/*
 * song-sheet.js — the one "what do you want to do with this song?" sheet (M5, plan §5.4, P23).
 *
 * CONTRACT STUB written by the orchestrator. Lane A (sheet UI) fills the bodies; the exports,
 * their names, signatures and the action ids/labels below are the contract lane I codes against —
 * do not change them.
 *
 * Two modes:
 *   library — opened from a song row in the Songs panel (or a home/favourites list later);
 *   queue   — opened from a row of the Queue panel.
 * The sheet itself never touches the queue, the player or the overlay stack: it renders, and it
 * reports the chosen action through onAction. app.js (lane I) opens/closes the `song` overlay and
 * carries the action out.
 *
 * Wiring note for the caller: call show() BEFORE opening the `song` overlay. overlays-dom moves
 * focus in the same turn as the open, through initialFocus → firstButton(), so the buttons must
 * already be the new song's.
 */

/** Clicks this soon after show() are ignored: the second click of a habitual double-click. */
const CLICK_GUARD_MS = 250;

// Kind icon per song kind — the same glyphs, classes and names as library-ui.js's KIND_ICON
// (🎤 MIDI · 🎞️ video · 🌐 YouTube · 🎵 audio), so the sheet's header reads like the row it
// came from. That table is not exported, hence the copy; keep the two in step.
const KIND_ICON = {
  video:   { glyph: "🎞️", cls: "vid", title: "Video" },
  youtube: { glyph: "🌐", cls: "yt",  title: "YouTube" },
  midi:    { glyph: "🎤", cls: "kar", title: "MIDI" },
  audio:   { glyph: "🎵", cls: "aud", title: "Audio + lyrics" },
};
const kindIcon = (kind) => (Object.prototype.hasOwnProperty.call(KIND_ICON, kind) ? KIND_ICON[kind] : KIND_ICON.midi);

/**
 * The actions a mode offers, in display order. Pure.
 *   mode "library": reserve "Reserve" · next "Play next" · now "Play now" ·
 *                   favorite ("★ Favorite" when not a favourite | "★ Remove favorite" when it is) ·
 *                   cancel "Cancel"
 *   mode "queue":   now "Play now" · top "Move to top" (omitted when index is 0) ·
 *                   up "Move up" (omitted when index is 0) · down "Move down" (omitted when
 *                   index is the last, i.e. index >= length - 1) · remove "Remove" · cancel "Cancel"
 *   any other mode → [{ id: "cancel", label: "Cancel" }]
 * (US spelling, matching the app's "Favorites" — amendment A12 of plan v2.4.)
 * An index that cannot name a row (negative, NaN, fractional) offers no moves at all:
 * now · remove · cancel.
 * @param {"library"|"queue"} mode
 * @param {{isFavorite?: boolean, index?: number, length?: number}} [o]
 * @returns {Array<{id: string, label: string}>}
 */
export function sheetActions(mode, { isFavorite = false, index = -1, length = 0 } = {}) {
  if (mode === "library") {
    return [
      { id: "reserve", label: "Reserve" },
      { id: "next", label: "Play next" },
      { id: "now", label: "Play now" },
      { id: "favorite", label: isFavorite ? "★ Remove favorite" : "★ Favorite" },
      { id: "cancel", label: "Cancel" },
    ];
  }
  if (mode === "queue") {
    const row = Number.isInteger(index) && index >= 0;
    const out = [{ id: "now", label: "Play now" }];
    if (row && index > 0) out.push({ id: "top", label: "Move to top" }, { id: "up", label: "Move up" });
    if (row && index < length - 1) out.push({ id: "down", label: "Move down" });
    out.push({ id: "remove", label: "Remove" }, { id: "cancel", label: "Cancel" });
    return out;
  }
  return [{ id: "cancel", label: "Cancel" }];
}

/**
 * @param {object} o
 * @param {HTMLElement} o.el   #ov-song (the sheet's overlay element; its children are owned here)
 * @param {(id: string, song: object, ctx: {mode: string, index: number}) => void} o.onAction
 * @param {Document} [o.doc]
 * @param {() => number} [o.now]  clock in ms (default performance.now / Date.now), injected for tests
 * @returns {{
 *   show(song: object, opts?: {mode?: "library"|"queue", index?: number, length?: number, isFavorite?: boolean}): void,
 *   readonly song: object|null,
 *   firstButton(): HTMLElement|null,
 * }}
 *   show(): replaces el's content with
 *     - a header: the kind icon (same glyphs as library-ui: 🎤 MIDI · 🎞️ video · 🌐 YouTube · 🎵 audio),
 *       the dial number (when the song has one), title, artist, and the songbook chip
 *       (`.src-chip` with data-src, only when song.source is non-empty);
 *     - one <button type="button" data-act="<id>"> per sheetActions(mode, …) entry, in order.
 *     All text via textContent (song titles are untrusted). Wires its own click handling (one
 *     delegated listener on el, added once — no inline handlers).
 *   A click on a [data-act] button calls onAction(id, song, { mode, index }) — EXCEPT during the
 *   first 250 ms after show(), when clicks are ignored (the second click of a habitual
 *   double-click on a row must not press a sheet button). Keyboard activation of a button
 *   (Enter/Space produce a click too) is guarded the same way; 250 ms is short enough not to matter.
 *   `song` is the song last shown (null before the first show). firstButton() = the first
 *   [data-act] button (initial focus — the overlay's initialFocus uses it).
 *
 *   One show(), one action: after a button has reported, further clicks are ignored until the
 *   next show() (every action closes the sheet, and the sheet is still on screen while it slides
 *   out — a double-click on "Remove" must not remove two songs). If onAction throws, the sheet
 *   re-arms so the user can try again.
 *   A held Enter (an auto-repeat keydown — a TV remote's OK held a moment too long on the row
 *   that opened the sheet) never presses a button: the sheet prevents the repeat, which also
 *   tells the key router to leave it alone.
 *   `mode` defaults to "library"; header layout: kind · number (songbook chip under it) ·
 *   title / artist — the song row's order.
 */
