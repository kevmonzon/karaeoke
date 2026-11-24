/*
 * play-counts.test.js — when a song counts as played (src/js/play-counts.js).
 *
 *   1. The rule: once per song start, after 30 s of actual playback or at a natural end,
 *      whichever comes first. Paused time, the title-card hold and a seek forward add nothing;
 *      a skip before 30 s counts nothing; a Restart (no start() call) cannot count twice.
 *   2. The clock: a step is capped (a laptop that slept mid-song), rAF + the 1 s watchdog
 *      ticking the same counter do not double the time, a bad clock value is ignored.
 *   3. The reporter: failures are swallowed with ONE warning; the default POSTs /api/played.
 * Run with:  node --test
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  createPlayCounter, reportPlayed, PLAY_THRESHOLD_SEC, MAX_STEP_SEC,
} from "../src/js/play-counts.js";

const SONG = { id: "midi:123", name: "Song" };
const OTHER = { id: "youtube:dQw4w9WgXcQ", name: "Other" };

/** A counter whose reports land in `calls`; warnings in `warns`. */
function rig(opts = {}) {
  const calls = [];
  const warns = [];
  const counter = createPlayCounter({
    report: (id) => { calls.push(id); },
    warn: (...args) => { warns.push(args); },
    ...opts,
  });
  return { counter, calls, warns };
}

