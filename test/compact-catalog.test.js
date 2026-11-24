/*
 * compact-catalog.test.js — the phone's catalogue (src/js/compact-catalog.js, M7): decoding the
 * /api/catalog/compact body into records Catalog.adopt() indexes, and the three search tiers the
 * phone runs over them (the number tier, Catalog.search, and the close tier from the real
 * search-core / search-client).
 * Run with:  node --test    (or  npm test)
 *
 * The bodies below are built the way tools/serve.py `_compact_rows` builds them: sources start
 * with "", kinds are midi / video / audio, langs start with "".
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { decodeCompact, loadCompact } from "../src/js/compact-catalog.js";
import { Catalog, SOURCES, normalizeCode } from "../src/js/catalog.js";
import { orderNumberMatches, mergeTiers } from "../src/js/search-core.js";
import { createSearchClient } from "../src/js/search-client.js";

const SRC = ["", "SH", "PLATKAR", "TJMEDIA", "MIDI"];
const KINDS = ["midi", "video", "audio"];
const LANGS = ["", "OPM", "English"];

/** A compact body from [code, name, artist, source, kind, lang] rows given as NAMES. */
function body(named, extra = {}) {
  const rows = named.map((r) => Array.isArray(r)
    ? [r[0], r[1], r[2], SRC.indexOf(r[3] ?? ""), KINDS.indexOf(r[4] ?? "midi"), LANGS.indexOf(r[5] ?? "")]
    : r);
  return rawBody(rows, extra);
}

/** A compact body from rows exactly as given (dictionary indices, or junk). */
function rawBody(rows, extra = {}) {
  return { v: 1, rev: "abc123", sources: SRC.slice(), kinds: KINDS.slice(), langs: LANGS.slice(),
           cols: ["code", "name", "artist", "source", "kind", "lang"], rows, ...extra };
}

const LIB = body([
  [123, "Barcelona", "Freddie Mercury", "SH", "midi", "English"],            // 0
  [123, "Anak", "Freddie Aguilar", "TJMEDIA", "audio", "OPM"],              // 1
  [1234, "Bohemian Rhapsody", "Queen", "PLATKAR", "midi", "English"],       // 2
  [123, "Halo", "Beyoncé", "MIDI", "video", "English"],                     // 3
  [77, "Ikaw", "Yeng Constantino", "", "midi", "OPM"],                       // 4
  [500, "Don't Stop Me Now", "Queen", "SH", "midi", "English"],             // 5
  [123, "Kahit Maputi Na Ang Buhok Ko", "Rey Valera", "PLATKAR", "midi", "OPM"],   // 6
  ["", "Untitled drop-in", "", "", "video", ""],                            // 7
]);

/** The phone's tier 1 + 2, as library-view.js searchTiers computes them on the host. */
function tiers(catalog, q) {
  if (/^\d+$/.test(q.trim())) {
    return mergeTiers(orderNumberMatches(catalog.lookupCode(normalizeCode(q), "all"), SOURCES), catalog.search(q));
  }
  return catalog.search(q);
}

// ---------------------------------------------------------------------------------------------
test("decode maps indices to names", () => {
  const songs = decodeCompact(LIB);
  assert.equal(songs.length, 8);
  const s = songs[1];
  assert.equal(s.code, 123);
  assert.equal(s.name, "Anak");
  assert.equal(s.artistName, "Freddie Aguilar");
  assert.equal(s.source, "TJMEDIA");
  assert.equal(s.kind, "audio");
  assert.equal(s.langName, "OPM");
  assert.equal(s.type, "");
  assert.equal(s.id, "c:1");
  assert.equal(songs[3].kind, "video");
  assert.equal(songs[4].source, "");
});

