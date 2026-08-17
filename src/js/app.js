/*
 * app.js — the player / orchestrator.
 *
 * Owns playback (queue, current song, load → synth + lyrics + guide), the
 * requestAnimationFrame loop (lyric sync, pitch guide, scoring, auto-tune), the
 * transport controls, and the "settings → app" glue (what each setting change
 * actually does). The two big UI surfaces are delegated:
 *   - library-ui.js  : song list, search results, queue rendering
 *   - settings-ui.js : the ⚙ panel (control ↔ Settings wiring)
 * Everything else (audio, lyrics, melody/key, mic, settings store) lives in
 * its own module; this file wires them together.
 */

import { Catalog } from "./catalog.js";
import { AudioEngine } from "./audio.js";
import { VideoEngine } from "./video.js";
import { YouTubeEngine } from "./youtube.js";
import { AudioFileEngine } from "./audiofile.js";
import { parseMidi, LyricsEngine, makeTickToSeconds } from "./lyrics.js";
import { linesFromLyricFile, distributeLineTimes } from "./lyrics-formats.js";
import { ChordEngine } from "./chords.js";
import { Settings } from "./settings.js";
import { MicEngine } from "./mic.js";
import { extractMelody, PitchGuide, snapNote, detectKey, keyName } from "./melody.js";
import { Scorer } from "./scoring.js";
import { createLibraryUI } from "./library-ui.js";
import { createSettingsUI } from "./settings-ui.js";
import { createMidiMixer } from "./midi-mixer.js";
import { createReactions } from "./reactions.js";
import { createDurationHints } from "./duration-hints.js";
import { createRecap } from "./recap.js";
import { createScorePresentation, SCORE_CARD_MS } from "./score-presentation.js";
import { createQueue } from "./queue.js";
import { createRemoteHost, pickRemoteBaseUrl, clampRemoteSetting, REMOTE_SETTABLE_PATHS } from "./remote-host.js";
import { cachedArrayBuffer, purgeStaleCaches, purgeAllCaches } from "./asset-cache.js";
import { jsonStore, collectAppData, restoreAppData, clearAppData } from "./store.js";

const $ = (id) => document.getElementById(id);
// What an empty song list should SAY. A bare white panel is indistinguishable from a broken
// app, and the first-run case has a concrete next action worth naming.
const EMPTY_LIBRARY = {
  title: "No songs in the library yet",
  hint: "Drop .kar/.mid files into data/kar_raw/ (or videos into data/videos/), then ⚙ → Rebuild Catalog.",
};
// Source-kind icon shown in the now-playing header (in place of the dial number).
const NP_ICON = { midi: "🎤", video: "🎞️", youtube: "🌐", audio: "🎵" };
const npIcon = (kind) => NP_ICON[kind] || "🎵";

// --- singletons -------------------------------------------------------------
const settings = new Settings();
const catalog = new Catalog();
const audio = new AudioEngine();
const reactions = createReactions({ settings, audio });
const durations = createDurationHints();
const recap = createRecap();
const score = createScorePresentation({ settings });
let lyrics, mic, pitchGuide, video, youtube, chordEngine, audioFile; // created at boot (need the DOM)
let lib, settingsUI, midiMixer;  // UI modules (created at boot)

let remoteHost;                  // host↔phone relay driver (created at boot)

// --- mutable player state ---------------------------------------------------
// The queue owns its own two parallel arrays (song + who reserved it); every mutation renders,
// persists and pushes to the phones through this one callback.
const queue = createQueue({
  onChange() {
    lib.renderQueue(queue.list, queue.listBy);
    saveSession();
    if (remoteHost) remoteHost.push();
  },
});
let current = null;
let currentBy = "";              // who queued the NOW-PLAYING song via the remote ("" if host-added)
let media = audio;    // the engine driving the current song (audio=MIDI, video=VIDEO, youtube=YOUTUBE, audioFile=AUDIO)
let armed = false;    // true once the user has started playback (gates queue auto-advance)
let recent = []; // recently-played song ids, most-recent first
let userPaused = false;   // true only when the user paused (the auto-advance exception)
let autoAdvancing = false; // guard so the idle auto-advance fires once
let playDelayTimer = null; // delays music start until ~1s before the title card fades
let recentMode = false;    // "Recent" view toggle
let favoritesMode = false; // "Favorites" view toggle
let favorites = new Set(); // starred song ids (persisted separately from the session)
let lastParsed = null;
let currentKey = null;
let pendingUnsyncedLines = null; // AUDIO song: unsynced .txt lines awaiting duration-based timing
let currentMelodyChannel = -1;
let scorer = null;               // scoring.js Scorer for the current MIDI song (null = nothing to score)

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
async function boot() {
  document.body.classList.add("booting"); // hairline sweep under the topbar until the catalog lands
  purgeStaleCaches(); // drop the old service-worker cache; keep our asset cache

  lyrics = new LyricsEngine($("lyrics"), {
    lineCount: settings.get("lyrics.lineCount"),
    smooth: settings.get("lyrics.smooth"),
    mergeLines: settings.get("lyrics.mergeLines"),
  });
  mic = new MicEngine(audio, settings);
  pitchGuide = new PitchGuide($("pitch-guide"), settings);
  chordEngine = new ChordEngine($("chords"), { simplify: settings.get("chords.simplify") });
  video = new VideoEngine($("kv"), $("kva"), audio); // VIDEO-song playback (picture + offset audio; key-shift via shared chain)
  youtube = new YouTubeEngine($("ytplayer")); // YOUTUBE-song playback (credentialless iframe)
  audioFile = new AudioFileEngine($("kaudio"), audio); // AUDIO-song playback (WebAudio + pitch-shift)
  youtube.onState = () => { if (media === youtube) setPlayIcon(); }; // keep transport icon in sync with YT state
  youtube.onEnded = () => { if (media === youtube) endOfSong(); };   // unload on end → no suggested-videos screen
  youtube.onError = (code) => onYoutubeError(code);                  // embed-blocked/unavailable → skip + remember
  video.onError = (why) => onMediaError("video", why);               // missing/corrupt file → skip, don't hang
  audioFile.onError = (why) => onMediaError("audio", why);

  lib = createLibraryUI({
    onPlay: playNow, onQueue: enqueue, onRemoveFromQueue: removeFromQueue,
    onToggleFavorite: toggleFavorite, isFavorite,
  });
  settingsUI = createSettingsUI({
    settings, mic, onRebuild, onToggleMic: toggleMic, onEraseAll: eraseAllData,
    onExportData: exportAppData, onImportData: importAppData, onShowRecap: () => recap.show(),
  });
  midiMixer = createMidiMixer({ container: $("midi-mixer"), audio });
  remoteHost = createRemoteHost({ getSnapshot: remoteSnapshot, applyCommand: applyRemoteCommand });
  mic.onStatus = (m) => { $("mic-status").textContent = m; settingsUI.updateMicBtn(); updateMicToggle(); };

  applyVisualSettings();
  applyGuideSettings();
  applyChordSettings();
  applyMidiMode();
  applyRemoteMode();
  applyFontSize();       // set the Small/Medium/Large text scale before first paint of the list/guide
  applyTheme();          // color theme: dark / light / auto (follows the OS)
  settingsUI.syncSettingsUI();
  applyBluetoothMode();
  applyUiCollapse();
  applyControlsAutoHide();  // arm the playback-dock idle-hide if "Always show" is off

  try {
    const n = await catalog.load(settings.get("data.catalogUrl"), settings.get("data.videoCatalogUrl"), settings.get("data.audioCatalogUrl"));
    setStatus(`${n.toLocaleString()} songs loaded — pick one to begin`);
    durations.load(); // learned song lengths → queue ETA on the phones
    recap.load();        // tonight's performance log (reset after a long enough gap)
    loadYoutubeCache(); // re-register persisted YouTube songs so favorites/recent/queue resolve them
    loadBlockedYoutube(); // hide videos that previously failed to embed
    if (settings.get("youtube.enabled") && blockedYoutube.size) reportBlockedToServer([...blockedYoutube]); // seed the shared list
    loadFavorites(); // restore starred songs (resolved by id) before the first render
    lib.renderList(catalog.search(""), EMPTY_LIBRARY);
    loadSession(); // restore queue + recently-played (no auto-play)
  } catch (e) {
    setStatus("Failed to load catalog.json — is the server running from the project root?");
    console.error(e);
    lib.renderList([], {
      title: "Couldn't load the song catalog",
      hint: "Is the server running? Start it with: python tools/serve.py",
    });
  } finally {
    document.body.classList.remove("booting");
  }
  wireUI();
  settingsUI.wireSettings();
  settings.onChange(onSettingChanged);
  requestAnimationFrame(tick);
}

// ---------------------------------------------------------------------------
// Settings → app (what each change actually does; Settings calls this on change)
// ---------------------------------------------------------------------------
function applyVisualSettings() {
  const root = document.documentElement.style;
  root.setProperty("--line-width", settings.get("lyrics.lineWidthPct") + "%");
  root.setProperty("--font-scale", settings.get("lyrics.fontScale"));
  lyrics.setOptions({
    lineCount: settings.get("lyrics.lineCount"),
    smooth: settings.get("lyrics.smooth"),
    mergeLines: settings.get("lyrics.mergeLines"),
  });
  // Keep the offset slider in step when the value is changed from code (e.g. the
  // Bluetooth auto-set) — not just from the slider itself. Idempotent otherwise.
  const off = $("set-offset");
  if (off) {
    const ms = settings.get("lyrics.offsetMs");
    off.value = ms;
    const lbl = $("set-offset-val");
    if (lbl) lbl.textContent = `${ms} ms`;
  }
  // For a VIDEO song the lyrics are baked into the picture, so the offset moves the
  // AUDIO instead (same sign: >0 = picture/lyrics lead the sound). VideoEngine owns it.
  if (video) video.setOffset(settings.get("lyrics.offsetMs") || 0);
}

function applyAudioSettings() {
  const vol = settings.get("audio.volume");
  const tempo = settings.get("audio.tempo");
  // Volume + tempo apply to whichever engine plays; transpose/key is MIDI-only.
  if (audio.ready) {
    audio.setVolume(vol);
    audio.setTempo(tempo);
    audio.applyTranspose(settings.get("audio.key"));
  }
  // VIDEO songs: volume + tempo, and the Key control drives a real (stereo) pitch-shift of the audio.
  if (video) { video.setVolume(vol); video.setTempo(tempo); video.setKey(settings.get("audio.key")); }
  if (youtube) { youtube.setVolume(vol); youtube.setTempo(tempo); }
  // AUDIO songs: volume + tempo, and the Key control drives a real (stereo) pitch-shift.
  if (audioFile) { audioFile.setVolume(vol); audioFile.setTempo(tempo); audioFile.setKey(settings.get("audio.key")); }
}

