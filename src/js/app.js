/*
 * app.js — the player / orchestrator.
 *
 * Owns playback (queue, current song, load → synth + lyrics + guide), the
 * requestAnimationFrame loop (lyric sync, pitch guide, scoring, auto-tune), the
 * transport controls, and the "settings → app" glue (what each setting change
 * actually does). The page is ONE full-screen stage; everything above it (Songs, Queue,
 * Mixer, Settings, the recap, the control bar, the adjust toast) is an overlay of one stack:
 *   - ui/overlay-stack.js : the stack's state (built here, shared by the two below)
 *   - ui/overlays-dom.js  : hidden / inert / scrim / focus / history for every overlay
 *   - ui/shell.js         : the control bar's ONE owner, idle / kind / playing, the status line
 *   - ui/home.js          : the idle home layer's tiles
 * The big UI surfaces are delegated:
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
import { StageLyricsEngine, LyricsSwitch } from "./lyrics-stage.js";
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
import { createSession } from "./session.js";
import { createLibraryView, enterDecision } from "./library-view.js";
import { createSearchClient } from "./search-client.js";
import { createRemoteGlue } from "./remote-glue.js";
import { createRemoteHost } from "./remote-host.js";
import { cachedArrayBuffer, purgeStaleCaches, purgeAllCaches } from "./asset-cache.js";
import { collectAppData, restoreAppData, clearAppData } from "./store.js";
import { createOverlayStack } from "./ui/overlay-stack.js";
import { createOverlays } from "./ui/overlays-dom.js";
import { createShell } from "./ui/shell.js";
import { createHome } from "./ui/home.js";
import { createSongSheet } from "./ui/song-sheet.js";
import { keyToAction } from "./ui/keymap.js";
import { createInputMode } from "./ui/input-mode.js";
import { createNav } from "./ui/nav-dom.js";
import { createActions } from "./ui/actions.js";

const $ = (id) => document.getElementById(id);
// What an empty song list should SAY. A bare white panel is indistinguishable from a broken
// app, and the first-run case has a concrete next action worth naming.
// Source-kind icon shown in the now-playing header (in place of the dial number).
const NP_ICON = { midi: "🎤", video: "🎞️", youtube: "🌐", audio: "🎵" };
const npIcon = (kind) => NP_ICON[kind] || "🎵";

// --- singletons -------------------------------------------------------------
const settings = new Settings();
const catalog = new Catalog();
const session = createSession({ catalog });
// The close-match (typo) index: a module Worker, or a sliced main-thread build without one.
// Built from the catalogue once it loads (buildSearchIndex); until then search is exact-only.
const searchClient = createSearchClient();
// The list's current VIEW (search / Recent / Favorites / YouTube append). It needs library-ui,
// which is built at boot, so it reaches it through a getter rather than a captured reference.
const libraryView = createLibraryView({
  catalog, settings,
  getLib: () => lib,
  setStatus: (m) => setStatus(m),
  youtubeSupported: () => YouTubeEngine.supported,
  getQueueIds: () => queue.list.map((s) => s.id),   // live: the keep-set spans three owners
  getRecentIds: () => session.recent,
  getRecentSongs: () => session.recentSongs(),
  warmYoutube: () => { if (youtube) youtube.warm(); },
  searchClient,
  getFuzzy: () => settings.get("search.fuzzy"),
  fuzzyBelow: () => settings.get("search.fuzzyBelow"),
});
const audio = new AudioEngine();
const reactions = createReactions({ settings, audio });
const durations = createDurationHints();
const recap = createRecap();
const score = createScorePresentation({ settings });
let lyrics, mic, pitchGuide, video, youtube, chordEngine, audioFile; // created at boot (need the DOM)
let lib, settingsUI, midiMixer, songSheet;  // UI modules (created at boot)
let stack, overlays, shell, home; // the stage-first shell (created at boot — see buildShell)
let inputMode, nav, actions;     // keys and D-pad (created at boot — see buildKeys)
// id → the element registered for that overlay, kept beside the overlays.register calls: the
// D-pad's scope is the top modal's element (nav.getOverlayEl).
const overlayEls = new Map();
let stageKind = "";              // the loaded song's kind as last told to the shell ("" = none)

let remoteHost;                  // host↔phone relay driver (created at boot)

// --- mutable player state ---------------------------------------------------
// The queue owns its own two parallel arrays (song + who reserved it); every mutation renders,
// persists and pushes to the phones through this one callback.
const queue = createQueue({
  onChange() {
    renderQueuePanel();
    saveSession();
    if (remoteHost) remoteHost.push();
  },
});
let current = null;
let currentBy = "";              // who queued the NOW-PLAYING song via the remote ("" if host-added)
let media = audio;    // the engine driving the current song (audio=MIDI, video=VIDEO, youtube=YOUTUBE, audioFile=AUDIO)
let armed = false;    // true once the user has started playback (gates queue auto-advance)
let userPaused = false;   // true only when the user paused (the auto-advance exception)
let autoAdvancing = false; // guard so the idle auto-advance fires once
let playDelayTimer = null; // delays music start until ~1s before the title card fades
let lastParsed = null;
let currentKey = null;
let pendingUnsyncedLines = null; // AUDIO song: unsynced .txt lines awaiting duration-based timing
let currentMelodyChannel = -1;
let scorer = null;               // scoring.js Scorer for the current MIDI song (null = nothing to score)

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
async function boot() {
  document.body.classList.add("booting"); // hairline sweep across the top of the stage until the catalog lands
  purgeStaleCaches(); // drop the old service-worker cache; keep our asset cache

  // One lyric surface, two styles (lyrics.style): the smooth-scrolling column, or the
  // fixed-row videoke "stage" (lyrics-stage.js). LyricsSwitch keeps both loaded.
  lyrics = new LyricsSwitch(
    new LyricsEngine($("lyrics"), {
      lineCount: settings.get("lyrics.lineCount"),
      smooth: settings.get("lyrics.smooth"),
      mergeLines: settings.get("lyrics.mergeLines"),
    }),
    new StageLyricsEngine($("lyrics"), stageLyricOptions()),
    settings.get("lyrics.style"),
  );
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
    // The pre-M5 row path (double-click / Enter plays). With onActivate below no row calls it;
    // it stays so the list keeps a meaning for "play" if onActivate is ever dropped.
    onPlay: (s) => { playNow(s); closeOverlay("search"); },
    onQueue: enqueue, onRemoveFromQueue: removeFromQueue,
    onToggleFavorite: (s) => libraryView.toggleFavorite(s), isFavorite: (s) => libraryView.isFavorite(s),
    showSource: () => settings.get("library.showSource"),
    // P23 (M5): a click, a tap or Enter on a row body opens the song sheet. ★ / ＋ on a song row
    // and ✕ on a queue row keep their direct actions; Space still selects, "+" still queues.
    onActivate: (song, rowEl) => openSheet(song, rowEl, "library", +rowEl.dataset.index),
    onQueueActivate: (index, song, rowEl) => openSheet(song, rowEl, "queue", index),
  });
  // The one "what do you want to do with this song?" sheet. It only renders and reports the
  // choice; onSheetAction carries it out (the queue, the player and the overlays are ours).
  songSheet = createSongSheet({ el: $("ov-song"), onAction: onSheetAction });
  settingsUI = createSettingsUI({
    settings, mic, onRebuild, onToggleMic: toggleMic, onEraseAll: eraseAllData,
    onExportData: exportAppData, onImportData: importAppData, onShowRecap: () => overlays.open("recap"),
  });
  midiMixer = createMidiMixer({ container: $("midi-mixer"), audio });
  remoteHost = createRemoteHost({
    getSnapshot: () => remoteGlue.snapshot(),
    applyCommand: (cmd) => remoteGlue.applyCommand(cmd),
  });
  mic.onStatus = (m) => { $("mic-status").textContent = m; settingsUI.updateMicBtn(); updateMicToggle(); };
  buildShell();          // the overlay stack, every overlay, the control bar and the home layer

  applyVisualSettings();
  applyGuideSettings();
  applyChordSettings();
  applyMidiMode();
  applyRemoteMode();
  applyFontSize();       // set the text scale before first paint of the list/guide
  applyTheme();          // color theme: dark / light / auto (follows the OS)
  applyOverscan();       // TV overscan inset → --overscan
  applyKeyHints();
  settingsUI.syncSettingsUI();
  applyBluetoothMode();

  try {
    const n = await catalog.load(settings.get("data.catalogUrl"), settings.get("data.videoCatalogUrl"), settings.get("data.audioCatalogUrl"));
    setStatus(`${n.toLocaleString()} songs loaded — pick one to begin`);
    durations.load(); // learned song lengths → queue ETA on the phones
    recap.load();        // tonight's performance log (reset after a long enough gap)
    libraryView.loadYoutubeCache(); // re-register persisted YouTube songs so favorites/recent/queue resolve them
    libraryView.loadBlocked();      // hide videos that previously failed to embed
    libraryView.seedServerBlocklist();
    libraryView.loadFavorites();    // restore starred songs (resolved by id) before the first render
    libraryView.renderAll();
    loadSession(); // restore queue + recently-played (no auto-play)
    // Its own task, not awaited: the hand-off copies every title + artist, and should not
    // lengthen the task that paints the list. Close matches start once the index is ready.
    setTimeout(buildSearchIndex, 0);
  } catch (e) {
    setStatus("Failed to load catalog.json — is the server running from the project root?");
    console.error(e);
    libraryView.renderCatalogError();
  } finally {
    document.body.classList.remove("booting");
  }
  wireUI();
  settingsUI.wireSettings();
  settings.onChange(onSettingChanged);
  requestAnimationFrame(tick);
}

// ---------------------------------------------------------------------------
// The stage-first shell: one overlay stack, the DOM side of every overlay, the control bar
// and the home layer. Ownership is split on purpose (each owner is the only writer):
//   - overlays-dom: `hidden`/`.open` on every overlay but the bar, `inert`, #scrim, focus,
//     history, body[data-ov] / body[data-panel];
//   - shell: the control bar (body.controls-hidden), body[data-idle] / [data-kind], #status;
//   - app.js: WHEN the stage is idle, what kind of song is loaded, whether it is playing.
// ---------------------------------------------------------------------------
function buildShell() {
  // The stack takes one onChange at construction, so changes fan out to every subscriber
  // (overlays-dom and the shell subscribe themselves).
  const stackSubs = new Set();
  stack = createOverlayStack({ onChange: (c) => { for (const fn of stackSubs) fn(c); } });
  stack.subscribe = (fn) => { stackSubs.add(fn); return () => stackSubs.delete(fn); };

  overlays = createOverlays({ stack });
  // The list sits in a panel that is display:none until it opens, so it can only measure its
  // rows (and fill its viewport) once the panel is laid out: re-measure on the next frame.
  const remeasure = () => requestAnimationFrame(() => lib.refresh());
  const first = (root, sel) => (root ? root.querySelector(sel) : null);
  const reg = (id, opts) => { overlayEls.set(id, opts.el || null); overlays.register(id, opts); };
  // Initial focus depends on the input mode (§4.2 table): a D-pad lands on a row / a category,
  // touch and mouse on the search field (so the keyboard comes up, or typing just works).
  const keysMode = () => !!inputMode && inputMode.mode === "keys";
  // Every overlay except "controls" — the shell registers the bar itself (its one owner).
  reg("search", {
    el: $("ov-search"),
    // Keys: the last focused row (the roving one), else the first; an empty list → the field.
    initialFocus: () => (keysMode() && lib.focusRow() ? document.activeElement : $("search")),
    onOpen: remeasure,
  });
  reg("queue", {
    el: $("ov-queue"),
    // The first queue row (a roving list since M5: Enter on it opens the song sheet, never a
    // removal), else Close. Pointer users get no ring from this (:focus-visible).
    initialFocus: () => (lib.focusQueueRow(0) ? document.activeElement : first($("ov-queue"), ".ov-close")),
    onOpen: remeasure,
  });
  reg("mixer", { el: $("ov-mixer"), initialFocus: () => first($("midi-mixer"), "input, button") });
  reg("settings", {
    el: $("settings-panel"),
    initialFocus: () => (keysMode() && first($("settings-panel"), ".set-cat:not(.filtered-out) > summary")) || $("set-search"),
    onOpen: settingsUI.onOpen,
  });
  // A sheet opens above a panel without closing it; Back closes it; focus starts on its first
  // action (openSheet renders the buttons before it opens the overlay).
  reg("song", { el: $("ov-song"), initialFocus: () => songSheet.firstButton() });
  reg("adjust", { el: $("ov-adjust") });
  reg("recap", { el: $("recap"), initialFocus: () => $("recap-close"), onOpen: () => recap.render() });
  reg("calibrate", { el: $("ov-calibrate") });
  reg("confirm", { el: $("ov-confirm"), initialFocus: () => $("ov-confirm-cancel") });
  overlays.wire();

  shell = createShell({ overlays, stack, settings, actions: { restart: restartSong, fullscreen: toggleFullscreen } });
  shell.wire();
  overlayEls.set("controls", $("ov-controls"));

  home = createHome({
    el: $("home"),
    enabled: ["songs", "favorites", "queue", "tonight", "settings"],
    onTile: openFromHome,
  });
  home.render();

  buildKeys();   // input mode, D-pad navigation, the named actions, the one key router, media keys

  // An open or closing panel reflows the stage beside it (never over the lyrics), and the
  // overscan inset moves it in from the edges. The stage lyric canvas re-measures itself; the
  // pitch guide and the title card only did on a window resize, so watch their boxes too.
  if (typeof ResizeObserver === "function") {
    let raf = 0;
    const ro = new ResizeObserver(() => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => { if (pitchGuide) pitchGuide.resize(); fitTitleCard(); });
    });
    for (const el of [$("pitch-guide"), document.querySelector(".lyrics-wrap")]) if (el) ro.observe(el);
    // The control bar overlays the bottom of the stage and wraps to 1–3 rows by size. Publish
    // its real height as --bar-h so the flow and the home layer keep that strip clear: the
    // lyrics never sit under the bar (it stays up while paused), and nothing jumps when it
    // auto-hides, because a hidden bar keeps its box (it only fades and slides).
    const bar = $("ov-controls");
    if (bar) new ResizeObserver(() => {
      document.documentElement.style.setProperty("--bar-h", `${Math.ceil(bar.getBoundingClientRect().height)}px`);
    }).observe(bar);
  }
}

/** Close an overlay if it is open (a no-op otherwise). */
function closeOverlay(id) {
  if (overlays && overlays.isOpen(id)) overlays.close(id);
}

