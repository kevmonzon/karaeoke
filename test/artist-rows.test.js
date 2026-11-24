/*
 * artist-rows.test.js — M6 lane I: library-ui's renderRows and the artist row kind.
 *
 *   1. Artist rows use the song-row geometry: the same measured row height, the same virtual
 *      window (26,000 items → only the viewport + overscan rows are in the DOM), the same scroll
 *      extent, and the roving row stays rendered when it is scrolled out.
 *   2. An artist row activates with its key: Enter, a click and a tap call onArtist(key) once —
 *      never onActivate (the song sheet), never select / queue; a double-click activates once.
 *   3. The back row reports BACK_ROW, in an artist list and at the head of a song list.
 *   4. A mixed list (back row + songs) draws both kinds; its song rows still open the sheet.
 *   5. renderList is a thin wrapper and still behaves as before (≈ marks, the empty state, the
 *      ⚙ count, the list keys and their edges).
 * The fake DOM is the queue-ops.test.js one (itself list-keys.test.js's), with a style that
 * records custom properties and a requestAnimationFrame the test can flush.
 * Run with:  node --test
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { createLibraryUI, BACK_ROW, listKeyPlan } from "../src/js/library-ui.js";

// --- a fake DOM ------------------------------------------------------------------------------
function fakeDom() {
  const doc = { activeElement: null, focusLog: [] };
  const matches = (n, sel) => {
    if (!n || !n.classList) return false;
    if (sel.startsWith(".")) return n.classList.contains(sel.slice(1));
    const a = /^\[([\w-]+)\]$/.exec(sel);
    if (a) return a[1] in n.attrs;
    return n.tagName === sel.toUpperCase();
  };
  const make = (tag) => {
    const props = {};
    const el = {
      tagName: String(tag).toUpperCase(), className: "", dataset: {}, attrs: {}, children: [], parent: null,
      listeners: {}, textContent: "", innerHTML: "", title: "",
      style: { props, setProperty(k, v) { props[k] = v; } },
      scrollTop: 0, clientHeight: 480,
      classList: {
        contains: (c) => el.className.split(/\s+/).includes(c),
        toggle: (c, on) => { const s = new Set(el.className.split(/\s+/).filter(Boolean)); if (on ?? !s.has(c)) s.add(c); else s.delete(c); el.className = [...s].join(" "); },
        add: (c) => el.classList.toggle(c, true), remove: (c) => el.classList.toggle(c, false),
      },
      set tabIndex(v) { el.attrs.tabindex = String(v); },
      get tabIndex() { return Number(el.attrs.tabindex ?? -1); },
      setAttribute(k, v) { el.attrs[k] = String(v); },
      getAttribute(k) { return el.attrs[k] ?? null; },
      appendChild(c) {
        const kids = c.tagName === "#FRAGMENT" ? c.children.splice(0) : [c];
        for (const k of kids) { if (k.parent) k.remove(); k.parent = el; el.children.push(k); }
        return c;
      },
      replaceChildren(...cs) { for (const c of el.children) c.parent = null; el.children = []; for (const c of cs) el.appendChild(c); },
      remove() { if (el.parent) el.parent.children = el.parent.children.filter((c) => c !== el); el.parent = null; },
      contains(n) { for (; n; n = n.parent) if (n === el) return true; return false; },
      closest(sel) { for (let n = el; n; n = n.parent) if (matches(n, sel)) return n; return null; },
      querySelectorAll(sel) {
        const out = [];
        const walk = (n) => { for (const c of n.children) { if (matches(c, sel)) out.push(c); walk(c); } };
        walk(el);
        return out;
      },
      querySelector(sel) {
        const m = /^\.song\[data-index="(\d+)"\]$/.exec(sel);
        if (m) return el.children.find((c) => String(c.dataset.index) === m[1]) || null;
        const found = el.querySelectorAll(sel)[0];
        if (found) return found;
        // The row template's spans (written with innerHTML, which the fake does not parse).
        if (/^\.[\w-]+$/.test(sel)) { const s = make("span"); s.className = sel.slice(1); el.appendChild(s); return s; }
        return null;
      },
      addEventListener(t, fn) { (el.listeners[t] ||= []).push(fn); },
      getBoundingClientRect: () => ({ height: 48 }),
      focus(opts) { doc.activeElement = el; doc.focusLog.push({ el, opts }); },
      scrollIntoView() {},
      onclick: null, ondblclick: null,
    };
    return el;
  };
  doc.createElement = make;
  doc.createDocumentFragment = () => make("#fragment");
  return { doc, make };
}

const ROW_H = 48;                        // what the fake's probe row measures
const VIEW_ROWS = 480 / ROW_H;           // the fake viewport's clientHeight, in rows
const OVERSCAN = 5;                      // library-ui's overscan (rows above / below)

function withRig(fn) {
  const { doc, make } = fakeDom();
  const list = make("ul");
  list.ownerDocument = doc;
  const listCount = make("em");
  const queueList = make("ul");
  const byId = { "song-list": list, "list-count": listCount, "queue-list": queueList };
  doc.getElementById = (id) => byId[id] || null;

  const saved = { document: globalThis.document, window: globalThis.window, raf: globalThis.requestAnimationFrame };
  const frames = [];
  globalThis.document = doc;
  globalThis.window = { addEventListener() {} };
  globalThis.requestAnimationFrame = (cb) => { frames.push(cb); return frames.length; };
  try {
    const calls = { artist: [], activate: [], played: [], queued: [], fav: [], edges: [] };
    const lib = createLibraryUI({
      onPlay: (s) => calls.played.push(s), onQueue: (s) => calls.queued.push(s),
      onRemoveFromQueue() {}, onToggleFavorite: (s) => calls.fav.push(s),
      isFavorite: () => false, showSource: () => false,
      onActivate: (s, el) => calls.activate.push([s, el]),
      onArtist: (key, el) => calls.artist.push([key, el]),
      onEdge: (dir) => calls.edges.push(dir),
    });
    const row = (i) => list.children.find((c) => String(c.dataset.index) === String(i));
    const indices = () => list.children.map((c) => Number(c.dataset.index));
    const press = (key, target = doc.activeElement) => {
      let prevented = false;
      const ev = { key, target, preventDefault: () => { prevented = true; } };
      for (let n = target; n; n = n.parent) for (const f of n.listeners.keydown || []) f(ev);
      return prevented;
    };
    const click = (el, detail = 1) => {
      let stopped = false;
      const ev = { detail, target: el, stopPropagation: () => { stopped = true; } };
      for (let n = el; n && !stopped; n = n.parent) if (typeof n.onclick === "function") n.onclick(ev);
    };
    const scrollTo = (top) => {
      list.scrollTop = top;
      for (const f of list.listeners.scroll || []) f();
      while (frames.length) frames.shift()();
    };
    return fn({ doc, list, listCount, lib, calls, row, indices, press, click, scrollTo });
  } finally {
    globalThis.document = saved.document; globalThis.window = saved.window; globalThis.requestAnimationFrame = saved.raf;
  }
}

const artists = (n) => Array.from({ length: n }, (_, i) => ({ key: `artist ${i}`, name: `Artist ${i}`, count: (i % 7) + 1 }));
const songs = (n) => Array.from({ length: n }, (_, i) => ({ id: `s${i}`, code: i + 1, name: `Song ${i}`, artistName: "Artist 0", kind: "midi" }));
const buttons = (el) => el.children.filter((c) => c.tagName === "BUTTON");
const textOf = (li, cls) => (li.children.find((c) => c.className === cls) || {}).textContent;
// The .title / .artist spans live inside .meta in a real row; the fake creates them on demand,
// wherever querySelector asked — find them anywhere under the row.
const deep = (li, cls) => li.querySelectorAll(`.${cls}`)[0] || null;

// --- 1. geometry -----------------------------------------------------------------------------
test("artist rows: the song-row geometry — same row height, same window, same scroll extent", () => {
  withRig(({ list, lib, indices, row, scrollTo }) => {
    const N = 26000;
    lib.renderRows(artists(N), { rowKind: "artist" });
    const maxRows = VIEW_ROWS + 2 * OVERSCAN + 1;          // the viewport, the overscan, the roving row
    assert.ok(list.children.length <= maxRows, `${list.children.length} <li> for ${N} artists (≤ ${maxRows})`);
    assert.ok(list.children.length >= VIEW_ROWS, "a screenful is drawn");
    assert.equal(list.style.props["--vlist-h"], `${N * ROW_H}px`, "the scroll extent is N × the song row height");
    assert.ok(list.children.every((c) => c.tagName === "LI"), "ul → li only (§5.19)");
    assert.ok(list.children.every((c) => c.classList.contains("song") && c.classList.contains("artist-row")),
      "an artist row is a .song box (one focus ring, one height rule) marked .artist-row");
    for (const i of indices()) assert.equal(row(i).style.top, `${i * ROW_H}px`);
    const artistWindow = indices();

    // A song list of the same length at the same scroll position draws the same rows.
    lib.renderRows(songs(N));
    assert.deepEqual(indices(), artistWindow, "same window maths as a song list");
    lib.renderRows(artists(N), { rowKind: "artist" });

    // Scrolled deep into the list: still only a screenful, positioned at the real offset.
    scrollTo(1000 * ROW_H);
    const deepWindow = indices().filter((i) => i !== 0);   // row 0 stays: it is the roving row
    assert.ok(list.children.length <= maxRows, `${list.children.length} <li> after a scroll`);
    assert.equal(Math.min(...deepWindow), 1000 - OVERSCAN);
    assert.equal(Math.max(...deepWindow), 1000 + VIEW_ROWS + OVERSCAN - 1);
    assert.ok(indices().includes(0), "the roving row stays rendered when scrolled out (the list's one tab stop)");
    assert.equal(row(0).getAttribute("tabindex"), "0");
    assert.equal(list.children.filter((c) => c.getAttribute("tabindex") === "0").length, 1, "exactly one tab stop");
  });
});

// --- 2. activation -----------------------------------------------------------------------------
test("artist rows: Enter, click and tap call onArtist with the key — never the sheet", () => {
  withRig(({ doc, lib, calls, row, press, click }) => {
    lib.renderRows(artists(6), { rowKind: "artist" });
    const r = row(3);
    assert.deepEqual(buttons(r), [], "no ★ / ＋ on an artist row");
    assert.equal(r.ondblclick, null);

    click(r);
    assert.equal(calls.artist.length, 1);
    assert.deepEqual(calls.artist[0], ["artist 3", r], "the key and the row element");
    click(r, 2);                                           // the 2nd click of a double-click
    assert.equal(calls.artist.length, 1, "a double-click activates once");
    assert.equal(r.getAttribute("tabindex"), "0", "the activated row is the tab stop");

    row(1).focus();
    assert.equal(doc.activeElement, row(1));
    assert.equal(press("Enter"), true, "Enter is the row's (prevented)");
    assert.deepEqual(calls.artist.map(([k]) => k), ["artist 3", "artist 1"], "Enter → onArtist once");
    assert.equal(press(" "), true, "Space is prevented (no list scroll, no play/pause) …");
    assert.equal(lib.getSelectedSong(), null, "… and selects nothing");
    assert.equal(press("+"), false, "+ means nothing on an artist row");
    assert.deepEqual(calls.queued, []);
    assert.deepEqual(calls.activate, [], "the song sheet is never opened from an artist row");
    assert.deepEqual(calls.played, []);
    assert.equal(calls.artist.length, 2, "Space and + did not activate");
  });
});

test("artist rows: a row shows the name and the song count", () => {
  withRig(({ lib, row }) => {
    lib.renderRows([{ key: "abba", name: "ABBA", count: 12 }, { key: "solo", name: "Solo", count: 1 }], { rowKind: "artist" });
    assert.equal(deep(row(0), "title").textContent, "ABBA");
    assert.equal(deep(row(0), "artist").textContent, "12 songs");
    assert.equal(deep(row(1), "artist").textContent, "1 song");
  });
});

// --- 3. the back row -----------------------------------------------------------------------------
test("the back row reports BACK_ROW and shows ← Artists", () => {
  withRig(({ lib, calls, row, press, click }) => {
    assert.equal(typeof BACK_ROW, "string");
    assert.ok(BACK_ROW.startsWith("\u0000"), "a NUL-prefixed key: no real artist name folds to it");
    lib.renderRows([{ key: BACK_ROW, name: "ignored", artist: "ABBA", count: 2 }, ...songs(2)]);
    const back = row(0);
    assert.ok(back.classList.contains("artist-row") && back.classList.contains("back-row"));
    assert.equal(deep(back, "title").textContent, "← Artists", "the label is fixed, whatever the item's name");
    assert.equal(deep(back, "artist").textContent, "ABBA · 2 songs", "whose songs these are");
    click(back);
    back.focus();
    assert.equal(press("Enter"), true);
    assert.deepEqual(calls.artist.map(([k]) => k), [BACK_ROW, BACK_ROW]);
    assert.deepEqual(calls.activate, []);
    // In an artist list too.
    lib.renderRows([{ key: BACK_ROW }, ...artists(2)], { rowKind: "artist" });
    click(row(0));
    assert.equal(calls.artist.at(-1)[0], BACK_ROW);
  });
});

// --- 4. a mixed list ----------------------------------------------------------------------------
test("a mixed list: one back row, then song rows that still open the sheet", () => {
  withRig(({ doc, list, listCount, lib, calls, row, press, click }) => {
    const items = [{ key: BACK_ROW, artist: "Artist 0", count: 3 }, ...songs(3)];
    lib.renderRows(items, { rowKind: "song" });
    assert.equal(lib.getList(), items, "getList() returns the rendered items");
    assert.equal(list.children.length, 4);
    assert.ok(row(0).classList.contains("back-row"));
    for (const i of [1, 2, 3]) {
      assert.ok(!row(i).classList.contains("artist-row"), `row ${i} is a song row`);
      assert.equal(buttons(row(i)).length, 2, "★ and ＋ on a song row");
    }
    assert.equal(listCount.textContent, "3", "the ⚙ count counts songs, not the back row");

    click(row(2));
    assert.equal(calls.activate.length, 1);
    assert.equal(calls.activate[0][0].id, "s1");
    assert.equal(calls.activate[0][1].dataset.index, 2, "the row element carries its list index");
    row(3).focus();
    assert.equal(press("Enter"), true);
    assert.equal(calls.activate.at(-1)[0].id, "s2");
    assert.equal(press("+"), true, "+ still queues a song row");
    assert.deepEqual(calls.queued.map((s) => s.id), ["s2"]);
    assert.deepEqual(calls.artist, [], "song rows never call onArtist");

    // The keys walk across both kinds: Up from the first song lands on the back row.
    row(1).focus();
    assert.equal(press("ArrowUp"), true);
    assert.equal(doc.activeElement, row(0));
    assert.equal(press("ArrowUp"), false, "row 0's top edge is left to the key router");
    assert.deepEqual(calls.edges, ["up"]);
  });
});

test("a new list keeps keyboard focus in the list (on its first row) after an activation", () => {
  withRig(({ doc, lib, row, press }) => {
    lib.renderRows(artists(8), { rowKind: "artist" });
    row(5).focus();
    press("Enter");                                     // the app would now show that artist's songs
    lib.renderRows([{ key: BACK_ROW }, ...songs(4)]);
    assert.equal(doc.activeElement, row(0), "focus restored to the new list's roving row: ← Artists");
    assert.equal(doc.focusLog.at(-1).opts && doc.focusLog.at(-1).opts.preventScroll, true);
  });
});

// --- 5. renderList, unchanged -------------------------------------------------------------------
test("renderList is still the song list: rows, ≈ marks, the empty state, the count, the keys", () => {
  withRig(({ doc, list, listCount, lib, calls, row, press }) => {
    const s = songs(30);
    lib.renderList(s, null, { closeSet: new Set([s[2]]) });
    assert.equal(lib.getList(), s);
    assert.equal(listCount.textContent, "30");
    assert.ok(row(2).classList.contains("close-match"));
    assert.ok(!row(1).classList.contains("close-match"));
    assert.ok(list.children.every((c) => !c.classList.contains("artist-row")));
    assert.equal(lib.focusRow(), true);
    assert.equal(doc.activeElement, row(0));
    assert.equal(press("End"), true);
    assert.equal(doc.activeElement, row(29));
    assert.equal(press("ArrowDown"), false, "the bottom edge is released");
    assert.deepEqual(calls.edges, ["down"]);
    assert.equal(press("Enter"), true);
    assert.equal(calls.activate.at(-1)[0].id, "s29");

    lib.renderList([], { title: "No matches", hint: "Try fewer words" });
    assert.equal(list.children.length, 1);
    assert.equal(list.children[0].className, "empty-state");
    assert.equal(lib.focusRow(), false);
    assert.equal(listCount.textContent, "0");

    // An artist list leaves the ⚙ song count alone.
    lib.renderList(songs(7));
    lib.renderRows(artists(3), { rowKind: "artist" });
    assert.equal(listCount.textContent, "7");
  });
});

test("listKeyPlan is unchanged by M6 (the artist list uses it as is)", () => {
  assert.deepEqual(listKeyPlan("ArrowUp", 0, 26000), { move: null, edge: "up", prevent: false });
  assert.deepEqual(listKeyPlan("PageDown", 0, 26000), { move: 10, edge: null, prevent: true });
  assert.deepEqual(listKeyPlan("End", 0, 26000), { move: 25999, edge: null, prevent: true });
});

// --- 6. library-view: the whole library, the close tier and the artist views (M6 lane I) --------
// A real Catalog through a stubbed fetch and a renderList / renderRows recorder (search-view's
// approach); the search client is a fake with the search-client.js surface. The songbook / type
// chips and the sort were removed (2026-11-24): every list is every song, in Relevance order.
import { Catalog } from "../src/js/catalog.js";
import { createLibraryView, countLabel } from "../src/js/library-view.js";
import { UNKNOWN_ARTIST } from "../src/js/library-browse.js";

const REC = (code, name, artistName, source, file) => ({ code, name, artistName, langName: "", type: "MIDI", source, file });
const MIDI = [
  REC(10, "Barcelona", "Freddie Mercury", "SH", "kar_raw/10.kar"),
  REC(11, "Barcelona Nights", "Someone", "PLATKAR", "kar_raw/11.kar"),
  REC(12, "Love Me Do", "The Beatles", "TJMEDIA", "kar_raw/12.mid"),
  REC(13, "All You Need Is Love", "the beatles", "SH", "kar_raw/13.kar"),
  REC(14, "Halo", "Beyonce", "SH", "kar_raw/14.kar"),
  REC(15, "Anonymous Song", "", "PLATKAR", "kar_raw/15.kar"),
  REC(16, "Lovely Day", "Bill Withers", "TJMEDIA", "kar_raw/16.mid"),
];
const AUDIO = [{ code: 20, name: "Love Story", artistName: "Taylor Swift", langName: "", type: "AUDIO", source: "MIDI", file: "audio_lyrics/20.mp3" }];
const FILES = { "/catalog.json": MIDI, "/catalog-video.json": [], "/catalog-audio.json": AUDIO };

async function loadCatalog() {
  const prev = global.fetch;
  global.fetch = async (url) => {
    const key = String(url);
    if (key in FILES) return { ok: true, json: async () => structuredClone(FILES[key]) };
    return { ok: false, status: 404, json: async () => [] };
  };
  const c = new Catalog();
  try { await c.load(); } finally { global.fetch = prev; }
  return c;
}

function recorderLib() {
  let list = [];
  const renders = [];
  return {
    renders,
    renderList(rows, empty, opts = {}) { list = rows; renders.push({ kind: "song", rows, empty, closeSet: opts.closeSet || null }); },
    renderRows(rows, opts = {}) { list = rows; renders.push({ kind: opts.rowKind || "song", rows, empty: opts.empty || null, closeSet: opts.closeSet || null }); },
    getList: () => list,
    refresh() {},
  };
}

function lateClient() {
  const pending = [];
  return { pending, ready: true, query(q, opts = {}) { return new Promise((resolve) => pending.push({ q, opts, resolve })); } };
}

function makeView(catalog, { client = null } = {}) {
  const lib = recorderLib();
  const status = [];
  const view = createLibraryView({
    catalog, settings: { get: () => false }, getLib: () => lib,
    setStatus: (m) => status.push(m), youtubeSupported: () => false,
    getQueueIds: () => [], getRecentIds: () => [], getRecentSongs: () => [], storage: null,
    searchClient: client, getFuzzy: () => true, fuzzyBelow: 20,
  });
  return { view, lib, status };
}

const by = (c, name) => c.songs.find((s) => s.name === name);
const titles = (rows) => rows.map((s) => s.name);

test("library-view: the whole library is every song, as it is (no copy, no 100k cap)", async () => {
  const c = await loadCatalog();
  const { view, lib, status } = makeView(c);
  assert.equal("setBrowse" in view, false, "no chip / sort state to hand in any more");
  view.renderAll();
  assert.equal(lib.getList(), c.songs, "catalog.songs itself");
  assert.equal(lib.getList().at(-1).name, "Love Story", "the audio songs at the END of catalog.songs are listed");
  view.rerender("");
  assert.equal(lib.getList(), c.songs);
  assert.equal(status.at(-1), "8 songs", "a re-render (a rebuild) says the count");
});

test("library-view: the close tier asks the index for its own count and is appended after the exact rows", async () => {
  const c = await loadCatalog();
  const client = lateClient();
  const { view, lib } = makeView(c, { client });
  const done = view.renderSearchResults("love", null);
  const exact = c.search("love");
  assert.deepEqual(lib.getList(), exact, "the exact tier, in Catalog.search order");
  assert.equal(client.pending.length, 1, "fewer exact rows than fuzzyBelow → the close tier is asked for");
  assert.deepEqual(client.pending[0].opts, { exclude: exact.map((s) => c.songs.indexOf(s)) },
    "the exact rows are skipped; no over-fetch (the index's own cap applies)");
  client.pending[0].resolve([by(c, "Halo"), by(c, "Barcelona Nights")].map((s) => ({ i: c.songs.indexOf(s), score: 1 })));
  await done;
  const last = lib.renders.at(-1);
  assert.deepEqual(titles(last.rows), [...titles(exact), "Halo", "Barcelona Nights"], "close rows after, in the index's order");
  assert.deepEqual([...last.closeSet], [by(c, "Halo"), by(c, "Barcelona Nights")], "≈ on the close rows only");
});

test("library-view: YouTube rows always come last, after the library rows", async () => {
  const c = await loadCatalog();
  const { view, lib } = makeView(c);
  const yt = { id: "youtube:x", kind: "youtube", code: "", name: "YT Love" };
  await view.renderSearchResults("love", [yt]);
  assert.deepEqual(lib.getList(), [...c.search("love"), yt]);
});

test("library-view: the Artists views — the index, a filter, one artist under ← Artists, topHit skips it", async () => {
  const c = await loadCatalog();
  const { view, lib, status } = makeView(c);
  const items = view.showArtists("");
  assert.equal(view.view, "artists");
  assert.equal(lib.renders.at(-1).kind, "artist", "drawn with renderRows({ rowKind: 'artist' })");
  assert.equal(items.at(-1).key, UNKNOWN_ARTIST, "(Unknown artist) last");
  const beatles = items.find((a) => a.count === 2);
  assert.ok(beatles, "'The Beatles' and 'the beatles' are one artist");
  assert.equal(status.at(-1), countLabel(items.length, "artist"));
  assert.equal(view.topHit(), null, "the artist list has no song for Enter to take");
  assert.equal(view.topArtist(), items[0]);

  const filtered = view.showArtists("beat");
  assert.deepEqual(filtered.map((a) => a.key), [beatles.key], "typing filters the artist names");

  const rows = view.showArtistSongs(beatles.key);
  assert.equal(view.view, "artist");
  assert.equal(view.artistShown, beatles.key);
  const shown = lib.getList();
  assert.equal(shown[0].key, BACK_ROW, "a back row heads the list …");
  assert.equal(lib.renders.at(-1).kind, "song", "… of a SONG list (renderRows rowKind 'song')");
  assert.deepEqual(titles(shown.slice(1)), ["All You Need Is Love", "Love Me Do"], "that artist's songs, by title");
  assert.deepEqual(shown.slice(1), rows);
  assert.equal(view.topHit(), rows[0], "Enter takes the first SONG, never the back row");
  assert.match(status.at(-1), /2 songs$/);
  view.rerender("");
  assert.deepEqual(lib.getList().slice(1), rows, "a re-render draws the same artist's songs again");

  assert.equal(view.showArtists(""), items, "the index of every song is built once per catalog.songs array");
  const unknown = view.showArtistSongs(UNKNOWN_ARTIST);
  assert.deepEqual(titles(unknown), ["Anonymous Song"]);
  assert.equal(lib.getList()[0].artist, "(Unknown artist)", "the back row names the placeholder bucket by its label");
});

test("library-view: a late close reply never draws songs over the artist list (or the hidden Rankings list)", async () => {
  const c = await loadCatalog();
  const client = lateClient();
  const { view, lib } = makeView(c, { client });
  const hit = [{ i: c.songs.indexOf(by(c, "Halo")), score: 1 }];
  for (const leave of [() => view.showArtists(""), () => view.showNone()]) {
    const done = view.renderSearchResults("haloo", null);
    leave();
    const after = lib.renders.length;
    client.pending.at(-1).resolve(hit);
    await done;
    assert.equal(lib.renders.length, after, "the reply was for a list that is no longer showing");
  }
  assert.equal(view.view, "none");
  view.rerender("anything");
  assert.equal(view.view, "none", "rerender on the Rankings tab draws nothing");
});