function onSettingChanged(path) {
  if (path === "*" || path.startsWith("lyrics.")) applyVisualSettings();
  if (path === "*" || path.startsWith("audio.")) applyAudioSettings();
  if (path.startsWith("mic.")) {
    // AEC/NS/AGC are getUserMedia constraints → need a fresh stream
    if (/echoCancellation|noiseSuppression|autoGainControl/.test(path)) mic.reacquire();
    else mic.applySettings();
  }
  if (path === "*" || path.startsWith("guide.")) {
    applyGuideSettings();
    if ((path === "*" || path === "guide.channel") && lastParsed) loadMelody(lastParsed);
    if (path === "*" || path.startsWith("guide.vocal")) { applyGuideVocal(); updateMelodyToggle(); }
  }
  if (path === "*" || path.startsWith("key.") || path === "audio.key") {
    if (path === "key.autoDetect" && lastParsed) currentKey = settings.get("key.autoDetect") ? detectKey(lastParsed) : null;
    updateKeyDisplay();
    // Transpose relabels the chord lane live (root + semitones) — no re-detection.
    if (chordEngine) chordEngine.setTranspose(settings.get("audio.key"));
  }
  if (path === "*" || path.startsWith("chords.")) applyChordSettings();
  if (path === "*" || path === "bt.enabled") applyBluetoothMode(path === "bt.enabled");
  if (path === "*" || path === "youtube.enabled") {
    updateYoutubeToggle();
    // reflect the new state in the current search (append or drop YouTube rows)
    if (path === "youtube.enabled" && !recentMode && !favoritesMode) runSearch($("search").value);
  }
  if (path === "*" || path.startsWith("midiMode.")) applyMidiMode();
  if (path === "*" || path.startsWith("remote.")) applyRemoteMode();
  // Only the panel-collapse booleans drive applyUiCollapse — not ui.fontSize / ui.theme
  // (those have their own handlers below and don't need a virtual-list re-refresh).
  if (path === "*" || /^ui\.(library|queue)$/.test(path)) applyUiCollapse();
  // "Always show playback controls" + its auto-hide duration re-arm the idle-hide timer.
  if (path === "*" || path === "ui.playback" || path === "ui.autoHideSec") applyControlsAutoHide();
  if (path === "*" || path === "ui.fontSize") applyFontSize();
  if (path === "*" || path === "ui.theme") applyTheme();
  if (path === "*") settingsUI.syncSettingsUI();
}

// Font size — an explicit Small / Medium / Large that scales the whole player text + controls
// (drives --scale/--ui-scale + --row-h via :root[data-fontsize] in tokens.css). Replaced the
// old auto display-size profile (phone/tablet/computer/tv width-detect + TV ramp). The Lyrics
// "Lyrics size" slider (lyrics.fontScale) fine-tunes just the lyrics on top of this.
const FONT_SIZES = new Set(["small", "medium", "large"]);
function applyFontSize() {
  const pref = settings.get("ui.fontSize");
  const size = FONT_SIZES.has(pref) ? pref : "medium";
  const el = document.documentElement;
  if (el.dataset.fontsize === size) return; // no change → nothing to re-measure
  el.dataset.fontsize = size;
  requestAnimationFrame(() => {
    if (lib) lib.refresh();          // --row-h changed → re-measure the virtualized list
    if (pitchGuide) pitchGuide.resize();
  });
}
// Host color theme. "auto" follows the OS (prefers-color-scheme); "dark"/"light" force it.
// tokens.css reads :root[data-theme]; removing the attribute = auto.
function applyTheme() {
  const t = settings.get("ui.theme");
  const el = document.documentElement;
  if (t === "dark" || t === "light") el.dataset.theme = t;
  else el.removeAttribute("data-theme");
}
// On resize/rotate (debounced): re-sync the compact-layout panel toggles (the mobile
// breakpoint is orientation-aware), re-fit the title card (its 50vh height changes with the
// viewport), re-anchor the focus QR, and re-measure the virtual list + guide.
let _screenResizeTimer;
window.addEventListener("resize", () => {
  clearTimeout(_screenResizeTimer);
  _screenResizeTimer = setTimeout(() => {
    // Focus mode is a 10-foot/desktop feature whose ◎ toggle is hidden on mobile — so if the
    // viewport becomes mobile while it's on, force it off (else you're stuck in it with no exit).
    if (isMobileWidth() && document.body.classList.contains("focus-mode")) setFocus(false);
    fitTitleCard(); positionFocusQr(); applyPanelToggles();
    if (lib) lib.refresh(); if (pitchGuide) pitchGuide.resize();
  }, 150);
});

// Mobile (≤900px): the song list (🔍) and the queue (▦) are MUTUALLY EXCLUSIVE — screen
// space is tight, so at most one is open at a time. Desktop keeps them independent
// (persisted ui.library / ui.queue, 3-column). `mobilePanel` is the mobile-only open panel.
let mobilePanel = "library"; // "library" | "queue" | "none" — only meaningful on mobile
// "Compact" = phones/small screens (≤900px) OR a tablet in portrait (≤1024px) — matches the
// CSS compact breakpoint. A tablet in landscape stays desktop (independent 3-column panels).
const isMobileWidth = () => window.matchMedia("(max-width: 900px), (max-width: 1024px) and (orientation: portrait)").matches;

function applyUiCollapse() {
  // Desktop 3-column collapse classes (read only by the >900px CSS).
  document.body.classList.toggle("lib-collapsed", !settings.get("ui.library"));
  document.body.classList.toggle("queue-collapsed", !settings.get("ui.queue"));
  applyPanelToggles();
  // panels that regained size need a re-render / resize
  requestAnimationFrame(() => {
    if (lib) lib.refresh();
    if (pitchGuide) pitchGuide.resize();
  });
}

// Reflect the list/queue open-state on the two top-bar buttons and, on mobile, on the
// mutually-exclusive body.mobile-lib / body.mobile-queue classes. Called on collapse
// changes and on resize (so crossing the 900px breakpoint re-syncs the buttons).
function applyPanelToggles() {
  const mobile = isMobileWidth();
  document.body.classList.toggle("mobile-lib", mobile && mobilePanel === "library");
  document.body.classList.toggle("mobile-queue", mobile && mobilePanel === "queue");
  $("toggle-lib").classList.toggle("active", mobile ? mobilePanel === "library" : settings.get("ui.library"));
  $("toggle-queue").classList.toggle("active", mobile ? mobilePanel === "queue" : settings.get("ui.queue"));
}

// Mobile toggle: open the tapped panel (closing the other), or close it if already open
// (→ full-screen lyrics). Re-measures the virtual list + guide since the stage resizes.
function toggleMobilePanel(which) {
  mobilePanel = mobilePanel === which ? "none" : which;
  applyPanelToggles();
  requestAnimationFrame(() => { if (lib) lib.refresh(); if (pitchGuide) pitchGuide.resize(); });
}

// Playback-controls auto-hide. The transport/seek dock is an overlay at the bottom of the
// stage; it stays visible when "Always show playback controls" (ui.playback) is on, and
// auto-hides after ui.autoHideSec idle seconds when that's off — and always in focus mode
// (which additionally recedes the topbar). Any pointer/key activity brings it back.
let _ctlHideTimer;
function autoHideActive() {
  return document.body.classList.contains("focus-mode") || !settings.get("ui.playback");
}
function showControls() {
  clearTimeout(_ctlHideTimer);
  document.body.classList.remove("controls-hidden");
  if (autoHideActive()) {
    const ms = Math.max(1, Number(settings.get("ui.autoHideSec")) || 3) * 1000;
    _ctlHideTimer = setTimeout(() => document.body.classList.add("controls-hidden"), ms);
  }
}
// (Re)arm or cancel the idle-hide timer when the mode or duration changes.
function applyControlsAutoHide() {
  if (autoHideActive()) showControls();
  else { clearTimeout(_ctlHideTimer); document.body.classList.remove("controls-hidden"); }
}

// Focus mode — a distraction-free full-stage lyrics view (10-foot). Toggles body.focus-mode,
// syncs the ◎ button, arms the controls auto-hide, and re-measures the list + guide. Module
// scope so the resize handler can force it off (the ◎ button is hidden on mobile, so entering
// focus on desktop then resizing to mobile would otherwise strand you with no way to exit).
function setFocus(on) {
  document.body.classList.toggle("focus-mode", on);
  const focusBtn = $("btn-focus");
  if (focusBtn) {
    focusBtn.classList.toggle("active", on);
    focusBtn.title = on ? "Exit focus mode (Esc)" : "Focus mode — hide panels for a full-screen lyrics view (Esc to exit)";
  }
  applyControlsAutoHide(); // focus on → arm the timer; off → revert to the ui.playback state
  requestAnimationFrame(() => { if (lib) lib.refresh(); if (pitchGuide) pitchGuide.resize(); positionFocusQr(); });
}

// Bluetooth mode: BT output lags ~260 ms, so the lyrics/guide (synced to the app
// clock) run ahead of what you HEAR — a negative offset delays them to match. We
// auto-set −260 ms only when you flip BT on (autoSet); after that the offset stays
// yours to nudge, and a reload won't clobber it. Also disables the mic (singing
// through a ~260 ms delayed output isn't practical).
const BT_OFFSET_MS = -260;
function applyBluetoothMode(autoSet = false) {
  const on = settings.get("bt.enabled");
  document.body.classList.toggle("bt-mode", on);
  if (on) {
    if (autoSet) settings.set("lyrics.offsetMs", BT_OFFSET_MS); // still user-adjustable afterward
    if (mic.enabled) mic.disable();
  }
  updateMicToggle();
}

function applyGuideSettings() {
  const on = settings.get("guide.enabled");
  document.body.classList.toggle("guide-on", on);
  document.documentElement.style.setProperty("--guide-height", settings.get("guide.height") + "px");
  if (on && pitchGuide) pitchGuide.resize();
  positionFocusQr(); // guide height/visibility changed → re-anchor the focus-mode QR
}

// Chord lane: show/hide + push the simplify toggle. (Detection happens on song load;
// transpose is applied from the audio.key branch below.)
function applyChordSettings() {
  document.body.classList.toggle("chords-on", settings.get("chords.enabled"));
  if (chordEngine) {
    chordEngine.setSimplify(settings.get("chords.simplify"));
    chordEngine._rescroll(); // the lane may have just become visible → re-anchor
  }
}

// MIDI mode: reveal the per-channel mixer band. Turning it OFF hands the mix back
// to the song (unlock CC7 + unmute every channel).
function applyMidiMode() {
  const on = settings.get("midiMode.enabled");
  document.body.classList.toggle("midi-mode", on);
  if (!on && audio.ready) audio.releaseChannelMix();
}

// Apply guide-vocal (melody channel volume/mute/solo) to the live synth.
function applyGuideVocal() {
  if (!audio.ready || currentMelodyChannel < 0) return;
  audio.setGuideVocal(currentMelodyChannel, {
    volume: settings.get("guide.vocal.volume"),
    mute: settings.get("guide.vocal.mute"),
    solo: settings.get("guide.vocal.solo"),
  });
}