// A home tile opens the overlay it names. "Favorites" is the Songs panel in its Favorites view;
// "Tonight" is the recap.
function openFromHome(id) {
  switch (id) {
    case "songs": overlays.open("search"); break;
    case "favorites":
      if (!libraryView.favoritesMode) { libraryView.setFavoritesMode(true); libraryView.showFavorites(); }
      overlays.open("search");
      break;
    case "queue": overlays.open("queue"); break;
    case "tonight": overlays.open("recap"); break;
    case "settings": overlays.open("settings"); break;
  }
}

// ---------------------------------------------------------------------------
// Keys and D-pad (M4, plan §4.3). ONE keydown listener on the document, bubble phase, decides
// what a key means. The protocol is `defaultPrevented`: a widget that handles a key (the song
// list, the search fields, a native control) prevents it and the router ignores it; a widget
// that wants the router to take over (a list edge) does not. No key is handled twice.
// Installed from buildShell, so the keys work while the catalogue is still loading.
// ---------------------------------------------------------------------------
const DIALOGS = new Set(["recap", "calibrate", "confirm"]);
// The song sheet is modal too: a panel shortcut must not open (or swap) a panel beneath it.
const sheetOrDialogOnTop = () => { const t = stack.top(); return DIALOGS.has(t) || t === "song"; };
// A single-line text field: it releases ArrowUp / ArrowDown (a text field owns only Left/Right).
const LINE_TYPES = /^(text|search|url|email|tel|password)$/;
const isLineField = (el) => !!el && el.tagName === "INPUT" && LINE_TYPES.test(el.type);
const noMods = (e) => !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey;
// Is the caret (no selection) at the start (ArrowLeft) or end (ArrowRight) of a field's text?
// A type without the selection API (email) counts as at the edge, so it can never trap focus.
const caretAtEdge = (el, key) => {
  const s = el.selectionStart, end = el.selectionEnd;
  if (s == null || end == null) return true;
  if (s !== end) return false;
  return key === "ArrowLeft" ? s === 0 : s === el.value.length;
};
let keyEvent = null;   // the keydown being routed: `c` and Back hand it to the shell (see shell.toggle)

