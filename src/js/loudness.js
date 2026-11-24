/*
 * loudness.js — evening out song loudness (M10, plan §5.20). Pure, except the store's injected storage.
 *
 * CONTRACT STUB written by the orchestrator. Lane A fills the bodies; the exports, names and signatures
 * are the contract lane I codes against — do not change them.
 *
 * How it is used (lane I, app.js): while a song plays, at most every 100 ms,
 *   meter.add(audio.readMusicMeanSquare(), dt)   (already divided by volume², see audio.js)
 * On a song's FIRST play (no stored value) a follower eases the gain toward the target:
 *   gain = followGainDb(gain, meter.db, targetDb, dt)  → audio.setLoudnessGainDb(gain)
 * At endOfSong, when meter.seconds ≥ 30, store.set(song.id, meter.db). On later plays the stored value is
 * applied at once: audio.setLoudnessGainDb(gainForDb(store.get(id), targetDb)).
 *
 * Units: "dB" here is 10·log10(mean-square) of the music bus's mono mix, BEFORE the EQ and the loudness
 * gain, divided by the volume² the active source was set to (audio.js readMusicMeanSquare). A full-scale
 * sine reads −3 dB. For scale: the baseline songs measured on the rig at Volume 90% read about −25 dB at
 * the destination, i.e. about −24.4 dB once divided by 0.9².
 */

export const LOUDNESS_KEY = "karaeoke.loudness.v1";

const toDb = (ms) => 10 * Math.log10(ms);
const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
const isNum = (x) => typeof x === "number" && Number.isFinite(x);

/**
 * The pure half of audio.readMusicMeanSquare (re-exported by audio.js): a mean-square measured AFTER a
 * volume gain of `vol`, brought back to what it was before it. Both volume gains (the synth's and the
 * key-shift chain's) sit BEFORE the music bus, so without this a song learned at Volume 50% would be
 * stored 6 dB quiet and boosted for ever (plan R12). A volume of 0 does not divide by zero.
 */
export function normalizeMeanSquare(ms, vol) {
  return ms / Math.max(1e-6, vol * vol);
}

/**
 * Time-weighted mean loudness of the music, in dB of mean-square. Frames whose level is under floorDb
 * are skipped (silence must not drag a song's loudness down).
 * @returns {{ add(meanSquare:number, dtSec:number): void, readonly db: number|null, readonly seconds: number, reset(): void }}
 *   db is null until something above the floor was added; seconds counts only the frames that counted.
 *
 * The mean is taken over ENERGY (mean-square), not over dB, so a loud chorus weighs what it sounds like.
 * One reading never counts for more than `maxDtSec` (1 s): a frame that arrives after the tab was hidden
 * is one ~85 ms analyser window, not a minute of music.
 */
export function createLoudnessMeter({ floorDb = -60, maxDtSec = 1 } = {}) {
  let energy = 0;   // Σ meanSquare · dt over the frames that counted
  let seconds = 0;  // Σ dt over the same frames
  return {
    add(meanSquare, dtSec) {
      if (!isNum(meanSquare) || meanSquare <= 0) return;   // silence, or nothing to read
      if (!isNum(dtSec) || dtSec <= 0) return;
      if (toDb(meanSquare) < floorDb) return;
      const dt = Math.min(dtSec, maxDtSec);
      energy += meanSquare * dt;
      seconds += dt;
    },
    get db() { return seconds > 0 ? toDb(energy / seconds) : null; },
    get seconds() { return seconds; },
    reset() { energy = 0; seconds = 0; },
  };
}

/** The gain (dB) that brings a song stored at storedDb to targetDb, clamped to [minDb, maxDb]. 0 when storedDb is null. */
export function gainForDb(storedDb, targetDb, { minDb = -9, maxDb = 6 } = {}) {
  if (!isNum(storedDb) || !isNum(targetDb)) return 0;
  return clamp(targetDb - storedDb, minDb, maxDb);
}

/**
 * One step of the first-play follower: move currentGainDb toward (targetDb − measuredDb) with time
 * constant tauSec over dtSec, never beyond ±limitDb. measuredDb null (silence so far) → hold.
 *
 * Exponential, so the result does not depend on how the time is sliced: two 0.5 s steps land where one
 * 1 s step does. measuredDb is the meter's running mean (pre-loudness-gain), so the follower never
 * hears its own correction — there is no feedback loop to pump.
 */
export function followGainDb(currentGainDb, measuredDb, targetDb, dtSec, { tauSec = 4, limitDb = 6 } = {}) {
  const lim = Math.abs(isNum(limitDb) ? limitDb : 6);
  const cur = clamp(isNum(currentGainDb) ? currentGainDb : 0, -lim, lim);
  if (!isNum(measuredDb) || !isNum(targetDb)) return cur;   // silence so far: hold
  if (!isNum(dtSec) || dtSec <= 0) return cur;
  const want = clamp(targetDb - measuredDb, -lim, lim);
  const alpha = isNum(tauSec) && tauSec > 0 ? 1 - Math.exp(-dtSec / tauSec) : 1;
  return clamp(cur + (want - cur) * alpha, -lim, lim);
}

function defaultStorage() {
  try { return globalThis.localStorage || null; } catch (_) { return null; }   // throws in some privacy modes
}

/**
 * The learned loudness per song id, in storage[LOUDNESS_KEY] (JSON; a failing or missing storage is
 * tolerated). Values rounded to 0.1 dB; least-recently-WRITTEN entries evicted beyond `max`.
 * @returns {{ get(id:string): number|null, set(id:string, db:number): void }}
 *
 * Stored as an ARRAY of [id, db] pairs, oldest write first. An object would reorder integer-like keys
 * ("123" before "midi:1"), which would silently break the eviction order. Read fresh on every call
 * (once per song start / end) so a Backup restore or a second tab is never shadowed by a stale copy.
 */
export function createLoudnessStore({ storage = defaultStorage(), max = 5000 } = {}) {
  const cap = Math.max(0, Math.floor(isNum(max) ? max : 5000));

  function read() {
    if (!storage) return [];
    let raw;
    try { raw = storage.getItem(LOUDNESS_KEY); } catch (_) { return []; }
    if (!raw) return [];
    let data;
    try { data = JSON.parse(raw); } catch (_) { return []; }
    if (!Array.isArray(data)) return [];
    // Keep only well-formed pairs; a repeated id keeps its LAST (newest) position.
    const seen = new Map();
    for (const e of data) {
      if (Array.isArray(e) && typeof e[0] === "string" && e[0] && isNum(e[1])) {
        seen.delete(e[0]);
        seen.set(e[0], e[1]);
      }
    }
    return [...seen];
  }

  function write(entries) {
    if (!storage) return;
    try { storage.setItem(LOUDNESS_KEY, JSON.stringify(entries)); } catch (_) { /* quota / privacy mode */ }
  }

  return {
    get(id) {
      if (typeof id !== "string" || !id) return null;
      for (const [k, v] of read()) if (k === id) return v;
      return null;
    },
    set(id, db) {
      if (typeof id !== "string" || !id || !isNum(db)) return;
      const v = Math.round(db * 10) / 10;
      const entries = read().filter(([k]) => k !== id);
      entries.push([id, v]);
      while (entries.length > cap) entries.shift();   // least-recently-written first
      write(entries);
    },
  };
}
