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
const ROW_H = 46;        // must match `.song { height }` in style.css
const OVERSCAN = 5;      // extra rows above/below the viewport

/**
 * @param {object} cb
 * @param {(song)=>void}  cb.onPlay             play a song now (double-click / row)
 * @param {(song)=>void}  cb.onQueue            add a song to the queue (＋)
 * @param {(index)=>void} cb.onRemoveFromQueue  remove queue item at index (✕)
 * @returns {{ renderList, renderQueue, getSelectedSong, setNowPlaying }}
 */
export function createLibraryUI({ onPlay, onQueue, onRemoveFromQueue }) {
  const viewport = $("song-list"); // the scroll container (overflow-y: auto)
  const spacer = document.createElement("div");
  spacer.className = "vlist-spacer";
  viewport.appendChild(spacer);

  let songs = [];
  let selectedSong = null;
  let nowPlaying = null;

  viewport.addEventListener("scroll", renderWindow, { passive: true });
  window.addEventListener("resize", renderWindow);

  function makeRow(s, i) {
    const li = document.createElement("li");
    const isVideo = s.kind === "video";
    li.className = "song" +
      (selectedSong && s.id === selectedSong.id ? " selected" : "") +
      (nowPlaying && s.id === nowPlaying.id ? " playing" : "");
    li.style.top = `${i * ROW_H}px`;
    li.innerHTML =
      `<span class="code">${s.code}</span>` +
      `<span class="meta"><span class="title"></span><span class="artist"></span></span>` +
      `<span class="kind ${isVideo ? "vid" : "kar"}" title="${isVideo ? "Video" : "MIDI"}">${isVideo ? "🎞️" : "🎤"}</span>`;
    li.querySelector(".title").textContent = s.name || "(untitled)";
    li.querySelector(".artist").textContent = s.artistName || "";
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
    const start = Math.max(0, Math.floor(top / ROW_H) - OVERSCAN);
    const end = Math.min(songs.length, Math.ceil((top + vh) / ROW_H) + OVERSCAN);
    const frag = document.createDocumentFragment();
    for (let i = start; i < end; i++) frag.appendChild(makeRow(songs[i], i));
    spacer.replaceChildren(frag);
  }

  function renderList(newSongs) {
    songs = newSongs;
    spacer.style.height = `${songs.length * ROW_H}px`;
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

  function renderQueue(queue) {
    const q = $("queue-list");
    q.innerHTML = "";
    queue.forEach((s, i) => {
      const li = document.createElement("li");
      const isVideo = s.kind === "video";
      li.innerHTML = `<span class="code">${s.code}</span> <span class="qt"></span>` +
        `<span class="kind ${isVideo ? "vid" : "kar"}" title="${isVideo ? "Video" : "MIDI"}">${isVideo ? "🎞️" : "🎤"}</span>`;
      li.querySelector(".qt").textContent = `${s.name} — ${s.artistName}`;
      const rm = document.createElement("button");
      rm.textContent = "✕"; rm.className = "add";
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
    setNowPlaying,
    refresh: renderWindow, // re-render the visible window (e.g. after un-collapsing)
  };
}
