/*
 * lyrics-doc.js — the lyric document the host publishes for the song it is playing, so phones
 * render the same stage lyrics without downloading or parsing song files (M7, plan §5.14, P9).
 * Pure; shared by the host (app.js builds, remote-host.js uploads) and the phone (remote.js parses).
 *
 * Contract written by the orchestrator; the exports, names and signatures are what lanes A and I
 * code against.
 *
 * Raw lyric line shape (VERIFIED against lyrics.js buildLyrics and lyrics-formats.js makeLine):
 *   { start, end, syllables: [{ time, text }], singer }   singer "" | "m" | "w" | "c", seconds.
 * Every producer sets `end` = the LAST syllable's time (not its end) and, except enhanced LRC,
 * `start` = the first syllable's time. What each engine reads from a raw line:
 *   - the stage engine (lyric-pager.js prepareStageLines): ONLY the syllables (time, text) and
 *     `singer`; it re-derives start/end from the syllables itself;
 *   - the scroll engine (lyrics.js LyricsEngine.loadLines): `start` (which line is active, and the
 *     cap on a line's last syllable) and the syllables; `end` is only copied along.
 * So a document line carries its syllables and singer, plus `b` (start) / `e` (end) only when
 * they are not what the syllables imply — an enhanced-LRC line whose first word comes after the
 * line's own stamp keeps its start.
 *
 * Rounding to the millisecond is not enough on its own for an IDENTICAL stage view. The stage rules
 * make discrete choices at exact boundaries — a syllable gap of exactly 4 beats (capped or not), a
 * first line at exactly 3 s, a line gap of exactly 8 s (count-in or not) — and quantised MIDI lands
 * on those boundaries all the time, decided by float noise in the 15th digit. Measured over 596 real
 * KAR files: 489 of 225,090 syllables (in 213 songs, 36%) flipped their 4-beat cap after plain
 * rounding. So buildLyricsDoc runs the stage rules on the source and on the document and, where a
 * choice differs, moves the deciding time (a syllable, a cue or a tempo change) by 1–3 ms until it
 * agrees (`repairStageChoices`). Measured after it, over 2,980 real KAR files (1.1 M syllables):
 * every line, singer marker and count-in identical, every time within 4.5 ms, and 2 syllables in 2
 * songs left with a different wipe length (a chain of exact-4-beat gaps meeting a tempo change, which
 * would need two nudges at once). Build cost: median 0.15 ms, worst 3.4 ms per song.
 */

import { STAGE, prepareStageLines, buildCountdowns } from "./lyric-pager.js";

export const LYRICS_DOC_V = 1;

const KINDS = ["lines", "baked", "none"];
const SINGERS = ["", "m", "w", "c"];
// Sanity bounds for a document read off the network (the relay caps a body at 400 KB anyway).
const MAX_LINES = 10000;
const MAX_SYLLABLES = 1000;
const MAX_TEXT = 500;
const MAX_ID = 512;
const NEAR = 0.0025;      // a start/end within this of what the syllables imply is not carried
const TIME_TOL = 0.0045;  // a repaired time may sit this far from the source (rounding + nudge)

const ms = (t) => Math.round(t * 1000) / 1000;
const us = (x) => Math.round(x * 1e6) / 1e6;   // seconds per beat: a MIDI tempo is whole µs
const num = (x) => typeof x === "number" && Number.isFinite(x);

