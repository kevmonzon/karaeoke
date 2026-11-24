/*
 * remote.js — the phone remote-control page (served at /remote; shell = src/remote.html).
 *
 * A guest's browser on the same network. It has NO synth and NO local player. It reads a host
 * ROOM's live state from serve.py's multi-room relay and sends intents back (POST
 * /api/remote/command, scoped to the room). The HOST stays the authoritative player — see
 * src/js/remote-host.js and §5.17 in CLAUDE.md.
 *
 * A ROOM CODE gates entry: scanning the host's QR fills ?room= and auto-connects; otherwise
 * the guest types the code shown on the karaoke screen. Five tabs: Now / Lyrics / Search /
 * Queue / You.
 *
 * LIVE STATE (relay v2, M7): an event stream (GET /api/remote/events, remote-push.js) delivers
 * the room view as `state` when the queue / song / settings change and a small `tick` per host
 * push otherwise. The old 1 s poll of /api/remote/state is the FALLBACK: it runs whenever the
 * stream is not healthy ("connecting" or "fallback") and stops the moment push is back. Whether
 * the host is alive is judged with this device's clock only (hostIsLive) — never the server's
 * wall clock, so a phone whose clock is a minute off still works.
 *
 * SONGBOOK: /api/catalog/compact (compact-catalog.js, ~2 MB gzip) adopted into a Catalog, searched
 * with the host's three tiers: the number tier, Catalog.search, and close matches (typos) from the
 * search worker. A song is named to the host as ref { i, code } — row i of the compact list is the
 * host's catalog.songs[i]; the host checks the code and falls back to a code lookup.
 *
 * NUMBERS: the phone has no number pad and never types onto the karaoke screen (M8's `123` pad and
 * guests' live digits are gone), and it prints no song number — no dial code, no songbook chip.
 * Digits typed into the search field still find songs by number (the number tier above). The code
 * still travels inside ref { i, code }: it is how the host checks which song a row means.
 *
 * LYRICS: the host publishes a lyric DOCUMENT for the song it is playing (lyrics-doc.js); the
 * phone fetches it when `songRev` changes and renders it with the host's own engines (stage or
 * scroll). Only the CLOCK rides the live channel, disciplined by the server-measured snapshot
 * `age` — see src/js/sync-clock.js. The phone never downloads a song file.
 */
import { Catalog, SOURCES, normalizeCode } from "./catalog.js";
import { orderNumberMatches, mergeTiers, tokenize, MAX_CLOSE } from "./search-core.js";
import { createSearchClient } from "./search-client.js";
import { loadCompact } from "./compact-catalog.js";
import { createPushClient, hostIsLive, makeCid, wantPush } from "./remote-push.js";
import { LyricsEngine } from "./lyrics.js";
import { StageLyricsEngine, LyricsSwitch } from "./lyrics-stage.js";
import { parseLyricsDoc } from "./lyrics-doc.js";
import { syncClock, clockTime } from "./sync-clock.js";
import { queueEta, formatEta } from "./queue-order.js";
import { REACTIONS } from "./reactions.js";

const $ = (id) => document.getElementById(id);
const KIND_ICON = { midi: "🎤", audio: "🎵", video: "🎞️", youtube: "🌐" };
const PREFS_KEY = "karaeoke.remote.v1";
const SEARCH_LIMIT = 150;   // exact-tier rows rendered (the phone's list is not virtualised)
const FUZZY_BELOW = 20;     // close matches only while the exact tier is shorter (host: search.fuzzyBelow)

// --- device-local state (persisted on the phone) ---------------------------
let prefs = {
  nickname: "", theme: "dark", text: "m", room: "", lyricNudgeMs: 0,
  lyricLines: 4,       // visible lyric lines on THIS phone, scroll style (the host keeps its own)
  lyricScale: 1,       // lyric text multiplier on THIS phone (0.7–1.8)
  lyricStyle: "stage", // "stage" (the videoke rows, as on the TV) | "scroll" (the column)
};
// --- songbook ----------------------------------------------------------------
const catalog = new Catalog();
let songbook = "loading";  // "loading" | "ready" | "off" (no compact catalogue: control-only)
let searchClient = null;   // close-match index over catalog.songs (search-client.js)
// --- live host state -------------------------------------------------------
let room = "";           // the room code we're connected to ("" until the gate is passed)
let state = null;        // last host view {rev, ts, now, age, queue, settings, songRev, notice}
let lastRev = -1;
let stamp = 0;           // performance.now() when `state` (or a tick) arrived — progress interpolation
let lastOk = 0;          // last time the relay answered (a poll, or any push event)
let lastEventAt = -Infinity; // performance.now()/1000 of the last FRESH host view (hostIsLive)
let lastPushAt = 0;      // performance.now() of the last push event: a poll sent before it is stale
let lastNotice = "";     // the host notice already toasted
let ytOn = false;        // include YouTube results in search
let seeking = false;     // true while the user drags the seek slider (don't fight them)
let pollTimer = null;    // the fallback poll — runs only while push is not healthy
let uiTimer = null;      // smooth-progress ticker (cleared on leave)
let activeTab = "now";
const cid = makeCid();   // this tab's stream id: a reconnect replaces its own slot on the server
let push = null;         // the push client (remote-push.js)
let pushStatus = "off";  // "off" | "connecting" | "push" | "fallback"
let hostPushOff = false; // the host turned push off (its mirrored remote.push === false): poll only
// --- Lyrics tab ------------------------------------------------------------
let lyrics = null;       // LyricsSwitch(scroll, stage), built on first visit to the tab
// A document is keyed on the PAIR "songRev|now.id": the host's songRev restarts at 0 when its page
// reloads, so a rev alone could name a different song than the one loaded here.
let lyricKey = "";       // the key whose document is loaded (or settled); "" = none
let lyricWant = "";      // the key being fetched (a fetch or a retry is pending); "" = none
let lyricDocId = "";     // the host song id that document belongs to
let lyricMissAt = 0;     // settled WITHOUT a document (never published): when, for a slow re-ask
let lyricKind = "";      // "lines" | "baked" | "none" ("" = nothing loaded)
let lyricNote = "";      // what the head says about the loaded document
let lyricDocKey = "";    // the loaded document as JSON (a re-publish check)
let lyricDurKnown = false; // fetched after the song's duration was known (else re-check once)
let lyricToken = 0;      // guards against a slow fetch landing after the song moved on
let lyricRetry = null;
let lyricTries = 0;
let lyricRaf = 0;        // rAF handle — runs ONLY while the tab is visible (phone battery)
let lyricStale = false;
let clock = null;        // sync-clock state (see sync-clock.js)
const LYRIC_RETRY_MS = [300, 700, 1500, 3000, 5000];   // the host publishes right after a song loads

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
async function boot() {
  loadPrefs();
  applyPrefs();
  wireTabs();
  wireNow();
  wireLyrics();
  wireSearch();
  wireSheet();
  wireSettings();
  wireReactions();
  wireGate();

  $("s-origin").textContent = location.origin;
  loadSongbook();   // not awaited: the transport works while the songbook downloads

  document.addEventListener("visibilitychange", () => {
    // A backgrounded phone holds no stream and polls nothing (battery, and the server's slots).
    if (room) {
      if (document.hidden) stopPush();
      else { startPush(); acquireWakeLock(); }   // the lock is dropped while hidden
      syncPolling();
    }
    syncLyricLoop();   // a backgrounded phone must not burn a rAF loop on lyrics
    if (!document.hidden) refreshLyrics();
  });

  // Kiosk: a tablet on a stand as the singer's own lyric monitor. Same page, no chrome —
  // the Lyrics tab already renders a frame-accurate wipe off the room clock (sync-clock.js),
  // which is exactly what a second screen needs and costs nothing extra to expose.
  if (new URLSearchParams(location.search).get("kiosk") === "1") document.body.classList.add("kiosk");

  // A room code from the scanned QR (?room=) wins; else the last room we used. Validate it
  // against a live host room before entering; otherwise show the gate.
  const urlRoom = normRoom(new URLSearchParams(location.search).get("room"));
  const candidate = urlRoom || normRoom(prefs.room);
  if (candidate && await roomIsLive(candidate)) {
    enterRoom(candidate);
    if (document.body.classList.contains("kiosk")) showTab("lyrics");
  } else { $("gate-code").value = candidate; showGate(candidate ? "That code isn't active right now." : ""); }
}

