/*
 * title-card.js — the song intro shown when a song loads: title, artist, and a small line with who
 * reserved it and its key, centred over the lyric area (2026-11-24).
 *
 * A clean-room rebuild of how the commercial videoke app's intro BEHAVES (behaviour and rough layout
 * only; no code, strings or assets): no panel, a calm text block over the stage, and the lyrics
 * HIDDEN while it shows. Hiding works by a body class (`title-card-on`, TITLE_CARD_BODY_CLASS);
 * title-card.css hides `#lyrics` (both the scroll view `.lyric-view` and the stage canvas
 * `.lyric-stage` live inside it) and the verdict chip while that class is set.
 *
 * Text arrives from file names, YouTube titles and phones, so it is only ever written with
 * textContent. The module builds its own children once; the markup is just the empty element:
 *   <div id="title-card" class="tcard" aria-hidden="true"></div>
 *
 * When it leaves: the caller decides. show() can arm a timer (`{ ms }`, the titleCard.seconds
 * setting), and titleCardYields(plan, t) says when the lyrics need the screen back — the first
 * count-in beat in front of line 0, else line 0's start (the same boundary as lyric-pager.js
 * pageAt's `intro`). hide() is idempotent and always cancels the timer.
 */

/** The class on <body> while the card is up; title-card.css hides the lyrics under it. */
export const TITLE_CARD_BODY_CLASS = "title-card-on";

/** The class on the card element while it is up. */
export const TITLE_CARD_ON_CLASS = "is-on";

/** Longest text kept per field, in code points (CSS clamps the rest visually). */
const MAX_LEN = 200;

const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/g;

/** One field as display text: a string, control characters as spaces, whitespace collapsed, trimmed, capped. */
function clean(v) {
  if (v == null) return "";
  const s = String(v).replace(CONTROL_CHARS, " ").replace(/\s+/g, " ").trim();
  const cps = Array.from(s);
  return cps.length > MAX_LEN ? cps.slice(0, MAX_LEN).join("").trimEnd() + "…" : s;
}

/**
 * What each line of the card says. Pure.
 *   title  — the song title
 *   artist — the song's artist
 *   singer — "🎤 <name>" for who reserved it (the same glyph as the stage banner), "" when nobody
 *   key    — "Key <name>" (e.g. "Key A minor"), "" when no key is known or shown
 * @param {{title?: any, artist?: any, singer?: any, keyName?: any}} [info]
 * @returns {{title: string, artist: string, singer: string, key: string}}
 */
export function titleCardText({ title, artist, singer, keyName } = {}) {
  const who = clean(singer);
  const key = clean(keyName);
  return {
    title: clean(title),
    artist: clean(artist),
    singer: who ? `🎤 ${who}` : "",
    key: key ? `Key ${key}` : "",
  };
}

/**
 * When the lyrics take the stage, in lyric seconds: the first beat of the count-in in front of the
 * first line, when it has one, else the first line's start. null when there are no lines. Pure.
 * @param {{lines?: Array<{start: number}>, cdByLine?: Map<number, {beats: number[]}>}|null} plan
 *   a stage plan (lyric-pager.js makeStagePlan; app.js: `lyrics.stage.plan`)
 * @returns {number|null}
 */
export function lyricsStartAt(plan) {
  const lines = plan && Array.isArray(plan.lines) ? plan.lines : [];
  if (!lines.length) return null;
  const start = lines[0] && Number.isFinite(lines[0].start) ? lines[0].start : null;
  const cd = plan.cdByLine && typeof plan.cdByLine.get === "function" ? plan.cdByLine.get(0) : null;
  const beat = cd && Array.isArray(cd.beats) && Number.isFinite(cd.beats[0]) ? cd.beats[0] : null;
  if (beat != null && start != null) return Math.min(beat, start);
  return beat != null ? beat : start;
}

/**
 * True once lyric time `t` has reached lyricsStartAt(plan): the card should give the stage back.
 * False when there are no lyrics (the caller's timer ends the card then). Pure.
 * @param {object|null} plan
 * @param {number} t lyric time in seconds (playback time + lyrics.offsetMs)
 */
export function titleCardYields(plan, t) {
  const at = lyricsStartAt(plan);
  return at != null && Number.isFinite(t) && t >= at;
}

/**
 * @param {object}   o
 * @param {Element}  o.el          the card element (#title-card); its children are built here
 * @param {Document} [o.doc]       for createElement and body (tests pass a fake)
 * @param {Function} [o.setTimer]  setTimeout stand-in (tests)
 * @param {Function} [o.clearTimer] clearTimeout stand-in (tests)
 * @returns {{ show: (info?: object, opts?: {ms?: number}) => boolean, hide: () => void, readonly visible: boolean, readonly text: object }}
 */
export function createTitleCard({
  el,
  doc = typeof document !== "undefined" ? document : null,
  setTimer = (fn, ms) => setTimeout(fn, ms),
  clearTimer = (id) => clearTimeout(id),
} = {}) {
  if (!el) throw new Error("createTitleCard: el is required");
  if (!doc) throw new Error("createTitleCard: doc is required");

  const make = (tag, cls) => {
    const n = doc.createElement(tag);
    n.className = cls;
    return n;
  };
  const titleEl = make("div", "tcard-title");
  const artistEl = make("div", "tcard-artist");
  const metaEl = make("div", "tcard-meta");
  const singerEl = make("span", "tcard-singer");
  const keyEl = make("span", "tcard-key");
  metaEl.replaceChildren(singerEl, keyEl);
  const block = make("div", "tcard-block");
  block.replaceChildren(titleEl, artistEl, metaEl);
  el.replaceChildren(block);
  // The status line already names the song (▶ Title — Artist); the card is visual only.
  el.setAttribute("aria-hidden", "true");

  let visible = false;
  let timer = null;
  let text = titleCardText();

  const stopTimer = () => { if (timer != null) { clearTimer(timer); timer = null; } };
  const setOn = (on) => {
    visible = on;
    el.classList.toggle(TITLE_CARD_ON_CLASS, on);
    if (doc.body && doc.body.classList) doc.body.classList.toggle(TITLE_CARD_BODY_CLASS, on);
  };

  function hide() {
    stopTimer();
    if (visible) setOn(false);
  }

  /**
   * Fill the card and show it (lyrics hidden from this call until hide()). Showing again while it
   * is up replaces the text and restarts the timer. Nothing to say (no title and no artist) → the
   * card is hidden instead and false is returned, so it never blanks the lyrics for nothing.
   * @param {{title?: string, artist?: string, singer?: string, keyName?: string}} [info]
   * @param {{ms?: number}} [opts] ms > 0 → hide() after that many milliseconds
   */
  function show(info = {}, { ms } = {}) {
    stopTimer();
    text = titleCardText(info);
    titleEl.textContent = text.title;
    artistEl.textContent = text.artist;
    singerEl.textContent = text.singer;
    keyEl.textContent = text.key;
    if (!text.title && !text.artist) { hide(); return false; }
    setOn(true);
    if (Number.isFinite(ms) && ms > 0) timer = setTimer(() => { timer = null; hide(); }, ms);
    return true;
  }

  return {
    show,
    hide,
    get visible() { return visible; },
    /** What the card says now (a copy). */
    get text() { return { ...text }; },
  };
}