// Extract the guide melody + detect the key from a parsed MIDI.
function loadMelody(parsed) {
  try {
    const t2s = makeTickToSeconds(parsed);
    const mel = extractMelody(parsed, t2s, settings.get("guide.channel"));
    pitchGuide.load(mel);
    currentMelodyChannel = mel.hasMelody ? mel.channel : -1;
    $("guide-info").textContent = mel.hasMelody
      ? `melody: channel ${mel.channel + 1} · ${mel.notes.length} notes`
      : "no guide melody found in this file";
    // The guide melody IS the scorer's reference track — the piece UltraStar-family games
    // have to hand-author per song and we derive from the KAR file (see scoring.js).
    scorer = mel.hasMelody ? new Scorer(mel.notes, { golden: settings.get("score.golden") }) : null;
  } catch (e) {
    console.warn("melody extract failed:", e);
    pitchGuide.load({ hasMelody: false, notes: [], range: { min: 60, max: 72 } });
    scorer = null;
  }
  score.resetLineBonus();
  pitchGuide.setScore(null);

  currentKey = settings.get("key.autoDetect") ? detectKey(parsed) : null;
  updateKeyDisplay();
}

// Key beside the title (current → transposed) + the resulting key on the Key control.
function updateKeyDisplay() {
  const el = $("np-key"), kn = $("key-name");
  const show = settings.get("key.showBadge") && currentKey && currentKey.source !== "none";
  if (!show) { if (el) el.textContent = ""; if (kn) kn.textContent = ""; return; }
  const semis = settings.get("audio.key") || 0;
  const orig = keyName(currentKey.keyPc, currentKey.mode, true);
  const trans = keyName(currentKey.keyPc + semis, currentKey.mode, true);
  el.textContent = semis ? `${orig} → ${trans}` : orig;
  el.classList.toggle("uncertain", currentKey.confidence > 0 && currentKey.confidence < 0.7);
  el.title = `Detected key (${currentKey.source}${currentKey.source === "analysis" ? `, ${Math.round(currentKey.confidence * 100)}% conf.` : ""})`;
  if (kn) kn.textContent = trans;
}

// octave-agnostic semitone distance between two MIDI notes (0..6)
function pcDist(a, b) {
  let d = (((a - b) % 12) + 12) % 12;
  return d > 6 ? 12 - d : d;
}

// ---------------------------------------------------------------------------
// Queue
// ---------------------------------------------------------------------------
// The list itself lives in queue.js (song + who reserved it, kept in lockstep). What stays
// here is only what needs the playback state: when to start playing, and what to do when the
// queue runs dry.
function enqueue(song, by = "") {
  queue.add(song, by, !!settings.get("queue.fairPlay"));
  // Start playing if nothing is — but NOT while a song is still loading. `current` isn't set
  // until a play* gets past its awaits, so during a cold start (or any slow load) every extra
  // ＋ click read "nothing is playing" and shifted ANOTHER song off the queue to play. Queue
  // three songs quickly and the middle one vanished: never played, no longer queued.
  // This guard has to stay HERE — only app.js can see the playback state it reads.
  if (!current && !loadingSong) advanceQueue();
}
function removeFromQueue(i) { queue.removeAt(i); }
// Move a queued song from one position to another (used by the phone remote's reorder).
function reorderQueue(from, to) { queue.move(from, to); }
function advanceQueue() {
  const taken = queue.shift();
  if (taken) playNow(taken.song, taken.by);
  else {
    media.stop();            // nothing more queued → halt the active engine
    current = null; autoAdvancing = false;
    clearStage();            // blank the lyrics + reset the seek bar/time once playback ends
    setPlayIcon();
  }
}

// ---------------------------------------------------------------------------
// Remote control (phones) — host side. The host stays the authoritative player;
// remote-host.js POSTs remoteSnapshot() to serve.py and hands back guest COMMANDS
// which applyRemoteCommand() applies through the SAME functions the local UI uses.
// See src/remote.html / src/js/remote.js (the phone) and §5.x in CLAUDE.md.
// ---------------------------------------------------------------------------
// The host-settings subset mirrored to phones AND the allowlist a guest may change.
// A guest `setting` command with any other path is ignored — never settings.set() an
// arbitrary path off the network. The paths AND their legal value ranges live together
// in remote-host.js (REMOTE_SETTING_RANGES): allowlisting the path is not enough, since
// the phone UI clamps client-side and a raw POST doesn't — see clampRemoteSetting.
const REMOTE_SETTABLE = new Set(REMOTE_SETTABLE_PATHS);

// Room code — OWNED BY THIS HOST BROWSER (generated once, kept in localStorage). Each host has
// its own code; guests reach THIS host's room by it (baked into the QR). The server keys its
// multi-room relay on the code. 6 chars, no ambiguous glyphs.
const HOST_ROOM_KEY = "karaeoke.remote.host.v1";
let hostRoom = null;
function getHostRoom() {
  if (hostRoom) return hostRoom;
  try { hostRoom = localStorage.getItem(HOST_ROOM_KEY) || ""; } catch (_) { hostRoom = ""; }
  if (!/^[A-Z0-9]{6}$/.test(hostRoom)) {
    const A = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    const buf = new Uint32Array(6);
    (window.crypto || crypto).getRandomValues(buf);
    hostRoom = Array.from(buf, (n) => A[n % A.length]).join("");
    try { localStorage.setItem(HOST_ROOM_KEY, hostRoom); } catch (_) {}
  }
  return hostRoom;
}

// Render/refresh (or hide) the QR + URL + room code on the queue panel. The base URL is
// auto-detected (settings override → the host page's own non-loopback origin → the server's
// LAN IP); the host's room code is embedded so scanning auto-connects. Degrades quietly if the
// QR lib 404'd (feature is opt-in anyway).
let remoteLanUrl = null; // server-detected LAN base (fetched once, cached)
async function refreshRemoteQr(on) {
  const box = $("remote-qr");
  if (!box) return;
  if (!on) { box.classList.remove("show"); renderQr($("focus-qr"), ""); return; }
  if (remoteLanUrl == null) {
    try {
      const d = await (await fetch("/api/remote/info")).json();
      remoteLanUrl = (d && d.lanUrl) || "";
    } catch (_) { remoteLanUrl = ""; }
  }
  const room = getHostRoom();
  const base = pickRemoteBaseUrl(settings.get("remote.baseUrl"), location.origin, remoteLanUrl);
  const url = base ? `${base}/remote?room=${room}` : "";
  const roomEl = $("remote-room"); if (roomEl) roomEl.textContent = room;
  const link = $("remote-qr-url");
  if (link) { link.textContent = base ? `${base}/remote` : "(no reachable URL)"; link.href = url || "#"; }
  renderQr($("remote-qr-code"), url);
  renderQr($("focus-qr"), url); // same QR mirrored into the focus-mode overlay (CSS gates visibility)
  positionFocusQr();
  box.classList.add("show");
}

// Focus-mode QR placement: overlay it on the RIGHT side of the melody guide, sized square to
// the guide's height. The guide's top is dynamic (below the now-playing header), so we measure
// rather than guess. When focus/remote is off or the guide is hidden, clear the inline styles
// and let CSS fall back to a top-right corner. Called on focus toggle, resize, and guide changes.
function positionFocusQr() {
  const qr = $("focus-qr");
  if (!qr) return;
  qr.style.top = qr.style.right = qr.style.width = qr.style.height = ""; // reset → CSS fallback
  const active = document.body.classList.contains("focus-mode") && document.body.classList.contains("remote-on");
  const stage = document.querySelector(".stage");
  const guide = $("pitch-guide");
  if (!active || !stage || !guide) return;
  // guide only counts if it's actually laid out (guide-on, and not hidden by video/audio/youtube mode)
  if (!document.body.classList.contains("guide-on") || !guide.getClientRects().length) return;
  const s = stage.getBoundingClientRect();
  const g = guide.getBoundingClientRect();
  qr.style.width = qr.style.height = g.height + "px";   // square, same height as the guide
  qr.style.top = (g.top - s.top) + "px";                 // top-aligned to the guide
  qr.style.right = (s.right - g.right) + "px";           // right edge aligned to the guide's
}

// Draw a QR into `el` using the vendored qrcode-generator (window.qrcode). No-op if the
// lib is missing or the URL is empty.
function renderQr(el, text) {
  if (!el) return;
  el.innerHTML = "";
  const qrcode = window.qrcode;
  if (!text || typeof qrcode !== "function") return;
  try {
    const qr = qrcode(0, "M");        // type 0 = auto-fit the data, error-correction level M
    qr.addData(text);
    qr.make();
    el.innerHTML = qr.createSvgTag({ cellSize: 4, margin: 2, scalable: true });
  } catch (e) { console.error("QR render failed:", e); }
}

function applyRemoteMode() {
  const on = !!settings.get("remote.enabled");
  document.body.classList.toggle("remote-on", on);
  if (!remoteHost) return;
  if (on) remoteHost.start(); else remoteHost.stop();
  refreshRemoteQr(on); // render/refresh (or hide) the QR on the queue panel — see Stage 3
}

// Snapshot the host state for the phones: now-playing, the queue (with attribution),
// and the mirrored settings subset. remote-host.js adds the ackSeq before POSTing.
function remoteSnapshot() {
  const now = current ? {
    id: current.id,
    name: current.name || "",
    artist: current.artistName || "",
    kind: current.kind,
    code: current.code || "",
    by: currentBy || "",
    position: (media && media.currentTime) || 0,
    duration: (media && media.duration) || 0,
    paused: media ? media.paused : true,
    // Live score, so the room can watch the number climb on their own phones. Null unless
    // the song is actually being scored (MIDI + mic + score.enabled) — see scoring.js.
    score: scorer && mic.enabled && settings.get("score.enabled") ? scorer.liveScore() : null,
  } : null;
  const q = queue.list.map((s, i) => ({
    id: s.id, name: s.name || "", artist: s.artistName || "",
    kind: s.kind, code: s.code || "", by: queue.listBy[i] || "",
    dur: durations.get(s.id),   // learned length → the phone computes "how long until mine"
  }));
  const settingsSub = {};
  for (const p of REMOTE_SETTABLE) settingsSub[p] = settings.get(p);
  return { room: getHostRoom(), now, queue: q, settings: settingsSub };
}

// Resolve a song a phone asked to enqueue. Library songs resolve by id; a YouTube
// result (not in the local catalog) is reconstructed from the command metadata and
// registered so it resolves everywhere else (favorites/recent/queue) like a local one.
function remoteResolveSong(c) {
  const hit = catalog.getById(c.id);
  if (hit) return hit;
  if (c.kind === "youtube" && c.videoId) {
    return registerYoutube(Catalog.makeYoutubeRecord({
      videoId: c.videoId, title: c.name, channelTitle: c.artist,
    }));
  }
  return null;
}

