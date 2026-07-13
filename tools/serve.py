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
import http.server
import json
import os
import re
import subprocess
import socketserver
import sys
import threading
import urllib.error
import urllib.parse
import urllib.request
import webbrowser

HERE = os.path.dirname(os.path.abspath(__file__))   # …/tools (this script lives in tools/)
# The static app (code). Override with KARAEOKE_APP_DIR; defaults to the project root.
APP_DIR = os.path.abspath(os.environ.get("KARAEOKE_APP_DIR") or os.path.dirname(HERE))
ROOT = APP_DIR                                       # back-compat alias: the app/web root
SRC = os.path.join(APP_DIR, "src")
VENDOR = os.path.join(SRC, "vendor")
ASSETS = os.path.join(SRC, "assets")

# All mutable/user data lives under DATA_DIR — mount this as a volume in Docker.
# Defaults to <project>/data; override with KARAEOKE_DATA_DIR (e.g. /data in a container).
DATA_DIR = os.path.abspath(os.environ.get("KARAEOKE_DATA_DIR") or os.path.join(APP_DIR, "data"))
BGV_DIR = os.path.join(DATA_DIR, "bgv")
VIDEOS_DIR = os.path.join(DATA_DIR, "videos")        # karaoke VIDEO songs (parallel to kar_raw/)
DOWNLOADS_DIR = os.path.join(DATA_DIR, "kar_raw")  # compressed-MIDI song payloads
CATALOG_PATH = os.path.join(DATA_DIR, "catalog.json")
VIDEO_CATALOG_PATH = os.path.join(DATA_DIR, "catalog-video.json")
# Shared blocklist of YouTube videoIds that can't be embedded (owner-disabled / removed). Clients
# report them via POST /api/youtube-block; /api/youtube-search filters them out for EVERY user.
YOUTUBE_BLOCKLIST_PATH = os.path.join(DATA_DIR, "youtube-blocklist.json")
VIDEO_EXTS = (".mp4", ".webm", ".ogg", ".mov")

# URL paths the server maps to DATA_DIR instead of the app tree (see Handler.translate_path).
DATA_URL_PREFIXES = ("/kar_raw/", "/videos/", "/bgv/")
DATA_URL_FILES = ("/catalog.json", "/catalog-video.json", "/soundfont.sf2", "/manifest.json")

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


def setup() -> None:
    os.makedirs(VENDOR, exist_ok=True)
    os.makedirs(DATA_DIR, exist_ok=True)
    os.makedirs(DOWNLOADS_DIR, exist_ok=True)  # kar_raw/
    os.makedirs(VIDEOS_DIR, exist_ok=True)
    os.makedirs(BGV_DIR, exist_ok=True)

    # 1) engine files (vendored + committed; warn if a checkout is somehow missing them)
    missing = [f for f in ENGINE_FILES if not os.path.exists(os.path.join(VENDOR, f))]
    if missing:
        print("SpessaSynth engine missing from src/vendor/:")
        for f in missing:
            print(f"    !! {f} — restore it from src/vendor/ (see src/vendor/README.md).")
        print("    The player needs these files to synthesize audio.")
    else:
        print("SpessaSynth engine: vendored ✓")

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
            os.system(f'"{sys.executable}" "{builder}" --downloads-dir "{DOWNLOADS_DIR}" --out "{CATALOG_PATH}"')
        else:
            print("catalog.json missing and builder script not found — search will be empty.")
    else:
        print("catalog.json: present ✓")

    # 4) catalog-video.json (VIDEO) — parallel catalog for drop-in karaoke videos.
    if not os.path.exists(VIDEO_CATALOG_PATH):
        vbuilder = os.path.join(HERE, "build-video-catalog.py")
        if os.path.exists(vbuilder):
            print("Building catalog-video.json from videos/ …")
            os.system(f'"{sys.executable}" "{vbuilder}" --videos-dir "{VIDEOS_DIR}" --out "{VIDEO_CATALOG_PATH}"')
        else:
            print("catalog-video.json missing and video builder not found — no videos listed.")
    else:
        print("catalog-video.json: present ✓")
    print()


