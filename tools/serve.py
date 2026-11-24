#!/usr/bin/env python3
"""
serve.py — run the offline Ka-Rae-oke karaoke player locally.

What it does
------------
1. First-run setup (only downloads what's missing):
     - vendors the SpessaSynth engine (3 files) into src/vendor/
     - fetches a free General MIDI SoundFont into data/soundfont.sf2
     - builds catalog.json from kar_raw/ if it isn't there yet
2. Serves the app (src/) at the site root "/" over HTTP with:
     - Cross-Origin-Isolation headers (COOP/COEP) so SpessaSynth's
       AudioWorklet + SharedArrayBuffer path works
     - correct MIME types for .mid / .sf2 / .js (ES modules) / .wasm
3. Opens the player in your browser.

Usage
-----
    python tools/serve.py                 # setup (if needed) + serve on :8080
    python tools/serve.py --port 9000
    python tools/serve.py --no-setup      # skip the download/setup step
    python tools/serve.py --no-open       # don't auto-open the browser

Stdlib only. Python 3.8+.

Author : Elaina, the Ashen Engineer
Created: 2026-07-12
"""

from __future__ import annotations

import argparse
import functools
import gzip
import hashlib
import http.server
import itertools
import json
import os
import re
import select
import subprocess
import socket
import socketserver
import sys
import threading
import time
import urllib.parse
import urllib.request
import webbrowser

# A sibling module in tools/, imported the way the catalog builders import it: `python
# tools/serve.py` (from any cwd) puts the script's own directory first on sys.path, and the
# tests put tools/ there themselves. Top-level on purpose — main() chdirs into src/ later.
from catalog_common import IGNORE_NAMES, write_json_atomic

HERE = os.path.dirname(os.path.abspath(__file__))   # …/tools (this script lives in tools/)
# The static app (code). Override with KARAEOKE_APP_DIR; defaults to the project root.
APP_DIR = os.path.abspath(os.environ.get("KARAEOKE_APP_DIR") or os.path.dirname(HERE))
SRC = os.path.join(APP_DIR, "src")
VENDOR = os.path.join(SRC, "vendor")

# All mutable/user data lives under DATA_DIR — mount this as a volume in Docker.
# Defaults to <project>/data; override with KARAEOKE_DATA_DIR (e.g. /data in a container).
DATA_DIR = os.path.abspath(os.environ.get("KARAEOKE_DATA_DIR") or os.path.join(APP_DIR, "data"))
VIDEOS_DIR = os.path.join(DATA_DIR, "videos")        # karaoke VIDEO songs (parallel to kar_raw/)
AUDIO_DIR = os.path.join(DATA_DIR, "audio_lyrics")   # AUDIO songs: audio file + a lyrics sidecar
DOWNLOADS_DIR = os.path.join(DATA_DIR, "kar_raw")  # compressed-MIDI song payloads
CATALOG_PATH = os.path.join(DATA_DIR, "catalog.json")
VIDEO_CATALOG_PATH = os.path.join(DATA_DIR, "catalog-video.json")
AUDIO_CATALOG_PATH = os.path.join(DATA_DIR, "catalog-audio.json")
# Shared blocklist of YouTube videoIds that can't be embedded (owner-disabled / removed). Clients
# report them via POST /api/youtube-block; /api/youtube-search filters them out for EVERY user.
YOUTUBE_BLOCKLIST_PATH = os.path.join(DATA_DIR, "youtube-blocklist.json")
# How many times each song was played: POST /api/played records one, GET /api/playcounts reads all.
PLAYCOUNTS_PATH = os.path.join(DATA_DIR, "playcounts.json")

# Largest request body any endpoint here accepts. The biggest legitimate POST is a host
# snapshot carrying the queue (a few KB); the cap exists because this is one thread per
# connection, so an unbounded Content-Length is a cheap way to pin memory and threads.
MAX_POST_BYTES = 1_000_000

# Origins allowed to POST, for deployments behind a Host-rewriting reverse proxy. Empty (the
# default) means "compare Origin against the request's own Host", which is correct for direct
# LAN use and for cloudflared. Comma-separated, e.g. "https://karaoke.example.com".
ALLOWED_ORIGINS = {
    o.strip().rstrip("/") for o in (os.environ.get("KARAEOKE_ALLOWED_ORIGINS") or "").split(",") if o.strip()
}

# URL paths the server maps to DATA_DIR instead of the app tree (see Handler.translate_path).
# /bgv/ and /bgphoto/ are the stage backgrounds (M11): looping clips and a photo slideshow.
DATA_URL_PREFIXES = ("/kar_raw/", "/videos/", "/audio_lyrics/", "/bgv/", "/bgphoto/")
DATA_URL_FILES = ("/catalog.json", "/catalog-video.json", "/catalog-audio.json", "/soundfont.sf2")

# Stage background media, listed by GET /api/backgrounds (see _list_backgrounds): the files
# directly in DATA_DIR/bgv and DATA_DIR/bgphoto, plus one level of sub-folders (= categories).
BG_VIDEO_EXTS = (".mp4", ".webm", ".m4v", ".mov")
BG_PHOTO_EXTS = (".jpg", ".jpeg", ".png", ".webp")
BG_MAX_ITEMS = 2000           # per kind; the scan runs on every request, so it stays bounded

# --- SpessaSynth engine ---
# These 4 files are VENDORED into the repo under src/vendor/ (see src/vendor/README.md
# for provenance + licenses). They are committed to the repo and are the canonical
# runtime source; the app never depends on any remote host at runtime.
ENGINE_FILES = [
    "spessasynth_lib.js",
    "spessasynth_core.js",
    "spessasynth_processor.min.js",
    "pako.min.js",  # zlib/deflate — the compressed-MIDI payloads are raw-deflate
]

# --- Free, redistributable General MIDI SoundFont (GeneralUser GS) ---
#     Verified: raw.githubusercontent serves a valid RIFF/sfbk, ~31 MB, with CORS.
SOUNDFONT_URL = (
    "https://raw.githubusercontent.com/mrbumpy409/GeneralUser-GS/main/GeneralUser-GS.sf2"
)
SOUNDFONT_PATH = os.path.join(DATA_DIR, "soundfont.sf2")

# --- QR encoder (qrcode-generator 1.4.4, MIT) — vendored; fallback-fetched if missing ---
#     UMD (~57 KB) exposing window.qrcode; renders the phone-remote QR on the queue panel.
#     Committed alongside the engine; this download only restores it if it's absent.
QRCODE_URL = "https://cdn.jsdelivr.net/npm/qrcode-generator@1.4.4/qrcode.js"
QRCODE_PATH = os.path.join(VENDOR, "qrcode.min.js")

USER_AGENT = "karaeoke-offline-setup/1.0"

# A browser-like UA for the /api/youtube-search scrape. YouTube serves stripped-down /
# consent-wall HTML to non-browser agents (our setup UA gets degraded markup that lacks
# ytInitialData), so the search endpoint impersonates a desktop Chrome.
YT_USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"
)


# ---------------------------------------------------------------------------
# Setup
# ---------------------------------------------------------------------------
def _download(url: str, dest: str, label: str) -> bool:
    tmp = dest + ".part"
    try:
        req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
        with urllib.request.urlopen(req, timeout=120) as resp:
            total = int(resp.headers.get("Content-Length") or 0)
            got = 0
            with open(tmp, "wb") as fh:
                while True:
                    chunk = resp.read(65536)
                    if not chunk:
                        break
                    fh.write(chunk)
                    got += len(chunk)
                    if total:
                        pct = got * 100 // total
                        print(f"\r    {label}: {pct:3d}%  ({got:,}/{total:,} bytes)", end="")
                    else:
                        print(f"\r    {label}: {got:,} bytes", end="")
        print()
        os.replace(tmp, dest)
        return True
    except Exception as exc:  # noqa: BLE001
        print(f"\n    ! failed: {exc}", file=sys.stderr)
        if os.path.exists(tmp):
            os.remove(tmp)
        return False


def _valid_soundfont(path: str) -> bool:
    try:
        if os.path.getsize(path) < 1_000_000:  # a real GM sf2 is many MB
            return False
        with open(path, "rb") as fh:
            head = fh.read(12)
        return head[0:4] == b"RIFF" and head[8:12] == b"sfbk"
    except OSError:
        return False


def _run_builder(builder: str, *args: str) -> None:
    """Run a catalog builder as a subprocess (not os.system — no shell parsing, so paths with
    spaces/quotes are safe on every platform) and surface failures instead of swallowing them."""
    try:
        subprocess.run([sys.executable, builder, *args],
                       cwd=APP_DIR, timeout=180, capture_output=True, check=True)
    except subprocess.CalledProcessError as exc:
        err = (exc.stderr or b"").decode("utf-8", "replace").strip()[:400]
        print(f"  ! builder failed ({os.path.basename(builder)}): {err or exc}")
    except (OSError, subprocess.TimeoutExpired) as exc:
        print(f"  ! builder could not run ({os.path.basename(builder)}): {exc}")


