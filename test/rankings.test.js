/*
 * rankings.test.js — the leaderboard store (M6 lane B, plan §5.9): the pure drop / order rules,
 * the entry normalisation, and createRankings' storage handling (a fake Storage, as unit.test.js
 * does for recap / store).
 * Run with:  node --test test/rankings.test.js
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  RANKINGS_KEY, RANKINGS_MAX, DIFFICULTIES,
  addRanking, topRankings, rankingPlayers, createRankings,
} from "../src/js/rankings.js";
import { APP_PREFIX, listAppKeys, collectAppData, restoreAppData, clearAppData } from "../src/js/store.js";

/** A Map-backed Storage that counts its calls. */
function fakeStorage(initial = {}) {
  const m = new Map(Object.entries(initial));
  const calls = { getItem: 0, setItem: 0, removeItem: 0 };
  return {
    get length() { return m.size; },
    key: (i) => [...m.keys()][i] ?? null,
    getItem: (k) => { calls.getItem++; return m.has(k) ? m.get(k) : null; },
    setItem: (k, v) => { calls.setItem++; m.set(k, String(v)); },
    removeItem: (k) => { calls.removeItem++; m.delete(k); },
    calls,
    _map: m,
  };
}

const throwingStorage = () => ({
  get length() { throw new Error("denied"); },
  key() { throw new Error("denied"); },
  getItem() { throw new Error("denied"); },
  setItem() { throw new Error("denied"); },
  removeItem() { throw new Error("denied"); },
});

/** A full, valid entry; override any field. */
const e = (over = {}) => ({
  player: "Rae", songId: "midi:1", song: "Tahan", artist: "Bryan Chong",
  score: 80, difficulty: "normal", at: 1000, ...over,
});

const stored = (s) => JSON.parse(s._map.get(RANKINGS_KEY));

// --- the pure rules -------------------------------------------------------------------------

test("addRanking: add appends to a copy, in canonical form", () => {
  const one = addRanking([], e());
  assert.deepEqual(one, [e()]);
  const two = addRanking(one, e({ songId: "midi:2", song: "Ikaw", score: 91, at: 2000 }));
  assert.equal(two.length, 2);
  assert.equal(two[1].song, "Ikaw", "appended at the end, not sorted in");
  assert.notEqual(two, one);
  assert.equal(one.length, 1);
  assert.deepEqual(Object.keys(two[0]).sort(),
    ["artist", "at", "difficulty", "player", "score", "song", "songId"]);
  assert.deepEqual(addRanking(null, e()), [e()], "a non-array list reads as empty");
});

test("addRanking: overflow drops the lowest score", () => {
  const full = [e({ score: 70, at: 1 }), e({ score: 40, at: 2 }), e({ score: 90, at: 3 })];
  const next = addRanking(full, e({ score: 60, at: 4 }), 3);
  assert.deepEqual(next.map((r) => r.score), [70, 90, 60], "the 40 is gone, the order kept");
  // a new score below everything in a full list is the one that does not stay
  assert.deepEqual(addRanking(full, e({ score: 10, at: 5 }), 3).map((r) => r.score), [70, 40, 90]);
  // a list already over the cap is trimmed until it fits
  const over = addRanking([e({ score: 5 }), e({ score: 50 }), e({ score: 7 }), e({ score: 99 })], e({ score: 60 }), 2);
  assert.deepEqual(over.map((r) => r.score), [99, 60]);
  assert.deepEqual(addRanking(full, e(), 0), [], "max 0 keeps nothing");
});

