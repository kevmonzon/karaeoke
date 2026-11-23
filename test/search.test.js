/*
 * search.test.js — the fuzzy-search engine (M2): folding, the bounded edit distance, the word
 * index, close-match scoring, the tier helpers, the search worker's message protocol and the
 * client's Worker / main-thread paths.
 * Run with:  node --test    (or  npm test)
 *
 * node has no Worker, so the client tests drive a fake Worker class that runs the real worker
 * handler (createSearchWorker) behind an asynchronous, structured-cloned message boundary.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  MAX_CLOSE, fold, tokenize, maxDistance, boundedDistance, buildIndex, buildIndexSteps, titleLengths,
  matchWords, searchClose, orderNumberMatches, mergeTiers,
} from "../src/js/search-core.js";
import { createSearchWorker } from "../src/js/workers/search-worker.js";
import { createSearchClient } from "../src/js/search-client.js";
import { SOURCES } from "../src/js/catalog.js";

// A small library: [title, artist].
const LIB = [
  ["Barcelona", "Freddie Mercury"],          // 0
  ["Bohemian Rhapsody", "Queen"],            // 1
  ["Halo", "Beyoncé"],                       // 2
  ["Don't Stop Me Now", "Queen"],            // 3
  ["Barcelona Nights", "The Somebodies"],    // 4
  ["Something", "Halo Band"],                // 5
  ["Love Story", "Taylor Swift"],            // 6
];
const titlesOf = (lib) => lib.map(([t]) => t);
const artistsOf = (lib) => lib.map(([, a]) => a);
const libIndex = (lib = LIB) => buildIndex(titlesOf(lib), artistsOf(lib));
const ids = (hits) => hits.map((h) => h.i);
const wordOf = (index, m) => index.words[m.w];

// --- fold / tokenize / maxDistance -------------------------------------------
test("fold lower-cases and strips accents", () => {
  assert.equal(fold("Beyoncé"), "beyonce");
  assert.equal(fold("ÁRBOL Niño"), "arbol nino");
  assert.equal(fold(null), "");
});

test("fold turns punctuation into single spaces", () => {
  assert.equal(fold("Don't  Stop!"), "don t stop");
  assert.equal(fold("  (I Can’t) — Get… No!  "), "i can t get no");
  assert.equal(fold("AC/DC"), "ac dc");
});

test("tokenize drops empties", () => {
  assert.deepEqual(tokenize("  Don't -- Stop  "), ["don", "t", "stop"]);
  assert.deepEqual(tokenize("!!!"), []);
  assert.deepEqual(tokenize(""), []);
  assert.deepEqual(tokenize(undefined), []);
});

test("maxDistance by length", () => {
  assert.equal(maxDistance(3), 0);
  assert.equal(maxDistance(4), 1);
  assert.equal(maxDistance(7), 1);
  assert.equal(maxDistance(8), 2);
  assert.equal(maxDistance(20), 2);
});

// --- boundedDistance ----------------------------------------------------------
test("distance: identical is 0", () => {
  assert.equal(boundedDistance("barcelona", "barcelona", 2), 0);
  assert.equal(boundedDistance("", "", 0), 0);
});

test("distance: one substitution, insertion, deletion", () => {
  assert.equal(boundedDistance("halo", "hale", 1), 1);          // substitution
  assert.equal(boundedDistance("halo", "halos", 1), 1);         // insertion
  assert.equal(boundedDistance("barcelona", "barcelna", 2), 1); // deletion
});

test("distance: a neighbour swap is 1", () => {
  assert.equal(boundedDistance("teh", "the", 1), 1);
  assert.equal(boundedDistance("rhapsdoy", "rhapsody", 2), 1);
});

test("distance: gives up beyond the bound", () => {
  assert.equal(boundedDistance("kitten", "sitting", 1), 2);     // true distance 3 → max + 1
  assert.equal(boundedDistance("kitten", "sitting", 2), 3);
  assert.equal(boundedDistance("abc", "abcdefgh", 2), 3);       // length gap alone exceeds it
  assert.equal(boundedDistance("kitten", "sitting", 3), 3);     // within the bound: exact value
});

// A plain full-table optimal-string-alignment distance, to check the early exit against.
function fullOsa(a, b) {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...new Array(b.length).fill(0)]);
  for (let j = 0; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
    }
  }
  return d[a.length][b.length];
}

function rng(seed) {   // mulberry32
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test("distance: the early exit agrees with the full table on random pairs", () => {
  const rand = rng(7);
  const word = () => Array.from({ length: 1 + Math.floor(rand() * 9) }, () => "abcd"[Math.floor(rand() * 4)]).join("");
  for (let k = 0; k < 3000; k++) {
    const a = word(), b = word(), max = Math.floor(rand() * 4);
    const full = fullOsa(a, b);
    assert.equal(boundedDistance(a, b, max), full > max ? max + 1 : full, `${a} / ${b} / ${max}`);
  }
});

// --- the word index -----------------------------------------------------------
test("index: words are distinct and sorted", () => {
  const index = libIndex();
  assert.equal(index.count, LIB.length);
  assert.equal(new Set(index.words).size, index.words.length);
  assert.deepEqual(index.words, [...index.words].sort());
  assert.ok(index.words.includes("beyonce"));               // folded
  assert.ok(index.words.includes("don") && index.words.includes("t"));
  assert.equal(index.songs.length, index.words.length);
  assert.equal(index.inTitle.length, index.words.length);
});

test("index: postings are ascending and title flags line up", () => {
  const index = buildIndex(
    ["Halo", "Something", "Halo Halo", "Other"],
    ["Someone", "Halo Band", "Halo", "Nobody"],
  );
  const at = (word) => index.words.indexOf(word);
  const halo = at("halo");
  assert.ok(index.songs[halo] instanceof Uint32Array);
  assert.ok(index.inTitle[halo] instanceof Uint8Array);
  assert.deepEqual([...index.songs[halo]], [0, 1, 2]);         // once per song, ascending
  assert.deepEqual([...index.inTitle[halo]], [1, 0, 1]);       // song 1 has it only as artist
  for (let w = 0; w < index.words.length; w++) {
    const posts = index.songs[w];
    assert.equal(posts.length, index.inTitle[w].length);
    for (let k = 1; k < posts.length; k++) assert.ok(posts[k - 1] < posts[k], index.words[w]);
  }
  assert.deepEqual([...index.songs[at("nobody")]], [3]);
  assert.deepEqual([...index.inTitle[at("nobody")]], [0]);
});

test("buildIndexSteps yields progress and returns the same index", () => {
  const titles = titlesOf(LIB), artists = artistsOf(LIB);
  const it = buildIndexSteps(titles, artists, 3);
  const progress = [];
  let r;
  while (!(r = it.next()).done) progress.push(r.value);
  assert.deepEqual(progress, [3, 6, 7]);
  assert.deepEqual(r.value, buildIndex(titles, artists));
  const whole = buildIndexSteps(titles, artists);                // default chunk: one slice
  assert.deepEqual(whole.next(), { value: 7, done: false });
  assert.deepEqual(whole.next().value, buildIndex(titles, artists));
});

// --- matchWords ---------------------------------------------------------------
test("matchWords: exact beats prefix beats distance", () => {
  const index = buildIndex(["Barcelona", "Barcelonas", "Barcelone", "Barcalone", "Xarcelona"], []);
  const got = Object.fromEntries(matchWords(index, "barcelona").map((m) => [wordOf(index, m), [m.kind, m.weight]]));
  assert.deepEqual(got, {
    barcelona: ["exact", 3],
    barcelonas: ["prefix", 2],      // also 1 edit away: the better kind wins
    barcelone: ["d1", 1.5],
    xarcelona: ["d1", 1.2],         // first letter differs: ×0.8
    barcalone: ["d2", 1],
  });
});

test("matchWords: fuzzy needs the same first letter (under 5 characters; longer tokens at ×0.8)", () => {
  const index = buildIndex(["Barcelona", "Xarcelone", "Halo", "Groove"], []);
  const got = (token) => matchWords(index, token).map((m) => [wordOf(index, m), m.kind, m.weight]);
  assert.deepEqual(got("xalo"), []);                            // 4 letters: "halo" is out of reach
  assert.deepEqual(got("halo"), [["halo", "exact", 3]]);
  assert.deepEqual(got("xarcelona"), [["barcelona", "d1", 1.2], ["xarcelone", "d1", 1.5]]);
  assert.deepEqual(got("xarcelna"), [["barcelona", "d2", 0.8], ["xarcelone", "d2", 1]]);  // 8 letters: budget 2
  assert.deepEqual(got("rgoove"), [["groove", "d1", 1.2]]);     // the swap IS the one allowed edit
  assert.deepEqual(got("rgoovy"), []);                          // swap + another edit: over budget
  // …and the same-first-letter d1 ranks above the first-letter-changed d1.
  assert.deepEqual(ids(searchClose(index, "xarcelona")), [1, 0]);
});

test("matchWords: a 4–7 letter token never matches a word 2 edits away", () => {
  // boundedDistance answers max + 1 for "over budget"; with a budget of 1 that is 2, not a d2 match.
  const index = buildIndex(["Hole", "Hale", "Hello", "Grooves"], []);
  const got = (token) => matchWords(index, token).map((m) => [wordOf(index, m), m.kind, m.weight]);
  assert.deepEqual(got("halo"), [["hale", "d1", 1.5]]);         // hole and hello are 2 away
  assert.deepEqual(got("groovy"), []);                          // grooves is 2 away
  assert.deepEqual(got("groovs"), [["grooves", "d1", 1.5]]);
});

test("matchWords: short tokens match exactly only", () => {
  // A token under 4 characters gets no edit-distance matches; a prefix still counts (≥ 2 chars).
  const index = buildIndex(["abc", "abd", "abcd", "xbc", "ab", "bc"], []);
  const got = matchWords(index, "abc").map((m) => [wordOf(index, m), m.kind]);
  assert.deepEqual(got, [["abc", "exact"], ["abcd", "prefix"]]);
  const one = buildIndex(["a", "ab", "b"], []);
  assert.deepEqual(matchWords(one, "a").map((m) => [wordOf(one, m), m.kind]), [["a", "exact"]]); // 1 char: no prefix
});

// --- searchClose --------------------------------------------------------------
test("close: finds a title with one typo", () => {
  const index = libIndex();
  const hits = searchClose(index, "barcelna", { titleLen: titleLengths(titlesOf(LIB)) });
  assert.equal(hits[0].i, 0);                                   // "Barcelona" beats the longer title
  assert.ok(ids(hits).includes(4));
});

test("close: finds a swapped pair", () => {
  const hits = searchClose(libIndex(), "bohemian rhapsdoy");
  assert.deepEqual(ids(hits), [1]);
  assert.equal(hits[0].score, 3 * 1.5 + 1.5 * 1.5);             // exact + d1, both in the title
});

test("close: every token must match", () => {
  const index = libIndex();
  assert.deepEqual(searchClose(index, "barcelna zzqxv"), []);
  assert.deepEqual(ids(searchClose(index, "queen bohemain")), [1]); // artist + typo'd title word
});

test("close: title matches outrank artist matches", () => {
  const hits = searchClose(libIndex(), "halo");
  assert.deepEqual(ids(hits).slice(0, 2), [2, 5]);              // "Halo" (title) before "Halo Band" (artist)
  assert.ok(hits[0].score > hits[1].score);
});

test("close: respects exclude", () => {
  const index = libIndex();
  assert.deepEqual(ids(searchClose(index, "barcelna", { exclude: new Set([0]) })), [4]);
  assert.deepEqual(ids(searchClose(index, "barcelna", { exclude: [4] })), [0]);   // any iterable
});

test("close: respects limit and is stable for equal scores", () => {
  const lib = [["Other Tune", "X"], ...Array.from({ length: 6 }, (_, k) => ["Same Title Song", `Singer ${k}`])];
  const index = libIndex(lib);
  const titleLen = titleLengths(titlesOf(lib));
  const all = searchClose(index, "same titel", { titleLen });
  assert.deepEqual(ids(all), [1, 2, 3, 4, 5, 6]);               // equal scores → song order
  assert.deepEqual(ids(searchClose(index, "same titel", { titleLen, limit: 3 })), [1, 2, 3]);
  assert.equal(MAX_CLOSE, 200);
  const many = Array.from({ length: 250 }, () => ["Lonely", "Y"]);
  assert.equal(searchClose(libIndex(many), "lonley").length, MAX_CLOSE);   // default cap
});

test("close: a first-letter typo in a long word still finds the title", () => {
  const lib = [
    ["All I Want Is You Today", "South Border"],   // 0
    ["Bless the Broken Road", "Archie D"],          // 1
    ["Shake Your Groove Thing", "Peaches and Herb"], // 2
    ["There's a Reason", "Cascades"],               // 3
    ["Broken Arrow", "Somebody"],                   // 4
    ["Road Trip", "Nobody"],                        // 5
  ];
  const index = libIndex(lib);
  const titleLen = titleLengths(titlesOf(lib));
  const top = (q) => ids(searchClose(index, q, { titleLen }));
  assert.deepEqual(top("all i want is you otday"), [0]);         // swapped first pair
  assert.deepEqual(top("vroken road"), [1]);                     // replaced first letter
  assert.deepEqual(top("shake your rgoove thing"), [2]);
  assert.deepEqual(top("there s a eason"), [3]);                 // dropped first letter
  assert.deepEqual(top("xoad trip"), []);                        // a 4-letter token still may not
});

test("close: same-first-letter matches outrank first-letter-changed ones at equal distance", () => {
  const lib = [["Cover Girl", "A"], ["Lover Girl", "B"], ["Mower Girl", "C"]];
  const hits = searchClose(libIndex(lib), "mover girl", { titleLen: titleLengths(titlesOf(lib)) });
  assert.deepEqual(ids(hits), [2, 0, 1]);                       // mower (m…) first, then cover / lover
  assert.ok(Math.abs((hits[0].score - hits[1].score) - (1.5 - 1.2) * 1.5) < 1e-9);
});

test("close: no token of 4+ characters returns nothing", () => {
  const index = buildIndex(["abc de", "abc"], ["fgh", ""]);
  assert.deepEqual(searchClose(index, "abc de"), []);
  assert.deepEqual(searchClose(index, ""), []);
  assert.deepEqual(searchClose(index, "!!!"), []);
});

// --- tier helpers -------------------------------------------------------------
test("orderNumberMatches: SH, PLATKAR, TJMEDIA, MIDI, then unknown; MIDI before audio", () => {
  const song = (name, source, kind) => ({ name, source, kind });
  const input = [
    song("none", "", "midi"),
    song("midi-book", "MIDI", "midi"),
    song("tj-audio", "TJMEDIA", "audio"),
    song("odd", "ELSEWHERE", "midi"),
    song("tj-midi", "TJMEDIA", "midi"),
    song("plat", "PLATKAR", "midi"),
    song("sh-video", "SH", "video"),
    song("sh-midi", "SH", "midi"),
    song("tj-midi-2", "TJMEDIA", "midi"),
    song("tj-yt", "TJMEDIA", "youtube"),
  ];
  const out = orderNumberMatches(input, SOURCES).map((s) => s.name);
  assert.deepEqual(out, [
    "sh-midi", "sh-video", "plat", "tj-midi", "tj-midi-2", "tj-audio", "tj-yt", "midi-book", "none", "odd",
  ]);
  assert.equal(input[0].name, "none");                          // the input is not reordered
});

test("mergeTiers drops duplicates and keeps order", () => {
  const a = { id: "a" }, b = { id: "b" }, c = { id: "c" }, d = { id: "d" };
  assert.deepEqual(mergeTiers([a, b], [b, c, a], null, [d, c]), [a, b, c, d]);
  assert.deepEqual(mergeTiers(), []);
  assert.equal(mergeTiers([{ id: "a" }], [{ id: "a" }]).length, 2);   // identity, not id
});

// --- the worker's message protocol ----------------------------------------------
function workerHarness() {
  const replies = [];
  const handle = createSearchWorker((message, transfer) => replies.push({ message, transfer }));
  return { handle, replies };
}

test("worker: a query before ready answers with empty arrays", () => {
  const { handle, replies } = workerHarness();
  handle({ type: "query", seq: 4, q: "barcelna", limit: 200, exclude: new Uint32Array(0) });
  const { message, transfer } = replies[0];
  assert.equal(message.type, "result");
  assert.equal(message.seq, 4);
  assert.ok(message.hits instanceof Uint32Array && message.hits.length === 0);
  assert.ok(message.scores instanceof Float32Array && message.scores.length === 0);
  assert.deepEqual(transfer, [message.hits.buffer, message.scores.buffer]);
});

test("worker: builds, then answers with transferred typed arrays and the title-length tie-break", () => {
  const { handle, replies } = workerHarness();
  handle({ type: "build", titles: titlesOf(LIB), artists: artistsOf(LIB) });
  assert.equal(replies[0].message.type, "ready");
  assert.equal(replies[0].message.words, libIndex().words.length);
  assert.ok(replies[0].message.ms >= 0);
  handle({ type: "query", seq: 9, q: "barcelna", limit: 200, exclude: new Uint32Array([7]) });
  const { message, transfer } = replies[1];
  assert.deepEqual([...message.hits], [0, 4]);
  assert.ok(Math.abs(message.scores[0] - (2.25 - 0.002 * 9)) < 1e-5);
  assert.deepEqual(transfer, [message.hits.buffer, message.scores.buffer]);
  handle({ type: "query", seq: 10, q: "barcelna", limit: 200, exclude: new Uint32Array([0]) });
  assert.deepEqual([...replies[2].message.hits], [4]);
});

// --- the client -----------------------------------------------------------------
/** A Worker stand-in: the real worker handler behind an async, structured-cloned boundary. */
class FakeWorker {
  static made = [];
  constructor(url, options) {
    this.url = url; this.options = options; this.sent = []; this.terminated = false;
    this.onmessage = null; this.onerror = null; this.onmessageerror = null;
    this.handle = createSearchWorker((message, transfer) => {
      const data = structuredClone(message, { transfer });
      setImmediate(() => { if (!this.terminated) this.onmessage?.({ data }); });
    });
    FakeWorker.made.push(this);
  }
  postMessage(message, transfer = []) {
    const data = structuredClone(message, { transfer });
    this.sent.push(data);
    setImmediate(() => { if (!this.terminated) this.handle(data); });
  }
  terminate() { this.terminated = true; }
}