/** Tick from `from` to `to` seconds at `fps` (integer-stepped, so there is no drift). */
function run(counter, from, to, playing = true, fps = 60) {
  const n = Math.round((to - from) * fps);
  for (let k = 0; k <= n; k++) counter.tick(playing, from + k / fps);
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

// --- 1. the rule ---------------------------------------------------------------------------
test("play counts: 30 s of playback counts the song once", () => {
  const { counter, calls } = rig();
  assert.equal(PLAY_THRESHOLD_SEC, 30);
  counter.start(SONG);
  run(counter, 0, 29.9);
  assert.deepEqual(calls, [], "not yet at 29.9 s");
  run(counter, 29.9 + 1 / 60, 30.05);
  assert.deepEqual(calls, ["midi:123"], "counted the moment 30 s is reached");
  run(counter, 30.05, 240);
  counter.ended();
  assert.deepEqual(calls, ["midi:123"], "the rest of the song and its natural end add nothing");
});

test("play counts: paused time does not count", () => {
  const { counter, calls } = rig();
  counter.start(SONG);
  run(counter, 0, 20);
  run(counter, 20, 80, false);                 // a minute on pause
  assert.deepEqual(calls, []);
  run(counter, 80, 89.8);
  assert.deepEqual(calls, [], "20 s + 9.8 s is still under 30 s");
  run(counter, 89.8, 90.2);
  assert.deepEqual(calls, ["midi:123"]);
});

test("play counts: the title-card hold does not count", () => {
  const { counter, calls } = rig();
  counter.start(SONG);
  run(counter, 0, 5, false);                   // the MIDI engine is paused behind the card
  run(counter, 5, 34.9);
  assert.deepEqual(calls, []);
  run(counter, 34.9, 35.1);
  assert.deepEqual(calls, ["midi:123"]);
});

test("play counts: a seek forward adds nothing — only the clock between ticks counts", () => {
  const { counter, calls } = rig();
  counter.start(SONG);
  run(counter, 0, 10);
  // The singer drags the seek bar from 0:10 to 3:30. The media clock is never read, so the
  // jump is invisible: 25 s of listening is 25 s.
  run(counter, 10, 25);
  assert.deepEqual(calls, []);
});

test("play counts: a skip or stop before 30 s counts nothing", () => {
  const { counter, calls } = rig();
  counter.start(SONG);
  run(counter, 0, 29.5);
  counter.stop();
  run(counter, 29.5, 120);
  counter.ended();
  assert.deepEqual(calls, [], "nothing counts after stop()");
});

test("play counts: the next song starting before 30 s abandons the first", () => {
  const { counter, calls } = rig();
  counter.start(SONG);
  run(counter, 0, 25);
  counter.start(OTHER);                        // ⏭ straight into the next song
  run(counter, 25, 50);
  assert.deepEqual(calls, [], "the first song's 25 s do not carry over");
  run(counter, 50, 55.1);
  assert.deepEqual(calls, ["youtube:dQw4w9WgXcQ"]);
});

test("play counts: a natural end counts a short play", () => {
  const { counter, calls } = rig();
  counter.start(SONG);
  run(counter, 0, 12);
  counter.ended();
  assert.deepEqual(calls, ["midi:123"]);
  counter.ended();
  run(counter, 12, 60);
  assert.deepEqual(calls, ["midi:123"], "an ended play stays closed");
});

test("play counts: an end for a song that never sounded is not a play", () => {
  const { counter, calls } = rig();
  counter.start(SONG);
  run(counter, 0, 3, false);                   // loading / the title card: never playing
  counter.ended();                             // a stale end flag (§5.14)
  assert.deepEqual(calls, []);
  counter.start(SONG);
  counter.ended();                             // no tick at all
  assert.deepEqual(calls, []);
});

test("play counts: a Restart is the same play and cannot count twice", () => {
  const { counter, calls } = rig();
  counter.start(SONG);
  run(counter, 0, 40);
  assert.deepEqual(calls, ["midi:123"]);
  // restartSong() rewinds the engine and does NOT call start(): the play goes on.
  run(counter, 40, 300);
  counter.ended();
  assert.deepEqual(calls, ["midi:123"]);
});

test("play counts: a Restart before 30 s keeps the time already played", () => {
  const { counter, calls } = rig();
  counter.start(SONG);
  run(counter, 0, 20);
  run(counter, 20, 30.1);                      // restarted at 20 s; 10.1 s more from the top
  assert.deepEqual(calls, ["midi:123"], "one play of 30 s, restart or not");
});

test("play counts: the same song queued twice counts twice", () => {
  const { counter, calls } = rig();
  counter.start(SONG);
  run(counter, 0, 200);
  counter.ended();
  counter.start(SONG);                         // the queue advances to the same song again
  run(counter, 210, 239.9);
  assert.deepEqual(calls, ["midi:123"]);
  run(counter, 239.9, 240.1);
  assert.deepEqual(calls, ["midi:123", "midi:123"]);
});

test("play counts: no play is open before start() or for a song without an id", () => {
  const { counter, calls } = rig();
  run(counter, 0, 60);
  counter.ended();
  for (const song of [null, undefined, {}, { id: "" }, { id: 5 }, { id: null }]) {
    counter.start(song);
    run(counter, 0, 60);
    counter.start(song);
    run(counter, 0, 1);
    counter.ended();
  }
  assert.deepEqual(calls, []);
});

// --- 2. the clock --------------------------------------------------------------------------
test("play counts: one step is capped — a laptop that slept mid-song is not 30 s of music", () => {
  const { counter, calls } = rig();
  assert.equal(MAX_STEP_SEC, 2);
  counter.start(SONG);
  counter.tick(true, 100);
  counter.tick(true, 100 + 3600);              // the lid closed for an hour, "playing" both ends
  assert.deepEqual(calls, []);
  run(counter, 3700, 3727.9);                  // 2 s (the clamped gap) + 27.9 s
  assert.deepEqual(calls, []);
  run(counter, 3727.9, 3728.1);
  assert.deepEqual(calls, ["midi:123"]);
});

test("play counts: the 1 s hidden-tab watchdog alone keeps counting", () => {
  const { counter, calls } = rig();
  counter.start(SONG);
  for (let t = 0; t <= 29; t++) counter.tick(true, t);
  assert.deepEqual(calls, []);
  counter.tick(true, 30);
  assert.deepEqual(calls, ["midi:123"]);
});

test("play counts: rAF and the watchdog ticking together do not double the time", () => {
  const { counter, calls } = rig();
  counter.start(SONG);
  // Both sources read the same monotonic clock, so their ticks interleave in time order.
  const times = [];
  for (let k = 0; k <= 29.5 * 60; k++) times.push(k / 60);
  for (let s = 0; s <= 29; s++) times.push(s + 0.0005);
  times.sort((a, b) => a - b);
  for (const t of times) counter.tick(true, t);
  assert.deepEqual(calls, [], "29.5 s of music is 29.5 s, however many callers tick");
  run(counter, 29.5, 30.1);
  assert.deepEqual(calls, ["midi:123"]);
});

test("play counts: a bad or backwards clock value is ignored", () => {
  const { counter, calls } = rig();
  counter.start(SONG);
  run(counter, 0, 10);
  for (const bad of [NaN, Infinity, -Infinity, undefined, "11"]) counter.tick(true, bad);
  counter.tick(true, 5);                       // backwards: no time, and the clock re-bases
  run(counter, 5, 24.5);
  assert.deepEqual(calls, [], "10 s + 19.5 s");
  run(counter, 24.5, 25.1);
  assert.deepEqual(calls, ["midi:123"]);
});

test("play counts: thresholdSec is configurable; a bad one falls back to 30", () => {
  const short = rig({ thresholdSec: 5 });
  short.counter.start(SONG);
  run(short.counter, 0, 5.05);
  assert.deepEqual(short.calls, ["midi:123"]);
  for (const thresholdSec of [NaN, -1, "10"]) {
    const r = rig({ thresholdSec });
    r.counter.start(SONG);
    run(r.counter, 0, 29.9);
    assert.deepEqual(r.calls, [], String(thresholdSec));
    run(r.counter, 29.9, 30.1);
    assert.deepEqual(r.calls, ["midi:123"], String(thresholdSec));
  }
});

// --- 3. the reporter -----------------------------------------------------------------------
test("play counts: a failing reporter is swallowed with ONE warning and never counts twice", async () => {
  let calls = 0;
  const warns = [];
  const counter = createPlayCounter({
    report: () => { calls++; if (calls % 2) throw new Error("offline"); return Promise.reject(new Error("503")); },
    warn: (...args) => warns.push(args),
  });
  for (let i = 0; i < 4; i++) {
    counter.start(SONG);
    run(counter, i * 100, i * 100 + 31);
    counter.ended();
  }
  await flush();
  assert.equal(calls, 4, "one report per play, the throwing one included");
  assert.equal(warns.length, 1, "one console line, however often the server is away");
  assert.match(String(warns[0][1]), /offline/);
});

test("play counts: a reporter that re-enters the counter cannot double count", () => {
  const calls = [];
  let counter;
  counter = createPlayCounter({
    report: (id) => { calls.push(id); counter.tick(true, 1e6); counter.ended(); },
    warn: () => {},
  });
  counter.start(SONG);
  run(counter, 0, 31);
  counter.ended();
  assert.deepEqual(calls, ["midi:123"]);
});

test("play counts: the default reporter POSTs the id to /api/played", async () => {
  const realFetch = globalThis.fetch;
  const sent = [];
  let status = 200;
  globalThis.fetch = async (url, init) => { sent.push({ url, init }); return { ok: status < 400, status }; };
  try {
    await reportPlayed("video:videos/clip.mp4");
    assert.equal(sent.length, 1);
    assert.equal(sent[0].url, "/api/played");
    assert.equal(sent[0].init.method, "POST");
    assert.equal(sent[0].init.headers["Content-Type"], "application/json");
    assert.deepEqual(JSON.parse(sent[0].init.body), { id: "video:videos/clip.mp4" });
    assert.equal(sent[0].init.keepalive, true);

    status = 507;                               // the server's table is full
    await assert.rejects(reportPlayed("midi:1"), /HTTP 507/);

    // createPlayCounter() without a reporter uses this one, and swallows its failure.
    const warns = [];
    const counter = createPlayCounter({ warn: (...args) => warns.push(args) });
    counter.start(SONG);
    run(counter, 0, 31);
    await flush();
    assert.deepEqual(JSON.parse(sent[2].init.body), { id: "midi:123" });
    assert.equal(warns.length, 1);
  } finally {
    globalThis.fetch = realFetch;
  }
});
