/*
 * app.js — the player / orchestrator.
 *
 * Owns playback (queue, current song, load → synth + lyrics + guide), the
 * requestAnimationFrame loop (lyric sync, pitch guide, scoring, auto-tune), the
 * transport controls, and the "settings → app" glue (what each setting change
 * actually does). The page is ONE full-screen stage (its footer holds the panel buttons, the status
 * line and the seek bar); everything above it (Songs — with the queue as a tab — Mixer, Settings,
 * the song sheet, the dialogs, the adjust toast) is an overlay of one stack:
 *   - ui/overlay-stack.js : the stack's state (built here, shared by the two below)
 *   - ui/overlays-dom.js  : hidden / inert / scrim / focus / history for every overlay
 *   - ui/shell.js         : the footer's panel buttons, idle / kind, the toast's tick
 *   - ui/browse-ui.js     : the Songs panel's tabs (All · Artists · Rankings · Queue) and rankings table (M6)
 * The big UI surfaces are delegated:
 *   - library-ui.js  : song list (songs and artists), search results, queue rendering
 *   - settings-ui.js : the ⚙ panel (control ↔ Settings wiring)
 *   - backgrounds.js : the videos / photos / camera behind the lyrics (M11; app.js says when)
 * Everything else (audio, lyrics, melody/key, mic, settings store) lives in
 * its own module; this file wires them together.
 */

import { Catalog, digitsOnly } from "./catalog.js";
import { AudioEngine } from "./audio.js";
import { EQ_BANDS, eqGainsFor, melodyLevel, melodyLevelSettings, nextMelodyLevel, melodyLevelLabel } from "./music-fx.js";
import { createLoudnessMeter, createLoudnessStore, gainForDb, followGainDb } from "./loudness.js";
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
import { createTitleCard, titleCardYields } from "./ui/title-card.js";
import { createPlayCounter } from "./play-counts.js";
import { Scorer } from "./scoring.js";
import { createVerdictFeed } from "./verdicts.js";
import { createLibraryUI, BACK_ROW } from "./library-ui.js";
import { createSettingsUI } from "./settings-ui.js";
import { createMidiMixer } from "./midi-mixer.js";
import { createReactions } from "./reactions.js";
import { createDurationHints } from "./duration-hints.js";
import { createScorePresentation, SCORE_CARD_MS } from "./score-presentation.js";
import { createQueue } from "./queue.js";
import { createSession } from "./session.js";
import { createLibraryView, enterDecision } from "./library-view.js";
import { createRankings } from "./rankings.js";
import { createSearchClient } from "./search-client.js";
import { createRemoteGlue } from "./remote-glue.js";
import { createRemoteHost } from "./remote-host.js";
import { buildLyricsDoc } from "./lyrics-doc.js";
import { cachedArrayBuffer, purgeStaleCaches, purgeAllCaches } from "./asset-cache.js";
import { collectAppData, restoreAppData, clearAppData } from "./store.js";
import { createOverlayStack, OVERLAY_DEFS } from "./ui/overlay-stack.js";
import { createOverlays } from "./ui/overlays-dom.js";
import { createShell } from "./ui/shell.js";
import { createSongSheet } from "./ui/song-sheet.js";
import { createBrowseUI } from "./ui/browse-ui.js";
import { createCalibrateUI } from "./ui/calibrate-ui.js";
import { keyToAction, resolveBindings, isFunctionKey } from "./ui/keymap.js";
import { createShortcutsUI } from "./ui/shortcuts-ui.js";
import { createInputMode } from "./ui/input-mode.js";
import { createNav } from "./ui/nav-dom.js";
import { createActions } from "./ui/actions.js";
import { createBackgrounds, resolveMode, shouldShow } from "./backgrounds.js";
import { setupKioskQuit } from "./kiosk.js";

const $ = (id) => document.getElementById(id);
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
  // M8: a number typed by a digit key is a song search — the All tab. The
  // switch (onBrowseTab) draws that tab from the field's text, so typeDigits does not draw again.
  showAllTab: () => {
    if (browseTab() === "all") return false;
    showBrowseTab("all");
    return true;
  },
});
const audio = new AudioEngine();
const reactions = createReactions({ settings, audio });
const durations = createDurationHints();
const score = createScorePresentation({ settings });
const rankings = createRankings();   // the leaderboard (karaeoke.rankings.v1), one row per scored song
// M10 (plan §5.20): each song's learned music loudness (karaeoke.loudness.v1) and the meter that
// learns it while the song plays. Driven by the loudness controller below (loudnessBegin / tick).
const loudStore = createLoudnessStore();
const loudMeter = createLoudnessMeter();
let lyrics, mic, pitchGuide, video, youtube, chordEngine, audioFile; // created at boot (need the DOM)
let lib, settingsUI, midiMixer, songSheet, titleCard, shortcutsUI;  // UI modules (created at boot)
let browseUI;                    // the Songs panel's tabs and the rankings view (created at boot)
let stack, overlays, shell; // the stage-first shell (created at boot — see buildShell)
let inputMode, nav, actions;     // keys and D-pad (created at boot — see buildKeys)
// id → the element registered for that overlay, kept beside the overlays.register calls: the
// D-pad's scope is the top modal's element (nav.getOverlayEl).
const overlayEls = new Map();
let stageKind = "";              // the loaded song's kind as last told to the shell ("" = none)
// M11: the background behind the lyrics (backgrounds.js on #bg-layer). Created at boot; null when
// it could not be built — every caller checks, because a background must never break the player.
let bg = null;

let remoteHost;                  // host↔phone relay driver (created at boot)

