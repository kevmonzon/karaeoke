/*
 * library-ui.js — the song list (Songs panel) and the queue list (Queue panel).
 *
 * The song list is VIRTUALIZED: only the rows in (and just around) the viewport
 * are in the DOM, absolutely positioned inside the scroll container; the full scroll
 * height comes from a `#song-list::after` pseudo (var --vlist-h), so the <ul>'s only
 * children are the <li> rows (valid list a11y). Row height is MEASURED from a rendered
 * probe row (measureRow) so the scroll maths match whatever the CSS makes a row.
 *
 * The queue list is short and fully rendered, but it is a roving-tabindex list too (M5): one
 * row is the tab stop, the arrows move it, and focus stays on the same song across a rebuild.
 *
 * The same <ul id="song-list"> also draws ARTIST rows (M6, renderRows rowKind "artist"): one
 * row per artist, same height, same virtual window, same roving tabindex and edges. A list can
 * mix the two: an item whose `key` is BACK_ROW is drawn as an artist-kind row ("← Artists")
 * wherever it sits, so one artist's songs are a song list with a back row at index 0.
 *
 * Pure UI: it renders song/queue data and calls back into the player for
 * play/queue actions. Local state is only the selected + now-playing song (and each list's
 * roving row).
 * Created once from app.js via createLibraryUI(callbacks) — no import cycle.
 */

const $ = (id) => document.getElementById(id);
// Row height. `--row-h` is now an expression over the viewport-driven scale unit
// (`max(44px, calc(3 * var(--u)))`), which getPropertyValue cannot turn into a number, so a
// real row is measured instead. Measuring forces layout, and this runs on EVERY scroll frame of
// a 120k-row virtual list, so the value is cached — but ONLY when it is real: the list lives in
// a panel that is display:none until opened, where every row measures 0. Caching that 0 (or the
// fallback) would lay the first open out on the wrong grid, so a zero measurement returns the
// fallback and stays uncached; the next call measures again. refresh() and a resize clear the
// cache (the font size and the viewport both change the unit).
const FALLBACK_ROW_H = 48;
let _rowH = 0;           // cached non-zero measurement (0 = measure on next use)
const clearRowCache = () => { _rowH = 0; };

/**
 * The height of one song row in `listEl` (the <ul>), measured from a hidden probe row.
 * Returns the cached value when there is one; a zero measurement returns 48 and is not cached.
 * @param {HTMLElement} listEl
 * @returns {number}
 */
export function measureRow(listEl) {
  if (_rowH) return _rowH;
  if (!listEl || typeof listEl.appendChild !== "function") return FALLBACK_ROW_H;
  const doc = listEl.ownerDocument || document;
  const probe = doc.createElement("li");
  probe.className = "song";
  probe.setAttribute("aria-hidden", "true");
  probe.setAttribute("style", "visibility:hidden");
  // The same two-line body a real row has, in case the CSS sizes a row by its content.
  probe.innerHTML = `<span class="meta"><span class="title">Ag</span><span class="artist">Ag</span></span>`;
  listEl.appendChild(probe);
  let h = 0;
  try { h = probe.getBoundingClientRect().height || 0; } finally { probe.remove(); }
  if (!(h > 0)) return FALLBACK_ROW_H;
  _rowH = h;
  return h;
}

const OVERSCAN = 5;      // extra rows above/below the viewport
const PAGE = 10;         // rows per PageUp / PageDown

/**
 * The key of the "← Artists" row (M6). An item `{ key: BACK_ROW }` is drawn as an artist-kind
 * row in ANY list and activates through onArtist(BACK_ROW). The NUL prefix keeps it apart from
 * every real artistKey (library-browse.js folds names; its own unknown bucket is "\0unknown").
 */
export const BACK_ROW = "\u0000back";
const BACK_LABEL = "← Artists";

