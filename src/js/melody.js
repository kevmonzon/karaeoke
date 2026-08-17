/*
 * melody.js — extract the guide melody from a parsed MIDI and render it as a
 * scrolling pitch guide (piano-roll), optionally overlaying the singer's live
 * detected pitch and a score.
 *
 * Melody-channel detection is heuristic (karaoke MIDIs put the tune on a guide
 * channel — often ch.4 in the Tune 1000 / KAR convention):
 *   +ch.4  +track-name match  +onsets aligning with lyric events  +monophonic
 *   −drums (ch.10)
 * A manual channel override (config guide.channel ≥ 0) wins when set.
 */

// --- pitch helpers (shared with mic.js) -------------------------------------
// Note: the autocorrelation pitch detector lives in workers/pitch-worker.js (off the
// main thread). mic.js posts buffers there and reads the cached result via hzToMidi below.

export function hzToMidi(hz) {
  return 69 + 12 * Math.log2(hz / 440);
}

// --- key detection ----------------------------------------------------------

const KEY_NAMES = ["C", "C♯", "D", "D♯", "E", "F", "F♯", "G", "G♯", "A", "A♯", "B"];
// Krumhansl-Schmuckler key profiles
const KS_MAJ = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const KS_MIN = [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];

function pearson(a, b) {
  const n = 12;
  let sa = 0, sb = 0;
  for (let i = 0; i < n; i++) { sa += a[i]; sb += b[i]; }
  const ma = sa / n, mb = sb / n;
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < n; i++) { const x = a[i] - ma, y = b[i] - mb; num += x * y; da += x * x; db += y * y; }
  return num / Math.sqrt(da * db || 1);
}

export function keyName(pc, mode, short = false) {
  const n = KEY_NAMES[((pc % 12) + 12) % 12];
  return short ? `${n} ${mode === "minor" ? "min" : "maj"}` : `${n} ${mode}`;
}

/**
 * Detect the song's key. Prefers an explicit (non-default) Key Signature meta,
 * else a Krumhansl-Schmuckler pitch-class-histogram correlation over all notes.
 * @returns { keyPc, mode:"major"|"minor", confidence, source:"metadata"|"analysis"|"none" }
 */
export function detectKey(parsed) {
  const m = parsed.keySig;
  if (m && (m.sf !== 0 || m.mi !== 0)) {
    const pc = m.mi ? (((m.sf * 7 + 9) % 12) + 12) % 12 : (((m.sf * 7) % 12) + 12) % 12;
    return { keyPc: pc, mode: m.mi ? "minor" : "major", confidence: 1, source: "metadata" };
  }
  // duration-weighted pitch-class histogram (skip drums ch.10)
  const h = new Array(12).fill(0);
  const active = {};
  for (const e of parsed.noteEvents || []) {
    if (e.chan === 9) continue;
    const k = e.chan * 128 + e.note;
    if (e.on) active[k] = e.tick;
    else if (active[k] != null) { h[e.note % 12] += Math.max(1, e.tick - active[k]); active[k] = null; }
  }
  if (h.reduce((a, b) => a + b, 0) <= 0) return { keyPc: 0, mode: "major", confidence: 0, source: "none" };

  let best = { keyPc: 0, mode: "major", score: -2 };
  for (let r = 0; r < 12; r++) {
    const rot = h.slice(r).concat(h.slice(0, r));
    const cM = pearson(rot, KS_MAJ), cm = pearson(rot, KS_MIN);
    if (cM > best.score) best = { keyPc: r, mode: "major", score: cM };
    if (cm > best.score) best = { keyPc: r, mode: "minor", score: cm };
  }
  return { keyPc: best.keyPc, mode: best.mode, confidence: +best.score.toFixed(3), source: "analysis" };
}

// --- auto-tune: snap a detected note to a target ----------------------------

export const SCALES = {
  major: [0, 2, 4, 5, 7, 9, 11],
  minor: [0, 2, 3, 5, 7, 8, 10],
  pentatonic: [0, 2, 4, 7, 9],
  chromatic: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
};

function snapToPitchClasses(m, pcSet) {
  let best = null, bd = Infinity;
  for (let n = Math.floor(m) - 2; n <= Math.ceil(m) + 2; n++) {
    const pc = ((n % 12) + 12) % 12;
    if (pcSet.has(pc)) {
      const d = Math.abs(n - m);
      if (d < bd) { bd = d; best = n; }
    }
  }
  return best == null ? Math.round(m) : best;
}

