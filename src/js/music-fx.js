/*
 * music-fx.js — the music bus's EQ presets and the reverb / chorus level scale (M10, plan §5.19). Pure.
 *
 * CONTRACT STUB written by the orchestrator. Lane A fills the bodies; the exports, names and signatures
 * are the contract lane I codes against — do not change them.
 *
 * The EQ is ten peaking BiquadFilterNodes (audio.js) at EQ_BANDS with Q EQ_Q. At Q 1.4 and one octave
 * apart the bands barely overlap, so a preset's response stays close to its own numbers (cascaded RBJ
 * peaking response, 48 kHz: the largest boost is +6.7 dB, Bass boost at 62 Hz; the deepest cut −8.9 dB,
 * Small speaker at 32 Hz).
 * The presets are Ka-Rae-oke's own values, tuned for a music bus that carries NO live voice (the mic
 * is outside it), so "Vocal clarity" makes room for the singer rather than lifting the backing.
 */

/** Ten peaking bands (Hz), ascending. */
export const EQ_BANDS = Object.freeze([31, 62, 125, 250, 500, 1000, 2000, 4000, 8000, 16000]);
export const EQ_Q = 1.4;

const CUSTOM_LIMIT_DB = 12;
const FLAT_EPS_DB = 0.05;

/**
 * Built-in presets, ten gains in dB each, every value within ±8:
 * flat (all 0), warm, bright, vocal, bass ("Bass boost": the bands below 150 Hz up ≥ 3 dB), small (small
 * speakers: low bass cut, presence up), tv (TV speakers). Frozen.
 */
export const EQ_PRESETS = Object.freeze({
  //                      31  62 125 250 500  1k  2k  4k  8k 16k
  flat:   Object.freeze([  0,  0,  0,  0,  0,  0,  0,  0,  0,  0]),
  // body in the low mids, the top softened (≈ +4 dB at 62/125 Hz, ≈ −3 dB at 16 kHz)
  warm:   Object.freeze([  2,  3,  3,  2,  1,  0, -1, -2, -2, -3]),
  // air and sparkle, a touch less boom
  bright: Object.freeze([  0,  0, -1, -1,  0,  1,  2,  3,  4,  4]),
  // "Vocal clarity": a gentle pocket where the singing voice lives (≈ −4 dB around 0.5–2 kHz)
  vocal:  Object.freeze([  0,  0, -1, -2, -3, -3, -3, -2,  0,  1]),
  // "Bass boost": ≈ +5.6 dB of energy below 150 Hz on a pink spectrum
  bass:   Object.freeze([  5,  5,  4,  1,  0,  0,  0,  0,  0,  0]),
  // small speakers cannot move 31–62 Hz (cutting it saves them distorting); upper bass + presence up
  small:  Object.freeze([ -8, -5,  1,  2,  1,  0,  2,  3,  2,  0]),
  // TV speakers: thin and often firing down or backwards — lose the sub, lift upper bass and the top
  tv:     Object.freeze([ -4, -2,  2,  2,  0, -1,  1,  3,  4,  3]),
});

/** A finite number from a setting value (a number, or a numeric string from a form control); else null. */
function finiteOrNull(v) {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));

/** "custom" → `custom` clamped to ±12 (missing / non-finite values → 0); a preset name → its gains; unknown → flat. Always a fresh array of 10. */
export function eqGainsFor(preset, custom) {
  if (preset === "custom") {
    const src = Array.isArray(custom) ? custom : [];
    return EQ_BANDS.map((_, i) => {
      const n = finiteOrNull(src[i]);
      return n === null ? 0 : clamp(n, -CUSTOM_LIMIT_DB, CUSTOM_LIMIT_DB);
    });
  }
  // Own properties only: "constructor" / "__proto__" / "toString" must not resolve to something.
  const own = typeof preset === "string" && Object.prototype.hasOwnProperty.call(EQ_PRESETS, preset);
  return (own ? EQ_PRESETS[preset] : EQ_PRESETS.flat).slice();
}

/** True when every gain is 0 (within 0.05 dB) — the bus then bypasses the EQ (a straight wire). */
export function isFlat(gains) {
  if (!Array.isArray(gains)) return true;          // null / absent = no EQ
  for (let i = 0; i < EQ_BANDS.length; i++) {
    const n = finiteOrNull(gains[i]);              // missing / non-finite counts as 0, as eqGainsFor does
    if (n !== null && Math.abs(n) > FLAT_EPS_DB) return false;
  }
  return true;
}

/** Reverb / chorus level 0..4 → master-parameter gain 0, .5, 1, 1.5, 2 (level 2 = unity, the default); out of range clamps, non-numbers → 1. */
export function fxLevelToGain(level) {
  if (typeof level !== "number" || !Number.isFinite(level)) return 1;
  return clamp(level, 0, 4) / 2;
}

/**
 * The melody guide's five volume levels (Rae, 2026-11-24): Off, 25 %, 50 %, 75 %, 100 %. Level 0 is
 * guide.vocal.mute = true (the volume is kept, so the phone's mute toggle brings it back); levels 1–4
 * unmute at that volume. The 🎵 button and its key step through them; Settings picks one.
 */
export const MELODY_LEVELS = Object.freeze([0, 0.25, 0.5, 0.75, 1]);

/** The level 0..4 that { volume, mute } plays at: muted or near-silent → 0, else the nearest step
 *  (a volume stored above 100 % before the levels existed reads as 100 %). */
export function melodyLevel(volume, mute) {
  const v = typeof volume === "number" && Number.isFinite(volume) ? volume : 1;
  if (mute === true || v < 0.125) return 0;
  return clamp(Math.round(v * 4), 1, 4);
}

/** The settings for level `k` (clamped 0..4): { mute: true } for Off — the volume is left alone —
 *  else { volume, mute: false }. */
export function melodyLevelSettings(k) {
  const n = clamp(Math.round(Number(k) || 0), 0, 4);
  return n === 0 ? { mute: true } : { volume: MELODY_LEVELS[n], mute: false };
}

/** The button's next level after `level`: Off → 25 → 50 → 75 → 100 → Off. */
export function nextMelodyLevel(level) {
  return (clamp(Math.round(Number(level) || 0), 0, 4) + 1) % 5;
}

/** "Off" or "50%" — the toast and the button's label. */
export function melodyLevelLabel(level) {
  const n = clamp(Math.round(Number(level) || 0), 0, 4);
  return n === 0 ? "Off" : `${n * 25}%`;
}

/** Drums are transposed with the key only when the setting asks for it (default false). The `force` argument of synth.transposeChannel. */
export function transposeForce(drumsSetting) {
  return drumsSetting === true;
}
