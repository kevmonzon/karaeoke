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
 */

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

export function buildLines(lyricEvents, tickToSeconds) {
  const has05 = lyricEvents.some((e) => e.type === 0x05);
  const src = lyricEvents.filter((e) => (has05 ? e.type === 0x05 : e.type === 0x01));

  const lines = [];
  let cur = null;
  const pushLine = () => { if (cur && cur.syllables.length) lines.push(cur); cur = null; };
  const ensureLine = (time) => { if (!cur) cur = { start: time, end: time, syllables: [] }; };

  for (const ev of src) {
    let text = ev.text;
    if (text == null || text[0] === "@") continue;
    const time = tickToSeconds(ev.tick);
    text = text.replace(/\r\n|\r|\n/g, "/");
    // Strip stray '^' markers some KAR files embed in the syllable text (a caret
    // not meant to be shown). Done before break handling so a '^' in front of a
    // '/' line-break can't hide the break. Empty leftovers are dropped below.
    text = text.replace(/\^/g, "");

    let breakBefore = false;
    while (text[0] === "/" || text[0] === "\\") { breakBefore = true; text = text.slice(1); }
    if (breakBefore) pushLine();
    if (text.length === 0) continue;

    ensureLine(time);
    cur.syllables.push({ time, text });
    cur.end = time;
  }
  pushLine();
  lines.sort((a, b) => a.start - b.start);
  return lines;
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
    if (!this.hasLyrics) {
      const el = document.createElement("div");
      el.className = "line placeholder";
      el.textContent = "♪  instrumental — no lyrics in this file  ♪";
      this.scroll.appendChild(el);
      this.lineEls.push(el);
      return;
    }
    for (const line of this.lines) {
      const el = document.createElement("div");
      el.className = "line upcoming";
      for (const syl of line.syllables) {
        const span = document.createElement("span");
        span.className = "syl";
        span.dataset.t = syl.time;
        span.dataset.e = syl.end;
        span.textContent = syl.text;
        el.appendChild(span);
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
      this._setClasses(idx);
      this._scrollToIndex(idx);
    }
    if (idx >= 0) this._paint(this.lineEls[idx], t);
  }

  _paint(el, t) {
    if (!el) return;
    const spans = el.children;
    for (let i = 0; i < spans.length; i++) {
      const span = spans[i];
      const st = +span.dataset.t;
      const en = +span.dataset.e;
      const fill = this.smooth
        ? (t <= st ? 0 : t >= en ? 1 : (t - st) / (en - st))
        : (t >= st ? 1 : 0);
      span.style.setProperty("--fill", (fill * 100).toFixed(1) + "%");
    }
  }
}
