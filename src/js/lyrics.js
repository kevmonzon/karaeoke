/*
 * lyrics.js — Standard MIDI File (SMF/KAR) lyric extraction + a smooth-scrolling,
 * tick-synced lyric engine.
 *
 *   - lyrics live in MIDI Meta Text (0x01) / Lyric (0x05) events, timed in ticks
 *     over a PPQN division, mapped to seconds via the tempo map
 *   - a persistent column of lines is rendered once and glides upward via a CSS
 *     transform (no per-line re-render / jump-cut)
 *   - the active line is painted syllable-by-syllable (smooth "wipe")
 *   - `mergeLines` concatenates N consecutive source lines into one display line
 *   - a timing offset is applied by the caller (see app.js)
 *   - since 2026-11-24 (Rae: "copy the stage design to scroll mode") the column is drawn in the
 *     STAGE style's look: white text with a black outline + drop shadow, the sung part in the
 *     highlight colour with a white outline, duet lines in the singer colours, (backing) vocals
 *     orange without their brackets. Each word is a span with a ::after copy of its text clipped
 *     at the wipe (scroll-lyrics.css); setLook() takes the stage engine's colour / outline / shadow.
 */

import { splitParens, SINGER_COLORS, SINGER_MARKS, STAGE } from "./lyric-pager.js";

// ----------------------------------------------------------------------------
// Minimal SMF parser — tempo map + text/lyric events.
// ----------------------------------------------------------------------------

function decodeText(bytes) {
  try {
    const utf8 = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
    if (!utf8.includes("�")) return utf8;
  } catch (_) {}
  try {
    return new TextDecoder("windows-1252", { fatal: false }).decode(bytes);
  } catch (_) {
    let s = "";
    for (const b of bytes) s += String.fromCharCode(b);
    return s;
  }
}

export function parseMidi(arrayBuffer) {
  const dv = new DataView(arrayBuffer);
  const u8 = (p) => dv.getUint8(p);
  const str = (p, n) => {
    let s = "";
    for (let i = 0; i < n; i++) s += String.fromCharCode(dv.getUint8(p + i));
    return s;
  };

  if (str(0, 4) !== "MThd") throw new Error("Not a Standard MIDI File (missing MThd)");
  const headerLen = dv.getUint32(4);
  const division = dv.getInt16(12);
  const nTracks = dv.getUint16(10);
  let pos = 8 + headerLen;

  let ppqn = 480, isSmpte = false;
  if (division & 0x8000) {
    isSmpte = true;
    ppqn = -(division >> 8) * (division & 0xff);
  } else {
    ppqn = division || 480;
  }

  const tempoMap = [];
  const lyricEvents = [];
  const noteEvents = []; // {tick, track, chan, note, on}
  const trackNames = [];
  const programByChannel = new Array(16).fill(null); // first GM program seen per channel (for mixer labels)
  let keySig = null; // {sf, mi} from the first Key Signature meta (0x59)
  let timeSig = null; // {num, den} from the first Time Signature meta (0x58) — chords.js bars on it

  for (let t = 0; t < nTracks && pos < dv.byteLength; t++) {
    if (str(pos, 4) !== "MTrk") break;
    const trackLen = dv.getUint32(pos + 4);
    let p = pos + 8;
    const end = p + trackLen;
    let tick = 0;
    let runningStatus = 0;

    while (p < end) {
      let delta = 0, b;
      do { b = u8(p++); delta = (delta << 7) | (b & 0x7f); } while (b & 0x80);
      tick += delta;

      let status = u8(p);
      if (status & 0x80) {
        p++;
        // Running status carries over only for channel-voice messages (0x80–0xEF).
        // System/meta/sysex bytes (>=0xF0) MUST clear it per the SMF spec, else a
        // following running-status event would be misparsed as another meta event.
        runningStatus = status < 0xf0 ? status : 0;
      } else {
        status = runningStatus;
      }

      if (status === 0xff) {
        const metaType = u8(p++);
        let len = 0;
        do { b = u8(p++); len = (len << 7) | (b & 0x7f); } while (b & 0x80);
        const dataStart = p;
        if (metaType === 0x51 && len === 3) {
          tempoMap.push({ tick, usPerQuarter: (u8(dataStart) << 16) | (u8(dataStart + 1) << 8) | u8(dataStart + 2) });
        } else if (metaType === 0x01 || metaType === 0x05) {
          lyricEvents.push({ tick, type: metaType, text: decodeText(new Uint8Array(arrayBuffer, dataStart, len)) });
        } else if (metaType === 0x03) {
          trackNames[t] = decodeText(new Uint8Array(arrayBuffer, dataStart, len));
        } else if (metaType === 0x59 && len === 2 && !keySig) {
          keySig = { sf: (u8(dataStart) << 24) >> 24, mi: u8(dataStart + 1) }; // sf signed
        } else if (metaType === 0x58 && len >= 2 && !timeSig) {
          timeSig = { num: u8(dataStart), den: 1 << u8(dataStart + 1) }; // dd byte is the power of two
        }
        p = dataStart + len;
      } else if (status === 0xf0 || status === 0xf7) {
        let len = 0;
        do { b = u8(p++); len = (len << 7) | (b & 0x7f); } while (b & 0x80);
        p += len;
      } else {
        const hi = status & 0xf0;
        const chan = status & 0x0f;
        if (hi === 0x90 || hi === 0x80) {
          const note = u8(p), vel = u8(p + 1);
          noteEvents.push({ tick, track: t, chan, note, on: hi === 0x90 && vel > 0 });
        } else if (hi === 0xc0 && programByChannel[chan] == null) {
          programByChannel[chan] = u8(p); // first program change → the channel's instrument
        }
        p += (hi === 0xc0 || hi === 0xd0) ? 1 : 2;
      }
    }
    pos = end;
  }

  tempoMap.sort((a, b) => a.tick - b.tick);
  lyricEvents.sort((a, b) => a.tick - b.tick);
  if (tempoMap.length === 0 || tempoMap[0].tick > 0) {
    tempoMap.unshift({ tick: 0, usPerQuarter: 500000 });
  }
  return { ppqn, isSmpte, tempoMap, lyricEvents, noteEvents, trackNames, nTracks, keySig, timeSig, programByChannel };
}

