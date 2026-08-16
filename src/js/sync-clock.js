/*
 * sync-clock.js — pure playback-clock estimator for a REMOTE viewer (the phone's
 * Lyrics tab; see src/js/remote.js).
 *
 * The phone learns the host's playback position through a ~1 Hz poll relay, which is
 * far too coarse to drive a per-syllable lyric wipe. So the relay is used only to
 * *discipline* a locally free-running clock: each snapshot yields a corrected target
 * (the host's position plus the snapshot's measured age), and the local clock is
 * eased toward it instead of being snapped every second — a hard snap every poll
 * would make the wipe visibly stutter.
 *
 * Latency terms this removes:
 *   - the guest's own poll phase (0…1 s of unknown snapshot staleness) → killed by `age`,
 *     which serve.py measures server-side when the host's push landed;
 *   - inter-poll dead time → the caller extrapolates every rAF frame via clockTime().
 * What remains is one-way network latency (a few ms on a LAN), which the per-device
 * nudge in the UI absorbs.
 *
 * Both functions are pure — no timers, no Date/performance reads — so they unit-test.
 */

/** Beyond this error (seconds) a correction is a seek/song change, not drift → snap. */
export const SNAP_SEC = 0.5;
/** Fraction of the remaining error absorbed per poll when easing (≈1 s apart). */
export const EASE = 0.35;

/**
 * Fold one host snapshot into the clock state.
 *
 * @param {object|null} prev  previous clock state (null on first sample)
 * @param {object} sample
 *   @param {number} sample.position  host playback position at push time (s)
 *   @param {number} sample.age       seconds since that push landed on the server
 *   @param {boolean} sample.paused   host transport state
 *   @param {number} [sample.rate]    playback rate (audio.tempo) — song-seconds per wall-second
 *   @param {string} [sample.songId]  identity of the playing song (a change forces a snap)
 *   @param {number} sample.at        local timestamp of this sample (ms, e.g. performance.now())
 * @returns {{base:number, at:number, rate:number, paused:boolean, songId:string}}
 */
export function syncClock(prev, sample) {
  const rate = num(sample.rate, 1) || 1;
  const paused = !!sample.paused;
  const songId = sample.songId || "";
  const at = num(sample.at, 0);
  // A paused host doesn't advance, so its snapshot doesn't age; a playing one does.
  const target = Math.max(0, num(sample.position, 0) + (paused ? 0 : Math.max(0, num(sample.age, 0)) * rate));

  // Snap (no easing) whenever continuity is broken rather than merely drifting.
  if (!prev || prev.songId !== songId || prev.paused !== paused ||
      Math.abs(target - clockTime(prev, at)) > SNAP_SEC) {
    return { base: target, at, rate, paused, songId };
  }
  const predicted = clockTime(prev, at);
  return { base: predicted + (target - predicted) * EASE, at, rate, paused, songId };
}

/**
 * Extrapolate the clock to a local timestamp — call this every frame.
 * @param {object|null} clock  state from syncClock()
 * @param {number} nowMs       local timestamp (ms), same source as sample.at
 * @returns {number} playback position in seconds (0 when there is no clock yet)
 */
export function clockTime(clock, nowMs) {
  if (!clock) return 0;
  if (clock.paused) return clock.base;
  return clock.base + ((num(nowMs, 0) - clock.at) / 1000) * clock.rate;
}

function num(v, fallback) {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}