/**
 * What one key does on a focused list row (pure). The list OWNS its movement keys, except at
 * its edges: ArrowUp on the first row, ArrowDown on the last and ArrowLeft / ArrowRight always
 * are handed to spatial navigation (`edge`, `prevent: false`), so the key router moves focus
 * out of the list exactly once. Every other movement key is consumed (`prevent: true`) with a
 * clamped target row. Any other key → null (Enter / Space / "+" are the row's, printable keys
 * are type-to-search's: the caller decides those).
 * @param {string} key    KeyboardEvent.key
 * @param {number} index  the focused row
 * @param {number} count  rows in the list
 * @returns {{move: number|null, edge: "up"|"down"|"left"|"right"|null, prevent: boolean} | null}
 */
export function listKeyPlan(key, index, count) {
  const n = Math.max(0, Math.floor(Number(count)) || 0);
  const last = n - 1;
  const i = Math.max(0, Math.min(last, Math.floor(Number(index)) || 0));
  const edge = (dir) => ({ move: null, edge: dir, prevent: false });
  const to = (j) => (n ? { move: Math.max(0, Math.min(last, j)), edge: null, prevent: true }
    : { move: null, edge: null, prevent: false });   // an empty list has nothing to move to
  switch (key) {
    case "ArrowUp": return n && i > 0 ? to(i - 1) : edge("up");
    case "ArrowDown": return n && i < last ? to(i + 1) : edge("down");
    case "ArrowLeft": return edge("left");
    case "ArrowRight": return edge("right");
    case "PageUp": return to(i - PAGE);
    case "PageDown": return to(i + PAGE);
    case "Home": return to(0);
    case "End": return to(last);
    default: return null;
  }
}

/**
 * Which queue row should hold focus after the queue list is rebuilt (pure). The row with the
 * SAME song (matched by `id`), the one nearest its old index when that song is queued twice;
 * if the song is gone (removed, or it just started), the row now at the old index, clamped to
 * the end. -1 for an empty queue (the caller falls back to the panel's Close).
 * @param {Array<{id?:string}>} prev  the queue as it was last rendered
 * @param {number} index              the row that held focus (or the roving row)
 * @param {Array<{id?:string}>} next  the queue about to be rendered
 * @returns {number}
 */
export function queueFocusTarget(prev, index, next) {
  const n = Array.isArray(next) ? next.length : 0;
  if (!n) return -1;
  const i = Math.max(0, Math.floor(Number(index)) || 0);
  const was = Array.isArray(prev) ? prev[i] : undefined;
  if (was) {
    let best = -1;
    for (let j = 0; j < n; j++) {
      const s = next[j];
      const same = s === was || (!!s && was.id != null && s.id === was.id);
      if (same && (best < 0 || Math.abs(j - i) < Math.abs(best - i))) best = j;   // ties: the earlier row
    }
    if (best >= 0) return best;
  }
  return Math.min(i, n - 1);
}

// Source icon per song kind (shown on each list + queue row): 🎤 MIDI · 🎞️ video · 🌐 YouTube · 🎵 audio.
const KIND_ICON = {
  video:   { glyph: "🎞️", cls: "vid", title: "Video" },
  youtube: { glyph: "🌐", cls: "yt",  title: "YouTube" },
  midi:    { glyph: "🎤", cls: "kar", title: "MIDI" },
  audio:   { glyph: "🎵", cls: "aud", title: "Audio + lyrics" },
};
const kindIcon = (kind) => KIND_ICON[kind] || KIND_ICON.midi;
const kindSpan = (s) => {
  const k = kindIcon(s.kind);
  return `<span class="kind ${k.cls}" title="${k.title}">${k.glyph}</span>`;
};
// A dial number is shown whenever the song has one — 0 included; YouTube rows have "".

