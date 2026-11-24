/*
 * browse.test.js — the library-browse helpers (M6): artist keys, songbook / kind filters and their
 * facets, the four sort modes, the artist index and its typed filter, and a 121k-song scale run.
 * Run with:  node --test    (or  npm test)
 *
 * The scale test checks the SHAPE of every result (a permutation, every neighbouring pair in
 * order under a reference comparator, ties in input order) — never a wall-clock threshold.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  UNKNOWN_ARTIST, UNKNOWN_ARTIST_LABEL, KINDS, SORTS,
  artistKey, presentFacets, applyFilters, sortSongs, buildArtistIndex, songsByArtist, filterArtists,
} from "../src/js/library-browse.js";
import { SOURCES } from "../src/js/catalog.js";

let nextId = 0;
/** A catalogue-shaped record. */
function song(name, artistName = "", { code = nextId, source = "MIDI", kind = "midi" } = {}) {
  nextId++;
  return { code, name, artistName, langName: "", type: "MIDI", source, kind, id: `${kind}:${code}:${nextId}` };
}
const yt = (title, channel = "Some Channel") =>
  ({ kind: "youtube", id: `youtube:${title}`, code: "", videoId: title, name: title, artistName: channel });
const names = (list) => list.map((s) => s.name);

const COLLATOR = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