def setup() -> None:
    os.makedirs(VENDOR, exist_ok=True)
    os.makedirs(DATA_DIR, exist_ok=True)
    os.makedirs(DOWNLOADS_DIR, exist_ok=True)  # kar_raw/
    os.makedirs(VIDEOS_DIR, exist_ok=True)
    os.makedirs(AUDIO_DIR, exist_ok=True)      # audio_lyrics/

    # 1) engine files (vendored + committed; warn if a checkout is somehow missing them)
    missing = [f for f in ENGINE_FILES if not os.path.exists(os.path.join(VENDOR, f))]
    if missing:
        print("SpessaSynth engine missing from src/vendor/:")
        for f in missing:
            print(f"    !! {f} — restore it from src/vendor/ (see src/vendor/README.md).")
        print("    The player needs these files to synthesize audio.")
    else:
        print("SpessaSynth engine: vendored ✓")

    # 1b) QR encoder (fetched if missing — powers the opt-in phone-remote QR)
    if os.path.exists(QRCODE_PATH) and os.path.getsize(QRCODE_PATH) > 1000:
        print("QR encoder: vendored ✓")
    else:
        print("Fetching the QR encoder (qrcode-generator, MIT, ~57 KB):")
        if _download(QRCODE_URL, QRCODE_PATH, "qrcode.min.js"):
            print("    QR encoder ready ✓")
        else:
            print("    !! QR encoder unavailable — the phone-remote QR won't render "
                  "(the remote is off by default, so nothing else is affected).")

    # 2) soundfont
    if _valid_soundfont(SOUNDFONT_PATH):
        print("SoundFont: present ✓")
    else:
        print("Fetching a free General MIDI SoundFont (GeneralUser GS, ~31 MB):")
        ok = _download(SOUNDFONT_URL, SOUNDFONT_PATH, "GeneralUser-GS.sf2")
        if ok and _valid_soundfont(SOUNDFONT_PATH):
            print("    SoundFont ready ✓")
        else:
            print(
                "    !! SoundFont unavailable. Drop any General MIDI .sf2 at:\n"
                f"       {SOUNDFONT_PATH}\n"
                "    (playback will be silent until a soundfont is present)."
            )

    # 3) catalog.json (MIDI)
    if not os.path.exists(CATALOG_PATH):
        builder = os.path.join(HERE, "build-catalog.py")
        if os.path.exists(builder):
            print("Building catalog.json from kar_raw/ …")
            _run_builder(builder, "--downloads-dir", DOWNLOADS_DIR, "--out", CATALOG_PATH)
        else:
            print("catalog.json missing and builder script not found — search will be empty.")
    else:
        print("catalog.json: present ✓")

    # 4) catalog-video.json (VIDEO) — parallel catalog for drop-in karaoke videos.
    if not os.path.exists(VIDEO_CATALOG_PATH):
        vbuilder = os.path.join(HERE, "build-video-catalog.py")
        if os.path.exists(vbuilder):
            print("Building catalog-video.json from videos/ …")
            _run_builder(vbuilder, "--videos-dir", VIDEOS_DIR, "--out", VIDEO_CATALOG_PATH)
        else:
            print("catalog-video.json missing and video builder not found — no videos listed.")
    else:
        print("catalog-video.json: present ✓")

    # 5) catalog-audio.json (AUDIO) — parallel catalog for drop-in audio+lyrics songs.
    if not os.path.exists(AUDIO_CATALOG_PATH):
        abuilder = os.path.join(HERE, "build-audio-catalog.py")
        if os.path.exists(abuilder):
            print("Building catalog-audio.json from audio_lyrics/ …")
            _run_builder(abuilder, "--audio-dir", AUDIO_DIR, "--out", AUDIO_CATALOG_PATH)
        else:
            print("catalog-audio.json missing and audio builder not found — no audio songs listed.")
    else:
        print("catalog-audio.json: present ✓")
    print()


# ---------------------------------------------------------------------------
# Shared YouTube embed blocklist — reported by clients, filtered for everyone
# ---------------------------------------------------------------------------
_yt_blocklist: set[str] = set()
_yt_blocklist_lock = threading.Lock()
_YT_ID_RE = re.compile(r"^[A-Za-z0-9_-]{11}$")  # a YouTube video id
YT_BLOCKLIST_MAX = 100_000                       # sanity cap so the file can't grow unbounded


def _load_yt_blocklist() -> None:
    global _yt_blocklist
    try:
        with open(YOUTUBE_BLOCKLIST_PATH, encoding="utf-8") as fh:
            data = json.load(fh)
        if isinstance(data, list):
            _yt_blocklist = {x for x in data if isinstance(x, str) and _YT_ID_RE.match(x)}
    except (FileNotFoundError, json.JSONDecodeError, OSError):
        _yt_blocklist = set()


def _save_yt_blocklist() -> None:
    try:
        os.makedirs(DATA_DIR, exist_ok=True)
        tmp = YOUTUBE_BLOCKLIST_PATH + ".part"
        with open(tmp, "w", encoding="utf-8") as fh:
            json.dump(sorted(_yt_blocklist), fh)
        os.replace(tmp, YOUTUBE_BLOCKLIST_PATH)
    except OSError as exc:  # noqa: BLE001
        print(f"  ! could not write youtube-blocklist.json: {exc}", file=sys.stderr)


# Per-IP rate limit on block reports. The endpoint is unauthenticated by design (self-hosted
# trust model), but a blocked id is PERSISTENT and shared with every user of the deployment,
# with no un-block UI — so an unthrottled reporter can quietly censor real karaoke videos for
# the whole house. A generous bucket still stops a script; a real client reports one id at a
# time when a video actually fails to embed.
_yt_block_rate: dict[str, list] = {}
YT_BLOCK_RATE_MAX = 30      # reports per window, per client
YT_BLOCK_RATE_WINDOW = 60.0  # seconds


def _yt_block_allowed(client: str) -> bool:
    """Token-bucket check for one block reporter. Call under no lock; takes its own."""
    now = time.time()
    with _yt_blocklist_lock:
        start, count = _yt_block_rate.get(client, [now, 0])
        if now - start >= YT_BLOCK_RATE_WINDOW:
            start, count = now, 0
        if count >= YT_BLOCK_RATE_MAX:
            _yt_block_rate[client] = [start, count]
            return False
        _yt_block_rate[client] = [start, count + 1]
        if len(_yt_block_rate) > 512:  # bound the table; stale windows are worthless anyway
            for key in [k for k, v in _yt_block_rate.items() if now - v[0] >= YT_BLOCK_RATE_WINDOW]:
                _yt_block_rate.pop(key, None)
        return True


def _add_yt_blocked(ids) -> int:
    """Add valid videoIds to the shared blocklist (persisting on change). Returns the new total."""
    with _yt_blocklist_lock:
        changed = False
        for vid in ids or []:
            if len(_yt_blocklist) >= YT_BLOCKLIST_MAX:
                break
            if isinstance(vid, str) and _YT_ID_RE.match(vid) and vid not in _yt_blocklist:
                _yt_blocklist.add(vid)
                changed = True
        if changed:
            _save_yt_blocklist()
        return len(_yt_blocklist)


# ---------------------------------------------------------------------------
# Keyless YouTube search (server-side scrape) — powers /api/youtube-search
# ---------------------------------------------------------------------------
def _runs_text(obj) -> str:
    """Text from a YouTube {runs:[{text}]} or {simpleText} node."""
    if not isinstance(obj, dict):
        return ""
    if "simpleText" in obj:
        return obj["simpleText"] or ""
    runs = obj.get("runs")
    if isinstance(runs, list):
        return "".join(r.get("text", "") for r in runs if isinstance(r, dict))
    return ""


def _iter_video_renderers(node):
    """Yield every videoRenderer dict anywhere in the parsed JSON, in document order.
    Walking the whole tree is robust to YouTube reshuffling the container structure."""
    if isinstance(node, dict):
        vr = node.get("videoRenderer")
        if isinstance(vr, dict):
            yield vr
        for v in node.values():
            yield from _iter_video_renderers(v)
    elif isinstance(node, list):
        for v in node:
            yield from _iter_video_renderers(v)


def _youtube_search(query: str, max_results: int = 20):
    """Keyless server-side YouTube search: fetch the public results page and parse the
    embedded ytInitialData JSON → [{videoId, title, channelTitle}]. Best-effort — any
    failure raises and the caller returns an empty set. No API key, no quota. BYOC-clean:
    live metadata only, nothing stored or redistributed (playback is the official embed)."""
    url = "https://www.youtube.com/results?" + urllib.parse.urlencode(
        {"search_query": query, "hl": "en", "gl": "US"}
    )
    req = urllib.request.Request(url, headers={
        "User-Agent": YT_USER_AGENT,
        "Accept-Language": "en-US,en;q=0.9",
        "Cookie": "CONSENT=YES+1",  # skip the EU consent interstitial so ytInitialData is present
    })
    with urllib.request.urlopen(req, timeout=12) as resp:
        html = resp.read().decode("utf-8", "replace")

    m = (re.search(r"ytInitialData\s*=\s*(\{.*?\})\s*;\s*</script>", html, re.DOTALL)
         or re.search(r'ytInitialData"\]\s*=\s*(\{.*?\})\s*;\s*</script>', html, re.DOTALL))
    if not m:
        return []
    data = json.loads(m.group(1))

    with _yt_blocklist_lock:
        blocked = frozenset(_yt_blocklist)  # snapshot: exclude videos already known un-embeddable

    out, seen = [], set()
    for vr in _iter_video_renderers(data):
        vid = vr.get("videoId")
        if not vid or vid in seen or vid in blocked:
            continue
        title = _runs_text(vr.get("title"))
        if not title:
            continue
        channel = _runs_text(vr.get("ownerText")) or _runs_text(vr.get("longBylineText"))
        seen.add(vid)
        out.append({"videoId": vid, "title": title, "channelTitle": channel})
        if len(out) >= max_results:
            break
    return out


