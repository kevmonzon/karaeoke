#!/usr/bin/env python3
"""
Build (and refresh) catalog-video.json for the karaoke-clone.

This is the VIDEO sibling of build-catalog.py. Where that script scans
kar_raw/ for MIDI/KAR payloads, this one scans videos/ for playable karaoke video
files (.mp4/.webm/.ogg/.mov) and emits a parallel catalog the app merges alongside
the MIDI one (tagging each row VID vs KAR).

Each record mirrors the MIDI catalog schema + the added `file` path, with `type`
forced to "VIDEO":
    { "code", "name", "artistName", "langName", "type":"VIDEO", "file" }

Filename grammar (same as the MIDI downloader's, `type` is ignored/overridden):
    {code} - {artistName} - {name} - {langName} - {type}.{ext}
Tolerant fallback: if the strict 5-field grammar doesn't match but a leading integer
code is present, the remainder becomes the title (artist/lang left blank) so
real-world filenames still catalog instead of being dropped.

Files with NO leading dial code are kept too (never skipped): they get a **blank
`code`**, the **filename (without extension) as the `name`**, and blank
`artistName`/`langName`. So any video file in videos/ ends up in the catalog.

A missing videos/ directory is fine — the script writes an empty [] and exits 0, so
serve.py's first-run setup never fails just because you haven't added videos yet.

Idempotent: safe to re-run. Writes catalog-video.json atomically (temp + replace).

Author : Elaina, the Ashen Engineer
Created: 2026-07-12
Stdlib only. Python 3.7+
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))   # …/tools
ROOT = os.path.dirname(HERE)                         # project root (parent of tools/)
# Data lives under DATA_DIR (default <project>/data; override with KARAEOKE_DATA_DIR).
DATA_DIR = os.path.abspath(os.environ.get("KARAEOKE_DATA_DIR") or os.path.join(ROOT, "data"))
DEFAULT_VIDEOS = os.path.join(DATA_DIR, "videos")
DEFAULT_OUT = os.path.join(DATA_DIR, "catalog-video.json")

VIDEO_EXTS = (".mp4", ".webm", ".ogg", ".mov", ".m4v")

# Non-song files that may live in videos/ and must never become records.
IGNORE_NAMES = {"desktop.ini", "thumbs.db", ".ds_store", "manifest.json"}

# Leading integer code, then the rest (same anchor as the MIDI builder).
_LEADING_CODE = re.compile(r"^(\d+)\s*-\s*(.*)$", re.DOTALL)


def parse_filename(filename: str):
    """
    '5 - Frank Sinatra - My Way - International - VIDEO.mp4'
      -> {code:5, artistName:'Frank Sinatra', name:'My Way',
          langName:'International', type:'VIDEO'}
    Strict grammar first; a lenient fallback keeps `{code} - anything` files.
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
        # back-anchored, exactly like the MIDI builder (a " - " inside the title is safe)
        lang = parts[-2].strip()
        artist = parts[0].strip()
        name = " - ".join(parts[1:-2]).strip()  # everything between artist and lang
    elif len(parts) == 3:
        # {artist} - {name} - {lang}
        artist, name, lang = parts[0].strip(), parts[1].strip(), parts[2].strip()
    elif len(parts) == 2:
        # {artist} - {name}
        artist, name, lang = parts[0].strip(), parts[1].strip(), ""
    else:
        # just a title after the code
        artist, name, lang = "", rest.strip(), ""

    return {
        "code": code,
        "name": name,
        "artistName": artist,
        "langName": lang,
        "type": "VIDEO",  # always — the extension already tells us it's video
    }


def index_videos(videos_dir: str, rel_base: str):
    """Scan videos/ once. Returns (coded, no_code, dup_codes).
    `coded` holds EVERY file with a leading dial code (duplicate codes are kept, not
    skipped — a code isn't a unique key; identity is resolved app-side by `id`). `no_code`
    holds files with no leading code — blank code, filename as the title. `dup_codes` is
    informational only."""
    coded = []
    no_code = []
    dup_codes = []
    seen_codes = set()

    if not os.path.isdir(videos_dir):
        return coded, no_code, dup_codes

    for fname in sorted(os.listdir(videos_dir)):
        full = os.path.join(videos_dir, fname)
        if not os.path.isfile(full):
            continue
        if fname.lower() in IGNORE_NAMES:
            continue
        if not fname.lower().endswith(VIDEO_EXTS):
            continue

        rel = os.path.join(rel_base, fname).replace(os.sep, "/")
        rec = parse_filename(fname)

        if rec is None:
            # No leading code: keep it anyway — blank code, filename as the title.
            base, _ext = os.path.splitext(fname)
            no_code.append({
                "code": "",
                "name": base,
                "artistName": "",
                "langName": "",
                "type": "VIDEO",
                "file": rel,
            })
            continue

        rec["file"] = rel
        if rec["code"] in seen_codes:
            dup_codes.append((rec["code"], fname))
        seen_codes.add(rec["code"])
        coded.append(rec)

    return coded, no_code, dup_codes


def write_json_atomic(path: str, data) -> None:
    d = os.path.dirname(os.path.abspath(path)) or "."
    fd, tmp = tempfile.mkstemp(prefix=".catalog-video-", suffix=".tmp", dir=d)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            json.dump(data, fh, ensure_ascii=False, indent=1)
        os.replace(tmp, path)
    finally:
        if os.path.exists(tmp):
            os.remove(tmp)


def main() -> int:
    ap = argparse.ArgumentParser(description="Build/refresh catalog-video.json.")
    ap.add_argument("--videos-dir", default=DEFAULT_VIDEOS,
                    help="folder holding the karaoke video files")
    ap.add_argument("--out", default=DEFAULT_OUT, help="output catalog-video.json path")
    args = ap.parse_args()

    out_dir = os.path.dirname(os.path.abspath(args.out)) or "."
    rel_base = os.path.relpath(args.videos_dir, out_dir).replace(os.sep, "/")

    if not os.path.isdir(args.videos_dir):
        print(f"videos dir not found ({args.videos_dir}) - writing empty catalog-video.json")
        write_json_atomic(args.out, [])
        print(f"Written  : {args.out}  (0 records)")
        return 0

    print(f"Scanning videos    : {args.videos_dir}")
    coded, no_code, dup_codes = index_videos(args.videos_dir, rel_base)
    print(f"  coded files      : {len(coded)}")
    if no_code:
        print(f"  no-code (kept)   : {len(no_code)}  e.g. {[r['name'] for r in no_code[:3]]}")
    if dup_codes:
        print(f"  shared codes (kept): {len(dup_codes)}  e.g. {dup_codes[:3]}")

    # Coded records first (stable sort by code → same-code songs keep scan order),
    # then no-code records (sorted by title).
    songs = sorted(coded, key=lambda r: r["code"])
    songs += sorted(no_code, key=lambda r: r["name"].lower())
    write_json_atomic(args.out, songs)

    print("\n===== Summary =====")
    print(f"Records  : {len(songs)}")
    print(f"Written  : {args.out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