/** A Worker whose script never loads: it reports an `error` event and never answers. */
class BrokenWorker {
  static made = [];
  constructor(url, options) {
    this.options = options; this.terminated = false; this.prevented = false;
    BrokenWorker.made.push(this);
    setImmediate(() => this.onerror?.({ message: "blocked", preventDefault: () => { this.prevented = true; } }));
  }
  postMessage() {}
  terminate() { this.terminated = true; }
}

const immediate = (fn) => setImmediate(fn);

test("client: creates a module Worker and maps hits back to { i, score }", async () => {
  FakeWorker.made.length = 0;
  const client = createSearchClient({ WorkerImpl: FakeWorker, schedule: immediate });
  assert.equal(client.mode, "off");
  assert.equal(client.ready, false);
  assert.equal(await client.query("barcelna"), null);           // not built yet
  await client.build(titlesOf(LIB), artistsOf(LIB));
  assert.equal(client.mode, "worker");
  assert.equal(client.ready, true);
  const [w] = FakeWorker.made;
  assert.deepEqual(w.options, { type: "module" });
  assert.match(String(w.url), /workers\/search-worker\.js$/);
  const hits = await client.query("barcelna", { exclude: [4] });
  assert.deepEqual(hits.map((h) => h.i), [0]);
  assert.ok(Math.abs(hits[0].score - (2.25 - 0.002 * 9)) < 1e-5);
  const q = w.sent.find((m) => m.type === "query");
  assert.ok(q.exclude instanceof Uint32Array);
  client.dispose();
  assert.equal(client.mode, "off");
  assert.equal(w.terminated, true);
  assert.equal(await client.query("barcelna"), null);
});