test("row index is preserved as i", () => {
  const songs = decodeCompact(body([
    [1, "One", "A"],
    "not a row",                                   // malformed: kept, as an empty record
    null,
    [4, "Four", "D"],
  ]));
  assert.equal(songs.length, 4);
  songs.forEach((s, k) => { assert.equal(s.i, k); assert.equal(s.id, `c:${k}`); });
  assert.deepEqual([songs[1].code, songs[1].name, songs[1].artistName], ["", "", ""]);
  assert.deepEqual([songs[2].code, songs[2].name, songs[2].artistName], ["", "", ""]);
  assert.equal(songs[3].name, "Four");
});

test("a row with an unknown source index gets \"\"", () => {
  const songs = decodeCompact(rawBody([
    [1, "A", "x", 0, 0, 0],
    [2, "B", "x", 99, 0, 0],                        // past the end
    [3, "C", "x", -1, 0, 0],
    [4, "D", "x", "length", 0, 0],                  // not an index
    [5, "E", "x", 1.5, 7, 42],                      // kind and lang unknown too
  ]));
  assert.deepEqual(songs.map((s) => s.source), ["", "", "", "", ""]);
  assert.equal(songs[4].kind, "midi");
  assert.equal(songs[4].langName, "");
});

test("decode rejects a wrong version", () => {
  assert.equal(decodeCompact({ ...LIB, v: 2 }), null);
  assert.equal(decodeCompact({ ...LIB, v: "1" }), null);
  const { v, ...noV } = LIB;
  assert.equal(decodeCompact(noV), null);
});

test("decode rejects a wrong shape", () => {
  assert.equal(decodeCompact(null), null);
  assert.equal(decodeCompact("{}"), null);
  assert.equal(decodeCompact([]), null);
  assert.equal(decodeCompact({ ...LIB, rows: {} }), null);
  assert.equal(decodeCompact({ ...LIB, sources: null }), null);
  assert.equal(decodeCompact({ ...LIB, kinds: "midi" }), null);
  assert.equal(decodeCompact({ ...LIB, langs: undefined }), null);
  assert.deepEqual(decodeCompact({ ...LIB, rows: [] }), []);
});

test("_search is the haystack catalog.js builds for the same record", () => {
  const songs = decodeCompact(LIB);
  // What Catalog.adopt() makes of an UNTAGGED record with the same fields (tag() runs on it).
  const plain = songs.map((s) => ({ code: s.code, name: s.name, artistName: s.artistName,
                                    langName: s.langName, source: s.source, kind: s.kind }));
  new Catalog().adopt(plain);
  plain.forEach((p, k) => assert.equal(songs[k]._search, p._search, `row ${k}`));
  assert.equal(songs[0]._search, "barcelona freddie mercury english 123 sh");
  assert.equal(songs[4]._search, "ikaw yeng constantino opm 77");         // no songbook → nothing appended
});

test("decoded songs are searchable by title, artist, code and source", () => {
  const cat = new Catalog();
  cat.adopt(decodeCompact(LIB));
  assert.deepEqual(cat.search("barcelona").map((s) => s.i), [0]);
  assert.deepEqual(cat.search("queen").map((s) => s.i).sort(), [2, 5]);
  assert.deepEqual(cat.search("1234").map((s) => s.i), [2]);
  assert.ok(cat.search("platkar").map((s) => s.i).includes(6));
  assert.deepEqual(cat.search("bohemian platkar").map((s) => s.i), [2]);
  assert.deepEqual(cat.search("tjmedia").map((s) => s.i), [1]);         // the songbook, nowhere else
  assert.deepEqual(cat.search("anak tjmedia").map((s) => s.i), [1]);
});

test("lang comes from the dictionary and is searchable", () => {
  const songs = decodeCompact(LIB);
  assert.equal(songs[4].langName, "OPM");
  const cat = new Catalog();
  cat.adopt(songs);
  assert.deepEqual(cat.search("opm").map((s) => s.i).sort((a, b) => a - b), [1, 4, 6]);
  assert.deepEqual(cat.search("opm valera").map((s) => s.i), [6]);
});

