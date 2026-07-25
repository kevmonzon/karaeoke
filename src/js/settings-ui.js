/*
 * settings-ui.js — the ⚙ settings drawer, driven by a single control SCHEMA.
 *
 * Each panel control is described ONCE in SETTINGS_SCHEMA (its element id, the
 * settings path, its type, and — for ranges — a label formatter). That one entry
 * drives both directions:
 *   - autoBind()  attaches the change/input listener → settings.set (+ label)
 *   - autoSync()  pushes the stored value back onto the control (+ label)
 * So adding a setting is: config.js default + index.html control + one schema row
 * (+ optionally a branch in the player's onSettingChanged for its side effect).
 *
 * The mic-enable and rebuild-catalog buttons are actions, not settings, so they're
 * wired by hand in wireSettings(). What a setting change *does* still lives in the
 * player's onSettingChanged (Settings calls it on every change).
 */

const $ = (id) => document.getElementById(id);
const pct = (v) => `${Math.round(v * 100)}%`;

// type: "range" (number) · "check" (boolean) · "select"/"text" (string)
// valId: label element id (defaults to `${id}-val`) · fmt: label text for ranges
const SETTINGS_SCHEMA = [
  // display size / profile
  { id: "set-screen", path: "ui.screen", type: "select" },
  // lyrics
  { id: "set-offset", path: "lyrics.offsetMs", type: "range", fmt: (v) => `${v} ms` },
  { id: "set-bt", path: "bt.enabled", type: "check" },
  { id: "set-smooth", path: "lyrics.smooth", type: "check" },
  { id: "set-lines", path: "lyrics.lineCount", type: "range", fmt: (v) => `${v}` },
  { id: "set-merge", path: "lyrics.mergeLines", type: "range", fmt: (v) => `${v}` },
  { id: "set-width", path: "lyrics.lineWidthPct", type: "range", fmt: (v) => `${v}%` },
  { id: "set-font", path: "lyrics.fontScale", type: "range", fmt: (v) => `${(+v).toFixed(2)}×` },
  { id: "set-tc", path: "titleCard.seconds", type: "range", fmt: (v) => `${(+v).toFixed(1)} s` },
  // background video
  { id: "set-bgv", path: "bgv.enabled", type: "check" },
  { id: "set-bgv-op", path: "bgv.opacity", type: "range", fmt: pct },
  { id: "set-bgv-perssong", path: "bgv.changePerSong", type: "check" },
  // midi mode (channel mixer band)
  { id: "set-midimode", path: "midiMode.enabled", type: "check" },
  // key detection
  { id: "set-key-auto", path: "key.autoDetect", type: "check" },
  { id: "set-key-badge", path: "key.showBadge", type: "check" },
  // chords
  { id: "set-chords", path: "chords.enabled", type: "check" },
  { id: "set-chords-simplify", path: "chords.simplify", type: "check" },
  // pitch guide
  { id: "set-guide", path: "guide.enabled", type: "check" },
  { id: "set-guide-win", path: "guide.windowSec", type: "range", fmt: (v) => `${(+v).toFixed(1)} s` },
  { id: "set-guide-h", path: "guide.height", type: "range", fmt: (v) => `${v} px` },
  { id: "set-guide-ch", path: "guide.channel", type: "range", fmt: (v) => (v < 0 ? "auto" : `${+v + 1}`) },
  { id: "set-guide-mic", path: "guide.showMic", type: "check" },
  { id: "set-guide-trail", path: "guide.trail", type: "check" },
  { id: "set-guide-score", path: "guide.scoring", type: "check" },
  { id: "set-gv-vol", path: "guide.vocal.volume", type: "range", fmt: pct },
  { id: "set-gv-mute", path: "guide.vocal.mute", type: "check" },
  { id: "set-gv-solo", path: "guide.vocal.solo", type: "check" },
  // microphone
  { id: "set-mic-vol", path: "mic.volume", type: "range", fmt: pct },
  { id: "set-mic-aec", path: "mic.echoCancellation", type: "check" },
  { id: "set-mic-ns", path: "mic.noiseSuppression", type: "check" },
  { id: "set-mic-agc", path: "mic.autoGainControl", type: "check" },
  { id: "set-mic-hp", path: "mic.highpass", type: "check" },
  { id: "set-mic-gate", path: "mic.gate", type: "check" },
  { id: "set-mic-gate-th", path: "mic.gateThresholdDb", type: "range", valId: "set-mic-gate-val", fmt: (v) => `${v} dB` },
  { id: "set-mic-echo", path: "mic.echo.enabled", type: "check" },
  { id: "set-mic-echo-mix", path: "mic.echo.mix", type: "range", valId: "set-mic-echo-val", fmt: pct },
  { id: "set-mic-reverb", path: "mic.reverb.enabled", type: "check" },
  { id: "set-mic-reverb-mix", path: "mic.reverb.mix", type: "range", valId: "set-mic-reverb-val", fmt: pct },
  { id: "set-mic-chorus", path: "mic.chorus.enabled", type: "check" },
  { id: "set-mic-chorus-mix", path: "mic.chorus.mix", type: "range", valId: "set-mic-chorus-val", fmt: pct },
  { id: "set-mic-pitch", path: "mic.pitch.enabled", type: "check" },
  { id: "set-mic-pitch-semi", path: "mic.pitch.semitones", type: "range", valId: "set-mic-pitch-val", fmt: (v) => `${v > 0 ? "+" : ""}${v} st` },
  { id: "set-autotune", path: "mic.autotune.enabled", type: "check" },
  { id: "set-autotune-str", path: "mic.autotune.strength", type: "range", fmt: pct },
  { id: "set-autotune-mode", path: "mic.autotune.mode", type: "select" },
  { id: "set-autotune-key", path: "mic.autotune.key", type: "select" }, // keeps "auto" or "0".."11"
  { id: "set-autotune-scale", path: "mic.autotune.scale", type: "select" },
  // youtube search (BYOC) — also toggled by the 🌐 search-row pill
  { id: "set-youtube", path: "youtube.enabled", type: "check" },
  // 11 = the slider max = "always" (query YouTube regardless of local hit count) — see app.js scheduleYoutubeSearch
  { id: "set-youtube-threshold", path: "youtube.autoThreshold", type: "range", fmt: (v) => (+v >= 11 ? "always" : `< ${v} local hits`) },
  { id: "set-youtube-debounce", path: "youtube.debounceMs", type: "range", fmt: (v) => `${(+v / 1000).toFixed(1)} s` },
  { id: "set-youtube-max", path: "youtube.maxResults", type: "range", fmt: (v) => `${v}` },
  { id: "set-youtube-keyword", path: "youtube.keyword", type: "text" },
  // remote control (phones) — QR on the queue panel opens /remote
  { id: "set-remote", path: "remote.enabled", type: "check" },
  { id: "set-remote-url", path: "remote.baseUrl", type: "text" },
];

