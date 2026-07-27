#!/usr/bin/env python3
"""
Build (and refresh) catalog.json for the karaoke player.

Each record has the shape:
    { "code", "name", "artistName", "langName", "type", "file" }
where "file" is the relative path to the local song payload in kar_raw/
(null if not present).

Scans kar_raw/, parses each filename, and emits one record per file
-> catalog.json = "what I can actually play right now".

Filenames follow this convention:
    {code} - {artistName} - {name} - {langName} - {type}.{ext}
Tolerant fallback: if the strict 5-field grammar doesn't match but a leading
integer code is present, the remainder is still parsed (missing langName -> '',
missing type -> 'MIDI') so real-world filenames catalog instead of being dropped.
Only files with no leading dial code are skipped.

Idempotent: safe to re-run. Writes catalog.json atomically (temp file + replace).

Author : Elaina, the Ashen Engineer
Created: 2026-07-12
Stdlib only (no pip install needed). Python 3.7+
"""

from __future__ import annotations

import argparse
import os
import sys

from catalog_common import IGNORE_NAMES, parse_filename, write_json_atomic

HERE = os.path.dirname(os.path.abspath(__file__))   # …/tools
ROOT = os.path.dirname(HERE)                         # project root (parent of tools/)
# Data lives under DATA_DIR (default <project>/data; override with KARAEOKE_DATA_DIR).
DATA_DIR = os.path.abspath(os.environ.get("KARAEOKE_DATA_DIR") or os.path.join(ROOT, "data"))
DEFAULT_DOWNLOADS = os.path.join(DATA_DIR, "kar_raw")
DEFAULT_OUT = os.path.join(DATA_DIR, "catalog.json")

# Payload extensions in kar_raw/ (raw-DEFLATE MIDI/KAR). Whitelisting keeps stray
# non-payloads (e.g. an interrupted download's `.part`) out of the catalog — matching
# how the video/audio builders filter by extension.
MIDI_EXTS = (".mid", ".midi", ".kar")


def index_downloads(downloads_dir: str, rel_base: str):
    """
    Scan downloads/ once. Return:
      records  : [parsed record (with 'file' relative path)] — EVERY parsed file, in scan order
      unparsed : [filenames that didn't match the grammar]
      dup_codes: [(code, filename)] where a dial code repeats — KEPT (not skipped), reported only
    Duplicate dial codes are allowed: a code is not a unique key, so every song is emitted.
    Identity is resolved app-side by `id` (kind:code, disambiguated by file path on a collision —
    see catalog.js / §5.10). Numeric dial-search still resolves to the first match.
    """
    records = []
    unparsed = []
    dup_codes = []
    seen_codes = set()

    entries = sorted(os.listdir(downloads_dir))
    for fname in entries:
        full = os.path.join(downloads_dir, fname)
        if not os.path.isfile(full):
            continue
        if fname.lower() in IGNORE_NAMES:
            continue
        if fname.startswith("_failures-"):  # downloader's own log files
            continue
        if not fname.lower().endswith(MIDI_EXTS):  # skip non-payloads (e.g. a `.part`)
            continue

        rec = parse_filename(fname)  # default_type "MIDI" (grammar may still carry a type)
        if rec is None:
            unparsed.append(fname)
            continue

        rec["file"] = os.path.join(rel_base, fname).replace(os.sep, "/")
        if rec["code"] in seen_codes:
            dup_codes.append((rec["code"], fname))
        seen_codes.add(rec["code"])
        records.append(rec)

    return records, unparsed, dup_codes


def main() -> int:
    ap = argparse.ArgumentParser(description="Build/refresh catalog.json.")
    ap.add_argument("--downloads-dir", default=DEFAULT_DOWNLOADS,
                    help="folder holding the downloaded song files")
    ap.add_argument("--out", default=DEFAULT_OUT, help="output catalog.json path")
    args = ap.parse_args()

    if not os.path.isdir(args.downloads_dir):
        print(f"downloads dir not found: {args.downloads_dir}", file=sys.stderr)
        return 1

    # file paths are stored relative to the catalog.json location (usually project root)
    out_dir = os.path.dirname(os.path.abspath(args.out)) or "."
    rel_base = os.path.relpath(args.downloads_dir, out_dir).replace(os.sep, "/")

    print(f"Scanning songs     : {args.downloads_dir}")
    records, unparsed, dup_codes = index_downloads(args.downloads_dir, rel_base)
    print(f"  parsed files     : {len(records)}")
    if unparsed:
        print(f"  unparsed (skipped): {len(unparsed)}  e.g. {unparsed[:3]}")
    if dup_codes:
        print(f"  shared codes (kept): {len(dup_codes)}  e.g. {dup_codes[:3]}")

    # Stable sort by code keeps same-code songs in scan (filename) order.
    songs = sorted(records, key=lambda r: r["code"])
    source = "local"

    # catalog.json = a bare array of records (each with the added local `file` path),
    # consumed directly by the app's Catalog loader.
    write_json_atomic(args.out, songs)

    print("\n===== Summary =====")
    print(f"Source   : {source}")
    print(f"Records  : {len(songs)}")
    print(f"With file: {sum(1 for s in songs if s.get('file'))}")
    print(f"Written  : {args.out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
