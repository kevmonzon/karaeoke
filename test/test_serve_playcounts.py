#!/usr/bin/env python3
"""
test_serve_playcounts.py — the play counter in serve.py: POST /api/played counts one play of
one song, GET /api/playcounts reads every count, DATA_DIR/playcounts.json keeps them.

Run with:  python3 -m unittest discover -s test -p 'test_*.py' -t test   (or `npm test`)

Two layers, cheapest first:

  * PURE: _valid_song_id, _record_play, _playcounts_doc and _flush_playcounts against a
    temporary DATA_DIR — counting, the lazy load, persistence across a simulated restart, the
    debounce, the cap, a corrupt file, a failed write.

  * A real http.server on an ephemeral 127.0.0.1 port (loopback only), the same way
    test_serve_push.py does it: status codes, Content-Length on every reply of a keep-alive
    socket, bad JSON, bad ids, the cap's 507, and the Origin gate every POST passes.

Nothing here reads or writes the real data/ directory: serve's play-count path points at a
temporary one, and the debounce timer is parked so it never fires behind a test's back.
"""

import contextlib
import functools
import http.client
import io
import json
import os
import sys
import tempfile
import threading
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "tools"))

import serve  # noqa: E402

PATCHED = ("DATA_DIR", "PLAYCOUNTS_PATH", "PLAYCOUNTS_MAX_IDS", "PLAYCOUNTS_FLUSH_SEC",
           "ALLOWED_ORIGINS")
FIXED_NOW = 1795003200.0            # 2026-11-18T12:00:00Z
FIXED_ISO = "2026-11-18T12:00:00Z"

VALID_IDS = (
    "midi:123",
    "midi:kar_raw/00099 - Bosom Buddies - SH.mid",
    "video:videos/clip.mp4",
    "audio:audio_lyrics/9700 - Adele - Hello - International - AUDIO.mp3",
    "youtube:dQw4w9WgXcQ",
    "midi:kar_raw/1 - 아이유 - 좋은 날 - KPOP - MIDI.mid",   # a real library is not all ASCII
    "midi:a:b",                                             # a ':' inside the rest is fine
    "midi:" + "x" * (serve.PLAYCOUNTS_ID_MAX - len("midi:")),   # exactly the length cap
)
INVALID_IDS = (
    None, 123, 1.5, True, ["midi:1"], {"id": "midi:1"},
    "", "midi", "midi:", ":123", "123", "MIDI:1", "1midi:2", "mi di:1", "midi 1",
    "k" * 25 + ":1",                                        # a kind longer than 24 characters
    "midi:" + "x" * (serve.PLAYCOUNTS_ID_MAX - len("midi:") + 1),   # one past the cap
    "midi:a\nb", "midi:a\rb", "midi:\x00", "midi:a\tb", "midi:\x7f", "midi:\x85",
    "midi:\ud800",                                          # a lone surrogate (see serve.py)
)


def reset_playcounts():
    """What a server restart does to play counts: the in-memory table is gone, the file stays."""
    with serve._pc_lock:
        if serve._pc_timer is not None:
            serve._pc_timer.cancel()
        serve._pc_timer = None
        serve._pc_songs = {}
        serve._pc_loaded = False
        serve._pc_dirty = False
        serve._pc_set_aside = False


class PlayCountsCase(unittest.TestCase):
    """A temporary DATA_DIR (not created yet: the first write must make it), a parked timer."""

    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)                      # cleanups run LIFO: this one last
        saved = {n: getattr(serve, n) for n in PATCHED}
        self.addCleanup(lambda: [setattr(serve, n, v) for n, v in saved.items()])
        self.addCleanup(reset_playcounts)                 # …and this one first
        self.data = os.path.join(tmp.name, "data")
        self.path = os.path.join(self.data, "playcounts.json")
        serve.DATA_DIR = self.data
        serve.PLAYCOUNTS_PATH = self.path
        serve.PLAYCOUNTS_FLUSH_SEC = 3600.0               # flushed explicitly, never by the timer
        reset_playcounts()
        self.quiet_stderr()                               # the corrupt-file / 4xx lines are expected

    def quiet_stderr(self):
        # TestCase.enterContext is 3.11+; serve.py supports 3.8.
        cm = contextlib.redirect_stderr(io.StringIO())
        cm.__enter__()
        self.addCleanup(cm.__exit__, None, None, None)

    def fixed_clock(self, t=FIXED_NOW):
        real = serve.time.time
        serve.time.time = lambda: t
        self.addCleanup(setattr, serve.time, "time", real)

    def write_file(self, data: bytes):
        os.makedirs(self.data, exist_ok=True)
        with open(self.path, "wb") as fh:
            fh.write(data)

    def read_file(self):
        with open(self.path, encoding="utf-8") as fh:
            return json.load(fh)

    def songs(self):
        return serve._playcounts_doc()["songs"]


