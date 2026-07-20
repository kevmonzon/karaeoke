/*
 * chords.js — auto-detected guitar chords from a parsed MIDI, shown as a
 * tick-synced, horizontally-scrolling chord lane above the lyrics.
 *
 * Chords are NOT stored in these KAR files — we DERIVE them:
 *   - split the song into per-bar windows (from the Time Signature meta; 4/4 default)
 *   - build a duration-weighted 12-bin pitch-class chroma per bar from the HARMONY
 *     (all non-drum channels EXCEPT the detected melody — its passing tones pollute)
 *   - template-match a "guitar-simple" vocabulary (maj / min / dom7 / sus4), gated so
 *     an extension only wins when its defining tone actually sustains (kills flicker),
 *     biased toward the song's key (detectKey) and the bar's bass note (the root cue)
 *   - hold with hysteresis, then a light cosmetic polish (blip + sus absorption)
 *
 * Validated across 120 library files: ~94% produce a usable, melody-consistent chart
 * (median 61% of melody note-time lands on a chord tone, ~3× a wrong-key control),
 * averaging ~11 chords/song. Compute is a few ms — done once on load, like the key.
 *
 * The engine renders roots as PITCH CLASSES, so the Key/transpose control relabels
 * live for free (root + semitones), and the Simplify toggle collapses 7ths/sus to the
 * bare triad a strummer would play — both are display-only, no re-detection.
 */

import { makeTickToSeconds } from "./lyrics.js";
import { detectKey, extractMelody } from "./melody.js";

// Sharps, ASCII — conventional chord notation (Am, C#, F#).
const NOTE = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];

/** Render a chord label, shifted by `transpose` semitones (the Key control). */
export function chordLabel(root, suf, transpose = 0) {
  return NOTE[(((root + transpose) % 12) + 12) % 12] + suf;
}
/** Simplify a suffix to the bare triad a strummer plays: 7/sus4/"" → "" ; keep m. */
export function simplifySuffix(suf) {
  return suf === "m" ? "m" : "";
}
/** The third the key implies for a root, from its 7-note set: "" (major), "m" (minor), null (non-diatonic). */
export function diatonicThird(root, keySet) {
  const maj = (root + 4) % 12, min = (root + 3) % 12;
  if (keySet.has(maj) && !keySet.has(min)) return "";
  if (keySet.has(min) && !keySet.has(maj)) return "m";
  return null;
}
/**
 * Simplify-mode display suffix. When the chord was a THIRDLESS power chord (common in
 * rock/OPM guitar arrangements) and the key is confident, correct it to the triad the
 * KEY implies — so a bare E5 in D major reads `Em`, not the mis-heard `Esus4`. Otherwise
 * just collapse extensions to the bare triad. The faithful (non-simplify) view never calls
 * this, so the correction is strictly opt-in and can't regress the default.
 */
export function simplifiedSuffix(chord, keySet, keyConf) {
  if (chord.powerless && keyConf >= 0.80 && keySet) {
    const d = diatonicThird(chord.root, keySet);
    if (d != null) return d;
  }
  return simplifySuffix(chord.suf);
}
const MAJ = [0, 2, 4, 5, 7, 9, 11], MIN = [0, 2, 3, 5, 7, 8, 10];
const POWER = 0.10; // both thirds below this fraction of bar energy ⇒ a thirdless power chord

