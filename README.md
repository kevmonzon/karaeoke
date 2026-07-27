<div align="center">

# 🎤 Ka-Rae-oke

### A client-side **karaoke / videoke** player

Plays local **MIDI/KAR** songs through an in-browser SoundFont synth with
**tick-synced, per-syllable lyrics** — plus a live **microphone with voice effects &
auto-tune**, a **pitch guide**, **key detection**, drop-in
**video karaoke**, and optional **YouTube karaoke search**. No accounts, no build step;
your local library plays offline after first-run setup.

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
| 🎸 | **Chords** — an auto-detected guitar chord lane above the lyrics, scrolling in time (MIDI songs) |
| 🎛️ | **MIDI mode** — a per-channel mixer (16 channels: volume, mute/solo, live VU) for the current MIDI song |
| 🎼 | **Key detection** + **transpose**, **tempo**, **volume**, all persisted |
| 🎞️ | **Video karaoke** — drop in `.mp4`/`.webm` files; play full-stage with real-time **key change** + volume >100% |
| 🎵 | **Audio + lyrics** — drop a recorded audio file + a matching `.lrc`/`.kar`/`.vtt`/`.txt` sidecar; plays with scrolling lyrics + a **real-time key change** |
| 🌐 | **YouTube karaoke search (BYOC)** — optionally find & play karaoke videos from YouTube (Chromium-only; needs a network) |
| 📚 | **Whole-library** instant search, virtualized list, queue, recents & favorites |
| 📱 | **Phone remote** — show a QR on the queue; guests scan it to queue, search & control playback from their phones |
| 💾 | **Runs locally** — after first-run setup your MIDI & video songs play with **no network** (the soundfont + song files are cached in the browser) |

> **About:** *Ka-Rae-oke* is an independent, client-side karaoke player, reconstructed for
> research/interoperability from a closed-source karaoke web app and reusing the same
> open-source engine (SpessaSynth). It ships **no song content** of its own — bring your own
> MIDI/KAR or video files.

---

## 2. Requirements

- **Python 3.8+** — the only runtime dependency (standard library only; no `pip install`).
- **A modern desktop browser** — Chromium (Chrome/Edge/Brave) or Firefox. Needs
  AudioWorklet + `SharedArrayBuffer` support (all current browsers qualify).
- **Network access** — required on the **first run** (to download the synth engine and a
  ~31 MB SoundFont, one time) and for the optional **YouTube search**. Your local MIDI &
  video songs play offline after setup.
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

- ⬇️ vendors the **SpessaSynth engine** + `pako` + the **QR encoder** into `src/vendor/`
  *(these are already committed; this is just a fallback)*
- ⬇️ fetches a free **General MIDI SoundFont** (GeneralUser GS, ~31 MB) → `data/soundfont.sf2`
- 🗂️ builds **`catalog.json`** from whatever songs are in `data/kar_raw/`
- 🗂️ creates `data/videos/` + `data/audio_lyrics/` and builds **`catalog-video.json`** / **`catalog-audio.json`** (empty if you have none yet)

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
songs by dropping them in `./data/kar_raw` (or `./data/videos`, `./data/audio_lyrics`) on the host
and rebuilding the catalog. Override the data location with the **`KARAEOKE_DATA_DIR`** env var.

> On first boot the container fills any missing pieces into `/data` (the soundfont download
> needs network once) — pre-populate `./data/soundfont.sf2` so the container needs no
> network at boot.

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

### 5.3 Audio + lyrics → `data/audio_lyrics/`

Have a recorded track and a lyric file? Drop **two files that share the same name** into
**`data/audio_lyrics/`** — the audio (`.mp3` / `.wav` / `.flac` / `.m4a` / `.opus` / …) and a
matching lyric **sidecar**:

- lyric formats: **`.lrc`** (synced; supports per-word timing for the wipe), a **lyrics-only
  `.kar` / `.mid`**, **`.vtt` / `.srt`** subtitles, or plain **`.txt`**.
- e.g. `9700 - Adele - Hello - International - AUDIO.mp3` **+** `9700 - Adele - Hello - International - AUDIO.lrc`

They appear marked **🎵** and play full-stage **with scrolling lyrics**. The **Key** control
pitch-shifts the audio in real time (in stereo), and volume can go past 100%. (An audio file with
no sidecar still plays — just without lyrics.)