export function createSongSheet({ el, onAction, doc = globalThis.document, now } = {}) {
  if (!el || typeof el.addEventListener !== "function") {
    throw new TypeError("createSongSheet: `el` (the #ov-song element) is required");
  }
  const clock = typeof now === "function" ? now
    : (globalThis.performance && typeof globalThis.performance.now === "function"
      ? () => globalThis.performance.now()
      : () => Date.now());

  let current = null;           // the song last shown
  let ctx = null;               // { mode, index } of the last show
  let shownAt = -Infinity;      // clock() at the last show
  let armed = false;            // false before the first show and after an action has reported
  let buttons = [];             // the [data-act] buttons of the last show, in order
  const actOf = new Map();      // button → action id (this show's buttons only)

  const D = () => {
    const d = doc || el.ownerDocument;
    if (!d || typeof d.createElement !== "function") {
      throw new TypeError("createSongSheet: no document to render into");
    }
    return d;
  };
  const add = (parent, child) => {
    if (typeof parent.appendChild === "function") parent.appendChild(child);
    else parent.append(child);
    return child;
  };
  const make = (d, tag, className, text) => {
    const n = d.createElement(tag);
    if (className) n.className = className;
    if (text != null) n.textContent = text;
    return n;
  };

  function renderHead(d, song) {
    const head = make(d, "div", "sheet-head");

    const k = kindIcon(song.kind);
    const icon = make(d, "span", `kind ${k.cls}`, k.glyph);
    icon.setAttribute("role", "img");
    icon.setAttribute("aria-label", k.title);
    icon.setAttribute("title", k.title);
    add(head, icon);

    // No song number or songbook here: Rae removed the numbers from the screen (2026-11-24).

    const meta = add(head, make(d, "div", "sheet-meta"));
    const name = song.name ? String(song.name) : "(untitled)";
    const title = make(d, "h2", "sheet-title", name);
    title.setAttribute("title", name);
    add(meta, title);
    if (song.artistName) add(meta, make(d, "p", "sheet-artist", String(song.artistName)));
    return head;
  }

  function renderActions(d, actions) {
    const box = make(d, "div", "sheet-actions");
    for (const a of actions) {
      const b = make(d, "button", "", a.label);
      b.setAttribute("type", "button");
      b.setAttribute("data-act", a.id);
      actOf.set(b, a.id);
      buttons.push(b);
      add(box, b);
    }
    return box;
  }

  function show(song, { mode = "library", index = -1, length = 0, isFavorite = false } = {}) {
    if (!song || typeof song !== "object") throw new TypeError("songSheet.show: a song object is required");
    const d = D();
    buttons = [];
    actOf.clear();
    const head = renderHead(d, song);
    const actions = renderActions(d, sheetActions(mode, { isFavorite, index, length }));
    if (typeof el.replaceChildren === "function") el.replaceChildren(head, actions);
    else { el.textContent = ""; add(el, head); add(el, actions); }
    current = song;
    ctx = { mode, index };
    shownAt = clock();
    armed = true;
  }

  // The delegated listeners (added once, here — never per show): click, and the held-Enter guard.
  function findButton(target) {
    let n = target;
    if (n && typeof n.closest === "function") n = n.closest("[data-act]");
    else {   // no closest(): walk up by hand
      while (n && !(typeof n.getAttribute === "function" && n.getAttribute("data-act") != null)) n = n.parentElement;
    }
    return n && actOf.has(n) ? n : null;   // only this show's buttons count
  }
  el.addEventListener("click", (ev) => {
    const btn = findButton(ev && ev.target);
    if (!btn || !armed || !current) return;
    if (clock() - shownAt < CLICK_GUARD_MS) return;
    if (typeof onAction !== "function") return;
    armed = false;
    try {
      onAction(actOf.get(btn), current, { mode: ctx.mode, index: ctx.index });
    } catch (e) {
      armed = true;
      throw e;
    }
  });
  el.addEventListener("keydown", (ev) => {
    if (!ev || !ev.repeat || (ev.key !== "Enter" && ev.keyCode !== 13)) return;
    if (findButton(ev.target) && typeof ev.preventDefault === "function") ev.preventDefault();
  });

  return {
    show,
    get song() { return current; },
    firstButton() { return buttons[0] || null; },
  };
}