// Synonyms so intuitive words find a control whose visible label doesn't contain
// them. Keyed by the control's (or action button's) element id. Optional sugar —
// a control without an entry is still searchable by its label + section titles.
const SEARCH_KEYWORDS = {
  "set-screen": "tv television display size screen distance responsive scale zoom big large",
  "set-offset": "latency delay sync timing",
  "set-bt": "bluetooth latency",
  "set-tc": "title card intro",
  "set-bgv": "background wallpaper backdrop",
  "set-midimode": "channel mixer volume mute solo vu levels",
  "set-key-auto": "transpose signature",
  "set-key-badge": "transpose signature",
  "set-chords": "guitar chord lane strum",
  "set-chords-simplify": "guitar chord triad",
  "set-guide": "melody piano roll pitch",
  "set-gv-vol": "melody vocal",
  "set-gv-mute": "melody vocal",
  "set-gv-solo": "melody vocal isolate",
  "set-mic-vol": "microphone gain",
  "set-mic-aec": "feedback echo cancellation howl",
  "set-mic-gate": "noise feedback",
  "set-mic-echo": "effect delay slapback",
  "set-mic-reverb": "effect hall space",
  "set-mic-chorus": "effect thicken",
  "set-mic-pitch": "shift transpose octave",
  "set-autotune": "pitch correction tune snap",
  "set-youtube": "online stream byoc",
  "set-remote": "phone qr code queue guest party mobile control",
  "set-remote-url": "phone qr url tunnel address host",
  "mic-enable": "microphone singing voice",
  "rebuild-catalog": "library refresh scan songs",
};