// A guest computes a queue index from a snapshot that can already be up to ~2 s stale, so a
// bare index may point at a DIFFERENT song by the time the command lands (the song auto-
// advanced, or another guest removed one first). When the command carries the song's stable
// id we require it to match, so the worst case becomes "nothing happened" instead of "the
// wrong song vanished". Commands without an id (older phone build) still apply by index.
// Apply one guest command (already validated server-side to a known type).
function applyRemoteCommand(cmd) {
  switch (cmd.type) {
    case "enqueue": {
      const by = String(cmd.by || "").slice(0, 24);
      // Optional reservation cap — the digital form of "don't hog the mic". 0 = off.
      const cap = +settings.get("queue.maxPerGuest") || 0;
      if (cap > 0 && by && queue.countBy(by) >= cap) {
        setStatus(`${by} already has ${cap} song${cap === 1 ? "" : "s"} reserved — wait for your turn.`);
        break;
      }
      const song = remoteResolveSong(cmd);
      if (song) enqueue(song, by);
      break;
    }
    case "remove":
      if (queue.matches(cmd.index, cmd.id)) removeFromQueue(cmd.index);
      break;
    case "reorder":
      if (Number.isInteger(cmd.to) && queue.matches(cmd.from, cmd.id)) reorderQueue(cmd.from, cmd.to);
      break;
    case "react":
      // Allowlisted, never free text: this is drawn on the host's TV from a stranger's phone.
      reactions.handle(cmd.emoji);
      break;
    case "play":  remotePlay();  break;
    case "pause": remotePause(); break;
    case "next":  skipCurrent(); break;
    case "seek":
      if (current && media.duration > 0 && Number.isFinite(cmd.position))
        media.seek(Math.max(0, Math.min(media.duration, cmd.position)));
      break;
    case "volume":
      if (Number.isFinite(cmd.value)) setRemoteVolume(cmd.value);
      break;
    case "setting": {
      // Two gates, not one: the PATH must be allowlisted and the VALUE must be in range.
      // A raw POST is unclamped, and audio.volume goes straight to a GainNode.
      if (typeof cmd.path !== "string" || !REMOTE_SETTABLE.has(cmd.path)) break;
      const v = clampRemoteSetting(cmd.path, cmd.value);
      if (v === undefined) break;             // wrong type / NaN / unknown path → ignore
      settings.set(cmd.path, v);              // → onSettingChanged fans it out
      settingsUI.syncSettingsUI();            // refresh the ⚙ panel controls
      syncTransportLabels();                  // …and the bottom key/tempo/volume labels
      break;
    }
  }
}

async function remotePlay() {
  if (!current) { if (queue.length) advanceQueue(); return; }
  if (media === audio && !(await ensureEngine())) return;
  if (media.paused) media.play();
  userPaused = false;
  setPlayIcon();
}
function remotePause() {
  if (current && !media.paused) { media.pause(); userPaused = true; setPlayIcon(); }
}
function setRemoteVolume(v) {
  v = Math.max(0, Math.min(2, v));        // the volume slider goes to 200% (see Bluetooth mode)
  settings.set("audio.volume", v);         // → applyAudioSettings
  const el = $("volume"); if (el) el.value = v;
}
// Keep the bottom transport labels/sliders in step when a phone changes key/tempo/volume.
function syncTransportLabels() {
  const tv = $("tempo-val"), v = $("volume"), kv = $("key-val");
  if (tv) tv.textContent = `${(+settings.get("audio.tempo")).toFixed(2)}×`;
  if (v) v.value = settings.get("audio.volume");
  if (kv) kv.textContent = fmtKey(settings.get("audio.key"));
}

// ---------------------------------------------------------------------------
// Session persistence — queue + recently played survive reloads (localStorage).
// The queue is restored but NOT auto-played (no user gesture on load).
// ---------------------------------------------------------------------------
const sessionStore = jsonStore("karaeoke.session.v1", null);

// Full factory reset ("Erase all app data"): remove EVERY karaeoke.* localStorage key
// (settings, session/queue+recents, favorites, ⚙ panel state, remote room code, the
// YouTube pointer cache + blocklist) AND every Cache Storage cache (the ~32 MB soundfont
// + cached songs), then reload into a pristine first-run state. Irreversible — the caller
// (settings-ui.js) gates it behind a two-step confirm.
async function eraseAllData() {
  clearAppData();
  await purgeAllCaches();
  location.reload();
}