function buildKeys() {
  inputMode = createInputMode();   // html[data-input] = touch | mouse | keys (hints, the ring's grow)
  inputMode.wire();
  nav = createNav({
    stack,
    getOverlayEl: (id) => overlayEls.get(id) || null,
    getHomeRoot: () => $("home-tiles"),
    getBarRoot: () => $("ov-controls"),
    getBarEntry: () => $("btn-play"),
    isIdle: () => document.body.dataset.idle === "true",
    isBarVisible: () => !document.body.classList.contains("controls-hidden"),
    showBar: () => shell.poke(),
  });
  // A handler returns false for "not handled" (the key goes through); anything else = handled.
  // `digit` (M8) and `bgNext` (M11) have no handler yet, so their keys are never swallowed.
  actions = createActions({
    back: () => goBack(),
    playPause: (arg) => playPauseKey(arg),
    next: () => nextKey(),
    restart: () => { if (!restartSong()) return false; showAdjust("Restart"); return true; },
    stop: () => stopSong(),
    keyUp: () => adjustKey(1),
    keyDown: () => adjustKey(-1),
    tempoUp: () => adjustTempo(0.05),
    tempoDown: () => adjustTempo(-0.05),
    offsetUp: () => { nudgeOffset(50); return true; },
    offsetDown: () => { nudgeOffset(-50); return true; },
    melodyToggle: () => {
      const mute = !settings.get("guide.vocal.mute");
      settings.set("guide.vocal.mute", mute);   // → onSettingChanged → the 🎵 button's state
      showAdjust(mute ? "Melody off" : "Melody on");
      return true;
    },
    openSearch: () => {
      if (sheetOrDialogOnTop()) return false;       // a dialog / the song sheet is on top: not under it
      if (overlays.isOpen("search")) { $("search").focus(); return true; }
      overlays.open("search");
      return true;
    },
    openQueue: () => {
      // Under the song sheet this would swap the panel the sheet was opened from.
      if (sheetOrDialogOnTop()) return false;
      overlays.open("queue");                       // already open → a no-op (open() only touches it)
      return true;
    },
    toggleControls: () => shell.toggle(keyEvent),
    fullscreen: () => { toggleFullscreen(); return true; },
  });
  document.addEventListener("keydown", routeKey);
  wireTypeToSearch();
  wireMediaSession();
}

function routeKey(e) {
  // 1. a widget already handled it (an IME composition is the field's too)
  if (e.defaultPrevented || e.isComposing) return;
  // 2. where focus is
  const a = document.activeElement;
  const ctx = {
    typing: !!a && ((/^(INPUT|TEXTAREA)$/.test(a.tagName) && !/^(range|checkbox|radio|button|color)$/.test(a.type)) || !!a.isContentEditable),
    // A5: only SONG rows own Space / "+" (select / queue). A queue row (a roving list since M5)
    // has no meaning for either, so Space there stays play/pause — keep this `.song` only.
    inList: !!(a && a.closest && a.closest(".song")),
    inSearch: !!(a && a.closest && a.closest("#ov-search")),
    modal: DIALOGS.has(stack.top()),
  };
  // 3. Enter = OK: a checkbox / radio / select / colour does not act on Enter natively
  if ((e.key === "Enter" || e.key === "NumpadEnter" || e.keyCode === 13) && nav.activate(a)) { e.preventDefault(); return; }
  // 4. (A8) a single-line text field releases Up / Down to spatial navigation; the key map maps
  //    nothing while typing, so the router does this itself. Shift+Up/Down still select text.
  if (ctx.typing && (e.key === "ArrowUp" || e.key === "ArrowDown") && noMods(e) && isLineField(a)) {
    if (nav.move(e.key === "ArrowUp" ? "up" : "down")) e.preventDefault();
    return;
  }
  //    (A11) …and Left / Right once the caret is already at that end of the text, so the
  //    buttons on the field's own line (the Songs panel's search row) are reachable by D-pad.
  if (ctx.typing && (e.key === "ArrowLeft" || e.key === "ArrowRight") && noMods(e) && isLineField(a) && caretAtEdge(a, e.key)) {
    if (nav.move(e.key === "ArrowLeft" ? "left" : "right", { release: true })) e.preventDefault();
    return;
  }
  //    Space on a focused form control (checkbox, radio, range, select, colour) keeps its
  //    native meaning, as it did before M4; play/pause is Space everywhere else.
  if (e.key === " " && a && (a.tagName === "INPUT" || a.tagName === "SELECT")) return;
  // 5.–7. the key map → spatial navigation or a named action
  const hit = keyToAction(e, ctx);
  if (!hit) return;
  if (hit.action === "nav") { if (nav.move(hit.arg)) e.preventDefault(); return; }
  keyEvent = e;
  try { if (actions.run(hit.action, hit.arg)) e.preventDefault(); }
  finally { keyEvent = null; }
}

