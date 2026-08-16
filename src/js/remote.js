/*
 * remote.js — the phone remote-control page (served at /remote; shell = src/remote.html).
 *
 * A guest's browser on the same network. It has NO synth and NO local player: it reuses
 * the tested Catalog (catalog.js) to search the songbook locally, reads a specific host
 * ROOM's live state from serve.py's multi-room relay (GET /api/remote/state?room=CODE) and
 * sends intents back (POST /api/remote/command, scoped to the room). The HOST stays the
 * authoritative player — see src/js/remote-host.js and §5.x in CLAUDE.md.
 *
 * A ROOM CODE gates entry: scanning the host's QR fills ?room= and auto-connects; otherwise
 * the guest types the code shown on the karaoke screen. Five tabs: Now / Lyrics / Search /
 * Queue / You.
 *
 * LYRICS: the relay is a ~1 Hz control channel — far too coarse to stream a syllable wipe —
 * so lyric TEXT never crosses it. The phone resolves the now-playing song in its own Catalog,
 * fetches and parses the file itself (MIDI via pako+parseMidi, AUDIO via its sidecar), and
 * renders with the host's own LyricsEngine. Only the CLOCK is synced, disciplined by the
 * server-measured snapshot `age` — see src/js/sync-clock.js.
 */
import { Catalog } from "./catalog.js";
import { LyricsEngine, parseMidi, buildLines, makeTickToSeconds } from "./lyrics.js";
import { linesFromLyricFile, distributeLineTimes } from "./lyrics-formats.js";
import { syncClock, clockTime } from "./sync-clock.js";
import { queueEta, formatEta } from "./queue-order.js";

const $ = (id) => document.getElementById(id);
const KIND_ICON = { midi: "🎤", video: "🎞️", youtube: "🌐" };
const PREFS_KEY = "karaeoke.remote.v1";

// --- device-local state (persisted on the phone) ---------------------------
let prefs = {
  nickname: "", theme: "dark", text: "m", room: "", lyricNudgeMs: 0,
  lyricLines: 4,     // visible lyric lines on THIS phone (the host keeps its own)
  lyricScale: 1,     // lyric text multiplier on THIS phone (0.7–1.8)
};
// --- live host state -------------------------------------------------------
let catalog = new Catalog();
let room = "";           // the room code we're connected to ("" until the gate is passed)
let state = null;        // last host snapshot {rev, ts, now, queue, settings}
let lastRev = -1;
let stamp = 0;           // performance.now() when `state` arrived (for progress interpolation)
let lastOk = 0;          // last successful poll time (connection health)
let ytOn = false;        // include YouTube results in search
let seeking = false;     // true while the user drags the seek slider (don't fight them)
let pollTimer = null;
let uiTimer = null;      // smooth-progress ticker (paired with pollTimer; both cleared on leave)
let activeTab = "now";
// --- Lyrics tab ------------------------------------------------------------
let lyricsEngine = null; // built on first visit to the tab (not at boot — most guests never open it)
let lyricSongId = null;  // id whose lines are loaded into the engine ("" = nothing playing)
let lyricToken = 0;      // guards against a slow load landing after the song moved on
let lyricRaf = 0;        // rAF handle — runs ONLY while the tab is visible (phone battery)
let clock = null;        // sync-clock state (see sync-clock.js)
const lyricCache = new Map(); // song id -> { lines } | { baked:true }

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
  wireSettings();
  wireReactions();
  wireGate();

  $("s-origin").textContent = location.origin;
  try { await catalog.load(); } catch (_) { /* songbook optional for control-only use */ }

  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && room) { poll(); acquireWakeLock(); }  // the lock is dropped while hidden
    syncLyricLoop();   // a backgrounded phone must not burn a rAF loop on lyrics
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
  // Tear down the poll/tick loop and drop the stale snapshot, so a left room's progress
  // bar stops extrapolating behind the gate and re-entry starts clean.
  clearInterval(pollTimer); clearInterval(uiTimer);
  pollTimer = uiTimer = null;
  state = null; lastRev = -1;
  clock = null; lyricSongId = null; lyricToken++;   // stop the lyric clock free-running behind the gate
  if (lyricsEngine) lyricsEngine.clear();
  document.body.classList.remove("connected");
  $("gate-err").textContent = msg || "";
  $("gate-code").focus();
}