### 5.4 Rebuild the catalog

Two ways — both scan `kar_raw/`, `videos/` **and** `audio_lyrics/` and refresh the library:

- **In the app:** ⚙ → **Library → ↻ Rebuild Catalog**. The list reloads live.
- **From the command line:**
  ```bash
  python tools/build-catalog.py          # rebuild catalog.json from kar_raw/
  python tools/build-video-catalog.py    # rebuild catalog-video.json from videos/
  python tools/build-audio-catalog.py    # rebuild catalog-audio.json from audio_lyrics/
  ```
  Each scans its folder offline and rewrites the catalog in place.

### 5.5 Bring your own songs

This project ships **no song content**. Drop your own karaoke files into the data
folders and rebuild:

- **MIDI/KAR** → `data/kar_raw/` (filename grammar:
  `"{code} - {artist} - {title} - {lang} - {type}.mid"`), then
  `python tools/build-catalog.py`.
- **Video** → `data/videos/` (`.mp4`/`.webm`/…), then `python tools/build-video-catalog.py`.
- **Audio + lyrics** → `data/audio_lyrics/` (an audio file + a matching-name `.lrc`/`.kar`/`.vtt`/
  `.txt` sidecar), then `python tools/build-audio-catalog.py`.

`catalog.json` is regenerated locally and is intentionally **git-ignored** — it is a
compilation of your own library, not something the repo distributes.

> 🎤 The song row's **icon** tells you the source at a glance: **🎤** = MIDI, **🎞️** = video.

---

## 6. Using the app — full walkthrough

### Find & queue songs
- **Search** by number, title, or artist in the top-left box. **Enter** plays the top hit.
- **Click** a song to select it, **double-click** to play now, **＋** to add to the **queue**.
- **★** stars a song; the **★ Favorites** and **⟲ Recent** pills toggle those filtered views.
- The **🌐** pill in the search row toggles **YouTube search** (see below; **on by default** — it still only queries when your local results are thin).
- The queue auto-advances between songs (MIDI, video, and YouTube alike). Remove queued items with **✕**.

### Playback controls (overlay)
The transport + seek bar float as a **translucent overlay** at the bottom of the stage. By default
they **auto-hide** after a few idle seconds and reappear on any movement or keypress — turn
**Always show playback controls** on (or change the **Auto-hide after** delay) under **⚙ → Display**.
- **Play/Pause** (or **Space**), **Next**, **🎵 Melody** (toggle the melody guide vocal on/off), and **🎤 Mic**.
- **Seek bar** — click/drag to scrub (the current / total time flank it).
- **Key ±** — transpose in semitones (the resulting key is named next to it).
- **Tempo ±** — 0.5×–1.5× playback rate (a −/＋ stepper, like Key).
- **Volume** — up to 200%.