# ---------------------------------------------------------------------------
# Remote-control relay — in-memory, ephemeral, thread-safe, MULTI-ROOM.
# ---------------------------------------------------------------------------
# Lets phones queue/search/control the player from /remote (src/remote.html +
# src/js/remote.js). Each HOST browser OWNS a ROOM CODE (generated + stored in that
# browser's localStorage) and is the AUTHORITATIVE player for its room: it POSTs its
# snapshot to /api/remote/host (tagged with its room) and drains THAT room's guest
# COMMANDS in the same call. Guests reach a specific room by its code — POST intents to
# /api/remote/command and read /api/remote/state, both scoped by the room code. The
# server is a keyed relay: the code is the routing key AND a soft gate (a wrong code
# hits no live room → rejected). In-memory only; a room vanishes when its host stops
# pushing (ROOM_TTL). Multiple hosts on one server each get their own room.
# Serializes /api/rebuild-catalog so a burst of requests can't spawn concurrent builder
# subprocesses (unauthenticated endpoint → cheap CPU/process-DoS guard). non-blocking:
# a request that finds a build already running is rejected with 409 rather than queued.
_rebuild_lock = threading.Lock()

_remote_lock = threading.Lock()
# The push channel's wake-up. It wraps _remote_lock itself, so `with _remote_lock:` and
# `with _remote_cond:` are the same critical section; every write to a room (host sync,
# command add, song put) calls notify_all() while still holding it.
_remote_cond = threading.Condition(_remote_lock)
_rooms: dict = {}             # roomCode(upper) -> {rev, ts, mts, now, queue, settings, songRev,
                              #                     notice, song, commands:[], seq, epoch}
REMOTE_CMD_TYPES = frozenset((
    "enqueue", "remove", "reorder", "play", "pause", "next", "seek", "volume", "setting",
    "react",   # an emoji (+ applause) sent to the host screen; the host allowlists the emoji
    # relay v2: the host decides whether each is allowed; the server only routes them
    "playnow", "priority", "digit", "digit_delete", "digit_clear", "digit_commit",
    "restart", "bg",
))
REMOTE_CMD_MAX = 200          # per-room inbox cap (host-less safety)
ROOM_TTL = 90                 # secs; a room whose host hasn't pushed in this long is dropped
ROOM_MAX = 200                # sanity cap on concurrent rooms
_ROOM_RE = re.compile(r"^[A-Z0-9]{4,12}$")
NOTICE_MAX = 200              # chars of the host's one-line notice kept per room

# Server-Sent Events (GET /api/remote/events). One thread per open stream — the server's
# model already — so streams are capped, and each one ends after SSE_MAX_AGE (the browser's
# EventSource reconnects after the `retry:` delay). All SSE timing reads time.monotonic():
# the tests replace time.time with a fake clock to drive the room TTL.
SSE_HEARTBEAT = 15            # secs of silence before a named `hb` event
SSE_MAX_AGE = 300             # secs; the handler ends the stream, the client reconnects
SSE_PEER_CHECK = 1.0          # secs; a parked stream wakes this often to see if its client left
SSE_MAX_PER_ROOM = 40         # open streams per room (guests + host)
SSE_MAX_TOTAL = 200           # open streams on this server
SONG_DOC_MAX = 400_000        # bytes of a POST /api/remote/song body
_CID_RE = re.compile(r"^[A-Za-z0-9_-]{8,32}$")
_SSE_ROLES = ("guest", "host")
_sse_slots: dict = {}         # (room, role, cid) -> _SseSlot, guarded by _remote_lock
_room_epochs = itertools.count(1)   # tells a re-created room apart from its predecessor


def _norm_room(code) -> str:
    """Normalize + validate a room code → uppercase, or '' if malformed."""
    code = str(code or "").strip().upper()
    return code if _ROOM_RE.match(code) else ""


def _gc_rooms_locked() -> None:
    """Drop rooms whose host has gone silent. Call while holding _remote_lock."""
    cutoff = int(time.time()) - ROOM_TTL
    for k in [k for k, r in _rooms.items() if r["ts"] < cutoff]:
        del _rooms[k]


def _lan_ip() -> str:
    """Best-effort primary LAN IPv4 of this host. The UDP 'connect' only selects a
    route (no packets are sent). Falls back to 127.0.0.1 when offline."""
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("8.8.8.8", 80))
        return s.getsockname()[0]
    except OSError:
        return "127.0.0.1"
    finally:
        s.close()


def _room_add_command(room, cmd) -> int:
    """Append a guest command to a LIVE room's inbox. Returns its seq, or 0 if the
    command is malformed or no live host owns that room code (the soft gate)."""
    if not isinstance(cmd, dict) or cmd.get("type") not in REMOTE_CMD_TYPES:
        return 0
    room = _norm_room(room)
    if not room:
        return 0
    with _remote_lock:
        _gc_rooms_locked()    # reclaim dead rooms even when no host is pushing anymore
        r = _rooms.get(room)
        if not r or r["ts"] < int(time.time()) - ROOM_TTL:
            return 0          # no live host for this code → reject
        r["seq"] += 1
        cmd["seq"] = r["seq"]
        r["commands"].append(cmd)
        if len(r["commands"]) > REMOTE_CMD_MAX:
            del r["commands"][:-REMOTE_CMD_MAX]
        _remote_cond.notify_all()   # wake the host's event stream
        return r["seq"]


def _room_host_sync(snapshot) -> dict:
    """Host upserts its room's snapshot (creating the room on first push) and drains that
    room's commands. `ackSeq` = the highest command seq the host applied; we drop those and
    return everything newer (re-delivered until acked, so the host dedups by seq)."""
    room = _norm_room(snapshot.get("room"))
    if not room:
        return {"ok": False, "error": "room"}
    try:
        ack = int(snapshot.get("ackSeq") or 0)
    except (TypeError, ValueError):
        ack = 0
    # Relay v2 additions, both optional: the revision of the song document the host has
    # published (POST /api/remote/song), and a one-line message for the guests.
    try:
        song_rev = max(0, int(snapshot.get("songRev") or 0))
    except (TypeError, ValueError):
        song_rev = 0
    notice = snapshot.get("notice")
    notice = notice[:NOTICE_MAX] if isinstance(notice, str) else ""
    now = int(time.time())
    with _remote_lock:
        _gc_rooms_locked()
        r = _rooms.get(room)
        if r is None:
            if len(_rooms) >= ROOM_MAX:
                return {"ok": False, "error": "full"}
            r = _rooms[room] = {"rev": 0, "ts": now, "commands": [], "seq": 0,
                                "epoch": next(_room_epochs)}
        r["rev"] += 1
        r["ts"] = now
        # Sub-second twin of ts: guests subtract it to learn how STALE the snapshot they
        # just polled is (their own poll phase is up to a full second). Lyric sync on the
        # phone rides this — see src/js/sync-clock.js. `ts` stays int for the TTL checks.
        r["mts"] = time.time()
        r["now"] = snapshot.get("now")
        r["queue"] = snapshot.get("queue") or []
        r["settings"] = snapshot.get("settings") or {}
        r["songRev"] = song_rev
        r["notice"] = notice
        r["commands"] = [c for c in r["commands"] if c["seq"] > ack]
        _remote_cond.notify_all()   # wake the guests' event streams
        return {"ok": True, "rev": r["rev"], "commands": list(r["commands"])}


def _room_state(code, since) -> dict:
    """The snapshot a guest reads (/api/remote/state). Returns {error:'no-room'} when the
    code names no live room (wrong code / host gone) — the gate's signal to the phone."""
    room = _norm_room(code)
    if not room:
        return {"ok": False, "error": "no-room"}
    with _remote_lock:
        _gc_rooms_locked()    # guests poll this ~1/s → reclaims rooms after all hosts go silent
        r = _rooms.get(room)
        if not r or r["ts"] < int(time.time()) - ROOM_TTL:
            return {"ok": False, "error": "no-room"}
        rev = r["rev"]
        if since is not None and str(since).isdigit() and int(since) == rev:
            return {"ok": True, "rev": rev, "unchanged": True}
        return _room_view_locked(r)


def _room_age_locked(r) -> float:
    """Seconds since the host's push landed here — lets a guest correct for its own poll
    phase before extrapolating the playback position (lyric sync, CLAUDE.md §5.21)."""
    return round(max(0.0, time.time() - r.get("mts", r["ts"])), 3)


def _room_view_locked(r) -> dict:
    """The full snapshot a guest reads: the body of GET /api/remote/state and of the SSE
    `state` event. Call while holding _remote_lock."""
    return {"ok": True, "rev": r["rev"], "ts": r["ts"], "now": r.get("now"),
            "age": _room_age_locked(r),
            "queue": r.get("queue", []), "settings": r.get("settings", {}),
            "songRev": r.get("songRev", 0), "notice": r.get("notice", "")}


# ---------------------------------------------------------------------------
# Relay v2 — server push (SSE), the published song document, the compact catalogue.
# ---------------------------------------------------------------------------
# The polling endpoints above stay exactly as they were; everything here is additive.
# A guest stream gets `state` when the HEAVY part of the snapshot changed (what is playing,
# the queue, the mirrored settings, songRev, notice) and a small `tick` when only the clock
# moved, so a phone is not re-sent the whole queue every second.
_TICK_ONLY = ("position", "duration", "score")   # the parts of `now` that change every push


def _heavy_key(room_record) -> str:
    """Stable JSON of the heavy part of a room: `now` without position/duration/score, plus
    queue, settings, songRev and notice. Two pushes with the same key differ only in clock."""
    now = room_record.get("now")
    if isinstance(now, dict):
        now = {k: v for k, v in now.items() if k not in _TICK_ONLY}
    return json.dumps({"now": now, "queue": room_record.get("queue", []),
                       "settings": room_record.get("settings", {}),
                       "songRev": room_record.get("songRev", 0),
                       "notice": room_record.get("notice", "")},
                      sort_keys=True, separators=(",", ":"), default=str)