function enterRoom(code) {
  room = code;
  prefs.room = code; savePrefs();
  $("s-room").textContent = code;
  document.body.classList.add("connected");
  lastRev = -1; state = null;
  poll();
  acquireWakeLock();
  if (!pollTimer) {
    pollTimer = setInterval(poll, 1000);   // pull host state
    uiTimer = setInterval(uiTick, 250);    // smooth now-playing progress between polls
  }
}

// ---------------------------------------------------------------------------
// Screen wake lock. A phone that auto-locks mid-song stops polling and freezes its lyric
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
  // The size is CSS (it composes with the Text-size choice); the line count is the engine's.
  document.documentElement.style.setProperty("--lyric-scale", prefs.lyricScale);
  if (lyricsEngine) lyricsEngine.setOptions({ lineCount: prefs.lyricLines });
}

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, +v || lo)); }

// ---------------------------------------------------------------------------
// Relay I/O (all scoped to the room)
// ---------------------------------------------------------------------------
async function poll() {
  if (!room || document.hidden) return; // don't poll a backgrounded phone (battery/network)
  try {
    const res = await fetch(`/api/remote/state?room=${room}&since=${Math.max(0, lastRev)}`);
    const d = await res.json();
    lastOk = performance.now();
    if (d && d.error === "no-room") {
      // The host stopped pushing (tab closed / server restart) — stay on the code and keep
      // polling; the room resumes when the host comes back. renderConn shows "waiting".
      state = null; clock = null;
      renderNow(); renderQueue(); renderSettingsMirror(); refreshLyrics();
    } else if (d && d.ok && !d.unchanged) {
      state = d; lastRev = d.rev; stamp = performance.now();
      reconcile(); // drop optimistic overrides the host has now caught up to
      refreshClock();
      renderNow(); renderQueue(); renderSettingsMirror(); refreshLyrics();
    }
  } catch (_) { /* server unreachable — the status dot reflects it */ }
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
    }).then(() => poll()).catch(() => {});
  } catch (_) {}
}

// ---------------------------------------------------------------------------
// Optimistic overlay — "opportunistic update" for responsiveness
// ---------------------------------------------------------------------------
// A guest's action reaches the host through a ~1–2 s relay (host drains commands on its ~1 s tick,
// then pushes state back). To keep the UI responsive we apply the user's intent LOCALLY at once and
// HOLD it against the mirror for HOLD_MS: the render functions read the EFFECTIVE value (optimistic if
// held, else the host mirror), so a poll returning the not-yet-applied host state can't clobber the
// user mid-action. `reconcile()` clears an override the instant the mirror actually reflects it (seamless
// handoff, no masking of the real value); anything not yet applied simply ages out after HOLD_MS (and a
// dropped command quietly reverts then). Generalizes the seek slider's `seeking` flag.
const HOLD_MS = 2500;
const opt = {};                                        // key -> { v, t }
const optActive = (k) => !!opt[k] && performance.now() - opt[k].t < HOLD_MS;
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
//   - hostAge(): the snapshot was already up to a second old when we polled it (our poll phase
//     is unrelated to the host's push phase); serve.py measures that staleness for us;
//   - rate: at tempo ≠ 1 the song advances `rate` seconds per wall second.
function effPos(now) {
  const rate = playRate();
  const seek = optActive("position");
  const base = seek ? opt["position"].v : now.position + (now.paused ? 0 : hostAge() * rate);
  const from = seek ? opt["position"].t : stamp;
  return now.paused ? base : base + ((performance.now() - from) / 1000) * rate;
}
// Seconds the last polled snapshot had already been sitting on the server. Clamped: a wild
// value (clock skew / a stale field from an older server) must not fling the position.
function hostAge() {
  const a = state && typeof state.age === "number" ? state.age : 0;
  return a > 0 && a < 5 ? a : 0;
}
const playRate = () => +setVal("audio.tempo", 1) || 1;
// The host bumps `ts` every ~1 s while it's syncing; a stale/absent ts ⇒ its tab is closed,
// remote is off, or its push loop is throttled. Drives the header chip AND freezes the lyric
// clock (a clock with no host behind it is a clock that lies).
const hostLive = () => !!(state && state.ts && (Date.now() / 1000 - state.ts) < 6);
// After a fresh poll, drop any optimistic override the host has now caught up to (instant handoff).
function reconcile() {
  const s = (state && state.settings) || {}, now = state && state.now, q = (state && state.queue) || [];
  for (const k of Object.keys(opt)) {
    if (!optActive(k)) { delete opt[k]; continue; }
    if (k === "position") continue;                    // rides the hold; interpolation stays continuous
    if (k.startsWith("set:")) { if (s[k.slice(4)] === opt[k].v) delete opt[k]; }
    else if (k === "paused") { if (now && now.paused === opt[k].v) delete opt[k]; }
    else if (k === "now") { if (now && opt[k].v && now.id === opt[k].v.id) delete opt[k]; }
    else if (k === "queue") {
      const ids = (a) => a.map((x) => x.id).join("");
      if (ids(q) === ids(opt[k].v)) delete opt[k];
    }
  }
}