// Best diatonic 7-set from the detected chords' TONES (mode-independent). Using the actual
// chord tones — not just roots — lets the confident chords' thirds (C#, F#, G#…) pin the
// right set even when roots alone are ambiguous (A major vs C major both contain A-D-E).
// A power chord's third is ambiguous, so it only votes its root+fifth, never a third.
const IVALS = { "": [0, 4, 7], m: [0, 3, 7], "7": [0, 4, 7, 10], sus4: [0, 5, 7] };
function keySetFromChords(bars) {
  const h = new Array(12).fill(0);   // chord-tone mass
  const rootN = new Array(12).fill(0); // how often each pc is a chord root (tonal-centre cue)
  let firstRoot = -1, lastRoot = -1;
  for (const b of bars) {
    if (!b) continue;
    const use = b.powerless ? [0, 7] : (IVALS[b.suf] || [0, 4, 7]);
    for (const i of use) h[(b.root + i) % 12] += 1;
    rootN[b.root] += 1;
    if (firstRoot < 0) firstRoot = b.root;
    lastRoot = b.root;
  }
  // primary score: how much chord-tone mass falls inside the diatonic set at tonic t.
  const mass = new Array(12);
  let maxMass = -1;
  for (let t = 0; t < 12; t++) {
    let s = 0; for (const d of MAJ) s += h[(t + d) % 12];
    mass[t] = s; if (s > maxMass) maxMass = s;
  }
  // Fifth-related sets (e.g. C vs G major) differ by one note that may be absent, leaving the
  // mass tied → the key is genuinely AMBIGUOUS (G-Am-C-D fits both G major and C major). When
  // that happens we don't trust the set to infer a third (caller stands down) — else a G-major
  // song's V would flip to Dm. Among the near-best sets pick the most tonally-central tonic
  // anyway (most-frequent root + first/last-chord nudge), for the non-ambiguous callers.
  const cands = [];
  for (let t = 0; t < 12; t++) if (mass[t] >= maxMass - 1) cands.push(t);
  let bestT = cands[0], bestTie = -1;
  for (const t of cands) {
    const tie = rootN[t] + (t === firstRoot ? 1.5 : 0) + (t === lastRoot ? 1.5 : 0);
    if (tie > bestTie) { bestTie = tie; bestT = t; }
  }
  return { set: new Set(MAJ.map((d) => (bestT + d) % 12)), ambiguous: cands.length > 1 };
}

// "guitar-simple" vocabulary. char = the tone that MUST sustain for this label to be
// eligible (null = triad, always eligible) — this gate is what stops maj7/sus flicker.
const TEMPLATES = [
  { suf: "",     iv: [0, 4, 7],     char: null },
  { suf: "m",    iv: [0, 3, 7],     char: null },
  { suf: "7",    iv: [0, 4, 7, 10], char: 10 }, // dom7 (functional V)
  { suf: "sus4", iv: [0, 5, 7],     char: 5  },
];
const CHAR_GATE = 0.15;    // characteristic tone must hold this fraction of window energy
const ROOT_MARGIN = 0.10;  // a root change must beat the incumbent by this
const SUFFIX_MARGIN = 0.16; // a same-root suffix flip must beat it by more
const MIN_SCORE = 0.15;    // below this → "no chord" (N.C.)

function scoreOne(c, bassPc, diatonic, root, t) {
  if (t.char != null && c[(root + t.char) % 12] < CHAR_GATE) return -9;
  if (t.suf === "sus4" && (c[(root + 4) % 12] > 0.10 || c[(root + 3) % 12] > 0.10)) return -9; // sus needs no 3rd
  const tone = new Set(t.iv.map((i) => (root + i) % 12));
  let inS = 0, outS = 0, missing = 0;
  for (let pc = 0; pc < 12; pc++) tone.has(pc) ? (inS += c[pc]) : (outS += c[pc]);
  for (const i of t.iv) if (c[(root + i) % 12] < 0.05) missing++;
  let s = inS - 0.6 * outS - 0.15 * missing - 0.04 * (t.iv.length - 3);
  let peak = 0, peakPc = 0;
  for (let pc = 0; pc < 12; pc++) if (c[pc] > peak) { peak = c[pc]; peakPc = pc; }
  if (bassPc === root) {
    // The bass strongly cues the root — but a bassline often plays the FIFTH under a chord
    // (slash chord / power chord), so only give full credit when the bass note is also among
    // the most-present pitch classes. Otherwise a G5 with a D bass would be mis-rooted as D
    // (→ the phantom "Dsus4"). Peak-relative, so it scales with the arrangement.
    s += c[bassPc] >= peak - 0.06 ? 0.30 : 0.12;
  } else if (tone.has(bassPc)) s += 0.06;
  if (root === peakPc) s += 0.12; // the root is usually the most-present pitch class
  if (diatonic.has(root)) s += 0.12;
  return s;
}
function bestChord(chroma, bassPc, diatonic) {
  const total = chroma.reduce((a, b) => a + b, 0);
  if (total < 1e-6) return null;
  const c = chroma.map((x) => x / total);
  let best = null;
  for (let root = 0; root < 12; root++)
    for (const t of TEMPLATES) {
      const s = scoreOne(c, bassPc, diatonic, root, t);
      if (!best || s > best.s) best = { s, root, suf: t.suf };
    }
  return best;
}
// Score a specific {root,suf} on this window — for the hysteresis "keep the incumbent" test.
function scoreOf(chroma, bassPc, diatonic, root, suf) {
  const total = chroma.reduce((a, b) => a + b, 0);
  if (total < 1e-6) return -9;
  const c = chroma.map((x) => x / total);
  const t = TEMPLATES.find((x) => x.suf === suf);
  return t ? scoreOne(c, bassPc, diatonic, root, t) : -9;
}