def _heavy_key_cached_locked(r) -> str:
    # Every guest stream of a room asks after each push; the key only changes when rev does.
    if r.get("_heavy_rev") != r["rev"]:
        r["_heavy"], r["_heavy_rev"] = _heavy_key(r), r["rev"]
    return r["_heavy"]


def _room_live_locked(room):
    """The live record for an already-normalized code, or None. Call while holding the lock."""
    r = _rooms.get(room)
    if not r or r["ts"] < int(time.time()) - ROOM_TTL:
        return None
    return r


def _room_poll(code, role, cursor):
    """Events newer than `cursor` for one stream, and the cursor to pass next time.

    Pure given _remote_lock (the caller holds it; nothing here blocks or mutates a room).
    cursor = {"rev": int, "heavy": str, "seq": int} (+ "epoch", added here). Returns None when
    the room is dead. A guest gets ("state", full view) on its first poll and whenever the
    heavy key moved, else ("tick", clock) once per host push; a host gets ("command", cmd) for
    every command with a seq above the cursor, in seq order. Commands are not consumed —
    POST /api/remote/host still drains them until acked, so the two paths cannot disagree.
    """
    r = _room_live_locked(_norm_room(code))
    if r is None:
        return None
    if cursor.get("epoch") != r.get("epoch"):
        # First poll, or the code expired and a host re-created it: every rev/seq restarted.
        cursor = {"rev": -1, "heavy": "", "seq": 0, "epoch": r.get("epoch")}
    if role == "host":
        cmds = [dict(c) for c in r["commands"] if c["seq"] > cursor["seq"]]
        if not cmds:
            return [], cursor
        return [("command", c) for c in cmds], {**cursor, "rev": r["rev"], "seq": cmds[-1]["seq"]}
    if r["rev"] == cursor["rev"]:
        return [], cursor
    heavy = _heavy_key_cached_locked(r)
    if heavy != cursor["heavy"]:
        event = ("state", _room_view_locked(r))
    else:
        now = r.get("now") if isinstance(r.get("now"), dict) else {}
        event = ("tick", {"rev": r["rev"], "age": _room_age_locked(r),
                          "position": now.get("position"), "duration": now.get("duration"),
                          "paused": bool(now.get("paused", False)), "score": now.get("score")})
    return [event], {**cursor, "rev": r["rev"], "heavy": heavy}


def _room_put_song(room, song_rev, song_id, doc) -> dict:
    """The host publishes the prepared lyric document for the song it is playing (P9).
    One document per room, last write wins; it dies with the room."""
    code = _norm_room(room)
    if not code:
        return {"ok": False, "error": "no-room"}
    try:
        rev = int(song_rev)
    except (TypeError, ValueError):
        return {"ok": False, "error": "songRev"}
    if rev < 0 or isinstance(song_rev, bool):
        return {"ok": False, "error": "songRev"}
    if doc is not None and not isinstance(doc, dict):
        return {"ok": False, "error": "doc"}
    with _remote_cond:
        _gc_rooms_locked()
        r = _room_live_locked(code)
        if r is None:
            return {"ok": False, "error": "no-room"}
        r["song"] = {"songRev": rev, "id": str(song_id or "")[:512], "doc": doc}
        _remote_cond.notify_all()
        return {"ok": True, "songRev": rev}


def _room_get_song(code) -> dict:
    """GET /api/remote/song: the room's published document, or an empty one (songRev 0)."""
    room = _norm_room(code)
    if not room:
        return {"ok": False, "error": "no-room"}
    with _remote_lock:
        _gc_rooms_locked()
        r = _room_live_locked(room)
        if r is None:
            return {"ok": False, "error": "no-room"}
        song = r.get("song")
        if not song:
            return {"ok": True, "songRev": 0, "id": "", "doc": None}
        return {"ok": True, "songRev": song["songRev"], "id": song["id"], "doc": song["doc"]}


class _SseSlot:
    """One open event stream. `closed` flips when a newer stream with the same (room, role,
    cid) replaces it — the old loop notices on its next wake and ends."""
    __slots__ = ("room", "role", "cid", "closed")

    def __init__(self, room, role, cid):
        self.room, self.role, self.cid, self.closed = room, role, cid, False


def _sse_slot_acquire(room, role, cid):
    """A slot for a new stream, or None when a cap is reached. A tab reconnecting with its own
    cid replaces its old slot (never refused, even at the cap): a half-open socket from a
    phone that dropped off Wi-Fi must not lock that same phone out."""
    key = (room, role, cid)
    with _remote_cond:
        old = _sse_slots.get(key)
        if old is None:
            in_room = sum(1 for k in _sse_slots if k[0] == room)
            if in_room >= SSE_MAX_PER_ROOM or len(_sse_slots) >= SSE_MAX_TOTAL:
                return None
        slot = _sse_slots[key] = _SseSlot(room, role, cid)
        if old is not None:
            old.closed = True
            _remote_cond.notify_all()   # the old loop may be parked in wait()
        return slot


def _sse_slot_release(slot) -> None:
    """Free a stream's slot. Idempotent; a replaced slot never frees its successor."""
    with _remote_cond:
        key = (slot.room, slot.role, slot.cid)
        if _sse_slots.get(key) is slot:
            del _sse_slots[key]
        slot.closed = True


def _sse_counts() -> tuple:
    """(open event streams, live rooms) — for /api/remote/info."""
    with _remote_lock:
        cutoff = int(time.time()) - ROOM_TTL
        return len(_sse_slots), sum(1 for r in _rooms.values() if r["ts"] >= cutoff)


def _sse_frame(name, data) -> str:
    # json.dumps never emits a raw newline, so one `data:` line always holds the payload.
    return f"event: {name}\ndata: {json.dumps(data, separators=(',', ':'))}\n\n"


_SSE_HB = "event: hb\ndata: {}\n\n"       # a NAMED event: EventSource never surfaces comments
_SSE_GONE = 'event: gone\ndata: {"error":"no-room"}\n\n'


def _sse_serve(slot, code, role, write, peer_closed=lambda: False) -> None:
    """Run one event stream until the room dies, the slot is replaced, the stream reaches
    SSE_MAX_AGE, or the client goes away. `write(str)` sends bytes; it raises OSError on a
    dead socket. `peer_closed()` answers, without blocking, whether the client hung up.
    Always releases the slot.

    The poll and the wait share ONE hold of the lock, so a notify_all() that fires while this
    thread is writing (lock released) is never lost: the next poll sees the change before the
    thread would wait. No I/O happens under the lock.

    A closed tab must free its slot at once, not when a later write fails: the first write
    after the client's FIN usually lands in the kernel buffer, so that takes one or two whole
    heartbeats, and a party reloading phones would fill SSE_MAX_PER_ROOM with dead streams.
    So the wait is capped at SSE_PEER_CHECK and `peer_closed()` is asked on every pass,
    before anything is written. A HALF-OPEN socket (a phone that left Wi-Fi without a FIN)
    cannot be seen this way: writes keep succeeding into the buffer, and SSE_MAX_AGE is what
    ends that stream.
    """
    try:
        write("retry: 2000\n\n")
        cursor = {"rev": -1, "heavy": "", "seq": 0}
        last_write = time.monotonic()
        deadline = last_write + SSE_MAX_AGE
        while not slot.closed:
            with _remote_cond:
                res = _room_poll(code, role, cursor)
                if res is not None and not res[0] and not slot.closed:
                    now = time.monotonic()
                    # Wake for the next heartbeat, the deadline or the next peer check,
                    # whichever is first, so a spurious wake never pushes the heartbeat out
                    # by a whole period and a closed client is noticed within a second.
                    _remote_cond.wait(timeout=max(0.0, min(SSE_HEARTBEAT - (now - last_write),
                                                           deadline - now, SSE_PEER_CHECK)))
                    res = _room_poll(code, role, cursor)
            if slot.closed:
                break                                   # replaced by the same tab
            if peer_closed():
                break                                   # the client hung up: free the slot now
            if res is None:                             # the room died
                write(_SSE_GONE)
                break
            events, cursor = res
            if events:
                write("".join(_sse_frame(name, data) for name, data in events))
                last_write = time.monotonic()
            elif time.monotonic() - last_write >= SSE_HEARTBEAT:
                write(_SSE_HB)
                last_write = time.monotonic()
            if time.monotonic() >= deadline:
                break                                   # the client reconnects via retry
    except (BrokenPipeError, ConnectionResetError, OSError):
        pass                                            # the client went away
    finally:
        _sse_slot_release(slot)


# The compact phone catalogue: one row per song in the host's catalog.songs order, the
# repeated strings (source tag, kind, language) as dictionary indices, gzip on the wire.
_COMPACT_SOURCES = ("", "SH", "PLATKAR", "TJMEDIA", "MIDI")
_COMPACT_KINDS = ("midi", "video", "audio")
_COMPACT_COLS = ("code", "name", "artist", "source", "kind", "lang")
_compact_lock = threading.Lock()   # one build at a time: two phones must not both parse 24 MB
_compact_cache = None              # (file key, identity body, gzip body, etag)


