#!/usr/bin/env python3
"""
test_serve.py — the pure logic inside serve.py, exercised without a socket.

Run with:  python3 -m unittest discover -s test -p 'test_*.py' -t .   (or `npm test`)

Two areas earn tests most:

  * The MULTI-ROOM RELAY (CLAUDE.md §5.17 calls its ack/seq + TTL behaviour "non-obvious,
    load-bearing"). All of it is pure given the clock, which we monkeypatch — no server,
    no threads, no network.

  * The KEYLESS YOUTUBE SCRAPE, which §14 already flags as the thing most likely to break
    silently. A captured `ytInitialData`-shaped fixture pins the extraction so a refactor
    can't quietly stop finding videos.

serve.py is import-safe (everything happens under `if __name__ == "__main__"`).
"""

import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "tools"))

import serve  # noqa: E402


class FakeClock:
    """Monkeypatchable stand-in for time.time() so TTLs are testable in microseconds."""

    def __init__(self, t=1_000_000.0):
        self.t = t

    def __call__(self):
        return self.t

    def advance(self, secs):
        self.t += secs


class RelayTestCase(unittest.TestCase):
    """Shared setup: a clean room table and a controllable clock."""

    def setUp(self):
        serve._rooms.clear()
        serve._yt_block_rate.clear()
        self.clock = FakeClock()
        self._real_time = serve.time.time
        serve.time.time = self.clock

    def tearDown(self):
        serve.time.time = self._real_time
        serve._rooms.clear()
        serve._yt_block_rate.clear()

    def host_push(self, room="ABC123", ack=0, **kw):
        snap = {"room": room, "ackSeq": ack, "now": None, "queue": [], "settings": {}}
        snap.update(kw)
        return serve._room_host_sync(snap)


class TestNormRoom(unittest.TestCase):
    def test_uppercases_and_validates(self):
        self.assertEqual(serve._norm_room("abc123"), "ABC123")
        self.assertEqual(serve._norm_room("  abc123  "), "ABC123")

    def test_rejects_malformed(self):
        for bad in ("", None, "ab", "abc-123", "a" * 13, "ABC 12", "ABC!23"):
            self.assertEqual(serve._norm_room(bad), "", repr(bad))


class TestRoomLifecycle(RelayTestCase):
    def test_first_host_push_creates_the_room(self):
        r = self.host_push()
        self.assertTrue(r["ok"])
        self.assertEqual(r["rev"], 1)
        self.assertEqual(r["commands"], [])
        self.assertIn("ABC123", serve._rooms)

    def test_a_guest_cannot_reach_a_room_that_no_host_owns(self):
        # This is the room code's teeth: an unknown code hits nothing at all.
        self.assertEqual(serve._room_state("ZZZZZZ", None)["error"], "no-room")
        self.assertEqual(serve._room_add_command("ZZZZZZ", {"type": "play"}), 0)

    def test_state_carries_the_snapshot_and_a_staleness_age(self):
        self.host_push(now={"id": "midi:1", "position": 12.5}, queue=[{"id": "midi:2"}])
        self.clock.advance(0.4)
        s = serve._room_state("ABC123", None)
        self.assertTrue(s["ok"])
        self.assertEqual(s["now"]["id"], "midi:1")
        self.assertEqual(len(s["queue"]), 1)
        # `age` is what lets a phone correct for its own poll phase before extrapolating
        # the playback position — the lyric sync rides on it (§5.21).
        self.assertAlmostEqual(s["age"], 0.4, places=2)

    def test_age_is_never_negative(self):
        self.host_push()
        self.clock.advance(-5)          # clock skew / an NTP step
        self.assertGreaterEqual(serve._room_state("ABC123", None)["age"], 0.0)

    def test_room_expires_after_the_ttl_and_takes_control_with_it(self):
        self.host_push()
        self.clock.advance(serve.ROOM_TTL + 1)
        self.assertEqual(serve._room_state("ABC123", None)["error"], "no-room")
        self.assertEqual(serve._room_add_command("ABC123", {"type": "play"}), 0)

    def test_rooms_are_isolated_from_each_other(self):
        self.host_push(room="AAAAAA", now={"id": "midi:1"})
        self.host_push(room="BBBBBB", now={"id": "video:9"})
        self.assertEqual(serve._room_state("AAAAAA", None)["now"]["id"], "midi:1")
        self.assertEqual(serve._room_state("BBBBBB", None)["now"]["id"], "video:9")
        # A command sent to one room must never surface in the other's inbox.
        serve._room_add_command("AAAAAA", {"type": "next"})
        self.assertEqual(len(self.host_push(room="BBBBBB")["commands"]), 0)
        self.assertEqual(len(self.host_push(room="AAAAAA")["commands"]), 1)