// Backup / restore. Every karaeoke.* key (settings, queue + recents, favorites, ⚙ panel
// layout, the remote room code, saved-YouTube pointers) lives ONLY in this browser's
// localStorage — a reinstall or a stray "clear site data" takes all of it, and the only
// control the panel offered for that state was the erase button. Export writes one JSON
// file; import writes karaeoke.* keys back and reloads so every module re-reads its store.
function exportAppData() {
  const payload = { ...collectAppData(), exportedAt: new Date().toISOString() };
  const url = URL.createObjectURL(new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = `karaeoke-backup-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  return Object.keys(payload.data).length;
}

/** Restore an exported file. Only karaeoke.* string keys are written, so a foreign or
 *  hand-edited file can't reach any other state this origin keeps. Caller reloads. */
async function importAppData(file) {
  return restoreAppData(JSON.parse(await file.text()));
}

// Resolve a stored reference to a song. New format = stable id ("midi:5"/"video:5");
// old sessions stored a bare numeric code → treat as a MIDI code (back-compat).
function resolveSong(ref) {
  return (typeof ref === "string" && ref.includes(":")) ? catalog.getById(ref) : catalog.get(ref);
}

function saveSession() {
  sessionStore.write({ queue: queue.list.map((s) => s.id), recent });
  saveYoutubeCache(); // keep the YouTube pointer cache in step with the queue/recent
}
function loadSession() {
  const data = sessionStore.read();
  if (!data) return;
  recent = (Array.isArray(data.recent) ? data.recent : [])
    .map(resolveSong).filter(Boolean).map((s) => s.id);
  const q = (data.queue || []).map(resolveSong).filter(Boolean);
  if (q.length) { queue.restore(q); lib.renderQueue(queue.list, queue.listBy); }
}
function pushRecent(song) {
  recent = [song.id, ...recent.filter((id) => id !== song.id)].slice(0, 40);
  saveSession();
}
function setRecentMode(on) {
  recentMode = on;
  $("btn-recent").classList.toggle("active", on);
  if (on && favoritesMode) setFavoritesMode(false); // the two library views are mutually exclusive
}
function showRecent() {
  const songs = recent.map((id) => catalog.getById(id)).filter(Boolean);
  lib.renderList(songs, { title: "Nothing played yet tonight", hint: "Songs you play show up here." });
  setStatus(songs.length ? `${songs.length} recently played` : "no recent songs yet");
}

// ---------------------------------------------------------------------------
// Favorites — starred songs, persisted separately from the session (localStorage).
// Stored as an array of stable ids so KAR/VID are unambiguous (§5.10); old bare
// codes resolve as MIDI via resolveSong (same back-compat as the queue/recent).
// ---------------------------------------------------------------------------
const favoritesStore = jsonStore("karaeoke.favorites.v1", []);

function loadFavorites() {
  const data = favoritesStore.read();
  const ids = (Array.isArray(data) ? data : []).map(resolveSong).filter(Boolean).map((s) => s.id);
  favorites = new Set(ids);
}
function saveFavorites() {
  favoritesStore.write([...favorites]);
  saveYoutubeCache(); // a starred YouTube song must keep its pointer so it resolves on reload
}
function isFavorite(song) { return !!song && favorites.has(song.id); }
function toggleFavorite(song) {
  if (!song) return;
  if (favorites.has(song.id)) favorites.delete(song.id);
  else favorites.add(song.id);
  saveFavorites();
  if (favoritesMode) showFavorites();  // in the Favorites view, un-starring drops the row
  else lib.refresh();                  // otherwise just repaint the star in place
}
function setFavoritesMode(on) {
  favoritesMode = on;
  $("btn-favorites").classList.toggle("active", on);
  if (on && recentMode) setRecentMode(false); // the two library views are mutually exclusive
}
function showFavorites() {
  const songs = [...favorites].map((id) => catalog.getById(id)).filter(Boolean);
  lib.renderList(songs, { title: "No favorites yet", hint: "Tap the ☆ on any song to keep it here." });
  setStatus(songs.length ? `${songs.length} favorite${songs.length === 1 ? "" : "s"}` : "no favorites yet — tap ☆ on a song");
}

// ---------------------------------------------------------------------------
// YouTube search (BYOC): live results append to the song list while you search; a 🌐 pill
// toggles it. YouTube records are transient (not part of the browse catalog), so we keep a
// small POINTER cache (metadata only — videoId/title/channel, never content) so favorited /
// queued / recently-played YouTube songs still resolve by id after a reload. Persisted in a
// third localStorage key, independent of settings + session. Chromium-only (needs the
// credentialless iframe — see src/js/youtube.js); self-disables where unsupported.
// ---------------------------------------------------------------------------
const youtubeStore = jsonStore("karaeoke.youtube.v1", {});
const youtubeCache = new Map(); // id → YouTube record (favorites/recent/queue resolution)
let ytSearchTimer = null;       // the (long) debounce before actually querying YouTube

/** True only when the user opted in AND the browser supports credentialless iframes. */
function youtubeOn() { return settings.get("youtube.enabled") && YouTubeEngine.supported; }

/** Register a YouTube record so catalog.getById() resolves it — WITHOUT adding it to the
 *  browse list. Used for live results and before persisting favorites/queue/recent. */
function registerYoutube(rec) {
  if (!rec || rec.kind !== "youtube") return rec;
  youtubeCache.set(rec.id, rec);
  catalog.addExternal(rec);
  return rec;
}
function loadYoutubeCache() {
  const data = youtubeStore.read();
  if (data && typeof data === "object") {
    for (const rec of Object.values(data)) {
      if (rec && rec.id && rec.kind === "youtube") registerYoutube(rec);
    }
  }
}
/** Persist only the YouTube records still referenced by a favorite / the queue / recent. */
function saveYoutubeCache() {
  const keep = new Set([...favorites, ...queue.list.map((s) => s.id), ...recent]);
  const obj = {};
  for (const id of keep) {
    const rec = youtubeCache.get(id);
    if (rec && rec.kind === "youtube") obj[id] = rec;
  }
  youtubeStore.write(obj);
}

// A persistent blocklist of YouTube videoIds that failed to embed (owner-disabled / removed /
// private). We hide them from future search results and skip past them, so a dead video never
// shows up again. Stored as a plain id array, independent of the pointer cache above.
const blockedStore = jsonStore("karaeoke.youtube.blocked.v1", []);
const blockedYoutube = new Set();

function loadBlockedYoutube() {
  const a = blockedStore.read();
  if (Array.isArray(a)) a.forEach((id) => id && blockedYoutube.add(id));
}
function blockYoutube(videoId) {
  if (!videoId || blockedYoutube.has(videoId)) return;
  blockedYoutube.add(videoId);
  blockedStore.write([...blockedYoutube]);
  reportBlockedToServer([videoId]); // share it so every user's results omit it too
}

/** Push un-embeddable videoIds to the server's shared blocklist (fire-and-forget). The server
 *  filters them from /api/youtube-search for everyone, so nobody hits the dead video again. */
function reportBlockedToServer(ids) {
  if (!ids || !ids.length) return;
  const url = settings.get("youtube.blockUrl") || "/api/youtube-block";
  try {
    fetch(url, { method: "POST", headers: { "Content-Type": "application/json" },
                 body: JSON.stringify({ videoIds: ids }) }).catch(() => {});
  } catch (_) {}
}

/** POST the query to serve.py's keyless-scrape proxy → transient YouTube records.
 *  The configured keyword (default "karaoke") is appended so YouTube filters to karaoke
 *  versions server-side — e.g. "tetoris" → "tetoris karaoke". */
async function youtubeSearch(query) {
  const url = settings.get("youtube.searchUrl") || "/api/youtube-search";
  const keyword = (settings.get("youtube.keyword") || "").trim();
  const q = keyword ? `${query} ${keyword}` : query;
  const maxResults = settings.get("youtube.maxResults");
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ q, maxResults }),
  });
  const data = await res.json();
  return ((data && data.items) || [])
    .map((it) => Catalog.makeYoutubeRecord(it))
    .filter((r) => r && !blockedYoutube.has(r.videoId)); // hide videos that already failed to embed
}

// A YouTube video failed to play. Codes: 2 = bad id, 5 = HTML5 error (may be transient),
// 100 = removed/private, 101/150 = embedding disabled by the owner. The permanent ones get
// remembered (blocklist → hidden from future results); then we skip to the next result.
function onYoutubeError(code) {
  if (media !== youtube || !current) return;
  const permanent = code === 101 || code === 150 || code === 100 || code === 2;
  if (permanent) blockYoutube(current.videoId);
  const why = (code === 101 || code === 150) ? "embedding disabled by owner" : `unavailable (${code})`;
  setStatus(`"${current.name}" ${why} — skipping…`);
  const next = nextYoutubeInList(current);
  if (next) return playNow(next);      // walk to the next result the user was browsing
  if (queue.length) return skipCurrent();  // same single "move on now" path as ⏭ / a failure
  youtube.unload();                    // nothing to fall back to → clear the stage
  document.body.classList.remove("youtube-mode");
  clearStage();
  current = null;
  setPlayIcon();
}

/** The next kind:"youtube" record after `song` in the currently-rendered list, skipping any
 *  already blocked. null if there isn't one. */
function nextYoutubeInList(song) {
  const list = (lib.getList && lib.getList()) || [];
  const i = list.findIndex((s) => s.id === song.id);
  if (i < 0) return null;
  for (let j = i + 1; j < list.length; j++) {
    const s = list[j];
    if (s.kind === "youtube" && !blockedYoutube.has(s.videoId)) return s;
  }
  return null;
}

/** Render local matches for `query`, optionally appending the given YouTube records. */
function renderSearchResults(query, ytRecords) {
  const local = catalog.search(query);
  const rows = ytRecords && ytRecords.length ? [...local, ...ytRecords] : local;
  lib.renderList(rows, query.trim()
    ? { title: `No matches for "${query.trim()}"`, hint: "Try fewer words, or a dial number." }
    : EMPTY_LIBRARY);
}

/** After a long idle, query YouTube — but only when enabled and the local list came up
 *  short (< autoThreshold hits). Appends the results if the query is still the active one. */
function scheduleYoutubeSearch(query) {
  clearTimeout(ytSearchTimer);
  if (!youtubeOn() || !query.trim()) return;
  ytSearchTimer = setTimeout(async () => {
    const threshold = settings.get("youtube.autoThreshold") || 2;
    // 11 = the ⚙ slider's max = "always" → skip the local-count gate and always query YouTube.
    if (threshold < 11 && catalog.search(query, threshold).length >= threshold) return; // local already covers it
    let recs = [];
    try { recs = await youtubeSearch(query); } catch (_) { recs = []; }
    recs.forEach(registerYoutube);
    if ($("search").value !== query || recentMode || favoritesMode) return; // query moved on
    renderSearchResults(query, recs);
  }, settings.get("youtube.debounceMs") || 3000);
}

/** Re-render the plain search view: instant local results + a scheduled YouTube append. */
function runSearch(query) {
  renderSearchResults(query, null);
  scheduleYoutubeSearch(query);
}

/** Reflect the 🌐 pill's on/off/unsupported state. */
function updateYoutubeToggle() {
  const b = $("btn-youtube");
  if (b) {
    const supported = YouTubeEngine.supported;
    b.classList.toggle("active", youtubeOn());
    b.disabled = !supported;
    b.title = !supported
      ? "YouTube search needs a Chromium-based browser (credentialless iframes)"
      : (settings.get("youtube.enabled")
          ? "YouTube search ON — searches also query YouTube"
          : "Search YouTube for karaoke videos");
  }
  // keep the ⚙ checkbox in step when the pill is what changed the value
  const chk = $("set-youtube");
  if (chk) chk.checked = settings.get("youtube.enabled");
  // preload the YT IFrame API while enabled so the first play can autoplay (no activation loss)
  if (youtubeOn() && youtube) youtube.warm();
}

// ---------------------------------------------------------------------------
// Playback
// ---------------------------------------------------------------------------
async function ensureEngine() {
  if (audio.ready) return true;
  const overlay = $("overlay");
  overlay.classList.remove("hidden");
  try {
    await audio.init((msg, frac) => {
      $("overlay-msg").textContent = msg;
      $("overlay-bar").style.width = frac != null ? `${Math.round(frac * 100)}%` : "";
    }, settings.get("data.soundfontUrl"));
    applyAudioSettings();
    overlay.classList.add("hidden");
    return true;
  } catch (e) {
    $("overlay-msg").textContent = "Engine failed to start: " + e.message;
    console.error(e);
    return false;
  }
}

// Every play* function awaits a fetch (and, on the first song, the ~32 MB soundfont) BEFORE
// it writes the shared player state. Without a generation token the chain that resolves LAST
// wins even if it was requested first — so a double-click, or picking a second song during a
// cold start, can leave the title, lyrics and audio describing different songs. Each call
// takes a ticket; anything stale bails out at its next checkpoint instead of writing.
let playGen = 0;
const stalePlay = (gen) => gen !== playGen;
// True while a play* is between its first await and actually owning the stage. `armed` flips
// the instant a user picks a song, but on a COLD START `current` stays null for the seconds the
// ~32 MB soundfont takes — and the rAF idle branch reads exactly that gap as "nothing playing,
// something queued" and auto-advances. The user's double-clicked song then loses to whatever was
// in the queue. Found in a browser, not by a test: it needs a real soundfont load to reproduce.
let loadingSong = false;

// Dispatch on the song's kind: VIDEO songs take the (synth-free) video path; MIDI
// songs take the existing SpessaSynth path.
async function playNow(song, by = "") {
  const gen = ++playGen;
  loadingSong = true;   // suppress the idle auto-advance until this song owns the stage
  durations.arm();      // re-arm the song-length learner for the incoming song
  score.hideCard();     // a new song takes the stage back from the previous song's verdict
  armed = true; // the user has started playback → the idle queue auto-advance is allowed
  currentBy = by || ""; // who queued this song from the remote ("" for host-picked songs)
  pendingUnsyncedLines = null; // drop any pending audio-lyric distribution from a prior song
  try {
    if (song.kind === "youtube") return await playYoutube(song, gen);
    if (song.kind === "video") return await playVideo(song, gen);
    if (song.kind === "audio") return await playAudio(song, gen);
    return await playMidi(song, gen);
  } catch (e) {
    // A play* that throws (corrupt file, engine refusal) must not strand the stage.
    console.error("Playback failed:", e);
    if (!stalePlay(gen)) {
      setStatus(`Could not play "${song.name || song.code || "that song"}" — skipping.`);
      onSongFailed();
    }
  } finally {
    if (gen === playGen) loadingSong = false;   // a newer play owns the flag now
    // A song change is the one transition phones can't extrapolate through (their local
    // lyric clock has to re-base and their Lyrics tab refetches), so push the moment the
    // new song is loaded instead of waiting for the next ~1 s host tick.
    if (remoteHost) remoteHost.push();
  }
}

// Clear the MIDI-only stage surfaces (lyrics / guide / key / title card) without
// touching the now-playing header. Used when a VIDEO song takes over.
function hideMidiSurfaces() {
  clearTimeout(playDelayTimer);
  clearTimeout(tcTimer);
  lyrics.clear();
  $("lyric-badge").textContent = "";
  $("np-key").textContent = "";
  $("title-card").classList.remove("show");
  if (pitchGuide) pitchGuide.load({ hasMelody: false, notes: [], range: { min: 60, max: 72 } });
  if (midiMixer) midiMixer.clear();
  currentMelodyChannel = -1;
  lastParsed = null;
  currentKey = null;
  scorer = null;          // no MIDI note data → nothing to score against
  score.resetLineBonus();
}

// VIDEO song: no synth/soundfont, no lyric parsing. The picture fills the stage; the
// offset feature moves the audio (handled inside VideoEngine).
async function playVideo(song, gen = playGen) {
  audio.pause();            // silence the synth if a MIDI song was playing
  youtube.unload();         // stop any YouTube video that was playing
  audioFile.unload();       // …and any audio song
  document.body.classList.remove("youtube-mode");
  document.body.classList.remove("audio-mode");
  media = video;
  current = song;
  userPaused = false;
  autoAdvancing = false;
  document.body.classList.add("video-mode");
  hideMidiSurfaces();
  lib.setNowPlaying(song);
  pushRecent(song);
  $("np-title").textContent = song.name || "(untitled)";
  $("np-artist").textContent = song.artistName || "";
  $("np-code").textContent = npIcon(song.kind); // source icon instead of the dial number
  $("lyric-badge").textContent = "video";

  const url = Catalog.fileUrl(song);
  video.setOffset(settings.get("lyrics.offsetMs") || 0);
  video.setVolume(settings.get("audio.volume"));
  video.setTempo(settings.get("audio.tempo"));
  video.setKey(settings.get("audio.key")); // apply the current transpose to the video's audio
  video.load(url);
  setStatus(`Now playing: ${song.code} — ${song.name}`);
  await video.play();
  if (stalePlay(gen)) return;  // a newer song took over while the picture was loading
  setPlayIcon();
}

// Hide the NOTE-derived surfaces (pitch guide / chords / channel mixer) + reset note
// state, WITHOUT touching the lyric surface or the now-playing header. Used by the AUDIO
// path, which keeps the scrolling lyrics (from a sidecar) but has no MIDI note data.
function hideNoteSurfaces() {
  clearTimeout(playDelayTimer);
  clearTimeout(tcTimer);
  if (pitchGuide) pitchGuide.load({ hasMelody: false, notes: [], range: { min: 60, max: 72 } });
  if (chordEngine) chordEngine.clear();
  if (midiMixer) midiMixer.clear();
  currentMelodyChannel = -1;
  lastParsed = null;
  currentKey = null;
  scorer = null;          // no MIDI note data → nothing to score against
  score.resetLineBonus();
}

// AUDIO song: a recorded audio file + a separate lyric sidecar. Routed through WebAudio
// (AudioFileEngine) so the Key control pitch-shifts the audio in stereo and volume can
// exceed 100%. KEEPS the scrolling lyric surface (loaded from the sidecar); hides the
// note-derived surfaces (guide/chords/mixer) which need MIDI data. Offset moves the
// LYRIC time (handled in the rAF loop), not the audio.
async function playAudio(song, gen = playGen) {
  audio.pause();            // silence the synth if a MIDI song was playing
  video.unload();           // …and any video
  youtube.unload();         // …and any YouTube video
  document.body.classList.remove("video-mode");
  document.body.classList.remove("youtube-mode");
  media = audioFile;
  current = song;
  userPaused = false;
  autoAdvancing = false;
  document.body.classList.add("audio-mode");
  hideNoteSurfaces();       // guide/chords/mixer off; note state reset (lyrics kept)
  updateKeyDisplay();       // no detected key → blanks the badge (the ± stepper still shows the number)
  lib.setNowPlaying(song);
  pushRecent(song);
  $("np-title").textContent = song.name || "(untitled)";
  $("np-artist").textContent = song.artistName || "";
  $("np-code").textContent = npIcon(song.kind); // source icon instead of the dial number

  const url = Catalog.fileUrl(song);
  audioFile.setVolume(settings.get("audio.volume"));
  audioFile.setTempo(settings.get("audio.tempo"));
  audioFile.setKey(settings.get("audio.key"));
  await audioFile.load(url);   // fetch the audio into an in-memory blob (reliable load/seek)
  if (stalePlay(gen)) return;  // a newer song was picked while this one was downloading
  await loadAudioLyrics(song); // fetch + parse the sidecar into the lyric surface
  if (stalePlay(gen)) return;
  showTitleCard(song);
  setStatus(`Now playing: ${song.code || ""} ${song.name}`.trim());
  await audioFile.play();
  if (stalePlay(gen)) return;
  setPlayIcon();
}

// Load an AUDIO song's lyric sidecar into the LyricsEngine. Handles the timed text
// formats (.lrc/.vtt/.srt), plain .txt (unsynced → spread across the duration once known),
// and a lyrics-only .kar/.mid (reuse the SMF parser). A missing/failed sidecar is non-fatal.
async function loadAudioLyrics(song) {
  const badge = $("lyric-badge");
  const url = Catalog.lyricsUrl(song);
  if (!url) { lyrics.clear(); badge.textContent = "no lyrics"; return; }
  const ext = (song.lyrics.split(".").pop() || "").toLowerCase();
  try {
    if (ext === "kar" || ext === "mid" || ext === "midi") {
      const raw = await cachedArrayBuffer(url);   // may be raw-deflate compressed (like kar_raw)
      const parsed = parseMidi(toMidiBytes(raw).slice(0));
      badge.textContent = lyrics.load(parsed) ? "" : "no lyrics";
    } else {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`sidecar ${res.status}`);
      const { lines, synced } = linesFromLyricFile(ext, await res.text());
      if (!synced) {
        distributeLineTimes(lines, audioFile.duration); // duration may be 0 here → refined in tick
        pendingUnsyncedLines = lines;
      }
      badge.textContent = lyrics.loadLines(lines) ? (synced ? "" : "unsynced") : "no lyrics";
    }
  } catch (e) {
    console.warn("Lyric sidecar failed:", e);
    lyrics.clear();
    badge.textContent = "no lyrics";
  }
}

// (distributeLineTimes — unsynced-line pacing — now lives in lyrics-formats.js, shared
//  with the phone remote's Lyrics tab.)

// YOUTUBE song (BYOC): no synth/soundfont, no lyric parsing — the official YouTube IFrame
// player fills the stage. Mirrors playVideo. Offset/key/guide/auto-tune don't apply (the
// lyrics are baked into the video), so the MIDI-only surfaces stay hidden.
async function playYoutube(song, gen = playGen) {
  audio.pause();            // silence the synth if a MIDI song was playing
  video.unload();           // …and any video
  audioFile.unload();       // …and any audio song
  document.body.classList.remove("video-mode");
  document.body.classList.remove("audio-mode");
  media = youtube;
  current = song;
  userPaused = false;
  autoAdvancing = false;
  document.body.classList.add("youtube-mode");
  hideMidiSurfaces();
  registerYoutube(song);   // keep it resolvable for favorites/recent/queue across reloads
  lib.setNowPlaying(song);
  pushRecent(song);
  $("np-title").textContent = song.name || "(untitled)";
  $("np-artist").textContent = song.artistName || "";
  $("np-code").textContent = npIcon(song.kind); // source icon instead of the dial number
  $("lyric-badge").textContent = "youtube";

  youtube.setVolume(settings.get("audio.volume"));
  youtube.setTempo(settings.get("audio.tempo"));
  youtube.load(song.videoId);
  setStatus(`Now playing: ${song.name}`);
  await youtube.play();
  if (stalePlay(gen)) return;
  setPlayIcon();
}

// MIDI song: the original SpessaSynth path.
async function playMidi(song, gen = playGen) {
  if (!(await ensureEngine())) return;
  if (stalePlay(gen)) return;  // engine start is slow (32 MB soundfont) — a newer pick wins
  video.unload();          // stop any video that was playing
  youtube.unload();        // …and any YouTube video
  audioFile.unload();      // …and any audio song
  document.body.classList.remove("video-mode");
  document.body.classList.remove("youtube-mode");
  document.body.classList.remove("audio-mode");
  media = audio;
  current = song;
  userPaused = false;
  autoAdvancing = false;
  lib.setNowPlaying(song);
  setStatus(`Loading: ${song.code} — ${song.name}`);
  $("np-title").textContent = song.name || "(untitled)";
  $("np-artist").textContent = song.artistName || "";
  $("np-code").textContent = npIcon(song.kind); // source icon instead of the dial number

  const url = Catalog.fileUrl(song);
  let buf;
  try {
    const raw = await cachedArrayBuffer(url); // cache-first via Cache Storage
    if (stalePlay(gen)) return;
    buf = toMidiBytes(raw); // song files may be raw-deflate compressed
  } catch (e) {
    if (stalePlay(gen)) return;
    console.error(e);
    setStatus(`Could not read file for #${song.code}: ${e.message}`);
    onSongFailed();  // don't leave `current` pointing at a song that never loaded
    return;
  }

  let parsed = null;
  try {
    parsed = parseMidi(buf.slice(0));
    lastParsed = parsed;
    const hasLyrics = lyrics.load(parsed);
    $("lyric-badge").textContent = hasLyrics ? "" : "instrumental";
  } catch (e) {
    console.warn("Parse failed:", e);
    lyrics.clear();  // clear() empties the rendered lines; reset() only scrolls them
    $("lyric-badge").textContent = "no lyrics";
    lastParsed = null;
  }

  // Derived surfaces in their OWN try: a melody/chord/mixer failure must not roll back the
  // lyrics that already loaded successfully (they used to share one catch, so a late throw
  // discarded a good parse and left the previous song's lines on screen).
  if (parsed) {
    try {
      loadMelody(parsed);
      chordEngine.load(parsed);                            // detect chords (once, on load)
      chordEngine.setTranspose(settings.get("audio.key")); // reflect the current Key transpose
      midiMixer.load(parsed); // reset the channel mixer for the new song
    } catch (e) {
      console.warn("Chord/melody/mixer setup failed:", e);
      chordEngine.clear();
      midiMixer.clear();
    }
  } else {
    chordEngine.clear();
    midiMixer.clear();
  }

  // A file can pass the MThd check and still be rejected by the sequencer; without this the
  // throw escaped playNow entirely, leaving "Now playing" on screen over silence.
  try {
    audio.loadSong(buf);
  } catch (e) {
    console.error("Sequencer rejected the file:", e);
    setStatus(`#${song.code} looks corrupt — skipping.`);
    onSongFailed();
    return;
  }

  pushRecent(song);    // only once the song has actually loaded — a failed load isn't "played"
  showTitleCard(song); // title/artist/key over the lyrics, fades after titleCard.seconds
  setStatus(`Now playing: ${song.code} — ${song.name}`);

  // Start the music a fixed 1s before the title card disappears (if the card is on).
  clearTimeout(playDelayTimer);
  const tcSecs = settings.get("titleCard.seconds") || 0;
  const delayMs = tcSecs > 1 ? (tcSecs - 1) * 1000 : 0;
  const startPlayback = async () => {
    if (stalePlay(gen)) return;   // title-card hold outlived by a newer song pick
    await audio.play();
    setPlayIcon();
    setTimeout(applyGuideVocal, 350); // re-apply once the new song's channels are live
  };
  if (delayMs > 0) {
    audio.pause();  // hold the music at the start while the title card is up
    audio.seek(0);  // discard the brief auto-play residual so it starts from the top
    setPlayIcon();
    playDelayTimer = setTimeout(startPlayback, delayMs);
  } else {
    startPlayback();
  }
}