/**
 * @param {{id: string, kind?: "lines"|"baked"|"none", lines?: object[], cues?: number[],
 *          beats?: Array<[number, number]>, duration?: number}} o
 *   lines = raw lines (shape above); cues = count-in cue times (s); beats = the tempo map flattened to
 *   [[t, secPerBeat], …] sorted by t (StageLyricsEngine `source` gives all three); duration in s.
 * @returns {{ v: 1, id: string, kind: "lines"|"baked"|"none",
 *             lines: Array<{ s?: "m"|"w"|"c", y: Array<[number, string]>, b?: number, e?: number }>,
 *             cues: number[], beats: Array<[number, number]>, dur: number }}
 *   kind defaults to "lines" when there are lines, else "none"; "lines" with no usable line is "none";
 *   "baked" (video / YouTube) and "none" carry no lines/cues/beats. Every time is rounded to the
 *   millisecond; seconds-per-beat to the microsecond (lossless for a MIDI tempo). A line's `y` is its
 *   syllables as [time, text] pairs, text verbatim (backing-vocal brackets and spaces included).
 *   Size: `s` is left out for "" (most lines), `b`/`e` unless they differ from the syllables by more
 *   than 2.5 ms. Measured over 2,980 real KAR files: median 6.3 KB, p95 12 KB, largest 53.6 KB (a
 *   685-line song); a dense synthetic 400-line song stays under 60 KB (tested).
 */
export function buildLyricsDoc(o = {}) {
  const src = o && typeof o === "object" ? o : {};
  const id = String(src.id ?? "").slice(0, MAX_ID);
  const dur = num(src.duration) && src.duration > 0 ? ms(src.duration) : 0;
  const kept = [];   // [raw line, doc line]
  for (const raw of Array.isArray(src.lines) ? src.lines : []) {
    const line = docLine(raw);
    if (line) kept.push([raw, line]);
  }
  let kind = KINDS.includes(src.kind) ? src.kind : (kept.length ? "lines" : "none");
  if (kind === "lines" && !kept.length) kind = "none";
  if (kind !== "lines") return { v: LYRICS_DOC_V, id, kind, lines: [], cues: [], beats: [], dur };

  const srcCues = (Array.isArray(src.cues) ? src.cues : []).filter(num).sort((a, b) => a - b);
  const srcBeats = validBeats(src.beats);
  const cues = srcCues.map(ms);
  const beats = srcBeats.map((b) => [ms(b[0]), us(b[1])]);
  repairStageChoices(kept, srcCues, cues, beats, beatAtOf(srcBeats), beatAtOf(beats));
  const lines = kept.map(([raw, line]) => finishLine(raw, line));
  return { v: LYRICS_DOC_V, id, kind, lines, cues, beats, dur };
}

function docLine(raw) {
  if (!raw || typeof raw !== "object" || !Array.isArray(raw.syllables)) return null;
  const y = [];
  for (const s of raw.syllables) {
    if (!s || !num(s.time) || typeof s.text !== "string" || !s.text) continue;
    y.push([ms(s.time), s.text]);
  }
  if (!y.length) return null;              // neither engine draws a line with nothing in it
  const line = {};
  if (raw.singer && SINGERS.includes(raw.singer)) line.s = raw.singer;
  line.y = y;
  return line;
}

/** `b`/`e` once the syllable times are final: only when the syllables do not already imply them. */
function finishLine(raw, line) {
  const y = line.y;
  if (num(raw.start) && Math.abs(ms(raw.start) - y[0][0]) > NEAR) line.b = ms(raw.start);
  if (num(raw.end) && Math.abs(ms(raw.end) - y[y.length - 1][0]) > NEAR) line.e = ms(raw.end);
  return line;
}

function validBeats(list) {
  return (Array.isArray(list) ? list : [])
    .filter((b) => Array.isArray(b) && num(b[0]) && num(b[1]) && b[1] > 0)
    .map((b) => [b[0], b[1]])
    .sort((a, b) => a[0] - b[0]);       // stable: equal times keep the tempo map's order
}

// ---------------------------------------------------------------- the stage-choice repair
// The stage view of a set of raw lines: what lyric-pager decides, reduced to what can differ.
function stageView(rawLines, cues, beatAt) {
  const lines = prepareStageLines(rawLines, beatAt);
  return { lines, cds: new Map(buildCountdowns(lines, cues, beatAt).map((c) => [c.line, c])) };
}

