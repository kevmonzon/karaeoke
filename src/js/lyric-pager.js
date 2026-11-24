/*
 * lyric-pager.js — the pure timing + layout rules behind the STAGE lyric view
 * (lyrics-stage.js), the fixed-row "videoke" style: two rows that take turns, a hard-edged
 * wipe, a 4-3-2-1-GO count-in before a line that follows a long break.
 *
 * The rules are a clean-room reimplementation of how a commercial videoke app's lyric
 * stage BEHAVES (studied 2026-11-23; numbers below are its). No code, fonts or assets
 * from it live here. Everything is in SECONDS and pure — no DOM, no clock, no canvas —
 * so the parts that decide what is on screen when are unit-tested (test/unit.test.js).
 */

export const STAGE = Object.freeze({
  LINGER: 0.6,              // a finished line stays up this long before a break blanks the rows
  END_CLEAR: 0.5,           // after the LAST line ends, the rows clear this much later
  FIRST_COUNTDOWN_AFTER: 3, // the first line gets a count-in if it starts later than this
  GAP_COUNTDOWN_OVER: 8,    // any later line gets one when its gap from the previous END exceeds this
  CUE_GROUP_GAP: 4,         // explicit '#' cues closer than this belong to one count-in
  BEATS: 4,                 // a synthesized count-in is four beats, the last one beat before the line
  DEFAULT_BEAT: 0.5,        // seconds per beat when the source has no tempo (sidecars): 120 bpm
  LAST_SYLLABLE: 1.0,       // a syllable with nothing after it is sung for this long
  SINGER_GAP: 5,            // re-show the singer marker after a gap this long, even for the same singer
  ANIM_MS: 320,             // a row's line-change animation
});

/** The line-change animations, in the order the settings select lists them. */
export const STAGE_ANIMATIONS = Object.freeze(["none", "fade", "wipe", "crossfade", "flip", "bounce"]);
/** Row alignment: centred, top-left / bottom-right, or the same split pulled toward the middle. */
export const STAGE_ALIGNS = Object.freeze(["center", "split", "close"]);
/** Where the rows sit vertically: the videoke layout at the bottom, or centred on the screen. */
export const STAGE_POSITIONS = Object.freeze(["bottom", "center"]);

/**
 * The baseline of a stage page's LAST row, in canvas px. The rows above it step up by lineH + gap,
 * and a wrapped line's extra rows stack upward from its own baseline (lyrics-stage.js), as before.
 * - "bottom" (and anything unknown): `bottom` px above the canvas foot — the videoke layout.
 * - "center": the block of `rows` one-row lines — the first row's ascent to the last row's descent —
 *   centred on `mid`, the screen's vertical middle in canvas px (the canvas middle when not given);
 *   then kept inside the canvas: never lower than the bottom layout, and with `top` px free above the
 *   first row (the count-in's room). A canvas too short for both gets the bottom layout.
 */
export function stageBaseline({ ch, rows, lineH, gap, ascent, descent, bottom, position = "bottom", mid, top = 0 }) {
  const low = ch - bottom;
  if (position !== "center") return low;
  const span = (rows - 1) * (lineH + gap);
  const m = Number.isFinite(mid) ? mid : ch / 2;
  const want = m + (span + ascent + descent) / 2 - descent;
  const high = top + span + ascent;
  return Math.min(low, Math.max(high, want));
}

