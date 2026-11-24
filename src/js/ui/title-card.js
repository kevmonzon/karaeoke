/*
 * title-card.js — the song intro shown when a song loads: title, artist, and a small line with who
 * reserved it and its key, centred over the lyric area (2026-11-24).
 *
 * A clean-room rebuild of how a commercial videoke app's intro BEHAVES (behaviour and rough layout
 * only; no code, strings or assets): no panel, a calm text block over the stage, and the lyrics
 * HIDDEN while it shows. Hiding works by a body class (`title-card-on`, TITLE_CARD_BODY_CLASS);
 * title-card.css hides `#lyrics` (both the scroll view `.lyric-view` and the stage canvas
 * `.lyric-stage` live inside it) and the verdict chip while that class is set.
 *
 * Text arrives from file names, YouTube titles and phones, so it is only ever written with
 * textContent. The module builds its own children once; the markup is just the empty element:
 *   <div id="title-card" class="tcard" aria-hidden="true"></div>
 *
 * Fit to width (Rae, 2026-11-25: ×2.5, then "enlarge it in a way that it fits the width", up to two
 * title lines): title-card.css gives each line its LARGEST size; on show() — and whenever the card
 * changes size while it is up — each line steps down only as far as it must: the title until it
 * fits two lines without splitting a word, the artist and the meta line until they fit one line.
 * Measured with the browser's own layout (scrollWidth/scrollHeight), so it needs a real document;
 * a document without getComputedStyle (the unit tests' fake) keeps the CSS sizes.
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

/** A fitted line never gets smaller than this share of its CSS size, nor than MIN_FIT_PX. */
export const MIN_FIT_SHARE = 0.25;
export const MIN_FIT_PX = 12;
/** A line that had to shrink ends this much under the largest size that measured as fitting. */
export const FIT_MARGIN = 0.97;
/** The artist and the meta line never outgrow these shares of the title's FITTED size — the card's
 *  original 48 : 24 : 16 — so a long title that shrinks never ends up smaller than its artist. */
export const ARTIST_SHARE = 0.5;
export const META_SHARE = 1 / 3;

/**
 * The largest size in [lo, hi] for which fits(size) holds, to within `step`, by bisection. `fits`
 * must be monotone (true below some size, false above). hi when hi fits; lo when nothing does. Pure.
 * @param {number} lo
 * @param {number} hi
 * @param {(size: number) => boolean} fits
 * @param {number} [step]
 */
export function largestFitting(lo, hi, fits, step = 0.5) {
  if (!(hi > lo)) return lo;
  if (fits(hi)) return hi;
  if (!fits(lo)) return lo;
  while (hi - lo > step) {
    const mid = (lo + hi) / 2;
    if (fits(mid)) lo = mid; else hi = mid;
  }
  return lo;
}

/** Content wider than the box (a word past the edge, an ellipsis). 1 px of rounding allowed. */
const overflowsX = (n) => n.scrollWidth > n.clientWidth + 1;
/** Content taller than the box (a line-clamped title that needs another line). */
const overflowsY = (n) => n.scrollHeight > n.clientHeight + 1;

/**
 * Step `node`'s font size down from its CSS size (or `cap`, when smaller) until fits() holds.
 * Returns the size used, or null when it cannot measure (empty, not laid out — a hidden lyric
 * area — or no layout at all).
 */
function fitFont(node, fits, win, cap = Infinity) {
  node.style.fontSize = "";
  if (!node.textContent || !win || typeof win.getComputedStyle !== "function") return null;
  const css = parseFloat(win.getComputedStyle(node).fontSize);
  if (!(css > 0) || !node.clientWidth) return null;
  // The cap (a share of the title) never pushes a line under MIN_FIT_PX — 8 px is not text.
  const max = Math.min(css, Math.max(cap > 0 ? cap : css, MIN_FIT_PX));
  const at = (px) => { node.style.fontSize = `${px}px`; return fits(); };
  const lo = Math.max(MIN_FIT_PX, max * MIN_FIT_SHARE);
  const px = largestFitting(lo, max, at);
  if (px >= max) { node.style.fontSize = max < css ? `${max}px` : ""; return max; }
  // Stop a little short of the boundary: scrollWidth is rounded to whole pixels, so a size that
  // "fits" can still be a fraction too wide — the title's overflow-wrap: anywhere then splits the
  // last letter onto a line of its own ("Barcelon / a", measured on a 390 px phone).
  const safe = Math.max(lo, px * FIT_MARGIN);
  node.style.fontSize = `${safe}px`;
  return safe;
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

  // The title is measured with overflow-wrap: normal, so a word too long for the width overflows
  // sideways (and fails the fit) instead of being split; the CSS's `anywhere` comes back after, and
  // only ever splits a word when even the smallest size cannot hold it.
  function fit() {
    const win = doc.defaultView;
    if (!win) return;
    titleEl.style.overflowWrap = "normal";
    const t = fitFont(titleEl, () => !overflowsX(titleEl) && !overflowsY(titleEl), win);
    titleEl.style.overflowWrap = "";
    const cap = (share) => (t ? t * share : Infinity);
    fitFont(artistEl, () => !overflowsX(artistEl), win, cap(ARTIST_SHARE));
    fitFont(metaEl, () => !overflowsX(metaEl) && !Array.from(metaEl.children).some(overflowsX), win, cap(META_SHARE));
  }
  // Re-fit when the card's box changes while it is up (a panel opens and narrows the stage, the
  // window turns, the guide hides). Changing the lines' font sizes never resizes the card itself.
  const RO = doc.defaultView && doc.defaultView.ResizeObserver;
  if (typeof RO === "function") new RO(() => { if (visible) fit(); }).observe(el);
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
    fit();
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