def _compact_rows(midi, video, audio) -> dict:
    """Pure: the compact body without "rev". Row i is the host's catalog.songs[i] (catalog.js
    concatenates the three arrays in this order and keeps every element), so a non-list
    catalogue contributes nothing and a non-dict element still gets a placeholder row."""
    sources = list(_COMPACT_SOURCES)
    src_ix = {s: i for i, s in enumerate(sources)}
    langs = [""]
    lang_ix = {"": 0}
    rows = []
    for kind_i, records in enumerate((midi, video, audio)):
        if not isinstance(records, list):
            continue
        for rec in records:
            if not isinstance(rec, dict):
                rows.append(["", "", "", 0, kind_i, 0])
                continue
            src = rec.get("source")
            src = src if isinstance(src, str) else ""
            si = src_ix.get(src)
            if si is None:            # a tag this server does not know yet: keep it, append it
                si = src_ix[src] = len(sources)
                sources.append(src)
            lang = rec.get("langName")
            lang = lang if isinstance(lang, str) else ""
            li = lang_ix.get(lang)
            if li is None:
                li = lang_ix[lang] = len(langs)
                langs.append(lang)
            code = rec.get("code")
            name = rec.get("name")
            artist = rec.get("artistName")
            rows.append(["" if code is None else code,
                         "" if name is None else str(name),
                         "" if artist is None else str(artist),
                         si, kind_i, li])
    return {"v": 1, "sources": sources, "kinds": list(_COMPACT_KINDS), "langs": langs,
            "cols": list(_COMPACT_COLS), "rows": rows}


def _compact_file_key(path):
    try:
        st = os.stat(path)
    except OSError:
        return (path, None, None)
    return (path, st.st_mtime_ns, st.st_size)


def _load_catalog_list(path) -> list:
    """A catalogue file as a list; absent or invalid → [] (catalog.js does the same)."""
    try:
        with open(path, "rb") as fh:
            data = json.loads(fh.read())
    except (OSError, ValueError):
        return []
    return data if isinstance(data, list) else []


def _compact_catalog() -> tuple:
    """(identity_body, gzip_body, etag) for GET /api/catalog/compact, cached until one of the
    three catalogue files changes (mtime + size). The ETag hashes the body, so an unchanged
    library keeps its ETag across restarts and a phone's cached copy stays valid."""
    global _compact_cache
    paths = (CATALOG_PATH, VIDEO_CATALOG_PATH, AUDIO_CATALOG_PATH)
    key = tuple(_compact_file_key(p) for p in paths)
    cached = _compact_cache
    if cached is not None and cached[0] == key:
        return cached[1:]
    with _compact_lock:
        key = tuple(_compact_file_key(p) for p in paths)   # another thread may have built it
        cached = _compact_cache
        if cached is not None and cached[0] == key:
            return cached[1:]
        body = _compact_rows(*(_load_catalog_list(p) for p in paths))
        version = body.pop("v")
        try:
            rest = json.dumps(body, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        except UnicodeEncodeError:   # a lone surrogate in a name: fall back to \u escapes
            rest = json.dumps(body, separators=(",", ":")).encode("ascii")
        rev = hashlib.sha1(b"%d\n" % version + rest).hexdigest()[:16]
        # Splice "v" and "rev" in front rather than serialising a multi-MB body twice.
        identity = b'{"v":%d,"rev":"%s",' % (version, rev.encode("ascii")) + rest[1:]
        gz = gzip.compress(identity, compresslevel=6, mtime=0)
        _compact_cache = (key, identity, gz, f'"{rev}"')
        return _compact_cache[1:]


def _accepts_gzip(header) -> bool:
    """True when Accept-Encoding allows gzip (an explicit q=0 refuses it)."""
    for part in (header or "").split(","):
        name, _, params = part.strip().partition(";")
        if name.strip().lower() not in ("gzip", "*"):
            continue
        q = 1.0
        for p in params.split(";"):
            k, _, v = p.strip().partition("=")
            if k.strip().lower() == "q":
                try:
                    q = float(v)
                except ValueError:
                    q = 0.0
        if q > 0:
            return True
    return False


def _etag_matches(header, etag) -> bool:
    """If-None-Match comparison (weak, as RFC 9110 requires for this header)."""
    for tag in (header or "").split(","):
        tag = tag.strip()
        if tag == "*" or (tag[2:] if tag.startswith("W/") else tag) == etag:
            return True
    return False


# ---------------------------------------------------------------------------
# Stage backgrounds (M11) — GET /api/backgrounds lists DATA_DIR/bgv and DATA_DIR/bgphoto
# ---------------------------------------------------------------------------
def _bg_name_ok(name: str) -> bool:
    """A listable directory entry: not hidden, not OS litter, and representable in a URL."""
    if not name or name.startswith(".") or name.lower() in IGNORE_NAMES:
        return False
    try:
        name.encode("utf-8")
    except UnicodeEncodeError:   # an undecodable byte name (Linux surrogate escape)
        return False
    return True


def _bg_inside(path: str, real_root: str) -> bool:
    """True when path, with every symlink resolved, is real_root or lies under it."""
    try:
        return os.path.commonpath([os.path.realpath(path), real_root]) == real_root
    except ValueError:           # different drives (Windows)
        return False


def _bg_scan_dir(path: str, real_root: str) -> tuple:
    """(file names, sub-folder names) directly in path, each sorted; ([], []) if unreadable.

    A symlink is followed only when its target stays inside real_root (the data dir): the
    listing must not advertise files from elsewhere on the machine. A dangling one is neither.
    """
    try:
        with os.scandir(path) as it:
            entries = sorted(it, key=lambda e: e.name)
    except OSError:
        return [], []
    files, dirs = [], []
    for entry in entries:
        if not _bg_name_ok(entry.name):
            continue
        try:
            if entry.is_symlink() and not _bg_inside(entry.path, real_root):
                continue
            if entry.is_file():
                files.append(entry.name)
            elif entry.is_dir():
                dirs.append(entry.name)
        except OSError:
            continue
    return files, dirs


def _bg_url(folder: str, *segments: str) -> str:
    """'/bgv/<seg>/<seg>' with every segment percent-encoded on its own (UTF-8, nothing safe)."""
    return "/" + folder + "/" + "/".join(urllib.parse.quote(s, safe="") for s in segments)


def _bg_list_kind(base: str, folder: str, exts, real_root: str, cap: int) -> list:
    """The media under base: its own files (category ""), then each sub-folder's files
    (category = the folder name), all in name order, stopping at cap."""
    if cap <= 0 or not os.path.isdir(base) or not _bg_inside(base, real_root):
        return []
    items: list = []

    def take(category, names):
        for name in names:
            if len(items) >= cap:
                return
            if os.path.splitext(name)[1].lower() in exts:
                segments = (category, name) if category else (name,)
                items.append({"url": _bg_url(folder, *segments), "category": category})

    files, dirs = _bg_scan_dir(base, real_root)
    take("", files)
    for sub in dirs:
        if len(items) >= cap:
            break
        take(sub, _bg_scan_dir(os.path.join(base, sub), real_root)[0])   # one level only
    return items


def _bg_categories(items) -> list:
    return sorted({item["category"] for item in items if item["category"]})


def _list_backgrounds(data_dir: str) -> dict:
    """Pure given the directory: the GET /api/backgrounds body without "ok".

    {"videos": [{"url", "category"}], "photos": [...],
     "categories": {"videos": [...], "photos": [...]}}  — a missing folder is an empty list.
    The categories are those of the listed items (an empty sub-folder is not one), sorted.
    """
    real_root = os.path.realpath(data_dir)
    videos = _bg_list_kind(os.path.join(data_dir, "bgv"), "bgv", BG_VIDEO_EXTS, real_root,
                           BG_MAX_ITEMS)
    photos = _bg_list_kind(os.path.join(data_dir, "bgphoto"), "bgphoto", BG_PHOTO_EXTS,
                           real_root, BG_MAX_ITEMS)
    return {"videos": videos, "photos": photos,
            "categories": {"videos": _bg_categories(videos), "photos": _bg_categories(photos)}}


# ---------------------------------------------------------------------------
# Play counts — how many times each song was played (recorded only; nothing shows them yet)
# ---------------------------------------------------------------------------
# The client (src/js/play-counts.js) decides WHEN a play counts (30 s of real playback or a
# natural end, once per song start) and POSTs the song id once. The server only counts.
#
# The file and GET /api/playcounts share one shape:
#     {"v": 1, "songs": {"<song id>": {"n": <plays>, "last": "<ISO-8601 UTC of the last play>"}}}
# Loaded lazily on the first read or play, then kept in memory. Writes are DEBOUNCED: a play
# marks the table dirty and one timer writes it PLAYCOUNTS_FLUSH_SEC later, so a burst of POSTs
# costs one write — not one rewrite of a growing file per request, which is quadratic, and this
# endpoint is as unauthenticated as every other one here. main() flushes on a normal shutdown;
# under Docker, `docker stop` grants a 10 s SIGTERM grace, longer than the delay.
PLAYCOUNTS_VERSION = 1
PLAYCOUNTS_MAX_IDS = 500_000      # distinct ids kept (the library is ~124k); a new id past it → 507
PLAYCOUNTS_ID_MAX = 300           # characters in one song id
PLAYCOUNTS_FLUSH_SEC = 2.0        # debounce between a play and the write that keeps it
# "<kind>:<rest>": midi:123, midi:kar_raw/<file>, video:videos/<file>, audio:audio_lyrics/<file>,
# youtube:<videoId>. The kind is checked for SHAPE, not against a list, so a new kind of song
# needs no server change.
_SONG_ID_RE = re.compile(r"[a-z][a-z0-9_-]{0,23}:.+", re.DOTALL)
# Control characters (C0, DEL, C1) and lone surrogates. json.loads happily returns "\ud800", and
# one such id kept in the table would make EVERY later write fail to encode as UTF-8.
_SONG_ID_BAD_CHARS = re.compile(r"[\x00-\x1f\x7f-\x9f\ud800-\udfff]")

_pc_lock = threading.Lock()        # guards the table and the flags below
_pc_write_lock = threading.Lock()  # one writer at a time; always taken BEFORE _pc_lock
# id → {"n", "last"}. An entry is REPLACED on every play, never mutated, so a shallow copy of the
# dict is a consistent snapshot that can be serialised after _pc_lock is released.
_pc_songs: dict = {}
_pc_loaded = False
_pc_dirty = False
_pc_set_aside = False              # the file on disk was unreadable: keep a copy before overwriting
_pc_timer = None


def _valid_song_id(value) -> bool:
    """A song id as the client builds it: a string of 1–PLAYCOUNTS_ID_MAX characters shaped
    "<kind>:<rest>" with a non-empty rest, and no control characters (§5.22: untrusted input)."""
    return (isinstance(value, str) and 0 < len(value) <= PLAYCOUNTS_ID_MAX
            and _SONG_ID_RE.fullmatch(value) is not None
            and _SONG_ID_BAD_CHARS.search(value) is None)


def _utc_now_iso() -> str:
    # gmtime(time.time()), not a bare gmtime(): a test's patched clock then shows up here too.
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(time.time()))


