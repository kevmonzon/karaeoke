/*
 * library-ui.js — the left (song list) and right (queue) panes.
 *
 * The song list is VIRTUALIZED: only the rows in (and just around) the viewport
 * are in the DOM, absolutely positioned inside the scroll container; the full scroll
 * height comes from a `#song-list::after` pseudo (var --vlist-h), so the <ul>'s only
 * children are the <li> rows (valid list a11y). Row height is the --row-h CSS var
 * (read via rowH()) so scroll math stays exact across display-size profiles.
 *
 * Pure UI: it renders song/queue data and calls back into the player for
 * play/queue actions. Local state is only the selected + now-playing song.
 * Created once from app.js via createLibraryUI(callbacks) — no import cycle.
 */

const $ = (id) => document.getElementById(id);
// Row height comes from the `--row-h` CSS var (set per display-size profile in style.css), so the
// list scales with the screen (phone → TV). Read once per render; falls back to 46 if unset.
// getComputedStyle forces a style recalc, and this used to run on EVERY scroll event of a
// 65k-row virtual list (dozens a second on a trackpad fling) for a value that only changes
// when the ⚙ font size does. Measured once, re-measured only when something can actually
// change it: refresh() (the font-size path already calls it) and a resize.
let _rowH = 0;
const measureRowH = () =>
  (_rowH = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--row-h")) || 46);
const rowH = () => _rowH || measureRowH();
const OVERSCAN = 5;      // extra rows above/below the viewport

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

/**
 * @param {object} cb
 * @param {(song)=>void}  cb.onPlay             play a song now (double-click / row)
 * @param {(song)=>void}  cb.onQueue            add a song to the queue (＋)
 * @param {(index)=>void} cb.onRemoveFromQueue  remove queue item at index (✕)
 * @param {(song)=>void}  cb.onToggleFavorite   star / un-star a song (★)
 * @param {(song)=>boolean} cb.isFavorite       is this song currently starred?
 * @returns {{ renderList, renderQueue, getSelectedSong, setNowPlaying }}
 */
export function createLibraryUI({ onPlay, onQueue, onRemoveFromQueue, onToggleFavorite, isFavorite }) {
  const viewport = $("song-list"); // the scroll container (overflow-y: auto, position: relative)
  // No spacer element: the full scroll height comes from a `#song-list::after` pseudo-element sized
  // by the `--vlist-h` CSS var (set in renderList). That keeps the <ul>'s only real children the
  // <li> rows — valid list semantics (a spacer <div> child would break ul→li structure for a11y).

  let songs = [];
  let selectedSong = null;
  let nowPlaying = null;
  let emptyState = null;   // {title, hint} shown when `songs` is empty — see renderWindow
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
  window.addEventListener("resize", () => { measureRowH(); renderWindow(); });

  function makeRow(s, i, h) {
    const li = document.createElement("li");
    li.className = "song" +
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
    const fav = isFavorite && isFavorite(s);
    const favBtn = document.createElement("button");
    favBtn.className = "fav" + (fav ? " on" : "");
    favBtn.textContent = fav ? "★" : "☆";
    favBtn.title = fav ? "Remove from favorites" : "Add to favorites";
    favBtn.onclick = (ev) => { ev.stopPropagation(); onToggleFavorite(s); };
    li.appendChild(favBtn);
    const addBtn = document.createElement("button");
    addBtn.className = "add";
    addBtn.textContent = "＋";
    addBtn.title = "Add to queue";
    addBtn.onclick = (ev) => { ev.stopPropagation(); onQueue(s); };
    li.appendChild(addBtn);
    li.ondblclick = () => onPlay(s);
    li.onclick = () => { focusIndex = i; selectRow(s); };
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
      if (el) el.focus();
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

  // Keyboard navigation for the list. Deliberately NOT a listbox: the <ul role="list"> +
  // <li> structure is a documented a11y invariant here (§5.19), so this stays a list whose
  // items happen to be focusable and actionable, which is what they already were by mouse.
  viewport.addEventListener("keydown", (e) => {
    if (!songs.length) return;
    const row = e.target.closest && e.target.closest(".song");
    const i = row ? +row.dataset.index : focusIndex;
    switch (e.key) {
      case "ArrowDown": e.preventDefault(); moveFocus(i + 1); break;
      case "ArrowUp": e.preventDefault(); moveFocus(i - 1); break;
      case "PageDown": e.preventDefault(); moveFocus(i + 10); break;
      case "PageUp": e.preventDefault(); moveFocus(i - 10); break;
      case "Home": e.preventDefault(); moveFocus(0); break;
      case "End": e.preventDefault(); moveFocus(songs.length - 1); break;
      case "Enter":
        if (row) { e.preventDefault(); onPlay(songs[i]); }
        break;
      case " ":
        // Space selects the row (the transport's global Space-to-play only applies when
        // focus isn't in the list — see app.js, which ignores keys from a focused row).
        if (row) { e.preventDefault(); focusIndex = i; selectRow(songs[i]); }
        break;
      case "+": case "=":
        if (row) { e.preventDefault(); onQueue(songs[i]); }   // matches the ＋ button
        break;
      default: return;
    }
  });

  // Set the ::after scroll-height var from the CURRENT row height. Must run whenever
  // --row-h changes (display-size profile switch) as well as when the list changes,
  // or the scroll extent desyncs from the absolutely-positioned rows.
  function setScrollHeight() {
    viewport.style.setProperty("--vlist-h", `${songs.length * rowH()}px`);
  }

  /** @param {{title:string, hint?:string}} [empty] what to say when the list comes back empty */
  function renderList(newSongs, empty) {
    songs = newSongs;
    emptyState = empty || null;
    focusIndex = 0;          // a new result set starts at the top
    pendingFocus = false;    // …but never steals focus from whatever the user is typing in
    setScrollHeight();
    viewport.scrollTop = 0;
    renderWindow();
    const lc = $("list-count");
    if (lc) lc.textContent = songs.length.toLocaleString();
  }

  // Re-measure the row height and repaint — for un-collapsing and, crucially, after a
  // display-size profile switch changes --row-h (else --vlist-h stays at the old height).
  function refresh() {
    measureRowH();   // the ⚙ font size changes --row-h; this is the one path that knows
    setScrollHeight();
    renderWindow();
  }

  function selectRow(song) {
    selectedSong = song;
    renderWindow(); // repaint to move the highlight
  }

  function setNowPlaying(song) {
    nowPlaying = song;
    renderWindow();
  }

  // Queue rows mirror the search-list `.song` layout: [icon][title / artist(+singer)][✕].
  // `queueBy` (optional, parallel to `queue`) holds who queued each song via the phone remote —
  // shown as a "· name" badge on the artist line. Absent/blank for host-added songs.
  function renderQueue(queue, queueBy = []) {
    const q = $("queue-list");
    q.innerHTML = "";
    queue.forEach((s, i) => {
      const li = document.createElement("li");
      li.className = "qsong";
      li.innerHTML = kindSpan(s) +
        `<span class="meta"><span class="title"></span><span class="artist"></span></span>`;
      li.querySelector(".title").textContent = s.name || "(untitled)";
      const artistEl = li.querySelector(".artist");
      artistEl.textContent = s.artistName || "";
      const by = queueBy[i];
      if (by) {
        const b = document.createElement("span");
        b.className = "by"; b.textContent = ` · ${by}`; b.title = `Added by ${by}`;
        artistEl.appendChild(b);
      }
      const rm = document.createElement("button");
      rm.textContent = "✕"; rm.className = "add"; rm.title = "Remove from queue";
      rm.onclick = () => onRemoveFromQueue(i);
      li.appendChild(rm);
      q.appendChild(li);
    });
    // NOT "queue-count": that id also belonged to the now-playing chip in the stage header,
    // so getElementById returned the chip and this overwrote it — the chip read "(1)" instead
    // of "⏭ 1" and the queue heading never showed a count at all. Two writers, one id.
    $("queue-heading-count").textContent = queue.length ? `(${queue.length})` : "";
  }

  return {
    renderList,
    renderQueue,
    getSelectedSong: () => selectedSong,
    getList: () => songs, // the currently-rendered list (used to skip to the next result)
    setNowPlaying,
    refresh, // re-measure --vlist-h + re-render (un-collapse / profile switch)
  };
}
