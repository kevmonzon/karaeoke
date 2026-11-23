/*
 * search-view.test.js — the three-tier search list as the library view builds it: the number
 * tier (searchTiers), the exact tier (Catalog.search, untouched), the close tier appended from
 * the search client, the stale-reply rule, topHit, and what Enter decides.
 * Run with:  node --test    (or  npm test)
 *
 * The catalogue is a real Catalog loaded through a stubbed global fetch (as in unit.test.js).
 * The search client is a FAKE with the search-client.js surface ({ ready, query }), so these
 * tests depend only on the contract, never on the worker or the index.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { Catalog, SOURCES } from "../src/js/catalog.js";
import { searchTiers, enterDecision, createLibraryView } from "../src/js/library-view.js";

// --- fixture ------------------------------------------------------------------------------------
function stubFetch(map) {
  const prev = global.fetch;
  global.fetch = async (url) => {
    const key = String(url);
    if (key in map) return { ok: true, json: async () => structuredClone(map[key]) };
    return { ok: false, status: 404, json: async () => [] };
  };
  return () => { global.fetch = prev; };
}

// Number 123 in three songbooks, deliberately NOT in songbook order in the file, plus a record
// from an old catalogue (no source) and two longer numbers that start with 123.
const MIDI = [
  { code: 12, name: "Twelve", artistName: "N", langName: "", type: "MIDI", source: "SH", file: "kar_raw/12.kar" },
  { code: 123, name: "Mega One Two Three", artistName: "M", langName: "", type: "MIDI", source: "MIDI", file: "kar_raw/123-midi.mid" },
  { code: 1234, name: "Prefix Song", artistName: "P", langName: "", type: "MIDI", source: "SH", file: "kar_raw/1234.kar" },
  { code: 123, name: "Plat One Two Three", artistName: "P", langName: "", type: "MIDI", source: "PLATKAR", file: "kar_raw/123-plat.kar" },
  { code: 123, name: "Sh One Two Three", artistName: "S", langName: "", type: "MIDI", source: "SH", file: "kar_raw/123-sh.kar" },
  { code: 12345, name: "Longer Prefix", artistName: "P", langName: "", type: "MIDI", source: "TJMEDIA", file: "kar_raw/12345.mid" },
  { code: 5, name: "Tj Five", artistName: "T", langName: "", type: "MIDI", source: "TJMEDIA", file: "kar_raw/5.mid" },
  { code: 55, name: "Fifty Five", artistName: "T", langName: "", type: "MIDI", source: "TJMEDIA", file: "kar_raw/55.mid" },
  { code: 900, name: "Barcelona", artistName: "Freddie Mercury", langName: "International", type: "MIDI", source: "SH", file: "kar_raw/900.kar" },
  { code: 901, name: "Barcelona Nights", artistName: "Someone", langName: "International", type: "MIDI", source: "PLATKAR", file: "kar_raw/901.kar" },
  { code: 902, name: "Bohemian Rhapsody", artistName: "Queen", langName: "International", type: "MIDI", source: "MIDI", file: "kar_raw/902.mid" },
  { code: 903, name: "Halo", artistName: "Beyonce", langName: "International", type: "MIDI", source: "SH", file: "kar_raw/903.kar" },
];
const VIDEO = [
  { code: 5, name: "Tj Five Video", artistName: "T", langName: "", type: "VIDEO", source: "TJMEDIA", file: "videos/5.mp4" },
];
const AUDIO = [
  { code: 123, name: "Old Catalogue 123", artistName: "O", langName: "", type: "AUDIO", file: "audio_lyrics/123.mp3" },
  { code: 5, name: "Tj Five Recorded", artistName: "T", langName: "", type: "AUDIO", source: "TJMEDIA", file: "audio_lyrics/5.mp3" },
];
const FILES = { "/catalog.json": MIDI, "/catalog-video.json": VIDEO, "/catalog-audio.json": AUDIO };

async function loadCatalog(files = FILES) {
  const restore = stubFetch(files);
  const c = new Catalog();
  try { await c.load(); } finally { restore(); }
  return c;
}

const byName = (catalog, name) => catalog.songs.find((s) => s.name === name);
const names = (rows) => rows.map((s) => s.name);

/** A library-ui stand-in that records every renderList call. */
function fakeLib() {
  let list = [];
  const renders = [];
  return {
    renders,
    renderList(rows, empty, opts = {}) { list = rows; renders.push({ rows, empty, closeSet: opts.closeSet || null }); },
    getList: () => list,
    refresh() {},
  };
}

