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

Source tag: in the real library the last field is not a media type but the songbook
the file came from (SH, PLATKAR, TJMEDIA or MIDI). When it is one of SOURCE_TAGS it is
popped into `source` and the rest is mapped per songbook (see parse_filename); `type`
is then only ever the media type the builder asks for.

Stdlib only. Python 3.7+.
Author: Elaina, the Ashen Engineer
"""

from __future__ import annotations

import json
import os
import re
import tempfile

# Non-song files that may live in a payload folder and must never become records.
IGNORE_NAMES = {"desktop.ini", "thumbs.db", ".ds_store"}

# Leading integer dial code, then the rest.
_LEADING_CODE = re.compile(r"^(\d+)\s*-\s*(.*)$", re.DOTALL)

# The songbook a file came from, carried as its LAST " - " field. Canonical upper case.
SOURCE_TAGS = ("SH", "PLATKAR", "TJMEDIA", "MIDI")
_SOURCE_SET = frozenset(SOURCE_TAGS)
# Songbooks whose files never carry a language field: "{artist} - {title} - TAG".
_NO_LANG_SOURCES = frozenset(("SH", "PLATKAR"))


def split_source(base: str) -> tuple[str, str]:
    """Pop a trailing source tag off a filename stem.

    '00099 - Bosom Buddies - SH' -> ('00099 - Bosom Buddies', 'SH')
    '00099 - Bosom Buddies'      -> ('00099 - Bosom Buddies', '')

    The tag must be a whole " - " field (case-insensitive, surrounding spaces ignored);
    the returned tag is the canonical upper-case spelling. A string with no " - "
    separator has no field to pop, so it is returned unchanged with an empty tag.
    """
    head, sep, last = base.rpartition(" - ")
    if sep:
        tag = last.strip().upper()
        if tag in _SOURCE_SET:
            return head, tag
    return base, ""


def parse_filename(filename: str, *, force_type: str | None = None, default_type: str = "MIDI"):
    """
    '1 - Bryan Chong - Tahan - International - MIDI.mid'
      -> {code:1, name:'Tahan', artistName:'Bryan Chong',
          langName:'International', type:'MIDI', source:'MIDI'}

    Returns None only when there is no leading integer code at all.

    When the last field is a source tag (SOURCE_TAGS) it becomes `source` and what is
    left is mapped by songbook:
      TJMEDIA / MIDI, >= 3 fields : artist - name… - lang  (name = the re-joined middle)
      TJMEDIA / MIDI, 2 fields    : artist - name          (lang '')
      SH / PLATKAR,   >= 2 fields : artist - name…         (name = the re-joined rest, lang '')
      any,            1 field     : name only              (artist '')
    Without a tag the pre-source grammar applies (`source` ''): >= 4 fields are
    artist - name… - lang - <last>, 3 are artist - name - lang, 2 are artist - name.

    force_type    : `type` for every record (VIDEO / AUDIO builders force this, since
                    the folder/extension already tells us).
    default_type  : `type` otherwise (MIDI builder uses "MIDI"). `type` is the media
                    type only — never a source tag, never a filename field.
    """
    base, _ext = os.path.splitext(filename)

    m = _LEADING_CODE.match(base)
    if not m:
        return None
    code = int(m.group(1))
    rest, source = split_source(m.group(2))

    # A re-joined title keeps its own spacing; only its ends are trimmed.
    parts = rest.split(" - ")
    if source in _NO_LANG_SOURCES:
        # No language field in these songbooks: "artist - title…", or just "title".
        # (Before `source`, the 2-field "title - SH" made the title the artist and "SH"
        # the title — 6,463 songs listed as "SH" / "PLATKAR".)
        if len(parts) >= 2:
            artist, name, lang = parts[0], " - ".join(parts[1:]), ""
        else:
            artist, name, lang = "", rest, ""
    elif len(parts) == 1:
        artist, name, lang = "", rest, ""
    elif source:
        if len(parts) >= 3:
            artist, name, lang = parts[0], " - ".join(parts[1:-1]), parts[-1]
        else:
            artist, name, lang = parts[0], parts[1], ""
    elif len(parts) >= 4:
        # back-anchored pre-source grammar: artist - name… - lang - <last field>
        # (a " - " inside the title stays safe — name is the re-joined middle)
        artist, name, lang = parts[0], " - ".join(parts[1:-2]), parts[-2]
    elif len(parts) == 3:
        artist, name, lang = parts[0], parts[1], parts[2]
    else:
        artist, name, lang = parts[0], parts[1], ""

    return {
        "code": code,
        "name": name.strip(),
        "artistName": artist.strip(),
        "langName": lang.strip(),
        "type": force_type or default_type,
        "source": source,
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