The controls spread evenly and reflow (stack) on narrow screens.

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
⚙ → **Pitch guide → Show pitch guide** (on by default): a scrolling piano-roll of the melody to
sing (read from the MIDI's guide track). With the mic on it overlays your **live pitch**, a fading
**trail** of where you've been, and an optional running **score** (scoring is off by default).

### 🎼 Guide vocal
Turn the detected **melody channel** up to learn a song, **mute** it to perform, or **solo**
it to isolate the tune (⚙ → Pitch guide → guide vocal). The **🎵** button in the transport — and
the **Melody** toggle on the phone remote — is a quick mute/unmute for it.

### 🎸 Chords (guitar follow-along)
⚙ → **Chords → Show chords** (off by default): a chord lane above the lyrics scrolls to anchor the
current chord, so guitarists can strum along. These KAR files carry no chord symbols — they're
**auto-detected from the notes** on load. The **Key ±** transpose **relabels the chords live**
(in sharps), and a **Simplify** toggle collapses jazzy 7ths/sus to the bare triad a strummer
plays (and fixes thirdless power chords to the key's triad). **MIDI-only** — hidden for video
and YouTube, which carry no note data.

### 🎛️ MIDI mode (channel mixer)
⚙ → **MIDI mode** reveals a per-channel mixer between the lyrics and the transport for the
current MIDI song. It shows **all 16 channels** (each labeled by instrument, ch 10 = Drums;
silent channels are dimmed) with a **volume slider, mute + solo, and a live VU meter** fed by
each channel's real audio level. Untouched channels keep the song's authored mix; turning MIDI
mode off — or loading a new song — hands the mix back. **MIDI-only**; per-channel positions
reset per song.

### 🎞️ Video karaoke
A video song plays **full-stage** (the MIDI-only surfaces hide themselves). Transport,
seeking, queue, tempo, volume, and the mic all work. Because a karaoke video has its lyrics
**baked into the picture**, the **lyric offset shifts the video's audio** (not the picture)
so you can line the sound up to the on-screen words. The **Key ±** control now **transposes the
video's audio in real time** (in stereo), and the **volume can go past 100%**. *(Transposing adds
~30–40 ms of audio latency — nudge the lyric offset if you need perfect lip-sync; at Key 0 there's
no added latency.)*

### 🌐 YouTube karaoke (BYOC)
**On by default**, but the app stays offline-first in practice — it queries YouTube **only when your
local library comes up short**. Toggle it with the **🌐** pill in the search row (or ⚙ →
**YouTube search**). Such a search appends a "karaoke" keyword to the query, and the hits append to
the list marked **🌐**. Selecting one plays the **official YouTube embed** full-stage, with working
transport / seek / queue / tempo / volume and the mic; YouTube songs are favoritable and show
up in Recent. Nothing is downloaded — it stores only a `youtube:<videoId>` pointer.
**Chromium-only** (it needs a `credentialless` iframe; the pill is dimmed elsewhere) and it
**needs a network**. Tune the threshold / debounce / max-results / keyword in ⚙.

### 📱 Remote control (phones)
Turn on **⚙ → Sources → Remote** and a **QR code + room code** appear on the queue panel. Guests
scan the QR with their phones (same network) to open **`/remote`**. Scanning auto-connects; anyone
typing the URL by hand enters the **room code** shown on screen. Four tabs:
- **Now** — the current song with play/pause, next, seek, **key / tempo / volume** (tempo is a −/＋
  stepper), and a **🎵 Melody** On/Off toggle so a singer can silence the melody guide from their phone
  (mirrors the host's 🎵 button).
- **Search** — the same songbook (number / title / artist), plus optional 🌐 YouTube; tap **＋** to queue.
- **Queue** — the live queue with an "added by" name, plus remove / reorder.
- **You** — your nickname (shown on songs you add), the lyric offset, device theme & text size, and
  the connection status + room code.

The host stays the real player — phones send requests that the host applies, so the whole room can
build the queue together. When a song was queued from a phone, the host shows **who's singing** above
the melody guide and on the title card, and an **"up next"** line in the last 20 seconds.

The **room code** is generated once per host browser and kept there (stable across restarts). Each
host has its own code, so several karaoke stations can share one server. **On by default** (turn it off
in ⚙ for an untrusted network). ⚠️ The
code is a **friction gate for a trusted network, not real security** — anyone on your LAN who has the
code can control playback (see [§9](#9-serving-to-phonestvs-on-your-network)).

### 🎬 Title card, Bluetooth mode
- **Title card** — a title / artist / key (and singer, if queued from a phone) card overlays the
  lyrics when a song starts, then fades in the words (⚙ → duration 0–10 s; 0 = off).
- **Bluetooth mode** (⚙) — BT speakers lag ~260 ms, so this delays the visuals to match and
  disables the mic; the offset stays adjustable.

### Layout & screens
Set the overall **Font size** — **Small / Medium / Large** (**⚙ → Display → Font size**) — to scale
the whole player's text + controls for your viewing distance (pick **Large** for a TV across the
room); the Lyrics **Lyrics size** slider fine-tunes just the lyrics on top. Collapse the **song list
/ queue** from the top-bar toggles (**🔍 ▦**), go **full screen** with the **⛶** button (top-right),
and find the live **song count** under ⚙ → Library.

On **phones and tablets in portrait** the layout stacks to a single column with the lyrics front and
centre, and the **song list (🔍)** and **queue (▦)** open **one at a time** to save space (tap the
open one to hide it for a full-screen lyrics view). A **tablet in landscape** gets the full desktop
three-column layout. The remote QR, focus (◎), and full-screen (⛶) buttons are hidden on mobile.

---

## 7. Settings reference (⚙)

All settings live in the **⚙ panel** and persist in `localStorage`. Their **defaults** come
from **`src/config.js`** — edit that file to change built-in defaults, then click **Reset to
defaults** in the panel to adopt them.

The panel is organized into **collapsible categories** (🎬 Display · 🎵 Music · 🎤 Singing ·
🔎 Sources) with a **search box** at the top — start typing to filter every control across all
categories at once (it matches labels, section names, and synonyms like "latency" → Offset or
"transpose" → Key). `Esc` or ✕ clears.

| Group | What it controls |
|---|---|
| **Lyrics** | offset, smooth wipe, visible lines, merge lines, width, lyrics size |
| **Audio** | volume, tempo, key (also driven by the bottom controls) |
| **Key** | auto-detect, show key badge |
| **Pitch guide** | enable, look-ahead, height, melody channel, mic overlay, trail, scoring, guide-vocal vol/mute/solo |
| **Chords** | show chord lane, simplify (collapse 7ths/sus to triads) |
| **MIDI mode** | enable the per-channel mixer band (volume/mute/solo/VU) |
| **Microphone & voice** | enable, volume, echo/reverb/chorus/pitch, auto-tune (mode/strength/key/scale), AEC/NS/AGC, high-pass, noise gate |
| **YouTube search** | enable, result threshold, debounce, max results, append-keyword |
| **Remote** | enable the phone remote (QR on the queue panel), auto-detected URL + override |
| **Font size** | Small / Medium / Large — scales the whole player's text + controls (the Lyrics "Lyrics size" slider fine-tunes lyrics on top) |
| **Playback controls** | Always show (off = the transport overlay auto-hides) + auto-hide delay |
| **Title card** | seconds shown, 0–10 (0 = off; default 5) |
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

### 📱 Phone remote control

Once you're serving on the LAN, turn on **⚙ → Sources → Remote** on the host. A **QR code + a room
code** appear on the queue panel — guests scan the QR to open **`http://<your-LAN-IP>:8080/remote`**
(it auto-connects), or type that URL and enter the **room code** shown on screen. Then they can
queue / search / control from their phones (any modern mobile browser; see the walkthrough in
[§6](#6-using-the-app--full-walkthrough)). The URL is **auto-detected** (the host's LAN IP, or the
public origin behind a tunnel like cloudflared); set a manual **URL override** in ⚙ if needed.

> ⚠️ The room code is a **friction gate for a trusted network, not real security** — anyone on your
> LAN with the code can control playback and edit the queue. Keep it on a **trusted network**; behind
> a public tunnel the code is weak protection. The remote is **on by default** (turn it off in ⚙ on an
> untrusted network) and only relays while
> the host tab stays the foreground display. The code is generated once per host browser and is stable
> across restarts; each host has its own, so several stations can share one server.

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
│   ├── build-video-catalog.py← (re)build catalog-video.json from data/videos/
│   └── build-audio-catalog.py← (re)build catalog-audio.json from data/audio_lyrics/
│
├── data/                     ← ALL your content — the mounted volume in Docker
│   ├── catalog.json          ← MIDI song library (rebuilt locally)        [git-ignored]
│   ├── catalog-video.json    ← video song library (rebuilt locally)      [git-ignored]
│   ├── catalog-audio.json    ← audio+lyrics song library (rebuilt locally) [git-ignored]
│   ├── kar_raw/          ← MIDI/KAR song files (compressed MIDI)   [git-ignored]
│   ├── videos/               ← video-karaoke files                     [git-ignored]
│   ├── audio_lyrics/         ← audio files + matching lyric sidecars    [git-ignored]
│   └── soundfont.sf2         ← General MIDI SoundFont (~31 MB, auto-fetched) [git-ignored]
│
├── Dockerfile · .dockerignore · docker-compose.yml   ← containerized run (§4)
│
└── src/                      ← the app — served at the site root /
    ├── index.html            ← shell + import map + settings panel
    ├── remote.html           ← phone remote-control page (served at /remote)
    ├── config.js             ← DEFAULT_CONFIG (editable defaults)
    ├── css/style.css · css/remote.css
    ├── sw.js                 ← self-destruct stub (the caching SW was removed; unregisters old workers)
    ├── js/                   ← app modules (app, catalog, audio, video, youtube, audiofile, lyrics,
    │                            lyrics-formats, mic, melody, remote-host, remote [phone], asset-cache, …)
    └── vendor/               ← SpessaSynth engine + pako + qrcode (committed)
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
| **No sound when a MIDI song plays** | The first play loads the 31 MB soundfont — wait a few seconds. If still silent, check `data/soundfont.sf2` exists (re-run setup) and that your OS volume/output is right. |
| **"Invalid MIDI Header! Expected 'MThd'…"** | A song file isn't valid MIDI. The app handles compressed MIDI automatically; a truly corrupt file should be removed from `kar_raw/`. |
| **Search is empty / song missing** | Rebuild the catalog (⚙ → Library → Rebuild, or `python tools/build-catalog.py`). |
| **Video won't seek / stops** | Seeking needs HTTP Range (206) — always serve via `tools/serve.py`, not another static server. |
| **Mic won't enable** | It needs a click (browser gesture) + a secure context. Use `http://localhost` / `127.0.0.1` (not a LAN IP). Grant the browser permission when prompted. |
| **Feedback/howling on speakers** | Use **headphones**. Otherwise keep Echo-cancellation + Noise-gate on and lower mic volume. |
| **Port 8080 in use** | `python tools/serve.py --port 9000`. |
| **Phone remote won't connect** | Enable ⚙ → Remote on the host, serve on the LAN (`--host 0.0.0.0`), and put the phone on the same Wi-Fi. If the QR URL shows `127.0.0.1`, set the ⚙ URL override to your LAN IP. Keep the host tab in the **foreground** (a backgrounded tab throttles the sync and the phone shows "waiting for host"). |
| **QR code doesn't render** | The QR needs `src/vendor/qrcode.min.js` — re-run `python tools/serve.py` once to fetch it. The URL text is always shown even without the image. |
| **First-run downloads fail** | You need internet on the first run only. Re-run, or manually place a General MIDI `.sf2` at `data/soundfont.sf2`. |
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
   ── YOUTUBE ► official YouTube IFrame embed in a credentialless iframe (Chromium; online)
        │
   requestAnimationFrame loop: lyric sync · pitch guide · auto-tune · seek bar · queue advance
```

Local **MIDI/video** playback is **same-origin and works offline** after setup; the optional
**YouTube search** is the one online, cross-origin feature. The server (`tools/serve.py`) sends
the cross-origin-isolation headers the synth needs, serves HTTP Range requests so video seeking
works, and exposes a few endpoints — `POST /api/rebuild-catalog` (⚙ rebuild button),
`/api/youtube-search` + `/api/youtube-block` (the keyless YouTube search), and the **phone-remote
relay** (`/api/remote/*`): an in-memory, ephemeral channel where the host posts its state and drains
the commands guests send from `/remote` (the host stays the authoritative player). For deeper detail,
the module reference and gotchas are documented inline in the `src/js/` source.

---

## 13. Credits & license

This is an independent, client-side reconstruction for research/interoperability, reusing
the same open-source engine the original app uses.

This project's own code is **MIT-licensed** — see [`LICENSE`](LICENSE). Bundled
third-party engine components under `src/vendor/` keep their own licenses (full texts
in `src/vendor/`, summarized in `src/vendor/NOTICE`):

- **SpessaSynth** (**Apache-2.0**) — SoundFont synthesis — <https://github.com/spessasus/SpessaSynth>
- **pako** (MIT) — zlib/deflate inflate — <https://github.com/nodeca/pako>
- **qrcode-generator** (MIT) by Kazuhiko Arase — the phone-remote QR code — <https://github.com/kazuhikoarase/qrcode-generator>
- **GeneralUser GS** by S. Christian Collins — freely redistributable General MIDI SoundFont (fetched at first run, not bundled)
- The original application's design belongs to its author; this project does not redistribute
  that app's code, catalog, or songs — it reconstructs interoperable behavior using
  open-source parts, and ships no song content.

Built with **[Claude](https://www.anthropic.com/claude)** (Anthropic).

<div align="center">

**Now go sing.** 🎶

*Who is the beautiful genius that made your living room a concert hall? Elaina, of course.*

</div>
