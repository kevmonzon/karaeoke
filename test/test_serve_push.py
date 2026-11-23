#!/usr/bin/env python3
"""
test_serve_push.py — relay v2 in serve.py: the SSE push channel, the published song document
and the compact phone catalogue.

Run with:  python3 -m unittest discover -s test -p 'test_*.py' -t test   (or `npm test`)

Three layers, cheapest first:

  * PURE relay logic (_room_poll, _heavy_key, the song document, _compact_rows), driven by a
    monkeypatched time.time exactly like test_serve.py — no threads, no sockets.

  * The STREAM LOOP (_sse_serve) in a thread against a fake writer, with SSE_HEARTBEAT and
    SSE_MAX_AGE patched down to fractions of a second. The lost-wake-up test lives here.

  * A real http.server on an ephemeral 127.0.0.1 port (loopback only) for what only HTTP can
    show: status codes, headers, gzip negotiation, 304, and a stream read off a real socket.

Nothing here reads or writes the real data/ directory: catalogue tests point serve's paths at a
temporary directory.
"""

import contextlib
import functools
import gzip
import http.client
import io
import json
import os
import socket
import sys
import tempfile
import threading
import time
import unittest
import urllib.parse

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "tools"))

import serve  # noqa: E402

ROOM = "ABC123"
NEW_COMMAND_TYPES = ("playnow", "priority", "digit", "digit_delete", "digit_clear",
                     "digit_commit", "restart", "bg")


class FakeClock:
    """Stand-in for time.time() so the room TTL is testable without waiting."""

    def __init__(self, t=1_000_000.0):
        self.t = t

    def __call__(self):
        return self.t

    def advance(self, secs):
        self.t += secs


class Sink:
    """A fake stream writer: records every write with its monotonic arrival time."""

    def __init__(self, on_write=None):
        self.cv = threading.Condition()
        self.writes = []
        self.on_write = on_write

    def __call__(self, text):
        with self.cv:
            self.writes.append((time.monotonic(), text))
            self.cv.notify_all()
        if self.on_write:
            self.on_write(text, self)

    def text(self):
        with self.cv:
            return "".join(t for _, t in self.writes)

    def events(self):
        """[(arrival time, event name, parsed data)] in order; `retry:` blocks are skipped."""
        out = []
        with self.cv:
            for at, text in self.writes:
                for block in text.split("\n\n"):
                    name, data = None, None
                    for line in block.split("\n"):
                        if line.startswith("event: "):
                            name = line[len("event: "):]
                        elif line.startswith("data: "):
                            data = json.loads(line[len("data: "):])
                    if name:
                        out.append((at, name, data))
        return out

    def count(self, name):
        return sum(1 for _, n, _ in self.events() if n == name)

    def wait_until(self, pred, timeout=2.0):
        with self.cv:
            return self.cv.wait_for(lambda: pred(self), timeout)


def now_playing(**kw):
    """The `now` shape the host sends (src/js/app.js getNowPlaying)."""
    now = {"id": "midi:1", "name": "Song", "artist": "Artist", "kind": "midi", "code": 1,
           "by": "", "position": 10.0, "duration": 200.0, "paused": False, "score": None}
    now.update(kw)
    return now


class PushTestCase(unittest.TestCase):
    """Clean relay tables, a controllable clock, and every patched module name restored."""

    PATCHED = ("SSE_HEARTBEAT", "SSE_MAX_AGE", "SSE_MAX_PER_ROOM", "SSE_MAX_TOTAL", "SSE_PEER_CHECK",
               "_room_poll", "_compact_rows", "_lan_ip",
               "DATA_DIR", "CATALOG_PATH", "VIDEO_CATALOG_PATH", "AUDIO_CATALOG_PATH")

    def setUp(self):
        self._saved = {n: getattr(serve, n) for n in self.PATCHED}
        serve._rooms.clear()
        serve._sse_slots.clear()
        serve._compact_cache = None
        self._threads = []
        self.clock = FakeClock()
        self._real_time = serve.time.time
        serve.time.time = self.clock

    def tearDown(self):
        # Stop any stream still running before the clock and the patches go back.
        with serve._remote_cond:
            for slot in list(serve._sse_slots.values()):
                slot.closed = True
            serve._remote_cond.notify_all()
        for t in self._threads:
            t.join(2.0)
        for n, v in self._saved.items():
            setattr(serve, n, v)
        serve.time.time = self._real_time
        serve._rooms.clear()
        serve._sse_slots.clear()
        serve._compact_cache = None

    # -- helpers -------------------------------------------------------------------------
    def host_push(self, room=ROOM, ack=0, **kw):
        snap = {"room": room, "ackSeq": ack, "now": None, "queue": [], "settings": {}}
        snap.update(kw)
        return serve._room_host_sync(snap)

    def poll(self, cursor=None, role="guest", room=ROOM):
        with serve._remote_lock:
            return serve._room_poll(room, role, cursor or {"rev": -1, "heavy": "", "seq": 0})

    def start_stream(self, role="guest", cid="cid-test-0001", room=ROOM, on_write=None,
                     peer_closed=None):
        slot = serve._sse_slot_acquire(room, role, cid)
        self.assertIsNotNone(slot)
        sink = Sink(on_write)
        args = (slot, room, role, sink) + ((peer_closed,) if peer_closed else ())
        t = threading.Thread(target=serve._sse_serve, args=args, daemon=True)
        t.start()
        self._threads.append(t)
        return slot, sink, t

    def use_catalog_dir(self, midi, video, audio):
        d = tempfile.TemporaryDirectory()
        self.addCleanup(d.cleanup)
        serve.DATA_DIR = d.name
        serve.CATALOG_PATH = os.path.join(d.name, "catalog.json")
        serve.VIDEO_CATALOG_PATH = os.path.join(d.name, "catalog-video.json")
        serve.AUDIO_CATALOG_PATH = os.path.join(d.name, "catalog-audio.json")
        for path, recs in ((serve.CATALOG_PATH, midi), (serve.VIDEO_CATALOG_PATH, video),
                           (serve.AUDIO_CATALOG_PATH, audio)):
            if recs is not None:
                with open(path, "w", encoding="utf-8") as fh:
                    json.dump(recs, fh)
        return d.name