def _pc_load_locked() -> None:
    """Read playcounts.json once; the caller holds _pc_lock.

    A missing file is an empty table. An unreadable or malformed one reads as empty too (the
    app must keep working), but a read never touches it: the first write after a play renames
    it to playcounts.json.corrupt (one copy kept) so a hand repair stays possible. Inside a
    well-formed file, an entry without a valid id and a positive count is dropped on its own.
    """
    global _pc_songs, _pc_loaded, _pc_set_aside
    if _pc_loaded:
        return
    _pc_loaded = True
    _pc_songs = {}
    try:
        with open(PLAYCOUNTS_PATH, encoding="utf-8") as fh:
            doc = json.load(fh)
    except FileNotFoundError:
        return
    except (OSError, ValueError, RecursionError) as exc:   # ValueError: bad JSON or bad UTF-8
        _pc_set_aside = True
        print(f"  ! playcounts.json is unreadable ({exc}); counting from zero", file=sys.stderr)
        return
    songs = doc.get("songs") if isinstance(doc, dict) and doc.get("v") == PLAYCOUNTS_VERSION else None
    if not isinstance(songs, dict):
        _pc_set_aside = True
        print("  ! playcounts.json is not a v1 play-count file; counting from zero", file=sys.stderr)
        return
    for sid, entry in songs.items():
        if not (_valid_song_id(sid) and isinstance(entry, dict)):
            continue
        n = entry.get("n")
        if isinstance(n, bool) or not isinstance(n, int) or n < 1:
            continue
        last = entry.get("last")
        _pc_songs[sid] = {"n": n, "last": last if isinstance(last, str) else ""}


def _pc_schedule_locked() -> None:
    global _pc_timer
    if _pc_timer is None:
        _pc_timer = threading.Timer(PLAYCOUNTS_FLUSH_SEC, _flush_playcounts)
        _pc_timer.daemon = True    # never holds the process open; main() flushes on the way out
        _pc_timer.start()


def _record_play(song_id: str):
    """Count one play of an id that passed _valid_song_id. Returns the new count, or None when
    the table is full and the id is new — ids already in it keep counting."""
    global _pc_dirty
    with _pc_lock:
        _pc_load_locked()
        entry = _pc_songs.get(song_id)
        if entry is None and len(_pc_songs) >= PLAYCOUNTS_MAX_IDS:
            return None
        n = (entry["n"] if entry else 0) + 1
        _pc_songs[song_id] = {"n": n, "last": _utc_now_iso()}
        _pc_dirty = True
        _pc_schedule_locked()
        return n


def _playcounts_doc() -> dict:
    """The GET /api/playcounts body: the same document as the file."""
    with _pc_lock:
        _pc_load_locked()
        songs = dict(_pc_songs)
    return {"v": PLAYCOUNTS_VERSION, "songs": songs}


def _flush_playcounts() -> bool:
    """Write the table now if a play changed it (the debounce timer, shutdown, tests).

    Returns False when the write failed: the table stays dirty and the next play retries.
    """
    global _pc_dirty, _pc_timer, _pc_set_aside
    with _pc_write_lock:
        with _pc_lock:
            if _pc_timer is not None:
                _pc_timer.cancel()     # a direct call supersedes the pending timer
                _pc_timer = None
            if not _pc_dirty:
                return True
            snapshot = dict(_pc_songs)
            _pc_dirty = False
            set_aside = _pc_set_aside
        # Serialise and write OUTSIDE _pc_lock: at the cap that is about a second, and plays and
        # reads must not queue behind the disk. _pc_write_lock keeps two writers apart.
        try:
            os.makedirs(os.path.dirname(PLAYCOUNTS_PATH), exist_ok=True)
            if set_aside:
                try:
                    os.replace(PLAYCOUNTS_PATH, PLAYCOUNTS_PATH + ".corrupt")
                except FileNotFoundError:
                    pass
                with _pc_lock:
                    _pc_set_aside = False
            write_json_atomic(PLAYCOUNTS_PATH, {"v": PLAYCOUNTS_VERSION, "songs": snapshot},
                              prefix=".playcounts-")
        except Exception as exc:  # noqa: BLE001 — the timer thread has no caller to raise to
            with _pc_lock:
                _pc_dirty = True
            print(f"  ! could not write playcounts.json: {exc}", file=sys.stderr)
            return False
        return True