class TestCommandAckProtocol(RelayTestCase):
    def test_commands_are_redelivered_until_acked(self):
        self.host_push()
        seq = serve._room_add_command("ABC123", {"type": "next"})
        self.assertEqual(seq, 1)
        # Un-acked: the host sees it again on the next sync (idempotent-by-seq on its side).
        self.assertEqual([c["seq"] for c in self.host_push()["commands"]], [1])
        self.assertEqual([c["seq"] for c in self.host_push()["commands"]], [1])
        # Acked: dropped.
        self.assertEqual(self.host_push(ack=1)["commands"], [])

    def test_seq_is_monotonic_and_acking_is_a_high_water_mark(self):
        self.host_push()
        for i in range(1, 6):
            self.assertEqual(serve._room_add_command("ABC123", {"type": "play"}), i)
        left = self.host_push(ack=3)["commands"]
        self.assertEqual([c["seq"] for c in left], [4, 5])

    def test_unknown_command_types_are_rejected_at_the_door(self):
        self.host_push()
        self.assertEqual(serve._room_add_command("ABC123", {"type": "rm -rf"}), 0)
        self.assertEqual(serve._room_add_command("ABC123", {"type": "eval"}), 0)
        self.assertEqual(serve._room_add_command("ABC123", "not-a-dict"), 0)
        self.assertEqual(serve._room_add_command("ABC123", {}), 0)

    def test_react_is_an_accepted_type(self):
        self.host_push()
        self.assertEqual(serve._room_add_command("ABC123", {"type": "react", "emoji": "x"}), 1)

    def test_a_flood_cannot_grow_the_inbox_without_bound(self):
        self.host_push()
        for _ in range(serve.REMOTE_CMD_MAX + 50):
            serve._room_add_command("ABC123", {"type": "play"})
        self.assertEqual(len(serve._rooms["ABC123"]["commands"]), serve.REMOTE_CMD_MAX)

    def test_a_bad_ackseq_does_not_throw(self):
        self.host_push()
        serve._room_add_command("ABC123", {"type": "play"})
        self.assertTrue(self.host_push(ack="nonsense")["ok"])
        self.assertTrue(self.host_push(ack=None)["ok"])


class TestUnchangedShortCircuit(RelayTestCase):
    def test_matching_rev_short_circuits(self):
        self.host_push()
        rev = serve._room_state("ABC123", None)["rev"]
        self.assertTrue(serve._room_state("ABC123", rev).get("unchanged"))
        self.host_push()   # any push advances rev
        self.assertNotIn("unchanged", serve._room_state("ABC123", rev))


class TestYoutubeBlockRateLimit(RelayTestCase):
    def test_a_client_is_throttled_after_the_burst(self):
        # A blocked videoId is persistent, shared with every user, and has no un-block UI —
        # so an unthrottled reporter could censor real karaoke videos for the whole house.
        for i in range(serve.YT_BLOCK_RATE_MAX):
            self.assertTrue(serve._yt_block_allowed("10.0.0.5"), f"call {i}")
        self.assertFalse(serve._yt_block_allowed("10.0.0.5"))

    def test_the_window_reopens(self):
        for _ in range(serve.YT_BLOCK_RATE_MAX):
            serve._yt_block_allowed("10.0.0.5")
        self.assertFalse(serve._yt_block_allowed("10.0.0.5"))
        self.clock.advance(serve.YT_BLOCK_RATE_WINDOW + 1)
        self.assertTrue(serve._yt_block_allowed("10.0.0.5"))

    def test_clients_are_throttled_independently(self):
        for _ in range(serve.YT_BLOCK_RATE_MAX):
            serve._yt_block_allowed("10.0.0.5")
        self.assertFalse(serve._yt_block_allowed("10.0.0.5"))
        self.assertTrue(serve._yt_block_allowed("10.0.0.6"))


