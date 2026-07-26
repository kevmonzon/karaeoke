#!/usr/bin/env python3
"""
Build (and refresh) catalog-audio.json for the karaoke-clone.

This is the AUDIO sibling of build-catalog.py / build-video-catalog.py. It scans
audio_lyrics/ for a recorded-audio file PAIRED WITH a separate lyrics sidecar and
emits a parallel catalog the app merges alongside the MIDI and video ones (tagging
each row AUDIO).

The novelty vs. the other builders: each song is TWO files that share a basename —
one audio payload plus one lyric sidecar. Files are grouped by basename (filename
minus extension); a group that has an audio file becomes one record, and its lyric
sidecar (if any) is attached as `lyrics`:
    { "code", "name", "artistName", "langName", "type":"AUDIO", "file", "lyrics"? }

  audio (played) : .mp3 .wav .flac .m4a .aac .opus .oga .ogg .weba .mp4
  lyric (sidecar): .lrc  >  .kar/.mid/.midi  >  .vtt/.srt  >  .txt   (priority when several)

A group with only a lyric file (no audio) is skipped — nothing to play. A group with
only audio (no sidecar) is still cataloged (plays with no lyric surface); `lyrics` is
then omitted.

Filename grammar (same as the other builders; `type` is ignored/overridden):
    {code} - {artistName} - {name} - {langName} - {type}.{ext}
Tolerant fallback: if the strict 5-field grammar doesn't match but a leading integer
code is present, the remainder becomes the title (artist/lang blank). Files with NO
leading dial code are kept too — blank `code`, filename (sans ext) as `name` — so
any real-world audio file still catalogs. `rel_base` is applied to BOTH `file` and
`lyrics` (each stored relative to the catalog's own directory).

A missing audio_lyrics/ directory is fine — writes an empty [] and exits 0, so
serve.py's first-run setup never fails just because you haven't added audio yet.

Idempotent: safe to re-run. Writes catalog-audio.json atomically (temp + replace).

Author : Elaina, the Ashen Engineer
Created: 2026-07-26
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
DEFAULT_AUDIO = os.path.join(DATA_DIR, "audio_lyrics")
DEFAULT_OUT = os.path.join(DATA_DIR, "catalog-audio.json")

# NOTE: .ogg is claimed by the VIDEO builder/server MIME; for audio-only Ogg prefer
# .oga/.opus. It's accepted here too since audio_lyrics/ is unambiguously audio.
AUDIO_EXTS = (".mp3", ".wav", ".flac", ".m4a", ".aac", ".opus", ".oga", ".ogg", ".weba", ".mp4")
LYRIC_EXTS = (".lrc", ".kar", ".mid", ".midi", ".vtt", ".srt", ".txt")
# Lower number = higher priority when a basename has more than one sidecar.
LYRIC_PRIORITY = {".lrc": 0, ".kar": 1, ".mid": 1, ".midi": 1, ".vtt": 2, ".srt": 2, ".txt": 3}

# Non-song files that may live in audio_lyrics/ and must never become records.
IGNORE_NAMES = {"desktop.ini", "thumbs.db", ".ds_store", "manifest.json"}

# Leading integer code, then the rest (same anchor as the other builders).
_LEADING_CODE = re.compile(r"^(\d+)\s*-\s*(.*)$", re.DOTALL)


def parse_filename(filename: str):
    """
    '9700 - Adele - Hello - International - AUDIO.mp3'
      -> {code:9700, artistName:'Adele', name:'Hello',
          langName:'International', type:'AUDIO'}
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
        # back-anchored, exactly like the other builders (a " - " inside the title is safe)
        lang = parts[-2].strip()
        artist = parts[0].strip()
        name = " - ".join(parts[1:-2]).strip()  # everything between artist and lang
    elif len(parts) == 3:
        artist, name, lang = parts[0].strip(), parts[1].strip(), parts[2].strip()
    elif len(parts) == 2:
        artist, name, lang = parts[0].strip(), parts[1].strip(), ""
    else:
        artist, name, lang = "", rest.strip(), ""

    return {
        "code": code,
        "name": name,
        "artistName": artist,
        "langName": lang,
        "type": "AUDIO",  # always — the folder already tells us it's an audio song
    }