# ---------------------------------------------------------------------------
# HTTP server with cross-origin isolation + correct MIME types
# ---------------------------------------------------------------------------
class Handler(http.server.SimpleHTTPRequestHandler):
    extensions_map = {
        **http.server.SimpleHTTPRequestHandler.extensions_map,
        ".js": "text/javascript",
        ".mjs": "text/javascript",
        ".json": "application/json",
        ".mid": "audio/midi",
        ".midi": "audio/midi",
        ".kar": "audio/midi",
        ".sf2": "application/octet-stream",
        ".sf3": "application/octet-stream",
        ".wasm": "application/wasm",
        ".css": "text/css",
        # video karaoke payloads (served from videos/)
        ".mp4": "video/mp4",
        ".m4v": "video/mp4",
        ".webm": "video/webm",
        ".mov": "video/quicktime",
        ".ogg": "video/ogg",
        ".ogv": "video/ogg",
        # audio karaoke payloads (served from audio_lyrics/). NOTE: .ogg is claimed
        # above for video — use .oga/.opus for audio-only Ogg.
        ".mp3": "audio/mpeg",
        ".wav": "audio/wav",
        ".flac": "audio/flac",
        ".m4a": "audio/mp4",
        ".mp4a": "audio/mp4",
        ".aac": "audio/aac",
        ".opus": "audio/ogg",
        ".oga": "audio/ogg",
        ".weba": "audio/webm",
        # background photos (served from bgphoto/). Pinned here so the type never depends on
        # the Python version's built-in table or on the host's mime.types (absent in slim images).
        ".jpg": "image/jpeg",
        ".jpeg": "image/jpeg",
        ".png": "image/png",
        ".webp": "image/webp",
    }

    # Speak HTTP/1.1 so a reverse proxy / cloudflared can keep the origin connection
    # alive instead of racing on a pooled socket we already closed — the classic cause
    # of intermittent 502s behind a tunnel. Safe here because every response path sends
    # an accurate Content-Length (static via send_head, 206/416 in _serve_range, JSON in
    # _send_json), which HTTP/1.1 keep-alive requires.
    protocol_version = "HTTP/1.1"
    # Free a thread whose socket stalls (client/tunnel vanished mid-request). This is a
    # PER-OPERATION timeout, so a healthy slow transfer is fine; only a truly stuck
    # recv/send trips it. Kept ABOVE cloudflared's ~90 s origin keep-alive so the tunnel
    # recycles idle connections first and we never close one it's about to reuse.
    timeout = 120

    def do_GET(self):
        path = self.path.split("?", 1)[0]
        # Pretty route: /remote → the mobile control page (served from APP_DIR/src).
        if path in ("/remote", "/remote/"):
            self.path = "/remote.html"
        # The whole body is under the BrokenPipe guard: a phone dropping mid-poll (frequent
        # on the /api/remote/state loop) or a client aborting a 32 MB soundfont is the client's
        # doing, not ours — drop the connection quietly instead of logging a traceback per drop.
        try:
            # Remote-relay read endpoints (before static/range handling).
            if path.startswith("/api/remote/"):
                return self._handle_remote_get(path)
            if path == "/api/catalog/compact":
                return self._handle_compact_get()
            if path == "/api/backgrounds":
                return self._handle_backgrounds_get()
            if path == "/api/playcounts":
                return self._send_json(_playcounts_doc())
            # Honour HTTP Range so <video> seeking works (SimpleHTTPRequestHandler only
            # serves full 200s). Falls back to a normal 200 for non-range / unsatisfiable.
            if self.headers.get("Range") and self._serve_range():
                return
            super().do_GET()
        except (BrokenPipeError, ConnectionResetError):
            self.close_connection = True

    def _handle_remote_get(self, path):
        # GET /api/remote/info → the phone-reachable base URL (LAN IP + port), so the host's
        # QR works even when the host opened http://127.0.0.1. (The room code is host-owned.)
        if path == "/api/remote/info":
            port = self.server.server_address[1]
            streams, rooms = _sse_counts()   # for soak tests: open event streams, live rooms
            self._send_json({"ok": True, "lanUrl": f"http://{_lan_ip()}:{port}", "port": port,
                             "streams": streams, "rooms": rooms})
            return
        # GET /api/remote/state?room=<code>[&since=<rev>] → that room's snapshot (short-circuits
        # to {unchanged:true} when the caller's rev is current; {error:'no-room'} for a dead code).
        if path == "/api/remote/state":
            qs = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
            self._send_json(_room_state(qs.get("room", [""])[0], qs.get("since", [None])[0]))
            return
        # GET /api/remote/events?room=&role=guest|host&cid= → a Server-Sent Events stream.
        if path == "/api/remote/events":
            self._handle_events()
            return
        # GET /api/remote/song?room=<code> → the lyric document the host published.
        if path == "/api/remote/song":
            qs = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
            self._send_json(_room_get_song(qs.get("room", [""])[0]))
            return
        self.send_error(404)

    def _handle_events(self):
        qs = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
        cid = qs.get("cid", [""])[0]
        role = qs.get("role", [""])[0]
        if not _CID_RE.match(cid):
            self._send_json({"ok": False, "error": "cid"}, 400)
            return
        if role not in _SSE_ROLES:
            self._send_json({"ok": False, "error": "role"}, 400)
            return
        code = _norm_room(qs.get("room", [""])[0])
        live = False
        if code:
            with _remote_lock:
                _gc_rooms_locked()
                live = _room_live_locked(code) is not None
        if not live:
            self._send_json({"ok": False, "error": "no-room"}, 404)
            return
        slot = _sse_slot_acquire(code, role, cid)
        if slot is None:
            self._send_json({"ok": False, "error": "busy"}, 503)
            return
        # From here the slot is ours; _sse_serve releases it, and so does this finally if the
        # headers never made it out.
        try:
            # A stream has no length, so it cannot share a keep-alive socket: Connection:
            # close + close_connection, and no Content-Length. X-Accel-Buffering stops an
            # nginx in front from holding events back; end_headers() adds Cache-Control.
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Connection", "close")
            self.send_header("X-Accel-Buffering", "no")
            self.end_headers()
            self.close_connection = True
            _sse_serve(slot, code, role, self._sse_write, self._sse_peer_closed)
        except (BrokenPipeError, ConnectionResetError, OSError):
            pass
        finally:
            _sse_slot_release(slot)
            self.close_connection = True

    def _sse_write(self, text):
        self.wfile.write(text.encode("utf-8"))
        self.wfile.flush()

    def _sse_peer_closed(self) -> bool:
        """True once the event-stream client has closed its end. Never blocks.

        An EventSource sends nothing after its request, so a readable socket means EOF (the
        client's FIN) or stray bytes. MSG_PEEK looks without consuming: b"" is EOF; stray
        bytes are left alone and do not count as closed. A reset or a closed fd is closed.
        """
        sock = self.connection
        try:
            if not select.select([sock], [], [], 0)[0]:
                return False
            return sock.recv(1, socket.MSG_PEEK) == b""
        except (OSError, ValueError):
            return True

    def _handle_compact_get(self):
        # GET /api/catalog/compact → every song as an array row, for the phone remote. ETag +
        # If-None-Match → 304, so a returning phone revalidates instead of re-downloading.
        try:
            identity, gz, etag = _compact_catalog()
        except Exception as exc:  # noqa: BLE001
            self._send_json({"ok": False, "error": str(exc)[:200]}, 500)
            return
        if _etag_matches(self.headers.get("If-None-Match"), etag):
            self.send_response(304)          # bodiless by definition, so no Content-Length
            self.send_header("ETag", etag)
            self.send_header("Vary", "Accept-Encoding")
            self.end_headers()
            return
        use_gzip = _accepts_gzip(self.headers.get("Accept-Encoding"))
        body = gz if use_gzip else identity
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("ETag", etag)
        self.send_header("Vary", "Accept-Encoding")
        if use_gzip:
            self.send_header("Content-Encoding", "gzip")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _handle_backgrounds_get(self):
        # GET /api/backgrounds → the stage background media, rescanned on every call (a
        # folder dropped in while the app runs shows up on the next fetch; no cache to go
        # stale). The files themselves are served by the /bgv/ and /bgphoto/ data routes.
        try:
            listing = _list_backgrounds(DATA_DIR)
        except Exception as exc:  # noqa: BLE001
            self._send_json({"ok": False, "error": str(exc)[:200]}, 500)
            return
        self._send_json({"ok": True, **listing})

    def translate_path(self, path):
        # Route data URLs (songs, videos, catalogs, soundfont) to DATA_DIR; every
        # other URL falls through to the app tree (APP_DIR). _serve_range() calls this too,
        # so video Range/206 seeking inherits the routing. Reuses the stdlib path sanitizer
        # (which blocks '..' escapes) by temporarily swapping the base directory.
        clean = path.split("?", 1)[0].split("#", 1)[0]
        if clean.startswith(DATA_URL_PREFIXES) or clean in DATA_URL_FILES:
            saved, self.directory = self.directory, DATA_DIR
            try:
                return super().translate_path(path)
            finally:
                self.directory = saved
        return super().translate_path(path)

    def _serve_range(self) -> bool:
        """Serve a 206 partial response for a satisfiable byte range of a real file.
        Returns True if it fully handled the response, else False (caller sends 200)."""
        path = self.translate_path(self.path.split("?")[0])
        if not os.path.isfile(path):
            return False
        m = re.match(r"bytes=(\d*)-(\d*)\s*$", self.headers.get("Range", "").strip())
        if not m:
            return False
        try:
            size = os.path.getsize(path)
        except OSError:
            return False
        start_s, end_s = m.group(1), m.group(2)
        if start_s == "":  # suffix range: last N bytes
            if end_s == "":
                return False
            length = min(int(end_s), size)
            start, end = size - length, size - 1
        else:
            start = int(start_s)
            end = min(int(end_s), size - 1) if end_s else size - 1
        if start > end or start >= size:  # unsatisfiable
            self.send_response(416)
            self.send_header("Content-Range", f"bytes */{size}")
            self.send_header("Content-Length", "0")  # HTTP/1.1 keep-alive needs a length
            self.end_headers()
            return True
        length = end - start + 1
        self.send_response(206)
        self.send_header("Content-Type", self.guess_type(path))
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
        self.send_header("Content-Length", str(length))
        self.end_headers()
        with open(path, "rb") as fh:
            fh.seek(start)
            remaining = length
            while remaining > 0:
                chunk = fh.read(min(65536, remaining))
                if not chunk:
                    break
                try:
                    self.wfile.write(chunk)
                except (BrokenPipeError, ConnectionResetError):
                    break
                remaining -= len(chunk)
        return True

    def end_headers(self):
        # Enable SharedArrayBuffer (SpessaSynth worklet path)
        self.send_header("Cross-Origin-Opener-Policy", "same-origin")
        # "credentialless" (not "require-corp") keeps crossOriginIsolated === true (so
        # SpessaSynth's SharedArrayBuffer still works) WHILE letting the page embed the
        # YouTube karaoke player in an <iframe credentialless> — YouTube ships no CORP/COEP,
        # which require-corp would block outright. See src/js/youtube.js.
        self.send_header("Cross-Origin-Embedder-Policy", "credentialless")
        self.send_header("Cross-Origin-Resource-Policy", "same-origin")
        self.send_header("Cache-Control", "no-cache")
        # let the service worker (served from /src/) claim the whole-origin scope
        if self.path.split("?")[0].endswith("/sw.js"):
            self.send_header("Service-Worker-Allowed", "/")
        super().end_headers()

    def _send_json(self, obj, code=200):
        body = json.dumps(obj).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _origin_ok(self) -> bool:
        """Reject cross-site POSTs — drive-by CSRF from any other tab open on the LAN.

        Every mutating endpoint here is unauthenticated, and the README recommends exposing
        this server on a LAN or through a tunnel, so a page on any other site could otherwise
        POST to /api/rebuild-catalog or /api/remote/command using the victim's browser as a
        confused deputy. Browsers always attach Origin to a fetch POST and Sec-Fetch-Site to
        every request; non-browser clients (curl, a scripted host) send neither, and those are
        still allowed — this closes the browser vector, not the same-LAN trust model.
        """
        site = self.headers.get("Sec-Fetch-Site")
        if site and site not in ("same-origin", "same-site", "none"):
            self._log_origin_refusal(f"Sec-Fetch-Site: {site}")
            return False
        origin = self.headers.get("Origin")
        if not origin:
            return True
        try:
            netloc = urllib.parse.urlparse(origin).netloc
        except ValueError:
            return False
        # A reverse proxy that rewrites Host (nginx's default proxy_pass does) would make the
        # comparison below fail for a perfectly legitimate request, so ALLOWED_ORIGINS is the
        # escape hatch: set KARAEOKE_ALLOWED_ORIGINS to the public origin(s) in that setup.
        if ALLOWED_ORIGINS:
            if origin.rstrip("/") in ALLOWED_ORIGINS:
                return True
            self._log_origin_refusal(f"Origin {origin} not in KARAEOKE_ALLOWED_ORIGINS")
            return False
        if netloc == (self.headers.get("Host") or ""):
            return True
        self._log_origin_refusal(f"Origin {origin} != Host {self.headers.get('Host')}")
        return False

    def _log_origin_refusal(self, why: str) -> None:
        # Loud on purpose: behind a Host-rewriting proxy this is the difference between
        # "the remote mysteriously stopped working" and a one-line fix.
        sys.stderr.write(
            f"  ! refused cross-origin POST {self.path} ({why}).\n"
            f"    If this is your own reverse proxy, set KARAEOKE_ALLOWED_ORIGINS=<your public origin>.\n"
        )

    def do_POST(self):
        path = self.path.split("?", 1)[0]
        # Read (and thus CONSUME) the whole request body once, up front. Under HTTP/1.1
        # keep-alive an un-drained body would desync the next request on the socket, so
        # every branch below — including the 404 — works from this drained buffer.
        # The length is CAPPED first: this is one thread per connection, so a client claiming
        # a multi-gigabyte body could otherwise pin memory and a thread. Every real body here
        # is a few KB (the largest is a host snapshot carrying the queue).
        try:
            length = int(self.headers.get("Content-Length", 0) or 0)
        except ValueError:
            length = -1
        if length < 0 or length > MAX_POST_BYTES:
            self._send_json({"ok": False, "error": "request too large"}, 413)
            self.close_connection = True  # body was never drained → this socket can't be reused
            return
        raw = self.rfile.read(length) if length else b""

        if not self._origin_ok():
            self._send_json({"ok": False, "error": "cross-origin request refused"}, 403)
            return

        if path == "/api/rebuild-catalog":
            if not _rebuild_lock.acquire(blocking=False):
                self._send_json({"ok": False, "error": "rebuild already in progress"}, 409)
                return
            builder = os.path.join(HERE, "build-catalog.py")
            vbuilder = os.path.join(HERE, "build-video-catalog.py")
            abuilder = os.path.join(HERE, "build-audio-catalog.py")
            try:
                subprocess.run([sys.executable, builder,
                                "--downloads-dir", DOWNLOADS_DIR, "--out", CATALOG_PATH],
                               cwd=APP_DIR, timeout=180, capture_output=True, check=True)
                if os.path.exists(vbuilder):
                    subprocess.run([sys.executable, vbuilder,
                                    "--videos-dir", VIDEOS_DIR, "--out", VIDEO_CATALOG_PATH],
                                   cwd=APP_DIR, timeout=180, capture_output=True, check=True)
                if os.path.exists(abuilder):
                    subprocess.run([sys.executable, abuilder,
                                    "--audio-dir", AUDIO_DIR, "--out", AUDIO_CATALOG_PATH],
                                   cwd=APP_DIR, timeout=180, capture_output=True, check=True)
                with open(CATALOG_PATH, encoding="utf-8") as fh:
                    n = len(json.load(fh))
                vn = 0
                try:
                    with open(VIDEO_CATALOG_PATH, encoding="utf-8") as fh:
                        vn = len(json.load(fh))
                except (FileNotFoundError, json.JSONDecodeError):
                    pass
                an = 0
                try:
                    with open(AUDIO_CATALOG_PATH, encoding="utf-8") as fh:
                        an = len(json.load(fh))
                except (FileNotFoundError, json.JSONDecodeError):
                    pass
                self._send_json({"ok": True, "records": n, "videoRecords": vn, "audioRecords": an})
            except Exception as exc:  # noqa: BLE001
                self._send_json({"ok": False, "error": str(exc)[:200]}, 500)
            finally:
                _rebuild_lock.release()
            return
        if path == "/api/remote/host":
            # Host pushes its room's snapshot + drains that room's commands. Body:
            # {room, now, queue, settings, ackSeq} → {ok, rev, commands:[…]}.
            try:
                self._send_json(_room_host_sync(json.loads(raw or b"{}")))
            except Exception as exc:  # noqa: BLE001
                self._send_json({"ok": False, "error": str(exc)[:200]}, 400)
            return
        if path == "/api/remote/song":
            # The host publishes the prepared lyric lines of its current song. Body:
            # {room, songRev, id, doc} → {ok, songRev}. Same drained-body + origin gates as
            # every POST, plus a tighter cap than MAX_POST_BYTES (a song is 10–40 KB).
            if len(raw) > SONG_DOC_MAX:
                self._send_json({"ok": False, "error": "request too large"}, 413)
                return
            try:
                body = json.loads(raw or b"{}")
                if not isinstance(body, dict):
                    raise ValueError("body must be a JSON object")
                res = _room_put_song(body.get("room"), body.get("songRev"),
                                     body.get("id"), body.get("doc"))
                if res.get("ok"):
                    self._send_json(res)
                else:
                    self._send_json(res, 403 if res.get("error") == "no-room" else 400)
            except Exception as exc:  # noqa: BLE001
                self._send_json({"ok": False, "error": str(exc)[:200]}, 400)
            return
        if path == "/api/remote/command":
            # A guest posts an intent to a room. Body: {room, type, …, by} → {ok, seq}.
            # The room code gates control: an unknown/dead room is rejected (403 no-room).
            try:
                cmd = json.loads(raw or b"{}")
                room = cmd.get("room") if isinstance(cmd, dict) else None
                seq = _room_add_command(room, cmd)
                if seq:
                    self._send_json({"ok": True, "seq": seq})
                else:
                    self._send_json({"ok": False, "error": "no-room"}, 403)
            except Exception as exc:  # noqa: BLE001
                self._send_json({"ok": False, "error": str(exc)[:200]}, 400)
            return
        if path == "/api/youtube-search":
            # Keyless YouTube search proxy. Body: {"q": "<query>"} → {"ok", "items":[…]}.
            # Errors are non-fatal (200 with empty items) so the UI just shows nothing.
            try:
                body = json.loads(raw or b"{}")
                query = (body.get("q") or "").strip()
                try:
                    n = int(body.get("maxResults") or 20)
                except (TypeError, ValueError):
                    n = 20
                n = max(1, min(50, n))  # clamp so a caller can't request an unbounded scrape
                items = _youtube_search(query, n) if query else []
                self._send_json({"ok": True, "items": items})
            except Exception as exc:  # noqa: BLE001
                self._send_json({"ok": False, "items": [], "error": str(exc)[:200]})
            return
        if path == "/api/youtube-block":
            # Client reports videoIds that can't be embedded → shared blocklist (filtered for all).
            # Body: {"videoIds":[...]} or {"videoId":"..."} → {"ok", "count": total}.
            try:
                if not _yt_block_allowed(self.client_address[0]):
                    self._send_json({"ok": False, "error": "rate limited"}, 429)
                    return
                payload = json.loads(raw or b"{}")
                ids = payload.get("videoIds")
                if not isinstance(ids, list):
                    ids = [payload.get("videoId")] if payload.get("videoId") else []
                ids = ids[:500]  # bounded, but roomy enough for a client's boot-time seed
                self._send_json({"ok": True, "count": _add_yt_blocked(ids)})
            except Exception as exc:  # noqa: BLE001
                self._send_json({"ok": False, "error": str(exc)[:200]})
            return
        if path == "/api/played":
            # One play of one song, counted. Body: {"id": "<song id>"} → {"ok", "count"}.
            # The client decides WHEN a play counts (src/js/play-counts.js); this only counts.
            # 507 when the table is full and the id is new: retrying cannot help, so not a 429.
            try:
                body = json.loads(raw or b"{}")
            except (ValueError, RecursionError):   # RecursionError: "[[[[…" nested past the limit
                self._send_json({"ok": False, "error": "bad json"}, 400)
                return
            song_id = body.get("id") if isinstance(body, dict) else None
            if not _valid_song_id(song_id):
                self._send_json({"ok": False, "error": "bad id"}, 400)
                return
            count = _record_play(song_id)
            if count is None:
                self._send_json({"ok": False, "error": "playcounts full"}, 507)
            else:
                self._send_json({"ok": True, "count": count})
            return
        self.send_error(404)

    def log_message(self, fmt, *args):
        # quieter: only log non-200s and the initial page
        msg = fmt % args
        # The event stream is quiet too: a 200 that lives for minutes, and the 400/404 of a
        # phone whose host left, are routine. Only "busy" (a cap was hit) is worth a line.
        if getattr(self, "path", "").startswith("/api/remote/events") and " 503 " not in msg:
            return
        if " 200 " not in msg or self.path in ("/", "/index.html"):
            sys.stderr.write(f"  {self.address_string()} — {msg}\n")


