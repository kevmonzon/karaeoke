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
 * the guest types the code shown on the karaoke screen. Four tabs: Now / Search / Queue / You.
 */
import { Catalog } from "./catalog.js";

const $ = (id) => document.getElementById(id);
const KIND_ICON = { midi: "🎤", video: "🎞️", youtube: "🌐" };
const PREFS_KEY = "karaeoke.remote.v1";

// --- device-local state (persisted on the phone) ---------------------------
let prefs = { nickname: "", theme: "dark", text: "m", room: "" };
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

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
async function boot() {
  loadPrefs();
  applyPrefs();
  wireTabs();
  wireNow();
  wireSearch();
  wireSettings();
  wireGate();

  $("s-origin").textContent = location.origin;
  try { await catalog.load(); } catch (_) { /* songbook optional for control-only use */ }

  document.addEventListener("visibilitychange", () => { if (!document.hidden && room) poll(); });

  // A room code from the scanned QR (?room=) wins; else the last room we used. Validate it
  // against a live host room before entering; otherwise show the gate.
  const urlRoom = normRoom(new URLSearchParams(location.search).get("room"));
  const candidate = urlRoom || normRoom(prefs.room);
  if (candidate && await roomIsLive(candidate)) enterRoom(candidate);
  else { $("gate-code").value = candidate; showGate(candidate ? "That code isn't active right now." : ""); }
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
  if (!pollTimer) {
    pollTimer = setInterval(poll, 1000);   // pull host state
    setInterval(uiTick, 250);              // smooth now-playing progress between polls
  }
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
}

// ---------------------------------------------------------------------------
// Relay I/O (all scoped to the room)
// ---------------------------------------------------------------------------
async function poll() {
  if (!room) return;
  try {
    const res = await fetch(`/api/remote/state?room=${room}&since=${Math.max(0, lastRev)}`);
    const d = await res.json();
    lastOk = performance.now();
    if (d && d.error === "no-room") {
      // The host stopped pushing (tab closed / server restart) — stay on the code and keep
      // polling; the room resumes when the host comes back. renderConn shows "waiting".
      state = null; renderNow(); renderQueue();
    } else if (d && d.ok && !d.unchanged) {
      state = d; lastRev = d.rev; stamp = performance.now();
      reconcile(); // drop optimistic overrides the host has now caught up to
      renderNow(); renderQueue(); renderSettingsMirror();
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
function effPos(now) {                                  // interpolated position (from the optimistic seek base if held)
  const seek = optActive("position");
  const base = seek ? opt["position"].v : now.position;
  const from = seek ? opt["position"].t : stamp;
  return now.paused ? base : base + (performance.now() - from) / 1000;
}
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
function wireTabs() {
  for (const btn of document.querySelectorAll(".tabbar .tab")) {
    btn.onclick = () => showTab(btn.dataset.tab);
  }
}
function showTab(name) {
  for (const p of document.querySelectorAll(".panel")) p.classList.toggle("active", p.id === `tab-${name}`);
  for (const b of document.querySelectorAll(".tabbar .tab")) b.classList.toggle("active", b.dataset.tab === name);
  if (name === "search") $("r-search").focus();
}

// ---------------------------------------------------------------------------
// Tab 1 — Now Playing (transport + key / tempo / volume)
// ---------------------------------------------------------------------------
function wireNow() {
  $("now-playpause").onclick = () => {
    const now = effNow();
    if (now) { optSet("paused", !now.paused); cmd({ type: now.paused ? "play" : "pause" }); renderNow(); }
    else cmd({ type: "play" });   // nothing loaded → host starts the queue; poll will show it
  };
  $("now-next").onclick = () => {
    const q = effQueue();
    if (q.length) {                                   // optimistically advance to the next queued song
      const nx = q[0];
      optSet("now", { id: nx.id, name: nx.name, artist: nx.artist, kind: nx.kind, by: nx.by || "", position: 0, duration: 0, paused: false });
      optSet("position", 0);
      optSet("queue", q.slice(1));
      renderNow(); renderQueue();
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
      optSet("position", pos); uiTick();
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
// Tab 2 — Search  (local Catalog + optional YouTube)
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
// Tab 3 — Queue
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
  q.forEach((s, i) => ul.appendChild(queueRow(s, i, q.length)));
}

function queueRow(s, i, n) {
  const li = document.createElement("li");
  li.className = "qrow";
  const meta = document.createElement("div"); meta.className = "meta";
  const t = document.createElement("div"); t.className = "t";
  t.innerHTML = `<span class="kind">${KIND_ICON[s.kind] || "🎵"}</span> ${esc(s.name || "(untitled)")}`;
  const a = document.createElement("div"); a.className = "a";
  a.textContent = s.artist || "";
  if (s.by) { const b = document.createElement("span"); b.className = "by"; b.textContent = ` · ${s.by}`; a.appendChild(b); }
  meta.append(t, a);
  const ctr = document.createElement("div"); ctr.className = "qctl";
  const up = mkBtn("↑", "Move up", () => { reorderOpt(i, i - 1); cmd({ type: "reorder", from: i, to: i - 1 }); }, i === 0);
  const dn = mkBtn("↓", "Move down", () => { reorderOpt(i, i + 1); cmd({ type: "reorder", from: i, to: i + 1 }); }, i === n - 1);
  const rm = mkBtn("✕", "Remove", () => {
    optSet("queue", effQueue().filter((_, idx) => idx !== i)); renderQueue();
    cmd({ type: "remove", index: i });
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
// Tab 4 — You (nickname, lyric offset, device prefs, connection + room)
// ---------------------------------------------------------------------------
function wireSettings() {
  $("s-nick").oninput = (e) => { prefs.nickname = e.target.value.slice(0, 24); savePrefs(); };
  $("s-theme").onchange = (e) => { prefs.theme = e.target.value; document.documentElement.dataset.theme = prefs.theme; savePrefs(); };
  $("s-text").onchange = (e) => { prefs.text = e.target.value; document.documentElement.dataset.text = prefs.text; savePrefs(); };
  $("s-offset").onchange = (e) => {
    const v = +e.target.value;
    optSet("set:lyrics.offsetMs", v); renderSettingsMirror();
    cmd({ type: "setting", path: "lyrics.offsetMs", value: v });
  };
  $("s-reconnect").onclick = () => { lastRev = -1; poll(); };
  $("s-leave").onclick = () => { prefs.room = ""; savePrefs(); $("gate-code").value = ""; showGate(""); };
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
  // The host bumps `ts` every ~1s while it's syncing; stale/absent ts ⇒ host tab closed or remote off.
  const hostLive = state && state.ts && (Date.now() / 1000 - state.ts) < 6;
  let label, cls;
  if (!reachable) { label = "offline"; cls = "bad"; }
  else if (!hostLive) { label = "waiting for host"; cls = "warn"; }
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
