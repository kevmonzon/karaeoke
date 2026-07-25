/*
 * remote.js — the phone remote-control page (served at /remote; shell = src/remote.html).
 *
 * A guest's browser on the same network. It has NO synth and NO local player: it reuses
 * the tested Catalog (catalog.js) to search the songbook locally, reads the host's live
 * state from serve.py's relay (GET /api/remote/state), and sends intents back
 * (POST /api/remote/command). The HOST stays the authoritative player — see
 * src/js/remote-host.js and §5.x in CLAUDE.md. Four tabs: Now / Search / Queue / You.
 *
 * Free-for-all (no auth): anyone who can open this page can queue and control playback.
 */
import { Catalog } from "./catalog.js";

const $ = (id) => document.getElementById(id);
const KIND_ICON = { midi: "🎤", video: "🎞️", youtube: "🌐" };
const PREFS_KEY = "karaeoke.remote.v1";

// --- device-local state (persisted on the phone) ---------------------------
let prefs = { nickname: "", theme: "dark", text: "m" };
// --- live host state -------------------------------------------------------
let catalog = new Catalog();
let state = null;        // last host snapshot {rev, ts, now, queue, settings}
let lastRev = -1;
let stamp = 0;           // performance.now() when `state` arrived (for progress interpolation)
let lastOk = 0;          // last successful poll time (connection health)
let ytOn = false;        // include YouTube results in search
let seeking = false;     // true while the user drags the seek slider (don't fight them)

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

  $("s-origin").textContent = location.origin;
  try { await catalog.load(); } catch (_) { /* songbook optional for control-only use */ }

  document.addEventListener("visibilitychange", () => { if (!document.hidden) poll(); });
  poll();
  setInterval(poll, 1000);   // pull host state
  setInterval(uiTick, 250);  // smooth the now-playing progress between polls
}

// ---------------------------------------------------------------------------
// Prefs (nickname + device-local look)
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
// Relay I/O
// ---------------------------------------------------------------------------
async function poll() {
  try {
    const res = await fetch(`/api/remote/state?since=${Math.max(0, lastRev)}`);
    const d = await res.json();
    lastOk = performance.now();
    if (d && d.ok && !d.unchanged) {
      state = d; lastRev = d.rev; stamp = performance.now();
      renderNow(); renderQueue(); renderSettingsMirror();
    }
  } catch (_) { /* host/server unreachable — the status dot will reflect it */ }
  renderConn();
}

// Send an intent to the host. Always carries the guest nickname.
function cmd(obj) {
  try {
    fetch("/api/remote/command", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...obj, by: prefs.nickname || "" }),
    }).then(() => poll()).catch(() => {});
  } catch (_) {}
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
// Tab 1 — Now Playing
// ---------------------------------------------------------------------------
function wireNow() {
  $("now-playpause").onclick = () => {
    const now = state && state.now;
    if (now && !now.paused) cmd({ type: "pause" });
    else cmd({ type: "play" });   // resumes, or (host-side) starts the queue if nothing is loaded
  };
  $("now-next").onclick = () => cmd({ type: "next" });
  const seek = $("now-seek");
  seek.oninput = () => { seeking = true; };
  seek.onchange = () => {
    seeking = false;
    const now = state && state.now;
    if (now && now.duration > 0) cmd({ type: "seek", position: (seek.value / 1000) * now.duration });
  };
  $("now-vol").onchange = (e) => cmd({ type: "volume", value: +e.target.value / 100 });
}

function renderNow() {
  const now = state && state.now;
  $("now-kind").textContent = now ? (KIND_ICON[now.kind] || "🎵") : "🎤";
  $("now-title").textContent = now ? (now.name || "(untitled)") : "Nothing playing";
  $("now-artist").textContent = now ? (now.artist || "") : "";
  $("now-playpause").textContent = now && !now.paused ? "❚❚" : "▶";
  if (state && state.settings && document.activeElement !== $("now-vol")) {
    $("now-vol").value = Math.round((state.settings["audio.volume"] ?? 0.9) * 100);
  }
  uiTick();
}

