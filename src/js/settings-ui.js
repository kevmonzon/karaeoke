/*
 * settings-ui.js — the ⚙ settings panel, driven by a single control SCHEMA.
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

import { getCacheStatus } from "./asset-cache.js";
import { melodyLevel, melodyLevelSettings } from "./music-fx.js";
// The dialog's own "why calibration cannot run" (pure), so the button says exactly what it says.
import { calibrateUnavailable } from "./ui/calibrate-ui.js";

const $ = (id) => document.getElementById(id);
const pct = (v) => `${Math.round(v * 100)}%`;
const mb = (bytes) => `${(bytes / 1048576).toFixed(bytes < 10485760 ? 1 : 0)} MB`;
// M10: the music reverb / chorus level (0–4) by name, and an EQ band's gain. A stored value off the
// scale (a hand-edited or imported setting) shows as its number; a missing band shows as 0 dB.
const FX_LEVEL_NAMES = ["Off", "Low", "Normal", "High", "Max"];
const fxLevelLabel = (v) => FX_LEVEL_NAMES[v] ?? `${v}`;
const dbLabel = (v) => { const n = Number(v) || 0; return `${n > 0 ? "+" : ""}${n} dB`; };
const EQ_BAND_COUNT = 10;   // music-fx.js EQ_BANDS (31 Hz … 16 kHz); the rows are in index.html

// type: "range" (number) · "check" (boolean) · "select"/"text" (string)
// valId: label element id (defaults to `${id}-val`) · fmt: label text for ranges
// clean: optional (value) → value applied before the value is stored (and shown back in the control)
const SETTINGS_SCHEMA = [
  // overall font size (extra small/small/medium/large) + color theme
  { id: "set-fontsize", path: "ui.fontSize", type: "select" },
  { id: "set-theme", path: "ui.theme", type: "select" },
  // the stage: TV overscan inset + key hints (keys mode only)
  { id: "set-overscan", path: "ui.overscanPct", type: "range", fmt: (v) => `${+v}%` },
  { id: "set-key-hints", path: "ui.keyHints", type: "check" },
  // lyrics
  { id: "set-offset", path: "lyrics.offsetMs", type: "range", fmt: (v) => `${v} ms` },
  { id: "set-bt", path: "bt.enabled", type: "check" }, // Lyrics → Timing in index.html

  { id: "set-smooth", path: "lyrics.smooth", type: "check" },
  { id: "set-lines", path: "lyrics.lineCount", type: "range", fmt: (v) => `${v}` },
  { id: "set-merge", path: "lyrics.mergeLines", type: "range", fmt: (v) => `${v}` },
  { id: "set-width", path: "lyrics.lineWidthPct", type: "range", fmt: (v) => `${v}%` },
  { id: "set-font", path: "lyrics.fontScale", type: "range", fmt: (v) => `${(+v).toFixed(2)}×` },
  { id: "set-tc", path: "titleCard.seconds", type: "range", fmt: (v) => `${(+v).toFixed(1)} s` },
  // lyric style + the stage style's look (lyrics-stage.js)
  { id: "set-lyric-style", path: "lyrics.style", type: "select" },
  { id: "set-stage-rows", path: "lyrics.stage.rows", type: "select" },
  { id: "set-stage-align", path: "lyrics.stage.align", type: "select" },
  { id: "set-stage-position", path: "lyrics.stage.position", type: "select" },
  { id: "set-stage-anim", path: "lyrics.stage.animation", type: "select" },
  { id: "set-stage-color", path: "lyrics.stage.color", type: "text" },   // <input type=color>: a string, on change
  { id: "set-stage-random", path: "lyrics.stage.randomColor", type: "check" },
  { id: "set-stage-outline", path: "lyrics.stage.outline", type: "range", fmt: (v) => `${(+v).toFixed(1).replace(/\.0$/, "")}` },
  { id: "set-stage-shadow", path: "lyrics.stage.shadow", type: "check" },
  { id: "set-stage-countdown", path: "lyrics.stage.countdown", type: "check" },
  { id: "set-stage-interlude", path: "lyrics.stage.interlude", type: "check" },
  // M11 the background behind the lyrics (plan §5.22). The category's options are the server's
  // folders (setBgCategories, from app.js); the Camera option is disabled on an insecure page.
  { id: "set-bg-mode", path: "bg.mode", type: "select" },
  { id: "set-bg-category", path: "bg.category", type: "select" },
  { id: "set-bg-dim", path: "bg.dim", type: "range", fmt: pct },
  { id: "set-bg-change", path: "bg.changeOnSong", type: "check" },
  { id: "set-bg-interval", path: "bg.photo.intervalSec", type: "range", fmt: (v) => `${+v} s` },
  { id: "set-bg-anim", path: "bg.photo.animation", type: "select" },
  { id: "set-bg-facing", path: "bg.camera.facing", type: "select" },
  { id: "set-bg-mirror", path: "bg.camera.mirror", type: "select" },
  // midi mode (channel mixer band)
  { id: "set-midimode", path: "midiMode.enabled", type: "check" },
  // M10 music sound (plan §5.18–§5.20): drums and the key, the synth's reverb / chorus, the music
  // EQ (ten Custom bands, shown only while the preset is Custom) and evening out song loudness
  { id: "set-transpose-drums", path: "audio.transposeDrums", type: "check" },
  { id: "set-music-reverb", path: "audio.reverb", type: "range", fmt: fxLevelLabel },
  { id: "set-music-chorus", path: "audio.chorus", type: "range", fmt: fxLevelLabel },
  { id: "set-eq-preset", path: "audio.eq.preset", type: "select" },
  // One row per band, each a nested array path: settings.set("audio.eq.gains.3", v) writes index 3
  // of the stored array in place (settings.js walks the dot path into arrays as it does objects).
  ...Array.from({ length: EQ_BAND_COUNT }, (_, i) => ({ id: `set-eq-${i}`, path: `audio.eq.gains.${i}`, type: "range", fmt: dbLabel })),
  { id: "set-loudness", path: "audio.loudness.enabled", type: "check" },
  { id: "set-loudness-target", path: "audio.loudness.targetDb", type: "range", fmt: (v) => `${+v} dB` },
  // key detection
  { id: "set-key-auto", path: "key.autoDetect", type: "check" },
  { id: "set-key-badge", path: "key.showBadge", type: "check" },
  // chords
  { id: "set-chords", path: "chords.enabled", type: "check" },
  { id: "set-chords-simplify", path: "chords.simplify", type: "check" },
  // pitch guide
  { id: "set-guide", path: "guide.enabled", type: "check" },
  { id: "set-guide-win", path: "guide.windowSec", type: "range", fmt: (v) => `${(+v).toFixed(1)} s` },
  // The band is sized in the stage's scale unit (16 px at the 1280×720 reference), so the label
  // shows rows of that unit, not pixels. The stored value and its range are unchanged.
  { id: "set-guide-h", path: "guide.height", type: "range", fmt: (v) => `${(v / 16).toFixed(1)} rows` },
  { id: "set-guide-ch", path: "guide.channel", type: "range", fmt: (v) => (v < 0 ? "auto" : `${+v + 1}`) },
  { id: "set-guide-mic", path: "guide.showMic", type: "check" },
  { id: "set-guide-trail", path: "guide.trail", type: "check" },
  { id: "set-guide-score", path: "guide.scoring", type: "check" },
  // score (videoke) — the engine itself; guide.scoring above is just the on-guide number
  { id: "set-score", path: "score.enabled", type: "check" },
  { id: "set-score-card", path: "score.card", type: "check" },
  { id: "set-score-golden", path: "score.golden", type: "check" },
  // M9: per-note / per-line chips while singing; the difficulty (applies from the next song)
  { id: "set-score-feedback", path: "score.feedback", type: "select" },
  { id: "set-score-difficulty", path: "score.difficulty", type: "select" },
  // the leaderboard (M6): record a row per scored song + the name a host-added song ranks under
  { id: "set-score-rankings", path: "score.rankings", type: "check" },
  { id: "set-score-host", path: "score.hostPlayer", type: "text", clean: cleanPlayerName },
  // queue fairness + reactions (party behaviour)
  { id: "set-fairplay", path: "queue.fairPlay", type: "check" },
  { id: "set-maxper", path: "queue.maxPerGuest", type: "range", fmt: (v) => (+v ? `${v}` : "off") },
  { id: "set-reactions", path: "reactions.enabled", type: "check" },
  { id: "set-reactions-sound", path: "reactions.sound", type: "check" },
  { id: "set-gv-solo", path: "guide.vocal.solo", type: "check" },
  { id: "set-foot-autohide", path: "ui.footer.autoHide", type: "check" },
  { id: "set-foot-hide", path: "ui.footer.hideSec", type: "range", fmt: (v) => `${(+v).toFixed(1)} s` },
  // microphone
  { id: "set-mic-vol", path: "mic.volume", type: "range", fmt: pct },
  { id: "set-mic-aec", path: "mic.echoCancellation", type: "check" },
  { id: "set-mic-ns", path: "mic.noiseSuppression", type: "check" },
  { id: "set-mic-agc", path: "mic.autoGainControl", type: "check" },
  { id: "set-mic-hp", path: "mic.highpass", type: "check" },
  { id: "set-mic-gate", path: "mic.gate", type: "check" },
  { id: "set-mic-gate-th", path: "mic.gateThresholdDb", type: "range", valId: "set-mic-gate-val", fmt: (v) => `${v} dB` },
  // M9: the voice's delay to the pitch detector — the scorer reads the melody this much earlier
  { id: "set-mic-latency", path: "mic.latencyMs", type: "range", fmt: (v) => `${v} ms` },
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
  // library search: close matches (typos), what Enter does
  { id: "set-search-fuzzy", path: "search.fuzzy", type: "check" },
  { id: "set-enter-action", path: "search.enterAction", type: "select" },
  // song numbers (M8): number keys open the search; a digit-opened panel's idle clear
  { id: "set-keypad", path: "keypad.enabled", type: "check" },
  { id: "set-keypad-idle", path: "keypad.idleSec", type: "range", fmt: (v) => `${+v} s` },
  // remote control (phones) — the QR in ⚙ → Phones & party → Remote (and on the stage, per qrOnStage) opens /remote
  { id: "set-remote", path: "remote.enabled", type: "check" },
  { id: "set-qr-stage", path: "remote.qrOnStage", type: "select" },
  { id: "set-remote-url", path: "remote.baseUrl", type: "text" },
  // M7: the push channel, and what a guest may do beyond Reserve (remote-glue.js gates both)
  { id: "set-remote-push", path: "remote.push", type: "check" },
  { id: "set-guest-playnow", path: "remote.guestPlayNow", type: "check" },
  { id: "set-guest-priority", path: "remote.guestPriority", type: "check" },
];

// Synonyms so intuitive words find a control whose visible label doesn't contain
// them. Keyed by the control's (or action button's) element id. Optional sugar —
// a control without an entry is still searchable by its label + section titles.
const SEARCH_KEYWORDS = {
  // R35 (review, 2026-11-24): the three reset / erase buttons are search hits too.
  "settings-reset": "reset defaults restore factory default settings start over",
  "erase-all": "erase delete clear wipe reset factory all data everything",
  "reset-offset": "reset offset lyrics timing zero",
  "set-fontsize": "font text size extra small medium large scale zoom big display readability",
  "set-overscan": "tv edge crop margin inset safe area border cut off",
  "set-key-hints": "keyboard remote arrows shortcuts help tips",
  "set-qr-stage": "phone qr code stage home idle corner always never guests",
  "set-theme": "dark light color theme appearance mode night day",
  "set-offset": "latency delay sync timing",
  "set-bt": "bluetooth latency",
  "set-tc": "title card intro",
  "set-lyric-style": "videoke karaoke stage scroll two rows machine look",
  "set-stage-rows": "lines portrait four two",
  "set-stage-align": "left right split center position",
  "set-stage-position": "vertical middle centre center bottom height up down place",
  "set-stage-anim": "animation transition fade flip bounce wipe crossfade",
  "set-stage-color": "highlight sung wipe colour color blue",
  "set-stage-random": "random colour color highlight",
  "set-stage-outline": "stroke border thickness",
  "set-stage-countdown": "count in countdown 4 3 2 1 go dots intro",
  "set-stage-interlude": "instrumental break interlude gap",
  "set-bg-mode": "background backdrop wallpaper video videos clip loop photo photos picture pictures slideshow camera webcam bgv bgphoto stage behind lyrics",
  "set-bg-category": "background folder category video photo slideshow",
  "set-bg-dim": "background dim darken dark brightness opacity contrast readability",
  "set-bg-change": "background next change shuffle new song clip photo",
  "set-bg-interval": "background photo slideshow interval seconds timer duration",
  "set-bg-anim": "background photo slideshow animation transition fade slide zoom pan",
  "set-bg-facing": "background camera webcam front back rear selfie facing",
  "set-bg-mirror": "background camera webcam mirror flip selfie",
  "set-midimode": "midi mode channel mixer volume mute solo vu levels",
  "set-transpose-drums": "drums drum kit percussion transpose key change pitch old behaviour behavior midi",
  "set-music-reverb": "music reverb hall room echo space ambience effect midi synth",
  "set-music-chorus": "music chorus thicken width effect midi synth",
  "set-eq-preset": "eq equalizer equaliser tone bass treble boost warm bright vocal clarity speakers tv small custom bands frequency sound",
  "set-loudness": "loudness volume normalize normalise even out level quiet loud match songs gain auto",
  "set-loudness-target": "loudness volume target level normalize normalise db gain",
  "set-key-auto": "transpose signature",
  "set-key-badge": "transpose signature",
  "set-chords": "guitar chord lane strum",
  "set-chords-simplify": "guitar chord triad",
  "set-guide": "melody piano roll pitch",
  "set-gv-level": "melody vocal guide volume level mute off quarter half",
  "set-gv-solo": "melody vocal isolate",
  "set-foot-autohide": "footer auto hide fade status line buttons seek bar controls idle",
  "set-foot-hide": "footer auto hide seconds timeout delay idle",
  "set-mic-vol": "microphone gain",
  "set-mic-aec": "feedback echo cancellation howl",
  "set-mic-gate": "noise feedback",
  "set-mic-echo": "effect delay slapback",
  "set-mic-reverb": "effect hall space",
  "set-mic-chorus": "effect thicken",
  "set-mic-pitch": "shift transpose octave",
  "set-autotune": "pitch correction tune snap",
  "set-youtube": "online stream byoc",
  "set-search-fuzzy": "fuzzy typo spelling misspelled approximate similar search",
  "set-enter-action": "enter key return reserve queue play now search",
  "set-keypad": "keypad number pad digits song number code dial remote keys 0 9 123",
  "set-keypad-idle": "keypad number digits idle timeout clear close seconds",
  "set-remote": "phone qr code queue guest party mobile control",
  "set-remote-url": "phone qr url tunnel address host",
  "set-remote-push": "phone instant push realtime latency polling stream sse fast",
  "set-guest-playnow": "phone guest play now stop interrupt singer permission",
  "set-guest-priority": "phone guest play next priority jump front queue permission",
  "mic-enable": "microphone singing voice",
  "rebuild-catalog": "library refresh scan songs",
  "set-score": "points rating videoke sing grade",
  "set-score-card": "points rating result end of song",
  "set-score-golden": "hooks bonus double weight",
  "set-score-feedback": "verdict perfect excellent great good miss chip popup per note per line feedback",
  "set-score-difficulty": "level easy normal hard strict lenient tolerance pitch accuracy",
  "set-mic-latency": "microphone delay lag offset timing sync calibrate calibration ms",
  "mic-calibrate": "calibrate calibration measure latency delay lag clicks loopback microphone timing gate noise",
  "set-score-rankings": "leaderboard ranking top scores high score history player",
  "set-score-host": "player singer name nickname leaderboard ranking host",
  "export-data": "backup save download favorites queue settings json",
  "import-data": "restore load upload backup json",
};

const CAT_STATE_KEY = "karaeoke.settingsUI.v1"; // transient UI: category open/closed

/** Pure: a singer name as the rankings store it — trimmed, inner whitespace collapsed, ≤ 24
 *  characters (code points, so an emoji is never cut in half). "" stays "" (rankings → "Host"). */
