/*
 * remote-adjust.js — the phone's Now-tab steps and the words both screens toast for them
 * (Rae, 2026-11-25: "volume - make it (+) (-) in 10 increments", "key - show current song key with
 * root key", "melody - same as controls from main screen (25-50-75-100-mute)", "show updates on
 * toast as well" → the phone toasts its own change, and the TV toasts it with the guest's name).
 *
 * Pure, imported by BOTH remote.js (the phone) and remote-glue.js (the host), so a step and its
 * label can never read one way on the phone and another on the TV. The melody levels come from
 * music-fx.js and the key names from melody.js — the same helpers the TV's own status line uses.
 */

import { keyName } from "./melody.js";
import { melodyLevel, melodyLevelSettings, melodyLevelLabel } from "./music-fx.js";

/** Volume moves in tenths: 0, 10 … 100 %. */
export const VOLUME_STEP = 0.1;

/** The next volume after one − (dir < 0) or + step, snapped to a tenth and kept in 0..1. */
export function stepVolume(volume, dir) {
  const v = typeof volume === "number" && Number.isFinite(volume) ? volume : 0.9;
  const tenths = Math.round(v * 10) + (dir < 0 ? -1 : 1);
  return Math.max(0, Math.min(10, tenths)) / 10;
}

/** The next melody level (0 Off … 4 = 100 %) one step down or up, and the settings for it. */
export function stepMelody(volume, mute, dir) {
  const level = Math.max(0, Math.min(4, melodyLevel(volume, mute) + (dir < 0 ? -1 : 1)));
  return { level, settings: melodyLevelSettings(level) };
}

/**
 * The Lyrics tab's sync nudge (Rae, 2026-11-28: "make the sync nudge be (+)/(-) buttons similar to
 * design in now tab"). It shifts THIS phone's lyrics only, in the slider's old 25 ms steps and range.
 */
export const NUDGE_STEP_MS = 25;
export const NUDGE_MAX_MS = 1000;

/** The next nudge after one − (dir < 0) or + step, snapped to the 25 ms grid and kept in ±1000 ms. */
export function stepNudge(ms, dir) {
  const v = Number(ms);
  const steps = Math.round((Number.isFinite(v) ? v : 0) / NUDGE_STEP_MS) + (dir < 0 ? -1 : 1);
  const max = NUDGE_MAX_MS / NUDGE_STEP_MS;
  return Math.max(-max, Math.min(max, steps)) * NUDGE_STEP_MS;
}

/** Milliseconds as the offsets read: "+50 ms", "0 ms", "-25 ms". */
export function fmtMs(ms) {
  const n = Math.round(Number(ms) || 0);
  return `${n > 0 ? "+" : ""}${n} ms`;
}

/** The phone's own toast for a nudge step (never sent to the TV: the nudge is this phone's). */
export function nudgeLabel(ms) {
  return `Sync nudge ${fmtMs(ms)}`;
}

/** Semitones as the TV writes them: "+2", "0", "-3". */
export function fmtSemis(k) {
  const n = Math.round(Number(k) || 0);
  return n > 0 ? `+${n}` : `${n}`;
}

/**
 * The song's key as the TV's key badge writes it: "D maj" at 0, "D maj → E maj" when transposed,
 * "" when no key is known (video / YouTube / audio songs, or detection off).
 * @param {number} semis   audio.key
 * @param {{pc: number, mode: string}|null} key  the detected (root) key, from the host's snapshot
 */
export function keyText(semis, key) {
  if (!key || !Number.isInteger(key.pc)) return "";
  const mode = key.mode === "minor" ? "minor" : "major";
  const s = Math.round(Number(semis) || 0);
  const root = keyName(key.pc, mode, true);
  return s ? `${root} → ${keyName(key.pc + s, mode, true)}` : root;
}

/**
 * The toast for one change of `path` to `value` ("Volume 80%", "Key +2 · D maj → E maj", "Melody
 * 50%"); null for a path nobody toasts. The melody reads BOTH guide.vocal settings through `get`
 * (after the change), because one level is two settings.
 * @param {string} path
 * @param {*} value
 * @param {{get?: (path: string) => any, key?: object|null}} [ctx]
 */
export function adjustLabel(path, value, { get = () => undefined, key = null } = {}) {
  switch (path) {
    case "audio.volume": return `Volume ${Math.round((Number(value) || 0) * 100)}%`;
    case "audio.key": {
      const names = keyText(value, key);
      return `Key ${fmtSemis(value)}${names ? ` · ${names}` : ""}`;
    }
    case "audio.tempo": return `Tempo ${(Number(value) || 1).toFixed(2)}×`;
    case "guide.vocal.volume":
    case "guide.vocal.mute":
      return `Melody ${melodyLevelLabel(melodyLevel(get("guide.vocal.volume"), get("guide.vocal.mute")))}`;
    case "lyrics.offsetMs": return `Lyric offset ${fmtMs(value)}`;
    default: return null;
  }
}