// Back (§4.2 rule 3), one thing per press, first match wins.
function goBack() {
  const a = document.activeElement;
  // 1. a text field with content clears first. #search and #set-search do this themselves for
  //    the keys they know; this catches the rest (a TV remote's Back in #set-search, say).
  if (isLineField(a) && a.value) {
    a.value = "";
    a.dispatchEvent(new Event("input", { bubbles: true }));
    return true;
  }
  // 2. close the top modal overlay
  if (overlays.back()) return true;
  // 3. the bar is up, holds focus, and the stage is not idle → hide it (focus goes to #stage)
  const bar = $("ov-controls");
  if (shell.shown && bar && bar.contains(a) && document.body.dataset.idle !== "true") return shell.hide(keyEvent);
  // 4. nothing: the key goes through (and Back never stops the song)
  return false;
}

// Space / k / the media play-pause keys. MediaPlay and MediaPause carry "play" / "pause" and
// never toggle the wrong way. Nothing loaded: what ▶ does — play a song the user has selected.
function playPauseKey(arg) {
  const want = arg === "play" || arg === "pause" ? arg : "toggle";
  if (!current) {
    if (loadingSong) return true;               // a song is on its way: nothing to toggle yet
    if (want === "pause") return false;
    const sel = lib.getSelectedSong();
    if (!sel) return false;
    playNow(sel);
    return true;
  }
  const playing = isPlaying();
  if ((want === "play" && playing) || (want === "pause" && !playing)) return true;   // already so
  showAdjust(playing ? "Paused" : "Playing");
  setPlayback(want);
  return true;
}
async function setPlayback(want) {
  if (media === audio && !(await ensureEngine())) return;
  if (want === "play") { media.play(); userPaused = false; }
  else if (want === "pause") { media.pause(); userPaused = true; }
  else { media.toggle(); userPaused = media.paused; }   // a pause here is a deliberate hold
  setPlayIcon();
}

// n / MediaTrackNext: the same single "move on now" path as ⏭.
function nextKey() {
  if (!current && !queue.length) return false;
  const up = queue.list[0];
  skipCurrent();
  showAdjust(up ? `Next: ${up.name || "(untitled)"}` : "End of the queue");
  return true;
}

// MediaStop: stop and clear the stage; the queue is kept (§4.3).
function stopSong() {
  if (!current && !loadingSong) return false;
  playGen++;               // a play* still awaiting its file or engine bails at its next checkpoint
  loadingSong = false;     // …and its `finally` no longer owns the flag, so release it here
  clearTimeout(endTimer); endTimer = null; endGuard = false;   // no hand-off to the next song
  score.hideCard();
  media.stop();
  current = null;
  armed = false;           // the idle auto-advance must not start the kept queue again
  autoAdvancing = false;
  userPaused = false;
  clearStage();
  setPlayIcon();
  // The THIRD deliberate setIdle(true) caller, beside advanceQueue's empty branch and
  // onSongFailed with an empty queue: a stopped stage is the home layer, whatever is queued.
  shell.setIdle(true);
  setStageKind("");
  if (remoteHost) remoteHost.push();
  showAdjust("Stopped");
  return true;
}

function adjustKey(delta) {
  setKey((Number(settings.get("audio.key")) || 0) + delta);
  showAdjust(`Key ${fmtKey(Number(settings.get("audio.key")) || 0)}`);
  return true;
}
function adjustTempo(delta) {
  setTempoRate((Number(settings.get("audio.tempo")) || 1) + delta);
  showAdjust(`Tempo ${(Number(settings.get("audio.tempo")) || 1).toFixed(2)}×`);
  return true;
}

// Type-to-search (§4.3): on a song row, a printable key moves focus to the search field BEFORE
// the browser inserts the character, so the character lands there. Bubble phase on the panel:
// after the list's own handler (which prevents Space / "+" / "=" and its movement keys), before
// the document router. Digits included — the key map leaves them alone on a row in Songs.
function wireTypeToSearch() {
  const panel = $("ov-search"), field = $("search");
  if (!panel || !field) return;
  panel.addEventListener("keydown", (e) => {
    if (e.defaultPrevented || e.isComposing) return;
    const row = e.target && e.target.closest ? e.target.closest(".song") : null;
    if (!row) return;
    // The list's top edge is the search field. The list released this key (listKeyPlan), and
    // spatial navigation would have to pick between the field and the filter pills on the same
    // line — a tie decided by sub-pixel rounding — so the panel takes it, deterministically.
    if (e.key === "ArrowUp" && noMods(e) && row.dataset.index === "0") {
      e.preventDefault();
      field.focus({ preventScroll: true });
      return;
    }
    if (typeof e.key !== "string" || e.key.length !== 1 || e.key === " " || e.ctrlKey || e.metaKey || e.altKey) return;
    field.focus({ preventScroll: true });
    const n = field.value.length;
    try { field.setSelectionRange(n, n); } catch { /* not a text type */ }
  });
}

// Hardware media keys when the page is not focused (lock screen, another window): the same
// actions as the keys. Every piece is optional and guarded — headless browsers lack some.
function wireMediaSession() {
  const ms = typeof navigator !== "undefined" ? navigator.mediaSession : null;
  if (!ms || typeof ms.setActionHandler !== "function") return;
  const on = (name, action, arg) => {
    try { ms.setActionHandler(name, () => { actions.run(action, arg); }); } catch { /* unsupported action */ }
  };
  on("play", "playPause", "play");
  on("pause", "playPause", "pause");
  on("nexttrack", "next");
  on("previoustrack", "restart");
  on("stop", "stop");
}
// What the OS media surface shows: the song now on the stage (null clears it).
function announceMedia(song) {
  const ms = typeof navigator !== "undefined" ? navigator.mediaSession : null;
  if (!ms) return;
  try {
    ms.metadata = song && typeof MediaMetadata === "function"
      ? new MediaMetadata({ title: song.name || "", artist: song.artistName || "" })
      : null;
    if (!song) ms.playbackState = "none";
  } catch { /* metadata unsupported */ }
}

function restartSong() {
  // Restart only means something with a song on the stage (and not mid-load).
  if (!current || !media || loadingSong) return false;
  media.restart();
  userPaused = false;
  setPlayIcon();
  return true;
}
function toggleFullscreen() {
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  else document.documentElement.requestFullscreen().catch(() => {});
}