export function cleanPlayerName(v) {
  return [...String(v ?? "").replace(/\s+/g, " ").trim()].slice(0, 24).join("").trim();
}

/** Why the Camera background cannot be picked on this page (Q6: getUserMedia needs a secure context). */
export const BG_CAMERA_INSECURE = "Open the app on https or localhost to use the camera";

/**
 * Pure: the Background → Category options. "All" first, then each folder name once (the server
 * sends them sorted). A stored category the list does not have (its folder is gone, or it belongs
 * to the other kind) stays selectable as "<name> (not found)", so the control shows what is
 * really stored instead of a blank. A folder literally named "all" is covered by "All".
 * @param {string[]} names  the folders of the kind on show (bg.list.categories.videos | photos)
 * @param {string} stored   bg.category
 * @returns {{value:string, label:string}[]}
 */
export function bgCategoryOptions(names, stored) {
  const out = [{ value: "all", label: "All" }];
  const seen = new Set(["all", ""]);
  for (const n of Array.isArray(names) ? names : []) {
    const v = String(n ?? "");
    if (seen.has(v)) continue;
    seen.add(v);
    out.push({ value: v, label: v });
  }
  const s = stored == null || stored === "" ? "all" : String(stored);
  if (!seen.has(s)) out.push({ value: s, label: `${s} (not found)` });
  return out;
}

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
 * @param {()=>Promise<void>} [deps.onToggleMic]  app-owned mic enable/disable (shared BT guard)
 * @param {()=>void} [deps.onCalibrate]  app-owned: open the calibration dialog (M9)
 * @returns {{ wireSettings, syncSettingsUI, updateMicBtn, updateCalibrateBtn, onOpen, setBgCategories }}
 *   onOpen: the overlay's open hook · updateCalibrateBtn(note?): re-evaluate "Calibrate…" ·
 *   setBgCategories(names): the Background → Category folders for the kind on show (M11)
 */