test("client: a newer query makes the older one resolve null", async () => {
  const client = createSearchClient({ WorkerImpl: FakeWorker, schedule: immediate });
  await client.build(titlesOf(LIB), artistsOf(LIB));
  const older = client.query("barcelna");
  const newer = client.query("bohemian rhapsdoy");
  assert.equal(await older, null);
  assert.deepEqual((await newer).map((h) => h.i), [1]);
  // A rebuild also drops a query still in flight: its indices describe the old song list.
  const stale = client.query("halo");
  const rebuilt = client.build(["Halo"], ["Someone"]);
  assert.equal(client.ready, false);
  assert.equal(await stale, null);
  await rebuilt;
  assert.deepEqual((await client.query("halo")).map((h) => h.i), [0]);
  client.dispose();
});

test("client: falls back to the main thread when the Worker fails", async () => {
  BrokenWorker.made.length = 0;
  const client = createSearchClient({ WorkerImpl: BrokenWorker, schedule: immediate });
  const built = client.build(titlesOf(LIB), artistsOf(LIB));
  assert.equal(client.mode, "worker");                          // tried first
  await built;
  assert.equal(client.mode, "main");
  assert.equal(client.ready, true);
  const [w] = BrokenWorker.made;
  assert.equal(w.terminated, true);
  assert.equal(w.prevented, true);                              // the error is handled, not reported
  assert.deepEqual((await client.query("barcelna")).map((h) => h.i), [0, 4]);
  const older = client.query("halo");
  const newer = client.query("lvoe story");
  assert.equal(await older, null);
  assert.deepEqual((await newer).map((h) => h.i), [6]);
  await client.build(["Halo"], [""]);                           // later builds stay on the main thread
  assert.equal(BrokenWorker.made.length, 1);
  assert.equal(client.mode, "main");
  client.dispose();
});