/** search-client.js surface; `answer(q, opts)` gives the hits. Records every query. */
function fakeClient(answer = () => [], { ready = true } = {}) {
  const calls = [];
  return {
    calls,
    ready,
    query(q, opts = {}) { calls.push({ q, exclude: [...(opts.exclude || [])] }); return Promise.resolve(answer(q, opts)); },
  };
}

/** A client whose answers arrive only when the test says so. */
function lateClient() {
  const pending = [];
  return {
    pending,
    ready: true,
    query(q, opts = {}) { return new Promise((resolve) => pending.push({ q, opts, resolve })); },
  };
}

function makeView(catalog, { client = null, fuzzy = true, below = 20, lib = fakeLib() } = {}) {
  const view = createLibraryView({
    catalog, settings: { get: () => false }, getLib: () => lib,
    setStatus: () => {}, youtubeSupported: () => false,
    getQueueIds: () => [], getRecentIds: () => [], getRecentSongs: () => [catalog.songs[0]],
    storage: null,
    searchClient: client, getFuzzy: () => fuzzy, fuzzyBelow: below,
  });
  return { view, lib };
}

// --- searchTiers: the number tier ---------------------------------------------------------------
test("a digits-only query lists exact numbers first, in songbook order", async () => {
  const c = await loadCatalog();
  const { rows, numeric } = searchTiers({ catalog: c, query: "123", sources: SOURCES });
  assert.equal(numeric, true);
  // SH, PLATKAR, (TJMEDIA none), MIDI, then the record with no songbook — not file order.
  assert.deepEqual(names(rows.slice(0, 4)),
    ["Sh One Two Three", "Plat One Two Three", "Mega One Two Three", "Old Catalogue 123"]);
  assert.deepEqual(rows.slice(0, 4).map((s) => s.source), ["SH", "PLATKAR", "MIDI", ""]);
});

test("leading zeros are ignored", async () => {
  const c = await loadCatalog();
  const plain = searchTiers({ catalog: c, query: "123" }).rows;
  for (const q of ["0123", "00123", " 00123 "]) {
    const { rows, numeric } = searchTiers({ catalog: c, query: q });
    assert.equal(numeric, true, q);
    assert.deepEqual(rows.slice(0, 4), plain.slice(0, 4), `${JSON.stringify(q)}: same first rows as "123"`);
    assert.ok(rows.every((s) => String(s.code) === "123"), `${JSON.stringify(q)}: a zero-led prefix matches no longer number`);
  }
});

test("prefix numbers follow, without duplicates", async () => {
  const c = await loadCatalog();
  const { rows } = searchTiers({ catalog: c, query: "123" });
  assert.equal(new Set(rows).size, rows.length, "no song twice");
  // After the four exact 123s: the code-prefix matches Catalog.search gives, in catalogue order.
  assert.deepEqual(names(rows.slice(4)), ["Prefix Song", "Longer Prefix"]);
  assert.ok(!rows.some((s) => s.code === 12), "12 does not start with 123");
  // Every row Catalog.search returns is still there: the number tier only reorders and adds.
  for (const s of c.search("123")) assert.ok(rows.includes(s), s.name);
});

test("the 237-style case lists MIDI then audio for one songbook", async () => {
  // One TJMEDIA number as a MIDI record, a video and a recorded song. The catalogue holds them
  // midi, video, audio; the number tier wants MIDI, then audio, then video.
  const c = await loadCatalog();
  const { rows } = searchTiers({ catalog: c, query: "5" });
  assert.deepEqual(rows.slice(0, 3).map((s) => s.kind), ["midi", "audio", "video"]);
  assert.ok(rows.slice(0, 3).every((s) => s.source === "TJMEDIA"));
  assert.deepEqual(names(rows.slice(3)), ["Fifty Five"], "then 55, a prefix match");
});

// --- searchTiers: the exact tier ----------------------------------------------------------------
test("a text query returns exactly Catalog.search", async () => {
  const c = await loadCatalog();
  for (const q of ["barcelona", "BARCELONA nights", "queen", "sh", "nothing like this", "", "123 one"]) {
    const { rows, numeric } = searchTiers({ catalog: c, query: q });
    assert.equal(numeric, false, q);
    const want = c.search(q);
    assert.equal(rows.length, want.length, q);
    rows.forEach((s, i) => assert.equal(s, want[i], `${JSON.stringify(q)} row ${i}`));   // same objects, same order
  }
});