/**
 * @param {object} cb
 * @param {(song)=>void}  cb.onPlay             play a song now (double-click / row)
 * @param {(song)=>void}  cb.onQueue            add a song to the queue (＋)
 * @param {(index)=>void} cb.onRemoveFromQueue  remove queue item at index (✕)
 * @param {(song)=>void}  cb.onToggleFavorite   star / un-star a song (★)
 * @param {(song)=>boolean} cb.isFavorite       is this song currently starred?
 * @param {(song, rowEl)=>void} [cb.onActivate]  optional (M5: the song sheet): a click or tap on a
 *        row body, and Enter on a row, call this and nothing else — no select, no play, and the
 *        row has no double-click handler. ★ / ＋ never activate the row; Space still selects and
 *        "+" / "=" still queue. Without it rows behave as before M5 (click selects, double-click
 *        and Enter play).
 * @param {(index, song, rowEl)=>void} [cb.onQueueActivate]  optional (M5): Enter, a click or a tap
 *        on a queue row body. The ✕ never activates the row.
 * @param {(dir:"up"|"down"|"left"|"right")=>void} [cb.onEdge]  optional: an arrow left the SONG list
 *        at an edge (listKeyPlan). The key is NOT prevented, so the key router still moves focus.
 * @param {(key:string, rowEl)=>void} [cb.onArtist]  optional (M6): Enter, a click or a tap on an
 *        artist-kind row (an artist, or the BACK_ROW). Never the song sheet; ★ / ＋ do not exist there.
 * @returns {{ renderRows, renderList, renderQueue, getSelectedSong, getList, setNowPlaying, refresh, focusRow, focusQueueRow }}
 */