export const SINGER_COLORS = Object.freeze({ m: "#42A5F5", w: "#EF5350", c: "#66BB6A" });
export const SINGER_MARKS = Object.freeze({ m: "🧑🏻", w: "👩🏻", c: "👫" });
export const BACKING_COLOR = "#FF9800";   // a (parenthesised) backing-vocal syllable
export const COUNTDOWN_COLORS = Object.freeze(["#FF5252", "#FF9800", "#FFEB3B", "#66BB6A", "#42A5F5", "#AB47BC"]);
export const GO_COLOR = "#66BB6A";
/** The palette "random colour" draws one highlight from, once per song. */
export const STAGE_PALETTE = Object.freeze([
  "#0000FF", "#FF0000", "#4CAF50", "#FDD835", "#00BCD4", "#FF00FF", "#FF5722", "#795548", "#607D8B", "#E91E63",
  "#9C27B0", "#3F51B5", "#FFC107", "#8BC34A", "#4682B4", "#D2691E", "#008080", "#FF4500", "#2E8B57", "#8A2BE2",
]);

const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);

/**
 * Seconds-per-beat at a time, from a parsed MIDI's tempo map. The count-in beats and the
 * long-gap syllable cap are both measured in beats, so a slow ballad counts in slowly.
 */
export function makeBeatAt(tempoMap, tickToSeconds) {
  const segs = (tempoMap || [])
    .map((e) => ({ sec: tickToSeconds(e.tick), spb: e.usPerQuarter / 1e6 }))
    .filter((s) => Number.isFinite(s.sec) && s.spb > 0)
    .sort((a, b) => a.sec - b.sec);
  if (!segs.length) return () => STAGE.DEFAULT_BEAT;
  return (t) => {
    let spb = segs[0].spb;
    for (const s of segs) { if (s.sec <= t) spb = s.spb; else break; }
    return spb;
  };
}

/**
 * One line's syllables → the same syllables with their brackets removed and the backing-vocal ones
 * flagged `paren` (drawn orange). A bracket left open is closed at the end of the line; a syllable
 * that was only brackets is dropped. Shared by the stage engine and, since 2026-11-24 (Rae: the
 * scroll style takes the stage look), the scroll engine (lyrics.js).
 * @param {{time:number, text:string}[]} syllables
 * @returns {{time:number, text:string, paren:boolean}[]} (other fields of each syllable are kept)
 */
export function splitParens(syllables) {
  let inParen = false;
  const out = [];
  for (const s of syllables || []) {
    const text = String((s && s.text) ?? "");
    const opens = text.includes("(");
    const closes = text.includes(")");
    if (opens) inParen = true;
    const paren = inParen;
    if (closes) inParen = false;
    const clean = text.replace(/[()]/g, "");
    if (!clean) continue;
    out.push({ ...s, text: clean, paren });
  }
  return out;
}

/**
 * Raw lines ([{start, end, singer?, syllables:[{time, text}]}]) → stage lines.
 * - Parentheses mark backing vocals: the brackets are removed and the syllables flagged
 *   `paren` (drawn orange). A bracket left open is closed at the end of its line.
 * - Syllable `end`: where the next syllable starts — but a gap longer than 4 beats is capped
 *   at 2 beats, so the wipe doesn't crawl across an instrumental. A syllable with nothing
 *   after it (or sharing the next one's time) lasts STAGE.LAST_SYLLABLE.
 * - Line `start`/`end`: its first syllable's start / its last syllable's end.
 * - `showSinger`: the singer marker is drawn when the singer changes, or after a 5 s gap.
 */
export function prepareStageLines(rawLines, beatAt = () => STAGE.DEFAULT_BEAT) {
  const out = [];
  for (const raw of rawLines || []) {
    const syllables = splitParens(raw.syllables).map((s) => ({ time: s.time, end: s.time, text: s.text, paren: s.paren }));
    if (syllables.length) out.push({ start: syllables[0].time, end: syllables[0].time, singer: raw.singer || "", showSinger: false, syllables });
  }
  const flat = out.flatMap((l) => l.syllables);
  for (let i = 0; i < flat.length; i++) {
    const s = flat[i];
    const next = flat[i + 1];
    if (next && next.time > s.time) {
      const beat = beatAt(s.time);
      s.end = next.time - s.time > 4 * beat ? s.time + 2 * beat : next.time;
    } else {
      s.end = s.time + STAGE.LAST_SYLLABLE;
    }
  }
  let prevEnd = -Infinity;
  let shown = "";
  for (const l of out) {
    l.start = l.syllables[0].time;
    l.end = l.syllables[l.syllables.length - 1].end;
    l.showSinger = !!l.singer && (l.singer !== shown || l.start - prevEnd > STAGE.SINGER_GAP);
    if (l.singer) shown = l.singer;
    prevEnd = l.end;
  }
  return out;
}