// Pair Note On/Off per (track,channel) → spans, skipping drums (ch.10) and the melody.
function harmonySpans(noteEvents, melodyEx) {
  const groups = new Map();
  for (const e of noteEvents) {
    if (e.chan === 9) continue;
    if (melodyEx && e.track === melodyEx.track && e.chan === melodyEx.channel) continue;
    const gk = e.track * 16 + e.chan;
    let g = groups.get(gk); if (!g) groups.set(gk, (g = []));
    g.push(e);
  }
  const spans = [];
  for (const evs of groups.values()) {
    evs.sort((a, b) => a.tick - b.tick);
    const active = new Map();
    for (const e of evs) {
      if (e.on) { if (active.has(e.note)) spans.push([active.get(e.note), e.tick, e.note]); active.set(e.note, e.tick); }
      else if (active.has(e.note)) { spans.push([active.get(e.note), e.tick, e.note]); active.delete(e.note); }
    }
  }
  return spans;
}

/**
 * Detect chords from a parsed MIDI (from lyrics.js parseMidi).
 * @returns {{ chords: Array<{time:number, tick:number, root:number, suf:string}>, key }}
 *          `root` is a pitch class 0–11 (C=0); `suf` ∈ {"", "m", "7", "sus4"}.
 *          Bars with no clear chord are omitted (gaps).
 */
