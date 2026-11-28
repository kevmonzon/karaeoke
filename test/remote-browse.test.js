/*
 * remote-browse.test.js — the phone's Search sub-tabs, All · Artists (src/js/remote-browse.js,
 * Rae 2026-11-28): the artist list is the TV's own (library-browse.js), the index is cached per
 * catalogue array, one artist's songs come under the "← Artists" row, and the way back finds the
 * artist the guest came from.
 * Run with:  node --test
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  createArtistBrowse, searchTabOf, songCountLabel, isBackRow, artistRowIndex, BACK_KEY, SEARCH_TABS,
} from "../src/js/remote-browse.js";
import { buildArtistIndex, artistKey, UNKNOWN_ARTIST, UNKNOWN_ARTIST_LABEL } from "../src/js/library-browse.js";

const song = (i, name, artistName) => ({ i, id: `c:${i}`, code: String(100 + i), name, artistName, kind: "midi" });
const SONGS = [
  song(0, "Shotgun", "George Ezra"),
  song(1, "Barcelona", "George Ezra"),
  song(2, "Halo", "Beyoncé"),
  song(3, "Budapest", "george  ezra"),     // another spelling of the same artist
  song(4, "Lupang Hinirang", ""),          // a placeholder → (Unknown artist)
  song(5, "Ang Huling El Bimbo", "Eraserheads"),
  song(6, "Bahay Kubo", "Unknown"),
];

test("the artist list is exactly the TV's (library-browse.js buildArtistIndex)", () => {
  const b = createArtistBrowse();
  assert.deepEqual(b.artists(SONGS, ""), buildArtistIndex(SONGS));
  const names = b.artists(SONGS, "").map((a) => a.name);
  assert.deepEqual(names, ["Beyoncé", "Eraserheads", "George Ezra", UNKNOWN_ARTIST_LABEL], "A→Z, unknown last");
  const ezra = b.artists(SONGS, "").find((a) => a.name === "George Ezra");
  assert.equal(ezra.count, 3, "the two spellings are one artist");
});

test("the index is built once per catalogue array, and again for a new one", () => {
  const b = createArtistBrowse();
  assert.equal(b.ready(SONGS), false, "nothing is built before the first visit");
  const first = b.index(SONGS);
  assert.equal(b.ready(SONGS), true);
  assert.equal(b.ready([...SONGS]), false, "ready is per array, not per content");
  assert.equal(b.ready(null), false);
  assert.equal(b.index(SONGS), first, "same array → the cached index (never rebuilt per keystroke)");
  b.artists(SONGS, "ez");
  assert.equal(b.index(SONGS), first, "filtering reuses it");
  const more = [...SONGS, song(7, "Paradise", "Coldplay")];
  const second = b.index(more);
  assert.notEqual(second, first, "a new songbook array → a new index");
  assert.ok(second.some((a) => a.name === "Coldplay"));
  assert.equal(b.index([]).length, 0);
  assert.equal(b.index(null).length, 0, "no songbook → no artists, no throw");
});

test("the field filters artist names: every word, case and accents folded", () => {
  const b = createArtistBrowse();
  assert.deepEqual(b.artists(SONGS, "ezr").map((a) => a.name), ["George Ezra"]);
  assert.deepEqual(b.artists(SONGS, "EZRA george").map((a) => a.name), ["George Ezra"], "word order free");
  assert.deepEqual(b.artists(SONGS, "beyonce").map((a) => a.name), ["Beyoncé"], "accents folded");
  assert.deepEqual(b.artists(SONGS, "zzz"), []);
  assert.equal(b.artists(SONGS, "   ").length, 4, "blank = every artist");
});

test("one artist's songs: '← Artists' first, with the name and count, then the songs by title", () => {
  const b = createArtistBrowse();
  const key = artistKey("George Ezra");
  const { name, count, rows } = b.artistSongs(SONGS, key);
  assert.equal(name, "George Ezra");
  assert.equal(count, 3);
  assert.equal(rows.length, 4);
  assert.ok(isBackRow(rows[0]), "the back row heads the list");
  assert.deepEqual(rows[0], { key: BACK_KEY, name: "George Ezra", count: 3 });
  assert.deepEqual(rows.slice(1).map((s) => s.name), ["Barcelona", "Budapest", "Shotgun"]);
  assert.ok(rows.slice(1).every((s) => !isBackRow(s)), "the songs are the catalogue's own records");
  assert.equal(rows[1], SONGS[1], "the same objects — the sheet names them to the host by ref");
});

test("the unknown bucket and an artist the songbook no longer has", () => {
  const b = createArtistBrowse();
  const unk = b.artistSongs(SONGS, UNKNOWN_ARTIST);
  assert.equal(unk.name, UNKNOWN_ARTIST_LABEL);
  assert.deepEqual(unk.rows.slice(1).map((s) => s.name), ["Bahay Kubo", "Lupang Hinirang"]);
  const gone = b.artistSongs(SONGS, "nobody at all");
  assert.equal(gone.name, "");
  assert.equal(gone.count, 0);
  assert.deepEqual(gone.rows, [{ key: BACK_KEY, name: "", count: 0 }], "just the way back");
});

test("BACK_KEY can never be a real artist's key", () => {
  assert.notEqual(BACK_KEY, UNKNOWN_ARTIST);
  assert.notEqual(artistKey(BACK_KEY), BACK_KEY, "a name spelled like the key folds to something else");
  for (const a of buildArtistIndex(SONGS)) assert.notEqual(a.key, BACK_KEY);
  assert.equal(isBackRow(null), false);
  assert.equal(isBackRow(SONGS[0]), false);
});

test("artistRowIndex finds the artist the back row returns to", () => {
  const b = createArtistBrowse();
  const list = b.artists(SONGS, "");
  assert.equal(artistRowIndex(list, artistKey("George Ezra")), 2);
  assert.equal(artistRowIndex(list, UNKNOWN_ARTIST), 3);
  assert.equal(artistRowIndex(b.artists(SONGS, "era"), artistKey("George Ezra")), -1, "filtered out");
  assert.equal(artistRowIndex(list, null), -1);
  assert.equal(artistRowIndex(null, "x"), -1);
});

test("the sub-tab names and the count wording", () => {
  assert.deepEqual([...SEARCH_TABS], ["all", "artists"]);
  assert.equal(searchTabOf("artists"), "artists");
  assert.equal(searchTabOf("all"), "all");
  for (const junk of ["rankings", "", null, undefined, "__proto__", 1]) assert.equal(searchTabOf(junk), "all");
  assert.equal(songCountLabel(1), "1 song");
  assert.equal(songCountLabel(0), "0 songs");
  assert.equal(songCountLabel(12345), `${(12345).toLocaleString()} songs`);
  assert.equal(songCountLabel(-3), "0 songs");
  assert.equal(songCountLabel(undefined), "0 songs");
});

test("the phone page wires All · Artists (structure only: remote.js boots a DOM on import)", () => {
  const read = (p) => readFileSync(new URL(p, import.meta.url), "utf8");
  const html = read("../src/remote.html");
  const js = read("../src/js/remote.js");
  const mod = read("../src/js/remote-browse.js");
  assert.match(html, /id="r-stabs"[^>]*role="tablist"/);
  assert.match(html, /id="r-stab-all"[^>]*role="tab"[^>]*aria-selected="true"[^>]*data-stab="all">All</);
  assert.match(html, /id="r-stab-artists"[^>]*role="tab"[^>]*aria-selected="false"[^>]*data-stab="artists">Artists</);
  assert.match(js, /from "\.\/remote-browse\.js"/);
  assert.match(js, /if \(searchTab === "artists"\) \{ showArtists\(q\); return; \}/, "Artists filters names, no song search");
  assert.match(js, /\$\("r-yt"\)\.hidden = t === "artists"/, "no YouTube on Artists");
  // The TV's grouping, imported — never a second copy that could drift from the TV's Artists tab.
  assert.match(mod, /from "\.\/library-browse\.js"/);
  assert.doesNotMatch(mod, /library-ui|library-view|document\.|window\./, "pure: no host list UI, no DOM");
});