MIDI = [
    {"code": 5, "name": "Title A", "artistName": "Artist A", "langName": "OPM",
     "type": "MIDI", "source": "SH", "file": "kar_raw/5 - Artist A - Title A - SH.kar"},
    {"code": 147, "name": "Title B", "artistName": "Artist B", "langName": "AB",
     "type": "MIDI", "source": "TJMEDIA", "file": "kar_raw/147 - x - TJMEDIA.mid"},
]
VIDEO = [{"code": "", "name": "Untitled clip", "artistName": "", "langName": "",
          "type": "VIDEO", "file": "videos/clip.mp4"}]
AUDIO = [{"code": 9700, "name": "Hello", "artistName": "Adele", "langName": "International",
          "type": "AUDIO", "source": "", "file": "audio_lyrics/9700.mp3"}]


# ---------------------------------------------------------------------------------------
# Pure: what a stream would be sent
# ---------------------------------------------------------------------------------------
class TestRoomPoll(PushTestCase):
    def test_guest_poll_first_event_is_a_full_state(self):
        self.host_push(now=now_playing(), queue=[{"id": "midi:2"}],
                       settings={"audio.volume": 0.8}, songRev=3, notice="hello")
        self.clock.advance(0.25)
        events, cursor = self.poll()
        self.assertEqual([name for name, _ in events], ["state"])
        data = events[0][1]
        self.assertEqual(set(data), {"ok", "rev", "ts", "age", "now", "queue", "settings",
                                     "songRev", "notice"})
        self.assertTrue(data["ok"])
        self.assertEqual(data["now"]["id"], "midi:1")
        self.assertEqual(data["queue"], [{"id": "midi:2"}])
        self.assertEqual(data["settings"], {"audio.volume": 0.8})
        self.assertEqual((data["songRev"], data["notice"]), (3, "hello"))
        self.assertAlmostEqual(data["age"], 0.25, places=2)
        # Nothing new since: the same cursor yields nothing.
        self.assertEqual(self.poll(cursor)[0], [])

    def test_position_only_change_is_a_tick(self):
        self.host_push(now=now_playing(position=10.0, score=None))
        _, cursor = self.poll()
        self.host_push(now=now_playing(position=11.0, duration=201.0, score=42))
        events, cursor = self.poll(cursor)
        self.assertEqual([name for name, _ in events], ["tick"])
        self.assertEqual(events[0][1], {"rev": 2, "age": 0.0, "position": 11.0,
                                        "duration": 201.0, "paused": False, "score": 42})
        self.assertEqual(self.poll(cursor)[0], [])

    def test_pause_is_heavy(self):
        self.host_push(now=now_playing(paused=False))
        _, cursor = self.poll()
        self.host_push(now=now_playing(paused=True, position=10.5))
        events, _ = self.poll(cursor)
        self.assertEqual([name for name, _ in events], ["state"])
        self.assertTrue(events[0][1]["now"]["paused"])

    def test_queue_change_is_heavy(self):
        self.host_push(now=now_playing(), queue=[])
        _, cursor = self.poll()
        self.host_push(now=now_playing(position=11.0), queue=[{"id": "midi:7", "by": "Ana"}])
        events, cursor = self.poll(cursor)
        self.assertEqual([name for name, _ in events], ["state"])
        self.assertEqual(events[0][1]["queue"], [{"id": "midi:7", "by": "Ana"}])
        # The settings, songRev and notice are heavy too.
        base = {"now": now_playing(), "queue": [{"id": "midi:7", "by": "Ana"}],
                "settings": {}, "songRev": 0, "notice": ""}
        for change in ({"settings": {"audio.key": 2}}, {"songRev": 1}, {"notice": "not allowed"}):
            self.host_push(**base)
            _, cursor = self.poll(cursor)
            self.host_push(**{**base, **change, "now": now_playing(position=12.0)})
            events, cursor = self.poll(cursor)
            self.assertEqual([name for name, _ in events], ["state"], change)

    def test_host_poll_yields_commands_in_seq_order_once(self):
        self.host_push()
        for t in ("play", "next", "enqueue"):
            serve._room_add_command(ROOM, {"type": t})
        events, cursor = self.poll(role="host")
        self.assertEqual([name for name, _ in events], ["command"] * 3)
        self.assertEqual([d["seq"] for _, d in events], [1, 2, 3])
        self.assertEqual([d["type"] for _, d in events], ["play", "next", "enqueue"])
        self.assertEqual(self.poll(cursor, role="host")[0], [])
        serve._room_add_command(ROOM, {"type": "pause"})
        events, cursor = self.poll(cursor, role="host")
        self.assertEqual([d["seq"] for _, d in events], [4])
        # A host push (rev bump) alone produces nothing on the host's stream.
        self.host_push()
        self.assertEqual(self.poll(cursor, role="host")[0], [])

    def test_host_poll_does_not_replace_the_post_drain(self):
        self.host_push()
        serve._room_add_command(ROOM, {"type": "next"})
        events, cursor = self.poll(role="host")
        self.assertEqual([d["seq"] for _, d in events], [1])
        # Seen on the stream, still re-delivered by the POST drain until acked.
        self.assertEqual([c["seq"] for c in self.host_push(ack=0)["commands"]], [1])
        self.assertEqual([c["seq"] for c in self.host_push(ack=0)["commands"]], [1])
        self.assertEqual(self.host_push(ack=1)["commands"], [])
        self.assertEqual(self.poll(cursor, role="host")[0], [])

    def test_dead_room_poll_is_none(self):
        self.assertIsNone(self.poll(room="ZZZZZZ"))
        self.assertIsNone(self.poll(room="bad code"))
        self.host_push()
        self.assertIsNotNone(self.poll())
        self.clock.advance(serve.ROOM_TTL + 1)
        self.assertIsNone(self.poll())
        self.assertIsNone(self.poll(role="host"))

    def test_a_recreated_room_restarts_the_cursor(self):
        # The code expires and a host brings it back: rev and seq restart at 1, and a stream
        # holding the old cursor must not mistake the new room's events for ones it has seen.
        for _ in range(3):
            self.host_push(now=now_playing())
        serve._room_add_command(ROOM, {"type": "play"})
        serve._room_add_command(ROOM, {"type": "play"})
        _, guest_cursor = self.poll()
        _, host_cursor = self.poll(role="host")
        self.clock.advance(serve.ROOM_TTL + 1)
        for _ in range(3):
            self.host_push(now=now_playing())       # the first one GCs and re-creates the room
        self.assertEqual(serve._rooms[ROOM]["rev"], guest_cursor["rev"])
        serve._room_add_command(ROOM, {"type": "next"})
        events, _ = self.poll(guest_cursor)
        self.assertEqual([name for name, _ in events], ["state"])
        events, _ = self.poll(host_cursor, role="host")
        self.assertEqual([(d["seq"], d["type"]) for _, d in events], [(1, "next")])

    def test_heavy_key_ignores_only_the_clock(self):
        a = {"now": now_playing(position=1.0, duration=2.0, score=3), "queue": [], "settings": {}}
        b = {"now": now_playing(position=9.0, duration=8.0, score=7), "queue": [], "settings": {}}
        self.assertEqual(serve._heavy_key(a), serve._heavy_key(b))
        # Key order inside the snapshot must not matter (the key is a comparison token).
        c = {"settings": {}, "queue": [], "now": dict(reversed(list(a["now"].items())))}
        self.assertEqual(serve._heavy_key(a), serve._heavy_key(c))
        self.assertNotEqual(serve._heavy_key(a), serve._heavy_key({**a, "now": None}))