class ThreadingServer(socketserver.ThreadingMixIn, http.server.HTTPServer):
    daemon_threads = True
    allow_reuse_address = True


def main() -> int:
    ap = argparse.ArgumentParser(description="Serve the offline Ka-Rae-oke player.")
    ap.add_argument("--port", type=int, default=8080)
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--no-setup", action="store_true", help="skip first-run downloads")
    ap.add_argument("--no-open", action="store_true", help="don't open a browser")
    args = ap.parse_args()

    # Windows consoles default to cp1252 and choke on ✓/→/♪ — force UTF-8.
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except Exception:  # noqa: BLE001
            pass

    if not args.no_setup:
        setup()

    _load_yt_blocklist()  # shared YouTube embed blocklist (filtered from search results)

    os.chdir(SRC)  # the app (src/) IS the web root — served at "/"; data URLs route to DATA_DIR
    handler = functools.partial(Handler, directory=SRC)
    url = f"http://{args.host}:{args.port}/"

    try:
        httpd = ThreadingServer((args.host, args.port), handler)
    except OSError as exc:
        print(f"Could not bind {args.host}:{args.port} — {exc}\nTry --port <other>.", file=sys.stderr)
        return 1

    print("=" * 58)
    print("  Ka-Rae-oke is running")
    print(f"  →  {url}")
    print(f"  data: {DATA_DIR}")
    print("  Ctrl+C to stop")
    print("=" * 58)

    if not args.no_open:
        threading.Timer(0.6, lambda: webbrowser.open(url)).start()

    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nStopped.")
    finally:
        httpd.server_close()
        _flush_playcounts()  # a play still inside its debounce window must outlive a Ctrl+C
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
