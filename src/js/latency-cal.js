/*
 * latency-cal.js — microphone latency calibration maths (M9, plan §5.17). Pure: no DOM, no audio.
 *
 * CONTRACT STUB written by the orchestrator. Lane B fills the bodies; the exports, names and
 * signatures are the contract — do not change them.
 *
 * Loopback method: 8 short clicks are played at known audio-clock times; their onsets are found in
 * the raw microphone signal; latency = median(onset − scheduled) + PITCH_CHAIN_MS (the pitch detector's
 * own delay: half its analysis window, the 30 ms post interval and the median-of-3).
 *
 * Lane B additions (extra exports; every contract export keeps its signature):
 *   ONSET_WINDOW_MS, MIN_MATCHED, MAX_SPREAD_MS — the constants the rules below use;
 *   matchClicks(scheduled, onsets, {maxMs}) — the per-click deltas estimateLatency pairs, so the
 *     dialog can say WHY a measurement failed (how many clicks were heard);
 *   onsetThresholdDb(noiseDb) — the detection threshold the dialog passes to detectOnsets.
 */

export const CLICKS = 8;
export const CLICK_GAP_SEC = 0.6;
export const CLICK_SEC = 0.012;
export const CLICK_HZ = 1000;
export const PITCH_CHAIN_MS = 60;

/** The short RMS window detectOnsets uses: two periods of the 1 kHz click, so its level is steady. */
export const ONSET_WINDOW_MS = 2;
/** estimateLatency fails below this many matched clicks, or above this inter-quartile spread. */
export const MIN_MATCHED = 5;
export const MAX_SPREAD_MS = 40;

const FLOOR_DB = -100;

/** CLICKS times, CLICK_GAP_SEC apart, the first at startSec. */
export function clickTimes(startSec) {
  const t0 = Number(startSec);
  const out = new Array(CLICKS);
  for (let i = 0; i < CLICKS; i++) out[i] = t0 + i * CLICK_GAP_SEC;
  return out;
}

/**
 * Onsets in a mono signal, in seconds from sample 0: a rise above thresholdDb (short-window RMS, dBFS)
 * after at least minGapMs below it — so a ringing click is one onset.
 * @param {Float32Array} samples
 * @param {number} sampleRate
 * @param {{thresholdDb?:number, minGapMs?:number}} [o]
 * @returns {number[]}
 *
 * The RMS window (ONSET_WINDOW_MS) ENDS at the sample being tested; an onset is reported at the
 * first sample whose window reaches the threshold. For a click well above the threshold that is
 * within a fraction of a millisecond of the click's true start; it is never early.
 */
export function detectOnsets(samples, sampleRate, { thresholdDb = -30, minGapMs = 150 } = {}) {
  const out = [];
  const n = samples ? samples.length >>> 0 : 0;
  const sr = Number(sampleRate);
  if (!n || !(sr > 0) || !Number.isFinite(thresholdDb)) return out;
  const win = Math.max(1, Math.round((sr * ONSET_WINDOW_MS) / 1000));
  const thrPow = Math.pow(10, thresholdDb / 10);          // mean-square threshold
  const minGap = Math.max(0, (sr * (Number(minGapMs) || 0)) / 1000);
  let sumSq = 0;
  let lastAbove = -Infinity;                                // index of the last sample above threshold
  for (let i = 0; i < n; i++) {
    const x = samples[i];
    sumSq += x * x;
    if (i >= win) { const y = samples[i - win]; sumSq -= y * y; }
    if (sumSq < 0) sumSq = 0;                               // float drift on long buffers
    if (sumSq / win >= thrPow) {
      const below = i - lastAbove - 1;                      // samples spent below since the last rise
      if (below > 0 && below >= minGap) out.push(i / sr);
      lastAbove = i;
    }
  }
  return out;
}

/**
 * The deltas, in ms, between each scheduled click and the first onset in (t, t + maxMs] — one per
 * click that was heard, in click order. Onsets need not be sorted.
 * @param {number[]} scheduled
 * @param {number[]} onsets
 * @returns {number[]}
 */
export function matchClicks(scheduled, onsets, { maxMs = 600 } = {}) {
  const sorted = Array.from(onsets || [], Number).filter(Number.isFinite).sort((a, b) => a - b);
  const maxSec = Number(maxMs) / 1000;
  const deltas = [];
  for (const raw of scheduled || []) {
    const t = Number(raw);
    if (!Number.isFinite(t)) continue;
    // first onset strictly after t (binary search), then check the window's far edge
    let lo = 0, hi = sorted.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (sorted[mid] <= t) lo = mid + 1; else hi = mid; }
    if (lo < sorted.length && sorted[lo] <= t + maxSec) deltas.push((sorted[lo] - t) * 1000);
  }
  return deltas;
}

// Linear-interpolated quantile of an ascending array (the common "type 7" definition).
function quantile(asc, p) {
  if (!asc.length) return NaN;
  const at = (asc.length - 1) * p;
  const lo = Math.floor(at), hi = Math.ceil(at);
  return asc[lo] + (asc[hi] - asc[lo]) * (at - lo);
}

/**
 * Pairs each scheduled click time with the first onset in (t, t + maxMs]; latencyMs = median of the
 * deltas + PITCH_CHAIN_MS; spreadMs = the deltas' inter-quartile range. null when fewer than 5 clicks
 * matched or spreadMs > 40.
 * @param {number[]} scheduled   seconds (same clock as onsets)
 * @param {number[]} onsets      seconds
 * @returns {{latencyMs:number, matched:number, spreadMs:number}|null}
 */
export function estimateLatency(scheduled, onsets, { maxMs = 600 } = {}) {
  const deltas = matchClicks(scheduled, onsets, { maxMs });
  if (deltas.length < MIN_MATCHED) return null;
  const asc = deltas.slice().sort((a, b) => a - b);
  const spreadMs = quantile(asc, 0.75) - quantile(asc, 0.25);
  if (!(spreadMs <= MAX_SPREAD_MS)) return null;
  return { latencyMs: quantile(asc, 0.5) + PITCH_CHAIN_MS, matched: deltas.length, spreadMs };
}

/** RMS of the whole buffer in dBFS; −100 for silence (the floor). */
export function noiseFloorDb(samples) {
  const n = samples ? samples.length >>> 0 : 0;
  if (!n) return FLOOR_DB;
  let sumSq = 0;
  for (let i = 0; i < n; i++) { const x = samples[i]; sumSq += x * x; }
  const rms = Math.sqrt(sumSq / n);
  if (!(rms > 0)) return FLOOR_DB;                          // silence (or NaN samples)
  return Math.max(FLOOR_DB, 20 * Math.log10(rms));
}

/** The gate threshold to offer: clamp(round(noiseDb + 10), −70, −20). */
export function suggestGateDb(noiseDb) {
  const n = Number(noiseDb);
  const v = Number.isNaN(n) ? FLOOR_DB + 10 : Math.round(n + 10);
  return Math.min(-20, Math.max(-70, v));
}

/**
 * The onset threshold the dialog uses: 20 dB above the room's noise, kept within −50…−30 dBFS. The
 * fixed −30 default misses clicks from a quiet laptop microphone with auto-gain off; −50 is still
 * far above an idle microphone's self-noise, and 20 dB over the room keeps its bumps out.
 */
export function onsetThresholdDb(noiseDb) {
  const n = Number(noiseDb);
  const v = Number.isFinite(n) ? n + 20 : -50;
  return Math.min(-30, Math.max(-50, v));
}