class TestSnapshotAdditions(PushTestCase):
    def test_state_carries_songrev_and_notice(self):
        self.host_push()
        s = serve._room_state(ROOM, None)
        self.assertEqual((s["songRev"], s["notice"]), (0, ""))     # defaults for an old host
        self.host_push(songRev=4, notice="x" * 300)
        s = serve._room_state(ROOM, None)
        self.assertEqual(s["songRev"], 4)
        self.assertEqual(s["notice"], "x" * 200)                    # truncated to 200
        for junk_rev, junk_notice in (("abc", 5), (None, None), (-3, ["no"]), ({}, {})):
            self.host_push(songRev=junk_rev, notice=junk_notice)
            s = serve._room_state(ROOM, None)
            self.assertEqual((s["songRev"], s["notice"]), (0, ""), (junk_rev, junk_notice))
        # The unchanged short-circuit is untouched.
        self.assertEqual(serve._room_state(ROOM, s["rev"]), {"ok": True, "rev": s["rev"],
                                                            "unchanged": True})

    def test_new_command_types_are_accepted(self):
        self.host_push()
        for i, t in enumerate(NEW_COMMAND_TYPES, start=1):
            self.assertEqual(serve._room_add_command(ROOM, {"type": t}), i, t)
        self.assertEqual([c["type"] for c in self.host_push()["commands"]], list(NEW_COMMAND_TYPES))
        events, _ = self.poll(role="host")
        self.assertEqual([d["type"] for _, d in events], list(NEW_COMMAND_TYPES))

    def test_room_writes_wake_a_waiter(self):
        self.host_push()

        def woken_by(action):
            ready, result = threading.Event(), []

            def waiter():
                with serve._remote_cond:
                    ready.set()                       # the action cannot take the lock
                    result.append(serve._remote_cond.wait(timeout=2))   # until we park here

            t = threading.Thread(target=waiter, daemon=True)
            t.start()
            self.assertTrue(ready.wait(1))
            action()
            t.join(3)
            return result == [True]

        self.assertTrue(woken_by(lambda: self.host_push()), "host sync")
        self.assertTrue(woken_by(lambda: serve._room_add_command(ROOM, {"type": "play"})),
                        "command add")
        self.assertTrue(woken_by(lambda: serve._room_put_song(ROOM, 1, "midi:1", {})), "song put")


class TestSongDocument(PushTestCase):
    def test_song_doc_round_trip_and_rev(self):
        self.host_push()
        self.assertEqual(serve._room_get_song(ROOM),
                         {"ok": True, "songRev": 0, "id": "", "doc": None})
        doc = {"lines": [{"start": 1.0, "syllables": [{"time": 1.0, "text": "La"}]}]}
        self.assertEqual(serve._room_put_song(ROOM, 1, "midi:5", doc), {"ok": True, "songRev": 1})
        self.assertEqual(serve._room_get_song(ROOM.lower()),
                         {"ok": True, "songRev": 1, "id": "midi:5", "doc": doc})
        self.assertEqual(serve._room_put_song(ROOM, 2, "video:9", None), {"ok": True, "songRev": 2})
        got = serve._room_get_song(ROOM)
        self.assertEqual((got["songRev"], got["id"], got["doc"]), (2, "video:9", None))
        for bad_rev in ("x", None, -1, True):
            self.assertEqual(serve._room_put_song(ROOM, bad_rev, "midi:5", doc)["error"],
                             "songRev", repr(bad_rev))
        self.assertEqual(serve._room_put_song(ROOM, 3, "midi:5", ["not", "a", "doc"])["error"], "doc")
        self.assertEqual(serve._room_get_song(ROOM)["songRev"], 2)   # refusals stored nothing

    def test_song_doc_for_a_dead_room_is_refused(self):
        self.assertEqual(serve._room_put_song("ZZZZZZ", 1, "midi:1", {}),
                         {"ok": False, "error": "no-room"})
        self.assertEqual(serve._room_get_song("ZZZZZZ"), {"ok": False, "error": "no-room"})
        self.assertEqual(serve._room_get_song("no good"), {"ok": False, "error": "no-room"})
        self.host_push()
        serve._room_put_song(ROOM, 1, "midi:1", {"lines": []})
        self.clock.advance(serve.ROOM_TTL + 1)
        self.assertEqual(serve._room_put_song(ROOM, 2, "midi:1", {})["error"], "no-room")
        self.assertEqual(serve._room_get_song(ROOM)["error"], "no-room")
        # The document dies with the room: a host coming back starts empty.
        self.host_push()
        self.assertEqual(serve._room_get_song(ROOM)["songRev"], 0)


