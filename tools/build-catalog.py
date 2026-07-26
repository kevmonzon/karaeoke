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
import glob
import json
import os
import re
import sys
import tempfile
import time

HERE = os.path.dirname(os.path.abspath(__file__))   # …/tools
ROOT = os.path.dirname(HERE)                         # project root (parent of tools/)
# Data lives under DATA_DIR (default <project>/data; override with KARAEOKE_DATA_DIR).
DATA_DIR = os.path.abspath(os.environ.get("KARAEOKE_DATA_DIR") or os.path.join(ROOT, "data"))
DEFAULT_DOWNLOADS = os.path.join(DATA_DIR, "kar_raw")
DEFAULT_OUT = os.path.join(DATA_DIR, "catalog.json")

# Non-song files that live in kar_raw/ and must never become catalog records.
IGNORE_NAMES = {"desktop.ini", "thumbs.db", ".ds_store"}

# Filename grammar. code is a leading integer; the trailing " - <lang> - <type>"
# is anchored from the RIGHT so that a " - " inside a song title never corrupts
# the code / langName / type fields. Whatever remains in the middle is the artist
# (first chunk) and the name (the rest, re-joined) -- robust to future titles.
_LEADING_CODE = re.compile(r"^(\d+)\s*-\s*(.*)$", re.DOTALL)


def parse_filename(filename: str):
    """
    '1 - Bryan Chong - Tahan - International - MIDI.mid'
      -> {code:1, artistName:'Bryan Chong', name:'Tahan',
          langName:'International', type:'MIDI'}
    Strict 5-field grammar first; a lenient fallback keeps shorter
    '{code} - …' filenames so a missing langName/type degrades gracefully
    (langName -> '', type -> 'MIDI') instead of the song being dropped.
    Returns None only when there is no leading integer code at all.
    """
    base, _ext = os.path.splitext(filename)

    m = _LEADING_CODE.match(base)
    if not m:
        return None
    code = int(m.group(1))
    rest = m.group(2)

    parts = rest.split(" - ")
    if len(parts) >= 4:
        # back-anchored full grammar: code - artist - name - lang - type
        # (a " - " inside the title stays safe -- name is the re-joined middle)
        type_ = parts[-1].strip()
        lang = parts[-2].strip()
        artist = parts[0].strip()
        name = " - ".join(parts[1:-2]).strip()
    elif len(parts) == 3:
        # code - artist - name - lang   (type missing -> default MIDI)
        artist, name, lang = parts[0].strip(), parts[1].strip(), parts[2].strip()
        type_ = "MIDI"
    elif len(parts) == 2:
        # code - artist - name         (lang + type missing)
        artist, name, lang = parts[0].strip(), parts[1].strip(), ""
        type_ = "MIDI"
    else:
        # just a title after the code
        artist, name, lang = "", rest.strip(), ""
        type_ = "MIDI"

    return {
        "code": code,
        "name": name,
        "artistName": artist,
        "langName": lang,
        "type": type_,
    }


def index_downloads(downloads_dir: str, rel_base: str):
    """
    Scan downloads/ once. Return:
      records_by_code : {code -> parsed record (with 'file' relative path)}
      unparsed        : [filenames that didn't match the grammar]
    First file wins per code; later collisions are reported.
    """
    records_by_code = {}
    unparsed = []
    collisions = []

    entries = sorted(os.listdir(downloads_dir))
    for fname in entries:
        full = os.path.join(downloads_dir, fname)
        if not os.path.isfile(full):
            continue
        if fname.lower() in IGNORE_NAMES:
            continue
        if fname.startswith("_failures-"):  # downloader's own log files
            continue

        rec = parse_filename(fname)
        if rec is None:
            unparsed.append(fname)
            continue

        rel = os.path.join(rel_base, fname).replace(os.sep, "/")
        rec["file"] = rel

        if rec["code"] in records_by_code:
            collisions.append((rec["code"], fname))
            continue
        records_by_code[rec["code"]] = rec

    return records_by_code, unparsed, collisions


def write_json_atomic(path: str, data) -> None:
    d = os.path.dirname(os.path.abspath(path)) or "."
    fd, tmp = tempfile.mkstemp(prefix=".catalog-", suffix=".tmp", dir=d)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            json.dump(data, fh, ensure_ascii=False, indent=1)
        os.replace(tmp, path)
    finally:
        if os.path.exists(tmp):
            os.remove(tmp)


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
    by_code, unparsed, collisions = index_downloads(args.downloads_dir, rel_base)
    print(f"  parsed files     : {len(by_code)}")
    if unparsed:
        print(f"  unparsed (skipped): {len(unparsed)}  e.g. {unparsed[:3]}")
    if collisions:
        print(f"  duplicate codes  : {len(collisions)}  e.g. {collisions[:3]}")

    songs = sorted(by_code.values(), key=lambda r: r["code"])
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
