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
import { parseMidi, LyricsEngine, makeTickToSeconds } from "./lyrics.js";
import { Settings } from "./settings.js";
import { BackgroundVideo } from "./bgv.js";
import { MicEngine } from "./mic.js";
import { extractMelody, PitchGuide, snapNote, detectKey, keyName } from "./melody.js";
import { createLibraryUI } from "./library-ui.js";
import { createSettingsUI } from "./settings-ui.js";
import { cachedArrayBuffer, purgeStaleCaches } from "./asset-cache.js";

const $ = (id) => document.getElementById(id);

// --- singletons -------------------------------------------------------------
const settings = new Settings();
const catalog = new Catalog();
const audio = new AudioEngine();
let lyrics, bgv, mic, pitchGuide, video, youtube; // created at boot (need the DOM)
let lib, settingsUI;              // UI modules (created at boot)

// --- mutable player state ---------------------------------------------------
let queue = [];
let current = null;
let media = audio;    // the engine driving the current song (audio=MIDI, video=VIDEO, youtube=YOUTUBE)
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
  video = new VideoEngine($("kv"), $("kva")); // VIDEO-song playback (picture + offset audio)
  youtube = new YouTubeEngine($("ytplayer")); // YOUTUBE-song playback (credentialless iframe)
  youtube.onState = () => { if (media === youtube) setPlayIcon(); }; // keep transport icon in sync with YT state
  youtube.onEnded = () => { if (media === youtube) endOfSong(); };   // unload on end → no suggested-videos screen
  youtube.onError = (code) => onYoutubeError(code);                  // embed-blocked/unavailable → skip + remember

  lib = createLibraryUI({
    onPlay: playNow, onQueue: enqueue, onRemoveFromQueue: removeFromQueue,
    onToggleFavorite: toggleFavorite, isFavorite,
  });
  settingsUI = createSettingsUI({ settings, mic, onRebuild });
  mic.onStatus = (m) => { $("mic-status").textContent = m; settingsUI.updateMicBtn(); updateMicToggle(); };

  applyVisualSettings();
  applyGuideSettings();
  settingsUI.syncSettingsUI();
  applyBluetoothMode();
  applyUiCollapse();
  bgv.init();

  try {
    const n = await catalog.load(settings.get("data.catalogUrl"), settings.get("data.videoCatalogUrl"));
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
  if (video) { video.setVolume(vol); video.setTempo(tempo); }
  if (youtube) { youtube.setVolume(vol); youtube.setTempo(tempo); }
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
    if (path === "*" || path.startsWith("guide.vocal")) applyGuideVocal();
  }
  if (path === "*" || path.startsWith("key.") || path === "audio.key") {
    if (path === "key.autoDetect" && lastParsed) currentKey = settings.get("key.autoDetect") ? detectKey(lastParsed) : null;
    updateKeyDisplay();
  }
  if (path === "*" || path === "bt.enabled") applyBluetoothMode(path === "bt.enabled");
  if (path === "*" || path === "youtube.enabled") {
    updateYoutubeToggle();
    // reflect the new state in the current search (append or drop YouTube rows)
    if (path === "youtube.enabled" && !recentMode && !favoritesMode) runSearch($("search").value);
  }
  if (path === "*" || path.startsWith("ui.")) applyUiCollapse();
  if (path === "*") settingsUI.syncSettingsUI();
}

