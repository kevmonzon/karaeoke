<div align="center">

# 🎤 Ka-Rae-oke

### A 100% offline, client-side **karaoke / videoke** player

Plays local **MIDI/KAR** songs through an in-browser SoundFont synth with
**tick-synced, per-syllable lyrics** — plus a live **microphone with voice effects &
auto-tune**, a **pitch guide**, **key detection**, **background video**, and drop-in
**video karaoke**. No cloud, no accounts, no build step.

`MIDI → SpessaSynth (WASM) → speakers` · `lyrics parsed from the MIDI itself` · `runs in any modern browser`

</div>

---

## Table of contents

1. [What you get](#1-what-you-get)
2. [Requirements](#2-requirements)
3. [Setup — first run](#3-setup--first-run)
4. [Running the app](#4-running-the-app)
5. [Adding songs](#5-adding-songs)
6. [Using the app — full walkthrough](#6-using-the-app--full-walkthrough)
7. [Settings reference (⚙)](#7-settings-reference-)
8. [Keyboard shortcuts](#8-keyboard-shortcuts)
9. [Serving to phones/TVs on your network](#9-serving-to-phonestvs-on-your-network)
10. [Project structure](#10-project-structure)
11. [Troubleshooting](#11-troubleshooting)
12. [How it works](#12-how-it-works)
13. [Credits & license](#13-credits--license)

---

## 1. What you get

| | Feature |
|---|---|
| 🎹 | **MIDI synthesis** via SpessaSynth (WebAssembly + AudioWorklet) — no external audio files per song |
| 📜 | **Smooth-scrolling lyrics** with per-syllable karaoke wipe, parsed from each song's own MIDI meta events |
| 🎙️ | **Live microphone** mixed with the music: echo, reverb, chorus, pitch-shift, **real-time auto-tune**, feedback/noise control |
| 🎯 | **Pitch guide** — a scrolling piano-roll of the melody to sing, with your live pitch overlaid + a score |
| 🎼 | **Key detection** + **transpose**, **tempo**, **volume**, all persisted |
| 🎞️ | **Video karaoke** — drop in `.mp4`/`.webm` files and they play full-stage alongside the MIDI songs |
| 🌄 | **Background video** layer behind the lyrics (or an animated gradient) |
| 📚 | **17k+ song library** with instant search, virtualized list, queue, and recents |
| 📴 | **Fully offline** after first-run setup (a service worker caches the app) |

> **About:** *Ka-Rae-oke* is an independent, client-side karaoke player, reconstructed for
> research/interoperability from a closed-source karaoke web app and reusing the same
> open-source engine (SpessaSynth). It ships **no song content** of its own — bring your own
> MIDI/KAR or video files.

---

## 2. Requirements

- **Python 3.8+** — the only runtime dependency (standard library only; no `pip install`).
- **A modern desktop browser** — Chromium (Chrome/Edge/Brave) or Firefox. Needs
  AudioWorklet + `SharedArrayBuffer` support (all current browsers qualify).
- **Network access on the first run only** — to download the synth engine and a SoundFont
  (~31 MB, one time). After that it's fully offline.
- **A microphone** (optional) — only for the singing/mic features.

> 💡 **No build step, no Node, no framework** for running the app. (Node is only needed if
> you want to run the unit tests — see [Troubleshooting](#11-troubleshooting).)

---

## 3. Setup — first run

**1. Get the project** onto your machine (clone or copy this folder).

**2. Start the server from the project root:**

```bash
python tools/serve.py
```

On the **first** run it automatically (only downloading what's missing):

- ⬇️ vendors the **SpessaSynth engine** + `pako` into `src/vendor/`
  *(these are already committed; this is just a fallback)*
- ⬇️ fetches a free **General MIDI SoundFont** (GeneralUser GS, ~31 MB) → `data/soundfont.sf2`
- 🗂️ builds **`catalog.json`** from whatever songs are in `data/kar_raw/`
- 🗂️ creates `data/videos/` and builds **`catalog-video.json`** (empty if you have no videos yet)

**3. Your browser opens automatically** at:

```
http://127.0.0.1:8080/
```

That's it — you're ready to sing. 🎉

> ⚠️ **You cannot open `src/index.html` directly (`file://`).** MIDI synthesis needs an
> AudioWorklet with cross-origin isolation (COOP/COEP headers), which **only the HTTP
> server provides**. Always launch via `python tools/serve.py`.

---

## 4. Running the app

```bash
python tools/serve.py                 # setup (if needed) + serve on :8080, opens browser
python tools/serve.py --port 9000     # use a different port
python tools/serve.py --no-open       # don't auto-open the browser
python tools/serve.py --no-setup      # skip the first-run download/build step
python tools/serve.py --host 0.0.0.0  # expose to your local network (see §9)
```

Press **Ctrl+C** to stop. The first time you play a MIDI song, the ~31 MB soundfont loads —
that takes a few seconds; subsequent songs are instant. (Video songs need no soundfont.)

### With Docker

The app ships as a container image containing only the code; your library lives in a mounted
volume at `/data`.

```bash
docker compose up --build          # then open http://localhost:8080/
```

`docker-compose.yml` mounts the host's `./data` directory into the container, so the same
song library, soundfont, and catalogs are used. The image stays small and immutable — add
songs by dropping them in `./data/kar_raw` (or `./data/videos`) on the host and rebuilding
the catalog. Override the data location with the **`KARAEOKE_DATA_DIR`** env var.

> On first boot the container fills any missing pieces into `/data` (the soundfont download
> needs network once) — pre-populate `./data/soundfont.sf2` for a fully-offline image.

---

## 5. Adding songs

### 5.1 MIDI / KAR songs → `data/kar_raw/`

Drop files into the **`data/kar_raw/`** folder using this filename grammar:

```
{code} - {artist} - {title} - {language} - {type}.mid
```

Example: `1 - Bryan Chong - Tahan - International - MIDI.mid`

- `code` is the videoke **dial number** (primary key).
- These payloads may be **raw-DEFLATE-compressed MIDI**; the app inflates them
  automatically. Real uncompressed `MThd…` MIDI files work too.

Then **rebuild the catalog** (see 5.3).

### 5.2 Video karaoke → `data/videos/`

Drop `.mp4` / `.webm` / `.ogg` / `.mov` / `.m4v` files into **`data/videos/`**, same filename
grammar (shorter forms like `{code} - {title}` also work; files with no leading code are
kept too, using the filename as the title). They appear in the same list marked **🎞️**.

### 5.3 Rebuild the catalog

Two ways — both scan `kar_raw/` **and** `videos/` and refresh the library:

- **In the app:** ⚙ → **Library → ↻ Rebuild Catalog**. The list reloads live.
- **From the command line:**
  ```bash
  python tools/build-catalog.py          # rebuild catalog.json from kar_raw/
  python tools/build-video-catalog.py    # rebuild catalog-video.json from videos/
  ```
  Both scan their folders offline and rewrite the catalogs in place.

### 5.4 Bring your own songs

This project ships **no song content**. Drop your own karaoke files into the data
folders and rebuild:

- **MIDI/KAR** → `data/kar_raw/` (filename grammar:
  `"{code} - {artist} - {title} - {lang} - {type}.mid"`), then
  `python tools/build-catalog.py`.
- **Video** → `data/videos/` (`.mp4`/`.webm`/…), then `python tools/build-video-catalog.py`.

`catalog.json` is regenerated locally and is intentionally **git-ignored** — it is a
compilation of your own library, not something the repo distributes.

> 🎤 The song row's **icon** tells you the source at a glance: **🎤** = MIDI, **🎞️** = video.

---

## 6. Using the app — full walkthrough

### Find & queue songs
- **Search** by number, title, or artist in the top-left box. **Enter** plays the top hit.
- **Click** a song to select it, **double-click** to play now, **＋** to add to the **queue**.
- The **☆ Recent** button toggles a recently-played view; click again for the full list.
- The queue auto-advances between songs (MIDI and video alike). Remove queued items with **✕**.

### Playback controls (bottom strip)
- **Play/Pause** (or **Space**), **Stop**, **Restart**, **Next**.
- **Seek bar** — click/drag to scrub.
- **Key ±** — transpose in semitones (the resulting key is named next to it).
- **Tempo** — 0.5×–1.5× playback rate.
- **Volume** — up to 200%.

### Lyrics
A smooth-scrolling column glides upward as lines finish (no jump-cuts); the active line is
painted **syllable-by-syllable**. Nudge timing live with **`[`** / **`]`** (∓50 ms). Tune
visible lines, line merging, width, and font in ⚙ → Lyrics.

### 🎙️ Microphone & voice
⚙ → **Microphone & voice → Enable microphone** (your browser asks permission; `localhost`
counts as secure, so no HTTPS needed). Once live, your voice mixes with the music:
- **Effects:** Echo, Reverb, Chorus, manual Pitch-shift.
- **Auto-tune:** bends your voice to a target — the song's **melody guide**, a **key/scale**,
  or **chromatic** — with adjustable **strength**.
- **Feedback & noise:** browser Echo-cancellation / Noise-suppression / Auto-gain, a
  High-pass filter, and a Noise gate. **The definitive anti-feedback fix is headphones.**

### 🎯 Pitch guide
⚙ → **Pitch guide → Show pitch guide**: a scrolling piano-roll of the melody to sing (read
from the MIDI's guide track). With the mic on it overlays your **live pitch**, a fading
**trail** of where you've been, and a running **score**.

### 🎼 Guide vocal
Turn the detected **melody channel** up to learn a song, **mute** it to perform, or **solo**
it to isolate the tune (⚙ → Pitch guide → guide vocal).

### 🎞️ Video karaoke
A video song plays **full-stage** (the MIDI-only surfaces hide themselves). Transport,
seeking, queue, tempo, volume, and the mic all work. Because a karaoke video has its lyrics
**baked into the picture**, the **lyric offset shifts the video's audio** (not the picture)
so you can line the sound up to the on-screen words.

### 🌄 Background video, title card, Bluetooth mode
- **Background video** (⚙ → Background video): drop clips in `data/bgv/` (restart to
  detect) or list them in `config.js`. No clips → animated gradient.
- **Title card** — a title/artist/key card overlays the lyrics when a song starts, then
  fades in the words (⚙ → duration; 0 = off).
- **Bluetooth mode** (⚙) — BT speakers lag ~260 ms, so this delays the visuals to match and
  disables the mic; the offset stays adjustable.

### Layout
Collapse the **song list / queue / playback strip** from the top-bar toggles (☰ ▦ 🎛). The
live **song count** is under ⚙ → Library. Everything is responsive down to phone widths.

---

## 7. Settings reference (⚙)

All settings live in the **⚙ panel** and persist in `localStorage`. Their **defaults** come
from **`src/config.js`** — edit that file to change built-in defaults, then click **Reset to
defaults** in the panel to adopt them.

| Group | What it controls |
|---|---|
| **Lyrics** | offset, smooth wipe, visible lines, merge lines, width, font scale |
| **Background video** | enabled, mode, opacity, change-per-song, explicit files |
| **Audio** | volume, tempo, key (also driven by the bottom controls) |
| **Key** | auto-detect, show key badge |
| **Pitch guide** | enable, look-ahead, height, melody channel, mic overlay, trail, scoring, guide-vocal vol/mute/solo |
| **Microphone & voice** | enable, volume, echo/reverb/chorus/pitch, auto-tune (mode/strength/key/scale), AEC/NS/AGC, high-pass, noise gate |
| **Title card** | seconds shown (0 = off) |
| **Bluetooth** | latency-compensation mode |
| **UI** | collapsible-panel visibility |

---

## 8. Keyboard shortcuts

| Key | Action |
|---|---|
| **Space** | Play / pause |
| **Enter** (in search) | Play the top search hit |
| **`[`** / **`]`** | Nudge lyric offset −/+ 50 ms |
| **Esc** (in search) | Clear the search box |
| **Double-click** a song | Play now |

---

## 9. Serving to phones/TVs on your network

Use the LAN launchers (they bind to `0.0.0.0` and print the URL other devices should open):

```bash
tools/serve-lan.sh          # macOS / Linux / Git-Bash
# or directly (any OS, incl. Windows):
python tools/serve.py --host 0.0.0.0
```

Open the printed `http://<your-LAN-IP>:8080/` on any device on the same Wi-Fi.

> ⚠️ On remote devices the **microphone is unavailable** (browsers require HTTPS or
> localhost for mic access) — playback, lyrics, and the pitch guide still work. On Windows,
> allow Python through the firewall on **Private** networks.

---

## 10. Project structure

```
karaoke-clone/
├── README.md                 ← this file (setup + usage + architecture overview)
├── package.json              ← npm test (node --test) for the pure functions
├── tools/                    ← all ops scripts (run from the project root)
│   ├── serve.py              ← the local server + first-run setup   ← START HERE
│   ├── serve-lan.sh         ← LAN launcher
│   ├── build-catalog.py      ← (re)build catalog.json from data/kar_raw/
│   └── build-video-catalog.py← (re)build catalog-video.json from data/videos/
│
├── data/                     ← ALL your content — the mounted volume in Docker
│   ├── catalog.json          ← MIDI song library (rebuilt locally)        [git-ignored]
│   ├── catalog-video.json    ← video song library (rebuilt locally)      [git-ignored]
│   ├── kar_raw/          ← MIDI/KAR song files (compressed MIDI)   [git-ignored]
│   ├── videos/               ← video-karaoke files                     [git-ignored]
│   ├── soundfont.sf2         ← General MIDI SoundFont (~31 MB, auto-fetched) [git-ignored]
│   ├── manifest.json         ← bgv clip list (auto-written each start)  [git-ignored]
│   └── bgv/                  ← drop background videos here             [git-ignored]
│
├── Dockerfile · .dockerignore · docker-compose.yml   ← containerized run (§4)
│
└── src/                      ← the app — served at the site root /
    ├── index.html            ← shell + import map + settings panel
    ├── config.js             ← DEFAULT_CONFIG (editable defaults)
    ├── css/style.css
    ├── sw.js                 ← service worker (offline caching)
    ├── js/                   ← app modules (app, catalog, audio, lyrics, mic, melody, video, …)
    └── vendor/               ← SpessaSynth engine + pako (committed)
```

> **The app (`src/` + `tools/`) is immutable; everything you supply lives in `data/`.** That
> split is what makes it portable: in Docker the image holds only the app and `data/` is a
> mounted volume. Locally, `data/` defaults to `<project>/data`; point elsewhere with the
> `KARAEOKE_DATA_DIR` environment variable.
>
> **Run all `tools/` scripts from the project root** (e.g. `python tools/serve.py`). Each
> anchors its paths to the project root regardless of the working directory.

---

## 11. Troubleshooting

| Symptom | Fix |
|---|---|
| **Blank page / "SharedArrayBuffer is not defined"** | You opened `index.html` as a `file://`. Launch via `python tools/serve.py` instead. |
| **No sound when a MIDI song plays** | The first play loads the 31 MB soundfont — wait a few seconds. If still silent, check `src/assets/soundfont.sf2` exists (re-run setup) and that your OS volume/output is right. |
| **"Invalid MIDI Header! Expected 'MThd'…"** | A song file isn't valid MIDI. The app handles compressed MIDI automatically; a truly corrupt file should be removed from `kar_raw/`. |
| **Search is empty / song missing** | Rebuild the catalog (⚙ → Library → Rebuild, or `python tools/build-catalog.py`). |
| **Video won't seek / stops** | Seeking needs HTTP Range (206) — always serve via `tools/serve.py`, not another static server. |
| **Mic won't enable** | It needs a click (browser gesture) + a secure context. Use `http://localhost` / `127.0.0.1` (not a LAN IP). Grant the browser permission when prompted. |
| **Feedback/howling on speakers** | Use **headphones**. Otherwise keep Echo-cancellation + Noise-gate on and lower mic volume. |
| **Port 8080 in use** | `python tools/serve.py --port 9000`. |
| **First-run downloads fail** | You need internet on the first run only. Re-run, or manually place a General MIDI `.sf2` at `src/assets/soundfont.sf2`. |
| **Run the tests** | `npm test` (or `node --test`) — covers the pure functions. Needs Node.js. |

---

## 12. How it works

```
catalog.json + catalog-video.json ──► one merged, searchable list
        │
   pick a song ──► dispatch on kind
        │
   ── MIDI ──►  fetch /kar_raw/<file>  ──► inflate (pako) ──► SpessaSynth synth ──► speakers
        │                                                     └─► parse lyrics from the same bytes
   ── VIDEO ─►  fetch /videos/<file> (HTTP Range 206) ──► <video> picture + offset-shifted audio
        │
   requestAnimationFrame loop: lyric sync · pitch guide · auto-tune · seek bar · queue advance
```

Everything is **same-origin and offline** after setup. The server (`tools/serve.py`) sends
the cross-origin-isolation headers the synth needs, serves HTTP Range requests so video
seeking works, and exposes one endpoint — `POST /api/rebuild-catalog` — behind the ⚙ rebuild
button. For deeper detail, the module reference and gotchas are documented inline in the
`src/js/` source.

---

## 13. Credits & license

This is an independent, client-side reconstruction for research/interoperability, reusing
the same open-source engine the original app uses.

This project's own code is **MIT-licensed** — see [`LICENSE`](LICENSE). Bundled
third-party engine components under `src/vendor/` keep their own licenses (full texts
in `src/vendor/`, summarized in `src/vendor/NOTICE`):

- **SpessaSynth** (**Apache-2.0**) — SoundFont synthesis — <https://github.com/spessasus/SpessaSynth>
- **pako** (MIT) — zlib/deflate inflate — <https://github.com/nodeca/pako>
- **GeneralUser GS** by S. Christian Collins — freely redistributable General MIDI SoundFont (fetched at first run, not bundled)
- The original application's design belongs to its author; this project does not redistribute
  that app's code, catalog, or songs — it reconstructs interoperable behavior using
  open-source parts, and ships no song content.

Built with **[Claude](https://www.anthropic.com/claude)** (Anthropic).

<div align="center">

**Now go sing.** 🎶

*Who is the beautiful genius that made your living room a concert hall? Elaina, of course.*

</div>