/**
 * Corrected note for a detected (float) MIDI pitch.
 *   mode "melody"    → snap to the nearest octave of the target melody note's pitch class
 *   mode "scale"     → snap to the nearest note in key+scale
 *   mode "chromatic" → snap to the nearest semitone
 */
export function snapNote(detected, { mode, targetMidi = null, key = 0, scale = "major" }) {
  if (mode === "melody") {
    if (targetMidi == null) return detected; // no target → leave alone
    return snapToPitchClasses(detected, new Set([((targetMidi % 12) + 12) % 12]));
  }
  if (mode === "scale") {
    const pcs = new Set((SCALES[scale] || SCALES.major).map((i) => (i + key) % 12));
    return snapToPitchClasses(detected, pcs);
  }
  return Math.round(detected); // chromatic
}

// --- melody extraction ------------------------------------------------------

function nearestDist(sortedTimes, x) {
  if (!sortedTimes.length) return Infinity;
  let lo = 0, hi = sortedTimes.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sortedTimes[mid] < x) lo = mid + 1; else hi = mid;
  }
  let best = Math.abs(sortedTimes[lo] - x);
  if (lo > 0) best = Math.min(best, Math.abs(sortedTimes[lo - 1] - x));
  return best;
}

const EMPTY = { hasMelody: false, notes: [], channel: -1, range: { min: 60, max: 72 } };

// Pair Note On/Off within one (track,channel) group → [{note,startTick,endTick}].
// Drops zero-length notes and out-of-vocal-range garbage (very low control notes).
function pairNotes(events) {
  const evs = events.slice().sort((a, b) => a.tick - b.tick);
  const active = new Map();
  const out = [];
  const close = (note, st, end) => { if (end > st && note >= 24 && note <= 96) out.push({ note, startTick: st, endTick: end }); };
  for (const e of evs) {
    if (e.on) {
      if (active.has(e.note)) close(e.note, active.get(e.note), e.tick);
      active.set(e.note, e.tick);
    } else if (active.has(e.note)) {
      close(e.note, active.get(e.note), e.tick);
      active.delete(e.note);
    }
  }
  return out;
}

// Score a candidate (track,channel) group as "the melody".
function scoreGroup(notes, name, chan, lyricTimes, tickToSec) {
  const nums = notes.map((n) => n.note).sort((a, b) => a - b);
  const median = nums[nums.length >> 1];
  // polyphony: overlapping notes (melody is mostly monophonic)
  const byStart = notes.slice().sort((a, b) => a.startTick - b.startTick);
  let overlaps = 0;
  for (let i = 1; i < byStart.length; i++) if (byStart[i].startTick < byStart[i - 1].endTick) overlaps++;
  const polyRatio = overlaps / notes.length;
  // lyric correlation
  let corr = 0;
  if (lyricTimes.length) {
    let hits = 0;
    for (const n of notes) if (nearestDist(lyricTimes, tickToSec(n.startTick)) < 0.25) hits++;
    corr = hits / notes.length;
  }
  let score = 0;
  if (/melod|vocal|voice|lead|sing|guide|tune/.test(name)) score += 5;
  if (chan === 3) score += 2; // ch.4 (1-based) convention
  score += 4 * corr;
  score += (1 - polyRatio) * 3; // reward monophonic
  if (median >= 50 && median <= 80) score += 2;
  else if (median < 40 || median > 88) score -= 3;
  if (notes.length > 15 && notes.length < 1500) score += 1;
  return score;
}

function finalize(cand, tickToSec) {
  let min = 127, max = 0;
  for (const n of cand.notes) {
    n.start = tickToSec(n.startTick);
    n.end = tickToSec(n.endTick);
    if (n.note < min) min = n.note;
    if (n.note > max) max = n.note;
  }
  cand.notes.sort((a, b) => a.start - b.start);
  return { hasMelody: true, channel: cand.chan, track: cand.track, notes: cand.notes, range: { min: min - 2, max: max + 2 } };
}

/**
 * Group notes by (track, channel), pair each group, score them, pick the melody.
 * channelOverride ≥ 0 forces that channel (largest matching group).
 * @returns { hasMelody, channel, notes:[{note,start,end}], range:{min,max} }
 */