// The compact songbook, then the close-match index over it. On any failure the phone stays
// control-only (transport, queue, lyrics) and the Search tab says so.
async function loadSongbook() {
  // performance marks: how long the songbook takes to be searchable (read them in DevTools or a
  // test rig; the plan's budget is ≤ 1.5 s at 4× CPU for loadCompact + adopt).
  try { performance.mark("songbook:start"); } catch (_) {}
  const r = await loadCompact();
  if (!r) { songbook = "off"; refreshSearch(); return; }
  try { performance.mark("songbook:decoded"); } catch (_) {}
  // The code maps (number search) are built just after the first paint, not inside adopt — they
  // are most of its time, and a phone on a slow CPU should be searchable sooner (plan R31).
  catalog.adopt(r.songs, { deferCodeIndex: true });
  try { performance.mark("songbook:adopted"); } catch (_) {}
  setTimeout(() => { try { catalog.ensureCodeIndex(); } catch (_) {} }, 0);
  songbook = "ready";
  try {
    searchClient = createSearchClient();
    const songs = catalog.songs;
    // A query typed before the index was ready gets its close tier once it is.
    searchClient.build(songs.map((s) => s.name), songs.map((s) => s.artistName))
      .then(() => { if (catalog.songs === songs) refreshSearch(); });
  } catch (e) {
    console.warn("Close-match search unavailable:", e);
    searchClient = null;
  }
  refreshSearch();
}

// ---------------------------------------------------------------------------
// Room gate
// ---------------------------------------------------------------------------
function normRoom(s) { return String(s || "").trim().toUpperCase().replace(/[^A-Z0-9]/g, ""); }

async function roomIsLive(code) {
  try {
    const d = await (await fetch(`/api/remote/state?room=${code}`)).json();
    return !!(d && d.ok);
  } catch (_) { return false; }
}

function wireGate() {
  const go = async () => {
    const code = normRoom($("gate-code").value);
    if (code.length < 4) { $("gate-err").textContent = "Enter the code from the karaoke screen."; return; }
    $("gate-err").textContent = "Checking…";
    if (await roomIsLive(code)) enterRoom(code);
    else $("gate-err").textContent = "No room with that code. Check the screen and try again.";
  };
  $("gate-go").onclick = go;
  $("gate-code").onkeydown = (e) => { if (e.key === "Enter") go(); };
  $("gate-code").oninput = (e) => { e.target.value = e.target.value.toUpperCase(); };
}

function showGate(msg) {
  room = "";
  // Tear down the stream, the poll and the tick loop and drop the stale view, so a left room's
  // progress bar stops extrapolating behind the gate and re-entry starts clean.
  stopPush();
  syncPolling();
  clearInterval(uiTimer); uiTimer = null;
  state = null; lastRev = -1; lastEventAt = -Infinity;
  clock = null;           // stop the lyric clock free-running behind the gate
  resetLyrics();
  closeSheet();
  document.body.classList.remove("connected");
  $("gate-err").textContent = msg || "";
  $("gate-code").focus();
}

function enterRoom(code) {
  room = code;
  prefs.room = code; savePrefs();
  $("s-room").textContent = code;
  document.body.classList.add("connected");
  lastRev = -1; state = null; lastEventAt = -Infinity;
  hostPushOff = false;   // until the room's first view says otherwise
  startPush();     // its "connecting" status starts the poll at once, until the stream answers
  syncPolling();
  acquireWakeLock();
  if (!uiTimer) uiTimer = setInterval(uiTick, 250);   // smooth now-playing progress between events
}

// ---------------------------------------------------------------------------
// Screen wake lock. A phone that auto-locks mid-song stops updating and freezes its lyric
// clock, and the guest has no idea why — they just see a stale screen. The Wake Lock API is
// released by the browser whenever the page is hidden, so it must be re-acquired on every
// return to visibility, not just once. Feature-detected: iOS Safari has no Wake Lock, and
// the honest answer there is a hint in the You tab rather than a video-playback hack.
// ---------------------------------------------------------------------------
let wakeLock = null;
async function acquireWakeLock() {
  if (!("wakeLock" in navigator) || wakeLock || !room || document.hidden) return;
  try {
    wakeLock = await navigator.wakeLock.request("screen");
    wakeLock.addEventListener("release", () => { wakeLock = null; });
  } catch (_) { wakeLock = null; }   // denied (low battery, no permission) → just let it sleep
}
function releaseWakeLock() {
  try { if (wakeLock) wakeLock.release(); } catch (_) {}
  wakeLock = null;
}

// ---------------------------------------------------------------------------
// Prefs (nickname + device-local look + last room)
// ---------------------------------------------------------------------------
function loadPrefs() {
  try {
    const p = JSON.parse(localStorage.getItem(PREFS_KEY) || "null");
    if (p && typeof p === "object") prefs = { ...prefs, ...p };
  } catch (_) {}
  prefs.lyricStyle = prefs.lyricStyle === "scroll" ? "scroll" : "stage";
}
function savePrefs() {
  try { localStorage.setItem(PREFS_KEY, JSON.stringify(prefs)); } catch (_) {}
}
function applyPrefs() {
  document.documentElement.dataset.theme = prefs.theme;
  document.documentElement.dataset.text = prefs.text;
  $("s-nick").value = prefs.nickname;
  $("s-theme").value = prefs.theme;
  $("s-text").value = prefs.text;
  $("s-lines").value = prefs.lyricLines;
  $("s-lyricsize").value = Math.round(prefs.lyricScale * 100);
  $("s-lyricstyle").value = prefs.lyricStyle;
  applyLyricDisplay();
}

// Push this phone's lyric-display prefs at the surfaces that render them. Device-local by
// design: a 400 px phone shouldn't inherit the TV's line count, and a guest must not be able
// to reshape everyone else's lyrics (contrast the ROOM's lyric offset, which is shared).
function applyLyricDisplay() {
  prefs.lyricLines = clamp(prefs.lyricLines, 2, 8) | 0;
  prefs.lyricScale = clamp(prefs.lyricScale, 0.7, 1.8);
  $("s-lines-val").textContent = prefs.lyricLines;
  $("s-lyricsize-val").textContent = `${Math.round(prefs.lyricScale * 100)}%`;
  // The size is CSS (it composes with the Text-size choice); the line count is the scroll engine's.
  document.documentElement.style.setProperty("--lyric-scale", prefs.lyricScale);
  if (lyrics) {
    lyrics.setOptions({ lineCount: prefs.lyricLines });
    lyrics.redraw();   // the stage measures its font from the container: re-measure after a size change
  }
}

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, +v || lo)); }

