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
        self.send_header("Cross-Origin-Embedder-Policy", "require-corp")
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