const near = (a, b) => Math.abs(a - b) <= TIME_TOL;

/** The first place the document's stage view differs from the source's, in reading order. */
function firstDifference(A, B, skip) {
  if (A.lines.length !== B.lines.length) return { pos: -1 };               // structural: unfixable
  for (let k = 0; k < A.lines.length; k++) {
    const a = A.lines[k], b = B.lines[k];
    if (a.syllables.length !== b.syllables.length) return { pos: -1 };
    const base = k * 100000;
    if (a.showSinger !== b.showSinger && !skip.has(base)) return { pos: base, k, what: "line" };
    for (let j = 0; j < a.syllables.length; j++) {
      if (!near(a.syllables[j].end, b.syllables[j].end) && !skip.has(base + 1 + j)) return { pos: base + 1 + j, k, j, what: "syl" };
    }
    const ca = A.cds.get(k), cb = B.cds.get(k);
    const same = (!ca && !cb) || (ca && cb && ca.beats.length === cb.beats.length && ca.beats.every((t, i) => near(t, cb.beats[i])));
    if (!same && !skip.has(base + 99999)) return { pos: base + 99999, k, what: "cd" };
  }
  return null;
}

/**
 * Make the document's stage choices match the source's (see the header). `kept` = [raw, doc line]
 * pairs in order; the doc lines' syllable times, the doc `cues` and the doc `beats` times (which
 * `beatDoc` reads) are edited in place, each by at most 3 ms.
 */
function repairStageChoices(kept, srcCues, cues, beats, beatSrc, beatDoc) {
  const A = stageView(kept.map(([raw]) => raw), srcCues, beatSrc);
  // Stage line k / its syllable j → the [time, text] pair in the document that produced it
  // (prepareStageLines drops a syllable that is only brackets, and a line left with none).
  const pairs = [];
  for (const [, line] of kept) {
    const p = line.y.filter((yy) => yy[1].replace(/[()]/g, ""));
    if (p.length) pairs.push(p);
  }
  const docRaw = () => kept.map(([, line]) => ({ syllables: line.y.map(([time, text]) => ({ time, text })), singer: line.s || "" }));
  const skip = new Set();
  let B = stageView(docRaw(), cues, beatDoc);
  for (let round = 0; round < 64; round++) {
    const d = firstDifference(A, B, skip);
    if (!d) return;
    if (d.pos < 0) return;                      // the two views do not even line up: leave it
    // The times that decide this choice, most likely first.
    const handles = [];
    const pairAt = (k, j) => (pairs[k] && pairs[k][j] ? { get: () => pairs[k][j][0], set: (v) => { pairs[k][j][0] = v; } } : null);
    const flatNext = (k, j) => (j + 1 < pairs[k].length ? pairAt(k, j + 1) : pairAt(k + 1, 0));
    if (d.what === "syl") handles.push(flatNext(d.k, d.j), pairAt(d.k, d.j));
    else {
      handles.push(pairAt(d.k, 0), d.k > 0 ? pairAt(d.k - 1, pairs[d.k - 1].length - 1) : null);
      if (d.what === "cd") {
        const at = pairs[d.k][0][0];   // only the cues that can belong to this line's count-in
        cues.forEach((c, i) => { if (Math.abs(c - at) < 3 * STAGE.CUE_GROUP_GAP) handles.push({ get: () => cues[i], set: (v) => { cues[i] = v; } }); });
      }
    }
    // A tempo change within a few ms of the syllable whose beat is read (it lands on the other side).
    const at = pairs[d.k][d.what === "syl" ? d.j : 0][0];
    beats.forEach((b, i) => {
      if (Math.abs(b[0] - at) > 0.005) return;
      const lo = i > 0 ? beats[i - 1][0] : -Infinity, hi = i + 1 < beats.length ? beats[i + 1][0] : Infinity;
      handles.push({ get: () => b[0], set: (v) => { b[0] = Math.min(hi, Math.max(lo, v)); } });
    });
    let fixed = false;
    for (const h of handles) {
      if (!h || fixed) continue;
      const was = h.get();
      for (const delta of [0.001, -0.001, 0.002, -0.002, 0.003, -0.003]) {
        h.set(ms(was + delta));
        const B2 = stageView(docRaw(), cues, beatDoc);
        const d2 = firstDifference(A, B2, skip);
        if (!d2 || d2.pos > d.pos) { B = B2; fixed = true; break; }
      }
      if (!fixed) h.set(was);
    }
    if (!fixed) skip.add(d.pos);                // cannot be fixed with a nudge: accept it, move on
  }
}