const CAT_STATE_KEY = "karaeoke.settingsUI.v1"; // transient UI: category open/closed

/**
 * Pure token-AND substring match: every whitespace-separated token in `query`
 * must appear in `text` (case-insensitive). Empty query matches everything.
 * Exported for unit testing.
 */
export function matchesQuery(text, query) {
  const q = (query || "").trim().toLowerCase();
  if (!q) return true;
  const hay = (text || "").toLowerCase();
  return q.split(/\s+/).every((tok) => hay.includes(tok));
}

/**
 * @param {object} deps
 * @param {object} deps.settings   the Settings store
 * @param {object} deps.mic        the MicEngine (enable button + status)
 * @param {()=>Promise<{ok:boolean, records?:number, error?:string}>} deps.onRebuild
 * @returns {{ wireSettings, syncSettingsUI, updateMicBtn }}
 */
export function createSettingsUI({ settings, mic, onRebuild }) {
  const label = (c, v) => {
    if (c.type !== "range" || !c.fmt) return;
    const el = $(c.valId || `${c.id}-val`);
    if (el) el.textContent = c.fmt(v);
  };
  const readControl = (c, el) =>
    c.type === "check" ? el.checked : (c.type === "select" || c.type === "text") ? el.value : +el.value;

  function autoBind() {
    for (const c of SETTINGS_SCHEMA) {
      const el = $(c.id);
      if (!el) continue;
      const evt = (c.type === "check" || c.type === "select" || c.type === "text") ? "change" : "input";
      el.addEventListener(evt, () => {
        const val = readControl(c, el);
        settings.set(c.path, val);
        label(c, val);
      });
    }
  }

  function autoSync() {
    for (const c of SETTINGS_SCHEMA) {
      const el = $(c.id);
      if (!el) continue;
      const val = settings.get(c.path);
      if (c.type === "check") el.checked = val;
      else if (c.type === "select" || c.type === "text") el.value = String(val);
      else { el.value = val; label(c, val); }
    }
  }

  // --- searchable / collapsible settings ---
  const LEAF_SEL = ".row, #mic-enable, #rebuild-catalog"; // matchable controls + action buttons
  let searchIndex = null;

  function buildSearchIndex() {
    const root = document.querySelector(".settings-body");
    const cats = [...root.querySelectorAll(".set-cat")];
    const leaves = [];
    for (const cat of cats) {
      const catText = cat.querySelector("summary")?.textContent || "";
      for (const sec of cat.querySelectorAll("section")) {
        const secText = sec.querySelector("h4")?.textContent || "";
        for (const el of sec.querySelectorAll(LEAF_SEL)) {
          const ctrl = el.matches(".row") ? el.querySelector("input, select") : el;
          const kw = SEARCH_KEYWORDS[ctrl?.id || el.id] || "";
          leaves.push({ el, sec, cat, text: `${el.textContent} ${secText} ${catText} ${kw}` });
        }
      }
    }
    // pure dividers/descriptions to tuck away while searching (not the no-results line)
    const dividers = [...root.querySelectorAll(".sub-h, .hint")].filter((d) => d.id !== "set-no-results");
    return { root, cats, leaves, dividers };
  }

  const loadCatState = () => {
    try { return JSON.parse(localStorage.getItem(CAT_STATE_KEY)) || {}; } catch { return {}; }
  };
  const restoreCatState = () => {
    const st = loadCatState();
    for (const cat of searchIndex?.cats || []) {
      const v = st[cat.dataset.cat];
      if (typeof v === "boolean") cat.open = v;
    }
  };
  const saveCatState = () => {
    const st = {};
    for (const cat of searchIndex?.cats || []) st[cat.dataset.cat] = cat.open;
    try { localStorage.setItem(CAT_STATE_KEY, JSON.stringify(st)); } catch { /* ignore */ }
  };

  function applyFilter(q) {
    if (!searchIndex) searchIndex = buildSearchIndex();
    const { root, cats, leaves, dividers } = searchIndex;
    const active = q.trim().length > 0;
    $("set-search-clear").classList.toggle("hidden", !active);

    if (!active) {
      for (const { el } of leaves) el.classList.remove("filtered-out");
      for (const d of dividers) d.classList.remove("filtered-out");
      root.querySelectorAll("section").forEach((s) => s.classList.remove("filtered-out"));
      for (const cat of cats) cat.classList.remove("filtered-out");
      restoreCatState();
      $("set-no-results").classList.add("hidden");
      return;
    }

    let anyVisible = false;
    for (const leaf of leaves) {
      const ok = matchesQuery(leaf.text, q);
      leaf.el.classList.toggle("filtered-out", !ok);
      anyVisible = anyVisible || ok;
    }
    for (const d of dividers) d.classList.add("filtered-out");
    root.querySelectorAll("section").forEach((sec) => {
      const has = [...sec.querySelectorAll(LEAF_SEL)].some((el) => !el.classList.contains("filtered-out"));
      sec.classList.toggle("filtered-out", !has);
    });
    for (const cat of cats) {
      const has = [...cat.querySelectorAll("section")].some((s) => !s.classList.contains("filtered-out"));
      cat.classList.toggle("filtered-out", !has);
      if (has) cat.open = true; // force-open categories with hits (don't persist — see toggle guard)
    }
    $("set-no-results").classList.toggle("hidden", anyVisible);
  }

  function wireSearch() {
    searchIndex = buildSearchIndex();
    restoreCatState();
    const input = $("set-search");
    if (!input) return;
    input.addEventListener("input", () => applyFilter(input.value));
    input.addEventListener("keydown", (e) => {
      if (e.key === "Escape") { input.value = ""; applyFilter(""); e.stopPropagation(); }
    });
    $("set-search-clear").onclick = () => { input.value = ""; applyFilter(""); input.focus(); };
    // persist manual open/close, but not the force-opens that happen mid-search
    for (const cat of searchIndex.cats) {
      cat.addEventListener("toggle", () => { if (!input.value.trim()) saveCatState(); });
    }
  }

  function updateMicBtn() {
    const btn = $("mic-enable");
    if (!btn) return;
    btn.textContent = mic.enabled ? "🎤 Disable microphone" : "🎤 Enable microphone";
    btn.classList.toggle("on", mic.enabled);
  }

  function wireSettings() {
    $("btn-settings").onclick = () => {
      $("settings-panel").classList.remove("hidden");
      const s = $("set-search");
      if (s) setTimeout(() => s.focus(), 60); // after the slide-in
    };
    $("settings-close").onclick = () => $("settings-panel").classList.add("hidden");

    autoBind();
    wireSearch();

    // --- action buttons (not settings) ---
    $("rebuild-catalog").onclick = async () => {
      const btn = $("rebuild-catalog"), st = $("rebuild-status");
      const orig = btn.textContent;
      btn.disabled = true; btn.textContent = "Rebuilding…"; st.textContent = "";
      try {
        const r = await onRebuild();
        st.textContent = r.ok ? `Rebuilt — ${r.records.toLocaleString()} songs` : "Failed: " + (r.error || "error");
      } catch (e) { st.textContent = "Failed: " + e.message; }
      btn.disabled = false; btn.textContent = orig;
    };

    $("mic-enable").onclick = async () => {
      $("mic-status").textContent = mic.enabled ? "Stopping…" : "Requesting microphone…";
      if (mic.enabled) mic.disable();
      else await mic.enable();
      updateMicBtn();
    };

    $("settings-reset").onclick = () => { settings.reset(); };
  }

  function syncSettingsUI() {
    autoSync();
    updateMicBtn();
    // bottom transport controls (wired in app.js, but reflected here on reset)
    if ($("tempo")) {
      const g = (p) => settings.get(p);
      $("tempo").value = g("audio.tempo");
      $("tempo-val").textContent = `${(+g("audio.tempo")).toFixed(2)}×`;
      $("volume").value = g("audio.volume");
      $("key-val").textContent = (g("audio.key") > 0 ? "+" : "") + g("audio.key");
    }
  }

  return { wireSettings, syncSettingsUI, updateMicBtn };
}
