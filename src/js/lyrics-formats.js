/*
 * lyrics-formats.js — parse sidecar lyric files for AUDIO songs into the "rawLines"
 * shape LyricsEngine.loadLines() consumes:
 *
 *     [{ start, end, syllables:[{ time, text }] }]     (times in seconds)
 *
 * Supported here (pure, unit-tested):
 *   .lrc  — LRC, incl. multiple timestamps per line + ENHANCED per-word <mm:ss.xx> timing
 *   .vtt  — WebVTT cues
 *   .srt  — SubRip cues
 *   .txt  — plain text (no timing → synced:false; app.js distributes across the duration)
 *
 * A lyrics-only .kar/.mid sidecar is NOT handled here — the caller runs the existing
 * parseMidi() + buildLines() (binary path) instead.
 *
 * Every parser returns { lines, synced } so the caller knows whether real timing exists.
 */

// hh:mm:ss with a . or , fractional part, or just mm:ss(.xx). Returns seconds.
function toSeconds(str) {
  const m = String(str).trim().match(/^(?:(\d+):)?(\d{1,2}):(\d{1,2})(?:[.,](\d{1,3}))?$/);
  if (!m) return null;
  const h = m[1] ? +m[1] : 0;
  const min = +m[2];
  const sec = +m[3];
  const frac = m[4] ? +("0." + m[4]) : 0;
  return h * 3600 + min * 60 + sec + frac;
}

// Build a line record from a start time + syllables; end = last syllable's time.
function makeLine(start, syllables) {
  const syls = syllables.filter((s) => s.text && s.text.length);
  const end = syls.length ? syls[syls.length - 1].time : start;
  return { start, end, syllables: syls };
}

// ----------------------------------------------------------------------------
// LRC (incl. enhanced word timing)
// ----------------------------------------------------------------------------

const LRC_TAG = /\[(\d{1,3}):(\d{1,2}(?:[.:]\d{1,3})?)\]/g; // [mm:ss.xx] line timestamps
const LRC_WORD = /<(\d{1,3}):(\d{1,2}(?:[.:]\d{1,3})?)>/g;   // <mm:ss.xx> word timestamps

function lrcStampToSec(mm, rest) {
  const sec = parseFloat(String(rest).replace(":", "."));
  return (+mm) * 60 + (isNaN(sec) ? 0 : sec);
}

// Split an enhanced-LRC line body into per-word syllables; falls back to one syllable.
function enhancedSyllables(body, lineStart) {
  const out = [];
  const tags = [];
  LRC_WORD.lastIndex = 0;
  let m;
  while ((m = LRC_WORD.exec(body)) !== null) {
    tags.push({ index: m.index, end: LRC_WORD.lastIndex, time: lrcStampToSec(m[1], m[2]) });
  }
  if (!tags.length) {
    const text = body.trim();
    return text ? [{ time: lineStart, text }] : [];
  }
  // leading text before the first <tag> belongs to the line start
  const lead = body.slice(0, tags[0].index);
  if (lead.trim()) out.push({ time: lineStart, text: lead });
  for (let i = 0; i < tags.length; i++) {
    const next = i + 1 < tags.length ? tags[i + 1].index : body.length;
    const text = body.slice(tags[i].end, next);
    if (text.length) out.push({ time: tags[i].time, text });
  }
  return out;
}

export function parseLrc(text) {
  const lines = [];
  let offset = 0; // [offset:±ms] shifts every timestamp
  for (const raw of String(text).split(/\r\n|\r|\n/)) {
    const offm = raw.match(/^\s*\[offset:\s*([+-]?\d+)\s*\]/i);
    if (offm) { offset = (+offm[1]) / 1000; continue; }

    // collect leading [mm:ss.xx] tags
    LRC_TAG.lastIndex = 0;
    const stamps = [];
    let m;
    let lastEnd = 0;
    while ((m = LRC_TAG.exec(raw)) !== null) {
      if (m.index !== lastEnd) break; // stop at the first non-leading position
      stamps.push(lrcStampToSec(m[1], m[2]));
      lastEnd = LRC_TAG.lastIndex;
    }
    if (!stamps.length) continue; // metadata ([ar:], [ti:]…) or blank → skip
    const body = raw.slice(lastEnd);
    if (!body.trim()) continue; // timestamp with no words

    for (const st of stamps) {
      // Build syllables at RAW times, then shift line + syllables by offset once.
      const syls = enhancedSyllables(body, st).map((s) => ({ time: Math.max(0, s.time + offset), text: s.text }));
      const start = Math.max(0, st + offset);
      if (syls.length) lines.push(makeLine(start, syls));
    }
  }
  lines.sort((a, b) => a.start - b.start);
  return { lines, synced: true };
}

// ----------------------------------------------------------------------------
// WebVTT / SubRip — one line per cue, using the cue start time.
// ----------------------------------------------------------------------------

function stripTags(s) {
  return s.replace(/<[^>]*>/g, "").trim();
}

function parseCues(text) {
  const lines = [];
  const blocks = String(text).replace(/\r\n|\r/g, "\n").split(/\n{2,}/);
  for (const block of blocks) {
    const rows = block.split("\n").map((r) => r.trim()).filter(Boolean);
    if (!rows.length) continue;
    const tIdx = rows.findIndex((r) => r.includes("-->"));
    if (tIdx === -1) continue; // header (WEBVTT) or numeric index-only block
    const startStr = rows[tIdx].split("-->")[0];
    const start = toSeconds(startStr.replace(/\s.*$/, "")); // drop VTT cue settings after the time
    if (start == null) continue;
    const textRows = rows.slice(tIdx + 1);
    const body = stripTags(textRows.join(" "));
    if (!body) continue;
    lines.push(makeLine(start, [{ time: start, text: body }]));
  }
  lines.sort((a, b) => a.start - b.start);
  return { lines, synced: true };
}

export function parseVtt(text) { return parseCues(text); }
export function parseSrt(text) { return parseCues(text); }

// ----------------------------------------------------------------------------
// Plain text — no timing. Returned synced:false so the caller distributes times.
// ----------------------------------------------------------------------------

export function parsePlainText(text) {
  const lines = String(text)
    .split(/\r\n|\r|\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .map((t) => ({ start: 0, end: 0, syllables: [{ time: 0, text: t }] }));
  return { lines, synced: false };
}

// ----------------------------------------------------------------------------
// Dispatch by extension. `.kar/.mid/.midi` are handled by the caller (binary MIDI),
// never here. Unknown text extensions fall back to plain text.
// ----------------------------------------------------------------------------

export function linesFromLyricFile(ext, text) {
  switch (String(ext).toLowerCase().replace(/^\./, "")) {
    case "lrc": return parseLrc(text);
    case "vtt": return parseVtt(text);
    case "srt": return parseSrt(text);
    case "txt":
    default:    return parsePlainText(text);
  }
}
