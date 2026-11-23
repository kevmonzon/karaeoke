/*
 * catalog-source.test.js — the songbook `source` field on the client side: dial-code
 * normalisation, the (source, code) index, lookupCode() and adopt().
 * Run with:  node --test    (or  npm test)
 *
 * The catalogue loader is exercised through a stubbed global fetch, as in unit.test.js.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { Catalog, SOURCES, normalizeCode } from "../src/js/catalog.js";

// Stub global fetch so load() can run without a server.
function stubFetch(map) {
  const prev = global.fetch;
  global.fetch = async (url) => {
    const key = String(url);
    if (key in map) return { ok: true, json: async () => structuredClone(map[key]) };
    return { ok: false, status: 404, json: async () => [] };
  };
  return () => { global.fetch = prev; };
}

async function loadCatalogs(map) {
  const restore = stubFetch(map);
  const c = new Catalog();
  try { await c.load(); } finally { restore(); }
  return c;
}

// One dial number (5) in four songbooks and two kinds, plus a same-source collision.
const MIDI = [
  { code: 5, name: "Sh Five", artistName: "A", langName: "", type: "MIDI", source: "SH", file: "kar_raw/5 - A - Sh Five - SH.kar" },
  { code: 5, name: "Mega Five", artistName: "B", langName: "OPM", type: "MIDI", source: "MIDI", file: "kar_raw/5 - B - Mega Five - OPM - MIDI.mid" },
  { code: 5, name: "Tj Five", artistName: "C", langName: "AB", type: "MIDI", source: "TJMEDIA", file: "kar_raw/5 - C - Tj Five - AB - TJMEDIA.mid" },
  { code: 7, name: "Plat Seven", artistName: "", langName: "", type: "MIDI", source: "PLATKAR", file: "kar_raw/7 - Plat Seven - PLATKAR.mid" },
  { code: 7, name: "Plat Seven Again", artistName: "", langName: "", type: "MIDI", source: "PLATKAR", file: "kar_raw/7 - Plat Seven Again - PLATKAR.mid" },
];
const AUDIO = [
  { code: 5, name: "Tj Five Recorded", artistName: "C", langName: "AB", type: "AUDIO", source: "TJMEDIA", file: "audio_lyrics/5.mp3" },
];

const stripSource = (list) => list.map(({ source, ...rest }) => rest);

test("normalizeCode strips zeros", () => {
  assert.equal(normalizeCode("00123"), "123");
  assert.equal(normalizeCode("000"), "0");
  assert.equal(normalizeCode(""), "");
  assert.equal(normalizeCode("12a"), "12");
  assert.equal(normalizeCode("0"), "0");
  assert.equal(normalizeCode(147), "147");
  assert.equal(normalizeCode(" 0 0 7 "), "7");   // digits only, wherever they are
  assert.equal(normalizeCode(null), "");
  assert.equal(normalizeCode(undefined), "");
  assert.equal(normalizeCode("abc"), "");
});

test("SOURCES matches the builders' SOURCE_TAGS", () => {
  assert.deepEqual(SOURCES, ["SH", "PLATKAR", "TJMEDIA", "MIDI"]);
  const py = readFileSync(new URL("../tools/catalog_common.py", import.meta.url), "utf8");
  const m = py.match(/^SOURCE_TAGS = \(([^)]*)\)/m);
  assert.ok(m, "SOURCE_TAGS not found in tools/catalog_common.py");
  assert.deepEqual([...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]), SOURCES);
});

test("lookupCode all returns every source in order", async () => {
  const c = await loadCatalogs({ "/catalog.json": MIDI, "/catalog-audio.json": AUDIO });
  const hits = c.lookupCode("5");
  assert.deepEqual(hits.map((s) => s.name), ["Sh Five", "Mega Five", "Tj Five", "Tj Five Recorded"]);
  assert.deepEqual(hits.map((s) => s.kind), ["midi", "midi", "midi", "audio"]);
  assert.deepEqual(c.lookupCode("5", null).map((s) => s.id), hits.map((s) => s.id));  // null = all
  assert.deepEqual(c.lookupCode("404"), []);
  assert.deepEqual(c.lookupCode(""), []);
});

test("lookupCode by source returns one", async () => {
  const c = await loadCatalogs({ "/catalog.json": MIDI, "/catalog-audio.json": AUDIO });
  assert.deepEqual(c.lookupCode("5", "SH").map((s) => s.name), ["Sh Five"]);
  assert.deepEqual(c.lookupCode("5", "MIDI").map((s) => s.name), ["Mega Five"]);
  // one songbook, two kinds: the MIDI record and the recorded one both answer
  assert.deepEqual(c.lookupCode("5", "TJMEDIA").map((s) => s.name), ["Tj Five", "Tj Five Recorded"]);
  // a collision inside one songbook keeps both, in catalogue order
  assert.deepEqual(c.lookupCode("7", "PLATKAR").map((s) => s.name), ["Plat Seven", "Plat Seven Again"]);
  assert.deepEqual(c.lookupCode("5", "PLATKAR"), []);
  assert.deepEqual(c.lookupCode("5", ""), []);           // every record here has a source
  assert.equal(c.bySourceCode.get("SH:5").length, 1);
  // the result is a copy: changing it leaves the index alone
  c.lookupCode("5", "SH").pop();
  assert.equal(c.lookupCode("5", "SH").length, 1);
});

test("lookupCode treats code as a string", async () => {
  const c = await loadCatalogs({ "/catalog.json": MIDI });
  assert.deepEqual(c.lookupCode(5).map((s) => s.id), c.lookupCode("5").map((s) => s.id));
  assert.equal(c.lookupCode(5, "SH")[0].name, "Sh Five");
  // compared as String(song.code), unnormalised: a typed number goes through normalizeCode
  assert.deepEqual(c.lookupCode("005"), []);
  assert.equal(c.lookupCode(normalizeCode("005")).length, 3);
});

test("a catalogue without source fields still loads", async () => {
  const c = await loadCatalogs({ "/catalog.json": stripSource(MIDI), "/catalog-audio.json": stripSource(AUDIO) });
  assert.equal(c.songs.length, 6);
  for (const s of c.songs) assert.equal(s.source, "");
  assert.equal(c.lookupCode("5", "").length, 4);       // all unsourced
  assert.equal(c.lookupCode("5", "SH").length, 0);
  assert.equal(c.bySourceCode.get(":7").length, 2);
  // the haystack is exactly the pre-source one: title, artist, lang, code
  assert.equal(c.getById("midi:5")._search, "sh five a  5");
  assert.equal(c.get(5).name, "Sh Five");              // byCode: first wins, as before
});

test("source is searchable text", async () => {
  const c = await loadCatalogs({ "/catalog.json": MIDI });
  assert.deepEqual(c.search("platkar").map((s) => s.name).sort(), ["Plat Seven", "Plat Seven Again"]);
  assert.deepEqual(c.search("tjmedia").map((s) => s.name), ["Tj Five"]);
  assert.deepEqual(c.search("seven PLATKAR").map((s) => s.name).sort(), ["Plat Seven", "Plat Seven Again"]);
  assert.equal(c.getById("midi:7")._search, "plat seven   7 platkar");
  assert.equal(c.search("5").length, 3);               // numeric dial search is unchanged
});

test("ids are unchanged by the new field", async () => {
  const withSource = await loadCatalogs({ "/catalog.json": MIDI, "/catalog-audio.json": AUDIO });
  const without = await loadCatalogs({ "/catalog.json": stripSource(MIDI), "/catalog-audio.json": stripSource(AUDIO) });
  const expected = [
    "midi:5",                                          // first record keeps kind:code
    "midi:kar_raw/5 - B - Mega Five - OPM - MIDI.mid", // later collisions → file path
    "midi:kar_raw/5 - C - Tj Five - AB - TJMEDIA.mid",
    "midi:7",
    "midi:kar_raw/7 - Plat Seven Again - PLATKAR.mid",
    "audio:5",                                         // other kinds keep their own namespace
  ];
  assert.deepEqual(withSource.songs.map((s) => s.id), expected);
  assert.deepEqual(without.songs.map((s) => s.id), expected);
  for (const id of expected) assert.equal(withSource.getById(id).name, without.getById(id).name);
});

test("adopt rebuilds every index", async () => {
  const c = await loadCatalogs({ "/catalog.json": MIDI, "/catalog-audio.json": AUDIO });
  const keep = c.songs.filter((s) => s.code === 7);   // already tagged by load()
  const fresh = { code: 9, name: "Fresh Nine", artistName: "D", langName: "", type: "VIDEO", source: "SH", kind: "video", file: "videos/9.mp4" };
  const n = c.adopt([...keep, fresh]);
  assert.equal(n, 3);
  assert.deepEqual(c.songs.map((s) => s.name), ["Plat Seven", "Plat Seven Again", "Fresh Nine"]);
  // the old list is gone from every index
  assert.equal(c.get(5), undefined);
  assert.equal(c.getById("midi:5"), undefined);
  assert.equal(c.bySourceCode.has("SH:5"), false);
  assert.deepEqual(c.lookupCode("5"), []);
  // the new list is in every index
  assert.equal(c.get(7).name, "Plat Seven");
  assert.equal(c.getById("midi:kar_raw/7 - Plat Seven Again - PLATKAR.mid").name, "Plat Seven Again");
  assert.equal(c.getById("video:9").name, "Fresh Nine");     // untagged record → tagged with its own kind
  assert.deepEqual(c.lookupCode("7", "PLATKAR").map((s) => s.name), ["Plat Seven", "Plat Seven Again"]);
  assert.deepEqual(c.lookupCode(9, "SH").map((s) => s.name), ["Fresh Nine"]);
  assert.deepEqual(c.search("fresh").map((s) => s.name), ["Fresh Nine"]);
  // a junk list empties the catalogue instead of throwing
  assert.equal(c.adopt(null), 0);
  assert.equal(c.byId.size + c.byCode.size + c.bySourceCode.size, 0);
});

test("adopt does not re-tag records that have an id", () => {
  const c = new Catalog();
  const prepared = [
    // ids and haystacks as the host computed them; re-tagging would turn the second id
    // back into "midi:5" and overwrite both haystacks
    { code: 5, name: "First", source: "SH", kind: "midi", id: "midi:5", _search: "host haystack one" },
    { code: 5, name: "Second", source: "SH", kind: "midi", id: "midi:kar_raw/second.mid", _search: "host haystack two" },
    // no id yet: tagged as load() would, kind defaulting to midi, collision → name
    { code: 5, name: "Third", source: "TJMEDIA" },
  ];
  c.adopt(prepared);
  assert.equal(c.songs[0], prepared[0]);                     // same objects, not copies
  assert.equal(prepared[0].id, "midi:5");
  assert.equal(prepared[1].id, "midi:kar_raw/second.mid");
  assert.equal(prepared[0]._search, "host haystack one");
  assert.equal(prepared[1]._search, "host haystack two");
  assert.equal(prepared[2].kind, "midi");
  assert.equal(prepared[2].id, "midi:Third");
  assert.equal(prepared[2]._search, "third   5 tjmedia");
  assert.deepEqual(c.search("haystack").map((s) => s.name).sort(), ["First", "Second"]);
  assert.deepEqual(c.lookupCode(5).map((s) => s.name), ["First", "Second", "Third"]);
  assert.equal(c.getById("midi:5").name, "First");
});