// Tell the shell what kind of song now owns the stage ("" = none). The Mixer belongs to MIDI
// songs only: its button shows only for one (with MIDI mode on), and the panel closes when the
// stage changes to anything else.
function setStageKind(kind) {
  stageKind = kind || "";
  shell.setKind(stageKind);
  syncMixerButton();
  if (stageKind !== "midi") closeOverlay("mixer");
  announceMedia(stageKind ? current : null);   // every play* calls this once its song owns the stage
}
function syncMixerButton() {
  const b = $("btn-mixer");
  if (b) b.hidden = !(settings.get("midiMode.enabled") && stageKind === "midi");
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
  lyrics.setStyle(settings.get("lyrics.style"));
  lyrics.setStageOptions(stageLyricOptions()); // also re-measures: --font-scale may have just changed
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

// The stage lyric view's options, straight from lyrics.stage.* (+ the shared smooth wipe).
function stageLyricOptions() {
  const s = settings.get("lyrics.stage") || {};
  return { ...s, smooth: settings.get("lyrics.smooth") };
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
    libraryView.updateYoutubeToggle();
    // reflect the new state in the current search (append or drop YouTube rows)
    if (path === "youtube.enabled" && !libraryView.recentMode && !libraryView.favoritesMode) libraryView.runSearch($("search").value);
  }
  // Close matches on/off: redo the current search so the list says what the setting now says.
  if (path === "search.fuzzy" && !libraryView.recentMode && !libraryView.favoritesMode) libraryView.runSearch($("search").value);
  if (path === "*" || path === "library.showSource") { if (lib) lib.refresh(); } // songbook chip on/off
  if (path === "*" || path.startsWith("midiMode.")) applyMidiMode();
  if (path === "*" || path.startsWith("remote.")) applyRemoteMode();
  // "Always show playback controls" + its auto-hide duration: the shell re-reads both and
  // re-arms the control bar's timer (ui.library / ui.queue are retired and ignored).
  if (path === "*" || path === "ui.playback" || path === "ui.autoHideSec") shell.applyAutoHide();
  if (path === "*" || path === "ui.fontSize") applyFontSize();
  if (path === "*" || path === "ui.theme") applyTheme();
  if (path === "*" || path === "ui.overscanPct") applyOverscan();
  if (path === "*" || path === "ui.keyHints") applyKeyHints();
  if (path === "*") settingsUI.syncSettingsUI();
}

