#!/usr/bin/env python3
"""
test_catalog_source.py — the songbook (`source`) tag every catalog record now carries.

Run with:  python3 -m unittest discover -s test -p 'test_*.py' -t test   (or `npm test`)

The real library's filenames end in the songbook they came from (SH, PLATKAR, TJMEDIA or
MIDI), not in a media type. Before `source` existed that tag landed in `type`, `langName`
or — for the 6,463 two-field SH/PLATKAR files — in `name`, so those songs were listed under
the title "SH". These tests pin the per-songbook mapping, and that the builders carry the
field through in the documented key order.

Stdlib unittest only — same "no dependencies" rule the rest of the tooling follows.
"""

import importlib.util
import os
import sys
import tempfile
import unittest

TOOLS = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "tools")
sys.path.insert(0, TOOLS)

from catalog_common import SOURCE_TAGS, parse_filename, split_source  # noqa: E402

RECORD_KEYS = ["code", "name", "artistName", "langName", "type", "source"]


def _load_builder(filename, module_name):
    """Import a hyphenated builder script (tools/build-*.py) as a module."""
    spec = importlib.util.spec_from_file_location(module_name, os.path.join(TOOLS, filename))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def _fields(r):
    return (r["artistName"], r["name"], r["langName"], r["source"], r["type"])


class TestSplitSource(unittest.TestCase):
    def test_split_source_known_tags(self):
        self.assertEqual(SOURCE_TAGS, ("SH", "PLATKAR", "TJMEDIA", "MIDI"))
        for tag in SOURCE_TAGS:
            for spelling in (tag, tag.lower(), tag.capitalize()):
                with self.subTest(spelling=spelling):
                    self.assertEqual(split_source(f"00099 - Bosom Buddies - {spelling}"),
                                     ("00099 - Bosom Buddies", tag))
        # spaces around the last field are not part of the tag
        self.assertEqual(split_source("7 - Artist - Title -  sh "), ("7 - Artist - Title", "SH"))

    def test_split_source_unknown_is_empty(self):
        for base in ("00099 - Bosom Buddies",          # no tag
                     "29160 - Rockstar 2 - OPM",       # a language, not a songbook
                     "5 - Artist - Smash",             # ends in "sh", but not as a whole field
                     "5 - Artist - TJ MEDIA",          # not the canonical spelling
                     "SH",                             # nothing to pop it from
                     ""):
            with self.subTest(base=base):
                self.assertEqual(split_source(base), (base, ""))


class TestParseFilenameSource(unittest.TestCase):
    def test_three_field_sh_file(self):
        r = parse_filename("00001 - Francesca Beghe - Trust in Me - SH.kar")
        self.assertEqual(r["code"], 1)
        self.assertEqual(_fields(r), ("Francesca Beghe", "Trust in Me", "", "SH", "MIDI"))

    def test_two_field_sh_file_keeps_its_title(self):
        # The bug this field exists to fix: the old 2-field rule made the title the
        # artist and the songbook tag the title.
        r = parse_filename("00099 - Bosom Buddies - SH.kar")
        self.assertEqual(r["name"], "Bosom Buddies")
        self.assertEqual(r["artistName"], "")
        self.assertEqual(r["source"], "SH")
        self.assertEqual(r["langName"], "")

    def test_two_field_platkar_file_keeps_its_title(self):
        r = parse_filename("00068 - Your cheatin' heart - PLATKAR.mid")
        self.assertEqual(r["code"], 68)
        self.assertEqual(_fields(r), ("", "Your cheatin' heart", "", "PLATKAR", "MIDI"))

    def test_tjmedia_four_fields(self):
        r = parse_filename("000147 - APO HIKING SOCIETY - Awit Ng Barkada - AB - TJMEDIA.mid")
        self.assertEqual(r["code"], 147)
        self.assertEqual(_fields(r), ("APO HIKING SOCIETY", "Awit Ng Barkada", "AB", "TJMEDIA", "MIDI"))

    def test_megaoke_five_fields_rejoins_title(self):
        r = parse_filename("42 - Artist - Some - Long Title - OPM - MIDI.mid")
        self.assertEqual(_fields(r), ("Artist", "Some - Long Title", "OPM", "MIDI", "MIDI"))
        # the full five-field grammar, tag in lower case
        r = parse_filename("1 - Bryan Chong - Tahan - International - midi.mid")
        self.assertEqual(_fields(r), ("Bryan Chong", "Tahan", "International", "MIDI", "MIDI"))

    def test_megaoke_three_fields(self):
        r = parse_filename("0 - Pan - Tabun - MIDI.kar")
        self.assertEqual(r["code"], 0)
        self.assertEqual(_fields(r), ("Pan", "Tabun", "", "MIDI", "MIDI"))

    def test_sh_title_with_separator_goes_to_name(self):
        # SH/PLATKAR files carry no language, so everything after the artist is the title.
        r = parse_filename("00002 - Artist - Title - Part Two - SH.kar")
        self.assertEqual(_fields(r), ("Artist", "Title - Part Two", "", "SH", "MIDI"))
        r = parse_filename("00003 - Artist - A - B - C - PLATKAR.mid")
        self.assertEqual(_fields(r), ("Artist", "A - B - C", "", "PLATKAR", "MIDI"))

    def test_single_field_before_a_tag_is_the_title(self):
        r = parse_filename("12 - Only A Title - TJMEDIA.mid")
        self.assertEqual(_fields(r), ("", "Only A Title", "", "TJMEDIA", "MIDI"))
        # a lone field is never popped as a tag: it is the title, and the file has no source
        r = parse_filename("12 - SH.kar")
        self.assertEqual(_fields(r), ("", "SH", "", "", "MIDI"))

    def test_untagged_file_uses_old_rules(self):
        r = parse_filename("29160 - Rockstar 2 - O Bakit Ba - OPM.mid")
        self.assertEqual(_fields(r), ("Rockstar 2", "O Bakit Ba", "OPM", "", "MIDI"))
        r = parse_filename("29160 - Rockstar 2 - O Bakit Ba.mid")
        self.assertEqual(_fields(r), ("Rockstar 2", "O Bakit Ba", "", "", "MIDI"))
        r = parse_filename("777 - Just A Title.mid")
        self.assertEqual(_fields(r), ("", "Just A Title", "", "", "MIDI"))
        # >= 4 fields: lang is still anchored second from the right; the last field is no
        # longer copied into `type`, which is the builder's media type only.
        r = parse_filename("5 - Artist - Some - Title - OPM - KARAOKE.mid")
        self.assertEqual(_fields(r), ("Artist", "Some - Title", "OPM", "", "MIDI"))
        self.assertIsNone(parse_filename("Bosom Buddies - SH.kar"))  # still no code → None

    def test_force_type_wins_and_source_survives(self):
        # the audio/video builders force the media type; the songbook tag is kept apart
        r = parse_filename("000147 - APO HIKING SOCIETY - Awit Ng Barkada - AB - TJMEDIA.mp3",
                           force_type="AUDIO")
        self.assertEqual(_fields(r), ("APO HIKING SOCIETY", "Awit Ng Barkada", "AB", "TJMEDIA", "AUDIO"))
        r = parse_filename("9 - Artist - Title - SH.webm", force_type="VIDEO")
        self.assertEqual(_fields(r), ("Artist", "Title", "", "SH", "VIDEO"))
        r = parse_filename("9 - Artist - Title.mp3", default_type="AUDIO")
        self.assertEqual((r["type"], r["source"]), ("AUDIO", ""))

    def test_type_is_never_a_source_tag(self):
        for tag in SOURCE_TAGS:
            for name in (f"1 - A - B - {tag}.mid", f"1 - A - B - C - {tag}.mid", f"1 - B - {tag}.mid"):
                with self.subTest(name=name):
                    r = parse_filename(name, default_type="KAR")
                    self.assertEqual((r["type"], r["source"]), ("KAR", tag))

    def test_record_key_order(self):
        for name in ("1 - A - B - C - MIDI.mid", "1 - B - SH.kar", "1 - A - B.mid"):
            with self.subTest(name=name):
                self.assertEqual(list(parse_filename(name)), RECORD_KEYS)