/** Public helper: a tick→seconds function for a parsed MIDI (used by melody.js). */
export function makeTickToSeconds(parsed) {
  return buildTickToSeconds(parsed.tempoMap, parsed.ppqn, parsed.isSmpte);
}

function buildTickToSeconds(tempoMap, ppqn, isSmpte) {
  if (isSmpte) return (tick) => tick / ppqn;
  const segs = tempoMap.map((t) => ({ ...t, sec: 0 }));
  for (let i = 1; i < segs.length; i++) {
    const prev = segs[i - 1];
    prev.secPerTick = prev.usPerQuarter / 1e6 / ppqn;
    segs[i].sec = prev.sec + (segs[i].tick - prev.tick) * prev.secPerTick;
  }
  const last = segs[segs.length - 1];
  last.secPerTick = last.usPerQuarter / 1e6 / ppqn;
  return (tick) => {
    let lo = 0, hi = segs.length - 1, idx = 0;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (segs[mid].tick <= tick) { idx = mid; lo = mid + 1; } else hi = mid - 1;
    }
    const seg = segs[idx];
    return seg.sec + (tick - seg.tick) * seg.secPerTick;
  };
}

// ----------------------------------------------------------------------------
// Group raw lyric events into timed lines of syllables.
// KAR conventions: '/' = new line, '\' = new paragraph, '@' lines = metadata.
// ----------------------------------------------------------------------------

// Singer tags (a duet convention): "@m" / "@w" / "@c" events, or a "M:" / "F:" / "B:" / "D:"
// prefix on a syllable. The letter must be followed by whitespace or nothing, so a KAR
// metadata tag such as "@TTitle" or "@LENG" can never be mistaken for one.
const SINGER_TAG = /^\s*@([mwc])(?:\s+([\s\S]*))?$/i;
const SINGER_PREFIX = /^\s*([MFBD]):\s*([\s\S]*)$/;
const PREFIX_SINGER = { M: "m", F: "w", B: "c", D: "c" };

/**
 * Lines plus the count-in CUES some files carry. MegaOke-style files mark a
 * count-in with one-character "#" lyric events (usually five, a beat apart) just before the
 * line they introduce. They are a timing signal, never text: shown, they read "#####Barcelona"
 * and drag the line's start five beats early. Returned as `cues` (seconds) for the stage view's
 * 4-3-2-1 count-in; every other caller only wants `lines` (see buildLines).
 * Each line also carries `singer` ("m" | "w" | "c" | "").
 */