test("adopt rebuilds the code index", () => {
  const cat = new Catalog();
  cat.adopt(decodeCompact(LIB));
  assert.deepEqual(cat.lookupCode("123").map((s) => s.i), [0, 1, 3, 6]);
  assert.deepEqual(cat.lookupCode("123", "PLATKAR").map((s) => s.i), [6]);
  assert.equal(cat.getById("c:2").name, "Bohemian Rhapsody");
  assert.equal(cat.get("1234").i, 2);
  assert.deepEqual(cat.lookupCode(""), []);                         // the blank-code video is not dialable
  // A second adopt replaces everything (a reloaded catalogue).
  cat.adopt(decodeCompact(body([[9, "Nine", "N", "SH"]])));
  assert.deepEqual(cat.lookupCode("123"), []);
  assert.equal(cat.lookupCode("9")[0].name, "Nine");
  assert.equal(cat.getById("c:2"), undefined);
});

test("the number tier lists every songbook in order, then the prefix matches", () => {
  const cat = new Catalog();
  cat.adopt(decodeCompact(LIB));
  // SH → PLATKAR → TJMEDIA → MIDI, then 1234 by prefix. "00123" finds the same exact rows.
  assert.deepEqual(tiers(cat, "123").map((s) => s.i), [0, 6, 1, 3, 2]);
  assert.deepEqual(tiers(cat, "00123").slice(0, 4).map((s) => s.i), [0, 6, 1, 3]);
});

test("the close tier runs over an adopted compact catalogue", async () => {
  const songs = decodeCompact(LIB);
  const cat = new Catalog();
  cat.adopt(songs);
  assert.equal(cat.songs[0], songs[0]);             // adopt keeps the records: hit i → catalog.songs[i]
  const client = createSearchClient({ WorkerImpl: undefined, schedule: (fn) => setImmediate(fn) });
  await client.build(cat.songs.map((s) => s.name), cat.songs.map((s) => s.artistName));
  assert.equal(client.ready, true);
  const exact = tiers(cat, "barcelna");
  assert.deepEqual(exact, []);                      // no exact match for the typo
  const hits = await client.query("barcelna", { exclude: exact.map((s) => s.i) });
  assert.deepEqual(hits.map((h) => cat.songs[h.i].name), ["Barcelona"]);
  const beyonce = await client.query("beyonce halo");
  assert.equal(cat.songs[beyonce[0].i].name, "Halo");
  // Rows already in the exact tier are skipped.
  const queen = tiers(cat, "queen");
  const none = await client.query("queen", { exclude: queen.map((s) => s.i) });
  assert.deepEqual(none, []);
  client.dispose();
});

test("loadCompact fetches, decodes and reports the rev", async () => {
  const calls = [];
  const ok = (json, headers = {}) => async (url) => {
    calls.push(url);
    return { ok: true, status: 200, json: async () => json, headers: { get: (k) => headers[k] ?? null } };
  };
  const r = await loadCompact(undefined, ok(LIB));
  assert.deepEqual(calls, ["/api/catalog/compact"]);
  assert.equal(r.songs.length, 8);
  assert.equal(r.rev, "abc123");
  const { rev, ...noRev } = LIB;
  assert.equal((await loadCompact("/c", ok(noRev, { ETag: '"e1"' }))).rev, '"e1"');
  assert.equal((await loadCompact("/c", ok(noRev))).rev, null);
});

test("loadCompact returns null on any failure and never throws", async () => {
  assert.equal(await loadCompact("/c", async () => ({ ok: false, status: 404, json: async () => LIB })), null);
  assert.equal(await loadCompact("/c", async () => { throw new TypeError("network down"); }), null);
  assert.equal(await loadCompact("/c", async () => ({ ok: true, json: async () => { throw new SyntaxError("bad json"); } })), null);
  assert.equal(await loadCompact("/c", async () => ({ ok: true, json: async () => ({ v: 2 }) })), null);
  assert.equal(await loadCompact("/c", null), null);
  assert.equal(await loadCompact("/c", async () => null), null);
});
