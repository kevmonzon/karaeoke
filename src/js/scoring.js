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
 *
 * M9 adds DIFFICULTY (three built-in levels; "normal" IS the constants below, so the default
 * scores exactly as before) and per-note TIME-WEIGHTED stats for the verdicts (verdicts.js).
 * The stats sit beside the frame mean; they never change the score.
 */

/** Full credit within this many semitones of the target. */
export const PERFECT_SEMIS = 0.5;
/** No credit at or beyond this many semitones. Linear decay in between. */
export const ZERO_AT_SEMIS = 2.5;
/** Share of notes (longest first) treated as "golden" hooks. */
export const GOLDEN_FRACTION = 0.15;
/** Weight multiplier for a golden note. */
export const GOLDEN_WEIGHT = 2;
/** The score curve's exponent (the "normal" difficulty's curve). */
export const CURVE_EXPONENT = 0.72;
/** A frame's time weight is capped here, so a stall or a forward seek adds at most this. */
export const MAX_FRAME_SEC = 0.1;

/**
 * The three built-in difficulty levels (plan §5.16). `perfectSemis` is the tolerance (full
 * credit, and "on pitch" for the verdicts), `zeroAtSemis` where credit reaches 0, `clear` the
 * on-pitch share a note needs to avoid a MISS (verdicts.js; nothing in the score uses it), and
 * `curve` the exponent curveScore bends the raw ratio with. "normal" is today's numbers.
 */
export const DIFFICULTIES = Object.freeze({
  easy: Object.freeze({ perfectSemis: 0.75, zeroAtSemis: 3, clear: 0.40, curve: 0.60 }),
  normal: Object.freeze({ perfectSemis: PERFECT_SEMIS, zeroAtSemis: ZERO_AT_SEMIS, clear: 0.55, curve: CURVE_EXPONENT }),
  hard: Object.freeze({ perfectSemis: 0.35, zeroAtSemis: 2, clear: 0.70, curve: 0.90 }),
});

const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const isLevel = (d) => !!d && typeof d === "object"
  && Number.isFinite(d.perfectSemis) && d.perfectSemis > 0
  && Number.isFinite(d.zeroAtSemis) && d.zeroAtSemis > d.perfectSemis
  && Number.isFinite(d.clear) && d.clear >= 0 && d.clear <= 1
  && Number.isFinite(d.curve) && d.curve > 0;

/**
 * A difficulty by name ("easy" | "normal" | "hard"), or an entry object as-is. Anything else —
 * an unknown name, "__proto__"/"constructor" (own-property lookup only), a malformed object,
 * null — is "normal", so a bad stored setting can never break scoring.
 */
export function difficultyOf(name) {
  if (typeof name === "string") return own(DIFFICULTIES, name) ? DIFFICULTIES[name] : DIFFICULTIES.normal;
  return isLevel(name) ? name : DIFFICULTIES.normal;
}

/** The name a difficulty is reported under: its DIFFICULTIES key, else "custom". */
function levelName(requested, level) {
  if (typeof requested === "string" && own(DIFFICULTIES, requested)) return requested;
  for (const k of Object.keys(DIFFICULTIES)) if (DIFFICULTIES[k] === level) return k;
  return "custom";
}

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

/**
 * Credit for one frame: 1 inside the perfect window, decaying linearly to 0. `d` is a
 * difficulty (an entry or a name, see difficultyOf); omitted it is "normal" = the old numbers.
 */
export function pitchCredit(errSemis, d = DIFFICULTIES.normal) {
  return creditFor(Math.abs(errSemis), difficultyOf(d));
}