export function detectChords(parsed) {
  const t2s = makeTickToSeconds(parsed);
  const key = detectKey(parsed);
  const melody = extractMelody(parsed, t2s);
  const ex = melody.hasMelody ? { track: melody.track, channel: melody.channel } : null;
  const diatonic = new Set((key.mode === "minor" ? MIN : MAJ).map((i) => (i + key.keyPc) % 12));

  const spans = harmonySpans(parsed.noteEvents || [], ex);
  if (!spans.length) return { chords: [], key };

  const ts = parsed.timeSig && parsed.timeSig.num ? parsed.timeSig : { num: 4, den: 4 };
  const barTick = Math.max(1, parsed.ppqn * ts.num * (4 / ts.den));
  const maxTick = spans.reduce((m, s) => Math.max(m, s[1]), 0);
  const nBars = Math.ceil(maxTick / barTick);

  // one label per bar, with a hysteresis hold. Store {root, suf} ("N.C." → root:-1).
  const bars = [];
  let prev = null;
  for (let b = 0; b < nBars; b++) {
    const ws = b * barTick, we = ws + barTick;
    const chroma = new Array(12).fill(0), bassLen = new Array(12).fill(0);
    let low = 128;
    for (const [st, en, note] of spans) {
      const ov = Math.min(en, we) - Math.max(st, ws);
      if (ov <= 0) continue;
      chroma[note % 12] += ov;
      if (note < 52) bassLen[note % 12] += ov; // bass register → root cue
      if (note < low) low = note;
    }
    let bassPc = -1, bl = 0;
    for (let pc = 0; pc < 12; pc++) if (bassLen[pc] > bl) { bl = bassLen[pc]; bassPc = pc; }
    if (bassPc < 0 && low < 128) bassPc = low % 12;

    const best = bestChord(chroma, bassPc, diatonic);
    let cur = best && best.s > MIN_SCORE ? { root: best.root, suf: best.suf } : null;
    if (prev && cur && !(cur.root === prev.root && cur.suf === prev.suf)) {
      const keepS = scoreOf(chroma, bassPc, diatonic, prev.root, prev.suf);
      const margin = cur.root === prev.root ? SUFFIX_MARGIN : ROOT_MARGIN;
      if (best.s - keepS < margin && keepS > 0.12) cur = { ...prev };
    }
    if (cur) {
      // Was this bar a thirdless power chord? (both thirds of the chosen root faint.)
      const tot = chroma.reduce((a, x) => a + x, 0) || 1;
      const third = Math.max(chroma[(cur.root + 4) % 12], chroma[(cur.root + 3) % 12]) / tot;
      cur = { root: cur.root, suf: cur.suf, powerless: third < POWER };
      prev = cur;
    }
    bars.push(cur); // may be null (N.C.)
  }
  polish(bars);

  // key set from the detected roots + how concentrated they are (Simplify correction only
  // trusts the diatonic third when the key is confident — see simplifiedSuffix).
  const { set: keySet, ambiguous } = keySetFromChords(bars);
  let inSet = 0, total = 0;
  for (const b of bars) if (b) { total++; if (keySet.has(b.root)) inSet++; }
  // ambiguous (fifth-tied) key → don't trust the set to infer a thirdless chord's quality;
  // drop confidence below the gate so Simplify just collapses (no invented minor).
  let keyConf = total ? inSet / total : 0;
  if (ambiguous) keyConf = Math.min(keyConf, 0.5);

  // merge equal adjacent bars → timed segments (drop the N.C. bars as gaps)
  const chords = [];
  for (let b = 0; b < bars.length; b++) {
    const c = bars[b]; if (!c) continue;
    const last = chords[chords.length - 1];
    if (last && last.root === c.root && last.suf === c.suf) continue;
    chords.push({ tick: b * barTick, time: t2s(b * barTick), root: c.root, suf: c.suf, powerless: c.powerless });
  }
  return { chords, key, keySet, keyConf };
}

// Cosmetic cleanup on the per-bar array (SAFE only — never merge distinct chords):
//  A) blip filter: an isolated one-bar X Y X → X X X
//  B) sus absorption: a sus4 bar next to the same-root triad is a decoration → absorb
const same = (a, b) => a && b && a.root === b.root && a.suf === b.suf;
function polish(bars) {
  for (let i = 1; i < bars.length - 1; i++) {
    if (!bars[i] || same(bars[i], bars[i - 1]) || !same(bars[i - 1], bars[i + 1])) continue;
    // X Y X — but only a blip if Y is truly isolated. In a real fast ALTERNATION (D-G-D-G,
    // common in verses) every bar looks like X Y X; skip when Y recurs two bars away, else
    // the whole alternation collapses to one chord (Spongecola "Jeepney" verse → all D).
    if (same(bars[i], bars[i - 2]) || same(bars[i], bars[i + 2])) continue;
    bars[i] = bars[i - 1];
  }
  for (let i = 0; i < bars.length; i++) {
    if (!bars[i] || bars[i].suf !== "sus4") continue;
    const r = bars[i].root;
    const nb = [bars[i - 1], bars[i + 1]].find((x) => x && x.root === r && x.suf !== "sus4");
    if (nb) bars[i] = nb;
  }
}

// ----------------------------------------------------------------------------
// ChordEngine — a horizontally-scrolling chord ribbon, anchored on the current
// chord (the same scroll idea as LyricsEngine, on the X axis).
// ----------------------------------------------------------------------------

const ANCHOR = 0.30; // where the active chord sits in the viewport (fraction from left)

export class ChordEngine {
  /**
   * @param {HTMLElement} container  #chords — we build a masked viewport + strip inside
   * @param {{simplify?:boolean}} opts
   */
  constructor(container, opts = {}) {
    this.container = container;
    this.simplify = !!opts.simplify;
    this.transpose = 0;

    this.raw = [];      // detected {time, root, suf, powerless}
    this.display = [];  // after simplify collapse+merge
    this.keySet = null; // key note-set + confidence (for the Simplify power-chord fix)
    this.keyConf = 0;
    this.chipEls = [];
    this.active = -1;
    this.hasChords = false;

    container.innerHTML = "";
    this.view = document.createElement("div");
    this.view.className = "chord-view";
    this.strip = document.createElement("div");
    this.strip.className = "chord-strip";
    this.view.appendChild(this.strip);
    container.appendChild(this.view);

    window.addEventListener("resize", () => this._rescroll());
  }

