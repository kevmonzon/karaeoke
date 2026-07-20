/*
 * config.js — DEFAULT settings for the offline Ka-Rae-oke player.
 *
 * Edit these values to change the built-in defaults. At runtime the app merges
 * your saved settings (localStorage) OVER these defaults, so:
 *   - a fresh browser (or after "Reset to defaults") uses exactly what's here;
 *   - any option you never touched in the UI keeps following this file.
 * To make an edit here take effect for settings you've already changed in the
 * UI, open the ⚙ panel and click "Reset to defaults".
 */

export const DEFAULT_CONFIG = {
  // Where the app fetches its content from. These are URL PATHS that tools/serve.py maps
  // to its DATA_DIR (the mounted data/ volume) — see the routing in serve.py. They are
  // config-file defaults only (there's no ⚙ panel control): change them only if you serve
  // the app under a different path layout (e.g. behind a reverse proxy on a sub-path). Keep
  // them absolute ("/…") so they resolve from the site root, not the current page.
  data: {
    catalogUrl:      "/catalog.json",       // MIDI/KAR song catalog
    videoCatalogUrl: "/catalog-video.json", // video-karaoke catalog (optional; may be absent)
    soundfontUrl:    "/soundfont.sf2",      // General MIDI SoundFont (~31 MB)
    bgvDir:          "/bgv/",               // background-video clips folder (bare names resolve here)
    bgvManifestUrl:  "/manifest.json",      // background-video clip list (written by serve.py)
  },

  lyrics: {
    // Timing offset in milliseconds. Positive = lyrics appear EARLIER (lead the
    // music); negative = later. Use the ⚙ panel or the [ and ] keys to nudge.
    offsetMs: 0,

    // Smooth karaoke "wipe": each syllable fills left-to-right in real time.
    // false = simple hard highlight (whole syllable flips colour at its cue).
    smooth: true,

    // How many lyric lines are visible in the scrolling viewport.
    lineCount: 4,

    // Concatenate N consecutive source lines into one display line (1–4).
    // Higher = longer lines and fewer, less-distracting line changes.
    mergeLines: 2,

    // Width of the lyric block as a percentage of the stage (50–100).
    lineWidthPct: 90,

    // Multiplier on the lyric font size (0.6–1.8).
    fontScale: 1.0,
  },

  bgv: {
    // Master switch for the background video layer.
    enabled: true,

    // "random" | "sequential" — how the next clip is chosen.
    mode: "random",

    // Video layer opacity behind the lyrics (0–1).
    opacity: 0.45,

    // Change the background video on every new song.
    changePerSong: true,

    // Explicit clip list. Bare names resolve under /bgv/; full URLs are
    // used as-is. Leave empty to auto-use whatever serve.py finds in
    // data/bgv/ (drop .mp4 / .webm files there). If nothing is available,
    // the player falls back to an animated gradient.
    files: [],
  },

  audio: {
    volume: 0.9, // 0–1
    tempo: 1.0, // playback rate, 0.5–1.5
    key: 0, // semitone transpose, -12..+12
  },

  // Key detection + display.
  key: {
    autoDetect: true, // analyse each song's key from the MIDI on load
    showBadge: true, // show the key beside the song title (current → transposed)
  },

  // Title card shown over the lyrics area when a song starts (title/artist/key),
  // then fades to the lyrics. seconds = how long it stays (0 = off).
  titleCard: { seconds: 3 },

  // Bluetooth mode: BT speakers/headphones add output latency, so enabling this
  // auto-sets the lyric/guide offset to -260 ms (delays the visuals to match the
  // delayed sound) and disables the mic features (singing through a ~260 ms delayed
  // output isn't practical). The offset stays adjustable afterward.
  bt: { enabled: false },

  // Collapsible panels (toggled from the top bar; true = shown). Persisted.
  ui: { library: true, queue: true, playback: true },

  // YouTube search (BYOC): live-query YouTube for karaoke videos and append the results to
  // the song list while you search. OFF by default — opt in with the 🌐 pill in the search
  // row (the app stays fully offline until then). BYOC-clean: results are live metadata only,
  // playback is the official YouTube embed, favorites store just a pointer (never content).
  // Chromium-only (needs the credentialless-iframe escape hatch under the app's cross-origin
  // isolation — see src/js/youtube.js); the feature self-disables on browsers without it.
  youtube: {
    enabled: false,                    // master toggle (mirrors the 🌐 search-row pill)
    searchUrl: "/api/youtube-search",  // server-side keyless-scrape proxy (serve.py)
    blockUrl:  "/api/youtube-block",   // report un-embeddable videoIds → shared server blocklist
    autoThreshold: 2,                  // only query YouTube when the local search has < this many hits
    debounceMs: 3000,                  // wait this long after typing stops before querying
    maxResults: 20,                    // cap on appended YouTube rows
    // Appended to every YouTube query ("<your search> karaoke") so results are filtered to
    // karaoke versions on YouTube's side. Blank to search the raw term. Editable in ⚙.
    keyword: "karaoke",
  },

  // Pitch guide — reads the guide melody from the MIDI and shows a scrolling
  // piano-roll of the notes to sing. Optionally overlays your live mic pitch and
  // a score. All parts are toggles.
  guide: {
    enabled: true, // master toggle for the guide band
    windowSec: 5, // seconds of melody visible across the band
    height: 150, // band height in px
    channel: -1, // -1 = auto-detect the melody channel; 0–15 = manual override
    showMic: true, // overlay the singer's detected pitch (needs mic enabled)
    trail: true, // soft fading ribbon tracing where the voice has been
    scoring: true, // compute + show a score from mic vs. target melody

    // The audible guide melody (the detected melody channel in the song).
    // volume 1 + no mute/solo = the song plays as authored (non-intrusive).
    // Turn the melody up to learn a song, mute it to perform, solo it to isolate.
    vocal: { volume: 1, mute: false, solo: false },
  },

  // MIDI mode — a per-channel mixer band (between the lyrics and the transport)
  // for the current MIDI song: all 16 channels with a volume slider, mute/solo,
  // and a live VU meter fed by the channel's real audio level. Off by default;
  // MIDI-only (hidden for video/YouTube). Per-channel slider positions are
  // transient (reset per song), so only this master toggle persists.
  midiMode: {
    enabled: false, // master toggle for the channel mixer band
  },

  // Microphone + voice effects. The mic starts OFF and must be enabled from the
  // ⚙ panel (browsers require a user gesture + permission). Enabling also needs a
  // secure context — http://localhost / 127.0.0.1 counts, so serve.py is fine.
  mic: {
    enabled: false, // reflects live state; actual enable needs a click
    volume: 0.9, // mic monitor level (0–1.5)

    // Feedback / noise control -------------------------------------------------
    // Browser constraints. Changing these re-acquires the mic. echoCancellation
    // is the biggest anti-feedback lever on speakers, but it colors singing —
    // turn off for the cleanest vocal (and use headphones).
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: false,
    highpass: true, // cut low rumble
    highpassHz: 100,
    gate: true, // noise gate: mute below threshold (stops amplifying room noise)
    gateThresholdDb: -50,

    // Voice effects ------------------------------------------------------------
    echo: { enabled: false, timeMs: 300, feedback: 0.35, mix: 0.35 },
    reverb: { enabled: false, mix: 0.3, seconds: 2.2 },
    chorus: { enabled: false, depth: 0.006, rateHz: 1.5, mix: 0.4 },
    // Manual pitch shift. enabled + semitones.
    pitch: { enabled: false, semitones: 0 },

    // Auto-tune: bends the voice to the correct note in real time.
    //   mode "melody"    → snap to the song's own guide melody note (best for karaoke)
    //   mode "scale"     → snap to key + scale
    //   mode "chromatic" → snap to the nearest semitone
    // strength 0 = off, 1 = full correction. (Shares the pitch-shift worklet, so its
    // quality/artifacts apply.) Needs the mic on; melody mode needs a playing song.
    autotune: { enabled: false, strength: 1.0, mode: "melody", key: 0, scale: "major" },
  },
};