export function buildLyrics(lyricEvents, tickToSeconds) {
  const has05 = lyricEvents.some((e) => e.type === 0x05);
  const src = lyricEvents.filter((e) => (has05 ? e.type === 0x05 : e.type === 0x01));

  const lines = [];
  const cues = [];
  let cur = null;
  let singer = "";
  const pushLine = () => { if (cur && cur.syllables.length) lines.push(cur); cur = null; };
  const ensureLine = (time) => { if (!cur) cur = { start: time, end: time, syllables: [], singer }; };

  for (const ev of src) {
    let text = ev.text;
    if (text == null) continue;
    const time = tickToSeconds(ev.tick);
    text = text.replace(/\r\n|\r|\n/g, "/");
    // Strip stray '^' markers some KAR files embed in the syllable text (a caret
    // not meant to be shown). Done before break handling so a '^' in front of a
    // '/' line-break can't hide the break. Empty leftovers are dropped below.
    text = text.replace(/\^/g, "");

    // Leading breaks first: a tag usually rides the break that starts its line ("/F: She").
    let breakBefore = false;
    while (text[0] === "/" || text[0] === "\\") { breakBefore = true; text = text.slice(1); }
    if (breakBefore) pushLine();

    // Count-in cue: a timing mark, not a syllable. A break riding after it still breaks.
    if (/^\s*#/.test(text)) {
      cues.push(time);
      if (/[/\\]/.test(text)) pushLine();
      continue;
    }

    const tag = SINGER_TAG.exec(text);
    if (tag) {
      singer = tag[1].toLowerCase();
      if (cur) cur.singer = singer;  // a tag inside an open line re-labels that line
      text = tag[2] || "";
      if (!text.trim()) continue;
    } else if (text[0] === "@") {
      continue;                      // KAR metadata (@T title, @L language, …)
    } else {
      const pre = SINGER_PREFIX.exec(text);
      if (pre) {
        singer = PREFIX_SINGER[pre[1]];
        if (cur) cur.singer = singer;
        text = pre[2];
      }
    }
    if (text.length === 0) continue;

    ensureLine(time);
    cur.syllables.push({ time, text });
    cur.end = time;
  }
  pushLine();
  lines.sort((a, b) => a.start - b.start);
  return { lines, cues };
}

/** The timed lines only — the shape every caller had before count-in cues existed. */
export function buildLines(lyricEvents, tickToSeconds) {
  return buildLyrics(lyricEvents, tickToSeconds).lines;
}

// Merge every `n` consecutive source lines into one display line.
function mergeLines(lines, n) {
  if (n <= 1) return lines.map((l) => ({ ...l, syllables: l.syllables.slice() }));
  const out = [];
  for (let i = 0; i < lines.length; i += n) {
    const group = lines.slice(i, i + n).filter(Boolean);
    if (!group.length) break;
    const syllables = [];
    group.forEach((line, gi) => {
      const s = line.syllables.map((x) => ({ ...x }));
      // add a separating space between joined source lines
      if (gi < group.length - 1 && s.length) s[s.length - 1].text += " ";
      syllables.push(...s);
    });
    out.push({ start: group[0].start, end: group[group.length - 1].end, syllables });
  }
  return out;
}

// Give each syllable an end time so the smooth wipe knows its duration.
function computeSyllableEnds(lines) {
  for (let li = 0; li < lines.length; li++) {
    const line = lines[li];
    const nextLineStart = li + 1 < lines.length ? lines[li + 1].start : Infinity;
    const s = line.syllables;
    for (let j = 0; j < s.length; j++) {
      const naturalEnd = j + 1 < s.length ? s[j + 1].time : Math.min(nextLineStart, s[j].time + 0.9);
      s[j].end = Math.max(s[j].time + 0.05, naturalEnd);
    }
  }
  return lines;
}

/**
 * One syllable → the pieces it is drawn as: each run of non-space characters a word piece with its
 * own share of the syllable's time (by character position, so a line-timed .lrc / .txt "syllable"
 * holding a whole line still wipes left to right), each run of spaces a plain text piece. A word
 * piece never contains a space, so its ::after copy (the sung layer) never wraps away from it.
 * @returns {{text:string, word:boolean, t:number, e:number}[]}
 */
export function sylPieces(text, start, end) {
  const str = String(text ?? "");
  const n = str.length;
  const st = Number(start) || 0;
  const en = Math.max(st, Number(end) || st);
  const out = [];
  const re = /\s+|\S+/g;
  let m;
  while ((m = re.exec(str))) {
    const a = m.index, b = a + m[0].length;
    out.push({ text: m[0], word: !/^\s/.test(m[0]), t: st + (en - st) * a / n, e: st + (en - st) * b / n });
  }
  return out;
}

