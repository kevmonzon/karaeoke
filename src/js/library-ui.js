/*
 * library-ui.js — the left (song list) and right (queue) panes.
 *
 * The song list is VIRTUALIZED: only the rows in (and just around) the viewport
 * are in the DOM, positioned absolutely inside a full-height spacer, so a 17k-song
 * result set stays smooth. Row height is fixed (ROW_H) so scroll math is exact.
 *
 * Pure UI: it renders song/queue data and calls back into the player for
 * play/queue actions. Local state is only the selected + now-playing song.
 * Created once from app.js via createLibraryUI(callbacks) — no import cycle.
 */

const $ = (id) => document.getElementById(id);
// Row height comes from the `--row-h` CSS var (set per display-size profile in style.css), so the
// list scales with the screen (phone → TV). Read once per render; falls back to 46 if unset.
const rowH = () => parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--row-h")) || 46;
const OVERSCAN = 5;      // extra rows above/below the viewport

// Source icon per song kind (shown on each list + queue row): 🎤 MIDI · 🎞️ video · 🌐 YouTube.
const KIND_ICON = {
  video:   { glyph: "🎞️", cls: "vid", title: "Video" },
  youtube: { glyph: "🌐", cls: "yt",  title: "YouTube" },
  midi:    { glyph: "🎤", cls: "kar", title: "MIDI" },
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
  const viewport = $("song-list"); // the scroll container (overflow-y: auto)
  const spacer = document.createElement("div");
  spacer.className = "vlist-spacer";
  viewport.appendChild(spacer);

  let songs = [];
  let selectedSong = null;
  let nowPlaying = null;

  viewport.addEventListener("scroll", renderWindow, { passive: true });
  window.addEventListener("resize", renderWindow);

  function makeRow(s, i, h) {
    const li = document.createElement("li");
    li.className = "song" +
      (selectedSong && s.id === selectedSong.id ? " selected" : "") +
      (nowPlaying && s.id === nowPlaying.id ? " playing" : "");
    li.style.top = `${i * h}px`;
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
    li.onclick = () => selectRow(s);
    return li;
  }

  // Render only the rows visible in the viewport (plus overscan).
  function renderWindow() {
    const vh = viewport.clientHeight || 1;
    const top = viewport.scrollTop;
    const h = rowH();
    const start = Math.max(0, Math.floor(top / h) - OVERSCAN);
    const end = Math.min(songs.length, Math.ceil((top + vh) / h) + OVERSCAN);
    const frag = document.createDocumentFragment();
    for (let i = start; i < end; i++) frag.appendChild(makeRow(songs[i], i, h));
    spacer.replaceChildren(frag);
  }

  function renderList(newSongs) {
    songs = newSongs;
    spacer.style.height = `${songs.length * rowH()}px`;
    viewport.scrollTop = 0;
    renderWindow();
    const lc = $("list-count");
    if (lc) lc.textContent = songs.length.toLocaleString();
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
    $("queue-count").textContent = queue.length ? `(${queue.length})` : "";
  }

  return {
    renderList,
    renderQueue,
    getSelectedSong: () => selectedSong,
    getList: () => songs, // the currently-rendered list (used to skip to the next result)
    setNowPlaying,
    refresh: renderWindow, // re-render the visible window (e.g. after un-collapsing)
  };
}