// ---------------------------------------------------------------------------
// rAF loop — lyric sync, pitch guide + scoring, auto-tune, seek bar, end-of-song
// ---------------------------------------------------------------------------
let endGuard = false, endTimer = null;
// End the current song: clear the stage (which also unloads the video / YouTube player, so
// YouTube never gets to paint its suggested-videos end screen) then advance the queue. Guarded
// so the rAF end-detection and YouTube's ENDED event can't both fire it.
function endOfSong() {
  if (endGuard) return;
  endGuard = true;
  // Close out scoring BEFORE clearStage(), which drops the song + singer the card needs.
  const res = score.finish(scorer, current, currentBy);
  recap.log(current, currentBy, res ? res.score : null);   // one line in tonight's recap
  score.resetLineBonus();
  clearStage();
  if (res) score.showCard(res);
  // Hold the stage while the score is up — the verdict is half the point of a videoke night,
  // and the next song's title card would otherwise land on top of it.
  const hold = res && settings.get("score.card") ? SCORE_CARD_MS : 700;
  endTimer = setTimeout(() => { endGuard = false; endTimer = null; advanceQueue(); }, hold);
}

// The ONE path for "move on to the next song now" — the ⏭ button, the phone's Next, and any
// failure. endGuard only ever protected endOfSong from itself, so a Next click inside the
// 700 ms hand-off window used to land a SECOND advanceQueue() and skip an extra song.
function skipCurrent() {
  clearTimeout(endTimer);
  endTimer = null;
  endGuard = false;
  score.hideCard();
  advanceQueue();
}

// A song that cannot play must not strand the stage: drop it and move on if anything is queued.
function onSongFailed() {
  current = null;
  clearStage();
  setPlayIcon();
  if (queue.length) skipCurrent();
}

// A missing or unreadable local file used to hang the night: the media element reports an
// error, duration stays 0, and the end-of-song check is gated on duration > 0 — so the stage
// sat blank and silent forever and the queue never advanced.
function onMediaError(kind, why) {
  if (!current) return;
  console.warn(`${kind} playback failed:`, why);
  setStatus(`Could not play "${current.name || current.code || "that song"}" — file missing or unreadable. Skipping.`);
  onSongFailed();
}

