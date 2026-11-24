/*
 * browse.test.js — the library-browse helpers (M6): artist keys, the artist index, one artist's
 * songs by title, the typed artist filter, and a 121k-song scale run. (The songbook / kind filters,
 * their facets and the library-wide sort were removed with the Songs panel's chips, 2026-11-24.)
 * Run with:  node --test    (or  npm test)
 *
 * The scale test checks the SHAPE of every result (counts, every neighbouring pair in order under
 * a reference comparator, ties in input order) — never a wall-clock threshold.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import * as browse from "../src/js/library-browse.js";
import {
  UNKNOWN_ARTIST, UNKNOWN_ARTIST_LABEL,
  artistKey, buildArtistIndex, songsByArtist, filterArtists,
} from "../src/js/library-browse.js";
import { SOURCES } from "../src/js/catalog.js";

let nextId = 0;
/** A catalogue-shaped record. */
function song(name, artistName = "", { code = nextId, source = "MIDI", kind = "midi" } = {}) {
  nextId++;
  return { code, name, artistName, langName: "", type: "MIDI", source, kind, id: `${kind}:${code}:${nextId}` };
}
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

// --- exports -----------------------------------------------------------------------
test("the artist helpers are all that is left: no filters, facets or sorts", () => {
  assert.equal(UNKNOWN_ARTIST_LABEL, "(Unknown artist)");
  for (const gone of ["KINDS", "SORTS", "presentFacets", "applyFilters", "sortSongs"]) {
    assert.equal(gone in browse, false, `${gone} was removed with the Songs panel's chips and sort`);
  }
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
  assert.deepEqual(songsByArtist(null, "abba"), []);
});

test("songsByArtist orders titles with the collator, then by number, then as given", () => {
  const input = [
    song("zebra", "Band"), song("Éclair", "Band"), song("apple", "Band"), song("Banana", "Band"), song("eagle", "Band"),
    song("Echo", "Band"), song("Song 10", "Band"), song("Song 2", "Band"),
  ];
  const before = input.slice();
  const out = songsByArtist(input, "band");
  assert.deepEqual(names(out), ["apple", "Banana", "eagle", "Echo", "Éclair", "Song 2", "Song 10", "zebra"]);
  assert.notEqual(out, input);
  assert.deepEqual(input, before, "a copy; the input is not reordered");

  // Titles the collator calls equal (case, accents) are ordered by number; numberless last; a full tie keeps input order.
  const a = song("Halo", "Band", { code: 30 }), b = song("HALO", "Band", { code: 5 }), c = song("halo", "Band", { code: "" });
  const d = song("Haló", "Band", { code: "30", kind: "audio" }), e = song("Halo", "Band", { code: 30, kind: "video" });
  assert.deepEqual(songsByArtist([c, d, a, e, b], "band"), [b, d, a, e, c]);
  assert.deepEqual(songsByArtist([e, a, c, b, d], "band"), [b, e, a, d, c]);
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
test("scale: 121,000 songs index into the right shape, and one artist's songs come out by title", () => {
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
  const num = (s) => (s.code === "" ? Infinity : s.code);

  // The artist index: one entry per key, counts add up, sorted by name, unknown last.
  const index = buildArtistIndex(songs);
  const keys = new Map();
  for (const s of songs) { const k = artistKey(s.artistName); keys.set(k, (keys.get(k) || 0) + 1); }
  assert.equal(index.length, keys.size);
  assert.equal(index.reduce((t, a) => t + a.count, 0), N);
  for (const a of index) assert.equal(keys.get(a.key), a.count);
  assert.deepEqual(index.at(-1), { key: UNKNOWN_ARTIST, name: UNKNOWN_ARTIST_LABEL, count: keys.get(UNKNOWN_ARTIST) });
  for (let i = 1; i < index.length - 1; i++) assert.ok(COLLATOR.compare(index[i - 1].name, index[i].name) <= 0, `index at ${i}`);

  // songsByArtist (the biggest real artist, and the unknown bucket — ~8% of the library) and
  // filterArtists on the big index. Sorted ⇔ every neighbouring pair is in order (title, then
  // number); a full tie keeps the input order.
  const big = [...index].sort((a, b) => b.count - a.count).find((a) => a.key !== UNKNOWN_ARTIST);
  for (const key of [big.key, UNKNOWN_ARTIST]) {
    const theirs = songsByArtist(songs, key);
    assert.equal(theirs.length, keys.get(key));
    for (let i = 1; i < theirs.length; i++) {
      const [x, y] = [theirs[i - 1], theirs[i]];
      const c = COLLATOR.compare(x.name, y.name) || (num(x) < num(y) ? -1 : num(x) > num(y) ? 1 : 0);
      assert.ok(c < 0 || (c === 0 && pos.get(x) < pos.get(y)), `${JSON.stringify(key)} out of order at ${i}`);
    }
  }
  const firstWord = big.name.split(" ")[0];
  const found = filterArtists(index, firstWord);
  assert.ok(found.includes(big));
  assert.ok(found.length < index.length);
  assert.equal(filterArtists(index, ""), index);
});