// ---------------------------------------------------------------------------
// Live channel: the event stream, the fallback poll, and commands (all scoped to the room)
// ---------------------------------------------------------------------------
function startPush() {
  stopPush();
  if (!room || hostPushOff) return;
  const client = createPushClient({
    url: `/api/remote/events?room=${encodeURIComponent(room)}&role=guest&cid=${cid}`,
    // A healthy stream opens with `state` at once. 3.5 s (not the default 4) puts a stream a
    // proxy holds silent at "polling" in 3 × 3.5 + 2 × 2 = 14.5 s — inside the 15 s budget (R11).
    // The poll runs throughout anyway: "connecting" polls too.
    firstEventMs: 3500,
    onEvent: (type, data) => { if (push === client) onPushEvent(type, data); },
    onStatus: (s) => {
      if (push !== client) return;   // a stopped client's last word
      pushStatus = s;
      syncPolling();
      renderConn();
    },
  });
  push = client;
  client.start();
}

function stopPush() {
  const p = push;
  push = null;
  if (p) p.stop();
  pushStatus = "off";
}

// Poll only while push is not carrying the room ("connecting" or "fallback"), and never on a
// backgrounded phone (battery/network). Starts with an immediate poll.
function syncPolling() {
  const want = !!room && !document.hidden && pushStatus !== "push";
  if (want && !pollTimer) { pollTimer = setInterval(poll, 1000); poll(); }
  else if (!want && pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  renderConn();
}

function onPushEvent(type, data) {
  if (!room) return;
  lastPushAt = performance.now();
  lastOk = lastPushAt;
  if (type === "state") { if (data.ok !== false) applyView(data); }
  else if (type === "tick") applyTick(data);
  else if (type === "gone") noRoom();
}

async function poll() {
  if (!room || document.hidden) return;
  const sentAt = performance.now();
  try {
    const res = await fetch(`/api/remote/state?room=${room}&since=${Math.max(0, lastRev)}`);
    const d = await res.json();
    if (!room) return;
    lastOk = performance.now();
    // The stream answered while this poll was in flight: its view is newer, keep it.
    if (lastPushAt > sentAt) { renderConn(); return; }
    if (d && d.error === "no-room") noRoom();
    else if (d && d.ok && !d.unchanged) applyView(d);
    // `unchanged` proves the SERVER answers, not that the host pushed: lastEventAt stays.
  } catch (_) { /* server unreachable — the status dot reflects it */ }
  renderConn();
}

// A full room view, from the stream (`state`) or a poll.
function applyView(d) {
  state = d;
  if (typeof d.rev === "number") lastRev = d.rev;
  stamp = performance.now();
  lastEventAt = stamp / 1000;
  reconcile();     // drop optimistic overrides the host has now caught up to
  refreshClock();
  renderNow(); renderQueue(); renderSettingsMirror(); renderSheet(); refreshLyrics();
  showNotice(d.notice);
  followHostPush(d.settings);   // after the view is applied: it may have come over the stream it stops
  renderConn();
}

// The host's "Instant updates (push)" toggle, mirrored read-only: off → drop the stream and poll;
// back on (or absent: an older host) → stream again.
function followHostPush(settings) {
  const off = !wantPush(settings);
  if (off === hostPushOff) return;
  hostPushOff = off;
  if (!room) return;
  if (off) stopPush();
  else if (!document.hidden) startPush();
  syncPolling();
}

// `tick`: only the clock moved — patch it into the last view.
function applyTick(t) {
  if (!state) return;   // a stream always opens with `state`; nothing to patch yet
  const at = performance.now();
  if (typeof t.rev === "number") { state.rev = t.rev; lastRev = t.rev; }
  if (typeof t.age === "number") state.age = t.age;
  const now = state.now;
  if (now && typeof now === "object") {
    if (typeof t.position === "number") now.position = t.position;
    if (typeof t.duration === "number") now.duration = t.duration;
    if (typeof t.paused === "boolean") now.paused = t.paused;
    if (t.score === null || typeof t.score === "number") now.score = t.score;
  }
  stamp = at;
  lastEventAt = at / 1000;
  reconcile();
  refreshClock();
  renderNow();
  if (activeTab === "queue") renderQueue();   // the "in ~N min" estimates move with the clock
  refreshLyrics();   // cheap unless the song's duration just became known (an unsynced re-publish)
  renderConn();
}

// The host stopped pushing (tab closed / server restart) — stay on the code; the room resumes
// when the host comes back. renderConn shows "waiting".
function noRoom() {
  state = null; clock = null;
  renderNow(); renderQueue(); renderSettingsMirror(); renderSheet(); refreshLyrics();
  renderConn();
}

// Send an intent to the host — always carries the guest nickname AND the room code (gated).
function cmd(obj) {
  if (!room) return;
  try {
    fetch("/api/remote/command", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...obj, by: prefs.nickname || "", room }),
    }).then(() => { if (pushStatus !== "push") poll(); }).catch(() => {});   // push delivers the result itself
  } catch (_) {}
}

// The host's read-only gates, mirrored in its settings (absent on an older host: allowed).
const hostSetting = (k) => (state && state.settings ? state.settings[k] : undefined);
const canPriority = () => !(hostSetting("remote.guestPriority") === false || hostSetting("queue.fairPlay") === true);
const canPlayNow = () => hostSetting("remote.guestPlayNow") === true;

// ---------------------------------------------------------------------------
// Optimistic overlay — "opportunistic update" for responsiveness
// ---------------------------------------------------------------------------
// A guest's action reaches the host through the relay, and its result comes back on the next
// state. To keep the UI responsive we apply the user's intent LOCALLY at once and HOLD it
// against the mirror: the render functions read the EFFECTIVE value (optimistic if held, else
// the host mirror), so a view returning the not-yet-applied host state can't clobber the user
// mid-action. `reconcile()` clears an override the instant the mirror actually reflects it
// (seamless handoff, no masking of the real value); anything not yet applied simply ages out
// (and a dropped command quietly reverts then). The hold is short while push is live (the
// answer is ~instant) and the old 2.5 s on the polling path.
const HOLD_MS = 2500;
const HOLD_PUSH_MS = 800;
const holdMs = () => (pushStatus === "push" ? HOLD_PUSH_MS : HOLD_MS);
const opt = {};                                        // key -> { v, t }
const optActive = (k) => !!opt[k] && performance.now() - opt[k].t < holdMs();
const optGet = (k, fallback) => (optActive(k) ? opt[k].v : fallback);
function optSet(k, v) { opt[k] = { v, t: performance.now() }; }

