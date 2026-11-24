/*
 * verdicts.js — per-note verdicts (M9, plan §5.15). Pure: no DOM, no clock, no audio.
 *
 * The contract (exports, names, signatures) was written by the orchestrator and lane A filled the
 * bodies; lanes C and I code against it — do not change it.
 *
 * A note is judged from the Scorer's time-weighted per-note stats (`scorer.noteStats(i)` →
 * { len, voiced, on, err }: seconds, seconds, seconds, semitone-seconds) and the difficulty's numbers
 * (`difficultyOf(name)` in scoring.js: { perfectSemis, zeroAtSemis, clear, curve }):
 *   cov = voiced / len   on = on-pitch time / voiced   err = (err / voiced) / perfectSemis
 *   MISS       cov < 0.15  or  on < clear
 *   PERFECT    cov ≥ 0.5, on ≥ 0.90, err ≤ 0.40
 *   EXCELLENT  cov ≥ 0.5, on ≥ 0.80, err ≤ 0.70
 *   GREAT      on ≥ min(0.99, clear + 0.20)
 *   GOOD       otherwise (cleared)
 * (voiced 0 → MISS.) Verdicts never change the score in v1: the final number is still the credit curve.
 *
 * Every comparison allows EPS of float slack, so a share that lands exactly on a threshold gets
 * the better verdict (0.7 + 0.2 is 0.8999999999999999 in floating point; "hard" must still
 * reach GREAT at 90%). The verdict must use the SAME difficulty the Scorer accumulated `on` with
 * (its perfectSemis decides what counted as on pitch); the feed defaults to the scorer's own.
 */

import { difficultyOf } from "./scoring.js";

export const VERDICTS = Object.freeze(["perfect", "excellent", "great", "good", "miss"]);
export const VERDICT_LABEL = Object.freeze({
  perfect: "PERFECT", excellent: "EXCELLENT", great: "GREAT", good: "GOOD", miss: "MISS",
});
/** Notes shorter than this are scored but never judged or shown. */
export const MIN_NOTE_SEC = 0.12;

/** A backwards jump larger than this (seconds) is a seek. */
const SEEK_BACK_SEC = 1;
/** Float slack on every threshold comparison. */
const EPS = 1e-9;

const num = (v) => (Number.isFinite(v) ? v : 0);

/**
 * @param {{len:number, voiced:number, on:number, err:number}} stats
 * @param {{perfectSemis:number, clear:number}} d   a difficulty (scoring.js DIFFICULTIES entry)
 * @returns {"perfect"|"excellent"|"great"|"good"|"miss"|null}   null when stats.len < MIN_NOTE_SEC
 */
export function judgeNote(stats, d) {
  if (!stats) return null;
  const len = Number(stats.len);
  if (!(len >= MIN_NOTE_SEC)) return null;          // also NaN / missing: not judged
  const lvl = difficultyOf(d);
  const voiced = num(stats.voiced);
  if (!(voiced > 0)) return "miss";                 // never sung
  const cov = voiced / len;
  const on = num(stats.on) / voiced;
  const err = num(stats.err) / voiced / lvl.perfectSemis;
  if (cov < 0.15 - EPS || on < lvl.clear - EPS) return "miss";
  if (cov >= 0.5 - EPS && on >= 0.90 - EPS && err <= 0.40 + EPS) return "perfect";
  if (cov >= 0.5 - EPS && on >= 0.80 - EPS && err <= 0.70 + EPS) return "excellent";
  if (on >= Math.min(0.99, lvl.clear + 0.20) - EPS) return "great";
  return "good";
}

/**
 * Emits each judged note exactly once, in note order, once t ≥ note.end + graceSec.
 * @param {object} o
 * @param {import("./scoring.js").Scorer} o.scorer   reads scorer.notes (each {start, end, …}) + noteStats(i)
 * @param {string|object} o.difficulty   a name ("easy"|"normal"|"hard") or a DIFFICULTIES entry
 * @param {(verdict: string, index: number) => void} [o.onVerdict]
 * @param {number} [o.graceSec]
 * @returns {{ update(t:number): number, tally(): {perfect:number, excellent:number, great:number, good:number, miss:number}, reset(): void }}
 *   update(t) returns how many verdicts it emitted in this call. Notes under MIN_NOTE_SEC are skipped
 *   (not tallied). A backwards jump of more than 1 s (a seek) moves the emit pointer to the first note
 *   ending after t and KEEPS the tally — nothing is ever counted twice. reset() zeroes the tally and
 *   the pointer.
 *
 * Lane A notes (additions, nothing removed):
 *   - `difficulty` omitted (undefined/null) → the scorer's own (`scorer.difficulty`), else "normal".
 *   - update(Infinity) flushes: every remaining note is judged now (call it at the end of a song, before
 *     tally(), so the last notes — the clock stops short of their end + grace — are counted). NaN → 0.
 *   - A note already emitted is never emitted again, even after a backward seek re-walks it (so a
 *     rewound passage shows no new verdicts until it passes the furthest point judged). reset() is the
 *     only way to judge notes again.
 *   - State is committed before onVerdict runs, so a throwing callback cannot double count.
 */
export function createVerdictFeed({ scorer, difficulty, onVerdict = () => {}, graceSec = 0.15 } = {}) {
  const notes = scorer && Array.isArray(scorer.notes) ? scorer.notes : [];
  const lvl = difficultyOf(difficulty ?? (scorer ? scorer.difficulty : undefined));
  const grace = Number.isFinite(graceSec) && graceSec >= 0 ? graceSec : 0.15;
  const emit = typeof onVerdict === "function" ? onVerdict : () => {};
  const done = new Uint8Array(notes.length);   // 1 = handled (judged, or too short to judge)
  let counts, ptr, lastT;

  function reset() {
    counts = { perfect: 0, excellent: 0, great: 0, good: 0, miss: 0 };
    ptr = 0;
    lastT = null;
    done.fill(0);
  }
  reset();

  /** The first note not yet due at t (its end + grace is still ahead). */
  function firstDueAfter(t) {
    let lo = 0, hi = notes.length;
    // Notes are sorted by start; a melody's ends are sorted with them except where notes overlap,
    // which is why `done` (not the pointer) is what guarantees "once".
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (notes[mid].end + grace <= t) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  function update(t) {
    if (typeof t !== "number" || Number.isNaN(t)) return 0;
    if (lastT !== null && t < lastT - SEEK_BACK_SEC) ptr = Math.min(ptr, firstDueAfter(t));
    lastT = t;
    let emitted = 0;
    while (ptr < notes.length && t >= notes[ptr].end + grace) {
      const i = ptr++;
      if (done[i]) continue;
      done[i] = 1;
      const v = judgeNote(scorer.noteStats(i), lvl);
      if (v === null) continue;                  // too short: scored, never judged or shown
      counts[v]++;
      emitted++;
      emit(v, i);
    }
    return emitted;
  }

  function tally() {
    return { perfect: counts.perfect, excellent: counts.excellent, great: counts.great, good: counts.good, miss: counts.miss };
  }

  return { update, tally, reset };
}