export function createLibraryUI({ onPlay, onQueue, onRemoveFromQueue, onToggleFavorite, isFavorite, onActivate = null, onQueueActivate = null, onEdge = null, onArtist = null }) {
  const viewport = $("song-list"); // the scroll container (overflow-y: auto, position: relative)
  const rowH = () => measureRow(viewport);
  // No spacer element: the full scroll height comes from a `#song-list::after` pseudo-element sized
  // by the `--vlist-h` CSS var (set in renderList). That keeps the <ul>'s only real children the
  // <li> rows — valid list semantics (a spacer <div> child would break ul→li structure for a11y).

  let songs = [];          // the rendered ITEMS: songs, or artists ({key, name, count}), or a mix
  let rowKind = "song";    // "song" | "artist": what a plain item is drawn as (renderRows)
  let selectedSong = null;
  let nowPlaying = null;
  let emptyState = null;   // {title, hint} shown when `songs` is empty — see renderWindow
  let closeSet = null;     // Set of the rows that are close matches (marked "≈"), or null
  // Roving tabindex: exactly ONE row is a tab stop, and the arrow keys move which. Without
  // this the 65k-row list was unreachable by keyboard entirely — you could Tab to the search
  // box and every button around it, but never to a song, which on a ten-foot app driven from
  // a couch is the whole library being off-limits. Virtualization is why it needs care: the
  // roving row must stay RENDERED even when scrolled out, or the tab stop vanishes with it
  // (see renderWindow).
  let focusIndex = 0;
  let pendingFocus = false;   // focus the roving row after the next render (keyboard nav only)

  // Coalesce scroll-driven re-renders to one per frame: a fling fires scroll events faster
  // than the display refreshes, and each one rebuilt the whole visible row set.
  let framePending = false;
  const onScroll = () => {
    if (framePending) return;
    framePending = true;
    requestAnimationFrame(() => { framePending = false; renderWindow(); });
  };
  viewport.addEventListener("scroll", onScroll, { passive: true });
  // The scale unit follows the viewport, so a resize can change the row height: re-measure,
  // and re-size the scroll extent with it (not only the window of rows).
  window.addEventListener("resize", () => { clearRowCache(); setScrollHeight(); renderWindow(); });

  // An item is drawn as an artist-kind row when the list is an artist list, or when it is the
  // back row (which may head a song list: one artist's songs).
  const isArtistItem = (it) => rowKind === "artist" || (!!it && it.key === BACK_ROW);
  function makeRow(it, i, h) {
    return isArtistItem(it) ? makeArtistRow(it, i, h) : makeSongRow(it, i, h);
  }

  // An artist row: the SAME <li class="song"> box and two-line body as a song row (so measureRow,
  // the window maths and the focus ring are the song row's), with the name over its song count.
  // No ★ / ＋ (an artist is not a song); Enter / click / tap → onArtist(key), never the sheet.
  function makeArtistRow(a, i, h) {
    const back = !!a && a.key === BACK_ROW;
    const li = document.createElement("li");
    li.className = "song artist-row" + (back ? " back-row" : "");
    li.style.top = `${i * h}px`;
    li.tabIndex = i === focusIndex ? 0 : -1;   // roving tabindex, as for songs
    li.dataset.index = i;
    li.innerHTML =
      `<span class="kind artist-ico" aria-hidden="true"></span>` +
      `<span class="meta"><span class="title"></span><span class="artist"></span></span>`;
    li.querySelector(".kind").textContent = back ? "←" : "👤";
    const n = a && Number.isFinite(a.count) ? a.count : null;
    const counted = n == null ? "" : `${n.toLocaleString()} song${n === 1 ? "" : "s"}`;
    li.querySelector(".title").textContent = back ? BACK_LABEL : ((a && a.name) || "");
    // The back row says whose songs these are (a.artist), when it is told.
    li.querySelector(".artist").textContent = back
      ? [a && a.artist, counted].filter(Boolean).join(" · ")
      : counted;
    li.onclick = (ev) => {
      if (ev && ev.detail > 1) return;     // the 2nd click of a double-click lands on the NEXT list
      focusIndex = i;
      paintRowStates();
      if (onArtist && a) onArtist(a.key, li);
    };
    return li;
  }

  // A row: kind icon · title / artist · [≈] · ★ · ＋. (No song number or songbook chip since Rae
  // removed them on 2026-11-24 — the search still finds a song by its number.)
  function makeSongRow(s, i, h) {
    const close = !!closeSet && closeSet.has(s);
    const li = document.createElement("li");
    li.className = "song" + (close ? " close-match" : "") +
      (selectedSong && s.id === selectedSong.id ? " selected" : "") +
      (nowPlaying && s.id === nowPlaying.id ? " playing" : "");
    li.style.top = `${i * h}px`;
    li.tabIndex = i === focusIndex ? 0 : -1;   // roving tabindex — one stop for the whole list
    li.dataset.index = i;
    li.innerHTML =
      kindSpan(s) +
      `<span class="meta"><span class="title"></span><span class="artist"></span></span>`;
    li.querySelector(".title").textContent = s.name || "(untitled)";
    li.querySelector(".artist").textContent = s.artistName || "";
    if (close) {
      // A glyph, not a colour: role="img" is what lets the aria-label name it (§5.19's QR precedent).
      const mark = document.createElement("span");
      mark.className = "close-mark";
      mark.setAttribute("role", "img");
      mark.setAttribute("aria-label", "close match");
      mark.title = "Close match";
      mark.textContent = "≈";
      li.appendChild(mark);
    }
    const fav = isFavorite && isFavorite(s);
    // ★ and ＋ are tappable but never a focus stop (tabindex -1): a row is ONE stop for the
    // D-pad and for Tab. "+" on the row stands in for ＋; ★ moves into the song sheet in M5.
    const favBtn = document.createElement("button");
    favBtn.tabIndex = -1;
    favBtn.className = "fav" + (fav ? " on" : "");
    favBtn.textContent = fav ? "★" : "☆";
    favBtn.title = fav ? "Remove from favorites" : "Add to favorites";
    favBtn.onclick = (ev) => { ev.stopPropagation(); onToggleFavorite(s); };
    li.appendChild(favBtn);
    const addBtn = document.createElement("button");
    addBtn.tabIndex = -1;
    addBtn.className = "add";
    addBtn.textContent = "＋";
    addBtn.title = "Add to queue";
    addBtn.onclick = (ev) => { ev.stopPropagation(); onQueue(s); };
    li.appendChild(addBtn);
    if (onActivate) {
      // No dblclick: the first click already opened the sheet. The second click of a double-click
      // (detail 2) is ignored, so a habit double-click can never activate the row twice.
      li.onclick = (ev) => {
        if (ev && ev.detail > 1) return;
        focusIndex = i;
        paintRowStates();      // the activated row becomes the one tab stop (no rebuild under the pointer)
        onActivate(s, li);
      };
    } else {
      li.ondblclick = () => onPlay(s);
      li.onclick = () => { focusIndex = i; selectRow(s); };
    }
    return li;
  }

  // Render only the rows visible in the viewport (plus overscan).
  function renderWindow() {
    // An empty list used to be bare whitespace with no explanation — the worst possible
    // first-run impression, and indistinguishable from a broken search. Say what happened
    // and what to do about it.
    if (!songs.length) {
      const li = document.createElement("li");
      li.className = "empty-state";
      const t = document.createElement("div");
      t.className = "es-title";
      t.textContent = (emptyState && emptyState.title) || "Nothing here";
      li.appendChild(t);
      if (emptyState && emptyState.hint) {
        const h = document.createElement("div");
        h.className = "es-hint";
        h.textContent = emptyState.hint;
        li.appendChild(h);
      }
      viewport.replaceChildren(li);
      return;
    }
    const vh = viewport.clientHeight || 1;
    const top = viewport.scrollTop;
    const h = rowH();
    const start = Math.max(0, Math.floor(top / h) - OVERSCAN);
    const end = Math.min(songs.length, Math.ceil((top + vh) / h) + OVERSCAN);
    const frag = document.createDocumentFragment();
    for (let i = start; i < end; i++) frag.appendChild(makeRow(songs[i], i, h));
    // Keep the roving row in the DOM even when it's scrolled out of the window, or the list's
    // only tab stop disappears and Tab skips the library again. It stays absolutely positioned
    // at its real offset, so focusing it just scrolls it into view.
    if (focusIndex >= 0 && focusIndex < songs.length && (focusIndex < start || focusIndex >= end)) {
      frag.appendChild(makeRow(songs[focusIndex], focusIndex, h));
    }
    // replaceChildren DESTROYS the focused element, so keyboard focus would be dropped to
    // <body> by any re-render — including the scroll a keyboard move itself causes. Note where
    // focus was before swapping, and put it back on the roving row after.
    const hadFocus = viewport.contains(document.activeElement);
    viewport.replaceChildren(frag); // rows are the ul's only children; height is from ::after
    if (pendingFocus || hadFocus) {
      pendingFocus = false;
      const el = viewport.querySelector(`.song[data-index="${focusIndex}"]`);
      // preventScroll: a keyboard move has already scrolled (moveFocus), and a restore after a
      // wheel / drag scroll must not yank the list back to the focused row.
      if (el) el.focus({ preventScroll: true });
    }
  }

  /** Move the roving focus to `i`, scroll it into view, and put real focus on it. */
  function moveFocus(i) {
    if (!songs.length) return;
    focusIndex = Math.max(0, Math.min(songs.length - 1, i));
    const h = rowH();
    const top = focusIndex * h;
    const vh = viewport.clientHeight || 1;
    if (top < viewport.scrollTop) viewport.scrollTop = top;
    else if (top + h > viewport.scrollTop + vh) viewport.scrollTop = top + h - vh;
    pendingFocus = true;
    renderWindow();   // the scroll above may also fire renderWindow; both are idempotent
  }

  /**
   * Put focus on row `i`, or on the roving row when `i` is omitted, scrolled into view.
   * @returns {boolean} whether focus landed on a row (false for an empty list)
   */
  function focusRow(i) {
    if (!songs.length) return false;
    moveFocus(i == null ? focusIndex : i);
    const a = document.activeElement;
    return !!a && a.classList && a.classList.contains("song") && viewport.contains(a);
  }

  // Keyboard navigation for the list. Deliberately NOT a listbox: the <ul role="list"> +
  // <li> structure is a documented a11y invariant here (§5.19), so this stays a list whose
  // items happen to be focusable and actionable, which is what they already were by mouse.
  // The list owns its movement keys but not its edges (listKeyPlan): an arrow that would leave
  // it is NOT prevented, so the document key router moves focus out, once. Printable keys are
  // left alone too (type-to-search, wired by app.js on the Songs panel).
  viewport.addEventListener("keydown", (e) => {
    if (!songs.length) return;
    const row = e.target.closest && e.target.closest(".song");
    const i = row ? +row.dataset.index : focusIndex;
    const plan = listKeyPlan(e.key, i, songs.length);
    if (plan) {
      if (plan.edge) { if (onEdge) onEdge(plan.edge); return; }
      if (plan.prevent) e.preventDefault();
      if (plan.move != null) moveFocus(plan.move);
      return;
    }
    // An artist-kind row (an artist, or the back row): Enter opens it; Space is prevented so it
    // neither scrolls the list nor reaches the router as play/pause; "+" means nothing here.
    if (row && isArtistItem(songs[i])) {
      if (e.key === "Enter") {
        e.preventDefault();
        focusIndex = i;
        paintRowStates();
        if (onArtist) onArtist(songs[i].key, row);
      } else if (e.key === " ") e.preventDefault();
      return;
    }
    switch (e.key) {
      case "Enter":
        if (!row) break;
        e.preventDefault();
        if (onActivate) { focusIndex = i; paintRowStates(); onActivate(songs[i], row); }
        else onPlay(songs[i]);
        break;
      case " ":
        // Space selects the row. It is prevented, so the key router (app.js) never also reads
        // it as play/pause; the key map leaves Space / "+" to a focused row as well.
        if (row) { e.preventDefault(); focusIndex = i; selectRow(songs[i]); }
        break;
      case "+": case "=":
        if (row) { e.preventDefault(); onQueue(songs[i]); }   // matches the ＋ button
        break;
      default: return;
    }
  });

  // Set the ::after scroll-height var from the CURRENT row height. Must run whenever
  // the row height changes (font size, viewport, the panel opening) as well as when the list
  // changes, or the scroll extent desyncs from the absolutely-positioned rows.
  function setScrollHeight() {
    viewport.style.setProperty("--vlist-h", `${songs.length * rowH()}px`);
  }

  /**
   * Show `items` in the one virtual list (M6).
   *   rowKind "song"  : songs — exactly the pre-M6 renderList. An item whose `key` is BACK_ROW is
   *                     drawn as an artist-kind row wherever it sits (one artist's songs = a back
   *                     row at index 0, then songs).
   *   rowKind "artist": `{key, name, count}` items, one artist row each.
   * Either way: the same row height (measureRow), the same window (viewport + overscan + the
   * roving row), the same roving tabindex and listKeyPlan edges. getList() returns `items`.
   * @param {object[]} items
   * @param {{rowKind?: "song"|"artist", empty?: {title:string, hint?:string}|null, closeSet?: Set<object>|null}} [o]
   *        empty: what to say when the list comes back empty · closeSet: the song rows to mark "≈"
   */
  function renderRows(items, { rowKind: kind = "song", empty = null, closeSet: marks = null } = {}) {
    songs = Array.isArray(items) ? items : [];
    rowKind = kind === "artist" ? "artist" : "song";
    emptyState = empty || null;
    closeSet = rowKind === "song" ? marks : null;
    focusIndex = 0;          // a new result set starts at the top
    pendingFocus = false;    // …but never steals focus from whatever the user is typing in
    setScrollHeight();
    viewport.scrollTop = 0;
    renderWindow();
    // The ⚙ hint "Showing N songs" counts SONGS: an artist list leaves it as it was, and a back
    // row is not a song.
    if (rowKind === "song") {
      const lc = $("list-count");
      if (lc) {
        const n = songs.length && songs[0] && songs[0].key === BACK_ROW ? songs.length - 1 : songs.length;
        lc.textContent = n.toLocaleString();
      }
    }
  }

  /**
   * The pre-M6 entry point, now a thin wrapper: a song list.
   * @param {{title:string, hint?:string}} [empty] what to say when the list comes back empty
   * @param {{closeSet?: Set<object>}} [opts]  closeSet: the rows to mark "≈" (close matches)
   */
  function renderList(newSongs, empty, { closeSet: marks = null } = {}) {
    renderRows(newSongs, { rowKind: "song", empty: empty || null, closeSet: marks });
  }

  // Re-measure the row height and repaint — when the Songs panel opens (it was display:none,
  // so nothing could be measured) and after a font-size change (else --vlist-h stays at the
  // old height).
  function refresh() {
    clearRowCache();   // the next rowH() measures a real row again
    setScrollHeight();
    renderWindow();
  }

  // Selection and now-playing are STATE changes, not content changes: patch the classes on the
  // rows already on screen instead of rebuilding them. A full rebuild replaced the <li> under
  // the user's cursor, and a click whose mousedown and mouseup land on different elements never
  // fires — so tapping ＋ down a list silently dropped songs, because the previous tap had just
  // re-rendered the row being tapped. (Caught in a browser: three ＋ taps produced two enqueues.)
  function paintRowStates() {
    for (const li of viewport.querySelectorAll(".song")) {
      const s = songs[+li.dataset.index];
      if (!s) continue;
      li.classList.toggle("selected", !!selectedSong && s.id === selectedSong.id);
      li.classList.toggle("playing", !!nowPlaying && s.id === nowPlaying.id);
      li.tabIndex = +li.dataset.index === focusIndex ? 0 : -1; // keep the single tab stop honest
                                                              // without a rebuild
    }
  }

  function selectRow(song) {
    selectedSong = song;
    paintRowStates(); // move the highlight without replacing any DOM under the pointer
  }

  function setNowPlaying(song) {
    nowPlaying = song;
    paintRowStates();
  }

  // --- the queue list (M5) -----------------------------------------------------------------
  // A roving-tabindex list like the song list (§5.19), but short and NOT virtualized: every row
  // is rendered, exactly one is the tab stop, Up/Down/PageUp/PageDown/Home/End move it
  // (listKeyPlan — the edges are left unprevented for the key router), and Enter / a click / a
  // tap on a row body go to onQueueActivate (the song sheet). The ✕ stays for the pointer only:
  // tabindex -1, and it never activates the row. The <ul>'s only children are the <li> rows.
  let qSongs = [];     // a COPY of the queue as last rendered — queue.js mutates its array in
                       // place, so by the time renderQueue runs the caller's array is already new
  let qFocus = 0;      // the roving row
  let qWired = null;   // the <ul> our keydown listener is on

  function queueEl() {
    const q = $("queue-list");
    if (q && q !== qWired) {
      q.addEventListener("keydown", onQueueKey);
      if (!q.getAttribute("role")) q.setAttribute("role", "list");   // list-style:none drops it in some AT
      qWired = q;
    }
    return q;
  }

  function paintQueueStops(q) {
    const rows = q.children;
    for (let j = 0; j < rows.length; j++) rows[j].tabIndex = j === qFocus ? 0 : -1;
  }

  // Focus without the browser's own scroll jump, then bring the row into view (nearest edge).
  function showQueueRow(el) {
    el.focus({ preventScroll: true });
    if (typeof el.scrollIntoView === "function") el.scrollIntoView({ block: "nearest" });
  }

  /**
   * Put focus on queue row `i`, or on the roving row when `i` is omitted (clamped; the roving
   * index follows). For the panel's initial focus and for after the song sheet closes.
   * @returns {boolean} whether focus landed on a row (false for an empty queue)
   */
  function focusQueueRow(i) {
    const q = queueEl();
    if (!q || !qSongs.length) return false;
    const j = i == null ? qFocus : Math.floor(Number(i)) || 0;
    qFocus = Math.max(0, Math.min(qSongs.length - 1, j));
    paintQueueStops(q);
    const el = q.children[qFocus];
    if (!el) return false;
    showQueueRow(el);
    return document.activeElement === el;
  }

  function activateQueueRow(i, row) {
    qFocus = i;
    const q = queueEl();
    if (q) paintQueueStops(q);
    if (onQueueActivate) onQueueActivate(i, qSongs[i], row);
  }

  function onQueueKey(e) {
    if (!qSongs.length) return;
    const row = e.target && e.target.closest ? e.target.closest(".qsong") : null;
    const i = row ? +row.dataset.index : qFocus;
    const plan = listKeyPlan(e.key, i, qSongs.length);
    if (plan) {
      if (plan.edge) return;                 // not prevented: the key router moves focus out, once
      if (plan.prevent) e.preventDefault();
      if (plan.move != null) focusQueueRow(plan.move);
      return;
    }
    // Enter on the row itself. (A ✕ that took focus from a mouse click keeps its native Enter.)
    if (e.key === "Enter" && row && e.target === row && onQueueActivate) {
      e.preventDefault();
      activateQueueRow(i, row);
    }
  }

  // Queue rows mirror the search-list `.song` layout: [icon][title / artist(+singer)][✕].
  // `by` is who queued it via the phone remote — a "· name" badge on the artist line; blank
  // for host-added songs.
  function makeQueueRow(s, i, by) {
    const li = document.createElement("li");
    li.className = "qsong";
    li.dataset.index = i;
    li.tabIndex = i === qFocus ? 0 : -1;     // roving tabindex — one stop for the whole queue
    li.innerHTML = kindSpan(s) +
      `<span class="meta"><span class="title"></span><span class="artist"></span></span>`;
    li.querySelector(".title").textContent = s.name || "(untitled)";
    const artistEl = li.querySelector(".artist");
    artistEl.textContent = s.artistName || "";
    if (by) {
      const b = document.createElement("span");
      b.className = "by"; b.textContent = ` · ${by}`; b.title = `Added by ${by}`;
      artistEl.appendChild(b);
    }
    const rm = document.createElement("button");
    rm.tabIndex = -1;                        // pointer only: a row is ONE stop; Remove is in the sheet
    rm.textContent = "✕"; rm.className = "add"; rm.title = "Remove from queue";
    rm.onclick = (ev) => { if (ev) ev.stopPropagation(); onRemoveFromQueue(i); };
    li.appendChild(rm);
    li.onclick = (ev) => {
      if (ev && ev.detail > 1) return;       // the 2nd click of a double-click: already activated
      activateQueueRow(i, li);
    };
    return li;
  }

  function renderQueue(queue, queueBy = []) {
    const q = queueEl();
    if (!q) return;
    const next = Array.isArray(queue) ? queue : [];
    const who = queueBy || [];
    // The rebuild destroys a focused row (Enter in the sheet moved it, the ✕ removed it, the
    // queue moved on when a song started, a phone reordered it), which would drop focus to
    // <body> inside an open panel. Note where focus was, and put it back on the SAME song.
    const a = document.activeElement;
    const hadFocus = !!a && q.contains(a);
    let from = qFocus;
    if (hadFocus) {
      const li = a.closest ? a.closest(".qsong") : null;
      if (li && li.dataset.index != null) from = +li.dataset.index;
    }
    // The roving row follows its song even when focus is elsewhere (in the song sheet, say), so
    // focusQueueRow() after the sheet closes lands on the song that just moved.
    const target = queueFocusTarget(qSongs, from, next);
    qFocus = Math.max(0, target);
    qSongs = next.slice();
    const frag = document.createDocumentFragment();
    next.forEach((s, i) => frag.appendChild(makeQueueRow(s, i, who[i])));
    q.replaceChildren(frag);
    if (hadFocus) {
      if (target >= 0) showQueueRow(q.children[target]);
      else {
        // An emptied queue: the panel's Close.
        const host = q.closest && q.closest("[data-ov]");
        const close = host && host.querySelector("[data-ov-close]");
        if (close) close.focus({ preventScroll: true });
      }
    }
    // NOT "queue-count": that id also belonged to the now-playing chip in the stage header,
    // so getElementById returned the chip and this overwrote it — the chip read "(1)" instead
    // of "⏭ 1" and the queue heading never showed a count at all. Two writers, one id.
    const count = $("queue-heading-count");
    if (count) count.textContent = next.length ? `(${next.length})` : "";
  }
  queueEl();   // listen from the start (the static #queue-list exists before the first render)

  return {
    renderRows, // M6: songs, artists, or a back row + songs, in the one virtual list
    renderList,
    renderQueue,
    getSelectedSong: () => selectedSong,
    getList: () => songs, // the currently-rendered list (used to skip to the next result)
    setNowPlaying,
    refresh, // re-measure the row + --vlist-h and re-render (panel opened / font size / resize)
    focusRow, // keys: #search ArrowDown and the Songs panel's initial focus
    focusQueueRow, // keys: the Queue panel's initial focus, and back to the row after the song sheet
  };
}