// Effective (host-mirror with optimistic override) reads used by the renders.
const setVal = (path, fallback) => optGet("set:" + path, (state && state.settings && state.settings[path]) ?? fallback);
const effQueue = () => optGet("queue", (state && state.queue) || []);
function effNow() {                                    // now-playing, with optimistic next / pause applied
  const base = optActive("now") ? opt["now"].v : (state && state.now);
  if (!base) return null;
  return { ...base, paused: optGet("paused", base.paused) };
}
// Interpolated position (from the optimistic seek base when one is held). Two corrections
// the naive "position + time since we got it" misses, both of which the lyric clock rides on:
//   - hostAge(): the view was already a little old when it reached us (its age on the server);
//   - rate: at tempo ≠ 1 the song advances `rate` seconds per wall second.
function effPos(now) {
  const rate = playRate();
  const seek = optActive("position");
  const base = seek ? opt["position"].v : now.position + (now.paused ? 0 : hostAge() * rate);
  const from = seek ? opt["position"].t : stamp;
  return now.paused ? base : base + ((performance.now() - from) / 1000) * rate;
}
// Seconds the last view had already been sitting on the server. Clamped: a wild value (a stale
// field from an older server) must not fling the position.
function hostAge() {
  const a = state && typeof state.age === "number" ? state.age : 0;
  return a > 0 && a < 5 ? a : 0;
}
const playRate = () => +setVal("audio.tempo", 1) || 1;
// Is the host alive? A fresh view within 6 s on THIS device's clock, and the server says the
// host's last push is under 6 s old. Drives the header chip AND freezes the lyric clock (a clock
// with no host behind it is a clock that lies). Never compares the server's `ts` with Date.now():
// that froze every phone whose clock was off.
const hostLive = () => !!state && hostIsLive({ lastEventAt, age: state.age, now: performance.now() / 1000 });

// Two queue rows are the same song: by catalogue row when both carry one (a phone's optimistic
// row has no host id), else by id (YouTube rows, an older host).
const sameRow = (a, b) => !!a && !!b && ((a.ref && b.ref) ? a.ref.i === b.ref.i : a.id === b.id);
function sameQueue(a, b) {
  if (a.length !== b.length) return false;
  for (let k = 0; k < a.length; k++) if (!sameRow(a[k], b[k])) return false;
  return true;
}
// The host's now-playing is the song an optimistic play-now/next named.
function sameNow(host, mine) {
  if (!host || !mine) return false;
  if (host.id === mine.id) return true;
  return !!mine.ref && String(host.code ?? "") === String(mine.ref.code ?? "")
    && host.name === mine.name && host.kind === mine.kind;
}

// After a fresh view, drop any optimistic override the host has now caught up to (instant handoff).
function reconcile() {
  const s = (state && state.settings) || {}, now = state && state.now, q = (state && state.queue) || [];
  for (const k of Object.keys(opt)) {
    if (!optActive(k)) { delete opt[k]; continue; }
    if (k === "position") continue;                    // rides the hold; interpolation stays continuous
    if (k.startsWith("set:")) { if (s[k.slice(4)] === opt[k].v) delete opt[k]; }
    else if (k === "paused") { if (now && now.paused === opt[k].v) delete opt[k]; }
    else if (k === "now") { if (sameNow(now, opt[k].v)) delete opt[k]; }
    else if (k === "queue") { if (sameQueue(q, opt[k].v)) delete opt[k]; }
  }
}

// ---------------------------------------------------------------------------
// Tabs
// ---------------------------------------------------------------------------
// Reactions — the crowd noise. The allowlist is imported from reactions.js so this phone and
// the host that actually renders them can never drift apart: a stranger's phone must not be
// able to put arbitrary text on someone's television.
function wireReactions() {
  const row = $("react-row");
  if (!row) return;
  for (const emoji of REACTIONS) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "react-btn";
    b.textContent = emoji;
    b.setAttribute("aria-label", `Send ${emoji}`);
    b.onclick = () => {
      cmd({ type: "react", emoji });
      b.classList.add("sent");                                  // local confirmation
      setTimeout(() => b.classList.remove("sent"), 420);
    };
    row.appendChild(b);
  }
}

function wireTabs() {
  for (const btn of document.querySelectorAll(".tabbar .tab")) {
    btn.onclick = () => showTab(btn.dataset.tab);
  }
}
function showTab(name) {
  activeTab = name;
  for (const p of document.querySelectorAll(".panel")) p.classList.toggle("active", p.id === `tab-${name}`);
  for (const b of document.querySelectorAll(".tabbar .tab")) b.classList.toggle("active", b.dataset.tab === name);
  if (name === "search") $("r-search").focus();
  if (name === "queue") renderQueue();
  // Lyrics are fetched + animated ONLY while their tab is on screen (no wasted fetch/rAF).
  syncLyricLoop();
  if (name === "lyrics") refreshLyrics();
}

// ---------------------------------------------------------------------------
// Tab 1 — Now Playing (transport + key / tempo / volume)
// ---------------------------------------------------------------------------
function wireNow() {
  $("now-playpause").onclick = () => {
    const now = effNow();
    if (now) { optSet("paused", !now.paused); cmd({ type: now.paused ? "play" : "pause" }); renderNow(); refreshClock(); }
    else cmd({ type: "play" });   // nothing loaded → host starts the queue; the next view shows it
  };
  $("now-next").onclick = () => {
    const q = effQueue();
    if (q.length) {                                   // optimistically advance to the next queued song
      const nx = q[0];
      optSet("now", { id: nx.id, name: nx.name, artist: nx.artist, kind: nx.kind, code: nx.code, ref: nx.ref, by: nx.by || "", position: 0, duration: 0, paused: false });
      optSet("position", 0);
      optSet("queue", q.slice(1));
      renderNow(); renderQueue(); refreshClock(); refreshLyrics();
    }
    cmd({ type: "next" });
  };
  $("now-restart").onclick = () => {
    if (!effNow()) return;
    optSet("position", 0); uiTick(); refreshClock();
    cmd({ type: "restart" });
  };
  const seek = $("now-seek");
  seek.oninput = () => { seeking = true; };
  seek.onchange = () => {
    seeking = false;
    const now = effNow();
    if (now && now.duration > 0) {
      const pos = (seek.value / 1000) * now.duration;
      optSet("position", pos); uiTick(); refreshClock();   // lyrics jump with the slider
      cmd({ type: "seek", position: pos });
    }
  };
  $("now-vol").onchange = (e) => {
    const v = +e.target.value / 100;
    optSet("set:audio.volume", v); renderNow();
    cmd({ type: "volume", value: v });
  };
  $("now-key-down").onclick = () => stepKey(-1);
  $("now-key-up").onclick = () => stepKey(1);
  $("now-tempo-down").onclick = () => stepTempo(-0.05);
  $("now-tempo-up").onclick = () => stepTempo(0.05);
  // Melody (guide-vocal channel) — an On/Off toggle mirroring the host's 🎵 transport button.
  // MIDI-only host-side (a no-op on video/YouTube); shown always, like the Key control.
  $("now-melody-toggle").onclick = () => {
    const muted = !!setVal("guide.vocal.mute", false);
    optSet("set:guide.vocal.mute", !muted); renderNow();
    cmd({ type: "setting", path: "guide.vocal.mute", value: !muted });
  };
}

function stepKey(delta) {
  const next = Math.max(-12, Math.min(12, setVal("audio.key", 0) + delta));
  optSet("set:audio.key", next);
  $("now-key-val").textContent = fmtKey(next);
  cmd({ type: "setting", path: "audio.key", value: next });
}