// True when the active engine has reached the end of the current song. MIDI is special: the
// sequencer stalls with `paused` false and the clock plateaued just short of duration, so it
// reports via `ended`; video/audio reach duration cleanly; YouTube fires its own onEnded.
function songHasEnded() {
  if (!current || !media) return false;
  const t = media.currentTime, d = media.duration;
  // MIDI. MEASURED IN A BROWSER, and it contradicts what §5.14 used to claim: at the natural
  // end the Sequencer BOTH pauses itself AND raises `isFinished`, with the clock landing
  // exactly on duration (paused:true, ended:true, t === d). So a `!paused` guard vetoes the
  // precise event it was meant to catch, and the queue never advances — the song just sits
  // there finished. Anchor on the CLOCK instead: a STALE `isFinished` left over from the
  // previous song (the thing that guard was protecting against) cannot fool us, because the
  // title-card hold parks the clock at 0 before the new song starts.
  if (media === audio) return !!audio.ended && t > 0.5;
  // Video/audio elements: `paused` here means the USER paused, so it still guards correctly.
  if (media.paused) return false;
  return d > 0 && t >= d - 0.15;
}
function tick() {
  setPlayIcon(); // keep the transport button mirroring the real play/pause state every frame
  updateStageBanner(); // singer + "up next" (last 20 s) — change-guarded, cheap
  if (current && media) {
    const isMidi = media === audio;
    const isAudioFile = media === audioFile;
    const t = media.currentTime;   // active-engine playback time
    const d = media.duration;

    // Lyric sync runs for MIDI *and* AUDIO songs — both show the scrolling lyric
    // surface (a VIDEO/YouTube song bakes the lyrics into the picture, so it's skipped).
    if (isMidi || isAudioFile) {
      const gt = t + (settings.get("lyrics.offsetMs") || 0) / 1000;
      lyrics.update(gt);
    }
    // Unsynced sidecar (.txt): once the real duration is known, spread the lines across it.
    if (isAudioFile && pendingUnsyncedLines && d > 0) {
      distributeLineTimes(pendingUnsyncedLines, d);
      lyrics.loadLines(pendingUnsyncedLines);
      pendingUnsyncedLines = null;
    }

    // MIDI-only stage work: pitch guide, chords, mixer, scoring, auto-tune (needs note data).
    if (isMidi) {
      const offset = (settings.get("lyrics.offsetMs") || 0) / 1000;
      const gt = t + offset;          // visual time — drives the guide AND chords
      if (settings.get("chords.enabled")) chordEngine.update(gt);

      // MIDI mode: paint the per-channel VU meters from the live audio levels.
      if (settings.get("midiMode.enabled")) midiMixer.update();

      // Live pitch detection is computed off-thread (mic worker); getPitchMidi() just
      // reads the cached value, so we can query it every frame.
      const guideOn = settings.get("guide.enabled");
      const autotuneOn = mic.enabled && settings.get("mic.autotune.enabled");
      const scoringOn = mic.enabled && settings.get("score.enabled") && !!scorer;
      const wantDetect = mic.enabled && (autotuneOn || scoringOn ||
        (guideOn && (settings.get("guide.showMic") || settings.get("guide.scoring"))));
      const micMidi = wantDetect ? mic.getPitchMidi() : null;

      // Feed the scorer every frame — including UNVOICED ones, which advance its clock but
      // score nothing (you have to be allowed to breathe). See scoring.js.
      if (scoringOn) {
        scorer.addFrame(gt, micMidi);
        score.lineBonus(scorer, lyrics);
      }

      if (guideOn) {
        if (settings.get("guide.scoring")) pitchGuide.setScore(scoringOn ? scorer.liveScore() : null);
        else pitchGuide.setScore(null);
        pitchGuide.update(gt, settings.get("guide.showMic") ? micMidi : null);
      }

      // Auto-tune: bend the voice toward the target note.
      if (autotuneOn) {
        if (micMidi != null) {
          const mode = settings.get("mic.autotune.mode");
          const target = mode === "melody" ? pitchGuide.targetNoteAt(gt) : null;
          let atKey = settings.get("mic.autotune.key");
          let atScale = settings.get("mic.autotune.scale");
          if (atKey === "auto") { atKey = currentKey ? currentKey.keyPc : 0; atScale = currentKey ? currentKey.mode : atScale; }
          else atKey = +atKey;
          const corrected = snapNote(micMidi, { mode, targetMidi: target, key: atKey, scale: atScale });
          // deadzone: if already within ~1/3 semitone of the target, don't correct —
          // leaves in-tune singing untouched (the main source of autotune artifacts).
          let err = corrected - micMidi;
          if (Math.abs(err) < 0.35) err = 0;
          let shift = Math.max(-7, Math.min(7, settings.get("mic.autotune.strength") * err));
          mic.setAutotuneShift(shift);
        } else {
          mic.setAutotuneShift(0);
        }
      } else if (mic.autotuneActive) {
        mic.clearAutotune();
      }
    }

    if (d > 0) {
      $("seekbar").style.width = `${Math.min(100, (t / d) * 100)}%`;
      $("time-cur").textContent = fmt(t);
      $("time-dur").textContent = fmt(d);
      durations.note(current, d);   // learn this song's length for the phones' queue ETA
    }
    // End-of-song detection lives in songHasEnded() so the hidden-tab watchdog below can
    // run the SAME predicate. Deliberately outside the `d > 0` block: a MIDI song reports
    // through `ended`, and gating on duration hid that case when duration never arrived.
    if (songHasEnded()) endOfSong();
  } else {
    if (mic.autotuneActive) mic.clearAutotune(); // release correction when nothing is playing
    // Nothing is playing and it wasn't a deliberate pause → play the next queued song.
    // (`armed` gates this to after the user has started playback, so a restored queue
    //  on a fresh load is NOT auto-played — there's no user gesture yet.)
    if (armed && !current && !loadingSong && !autoAdvancing && !userPaused && queue.length) {
      autoAdvancing = true;
      advanceQueue();
    }
  }
  requestAnimationFrame(tick);
}

// ---------------------------------------------------------------------------
// Transport / main UI + keyboard
// ---------------------------------------------------------------------------
function wireUI() {
  const search = $("search");
  const clearBtn = $("search-clear");
  const toggleClear = () => clearBtn.classList.toggle("show", !!search.value);
  let deb;
  search.oninput = () => {
    if (recentMode) setRecentMode(false);       // typing leaves the Recent view
    if (favoritesMode) setFavoritesMode(false); // …and the Favorites view
    toggleClear();
    const q = search.value;
    clearTimeout(deb);
    deb = setTimeout(() => renderSearchResults(q, null), 120); // instant local (drops any YouTube rows)
    scheduleYoutubeSearch(q); // append YouTube after a longer debounce, if enabled + local is sparse
  };
  clearBtn.onclick = () => {
    search.value = "";
    toggleClear();
    clearTimeout(ytSearchTimer);
    if (recentMode) setRecentMode(false);
    if (favoritesMode) setFavoritesMode(false);
    lib.renderList(catalog.search(""), EMPTY_LIBRARY);
    search.focus();
  };
  $("btn-recent").onclick = () => {
    setRecentMode(!recentMode);
    if (recentMode) showRecent();
    else runSearch(search.value); // back to the (search) list
  };
  $("btn-favorites").onclick = () => {
    setFavoritesMode(!favoritesMode);
    if (favoritesMode) showFavorites();
    else runSearch(search.value); // back to the (search) list
  };
  $("btn-youtube").onclick = () => {
    if (!YouTubeEngine.supported) {
      setStatus("YouTube search needs a Chromium-based browser (credentialless iframes).");
      return;
    }
    settings.set("youtube.enabled", !settings.get("youtube.enabled")); // onSettingChanged repaints + re-runs
  };

  // collapsible panels (playback-controls visibility is now a ⚙ → Display setting, not a
  // top-bar toggle — see ui.playback / applyControlsAutoHide). On mobile the list + queue
  // are mutually exclusive (toggleMobilePanel); on desktop they're independent settings.
  $("toggle-lib").onclick = () =>
    isMobileWidth() ? toggleMobilePanel("library") : settings.set("ui.library", !settings.get("ui.library"));
  $("toggle-queue").onclick = () =>
    isMobileWidth() ? toggleMobilePanel("queue") : settings.set("ui.queue", !settings.get("ui.queue"));

  // Full-screen toggle (top-right). Falls back silently if the browser refuses.
  const fsBtn = $("btn-fullscreen");
  if (fsBtn) {
    fsBtn.onclick = () => {
      if (document.fullscreenElement) document.exitFullscreen();
      else document.documentElement.requestFullscreen().catch(() => {});
    };
    document.addEventListener("fullscreenchange", () => {
      fsBtn.classList.toggle("active", !!document.fullscreenElement);
      fsBtn.title = document.fullscreenElement ? "Exit full screen" : "Full screen";
    });
  }

  // Focus mode — a distraction-free full-stage lyrics view (10-foot). Hides the browse +
  // queue panels; the topbar stays so you can exit (Esc also exits, and resize-to-mobile
  // forces it off since the ◎ button is hidden there). setFocus lives at module scope.
  const focusBtn = $("btn-focus");
  if (focusBtn) focusBtn.onclick = () => setFocus(!document.body.classList.contains("focus-mode"));
  ["mousemove", "touchstart", "keydown", "click"].forEach((ev) =>
    document.addEventListener(ev, () => { if (autoHideActive()) showControls(); }, { passive: true }));
  document.addEventListener("keydown", (e) => {
    // Esc leaves focus mode (unless a text field is focused — there Esc clears the field).
    // The settings drawer is modal and owns Escape while it's open (settings-ui.js closes it),
    // so one press must not also drop you out of focus mode.
    if (e.key !== "Escape") return;
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName || "");
    // Modals own Escape while they're up: one press must close the thing in front of you,
    // not drop you out of focus mode behind it.
    if (recap.isOpen()) { recap.hide(); return; }
    const modalOpen = document.body.classList.contains("settings-open");
    if (!typing && !modalOpen && document.body.classList.contains("focus-mode")) setFocus(false);
  });
  search.onkeydown = (e) => {
    if (e.key === "Enter") {
      const hits = catalog.search(search.value, 1);
      if (hits.length) playNow(hits[0]);
    } else if (e.key === "Escape") {
      clearBtn.onclick();
    }
  };

  $("btn-play").onclick = async () => {
    if (!current) {
      // Nothing loaded: play a song the user has actually picked (a selected row).
      // Do NOT fall back to the first library song — pressing play on a fresh load
      // with nothing selected should do nothing. (Enter in the search box still
      // plays the top hit — that's the "type + go" path.)
      const sel = lib.getSelectedSong();
      if (sel) return playNow(sel);
      return;
    }
    if (media === audio && !(await ensureEngine())) return;
    media.toggle();
    userPaused = media.paused; // pausing here is a deliberate hold (no auto-advance)
    setPlayIcon();
  };
  $("btn-next").onclick = () => skipCurrent();
  recap.wire();   // close button + click-the-scrim-to-dismiss

  // Hidden-tab watchdog. requestAnimationFrame is throttled to a crawl (or stopped) in a
  // background tab while the AudioContext keeps playing — so a song that ended while the host
  // was alt-tabbed never advanced the queue, which is the whole point of having one. A plain
  // interval keeps firing (a page playing audio is exempt from Chrome's intensive throttling),
  // and visibilitychange catches up the instant the tab comes back.
  setInterval(() => { if (songHasEnded()) endOfSong(); }, 1000);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && songHasEnded()) endOfSong();
  });
  // 🎵 melody toggle — flips the guide-vocal mute (melody channel audible on/off). Same setting
  // the ⚙ "Mute melody" checkbox and the phone remote drive, so all three stay in sync.
  $("btn-melody").onclick = () => settings.set("guide.vocal.mute", !settings.get("guide.vocal.mute"));
  $("btn-mic").onclick = toggleMic;

  // Bottom controls (persisted via settings)
  $("key-down").onclick = () => setKey(settings.get("audio.key") - 1);
  $("key-up").onclick = () => setKey(settings.get("audio.key") + 1);
  $("tempo-down").onclick = () => setTempoRate(settings.get("audio.tempo") - 0.05);
  $("tempo-up").onclick = () => setTempoRate(settings.get("audio.tempo") + 0.05);
  $("volume").oninput = (e) => settings.set("audio.volume", +e.target.value);

  $("seek-track").onclick = (e) => {
    if (!current || media.duration <= 0) return;
    const rect = e.currentTarget.getBoundingClientRect();
    media.seek(((e.clientX - rect.left) / rect.width) * media.duration);
  };

  document.onkeydown = (e) => {
    if (e.target.tagName === "INPUT") return;
    // A focused song row owns its own keys (Space selects, Enter plays, ＋ queues — see the
    // roving tabindex in library-ui.js). Without this, Space would BOTH select the row and
    // toggle the transport.
    if (e.target.closest && e.target.closest(".song")) return;
    if (e.code === "Space") { e.preventDefault(); $("btn-play").click(); }
    else if (e.key === "[") nudgeOffset(-50);
    else if (e.key === "]") nudgeOffset(50);
  };

  // reflect persisted bottom-control values
  updateMelodyToggle();
  $("tempo-val").textContent = `${(+settings.get("audio.tempo")).toFixed(2)}×`;
  $("volume").value = settings.get("audio.volume");
  $("key-val").textContent = fmtKey(settings.get("audio.key"));
  updateYoutubeToggle(); // reflect the persisted 🌐 toggle + browser support
}