def build_bgv_manifest() -> None:
    """List drop-in videos in DATA_DIR/bgv/ into DATA_DIR/manifest.json (served at /manifest.json)."""
    os.makedirs(BGV_DIR, exist_ok=True)
    try:
        vids = sorted(
            f for f in os.listdir(BGV_DIR)
            if f.lower().endswith(VIDEO_EXTS) and os.path.isfile(os.path.join(BGV_DIR, f))
        )
    except OSError:
        vids = []
    manifest = os.path.join(DATA_DIR, "manifest.json")  # one level up from the bgv/ clips
    with open(manifest, "w", encoding="utf-8") as fh:
        json.dump(vids, fh)
    if vids:
        print(f"Background videos: {len(vids)} found in data/bgv/")
    else:
        print("Background videos: none (drop .mp4/.webm in data/bgv/) — using gradient fallback")


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
    }

    def do_GET(self):
        # Honour HTTP Range so <video> seeking works (SimpleHTTPRequestHandler only
        # serves full 200s). Falls back to a normal 200 for non-range / unsatisfiable.
        if self.headers.get("Range") and self._serve_range():
            return
        super().do_GET()

    def translate_path(self, path):
        # Route data URLs (songs, videos, bgv, catalogs, soundfont) to DATA_DIR; every
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

    def do_POST(self):
        if self.path.split("?")[0] == "/api/rebuild-catalog":
            builder = os.path.join(HERE, "build-catalog.py")
            vbuilder = os.path.join(HERE, "build-video-catalog.py")
            try:
                subprocess.run([sys.executable, builder,
                                "--downloads-dir", DOWNLOADS_DIR, "--out", CATALOG_PATH],
                               cwd=APP_DIR, timeout=180, capture_output=True, check=True)
                if os.path.exists(vbuilder):
                    subprocess.run([sys.executable, vbuilder,
                                    "--videos-dir", VIDEOS_DIR, "--out", VIDEO_CATALOG_PATH],
                                   cwd=APP_DIR, timeout=180, capture_output=True, check=True)
                with open(CATALOG_PATH, encoding="utf-8") as fh:
                    n = len(json.load(fh))
                vn = 0
                try:
                    with open(VIDEO_CATALOG_PATH, encoding="utf-8") as fh:
                        vn = len(json.load(fh))
                except (FileNotFoundError, json.JSONDecodeError):
                    pass
                self._send_json({"ok": True, "records": n, "videoRecords": vn})
            except Exception as exc:  # noqa: BLE001
                self._send_json({"ok": False, "error": str(exc)[:200]}, 500)
            return
        if self.path.split("?")[0] == "/api/youtube-search":
            # Keyless YouTube search proxy. Body: {"q": "<query>"} → {"ok", "items":[…]}.
            # Errors are non-fatal (200 with empty items) so the UI just shows nothing.
            try:
                length = int(self.headers.get("Content-Length", 0) or 0)
                raw = self.rfile.read(length) if length else b"{}"
                query = (json.loads(raw or b"{}").get("q") or "").strip()
                items = _youtube_search(query, 20) if query else []
                self._send_json({"ok": True, "items": items})
            except Exception as exc:  # noqa: BLE001
                self._send_json({"ok": False, "items": [], "error": str(exc)[:200]})
            return
        if self.path.split("?")[0] == "/api/youtube-block":
            # Client reports videoIds that can't be embedded → shared blocklist (filtered for all).
            # Body: {"videoIds":[...]} or {"videoId":"..."} → {"ok", "count": total}.
            try:
                length = int(self.headers.get("Content-Length", 0) or 0)
                raw = self.rfile.read(length) if length else b"{}"
                payload = json.loads(raw or b"{}")
                ids = payload.get("videoIds")
                if not isinstance(ids, list):
                    ids = [payload.get("videoId")] if payload.get("videoId") else []
                self._send_json({"ok": True, "count": _add_yt_blocked(ids)})
            except Exception as exc:  # noqa: BLE001
                self._send_json({"ok": False, "error": str(exc)[:200]})
            return
        self.send_error(404)

    def log_message(self, fmt, *args):
        # quieter: only log non-200s and the initial page
        msg = fmt % args
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

    build_bgv_manifest()  # always refresh so drop-in videos are picked up
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
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
