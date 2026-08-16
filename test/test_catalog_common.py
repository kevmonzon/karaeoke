#!/usr/bin/env python3
"""
test_catalog_common.py — the filename grammar every catalog depends on.

Run with:  python3 -m unittest discover -s test -p 'test_*.py' -t .   (or `npm test`)

`parse_filename` is the single point where a file on disk becomes a song in the library, and
its failure mode is silent: a filename it can't parse produces no record, no warning, and a
song that simply isn't in the songbook. It also has four fallback branches for shorter
filenames, which is exactly the kind of logic that regresses without anybody noticing.

Stdlib unittest only — same "no dependencies" rule the rest of the tooling follows.
"""

import json
import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "tools"))

from catalog_common import IGNORE_NAMES, parse_filename, write_json_atomic  # noqa: E402


class TestParseFilename(unittest.TestCase):
    def test_full_grammar(self):
        r = parse_filename("1 - Bryan Chong - Tahan - International - MIDI.mid")
        self.assertEqual(r, {
            "code": 1, "name": "Tahan", "artistName": "Bryan Chong",
            "langName": "International", "type": "MIDI",
        })

    def test_separator_inside_the_title_is_safe(self):
        # lang/type are anchored from the RIGHT, so " - " in a title can't corrupt them.
        r = parse_filename("42 - Artist - Some - Long - Title - OPM - MIDI.mid")
        self.assertEqual(r["artistName"], "Artist")
        self.assertEqual(r["name"], "Some - Long - Title")
        self.assertEqual(r["langName"], "OPM")
        self.assertEqual(r["type"], "MIDI")

    def test_shorter_forms_degrade_instead_of_dropping_the_song(self):
        # 3 fields: no type
        r = parse_filename("29160 - Rockstar 2 - O Bakit Ba - OPM.mid")
        self.assertEqual((r["code"], r["artistName"], r["name"], r["langName"], r["type"]),
                         (29160, "Rockstar 2", "O Bakit Ba", "OPM", "MIDI"))
        # 2 fields: no lang, no type
        r = parse_filename("29160 - Rockstar 2 - O Bakit Ba.mid")
        self.assertEqual((r["artistName"], r["name"], r["langName"]), ("Rockstar 2", "O Bakit Ba", ""))
        # 1 field: title only
        r = parse_filename("777 - Just A Title.mid")
        self.assertEqual((r["artistName"], r["name"]), ("", "Just A Title"))

    def test_no_leading_code_is_rejected(self):
        # The MIDI builder treats the dial code as the primary key, so this must be None
        # (the video/audio builders keep such files with a blank code — that's their choice,
        # made at the call site, not here).
        self.assertIsNone(parse_filename("No Code Here - Artist - Title.mid"))
        self.assertIsNone(parse_filename("  - Artist - Title.mid"))
        self.assertIsNone(parse_filename(""))

    def test_zero_padded_codes_collapse_to_int(self):
        # Documented behaviour, pinned deliberately: real library files ARE zero-padded
        # ("003062 - …"), and the padding is dropped. If dial search ever needs to honour
        # padding, this test is the thing that will fail and say so.
        self.assertEqual(parse_filename("003062 - A - B - C - MIDI.mid")["code"], 3062)
        self.assertEqual(parse_filename("3062 - A - B - C - MIDI.mid")["code"], 3062)

    def test_force_type_and_default_type(self):
        r = parse_filename("5 - A - B - Lang - MIDI.webm", force_type="VIDEO")
        self.assertEqual(r["type"], "VIDEO")           # the folder/extension wins
        r = parse_filename("5 - A - B.mp3", default_type="AUDIO")
        self.assertEqual(r["type"], "AUDIO")           # grammar carried none

    def test_whitespace_is_trimmed(self):
        r = parse_filename("7 -  Artist   -  Title  -  Lang  -  MIDI .mid")
        self.assertEqual(r["artistName"], "Artist")
        self.assertEqual(r["langName"], "Lang")
        self.assertEqual(r["type"], "MIDI")

    def test_extension_is_ignored_not_parsed(self):
        self.assertEqual(parse_filename("9 - A - B - C - MIDI.kar")["name"], "B")
        self.assertEqual(parse_filename("9 - A - B - C - MIDI")["name"], "B")  # no extension at all

    def test_ignore_names_are_lowercase_for_case_folded_comparison(self):
        # Callers compare `name.lower() in IGNORE_NAMES`; an uppercase entry here would
        # silently never match.
        for n in IGNORE_NAMES:
            self.assertEqual(n, n.lower())


class TestWriteJsonAtomic(unittest.TestCase):
    def test_writes_and_replaces(self):
        with tempfile.TemporaryDirectory() as d:
            path = os.path.join(d, "catalog.json")
            write_json_atomic(path, [{"code": 1}])
            with open(path, encoding="utf-8") as fh:
                self.assertEqual(json.load(fh), [{"code": 1}])
            write_json_atomic(path, [{"code": 2}])       # overwrite in place
            with open(path, encoding="utf-8") as fh:
                self.assertEqual(json.load(fh), [{"code": 2}])

    def test_leaves_no_temp_files_behind(self):
        with tempfile.TemporaryDirectory() as d:
            path = os.path.join(d, "catalog.json")
            write_json_atomic(path, {"a": 1})
            self.assertEqual(os.listdir(d), ["catalog.json"])

    def test_a_failed_write_neither_clobbers_nor_litters(self):
        # The whole point of the temp-file dance: a reader must never see a half-written
        # catalog, and a crash mid-serialize must leave the previous one intact.
        with tempfile.TemporaryDirectory() as d:
            path = os.path.join(d, "catalog.json")
            write_json_atomic(path, [{"code": 1}])

            class Unserializable:
                pass

            with self.assertRaises(TypeError):
                write_json_atomic(path, [Unserializable()])
            with open(path, encoding="utf-8") as fh:
                self.assertEqual(json.load(fh), [{"code": 1}])   # previous content survived
            self.assertEqual(os.listdir(d), ["catalog.json"])    # no .tmp left behind

    def test_non_ascii_survives_the_round_trip(self):
        with tempfile.TemporaryDirectory() as d:
            path = os.path.join(d, "c.json")
            write_json_atomic(path, [{"name": "Ka-Rae-oke — Tagalog · 日本語"}])
            with open(path, encoding="utf-8") as fh:
                self.assertEqual(json.load(fh)[0]["name"], "Ka-Rae-oke — Tagalog · 日本語")


if __name__ == "__main__":
    unittest.main()