// --- mutable player state ---------------------------------------------------
// The queue owns its own two parallel arrays (song + who reserved it); every mutation renders,
// persists and pushes to the phones through this one callback.
const queue = createQueue({
  onChange() {
    renderQueueView();
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
// The phones' lyric document (M7). `songRev` counts loaded songs: each play* bumps it once the
// song's lyrics are in, and it rides in getNowPlaying() so a phone knows to fetch the new
// document. `revSong` is the song it was bumped for — `current` is written BEFORE a play*'s
// first await, so for a moment it can name a song whose lyrics are not loaded yet.
let songRev = 0;
let revSong = null;
let songDocDur = -1;             // the duration the last published document carried (-1 = none sent)
let currentMelodyChannel = -1;
let scorer = null;               // scoring.js Scorer for the current MIDI song (null = nothing to score)
let verdictFeed = null;          // verdicts.js feed judging `scorer`'s notes (null whenever scorer is)

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
  // M11 (plan §5.22): videos, photos or the camera behind the lyrics. Its list is fetched once the
  // catalogue has loaded (startBackgrounds); until then it shows nothing.
  try {
    bg = createBackgrounds({
      el: $("bg-layer"),
      settings,
      fetchList: () => fetch("/api/backgrounds").then((r) => r.json()),
      onStatus: (m) => setStatus(m),   // "camera blocked", …
    });
  } catch (e) {
    bg = null;
    console.error("Backgrounds unavailable:", e);
  }

  lib = createLibraryUI({
    // The pre-M5 row path (double-click / Enter plays). With onActivate below no row calls it;
    // it stays so the list keeps a meaning for "play" if onActivate is ever dropped.
    onPlay: (s) => { playNow(s); closeOverlay("search"); },
    onQueue: enqueue, onRemoveFromQueue: removeFromQueue,
    onToggleFavorite: (s) => libraryView.toggleFavorite(s), isFavorite: (s) => libraryView.isFavorite(s),
    // P23 (M5): a click, a tap or Enter on a row body opens the song sheet. ★ / ＋ on a song row
    // and ✕ on a queue row keep their direct actions; Space still selects, "+" still queues.
    onActivate: (song, rowEl) => openSheet(song, rowEl, "library", +rowEl.dataset.index),
    onQueueActivate: (index, song, rowEl) => openSheet(song, rowEl, "queue", index),
    // M6: an artist row (or "← Artists") opens that artist's songs (or the artist list again).
    onArtist: (key) => openArtist(key),
  });
  // M6: the Songs panel's tabs (and the Queue tab's count) and the rankings table. It draws the
  // controls only; the list is still library-ui's, and what it shows is library-view's.
  browseUI = createBrowseUI({
    tabsEl: $("browse-tabs"), paneEl: $("browse-pane"),
    getRankings: ({ player = "", difficulty = "" } = {}) => ({
      rows: rankings.top({ player, difficulty, limit: 50 }),
      players: rankings.players(),
      difficulties: rankings.difficulties(),
    }),
    onTab: onBrowseTab,
    onClearRankings: () => { clearRankingsAsk(); },
  });
  // The one "what do you want to do with this song?" sheet. It only renders and reports the
  // choice; onSheetAction carries it out (the queue, the player and the overlays are ours).
  songSheet = createSongSheet({ el: $("ov-song"), onAction: onSheetAction });
  titleCard = createTitleCard({ el: $("title-card") });   // the videoke-style intro card (Rae, 2026-11-24)
  settingsUI = createSettingsUI({
    settings, mic, onRebuild, onToggleMic: toggleMic, onCalibrate: openCalibration, onEraseAll: eraseAllData,
    onExportData: exportAppData, onImportData: importAppData,
    // R35: Reset to defaults asks first (Cancel focused, Back = Cancel).
    confirmReset: () => overlays.confirm({
      title: "Reset every setting?",
      text: "Every setting goes back to its default — custom shortcuts, the microphone latency and the EQ too.",
      okLabel: "Reset",
    }),
  });
  midiMixer = createMidiMixer({ container: $("midi-mixer"), audio });
  remoteHost = createRemoteHost({
    getSnapshot: () => remoteGlue.snapshot(),
    // Push the new state the moment a guest command lands (a pause, a refusal's notice) instead of
    // on the next ~1 s tick — the phone's round trip. Inside a POST this coalesces into ONE
    // follow-up POST, and that one acks the command, so it cannot loop.
    applyCommand: (cmd) => { remoteGlue.applyCommand(cmd); remoteHost.push(); },
    // Read after every accepted POST, so "Instant updates" off closes the event stream and on
    // opens it without rebuilding the host (its command-seq bookkeeping survives the change).
    push: () => !!settings.get("remote.push"),
    // The relay restarted or the room lapsed: it no longer holds this song's lyric document.
    onRelayReset: () => publishCurrentSong(),
    onPushStatus: () => updatePushStatus(),   // "Phones: instant / polling" in ⚙ Remote and on the Queue tab
  });
  mic.onStatus = (m) => { $("mic-status").textContent = m; settingsUI.updateMicBtn(); };
  buildShell();          // the overlay stack, every overlay, the stage footer and the home layer

  applyVisualSettings();
  applyGuideSettings();
  applyChordSettings();
  applyMidiMode();
  applyRemoteMode();
  applyFontSize();       // set the text scale before first paint of the list/guide
  applyTheme();          // color theme: dark / light / auto (follows the OS)
  applyOverscan();       // TV overscan inset → --overscan
  applyKeyHints();
  applyKeypad();         // the home hint follows keypad.enabled
  settingsUI.syncSettingsUI();
  applyBluetoothMode();
  // M10: hand the engine the music-bus settings now. It keeps them until its context and synth
  // exist, so an audio or video song played before any MIDI song (no ensureEngine) gets the EQ.
  audio.setTransposeDrums(!!settings.get("audio.transposeDrums"));
  applyMusicFx();

  try {
    const n = await catalog.load(settings.get("data.catalogUrl"), settings.get("data.videoCatalogUrl"), settings.get("data.audioCatalogUrl"));
    setSongCount(n);
    durations.load(); // learned song lengths → queue ETA on the phones
    // "Tonight's recap" was removed (Rae, 2026-11-24): forget its stored log once.
    try { localStorage.removeItem("karaeoke.recap.v1"); } catch { /* storage blocked */ }
    libraryView.loadYoutubeCache(); // re-register persisted YouTube songs so favorites/recent/queue resolve them
    libraryView.loadBlocked();      // hide videos that previously failed to embed
    libraryView.seedServerBlocklist();
    libraryView.loadFavorites();    // restore starred songs (resolved by id) before the first render
    renderBrowse();                 // the tabs (shown once a catalogue is in)
    libraryView.renderAll();
    loadSession(); // restore queue + recently-played (no auto-play)
    // Its own task, not awaited: the hand-off copies every title + artist, and should not
    // lengthen the task that paints the list. Close matches start once the index is ready.
    setTimeout(buildSearchIndex, 0);
  } catch (e) {
    setStatus("Failed to load catalog.json — is the server running from the project root?", { error: true });
    console.error(e);
    songCountText = "No catalogue";   // the status line said "Loading…" for good (review R11)
    updateStatusLine();
    libraryView.renderCatalogError();
  } finally {
    document.body.classList.remove("booting");
  }
  startBackgrounds();    // M11: the background list, after the catalogue (never awaited)
  wireUI();
  // The shortcut list goes in BEFORE settings-ui wires its search: that index is built once.
  shortcutsUI = createShortcutsUI({
    el: $("set-shortcuts"),
    getOverrides: () => settings.get("keys.bindings"),
    setOverrides: (o) => settings.set("keys.bindings", o),
  });
  shortcutsUI.render();
  settingsUI.wireSettings();
  settings.onChange(onSettingChanged);
  requestAnimationFrame(tick);
}

// ---------------------------------------------------------------------------
// The stage-first shell: one overlay stack, the DOM side of every overlay, the stage footer
// and the home layer. Ownership is split on purpose (each owner is the only writer):
//   - overlays-dom: `hidden`/`.open` on every overlay, `inert`, #scrim, focus, history,
//     body[data-ov] / body[data-panel];
//   - shell: the footer's panel buttons and its auto-hide (body.foot-hidden), body[data-idle] /
//     [data-kind];
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
  reg("search", {
    el: $("ov-search"),
    // Keys: the last focused row (the roving one — a song or, on the Artists tab, an artist),
    // else the first; an empty list → the field. The Rankings tab hides the list: its first
    // control, else the selected tab. Touch / mouse: the field. The Queue tab (2026-11-24): keys
    // → the first queue row (Enter opens the song sheet, never a removal); touch / mouse, or an
    // empty queue → the Queue tab itself (no keyboard popping up over the queue on a phone).
    initialFocus: () => {
      if (browseTab() === "queue") {
        if (keysMode() && lib.focusQueueRow(0)) return document.activeElement;
        return selectedTabEl() || $("search");
      }
      if (keysMode()) {
        if (browseTab() === "rankings") return rankingsFocusTarget() || $("search");
        if (lib.focusRow()) return document.activeElement;
      }
      return $("search");
    },
    // Opened for the queue (Q, Green, the queue count) → the Queue tab. Opened any other way (the
    // Songs button, F1, S, /, a digit) while it was left on the Queue tab → All: search means
    // search. Runs before the initial focus (overlays-dom focuses after onOpen).
    onOpen: () => {
      const want = songsOpenTab || (browseTab() === "queue" ? "all" : null);
      songsOpenTab = null;
      if (want) showBrowseTab(want);
      remeasure();
    },
    onClose: () => { digitOpened = false; songsOpenTab = null; },   // M8: only an open panel can be "opened by a digit"
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
  // The calibration dialog (M9) is built on first use (openCalibration), hence the closures:
  // focus its step's first button; any close (Back, the scrim, Cancel) stops a measurement.
  reg("calibrate", {
    el: $("ov-calibrate"),
    initialFocus: () => (calibrateUI ? calibrateUI.firstButton() : null),
    onClose: () => { if (calibrateUI) calibrateUI.close(); },
  });
  reg("confirm", { el: $("ov-confirm"), initialFocus: () => $("ov-confirm-cancel") });
  overlays.wire();

  shell = createShell({ overlays, stack, settings, actions: { fullscreen: toggleFullscreen, queue: (el) => toggleQueueTab(el) } });
  shell.wire();
  wireFooter();   // the status line's − + steps and the seek bar (Rae, 2026-11-24)
  // Kiosk host (serve-lan.sh on a Steam Deck, Rae 2026-11-25): the footer's Exit button, shown only
  // when the server runs with --kiosk and this is its own screen. The launcher closes the browser.
  setupKioskQuit({
    button: $("btn-quit"),
    confirm: (opts, openOpts) => overlays.confirm(opts, openOpts),
    onStopped: () => {
      stopSong();
      const s = $("quit-screen");
      if (s) s.hidden = false;
    },
    onError: (msg) => setStatus(msg, { error: true }),
    closeWindow: () => { try { window.close(); } catch { /* not script-closable: the launcher closes it */ } },
  }).catch(() => {});

  buildKeys();   // input mode, D-pad navigation, the named actions, the one key router, media keys

  // An open or closing panel reflows the stage beside it (never over the lyrics), and the
  // overscan inset moves it in from the edges. The stage lyric canvas re-measures itself; the
  // pitch guide only did on a window resize, so watch its box too.
  if (typeof ResizeObserver === "function") {
    let raf = 0;
    const ro = new ResizeObserver(() => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => { if (pitchGuide) pitchGuide.resize(); });
    });
    const pg = $("pitch-guide");
    if (pg) ro.observe(pg);
    // The footer (status line, panel buttons, seek bar) sits over the bottom of the stage and
    // wraps by size. Publish its real height as --foot-h so the flow and the home layer keep that
    // strip clear: the lyrics never sit under it.
    const foot = $("stage-foot");
    if (foot) new ResizeObserver(() => {
      document.documentElement.style.setProperty("--foot-h", `${Math.ceil(foot.getBoundingClientRect().height)}px`);
    }).observe(foot);
  }
}

/** Close an overlay if it is open (a no-op otherwise). */
function closeOverlay(id) {
  if (overlays && overlays.isOpen(id)) overlays.close(id);
}

// ---------------------------------------------------------------------------
// Browse (M6, plan §5.6 / §5.9): the Songs panel's tabs (All · Artists · Rankings). browse-ui.js
// draws them and the rankings table; the list is still the one virtual list (library-ui), and what
// it shows is library-view's — every song, best match first (the songbook / type chips and the
// sort were removed on 2026-11-24). A reload starts on All.
// ---------------------------------------------------------------------------
const browseTab = () => (browseUI ? browseUI.tab : "all");
/** Switch the Songs panel to tab `id`; a no-op when it is already there (onBrowseTab does the work). */
function showBrowseTab(id) { if (browseUI && browseUI.tab !== id) browseUI.setTab(id); }
/** The Songs panel's selected tab button (null before the catalogue loads). */
function selectedTabEl() {
  const tabs = $("browse-tabs");
  return (tabs && !tabs.hidden && tabs.querySelector('[role="tab"][aria-selected="true"]')) || null;
}
/** The queue is on screen: the Songs panel is open on its Queue tab. */
const queueTabShown = () => overlays.isOpen("search") && browseTab() === "queue";

// The tab the next opening of the Songs panel lands on (openQueueTab sets it; onOpen reads it).
let songsOpenTab = null;
/**
 * Show the queue — Q, the Green key, the "Open queue" shortcut and the queue count (Rae,
 * 2026-11-24: the queue is a tab of Songs, after Rankings). Closed → open on the Queue tab;
 * open on another tab → switch to it (keys: onto the first row). False under the song sheet or a
 * dialog (it would swap the panel the sheet was opened from).
 */
function openQueueTab(opener = null) {
  if (sheetOrDialogOnTop()) return false;
  if (overlays.isOpen("search")) {
    showBrowseTab("queue");
    if (inputMode && inputMode.mode === "keys" && !lib.focusQueueRow(0)) focusSelectedTab();
    return true;
  }
  songsOpenTab = "queue";
  overlays.open("search", opener ? { opener } : undefined);
  const ok = overlays.isOpen("search");
  if (!ok) songsOpenTab = null;
  return ok;
}
/** The queue count in the queue bar: the Queue tab, or closes the panel when that is what shows. */
function toggleQueueTab(opener) {
  if (queueTabShown() && stack.top() === "search") { overlays.close("search"); return; }
  openQueueTab(opener);
}

/** (Re)build the tabs — after the catalogue loads and after a rebuild. */
function renderBrowse() {
  if (browseUI) browseUI.render();
}

/** browse-ui's onTab: what the list shows on each tab. */
function onBrowseTab(id) {
  const list = $("song-list");
  const qv = $("queue-view");
  const q = $("search").value;
  cancelSearchDebounce();               // a keystroke's pending render belongs to the old tab
  libraryView.cancelYoutubeSearch();
  // The queue view shows on the Queue tab only; focus inside it when it goes moves to the tab.
  if (qv && id !== "queue" && !qv.hidden) {
    const had = qv.contains(document.activeElement);
    qv.hidden = true;
    if (had) focusSelectedTab();
  }
  if (id === "rankings" || id === "queue") {
    libraryView.leaveSpecialViews();    // Recent / Favorites are views of the All tab
    libraryView.showNone();             // nothing late (a close tier, YouTube) draws into the hidden list
    if (list) {
      const had = list.contains(document.activeElement);
      list.hidden = true;               // the rankings table (browse-pane) or the queue takes its place
      if (had) focusSelectedTab();
    }
    if (id === "queue" && qv) qv.hidden = false;
    return;
  }
  if (list) list.hidden = false;        // BEFORE drawing: the virtual window reads the list's height
  if (id === "artists") {
    libraryView.leaveSpecialViews();
    libraryView.showArtists(q);         // the field's text filters artist names on this tab
  } else {
    libraryView.showAll(q);             // the current search (or Recent / Favorites), re-run
  }
}

function focusSelectedTab() {
  const tabs = $("browse-tabs");
  const t = tabs && tabs.querySelector('[role="tab"][aria-selected="true"]');
  if (t) t.focus({ preventScroll: true });
}

/** Keys on the Rankings tab: the first control of the rankings view, else the selected tab. */
function rankingsFocusTarget() {
  const pane = $("browse-pane");
  const first = nav && pane && !pane.hidden ? nav.focusables(pane)[0] : null;
  const tabs = $("browse-tabs");
  return first || (tabs && tabs.querySelector('[role="tab"][aria-selected="true"]')) || null;
}

/** An artist row → that artist's songs; the "← Artists" row → the artist list, on the artist we
 *  came from (when the list had focus: a key or a click on a row). */
function openArtist(key) {
  const list = $("song-list");
  const hadFocus = !!list && list.contains(document.activeElement);
  if (key === BACK_ROW) {
    const from = libraryView.artistShown;
    const items = libraryView.showArtists($("search").value);
    const i = from == null ? -1 : items.findIndex((a) => a.key === from);
    if (i > 0 && hadFocus) lib.focusRow(i);   // row 0 already has it (the render restores focus there)
    return;
  }
  libraryView.showArtistSongs(key);           // focus, if the list had it, lands on "← Artists"
}

// "Clear" in the rankings view — behind the confirm dialog (Cancel first; Back = Cancel).
async function clearRankingsAsk() {
  const n = rankings.all().length;
  if (!n) return;
  const ok = await overlays.confirm({
    title: "Clear the rankings?",
    text: `${n} ${n === 1 ? "entry" : "entries"} will be removed.`,
    okLabel: "Clear",
  });
  if (!ok) return;
  rankings.clear();
  if (browseUI) browseUI.refreshPane();
  setStatus("Rankings cleared");
  // The Clear button hides with the last row: never leave focus on <body> inside the open panel.
  const a = document.activeElement;
  if (overlays.isOpen("search") && (!a || a === document.body || !a.isConnected || (a.closest && a.closest("[hidden]")))) {
    const t = rankingsFocusTarget();
    if (t) t.focus({ preventScroll: true });
  }
}

// One leaderboard row per scored song (plan §5.9): the same condition as the score card (a
// result exists), plus score.rankings. It reads `current` / `currentBy`, so it runs BEFORE
// clearStage(). It must never throw: endOfSong has to reach the queue hand-off.
function logRanking(res) {
  if (!res || !current || !settings.get("score.rankings")) return;
  try {
    rankings.add({
      player: currentBy || settings.get("score.hostPlayer"),
      songId: current.id,
      song: current.name,
      artist: current.artistName,
      score: res.score,
      difficulty: res.difficulty || "normal",
      at: Date.now(),
    });
    if (browseUI) browseUI.refreshPane();
  } catch (e) {
    console.error("Could not record the ranking:", e);
  }
}

// ---------------------------------------------------------------------------
// Keys and D-pad (M4, plan §4.3). ONE keydown listener on the document, bubble phase, decides
// what a key means. The protocol is `defaultPrevented`: a widget that handles a key (the song
// list, the search fields, a native control) prevents it and the router ignores it; a widget
// that wants the router to take over (a list edge) does not. No key is handled twice.
// Installed from buildShell, so the keys work while the catalogue is still loading.
// ---------------------------------------------------------------------------
const DIALOGS = new Set(["calibrate", "confirm"]);
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

function buildKeys() {
  inputMode = createInputMode();   // html[data-input] = touch | mouse | keys (hints, the ring's grow)
  inputMode.wire();
  nav = createNav({
    stack,
    getOverlayEl: (id) => overlayEls.get(id) || null,
    // The idle home has nothing to focus since its tiles went (2026-11-24); the footer is always on
    // screen, so it is the bare stage's one scope and the D-pad enters it on Songs.
    getHomeRoot: () => null,
    getBarRoot: () => $("stage-foot"),
    // M11: while the background layer shows its "Tap to start camera" button (data-tap), a D-pad reaches it.
    getExtraRoots: () => { const l = $("bg-layer"); return l && l.hasAttribute("data-tap") ? [l] : []; },
    getBarEntry: () => $("toggle-lib"),
    isIdle: () => document.body.dataset.idle === "true",
    isBarVisible: () => true,
    showBar: () => {},
  });
  // A handler returns false for "not handled" (the key goes through); anything else = handled.
  // `bgNext` (M11) is handled only while a clip or a photo is on the stage, so otherwise the
  // Yellow key is never swallowed.
  actions = createActions({
    back: () => goBack(),
    digit: (d) => digitKey(d),                       // M8: a digit opens Songs with it in the search
    playPause: (arg) => playPauseKey(arg),
    next: () => nextKey(),
    restart: () => { if (!restartSong()) return false; showAdjust("Restart"); return true; },
    stop: () => stopSong(),
    keyUp: () => adjustKey(1),
    keyDown: () => adjustKey(-1),
    tempoUp: () => adjustTempo(0.05),
    tempoDown: () => adjustTempo(-0.05),
    offsetUp: () => { nudgeOffset(10); return true; },     // 10 ms a press (Rae, 2026-11-24)
    offsetDown: () => { nudgeOffset(-10); return true; },
    melodyToggle: () => { stepMelody(); return true; },   // F2 / M / Blue: the next of the five levels
    melodyUp: () => { stepMelodyBy(1); return true; },
    melodyDown: () => { stepMelodyBy(-1); return true; },
    volumeUp: () => adjustVolume(VOLUME_STEP),
    volumeDown: () => adjustVolume(-VOLUME_STEP),
    // F1: Songs open / closed. Under the song sheet or a dialog it does nothing (not beneath them).
    searchToggle: () => {
      if (sheetOrDialogOnTop()) return false;
      if (stack.top() === "search") overlays.close("search"); else overlays.open("search");
      return true;
    },
    // F8: the pitch-guide band on / off.
    guideToggle: () => {
      const on = !settings.get("guide.enabled");
      settings.set("guide.enabled", on);
      showAdjust(`Pitch guide ${on ? "on" : "off"}`);
      return true;
    },
    openSearch: () => {
      if (sheetOrDialogOnTop()) return false;       // a dialog / the song sheet is on top: not under it
      if (overlays.isOpen("search")) {
        if (browseTab() === "queue") showBrowseTab("all");   // search means search
        $("search").focus();
        return true;
      }
      overlays.open("search");
      return true;
    },
    openQueue: () => openQueueTab(),               // the Songs panel's Queue tab (2026-11-24)
    fullscreen: () => { toggleFullscreen(); return true; },
    bgNext: () => {
      if (!bgNext()) return false;
      showAdjust("Next background");   // a key-driven change says what it did, as the others do
      return true;
    },
  });
  document.addEventListener("keydown", routeKey);
  wireTypeToSearch();
  wireDigits();
  wireMediaSession();
}

// The effective key table: the defaults (ui/keymap.js) with the stored overrides (⚙ → Keyboard
// shortcuts) applied. Re-resolved when keys.bindings changes (onSettingChanged).
let keyTable = resolveBindings(settings.get("keys.bindings"));

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
  const hit = keyToAction(e, ctx, keyTable);
  if (!hit) return;
  if (hit.action === "nav") { if (nav.move(hit.arg)) e.preventDefault(); return; }
  // An F-key is ours even when its action declines (Next with nothing queued, F1 under a dialog):
  // otherwise the browser's F1 help, F3 find, F5 reload or F6 address bar would fire.
  if (actions.run(hit.action, hit.arg) || isFunctionKey(e.key)) e.preventDefault();
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
  // 3. focus is in the footer (it never hides) and a song is on the stage → back to the stage
  const foot = $("stage-foot");
  if (foot && foot.contains(a) && document.body.dataset.idle !== "true") {
    const st = $("stage");
    if (st) st.focus({ preventScroll: true });
    return true;
  }
  // 4. nothing: the key goes through (and Back never stops the song)
  return false;
}

