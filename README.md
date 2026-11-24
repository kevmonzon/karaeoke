<div align="center">

# 🎤 Ka-Rae-oke

### A client-side **karaoke / videoke** player

Plays local **MIDI/KAR** songs through an in-browser SoundFont synth with
**tick-synced, per-syllable lyrics** on a full-screen **videoke stage** — plus a live
**microphone with voice effects & auto-tune**, **per-note scoring**, a **pitch guide**,
**key detection**, drop-in **video karaoke**, **phone remotes**, **TV-remote / D-pad control**,
and optional **YouTube karaoke search**. No accounts, no build step; your local library plays
offline after first-run setup.

`MIDI → SpessaSynth (WASM) → speakers` · `lyrics parsed from the MIDI itself` · `runs in any modern browser`

</div>

---

## Table of contents

1. [What you get](#1-what-you-get)
2. [Requirements](#2-requirements)
3. [Setup — first run](#3-setup--first-run)
4. [Running the app](#4-running-the-app)
5. [Adding songs & backgrounds](#5-adding-songs--backgrounds)
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
| 🖥️ | **Stage-first everywhere** — one full-screen stage on every device; Songs (with the queue as its last tab), Mixer and Settings slide in from the right, a quiet status line and corner buttons sit along the bottom, and a home screen (QR + room code) shows when nothing is playing |
| 📜 | **Videoke lyrics** — two fixed rows that take turns, outlined text and a count-in after each break (or the classic smooth-scrolling column), with a per-syllable wipe parsed from each song's own MIDI meta events |
| 🔎 | **Forgiving search** — typo-tolerant (≈ close matches), a number finds that number in **every songbook** (SH, PLATKAR, TJMEDIA, MIDI), plus **Artists** and **Rankings** tabs |
| 🎮 | **TV remote / D-pad / keyboard** — everything works with arrows, OK and Back alone; colour keys, media keys and number keys are shortcuts |
| 🎙️ | **Live microphone** mixed with the music: echo, reverb, chorus, pitch-shift, **real-time auto-tune**, feedback/noise control, and a **latency calibration** |
| 🏆 | **Score** — every note judged (PERFECT … MISS) against the song's own guide melody, three difficulties, a full-stage score card and a **leaderboard** |
| 🎯 | **Pitch guide** — a scrolling piano-roll of the melody to sing, with your live pitch overlaid |
| 🔊 | **Sound** — the drums stay put when you change key, reverb/chorus levels, a 10-band **EQ** with presets, and **even song loudness** learned per song |
| 🖼️ | **Backgrounds** — your own looping videos, a photo slideshow, or the live camera behind the lyrics |
| 🎸 | **Chords** — an auto-detected guitar chord lane above the lyrics, scrolling in time (MIDI songs) |
| 🎛️ | **Channel mixer** — 16 channels (volume, mute/solo, live VU) for the current MIDI song |
| 🎼 | **Key detection** + **transpose**, **tempo**, **volume**, all persisted |
| 🎞️ | **Video karaoke** — drop in `.mp4`/`.webm` files; play full-stage with real-time **key change** + volume >100% |
| 🎵 | **Audio + lyrics** — drop a recorded audio file + a matching `.lrc`/`.kar`/`.vtt`/`.txt` sidecar; plays with lyrics + a **real-time key change** |
| 🌐 | **YouTube karaoke search (BYOC)** — optionally find & play karaoke videos from YouTube (Chromium-only; needs a network) |
| 📱 | **Phone remote** — guests scan a QR to search, reserve and control from their phones, with **instant updates**, and the TV's lyrics on their own screen |
| 🎉 | **Party features** — fair-play queue ordering, a per-guest song cap and emoji reactions that float on the screen |
| 💾 | **Runs locally** — after first-run setup your MIDI & video songs play with **no network** (the soundfont + song files are cached in the browser) |

> **About:** *Ka-Rae-oke* is an independent, client-side karaoke player, reconstructed for
> research/interoperability from a closed-source karaoke web app and reusing the same
> open-source engine (SpessaSynth). It ships **no song content** of its own — bring your own
> MIDI/KAR or video files.

---

## 2. Requirements

- **Python 3.8+** — the only runtime dependency (standard library only; no `pip install`).
- **A modern browser** — Chromium (Chrome/Edge/Brave) or Firefox, on a computer, tablet or TV.
  Needs AudioWorklet + `SharedArrayBuffer` support (all current browsers qualify).
- **Network access** — required on the **first run** (to download the synth engine and a
  ~31 MB SoundFont, one time) and for the optional **YouTube search**. Your local MIDI &
  video songs play offline after setup.
- **A microphone** (optional) — for singing through the app, scoring and calibration.
- **A camera** (optional) — only for the camera background.

> 🔒 **MIDI songs**, the microphone and the camera only work on a **secure page**: `http://localhost` /
> `http://127.0.0.1` on the machine running the server, or HTTPS. See
> [§9](#9-serving-to-phonestvs-on-your-network) for what that means on a TV box.

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

(The background folders `data/bgv/` and `data/bgphoto/` are not created for you — make them
when you want backgrounds; see [§5.6](#56-backgrounds--databgv-and-databgphoto).)

**3. Your browser opens automatically** at:

```
http://127.0.0.1:52723/
```

That's it — you're ready to sing. 🎉

> ⚠️ **You cannot open `src/index.html` directly (`file://`).** MIDI synthesis needs an
> AudioWorklet with cross-origin isolation (COOP/COEP headers), which **only the HTTP
> server provides**. Always launch via `python tools/serve.py`.

---

## 4. Running the app

```bash
python tools/serve.py                 # setup (if needed) + serve on :52723, opens browser
python tools/serve.py --port 9000     # use a different port
python tools/serve.py --no-open       # don't auto-open the browser
python tools/serve.py --no-setup      # skip the first-run download/build step
python tools/serve.py --host 0.0.0.0  # expose to your local network (see §9)
```

Press **Ctrl+C** to stop. The first time you play a MIDI song, the ~31 MB soundfont loads —
that takes a few seconds; subsequent songs are instant. (Video songs need no soundfont.)

> **The default port is 52723** (it was 8080 until 2026-11-25). Your browser keeps the app's settings, queue,
> favorites and rankings **per address**, so the first visit at `:52723` starts from defaults. To bring them
> along: start once with `--port 8080`, ⚙ → Application → Backup → **Export app data**, then restart on the
> new port and **Import app data**.

### With Docker

The app ships as a container image containing only the code; your library lives in a mounted
volume at `/data`.

```bash
docker compose up --build          # then open http://localhost:52723/
```

`docker-compose.yml` publishes port **52723** (the server's default, inside and out) and mounts
the host's `./data` directory into the container, so the same song library, soundfont, and
catalogs are used. The image stays small and immutable — add songs by dropping them in
`./data/kar_raw` (or `./data/videos`, `./data/audio_lyrics`) on the host and rebuilding the
catalog; backgrounds go in `./data/bgv` and `./data/bgphoto`. Override the data location with the
**`KARAEOKE_DATA_DIR`** env var.

> On first boot the container fills any missing pieces into `/data` (the soundfont download
> needs network once) — pre-populate `./data/soundfont.sf2` so the container needs no
> network at boot.

---

## 5. Adding songs & backgrounds

### 5.1 MIDI / KAR songs → `data/kar_raw/`

Drop `.mid` / `.midi` / `.kar` files into the **`data/kar_raw/`** folder using this filename grammar:

```
{code} - {artist} - {title} - {language} - {songbook}.mid
```

Example: `1 - Bryan Chong - Tahan - International - MIDI.mid`

- `code` is the videoke **dial number**. It is not unique: the same number can exist in several
  songbooks, and a number search lists them all (§6).
- `songbook` is one of **SH**, **PLATKAR**, **TJMEDIA** or **MIDI** — a number search lists the
  songbooks in that order, and typing a songbook's name finds its songs. SH and PLATKAR files carry
  no language field:
  `{code} - {artist} - {title} - SH.kar`. A file with no songbook tag still catalogs (it just has
  no songbook).
- These payloads may be **raw-DEFLATE-compressed MIDI**; the app inflates them
  automatically. Real uncompressed `MThd…` MIDI files work too.

Then **rebuild the catalog** (see 5.4).

> 🔁 **Upgrading from an older version?** Rebuild the catalog once (⚙ → Application → Library →
> ↻ Rebuild Catalog). Older catalogs have no songbooks (so a number search can't order them by
> songbook) until you do — and some SH / PLATKAR songs listed with "SH" or "PLATKAR" as their title
> get their real titles back.

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

They appear marked **🎵** and play full-stage **with lyrics**. The **Key** control
pitch-shifts the audio in real time (in stereo), and volume can go past 100%. (An audio file with
no sidecar still plays — just without lyrics.)

### 5.4 Rebuild the catalog

Two ways — both scan `kar_raw/`, `videos/` **and** `audio_lyrics/` and refresh the library:

- **In the app:** ⚙ → **Application → Library → ↻ Rebuild Catalog**. The list reloads live.
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
  `"{code} - {artist} - {title} - {lang} - {songbook}.mid"`), then
  `python tools/build-catalog.py`.
- **Video** → `data/videos/` (`.mp4`/`.webm`/…), then `python tools/build-video-catalog.py`.
- **Audio + lyrics** → `data/audio_lyrics/` (an audio file + a matching-name `.lrc`/`.kar`/`.vtt`/
  `.txt` sidecar), then `python tools/build-audio-catalog.py`.

`catalog.json` is regenerated locally and is intentionally **git-ignored** — it is a
compilation of your own library, not something the repo distributes.

> 🎤 The song row's **icon** tells you the kind at a glance: **🎤** = MIDI, **🎵** = audio + lyrics,
> **🎞️** = video, **🌐** = YouTube.

### 5.6 Backgrounds → `data/bgv/` and `data/bgphoto/`

Behind the lyrics the stage can show your own looping videos, a photo slideshow, or the live
camera (⚙ → Display → Background, see [§6](#6-using-the-app--full-walkthrough)). Nothing shows
until you create the folders:

- **Videos** → `data/bgv/` — `.mp4`, `.webm` or `.m4v` (`.mov` is listed too, but `.mov` / HEVC
  clips may not play in Chrome; such a clip is skipped).
- **Photos** → `data/bgphoto/` — `.jpg` / `.jpeg`, `.png` or `.webp`.
- **One level of sub-folders = a category** (e.g. `data/bgv/beach/`, `data/bgv/city/`), picked
  under ⚙ → Display → Background → Category. Files directly in the folder show under **All**.
- No catalog rebuild is needed — the app lists the folders when it loads, so **reload the page**
  after adding files.

> 💡 For TV boxes and other small devices, use **720p** clips — decoding a large clip behind the
> lyrics is hard work for a small box.
>
> ⚠️ Like `videos/`, these folders are **readable by anyone who can reach the server** on your
> network (that is how the screens fetch them) — don't put private photos there.

---

## 6. Using the app — full walkthrough

### 🖥️ The stage
Every device — a laptop, a phone, a tablet, a TV — gets the same layout: **one full-screen stage**
with the lyrics, and everything else on top of it.
- **The bottom of the screen** holds the two-line **status line** at the left, the small **panel
  buttons** — in the **bottom-right corner** whenever the screen is wider than tall (a TV, a laptop,
  a phone on its side), just above the status line when it is held upright — and the **seek bar**
  along the very bottom edge (see *The status line* below). While a song plays it fades away after a few idle seconds and
  comes back on a tap, a mouse move or a key (Back excepted); it never hides while paused or idle
  (⚙ → Display → **Footer**).
- **Panels slide in from the right:** **Songs** (with the queue as its **Queue** tab), **Mixer**
  (MIDI songs, when the channel mixer is on) and **Settings** (⚙). One is open at a time; on a wide screen the lyrics move over and
  stay uncovered beside it, on a phone held upright the panel fills the screen. **Back** (Esc, the
  browser's Back button or a TV remote's Back) closes the top panel and never leaves the app.
- **The queue bar** (top of the stage) shows the song, artist, singer and key, then **NEXT** — the
  next song in the queue and who queued it — and **⏭ N** for the songs waiting (tap it to open the
  queue).
- **The home screen** appears whenever nothing is loaded: the **Ka-Rae-oke** logo, "Select a song",
  key hints while you use the keys and, while the phone remote is on, a big **QR + room code** for
  guests. Open Songs or Settings from the corner buttons. It never flashes between queued songs.
- **Size it for the room** with **⚙ → Display → Font size** (Extra small / Small / Medium /
  Large). **Extra small** is for a desk monitor with a mouse: its buttons are smaller than a
  fingertip on purpose. **On a touch screen every button is at least 44 px** at any font size — the
  app enlarges them as soon as you touch the screen. The stage sizes itself from the screen, so the browser's own zoom (Ctrl/⌘ + / −) barely
  changes it — use Font size instead. **Overscan** moves the stage in from the edges for a TV that
  crops the picture; **Theme** is Auto (follows your OS), Dark or Light.
- **Full screen** — the **Full screen** panel button, or **F**.

### Find & queue songs
Open **Songs** (the 🔍 panel button, **F1**, **S**, **/**, the Red key — or just type a
number).
- **Search** by number, title, artist or language. Results come in up to three groups, always in
  this order:
  1. **A number** (digits only) lists every song with exactly that number in **every songbook** —
     SH, then PLATKAR, TJMEDIA and MIDI (leading zeros don't matter: `00123` finds 123) — then the
     numbers that start with it.
  2. **Exact matches** — every word you typed found in the title, artist or language.
  3. **Close matches**, marked **≈** — words a typo or two away (`barcelna` → Barcelona). They are
     looked for only when the exact list is short and a word has 4+ letters, and always come after
     the exact ones (⚙ → Songs & search → Search → **Also show close matches (typos)**).
- Rows show the **title and artist** only — no song numbers on screen. Typing a number still finds
  the song.
- **Enter** in the search box takes the top row: by default it **reserves** it while a song is
  playing and **plays it at once** when the stage is idle (⚙ → Songs & search → Search → **Enter in
  search**: also *Always reserve* or *Always play now*).
- **Tabs — All · Artists · Rankings · Queue.** *Artists* lists every artist with a song count (Enter
  opens their songs, with **← Artists** on top to go back; typing filters the names). *Rankings* is
  the leaderboard (see Score below). *Queue* is described below.
- The list always shows **every song**, best match first — there are no category filters or sort
  menu. The tab resets to All when the page reloads.
- The **★ Favorites** and **⟲ Recent** pills toggle those lists; the **🌐** pill toggles **YouTube
  search** (on by default; it still only queries when your local results are thin).
- **Tap, click or press Enter on a song** to open its **action sheet**: **Reserve** (add to the
  queue), **Play next** (first in the queue), **Play now**, **★ Favorite**, **Cancel**. A
  double-click does *not* play — Play now is one tap in the sheet. The row's own **★** and **＋**
  still act directly.
- **The queue** is the last tab of Songs — **All · Artists · Rankings · Queue**, with the number of
  waiting songs on the tab. **Q**, the **Green** key or the queue count at the top of the stage open
  Songs straight on it (the count again closes it). It lists what's waiting, with the name of the
  guest who added it; with the remote on, a line on top shows the **room code** and the phones'
  connection. Tap a queued song for **Play now · Move to top · Move up · Move down · Remove**; **✕**
  removes it at once; **Clear all** empties the queue after asking. Typing in the search field
  switches back to **All**, and the 🔍 button opens Songs on All. The queue advances by itself
  between songs (MIDI, audio, video and YouTube alike).

### 🔢 Song numbers (number keys)
Song numbers are not shown on screen, but they still work for anyone dialing from a printed
songbook: press a **digit** anywhere on the stage — a keyboard's number row, the numpad or a TV
remote's number keys — and **Songs** opens with it in the search box, listing every songbook's song
with that number. Keep typing, then **Enter** takes the top row (as above) — or press **↓** to move
down to another row and **Enter** for its action sheet. The song keeps playing meanwhile. A panel
opened this way that still holds only a number closes by itself after **8 s** with no key or tap
(⚙ → Songs & search → Search → **Clear an untouched song number after**); a panel you opened yourself
never does. **Number keys open the song search** turns this off.

### 🎮 TV remote, D-pad & keyboard
Every screen works with **the arrows, OK (Enter) and Back** alone, so a TV remote or a game-pad
D-pad drives the whole app.
- **Arrows** move to the nearest control in that direction. With nothing focused, the first arrow
  lands on the **Songs** button (the first of the panel buttons).
- **OK** presses the focused control (on a song row: the action sheet).
- **Back** does one thing per press: clears a search box that has text, then closes the top panel
  or dialog, then takes focus off the bottom buttons. It never stops the song.
- **Colour keys:** **Red** = Songs · **Green** = Queue · **Yellow** = next background ·
  **Blue** = melody volume (next level). **Media keys** play, pause, stop, skip and restart; **Channel + / −**
  change the key. The OS media controls (headset buttons, the lock screen) work too.
- While you use the keys, short **key hints** appear at the bottom of the home screen and panels
  (⚙ → Display → **Show key hints**).

Full list in [§8](#8-keyboard-shortcuts).

### The status line, the corner buttons and the seek bar
There is no playback bar: play, pause, next and restart come from the keys (**Space**, **N**, **P**,
the media keys), a TV remote, or a phone.
- **The status line** (bottom-left, small caps) is two lines: the song — the song count while
  nothing plays (**No catalogue** if the song list failed to load), or **▶ Title — Artist** (❚❚ when
  paused) — and under it five values, each between
  a **−** and a **+**:
  - **VOL** 0–100 (steps of 5)
  - **KEY** the song's key (**F**, **Am**), **F → G** once transposed; **+2** for a song with no
    detected key
  - **TEMPO** 0.50×–1.50× (steps of 0.05)
  - **MELODY** Off / 25 / 50 / 75 / 100 — the guide melody's level
  - **OFFSET** the lyric offset in ms (steps of 10)
- **The panel buttons** — small icons in the bottom-right corner (just above the status line on a
  screen held upright): **Songs** (the queue is its **Queue** tab), **Mixer** (MIDI songs with the channel mixer on),
  **Next background** (only while a video or photo background shows), **Settings** and **Full
  screen** (hover or long-press for the name).
- **On a phone or a small tablet held upright** the bottom becomes a bar: the panel buttons share
  the width, and the five values stand side by side like a mixing desk — the name, **+** above, the
  value, **−** below. With touch, every button there is at least 44 px; on a landscape phone or a
  tablet each value sits with its name above it between its **−** and **+**, so all five fit on one line.
- **The seek bar** is the thin line on the bottom edge: press or drag along it to move in the song.

A change made from the keyboard or a TV remote flashes a short note on the stage ("Key +1", "Tempo
1.05×", "Melody 50%"), as do messages such as "Reserved: …". A note stays 2.5 s; an **error** — a
song that cannot play, a song list that failed to load — stays **6 s** and has a red edge.

### Lyrics
Two layouts, under ⚙ → Lyrics → Lyrics → **Style**:
- **Stage** (default) — the videoke layout: **two fixed rows** that take turns (the line being sung,
  and the one just sung until you reach the new line's second syllable, then a preview of the next),
  and a **4 · 3 · 2 · 1 · GO!** count-in before the first line and after any break longer than 8 s
  ("♪ Instrumental" shows during the break). In portrait it uses four rows. Rows, alignment,
  **position** (at the bottom, or **centered on the screen**), line animation and the count-in are
  under ⚙ → Lyrics → **Stage lyrics**. Centered rows sit at the screen's middle; on a short screen (a
  landscape phone with the pitch guide on) they move down as far as needed to fit.
- **Scroll** — a smooth-scrolling column that glides upward as lines finish; tune visible lines,
  line merging and width under ⚙ → Lyrics → **Scroll lyrics**. The lines around the one being sung
  are dimmed: lines already sung show at 60 % opacity, lines still to come at 75 %.

Both layouts draw the lyrics the same way. Every syllable is white with a black outline and a drop
shadow; as it is sung, a hard-edged wipe turns it to the **sung colour** with a white outline. Duet
lines (tagged `@m` / `@w` / `@c` or `M:` / `F:` / `D:` in the song file) use the singers' colours
for the sung part — blue, red and green — and **(backing vocals)** lose their brackets and fill
orange. The look is the same in the dark and the light theme and over a background video or photo.
Four settings under ⚙ → Lyrics → **Lyrics** set it for both layouts: **Sung colour** (default blue),
**Random colour** (a different colour for each song), **Outline** (0–12) and **Shadow**.

The active line is painted **syllable-by-syllable**. Nudge timing live with **`[`** / **`]`**
(∓10 ms), and size the lyrics alone with **Lyrics size**.

### 🎙️ Microphone & voice
⚙ → **Singing → Microphone & voice → Enable microphone** (your browser asks
permission). It needs a secure page — `http://localhost` / `127.0.0.1` count, so no HTTPS is needed
on the machine running the server; on a plain LAN address the button is disabled with the reason
(see [§9](#9-serving-to-phonestvs-on-your-network)). Once live, your voice mixes with the music:
- **Effects:** Echo, Reverb, Chorus, manual Pitch-shift.
- **Auto-tune:** bends your voice to a target — the song's **melody guide**, a **key/scale**,
  or **chromatic** — with adjustable **strength**.
- **Feedback & noise:** browser Echo-cancellation / Noise-suppression / Auto-gain, a
  High-pass filter, and a Noise gate. **The definitive anti-feedback fix is headphones.**
- **Mic latency** (default **100 ms**) — how late your voice reaches the scorer. Scoring and the
  pitch guide's mic trace are shifted by it; 0 = no compensation. **Calibrate…** measures it for
  your room: hold the microphone **20 cm from the speaker**, press Start, stay quiet for two
  seconds, and the app plays **8 clicks** and listens for them. It shows the result (and how many
  clicks it heard) — **Save** keeps it (tick *Also set the noise gate* to set the gate from the room
  noise it heard), **Retry** measures again. Opening it pauses the song; if it can't hear enough
  clicks it says "Could not measure" and **nothing is saved**. Not available in Bluetooth mode.

### 🎯 Pitch guide
⚙ → **Singing → Pitch guide → Show pitch guide** (on by default): a scrolling piano-roll of the
melody to sing (read from the MIDI's guide track). With the mic on it overlays your **live pitch**,
a fading **trail** of where you've been, and the running **score** number (each is a toggle there).

### 🏆 Score
With the **mic on**, MIDI songs are scored against their own guide melody — the same notes the
pitch guide draws, so nothing extra has to be authored per song.
- **Every note gets a verdict** as it ends — **PERFECT**, **EXCELLENT**, **GREAT**, **GOOD** or
  **MISS** — on a chip by the pitch guide (⚙ → Singing → Score → **Feedback while singing**: *Per
  note* (default), *Per line* — a chip per lyric line instead — *Both*, or *Off*). The chips show how
  each note went; the score itself is worked out the same way whatever you pick.
- **Difficulty** — **Easy**, **Normal** (default) or **Hard** decides how close counts as on pitch
  and how the score is curved. A change applies **from the next song**.
- **The score card** at the end shows the number, a verdict ("Good job!", "Excellent singing!"),
  the difficulty, how many notes got each verdict, who was singing, and your **personal best** for
  that song.
- **Rankings** — every scored song adds a row to **Songs → Rankings**: the singer (a guest's nickname, or the **Host singer name**, default "Host"), the
  song, the score, the difficulty and the date. Filter by player or difficulty; **Clear** empties it
  after asking. Turn it off with **Keep rankings**.

It's deliberately forgiving, because a scoring system that makes people feel bad is broken however
accurate it is:
- **Octave-invariant** — singing the right note an octave down is right, so nobody is punished for
  the song being in someone else's range.
- **Graded, not pass/fail** — on Normal, full credit within half a semitone, tapering off from there.
- **Silence is neutral** — you're allowed to breathe; only a note you *sing wrong* costs you.
- **Golden notes** — the longest notes count double.

Audio, video and YouTube songs carry no note data, so they aren't scored. ⚙ → **Singing → Score**
turns the whole thing (or just the card, or golden notes) off. Bests and rankings are kept in this
browser.

### 🎼 Guide vocal
The detected **melody channel** has five volume levels — **Off, 25%, 50%, 75%, 100%** — up to learn
a song, off to perform. **F2** (or **M**, or the Blue key) steps to the
next level; ⚙ → Singing → Score → *Guide vocal (melody)* → **Melody volume** picks one, and **Solo**
isolates the tune. The phone remote's **Melody − ＋** steps through the same five levels.

### 🔊 Sound (the music)
Under ⚙ → **Music**:
- **The drums stay put when you change key.** Key ± transposes a MIDI song's instruments but leaves
  the drum kit alone, so a key change no longer swaps its drum sounds. Want the old behaviour?
  **MIDI → Transpose drums with the key**.
- **Reverb** and **Chorus** — the MIDI songs' own effects, **Off · Low · Normal · High · Max**
  (*Normal* plays them as written).
- **Equalizer** — **Flat** (default), **Warm**, **Bright**, **Vocal**, **Bass boost**, **Small
  speakers**, **TV speakers**, or **Custom** (ten bands, 31 Hz – 16 kHz, ±12 dB). It shapes the
  music of MIDI, audio and video songs — not YouTube, and never the microphone.
- **Even out song loudness** (on by default) — each song's level is learned while it plays through
  to its end, and the next time it starts at the **Loudness target** (−24 dB by default), so a quiet
  song and a loud one sound alike. On a song's first play the level eases in as it goes; a skipped
  song isn't learned. Not YouTube.

### 🎸 Chords (guitar follow-along)
⚙ → **Music → Chords → Show chord lane** (off by default): a chord lane above the lyrics scrolls to anchor the
current chord, so guitarists can strum along. These KAR files carry no chord symbols — they're
**auto-detected from the notes** on load. The **Key ±** transpose **relabels the chords live**
(in sharps), and a **Simplify** toggle collapses jazzy 7ths/sus to the bare triad a strummer
plays (and fixes thirdless power chords to the key's triad). **MIDI-only** — hidden for video
and YouTube, which carry no note data.

### 🎛️ Channel mixer (MIDI)
⚙ → **Music → MIDI → Channel mixer** adds a **Mixer** button to the corner buttons for a MIDI song;
it opens a panel with **all 16 channels** (each labeled by instrument, ch 10 = Drums;
silent channels are dimmed) with a **volume slider, mute + solo, and a live VU meter** fed by
each channel's real audio level. Untouched channels keep the song's authored mix; turning the
mixer off — or loading a new song — hands the mix back. **MIDI-only**; per-channel positions
reset per song.

### 🖼️ Backgrounds
Put your own clips in `data/bgv/` and photos in `data/bgphoto/` ([§5.6](#56-backgrounds--databgv-and-databgphoto)),
then pick what shows behind the lyrics under ⚙ → **Display → Background**:
- **Background** — **Auto** (default: videos if there are any, else photos, else nothing — never
  the camera), **Off**, **Videos**, **Photos** or **Camera**. **Category** picks one sub-folder,
  or All.
- **Dim** (default 35%) darkens the background under the lyrics; **Next background on each song**
  (on) moves to the next clip or photo when a song starts. The **Yellow** key or the corner's **Next
  background** button (shown only while a video or photo background is up) changes it any time.
- **Photos** — **Each photo** (3–60 s, default 8 s) and **Photo animation** (None, Fade, Slide,
  Zoom; default Fade). With reduced motion on in your OS, photos simply cut.
- **Camera** — the live camera, **Which camera** (Back / Front) and **Mirror** (Auto mirrors the
  front camera only, or On / Off). It asks for permission only when you pick it, and nothing is
  recorded or sent. It needs a secure page (https or localhost) — elsewhere the option is disabled
  with the reason. If the page reloads with Camera chosen and permission not yet given, a **Tap to
  start camera** button appears (OK reaches it too).

The background shows behind MIDI and audio songs and on the home screen — never behind a video or
YouTube song, which have their own picture. Nothing changes until the folders exist. (An older
install may already have a `data/bgv/` folder — Auto will show it; choose **Off** to hide it.)

### 🎞️ Video karaoke
A video song plays **full-stage** (the MIDI-only surfaces and any background hide themselves). Play / pause,
seeking, the queue, tempo, volume, and the mic all work. Because a karaoke video has its lyrics
**baked into the picture**, the **lyric offset shifts the video's audio** (not the picture)
so you can line the sound up to the on-screen words. The **Key ±** control now **transposes the
video's audio in real time** (in stereo), and the **volume can go past 100%**. *(Transposing adds
~30–40 ms of audio latency — nudge the lyric offset if you need perfect lip-sync; at Key 0 there's
no added latency.)*

### 🌐 YouTube karaoke (BYOC)
**On by default**, but the app stays offline-first in practice — it queries YouTube **only when your
local library comes up short**. Toggle it with the **🌐** pill in the Songs search row (or ⚙ →
**Songs & search → YouTube search**). Such a search appends a "karaoke" keyword to the query, and the hits append to
the list marked **🌐**. Selecting one plays the **official YouTube embed** full-stage, with working
play / pause / seek / queue / tempo / volume and the mic; YouTube songs are favoritable and show
up in Recent. Nothing is downloaded — it stores only a `youtube:<videoId>` pointer.
**Chromium-only** (it needs a `credentialless` iframe; the pill is dimmed elsewhere) and it
**needs a network**. Tune the threshold / debounce / max-results / keyword in the same ⚙ section.

### 📱 Remote control (phones)
A **QR code + room code** sit under **⚙ → Phones & party → Remote** and on the home screen (the remote is **on by
default**; turn it off under **⚙ → Phones & party → Remote** for an untrusted network, and choose with **QR
on the stage** whether the stage shows it *When idle* (default), *Always* — during songs too, as a
small code beside the pitch guide at exactly the guide's height (top-right, under the song title, when
the guide is off or hidden) — or *Never*). Guests scan the QR with their phones (same network) to open **`/remote`**.
Scanning auto-connects; anyone typing the URL by hand enters the **room code** shown on screen.
The first time a phone joins a room it asks **"What name should we use?"** (prefilled with the last
name it used); the name goes on the songs it reserves and on the TV's messages.

The phone downloads only a **compact copy of the songbook** (a couple of megabytes even for a very
large library) and gets **instant updates**: a tap reaches the TV in a fraction of a second over a
live event stream. If something on the network holds that stream back, the phone falls back to
checking once a second by itself and tries the stream again a minute later. The Songs panel's Queue
tab (with the room code) and ⚙ → Phones & party → Remote show the state (**Phones: instant / connecting… / polling**), and so does the phone's **You** tab. Five tabs:
- **Now** — the current song with play/pause and next, its progress (a bar to watch — guests don't
  seek), and **− value ＋** steppers like the TV's status line: **Volume** in steps of 10 %, **Key**
  with the song's key beside it (*D maj → E maj* when transposed; video / YouTube / audio songs show
  just the number), **Tempo**, and **🎵 Melody** Off · 25 · 50 · 75 · 100 %. Every change shows as a
  message on the phone **and on the TV, with the guest's name** ("Kai: Volume 80%"). Plus the live
  score and reactions (👏 🎉 🔥 ❤️ 😂 🙌).
- **🎤 Lyrics** — the current song's lyrics **on your own phone**, in time with the room, in the
  same **Stage** layout as the TV (or **Scroll** — pick it on the You tab). Both draw the TV's look —
  white outlined text, the wipe to the sung colour, singer colours and orange backing vocals — in the
  phone's own default colour (the TV's Sung colour setting does not reach the phone). Handy when you're away from
  the TV, or reading ahead. Works for MIDI and audio+lyrics songs; video / YouTube songs have their
  lyrics baked into the picture, so the tab says so. If your phone reads a touch early or late, nudge
  it with the **Sync nudge** slider at the bottom — it only moves *your* screen (the **You** tab's
  lyric offset moves everyone's).
- **Search** — with the field empty, **every song**, in the same order as the TV's Songs panel
  (scroll the whole songbook); type for the TV's own search: numbers across every songbook, exact
  matches, then **≈** close matches; plus optional 🌐 YouTube. **Tap a song** for **Reserve**, **Play next** and **Play now** —
  the last two only when the host allows them (see below). Typing a number finds that song number.
- **Queue** — the live queue with an "added by" name and a rough **"~7 min"** wait for each song,
  plus move up / down, remove, and **⤒ Play next** (when the host allows jumping the queue).
- **You** — your nickname (shown on songs you add), the lyric offset, device theme & text size,
  **how the lyrics look on your phone** (lyric style, lyric lines 2–8 for Scroll, lyrics size
  70–180% — yours alone; the karaoke screen keeps its own layout), and the connection status + room code.

**What guests may do** — ⚙ → Phones & party → Remote:

| Setting | Default | |
|---|---|---|
| **Instant updates** | on | the live event stream; off = phones check once a second |
| **Guests can play a song now** | **off** | a guest's *Play now* stops whoever is singing, so it waits for the host's say-so |
| **Guests can jump the queue** | on | a guest's *Play next* puts their song first; refused while **Fair play** is on, and counted against the per-guest cap |

A request the host doesn't allow is refused, and the phone says so ("not allowed by the host").

The host stays the real player — phones send requests that the host applies, so the whole room can
build the queue together. When a song was queued from a phone, the host shows **who's singing** above
the melody guide and on the title card, and the queue bar always shows who sings **next**.

The **room code** is generated once per host browser and kept there (stable across restarts). Each
host has its own code, so several karaoke stations can share one server. ⚠️ The code is a **friction
gate for a trusted network, not real security** — anyone on your LAN who has the code can control
playback (see [§9](#9-serving-to-phonestvs-on-your-network)).

Pull-to-refresh is disabled so an accidental swipe can't reload the page mid-song. Where the browser
allows it, the phone also keeps its **screen awake** while it's connected (browsers offer that to
secure pages only, so over a plain `http://` LAN address the phone may still go to sleep).

**Second screen:** open `/remote?room=CODE&kiosk=1` on a spare tablet and it becomes a dedicated
lyric monitor — the stage lyrics alone, no header or tabs.

### 🎉 Party features
- **Fair play** (⚙ → Phones & party → Queue) — each *new* request joins the back of its singer's own round, so
  everyone sings once before anyone sings twice. Songs already waiting never move: people watch
  that list, and a song sliding backwards reads as a cheat. Off by default — plain FIFO is what
  people expect until they ask for fair. (The host's own **Play next** is an explicit jump and
  skips the rounds.)
- **Reservation cap** (⚙ → Phones & party → Queue) — the polite version of "don't hog the mic": how many
  songs one phone may have waiting. Off (`0`) = unlimited. A guest over the cap is told why, not
  silently ignored.
- **Reactions** (⚙ → Phones & party → Reactions) — a guest taps 👏 🎉 🔥 ❤️ 😂 🙌 on their phone and it floats up
  the karaoke screen; 👏 also fires a burst of applause (synthesized — the app ships no audio
  files). Only those six can ever appear, since this is a stranger's phone drawing on your TV.

### 💾 Backup & reset
Your queue, recents, favorites, settings, scores, rankings, each song's learned loudness and
saved-YouTube pointers live **only in this browser**. ⚙ → **Application → Backup** (at the bottom of
the panel) exports all of it to one JSON file and imports it back (handy when moving machines, or
before clearing site data). **Reset to defaults** asks first ("Reset every setting to its default?
Custom shortcuts, the microphone latency and the EQ are reset too." — Cancel has the focus, and Back
cancels), then restores the default settings but keeps your library data; **Erase all app data**
(red, two-click) wipes everything including the cached soundfont and starts fresh. That one is
irreversible. Typing **reset** or **erase** in the settings search finds both buttons and the
lyric-offset reset.

### 🎬 Title card, Bluetooth mode
- **Title card** — when a song starts, its title and artist (then who queued it and the key) show
  in the middle of the stage, and **the lyrics stay hidden until the card goes**: after the card's
  time (⚙ → Lyrics → Lyrics → **Title card**, 0–10 s; 0 = off) or as soon as the lyrics reach their
  first count-in, whichever comes first.
- **Bluetooth mode** (⚙ → Lyrics → Timing) — BT speakers lag ~260 ms, so this delays the visuals
  to match and disables the mic (and calibration); the offset stays adjustable.

---

## 7. Settings reference (⚙)

All settings live in the **⚙ panel** and persist in `localStorage`. Their **defaults** come
from **`src/config.js`** — edit that file to change built-in defaults, then click **Reset to
defaults** in the panel to adopt them.

Settings is a panel on the right (the ⚙ panel button), organized into **collapsible
categories** (🎬 Display · 🎤 Lyrics · 🎵 Music · 🎙️ Singing · 🔎 Songs & search · 📱 Phones & party ·
⌨️ Keyboard shortcuts · ⚙️ Application) with a
**search box** at the top — start typing to filter every control across all categories at once (it
matches labels, section names, and synonyms like "latency" → Offset or "transpose" → Key; "reset"
and "erase" find Reset to defaults, Erase all app data and Reset offset). `Esc` or ✕ clears it. Volume, Tempo, Key, Melody and Offset are also on the status line (and remembered).

Defaults are in *italics*.

| Category → section | Controls |
|---|---|
| 🎬 **Display → Screen** | Theme (*Auto* / Dark / Light) · Font size (Extra small / Small / *Medium* / Large) · Overscan (*0* – 5%) · Show key hints (*on*) |
| 🎬 **Display → Footer** | Auto-hide while a song plays (*on*) · Hide after (1 – 15 s, *3 s*) |
| 🎬 **Display → Background** | Background (*Auto* / Off / Videos / Photos / Camera) · Category (*All* + your sub-folders) · Dim (0 – 80%, *35%*) · Next background on each song (*on*) · Each photo (3 – 60 s, *8 s*) · Photo animation (None / *Fade* / Slide / Zoom) · Which camera (*Back* / Front) · Mirror (*Auto — front camera* / On / Off) |
| 🎤 **Lyrics → Lyrics** | Style (*Stage* / Scroll) · Smooth wipe (*on*) · Lyrics size (0.6 – 1.8×) · Title card (0 – 10 s, *5 s*) · Sung colour (*blue*) · Random colour (*off*) · Outline (0 – 12, *6*) · Shadow (*on*) — the last four style both lyric styles |
| 🎤 **Lyrics → Stage lyrics** | Rows (*Auto — 4 in portrait* / 2 / 4) · Alignment (*Center* / Left-Right Split / Close Split) · Position (Bottom / *Centered on screen*) · Line animation (*None* / Fade / Wipe / Crossfade / Flip / Pop bounce) · Count-in (*on*) · "Instrumental" during breaks (*on*) |
| 🎤 **Lyrics → Scroll lyrics** | Visible lines (2 – 8, *5*) · Merge lines (1 – 4, *2*) · Line width (50 – 100%, *90%*) |
| 🎤 **Lyrics → Timing** | Offset (±2000 ms, *0*) + Reset offset · Bluetooth mode (*off*) |
| 🎵 **Music → Sound** | Reverb and Chorus (Off / Low / *Normal* / High / Max) · Equalizer (*Flat* / Warm / Bright / Vocal / Bass boost / Small speakers / TV speakers / Custom — ten bands, ±12 dB) · Even out song loudness (*on*) · Loudness target (−30 – −12 dB, *−24 dB*) |
| 🎵 **Music → Melody guide** | Melody volume (Off / 25% / 50% / 75% / *100%*) · Solo melody (*off*) |
| 🎵 **Music → MIDI** | Channel mixer (*off*) · Transpose drums with the key (*off* — the old behaviour when on) |
| 🎵 **Music → Key detection** | Auto-detect key (*on*) · Show key by title (*on*) |
| 🎵 **Music → Chords** | Show chord lane (*off*) · Simplify (*off*) |
| 🎙️ **Singing → Microphone & voice** | Enable microphone · Mic volume (0 – 150%, *90%*) · Echo cancellation (*on*) · Noise suppression (*on*) · Auto gain (*off*) · High-pass (*on*) · Noise gate (*on*) · Gate threshold (−70 – −20 dB, *−50 dB*) · Mic latency (0 – 500 ms, *100 ms*) + **Calibrate…** · Echo / Reverb / Chorus (*off*) with their mix · Pitch shift (*off*, ±12 st) · Auto-tune (*off*) · Strength (*100%*) · Snap to (*Melody guide* / Key / scale / Chromatic) · Key (*Auto (detected)* / C … B) · Scale (*Major* / Minor / Pentatonic / Chromatic) |
| 🎙️ **Singing → Pitch guide** | Show pitch guide (*on*) · Look-ahead (2 – 10 s, *5 s*) · Band height · Melody channel (*auto* or 1 – 16) · Overlay my pitch (*on*) · Soft pitch trail (*on*) · Live score on the guide (*on*) |
| 🎙️ **Singing → Score** | Score my singing (*on*) · Score card when a song ends (*on*) · Golden notes count double (*on*) · Feedback while singing (*Per note* / Per line / Both / Off) · Difficulty (Easy / *Normal* / Hard, from the next song) · Keep rankings (*on*) · Host singer name (*Host*) |
| 🔎 **Songs & search → Search** | Also show close matches (typos) (*on*) · Enter in search (*reserve while singing, play when idle* / Always reserve / Always play now) · Number keys open the song search (*on*) · Clear an untouched song number after (3 – 30 s, *8 s*) |
| 🔎 **Songs & search → YouTube search** | Enabled (*on*; also the 🌐 pill) · Query YouTube when local has (fewer than 1 – 10 hits, or always; *< 2*) · Debounce (0.5 – 10 s, *3 s*) · Max results (5 – 40, *20*) · Append keyword (*karaoke*) |
| 📱 **Phones & party → Remote** | Enabled (*on*; the phone QR, room code, URL and connection show under it) · QR on the stage (*When idle* / Always / Never) · URL override (*blank = auto-detect*) · Instant updates (*on*) · Guests can play a song now (***off***) · Guests can jump the queue (*on*) |
| 📱 **Phones & party → Queue** | Fair play (*off*) · Max reservations per guest (*off*, 1 – 6) |
| 📱 **Phones & party → Reactions** | Let phones send reactions (*on*) · Play applause (*on*) |
| ⌨️ **Keyboard shortcuts** | Every rebindable action with its keys — select a key to change it, ＋ to add one, Reset shortcuts (see [§8](#8-keyboard-shortcuts)) |
| ⚙️ **Application** | Library: the live song count · ↻ Rebuild Catalog · Backup: ⭳ Export app data / ⭱ Import app data… (every setting and library list as one JSON file) · Reset to defaults (asks first; also resets custom shortcuts, the mic latency and the EQ) · Erase all app data |

---

## 8. Keyboard shortcuts

Everything below works the same from a keyboard, a TV remote or a D-pad. Letter and symbol
shortcuts are ignored while you type in a text field, and a key held with Ctrl / ⌘ / Alt is always
left to the browser.

**Moving around**

| Key | Action |
|---|---|
| **← ↑ → ↓** | Move to the nearest control in that direction (with nothing focused, the first arrow lands on the Songs panel button). On a slider, ← / → change it |
| **Enter** / **OK** | Press the focused control — on a song row, open its action sheet |
| **Esc** / **Backspace** / **Back** | Back, one step per press: clear a search box that has text → close the top panel or dialog → leave the bottom buttons. Never stops the song |

**Playback & the stage**

| Key | Action |
|---|---|
| **Space** or **K** | Play / pause |
| **N** | Next song |
| **P** | Restart the song |
| **F4** / **F3** (or **+** / **-**) | Key up / down a semitone |
| **F6** / **F5** (or **.** / **,**) | Tempo up / down (0.05×) |
| **`]`** / **`[`** | Nudge the lyric offset +/− 10 ms |
| **F2** or **M** | Melody guide volume: Off → 25% → 50% → 75% → 100% → Off |
| **F8** | Pitch guide band on / off |
| **F1** | Songs open / close |
| **S** or **/** | Open Songs (focus its search box if it's already open) |
| **Q** | Open the queue (the Songs panel's Queue tab) |
| **F** | Full screen |
| **0 – 9** | Open Songs with that number in the search (see [§6](#6-using-the-app--full-walkthrough)) |

**Change any of these** in ⚙ → **Keyboard shortcuts**: select a key to change it (or ＋ to add one)
and press the new key; a key another action already uses offers **Swap** (or **Move**). Arrows,
Enter, Back and 0–9 are fixed. **Reset shortcuts** restores this table. Volume and melody up / down
have no key by default but can be given one. On a Mac, F1–F12 may be the system's brightness /
media keys unless you hold **fn** (or turn on "Use F1, F2, etc. keys as standard function keys").

**TV remote & media keys**

| Key | Action |
|---|---|
| **Red** | Open Songs |
| **Green** | Open the queue |
| **Yellow** | Next background (while a video or photo background shows) |
| **Blue** | Melody guide volume (next level) |
| **Play** / **Pause** / **Play-Pause** | Play · pause · toggle (separate Play and Pause buttons never toggle the wrong way) |
| **Stop** | Stop the song and show the home screen; the queue is kept |
| **Next track** / **Previous track** | Next song / restart the song |
| **Channel + / −** | Key up / down |
| **Back** | Back (as above) |

Your OS's media controls (headset buttons, the lock screen, a keyboard's media keys) map to the same
play, pause, next, previous and stop.

**In the Songs search box**

| Key | Action |
|---|---|
| **Enter** | Take the top row — reserve it while a song plays, play it when idle (⚙ → Songs & search → Search → **Enter in search**) |
| **↓** | Into the list |
| **↑** | Up to the controls above |
| **← / →** at the end of the text | On to the buttons beside the box |
| **Esc** / **Back** | Clear the box; press again to close Songs |

**In a song list** (Songs, and the queue's list):

| Key | Action |
|---|---|
| **↑ / ↓** | Move through songs (past the first or last row, focus moves on to what's above or below) |
| **PageUp / PageDown** | Move ten rows |
| **Home / End** | First / last song |
| **Enter** | Open the song's action sheet (Reserve · Play next · Play now · ★ Favorite; on a queued song: Play now · Move to top / up / down · Remove) |
| **Space** | Select the song (Songs list) |
| **+** | Add it to the queue (Songs list) |
| any other letter or digit | Jump to the search box and type it (Songs list) |

---

## 9. Serving to phones/TVs on your network

Use the LAN launchers (they bind to `0.0.0.0` and print the URL other devices should open):

```bash
tools/serve-lan.sh          # macOS / Linux / Git-Bash
# or directly (any OS, incl. Windows):
python tools/serve.py --host 0.0.0.0
```

Open the printed `http://<your-LAN-IP>:52723/` on any device on the same Wi-Fi. On Windows, allow
Python through the firewall on **Private** networks.

### 🔒 Secure pages: what a TV box (or any other screen) can and can't do

Browsers give the **MIDI synthesizer** (it runs on an AudioWorklet), the **microphone** and the
**camera** only to a *secure* page: `http://localhost` / `http://127.0.0.1` (the machine running the
server), or HTTPS. So:

- **On the machine running the server** (`http://localhost:52723/`) — everything works.
- **On a TV box, a second laptop or a tablet that opens `http://<your-LAN-IP>:52723/`** —
  **MIDI / KAR songs do not play** (the synthesizer cannot start: picking one shows "MIDI songs need
  a secure page — open the app on localhost or https" and the song is skipped), there is **no
  microphone**, so **no singing through the app, no scoring and no calibration**, and **no camera
  background**. The mic and camera options stay visible but **disabled, with the reason** beside
  them. **Audio + lyrics songs** (without key shift) and **video songs** still play; browsing and
  searching the songbook, the queue, the panels and the D-pad, video and photo backgrounds and the
  phone remote work as usual.
- **Phones** using the remote (`/remote`) need none of these features, so the plain LAN address is
  fine for them.

**The recommended setup for a TV box: open the cloudflared HTTPS address on the TV.** `serve.py`
itself speaks plain HTTP (it has no HTTPS option), so put a tunnel in front of it — for example
`cloudflared tunnel --url http://localhost:52723` (a quick `https://….trycloudflare.com` address) or a
named tunnel on your own domain — and open that **https://** address in the TV box's browser. It is a
secure page, so MIDI songs play and the microphone, scoring, calibration and the camera can be used
(if the TV box has a mic or camera). Things to know:
- The TV now loads everything **through the internet and back** — the box needs internet, and the
  first MIDI song downloads the ~31 MB SoundFont once (it is then cached on the box).
- Phones follow the QR, which now shows the **https** address too, so they also go through the
  tunnel. To keep phones on your LAN instead, set **⚙ → Phones & party → Remote → URL override** to
  `http://<your-LAN-IP>:52723`.
- Anyone with the public address and the room code can reach the remote — see the warning in the
  phone-remote section below.

The other way to get everything on a big screen: run the server on the machine plugged into the TV
and open `localhost` there (that's what the Steam Deck setup below does).

### 🎮 Steam Deck (portable, no-install)

Run the whole thing from a **USB stick / SD card** — nothing is installed on the Deck (SteamOS
already ships Python 3, and the synth engine is vendored). Great as a party rig: the Deck drives the
TV and hosts a Wi-Fi hotspot; guests connect and control it from their phones.

1. **Bake a portable copy** (on a machine with internet): run `python tools/serve.py` once so `data/`
   holds `soundfont.sf2` + the catalogs + your songs, then copy the whole project folder to the
   drive. Format the drive **ext4** (preserves the executable bit); on exFAT/FAT, launch with
   `bash tools/serve-lan.sh` instead of `./`.
2. **On the Deck** (Desktop Mode): start a Wi-Fi **hotspot** yourself (KDE network menu), plug into
   the TV, then run:
   ```bash
   ./tools/serve-lan.sh
   ```
   On SteamOS this auto-enters **kiosk mode**: it serves **offline** (`--no-setup`) and opens the
   Deck's browser **fullscreen** at `http://localhost:52723/`. It uses a **browser you already have**
   (Flatpak Chromium / Chrome / Brave / Firefox — nothing is installed); force one with
   `KARAEOKE_BROWSER=org.mozilla.firefox ./tools/serve-lan.sh`.
   **To quit with just the controller:** the footer's **Exit** button (⏻, bottom-right, after Full screen —
   reach it with the D-pad or tap it) asks *"Exit Ka-Rae-oke?"*; **Exit** stops the server and the script
   closes the browser. `Ctrl+C` in the terminal does the same. The button only appears on the Deck's own
   screen — never on guests' phones, a TV box or through a tunnel.
3. **Guests** join the Deck's hotspot and open the printed `http://<deck-ip>:52723/` (typically
   `http://10.42.0.1:52723/`), or scan the phone-remote QR — see below.

> The Deck's **own** browser opens `localhost`, so the host mic, scoring and the camera background
> still work there; guests just queue/control from their phones. Force kiosk mode on any Linux box
> with `./tools/serve-lan.sh --kiosk`.

### 📱 Phone remote control

Once you're serving on the LAN, the remote is already on (**⚙ → Phones & party → Remote**). A **QR code + a
room code** appear under ⚙ → Phones & party → Remote and on the home screen (the Queue tab shows the room code) — guests scan the QR to open
**`http://<your-LAN-IP>:52723/remote`** (it auto-connects), or type that URL and enter the **room
code** shown on screen. Then they can search / reserve / control from their phones (any modern
mobile browser; see the walkthrough in [§6](#6-using-the-app--full-walkthrough)). The URL is
**auto-detected** (the host's LAN IP, or the public origin behind a tunnel like cloudflared); set a
manual **URL override** in ⚙ if needed.

> 💡 Phones update **instantly** over a live event stream. A proxy or tunnel that buffers that
> stream is detected — the phones fall back to checking once a second by themselves (the Queue tab
> then reads *Phones: polling*) and keep working. To skip the stream altogether, turn off
> **Instant updates**.

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
├── package.json              ← npm test: the Node suite + the Python suite (§11)
├── tools/                    ← all ops scripts (run from the project root)
│   ├── serve.py              ← the local server + first-run setup   ← START HERE
│   ├── serve-lan.sh          ← LAN launcher (+ Steam Deck kiosk mode)
│   ├── build-catalog.py      ← (re)build catalog.json from data/kar_raw/
│   ├── build-video-catalog.py← (re)build catalog-video.json from data/videos/
│   ├── build-audio-catalog.py← (re)build catalog-audio.json from data/audio_lyrics/
│   └── catalog_common.py     ← the filename grammar (incl. the songbook tag) the three builders share
│
├── test/                     ← *.test.js (Node: node --test) + test_*.py (Python: unittest)
├── .github/workflows/test.yml← CI: both suites + a syntax check
│
├── data/                     ← ALL your content — the mounted volume in Docker
│   ├── catalog.json          ← MIDI song library (rebuilt locally)        [git-ignored]
│   ├── catalog-video.json    ← video song library (rebuilt locally)      [git-ignored]
│   ├── catalog-audio.json    ← audio+lyrics song library (rebuilt locally) [git-ignored]
│   ├── kar_raw/              ← MIDI/KAR song files (compressed MIDI)   [git-ignored]
│   ├── videos/               ← video-karaoke files                     [git-ignored]
│   ├── audio_lyrics/         ← audio files + matching lyric sidecars    [git-ignored]
│   ├── bgv/                  ← background videos (you create it; sub-folders = categories)
│   ├── bgphoto/              ← background photos (you create it; sub-folders = categories)
│   ├── playcounts.json       ← how often each song was played (written by the server) [git-ignored]
│   └── soundfont.sf2         ← General MIDI SoundFont (~31 MB, auto-fetched) [git-ignored]
│
├── Dockerfile · .dockerignore · docker-compose.yml   ← containerized run (§4)
│
└── src/                      ← the app — served at the site root /
    ├── index.html            ← the stage + its panels, sheet and dialogs + the settings panel + import map
    ├── remote.html           ← phone remote-control page (served at /remote)
    ├── config.js             ← DEFAULT_CONFIG (editable defaults)
    ├── css/                  ← tokens (palette, both themes) · style · stage · overlays · sheet ·
    │                            browse · scoring · backgrounds · title-card · shortcuts ·
    │                            remote (the phone page)
    ├── sw.js                 ← self-destruct stub (the caching SW was removed; unregisters old workers)
    ├── js/                   ← app modules. app.js orchestrates; the rest own one thing each:
    │                            playback (audio · audiofile · video · youtube · media-engine · pitch-chain),
    │                            sound (music-fx · loudness · midi-mixer),
    │                            lyrics (lyrics · lyrics-formats · lyrics-stage · lyric-pager · lyrics-doc · chords),
    │                            singing (mic · melody · pitch-yin · scoring · verdicts · latency-cal ·
    │                              score-presentation),
    │                            library & search (catalog · compact-catalog · search-core · search-client ·
    │                              library-ui · library-view · library-browse · rankings · duration-hints),
    │                            the night (queue · queue-order · session · reactions · backgrounds ·
    │                              play-counts),
    │                            remote (remote-host · remote-glue · remote-push · remote [phone] · sync-clock),
    │                            settings & storage (settings · settings-ui · store · asset-cache)
    │   ├── ui/               ← the stage-first shell and the keys: overlay-stack · overlays-dom · shell ·
    │   │                        title-card · song-sheet · browse-ui · calibrate-ui · shortcuts-ui ·
    │   │                        keymap · actions · spatial-nav · nav-dom · input-mode
    │   ├── workers/          ← pitch-worker (pitch detection) · search-worker (the typo index)
    │   └── worklets/         ← mic-dsp (noise gate + pitch shift) · capture (calibration's raw mic)
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
| **Search is empty / song missing** | Rebuild the catalog (⚙ → Application → Library → ↻ Rebuild Catalog, or `python tools/build-catalog.py`). |
| **The status line says "No catalogue"** | The song list failed to load (the error note says so for 6 s). Start the app with `python tools/serve.py` from the project root, check `data/catalog.json` exists (rebuild it as above), and reload. |
| **A number search doesn't list songbooks in order / songs titled "SH" or "PLATKAR"** | The catalog predates songbooks — rebuild it once (as above). |
| **A double-click doesn't play the song any more** | By design: a click or tap opens the song's action sheet, and **Play now** is one tap there. |
| **Browser zoom doesn't make the stage bigger** | The stage sizes itself from the screen. Use ⚙ → Display → **Font size** (and **Lyrics size** for the lyrics alone). |
| **The TV cuts off the edges** | ⚙ → Display → **Overscan** moves the stage in from the edges. |
| **Video won't seek / stops** | Seeking needs HTTP Range (206) — always serve via `tools/serve.py`, not another static server. |
| **Mic won't enable / Calibrate… or the Camera option is greyed out** | They need a click (browser gesture) + a secure page. Use `http://localhost` / `127.0.0.1` on the server machine, or HTTPS — not a plain LAN IP ([§9](#9-serving-to-phonestvs-on-your-network)). Grant the browser permission when prompted. Calibrate… is also off in Bluetooth mode. |
| **Calibrate says "Could not measure"** | Nothing was saved. Turn the volume up, hold the mic about 20 cm from the speaker, keep the room quiet, and Retry. |
| **Feedback/howling on speakers** | Use **headphones**. Otherwise keep Echo-cancellation + Noise-gate on and lower mic volume. |
| **No background shows** | Create `data/bgv/` or `data/bgphoto/` with supported files and **reload the page**; check ⚙ → Display → Background isn't **Off**. Backgrounds never show behind a video or YouTube song. A `.mov` / HEVC clip may not play in Chrome — re-encode it to `.mp4` (H.264) or `.webm`. |
| **Port 52723 in use** | `python tools/serve.py --port 9000`. |
| **Phone remote won't connect** | Check ⚙ → Phones & party → Remote is on, serve on the LAN (`--host 0.0.0.0`), and put the phone on the same Wi-Fi. If the QR URL shows `127.0.0.1`, set the ⚙ URL override to your LAN IP. Keep the host tab in the **foreground** (a backgrounded tab throttles the sync and the phone shows "waiting for host"). |
| **Phones show "polling" instead of "instant"** | Something between them and the server (a proxy or tunnel) is holding back the live stream. The remote still works, just with up to a second's delay; it tries the stream again after a minute. |
| **A guest's Play now / Play next is missing or "not allowed by the host"** | ⚙ → Phones & party → Remote: **Guests can play a song now** is off by default; **Guests can jump the queue** is refused while **Fair play** is on. |
| **QR code doesn't render** | The QR needs `src/vendor/qrcode.min.js` — re-run `python tools/serve.py` once to fetch it. The URL text is always shown even without the image. |
| **First-run downloads fail** | You need internet on the first run only. Re-run, or manually place a General MIDI `.sf2` at `data/soundfont.sf2`. |
| **Run the tests** | `npm test` runs both suites — `npm run test:js` (Node, `test/*.test.js`) and `npm run test:py` (Python 3, `test/test_*.py`: the catalog grammar + server). Needs Node.js for the JS half. |

---

## 12. How it works

```
catalog.json + catalog-video.json + catalog-audio.json ──► one merged list
        │                                                   └─► search: number → exact → ≈ close (a worker)
   pick a song ──► dispatch on kind
        │
   ── MIDI ──►  fetch /kar_raw/<file> ──► inflate (pako) ──► SpessaSynth synth ─────┐
        │                                                    └─► lyrics parsed from the same bytes
   ── AUDIO ─►  fetch /audio_lyrics/<file> + its lyric sidecar ──► key shift ───────┤
        │                                                                           ├─► EQ ─► loudness ─► limiter ─► speakers
   ── VIDEO ─►  fetch /videos/<file> (HTTP Range 206) ──► <video> picture           │
        │                                           └──► offset-shifted sound ──────┘
   ── YOUTUBE ► official YouTube IFrame embed in a credentialless iframe (Chromium; online)
        │
   requestAnimationFrame loop: lyric sync · pitch guide · scoring + verdicts · auto-tune · seek bar · queue advance

   background layer (behind the lyrics): /bgv/ clips · /bgphoto/ slideshow · the camera
   the microphone ──► voice effects ──► speakers  (never through the music EQ / loudness)
```

Local **MIDI/audio/video** playback is **same-origin and works offline** after setup; the optional
**YouTube search** is the one online, cross-origin feature. The server (`tools/serve.py`) sends
the cross-origin-isolation headers the synth needs, serves HTTP Range requests so video seeking
works, and exposes a few endpoints — `POST /api/rebuild-catalog` (⚙ rebuild button),
`/api/youtube-search` + `/api/youtube-block` (the keyless YouTube search), `/api/backgrounds` (the
`bgv/` + `bgphoto/` listing), `/api/catalog/compact` (the phones' compact songbook),
`POST /api/played` + `GET /api/playcounts` (how many times each song was played — a song counts once
after 30 s of playback or at its natural end; kept in `data/playcounts.json`, not shown yet) and the
**phone-remote relay** (`/api/remote/*`): an in-memory, ephemeral channel where the host posts its
state, publishes each song's lyrics for the phones, and receives the commands guests send from
`/remote` — pushed live over a server-sent event stream (`/api/remote/events`), with polling as the
fallback. The host stays the authoritative player. For deeper detail, the module reference and
gotchas are documented inline in the `src/js/` source.

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
