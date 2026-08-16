/*
 * scoring.js — the videoke score. PURE (no DOM, no timers, no audio) → unit-tested.
 *
 * In a Filipino living room the score IS the event: the fanfare, the 96, and the argument
 * about whether the machine is lying. This module is the part every karaoke game has to
 * hand-author and we get for free: UltraStar-family games ship a per-note reference melody
 * inside the song file, and `melody.js extractMelody()` already derives exactly that shape
 * from the KAR file's guide track. Feed it frames from the mic pitch detector and it scores.
 *
 * The design follows Performous/UltraStar, whose hard-won lessons are all about FEEL:
 *
 *   1. OCTAVE-INVARIANT. Singing the right pitch class an octave down is correct singing.
 *      A naive absolute comparison punishes every man singing a woman's line and vice versa,
 *      which is most of the room.
 *   2. DECAY, NOT A THRESHOLD. Credit falls off smoothly with distance instead of a binary
 *      hit/miss. Thresholds feel punishing and make the number twitchy.
 *   3. PER NOTE, TIME-WEIGHTED. A note's score is the mean credit of its frames, and long
 *      notes count for more — so holding a pitch beats stabbing at it and drifting off.
 *   4. SILENCE IS NEUTRAL. Frames with no detected pitch score neither for nor against; you
 *      must be allowed to breathe. (A note you never sing at all still scores 0 — that part
 *      is fair.)
 *   5. GOLDEN NOTES. The hooks count double. UltraStar has an author mark them; we take the
 *      longest notes, which is very nearly the same set.
 *   6. GENEROUS CURVE, HIGH CEILING. The raw ratio is bent upward before display, and the
 *      band messages are Magic Sing's own. Videoke rewards participation; a scoring system
 *      that makes people feel bad is a broken scoring system, however accurate it is.
 */

/** Full credit within this many semitones of the target. */
export const PERFECT_SEMIS = 0.5;
/** No credit at or beyond this many semitones. Linear decay in between. */
export const ZERO_AT_SEMIS = 2.5;
/** Share of notes (longest first) treated as "golden" hooks. */
export const GOLDEN_FRACTION = 0.15;
/** Weight multiplier for a golden note. */
export const GOLDEN_WEIGHT = 2;

/**
 * Signed semitone error between a sung note and a target, folded to ±6 so the octave
 * doesn't matter. e.g. singing C3 against C5 → 0.
 */
export function foldSemitones(sungMidi, targetMidi) {
  let d = (sungMidi - targetMidi) % 12;
  if (d > 6) d -= 12;
  else if (d < -6) d += 12;
  return d === 0 ? 0 : d;   // normalise -0 (an exact octave gives -12 % 12 === -0)
}

/** Credit for one frame: 1 inside the perfect window, decaying linearly to 0. */
export function pitchCredit(errSemis) {
  const e = Math.abs(errSemis);
  if (!Number.isFinite(e)) return 0;
  if (e <= PERFECT_SEMIS) return 1;
  if (e >= ZERO_AT_SEMIS) return 0;
  return 1 - (e - PERFECT_SEMIS) / (ZERO_AT_SEMIS - PERFECT_SEMIS);
}

/**
 * Pick the "golden" notes — the hooks worth double. UltraStar has a human mark these; the
 * longest notes of a melody are very nearly the same set (held notes are what a room hears).
 * Returns an array of booleans aligned to `notes`.
 */
export function markGolden(notes, fraction = GOLDEN_FRACTION) {
  const out = new Array(notes.length).fill(false);
  if (!notes.length || fraction <= 0) return out;
  const n = Math.max(1, Math.min(Math.floor(notes.length / 2), Math.round(notes.length * fraction)));
  const byLen = notes
    .map((note, i) => ({ i, len: note.end - note.start }))
    .sort((a, b) => b.len - a.len || a.i - b.i);
  for (let k = 0; k < n; k++) out[byLen[k].i] = true;
  return out;
}

/**
 * Bend the raw 0–1 ratio into a 0–100 score. Deliberately generous below the top: an
 * exponent under 1 lifts the middle, so an honest amateur lands in the 70s–80s and feels
 * invited back, while the 96+ band still has to be earned.
 */
export function curveScore(raw) {
  const r = Math.max(0, Math.min(1, Number(raw) || 0));
  return Math.round(Math.pow(r, 0.72) * 100);
}

/**
 * The band messages, taken from Magic Sing's published bands so the machine our users grew
 * up with and this app agree about what a 90 means.
 */
