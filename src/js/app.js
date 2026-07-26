/*
 * app.js — the player / orchestrator.
 *
 * Owns playback (queue, current song, load → synth + lyrics + guide), the
 * requestAnimationFrame loop (lyric sync, pitch guide, scoring, auto-tune), the
 * transport controls, and the "settings → app" glue (what each setting change
 * actually does). The two big UI surfaces are delegated:
 *   - library-ui.js  : song list, search results, queue rendering
 *   - settings-ui.js : the ⚙ panel (control ↔ Settings wiring)
 * Everything else (audio, lyrics, melody/key, mic, bgv, settings store) lives in
 * its own module; this file wires them together.
 */

import { Catalog } from "./catalog.js";
import { AudioEngine } from "./audio.js";
import { VideoEngine } from "./video.js";
import { YouTubeEngine } from "./youtube.js";
import { AudioFileEngine } from "./audiofile.js";
import { parseMidi, LyricsEngine, buildLines, makeTickToSeconds } from "./lyrics.js";
import { linesFromLyricFile } from "./lyrics-formats.js";
import { ChordEngine } from "./chords.js";
import { Settings } from "./settings.js";
import { BackgroundVideo } from "./bgv.js";
import { MicEngine } from "./mic.js";
import { extractMelody, PitchGuide, snapNote, detectKey, keyName } from "./melody.js";
import { createLibraryUI } from "./library-ui.js";
import { createSettingsUI } from "./settings-ui.js";
import { createMidiMixer } from "./midi-mixer.js";
import { createRemoteHost, pickRemoteBaseUrl } from "./remote-host.js";
import { cachedArrayBuffer, purgeStaleCaches } from "./asset-cache.js";

const $ = (id) => document.getElementById(id);
// Source-kind icon shown in the now-playing header (in place of the dial number).
const NP_ICON = { midi: "🎤", video: "🎞️", youtube: "🌐", audio: "🎵" };
const npIcon = (kind) => NP_ICON[kind] || "🎵";

// --- singletons -------------------------------------------------------------
const settings = new Settings();
const catalog = new Catalog();
const audio = new AudioEngine();
let lyrics, bgv, mic, pitchGuide, video, youtube, chordEngine, audioFile; // created at boot (need the DOM)
let lib, settingsUI, midiMixer;  // UI modules (created at boot)

let remoteHost;                  // host↔phone relay driver (created at boot)