export function createSettingsUI({ settings, mic, onRebuild, onToggleMic, onCalibrate, onEraseAll, onExportData, onImportData, confirmReset = null }) {
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
        const val = c.clean ? c.clean(readControl(c, el)) : readControl(c, el);
        if (c.clean && el.value !== val) el.value = val;   // show what was actually kept
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
  // matchable controls + action buttons (the reset / erase buttons since R35, 2026-11-24)
  const LEAF_SEL = ".row, #mic-enable, #mic-calibrate, #rebuild-catalog, #export-data, #import-data, #settings-reset, #erase-all, #reset-offset";
  // A "section" for searching: the <section>s, and the danger zone (Erase all) that sits outside them.
  const SEC_SEL = "section, .danger-zone";
  let searchIndex = null;
  let catDefaults = {}; // each category's HTML-default open state, captured before restore

  function buildSearchIndex() {
    const root = document.querySelector(".settings-body");
    const cats = [...root.querySelectorAll(".set-cat")];
    const leaves = [];
    for (const cat of cats) {
      const catText = cat.querySelector("summary")?.textContent || "";
      for (const sec of cat.querySelectorAll(SEC_SEL)) {
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
  // Reset the panel's own layout (category open/closed) back to the HTML defaults and
  // forget the persisted state — the settings-UI half of "Reset to defaults".
  const resetCatState = () => {
    try { localStorage.removeItem(CAT_STATE_KEY); } catch { /* ignore */ }
    for (const cat of searchIndex?.cats || []) {
      const d = catDefaults[cat.dataset.cat];
      cat.open = typeof d === "boolean" ? d : false;
    }
  };

  function applyFilter(q) {
    if (!searchIndex) searchIndex = buildSearchIndex();
    const { root, cats, leaves, dividers } = searchIndex;
    const active = q.trim().length > 0;
    $("set-search-clear").classList.toggle("hidden", !active);

    if (!active) {
      for (const { el } of leaves) el.classList.remove("filtered-out");
      for (const d of dividers) d.classList.remove("filtered-out");
      root.querySelectorAll(SEC_SEL).forEach((s) => s.classList.remove("filtered-out"));
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
    root.querySelectorAll(SEC_SEL).forEach((sec) => {
      const has = [...sec.querySelectorAll(LEAF_SEL)].some((el) => !el.classList.contains("filtered-out"));
      sec.classList.toggle("filtered-out", !has);
    });
    for (const cat of cats) {
      const has = [...cat.querySelectorAll(SEC_SEL)].some((s) => !s.classList.contains("filtered-out"));
      cat.classList.toggle("filtered-out", !has);
      if (has) cat.open = true; // force-open categories with hits (don't persist — see toggle guard)
    }
    $("set-no-results").classList.toggle("hidden", anyVisible);
  }

  function wireSearch() {
    searchIndex = buildSearchIndex();
    // capture each category's HTML-default open state BEFORE restore overwrites the DOM
    for (const cat of searchIndex.cats) catDefaults[cat.dataset.cat] = cat.open;
    restoreCatState();
    const input = $("set-search");
    if (!input) return;
    input.addEventListener("input", () => applyFilter(input.value));
    // Escape in a field WITH text clears it and stops there; in an empty field it is left to
    // the page, where Back closes the panel (the overlay stack owns that).
    input.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && input.value) {
        input.value = ""; applyFilter("");
        e.preventDefault(); e.stopPropagation();
      }
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
    // Q6: no microphone on an insecure page — disabled, with the reason as its title.
    const insecure = mic.secure === false;
    btn.disabled = insecure && !mic.enabled;
    btn.title = insecure ? (mic.unavailableReason || "") : "";
  }

  // "Calibrate…" (M9): DISABLED, with the reason beside it and as its title, on a page that is
  // not a secure context (a TV box on http://<LAN-IP> has no microphone at all — Q6) or while
  // Bluetooth mode is on. Re-evaluated on every sync (the panel opening, Reset, an import) and
  // by app.js when bt.enabled changes. When it can run, the line shows the last calibration's
  // outcome instead (`note`, e.g. "Mic latency set to 140 ms").
  let calNote = "";
  function updateCalibrateBtn(note) {
    if (typeof note === "string") calNote = note;
    const btn = $("mic-calibrate");
    if (!btn) return;
    const why = calibrateUnavailable({ mic, settings }) || "";
    btn.disabled = !!why;
    btn.title = why;
    const line = $("mic-calibrate-why");
    if (line) line.textContent = why || calNote;
  }

  // The panel is one overlay of the stage-first shell. Opening, closing, Escape/Back, the
  // inert page behind it, focus in and focus back all belong to the overlay stack
  // (ui/overlays-dom.js); #settings-close carries data-ov-close. What is left here is the part
  // only this module knows: bring every control up to date as the panel opens, because values
  // change from outside it (the 🎵 melody button, the steppers, a phone).
  function onOpen() {
    syncSettingsUI();
  }

  // M10: the ten Custom EQ bands show only while the preset is Custom (plan §5.19). They sit in a
  // plain <div hidden>: a .row's own display:flex would beat the UA's [hidden] rule on the rows.
  function updateEqCustom() {
    const wrap = $("set-eq-custom");
    if (wrap) wrap.hidden = settings.get("audio.eq.preset") !== "custom";
  }

  // M11 Background → Category: app.js hands over the folder names of the kind on show (videos or
  // photos — the resolved bg.mode) whenever the list or the mode changes; every sync re-applies
  // them, because autoSync sets the select's value before the options it names may exist. The
  // options are rebuilt only when they change (a rebuild under an open select would close it).
  let bgCatNames = [];
  function setBgCategories(names) {
    bgCatNames = Array.isArray(names) ? names.slice() : [];
    updateBgCategories();
  }
  function updateBgCategories() {
    const sel = $("set-bg-category");
    if (!sel) return;
    const stored = settings.get("bg.category");
    const opts = bgCategoryOptions(bgCatNames, stored);
    const key = JSON.stringify(opts);
    if (sel.dataset.opts !== key) {
      sel.replaceChildren(...opts.map(({ value, label }) => {
        const o = document.createElement("option");
        o.value = value;
        o.textContent = label;   // folder names are text, never markup
        return o;
      }));
      sel.dataset.opts = key;
    }
    sel.value = stored == null || stored === "" ? "all" : String(stored);
  }

  // M11 (Q6): the Camera background needs a secure context, as the microphone does. On an insecure
  // page (a TV box on http://<LAN-IP>) the option is disabled, with the reason as its title and on
  // the line under the select. A stored "camera" still shows as selected (backgrounds.js reports
  // "insecure" and calls nothing).
  function updateBgCamera() {
    const insecure = !window.isSecureContext;
    const opt = $("set-bg-mode")?.querySelector('option[value="camera"]');
    if (opt) {
      opt.disabled = insecure;
      opt.title = insecure ? BG_CAMERA_INSECURE : "";
    }
    const why = $("set-bg-why");
    if (why) {
      why.textContent = insecure ? BG_CAMERA_INSECURE : "";
      why.hidden = !insecure;
    }
  }

  function wireSettings() {
    autoBind();
    wireSearch();
    // autoBind's own listener ran first (registered first), so the setting is already stored.
    const eqPreset = $("set-eq-preset");
    if (eqPreset) eqPreset.addEventListener("change", updateEqCustom);
    // The melody's five levels (Rae, 2026-11-24): one select drives guide.vocal.mute + .volume.
    const gvLevel = $("set-gv-level");
    if (gvLevel) gvLevel.addEventListener("change", () => {
      for (const [k, v] of Object.entries(melodyLevelSettings(gvLevel.value))) settings.set(`guide.vocal.${k}`, v);
    });

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

    // Delegate to the app's single mic path (same Bluetooth-mode guard as the transport
    // button); fall back to a local toggle if no handler was injected.
    $("mic-enable").onclick = onToggleMic || (async () => {
      $("mic-status").textContent = mic.enabled ? "Stopping…" : "Requesting microphone…";
      if (mic.enabled) mic.disable();
      else await mic.enable();
      updateMicBtn();
    });

    // The calibration dialog is app.js's (it owns the overlays); a click re-checks the reason
    // first, so a state that changed since the last sync can never start it.
    const calBtn = $("mic-calibrate");
    if (calBtn && onCalibrate) {
      calBtn.onclick = () => {
        updateCalibrateBtn();
        if (!calBtn.disabled) onCalibrate();
      };
    }

    // Reset just the lyric offset to 0 (settings.set fans out to applyVisualSettings;
    // syncSettingsUI moves the slider + "0 ms" label back).
    const rOff = $("reset-offset");
    if (rOff) rOff.onclick = () => { settings.set("lyrics.offsetMs", 0); syncSettingsUI(); };

    // R35 (review, 2026-11-24): every setting at once — custom shortcuts, the calibrated mic latency
    // and the EQ included — so it asks first (app.js passes the confirm dialog; Back = Cancel).
    $("settings-reset").onclick = async () => {
      if (typeof confirmReset === "function") {
        let ok = false;
        try { ok = await confirmReset(); } catch (e) { console.error(e); }
        if (!ok) return;
      }
      settings.reset();                 // clears karaeoke.settings.v1 → re-applies defaults + syncs controls
      const s = $("set-search");
      if (s && s.value) { s.value = ""; applyFilter(""); } // drop any active search filter
      resetCatState();                  // clears karaeoke.settingsUI.v1 → default panel layout
    };

    // Backup / restore. Favorites, the queue and every setting exist ONLY in this browser, so
    // the panel must offer a way out that isn't the delete button. Import reloads: modules read
    // their stores at boot, so restoring underneath a live page would show stale state.
    const exp = $("export-data"), imp = $("import-data"), impFile = $("import-file"), st = $("data-status");
    if (exp && onExportData) {
      exp.onclick = () => {
        try {
          const n = onExportData();
          if (st) st.textContent = `Exported ${n} item${n === 1 ? "" : "s"}.`;
        } catch (e) { if (st) st.textContent = "Export failed: " + e.message; }
      };
    }
    if (imp && impFile && onImportData) {
      imp.onclick = () => impFile.click();   // the real <input type=file> stays visually hidden
      impFile.onchange = async () => {
        const file = impFile.files && impFile.files[0];
        impFile.value = "";                  // allow re-picking the same file after a failure
        if (!file) return;
        if (st) st.textContent = "Restoring…";
        try {
          const n = await onImportData(file);
          if (st) st.textContent = `Restored ${n} item${n === 1 ? "" : "s"} — reloading…`;
          setTimeout(() => location.reload(), 600);
        } catch (e) { if (st) st.textContent = "Import failed: " + e.message; }
      };
    }

    // "Erase all app data" — full factory reset (settings + library data + caches). Guarded
    // by a two-step confirm on the button itself (no native dialog, matches the app's style):
    // first click arms + warns, a second click within 4 s performs the irreversible wipe.
    const erase = $("erase-all");
    if (erase && onEraseAll) {
      const orig = erase.textContent;
      let armed = null; // timer handle while armed
      const disarm = () => { clearTimeout(armed); armed = null; erase.textContent = orig; erase.classList.remove("armed"); };
      erase.onclick = () => {
        if (armed) { disarm(); onEraseAll(); return; } // second click → wipe + reload
        erase.textContent = "Click again to erase everything";
        erase.classList.add("armed");
        armed = setTimeout(disarm, 4000);
      };
    }
  }

  // How much the offline cache is holding, and — the part that matters — whether the browser
  // has started REFUSING writes. That used to fail silently, so repeat plays quietly went back
  // to re-downloading with nothing on screen to explain it.
  function updateCacheStatus() {
    const el = $("cache-status");
    if (!el) return;
    const s = getCacheStatus();
    if (!s.supported) { el.textContent = "Offline cache unavailable in this browser."; return; }
    const base = s.files
      ? `Cached offline: ${s.files} file${s.files === 1 ? "" : "s"}, ${mb(s.bytes)} of ${mb(s.budget)}.`
      : "Nothing cached offline yet.";
    el.textContent = s.quotaExceeded
      ? `${base} Storage is full — songs are re-downloading each play. Erase app data to reclaim it.`
      : base;
    el.classList.toggle("warn", s.quotaExceeded);
  }

  function syncSettingsUI() {
    autoSync();
    const gvLevel = $("set-gv-level");
    if (gvLevel) gvLevel.value = String(melodyLevel(settings.get("guide.vocal.volume"), settings.get("guide.vocal.mute")));
    updateEqCustom();
    updateBgCategories();   // after autoSync: it puts back the stored category's option and value
    updateBgCamera();
    updateMicBtn();
    updateCalibrateBtn();
    updateCacheStatus();
  }

  return { wireSettings, syncSettingsUI, updateMicBtn, updateCalibrateBtn, onOpen, setBgCategories };
}