test("addRanking: ties drop the oldest", () => {
  const list = [e({ score: 50, at: 300, song: "mid" }), e({ score: 50, at: 100, song: "old" }), e({ score: 80, at: 50, song: "hi" })];
  const next = addRanking(list, e({ score: 50, at: 400, song: "new" }), 3);
  assert.deepEqual(next.map((r) => r.song), ["mid", "hi", "new"], "the at-100 row of the 50s goes");
  // equal score AND equal time: the earlier-appended row is the older
  const same = addRanking([e({ score: 50, at: 7, song: "first" }), e({ score: 50, at: 7, song: "second" })],
    e({ score: 50, at: 7, song: "third" }), 2);
  assert.deepEqual(same.map((r) => r.song), ["second", "third"]);
});

test("addRanking: RANKINGS_MAX is the default cap", () => {
  assert.equal(RANKINGS_MAX, 1000);
  let list = [];
  for (let i = 0; i < RANKINGS_MAX; i++) list.push(e({ score: 50 + (i % 50), at: i }));
  const next = addRanking(list, e({ score: 100, at: 5000 }));
  assert.equal(next.length, RANKINGS_MAX);
  assert.equal(next.at(-1).score, 100);
  assert.equal(next.filter((r) => r.score === 50).length, 19, "one of the twenty 50s (the oldest) went");
  assert.ok(!next.some((r) => r.score === 50 && r.at === 0));
});

test("addRanking: does not mutate its input (list or entry)", () => {
  const entry = Object.freeze(e({ player: "  Mia  ", score: 77.6, difficulty: "weird" }));
  const list = Object.freeze([Object.freeze(e({ score: 10 })), Object.freeze(e({ score: 20 }))]);
  const snapshot = JSON.stringify([list, entry]);
  const next = addRanking(list, entry, 2);              // frozen: a write would throw in a module
  assert.equal(JSON.stringify([list, entry]), snapshot);
  assert.deepEqual(next.map((r) => r.score), [20, 78]);
  assert.equal(next[1].player, "Mia");
  assert.notEqual(next[0], list[1], "rows are new objects, not the caller's");
});

test("topRankings: sorts by score, then most recent first", () => {
  const list = [
    e({ song: "a", score: 70, at: 10 }),
    e({ song: "b", score: 95, at: 5 }),
    e({ song: "c", score: 70, at: 30 }),
    e({ song: "d", score: 88, at: 1 }),
    e({ song: "e", score: 70, at: 20 }),
  ];
  assert.deepEqual(topRankings(list).map((r) => r.song), ["b", "d", "c", "e", "a"]);
  assert.deepEqual(topRankings(list, { limit: 2 }).map((r) => r.song), ["b", "d"]);
  assert.deepEqual(list.map((r) => r.song), ["a", "b", "c", "d", "e"], "the input is not sorted in place");
  // equal score and time: the later-appended row counts as newer
  assert.deepEqual(topRankings([e({ song: "x", at: 1 }), e({ song: "y", at: 1 })]).map((r) => r.song), ["y", "x"]);
});

test("topRankings: the default limit is 50, and a bad limit means the default", () => {
  const list = Array.from({ length: 80 }, (_, i) => e({ score: i, at: i }));
  assert.equal(topRankings(list).length, 50);
  assert.equal(topRankings(list, { limit: null }).length, 50);
  assert.equal(topRankings(list, { limit: "lots" }).length, 50);
  assert.equal(topRankings(list, { limit: 0 }).length, 0);
  assert.equal(topRankings(list, { limit: Infinity }).length, 80);
  assert.equal(topRankings(list)[0].score, 79);
});

test("topRankings: filters by player (exact, after trim) and by difficulty", () => {
  const list = [
    e({ player: "Rae", difficulty: "normal", score: 60, song: "r-n" }),
    e({ player: "Mia", difficulty: "hard", score: 90, song: "m-h" }),
    e({ player: "Rae", difficulty: "hard", score: 70, song: "r-h" }),
    e({ player: "rae", difficulty: "hard", score: 99, song: "lower-rae" }),
    e({ player: "Mia", difficulty: "easy", score: 50, song: "m-e" }),
  ];
  assert.deepEqual(topRankings(list, { player: "  Rae " }).map((r) => r.song), ["r-h", "r-n"], "case-sensitive");
  assert.deepEqual(topRankings(list, { difficulty: "hard" }).map((r) => r.song), ["lower-rae", "m-h", "r-h"]);
  assert.deepEqual(topRankings(list, { player: "Rae", difficulty: "hard" }).map((r) => r.song), ["r-h"]);
  assert.deepEqual(topRankings(list, { player: "", difficulty: "" }).length, 5, '"" means no filter');
  assert.deepEqual(topRankings(list, { player: "Nobody" }), []);
  assert.deepEqual(topRankings(list, { difficulty: "extreme" }), []);
});