function stepTempo(delta) {
  const next = Math.round(Math.max(0.5, Math.min(1.5, setVal("audio.tempo", 1) + delta)) * 100) / 100; // clamp + avoid fp drift
  optSet("set:audio.tempo", next);
  $("now-tempo-val").textContent = `${next.toFixed(2)}×`;
  cmd({ type: "setting", path: "audio.tempo", value: next });
}

function renderNow() {
  const now = effNow();
  $("now-kind").textContent = now ? (KIND_ICON[now.kind] || "🎵") : "🎤";
  $("now-title").textContent = now ? (now.name || "(untitled)") : "Nothing playing";
  $("now-artist").textContent = now ? (now.artist || "") : "";
  // Live score (host mirrors it only while a song is actually being scored).
  const sc = $("now-score");
  if (sc) sc.textContent = now && now.score != null ? `★ ${now.score}` : "";
  $("now-playpause").textContent = now && !now.paused ? "❚❚" : "▶";
  $("now-restart").disabled = !now;
  // reflect the effective key/tempo/volume (optimistic if the guest just changed it, else the host mirror)
  const vol = Math.round(setVal("audio.volume", 0.9) * 100);
  if (document.activeElement !== $("now-vol")) $("now-vol").value = vol;
  $("now-vol-val").textContent = `${vol}%`;
  $("now-tempo-val").textContent = `${(+setVal("audio.tempo", 1)).toFixed(2)}×`;
  $("now-key-val").textContent = fmtKey(setVal("audio.key", 0));
  // melody (guide vocal): On/Off toggle
  const melodyMuted = !!setVal("guide.vocal.mute", false);
  const mt = $("now-melody-toggle");
  mt.classList.toggle("off", melodyMuted);
  mt.textContent = melodyMuted ? "Off" : "On";
  uiTick();
}

// Smooth the seek bar/time between views by extrapolating the position locally.
function uiTick() {
  renderConn();
  const now = effNow();
  const seek = $("now-seek");
  if (!now || !(now.duration > 0)) {
    if (!seeking) seek.value = 0;
    $("now-cur").textContent = "0:00"; $("now-dur").textContent = "0:00";
    return;
  }
  const pos = Math.max(0, Math.min(now.duration, effPos(now)));
  if (!seeking) seek.value = Math.round((pos / now.duration) * 1000);
  $("now-cur").textContent = fmt(pos);
  $("now-dur").textContent = fmt(now.duration);
}

// ---------------------------------------------------------------------------
// Tab 2 — Lyrics (the host's published document; only the clock comes off the live channel)
// ---------------------------------------------------------------------------
// The host publishes one lyric document per song (`songRev` counts them). The phone fetches it
// when songRev changes, feeds the SAME engines the host uses (stage rows or the scroll column,
// both loaded so switching style is instant), and drives them from a locally free-running clock
// that each view disciplines (sync-clock.js). Result: lyric motion is frame-accurate on the
// phone, and the only error left is one-way network latency, which the per-device nudge absorbs.

function wireLyrics() {
  const n = $("l-nudge");
  n.value = prefs.lyricNudgeMs || 0;
  $("l-nudge-val").textContent = `${prefs.lyricNudgeMs || 0} ms`;
  // Apply live while dragging (you're nudging against what you see), persist on release.
  n.oninput = () => { prefs.lyricNudgeMs = +n.value || 0; $("l-nudge-val").textContent = `${prefs.lyricNudgeMs} ms`; };
  n.onchange = () => savePrefs();
}

// Fold the newest host view into the local clock (called on every fresh view AND right after an
// optimistic transport action, so the lyrics react on the same tick as the button).
function refreshClock() {
  const now = effNow();
  if (!now) { clock = null; return; }
  clock = syncClock(clock, {
    position: effPos(now),   // already age-corrected and extrapolated to this instant
    age: 0,
    paused: now.paused,
    rate: playRate(),
    songId: now.id,
    at: performance.now(),
  });
}

// Total lyric shift: the ROOM's offset (mirrored from the host, moves everyone's lyrics)
// plus this phone's private nudge. Same sign convention as the host (§5.5).
function lyricOffsetSec() {
  return ((+setVal("lyrics.offsetMs", 0) || 0) + (prefs.lyricNudgeMs || 0)) / 1000;
}

const lyricsTabLive = () => activeTab === "lyrics" && !document.hidden;
const currentSongRev = () => (state && state.now ? (Number(state.songRev) || 0) : 0);
const currentHostId = () => (state && state.now ? String(state.now.id ?? "") : "");
// "" while nothing is published (songRev 0) or nothing plays.
const currentLyricKey = () => { const rev = currentSongRev(); return rev ? `${rev}|${currentHostId()}` : ""; };
const LYRIC_MISS_REASK_MS = 5000;

// Start/stop the render loop to match the tab's visibility.
function syncLyricLoop() {
  if (lyricsTabLive()) {
    if (!lyricRaf) lyricRaf = requestAnimationFrame(lyricFrame);
  } else if (lyricRaf) {
    cancelAnimationFrame(lyricRaf);
    lyricRaf = 0;
  }
}

// The loaded document belongs to what is on screen now. False while an optimistic next / play
// now is pending, or the host started a song whose document has not arrived yet.
function lyricShowing(now) {
  return lyricKind === "lines" && !!now && lyricKey === currentLyricKey() && now.id === lyricDocId;
}

function setLyricStale(v) {
  if (v === lyricStale) return;
  lyricStale = v;
  $("l-lyrics").classList.toggle("stale", v);
}

function lyricFrame() {
  lyricRaf = lyricsTabLive() ? requestAnimationFrame(lyricFrame) : 0;
  if (!lyrics) return;
  const now = effNow();
  const showing = lyricShowing(now);
  setLyricStale(lyricKind === "lines" && !showing);
  if (!showing || !clock) return;
  // FREEZE rather than free-run once the host has gone quiet (tab closed, server restarted,
  // or a backgrounded host whose push loop got throttled). Extrapolating against a host that
  // may not even be playing is worse than holding — and the header already says "waiting for
  // host". `syncClock` snaps back the moment real views resume.
  if (!hostLive()) return;
  lyrics.update(clockTime(clock, performance.now()) + lyricOffsetSec());
}

function ensureLyrics() {
  if (lyrics) return lyrics;
  const el = $("l-lyrics");
  // The scroll engine first: it empties the container, the stage engine then adds its canvas.
  const scroll = new LyricsEngine(el, { lineCount: prefs.lyricLines, smooth: true, mergeLines: 1 });
  const stage = new StageLyricsEngine(el, {});
  lyrics = new LyricsSwitch(scroll, stage, prefs.lyricStyle);
  return lyrics;
}

function resetLyrics() {
  lyricKey = ""; lyricWant = ""; lyricDocId = ""; lyricKind = ""; lyricNote = ""; lyricDocKey = "";
  lyricMissAt = 0;
  lyricDurKnown = false;
  lyricToken++;
  clearTimeout(lyricRetry); lyricRetry = null;
  if (lyrics) lyrics.clear();
  setLyricStale(false);
}