// Collapsible panels (song list / queue / playback controls), toggled from the top bar.
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
function enqueue(song) {
  queue.push(song);
  lib.renderQueue(queue);
  saveSession();
  if (!current) advanceQueue();
}
function removeFromQueue(i) {
  queue.splice(i, 1);
  lib.renderQueue(queue);
  saveSession();
}
function advanceQueue() {
  const next = queue.shift();
  lib.renderQueue(queue);
  saveSession();
  if (next) playNow(next);
  else {
    media.stop();            // nothing more queued → halt the active engine
    current = null; autoAdvancing = false;
    clearStage();            // blank the lyrics + reset the seek bar/time once playback ends
    setPlayIcon();
  }
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
  if (q.length) { queue = q; lib.renderQueue(queue); }
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
async function playNow(song) {
  armed = true; // the user has started playback → the idle queue auto-advance is allowed
  if (song.kind === "youtube") return playYoutube(song);
  if (song.kind === "video") return playVideo(song);
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
  currentMelodyChannel = -1;
  lastParsed = null;
  currentKey = null;
}

// VIDEO song: no synth/soundfont, no lyric parsing. The picture fills the stage; the
// offset feature moves the audio (handled inside VideoEngine).
async function playVideo(song) {
  audio.pause();            // silence the synth if a MIDI song was playing
  youtube.unload();         // stop any YouTube video that was playing
  document.body.classList.remove("youtube-mode");
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
  $("np-code").textContent = song.code ? `#${song.code}` : ""; // blank for code-less videos
  $("lyric-badge").textContent = "video";

  const url = Catalog.fileUrl(song);
  video.setOffset(settings.get("lyrics.offsetMs") || 0);
  video.setVolume(settings.get("audio.volume"));
  video.setTempo(settings.get("audio.tempo"));
  video.load(url);
  bgv.onSongStart();
  setStatus(`Now playing: ${song.code} — ${song.name}`);
  await video.play();
  setPlayIcon();
}

// YOUTUBE song (BYOC): no synth/soundfont, no lyric parsing — the official YouTube IFrame
// player fills the stage. Mirrors playVideo. Offset/key/guide/auto-tune don't apply (the
// lyrics are baked into the video), so the MIDI-only surfaces stay hidden.
async function playYoutube(song) {
  audio.pause();            // silence the synth if a MIDI song was playing
  video.unload();           // …and any video
  document.body.classList.remove("video-mode");
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
  $("np-code").textContent = "";        // YouTube songs have no dial code
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
  document.body.classList.remove("video-mode");
  document.body.classList.remove("youtube-mode");
  media = audio;
  current = song;
  userPaused = false;
  autoAdvancing = false;
  lib.setNowPlaying(song);
  pushRecent(song);
  setStatus(`Loading: ${song.code} — ${song.name}`);
  $("np-title").textContent = song.name || "(untitled)";
  $("np-artist").textContent = song.artistName || "";
  $("np-code").textContent = `#${song.code}`;

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
  } catch (e) {
    console.warn("Parse failed:", e);
    lyrics.lines = []; lyrics.hasLyrics = false; lyrics.reset();
    lastParsed = null;
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
  if (current && media) {
    const isMidi = media === audio;
    const t = media.currentTime;   // active-engine playback time
    const d = media.duration;

    // MIDI-only stage work: lyric sync, pitch guide, scoring, auto-tune. (For a
    // VIDEO song the lyrics are baked into the picture and there's no note data.)
    if (isMidi) {
      const offset = (settings.get("lyrics.offsetMs") || 0) / 1000;
      const gt = t + offset;          // visual time — drives lyrics AND the guide
      lyrics.update(gt);

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
  $("tempo").oninput = (e) => {
    const r = +e.target.value;
    settings.set("audio.tempo", r);
    $("tempo-val").textContent = `${r.toFixed(2)}×`;
  };
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
  $("tempo").value = settings.get("audio.tempo");
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
  $("tc-code").textContent = `#${song.code}`;
  $("tc-title").textContent = song.name || "";
  $("tc-artist").textContent = song.artistName || "";
  $("tc-key").textContent = currentKey && currentKey.source !== "none" && settings.get("key.showBadge")
    ? keyName(currentKey.keyPc, currentKey.mode) : "";
  tc.classList.add("show");
  tcTimer = setTimeout(() => tc.classList.remove("show"), secs * 1000);
}

// Blank the stage (between songs / when nothing is playing).
function clearStage() {
  $("np-title").textContent = "Select a song to begin";
  $("np-artist").textContent = "";
  $("np-code").textContent = "—";
  $("np-key").textContent = "";
  $("lyric-badge").textContent = "";
  lyrics.clear();
  if (pitchGuide) pitchGuide.load({ hasMelody: false, notes: [], range: { min: 60, max: 72 } });
  $("seekbar").style.width = "0%";
  $("time-cur").textContent = "0:00"; $("time-dur").textContent = "0:00";
  $("title-card").classList.remove("show");
  document.body.classList.remove("video-mode"); // leave the clean video stage
  document.body.classList.remove("youtube-mode");
  if (video) video.unload();
  if (youtube) youtube.unload();
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

// Rebuild catalog.json from kar_raw/ (called by the settings-ui button).
async function onRebuild() {
  const res = await (await fetch("/api/rebuild-catalog", { method: "POST" })).json();
  if (!res.ok) return { ok: false, error: res.error };
  const n = await catalog.load(settings.get("data.catalogUrl"), settings.get("data.videoCatalogUrl"));
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