test("rankingPlayers: distinct, ordered by best score (ties: most recent first)", () => {
  const list = [
    e({ player: "Rae", score: 80, at: 1 }),
    e({ player: "Mia", score: 95, at: 2 }),
    e({ player: "Rae", score: 60, at: 9 }),
    e({ player: "Jo", score: 80, at: 5 }),        // ties Rae's best, set more recently
    e({ player: "", score: 40, at: 3 }),          // → "Host"
    e({ player: "Mia", score: 10, at: 99 }),
  ];
  assert.deepEqual(rankingPlayers(list), ["Mia", "Jo", "Rae", "Host"]);
  assert.deepEqual(rankingPlayers([]), []);
  assert.deepEqual(rankingPlayers("nope"), []);
});

test("a bad score is ignored (NaN, Infinity, a non-numeric string, blank, null, missing)", () => {
  const bad = [NaN, Infinity, -Infinity, "abc", "", "   ", null, undefined, true, {}, []];
  for (const score of bad) {
    assert.deepEqual(addRanking([], e({ score })), [], `addRanking: ${String(score)}`);
  }
  const { score: _drop, ...noScore } = e();
  assert.deepEqual(addRanking([], noScore), [], "addRanking: missing");
  assert.deepEqual(addRanking([], null), []);

  const s = fakeStorage();
  const r = createRankings({ storage: s, now: () => 1 });
  for (const score of bad) assert.equal(r.add(e({ score })), false, `add: ${String(score)}`);
  assert.equal(r.add(noScore), false);
  assert.equal(r.add(null), false);
  assert.equal(r.add("Rae 90"), false);
  assert.deepEqual(r.all(), []);
  assert.equal(s.calls.setItem, 0, "nothing stored");
  // the pure readers skip a bad row instead of sorting NaN into the board
  assert.deepEqual(topRankings([e({ score: NaN }), e({ score: 5 }), null, 7]).map((x) => x.score), [5]);
});

test("score is clamped to 0–100 and rounded; a numeric string is accepted", () => {
  const r = createRankings({ storage: fakeStorage(), now: () => 1 });
  assert.equal(r.add(e({ score: 84.5 })), true);
  r.add(e({ score: 150 }));
  r.add(e({ score: -3 }));
  r.add(e({ score: " 72 " }));
  assert.deepEqual(r.all().map((x) => x.score), [85, 100, 0, 72]);
});

test("player normalisation: trim, a 24-character cap, \"\" → \"Host\"", () => {
  const r = createRankings({ storage: fakeStorage(), now: () => 1 });
  r.add(e({ player: "   Rae  " }));
  r.add(e({ player: "" }));
  r.add(e({ player: "    " }));
  r.add(e({ player: undefined }));
  r.add(e({ player: "abcdefghijklmnopqrstuvwxyz0123" }));
  r.add(e({ player: `${"x".repeat(23)} yz` }));              // the cap lands on a space → trimmed
  r.add(e({ player: `${"é".repeat(23)}🎤🎤` }));               // code points, never half an emoji
  r.add(e({ player: 42 }));
  const players = r.all().map((x) => x.player);
  assert.deepEqual(players.slice(0, 6), [
    "Rae", "Host", "Host", "Host", "abcdefghijklmnopqrstuvwx", "x".repeat(23),
  ]);
  assert.equal(players[6], `${"é".repeat(23)}🎤`);
  assert.equal(Array.from(players[6]).length, 24);
  assert.equal(players[7], "42");
});