// Bring the Lyrics tab up to date with the room. No-ops unless the tab is on screen, so a guest
// who never opens it never fetches a document.
function refreshLyrics() {
  if (!lyricsTabLive()) return;
  ensureLyrics();
  const now = effNow();
  const key = currentLyricKey();
  if (!now) {
    if (lyricKey || lyricWant || lyricKind) resetLyrics();
    setLyricHead(null, "");
    return;
  }
  if (!key) {                                       // nothing published yet: a quiet head
    if (lyricKind) resetLyrics();
    setLyricHead(now, "");
    return;
  }
  if (key !== lyricKey) {
    if (key !== lyricWant) { lyricWant = key; lyricTries = 0; fetchDoc(key); }
    setLyricStale(lyricKind === "lines");
    setLyricHead(now, "loading lyrics…");
    return;
  }
  const showing = lyricKind !== "lines" || lyricShowing(now);
  setLyricHead(now, showing ? lyricNote : "loading lyrics…");
  // Never published (or published after the retries gave up — a relay restart re-publishes
  // late): ask again now and then while the tab is open.
  if (lyricMissAt && !lyricWant && performance.now() - lyricMissAt > LYRIC_MISS_REASK_MS) {
    lyricMissAt = performance.now();
    lyricWant = key; lyricTries = LYRIC_RETRY_MS.length;   // one try, no retry ladder
    fetchDoc(key);
    return;
  }
  // An unsynced .txt is timed only once the host knows the song's length; the host then
  // re-publishes the SAME songRev. Fetch once more after the duration first shows up.
  if (lyricKind === "lines" && !lyricDurKnown && state.now.duration > 0) {
    lyricDurKnown = true;
    recheckDoc(key);
  }
}

async function getSongDoc() {
  try { return await (await fetch(`/api/remote/song?room=${encodeURIComponent(room)}`)).json(); }
  catch (_) { return null; }
}

// The published document answers `key` only when BOTH halves match: its songRev, and its id
// against the host's current now.id (during a song load now.id moves before songRev does).
function docMatches(d, key) {
  return !!d && d.ok === true && `${d.songRev}|${String(d.id ?? "")}` === key;
}

async function fetchDoc(key) {
  const token = ++lyricToken;
  clearTimeout(lyricRetry); lyricRetry = null;
  const d = await getSongDoc();
  if (token !== lyricToken || lyricWant !== key || !room) return;   // the song moved on meanwhile
  if (key !== currentLyricKey()) { lyricWant = ""; refreshLyrics(); return; }   // …while the tab was hidden
  if (docMatches(d, key)) { applyDoc(key, d, ""); refreshLyrics(); return; }
  // Not published yet, or still the previous song's (the host publishes right after a song
  // loads, and again after a relay restart): try again a few times, then say where they are.
  if (lyricTries < LYRIC_RETRY_MS.length) {
    lyricRetry = setTimeout(() => {
      lyricRetry = null;
      if (token !== lyricToken || lyricWant !== key) return;
      if (!lyricsTabLive()) { lyricWant = ""; return; }     // resumes when the tab is back
      fetchDoc(key);
    }, LYRIC_RETRY_MS[lyricTries++]);
    return;
  }
  applyDoc(key, { id: currentHostId(), doc: null }, "lyrics are on the big screen");
  lyricMissAt = performance.now();
  refreshLyrics();
}

function recheckDoc(key) {
  setTimeout(async () => {
    if (lyricKey !== key || lyricWant || !room || !lyricsTabLive()) return;
    const d = await getSongDoc();
    if (lyricKey !== key || lyricWant || key !== currentLyricKey() || !docMatches(d, key)) return;
    if (JSON.stringify(d.doc ?? null) === lyricDocKey) return;   // the same document: nothing to do
    applyDoc(key, d, "");
    refreshLyrics();
  }, 1000);
}

// Load one published document into both engines (or settle on the note that replaces them).
function applyDoc(key, d, note) {
  lyricWant = "";
  lyricKey = key;
  lyricMissAt = 0;
  lyricDocId = String(d.id ?? "");
  lyricDocKey = JSON.stringify(d.doc ?? null);
  lyricDurKnown = !!(state && state.now && state.now.duration > 0);
  let parsed = null;
  try { parsed = d.doc ? parseLyricsDoc(d.doc) : null; } catch (_) { parsed = null; }
  const now = effNow();
  if (!parsed || parsed.kind !== "lines") {
    lyrics.clear();
    if (parsed && parsed.kind === "baked") {
      lyricKind = "baked";
      lyricNote = `lyrics are part of the ${now && now.kind === "youtube" ? "video" : "picture"}`;
    } else {
      lyricKind = "none";
      lyricNote = note || (d.doc && !parsed ? "lyrics are on the big screen" : "no lyrics for this song");
    }
    return;
  }
  lyricKind = "lines";
  // LyricsSwitch.loadDoc: the stage engine takes the document (cues, tempo), the scroll engine the
  // same raw lines.
  lyricNote = lyrics.loadDoc(parsed) ? "" : "instrumental — no lyrics in this file";
}

function setLyricHead(now, note) {
  $("l-title").textContent = now ? (now.name || "(untitled)") : "Nothing playing";
  $("l-state").textContent = note || (now && now.artist) || "";
}

// ---------------------------------------------------------------------------
// Tab 3 — Search  (the compact songbook in the host's three tiers + optional YouTube)
// ---------------------------------------------------------------------------
let searchGen = 0;
let results = { q: "", rows: [], close: [], yt: [], looking: false };

function wireSearch() {
  const input = $("r-search");
  let deb;
  input.oninput = () => { clearTimeout(deb); deb = setTimeout(() => runSearch(input.value), 150); };
  // Enter: search now and drop the keyboard so the results are visible.
  input.onkeydown = (e) => { if (e.key === "Enter") { clearTimeout(deb); runSearch(input.value); input.blur(); } };
  $("r-yt").onclick = () => { ytOn = !ytOn; $("r-yt").classList.toggle("on", ytOn); runSearch(input.value); };
}

function refreshSearch() { runSearch($("r-search").value); }

// Tiers 1 and 2, as library-view.js searchTiers computes them on the host (mirrored here so the
// phone does not import the host's list UI): a digits-only query lists every song numbered
// exactly that (leading zeros ignored, every songbook, in songbook order), then the code-prefix
// matches; anything else is exactly Catalog.search, in its order.
function phoneTiers(q) {
  if (/^\d+$/.test(q.trim())) {
    const exact = orderNumberMatches(catalog.lookupCode(normalizeCode(q), "all"), SOURCES);
    return { rows: mergeTiers(exact, catalog.search(q, SEARCH_LIMIT)), numeric: true };
  }
  return { rows: catalog.search(q, SEARCH_LIMIT), numeric: false };
}

function runSearch(raw) {
  const q = String(raw || "").trim();
  const gen = ++searchGen;
  if (!q) { results = { q, rows: [], close: [], yt: [], looking: false }; renderResults(); return; }
  const tiers = phoneTiers(q);
  const rows = tiers.rows.slice(0, SEARCH_LIMIT);
  // Tier 3 — close matches (typos), only for a short exact tier and a word of 4+ letters.
  const wantClose = !tiers.numeric && tiers.rows.length < FUZZY_BELOW && !!searchClient && searchClient.ready
    && tokenize(q).some((t) => t.length >= 4);
  results = { q, rows, close: [], yt: [], looking: wantClose && !rows.length };
  renderResults();
  if (wantClose) {
    const songs = catalog.songs;
    searchClient.query(q, { exclude: tiers.rows.map((s) => s.i) }).then((hits) => {
      if (gen !== searchGen || catalog.songs !== songs) return;   // the query (or the songbook) moved on
      results.close = (hits || []).map((h) => songs[h.i]).filter(Boolean).slice(0, MAX_CLOSE);
      results.looking = false;
      renderResults();
    }).catch(() => { if (gen === searchGen) { results.looking = false; renderResults(); } });
  }
  if (ytOn) youtubeSearch(q, gen);
}