export function scoreBand(score) {
  const s = Math.max(0, Math.min(100, Math.round(Number(score) || 0)));
  if (s >= 96) return { tier: "excellent", label: "Excellent singing!" };
  if (s >= 86) return { tier: "good", label: "Good job!" };
  if (s >= 71) return { tier: "ok", label: "Not bad!" };
  if (s >= 10) return { tier: "meh", label: "You need more effort" };
  return { tier: "none", label: "Try singing?" };
}

/**
 * Accumulates frames against a melody. One instance per song.
 *
 * Frames arrive from the rAF loop at whatever rate the display runs, which is close enough
 * to uniform that a plain mean over a note's frames IS the time-weighted mean. Notes are
 * weighted by their own duration, so the aggregate is time-weighted across the song too.
 */
export class Scorer {
  /**
   * @param {{note:number,start:number,end:number}[]} notes  the guide melody (extractMelody)
   * @param {{golden?:boolean, goldenFraction?:number}} opts
   */
  constructor(notes, opts = {}) {
    this.notes = (Array.isArray(notes) ? notes : [])
      .filter((n) => n && Number.isFinite(n.note) && n.end > n.start)
      .sort((a, b) => a.start - b.start);
    this.golden = opts.golden === false
      ? new Array(this.notes.length).fill(false)
      : markGolden(this.notes, opts.goldenFraction);
    this._sum = new Float64Array(this.notes.length);
    this._cnt = new Float64Array(this.notes.length);
    this._voicedFrames = 0;
    this._lastT = 0;
  }

  get hasMelody() { return this.notes.length > 0; }
  /** True once the singer has actually produced pitch on at least one melody note. */
  get attempted() { return this._voicedFrames > 0; }

  /** Index of the melody note covering time `t`, or -1 between phrases. Binary search. */
  noteIndexAt(t) {
    const a = this.notes;
    let lo = 0, hi = a.length - 1, best = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (a[mid].start <= t) { best = mid; lo = mid + 1; }
      else hi = mid - 1;
    }
    return best >= 0 && t <= a[best].end ? best : -1;
  }

  /**
   * Fold one frame in. `micMidi` may be null/undefined for an unvoiced frame — that still
   * advances the clock (so the live score keeps up) but scores nothing either way.
   * @returns the note index credited, or -1.
   */
  addFrame(t, micMidi) {
    if (Number.isFinite(t)) this._lastT = t;
    if (micMidi == null || !Number.isFinite(micMidi)) return -1;
    const i = this.noteIndexAt(t);
    if (i < 0) return -1;
    this._voicedFrames++;
    this._cnt[i]++;
    this._sum[i] += pitchCredit(foldSemitones(micMidi, this.notes[i].note));
    return i;
  }

  /** Mean credit on one note (0 when it was never sung). */
  noteRatio(i) { return this._cnt[i] ? this._sum[i] / this._cnt[i] : 0; }

  _weight(i) {
    const n = this.notes[i];
    return (n.end - n.start) * (this.golden[i] ? GOLDEN_WEIGHT : 1);
  }

  /**
   * Weighted ratio over notes that have already gone by (`upTo`, default the last frame's
   * time). Live scoring must not divide by the whole song or the number crawls up from 0
   * all night; the final score passes Infinity to include everything.
   */
  ratio(upTo = this._lastT) {
    let num = 0, den = 0;
    for (let i = 0; i < this.notes.length; i++) {
      if (this.notes[i].start > upTo) break;   // notes are sorted
      const w = this._weight(i);
      den += w;
      num += w * this.noteRatio(i);
    }
    return den ? num / den : 0;
  }

  /** Live 0–100 for the on-screen readout. */
  liveScore() { return curveScore(this.ratio()); }

  /**
   * Mean credit over the notes inside a time window — the per-line bonus. Returns null when
   * the window contains no melody (an instrumental break shouldn't rate the singer).
   */
  windowRatio(from, to) {
    let num = 0, den = 0;
    for (let i = 0; i < this.notes.length; i++) {
      const n = this.notes[i];
      if (n.end < from) continue;
      if (n.start > to) break;
      if (!this._cnt[i]) { den += this._weight(i); continue; } // sung nothing here → counts as 0
      const w = this._weight(i);
      den += w;
      num += w * this.noteRatio(i);
    }
    return den ? num / den : null;
  }

  /** Final result for the score card. `null` when there is nothing worth showing. */
  finish() {
    if (!this.hasMelody || !this.attempted) return null;
    const raw = this.ratio(Infinity);
    const score = curveScore(raw);
    let sung = 0;
    for (let i = 0; i < this.notes.length; i++) if (this._cnt[i]) sung++;
    return {
      score,
      raw,
      band: scoreBand(score),
      notes: this.notes.length,
      sung,
      golden: this.golden.filter(Boolean).length,
    };
  }
}