export function extractMelody(parsed, tickToSec, channelOverride = -1) {
  if (!parsed.noteEvents || !parsed.noteEvents.length) return { ...EMPTY };

  const groups = new Map();
  for (const e of parsed.noteEvents) {
    const key = e.track * 16 + e.chan;
    let g = groups.get(key);
    if (!g) { g = { track: e.track, chan: e.chan, events: [] }; groups.set(key, g); }
    g.events.push(e);
  }
  const lyricTimes = (parsed.lyricEvents || []).map((l) => tickToSec(l.tick)).sort((a, b) => a - b);

  const candidates = [];
  for (const g of groups.values()) {
    if (g.chan === 9) continue; // drums
    const notes = pairNotes(g.events);
    if (notes.length < 8) continue;
    const name = (parsed.trackNames[g.track] || "").toLowerCase();
    const score = scoreGroup(notes, name, g.chan, lyricTimes, tickToSec);
    candidates.push({ track: g.track, chan: g.chan, notes, score });
  }
  if (!candidates.length) return { ...EMPTY };

  if (channelOverride >= 0) {
    const ov = candidates.filter((c) => c.chan === channelOverride).sort((a, b) => b.notes.length - a.notes.length)[0];
    if (ov) return finalize(ov, tickToSec);
  }
  candidates.sort((a, b) => b.score - a.score);
  return finalize(candidates[0], tickToSec);
}

// --- pitch-guide renderer ---------------------------------------------------

const NOW_FRAC = 0.28; // "now" line position (fraction from left)