class TestBuildersCarrySource(unittest.TestCase):
    """The builders' scan functions, run over throwaway folders (nothing under data/)."""

    def _touch(self, d, *names):
        for n in names:
            with open(os.path.join(d, n), "wb"):
                pass

    def test_midi_builder_records(self):
        build = _load_builder("build-catalog.py", "build_catalog_under_test")
        with tempfile.TemporaryDirectory() as d:
            self._touch(d, "00099 - Bosom Buddies - SH.kar", "000147 - APO - Awit - AB - TJMEDIA.mid")
            records, unparsed, _dups = build.index_downloads(d, "kar_raw")
        self.assertEqual(unparsed, [])
        by_code = {r["code"]: r for r in records}
        self.assertEqual(list(by_code[99]), RECORD_KEYS + ["file"])
        self.assertEqual((by_code[99]["name"], by_code[99]["source"]), ("Bosom Buddies", "SH"))
        self.assertEqual((by_code[147]["langName"], by_code[147]["source"]), ("AB", "TJMEDIA"))

    def test_video_builder_records(self):
        build = _load_builder("build-video-catalog.py", "build_video_catalog_under_test")
        with tempfile.TemporaryDirectory() as d:
            self._touch(d, "9 - Artist - Title - SH.mp4", "No Code Clip.webm")
            coded, no_code, _dups = build.index_videos(d, "videos")
        self.assertEqual(list(coded[0]), RECORD_KEYS + ["file"])
        self.assertEqual((coded[0]["type"], coded[0]["source"]), ("VIDEO", "SH"))
        self.assertEqual(list(no_code[0]), RECORD_KEYS + ["file"])
        self.assertEqual(no_code[0]["source"], "")

    def test_audio_builder_records(self):
        build = _load_builder("build-audio-catalog.py", "build_audio_catalog_under_test")
        with tempfile.TemporaryDirectory() as d:
            self._touch(d, "147 - APO - Awit - AB - TJMEDIA.mp3", "147 - APO - Awit - AB - TJMEDIA.lrc",
                        "No Code Song.mp3", "No Code Song.lrc")
            coded, no_code, _dups, _lyric_only = build.index_audio(d, "audio_lyrics")
        self.assertEqual(list(coded[0]), RECORD_KEYS + ["file", "lyrics"])
        self.assertEqual((coded[0]["type"], coded[0]["source"]), ("AUDIO", "TJMEDIA"))
        self.assertEqual(list(no_code[0]), RECORD_KEYS + ["file", "lyrics"])
        self.assertEqual(no_code[0]["source"], "")


if __name__ == "__main__":
    unittest.main()
