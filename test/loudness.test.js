/*
 * loudness.test.js — M10 lane A: evening out song loudness (plan §5.20). Pure: loudness.js only.
 * (readMusicMeanSquare's use of normalizeMeanSquare on the real engine is in music-fx.test.js, which
 * carries the fake Web Audio graph.)
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  LOUDNESS_KEY, normalizeMeanSquare, createLoudnessMeter, gainForDb, followGainDb, createLoudnessStore,
} from "../src/js/loudness.js";

const dbOf = (ms) => 10 * Math.log10(ms);
const near = (a, b, eps, msg) => assert.ok(Math.abs(a - b) <= eps, `${msg ?? ""} ${a} vs ${b} (±${eps})`);

/** The mean-square of a sine of amplitude `amp` read after a volume gain `vol` (what the analyser sees). */
const sineMs = (amp, vol) => (amp * vol) ** 2 / 2;

function memStorage(initial = {}) {
  const m = new Map(Object.entries(initial));
  return {
    map: m,
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => { m.set(k, String(v)); },
    removeItem: (k) => { m.delete(k); },
  };
}

// MUTATION-PROVEN: with normalizeMeanSquare returning `ms` (the division removed) the two readings
// differ by 6.02 dB and this test fails.
test("loudness meter is independent of the volume setting", () => {
  const learn = (vol) => {
    const m = createLoudnessMeter();
    for (let i = 0; i < 400; i++) {                         // 40 s of a song whose level breathes
      const amp = 0.05 + 0.05 * Math.sin(i / 7) ** 2;
      m.add(normalizeMeanSquare(sineMs(amp, vol), vol), 0.1);
    }
    return m.db;
  };
  const atHalf = learn(0.5), atFull = learn(1.0);
  near(atHalf, atFull, 0.1, "Volume 50% vs 100%:");
  near(learn(2.0), atFull, 0.1, "Volume 200% too:");
});

test("normalizeMeanSquare divides by volume² and never by zero", () => {
  assert.equal(normalizeMeanSquare(0.25, 0.5), 1);
  assert.equal(normalizeMeanSquare(0.01, 1), 0.01);
  assert.ok(Number.isFinite(normalizeMeanSquare(0, 0)), "Volume 0 is not a division by zero");
  assert.equal(normalizeMeanSquare(0, 0), 0);
});

test("meter of a constant signal reads its level", () => {
  const m = createLoudnessMeter();
  for (let i = 0; i < 50; i++) m.add(0.01, 0.1);            // −20 dB mean-square
  near(m.db, -20, 1e-9);
  near(m.seconds, 5, 1e-9);
  const sine = createLoudnessMeter();
  sine.add(sineMs(1, 1), 1);                                // a full-scale sine reads −3.01 dB
  near(sine.db, -3.0103, 1e-3);
});

test("silence is skipped", () => {
  const m = createLoudnessMeter();
  for (let i = 0; i < 20; i++) m.add(0.01, 0.1);            // 2 s at −20 dB
  for (let i = 0; i < 200; i++) m.add(1e-8, 0.1);           // 20 s at −80 dB: under the −60 floor
  for (let i = 0; i < 20; i++) m.add(0, 0.1);               // digital silence
  near(m.db, -20, 1e-9, "silence did not drag it down:");
  near(m.seconds, 2, 1e-9, "only the frames that counted:");
  const strict = createLoudnessMeter({ floorDb: -15 });
  strict.add(0.01, 1);
  assert.equal(strict.db, null, "a higher floor skips −20 dB too");
});

test("meter needs time before it reports", () => {
  const m = createLoudnessMeter();
  assert.equal(m.db, null, "nothing yet");
  assert.equal(m.seconds, 0);
  m.add(1e-9, 1);
  assert.equal(m.db, null, "only silence so far");
  m.add(0.001, 0.1);
  near(m.seconds, 0.1, 1e-12);
  near(m.db, -30, 1e-9);
  for (const junk of [[NaN, 0.1], [0.01, NaN], [0.01, 0], [0.01, -1], [-0.5, 0.1], [Infinity, 0.1]]) m.add(...junk);
  near(m.seconds, 0.1, 1e-12, "junk frames do not count:");
  m.reset();
  assert.equal(m.db, null);
  assert.equal(m.seconds, 0);
});

test("the meter averages energy over time, not dB", () => {
  const m = createLoudnessMeter();
  m.add(0.01, 1);       // −20 dB for 1 s
  m.add(0.0001, 1);     // −40 dB for 1 s
  near(m.db, dbOf((0.01 + 0.0001) / 2), 1e-9, "−22.97, not the −30 a dB average would give");
  m.add(0.0001, 30);    // one reading after a hidden tab counts for at most 1 s
  near(m.seconds, 3, 1e-9);
});

test("gainForDb boosts a quiet song up to the limit", () => {
  assert.equal(gainForDb(-22, -18), 4);
  assert.equal(gainForDb(-40, -18), 6, "capped at +6");
  assert.equal(gainForDb(-40, -18, { maxDb: 3 }), 3);
});

test("gainForDb cuts a loud song down to the limit", () => {
  assert.equal(gainForDb(-14, -18), -4);
  assert.equal(gainForDb(0, -18), -9, "capped at −9");
  assert.equal(gainForDb(0, -18, { minDb: -12 }), -12);
});