# ---------------------------------------------------------------------------------------
# Pure: the compact catalogue
# ---------------------------------------------------------------------------------------
class TestCompactRows(PushTestCase):
    def test_compact_rows_shape_and_order(self):
        body = serve._compact_rows(MIDI, VIDEO, AUDIO)
        self.assertNotIn("rev", body)
        self.assertEqual(body["v"], 1)
        self.assertEqual(body["cols"], ["code", "name", "artist", "source", "kind", "lang"])
        self.assertEqual(body["kinds"], ["midi", "video", "audio"])
        self.assertEqual(body["sources"], ["", "SH", "PLATKAR", "TJMEDIA", "MIDI"])
        rows = body["rows"]
        # midi → video → audio, each in file order: row i is the host's catalog.songs[i].
        self.assertEqual([(r[0], r[1]) for r in rows],
                         [(5, "Title A"), (147, "Title B"), ("", "Untitled clip"), (9700, "Hello")])
        self.assertEqual([body["kinds"][r[4]] for r in rows], ["midi", "midi", "video", "audio"])
        self.assertEqual([body["sources"][r[3]] for r in rows], ["SH", "TJMEDIA", "", ""])
        self.assertEqual(rows[0][2], "Artist A")
        json.dumps(body)   # serialisable as is

    def test_compact_rows_tolerate_records_without_source(self):
        body = serve._compact_rows([{"code": 1, "name": "Old record"}], None, {"not": "a list"})
        self.assertEqual(body["rows"], [[1, "Old record", "", 0, 0, 0]])
        # A non-dict element keeps its place (catalog.js maps every element); an unknown
        # tag is kept by extending the dictionary rather than being folded into "".
        body = serve._compact_rows([{"code": 1, "name": "A", "source": "SH"}, 7,
                                    {"code": 2, "name": "B", "source": "NEWTAG"}], [], [])
        self.assertEqual(len(body["rows"]), 3)
        self.assertEqual(body["rows"][1], ["", "", "", 0, 0, 0])
        self.assertEqual(body["sources"][body["rows"][2][3]], "NEWTAG")
        self.assertEqual(body["sources"][:5], ["", "SH", "PLATKAR", "TJMEDIA", "MIDI"])
        self.assertEqual(serve._compact_rows([], [], [])["rows"], [])

    def test_compact_rows_carry_a_lang_dictionary(self):
        recs = MIDI + [{"code": 6, "name": "C", "langName": "OPM"},
                       {"code": 8, "name": "D", "langName": None}]
        body = serve._compact_rows(recs, VIDEO, AUDIO)
        self.assertEqual(body["langs"][0], "")
        self.assertEqual(len(body["langs"]), len(set(body["langs"])))   # each value once
        expected = [r.get("langName") or "" for r in recs + VIDEO + AUDIO]
        self.assertEqual([body["langs"][row[5]] for row in body["rows"]], expected)
        self.assertEqual(body["langs"], ["", "OPM", "AB", "International"])


class TestCompactCatalogCache(PushTestCase):
    def test_compact_catalog_is_built_once_until_a_file_changes(self):
        self.use_catalog_dir(MIDI, VIDEO, AUDIO)
        real_rows, builds = serve._compact_rows, []

        def counting_rows(*a):
            builds.append(1)
            time.sleep(0.1)          # long enough for the other callers to pile up
            return real_rows(*a)

        serve._compact_rows = counting_rows
        results = []
        threads = [threading.Thread(target=lambda: results.append(serve._compact_catalog()))
                   for _ in range(3)]
        for t in threads:
            t.start()
        for t in threads:
            t.join(5)
        self.assertEqual(len(builds), 1, "three concurrent phones, one build")
        self.assertEqual(len({r[2] for r in results}), 1)
        identity, gz, etag = results[0]
        self.assertEqual(gzip.decompress(gz), identity)
        body = json.loads(identity)
        self.assertEqual(etag, f'"{body["rev"]}"')
        self.assertEqual(list(body)[:2], ["v", "rev"])
        self.assertEqual(len(body["rows"]), 4)
        self.assertIs(serve._compact_catalog()[0], identity)          # served from the cache
        with open(serve.AUDIO_CATALOG_PATH, "w", encoding="utf-8") as fh:
            json.dump(AUDIO + AUDIO, fh)
        identity2, _, etag2 = serve._compact_catalog()
        self.assertEqual(len(builds), 2)
        self.assertNotEqual(etag2, etag)
        self.assertEqual(len(json.loads(identity2)["rows"]), 5)

    def test_missing_catalogues_build_an_empty_body(self):
        self.use_catalog_dir(None, None, None)
        identity, _, _ = serve._compact_catalog()
        self.assertEqual(json.loads(identity)["rows"], [])