// Smooth the seek bar/time between 1-Hz polls by extrapolating the position locally.
function uiTick() {
  const now = state && state.now;
  const seek = $("now-seek");
  if (!now || !(now.duration > 0)) {
    if (!seeking) seek.value = 0;
    $("now-cur").textContent = "0:00"; $("now-dur").textContent = "0:00";
    return;
  }
  let pos = now.position;
  if (!now.paused) pos += (performance.now() - stamp) / 1000;
  pos = Math.max(0, Math.min(now.duration, pos));
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
  const now = state && state.now;
  $("q-now").innerHTML = "";
  if (now) {
    const d = document.createElement("div"); d.className = "q-now-card";
    d.innerHTML = `<span class="np">NOW</span> <span class="kind">${KIND_ICON[now.kind] || "🎵"}</span>
      <span class="t">${esc(now.name || "(untitled)")}</span> <span class="a">${esc(now.artist || "")}</span>`;
    $("q-now").appendChild(d);
  }
  const ul = $("r-queue");
  ul.innerHTML = "";
  const q = (state && state.queue) || [];
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
  const up = mkBtn("↑", "Move up", () => cmd({ type: "reorder", from: i, to: i - 1 }), i === 0);
  const dn = mkBtn("↓", "Move down", () => cmd({ type: "reorder", from: i, to: i + 1 }), i === n - 1);
  const rm = mkBtn("✕", "Remove", () => cmd({ type: "remove", index: i }));
  rm.classList.add("rm");
  ctr.append(up, dn, rm);
  li.append(meta, ctr);
  return li;
}
function mkBtn(label, title, onClick, disabled) {
  const b = document.createElement("button");
  b.textContent = label; b.title = title; b.onclick = onClick;
  if (disabled) b.disabled = true;
  return b;
}

// ---------------------------------------------------------------------------
// Tab 4 — You (nickname, room controls mirror, device prefs, connection)
// ---------------------------------------------------------------------------
function wireSettings() {
  $("s-nick").oninput = (e) => { prefs.nickname = e.target.value.slice(0, 24); savePrefs(); };
  $("s-theme").onchange = (e) => { prefs.theme = e.target.value; document.documentElement.dataset.theme = prefs.theme; savePrefs(); };
  $("s-text").onchange = (e) => { prefs.text = e.target.value; document.documentElement.dataset.text = prefs.text; savePrefs(); };

  // Room controls → host `setting` (and `volume`) commands.
  $("s-offset").onchange = (e) => cmd({ type: "setting", path: "lyrics.offsetMs", value: +e.target.value });
  $("s-tempo").onchange = (e) => cmd({ type: "setting", path: "audio.tempo", value: +e.target.value });
  $("s-vol").onchange = (e) => cmd({ type: "volume", value: +e.target.value / 100 });
  $("s-mic").onchange = (e) => cmd({ type: "setting", path: "mic.enabled", value: e.target.checked });
  $("s-bgv").onchange = (e) => cmd({ type: "setting", path: "bgv.enabled", value: e.target.checked });
  $("s-key-down").onclick = () => stepKey(-1);
  $("s-key-up").onclick = () => stepKey(1);

  $("s-reconnect").onclick = () => { lastRev = -1; poll(); };
}
function stepKey(delta) {
  const cur = (state && state.settings && state.settings["audio.key"]) || 0;
  const next = Math.max(-12, Math.min(12, cur + delta));
  $("s-key-val").textContent = fmtKey(next);
  cmd({ type: "setting", path: "audio.key", value: next });
}

// Reflect the host's mirrored settings into the room controls — but never overwrite a
// control the guest is actively touching.
function renderSettingsMirror() {
  const s = (state && state.settings) || {};
  const active = document.activeElement;
  if (active !== $("s-offset")) { $("s-offset").value = s["lyrics.offsetMs"] ?? 0; }
  $("s-offset-val").textContent = `${s["lyrics.offsetMs"] ?? 0} ms`;
  if (active !== $("s-tempo")) { $("s-tempo").value = s["audio.tempo"] ?? 1; }
  $("s-tempo-val").textContent = `${(+(s["audio.tempo"] ?? 1)).toFixed(2)}×`;
  if (active !== $("s-vol")) { $("s-vol").value = Math.round((s["audio.volume"] ?? 0.9) * 100); }
  $("s-vol-val").textContent = `${Math.round((s["audio.volume"] ?? 0.9) * 100)}%`;
  $("s-key-val").textContent = fmtKey(s["audio.key"] ?? 0);
  if (active !== $("s-mic")) $("s-mic").checked = !!s["mic.enabled"];
  if (active !== $("s-bgv")) $("s-bgv").checked = s["bgv.enabled"] !== false;
}

// ---------------------------------------------------------------------------
// Connection status
// ---------------------------------------------------------------------------
function renderConn() {
  const reachable = performance.now() - lastOk < 4000;
  // The host bumps `ts` every ~1s while it's syncing; stale ts ⇒ host tab closed or remote off.
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