/**
 * @param {object} doc  a document from buildLyricsDoc (possibly from the network: validate everything)
 * @returns {{ kind: string, lines: object[], cues: number[], beatAt: (t: number) => number,
 *             beats: Array<[number, number]>, duration: number } | null}
 *   lines come back in the raw-line shape above, sorted by start; beatAt(t) = seconds per beat at t (a
 *   step function over `beats`: the last entry at or before t, as makeBeatAt picks; 0.5 — 120 bpm —
 *   when empty or before the first entry). `beats` is the validated list (so StageLyricsEngine
 *   `source` stays complete after loadDoc). null when v !== LYRICS_DOC_V or the top-level shape is
 *   wrong; a malformed LINE or SYLLABLE inside an otherwise valid document is dropped. Never throws.
 */
export function parseLyricsDoc(doc) {
  try {
    if (!doc || typeof doc !== "object" || Array.isArray(doc)) return null;
    if (doc.v !== LYRICS_DOC_V || !KINDS.includes(doc.kind)) return null;
    const duration = num(doc.dur) && doc.dur > 0 ? doc.dur : 0;
    if (doc.kind !== "lines") return { kind: doc.kind, lines: [], cues: [], beatAt: defaultBeat, beats: [], duration };
    if (!Array.isArray(doc.lines)) return null;
    const lines = [];
    for (const l of doc.lines.slice(0, MAX_LINES)) {
      const line = rawLine(l);
      if (line) lines.push(line);
    }
    lines.sort((a, b) => a.start - b.start);
    const cues = (Array.isArray(doc.cues) ? doc.cues : []).filter(num).sort((a, b) => a - b);
    const beats = validBeats(doc.beats);
    return { kind: lines.length ? "lines" : "none", lines, cues, beatAt: beatAtOf(beats), beats, duration };
  } catch (_) {
    return null;   // a getter that throws, a proxy… — junk never throws out of here
  }
}

function rawLine(l) {
  if (!l || typeof l !== "object" || !Array.isArray(l.y)) return null;
  const syllables = [];
  for (const p of l.y.slice(0, MAX_SYLLABLES)) {
    if (!Array.isArray(p) || !num(p[0]) || typeof p[1] !== "string" || !p[1]) continue;
    syllables.push({ time: p[0], text: p[1].slice(0, MAX_TEXT) });
  }
  if (!syllables.length) return null;
  return {
    start: num(l.b) ? l.b : syllables[0].time,
    end: num(l.e) ? l.e : syllables[syllables.length - 1].time,
    syllables,
    singer: SINGERS.includes(l.s) ? l.s : "",
  };
}

function defaultBeat() { return STAGE.DEFAULT_BEAT; }

/** A step function over sorted [[t, spb]]: the LAST entry with t_i <= t (as makeBeatAt picks). */
function beatAtOf(beats) {
  if (!beats.length) return defaultBeat;
  return (t) => {
    if (!(t >= beats[0][0])) return STAGE.DEFAULT_BEAT;
    let lo = 0, hi = beats.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (beats[mid][0] <= t) lo = mid; else hi = mid - 1;
    }
    return beats[lo][1];
  };
}