test("difficulty normalisation: easy | normal | hard, anything else → normal", () => {
  assert.deepEqual(DIFFICULTIES, ["easy", "normal", "hard"]);
  assert.ok(Object.isFrozen(DIFFICULTIES));
  const got = ["easy", "normal", "hard", "HARD", "expert", "", undefined, 3]
    .map((difficulty) => addRanking([], e({ difficulty }))[0].difficulty);
  assert.deepEqual(got, ["easy", "normal", "hard", "normal", "normal", "normal", "normal", "normal"]);
});

test("song, artist and songId: display strings, song/artist capped at 200", () => {
  const [row] = addRanking([], e({ song: "s".repeat(250), artist: null, songId: 17 }));
  assert.equal(row.song.length, 200);
  assert.equal(row.artist, "");
  assert.equal(row.songId, "17");
  const [obj] = addRanking([], e({ song: { evil: true } }));
  assert.equal(obj.song, "", "an object is not stringified into [object Object]");
});

// --- createRankings -------------------------------------------------------------------------

test("createRankings: at comes from the entry, else from the injected clock", () => {
  let t = 5000;
  const r = createRankings({ storage: fakeStorage(), now: () => t });
  r.add(e({ at: 1234 }));
  r.add(e({ at: undefined }));
  t = 6000;
  r.add(e({ at: NaN }));
  r.add(e({ at: "1999" }));                                 // not a number → the clock
  assert.deepEqual(r.all().map((x) => x.at), [1234, 5000, 6000, 6000]);
  const fallback = createRankings({ storage: fakeStorage(), now: () => NaN });
  fallback.add(e({ at: undefined }));
  assert.ok(Number.isFinite(fallback.all()[0].at), "a broken clock still stores a finite time");
});

test("createRankings: reads storage once (lazily) and writes on every change", () => {
  const s = fakeStorage({ [RANKINGS_KEY]: JSON.stringify([e({ score: 50 })]) });
  const r = createRankings({ storage: s, now: () => 1 });
  assert.equal(s.calls.getItem, 0, "nothing is read at construction");
  assert.equal(r.top().length, 1);
  r.players(); r.difficulties(); r.all(); r.top({ player: "Rae" });
  assert.equal(s.calls.getItem, 1, "read once");
  assert.equal(s.calls.setItem, 0, "reads never write");

  assert.equal(r.add(e({ score: 90 })), true);
  assert.equal(s.calls.setItem, 1);
  r.add(e({ score: 91 }));
  assert.equal(s.calls.setItem, 2);
  r.add(e({ score: "nope" }));
  assert.equal(s.calls.setItem, 2, "an ignored entry writes nothing");
  assert.deepEqual(stored(s).map((x) => x.score), [50, 90, 91], "what is stored is the list");
  r.clear();
  assert.equal(s.calls.setItem, 3);
  assert.equal(s.calls.getItem, 1, "still read only once");
});

test("createRankings: a stored list survives a reload", () => {
  const s = fakeStorage();
  const a = createRankings({ storage: s, now: () => 1 });
  a.add(e({ player: "Mia", score: 88, difficulty: "hard" }));
  a.add(e({ player: "Rae", score: 70 }));
  const b = createRankings({ storage: s });
  assert.deepEqual(b.top().map((x) => [x.player, x.score]), [["Mia", 88], ["Rae", 70]]);
  assert.deepEqual(b.players(), ["Mia", "Rae"]);
  assert.deepEqual(b.difficulties(), ["normal", "hard"], "present ones, in DIFFICULTIES order");
});