# ---------------------------------------------------------------------------------------
# Pure: the id gate
# ---------------------------------------------------------------------------------------
class TestSongIds(unittest.TestCase):
    def test_accepts_every_kind_of_song_id(self):
        for sid in VALID_IDS:
            self.assertTrue(serve._valid_song_id(sid), sid)

    def test_refuses_anything_else(self):
        for sid in INVALID_IDS:
            self.assertFalse(serve._valid_song_id(sid), repr(sid))


# ---------------------------------------------------------------------------------------
# Pure: counting, persistence, the cap, a corrupt file
# ---------------------------------------------------------------------------------------
class TestCounting(PlayCountsCase):
    def test_counts_up_per_id_and_stamps_the_last_play(self):
        self.fixed_clock()
        self.assertEqual(serve._record_play("midi:5"), 1)
        self.assertEqual(serve._record_play("midi:5"), 2)
        self.assertEqual(serve._record_play("youtube:dQw4w9WgXcQ"), 1)
        self.assertEqual(serve._playcounts_doc(), {"v": 1, "songs": {
            "midi:5": {"n": 2, "last": FIXED_ISO},
            "youtube:dQw4w9WgXcQ": {"n": 1, "last": FIXED_ISO},
        }})

    def test_last_is_the_latest_play(self):
        self.fixed_clock(FIXED_NOW)
        serve._record_play("midi:5")
        self.fixed_clock(FIXED_NOW + 90)
        serve._record_play("midi:5")
        self.assertEqual(self.songs()["midi:5"], {"n": 2, "last": "2026-11-18T12:01:30Z"})

    def test_a_read_returns_a_snapshot_not_the_live_table(self):
        serve._record_play("midi:5")
        doc = serve._playcounts_doc()
        serve._record_play("midi:5")
        serve._record_play("midi:6")
        self.assertEqual(doc["songs"]["midi:5"]["n"], 1)
        self.assertNotIn("midi:6", doc["songs"])

    def test_the_file_is_read_lazily_on_first_use(self):
        self.write_file(json.dumps({"v": 1, "songs": {"midi:7": {"n": 4, "last": FIXED_ISO}}}).encode())
        self.assertFalse(serve._pc_loaded, "importing or starting the server reads nothing")
        self.assertEqual(serve._record_play("midi:7"), 5)
        self.assertTrue(serve._pc_loaded)

    def test_counts_survive_a_restart(self):
        self.fixed_clock()
        for sid in ("midi:5", "midi:5", "video:videos/clip.mp4", VALID_IDS[5]):
            serve._record_play(sid)
        self.assertFalse(os.path.exists(self.path), "debounced: nothing written yet")
        self.assertTrue(serve._flush_playcounts())
        expected = {"v": 1, "songs": {
            "midi:5": {"n": 2, "last": FIXED_ISO},
            "video:videos/clip.mp4": {"n": 1, "last": FIXED_ISO},
            VALID_IDS[5]: {"n": 1, "last": FIXED_ISO},
        }}
        self.assertEqual(self.read_file(), expected, "the file has the documented shape")
        with open(self.path, "rb") as fh:
            self.assertIn("아이유".encode("utf-8"), fh.read(), "UTF-8 on disk, not \\u escapes")
        self.assertEqual(os.listdir(self.data), ["playcounts.json"], "no temp file left behind")
        reset_playcounts()                                # the server restarts
        self.assertEqual(serve._playcounts_doc(), expected)
        self.assertEqual(serve._record_play("midi:5"), 3, "counting carries on from the file")

    def test_one_debounced_write_for_a_burst(self):
        serve.PLAYCOUNTS_FLUSH_SEC = 0.5              # roomy: the burst below takes ~1 ms
        serve._record_play("midi:1")
        timer = serve._pc_timer
        self.assertIsNotNone(timer)
        for _ in range(50):
            serve._record_play("midi:1")
        self.assertIs(serve._pc_timer, timer, "a burst shares one pending write")
        timer.join(2.0)
        self.assertFalse(timer.is_alive())
        self.assertEqual(self.read_file()["songs"]["midi:1"]["n"], 51)
        self.assertIsNone(serve._pc_timer)
        self.assertFalse(serve._pc_dirty)

    def test_a_flush_with_nothing_new_writes_nothing(self):
        serve._playcounts_doc()
        self.assertTrue(serve._flush_playcounts())
        self.assertFalse(os.path.exists(self.data), "a read alone never creates the file")

    def test_a_direct_flush_supersedes_the_pending_timer(self):
        serve._record_play("midi:1")
        timer = serve._pc_timer
        self.assertTrue(serve._flush_playcounts())
        self.assertIsNone(serve._pc_timer)
        timer.join(1.0)
        self.assertFalse(timer.is_alive(), "the parked timer was cancelled")


