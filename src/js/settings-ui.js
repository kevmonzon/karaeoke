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

// type: "range" (number) · "check" (boolean) · "select" (string)
// valId: label element id (defaults to `${id}-val`) · fmt: label text for ranges
const SETTINGS_SCHEMA = [
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
  // key detection
  { id: "set-key-auto", path: "key.autoDetect", type: "check" },
  { id: "set-key-badge", path: "key.showBadge", type: "check" },
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
];

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
    c.type === "check" ? el.checked : c.type === "select" ? el.value : +el.value;

  function autoBind() {
    for (const c of SETTINGS_SCHEMA) {
      const el = $(c.id);
      if (!el) continue;
      const evt = c.type === "check" || c.type === "select" ? "change" : "input";
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
      else if (c.type === "select") el.value = String(val);
      else { el.value = val; label(c, val); }
    }
  }

  function updateMicBtn() {
    const btn = $("mic-enable");
    if (!btn) return;
    btn.textContent = mic.enabled ? "🎤 Disable microphone" : "🎤 Enable microphone";
    btn.classList.toggle("on", mic.enabled);
  }

  function wireSettings() {
    $("btn-settings").onclick = () => $("settings-panel").classList.remove("hidden");
    $("settings-close").onclick = () => $("settings-panel").classList.add("hidden");

    autoBind();

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