function creditFor(e, d) {
  if (!Number.isFinite(e)) return 0;
  if (e <= d.perfectSemis) return 1;
  if (e >= d.zeroAtSemis) return 0;
  return 1 - (e - d.perfectSemis) / (d.zeroAtSemis - d.perfectSemis);
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
 * invited back, while the 96+ band still has to be earned. `exponent` is a difficulty's
 * `curve`; omitted (or not a positive number) it is 0.72, the curve every score used before M9.
 */
export function curveScore(raw, exponent = CURVE_EXPONENT) {
  const r = Math.max(0, Math.min(1, Number(raw) || 0));
  const k = Number.isFinite(exponent) && exponent > 0 ? exponent : CURVE_EXPONENT;
  return Math.round(Math.pow(r, k) * 100);
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
 *
 * The verdicts need more than "close enough": a note's on-pitch TIME and its coverage. So each
 * voiced frame also adds its real elapsed time (dt since the previous frame, capped at
 * MAX_FRAME_SEC) to per-note sums — see noteStats(). Those sums are separate from the frame
 * mean above, which is what every score is still computed from.
 */
export class Scorer {
  /**
   * @param {{note:number,start:number,end:number}[]} notes  the guide melody (extractMelody)
   * @param {{golden?:boolean, goldenFraction?:number, difficulty?:string|object}} opts
   *   difficulty: a DIFFICULTIES name or entry (default "normal" = the pre-M9 score exactly).
   */
  constructor(notes, opts = {}) {
    const o = opts || {};
    this.notes = (Array.isArray(notes) ? notes : [])
      .filter((n) => n && Number.isFinite(n.note) && n.end > n.start)
      .sort((a, b) => a.start - b.start);
    this.golden = o.golden === false
      ? new Array(this.notes.length).fill(false)
      : markGolden(this.notes, o.goldenFraction);
    const requested = o.difficulty === undefined ? "normal" : o.difficulty;
    this._d = difficultyOf(requested);
    this._dName = levelName(requested, this._d);
    this._sum = new Float64Array(this.notes.length);
    this._cnt = new Float64Array(this.notes.length);
    this._voiced = new Float64Array(this.notes.length);   // seconds with a detected pitch
    this._on = new Float64Array(this.notes.length);       // …of which within perfectSemis
    this._err = new Float64Array(this.notes.length);      // Σ |folded error| · dt (semitone-seconds)
    this._voicedFrames = 0;
    this._lastT = 0;
    this._prevT = null;   // the previous frame's time (any frame, voiced or not); null = none yet
  }

  get hasMelody() { return this.notes.length > 0; }
  /** True once the singer has actually produced pitch on at least one melody note. */
  get attempted() { return this._voicedFrames > 0; }
  /** The difficulty this scorer scores with — a frozen DIFFICULTIES entry (or a custom one). */
  get difficulty() { return this._d; }
  /** Its name: "easy" | "normal" | "hard" (an unknown name fell back to "normal"), or "custom". */
  get difficultyName() { return this._dName; }

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
   * A voiced frame on a note also adds dt = clamp(t − previous frame's t, 0, MAX_FRAME_SEC) to
   * that note's time-weighted stats (a backward seek adds 0; a stall or forward seek ≤ 0.1 s).
   * @returns the note index credited, or -1.
   */
  addFrame(t, micMidi) {
    let dt = 0;
    if (Number.isFinite(t)) {
      if (this._prevT !== null) dt = Math.min(MAX_FRAME_SEC, Math.max(0, t - this._prevT));
      this._prevT = t;
      this._lastT = t;
    }
    if (micMidi == null || !Number.isFinite(micMidi)) return -1;
    const i = this.noteIndexAt(t);
    if (i < 0) return -1;
    const e = Math.abs(foldSemitones(micMidi, this.notes[i].note));
    this._voicedFrames++;
    this._cnt[i]++;
    this._sum[i] += creditFor(e, this._d);
    this._voiced[i] += dt;
    if (e <= this._d.perfectSemis) this._on[i] += dt;
    this._err[i] += e * dt;
    return i;
  }

  /** Mean credit on one note (0 when it was never sung). */
  noteRatio(i) { return this._cnt[i] ? this._sum[i] / this._cnt[i] : 0; }

  /**
   * Time-weighted stats of one note, for its verdict (verdicts.js judgeNote):
   * `len` = end − start, `voiced` = seconds sung (with a detected pitch) while it was the
   * note, `on` = of those, seconds within the difficulty's perfectSemis, `err` = Σ |folded
   * error| · dt in semitone-seconds (err / voiced = the mean absolute error). An index with no
   * note gives all zeros. A fresh object each call.
   */
  noteStats(i) {
    const n = this.notes[i];
    if (!n) return { len: 0, voiced: 0, on: 0, err: 0 };
    return { len: n.end - n.start, voiced: this._voiced[i], on: this._on[i], err: this._err[i] };
  }

  _weight(i) {
    const n = this.notes[i];
    return (n.end - n.start) * (this.golden[i] ? GOLDEN_WEIGHT : 1);
  }

  /** The time of the last frame folded in (song seconds, already shifted by the mic latency). A
   *  per-line rating waits for this to pass the line's end, or the line's last notes are unscored. */
  get clock() { return this._lastT; }

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
  liveScore() { return curveScore(this.ratio(), this._d.curve); }

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

  /**
   * Final result for the score card. `null` when there is nothing worth showing.
   * `difficulty` is the level actually scored with (its name — see difficultyName).
   */
  finish() {
    if (!this.hasMelody || !this.attempted) return null;
    const raw = this.ratio(Infinity);
    const score = curveScore(raw, this._d.curve);
    let sung = 0;
    for (let i = 0; i < this.notes.length; i++) if (this._cnt[i]) sung++;
    return {
      score,
      raw,
      band: scoreBand(score),
      notes: this.notes.length,
      sung,
      golden: this.golden.filter(Boolean).length,
      difficulty: this._dName,
    };
  }
}