// Font size — an explicit Extra small / Small / Medium / Large that scales the whole player
// text + controls (drives --scale, and so the stage's scale unit, via :root[data-fontsize] in
// tokens.css). The Lyrics "Lyrics size" slider (lyrics.fontScale) fine-tunes just the lyrics
// on top of this.
const FONT_SIZES = new Set(["xsmall", "small", "medium", "large"]);
function applyFontSize() {
  const pref = settings.get("ui.fontSize");
  const size = FONT_SIZES.has(pref) ? pref : "medium";
  const el = document.documentElement;
  if (el.dataset.fontsize === size) return; // no change → nothing to re-measure
  el.dataset.fontsize = size;
  requestAnimationFrame(() => {
    if (lib) lib.refresh();          // the row height changed → re-measure the virtualized list
    if (pitchGuide) pitchGuide.resize();
    if (lyrics) lyrics.redraw();     // --ui-scale changed the lyric font → re-measure the stage
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
// TV overscan: ui.overscanPct (0–5) becomes --overscan on :root, always a LENGTH ("2.5vmax",
// "0vmax"), which the stage CSS adds to its edge padding. vmax so a landscape TV that crops a
// percentage of each axis is never under-inset on either.
function applyOverscan() {
  const n = Math.max(0, Math.min(5, Number(settings.get("ui.overscanPct")) || 0));
  document.documentElement.style.setProperty("--overscan", `${n}vmax`);
}
// Key hints (the arrow / OK / Back footers): shown only in keys mode by the CSS; this setting
// can switch them off altogether. Default on = the markup as written.
function applyKeyHints() {
  const on = settings.get("ui.keyHints") !== false;
  for (const el of document.querySelectorAll(".key-hints")) el.hidden = !on;
}
// On resize/rotate (debounced): re-fit the title card (its height follows the viewport) and
// re-measure the virtual list + guide (the scale unit follows the viewport too).
let _screenResizeTimer;
window.addEventListener("resize", () => {
  clearTimeout(_screenResizeTimer);
  _screenResizeTimer = setTimeout(() => {
    fitTitleCard();
    if (lib) lib.refresh(); if (pitchGuide) pitchGuide.resize();
  }, 150);
});

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
  // guide.height is in 16ths of the stage's scale unit (150 = 9.4 rows ≈ 150 px at 1280×720),
  // so the band scales with the screen like everything else. The stored value is unchanged.
  const h = Math.max(1, Number(settings.get("guide.height")) || 150);
  document.documentElement.style.setProperty("--guide-height", `calc(${h} / 16 * var(--u))`);
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

// MIDI mode: show the Mixer button (MIDI songs only) that opens the per-channel mixer panel.
// Turning it OFF closes the panel and hands the mix back to the song (unlock CC7 + unmute
// every channel).
function applyMidiMode() {
  const on = settings.get("midiMode.enabled");
  document.body.classList.toggle("midi-mode", on);
  syncMixerButton();
  if (!on) closeOverlay("mixer");
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

// The Queue panel: the list, plus its "Clear all" button, which only shows with something to
// clear. Every queue change comes through here (queue.onChange; loadSession, because a restore
// is silent).
function renderQueuePanel() {
  lib.renderQueue(queue.list, queue.listBy);
  const clr = $("queue-clear");
  if (!clr) return;
  const hide = !queue.length;
  // Hiding a focused button drops focus to <body> inside an open panel (the queue ran dry, or
  // Clear all just emptied it): hand it to the panel's Close first.
  if (hide && !clr.hidden && document.activeElement === clr) {
    const close = $("ov-queue") && $("ov-queue").querySelector(".ov-close");
    if (close) close.focus({ preventScroll: true });
  }
  clr.hidden = hide;
}

// "Clear all" — behind the confirm dialog (its initial focus is Cancel; Back = Cancel).
async function clearQueueAsk() {
  const n = queue.length;
  if (!n) return;
  const ok = await overlays.confirm({
    title: "Clear the queue?",
    text: `${n} ${n === 1 ? "song" : "songs"} will be removed.`,
    okLabel: "Clear",
  });
  if (ok && queue.clear() > 0) setStatus("Queue cleared");
}

function advanceQueue() {
  const taken = queue.shift();
  if (taken) playNow(taken.song, taken.by);
  else {
    media.stop();            // nothing more queued → halt the active engine
    current = null; autoAdvancing = false;
    clearStage();            // blank the lyrics + reset the seek bar/time once playback ends
    setPlayIcon();
    // Nothing loaded, nothing queued → the home layer. One of EXACTLY three places the stage goes
    // idle (the others: onSongFailed with an empty queue, and stopSong — MediaStop). Never
    // clearStage(), which also runs between queued songs, where the home layer must not flash.
    // playNow() ends idle.
    shell.setIdle(true);
    setStageKind("");
  }
}

// ---------------------------------------------------------------------------
// The song sheet (M5, plan §5.4, P23). A tap, a click or Enter on a song row or a queue row
// opens ONE sheet above the panel (song-sheet.js renders it and reports the choice). Every
// action closes the sheet; "Play now" also closes the panel; the others leave the panel open
// with focus back on the row the sheet came from.
// ---------------------------------------------------------------------------
const songTitle = (s) => (s && (s.name || s.code)) || "a song";

/** `index`: the row the sheet came from — a song-list row, or a queue position. */
function openSheet(song, rowEl, mode, index) {
  if (!song || !songSheet) return;
  // show() FIRST: the overlay's initial focus is the sheet's first button, so it must exist.
  songSheet.show(song, {
    mode, index,
    length: mode === "queue" ? queue.length : 0,
    isFavorite: libraryView.isFavorite(song),
  });
  overlays.open("song", { opener: rowEl });
}

/**
 * Where a queued song is NOW, or -1 when it is gone. The queue can change under an open sheet
 * (a phone adds or removes a song, a song ends and the queue moves on), so the index the sheet
 * was opened with may name a different song by the time a button is pressed — and a stale
 * index must never act on the wrong song (§5.22). The same position if it still holds this
 * song, else this song's nearest position (it can be queued twice).
 */
function resolveQueueIndex(index, id) {
  if (queue.matches(index, id)) return index;
  let best = -1;
  queue.list.forEach((s, j) => {
    if (s.id === id && (best < 0 || Math.abs(j - index) < Math.abs(best - index))) best = j;
  });
  return best;
}

function onSheetAction(id, song, { mode, index } = {}) {
  // Close first: overlays-dom hands focus back to the row (the opener) before the action
  // re-renders anything, so the list's own focus restore follows the song from there.
  closeOverlay("song");
  if (!song) return;
  if (mode === "queue") { queueSheetAction(id, song, index); return; }
  // Reserve and Play next write their line BEFORE acting: with nothing playing they start the
  // song at once, and the play path's own "Loading: …" / "Now playing: …" should then win.
  switch (id) {
    case "reserve":
      setStatus(`Reserved: ${songTitle(song)}`);
      enqueue(song);                       // fair play, the auto-start guard: as for ＋
      break;
    case "next":
      setStatus(`Up next: ${songTitle(song)}`);
      queue.addFront(song, "");            // an explicit jump: fair play does not apply
      if (!current && !loadingSong) advanceQueue();   // enqueue's auto-start guard (§5.29 rule 4)
      break;
    case "now":
      playNow(song);
      closeOverlay("search");              // a song was taken from the panel: it has done its job
      return;
    case "favorite":
      libraryView.toggleFavorite(song);
      break;
    default: break;                        // cancel
  }
  // Back on the row, if it still holds this song (a re-render — a late YouTube append,
  // un-starring in Favorites — can move it). Else overlays-dom's restore stands.
  if (overlays.isOpen("search") && lib.getList()[index]?.id === song.id) lib.focusRow(index);
}

function queueSheetAction(id, song, index) {
  const i = resolveQueueIndex(index, song.id);
  if (i < 0) {
    if (id !== "cancel") setStatus("That song is no longer in the queue");
    return;
  }
  let focusAt = i;
  switch (id) {
    case "now": {
      const by = queue.listBy[i] || "";
      queue.removeAt(i);
      playNow(song, by);
      closeOverlay("queue");
      return;
    }
    case "top": if (queue.moveToFront(i)) focusAt = 0; break;
    case "up": if (queue.move(i, i - 1)) focusAt = i - 1; break;
    case "down": if (queue.move(i, i + 1)) focusAt = i + 1; break;
    case "remove":
      queue.removeAt(i);
      focusAt = Math.min(i, queue.length - 1);   // the row that took its place; -1 = emptied
      break;
    default: break;                              // cancel
  }
  // Focus stays on the moved song (after Remove, on the row that took its place). An emptied
  // queue leaves focus where the re-render put it: the panel's Close.
  if (focusAt >= 0 && overlays.isOpen("queue")) lib.focusQueueRow(focusAt);
}

// ---------------------------------------------------------------------------
// Remote control (phones) — host side. The host stays the authoritative player;
// remote-host.js POSTs the snapshot to serve.py and hands back guest COMMANDS, which
// remote-glue.js applies through the SAME functions the local UI uses.
// See src/remote.html / src/js/remote.js (the phone) and §5.x in CLAUDE.md.
// ---------------------------------------------------------------------------
// The room code, the QR, the snapshot the phones mirror and the guest-command translation all
// live in remote-glue.js. What stays here is only what writes the playback state — handed over
// as `actions`.
const remoteGlue = createRemoteGlue({
  settings, catalog, queue, reactions, libraryView, durations,
  // The one legitimate getter in the split: remote-host's interval calls snapshot() on its own
  // schedule, so there is no caller here to pass the now-playing state in.
  getNowPlaying: () => (current ? {
    id: current.id,
    name: current.name || "",
    artist: current.artistName || "",
    kind: current.kind,
    code: current.code || "",
    by: currentBy || "",
    position: (media && media.currentTime) || 0,
    duration: (media && media.duration) || 0,
    paused: media ? media.paused : true,
    // Live score, so the room can watch the number climb on their own phones. Null unless the
    // song is actually being scored (MIDI + mic + score.enabled) — see scoring.js.
    score: scorer && mic.enabled && settings.get("score.enabled") ? scorer.liveScore() : null,
  } : null),
  setStatus: (m) => setStatus(m),
  actions: {
    enqueue: (song, by) => enqueue(song, by),
    removeFromQueue: (i) => removeFromQueue(i),
    reorderQueue: (from, to) => reorderQueue(from, to),
    play: () => remotePlay(),
    pause: () => remotePause(),
    next: () => skipCurrent(),
    seek: (position) => {
      // Clamped HERE: only app.js knows which engine is driving and how long the song is.
      if (current && media.duration > 0) media.seek(Math.max(0, Math.min(media.duration, position)));
    },
    setVolume: (v) => setRemoteVolume(v),
    applySetting: (path, v) => {
      settings.set(path, v);           // → onSettingChanged fans it out
      settingsUI.syncSettingsUI();     // refresh the ⚙ panel controls
      syncTransportLabels();           // …and the bottom key/tempo/volume labels
    },
  },
});

function applyRemoteMode() {
  const on = !!settings.get("remote.enabled");
  document.body.classList.toggle("remote-on", on);
  // Where the stage shows the QR ("idle" | "always" | "never"); the CSS reads it with remote-on.
  document.body.dataset.qr = settings.get("remote.qrOnStage");
  if (!remoteHost) return;
  if (on) remoteHost.start(); else remoteHost.stop();
  remoteGlue.refreshQr(on); // render/refresh (or clear) the QR on the queue panel + the stage
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
// App data — factory reset, backup/export, and the thin wrappers over session.js
// (which owns the queue + recently-played persistence).
// ---------------------------------------------------------------------------
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

function saveSession() {
  session.save(queue.list.map((s) => s.id));
  libraryView.persistYoutubeCache(); // keep the YouTube pointer cache in step with the queue/recent
}
function loadSession() {
  const { queue: songs } = session.restore();
  // Only touch the queue when there IS one: an empty restore must not clobber whatever the
  // boot sequence has already put there, or re-render the panel for nothing.
  if (songs.length) { queue.restore(songs); renderQueuePanel(); }
}
function pushRecent(song) {
  session.push(song);
  saveSession();
}
// A YouTube video failed to play. Codes: 2 = bad id, 5 = HTML5 error (may be transient),
// 100 = removed/private, 101/150 = embedding disabled by the owner. The permanent ones get
// remembered (library-view's blocklist → hidden from future results); then we skip to the next
// result. Stays here rather than in library-view.js: it writes `current`/`media`.
function onYoutubeError(code) {
  if (media !== youtube || !current) return;
  const permanent = code === 101 || code === 150 || code === 100 || code === 2;
  if (permanent) libraryView.blockYoutube(current.videoId);
  const why = (code === 101 || code === 150) ? "embedding disabled by owner" : `unavailable (${code})`;
  setStatus(`"${current.name}" ${why} — skipping…`);
  const next = libraryView.nextYoutubeInList(current);
  if (next) return playNow(next);          // walk to the next result the user was browsing
  if (queue.length) return skipCurrent();  // same single "move on now" path as ⏭ / a failure
  youtube.unload();                        // nothing to fall back to → clear the stage
  document.body.classList.remove("youtube-mode");
  onSongFailed();                          // same end state as any failed song: the home layer (idle)
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
  shell.setIdle(false);   // a song is coming: the home layer gives way (the only setIdle(false))
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
  setStageKind("video");
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
  setStageKind("audio");
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
  libraryView.registerYoutube(song);   // keep it resolvable for favorites/recent/queue across reloads
  lib.setNowPlaying(song);
  pushRecent(song);
  $("np-title").textContent = song.name || "(untitled)";
  $("np-artist").textContent = song.artistName || "";
  $("np-code").textContent = npIcon(song.kind); // source icon instead of the dial number
  $("lyric-badge").textContent = "youtube";

  youtube.setVolume(settings.get("audio.volume"));
  youtube.setTempo(settings.get("audio.tempo"));
  youtube.load(song.videoId);
  setStageKind("youtube");
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
  setStageKind("midi");

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
  if (res) {
    score.showCard(res);
    // The card is role=status, but a modal panel makes the stage inert, which hides it from
    // assistive tech. #status lives outside the stage, so say the same thing there too.
    if (settings.get("score.card")) {
      const title = (res.song && res.song.name) || "(untitled)";
      setStatus(`${title}: ${res.score}, ${res.band.label}`);
    }
  }
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
  else { shell.setIdle(true); setStageKind(""); }   // nothing to fall back to → the home layer
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
  // A song that is still LOADING is judged by the PREVIOUS song's engine state. `playMidi`
  // sets `current`/`media` before `await cachedArrayBuffer(url)`, and for that whole window the
  // Sequencer still holds the last song's `isFinished` + its plateaued clock — so the MIDI
  // branch below fired a spurious end on a song that had not started. clearStage() then wiped
  // the lyrics that had just loaded (and np-title, which playMidi never re-sets), and the
  // scheduled advanceQueue() ate the song. MEASURED: three songs burned in 1.5 s.
  // `loadingSong` is exactly "a play* started but doesn't own the stage yet", for all four
  // engines — and the 1 s hidden-tab watchdog inherits the guard because it lives in here.
  if (loadingSong) return false;
  const t = media.currentTime, d = media.duration;
  // MIDI. MEASURED IN A BROWSER, and it contradicts what §5.14 used to claim: at the natural
  // end the Sequencer BOTH pauses itself AND raises `isFinished`, with the clock landing
  // exactly on duration (paused:true, ended:true, t === d). So a `!paused` guard vetoes the
  // precise event it was meant to catch, and the queue never advances — the song just sits
  // there finished. Anchor on the CLOCK instead.
  //
  // CORRECTED AGAIN 2026-08-21: that fix then used `t > 0.5` as the stale-flag guard, on the
  // belief that "the title-card hold parks the clock at 0". It does not.
  // `t > 0.5` used to stand in for "this is not a stale flag", and it does not hold: the
  // Sequencer keeps `isFinished` from the PREVIOUS song across loadNewSongList, and the
  // title-card hold leaves ~1.5 s of auto-play residual on the new song's clock — so a
  // just-loaded song read as finished. MEASURED: {ended:true, t:1.55, d:179.46}. Anchor on the
  // clock reaching THIS song's duration, the same way every other engine does; `audio.ended`
  // is now song-scoped too (audio.js `_started`), so both halves have to agree.
  if (media === audio) return !!audio.ended && d > 0 && t >= d - 0.5;
  // Video/audio elements: `paused` here means the USER paused, so it still guards correctly.
  if (media.paused) return false;
  return d > 0 && t >= d - 0.15;
}
let _shellPlaying = null;   // what the shell was last told (change-guarded: tick runs every frame)
function tick() {
  setPlayIcon(); // keep the transport button mirroring the real play/pause state every frame
  updateStageBanner(); // singer + "up next" (last 20 s) — change-guarded, cheap
  // Playing vs paused drives the control bar's auto-hide (it never hides while paused).
  const playing = !!(current && media && !media.paused);
  if (playing !== _shellPlaying) {
    _shellPlaying = playing;
    shell.setPlaying(playing);
    // The OS media surface decides play vs pause for a toggle key from this.
    try { if (navigator.mediaSession && current) navigator.mediaSession.playbackState = playing ? "playing" : "paused"; } catch { /* unsupported */ }
  }
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
  let deb = null;   // the pending debounced render (null once it has run) — Enter flushes it
  search.oninput = () => {
    libraryView.leaveSpecialViews();   // typing leaves the Recent / Favorites views
    toggleClear();
    const q = search.value;
    clearTimeout(deb);
    deb = setTimeout(() => { deb = null; libraryView.renderSearchResults(q, null); }, 120); // instant local (drops any YouTube rows)
    libraryView.scheduleYoutubeSearch(q); // append YouTube after a longer debounce, if enabled + local is sparse
  };
  clearBtn.onclick = () => {
    search.value = "";
    toggleClear();
    libraryView.cancelYoutubeSearch();
    libraryView.leaveSpecialViews();
    libraryView.renderAll();
    search.focus();
  };
  $("btn-recent").onclick = () => {
    libraryView.setRecentMode(!libraryView.recentMode);
    if (libraryView.recentMode) libraryView.showRecent();
    else libraryView.runSearch(search.value); // back to the (search) list
  };
  $("btn-favorites").onclick = () => {
    libraryView.setFavoritesMode(!libraryView.favoritesMode);
    if (libraryView.favoritesMode) libraryView.showFavorites();
    else libraryView.runSearch(search.value); // back to the (search) list
  };
  $("btn-youtube").onclick = () => {
    if (!YouTubeEngine.supported) {
      setStatus("YouTube search needs a Chromium-based browser (credentialless iframes).");
      return;
    }
    settings.set("youtube.enabled", !settings.get("youtube.enabled")); // onSettingChanged repaints + re-runs
  };

  // The panel buttons (Songs, Queue, Mixer, Settings), Restart and Full screen are the shell's
  // (shell.wire). The full-screen button's state still follows the document from here.
  const fsBtn = $("btn-fullscreen");
  if (fsBtn) {
    document.addEventListener("fullscreenchange", () => {
      fsBtn.classList.toggle("active", !!document.fullscreenElement);
      fsBtn.title = document.fullscreenElement ? "Exit full screen" : "Full screen";
    });
  }

  // A key typed inside the 120 ms debounce has not rendered yet. Render it now, or the top hit
  // (Enter) or the first row (ArrowDown) would belong to the query one keystroke earlier.
  const flushSearch = () => {
    if (deb) { clearTimeout(deb); deb = null; libraryView.renderSearchResults(search.value, null); }
  };
  // The field's own keys. Every key it handles is prevented, so the document key router (and the
  // browser) never act on it a second time.
  search.onkeydown = (e) => {
    if (e.isComposing) return;
    if (e.key === "Enter") {
      flushSearch();
      const song = libraryView.topHit();
      if (!song) return;
      // Prevented: the panel is about to close and hand focus back to its opener, and an
      // unprevented Enter would go on to activate that button too.
      e.preventDefault();
      // search.enterAction — "auto" reserves while a song is playing or loading, plays when idle.
      if (enterDecision(settings.get("search.enterAction"), !!(current || loadingSong)) === "reserve") {
        enqueue(song);
        setStatus(`Reserved: ${song.name || song.code || "a song"}`);
      } else {
        playNow(song);
      }
      if (search.value) clearBtn.onclick();   // clear the field and show the whole library again
      closeOverlay("search");                 // a song was taken from the panel: it has done its job
    } else if (search.value && keyToAction(e, { typing: true })?.action === "back") {
      // Back step 1 (Escape, BrowserBack, a TV remote's Back): a field with text clears first;
      // the next Back closes the panel.
      e.preventDefault(); e.stopPropagation();
      clearBtn.onclick();
    } else if (e.key === "ArrowDown" && noMods(e)) {
      // Into the list: its roving row (the first row of a fresh result). Empty list → the key
      // goes on to the router, which finds nothing below and leaves focus here.
      flushSearch();
      if (lib.focusRow()) e.preventDefault();
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
  $("queue-clear").onclick = () => { clearQueueAsk(); };   // the Queue panel's "Clear all"

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
  // Volume. With data-nav-axis="vertical" (A9) the range keeps Up/Down (its native value change)
  // and gives Left/Right to the D-pad, so the bar stays walkable past it. A change made by a key
  // shows the adjust toast; a pointer drag stays silent. The flag lives for one task: the range's
  // own `input` event fires during the keydown's default action, before the timeout runs.
  const vol = $("volume");
  let volByKey = false;
  vol.addEventListener("keydown", () => { volByKey = true; setTimeout(() => { volByKey = false; }, 0); });
  vol.oninput = (e) => {
    settings.set("audio.volume", +e.target.value);
    if (volByKey) showAdjust(`Volume ${Math.round(+e.target.value * 100)}%`);
  };

  $("seek-track").onclick = (e) => {
    if (!current || media.duration <= 0) return;
    const rect = e.currentTarget.getBoundingClientRect();
    media.seek(((e.clientX - rect.left) / rect.width) * media.duration);
  };

  // Global keys (Space, [ / ], the media and remote keys…) belong to the one key router
  // (routeKey, installed by buildShell → buildKeys).

  // reflect persisted bottom-control values
  updateMelodyToggle();
  $("tempo-val").textContent = `${(+settings.get("audio.tempo")).toFixed(2)}×`;
  $("volume").value = settings.get("audio.volume");
  $("key-val").textContent = fmtKey(settings.get("audio.key"));
  libraryView.updateYoutubeToggle(); // reflect the persisted 🌐 toggle + browser support
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
  showAdjust(`Lyrics offset ${v > 0 ? "+" : ""}${v} ms`);
}

// The "adjust" toast: the new value after a key-driven change ("Key +2", "Tempo 0.95×",
// "Melody off", "Lyrics offset +50 ms", "Volume 95%"). A non-modal overlay that the stack
// closes after its 2500 ms period (the shell's 250 ms tick drives that). Opened without user
// activation so it never takes focus or a history entry; a repeat while it is up just restarts
// its timer.
function showAdjust(text) {
  const el = $("ov-adjust");
  if (el) el.textContent = text == null ? "" : String(text);
  if (!overlays.open("adjust", { activated: false, opener: null })) stack.touch("adjust");
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
  // It is a button that opens the queue (the shell wires it); its name carries the count too,
  // so what is read out matches what is shown.
  const qEl = $("queue-count");
  if (qEl) {
    const qText = queue.length ? `⏭ ${queue.length}` : "";
    if (qText !== _queueCount) {
      qEl.textContent = qText; _queueCount = qText;
      qEl.setAttribute("aria-label", queue.length ? `Open the queue, ${queue.length} queued` : "Open the queue");
    }
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
  // A MIDI song held behind the title card starts from a timer. If the stage is cleared before
  // that timer fires (queue drained, a skip, a failure), the timer still fires and calls
  // audio.play() with `current` already null — the song plays on with no title and no lyrics,
  // and nothing can end it because the rAF loop's `current && media` branch is skipped.
  clearTimeout(playDelayTimer);
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
  buildSearchIndex();   // BEFORE the re-render: no close query may reach the old list's index
  libraryView.renderSearchResults($("search").value, null);
  setStatus(`${n.toLocaleString()} songs loaded`);
  return { ok: true, records: n };
}

// The close-match index over every title + artist (search-client.js). Never awaited: the
// number and exact tiers do not need it, and close matches simply start once it is ready.
function buildSearchIndex() {
  const songs = catalog.songs;
  searchClient.build(songs.map((s) => s.name || ""), songs.map((s) => s.artistName || ""))
    .catch((e) => console.error("Close-match index failed to build:", e));
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

// The one status line (#status, outside the stage) belongs to the shell; before the shell
// exists (nothing calls this that early today) write it directly.
function setStatus(msg) {
  if (shell) shell.setStatus(msg);
  else { const el = $("status"); if (el) el.textContent = msg; }
}
// Reflects the *real* playback state. A MIDI song at its stalled end reports
// paused===false (§5.14) while nothing is actually sounding, so treat `audio.ended`
// as stopped too. Only writes on change so it's cheap to call every rAF frame.
function isPlaying() { return !media.paused && !(media === audio && audio.ended); }
function setPlayIcon() {
  const playing = isPlaying();
  const href = playing ? "#i-pause" : "#i-play";
  const el = $("play-icon");   // the <use> inside the play button's sprite icon
  if (el && el.getAttribute("href") !== href) el.setAttribute("href", href);
}
function fmtKey(s) { return (s > 0 ? "+" : "") + s; }
function fmt(s) { s = Math.max(0, s | 0); return `${(s / 60) | 0}:${String(s % 60).padStart(2, "0")}`; }

boot();