// ---------------------------------------------------------------------------
// Tabs
// ---------------------------------------------------------------------------
// Reactions — the crowd noise. Allowlisted here AND on the host (which is what actually
// renders them), because a stranger's phone should never be able to put arbitrary text on
// someone's television.
const REACTIONS = ["👏", "🎉", "🔥", "❤️", "😂", "🙌"];
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
      b.classList.add("sent");                                  // local confirmation; the relay is ~1 s
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
  // Lyrics are loaded + animated ONLY while their tab is on screen (no wasted fetch/rAF).
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
    else cmd({ type: "play" });   // nothing loaded → host starts the queue; poll will show it
  };
  $("now-next").onclick = () => {
    const q = effQueue();
    if (q.length) {                                   // optimistically advance to the next queued song
      const nx = q[0];
      optSet("now", { id: nx.id, name: nx.name, artist: nx.artist, kind: nx.kind, by: nx.by || "", position: 0, duration: 0, paused: false });
      optSet("position", 0);
      optSet("queue", q.slice(1));
      renderNow(); renderQueue(); refreshClock(); refreshLyrics();
    }
    cmd({ type: "next" });
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

// Smooth the seek bar/time between 1-Hz polls by extrapolating the position locally.
function uiTick() {
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
// Tab 2 — Lyrics (rendered on the phone; only the clock comes off the relay)
// ---------------------------------------------------------------------------
// Why local: the relay is a ~1 Hz half-duplex poll, so streaming a per-syllable wipe
// through it is hopeless. Instead the phone fetches + parses the song itself — the same
// parser and the same LyricsEngine the host uses — and drives it from a locally
// free-running clock that each poll disciplines (sync-clock.js). Result: lyric motion is
// frame-accurate on the phone, and the only error left is one-way network latency, which
// the per-device nudge below absorbs.

function wireLyrics() {
  const n = $("l-nudge");
  n.value = prefs.lyricNudgeMs || 0;
  $("l-nudge-val").textContent = `${prefs.lyricNudgeMs || 0} ms`;
  // Apply live while dragging (you're nudging against what you see), persist on release.
  n.oninput = () => { prefs.lyricNudgeMs = +n.value || 0; $("l-nudge-val").textContent = `${prefs.lyricNudgeMs} ms`; };
  n.onchange = () => savePrefs();
}

// Fold the newest host snapshot into the local clock (called on every fresh poll AND right
// after an optimistic transport action, so the lyrics react on the same tick as the button).
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

// Start/stop the render loop to match the tab's visibility.
function syncLyricLoop() {
  if (lyricsTabLive()) {
    if (!lyricRaf) lyricRaf = requestAnimationFrame(lyricFrame);
  } else if (lyricRaf) {
    cancelAnimationFrame(lyricRaf);
    lyricRaf = 0;
  }
}

function lyricFrame() {
  lyricRaf = lyricsTabLive() ? requestAnimationFrame(lyricFrame) : 0;
  if (!lyricsEngine || !clock) return;
  // FREEZE rather than free-run once the host has gone quiet (tab closed, server restarted,
  // or a backgrounded host whose push loop got throttled). Extrapolating against a host that
  // may not even be playing is worse than holding — and the header already says "waiting for
  // host". `syncClock` snaps back the moment real snapshots resume.
  if (!hostLive()) return;
  lyricsEngine.update(clockTime(clock, performance.now()) + lyricOffsetSec());
}

// Load (or reload) the lyrics for whatever is playing now. No-ops unless the tab is on
// screen, so a guest who never opens it never downloads a song file.
async function refreshLyrics() {
  if (!lyricsTabLive()) return;
  if (!lyricsEngine) lyricsEngine = new LyricsEngine($("l-lyrics"), { lineCount: prefs.lyricLines, smooth: true, mergeLines: 1 });
  const now = effNow();
  const id = now ? now.id : "";
  if (id === lyricSongId) return;          // same song → nothing to do (the rAF loop has it)
  lyricSongId = id;
  const token = ++lyricToken;
  lyricsEngine.clear();
  setLyricHead(now, id ? "loading lyrics…" : "");
  if (!id) return;
  try {
    const r = await lyricsFor(now);
    if (token !== lyricToken) return;      // the song moved on while we were fetching
    if (r.baked) { setLyricHead(now, `lyrics are part of the ${now.kind === "youtube" ? "video" : "picture"}`); return; }
    setLyricHead(now, lyricsEngine.loadLines(r.lines) ? "" : "instrumental — no lyrics in this file");
  } catch (e) {
    if (token !== lyricToken) return;
    lyricSongId = null;                    // let the next poll retry
    setLyricHead(now, `couldn't load lyrics — ${e.message}`);
  }
}

function setLyricHead(now, note) {
  $("l-title").textContent = now ? (now.name || "(untitled)") : "Nothing playing";
  $("l-state").textContent = note || (now && now.artist) || "";
}

// Resolve one song's lyric lines, cached per id (tab-switching mustn't refetch).
async function lyricsFor(now) {
  const hit = lyricCache.get(now.id);
  if (hit) return hit;
  // VIDEO / YouTube bake their lyrics into the picture — there is nothing to parse.
  if (now.kind === "video" || now.kind === "youtube") return cacheLyrics(now.id, { baked: true });

  const song = catalog.getById(now.id);
  if (!song) throw new Error("not in this phone's songbook");

  if (song.kind === "audio") {             // recorded audio + a sidecar lyric file
    const url = Catalog.lyricsUrl(song);
    if (!url) return cacheLyrics(now.id, { lines: [] });
    const ext = (song.lyrics.split(".").pop() || "").toLowerCase();
    if (ext === "kar" || ext === "mid" || ext === "midi") {
      return cacheLyrics(now.id, { lines: await linesFromMidiUrl(url) });
    }
    const res = await fetch(url);
    if (!res.ok) throw new Error(`sidecar ${res.status}`);
    const { lines, synced } = linesFromLyricFile(ext, await res.text());
    if (!synced) distributeLineTimes(lines, now.duration);  // plain .txt → pace it across the song
    return cacheLyrics(now.id, { lines, unsynced: !synced });
  }
  return cacheLyrics(now.id, { lines: await linesFromMidiUrl(Catalog.fileUrl(song)) });
}

function cacheLyrics(id, entry) {
  if (lyricCache.size > 40) lyricCache.clear();   // a party's worth; keeps the phone's memory flat
  // An unsynced .txt was paced against THIS song's duration — safe to cache, same song.
  lyricCache.set(id, entry);
  return entry;
}

// Fetch a MIDI/KAR file and pull its timed lines out (same path the host takes).
async function linesFromMidiUrl(url) {
  if (!url) throw new Error("no file");
  const res = await fetch(url);
  if (!res.ok) throw new Error(`song ${res.status}`);
  const parsed = parseMidi(await toMidiBytes(await res.arrayBuffer()));
  return buildLines(parsed.lyricEvents, makeTickToSeconds(parsed));
}

// Song files are raw-DEFLATE compressed (§5.2). pako is ~46 KB, so it is injected LAZILY —
// a guest who only ever uses the transport never pays for it.
let pakoLoad = null;
function ensurePako() {
  if (window.pako) return Promise.resolve(window.pako);
  if (!pakoLoad) {
    pakoLoad = new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = "./vendor/pako.min.js";
      s.onload = () => (window.pako ? resolve(window.pako) : reject(new Error("pako missing")));
      s.onerror = () => { pakoLoad = null; reject(new Error("pako failed to load")); };
      document.head.appendChild(s);
    });
  }
  return pakoLoad;
}