  /** Detect + render for a parsed MIDI. Returns whether any chords were found. */
  load(parsed) {
    try {
      const res = detectChords(parsed);
      this.raw = res.chords;
      this.keySet = res.keySet || null;
      this.keyConf = res.keyConf || 0;
    } catch (e) {
      console.warn("chord detect failed:", e);
      this.raw = []; this.keySet = null; this.keyConf = 0;
    }
    this.hasChords = this.raw.length > 0;
    this._build();
    return this.hasChords;
  }

  setSimplify(on) {
    on = !!on;
    if (on === this.simplify) return;
    this.simplify = on;
    this._build();
  }

  setTranspose(semitones) {
    const t = semitones | 0;
    if (t === this.transpose) return;
    this.transpose = t;
    for (const el of this.chipEls) el.textContent = this._label(+el.dataset.root, el.dataset.suf);
    this._rescroll();
  }

  clear() {
    this.raw = []; this.display = []; this.chipEls = [];
    this.keySet = null; this.keyConf = 0;
    this.hasChords = false; this.active = -1;
    this.strip.innerHTML = "";
    this.strip.style.transform = "translateX(0)";
  }

  _label(root, suf) {
    return chordLabel(root, suf, this.transpose);
  }

  // Collapse (simplify) then merge equal neighbours → this.display, then render chips.
  // Simplify mode also applies the diatonic power-chord correction (simplifiedSuffix).
  _build() {
    const out = [];
    for (const c of this.raw) {
      const suf = this.simplify ? simplifiedSuffix(c, this.keySet, this.keyConf) : c.suf;
      const last = out[out.length - 1];
      if (last && last.root === c.root && last.suf === suf) continue;
      out.push({ time: c.time, root: c.root, suf });
    }
    this.display = out;
    this._render();
  }

  _render() {
    this.strip.innerHTML = "";
    this.chipEls = [];
    this.active = -1;
    if (!this.display.length) {
      const el = document.createElement("span");
      el.className = "chord-chip placeholder";
      el.textContent = "no chord data in this file";
      this.strip.appendChild(el);
      this.strip.style.transform = "translateX(0)";
      return;
    }
    for (const c of this.display) {
      const el = document.createElement("span");
      el.className = "chord-chip upcoming";
      el.dataset.root = c.root;
      el.dataset.suf = c.suf;
      el.dataset.t = c.time;
      el.textContent = this._label(c.root, c.suf);
      this.strip.appendChild(el);
      this.chipEls.push(el);
    }
    this._scrollTo(-1);
  }

  _indexAt(t) {
    const D = this.display;
    let lo = 0, hi = D.length - 1, idx = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (D[mid].time <= t) { idx = mid; lo = mid + 1; } else hi = mid - 1;
    }
    return idx;
  }

  _setClasses(idx) {
    for (let i = 0; i < this.chipEls.length; i++)
      this.chipEls[i].className = "chord-chip " + (i < idx ? "past" : i === idx ? "current" : "upcoming");
  }

  _scrollTo(idx) {
    if (!this.chipEls.length) { this.strip.style.transform = "translateX(0)"; return; }
    const target = this.chipEls[idx < 0 ? 0 : idx];
    const anchor = this.view.clientWidth * ANCHOR;
    const center = target.offsetLeft + target.offsetWidth / 2;
    this._x = anchor - center;
    this.strip.style.transform = `translateX(${this._x.toFixed(1)}px)`;
  }
  _rescroll() { if (this.hasChords) this._scrollTo(this.active); }

  /** Call every frame with the (offset-adjusted) playback time in seconds. */
  update(t) {
    if (!this.hasChords) return;
    const idx = this._indexAt(t);
    if (idx !== this.active) {
      this.active = idx;
      this._setClasses(idx);
      this._scrollTo(idx);
    }
  }
}