// --- mutable player state ---------------------------------------------------
let queue = [];
let queueBy = [];                // parallel to `queue`: who queued each song (phone nickname, or "")
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
let scoreHit = 0, scoreVoiced = 0;

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
async function boot() {
  purgeStaleCaches(); // drop the old service-worker cache; keep our asset cache

  lyrics = new LyricsEngine($("lyrics"), {
    lineCount: settings.get("lyrics.lineCount"),
    smooth: settings.get("lyrics.smooth"),
    mergeLines: settings.get("lyrics.mergeLines"),
  });
  bgv = new BackgroundVideo($("bgv"), settings);
  mic = new MicEngine(audio, settings);
  pitchGuide = new PitchGuide($("pitch-guide"), settings);
  chordEngine = new ChordEngine($("chords"), { simplify: settings.get("chords.simplify") });
  video = new VideoEngine($("kv"), $("kva"), audio); // VIDEO-song playback (picture + offset audio; key-shift via shared chain)
  youtube = new YouTubeEngine($("ytplayer")); // YOUTUBE-song playback (credentialless iframe)
  audioFile = new AudioFileEngine($("kaudio"), audio); // AUDIO-song playback (WebAudio + pitch-shift)
  youtube.onState = () => { if (media === youtube) setPlayIcon(); }; // keep transport icon in sync with YT state
  youtube.onEnded = () => { if (media === youtube) endOfSong(); };   // unload on end → no suggested-videos screen
  youtube.onError = (code) => onYoutubeError(code);                  // embed-blocked/unavailable → skip + remember

  lib = createLibraryUI({
    onPlay: playNow, onQueue: enqueue, onRemoveFromQueue: removeFromQueue,
    onToggleFavorite: toggleFavorite, isFavorite,
  });
  settingsUI = createSettingsUI({ settings, mic, onRebuild });
  midiMixer = createMidiMixer({ container: $("midi-mixer"), audio });
  remoteHost = createRemoteHost({ getSnapshot: remoteSnapshot, applyCommand: applyRemoteCommand });
  mic.onStatus = (m) => { $("mic-status").textContent = m; settingsUI.updateMicBtn(); updateMicToggle(); };

  applyVisualSettings();
  applyGuideSettings();
  applyChordSettings();
  applyMidiMode();
  applyRemoteMode();
  applyScreenProfile();  // set the display-size profile before first paint of the list/guide
  applyTheme();          // color theme: dark / light / auto (follows the OS)
  settingsUI.syncSettingsUI();
  applyBluetoothMode();
  applyUiCollapse();
  bgv.init();

  try {
    const n = await catalog.load(settings.get("data.catalogUrl"), settings.get("data.videoCatalogUrl"), settings.get("data.audioCatalogUrl"));
    setStatus(`${n.toLocaleString()} songs loaded — pick one to begin`);
    loadYoutubeCache(); // re-register persisted YouTube songs so favorites/recent/queue resolve them
    loadBlockedYoutube(); // hide videos that previously failed to embed
    if (settings.get("youtube.enabled") && blockedYoutube.size) reportBlockedToServer([...blockedYoutube]); // seed the shared list
    loadFavorites(); // restore starred songs (resolved by id) before the first render
    lib.renderList(catalog.search(""));
    loadSession(); // restore queue + recently-played (no auto-play)
  } catch (e) {
    setStatus("Failed to load catalog.json — is the server running from the project root?");
    console.error(e);
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
  if (path === "*" || path.startsWith("bgv.")) bgv.applySettings();
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
  if (path === "*" || path.startsWith("ui.")) applyUiCollapse();
  if (path === "*" || path === "ui.screen") applyScreenProfile();
  if (path === "*" || path === "ui.theme") applyTheme();
  if (path === "*") settingsUI.syncSettingsUI();
}

// Collapsible panels (song list / queue / playback controls), toggled from the top bar.
// Display-size profile — scales the whole player for readability across phone / tablet /
// computer / TV. "auto" derives it from the window width (live on resize); an explicit choice
// forces it. Sets <html data-screen>, then re-measures the virtual list (row height changes via
// the --row-h var) + the pitch-guide canvas. Big screens (~1800px+) read as "tv" by default.
const SCREEN_PROFILES = new Set(["phone", "tablet", "computer", "tv"]);
// Breakpoints aligned with the layout @media queries (560 / 900) so scaling + layout switch
// together; ≥1800 reads as "tv" (big text) by default — override to "computer" for a big monitor.
function detectScreen() {
  const w = window.innerWidth || 1280;
  if (w < 560) return "phone";
  if (w < 900) return "tablet";
  if (w < 1800) return "computer";
  return "tv";
}
function applyScreenProfile() {
  const pref = settings.get("ui.screen");
  const profile = SCREEN_PROFILES.has(pref) ? pref : detectScreen();
  const el = document.documentElement;
  if (el.dataset.screen === profile) return; // no change → nothing to re-measure
  el.dataset.screen = profile;
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
// Re-evaluate the auto profile as the window crosses a breakpoint (debounced); also re-fit
// the title card, whose 50vh height (and so its title size) changes with the viewport.
let _screenResizeTimer;
window.addEventListener("resize", () => {
  clearTimeout(_screenResizeTimer);
  _screenResizeTimer = setTimeout(() => { applyScreenProfile(); fitTitleCard(); }, 150);
});

function applyUiCollapse() {
  const libOpen = settings.get("ui.library");
  const qOpen = settings.get("ui.queue");
  const pbOpen = settings.get("ui.playback");
  document.body.classList.toggle("lib-collapsed", !libOpen);
  document.body.classList.toggle("queue-collapsed", !qOpen);
  document.body.classList.toggle("pb-collapsed", !pbOpen);
  $("toggle-lib").classList.toggle("active", libOpen);
  $("toggle-queue").classList.toggle("active", qOpen);
  $("toggle-playback").classList.toggle("active", pbOpen);
  // panels that regained size need a re-render / resize
  requestAnimationFrame(() => {
    if (libOpen && lib) lib.refresh();
    if (pitchGuide) pitchGuide.resize();
  });
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
  } catch (e) {
    console.warn("melody extract failed:", e);
    pitchGuide.load({ hasMelody: false, notes: [], range: { min: 60, max: 72 } });
  }
  scoreHit = 0; scoreVoiced = 0;
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
// `queueBy` runs parallel to `queue` — index i holds who queued queue[i] (a phone
// nickname, or "" for a host-added song). Every queue mutation keeps them in lockstep.
function enqueue(song, by = "") {
  queue.push(song);
  queueBy.push(by);
  lib.renderQueue(queue, queueBy);
  saveSession();
  if (remoteHost) remoteHost.push();
  if (!current) advanceQueue();
}
function removeFromQueue(i) {
  queue.splice(i, 1);
  queueBy.splice(i, 1);
  lib.renderQueue(queue, queueBy);
  saveSession();
  if (remoteHost) remoteHost.push();
}
// Move a queued song from one position to another (used by the phone remote's reorder).
function reorderQueue(from, to) {
  if (from < 0 || from >= queue.length || to < 0 || to >= queue.length || from === to) return;
  const [s] = queue.splice(from, 1); queue.splice(to, 0, s);
  const [b] = queueBy.splice(from, 1); queueBy.splice(to, 0, b);
  lib.renderQueue(queue, queueBy);
  saveSession();
  if (remoteHost) remoteHost.push();
}
function advanceQueue() {
  const next = queue.shift();
  const by = queueBy.shift() || "";  // keep the attribution array in lockstep + carry it to the singer banner
  lib.renderQueue(queue, queueBy);
  saveSession();
  if (remoteHost) remoteHost.push();
  if (next) playNow(next, by);
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
// arbitrary path off the network.
const REMOTE_SETTABLE = new Set([
  "lyrics.offsetMs", "audio.key", "audio.tempo", "audio.volume",
  "guide.vocal.mute",
]);

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
  if (!on) { box.classList.remove("show"); return; }
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
  box.classList.add("show");
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
  } : null;
  const q = queue.map((s, i) => ({
    id: s.id, name: s.name || "", artist: s.artistName || "",
    kind: s.kind, code: s.code || "", by: queueBy[i] || "",
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

// Apply one guest command (already validated server-side to a known type).
function applyRemoteCommand(cmd) {
  switch (cmd.type) {
    case "enqueue": {
      const song = remoteResolveSong(cmd);
      if (song) enqueue(song, String(cmd.by || "").slice(0, 24));
      break;
    }
    case "remove":
      if (Number.isInteger(cmd.index)) removeFromQueue(cmd.index);
      break;
    case "reorder":
      if (Number.isInteger(cmd.from) && Number.isInteger(cmd.to)) reorderQueue(cmd.from, cmd.to);
      break;
    case "play":  remotePlay();  break;
    case "pause": remotePause(); break;
    case "next":  advanceQueue(); break;
    case "seek":
      if (current && media.duration > 0 && typeof cmd.position === "number")
        media.seek(Math.max(0, Math.min(media.duration, cmd.position)));
      break;
    case "volume":
      if (typeof cmd.value === "number") setRemoteVolume(cmd.value);
      break;
    case "setting":
      if (typeof cmd.path === "string" && REMOTE_SETTABLE.has(cmd.path)) {
        settings.set(cmd.path, cmd.value);   // → onSettingChanged fans it out
        settingsUI.syncSettingsUI();          // refresh the ⚙ panel controls
        syncTransportLabels();                // …and the bottom key/tempo/volume labels
      }
      break;
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
const SESSION_KEY = "karaeoke.session.v1";

// Resolve a stored reference to a song. New format = stable id ("midi:5"/"video:5");
// old sessions stored a bare numeric code → treat as a MIDI code (back-compat).
function resolveSong(ref) {
  return (typeof ref === "string" && ref.includes(":")) ? catalog.getById(ref) : catalog.get(ref);
}

function saveSession() {
  try {
    localStorage.setItem(SESSION_KEY, JSON.stringify({ queue: queue.map((s) => s.id), recent }));
  } catch (_) {}
  saveYoutubeCache(); // keep the YouTube pointer cache in step with the queue/recent
}
function loadSession() {
  let data;
  try { data = JSON.parse(localStorage.getItem(SESSION_KEY) || "null"); } catch (_) {}
  if (!data) return;
  recent = (Array.isArray(data.recent) ? data.recent : [])
    .map(resolveSong).filter(Boolean).map((s) => s.id);
  const q = (data.queue || []).map(resolveSong).filter(Boolean);
  if (q.length) { queue = q; queueBy = q.map(() => ""); lib.renderQueue(queue, queueBy); }
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
  lib.renderList(songs);
  setStatus(songs.length ? `${songs.length} recently played` : "no recent songs yet");
}

// ---------------------------------------------------------------------------
// Favorites — starred songs, persisted separately from the session (localStorage).
// Stored as an array of stable ids so KAR/VID are unambiguous (§5.10); old bare
// codes resolve as MIDI via resolveSong (same back-compat as the queue/recent).
// ---------------------------------------------------------------------------
const FAVORITES_KEY = "karaeoke.favorites.v1";

function loadFavorites() {
  let data;
  try { data = JSON.parse(localStorage.getItem(FAVORITES_KEY) || "null"); } catch (_) {}
  const ids = (Array.isArray(data) ? data : []).map(resolveSong).filter(Boolean).map((s) => s.id);
  favorites = new Set(ids);
}
function saveFavorites() {
  try { localStorage.setItem(FAVORITES_KEY, JSON.stringify([...favorites])); } catch (_) {}
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
  lib.renderList(songs);
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
const YOUTUBE_KEY = "karaeoke.youtube.v1";
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
  let data;
  try { data = JSON.parse(localStorage.getItem(YOUTUBE_KEY) || "null"); } catch (_) {}
  if (data && typeof data === "object") {
    for (const rec of Object.values(data)) {
      if (rec && rec.id && rec.kind === "youtube") registerYoutube(rec);
    }
  }
}
/** Persist only the YouTube records still referenced by a favorite / the queue / recent. */
function saveYoutubeCache() {
  const keep = new Set([...favorites, ...queue.map((s) => s.id), ...recent]);
  const obj = {};
  for (const id of keep) {
    const rec = youtubeCache.get(id);
    if (rec && rec.kind === "youtube") obj[id] = rec;
  }
  try { localStorage.setItem(YOUTUBE_KEY, JSON.stringify(obj)); } catch (_) {}
}

// A persistent blocklist of YouTube videoIds that failed to embed (owner-disabled / removed /
// private). We hide them from future search results and skip past them, so a dead video never
// shows up again. Stored as a plain id array, independent of the pointer cache above.
const YOUTUBE_BLOCKED_KEY = "karaeoke.youtube.blocked.v1";
const blockedYoutube = new Set();

function loadBlockedYoutube() {
  try {
    const a = JSON.parse(localStorage.getItem(YOUTUBE_BLOCKED_KEY) || "[]");
    if (Array.isArray(a)) a.forEach((id) => id && blockedYoutube.add(id));
  } catch (_) {}
}
function blockYoutube(videoId) {
  if (!videoId || blockedYoutube.has(videoId)) return;
  blockedYoutube.add(videoId);
  try { localStorage.setItem(YOUTUBE_BLOCKED_KEY, JSON.stringify([...blockedYoutube])); } catch (_) {}
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
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ q }),
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
  if (queue.length) return advanceQueue();
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
  lib.renderList(ytRecords && ytRecords.length ? [...local, ...ytRecords] : local);
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

// Dispatch on the song's kind: VIDEO songs take the (synth-free) video path; MIDI
// songs take the existing SpessaSynth path.
async function playNow(song, by = "") {
  armed = true; // the user has started playback → the idle queue auto-advance is allowed
  currentBy = by || ""; // who queued this song from the remote ("" for host-picked songs)
  pendingUnsyncedLines = null; // drop any pending audio-lyric distribution from a prior song
  if (song.kind === "youtube") return playYoutube(song);
  if (song.kind === "video") return playVideo(song);
  if (song.kind === "audio") return playAudio(song);
  return playMidi(song);
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
}

// VIDEO song: no synth/soundfont, no lyric parsing. The picture fills the stage; the
// offset feature moves the audio (handled inside VideoEngine).
async function playVideo(song) {
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
  bgv.onSongStart();
  setStatus(`Now playing: ${song.code} — ${song.name}`);
  await video.play();
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
}

// AUDIO song: a recorded audio file + a separate lyric sidecar. Routed through WebAudio
// (AudioFileEngine) so the Key control pitch-shifts the audio in stereo and volume can
// exceed 100%. KEEPS the scrolling lyric surface (loaded from the sidecar); hides the
// note-derived surfaces (guide/chords/mixer) which need MIDI data. Offset moves the
// LYRIC time (handled in the rAF loop), not the audio.
async function playAudio(song) {
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
  await loadAudioLyrics(song); // fetch + parse the sidecar into the lyric surface
  bgv.onSongStart();
  showTitleCard(song);
  setStatus(`Now playing: ${song.code || ""} ${song.name}`.trim());
  await audioFile.play();
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

// Spread unsynced lyric lines evenly across the song (a small lead-in, then paced to
// the end) so a plain-text sidecar still scrolls. Falls back to ~1s/line if no duration.
function distributeLineTimes(lines, duration) {
  const n = lines.length;
  if (!n) return;
  const d = duration && isFinite(duration) && duration > 0 ? duration : n;
  const lead = Math.min(3, d * 0.05);
  const span = Math.max(0, d - lead);
  for (let i = 0; i < n; i++) {
    const t = lead + (i / n) * span;
    lines[i].start = t;
    lines[i].end = t;
    if (lines[i].syllables[0]) lines[i].syllables[0].time = t;
  }
}

// YOUTUBE song (BYOC): no synth/soundfont, no lyric parsing — the official YouTube IFrame
// player fills the stage. Mirrors playVideo. Offset/key/guide/auto-tune don't apply (the
// lyrics are baked into the video), so the MIDI-only surfaces stay hidden.
async function playYoutube(song) {
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
  bgv.onSongStart();
  setStatus(`Now playing: ${song.name}`);
  await youtube.play();
  setPlayIcon();
}

// MIDI song: the original SpessaSynth path.
async function playMidi(song) {
  if (!(await ensureEngine())) return;
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
  pushRecent(song);
  setStatus(`Loading: ${song.code} — ${song.name}`);
  $("np-title").textContent = song.name || "(untitled)";
  $("np-artist").textContent = song.artistName || "";
  $("np-code").textContent = npIcon(song.kind); // source icon instead of the dial number

  const url = Catalog.fileUrl(song);
  let buf;
  try {
    const raw = await cachedArrayBuffer(url); // cache-first via Cache Storage
    buf = toMidiBytes(raw); // song files may be raw-deflate compressed
  } catch (e) {
    setStatus(`Could not read file for #${song.code}: ${e.message}`);
    console.error(e);
    return;
  }

  try {
    const parsed = parseMidi(buf.slice(0));
    lastParsed = parsed;
    const hasLyrics = lyrics.load(parsed);
    $("lyric-badge").textContent = hasLyrics ? "" : "instrumental";
    loadMelody(parsed);
    chordEngine.load(parsed);                            // detect chords (once, on load)
    chordEngine.setTranspose(settings.get("audio.key")); // reflect the current Key transpose
    midiMixer.load(parsed); // reset the channel mixer for the new song
  } catch (e) {
    console.warn("Parse failed:", e);
    lyrics.lines = []; lyrics.hasLyrics = false; lyrics.reset();
    chordEngine.clear();
    lastParsed = null;
    midiMixer.clear();
  }

  audio.loadSong(buf);
  bgv.onSongStart();
  showTitleCard(song); // title/artist/key over the lyrics, fades after titleCard.seconds
  setStatus(`Now playing: ${song.code} — ${song.name}`);

  // Start the music a fixed 1s before the title card disappears (if the card is on).
  clearTimeout(playDelayTimer);
  const tcSecs = settings.get("titleCard.seconds") || 0;
  const delayMs = tcSecs > 1 ? (tcSecs - 1) * 1000 : 0;
  const startPlayback = async () => {
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
let endGuard = false;
// End the current song: clear the stage (which also unloads the video / YouTube player, so
// YouTube never gets to paint its suggested-videos end screen) then advance the queue. Guarded
// so the rAF end-detection and YouTube's ENDED event can't both fire it.
function endOfSong() {
  if (endGuard) return;
  endGuard = true;
  clearStage();
  setTimeout(() => { endGuard = false; advanceQueue(); }, 700);
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
      const wantDetect = mic.enabled && (autotuneOn ||
        (guideOn && (settings.get("guide.showMic") || settings.get("guide.scoring"))));
      const micMidi = wantDetect ? mic.getPitchMidi() : null;

      if (guideOn) {
        if (settings.get("guide.scoring") && micMidi != null) {
          scoreVoiced++;
          const tgt = pitchGuide.targetNoteAt(gt);
          if (tgt != null && pcDist(micMidi, tgt) < 1.5) scoreHit++;
          pitchGuide.setScore(scoreVoiced ? (scoreHit / scoreVoiced) * 100 : 0);
        } else if (!settings.get("guide.scoring")) {
          pitchGuide.setScore(null);
        }
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
      // MIDI: the sequencer stalls at the end (paused stays false, clock plateaus
      // short of duration) so rely on its `ended` flag; video reaches duration
      // cleanly; YouTube ends via its own onEnded callback. The `!media.paused`
      // guard is essential: seq.play() clears `isFinished`, so an unpaused song can
      // never show a stale end flag left over from the previous song's title-card hold.
      if (!media.paused && ((isMidi && audio.ended) || t >= d - 0.15)) endOfSong();
    }
  } else {
    if (mic.autotuneActive) mic.clearAutotune(); // release correction when nothing is playing
    // Nothing is playing and it wasn't a deliberate pause → play the next queued song.
    // (`armed` gates this to after the user has started playback, so a restored queue
    //  on a fresh load is NOT auto-played — there's no user gesture yet.)
    if (armed && !current && !autoAdvancing && !userPaused && queue.length) {
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
    lib.renderList(catalog.search(""));
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

  // collapsible panels
  $("toggle-lib").onclick = () => settings.set("ui.library", !settings.get("ui.library"));
  $("toggle-queue").onclick = () => settings.set("ui.queue", !settings.get("ui.queue"));
  $("toggle-playback").onclick = () => settings.set("ui.playback", !settings.get("ui.playback"));

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
  // queue panels; the topbar stays so you can exit (Esc also exits). Re-measures the
  // virtual list + guide because the stage width changes.
  const focusBtn = $("btn-focus");
  const setFocus = (on) => {
    document.body.classList.toggle("focus-mode", on);
    if (focusBtn) {
      focusBtn.classList.toggle("active", on);
      focusBtn.title = on ? "Exit focus mode (Esc)" : "Focus mode — hide panels for a full-screen lyrics view (Esc to exit)";
    }
    requestAnimationFrame(() => { if (lib) lib.refresh(); if (pitchGuide) pitchGuide.resize(); });
  };
  if (focusBtn) focusBtn.onclick = () => setFocus(!document.body.classList.contains("focus-mode"));
  document.addEventListener("keydown", (e) => {
    // Esc leaves focus mode (unless a text field is focused — there Esc clears the field).
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName || "");
    if (e.key === "Escape" && !typing && document.body.classList.contains("focus-mode")) setFocus(false);
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
  $("btn-next").onclick = () => advanceQueue();
  // 🎵 melody toggle — flips the guide-vocal mute (melody channel audible on/off). Same setting
  // the ⚙ "Mute melody" checkbox and the phone remote drive, so all three stay in sync.
  $("btn-melody").onclick = () => settings.set("guide.vocal.mute", !settings.get("guide.vocal.mute"));
  $("btn-mic").onclick = async () => {
    if (settings.get("bt.enabled")) return; // mic disabled in Bluetooth mode
    $("mic-status").textContent = mic.enabled ? "Stopping…" : "Requesting microphone…";
    if (mic.enabled) mic.disable();
    else await mic.enable();
    settingsUI.updateMicBtn();
    updateMicToggle();
  };

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
let _bannerNow = null, _bannerUp = null;
function updateStageBanner() {
  const nowEl = $("now-singer"), upEl = $("up-next");
  if (!nowEl || !upEl) return;
  const nowText = current && currentBy ? `🎤 ${currentBy}` : "";
  if (nowText !== _bannerNow) { nowEl.textContent = nowText; _bannerNow = nowText; }
  let upText = "";
  if (current && media && media.duration > 0 && queue.length) {
    const remaining = media.duration - media.currentTime;
    if (remaining > 0 && remaining <= 20) {
      const who = queueBy[0];
      upText = `⏭ Up next: ${queue[0].name || "(untitled)"}${who ? ` · ${who}` : ""}`;
    }
  }
  if (upText !== _bannerUp) { upEl.textContent = upText; _bannerUp = upText; }
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
  lib.renderList(catalog.search($("search").value));
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
  const icon = playing ? "❚❚" : "▶";
  const el = $("btn-play");
  if (el.textContent !== icon) el.textContent = icon;
}
function fmtKey(s) { return (s > 0 ? "+" : "") + s; }
function fmt(s) { s = Math.max(0, s | 0); return `${(s / 60) | 0}:${String(s % 60).padStart(2, "0")}`; }

// set the bgv "no clips" note once discovery finishes
setTimeout(() => {
  const note = $("set-bgv-note");
  if (note && bgv) note.textContent = bgv.available ? "" : "(no clips found)";
}, 1200);

boot();