class TestCap(PlayCountsCase):
    def test_new_ids_are_refused_when_full_but_known_ids_still_count(self):
        serve.PLAYCOUNTS_MAX_IDS = 3
        for sid in ("midi:1", "midi:2", "midi:3"):
            self.assertEqual(serve._record_play(sid), 1)
        self.assertIsNone(serve._record_play("midi:4"))
        self.assertEqual(serve._record_play("midi:1"), 2)
        self.assertEqual(sorted(self.songs()), ["midi:1", "midi:2", "midi:3"])

    def test_a_file_over_a_lowered_cap_keeps_every_id(self):
        self.write_file(json.dumps({"v": 1, "songs": {
            f"midi:{i}": {"n": 1, "last": FIXED_ISO} for i in range(5)}}).encode())
        serve.PLAYCOUNTS_MAX_IDS = 2
        self.assertIsNone(serve._record_play("midi:99"))
        self.assertEqual(serve._record_play("midi:4"), 2)
        self.assertEqual(len(self.songs()), 5, "a cap refuses growth; it never deletes history")


class TestCorruptFile(PlayCountsCase):
    CORRUPT = (
        b"{not json",
        b'{"v": 1, "songs": {"midi:1": {"n": 2',             # a write cut short
        b"\x80\x81 not utf-8",
        b"[1, 2, 3]",
        b'"just a string"',
        b'{"v": 2, "songs": {}}',                            # a newer format: not ours to read
        b'{"songs": {"midi:1": {"n": 1}}}',                  # no version
        b'{"v": 1, "songs": ["midi:1"]}',
        b"[" * 100_000,                                      # nested past the recursion limit
    )

    def test_a_corrupt_file_reads_as_empty_and_is_not_touched_by_a_read(self):
        for data in self.CORRUPT:
            with self.subTest(data=data[:40]):
                reset_playcounts()
                self.write_file(data)
                self.assertEqual(serve._playcounts_doc(), {"v": 1, "songs": {}})
                self.assertTrue(serve._flush_playcounts())   # nothing played: no write at all
                with open(self.path, "rb") as fh:
                    self.assertEqual(fh.read(), data, "a read never overwrites the file")
                self.assertFalse(os.path.exists(self.path + ".corrupt"))

    def test_the_first_play_sets_the_corrupt_file_aside_then_writes(self):
        self.write_file(b"{not json")
        self.assertEqual(serve._record_play("midi:1"), 1, "counting starts from zero")
        self.assertTrue(serve._flush_playcounts())
        with open(self.path + ".corrupt", "rb") as fh:
            self.assertEqual(fh.read(), b"{not json", "the unreadable file is kept, not destroyed")
        self.assertEqual(self.read_file()["songs"], {"midi:1": serve._pc_songs["midi:1"]})
        self.assertFalse(serve._pc_set_aside)
        # Only the FIRST write after a corrupt load moves the file aside.
        serve._record_play("midi:1")
        self.assertTrue(serve._flush_playcounts())
        with open(self.path + ".corrupt", "rb") as fh:
            self.assertEqual(fh.read(), b"{not json")
        self.assertEqual(self.read_file()["songs"]["midi:1"]["n"], 2)

    def test_bad_entries_are_dropped_one_by_one(self):
        good = {"n": 3, "last": FIXED_ISO}
        self.write_file(json.dumps({"v": 1, "songs": {
            "midi:1": good,
            "no-kind": {"n": 1, "last": FIXED_ISO},
            "midi:2": {"n": 0, "last": FIXED_ISO},
            "midi:3": {"n": -4, "last": FIXED_ISO},
            "midi:4": {"n": "7", "last": FIXED_ISO},
            "midi:5": {"n": True, "last": FIXED_ISO},
            "midi:6": {"n": 2.5, "last": FIXED_ISO},
            "midi:7": 9,
            "midi:8": {"n": 2, "last": 12345},
            "midi:9": {"n": 1},
        }}).encode())
        self.assertEqual(self.songs(), {"midi:1": good, "midi:8": {"n": 2, "last": ""},
                                        "midi:9": {"n": 1, "last": ""}})
        self.assertFalse(serve._pc_set_aside, "a readable file is not corrupt")