# ---------------------------------------------------------------------------------------
# The stream loop, in a thread, against a fake writer
# ---------------------------------------------------------------------------------------
class TestStreamLoop(PushTestCase):
    def test_notify_during_write_is_not_lost(self):
        # The heartbeat is 3 s, so any event that waits for it misses the 0.5 s budget.
        serve.SSE_HEARTBEAT = 3.0
        serve.SSE_PEER_CHECK = 3.0     # the 1 s peer check would otherwise bound a lost wake
        serve.SSE_MAX_AGE = 30
        self.host_push(now=now_playing(), queue=[])
        real_poll = serve._room_poll
        window, polled_empty, problems = threading.Event(), threading.Event(), []

        def slow_poll(code, role, cursor):
            res = real_poll(code, role, cursor)
            if window.is_set() and res is not None and not res[0] and not polled_empty.is_set():
                polled_empty.set()      # the stream saw nothing new; the injector fires now,
                time.sleep(0.15)        # inside the gap between this poll and the wait
            return res

        serve._room_poll = slow_poll

        def inject():
            if polled_empty.wait(2):
                self.host_push(now=now_playing(), queue=[{"id": "midi:3"}])  # → notify_all()

        def on_write(text, sink):
            if "event: state" not in text:
                return
            n = sink.count("state")
            if n == 1:
                # (a) a change and its notify_all() from INSIDE the first write. The stream
                # must not hold the relay lock while writing (that would deadlock here).
                if serve._remote_lock.locked():
                    problems.append("the stream wrote while holding _remote_lock")
                    return
                self.host_push(now=now_playing(), queue=[{"id": "midi:2"}])
            elif n == 2:
                # (b) the next notify_all() lands between the stream's poll and its wait.
                window.set()
                threading.Thread(target=inject, daemon=True).start()

        _, sink, _ = self.start_stream(on_write=on_write)
        got = sink.wait_until(lambda s: s.count("state") >= 3, timeout=2.0)
        times = [at for at, name, _ in sink.events() if name == "state"]
        self.assertEqual(problems, [])
        self.assertTrue(got, f"{len(times)} state events in 2 s (heartbeat 3 s): a wake-up was lost")
        self.assertLess(times[1] - times[0], 0.5)
        self.assertLess(times[2] - times[1], 0.5)
        queues = [d["queue"] for _, name, d in sink.events() if name == "state"]
        self.assertEqual(queues, [[], [{"id": "midi:2"}], [{"id": "midi:3"}]])

    def test_stream_ends_after_max_age(self):
        serve.SSE_HEARTBEAT = 5.0      # far longer than the age: the deadline must still win
        serve.SSE_MAX_AGE = 0.2
        self.host_push(now=now_playing())
        started = time.monotonic()
        _, sink, t = self.start_stream()
        t.join(1.5)
        self.assertFalse(t.is_alive(), "the stream outlived SSE_MAX_AGE")
        self.assertLess(time.monotonic() - started, 1.5)
        self.assertEqual(serve._sse_counts()[0], 0)
        self.assertTrue(sink.text().startswith("retry: 2000\n\n"))
        self.assertEqual([name for _, name, _ in sink.events()], ["state"])

    def test_same_cid_replaces_old_slot(self):
        serve.SSE_HEARTBEAT = 5.0
        self.host_push(now=now_playing())
        first, sink, t = self.start_stream(cid="same-tab-0001")
        self.assertTrue(sink.wait_until(lambda s: s.count("state") >= 1))
        second = serve._sse_slot_acquire(ROOM, "guest", "same-tab-0001")
        self.assertTrue(first.closed)
        self.assertFalse(second.closed)
        self.assertEqual(serve._sse_counts()[0], 1)
        t.join(1.0)                     # the old loop was parked in wait(); it must wake
        self.assertFalse(t.is_alive())
        self.assertEqual(serve._sse_counts()[0], 1, "the old loop freed its successor's slot")
        other = serve._sse_slot_acquire(ROOM, "host", "same-tab-0001")   # another role: new
        self.assertEqual(serve._sse_counts()[0], 2)
        serve._sse_slot_release(second)
        serve._sse_slot_release(other)
        serve._sse_slot_release(second)  # idempotent
        self.assertEqual(serve._sse_counts()[0], 0)

    def test_heartbeat_is_a_named_event(self):
        serve.SSE_HEARTBEAT = 0.05
        self.host_push(now=now_playing())
        _, sink, _ = self.start_stream()
        self.assertTrue(sink.wait_until(lambda s: s.count("hb") >= 2))
        text = sink.text()
        self.assertIn("event: hb\ndata: {}\n\n", text)
        self.assertFalse([ln for ln in text.split("\n") if ln.startswith(":")],
                         "an SSE comment is invisible to EventSource")
        self.assertEqual(sink.events()[0][1], "state")

    def test_host_stream_carries_commands(self):
        serve.SSE_HEARTBEAT = 5.0
        self.host_push()
        _, sink, _ = self.start_stream(role="host", cid="host-tab-0001")
        serve._room_add_command(ROOM, {"type": "enqueue", "id": "midi:4", "by": "Ana"})
        serve._room_add_command(ROOM, {"type": "playnow", "id": "midi:5"})
        self.assertTrue(sink.wait_until(lambda s: s.count("command") >= 2))
        self.host_push(ack=2, now=now_playing())        # a push is not a host event
        serve._room_add_command(ROOM, {"type": "next"})
        self.assertTrue(sink.wait_until(lambda s: s.count("command") >= 3))
        cmds = [d for _, name, d in sink.events() if name == "command"]
        self.assertEqual([(c["seq"], c["type"]) for c in cmds],
                         [(1, "enqueue"), (2, "playnow"), (3, "next")])
        self.assertEqual(cmds[0]["by"], "Ana")
        self.assertEqual({name for _, name, _ in sink.events()}, {"command"})

    def test_a_dead_room_ends_the_stream_with_gone(self):
        serve.SSE_HEARTBEAT = 0.05
        self.host_push(now=now_playing())
        _, sink, t = self.start_stream()
        self.assertTrue(sink.wait_until(lambda s: s.count("state") >= 1))
        self.clock.advance(serve.ROOM_TTL + 1)
        t.join(1.5)
        self.assertFalse(t.is_alive())
        self.assertTrue(sink.text().endswith('event: gone\ndata: {"error":"no-room"}\n\n'))
        self.assertEqual(serve._sse_counts()[0], 0)

    def test_a_closed_peer_frees_its_slot_without_waiting_for_a_heartbeat(self):
        serve.SSE_HEARTBEAT = 30        # production-like: a heartbeat never comes in this test
        self.assertEqual(serve.SSE_PEER_CHECK, 1.0)
        self.host_push(now=now_playing())
        gone = threading.Event()
        flipped_at = []

        def on_write(text, sink):
            if "event: state" in text and not gone.is_set():
                flipped_at.append(len(sink.writes))
                gone.set()              # the client hangs up right after its first state

        _, sink, t = self.start_stream(on_write=on_write, peer_closed=gone.is_set)
        self.assertTrue(gone.wait(1))
        started = time.monotonic()
        t.join(1.5)
        self.assertFalse(t.is_alive(), "a closed client kept its slot past 1.5 s")
        self.assertLess(time.monotonic() - started, 1.5)
        self.assertEqual(serve._sse_counts()[0], 0)
        self.assertEqual(len(sink.writes), flipped_at[0], "wrote to a client that had left")

    def test_a_closed_peer_is_noticed_while_ticks_are_flowing(self):
        # A playing host pushes every second, so a guest stream writes a tick on every pass.
        # The peer check must not wait for a quiet pass, or the slot lives until SSE_MAX_AGE.
        serve.SSE_HEARTBEAT = 30
        self.host_push(now=now_playing(position=0.0))
        stop, gone, flipped_at = threading.Event(), threading.Event(), []

        def pusher():
            pos = 0.0
            while not stop.wait(0.05):
                pos += 0.05
                self.host_push(now=now_playing(position=pos))

        p = threading.Thread(target=pusher, daemon=True)
        self._threads.append(p)
        self.addCleanup(stop.set)

        def on_write(text, sink):
            if "event: tick" in text and not gone.is_set():
                flipped_at.append(len(sink.writes))
                gone.set()

        _, sink, t = self.start_stream(on_write=on_write, peer_closed=gone.is_set)
        p.start()
        self.assertTrue(gone.wait(1), "no tick arrived")
        t.join(1.5)
        stop.set()
        self.assertFalse(t.is_alive(), "ticks kept a closed client's stream alive")
        self.assertEqual(serve._sse_counts()[0], 0)
        self.assertEqual(len(sink.writes), flipped_at[0], "wrote to a client that had left")

    def test_a_broken_pipe_ends_the_stream_and_frees_the_slot(self):
        serve.SSE_HEARTBEAT = 0.05
        self.host_push(now=now_playing())

        def broken(text, sink):
            if sink.count("hb"):
                raise BrokenPipeError()

        _, sink, t = self.start_stream(on_write=broken)
        t.join(1.5)
        self.assertFalse(t.is_alive())
        self.assertEqual(serve._sse_counts()[0], 0)