// ----------------------------------------------------------------------------
// LyricsEngine — a smooth-scrolling column of lines.
// ----------------------------------------------------------------------------

const ANCHOR = 0.44; // where the active line sits in the viewport (fraction from top)

export class LyricsEngine {
  /**
   * @param {HTMLElement} container  #lyrics — we build a viewport + scroll column inside
   * @param {{lineCount?:number, smooth?:boolean, mergeLines?:number}} opts
   */
  constructor(container, opts = {}) {
    this.container = container;
    this.lineCount = opts.lineCount ?? 4;
    this.smooth = opts.smooth ?? true;
    this.merge = Math.max(1, opts.mergeLines ?? 1);

    this.rawLines = [];
    this.lines = [];
    this.lineEls = [];
    this.activeLine = -1;
    this.hasLyrics = false;
    this._painted = new Set();   // line indices whose words carry a wipe state (see _unpaint)

    // Build the viewport (masked, clips) + the scrolling column.
    container.innerHTML = "";
    container.style.setProperty("--vis-lines", this.lineCount);
    this.view = document.createElement("div");
    this.view.className = "lyric-view";
    this.scroll = document.createElement("div");
    this.scroll.className = "lyric-scroll";
    this.view.appendChild(this.scroll);
    container.appendChild(this.view);

    window.addEventListener("resize", () => this._rescroll());
  }

  setOptions({ lineCount, smooth, mergeLines } = {}) {
    let rebuild = false;
    if (lineCount != null) {
      this.lineCount = Math.max(1, lineCount | 0);
      this.container.style.setProperty("--vis-lines", this.lineCount);
    }
    if (smooth != null) this.smooth = !!smooth;
    if (mergeLines != null && mergeLines !== this.merge) {
      this.merge = Math.max(1, mergeLines | 0);
      rebuild = true;
    }
    if (rebuild && this.rawLines.length) this._rebuild();
    else this._rescroll();
  }

  /**
   * The stage style's look, shared by this column (Rae, 2026-11-24): `color` = the sung colour,
   * `outline` = the outline thickness in 63rds of the font (the stage's own unit, 0–16), `shadow`
   * = the drop shadow on / off. Written as CSS variables on the view (scroll-lyrics.css).
   */
  setLook({ color, outline, shadow } = {}) {
    const v = this.view.style;
    if (typeof color === "string" && color) v.setProperty("--lyr-hi", color);
    if (outline != null) {
      const o = Math.min(16, Math.max(0, Number(outline) || 0));
      v.setProperty("--lyr-stroke", (o / 63).toFixed(4) + "em");
    }
    if (shadow != null) v.setProperty("--lyr-shadow", shadow ? "0.032em 0.032em 0.064em #000" : "none");
  }

  load(parsed) {
    const t2s = buildTickToSeconds(parsed.tempoMap, parsed.ppqn, parsed.isSmpte);
    return this.loadLines(buildLines(parsed.lyricEvents, t2s));
  }

  /**
   * Load pre-built raw lines directly (used by the AUDIO source's sidecar formats —
   * .lrc/.vtt/.srt/.txt via lyrics-formats.js, or a lyrics-only .kar/.mid via
   * buildLines). Shape: [{ start, end, syllables:[{ time, text }] }].
   */
  loadLines(rawLines) {
    this.rawLines = Array.isArray(rawLines) ? rawLines : [];
    this.hasLyrics = this.rawLines.length > 0;
    this._rebuild();
    return this.hasLyrics;
  }

  // (re)compute display lines from rawLines using the current merge setting.
  _rebuild() {
    this.lines = computeSyllableEnds(mergeLines(this.rawLines, this.merge));
    this.activeLine = -1;
    this._renderAll();
    this._scrollToIndex(-1);
  }

  reset() {
    this.activeLine = -1;
    for (const j of this._painted) this._unpaint(j);
    this._painted.clear();
    this._setClasses(-1);
    this._scrollToIndex(-1);
  }

  // Blank the display entirely (used when playback stops / between songs).
  clear() {
    this.rawLines = [];
    this.lines = [];
    this.lineEls = [];
    this.hasLyrics = false;
    this.activeLine = -1;
    this.scroll.innerHTML = "";
    this.scroll.style.transform = "translateY(0)";
  }