/**
 * Count-ins, one per line that needs one: [{line, start, beats:[t…]}] (sorted by line).
 * Explicit '#' cues (grouped while < 4 s apart) attach to the first line starting at or
 * after the group's last cue. Any line left uncovered gets four synthesized beats when it is
 * the first line and starts after 3 s, or when its gap from the previous line's END is > 8 s.
 */
export function buildCountdowns(lines, cues = [], beatAt = () => STAGE.DEFAULT_BEAT) {
  const n = lines.length;
  const byLine = new Map();
  const sorted = [...cues].filter(Number.isFinite).sort((a, b) => a - b);
  const groups = [];
  for (const c of sorted) {
    const g = groups[groups.length - 1];
    if (g && c - g[g.length - 1] < STAGE.CUE_GROUP_GAP) g.push(c);
    else groups.push([c]);
  }
  for (const g of groups) {
    const last = g[g.length - 1];
    let k = lines.findIndex((l) => l.start >= last - 0.001);
    if (k < 0) continue;                                 // cues after the last line: nothing to count into
    if (!byLine.has(k)) byLine.set(k, { line: k, start: lines[k].start, beats: g.slice() });
  }
  for (let k = 0; k < n; k++) {
    if (byLine.has(k)) continue;
    const need = k === 0
      ? lines[0].start > STAGE.FIRST_COUNTDOWN_AFTER
      : lines[k].start - lines[k - 1].end > STAGE.GAP_COUNTDOWN_OVER;
    if (!need) continue;
    const start = lines[k].start;
    const beat = beatAt(start);
    const beats = [];
    for (let j = STAGE.BEATS; j >= 1; j--) { const b = start - j * beat; if (b >= 0) beats.push(b); }
    if (beats.length) byLine.set(k, { line: k, start, beats });
  }
  return [...byLine.values()].sort((a, b) => a.line - b.line);
}

/**
 * Where a count-in is at time t: null (not showing), or {count, phase} — count = beats still
 * to come (4…1), 0 = "GO!" (shown for one beat after the line starts); phase = 0…1 within it.
 */
export function countdownAt(cd, t) {
  if (!cd || !cd.beats.length) return null;
  const beats = cd.beats;
  const last = beats[beats.length - 1];
  const go = cd.start - last > 0.1 ? cd.start - last : 0.5;
  if (t < beats[0]) return null;
  if (t < cd.start) {
    let i = 0;
    while (i + 1 < beats.length && beats[i + 1] <= t) i++;
    const next = i + 1 < beats.length ? beats[i + 1] : cd.start;
    return { count: beats.length - i, phase: clamp01((t - beats[i]) / Math.max(0.001, next - beats[i])) };
  }
  if (t < cd.start + go) return { count: 0, phase: clamp01((t - cd.start) / go) };
  return null;
}

/**
 * Precompute what paging needs once per song: the count-in for each line, and each line's
 * ANCHOR — the most recent line at or before it that restarts the row rotation (line 0, or a
 * line behind a count-in). Rows are derived from (index − anchor), so paging is stateless:
 * a seek or an offset nudge lands on the same rows a straight play-through would.
 */
export function makeStagePlan(lines, countdowns = []) {
  const cdByLine = new Map(countdowns.map((c) => [c.line, c]));
  const anchors = new Array(lines.length);
  let a = 0;
  for (let k = 0; k < lines.length; k++) {
    if (k === 0 || cdByLine.has(k)) a = k;
    anchors[k] = a;
  }
  return { lines, countdowns, cdByLine, anchors };
}