test("gainForDb is zero at target, and with nothing stored", () => {
  assert.equal(gainForDb(-18, -18), 0);
  assert.equal(gainForDb(null, -18), 0);
  assert.equal(gainForDb(undefined, -18), 0);
  assert.equal(gainForDb(NaN, -18), 0);
  assert.equal(gainForDb(-20, NaN), 0);
});

test("follower moves toward the target with the time constant", () => {
  // want = target − measured = −18 − (−24) = +6 (exactly the limit)
  const after1Tau = followGainDb(0, -24, -18, 4);
  near(after1Tau, 6 * (1 - Math.exp(-1)), 1e-9, "63% of the way after one τ:");
  let g = 0;
  for (let i = 0; i < 40; i++) g = followGainDb(g, -24, -18, 0.1);   // 40 × 0.1 s = one τ in small steps
  near(g, after1Tau, 1e-9, "independent of how time is sliced:");
  for (let i = 0; i < 400; i++) g = followGainDb(g, -24, -18, 0.1);
  near(g, 6, 1e-3, "settles on the target:");
  near(followGainDb(0, -24, -18, 2, { tauSec: 2 }), 6 * (1 - Math.exp(-1)), 1e-9, "tau is an option");
});

test("follower never goes beyond ±limit", () => {
  assert.equal(followGainDb(0, -60, -18, 1000), 6, "wants +42, gets +6");
  assert.equal(followGainDb(0, 0, -18, 1000), -6, "wants −18, gets −6");
  assert.equal(followGainDb(20, -18, -18, 0), 6, "even a wild starting value is clamped");
  assert.equal(followGainDb(0, -60, -18, 1000, { limitDb: 3 }), 3);
  // the far-off target is limited BEFORE easing: one τ is 63% of the way to +6, not a dash toward +42
  near(followGainDb(0, -60, -18, 4), 6 * (1 - Math.exp(-1)), 1e-9, "limited, then eased:");
});

test("follower holds during silence", () => {
  assert.equal(followGainDb(2.5, null, -18, 0.1), 2.5, "measured null → hold");
  assert.equal(followGainDb(2.5, undefined, -18, 5), 2.5);
  assert.equal(followGainDb(2.5, -24, -18, 0), 2.5, "no time passed → hold");
  assert.equal(followGainDb(NaN, null, -18, 1), 0, "a junk current gain starts from 0");
});

test("store round-trips rounded values", () => {
  const storage = memStorage();
  const store = createLoudnessStore({ storage });
  assert.equal(store.get("midi:12989"), null);
  store.set("midi:12989", -24.4372);
  store.set("audio:00005", -23.25);
  assert.equal(store.get("midi:12989"), -24.4);
  assert.equal(store.get("audio:00005"), -23.2);
  assert.ok(storage.map.has(LOUDNESS_KEY), `stored under ${LOUDNESS_KEY}`);
  assert.equal(LOUDNESS_KEY, "karaeoke.loudness.v1");
  const again = createLoudnessStore({ storage });            // a reload reads it back
  assert.equal(again.get("midi:12989"), -24.4);
  store.set("midi:12989", -20);                               // a later learn replaces it
  assert.equal(again.get("midi:12989"), -20, "read fresh — no stale copy");
  store.set("midi:1", NaN);
  store.set("", -20);
  assert.equal(store.get("midi:1"), null, "non-finite values are not stored");
  assert.equal(store.get(""), null);
});

test("store evicts the oldest beyond max", () => {
  const storage = memStorage();
  const store = createLoudnessStore({ storage, max: 3 });
  store.set("a", -20); store.set("123", -21); store.set("c", -22);
  store.set("a", -19);                                        // re-writing "a" makes it the newest
  store.set("d", -23);                                        // → "123" (oldest write) goes
  assert.equal(store.get("123"), null, "an integer-like id is evicted in write order too");
  assert.equal(store.get("a"), -19);
  assert.equal(store.get("c"), -22);
  assert.equal(store.get("d"), -23);
  assert.equal(JSON.parse(storage.map.get(LOUDNESS_KEY)).length, 3);
});

test("store tolerates a missing, failing or corrupt storage", () => {
  const none = createLoudnessStore({ storage: null });
  none.set("x", -20);
  assert.equal(none.get("x"), null);
  const throwing = { getItem() { throw new Error("SecurityError"); }, setItem() { throw new Error("QuotaExceededError"); } };
  const t = createLoudnessStore({ storage: throwing });
  assert.doesNotThrow(() => t.set("x", -20));
  assert.equal(t.get("x"), null);
  for (const raw of ["{not json", "{\"a\":-20}", "42", "null"]) {
    const s = createLoudnessStore({ storage: memStorage({ [LOUDNESS_KEY]: raw }) });
    assert.equal(s.get("a"), null, raw);
    assert.doesNotThrow(() => s.set("b", -20));
    assert.equal(s.get("b"), -20, `${raw}: recovers on the next write`);
  }
  const mixed = createLoudnessStore({ storage: memStorage({ [LOUDNESS_KEY]: JSON.stringify([["ok", -20], ["bad"], [1, 2], ["nan", null], "x", ["ok", -21]]) }) });
  assert.equal(mixed.get("ok"), -21, "bad entries skipped; a repeated id keeps its newest value");
  assert.equal(mixed.get("__proto__"), null);
});