def index_audio(audio_dir: str, rel_base: str):
    """Scan audio_lyrics/ once, grouping files by basename (name minus extension).
    Returns (coded, no_code, dup_codes, lyric_only).
      - each basename with an audio file -> one record, `lyrics` attached if a sidecar exists
      - EVERY coded record is kept (duplicate dial codes allowed — a code isn't a unique key;
        identity is resolved app-side by `id`). `dup_codes` is informational only.
      - a basename with only a lyric file -> counted in `lyric_only` (skipped)
      - `no_code` holds records for audio files with no leading dial code (kept, blank code)."""
    coded = []
    no_code = []
    dup_codes = []
    lyric_only = []
    seen_codes = set()

    if not os.path.isdir(audio_dir):
        return coded, no_code, dup_codes, lyric_only

    # basename -> {"audio": [fnames], "lyric": [fnames]}
    groups: dict[str, dict[str, list]] = {}
    for fname in sorted(os.listdir(audio_dir)):
        full = os.path.join(audio_dir, fname)
        if not os.path.isfile(full):
            continue
        if fname.lower() in IGNORE_NAMES:
            continue
        stem, ext = os.path.splitext(fname)
        ext = ext.lower()
        if ext in AUDIO_EXTS:
            groups.setdefault(stem, {"audio": [], "lyric": []})["audio"].append(fname)
        elif ext in LYRIC_EXTS:
            groups.setdefault(stem, {"audio": [], "lyric": []})["lyric"].append(fname)

    def pick_lyric(cands):
        # highest-priority sidecar; tie-break by filename for determinism
        return sorted(cands, key=lambda f: (LYRIC_PRIORITY.get(os.path.splitext(f)[1].lower(), 9), f))[0]

    for stem in sorted(groups):
        g = groups[stem]
        if not g["audio"]:
            lyric_only.append(stem)          # a sidecar with nothing to play
            continue

        audio_fname = sorted(g["audio"])[0]  # first by name if several audio files share a stem
        rec = parse_filename(audio_fname)
        audio_rel = os.path.join(rel_base, audio_fname).replace(os.sep, "/")

        if rec is None:
            # No leading code: keep it anyway — blank code, filename as the title.
            rec = {"code": "", "name": stem, "artistName": "", "langName": "", "type": "AUDIO"}
            rec["file"] = audio_rel
            if g["lyric"]:
                rec["lyrics"] = os.path.join(rel_base, pick_lyric(g["lyric"])).replace(os.sep, "/")
            no_code.append(rec)
            continue

        rec["file"] = audio_rel
        if g["lyric"]:
            rec["lyrics"] = os.path.join(rel_base, pick_lyric(g["lyric"])).replace(os.sep, "/")

        if rec["code"] in seen_codes:
            dup_codes.append((rec["code"], audio_fname))
        seen_codes.add(rec["code"])
        coded.append(rec)

    return coded, no_code, dup_codes, lyric_only


def write_json_atomic(path: str, data) -> None:
    d = os.path.dirname(os.path.abspath(path)) or "."
    fd, tmp = tempfile.mkstemp(prefix=".catalog-audio-", suffix=".tmp", dir=d)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            json.dump(data, fh, ensure_ascii=False, indent=1)
        os.replace(tmp, path)
    finally:
        if os.path.exists(tmp):
            os.remove(tmp)


def main() -> int:
    ap = argparse.ArgumentParser(description="Build/refresh catalog-audio.json.")
    ap.add_argument("--audio-dir", default=DEFAULT_AUDIO,
                    help="folder holding the audio + lyric sidecar files")
    ap.add_argument("--out", default=DEFAULT_OUT, help="output catalog-audio.json path")
    args = ap.parse_args()

    out_dir = os.path.dirname(os.path.abspath(args.out)) or "."
    rel_base = os.path.relpath(args.audio_dir, out_dir).replace(os.sep, "/")

    if not os.path.isdir(args.audio_dir):
        print(f"audio dir not found ({args.audio_dir}) - writing empty catalog-audio.json")
        write_json_atomic(args.out, [])
        print(f"Written  : {args.out}  (0 records)")
        return 0

    print(f"Scanning audio     : {args.audio_dir}")
    coded, no_code, dup_codes, lyric_only = index_audio(args.audio_dir, rel_base)
    print(f"  coded songs      : {len(coded)}")
    with_lyrics = sum(1 for r in coded + no_code if r.get("lyrics"))
    print(f"  with lyrics      : {with_lyrics}")
    if no_code:
        print(f"  no-code (kept)   : {len(no_code)}  e.g. {[r['name'] for r in no_code[:3]]}")
    if lyric_only:
        print(f"  lyric-only (skip): {len(lyric_only)}  e.g. {lyric_only[:3]}")
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