class TestSlots(PushTestCase):
    def test_sse_slots_are_capped_and_released(self):
        per, total = serve.SSE_MAX_PER_ROOM, serve.SSE_MAX_TOTAL
        self.assertEqual((per, total), (40, 200))
        held = [serve._sse_slot_acquire("ROOM00", "guest", f"cid-{i:08d}") for i in range(per)]
        self.assertNotIn(None, held)
        self.assertIsNone(serve._sse_slot_acquire("ROOM00", "guest", "cid-overflow"))
        self.assertIsNone(serve._sse_slot_acquire("ROOM00", "host", "cid-overflow"))  # both roles
        # A tab reconnecting with its own cid is never locked out by its stale slot.
        again = serve._sse_slot_acquire("ROOM00", "guest", "cid-00000000")
        self.assertIsNotNone(again)
        self.assertTrue(held[0].closed)
        held[0] = again
        room = 1
        while len(held) < total:
            for i in range(per):
                if len(held) < total:
                    held.append(serve._sse_slot_acquire(f"ROOM{room:02d}", "guest", f"cid-{i:08d}"))
            room += 1
        self.assertNotIn(None, held)
        self.assertEqual(serve._sse_counts()[0], total)
        self.assertIsNone(serve._sse_slot_acquire("ROOMZZ", "guest", "cid-total-x"))
        serve._sse_slot_release(held.pop())
        extra = serve._sse_slot_acquire("ROOMZZ", "guest", "cid-total-x")
        self.assertIsNotNone(extra)
        for s in held + [extra]:
            serve._sse_slot_release(s)
        self.assertEqual(serve._sse_counts()[0], 0)


# ---------------------------------------------------------------------------------------
# Over HTTP: a real server on an ephemeral loopback port
# ---------------------------------------------------------------------------------------
class LoopbackTestCase(PushTestCase):
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

    def call(self, method, path, body=None, headers=None, conn=None):
        c = conn or http.client.HTTPConnection("127.0.0.1", self.port, timeout=5)
        try:
            data = json.dumps(body).encode() if isinstance(body, (dict, list)) else body
            c.request(method, path, body=data, headers=headers or {})
            r = c.getresponse()
            payload = r.read()
            return r.status, {k.lower(): v for k, v in r.getheaders()}, payload
        finally:
            if conn is None:
                c.close()

    def quiet_stderr(self):
        # TestCase.enterContext is 3.11+; serve.py supports 3.8.
        cm = contextlib.redirect_stderr(io.StringIO())
        cm.__enter__()
        self.addCleanup(cm.__exit__, None, None, None)

    def events_path(self, room=ROOM, role="guest", cid="cid-http-0001"):
        return "/api/remote/events?" + urllib.parse.urlencode({"room": room, "role": role,
                                                               "cid": cid})