test("client: without a Worker it builds on the main thread, one step per schedule() call", async () => {
  const queue = [];
  const client = createSearchClient({ WorkerImpl: undefined, schedule: (fn) => queue.push(fn) });
  const titles = Array.from({ length: 12000 }, (_, k) => `Song ${k} Title`);
  let done = false;
  client.build(titles, titles.map(() => "Artist")).then(() => { done = true; });
  assert.equal(client.mode, "main");
  let calls = 0;
  while (queue.length) { queue.shift()(); calls++; assert.equal(client.ready, calls === 4); }
  assert.equal(calls, 4);                                       // 5000 + 5000 + 2000 songs, then pack
  await Promise.resolve();
  assert.equal(done, true);
  const pending = client.query("titel");
  assert.equal(queue.length, 1);                                // a main-thread query is scheduled too
  queue.shift()();
  assert.equal((await pending).length, MAX_CLOSE);
  const throwing = createSearchClient({ WorkerImpl: function () { throw new Error("no workers"); }, schedule: immediate });
  await throwing.build(["Halo"], [""]);
  assert.equal(throwing.mode, "main");
});

// --- scale ----------------------------------------------------------------------
test("scale: 120,000 synthetic songs build in under 5 s and a query answers in under 200 ms", () => {
  const rand = rng(42);
  const letters = "abcdefghijklmnopqrstuvwxyz";
  const vocab = Array.from({ length: 25000 }, () =>
    Array.from({ length: 3 + Math.floor(rand() * 8) }, () => letters[Math.floor(rand() * 26)]).join(""));
  const phrase = (min, max) => Array.from({ length: min + Math.floor(rand() * (max - min + 1)) },
    () => vocab[Math.floor(rand() * vocab.length)]).join(" ");
  const titles = Array.from({ length: 120000 }, () => phrase(1, 5));
  const artists = Array.from({ length: 120000 }, () => phrase(1, 3));
  const target = 4242;
  titles[target] = "Wonderful Midnight Serenade";

  let t0 = performance.now();
  const index = buildIndex(titles, artists);
  const buildMs = performance.now() - t0;
  assert.ok(buildMs < 5000, `build took ${buildMs.toFixed(0)} ms`);
  assert.equal(index.count, 120000);

  t0 = performance.now();
  const hits = searchClose(index, "wonderfull midnigth serenade", { titleLen: titleLengths(titles) });
  const queryMs = performance.now() - t0;
  assert.ok(queryMs < 200, `query took ${queryMs.toFixed(1)} ms`);
  assert.equal(hits[0].i, target);
});