  _renderAll() {
    this.scroll.innerHTML = "";
    this.lineEls = [];
    this._painted.clear();
    if (!this.hasLyrics) {
      const el = document.createElement("div");
      el.className = "line placeholder";
      el.textContent = "♪  instrumental — no lyrics in this file  ♪";
      this.scroll.appendChild(el);
      this.lineEls.push(el);
      return;
    }
    // The stage's duet rules (lyric-pager prepareStageLines): a line's singer colours its sung
    // part, and its marker shows when the singer changes or after a STAGE.SINGER_GAP gap.
    let shown = "";
    let prevEnd = -Infinity;
    for (const line of this.lines) {
      const el = document.createElement("div");
      el.className = "line upcoming";
      const singer = line.singer || "";
      if (SINGER_COLORS[singer]) el.style.setProperty("--hi", SINGER_COLORS[singer]);
      if (singer && SINGER_MARKS[singer] && (singer !== shown || line.start - prevEnd > STAGE.SINGER_GAP)) {
        const mark = document.createElement("span");
        mark.className = "syl-mark";
        mark.textContent = SINGER_MARKS[singer];
        el.append(mark, " ");
      }
      if (singer) shown = singer;
      prevEnd = line.end;
      for (const syl of splitParens(line.syllables)) {
        for (const piece of sylPieces(syl.text, syl.time, syl.end)) {
          if (!piece.word) { el.appendChild(document.createTextNode(piece.text)); continue; }
          const span = document.createElement("span");
          span.className = syl.paren ? "syl bk" : "syl";
          span.dataset.t = piece.t;
          span.dataset.e = piece.e;
          span.dataset.f = syl.time;          // the whole syllable flips at once (smooth wipe off)
          span.dataset.text = piece.text;     // the sung layer's text (::after content)
          span.textContent = piece.text;
          el.appendChild(span);
        }
      }
      this.scroll.appendChild(el);
      this.lineEls.push(el);
    }
  }

  _lineIndexAt(t) {
    const L = this.lines;
    let lo = 0, hi = L.length - 1, idx = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (L[mid].start <= t) { idx = mid; lo = mid + 1; } else hi = mid - 1;
    }
    return idx;
  }

  _setClasses(idx) {
    for (let i = 0; i < this.lineEls.length; i++) {
      const el = this.lineEls[i];
      const cls = i < idx ? "past" : i === idx ? "current" : "upcoming";
      el.className = "line " + cls;
    }
  }

  _scrollToIndex(idx) {
    if (!this.hasLyrics || !this.lineEls.length) { this.scroll.style.transform = "translateY(0)"; return; }
    const target = this.lineEls[idx < 0 ? 0 : idx];
    const anchor = this.view.clientHeight * ANCHOR;
    const center = target.offsetTop + target.offsetHeight / 2;
    this._y = anchor - center;
    this.scroll.style.transform = `translateY(${this._y.toFixed(1)}px)`;
  }

  _rescroll() {
    this._scrollToIndex(this.activeLine);
  }

  /** Call every frame with the (offset-adjusted) playback time in seconds. */
  update(t) {
    if (!this.hasLyrics) return;
    const idx = this._lineIndexAt(t);
    if (idx !== this.activeLine) {
      this.activeLine = idx;
      // A line that is upcoming again (a seek back) loses the wipe it had (past lines are drawn
      // fully sung by the stylesheet, whatever their words carry).
      for (const j of this._painted) if (j > idx) { this._unpaint(j); this._painted.delete(j); }
      this._setClasses(idx);
      this._scrollToIndex(idx);
    }
    if (idx >= 0) { this._paint(this.lineEls[idx], t); this._painted.add(idx); }
  }

  // --fill (0–100 %) drives the sung layer's clip; `on` shows it at all (so a word not yet reached
  // shows no sliver of its outline), `full` lets it keep its right-hand outline and shadow.
  _paint(el, t) {
    if (!el) return;
    const spans = el.children;
    for (let i = 0; i < spans.length; i++) {
      const span = spans[i];
      if (!span.classList.contains("syl")) continue;   // the singer marker
      const st = +span.dataset.t;
      const en = +span.dataset.e;
      const fill = this.smooth
        ? (t <= st ? 0 : t >= en ? 1 : (t - st) / (en - st))
        : (t >= +span.dataset.f ? 1 : 0);
      span.style.setProperty("--fill", (fill * 100).toFixed(1) + "%");
      span.classList.toggle("on", fill > 0);
      span.classList.toggle("full", fill >= 1);
    }
  }

  _unpaint(j) {
    const el = this.lineEls[j];
    if (!el) return;
    for (const span of el.children) {
      span.style.removeProperty("--fill");
      span.classList.remove("on", "full");
    }
  }
}