async function youtubeSearch(q, gen) {
  try {
    const res = await fetch("/api/youtube-search", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ q: `${q} karaoke` }),
    });
    const d = await res.json();
    if (gen !== searchGen) return;   // query moved on
    results.yt = ((d && d.items) || []).map((it) => Catalog.makeYoutubeRecord(it)).filter(Boolean);
    renderResults();
  } catch (_) {}
}

function setSearchHint(text) {
  const hint = $("r-search-hint");
  hint.style.display = text ? "" : "none";
  hint.textContent = text || "";
}

// Exact rows, then the close rows ("≈"), then YouTube — appended rows never move the ones above.
function renderResults() {
  const ul = $("r-results");
  ul.innerHTML = "";
  const { q, rows, close, yt, looking } = results;
  const frag = document.createDocumentFragment();
  for (const s of rows) frag.appendChild(songRow(s, false));
  for (const s of close) frag.appendChild(songRow(s, true));
  for (const s of yt) frag.appendChild(songRow(s, false));
  ul.appendChild(frag);
  const n = rows.length + close.length + yt.length;
  if (n) setSearchHint("");
  else if (songbook === "off") setSearchHint(ytOn && q ? "No matches." : "The songbook isn't available — the controls still work.");
  else if (songbook === "loading") setSearchHint(q ? "Loading the songbook…" : "Type to search the songbook.");
  else if (!q) setSearchHint("Type to search the songbook.");
  else setSearchHint(looking ? "Looking for close spellings…" : "No matches.");
}

// A row: kind icon · title / artist · [≈]. No number column: the phone shows no song numbers
// (a typed number still finds its songs). One button: a tap opens the song sheet.
function songRow(s, close) {
  const li = document.createElement("li");
  li.className = "song" + (close ? " close-match" : "");
  const b = document.createElement("button");
  b.type = "button";
  b.className = "song-btn";
  b.setAttribute("aria-haspopup", "dialog");
  const icon = el("span", "kind", KIND_ICON[s.kind] || "🎵");
  const meta = el("span", "meta");
  meta.append(el("span", "t", s.name || "(untitled)"), el("span", "a", s.artistName || ""));
  b.append(icon, meta);
  if (close) {
    // A glyph, not a colour: role="img" is what lets the aria-label name it.
    const mark = el("span", "close-mark", "≈");
    mark.setAttribute("role", "img");
    mark.setAttribute("aria-label", "close match");
    mark.title = "Close match";
    b.appendChild(mark);
  }
  b.onclick = () => openSheet(s, b);
  li.appendChild(b);
  return li;
}

// --- the song sheet: Reserve / Play next / Play now ---------------------------------------
let sheetSong = null;
let sheetOpener = null;

function wireSheet() {
  $("sheet-reserve").onclick = () => sheetAct("enqueue");
  $("sheet-next").onclick = () => sheetAct("priority");
  $("sheet-now").onclick = () => sheetAct("playnow");
  $("sheet-cancel").onclick = () => closeSheet();
  $("sheet-scrim").onclick = () => closeSheet();
  $("sheet").addEventListener("keydown", (e) => { if (e.key === "Escape") { e.preventDefault(); closeSheet(); } });
}

function openSheet(song, opener) {
  sheetSong = song;
  sheetOpener = opener || null;
  $("sheet-kind").textContent = KIND_ICON[song.kind] || "🎵";
  $("sheet-title").textContent = song.name || "(untitled)";
  // No song number and no songbook (Rae, 2026-11-24) — as on the TV's own sheet.
  $("sheet-artist").textContent = song.artistName || "";
  renderSheet();
  $("sheet").hidden = false;
  document.body.classList.add("sheet-open");
  $("sheet-reserve").focus();
}

function closeSheet() {
  if (!sheetSong && $("sheet").hidden) return;
  sheetSong = null;
  $("sheet").hidden = true;
  document.body.classList.remove("sheet-open");
  const back = sheetOpener;
  sheetOpener = null;
  if (back && back.isConnected) back.focus();
}

// Play next / Play now follow the host's gates, live: the host may flip them while the sheet is open.
function renderSheet() {
  if (!sheetSong) return;
  $("sheet-next").hidden = !canPriority();
  $("sheet-now").hidden = !canPlayNow();
}

function sheetAct(type) {
  const s = sheetSong;
  closeSheet();
  if (s) requestSong(type, s);
}

// The command naming a song to the host: a library song by its compact row (the host checks the
// code, then falls back to the code + songbook), a YouTube result by its video id.
function songCommand(type, s) {
  if (s.kind === "youtube") return { type, kind: "youtube", videoId: s.videoId || "", name: s.name || "", artist: s.artistName || "" };
  return { type, ref: { i: s.i, code: s.code }, source: s.source || "", name: s.name || "", artist: s.artistName || "", kind: s.kind };
}

// The mirror shape of a queued song, for the optimistic overlay (reconciled by ref.i, else id).
function mirrorRow(s) {
  const row = { id: s.id, name: s.name || "", artist: s.artistName || "", kind: s.kind, code: s.code || "", by: prefs.nickname || "" };
  if (s.kind !== "youtube" && Number.isInteger(s.i)) row.ref = { i: s.i, code: s.code };
  return row;
}

const REQUEST_SAID = { enqueue: "Reserved", priority: "Playing next", playnow: "Starting" };

function requestSong(type, s) {
  const row = mirrorRow(s);
  if (type === "enqueue") optSet("queue", [...effQueue(), row]);
  else if (type === "priority") optSet("queue", [row, ...effQueue()]);
  else if (type === "playnow") {
    optSet("now", { ...row, position: 0, duration: 0, paused: false });
    optSet("position", 0);
  }
  renderNow(); renderQueue(); refreshClock(); refreshLyrics();
  cmd(songCommand(type, s));
  showToast(`${REQUEST_SAID[type] || "Sent"}: ${s.name || "(untitled)"}`, 1800);
}

// ---------------------------------------------------------------------------
// Tab 4 — Queue
// ---------------------------------------------------------------------------
function renderQueue() {
  const now = effNow();
  $("q-now").innerHTML = "";
  if (now) {
    const d = document.createElement("div"); d.className = "q-now-card";
    d.innerHTML = `<span class="np">NOW</span> <span class="kind">${KIND_ICON[now.kind] || "🎵"}</span>
      <span class="t">${esc(now.name || "(untitled)")}</span> <span class="a">${esc(now.artist || "")}</span>
      ${now.by ? `<span class="by">· ${esc(now.by)}</span>` : ""}`;
    $("q-now").appendChild(d);
  }
  const ul = $("r-queue");
  ul.innerHTML = "";
  const q = effQueue();
  $("q-empty").style.display = q.length ? "none" : "";
  // "How long until mine?" — the question a guest actually has. The host mirrors each queued
  // song's LEARNED length (`dur`, null until it's been played once); queue-order.js falls back
  // to an average for the rest, so the answer is approximate on purpose and immediate.
  const remaining = now && now.duration > 0 ? Math.max(0, now.duration - effPos(now)) : 0;
  const durations = q.map((s) => s.dur);
  const jump = canPriority();
  q.forEach((s, i) => ul.appendChild(queueRow(s, i, q.length, formatEta(queueEta(remaining, durations, i)), jump)));
}