class TestEventStreamHttp(LoopbackTestCase):
    def test_bad_cid_is_refused(self):
        self.host_push()
        for cid in ("", "short", "x" * 33, "bad cid!!", "../../etc/x", "tabé-12345"):
            status, headers, body = self.call("GET", self.events_path(cid=cid))
            self.assertEqual(status, 400, repr(cid))
            self.assertEqual(json.loads(body), {"ok": False, "error": "cid"})
            self.assertEqual(headers["content-type"], "application/json")
        self.assertEqual(serve._sse_counts()[0], 0)

    def test_dead_room_role_and_busy_are_refused_before_streaming(self):
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=5)
        self.addCleanup(conn.close)
        err = io.StringIO()
        with contextlib.redirect_stderr(err):
            # One keep-alive connection for all of them: each refusal carries a Content-Length.
            status, _, body = self.call("GET", self.events_path(room="ZZZZZZ"), conn=conn)
            self.assertEqual((status, json.loads(body)), (404, {"ok": False, "error": "no-room"}))
            self.host_push()
            status, _, body = self.call("GET", self.events_path(role="dj"), conn=conn)
            self.assertEqual((status, json.loads(body)), (400, {"ok": False, "error": "role"}))
            serve.SSE_MAX_PER_ROOM = 0
            status, _, body = self.call("GET", self.events_path(), conn=conn)
            self.assertEqual((status, json.loads(body)), (503, {"ok": False, "error": "busy"}))
            status, _, _ = self.call("GET", "/api/remote/state?room=" + ROOM, conn=conn)
            self.assertEqual(status, 200)
        # The event stream logs only "busy": a phone whose host left is not news.
        lines = [ln for ln in err.getvalue().splitlines() if "/api/remote/events" in ln]
        self.assertEqual(len(lines), 1, err.getvalue())
        self.assertIn(" 503 ", lines[0])

    def test_info_reports_streams_and_rooms(self):
        serve._lan_ip = lambda: "127.0.0.1"   # no route lookup from a test
        self.host_push(room="AAAA11")
        self.host_push(room="BBBB22")
        for cid in ("cid-info-0001", "cid-info-0002", "cid-info-0003"):
            serve._sse_slot_acquire("AAAA11", "guest", cid)
        status, _, body = self.call("GET", "/api/remote/info")
        info = json.loads(body)
        self.assertEqual(status, 200)
        self.assertEqual((info["streams"], info["rooms"]), (3, 2))
        self.assertEqual(info["port"], self.port)
        self.assertEqual(info["lanUrl"], f"http://127.0.0.1:{self.port}")
        self.clock.advance(serve.ROOM_TTL + 1)
        self.assertEqual(json.loads(self.call("GET", "/api/remote/info")[2])["rooms"], 0)

    def test_event_stream_end_to_end_on_loopback(self):
        # Production constants on purpose: a closed tab must free its slot within 2 s even
        # though the next heartbeat (the next write that could fail) is 15 s away.
        self.assertEqual((serve.SSE_HEARTBEAT, serve.SSE_MAX_AGE, serve.SSE_PEER_CHECK),
                         (15, 300, 1.0))
        snap = {"room": ROOM, "ackSeq": 0, "now": now_playing(), "queue": [], "settings": {}}
        self.assertEqual(self.call("POST", "/api/remote/host", snap)[0], 200)
        sock = socket.create_connection(("127.0.0.1", self.port), timeout=5)
        try:
            sock.sendall(("GET " + self.events_path(cid="loopback-0001") + " HTTP/1.1\r\n"
                          "Host: 127.0.0.1\r\nAccept: text/event-stream\r\n\r\n").encode())
            buf = b""
            while b"\r\n\r\n" not in buf:
                chunk = sock.recv(4096)
                self.assertTrue(chunk, "server closed before the headers")
                buf += chunk
            head, _, buf = buf.partition(b"\r\n\r\n")
            lines = head.decode("latin-1").split("\r\n")
            self.assertEqual(lines[0], "HTTP/1.1 200 OK")
            headers = {k.strip().lower(): v.strip() for k, _, v in
                       (ln.partition(":") for ln in lines[1:])}
            self.assertEqual(headers["content-type"], "text/event-stream")
            self.assertEqual(headers["connection"], "close")
            self.assertEqual(headers["x-accel-buffering"], "no")
            self.assertNotIn("content-length", headers)

            def next_event(name):
                nonlocal buf
                deadline = time.monotonic() + 2
                while True:
                    while b"\n\n" in buf:
                        block, _, buf = buf.partition(b"\n\n")
                        fields = dict(ln.split(": ", 1) for ln in block.decode().split("\n")
                                      if ": " in ln)
                        if fields.get("event") == name:
                            return json.loads(fields["data"])
                    self.assertLess(time.monotonic(), deadline, f"no {name} event in 2 s")
                    buf += sock.recv(4096)

            while len(buf) < len(b"retry: 2000\n\n"):
                buf += sock.recv(4096)
            self.assertTrue(buf.startswith(b"retry: 2000\n\n"), buf[:40])   # the first write
            first = next_event("state")
            self.assertEqual((first["now"]["id"], first["queue"]), ("midi:1", []))
            # Push once through the real POST path; the stream carries it.
            snap2 = {**snap, "queue": [{"id": "midi:9", "by": "Ana"}]}
            self.assertEqual(self.call("POST", "/api/remote/host", snap2)[0], 200)
            second = next_event("state")
            self.assertEqual(second["queue"], [{"id": "midi:9", "by": "Ana"}])
            # A clock-only push is a tick (the hand-run sequence: state, tick, state).
            snap3 = {**snap2, "now": now_playing(position=11.5)}
            self.assertEqual(self.call("POST", "/api/remote/host", snap3)[0], 200)
            self.assertEqual(next_event("tick")["position"], 11.5)
            self.assertEqual(serve._sse_counts()[0], 1)
        finally:
            sock.close()
        deadline = time.monotonic() + 2
        while serve._sse_counts()[0] and time.monotonic() < deadline:
            time.sleep(0.02)
        self.assertEqual(serve._sse_counts()[0], 0, "the slot outlived its socket")