/** Index of the last line that has started by t (−1 before the first). */
export function lineIndexAt(lines, t) {
  let lo = 0, hi = lines.length - 1, idx = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (lines[mid].start <= t) { idx = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return idx;
}

/**
 * What every row shows at time t. → {slots, focus, countdown, interlude, intro}
 *   slots[i] = null | {index, state}; state 0 = upcoming (unsung preview), 1 = being sung,
 *   2 = sung (fully highlighted). `rows` is 2 (rows take turns) or 4 (a fixed ring of four).
 * The rules:
 *   - A line becomes the focus at its first syllable — no lead-in — or, behind a count-in,
 *     at the count-in's first beat (so it is on screen while the count runs).
 *   - The other row keeps the line just sung until the focus line passes its SECOND
 *     syllable (the midpoint of a one-syllable line); then it previews the next line.
 *   - Before a count-in: the last line lingers 0.6 s, then the rows go blank (`interlude`)
 *     until the first beat, and a line behind a count-in that hasn't started is never previewed.
 *   - The first line, and the first line after every count-in, take the TOP row.
 *   - 0.5 s after the last line ends, everything clears.
 */
export function pageAt(plan, t, rows = 2) {
  const R = rows === 4 ? 4 : 2;
  const lines = plan ? plan.lines : [];
  const n = lines.length;
  const blank = (extra) => ({ slots: new Array(R).fill(null), focus: -1, countdown: null, interlude: false, intro: false, ...extra });
  if (!n) return blank();
  const cdOf = (k) => (k > 0 && k < n ? plan.cdByLine.get(k) || null : null);
  const firstBeat = (cd) => cd.beats[0];
  const gated = (k) => { const cd = cdOf(k); return !!cd && t < firstBeat(cd); };

  const p = Math.max(0, lineIndexAt(lines, t));
  const cd0 = plan.cdByLine.get(0);
  const intro = t < (cd0 ? firstBeat(cd0) : lines[0].start);

  const nextCd = cdOf(p + 1);
  if (nextCd && t >= lines[p].start && t >= lines[p].end + STAGE.LINGER && t < firstBeat(nextCd)) {
    return blank({ interlude: true });
  }
  const f = nextCd && t >= firstBeat(nextCd) ? p + 1 : p;
  if (f >= n - 1 && t >= lines[n - 1].end + STAGE.END_CLEAR) return blank();

  const L = lines[f];
  const focusState = t >= L.end ? 2 : 1;
  const sy = L.syllables;
  const underway = sy.length > 1 ? t >= sy[1].time
    : sy.length ? t >= sy[0].time + (sy[0].end - sy[0].time) / 2 : true;
  const nextGated = gated(f + 1);
  const keepPrev = f > 0 && ((!underway && !cdOf(f)) || (nextGated && t < L.end + STAGE.LINGER));

  const slots = new Array(R).fill(null);
  const put = (slot, idx, state) => { if (idx >= 0 && idx < n) slots[slot] = { index: idx, state: idx > f ? 0 : state }; };
  const ring = (f - plan.anchors[f]) % R;
  put(ring, f, focusState);
  if (R === 2) {
    const other = 1 - ring;
    if (keepPrev) put(other, f - 1, 2);
    else if (!nextGated) put(other, f + 1, 0);
  } else {
    let hidden = false;                       // nothing past a pending count-in is previewed
    for (let j = 1; j <= 2; j++) {
      hidden = hidden || gated(f + j);
      if (!hidden) put((ring + j) % R, f + j, 0);
    }
    if (keepPrev) put((ring + 3) % R, f - 1, 2);
    else if (!(hidden || gated(f + 3))) put((ring + 3) % R, f + 3, 0);
  }
  const cd = plan.cdByLine.get(f);
  return { slots, focus: f, countdown: cd ? countdownAt(cd, t) : null, interlude: false, intro };
}

/**
 * How much of a row is sung, in px: whole syllables already past + the live fraction of the
 * one being sung (linear in time between its start and end). It holds still in the gaps.
 * smooth=false flips each syllable whole at its start instead.
 */
export function wipeWidth(syllables, widths, t, smooth = true) {
  let acc = 0;
  for (let i = 0; i < syllables.length; i++) {
    const s = syllables[i];
    if (smooth ? t <= s.time : t < s.time) return acc;
    if (!smooth || t >= s.end) { acc += widths[i]; continue; }
    return acc + clamp01((t - s.time) / Math.max(0.001, s.end - s.time)) * widths[i];
  }
  return acc;
}

/**
 * Greedy word wrap of a line's syllables into rows no wider than maxW. A word break falls
 * before a syllable that starts with whitespace or after one that ends with it; a word is
 * never split. `prefixW` (the singer marker) is counted on the first row.
 * → [{from, to (exclusive), width}]
 */
export function wrapRows(syllables, widths, maxW, prefixW = 0) {
  const words = [];
  for (let i = 0; i < syllables.length; i++) {
    const txt = syllables[i].text;
    const prev = i > 0 ? syllables[i - 1].text : "";
    if (!words.length || /^\s/.test(txt) || /\s$/.test(prev)) words.push({ from: i, to: i + 1, w: widths[i] });
    else { const w = words[words.length - 1]; w.to = i + 1; w.w += widths[i]; }
  }
  const rows = [];
  let row = { from: 0, to: 0, width: prefixW };
  for (const w of words) {
    const occupied = row.to > row.from || (rows.length === 0 && prefixW > 0);
    if (occupied && row.width + w.w > maxW) {
      rows.push(row);
      row = { from: w.from, to: w.from, width: 0 };
    }
    row.to = w.to;
    row.width += w.w;
  }
  if (row.to > row.from || !rows.length) rows.push(row);
  return rows;
}

/** Left x of a row of width w in a stage of width W. side: "left" (top row) or "right" (bottom). */
export function alignX(w, W, side, align, margin) {
  const c = (W - w) / 2;
  if (align === "split") return side === "right" ? W - w - margin : margin;
  if (align === "close") return side === "right" ? Math.min(W - w - margin, c + 0.1 * W) : Math.max(margin, c - 0.1 * W);
  return c;
}

/** AccelerateDecelerate: a cosine S-curve. */
export const easeInOut = (p) => Math.cos((clamp01(p) + 1) * Math.PI) / 2 + 0.5;

/**
 * One frame of a row's line-change animation, p = 0…1 over STAGE.ANIM_MS.
 * → {old: null | {alpha, scaleY}, new: {alpha, scaleY, reveal}}  (reveal = 0…1 of the width)
 */
export function animFrame(kind, p) {
  const q = clamp01(p);
  const e = easeInOut(q);
  const show = (o) => ({ alpha: 1, scaleY: 1, reveal: 1, ...o });
  switch (kind) {
    case "fade": return { old: null, new: show({ alpha: e }) };
    case "wipe": return { old: null, new: show({ reveal: e }) };
    case "crossfade": return { old: { alpha: 1 - e, scaleY: 1 }, new: show({ alpha: e }) };
    case "flip":
      if (q < 0.5) return { old: { alpha: 1, scaleY: Math.max(0.001, 1 - q / 0.5) }, new: null };
      return { old: null, new: show({ scaleY: Math.max(0.001, 1 - (1 - (q - 0.5) / 0.5) ** 2) }) };
    case "bounce": return { old: null, new: show({ scaleY: Math.max(0.001, 1 - Math.exp(-4.5 * q) * Math.cos(3.5 * Math.PI * q)) }) };
    default: return { old: null, new: show({}) };
  }
}