function queueRow(s, i, n, eta, jump) {
  const li = document.createElement("li");
  li.className = "qrow";
  const meta = document.createElement("div"); meta.className = "meta";
  const t = document.createElement("div"); t.className = "t";
  t.innerHTML = `<span class="kind">${KIND_ICON[s.kind] || "🎵"}</span> ${esc(s.name || "(untitled)")}`;
  const a = document.createElement("div"); a.className = "a";
  a.textContent = s.artist || "";
  if (s.by) { const b = document.createElement("span"); b.className = "by"; b.textContent = ` · ${s.by}`; a.appendChild(b); }
  if (eta) { const e = document.createElement("span"); e.className = "eta"; e.textContent = ` · ${eta}`; a.appendChild(e); }
  meta.append(t, a);
  const ctr = document.createElement("div"); ctr.className = "qctl";
  // Every queue mutation carries the song's stable id alongside the index: this phone's view
  // can be behind the host, so by the time the command lands the index may point at a different
  // song (auto-advance, or another guest acting first). The host verifies the id and ignores
  // the command rather than mutating the wrong row.
  // "Play next" moves the queued song to the front (a reorder, so it is not queued twice); it is
  // offered under the same host gates as the sheet's Play next.
  if (jump && i > 0) {
    const nx = mkBtn("⤒", "Play next", () => { reorderOpt(i, 0); cmd({ type: "reorder", from: i, to: 0, id: s.id }); });
    nx.classList.add("jump");
    ctr.appendChild(nx);
  }
  const up = mkBtn("↑", "Move up", () => { reorderOpt(i, i - 1); cmd({ type: "reorder", from: i, to: i - 1, id: s.id }); }, i === 0);
  const dn = mkBtn("↓", "Move down", () => { reorderOpt(i, i + 1); cmd({ type: "reorder", from: i, to: i + 1, id: s.id }); }, i === n - 1);
  const rm = mkBtn("✕", "Remove", () => {
    optSet("queue", effQueue().filter((_, idx) => idx !== i)); renderQueue();
    cmd({ type: "remove", index: i, id: s.id });
  });
  rm.classList.add("rm");
  ctr.append(up, dn, rm);
  li.append(meta, ctr);
  return li;
}
// Optimistically move a queue item (mirrors the host's reorder) so the list reflows at once.
function reorderOpt(from, to) {
  const q = effQueue().slice();
  if (to < 0 || to >= q.length) return;
  const [item] = q.splice(from, 1); q.splice(to, 0, item);
  optSet("queue", q); renderQueue();
}
function mkBtn(label, title, onClick, disabled) {
  const b = document.createElement("button");
  b.textContent = label; b.title = title; b.onclick = onClick;
  b.setAttribute("aria-label", title);
  if (disabled) b.disabled = true;
  return b;
}

// ---------------------------------------------------------------------------
// Tab 5 — You (nickname, lyric offset, device prefs, connection + room)
// ---------------------------------------------------------------------------
function wireSettings() {
  $("s-nick").oninput = (e) => { prefs.nickname = e.target.value.slice(0, 24); savePrefs(); };
  $("s-theme").onchange = (e) => { prefs.theme = e.target.value; document.documentElement.dataset.theme = prefs.theme; savePrefs(); };
  $("s-text").onchange = (e) => {
    prefs.text = e.target.value; document.documentElement.dataset.text = prefs.text; savePrefs();
    if (lyrics) lyrics.redraw();
  };
  // Lyric display (this phone only) — apply live while dragging, persist on release.
  $("s-lyricstyle").onchange = (e) => {
    prefs.lyricStyle = e.target.value === "scroll" ? "scroll" : "stage";
    savePrefs();
    if (lyrics) lyrics.setStyle(prefs.lyricStyle);
  };
  $("s-lines").oninput = (e) => { prefs.lyricLines = +e.target.value; applyLyricDisplay(); };
  $("s-lines").onchange = () => savePrefs();
  $("s-lyricsize").oninput = (e) => { prefs.lyricScale = +e.target.value / 100; applyLyricDisplay(); };
  $("s-lyricsize").onchange = () => savePrefs();
  $("s-offset").onchange = (e) => {
    const v = +e.target.value;
    optSet("set:lyrics.offsetMs", v); renderSettingsMirror();
    cmd({ type: "setting", path: "lyrics.offsetMs", value: v });
  };
  $("s-reconnect").onclick = () => { lastRev = -1; if (room) { startPush(); syncPolling(); poll(); } };
  $("s-leave").onclick = () => {
    releaseWakeLock();   // no room, no reason to hold the screen awake
    prefs.room = ""; savePrefs(); $("gate-code").value = ""; showGate("");
  };
}

// Reflect the effective lyric offset (optimistic if just changed, else the host mirror; not while dragging).
function renderSettingsMirror() {
  const v = setVal("lyrics.offsetMs", 0);
  if (document.activeElement !== $("s-offset")) $("s-offset").value = v;
  $("s-offset-val").textContent = `${v} ms`;
}

// ---------------------------------------------------------------------------
// Connection status + the toast
// ---------------------------------------------------------------------------
const MODE_LABEL = { push: "instant", fallback: "polling", connecting: "connecting…", off: "—" };
let connShown = "";
function renderConn() {
  const reachable = pushStatus === "push" || performance.now() - lastOk < 4000;
  let label, cls;
  if (!reachable) { label = "offline"; cls = "bad"; }
  else if (!hostLive()) { label = "waiting for host"; cls = "warn"; }
  else { label = "connected"; cls = "ok"; }
  const mode = !room ? "—" : hostPushOff ? "polling" : (MODE_LABEL[pushStatus] || "—");
  const key = `${cls}|${label}|${mode}`;
  if (key === connShown) return;
  connShown = key;
  $("conn").className = `conn ${cls}`;
  $("conn-label").textContent = label;
  const st = $("s-status"); if (st) st.textContent = label;
  const md = $("s-mode"); if (md) md.textContent = mode;
}

// The host's one-line notice (e.g. "Kai: not allowed by the host"), shown once when it appears.
function showNotice(n) {
  const text = typeof n === "string" ? n : "";
  if (text && text !== lastNotice) showToast(text, 4000);
  lastNotice = text;
}

let toastTimer = null;
function showToast(text, ms = 3000) {
  const t = $("toast");
  t.textContent = text;
  t.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove("show"), ms);
}

// ---------------------------------------------------------------------------
// Utils
// ---------------------------------------------------------------------------
function fmt(sec) {
  sec = Math.max(0, Math.floor(sec || 0));
  return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, "0")}`;
}
function fmtKey(k) { k = +k || 0; return k > 0 ? `+${k}` : `${k}`; }
function esc(s) { return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])); }
function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

boot();