class TestWriteFailure(PlayCountsCase):
    def test_a_failed_write_keeps_the_counts_for_the_next_try(self):
        serve._record_play("midi:1")                      # loaded: no file yet, an empty table
        with open(self.data, "wb"):                       # now a FILE where DATA_DIR should be
            pass
        self.assertFalse(serve._flush_playcounts())
        self.assertTrue(serve._pc_dirty, "still owed to the disk")
        self.assertEqual(serve._record_play("midi:1"), 2, "counting goes on in memory")
        os.remove(self.data)
        self.assertTrue(serve._flush_playcounts())
        self.assertEqual(self.read_file()["songs"]["midi:1"]["n"], 2)


# ---------------------------------------------------------------------------------------
# Over HTTP: a real server on loopback
# ---------------------------------------------------------------------------------------
class LoopbackCase(PlayCountsCase):
    @classmethod
    def setUpClass(cls):
        cls._root = tempfile.TemporaryDirectory()   # static root: nothing real is reachable
        handler = functools.partial(serve.Handler, directory=cls._root.name)
        cls.httpd = serve.ThreadingServer(("127.0.0.1", 0), handler)
        cls.port = cls.httpd.server_address[1]
        cls._serving = threading.Thread(target=cls.httpd.serve_forever,
                                        kwargs={"poll_interval": 0.05}, daemon=True)
        cls._serving.start()

    @classmethod
    def tearDownClass(cls):
        cls.httpd.shutdown()
        cls.httpd.server_close()
        cls._root.cleanup()

    def conn(self):
        c = http.client.HTTPConnection("127.0.0.1", self.port, timeout=5)
        self.addCleanup(c.close)
        return c

    def call(self, method, path, body=None, headers=None, conn=None):
        """→ (status, lower-cased headers, raw body). A dict body is sent as JSON."""
        c = conn or self.conn()
        data = json.dumps(body).encode() if isinstance(body, dict) else body
        c.request(method, path, body=data, headers=headers or {})
        r = c.getresponse()
        payload = r.read()
        return r.status, {k.lower(): v for k, v in r.getheaders()}, payload

    def assertJson(self, headers, raw):
        self.assertEqual(headers["content-type"], "application/json")
        self.assertEqual(int(headers["content-length"]), len(raw), "keep-alive needs a length")
        return json.loads(raw)


