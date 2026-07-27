#!/usr/bin/env python3
"""
catalog_common.py — shared helpers for the three catalog builders
(build-catalog.py / build-video-catalog.py / build-audio-catalog.py).

The builders scan different folders and shape slightly different records, but they
all parse the SAME filename grammar and write JSON the same way. Keeping that logic
here stops the three copies from drifting (they already had, before this module:
divergent IGNORE_NAMES and an extension-filter gap in the MIDI builder).

Filename grammar:
    {code} - {artistName} - {name} - {langName} - {type}.{ext}
`code` is a leading integer; the trailing " - <lang> - <type>" is anchored from the
RIGHT so a " - " inside a title never corrupts the code/lang/type fields. Shorter
forms degrade gracefully. See §6 in CLAUDE.md.

Stdlib only. Python 3.7+.
Author: Elaina, the Ashen Engineer
"""

from __future__ import annotations

import json
import os
import re
import tempfile

# Non-song files that may live in a payload folder and must never become records.
# (Includes manifest.json — the BGV manifest — so it's ignored uniformly by all builders.)
IGNORE_NAMES = {"desktop.ini", "thumbs.db", ".ds_store", "manifest.json"}

# Leading integer dial code, then the rest.
_LEADING_CODE = re.compile(r"^(\d+)\s*-\s*(.*)$", re.DOTALL)


def parse_filename(filename: str, *, force_type: str | None = None, default_type: str = "MIDI"):
    """
    '1 - Bryan Chong - Tahan - International - MIDI.mid'
      -> {code:1, artistName:'Bryan Chong', name:'Tahan',
          langName:'International', type:'MIDI'}

    Strict 5-field grammar first; a lenient fallback keeps shorter '{code} - …'
    filenames so a missing langName/type degrades gracefully instead of the song
    being dropped. Returns None only when there is no leading integer code at all.

    force_type    : override the `type` regardless of the filename (VIDEO / AUDIO
                    builders force this, since the folder/extension already tells us).
    default_type  : `type` when the grammar carries none (MIDI builder uses "MIDI").
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
        # (a " - " inside the title stays safe — name is the re-joined middle)
        type_ = parts[-1].strip()
        lang = parts[-2].strip()
        artist = parts[0].strip()
        name = " - ".join(parts[1:-2]).strip()
    elif len(parts) == 3:
        artist, name, lang = parts[0].strip(), parts[1].strip(), parts[2].strip()
        type_ = default_type
    elif len(parts) == 2:
        artist, name, lang = parts[0].strip(), parts[1].strip(), ""
        type_ = default_type
    else:
        artist, name, lang = "", rest.strip(), ""
        type_ = default_type

    if force_type:
        type_ = force_type

    return {
        "code": code,
        "name": name,
        "artistName": artist,
        "langName": lang,
        "type": type_,
    }


def write_json_atomic(path: str, data, *, prefix: str = ".catalog-") -> None:
    """Write `data` as JSON to `path` atomically (temp file in the same dir + os.replace),
    so a reader never sees a half-written catalog."""
    d = os.path.dirname(os.path.abspath(path)) or "."
    fd, tmp = tempfile.mkstemp(prefix=prefix, suffix=".tmp", dir=d)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            json.dump(data, fh, ensure_ascii=False, indent=1)
        os.replace(tmp, path)
    finally:
        if os.path.exists(tmp):
            os.remove(tmp)