# A trimmed, structurally faithful ytInitialData payload: videoRenderers nested at a
# different depth from each other, exactly as YouTube's real response shuffles them.
YT_FIXTURE = {
    "contents": {
        "twoColumnSearchResultsRenderer": {
            "primaryContents": {
                "sectionListRenderer": {
                    "contents": [
                        {"itemSectionRenderer": {"contents": [
                            {"videoRenderer": {
                                "videoId": "abcdefghijk",
                                "title": {"runs": [{"text": "Tetoris "}, {"text": "(Karaoke)"}]},
                                "ownerText": {"runs": [{"text": "Some Channel"}]},
                            }},
                            {"shelfRenderer": {"content": {"verticalListRenderer": {"items": [
                                {"videoRenderer": {
                                    "videoId": "lmnopqrstuv",
                                    "title": {"simpleText": "Another Karaoke"},
                                    "ownerText": {"runs": [{"text": "Chan 2"}]},
                                }},
                            ]}}}},
                        ]}},
                    ],
                },
            },
        },
    },
}


class TestYoutubeScrapeParsing(unittest.TestCase):
    def test_finds_video_renderers_at_any_depth_in_document_order(self):
        got = [v["videoId"] for v in serve._iter_video_renderers(YT_FIXTURE)]
        self.assertEqual(got, ["abcdefghijk", "lmnopqrstuv"])

    def test_runs_text_handles_both_node_shapes(self):
        vids = list(serve._iter_video_renderers(YT_FIXTURE))
        self.assertEqual(serve._runs_text(vids[0]["title"]), "Tetoris (Karaoke)")   # runs[]
        self.assertEqual(serve._runs_text(vids[1]["title"]), "Another Karaoke")     # simpleText
        self.assertEqual(serve._runs_text(vids[0]["ownerText"]), "Some Channel")

    def test_runs_text_tolerates_junk(self):
        for junk in (None, "", 5, [], {}, {"runs": "nope"}, {"runs": [1, 2]}):
            self.assertEqual(serve._runs_text(junk), "")

    def test_a_reshaped_payload_yields_nothing_rather_than_throwing(self):
        # YouTube changing its markup must degrade to "no results", never a 500.
        self.assertEqual(list(serve._iter_video_renderers({"totally": "different"})), [])
        self.assertEqual(list(serve._iter_video_renderers([])), [])
        self.assertEqual(list(serve._iter_video_renderers(None)), [])

    def test_video_id_shape_is_validated_for_the_blocklist(self):
        self.assertTrue(serve._YT_ID_RE.match("abcdefghijk"))
        self.assertTrue(serve._YT_ID_RE.match("a-b_cdefghi"))
        for bad in ("short", "waaaaaaaaytoolong", "has space11", "../../etc/x"):
            self.assertIsNone(serve._YT_ID_RE.match(bad), bad)


class TestSoundfontValidation(unittest.TestCase):
    def test_rejects_a_small_or_wrong_magic_file(self):
        import tempfile
        with tempfile.TemporaryDirectory() as d:
            p = os.path.join(d, "sf.sf2")
            with open(p, "wb") as fh:
                fh.write(b"RIFF" + b"\x00" * 4 + b"sfbk")     # right magic, far too small
            self.assertFalse(serve._valid_soundfont(p))
            with open(p, "wb") as fh:                          # big enough, wrong magic
                fh.write(b"NOPE" + b"\x00" * 4 + b"junk" + b"\x00" * 1_000_001)
            self.assertFalse(serve._valid_soundfont(p))
            with open(p, "wb") as fh:                          # big enough, right magic
                fh.write(b"RIFF" + b"\x00" * 4 + b"sfbk" + b"\x00" * 1_000_001)
            self.assertTrue(serve._valid_soundfont(p))

    def test_a_missing_file_is_not_valid(self):
        self.assertFalse(serve._valid_soundfont("/no/such/soundfont.sf2"))


class TestPostLimits(unittest.TestCase):
    def test_the_body_cap_is_sane(self):
        # Every legitimate POST here is a few KB; the cap exists because one thread per
        # connection means an unbounded Content-Length pins memory and a thread.
        self.assertGreaterEqual(serve.MAX_POST_BYTES, 100_000)
        self.assertLessEqual(serve.MAX_POST_BYTES, 10_000_000)


if __name__ == "__main__":
    unittest.main()