// --- the close tier -----------------------------------------------------------------------------
test("close matches are appended, never inserted above", async () => {
  const c = await loadCatalog();
  const halo = byName(c, "Halo"), boho = byName(c, "Bohemian Rhapsody"), barca = byName(c, "Barcelona");
  // The fake also "finds" an exact row (Barcelona) — it must not move up or appear twice.
  const client = fakeClient(() => [halo, barca, boho].map((s) => ({ i: c.songs.indexOf(s), score: 1 })));
  const { view, lib } = makeView(c, { client });
  const yt = { id: "youtube:x", kind: "youtube", code: "", name: "YouTube row" };

  await view.renderSearchResults("barcelona", [yt]);
  assert.equal(lib.renders.length, 2, "the exact tier at once, then one append");
  const first = lib.renders[0].rows, second = lib.renders[1].rows;
  assert.equal(lib.renders[0].closeSet, null);
  const exact = c.search("barcelona");
  assert.deepEqual(first, [...exact, yt]);
  assert.deepEqual(second, [...exact, halo, boho, yt], "exact rows, then close rows, YouTube last");
  assert.deepEqual([...lib.renders[1].closeSet], [halo, boho], "only the appended rows carry ≈");
});

test("the close query excludes the exact rows by catalogue index", async () => {
  const c = await loadCatalog();
  const client = fakeClient();
  const { view } = makeView(c, { client });
  await view.renderSearchResults("barcelona", null);
  assert.equal(client.calls.length, 1);
  const want = c.search("barcelona").map((s) => c.songs.indexOf(s));
  assert.deepEqual(client.calls[0].exclude, want);
  assert.equal(client.calls[0].q, "barcelona");
});

test("a late result for an old query is ignored", async () => {
  const c = await loadCatalog();
  const client = lateClient();
  const { view, lib } = makeView(c, { client });
  const halo = byName(c, "Halo");
  const hit = [{ i: c.songs.indexOf(halo), score: 1 }];

  const oldDone = view.renderSearchResults("barcelna", null);
  const newDone = view.renderSearchResults("bohemian rapsody", null);
  assert.equal(client.pending.length, 2);
  const shown = lib.renders.length;

  client.pending[0].resolve(hit);   // the OLD query's answer lands after the list moved on
  await oldDone;
  assert.equal(lib.renders.length, shown, "nothing re-rendered for the old query");
  assert.deepEqual(lib.getList(), c.search("bohemian rapsody"));

  client.pending[1].resolve(hit);   // the current query's answer is used
  await newDone;
  assert.equal(lib.renders.length, shown + 1);
  assert.ok(lib.getList().includes(halo));

  // Leaving for another view counts too: a reply that lands after showRecent()/renderAll() is dropped.
  for (const leave of [() => view.showRecent(), () => view.renderAll()]) {
    const done = view.renderSearchResults("halo", null);
    leave();
    const after = lib.renders.length;
    client.pending.at(-1).resolve(hit);
    await done;
    assert.equal(lib.renders.length, after, "the other view stays");
  }
});

test("a reply for a catalogue that was reloaded meanwhile is dropped", async () => {
  const c = await loadCatalog();
  const client = lateClient();
  const { view, lib } = makeView(c, { client });
  const done = view.renderSearchResults("barcelna", null);
  const shown = lib.renders.length;
  const restore = stubFetch(FILES);
  try { await c.load(); } finally { restore(); }   // a rebuild: catalog.songs is a new array
  client.pending[0].resolve([{ i: 0, score: 1 }]);
  await done;
  assert.equal(lib.renders.length, shown, "index 0 named a song of the OLD list");
});

test("close matches are asked for only when they can help", async () => {
  const c = await loadCatalog();
  const cases = [
    { why: "a number query", q: "123", opts: {} },
    { why: "fuzzy off", q: "barcelna", opts: { fuzzy: false } },
    { why: "an exact list as long as fuzzyBelow", q: "barcelona", opts: { below: 2 } },
    { why: "an empty query", q: "  ", opts: {} },
  ];
  for (const { why, q, opts } of cases) {
    const client = fakeClient();
    const { view } = makeView(c, { client, ...opts });
    await view.renderSearchResults(q, null);
    assert.equal(client.calls.length, 0, why);
  }
  const unready = fakeClient(() => [], { ready: false });
  await makeView(c, { client: unready }).view.renderSearchResults("barcelna", null);
  assert.equal(unready.calls.length, 0, "an index that is not ready yet");
  // No client at all (or none injected) is exact-only, as before M2.
  const { view, lib } = makeView(c, { client: null });
  await view.renderSearchResults("barcelna", null);
  assert.equal(lib.renders.length, 1);
  // fuzzyBelow can be a live getter; one row under it, the close tier runs.
  const live = fakeClient();
  await makeView(c, { client: live, below: () => 3 }).view.renderSearchResults("barcelona", null);
  assert.equal(live.calls.length, 1, "2 exact rows < 3");
});