// Single mic enable/disable path shared by BOTH the transport 🎙 button and the ⚙ panel
// button (passed in as onToggleMic), so the Bluetooth-mode guard can't diverge between them.
async function toggleMic() {
  if (settings.get("bt.enabled")) return; // mic is disabled in Bluetooth mode
  $("mic-status").textContent = mic.enabled ? "Stopping…" : "Requesting microphone…";
  if (mic.enabled) mic.disable();
  else await mic.enable();
  settingsUI.updateMicBtn();
  updateMicToggle();
}

function setKey(semi) {
  semi = Math.max(-12, Math.min(12, semi));
  settings.set("audio.key", semi);
  $("key-val").textContent = fmtKey(semi);
  updateKeyDisplay();
}

function setTempoRate(rate) {
  rate = Math.round(Math.max(0.5, Math.min(1.5, rate)) * 100) / 100; // clamp 0.5–1.5, avoid fp drift
  settings.set("audio.tempo", rate);
  $("tempo-val").textContent = `${rate.toFixed(2)}×`;
}

function nudgeOffset(delta) {
  const v = Math.max(-2000, Math.min(2000, (settings.get("lyrics.offsetMs") || 0) + delta));
  settings.set("lyrics.offsetMs", v);
  $("set-offset").value = v;
  $("set-offset-val").textContent = `${v} ms`;
  showOffsetToast(v);
}

let toastTimer;
function showOffsetToast(v) {
  const el = $("offset-toast");
  el.textContent = `Lyrics offset ${v > 0 ? "+" : ""}${v} ms`;
  el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), 900);
}

// Title card: title + artist + key over the lyrics area for `titleCard.seconds`,
// then fades to the lyrics (0 s = disabled).
let tcTimer;
function showTitleCard(song) {
  const tc = $("title-card");
  clearTimeout(tcTimer);
  const secs = settings.get("titleCard.seconds") || 0;
  if (secs <= 0) { tc.classList.remove("show"); return; }
  $("tc-title").textContent = song.name || "";
  $("tc-artist").textContent = song.artistName || "";
  $("tc-singer").textContent = currentBy ? `🎤 ${currentBy}` : ""; // who queued it (remote only)
  $("tc-key").textContent = currentKey && currentKey.source !== "none" && settings.get("key.showBadge")
    ? keyName(currentKey.keyPc, currentKey.mode) : "";
  tc.classList.add("show");
  fitTitleCard(); // auto-size the title to fill the card without truncating
  tcTimer = setTimeout(() => tc.classList.remove("show"), secs * 1000);
}

// Grow the title to the largest font that still fits the whole title card (title + artist +
// singer + key), so it fills the ~50vh card's vertical space without ever truncating. Binary
// search on px; checks BOTH dimensions (a big short title must not overflow the width either).
function fitTitleCard() {
  const card = $("title-card"), title = $("tc-title");
  if (!card || !title || !title.textContent || !card.classList.contains("show")) return;
  const st = title.style;
  const fits = () => card.scrollHeight <= card.clientHeight && card.scrollWidth <= card.clientWidth;
  let lo = 14, hi = Math.min(240, Math.round(card.clientHeight));
  st.fontSize = hi + "px";
  if (!fits()) {
    for (let i = 0; i < 16; i++) {
      const mid = (lo + hi) / 2;
      st.fontSize = mid + "px";
      if (fits()) lo = mid; else hi = mid;
    }
    st.fontSize = Math.floor(lo) + "px";
  }
}

// Singer + "up next" banner above the melody guide. Shows the current singer (only when the
// playing song was queued from the remote) and, in the last 20 s, the next queued song + singer.
// Change-guarded so it's cheap to call every frame from the rAF loop.
let _bannerNow = null, _bannerUp = null, _queueCount = null;
function updateStageBanner() {
  const nowEl = $("now-singer"), upEl = $("up-next");
  if (!nowEl || !upEl) return;
  const nowText = current && currentBy ? `🎤 ${currentBy}` : "";
  if (nowText !== _bannerNow) { nowEl.textContent = nowText; _bannerNow = nowText; }
  // Queued-song count chip (far right of the bar): "⏭ N", hidden when empty (:empty in CSS).
  const qEl = $("queue-count");
  if (qEl) {
    const qText = queue.length ? `⏭ ${queue.length}` : "";
    if (qText !== _queueCount) { qEl.textContent = qText; _queueCount = qText; }
  }
  let upName = "", upWho = "";
  if (current && media && media.duration > 0 && queue.length) {
    const remaining = media.duration - media.currentTime;
    if (remaining > 0 && remaining <= 20) {
      upName = queue.list[0].name || "(untitled)";
      upWho = queue.listBy[0] || "";
    }
  }
  const upKey = upName ? `${upName}|${upWho}` : "";
  if (upKey !== _bannerUp) {
    _bannerUp = upKey;
    upEl.textContent = "";
    if (upName) {
      // Pill = a mono "⏭ Up next" eyebrow + the song + (if phone-queued) the next singer.
      // Built as spans (text nodes, no innerHTML).
      const lab = document.createElement("span"); lab.className = "up-lb"; lab.textContent = "⏭ Up next";
      const sp = document.createElement("span"); sp.className = "up-song"; sp.textContent = upName;
      upEl.append(lab, sp);
      if (upWho) {
        const wh = document.createElement("span"); wh.className = "up-by"; wh.textContent = `🎤 ${upWho}`;
        upEl.append(wh);
      }
    }
  }
}

// Blank the stage (between songs / when nothing is playing).
function clearStage() {
  currentBy = "";              // no singer once playback stops → the banner clears via updateStageBanner
  $("np-title").textContent = "Select a song to begin";
  $("np-artist").textContent = "";
  $("np-code").textContent = ""; // nothing playing → no source icon
  $("np-key").textContent = "";
  $("lyric-badge").textContent = "";
  lyrics.clear();
  if (chordEngine) chordEngine.clear();
  if (pitchGuide) pitchGuide.load({ hasMelody: false, notes: [], range: { min: 60, max: 72 } });
  if (midiMixer) midiMixer.clear();
  $("seekbar").style.width = "0%";
  $("time-cur").textContent = "0:00"; $("time-dur").textContent = "0:00";
  $("title-card").classList.remove("show");
  document.body.classList.remove("video-mode"); // leave the clean video stage
  document.body.classList.remove("youtube-mode");
  document.body.classList.remove("audio-mode");
  pendingUnsyncedLines = null;
  if (video) video.unload();
  if (youtube) youtube.unload();
  if (audioFile) audioFile.unload();
  if (lib) lib.setNowPlaying(null);
}

// Mic toggle button in the transport row (mirrors the settings mic button).
function updateMicToggle() {
  const b = $("btn-mic");
  if (!b) return;
  const btOn = settings.get("bt.enabled");
  b.classList.toggle("on", mic.enabled);
  b.disabled = btOn;
  b.title = btOn ? "Microphone disabled in Bluetooth mode" : "Microphone on/off";
}

// 🎵 melody toggle state — lit when the melody guide vocal is audible (not muted).
function updateMelodyToggle() {
  const b = $("btn-melody");
  if (!b) return;
  const on = !settings.get("guide.vocal.mute");
  b.classList.toggle("on", on);
  b.title = on ? "Melody guide: on (click to mute)" : "Melody guide: off (click to unmute)";
}

// Rebuild catalog.json from kar_raw/ (called by the settings-ui button).
async function onRebuild() {
  const res = await (await fetch("/api/rebuild-catalog", { method: "POST" })).json();
  if (!res.ok) return { ok: false, error: res.error };
  const n = await catalog.load(settings.get("data.catalogUrl"), settings.get("data.videoCatalogUrl"), settings.get("data.audioCatalogUrl"));
  lib.renderList(catalog.search($("search").value), EMPTY_LIBRARY);
  setStatus(`${n.toLocaleString()} songs loaded`);
  return { ok: true, records: n };
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------
function toMidiBytes(arrayBuffer) {
  const u8 = new Uint8Array(arrayBuffer);
  if (u8[0] === 0x4d && u8[1] === 0x54 && u8[2] === 0x68 && u8[3] === 0x64) return arrayBuffer;
  if (!window.pako) throw new Error("pako not loaded (needed to decompress)");
  const inflated = window.pako.inflateRaw(u8);
  return inflated.buffer.slice(inflated.byteOffset, inflated.byteOffset + inflated.byteLength);
}

function setStatus(msg) { $("status").textContent = msg; }
// Reflects the *real* playback state. A MIDI song at its stalled end reports
// paused===false (§5.14) while nothing is actually sounding, so treat `audio.ended`
// as stopped too. Only writes on change so it's cheap to call every rAF frame.
function setPlayIcon() {
  const playing = !media.paused && !(media === audio && audio.ended);
  const href = playing ? "#i-pause" : "#i-play";
  const el = $("play-icon");   // the <use> inside the play button's sprite icon
  if (el && el.getAttribute("href") !== href) el.setAttribute("href", href);
}
function fmtKey(s) { return (s > 0 ? "+" : "") + s; }
function fmt(s) { s = Math.max(0, s | 0); return `${(s / 60) | 0}:${String(s % 60).padStart(2, "0")}`; }

boot();
