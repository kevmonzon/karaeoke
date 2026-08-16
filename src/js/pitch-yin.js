/*
 * pitch-yin.js — YIN fundamental-frequency estimation. PURE → unit-tested.
 *
 * Replaces the plain autocorrelation this app used to run. Autocorrelation's failure mode is
 * the one that hurts a karaoke app most: it happily locks onto a HARMONIC, reporting a note
 * an octave (or a fifth) away from what was actually sung. On a pitch guide that's a visible
 * dropout; once singing is scored, it's a wrong verdict in front of a room.
 *
 * YIN (de Cheveigné & Kawahara, 2002) fixes exactly that, in four steps:
 *
 *   1. DIFFERENCE FUNCTION  d(τ) = Σ (x[j] − x[j+τ])²  — small where the wave repeats.
 *   2. CUMULATIVE MEAN NORMALISATION  d'(τ) = d(τ) / ((1/τ) Σ d(k))  — this is the step that
 *      kills octave errors. Raw d(τ) is near zero at τ=0 and at every multiple of the true
 *      period; dividing by the running mean makes the FIRST real dip stand out instead of
 *      whichever dip happens to be deepest.
 *   3. ABSOLUTE THRESHOLD — take the first τ where d' drops below ~0.15 (rather than the
 *      global minimum), so the fundamental wins over its own harmonics by construction.
 *   4. PARABOLIC INTERPOLATION around that τ for sub-sample precision, which matters when a
 *      semitone at the top of a singer's range is only a few samples wide.
 *
 * Cost is the same O(n·τmax) envelope as the autocorrelation it replaces — the τ range is
 * bounded by the human vocal range, so this comfortably holds a 30 ms cadence in a Worker.
 */

/** Lowest / highest fundamental we'll believe from a human voice, in Hz. */
export const MIN_HZ = 65;    // ~C2, below a bass's comfortable floor
export const MAX_HZ = 1200;  // ~D6, above a soprano's belt
/** d' must drop below this to count as periodic. Lower = stricter (more "unvoiced"). */
export const YIN_THRESHOLD = 0.15;
/** RMS floor (~−46 dBFS). Low enough for soft singing, high enough to ignore room tone. */
export const RMS_FLOOR = 0.005;

/**
 * Estimate the fundamental frequency of one buffer.
 * @param {Float32Array|number[]} buf  mono samples
 * @param {number} sampleRate
 * @param {{threshold?:number, minHz?:number, maxHz?:number, rmsFloor?:number}} [opts]
 * @returns {number} Hz, or -1 when the frame is silent or unvoiced
 */
export function yinPitch(buf, sampleRate, opts = {}) {
  const threshold = opts.threshold ?? YIN_THRESHOLD;
  const minHz = opts.minHz ?? MIN_HZ;
  const maxHz = opts.maxHz ?? MAX_HZ;
  const rmsFloor = opts.rmsFloor ?? RMS_FLOOR;

  const n = buf ? buf.length : 0;
  if (!n || !(sampleRate > 0)) return -1;

  let rms = 0;
  for (let i = 0; i < n; i++) rms += buf[i] * buf[i];
  rms = Math.sqrt(rms / n);
  if (rms < rmsFloor) return -1;                       // silence — say nothing rather than guess

  const tauMin = Math.max(2, Math.floor(sampleRate / maxHz));
  const tauMax = Math.min(Math.floor(n / 2), Math.ceil(sampleRate / minHz));
  if (tauMax <= tauMin) return -1;

  // 1 + 2: difference function and its cumulative mean normalisation, in one pass.
  const d = new Float32Array(tauMax + 1);
  const dPrime = new Float32Array(tauMax + 1);
  dPrime[0] = 1;
  let running = 0;
  for (let tau = 1; tau <= tauMax; tau++) {
    let sum = 0;
    const lim = n - tau;
    for (let j = 0; j < lim; j++) {
      const diff = buf[j] - buf[j + tau];
      sum += diff * diff;
    }
    d[tau] = sum;
    running += sum;
    dPrime[tau] = running === 0 ? 1 : sum * tau / running;
  }

  // 3: the FIRST dip under the threshold — not the deepest, which is how octave errors start.
  let tau = -1;
  for (let t = tauMin; t <= tauMax; t++) {
    if (dPrime[t] < threshold) {
      while (t + 1 <= tauMax && dPrime[t + 1] < dPrime[t]) t++;   // walk to the bottom of this dip
      tau = t;
      break;
    }
  }
  if (tau < 0) {
    // Nothing crossed the threshold. Rather than invent a pitch, only accept a clearly
    // periodic global minimum; otherwise report unvoiced.
    let best = tauMin;
    for (let t = tauMin; t <= tauMax; t++) if (dPrime[t] < dPrime[best]) best = t;
    if (dPrime[best] > 0.5) return -1;
    tau = best;
  }

  // 4: parabolic interpolation around the chosen lag.
  const x0 = tau > tauMin ? dPrime[tau - 1] : dPrime[tau];
  const x2 = tau + 1 <= tauMax ? dPrime[tau + 1] : dPrime[tau];
  const denom = 2 * (2 * dPrime[tau] - x2 - x0);
  const better = denom !== 0 ? tau + (x2 - x0) / denom : tau;

  const hz = sampleRate / better;
  return hz >= minHz && hz <= maxHz ? hz : -1;
}