test("no exact rows: the list says it is looking, and says 'No matches' only if nothing close turns up", async () => {
  const c = await loadCatalog();
  const halo = byName(c, "Halo");
  for (const [answer, want] of [[[{ i: c.songs.indexOf(halo), score: 1 }], [halo]], [[], []], [null, []]]) {
    const client = lateClient();
    const { view, lib } = makeView(c, { client });
    const done = view.renderSearchResults("haloo", null);
    assert.deepEqual(lib.renders[0].rows, []);
    assert.match(lib.renders[0].empty.title, /No exact matches/);
    assert.doesNotMatch(lib.renders[0].empty.title, /^No matches/, "never a premature 'No matches'");
    client.pending[0].resolve(answer);
    await done;
    assert.equal(lib.renders.length, 2, `answer ${JSON.stringify(answer)}: one final render`);
    assert.deepEqual(lib.getList(), want);
    if (!want.length) assert.match(lib.renders[1].empty.title, /^No matches for "haloo"/);
  }
  // Fuzzy off (or no index yet): today's empty state straight away, nothing pending.
  const { view, lib } = makeView(c, { client: fakeClient(), fuzzy: false });
  await view.renderSearchResults("haloo", null);
  assert.equal(lib.renders.length, 1);
  assert.match(lib.renders[0].empty.title, /^No matches for "haloo"/);
});

test("a re-render of the same search reuses its close tier, YouTube rows still last", async () => {
  const c = await loadCatalog();
  const halo = byName(c, "Halo");
  const client = fakeClient(() => [{ i: c.songs.indexOf(halo), score: 1 }]);
  const { view, lib } = makeView(c, { client });
  await view.renderSearchResults("barcelna", null);
  assert.deepEqual(lib.getList(), [halo]);

  // The YouTube append re-renders the same query: one render, close rows kept, no new query.
  const yt = { id: "youtube:y", kind: "youtube", code: "", name: "YT" };
  const before = lib.renders.length;
  await view.renderSearchResults("barcelna", [yt]);
  assert.equal(lib.renders.length, before + 1);
  assert.deepEqual(lib.getList(), [halo, yt]);
  assert.deepEqual([...lib.renders.at(-1).closeSet], [halo]);
  assert.equal(client.calls.length, 1);
});

// --- topHit and Enter ---------------------------------------------------------------------------
test("topHit is row one, or null for an empty list", async () => {
  const c = await loadCatalog();
  const { view } = makeView(c);
  view.renderSearchResults("123", null);
  assert.equal(view.topHit(), byName(c, "Sh One Two Three"));
  view.renderSearchResults("no such song anywhere", null);
  assert.equal(view.topHit(), null);
  view.renderSearchResults("barcelona", null);
  assert.equal(view.topHit(), c.search("barcelona")[0]);
  // Not ready yet (no getList on the list UI) → null, never a throw.
  const bare = createLibraryView({
    catalog: c, settings: { get: () => false }, getLib: () => ({ renderList() {} }),
    setStatus: () => {}, youtubeSupported: () => false,
    getQueueIds: () => [], getRecentIds: () => [], getRecentSongs: () => [], storage: null,
  });
  assert.equal(bare.topHit(), null);
});

test("enterDecision: auto reserves while busy and plays when idle; now and reserve are fixed", () => {
  assert.equal(enterDecision("auto", true), "reserve");
  assert.equal(enterDecision("auto", false), "play");
  assert.equal(enterDecision("now", true), "play");
  assert.equal(enterDecision("now", false), "play");
  assert.equal(enterDecision("reserve", true), "reserve");
  assert.equal(enterDecision("reserve", false), "reserve");
  assert.equal(enterDecision(undefined, true), "reserve", "unknown → auto");
  assert.equal(enterDecision("bogus", false), "play", "unknown → auto");
});