function rng(seed) {   // mulberry32
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// --- constants ---------------------------------------------------------------------
test("the kinds and sorts are frozen and in display order", () => {
  assert.deepEqual(KINDS.map((k) => k.id), ["midi", "audio", "video"]);
  assert.deepEqual(SORTS.map((s) => s.id), ["relevance", "title", "artist", "code"]);
  assert.ok(Object.isFrozen(KINDS) && Object.isFrozen(KINDS[0]) && Object.isFrozen(SORTS) && Object.isFrozen(SORTS[3]));
  assert.equal(UNKNOWN_ARTIST_LABEL, "(Unknown artist)");
});

// --- artistKey -----------------------------------------------------------------------
test("artistKey folds case and space", () => {
  const k = artistKey("Taylor Swift");
  assert.equal(k, "taylor swift");
  for (const v of ["TAYLOR SWIFT", "  taylor   swift ", "Taylor\tSwift", "Taylor Swift", "taylor\n swift"]) {
    assert.equal(artistKey(v), k, JSON.stringify(v));
  }
  assert.notEqual(artistKey("Taylor Swiftly"), k);
  // A decomposed accent groups with the composed one.
  assert.equal(artistKey("Beyoncé"), artistKey("Beyoncé"));
  assert.notEqual(artistKey("Beyoncé"), artistKey("Beyonce"));   // accents are kept in the key
});

test("artistKey folds placeholders", () => {
  for (const v of ["", "   ", ".", "..", "-", "unknown", "Unknown", "  UNKNOWN ", "none", "None", "n/a", "N/A",
    "na", "NA", "various", "Various", "various artists", "Various   Artists", "Unknown Artist", "Various Artist",
    null, undefined]) {
    assert.equal(artistKey(v), UNKNOWN_ARTIST, JSON.stringify(v));
  }
  // Whole-name matches only: a real name that merely contains a placeholder keeps its own key.
  for (const v of ["Nana", "The Unknowns", "None of the Above", "Various Cruelties", "A-ha", "..And You Will Know Us", "Anonymous"]) {
    assert.notEqual(artistKey(v), UNKNOWN_ARTIST, v);
  }
  // The unknown key cannot be spelled by a real name: control characters fold like spaces.
  assert.equal(artistKey("\u0000unknown"), UNKNOWN_ARTIST);
  assert.equal(artistKey("\u0000Queen"), "queen");
});

// --- presentFacets -------------------------------------------------------------------------
test("facets list only what is present, in order", () => {
  const songs = [
    song("a", "", { source: "MIDI", kind: "video" }),
    song("b", "", { source: "", kind: "midi" }),
    song("c", "", { source: "SH", kind: "video" }),
    song("d", "", { source: "MIDI", kind: "midi" }),
    yt("e"),
    song("f", "", { source: "OTHER", kind: "karaoke-box" }),
  ];
  assert.deepEqual(presentFacets(songs), { sources: ["SH", "MIDI"], kinds: ["midi", "video"] });

  const all = SOURCES.flatMap((source) => KINDS.map((k) => song("x", "", { source, kind: k.id }))).reverse();
  assert.deepEqual(presentFacets(all), { sources: SOURCES, kinds: ["midi", "audio", "video"] });

  // An old catalogue (no songbook on any record) offers no source chip at all.
  assert.deepEqual(presentFacets([song("a", "", { source: "" })]), { sources: [], kinds: ["midi"] });
  assert.deepEqual(presentFacets([]), { sources: [], kinds: [] });
  assert.deepEqual(presentFacets(null), { sources: [], kinds: [] });
});

// --- applyFilters ----------------------------------------------------------------------------------
const LIB = [
  song("sh midi", "", { source: "SH", kind: "midi" }),
  song("plat midi", "", { source: "PLATKAR", kind: "midi" }),
  song("sh audio", "", { source: "SH", kind: "audio" }),
  song("none video", "", { source: "", kind: "video" }),
  song("tj video", "", { source: "TJMEDIA", kind: "video" }),
  song("plat audio", "", { source: "PLATKAR", kind: "audio" }),
];

test("no filter returns the same array", () => {
  assert.equal(applyFilters(LIB), LIB);
  assert.equal(applyFilters(LIB, {}), LIB);
  assert.equal(applyFilters(LIB, { sources: null, kinds: null }), LIB);
  assert.equal(applyFilters(LIB, { sources: new Set(), kinds: new Set() }), LIB);
  const empty = [];
  assert.equal(applyFilters(empty, { sources: new Set() }), empty);
});

test("source filter", () => {
  const out = applyFilters(LIB, { sources: new Set(["SH"]) });
  assert.deepEqual(names(out), ["sh midi", "sh audio"]);
  assert.notEqual(out, LIB);
  assert.deepEqual(names(applyFilters(LIB, { sources: new Set(["PLATKAR", "SH"]) })),
    ["sh midi", "plat midi", "sh audio", "plat audio"]);            // catalogue order, not chip order
  assert.deepEqual(applyFilters(LIB, { sources: new Set(["MIDI"]) }), []);
  assert.equal(LIB.length, 6);                                     // the input is untouched
});

test("kind filter", () => {
  assert.deepEqual(names(applyFilters(LIB, { kinds: new Set(["video"]) })), ["none video", "tj video"]);
  assert.deepEqual(names(applyFilters(LIB, { kinds: new Set(["audio", "midi"]) })),
    ["sh midi", "plat midi", "sh audio", "plat audio"]);
});

test("both filters intersect", () => {
  assert.deepEqual(names(applyFilters(LIB, { sources: new Set(["PLATKAR"]), kinds: new Set(["audio"]) })), ["plat audio"]);
  assert.deepEqual(names(applyFilters(LIB, { sources: new Set(["SH", "TJMEDIA"]), kinds: new Set(["video", "midi"]) })),
    ["sh midi", "tj video"]);
  // An empty axis is no filter on that axis.
  assert.deepEqual(names(applyFilters(LIB, { sources: new Set(["TJMEDIA"]), kinds: new Set() })), ["tj video"]);
});

test("youtube records vs filters", () => {
  const rows = [LIB[0], yt("Halo karaoke"), LIB[3]];
  assert.equal(applyFilters(rows, {}), rows);                                   // kept: nothing filters
  assert.deepEqual(names(applyFilters(rows, { sources: new Set(["SH"]) })), ["sh midi"]);
  assert.deepEqual(names(applyFilters(rows, { kinds: new Set(["midi", "video"]) })), ["sh midi", "none video"]);
  // Even a kind set that names "youtube" is an active kind filter.
  assert.deepEqual(names(applyFilters(rows, { kinds: new Set(["youtube"]) })), []);
});

// --- sortSongs ------------------------------------------------------------------------------------------
test("sort by title is locale-aware and stable", () => {
  const input = [
    song("zebra"), song("Éclair"), song("apple"), song("Banana"), song("eagle"), song("Echo"),
    song("Song 10"), song("Song 2"),
  ];
  const before = input.slice();
  const out = sortSongs(input, "title");
  assert.deepEqual(names(out), ["apple", "Banana", "eagle", "Echo", "Éclair", "Song 2", "Song 10", "zebra"]);
  assert.notEqual(out, input);
  assert.deepEqual(input, before);                                  // a copy; the input is not reordered

  // Ties: same title → artist, then number; a full tie keeps the input order.
  const a = song("Halo", "Beyoncé", { code: 30 }), b = song("Halo", "Adele", { code: 50 });
  const c = song("halo", "beyonce", { code: 10 }), d = song("HALO", "Beyoncé", { code: 30, kind: "audio" });
  const e = song("Halo", "Beyoncé", { code: 30, kind: "video" });
  assert.deepEqual(sortSongs([d, a, e, c, b], "title"), [b, c, d, a, e]);
  assert.deepEqual(sortSongs([e, a, d, c, b], "title"), [b, c, e, a, d]);
  const one = [a];
  assert.notEqual(sortSongs(one, "title"), one);                    // still a copy
  assert.deepEqual(sortSongs([], "title"), []);
});

test("sort stays correct as new titles arrive", () => {
  // Each call may bring titles the previous calls never saw; the order must not depend on history.
  assert.deepEqual(names(sortSongs([song("delta"), song("bravo")], "title")), ["bravo", "delta"]);
  assert.deepEqual(names(sortSongs([song("echo"), song("charlie"), song("bravo"), song("alpha"), song("delta")], "title")),
    ["alpha", "bravo", "charlie", "delta", "echo"]);
  assert.deepEqual(names(sortSongs([song("Delta"), song("ALPHA"), song("Bravo2"), song("bravo10")], "title")),
    ["ALPHA", "Bravo2", "bravo10", "Delta"]);

  // Long lists share one rank table: a second long list whose titles and artists the first never
  // had must still interleave correctly with what the table already holds.
  const evens = Array.from({ length: 5000 }, (_, i) => song(`Track ${i * 2}`, `Band ${i % 50}`));
  const odds = Array.from({ length: 5000 }, (_, i) => song(`track ${9999 - i * 2}`, `band ${i % 70}`));
  assert.equal(sortSongs(evens, "title").length, 5000);
  const mixed = [...odds, ...evens.slice(0, 2500)];
  const num = (s) => Number(s.name.split(" ")[1]);
  const byTitle = sortSongs(mixed, "title");
  assert.equal(byTitle.length, 7500);
  for (let i = 1; i < byTitle.length; i++) assert.ok(num(byTitle[i - 1]) < num(byTitle[i]), `title at ${i}`);
  const byArtist = sortSongs(mixed, "artist");
  for (let i = 1; i < byArtist.length; i++) {
    const c = COLLATOR.compare(artistKey(byArtist[i - 1].artistName), artistKey(byArtist[i].artistName));
    assert.ok(c < 0 || (c === 0 && COLLATOR.compare(byArtist[i - 1].name, byArtist[i].name) < 0), `artist at ${i}`);
  }
});

test("sort by artist groups spellings and puts unknown artists last", () => {
  const input = [
    song("b", "Queen"), song("x", ""), song("a", "ABBA"), song("c", "queen"), song("y", "Unknown"),
    song("a", " Queen "), song("b", "abba"), song("w", "N/A"),
  ];
  const out = sortSongs(input, "artist");
  assert.deepEqual(out.map((s) => `${s.artistName.trim()}|${s.name}`),
    ["ABBA|a", "abba|b", "Queen|a", "Queen|b", "queen|c", "N/A|w", "|x", "Unknown|y"]);
});

test("sort by code is numeric", () => {
  const input = [
    song("ten", "", { code: 10 }), song("nine", "", { code: 9 }), song("blank", "", { code: "", kind: "video" }),
    song("hundred", "", { code: 100 }), song("str42", "", { code: "42" }), song("zero", "", { code: 0 }),
  ];
  assert.deepEqual(names(sortSongs(input, "code")), ["zero", "nine", "ten", "str42", "hundred", "blank"]);

  // Same number: songbook in SOURCES order (none last), then kind (midi, audio, video).
  const same = [
    song("none", "", { code: 7, source: "" }), song("midi-vid", "", { code: 7, source: "MIDI", kind: "video" }),
    song("sh-audio", "", { code: 7, source: "SH", kind: "audio" }), song("tj", "", { code: 7, source: "TJMEDIA" }),
    song("sh-midi", "", { code: 7, source: "SH", kind: "midi" }), song("midi-midi", "", { code: 7, source: "MIDI" }),
    song("plat", "", { code: 7, source: "PLATKAR" }),
  ];
  assert.deepEqual(names(sortSongs(same, "code")), ["sh-midi", "sh-audio", "plat", "tj", "midi-midi", "midi-vid", "none"]);
});

test("relevance leaves order alone", () => {
  const input = [song("b"), song("a"), song("c")];
  for (const mode of ["relevance", undefined, null, "", "bogus", "__proto__", "constructor", "toString"]) {
    assert.equal(sortSongs(input, mode), input, String(mode));
  }
  assert.deepEqual(names(input), ["b", "a", "c"]);
});

// --- buildArtistIndex ------------------------------------------------------------------------------------
test("artist index counts and picks the common spelling", () => {
  const songs = [
    song("1", "ABBA"), song("2", "Abba"), song("3", "Bon Jovi"), song("4", "abba "), song("5", "Abba"),
    song("6", "Beyoncé"), song("7", "Bee Gees"), song("8", "Queen"), song("9", "QUEEN"),
    song("10", "Cher"), song("11", "CHER"), song("12", "CHER"), song("13", "Cher"),
  ];
  const index = buildArtistIndex(songs);
  assert.deepEqual(index, [
    { key: "abba", name: "Abba", count: 4 },          // "Abba" ×2 beats "ABBA" and "abba"
    { key: "bee gees", name: "Bee Gees", count: 1 },
    { key: "beyoncé", name: "Beyoncé", count: 1 },     // locale-aware: é sorts with e
    { key: "bon jovi", name: "Bon Jovi", count: 1 },
    { key: "cher", name: "Cher", count: 4 },          // a 2–2 tie: the first spelling seen
    { key: "queen", name: "Queen", count: 2 },        // a 1–1 tie: the first spelling seen
  ]);
  assert.deepEqual(Object.keys(index[0]), ["key", "name", "count"]);
  assert.deepEqual(buildArtistIndex([]), []);
});

test("unknown artists sort last", () => {
  const songs = [
    song("1", ""), song("2", "Zz Top"), song("3", ".."), song("4", "Unknown"), song("5", "  none "),
    song("6", "Various Artists"), song("7", "ABBA"), song("8", "-"), { name: "9", kind: "midi" },
  ];
  const index = buildArtistIndex(songs);
  assert.deepEqual(index.map((a) => a.name), ["ABBA", "Zz Top", UNKNOWN_ARTIST_LABEL]);
  assert.deepEqual(index.at(-1), { key: UNKNOWN_ARTIST, name: UNKNOWN_ARTIST_LABEL, count: 7 });
  // No unknown songs → no unknown bucket.
  assert.ok(!buildArtistIndex([song("1", "ABBA")]).some((a) => a.key === UNKNOWN_ARTIST));
});

test("songsByArtist matches the key", () => {
  const songs = [
    song("Waterloo", "ABBA", { code: 5 }), song("Halo", "Beyoncé"), song("Dancing Queen", "abba", { code: 9 }),
    song("Mamma Mia", " ABBA ", { code: 2 }), song("Dancing Queen", "Abba", { code: 3 }), song("Untitled", ""),
    song("Mystery", "Unknown"),
  ];
  const abba = songsByArtist(songs, artistKey("Abba"));
  assert.deepEqual(abba.map((s) => `${s.name}#${s.code}`), ["Dancing Queen#3", "Dancing Queen#9", "Mamma Mia#2", "Waterloo#5"]);
  assert.deepEqual(names(songsByArtist(songs, UNKNOWN_ARTIST)), ["Mystery", "Untitled"]);
  assert.deepEqual(songsByArtist(songs, "nobody"), []);
  // Every entry of an index finds exactly its count.
  for (const a of buildArtistIndex(songs)) assert.equal(songsByArtist(songs, a.key).length, a.count, a.name);
});

// --- filterArtists -------------------------------------------------------------------------------------------
const INDEX = buildArtistIndex([
  song("1", "Taylor Swift"), song("2", "Beyoncé"), song("3", "José Mari Chan"), song("4", "Swift Taylor Band"),
  song("5", "Queen"), song("6", "AC/DC"), song("7", ""),
]);

test("filterArtists: every token must occur in the name", () => {
  assert.deepEqual(filterArtists(INDEX, "taylor").map((a) => a.name), ["Swift Taylor Band", "Taylor Swift"]);
  assert.deepEqual(filterArtists(INDEX, "  SWIFT   tay ").map((a) => a.name), ["Swift Taylor Band", "Taylor Swift"]);
  assert.deepEqual(filterArtists(INDEX, "band swift").map((a) => a.name), ["Swift Taylor Band"]);
  assert.deepEqual(filterArtists(INDEX, "taylor queen"), []);
  assert.deepEqual(filterArtists(INDEX, "ac/dc").map((a) => a.name), ["AC/DC"]);
  assert.deepEqual(filterArtists(INDEX, "unknown").map((a) => a.key), [UNKNOWN_ARTIST]);   // its label matches
});

test("filterArtists: diacritics are ignored on both sides", () => {
  assert.deepEqual(filterArtists(INDEX, "beyonce").map((a) => a.name), ["Beyoncé"]);
  assert.deepEqual(filterArtists(INDEX, "BEYONCÉ").map((a) => a.name), ["Beyoncé"]);
  assert.deepEqual(filterArtists(INDEX, "jose chan").map((a) => a.name), ["José Mari Chan"]);
  assert.deepEqual(filterArtists(INDEX, "José").map((a) => a.name), ["José Mari Chan"]);
});

test("filterArtists: an empty query returns the same array", () => {
  for (const q of ["", "   ", null, undefined]) assert.equal(filterArtists(INDEX, q), INDEX, JSON.stringify(q));
  const out = filterArtists(INDEX, "queen");
  assert.notEqual(out, INDEX);
  assert.equal(INDEX.length, 7);
});

// --- scale ------------------------------------------------------------------------------------------------------
test("scale: 121,000 songs sort, filter and index into the right shape", () => {
  const rand = rng(6);
  const pickOf = (arr) => arr[Math.floor(rand() * arr.length)];
  const letters = "abcdefghijklmnopqrstuvwxyzéñ";
  const vocab = Array.from({ length: 30000 }, () =>
    Array.from({ length: 2 + Math.floor(rand() * 8) }, () => letters[Math.floor(rand() * letters.length)]).join(""));
  const word = () => {
    const w = pickOf(vocab);
    return rand() < 0.3 ? w[0].toUpperCase() + w.slice(1) : w;
  };
  const artists = Array.from({ length: 22000 }, () => Array.from({ length: 1 + Math.floor(rand() * 3) }, word).join(" "));
  const placeholders = ["", "..", "Unknown", "None", "various artists", "N/A"];
  const N = 121000;
  const songs = new Array(N);
  for (let i = 0; i < N; i++) {
    const title = Array.from({ length: 1 + Math.floor(rand() * 4) }, word).join(" ") + (rand() < 0.1 ? ` ${Math.floor(rand() * 20)}` : "");
    let artist = rand() < 0.08 ? pickOf(placeholders) : pickOf(artists);
    if (rand() < 0.05) artist = artist.toUpperCase();
    if (rand() < 0.02) artist = ` ${artist}  `;
    const kind = rand() < 0.9 ? "midi" : rand() < 0.5 ? "audio" : "video";
    const source = kind === "video" && rand() < 0.5 ? "" : pickOf(SOURCES);
    const code = rand() < 0.01 ? "" : Math.floor(rand() * 60000);
    songs[i] = { code, name: title, artistName: artist, kind, source, id: `${kind}:${i}` };
  }
  const pos = new Map(songs.map((s, i) => [s, i]));

  const isPermutation = (out) => {
    assert.equal(out.length, N);
    const seen = new Set(out);
    assert.equal(seen.size, N);
    for (const s of out) assert.ok(pos.has(s));
  };
  const num = (s) => (s.code === "" ? Infinity : s.code);
  const cmpNum = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
  const artistCmp = (a, b) => {
    const ka = artistKey(a.artistName), kb = artistKey(b.artistName);
    if (ka === kb) return 0;
    if (ka === UNKNOWN_ARTIST) return 1;
    if (kb === UNKNOWN_ARTIST) return -1;
    return COLLATOR.compare(ka, kb);
  };
  const srcRank = (s) => (SOURCES.includes(s.source) ? SOURCES.indexOf(s.source) : SOURCES.length);
  const kindRank = (s) => KINDS.findIndex((k) => k.id === s.kind);
  const reference = {
    title: (a, b) => COLLATOR.compare(a.name, b.name) || artistCmp(a, b) || cmpNum(num(a), num(b)),
    artist: (a, b) => artistCmp(a, b) || COLLATOR.compare(a.name, b.name),
    code: (a, b) => cmpNum(num(a), num(b)) || srcRank(a) - srcRank(b) || kindRank(a) - kindRank(b),
  };
  for (const mode of ["title", "artist", "code"]) {
    const out = sortSongs(songs, mode);
    isPermutation(out);
    // Sorted ⇔ every neighbouring pair is in order; a full tie keeps the input order (stable).
    for (let i = 1; i < N; i++) {
      const c = reference[mode](out[i - 1], out[i]);
      assert.ok(c < 0 || (c === 0 && pos.get(out[i - 1]) < pos.get(out[i])), `${mode} out of order at ${i}`);
    }
    assert.equal(sortSongs(songs, mode).every((s, i) => s === out[i]), true, `${mode} is deterministic`);
  }
  assert.equal(sortSongs(songs, "relevance"), songs);

  // Filters and facets.
  assert.deepEqual(presentFacets(songs), { sources: SOURCES, kinds: ["midi", "audio", "video"] });
  assert.equal(applyFilters(songs, { sources: new Set(), kinds: null }), songs);
  const filtered = applyFilters(songs, { sources: new Set(["SH", "TJMEDIA"]), kinds: new Set(["midi", "video"]) });
  assert.equal(filtered.length, songs.filter((s) => (s.source === "SH" || s.source === "TJMEDIA") && s.kind !== "audio").length);
  for (let i = 1; i < filtered.length; i++) assert.ok(pos.get(filtered[i - 1]) < pos.get(filtered[i]));

  // The artist index: one entry per key, counts add up, sorted by name, unknown last.
  const index = buildArtistIndex(songs);
  const keys = new Map();
  for (const s of songs) { const k = artistKey(s.artistName); keys.set(k, (keys.get(k) || 0) + 1); }
  assert.equal(index.length, keys.size);
  assert.equal(index.reduce((t, a) => t + a.count, 0), N);
  for (const a of index) assert.equal(keys.get(a.key), a.count);
  assert.deepEqual(index.at(-1), { key: UNKNOWN_ARTIST, name: UNKNOWN_ARTIST_LABEL, count: keys.get(UNKNOWN_ARTIST) });
  for (let i = 1; i < index.length - 1; i++) assert.ok(COLLATOR.compare(index[i - 1].name, index[i].name) <= 0, `index at ${i}`);

  // songsByArtist and filterArtists on the big index.
  const big = [...index].sort((a, b) => b.count - a.count).find((a) => a.key !== UNKNOWN_ARTIST);
  const theirs = songsByArtist(songs, big.key);
  assert.equal(theirs.length, big.count);
  for (let i = 1; i < theirs.length; i++) assert.ok(COLLATOR.compare(theirs[i - 1].name, theirs[i].name) <= 0);
  const firstWord = big.name.split(" ")[0];
  const found = filterArtists(index, firstWord);
  assert.ok(found.includes(big));
  assert.ok(found.length < index.length);
  assert.equal(filterArtists(index, ""), index);
});