test("corrupt storage reads as empty", () => {
  const cases = ["{not json", "null", '"a string"', "42", '{"score":90}', "[]"];
  for (const raw of cases) {
    const s = fakeStorage({ [RANKINGS_KEY]: raw });
    const r = createRankings({ storage: s, now: () => 1 });
    assert.deepEqual(r.all(), [], raw);
    assert.deepEqual(r.top(), []);
    assert.deepEqual(r.players(), []);
    assert.deepEqual(r.difficulties(), []);
    assert.equal(r.add(e()), true, "and it is still usable");
    assert.equal(stored(s).length, 1);
  }
  // an array with junk rows keeps only the rows that make sense (a hand-edited backup)
  const junk = fakeStorage({ [RANKINGS_KEY]: JSON.stringify([5, null, { score: "x" }, e({ score: 66 }), { score: 12 }]) });
  const r = createRankings({ storage: junk });
  assert.deepEqual(r.all().map((x) => [x.player, x.score, x.difficulty, x.at]), [["Rae", 66, "normal", 1000], ["Host", 12, "normal", 0]]);
});

test("a throwing storage never throws out of add / top / clear", () => {
  const r = createRankings({ storage: throwingStorage(), now: () => 1 });
  assert.doesNotThrow(() => {
    assert.deepEqual(r.top(), []);
    assert.equal(r.add(e({ score: 77 })), true);
    assert.deepEqual(r.top().map((x) => x.score), [77], "kept in memory for this session");
    assert.deepEqual(r.players(), ["Rae"]);
    assert.deepEqual(r.difficulties(), ["normal"]);
    r.clear();
    assert.deepEqual(r.all(), []);
  });
  const broken = createRankings({ storage: fakeStorage(), now: () => { throw new Error("clock"); } });
  assert.doesNotThrow(() => broken.add(e({ at: undefined })));
  assert.equal(broken.all().length, 1);
  assert.doesNotThrow(() => createRankings({ storage: fakeStorage() }).top(null), "top(null) reads as top()");
});

test("clear empties and persists", () => {
  const s = fakeStorage();
  const r = createRankings({ storage: s, now: () => 1 });
  r.add(e()); r.add(e({ player: "Mia" }));
  r.clear();
  assert.deepEqual(r.all(), []);
  assert.deepEqual(r.top(), []);
  assert.deepEqual(r.players(), []);
  assert.deepEqual(stored(s), [], "the empty list is written");
  assert.deepEqual(createRankings({ storage: s }).all(), [], "a reload stays empty");
  r.add(e({ score: 33 }));
  assert.deepEqual(stored(s).map((x) => x.score), [33], "and it keeps working after a clear");
});

test("all() and top() hand out copies, never the stored rows", () => {
  const r = createRankings({ storage: fakeStorage(), now: () => 1 });
  r.add(e({ score: 60 }));
  r.all()[0].score = 0;
  r.all().push(e({ score: 99 }));
  r.top()[0].player = "Hacker";
  assert.deepEqual(r.all().map((x) => [x.player, x.score]), [["Rae", 60]]);
});

test("the key has the app prefix, so Backup / Restore / Erase-all cover it", () => {
  assert.ok(RANKINGS_KEY.startsWith(APP_PREFIX));
  assert.equal(RANKINGS_KEY, "karaeoke.rankings.v1");
  const s = fakeStorage({ "someone.else": "x" });
  createRankings({ storage: s, now: () => 1 }).add(e({ score: 64 }));
  assert.ok(listAppKeys(s).includes(RANKINGS_KEY));
  const backup = collectAppData(s);
  assert.ok(RANKINGS_KEY in backup.data);
  assert.ok(!("someone.else" in backup.data));

  const fresh = fakeStorage();
  restoreAppData(backup, fresh);
  assert.deepEqual(createRankings({ storage: fresh }).top().map((x) => x.score), [64], "a restore brings it back");
  clearAppData(fresh);
  assert.deepEqual(createRankings({ storage: fresh }).all(), [], "Erase-all removes it");
});