class TestPeerCheck(unittest.TestCase):
    def test_peer_check_sees_eof_but_leaves_stray_bytes(self):
        ours, theirs = socket.socketpair()
        self.addCleanup(ours.close)
        handler = type("H", (), {"connection": ours})()
        closed = functools.partial(serve.Handler._sse_peer_closed, handler)
        self.assertFalse(closed())                       # nothing to read: still connected
        theirs.sendall(b"x")
        time.sleep(0.05)
        self.assertFalse(closed())                       # stray bytes are not a hang-up…
        self.assertEqual(ours.recv(1, socket.MSG_PEEK), b"x")   # …and were not consumed
        theirs.close()
        ours.recv(1)
        time.sleep(0.05)
        self.assertTrue(closed())                        # EOF
        ours.close()
        self.assertTrue(closed())                        # a closed fd counts as closed


class TestSongHttp(LoopbackTestCase):
    def test_song_post_is_capped_gated_and_readable(self):
        self.host_push()
        self.quiet_stderr()                    # 4xx are logged (existing non-200 policy)
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=5)
        self.addCleanup(conn.close)
        doc = {"lines": [{"start": 0.5, "syllables": [{"time": 0.5, "text": "Hi"}]}]}
        status, _, body = self.call("POST", "/api/remote/song",
                                    {"room": ROOM, "songRev": 1, "id": "midi:5", "doc": doc}, conn=conn)
        self.assertEqual((status, json.loads(body)), (200, {"ok": True, "songRev": 1}))
        status, _, body = self.call("GET", "/api/remote/song?room=" + ROOM, conn=conn)
        self.assertEqual(json.loads(body), {"ok": True, "songRev": 1, "id": "midi:5", "doc": doc})
        big = {"room": ROOM, "songRev": 2, "id": "midi:6", "doc": {"x": "a" * serve.SONG_DOC_MAX}}
        status, _, _ = self.call("POST", "/api/remote/song", big, conn=conn)
        self.assertEqual(status, 413)
        # The oversize body was drained, so the same keep-alive socket still works.
        status, _, body = self.call("GET", "/api/remote/song?room=" + ROOM, conn=conn)
        self.assertEqual((status, json.loads(body)["songRev"]), (200, 1))
        status, _, _ = self.call("POST", "/api/remote/song",
                                 {"room": ROOM, "songRev": 3, "id": "midi:7", "doc": {}},
                                 headers={"Origin": "http://elsewhere.example"})
        self.assertEqual(status, 403)                        # the existing origin gate
        status, _, body = self.call("POST", "/api/remote/song",
                                    {"room": "ZZZZZZ", "songRev": 1, "id": "", "doc": None})
        self.assertEqual((status, json.loads(body)["error"]), (403, "no-room"))
        status, _, _ = self.call("POST", "/api/remote/song", {"room": ROOM, "songRev": "x"})
        self.assertEqual(status, 400)
        self.assertEqual(serve._room_get_song(ROOM)["songRev"], 1)


class TestCompactHttp(LoopbackTestCase):
    def test_compact_endpoint_etag_gzip_and_304(self):
        self.use_catalog_dir(MIDI, VIDEO, AUDIO)
        self.quiet_stderr()                    # 304s are logged (existing non-200 policy)
        status, headers, raw = self.call("GET", "/api/catalog/compact",
                                         headers={"Accept-Encoding": "gzip, deflate, br"})
        self.assertEqual(status, 200)
        self.assertEqual(headers["content-type"], "application/json")
        self.assertEqual(headers["content-encoding"], "gzip")
        self.assertEqual(headers["vary"], "Accept-Encoding")
        self.assertEqual(int(headers["content-length"]), len(raw))
        body = json.loads(gzip.decompress(raw))
        etag = headers["etag"]
        self.assertEqual(etag, f'"{body["rev"]}"')
        self.assertEqual(len(body["rows"]), len(MIDI) + len(VIDEO) + len(AUDIO))
        for ae in (None, "identity", "gzip;q=0, br"):
            status, h, plain = self.call("GET", "/api/catalog/compact",
                                         headers={"Accept-Encoding": ae} if ae else None)
            self.assertEqual(status, 200, ae)
            self.assertNotIn("content-encoding", h, ae)
            self.assertEqual(json.loads(plain), body, ae)
            self.assertEqual(h["etag"], etag)
        status, h, empty = self.call("GET", "/api/catalog/compact",
                                     headers={"If-None-Match": etag, "Accept-Encoding": "gzip"})
        self.assertEqual((status, empty, h["etag"]), (304, b"", etag))
        status, _, _ = self.call("GET", "/api/catalog/compact",
                                 headers={"If-None-Match": f'"other", W/{etag}'})
        self.assertEqual(status, 304)
        status, _, _ = self.call("GET", "/api/catalog/compact", headers={"If-None-Match": '"nope"'})
        self.assertEqual(status, 200)


if __name__ == "__main__":
    unittest.main()