class TestPlayedHttp(LoopbackCase):
    def test_post_counts_and_get_reads_on_one_keep_alive_socket(self):
        self.fixed_clock()
        c = self.conn()
        for n in (1, 2):
            status, h, raw = self.call("POST", "/api/played", {"id": "midi:5"}, conn=c)
            self.assertEqual((status, self.assertJson(h, raw)), (200, {"ok": True, "count": n}))
        status, h, raw = self.call("POST", "/api/played", {"id": "youtube:dQw4w9WgXcQ"}, conn=c)
        self.assertEqual((status, self.assertJson(h, raw)), (200, {"ok": True, "count": 1}))
        status, h, raw = self.call("GET", "/api/playcounts", conn=c)
        self.assertEqual(status, 200)
        self.assertEqual(self.assertJson(h, raw), {"v": 1, "songs": {
            "midi:5": {"n": 2, "last": FIXED_ISO},
            "youtube:dQw4w9WgXcQ": {"n": 1, "last": FIXED_ISO},
        }})
        self.assertTrue(serve._flush_playcounts())
        self.assertEqual(self.read_file(), json.loads(raw), "the file and the GET agree")
        # The file lives in DATA_DIR but is not a data route: only the API serves it.
        status, _, _ = self.call("GET", "/playcounts.json", conn=c)
        self.assertEqual(status, 404)

    def test_get_with_no_plays_is_an_empty_table(self):
        status, h, raw = self.call("GET", "/api/playcounts")
        self.assertEqual((status, self.assertJson(h, raw)), (200, {"v": 1, "songs": {}}))

    def test_bad_json_is_400(self):
        c = self.conn()
        for raw_body in (b"{nope", b'{"id": "midi:1"', b"\x80\x81", b"[" * 100_000):
            with self.subTest(body=raw_body[:20]):
                status, h, raw = self.call("POST", "/api/played", raw_body,
                                           headers={"Content-Type": "application/json"}, conn=c)
                self.assertEqual((status, self.assertJson(h, raw)),
                                 (400, {"ok": False, "error": "bad json"}))
        self.assertEqual(self.songs(), {})

    def test_bad_ids_are_400(self):
        c = self.conn()
        # json.dumps sends the lone surrogate as the escape \ud800, as a hostile client would.
        bodies = [json.dumps({"id": sid}).encode() for sid in INVALID_IDS]
        bodies += [b"{}", b"", b"null", b'["midi:1"]', b'"midi:1"', b'{"ID": "midi:1"}']
        for body in bodies:
            with self.subTest(body=body[:40]):
                status, h, raw = self.call("POST", "/api/played", body, conn=c)
                self.assertEqual((status, self.assertJson(h, raw)),
                                 (400, {"ok": False, "error": "bad id"}))
        self.assertEqual(self.songs(), {}, "nothing was counted")
        status, _, raw = self.call("POST", "/api/played", {"id": VALID_IDS[1]}, conn=c)
        self.assertEqual((status, json.loads(raw)["count"]), (200, 1), "the socket still works")

    def test_a_full_table_refuses_new_ids_with_507(self):
        serve.PLAYCOUNTS_MAX_IDS = 2
        c = self.conn()
        for sid in ("midi:1", "midi:2"):
            self.assertEqual(self.call("POST", "/api/played", {"id": sid}, conn=c)[0], 200)
        status, h, raw = self.call("POST", "/api/played", {"id": "midi:3"}, conn=c)
        self.assertEqual((status, self.assertJson(h, raw)),
                         (507, {"ok": False, "error": "playcounts full"}))
        status, h, raw = self.call("POST", "/api/played", {"id": "midi:2"}, conn=c)
        self.assertEqual((status, self.assertJson(h, raw)), (200, {"ok": True, "count": 2}))

    def test_the_origin_gate_applies(self):
        c = self.conn()
        same = f"http://127.0.0.1:{self.port}"
        refused = ({"Origin": "http://elsewhere.example"},
                   {"Sec-Fetch-Site": "cross-site"},
                   {"Origin": same, "Sec-Fetch-Site": "cross-site"})
        for headers in refused:
            with self.subTest(headers=headers):
                status, h, raw = self.call("POST", "/api/played", {"id": "midi:1"},
                                           headers=headers, conn=c)
                self.assertEqual((status, self.assertJson(h, raw)["ok"]), (403, False))
        self.assertEqual(self.songs(), {}, "a refused POST counts nothing")
        allowed = ({}, {"Origin": same}, {"Origin": same, "Sec-Fetch-Site": "same-origin"})
        for n, headers in enumerate(allowed, start=1):
            status, _, raw = self.call("POST", "/api/played", {"id": "midi:1"}, headers=headers, conn=c)
            self.assertEqual((status, json.loads(raw)["count"]), (200, n), headers)
        # Behind a Host-rewriting proxy, KARAEOKE_ALLOWED_ORIGINS decides instead.
        serve.ALLOWED_ORIGINS = {"https://karaoke.example.com"}
        status, _, _ = self.call("POST", "/api/played", {"id": "midi:1"},
                                 headers={"Origin": same}, conn=c)
        self.assertEqual(status, 403)
        status, _, raw = self.call("POST", "/api/played", {"id": "midi:1"},
                                   headers={"Origin": "https://karaoke.example.com"}, conn=c)
        self.assertEqual((status, json.loads(raw)["count"]), (200, 4))

    def test_concurrent_plays_are_all_counted(self):
        def hammer():
            c = http.client.HTTPConnection("127.0.0.1", self.port, timeout=5)
            try:
                for _ in range(25):
                    c.request("POST", "/api/played", body=b'{"id": "midi:42"}')
                    c.getresponse().read()
            finally:
                c.close()
        threads = [threading.Thread(target=hammer) for _ in range(8)]
        for t in threads:
            t.start()
        for t in threads:
            t.join(10)
        self.assertEqual(self.songs()["midi:42"]["n"], 200)


if __name__ == "__main__":
    unittest.main()