async function toMidiBytes(buf) {
  const u8 = new Uint8Array(buf);
  if (u8[0] === 0x4d && u8[1] === 0x54 && u8[2] === 0x68 && u8[3] === 0x64) return buf; // "MThd"
  const pako = await ensurePako();
  const out = pako.inflateRaw(u8);
  return out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength);
}

// ---------------------------------------------------------------------------
// Tab 3 — Search  (local Catalog + optional YouTube)
// ---------------------------------------------------------------------------
function wireSearch() {
  const input = $("r-search");
  let deb;
  input.oninput = () => { clearTimeout(deb); deb = setTimeout(() => runSearch(input.value), 150); };
  $("r-yt").onclick = () => { ytOn = !ytOn; $("r-yt").classList.toggle("on", ytOn); runSearch(input.value); };
}

async function runSearch(q) {
  q = (q || "").trim();
  const hint = $("r-search-hint");
  if (!q) { $("r-results").innerHTML = ""; hint.style.display = ""; hint.textContent = "Type to search the songbook."; return; }
  hint.style.display = "none";
  const local = catalog.search(q, 150);
  renderResults(local);
  if (ytOn) {
    try {
      const res = await fetch("/api/youtube-search", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ q: `${q} karaoke` }),
      });
      const d = await res.json();
      if ($("r-search").value.trim() !== q) return;   // query moved on
      const yt = ((d && d.items) || []).map((it) => Catalog.makeYoutubeRecord(it)).filter(Boolean);
      renderResults(local.concat(yt));
    } catch (_) {}
  }
}