// Space / k / the media play-pause keys. MediaPlay and MediaPause carry "play" / "pause" and
// never toggle the wrong way. Nothing loaded: what ▶ does — play a song the user has selected.
function playPauseKey(arg) {
  const want = arg === "play" || arg === "pause" ? arg : "toggle";
  // The end-of-song hand-off: `current` is still the song that just ended (endOfSong keeps it for
  // the card, the ranking and the loudness learner; advanceQueue moves on). Toggling it would
  // restart a finished song under the card — the key is taken and does nothing (review R12).
  if (endGuard) return true;
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
  playCounter.stop();
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

// The browse tabs are on screen (browse-ui unhides them once the catalogue loads).
const browseControlsShown = () => { const el = $("browse-tabs"); return !!el && !el.hidden; };

// Type-to-search (§4.3): on a song row, a printable key moves focus to the search field BEFORE
// the browser inserts the character, so the character lands there. Bubble phase on the panel:
// after the list's own handler (which prevents Space / "+" / "=" and its movement keys), before
// the document router. Digits included — the key map leaves them alone on a row in Songs.
function wireTypeToSearch() {
  const panel = $("ov-search"), field = $("search");
  if (!panel || !field) return;
  panel.addEventListener("keydown", (e) => {
    if (e.defaultPrevented || e.isComposing) return;
    // A song row, or (the Queue tab, 2026-11-24) a queue row: typing on either is a song search.
    const row = e.target && e.target.closest ? e.target.closest(".song, .qsong") : null;
    if (!row) return;
    // The list's top edge. The list released this key (listKeyPlan). Without the browse controls
    // the row above is the search row, where spatial navigation would have to pick between the
    // field and the filter pills on the same line — a tie decided by sub-pixel rounding — so the
    // panel takes it to the field, deterministically. M6: with the tabs between the list and the
    // field, the key goes on to the router, which moves up to them — otherwise the tabs could
    // never be reached with a D-pad (ArrowDown in the field still jumps straight to the list).
    if (e.key === "ArrowUp" && noMods(e) && row.dataset.index === "0" && row.classList.contains("song")) {
      if (browseControlsShown()) return;
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

// ---------------------------------------------------------------------------
// Song numbers (M8, plan §4.3 "Digits", §5.3). The search field IS the number entry — no buffer,
// no resolver, no sheet of its own: a number key on the stage (a TV remote) opens Songs with the
// digit in the field, and M2's number tier lists every songbook's match; Enter takes the top hit
// (takeTopHit). The on-screen 123 pad and guests' live digits were removed (Rae, 2026-11-24).
// ---------------------------------------------------------------------------
// The Songs panel was opened by a digit key: only such a panel idle-closes, and
// only while it holds nothing but digits. A word typed, or the user moving onto a row, clears it.
let digitOpened = false;
let lastSearchInput = 0;    // ms of the last key / pointer inside #ov-search
let focusedLast = null;     // the last element that took focus anywhere (see wireDigits)

const keypadOn = () => !!settings.get("keypad.enabled");
const digitChar = (d) => (/^[0-9]$/.test(String(d)) ? String(d) : null);
const isRow = (el) => !!(el && el.closest && el.closest(".song"));

/** Put `text` in the search field and run the search now. */
function typeIntoSearch(text) {
  cancelSearchDebounce();   // a keystroke's pending render must not draw the older text over this
  libraryView.typeDigits(text);
}

function focusSearchField() {
  const f = $("search");
  if (!f) return;
  f.focus({ preventScroll: true });
  const n = f.value.length;
  try { f.setSelectionRange(n, n); } catch { /* not a text type */ }
}

/**
 * The key router's `digit`: a digit on the stage, or in the Songs panel away from its field
 * (in the field it is typing; on a row type-to-search takes it). Closed → open Songs (a user
 * activation: its history entry, its initial focus) with the digit in the field and the caret
 * after it, marked digit-opened. Open → focus the field and append. False lets the key through:
 * number keys off, or the song sheet / a dialog on top (its buttons, not the field beneath).
 */
function digitKey(d) {
  if (!keypadOn() || sheetOrDialogOnTop()) return false;
  const ch = digitChar(d);
  if (ch === null || !$("search")) return false;
  lastSearchInput = Date.now();
  if (!overlays.isOpen("search")) {
    overlays.open("search");
    if (!overlays.isOpen("search")) return false;
    typeIntoSearch(ch);
    focusSearchField();
    // Marked AFTER the open and the render: the panel's initial focus (keys: a row) is not the
    // user moving onto a row.
    digitOpened = true;
    return true;
  }
  typeIntoSearch(libraryView.query + ch);
  focusSearchField();
  return true;
}

/** The 1 s idle check (§4.3 "Digits" 2): a digit-opened panel holding only digits (or emptied
 *  back to nothing) with no key or tap in it for keypad.idleSec clears and closes. */
function checkDigitIdle() {
  if (!digitOpened) return;
  if (!overlays.isOpen("search")) { digitOpened = false; return; }
  if (stack.top() !== "search") return;          // the song sheet / a dialog is up: not idle
  const q = libraryView.query;
  if (q.trim() && !digitsOnly(q)) { digitOpened = false; return; }
  const sec = Number(settings.get("keypad.idleSec"));
  const idleMs = (Number.isFinite(sec) ? Math.min(30, Math.max(3, sec)) : 8) * 1000;
  if (Date.now() - lastSearchInput < idleMs) return;
  digitOpened = false;
  if (q) clearSearch({ focus: false });
  closeOverlay("search");
}

/** keypad.enabled: the home hint; off also ends any digit entry. */
function applyKeypad() {
  const on = keypadOn();
  const hint = $("home-hint-digits");
  if (hint) hint.hidden = !on;
  if (!on) digitOpened = false;
}

// Installed with the key router (buildKeys), so digits work while the catalogue loads.
function wireDigits() {
  const panel = $("ov-search"), field = $("search");
  if (!panel || !field) return;
  // Capture phase: a key a widget prevents (the list's arrows, the field's Enter) still counts.
  const local = (e) => {
    lastSearchInput = Date.now();
    if (digitOpened && isRow(e.target)) digitOpened = false;   // working the rows: browsing
  };
  panel.addEventListener("keydown", local, true);
  panel.addEventListener("pointerdown", local, true);
  // Focus moving onto a row (from anything that is not a row) clears the mark. A row the list
  // re-focuses after a re-render came from a row, so a re-render never clears it.
  document.addEventListener("focusin", (e) => {
    const t = e.target;
    if (digitOpened && isRow(t) && panel.contains(t) && !isRow(focusedLast)) digitOpened = false;
    focusedLast = t;
  }, true);
  // A non-digit typed into the field: a word search, never idle-closed.
  field.addEventListener("input", () => {
    if (digitOpened && field.value.trim() && !digitsOnly(field.value)) digitOpened = false;
  });
  setInterval(checkDigitIdle, 1000);
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
  const prev = stageKind;
  stageKind = kind || "";
  shell.setKind(stageKind);
  syncMixerButton();
  if (stageKind !== "midi") closeOverlay("mixer");
  announceMedia(stageKind ? current : null);   // every play* calls this once its song owns the stage
  bgStageChanged(prev);
}
function syncMixerButton() {
  const b = $("btn-mixer");
  if (b) b.hidden = !(settings.get("midiMode.enabled") && stageKind === "midi");
}

// ---------------------------------------------------------------------------
// Backgrounds (M11, plan §5.22). backgrounds.js owns #bg-layer — its elements, the shuffle, the
// camera and the dim. What stays here is WHEN: the list after the catalogue, every song change,
// the bg.* settings, the Yellow key / the phone's "bg" / #btn-bg. Every call is guarded: a
// background that fails must never take a song, a key or a setting down with it.
// ---------------------------------------------------------------------------
/** The background's RESOLVED mode — what the layer is showing (or would show on a stage that shows
 *  backgrounds): "video" | "photo" | "camera" | "off". backgrounds.js's own state is the truth (it
 *  resolves against the category-filtered list, and a blocked camera reads "off"); resolveMode over
 *  the whole list is only the fallback. */
function bgMode() {
  if (!bg) return "off";
  try {
    const m = bg.state && bg.state.mode;
    return typeof m === "string" ? m : resolveMode(settings.get("bg.mode"), bg.list || {});
  } catch { return "off"; }
}
/** A clip or a photo is on the stage now: video / photo mode, and a stage that shows backgrounds
 *  (a MIDI or audio song, or the idle home layer — never a video or YouTube song). */
function bgOnStage() {
  const m = bgMode();
  if (m !== "video" && m !== "photo") return false;
  try { return !!shouldShow(stageKind, !stageKind); } catch { return false; }
}

// The list is fetched once the catalogue has loaded; a failure (an older server without
// /api/backgrounds, a parse error) leaves an empty list. Either way the settings are applied:
// a stored Camera mode needs no list.
function startBackgrounds() {
  if (!bg) return;
  let p;
  try { p = Promise.resolve(bg.init()); } catch (e) { p = Promise.reject(e); }
  p.catch((e) => console.warn("Background list unavailable:", e)).then(() => {
    if (!bg) return;
    try {
      bg.applySettings({ gesture: false });       // a stored Camera mode asks the permission first (R27)
      bg.onSongChange(stageKind, !stageKind);     // whatever owns the stage by now (usually: idle)
    } catch (e) {
      console.error("Background failed to start:", e);
    }
    syncBgCategories();
    syncBgButton();
  }).catch((e) => console.error("Background failed to start:", e));
}

// setStageKind is the one funnel for both halves of the idle rule (§5.34): every play* calls it
// once its song owns the stage (after its stale checks), and the three setIdle(true) callers call
// it with "" — never clearStage(), which also runs between queued songs. So the background hears
// each new song once (and advances when bg.changeOnSong), and idle → idle is not a change.
function bgStageChanged(prev) {
  if (bg && (stageKind || prev)) {
    try { bg.onSongChange(stageKind, !stageKind); }
    catch (e) { console.error("Background update failed:", e); }
  }
  syncBgButton();
}

// bg.* changed. Picking Camera in Settings is a user gesture, so that one change may call
// getUserMedia at once; a stored mode, a reset or an import asks the permission first and
// otherwise shows "Tap to start camera" (R27). A new Back / Front pick while on Camera is the
// same kind of gesture. `bgPickGesture` is raised by the capture-phase listener in wireUI, which
// runs before settings-ui's own change listener stores the value and lands here.
let bgPickGesture = false;
function applyBackgroundSettings(path) {
  const gesture = bgPickGesture && settings.get("bg.mode") === "camera" && (path === "bg.mode" || path === "bg.camera.facing");
  bgPickGesture = false;
  if (!bg) return;
  try { bg.applySettings({ gesture }); }
  catch (e) { console.error("Background settings failed:", e); }
  if (path === "*" || path === "bg.mode" || path === "bg.category") syncBgCategories();
  syncBgButton();
}

// Settings → Background → Category: "All" + the folders of the kind on show (camera / off: none).
function syncBgCategories() {
  if (!settingsUI) return;
  const m = bgMode();
  const cats = (bg && bg.list && bg.list.categories) || {};
  const names = m === "video" ? cats.videos : m === "photo" ? cats.photos : [];
  settingsUI.setBgCategories(Array.isArray(names) ? names : []);
}

// #btn-bg ("Next background") shows only while a clip or a photo is on the stage. Hiding it while
// it holds focus would drop focus to <body> (M4: never), so focus moves to Settings beside it.
function syncBgButton() {
  const b = $("btn-bg");
  if (!b) return;
  const show = bgOnStage();
  if (!show && !b.hidden && document.activeElement === b) {
    const s = $("btn-settings");
    if (s) s.focus({ preventScroll: true });
  }
  b.hidden = !show;
}

/** The `bgNext` action (the Yellow key, the phone's "bg", #btn-bg): the next clip or photo.
 *  Handled only while one is on the stage; otherwise false, so the key goes through. */
function bgNext() {
  if (!bgOnStage()) return false;
  try { bg.next(); }
  catch (e) { console.error("Next background failed:", e); }
  return true;
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

// The M10 music-bus settings (plan §5.18–§5.20). They change only from the ⚙ panel, while the
// transport's volume / tempo / key fire on every step of a drag — so each half re-applies only
// for its own paths ("*" = a reset or the engine coming up: both).
const MUSIC_FX_PATH = /^audio\.(transposeDrums|reverb|chorus|eq|loudness)(\.|$)/;

function applyAudioSettings(path = "*") {
  const all = path === "*";
  // Drums follow the key only when asked (plan §5.18). The engine STORES the flag and its
  // applyTranspose passes it on, so loadSong's own re-assert keeps it for the next song. Set
  // before the transpose below, which then applies with it.
  if (all || path === "audio.transposeDrums") audio.setTransposeDrums(!!settings.get("audio.transposeDrums"));
  if (all || /^audio\.(reverb|chorus|eq)(\.|$)/.test(path)) applyMusicFx();
  if (all || path.startsWith("audio.loudness.")) applyLoudnessSettings();
  if (!all && MUSIC_FX_PATH.test(path)) return;   // the transport half below is not theirs
  const vol = volumeNow();
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

// The music bus (plan §5.19): the synth's reverb / chorus master levels (0–4, 2 = as authored) and
// the ten-band EQ, which the engine bypasses while the gains are flat. The engine keeps each
// value, so a call before the soundfont has loaded still holds once it has — and the EQ needs no
// synth at all: audio and video songs pass through it too (YouTube cannot; the mic never does).
function applyMusicFx() {
  audio.setReverbLevel(settings.get("audio.reverb"));
  audio.setChorusLevel(settings.get("audio.chorus"));
  audio.setEq(eqGainsFor(settings.get("audio.eq.preset"), eqCustomGains()));
}

// The Custom bands as a plain ten-slot array. settings.js replaces a stored array whole (its
// deep-merge never merges arrays index-wise), so a stored list can only be short or holey if it was
// hand-edited or imported; eqGainsFor turns any missing / non-number slot into 0 dB.
function eqCustomGains() {
  const g = settings.get("audio.eq.gains");
  return Array.from({ length: EQ_BANDS.length }, (_, i) => (g == null ? 0 : g[i]));
}

// ---------------------------------------------------------------------------
// Loudness (M10, plan §5.20) — even out the music's level from song to song.
//   · Each play* (MIDI / audio / video) calls loudnessBegin(song) once the song owns the stage:
//     the meter resets; a song with a learned level gets its gain at once (gainForDb); a first
//     play starts at 0 dB and the follower eases it toward the target as the song goes.
//   · loudnessLive() marks the music as really started — the title-card hold is not measured.
//   · tick() feeds the meter at most every LOUD_SAMPLE_MS while the song plays (not paused).
//   · endOfSong stores the song's level once LOUD_LEARN_SEC of music were measured.
// The meter reads the bus BEFORE the EQ and the loudness gain, divided by the volume² (audio.js),
// so neither the EQ, the correction itself nor the Volume control leaks into what is learned.
// YouTube is skipped (its sound never reaches the bus): gain 0, nothing measured. Off → gain 0,
// nothing measured or stored. Only the state below is written here — never the playback state.
// ---------------------------------------------------------------------------
const LOUD_SAMPLE_MS = 100;   // meter cadence (the follower steps with it)
const LOUD_MAX_DT_SEC = 0.25; // one sample never stands for more (a throttled frame, a hidden tab)
const LOUD_LEARN_SEC = 30;    // music measured before a song's level is worth storing
const loud = {
  songId: null,    // the song being measured / corrected (null = none, or a YouTube song)
  storedDb: null,  // its learned level when it began (null = a first play → the follower)
  gainDb: 0,       // the correction applied now
  live: false,     // its music has really started (not loading, not behind the title card)
  lastMs: 0,       // the last meter sample (performance.now; 0 = re-anchor on the next frame)
};
const loudnessOn = () => !!settings.get("audio.loudness.enabled");
const loudnessTarget = () => {
  const t = Number(settings.get("audio.loudness.targetDb"));
  return Number.isFinite(t) ? Math.max(-30, Math.min(-12, t)) : -24;
};

// A new song takes the stage (each play*, after its stale checks): reset and pick the start gain.
function loudnessBegin(song) {
  loudMeter.reset();
  loud.live = false;
  loud.lastMs = 0;
  // Which Volume the meter divides out (audio.js, plan R12): an audio / video song's key-shift
  // chain, else the synth's. (The synth's own volume is only kept current once it is ready.)
  const kind = song && song.kind;
  if (kind === "audio") audio.setActiveSource("chain", audioFile);
  else if (kind === "video") audio.setActiveSource("chain", video);
  else if (kind !== "youtube") audio.setActiveSource("synth");
  loud.songId = song && kind !== "youtube" && song.id ? song.id : null;
  loud.storedDb = loud.songId ? loudStore.get(loud.songId) : null;
  // gainForDb(null, …) is 0: a first play starts flat and follows.
  loud.gainDb = loud.songId && loudnessOn() ? gainForDb(loud.storedDb, loudnessTarget()) : 0;
  audio.setLoudnessGainDb(loud.gainDb);
}

// The song's music has started (`gen` still current). The gain is re-sent: a video's chain only
// joins the shared context as it plays, so the engine may just now have its bus.
function loudnessLive(song) {
  if (!song || loud.songId !== song.id) return;
  loud.live = true;
  loud.lastMs = 0;
  audio.setLoudnessGainDb(loud.gainDb);
}

// Off → 0 dB now (and tick stops measuring). On, or a new target: a learned song re-derives its
// gain; a first play keeps its current gain and the follower heads for the (new) target.
function applyLoudnessSettings() {
  let g = 0;
  if (loud.songId && loudnessOn()) g = loud.storedDb != null ? gainForDb(loud.storedDb, loudnessTarget()) : loud.gainDb;
  loud.gainDb = g;
  audio.setLoudnessGainDb(g);
}

// Called by tick() every frame; it does its work at most every LOUD_SAMPLE_MS.
function loudnessTick() {
  if (!loud.live || !loud.songId || !current || current.id !== loud.songId || media.paused || !loudnessOn()) {
    loud.lastMs = 0;   // a pause or a stretch with nothing to measure is not measured time
    return;
  }
  const now = performance.now();
  if (!loud.lastMs) { loud.lastMs = now; return; }
  const elapsed = now - loud.lastMs;
  if (elapsed < LOUD_SAMPLE_MS) return;
  loud.lastMs = now;
  const dt = Math.min(LOUD_MAX_DT_SEC, elapsed / 1000);
  loudMeter.add(audio.readMusicMeanSquare(), dt);
  if (loud.storedDb == null) {   // a first play: ease toward the target (held while silent)
    const g = followGainDb(loud.gainDb, loudMeter.db, loudnessTarget(), dt);
    if (g !== loud.gainDb) { loud.gainDb = g; audio.setLoudnessGainDb(g, LOUD_SAMPLE_MS); }
  }
}

// The song reached its natural end (endOfSong, before clearStage drops `current`).
function loudnessEnd(song) {
  if (song && loud.songId === song.id && loudnessOn() && loudMeter.seconds >= LOUD_LEARN_SEC && loudMeter.db != null) {
    loudStore.set(song.id, loudMeter.db);
  }
  loud.live = false;
}

// The list is showing a search (the All tab, not Recent / Favorites): a setting that changes what
// a search returns re-runs it then, and only then.
const showingSearch = () => libraryView.view === "songs" && !libraryView.recentMode && !libraryView.favoritesMode;

function onSettingChanged(path) {
  if (path === "*" || path.startsWith("lyrics.")) applyVisualSettings();
  if (path === "*" || path.startsWith("audio.")) applyAudioSettings(path);   // incl. the M10 music bus
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
  if (path === "*" || path === "lyrics.offsetMs" || path.startsWith("guide.vocal")) updateStatusLine();
  if (path === "*" || path.startsWith("key.") || path === "audio.key") {
    if (path === "key.autoDetect" && lastParsed) currentKey = settings.get("key.autoDetect") ? detectKey(lastParsed) : null;
    updateKeyDisplay();
    // Transpose relabels the chord lane live (root + semitones) — no re-detection.
    if (chordEngine) chordEngine.setTranspose(settings.get("audio.key"));
  }
  if (path === "*" || path.startsWith("chords.")) applyChordSettings();
  if (path === "*" || path === "bt.enabled") {
    applyBluetoothMode(path === "bt.enabled");
    settingsUI.updateCalibrateBtn();   // M9: "Calibrate…" is unavailable in Bluetooth mode
  }
  if (path === "*" || path === "youtube.enabled") {
    libraryView.updateYoutubeToggle();
    // reflect the new state in the current search (append or drop YouTube rows)
    // (only while the list shows a search: not Recent / Favorites, not the Artists / Rankings tab)
    if (path === "youtube.enabled" && showingSearch()) libraryView.runSearch($("search").value);
  }
  // Close matches on/off: redo the current search so the list says what the setting now says.
  if (path === "search.fuzzy" && showingSearch()) libraryView.runSearch($("search").value);
  if (path === "*" || path.startsWith("midiMode.")) applyMidiMode();
  if (path === "*" || path.startsWith("remote.")) applyRemoteMode();
  if (path === "*" || path === "ui.fontSize") applyFontSize();
  if (path === "*" || path === "ui.theme") applyTheme();
  if (path === "*" || path === "ui.overscanPct") applyOverscan();
  if (path === "*" || path === "ui.keyHints") applyKeyHints();
  if (path === "*" || path.startsWith("bg.")) applyBackgroundSettings(path);   // M11
  if (path === "*" || path.startsWith("ui.footer.")) shell.applyAutoHide();   // the footer's auto-hide
  if (path === "*" || path === "keys.bindings") {
    keyTable = resolveBindings(settings.get("keys.bindings"));
    if (shortcutsUI) shortcutsUI.render();
  }
  if (path === "*" || path.startsWith("keypad.")) {
    applyKeypad();
  }
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
    if (lyrics) lyrics.redraw();     // the scale unit (--u) changed the lyric font → re-measure the stage
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
// On resize/rotate (debounced): re-measure the virtual list + guide (the scale unit follows the
// viewport).
let _screenResizeTimer;
window.addEventListener("resize", () => {
  clearTimeout(_screenResizeTimer);
  _screenResizeTimer = setTimeout(() => {
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
    // score.difficulty is read HERE, once: a change applies from the next song, and the scorer
    // and its verdict feed always judge with the same level (an unknown name is "normal").
    const difficulty = settings.get("score.difficulty");
    scorer = mel.hasMelody ? new Scorer(mel.notes, { golden: settings.get("score.golden"), difficulty }) : null;
    verdictFeed = scorer ? newVerdictFeed(scorer, difficulty) : null;
  } catch (e) {
    console.warn("melody extract failed:", e);
    pitchGuide.load({ hasMelody: false, notes: [], range: { min: 60, max: 72 } });
    scorer = null;
    verdictFeed = null;
  }
  score.resetLineBonus();
  pitchGuide.setScore(null);

  currentKey = settings.get("key.autoDetect") ? detectKey(parsed) : null;
  updateKeyDisplay();
}

// Per-note verdicts (M9, plan §5.15) for one scorer: the feed judges each note once it has
// ended and keeps the five tallies for the score card. score.showVerdict reads score.feedback
// itself, so the tallies are kept even while the chips are off. `quietVerdicts` silences the
// end-of-song sweep (the card is about to cover the stage). In its own try: verdicts are a
// garnish, and a throw here must not take the scorer and the guide down with it.
let quietVerdicts = false;
function newVerdictFeed(s, difficulty) {
  try {
    return createVerdictFeed({
      scorer: s,
      difficulty,
      onVerdict: (v) => { if (!quietVerdicts) score.showVerdict(v); },
    });
  } catch (e) {
    console.warn("verdict feed setup failed:", e);
    return null;
  }
}

// The microphone latency the scorer compensates (mic.latencyMs, plan §5.17), in seconds, 0–0.5.
function micLatencySec() {
  const ms = Number(settings.get("mic.latencyMs")) || 0;
  return Math.min(500, Math.max(0, ms)) / 1000;
}

// Key beside the title (current → transposed) + the resulting key on the Key control.
function updateKeyDisplay() {
  const el = $("np-key");
  updateStatusLine();
  const show = settings.get("key.showBadge") && currentKey && currentKey.source !== "none";
  if (!show) { if (el) el.textContent = ""; return; }
  const semis = settings.get("audio.key") || 0;
  const orig = keyName(currentKey.keyPc, currentKey.mode, true);
  const trans = keyName(currentKey.keyPc + semis, currentKey.mode, true);
  el.textContent = semis ? `${orig} → ${trans}` : orig;
  el.classList.toggle("uncertain", currentKey.confidence > 0 && currentKey.confidence < 0.7);
  el.title = `Detected key (${currentKey.source}${currentKey.source === "analysis" ? `, ${Math.round(currentKey.confidence * 100)}% conf.` : ""})`;
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

// The Songs panel's Queue tab: the list, its "Clear all" button (only with something to clear)
// and the count on the tab. Every queue change comes through here (queue.onChange; loadSession,
// because a restore is silent).
function renderQueueView() {
  lib.renderQueue(queue.list, queue.listBy);
  if (browseUI) browseUI.setCount("queue", queue.length);
  const clr = $("queue-clear");
  if (!clr) return;
  const hide = !queue.length;
  // Hiding a focused button drops focus to <body> inside an open panel (the queue ran dry, or
  // Clear all just emptied it): hand it to the Queue tab first.
  if (hide && !clr.hidden && document.activeElement === clr) {
    const to = selectedTabEl() || ($("ov-search") && $("ov-search").querySelector(".ov-close"));
    if (to) to.focus({ preventScroll: true });
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
  // Reserve and Play next write their toast BEFORE acting: with nothing playing they start the
  // song at once, and anything the play path says (an error) should then win.
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
      closeOverlay("search");
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
  // queue leaves focus where the re-render put it: the Queue tab.
  if (focusAt >= 0 && queueTabShown()) lib.focusQueueRow(focusAt);
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
    // The song's detected (root) key, so a phone can show "D maj → E maj" beside its Key ± (Rae,
    // 2026-11-25). Null when none is known: video / YouTube / audio songs, or detection off.
    key: currentKey && currentKey.source !== "none" ? { pc: currentKey.keyPc, mode: currentKey.mode } : null,
    // Which lyric document describes this song (remote-glue lifts it to the snapshot's top
    // level). Inside this getter on purpose: §5.29 rule 2 allows exactly one.
    songRev,
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
      updateStatusLine();              // …and the status line's values
    },
    // M7. remote-glue gates these first (remote.guestPlayNow / remote.guestPriority, fair play,
    // the per-guest cap); what is left here is the playback state only app.js may write.
    playNow: (song, by) => playNow(song, by),
    playNext: (song, by) => {
      queue.addFront(song, by);                       // an explicit jump, as the host sheet's Play next
      if (!current && !loadingSong) advanceQueue();   // enqueue's auto-start guard (§5.29 rule 4)
    },
    restart: () => restartSong(),
    bgNext: () => { bgNext(); },                      // M11: the next clip / photo (a no-op otherwise)
  },
});

function applyRemoteMode() {
  const on = !!settings.get("remote.enabled");
  document.body.classList.toggle("remote-on", on);
  // Where the stage shows the QR ("idle" | "always" | "never"); the CSS reads it with remote-on.
  document.body.dataset.qr = settings.get("remote.qrOnStage");
  if (!remoteHost) return;
  if (!on) remoteHost.stop();
  // Already running: push now, so a remote.* change reaches the phones at once (guest Play now
  // appearing) and a remote.push change opens or closes the event stream after this one POST.
  else if (remoteHost.running) remoteHost.push();
  else { remoteHost.start(); publishCurrentSong(); } // turned on mid-song: the phones need this song's lyrics
  remoteGlue.refreshQr(on); // render/refresh (or clear) the QR in ⚙ Remote, the Queue tab's room line + the stage
  updatePushStatus();
}

// The push channel's state under the QR in ⚙ Remote, and on the Queue tab's room line (refreshed
// on every status change, and here when Remote is toggled). The host's own event stream stands in
// for the phones': same relay, same way.
let _pushLine = null;
function updatePushStatus() {
  const el = $("remote-push-status");
  if (!el || !remoteHost) return;
  const line = $("queue-push");
  const on = !!settings.get("remote.enabled");
  const ps = remoteHost.pushStatus;
  // "connecting" is not "polling": the stream is open and a guest command arrives on it at once;
  // it only waits for the first event (the server's heartbeat comes every 15 s).
  const text = !on ? "" : ps === "push" ? "Phones: instant" : ps === "connecting" ? "Phones: connecting…" : "Phones: polling";
  if (text === _pushLine) return;
  _pushLine = text;
  el.textContent = text;
  el.hidden = !on;
  if (line) line.textContent = text;
}

/**
 * Publish the lyric document for the loaded song (M7, plan §5.14), so phones draw the same lyrics
 * without fetching or parsing song files. Fire and forget: a failure here must never reach the
 * player. Called by each play* once its lyrics are in, again (same songRev) when a duration or an
 * unsynced .txt's line times arrive in tick(), when the relay restarts, and when Remote is turned on.
 */
function publishCurrentSong() {
  songDocDur = -1;
  if (!remoteHost || !current || current !== revSong || !settings.get("remote.enabled")) return;
  try {
    const duration = (media && media.duration) || 0;
    const doc = lyricDocFor(current, duration);
    songDocDur = duration;
    Promise.resolve(remoteHost.publishSong(songRev, current.id, doc))
      .catch((e) => console.warn("Lyric document not published:", e));
  } catch (e) {
    console.warn("Lyric document not published:", e);
  }
}

// MIDI and AUDIO sidecars: what the stage engine was loaded with (raw lines, count-in cues, the
// tempo map — empty for a text sidecar, which has no tempo). A song with no lyrics (instrumental,
// no sidecar, a failed parse: the engine was cleared) has no usable line, and buildLyricsDoc turns
// "lines" with none into "none". VIDEO / YouTube carry their lyrics in the picture.
function lyricDocFor(song, duration) {
  const id = song.id;
  if (song.kind === "video" || song.kind === "youtube") return buildLyricsDoc({ id, kind: "baked", duration });
  const { lines, cues, beats } = lyrics.source;
  return buildLyricsDoc({ id, kind: "lines", lines, cues, beats, duration });
}

// A play* calls this once the song's lyrics are loaded (after its last stale check).
function songLoaded(song) {
  songRev++;
  revSong = song;
  publishCurrentSong();
}

async function remotePlay() {
  // The end-of-song hand-off: the ended song is still `current`, but there is nothing to play
  // or pause until the next one takes the stage (review R12).
  if (endGuard) return;
  // Nothing on the stage yet: start the queue — unless a song is already on its way (the first
  // MIDI song waits for the soundfont with `current` still null), which ▶ must not replace (R3).
  if (!current) { if (!loadingSong && queue.length) advanceQueue(); return; }
  if (media === audio && !(await ensureEngine())) return;
  if (media.paused) media.play();
  userPaused = false;
  setPlayIcon();
}
function remotePause() {
  if (endGuard) return;   // the end-of-song hand-off (R12)
  if (current && !media.paused) { media.pause(); userPaused = true; setPlayIcon(); }
}
function setRemoteVolume(v) {
  v = Math.max(0, Math.min(VOLUME_MAX, v));   // 0–100 % (Rae, 2026-11-24: no boost past 100)
  settings.set("audio.volume", v);         // → applyAudioSettings
  updateStatusLine();
}
// Keep the status line in step when a phone changes key/tempo/volume.

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
  if (songs.length) { queue.restore(songs); renderQueueView(); }
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
  setStatus(`"${current.name}" ${why} — skipping…`, { error: true });
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
    // The spinner must not stay up: the song is skipped with the reason on the status line (playMidi throws).
    overlay.classList.add("hidden");
    engineError = e && e.message ? e.message : "the MIDI engine did not start";
    console.error(e);
    return false;
  }
}
let engineError = "";

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
  // A song picked during the previous song's end-of-song hand-off (the score card's 4.5 s, else
  // 0.7 s) REPLACES that hand-off: its timer would otherwise advance the queue over this song —
  // stop it on an empty queue, or swap in the next one (review R1, 2026-11-24). advanceQueue →
  // playNow from that timer arrives with endTimer already null.
  clearTimeout(endTimer); endTimer = null; endGuard = false;
  const gen = ++playGen;
  playCounter.start(song);   // a new play (Restart is not a new play and does not come through here)
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
      setStatus(e && e.userMessage
        ? `Could not play "${song.name || song.code || "that song"}": ${e.userMessage}.`
        : `Could not play "${song.name || song.code || "that song"}" — skipping.`, { error: true });
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
  if (titleCard) titleCard.hide();
  lyrics.clear();
  $("lyric-badge").textContent = "";
  $("np-key").textContent = "";
  if (pitchGuide) pitchGuide.load({ hasMelody: false, notes: [], range: { min: 60, max: 72 } });
  if (midiMixer) midiMixer.clear();
  currentMelodyChannel = -1;
  lastParsed = null;
  currentKey = null;
  scorer = null;          // no MIDI note data → nothing to score against
  verdictFeed = null;
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
  video.setVolume(volumeNow());
  video.setTempo(settings.get("audio.tempo"));
  video.setKey(settings.get("audio.key")); // apply the current transpose to the video's audio
  video.load(url);
  setStageKind("video");
  songLoaded(song);            // no await above this line: the play cannot be stale yet
  loudnessBegin(song);         // M10: this song's loudness gain (learned, or 0 and follow)
  await video.play();
  if (stalePlay(gen)) return;  // a newer song took over while the picture was loading
  loudnessLive(song);
  setPlayIcon();
}

// Hide the NOTE-derived surfaces (pitch guide / chords / channel mixer) + reset note
// state, WITHOUT touching the lyric surface or the now-playing header. Used by the AUDIO
// path, which keeps the scrolling lyrics (from a sidecar) but has no MIDI note data.
function hideNoteSurfaces() {
  clearTimeout(playDelayTimer);
  if (titleCard) titleCard.hide();
  if (pitchGuide) pitchGuide.load({ hasMelody: false, notes: [], range: { min: 60, max: 72 } });
  if (chordEngine) chordEngine.clear();
  if (midiMixer) midiMixer.clear();
  currentMelodyChannel = -1;
  lastParsed = null;
  currentKey = null;
  scorer = null;          // no MIDI note data → nothing to score against
  verdictFeed = null;
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
  audioFile.setVolume(volumeNow());
  audioFile.setTempo(settings.get("audio.tempo"));
  audioFile.setKey(settings.get("audio.key"));
  await audioFile.load(url);   // fetch the audio into an in-memory blob (reliable load/seek)
  if (stalePlay(gen)) return;  // a newer song was picked while this one was downloading
  setStageKind("audio");
  await loadAudioLyrics(song, gen); // fetch + parse the sidecar into the lyric surface
  if (stalePlay(gen)) return;
  songLoaded(song);
  loudnessBegin(song);         // M10: this song's loudness gain (learned, or 0 and follow)
  showTitleCard(song);
  await audioFile.play();
  if (stalePlay(gen)) return;
  loudnessLive(song);
  setPlayIcon();
}

// Load an AUDIO song's lyric sidecar into the LyricsEngine. Handles the timed text
// formats (.lrc/.vtt/.srt), plain .txt (unsynced → spread across the duration once known),
// and a lyrics-only .kar/.mid (reuse the SMF parser). A missing/failed sidecar is non-fatal.
// `gen`: §5.23 — a newer song picked while the sidecar downloads owns the lyric surface, so a
// stale load writes nothing (it used to load its lines over the newer song's).
async function loadAudioLyrics(song, gen = playGen) {
  const badge = $("lyric-badge");
  const url = Catalog.lyricsUrl(song);
  if (!url) { lyrics.clear(); badge.textContent = "no lyrics"; return; }
  const ext = (song.lyrics.split(".").pop() || "").toLowerCase();
  try {
    if (ext === "kar" || ext === "mid" || ext === "midi") {
      const raw = await cachedArrayBuffer(url);   // may be raw-deflate compressed (like kar_raw)
      if (stalePlay(gen)) return;
      const parsed = parseMidi(toMidiBytes(raw).slice(0));
      badge.textContent = lyrics.load(parsed) ? "" : "no lyrics";
    } else {
      const res = await fetch(url);
      if (stalePlay(gen)) return;
      if (!res.ok) throw new Error(`sidecar ${res.status}`);
      const text = await res.text();
      if (stalePlay(gen)) return;
      const { lines, synced } = linesFromLyricFile(ext, text);
      if (!synced) {
        distributeLineTimes(lines, audioFile.duration); // duration may be 0 here → refined in tick
        pendingUnsyncedLines = lines;
      }
      badge.textContent = lyrics.loadLines(lines) ? (synced ? "" : "unsynced") : "no lyrics";
    }
  } catch (e) {
    if (stalePlay(gen)) return;
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

  youtube.setVolume(volumeNow());
  youtube.setTempo(settings.get("audio.tempo"));
  youtube.load(song.videoId);
  setStageKind("youtube");
  songLoaded(song);            // no await above this line: the play cannot be stale yet
  loudnessBegin(song);         // M10: YouTube never reaches the music bus — gain 0, not measured
  await youtube.play();
  if (stalePlay(gen)) return;
  setPlayIcon();
}

// MIDI song: the original SpessaSynth path.
async function playMidi(song, gen = playGen) {
  // A synth that cannot start (an insecure page has no AudioWorklet — M13) fails the song like any other refusal,
  // so playNow skips it with the reason instead of leaving a spinner and a stalled queue.
  if (!(await ensureEngine())) { const e = new Error(engineError); e.userMessage = engineError; throw e; }
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
    setStatus(`Could not read the file for "${songTitle(song)}": ${e.message}`, { error: true });
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
    // No parse → no melody: never score (or call verdicts) against the PREVIOUS song's notes.
    scorer = null;
    verdictFeed = null;
  }

  // A file can pass the MThd check and still be rejected by the sequencer; without this the
  // throw escaped playNow entirely, leaving "Now playing" on screen over silence.
  try {
    audio.loadSong(buf);
  } catch (e) {
    console.error("Sequencer rejected the file:", e);
    setStatus(`"${songTitle(song)}" looks corrupt — skipping.`, { error: true });
    onSongFailed();
    return;
  }
  setStageKind("midi");
  songLoaded(song);    // lyrics are in and the sequencer took the file (its length follows in tick)
  loudnessBegin(song); // M10: this song's loudness gain (learned, or 0 and follow)

  pushRecent(song);    // only once the song has actually loaded — a failed load isn't "played"
  showTitleCard(song); // title/artist/key over the lyrics, fades after titleCard.seconds

  // Start the music a fixed 1s before the title card disappears (if the card is on).
  clearTimeout(playDelayTimer);
  const tcSecs = settings.get("titleCard.seconds") || 0;
  const delayMs = tcSecs > 1 ? (tcSecs - 1) * 1000 : 0;
  const startPlayback = async () => {
    if (stalePlay(gen)) return;   // title-card hold outlived by a newer song pick
    await audio.play();
    if (!stalePlay(gen)) loudnessLive(song);   // M10: measured from here — never the hold
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
  playCounter.ended();   // a natural end counts the play (if it ever sounded)
  // Close out scoring BEFORE clearStage(), which drops the singer (currentBy) the card needs.
  // `current` stays the ended song through the hand-off below (the keys and the phone's ▶ ignore
  // it while endGuard is set); advanceQueue replaces or clears it.
  // First judge the notes still inside their grace window (M9), silently: the card is about
  // to cover the stage, so a last chip would only flash underneath it.
  if (scorer && verdictFeed) {
    quietVerdicts = true;
    try { verdictFeed.update(Number.MAX_VALUE); }
    catch (e) { console.error("Could not judge the last notes:", e); }
    finally { quietVerdicts = false; }
  }
  // `difficulty` comes from the scorer (its finish()); the tallies are merged in for the card.
  const res = score.finish(scorer, current, currentBy);
  if (res && verdictFeed) res.verdicts = verdictFeed.tally();
  logRanking(res);                                          // one leaderboard row (M6) — needs current too
  loudnessEnd(current);                                     // M10: learn its loudness — needs current too
  score.resetLineBonus();
  clearStage();
  if (res) {
    score.showCard(res);
    // The card is role=status, but a modal panel makes the stage (the footer's status line
    // included) inert, which hides it from assistive tech; the toast is outside the stage, so it
    // says the same thing.
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
  playCounter.stop();      // skipped before 30 s: not a play
  // A song still loading is skipped too (review R37): its play* bails at its next checkpoint and
  // its `finally` no longer owns the flag — as stopSong does. Without this, Next with an empty
  // queue showed the home layer and the loading song then took the stage anyway.
  if (loadingSong) { playGen++; loadingSong = false; }
  clearTimeout(endTimer);
  endTimer = null;
  endGuard = false;
  score.hideCard();
  advanceQueue();
}

// A song that cannot play must not strand the stage: drop it and move on if anything is queued.
function onSongFailed() {
  playCounter.stop();
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
  setStatus(`Could not play "${current.name || current.code || "that song"}" — file missing or unreadable. Skipping.`, { error: true });
  onSongFailed();
}

// True when the active engine has reached the end of the current song. MIDI reports via
// `ended` (song-scoped, §5.14) with the clock on its duration — the Sequencer pauses itself at its
// natural end, so `paused` alone proves nothing; video/audio reach duration cleanly; YouTube fires
// its own onEnded.
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
  countPlayTick();
  setPlayIcon(); // keep the status line's ▶ / ❚❚ mirroring the real play/pause state every frame
  updateStageBanner(); // singer + what plays next — change-guarded, cheap
  // Playing vs paused: the OS media surface follows it.
  const playing = !!(current && media && !media.paused);
  if (playing !== _shellPlaying) {
    _shellPlaying = playing;
    shell.setPlaying(playing);   // the footer auto-hides only while a song plays
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
      // The title card leaves at its timer or when the lyrics reach their first count-in beat (line
      // 0's start without one) — only while the music plays, so the paused hold cannot trip it.
      if (titleCard.visible && !media.paused && titleCardYields(lyrics.stage.plan, gt)) titleCard.hide();
    }
    // Unsynced sidecar (.txt): once the real duration is known, spread the lines across it.
    if (isAudioFile && pendingUnsyncedLines && d > 0) {
      distributeLineTimes(pendingUnsyncedLines, d);
      lyrics.loadLines(pendingUnsyncedLines);
      pendingUnsyncedLines = null;
      publishCurrentSong();   // the document sent at load may carry placeholder line times (F43)
    } else if (songDocDur === 0 && d > 0) {
      // The document went out before the engine knew the length (a MIDI sequencer reports it
      // a moment after loadSong; video and YouTube after their metadata). Same songRev.
      publishCurrentSong();
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
      // The voice reaches the detector mic.latencyMs late (M9, plan §5.17): what it hears now
      // was sung against the melody at gt − lat, so that is where the scorer and the verdict
      // judge read it. 0 = the pre-M9 behaviour exactly.
      const lat = micLatencySec();
      if (scoringOn) {
        scorer.addFrame(gt - lat, micMidi);
        if (verdictFeed) verdictFeed.update(gt - lat);   // onVerdict → score.showVerdict
        score.lineBonus(scorer, lyrics);                 // gated by score.feedback inside
      }

      if (guideOn) {
        if (settings.get("guide.scoring")) pitchGuide.setScore(scoringOn ? scorer.liveScore() : null);
        else pitchGuide.setScore(null);
        // The mic trace is drawn `lat` earlier, so what the singer sees is what is scored.
        pitchGuide.update(gt, settings.get("guide.showMic") ? micMidi : null, { micShiftSec: lat });
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
      durations.note(current, d);   // learn this song's length for the phones' queue ETA
    }
    loudnessTick();   // M10: the loudness meter + first-play follower (at most every 100 ms)
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
// The search field's debounced render (120 ms): what the field's text draws depends on the tab
// (songs on All, artist names on Artists), so the pending render is a closure. Enter / ArrowDown
// flush it; a tab switch cancels it (it belongs to the old tab, and the new tab draws itself).
let searchDeb = null;   // the pending timer (null once it has run)
let searchDebRun = null;
function debounceSearch(fn) {
  clearTimeout(searchDeb);
  searchDebRun = fn;
  searchDeb = setTimeout(() => { searchDeb = null; fn(); }, 120);
}
function flushSearch() {
  if (searchDeb) { clearTimeout(searchDeb); searchDeb = null; searchDebRun(); }
}
function cancelSearchDebounce() { clearTimeout(searchDeb); searchDeb = null; }

/**
 * Empty the search field and show what an empty field shows: the whole library on All (leaving
 * Recent / Favorites), every artist on Artists; on Rankings only the field clears. `focus` puts
 * the caret back in the field (the ✕ button, Enter); a guest's ⏎ or an idle clear must not move
 * the host's focus.
 */
function clearSearch({ focus = true } = {}) {
  const search = $("search");
  search.value = "";
  $("search-clear").classList.remove("show");
  cancelSearchDebounce();              // a keystroke's pending render must not redraw the old text
  libraryView.cancelYoutubeSearch();
  const tab = browseTab();
  if (tab === "artists") libraryView.showArtists("");
  else if (tab === "all") {
    libraryView.leaveSpecialViews();
    libraryView.renderAll();
  }                                    // Rankings: the list is hidden; only the field clears
  if (focus) search.focus();
}

/**
 * Take the top hit — Enter in the search field (M2, §5.33). A key typed inside the 120 ms debounce has not rendered yet,
 * so it flushes first: the top hit belongs to the text as typed. Rankings has no list (the text
 * is a song search, on All). The artist list: open the top artist (the field keeps its text, so
 * "← Artists" comes back to the same filtered list; the panel stays). Else the list's first song
 * by search.enterAction ("auto" reserves while a song plays or loads, plays when idle), then the
 * field clears and the panel closes. False when there was nothing to take.
 */
function takeTopHit() {
  flushSearch();
  if (browseTab() === "rankings" || browseTab() === "queue") showBrowseTab("all");
  if (browseTab() === "artists" && libraryView.view === "artists") {
    const a = libraryView.topArtist();
    if (!a) return false;
    openArtist(a.key);
    return true;
  }
  const song = libraryView.topHit();
  if (!song) return false;
  if (enterDecision(settings.get("search.enterAction"), !!(current || loadingSong)) === "reserve") {
    enqueue(song);
    setStatus(`Reserved: ${song.name || song.code || "a song"}`);
  } else {
    playNow(song);
  }
  if ($("search").value) clearSearch();   // clear the field and show the whole library again
  closeOverlay("search");                 // a song was taken from the panel: it has done its job
  return true;
}

function wireUI() {
  const search = $("search");
  const clearBtn = $("search-clear");
  const toggleClear = () => clearBtn.classList.toggle("show", !!search.value);
  search.oninput = () => {
    toggleClear();
    const q = search.value;
    const tab = browseTab();
    if (tab === "artists") {
      // The Artists tab: the field filters artist names (no song search, no YouTube).
      debounceSearch(() => libraryView.showArtists(q));
      return;
    }
    libraryView.leaveSpecialViews();   // typing leaves the Recent / Favorites views
    if (tab === "rankings" || tab === "queue") {
      // Typing on Rankings or the Queue is a song search: the All tab, which runs it (onBrowseTab).
      cancelSearchDebounce();
      showBrowseTab("all");
      return;
    }
    debounceSearch(() => libraryView.renderSearchResults(q, null)); // instant local (drops any YouTube rows)
    libraryView.scheduleYoutubeSearch(q); // append YouTube after a longer debounce, if enabled + local is sparse
  };
  clearBtn.onclick = () => clearSearch();
  // Recent and Favorites are views of the All tab: from another tab they switch to it, and
  // onBrowseTab("all") draws them (showAll).
  $("btn-recent").onclick = () => {
    libraryView.setRecentMode(!libraryView.recentMode);
    if (browseTab() !== "all") { showBrowseTab("all"); return; }
    if (libraryView.recentMode) libraryView.showRecent();
    else libraryView.runSearch(search.value); // back to the (search) list
  };
  $("btn-favorites").onclick = () => {
    libraryView.setFavoritesMode(!libraryView.favoritesMode);
    if (browseTab() !== "all") { showBrowseTab("all"); return; }
    if (libraryView.favoritesMode) libraryView.showFavorites();
    else libraryView.runSearch(search.value); // back to the (search) list
  };
  $("btn-youtube").onclick = () => {
    if (!YouTubeEngine.supported) {
      setStatus("YouTube search needs a Chromium-based browser (credentialless iframes).", { error: true });
      return;
    }
    settings.set("youtube.enabled", !settings.get("youtube.enabled")); // onSettingChanged repaints + re-runs
  };

  // The panel buttons (Songs, Mixer, Next background, Settings, Full screen) are the shell's
  // (shell.wire). The full-screen button's state still follows the document from here.
  const fsBtn = $("btn-fullscreen");
  if (fsBtn) {
    document.addEventListener("fullscreenchange", () => {
      fsBtn.classList.toggle("active", !!document.fullscreenElement);
      fsBtn.title = document.fullscreenElement ? "Exit full screen" : "Full screen";
    });
  }

  // A key typed inside the 120 ms debounce has not rendered yet: flushSearch() renders it now,
  // or the top hit (Enter) or the first row (ArrowDown) would belong to the text one keystroke
  // earlier. The field's own keys. Every key it handles is prevented, so the document key router
  // (and the browser) never act on it a second time.
  search.onkeydown = (e) => {
    if (e.isComposing) return;
    if (e.key === "Enter") {
      // Prevented when it took something: the panel is about to close and hand focus back to
      // its opener, and an unprevented Enter would go on to activate that button too. Nothing
      // to take → the key goes on, as before.
      if (takeTopHit()) e.preventDefault();
    } else if (search.value && keyToAction(e, { typing: true })?.action === "back") {
      // Back step 1 (Escape, BrowserBack, a TV remote's Back): a field with text clears first;
      // the next Back closes the panel.
      e.preventDefault(); e.stopPropagation();
      clearBtn.onclick();
    } else if (e.key === "ArrowDown" && noMods(e)) {
      // Into the list: its roving row (the first row of a fresh result); on the Queue tab the
      // queue's. Empty list, or the Rankings tab (the list is hidden) → the key goes on to the
      // router, which moves to what is below (the tabs) or leaves focus here.
      flushSearch();
      const tab = browseTab();
      if (tab === "queue" ? lib.focusQueueRow() : tab !== "rankings" && lib.focusRow()) e.preventDefault();
    }
  };

  $("queue-clear").onclick = () => { clearQueueAsk(); };   // the Queue tab's "Clear all"
  // M11: "Next background" — the same action as the Yellow key and the phone's "bg".
  const bgBtn = $("btn-bg");
  if (bgBtn) bgBtn.onclick = () => { bgNext(); };
  // M11: a Background pick in Settings (Camera, or Back / Front while on Camera) is a user
  // gesture. Document + capture phase, so it runs before settings-ui's own change listener on the
  // select (which stores the value → onSettingChanged → applyBackgroundSettings reads the flag),
  // whatever order the two were registered in. The flag lives for this one event only.
  document.addEventListener("change", (e) => {
    const id = e.target && e.target.id;
    if (id !== "set-bg-mode" && id !== "set-bg-facing") return;
    bgPickGesture = true;
    setTimeout(() => { bgPickGesture = false; }, 0);
  }, true);

  // Hidden-tab watchdog. requestAnimationFrame is throttled to a crawl (or stopped) in a
  // background tab while the AudioContext keeps playing — so a song that ended while the host
  // was alt-tabbed never advanced the queue, which is the whole point of having one. A plain
  // interval keeps firing (a page playing audio is exempt from Chrome's intensive throttling),
  // and visibilitychange catches up the instant the tab comes back.
  setInterval(() => { countPlayTick(); if (songHasEnded()) endOfSong(); }, 1000);   // + play time in a hidden tab
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && songHasEnded()) endOfSong();
  });

  // Global keys (Space, [ / ], the media and remote keys…) belong to the one key router
  // (routeKey, installed by buildShell → buildKeys).

  // reflect the persisted values on the status line
  updateMelodyToggle();
  libraryView.updateYoutubeToggle(); // reflect the persisted 🌐 toggle + browser support
}

// Single mic enable/disable path for the ⚙ panel's button (passed in as onToggleMic) and the
// phone remote, so the Bluetooth-mode guard can't diverge between them.
async function toggleMic() {
  if (settings.get("bt.enabled")) return; // mic is disabled in Bluetooth mode
  $("mic-status").textContent = mic.enabled ? "Stopping…" : "Requesting microphone…";
  if (mic.enabled) mic.disable();
  else await mic.enable();
  settingsUI.updateMicBtn();
}

// Mic calibration (M9, plan §5.17): Settings → "Calibrate…" (settings-ui.js disables it, with the
// reason, on an insecure page or in Bluetooth mode). The dialog is built on first use — nothing
// at boot depends on it. open() renders its first step BEFORE the overlay opens: overlays-dom
// focuses synchronously, so the initialFocus hook (buildShell) finds that step's first button.
let calibrateUI = null;          // ui/calibrate-ui.js, created by the first openCalibration()
function openCalibration() {
  try {
    if (!calibrateUI) {
      calibrateUI = createCalibrateUI({ el: $("ov-calibrate"), mic, audio, settings, onSave: onCalibrated });
    }
    // The clicks go out through the song's own output and are listened for on the mic: a playing
    // song would mask them, so opening calibration pauses it (play resumes it as usual).
    remotePause();
    calibrateUI.open();
  } catch (e) {
    console.error("Calibration is unavailable:", e);
    setStatus("Calibration is unavailable", { error: true });
    return;
  }
  overlays.open("calibrate");
}
// The dialog saved mic.latencyMs (and the gate threshold, if kept): move the sliders, say so.
function onCalibrated() {
  settingsUI.syncSettingsUI();
  const msg = `Mic latency set to ${Number(settings.get("mic.latencyMs")) || 0} ms`;
  settingsUI.updateCalibrateBtn(msg);   // the line beside the button, in the panel underneath
  setStatus(msg);
}

function setKey(semi) {
  semi = Math.max(-12, Math.min(12, semi));
  settings.set("audio.key", semi);
  updateKeyDisplay();   // the queue bar's key and the status line
}

function setTempoRate(rate) {
  rate = Math.round(Math.max(0.5, Math.min(1.5, rate)) * 100) / 100; // clamp 0.5–1.5, avoid fp drift
  settings.set("audio.tempo", rate);
  updateStatusLine();
}

function nudgeOffset(delta) {
  const v = Math.max(-2000, Math.min(2000, (settings.get("lyrics.offsetMs") || 0) + delta));
  settings.set("lyrics.offsetMs", v);
  $("set-offset").value = v;
  $("set-offset-val").textContent = `${v} ms`;
  showAdjust(`Lyrics offset ${v > 0 ? "+" : ""}${v} ms`);
  updateStatusLine();
}

// The "adjust" toast: the new value after a key-driven change ("Key +2", "Tempo 0.95×",
// "Melody off", "Lyrics offset +50 ms", "Volume 95%"). A non-modal overlay that the stack
// closes after its 2500 ms period (the shell's 250 ms tick drives that). Opened without user
// activation so it never takes focus or a history entry; a repeat while it is up just restarts
// its timer.
// The toast's two periods (review R34, Rae 2026-11-24): a routine message 2.5 s, an error 6 s with
// a red edge (it used to sit on the status line until the next message; a 2.5 s pop-up was easy
// to miss). The next message replaces it either way, with its own period.
const TOAST_MS = OVERLAY_DEFS.adjust.autoHideMs;
const ERROR_TOAST_MS = 6000;
function showAdjust(text, { error = false } = {}) {
  const el = $("ov-adjust");
  if (el) {
    el.textContent = text == null ? "" : String(text);
    el.classList.toggle("error", !!error);
  }
  stack.setAutoHide("adjust", error ? ERROR_TOAST_MS : TOAST_MS);   // restarts an open toast's timer
  if (!overlays.open("adjust", { activated: false, opener: null })) stack.touch("adjust");
}

// Title card (ui/title-card.js — videoke-style, Rae 2026-11-24): title, artist, then who queued it
// and the key, over the lyric area, which is HIDDEN while it shows. It leaves after
// `titleCard.seconds` or at the lyrics' first count-in beat, whichever comes first (the rAF loop);
// 0 s = no card.
function showTitleCard(song) {
  const secs = settings.get("titleCard.seconds") || 0;
  if (secs <= 0) { titleCard.hide(); return; }
  titleCard.show({
    title: song.name || "", artist: song.artistName || "", singer: currentBy || "",
    keyName: currentKey && currentKey.source !== "none" && settings.get("key.showBadge")
      ? keyName(currentKey.keyPc, currentKey.mode) : "",
  }, { ms: secs * 1000 });
}

// The queue bar's singer badge (only when the playing song was queued from a phone), its queue
// count and what plays next.
// Change-guarded so it's cheap to call every frame from the rAF loop.
let _bannerNow = null, _bannerUp = null, _queueCount = null;
function updateStageBanner() {
  const nowEl = $("now-singer");
  if (!nowEl) return;
  const nowText = current && currentBy ? `🎤 ${currentBy}` : "";
  if (nowText !== _bannerNow) { nowEl.textContent = nowText; _bannerNow = nowText; }
  // Queued-song count chip (far right of the queue bar): "⏭ N", hidden when empty (:empty in
  // CSS). It is a button that opens the Songs panel's Queue tab (the shell wires it); its name carries the count too,
  // so what is read out matches what is shown.
  const qEl = $("queue-count");
  if (qEl) {
    const qText = queue.length ? `⏭ ${queue.length}` : "";
    if (qText !== _queueCount) {
      qEl.textContent = qText; _queueCount = qText;
      qEl.setAttribute("aria-label", queue.length ? `Open the queue, ${queue.length} queued` : "Open the queue");
    }
  }
  // What plays next: the queue's first song · who queued it, in the queue bar whenever the queue
  // has one (Rae, 2026-11-24 — it replaces the floating "up next" pill of the last 20 s).
  const nxEl = $("np-next");
  const nxName = queue.length ? (queue.list[0].name || "(untitled)") : "";
  const nxWho = queue.length ? (queue.listBy[0] || "") : "";
  const nxKey = nxName ? `${nxName}|${nxWho}` : "";
  if (nxEl && nxKey !== _bannerUp) {
    _bannerUp = nxKey;
    nxEl.textContent = "";
    if (nxName) {
      // A mono eyebrow + the song + (if phone-queued) the singer. Spans, never innerHTML.
      const lab = document.createElement("span"); lab.className = "nx-lb"; lab.textContent = "Next";
      const sp = document.createElement("span"); sp.className = "nx-song"; sp.textContent = nxName;
      nxEl.append(lab, sp);
      if (nxWho) {
        const wh = document.createElement("span"); wh.className = "nx-by"; wh.textContent = `🎤 ${nxWho}`;
        nxEl.append(wh);
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
  if (titleCard) titleCard.hide();
  // A MIDI song held behind the title card starts from a timer. If the stage is cleared before
  // that timer fires (queue drained, a skip, a failure), the timer still fires and calls
  // audio.play() with `current` already null — the song plays on with no title and no lyrics,
  // and nothing can end it because the rAF loop's `current && media` branch is skipped.
  clearTimeout(playDelayTimer);
  loud.live = false;           // M10: nothing on the stage → nothing to measure
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
// The melody guide's level (Rae, 2026-11-24): Off · 25 · 50 · 75 · 100 % (music-fx.js).
const melodyNow = () => melodyLevel(settings.get("guide.vocal.volume"), settings.get("guide.vocal.mute"));
/** The 🎵 button and its key: the next level, applied through the settings (→ applyGuideVocal). */
function stepMelody() {
  const k = nextMelodyLevel(melodyNow());
  for (const [key, v] of Object.entries(melodyLevelSettings(k))) settings.set(`guide.vocal.${key}`, v);
  showAdjust(`Melody ${melodyLevelLabel(k)}`);
}
/** − / + on the status line's melody, and the melodyUp / melodyDown keys: one level (25 %). */
function stepMelodyBy(d) {
  const k = Math.max(0, Math.min(4, melodyNow() + d));
  for (const [key, v] of Object.entries(melodyLevelSettings(k))) settings.set(`guide.vocal.${key}`, v);
  showAdjust(`Melody ${melodyLevelLabel(k)}`);
}
// The melody level shows on the status line; ⚙'s select follows a key press or the phone's mute
// while the panel is open.
function updateMelodyToggle() {
  const sel = $("set-gv-level");
  if (sel) sel.value = String(melodyNow());
  updateStatusLine();
}

// Rebuild catalog.json from kar_raw/ (called by the settings-ui button).
async function onRebuild() {
  const res = await (await fetch("/api/rebuild-catalog", { method: "POST" })).json();
  if (!res.ok) return { ok: false, error: res.error };
  const n = await catalog.load(settings.get("data.catalogUrl"), settings.get("data.videoCatalogUrl"), settings.get("data.audioCatalogUrl"));
  buildSearchIndex();   // BEFORE the re-render: no close query may reach the old list's index
  renderBrowse();       // the tabs again, for the new catalogue
  // The ACTIVE view again, on the new catalogue (its caches key on the catalog.songs array): the
  // search, Recent / Favorites, the artist list or one artist's songs; nothing on Rankings.
  libraryView.rerender($("search").value);
  setSongCount(n);
  showAdjust(`${n.toLocaleString()} songs loaded`);
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

// A message for the room. (The #status element is the status LINE now — values, not messages.)
function setStatus(msg, { error = false } = {}) {
  // Messages ("Reserved: …", "Queue cleared", errors) are the adjust toast now: the status line
  // holds the values (Rae, 2026-11-24). `error`: 6 s with a red edge (R34). Before the overlays
  // exist, the console keeps them.
  if (msg == null || msg === "") return;
  if (overlays) showAdjust(msg, { error }); else if (error) console.warn(msg); else console.info(msg);
}
// Reflects the *real* playback state: a finished MIDI song counts as stopped whatever `paused`
// says (`audio.ended`, §5.14). Cheap enough to call every rAF frame.
function isPlaying() { return !media.paused && !(media === audio && audio.ended); }
// Play counts (Rae, 2026-11-24 — recorded on the server, not shown yet): a song counts once after
// 30 s of real playback or at its natural end (play-counts.js). isPlaying(), not `!paused`: a
// finished MIDI song is not playing whatever `paused` says, and while the next song loads `media`
// is still the old one.
const playCounter = createPlayCounter();
function countPlayTick() {
  playCounter.tick(!!(current && media && !loadingSong && isPlaying()), performance.now() / 1000);
}
// ---------------------------------------------------------------------------
// The status line (Rae, 2026-11-24): the song count (idle) or the song now on the stage, then
// VOL · KEY · TEMPO · MELODY · OFFSET, each between a − and a +. Values come from the settings and
// the playback state; every write is change-guarded, so it runs every frame (setPlayIcon) for free.
// ---------------------------------------------------------------------------
const VOLUME_STEP = 0.05;   // − / + and volumeUp / volumeDown: 5 %
const VOLUME_MAX = 1;       // 0–100 % (Rae: no boost past 100; song loudness is evened out already)
const volumeNow = () => Math.max(0, Math.min(VOLUME_MAX, Number(settings.get("audio.volume")) || 0));
let songCountText = "Loading…";
function setSongCount(n) {
  songCountText = `${Number(n || 0).toLocaleString()} songs`;
  updateStatusLine();
}
function adjustVolume(delta) {
  const v = Math.round(Math.max(0, Math.min(VOLUME_MAX, volumeNow() + delta)) * 100) / 100;
  settings.set("audio.volume", v);   // → applyAudioSettings
  showAdjust(`Volume ${Math.round(v * 100)}%`);
  updateStatusLine();
  return true;
}
// KEY: the detected root ("F", "Am" for a minor key), "F → G" once transposed; without a detected
// key (audio, video, nothing loaded) the transpose alone, "+2" / "0".
const keyRoot = (pc, mode) => keyName(pc, mode, true).split(" ")[0] + (mode === "minor" ? "m" : "");
function statusKeyText() {
  const semis = Number(settings.get("audio.key")) || 0;
  if (current && currentKey && currentKey.source !== "none") {
    const orig = keyRoot(currentKey.keyPc, currentKey.mode);
    return semis ? `${orig} → ${keyRoot(currentKey.keyPc + semis, currentKey.mode)}` : orig;
  }
  return fmtKey(semis);
}
const putText = (id, text) => { const el = $(id); if (el && el.textContent !== text) el.textContent = text; };
function updateStatusLine() {
  const idle = !current && !loadingSong;
  const songs = $("st-songs"), now = $("st-now");
  if (songs && songs.hidden !== !idle) songs.hidden = !idle;
  putText("st-songs", songCountText);
  if (now) {
    const show = !!current;
    if (now.hidden !== !show) now.hidden = !show;
    const title = current ? [current.name || "(untitled)", current.artistName].filter(Boolean).join(" — ") : "";
    putText("st-now", current ? `${isPlaying() ? "▶" : "❚❚"} ${title}` : "");
  }
  const next = $("st-next");
  if (next && next.hidden !== !current) next.hidden = !current;
  putText("st-volume", String(Math.round(volumeNow() * 100)));
  putText("st-key", statusKeyText());
  putText("st-tempo", `${(Number(settings.get("audio.tempo")) || 1).toFixed(2)}×`);
  const k = melodyNow();
  putText("st-melody", k ? String(k * 25) : "Off");
  const off = Number(settings.get("lyrics.offsetMs")) || 0;
  putText("st-offset", `${off > 0 ? "+" : ""}${off}`);
}
// The footer's − + steps and the seek bar. Installed with the shell (buildShell), so the steps
// work while the catalogue loads.
function wireFooter() {
  const on = (id, fn) => { const el = $(id); if (el) el.addEventListener("click", () => fn()); };
  on("st-volume-down", () => adjustVolume(-VOLUME_STEP));
  on("st-volume-up", () => adjustVolume(VOLUME_STEP));
  on("st-key-down", () => adjustKey(-1));
  on("st-key-up", () => adjustKey(1));
  on("st-tempo-down", () => adjustTempo(-0.05));
  on("st-tempo-up", () => adjustTempo(0.05));
  on("st-melody-down", () => stepMelodyBy(-1));
  on("st-melody-up", () => stepMelodyBy(1));
  on("st-offset-down", () => nudgeOffset(-10));
  on("st-offset-up", () => nudgeOffset(10));
  on("st-next", () => nextKey());   // the N key's action: skip, toast "Next: …" (Rae, 2026-11-25)
  // The seek bar: press or drag anywhere along the bottom edge.
  const track = $("seek-track");
  if (!track) return;
  const seekTo = (e) => {
    if (!current || !media || media.duration <= 0) return;
    const r = track.getBoundingClientRect();
    const f = Math.max(0, Math.min(1, (e.clientX - r.left) / (r.width || 1)));
    media.seek(f * media.duration);
  };
  track.addEventListener("pointerdown", (e) => {
    if (!current) return;
    track.classList.add("dragging");
    try { track.setPointerCapture(e.pointerId); } catch { /* not capturable */ }
    seekTo(e);
  });
  track.addEventListener("pointermove", (e) => { if (track.classList.contains("dragging")) seekTo(e); });
  const end = () => track.classList.remove("dragging");
  track.addEventListener("pointerup", end);
  track.addEventListener("pointercancel", end);
  updateStatusLine();
}

// (The play button went with the dock: the status line's ▶ / ❚❚ is what follows the real state.)
function setPlayIcon() {
  updateStatusLine();
}
function fmtKey(s) { return (s > 0 ? "+" : "") + s; }

boot();