export class PitchGuide {
  constructor(canvas, settings) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.settings = settings;
    this.melody = null;
    this.dpr = 1;
    this.w = 0;
    this.h = 0;
    this.score = null;
    this.trail = []; // recent {t, midi} detected-pitch samples
    window.addEventListener("resize", () => this.resize());
  }

  load(melody) {
    this.melody = melody;
    this.trail = [];
    this.resize();
  }

  setScore(pct) { this.score = pct; }

  resize() {
    const dpr = window.devicePixelRatio || 1;
    const rect = this.canvas.getBoundingClientRect();
    this.dpr = dpr;
    this.w = rect.width;
    this.h = rect.height;
    this.canvas.width = Math.max(1, Math.floor(rect.width * dpr));
    this.canvas.height = Math.max(1, Math.floor(rect.height * dpr));
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  _yFor(note) {
    const r = this.melody.range;
    const span = Math.max(4, r.max - r.min);
    const pad = 14;
    return pad + (1 - (note - r.min) / span) * (this.h - 2 * pad);
  }

  /** Melody note number active at time t (or null). Binary search: this runs twice per frame
   *  (the rAF loop asks directly, and update() asks again via isClose), and a linear walk from
   *  index 0 through a few hundred notes every time is the kind of cost that only shows up on
   *  the slowest machine in the room. LyricsEngine and ChordEngine already search this way. */
  targetNoteAt(t) {
    const a = this.melody && this.melody.notes;
    if (!a || !a.length) return null;
    let lo = 0, hi = a.length - 1, best = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (a[mid].start <= t) { best = mid; lo = mid + 1; }
      else hi = mid - 1;
    }
    return best >= 0 && t <= a[best].end ? a[best].note : null;
  }

  /** Draw. micMidi = live detected note (float) or null. */
  update(t, micMidi = null) {
    const ctx = this.ctx;
    if (!this.w) this.resize();
    ctx.clearRect(0, 0, this.w, this.h);
    if (!this.melody || !this.melody.hasMelody) {
      ctx.fillStyle = "#8b93ab";
      ctx.font = "13px system-ui, sans-serif";
      ctx.textAlign = "center";
      ctx.fillText("no guide melody detected in this file", this.w / 2, this.h / 2);
      return;
    }

    const win = this.settings.get("guide.windowSec") || 5;
    const tStart = t - win * NOW_FRAC;
    const tEnd = t + win * (1 - NOW_FRAC);
    const xFor = (time) => ((time - tStart) / win) * this.w;
    const nowX = NOW_FRAC * this.w;

    // faint horizontal gridlines every octave
    const r = this.melody.range;
    ctx.strokeStyle = "rgba(255,255,255,0.05)";
    ctx.lineWidth = 1;
    for (let nn = Math.ceil(r.min / 12) * 12; nn <= r.max; nn += 12) {
      const y = this._yFor(nn);
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(this.w, y); ctx.stroke();
    }

    // note bars
    const barH = Math.max(6, (this.h - 28) / Math.max(6, r.max - r.min) * 1.1);
    for (const n of this.melody.notes) {
      if (n.end < tStart || n.start > tEnd) continue;
      const x1 = xFor(n.start), x2 = xFor(n.end);
      const y = this._yFor(n.note);
      const active = n.start <= t && t <= n.end;
      const past = n.end < t;
      ctx.fillStyle = active ? "#ffd23f" : past ? "rgba(123,132,160,0.5)" : "#37e0c8";
      roundRect(ctx, x1, y - barH / 2, Math.max(3, x2 - x1), barH, Math.min(barH / 2, 6));
      ctx.fill();
      if (active) { ctx.shadowColor = "rgba(255,210,63,.6)"; ctx.shadowBlur = 12; ctx.fill(); ctx.shadowBlur = 0; }
    }

    // fold a detected pitch into the melody's octave range for readability
    const fold = (m) => {
      let s = m;
      while (s < r.min - 1 && s + 12 <= r.max + 1) s += 12;
      while (s > r.max + 1 && s - 12 >= r.min - 1) s -= 12;
      return s;
    };
    const isClose = (m) => {
      const target = this.targetNoteAt(t);
      if (target == null) return false;
      let pc = (((m - target) % 12) + 12) % 12;
      if (pc > 6) pc = 12 - pc;
      return pc < 1.2;
    };

    // record + draw the soft vocal trail (aligned to the melody timeline)
    const trailOn = this.settings.get("guide.trail");
    if (this.trail.length && t < this.trail[this.trail.length - 1].t - 0.1) this.trail.length = 0; // seek-back
    while (this.trail.length && this.trail[0].t < t - win) this.trail.shift(); // prune to window
    if (trailOn && micMidi != null && isFinite(micMidi)) this.trail.push({ t, midi: fold(micMidi) });
    if (trailOn && this.trail.length > 1) this._drawTrail(t, win, xFor, nowX);

    // now line
    ctx.strokeStyle = "#ff3d81";
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(nowX, 0); ctx.lineTo(nowX, this.h); ctx.stroke();

    // singer pitch dot
    if (micMidi != null && isFinite(micMidi)) {
      ctx.fillStyle = isClose(micMidi) ? "#5dff9b" : "#ffffff";
      ctx.shadowColor = "rgba(255,255,255,.5)"; ctx.shadowBlur = 8;
      ctx.beginPath();
      ctx.arc(nowX, this._yFor(fold(micMidi)), 7, 0, Math.PI * 2);
      ctx.fill();
      ctx.shadowBlur = 0;
    }

    // score
    if (this.score != null) {
      ctx.fillStyle = "#eef2ff";
      ctx.font = "600 14px system-ui, sans-serif";
      ctx.textAlign = "left";
      ctx.fillText(`Score ${Math.round(this.score)}%`, 12, 22);
    }
  }

  // A soft glowing ribbon of recent sung pitch, fading toward the past (left).
  _drawTrail(t, win, xFor, nowX) {
    const ctx = this.ctx;
    const grad = ctx.createLinearGradient(xFor(t - win), 0, nowX, 0);
    grad.addColorStop(0, "rgba(55,224,200,0)");
    grad.addColorStop(1, "rgba(55,224,200,0.95)");
    const path = () => {
      ctx.beginPath();
      let started = false;
      for (let i = 0; i < this.trail.length; i++) {
        const p = this.trail[i];
        if (i > 0 && p.t - this.trail[i - 1].t > 0.14) started = false; // break over silence
        const x = xFor(p.t), y = this._yFor(p.midi);
        if (!started) { ctx.moveTo(x, y); started = true; } else ctx.lineTo(x, y);
      }
    };
    ctx.save();
    ctx.lineCap = "round"; ctx.lineJoin = "round"; ctx.strokeStyle = grad;
    ctx.shadowColor = "rgba(55,224,200,0.6)";
    ctx.globalAlpha = 0.35; ctx.lineWidth = 9; ctx.shadowBlur = 14; path(); ctx.stroke(); // halo
    ctx.globalAlpha = 0.95; ctx.lineWidth = 3; ctx.shadowBlur = 6; path(); ctx.stroke(); // core
    ctx.restore();
  }
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