function renderResults(songs) {
  const ul = $("r-results");
  ul.innerHTML = "";
  for (const s of songs) ul.appendChild(songRow(s));
  if (!songs.length) { $("r-search-hint").style.display = ""; $("r-search-hint").textContent = "No matches."; }
}

function songRow(s) {
  const li = document.createElement("li");
  li.className = "song";
  const icon = document.createElement("span"); icon.className = "kind"; icon.textContent = KIND_ICON[s.kind] || "🎵";
  const meta = document.createElement("div"); meta.className = "meta";
  const t = document.createElement("div"); t.className = "t"; t.textContent = s.name || "(untitled)";
  const a = document.createElement("div"); a.className = "a"; a.textContent = s.artistName || "";
  meta.append(t, a);
  const add = document.createElement("button"); add.className = "add"; add.textContent = "＋"; add.title = "Add to queue";
  add.onclick = () => {
    // optimistically append to the queue (mirror shape: id/name/artist/kind/code/by) so the Queue tab updates now
    optSet("queue", [...effQueue(), { id: s.id, name: s.name, artist: s.artistName || "", kind: s.kind, code: s.code || "", by: prefs.nickname || "" }]);
    renderQueue();
    cmd({ type: "enqueue", id: s.id, name: s.name, artist: s.artistName || "",
          kind: s.kind, code: s.code || "", videoId: s.videoId || "" });
    add.textContent = "✓"; add.classList.add("done");
    setTimeout(() => { add.textContent = "＋"; add.classList.remove("done"); }, 900);
  };
  li.append(icon, meta, add);
  return li;
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
  q.forEach((s, i) => ul.appendChild(queueRow(s, i, q.length, formatEta(queueEta(remaining, durations, i)))));
}

function queueRow(s, i, n, eta) {
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
  // can be up to ~2 s behind the host, so by the time the command lands the index may point at
  // a different song (auto-advance, or another guest acting first). The host verifies the id
  // and ignores the command rather than mutating the wrong row.
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
  if (disabled) b.disabled = true;
  return b;
}

// ---------------------------------------------------------------------------
// Tab 5 — You (nickname, lyric offset, device prefs, connection + room)
// ---------------------------------------------------------------------------
function wireSettings() {
  $("s-nick").oninput = (e) => { prefs.nickname = e.target.value.slice(0, 24); savePrefs(); };
  $("s-theme").onchange = (e) => { prefs.theme = e.target.value; document.documentElement.dataset.theme = prefs.theme; savePrefs(); };
  $("s-text").onchange = (e) => { prefs.text = e.target.value; document.documentElement.dataset.text = prefs.text; savePrefs(); };
  // Lyric display (this phone only) — apply live while dragging, persist on release.
  $("s-lines").oninput = (e) => { prefs.lyricLines = +e.target.value; applyLyricDisplay(); };
  $("s-lines").onchange = () => savePrefs();
  $("s-lyricsize").oninput = (e) => { prefs.lyricScale = +e.target.value / 100; applyLyricDisplay(); };
  $("s-lyricsize").onchange = () => savePrefs();
  $("s-offset").onchange = (e) => {
    const v = +e.target.value;
    optSet("set:lyrics.offsetMs", v); renderSettingsMirror();
    cmd({ type: "setting", path: "lyrics.offsetMs", value: v });
  };
  $("s-reconnect").onclick = () => { lastRev = -1; poll(); };
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
// Connection status
// ---------------------------------------------------------------------------
function renderConn() {
  const reachable = performance.now() - lastOk < 4000;
  let label, cls;
  if (!reachable) { label = "offline"; cls = "bad"; }
  else if (!hostLive()) { label = "waiting for host"; cls = "warn"; }
  else { label = "connected"; cls = "ok"; }
  $("conn").className = `conn ${cls}`;
  $("conn-label").textContent = label;
  const st = $("s-status"); if (st) st.textContent = label;
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

boot();
