// M9 lane A — difficulty levels, the Scorer's time-weighted per-note stats, and the per-note
// verdicts (src/js/scoring.js additions + src/js/verdicts.js). Plan §5.15 / §5.16.
// Run with: node --test
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  DIFFICULTIES, difficultyOf, pitchCredit, curveScore, Scorer,
  PERFECT_SEMIS, ZERO_AT_SEMIS, CURVE_EXPONENT, MAX_FRAME_SEC,
} from "../src/js/scoring.js";
import {
  VERDICTS, VERDICT_LABEL, MIN_NOTE_SEC, judgeNote, createVerdictFeed,
} from "../src/js/verdicts.js";

// --- helpers ------------------------------------------------------------------------------------

/** Feed frames at `fps` from `from` to `to` (inclusive, integer-stepped so there is no drift). */
function sing(scorer, from, to, fps, pitchAt, feed) {
  const n = Math.round((to - from) * fps);
  for (let k = 0; k <= n; k++) {
    const t = from + k / fps;
    scorer.addFrame(t, pitchAt(t));
    if (feed) feed.update(t);
  }
}

/** n one-second notes back to back: [k, k+1] at midi 60 + (k % 5). */
const seconds = (n) => Array.from({ length: n }, (_, k) => ({ note: 60 + (k % 5), start: k, end: k + 1 }));
/** The target pitch at time t on such a melody. */
const targetAt = (notes) => {
  const s = new Scorer(notes, { golden: false });
  return (t) => { const i = s.noteIndexAt(t); return i < 0 ? null : s.notes[i].note; };
};
/** …the same, sung `cents` sharp. */
const detuned = (notes, cents) => { const at = targetAt(notes); return (t) => { const m = at(t); return m == null ? null : m + cents / 100; }; };
const near = (a, b, rel) => Math.abs(a - b) <= rel * Math.max(Math.abs(a), Math.abs(b));
const sum = (o) => Object.values(o).reduce((a, b) => a + b, 0);
const stats = (len, voiced, on, err) => ({ len, voiced, on, err });

// --- difficulty ---------------------------------------------------------------------------------

test("normal difficulty equals the old constants", () => {
  const n = DIFFICULTIES.normal;
  assert.equal(n.perfectSemis, PERFECT_SEMIS);
  assert.equal(n.zeroAtSemis, ZERO_AT_SEMIS);
  assert.equal(PERFECT_SEMIS, 0.5);
  assert.equal(ZERO_AT_SEMIS, 2.5);
  assert.equal(n.curve, 0.72);
  assert.equal(CURVE_EXPONENT, 0.72);
  assert.equal(n.clear, 0.55);
  assert.deepEqual({ ...DIFFICULTIES.easy }, { perfectSemis: 0.75, zeroAtSemis: 3, clear: 0.40, curve: 0.60 });
  assert.deepEqual({ ...DIFFICULTIES.hard }, { perfectSemis: 0.35, zeroAtSemis: 2, clear: 0.70, curve: 0.90 });
  assert.deepEqual(Object.keys(DIFFICULTIES), ["easy", "normal", "hard"]);
  assert.ok(Object.isFrozen(DIFFICULTIES));
  for (const k of Object.keys(DIFFICULTIES)) assert.ok(Object.isFrozen(DIFFICULTIES[k]), k);
  // The credit curve, with and without the new parameter, is exactly the pre-M9 formula.
  const old = (x) => { const e = Math.abs(x); return e <= 0.5 ? 1 : e >= 2.5 ? 0 : 1 - (e - 0.5) / 2; };
  for (let k = -70; k <= 70; k++) {
    const e = k / 20;
    assert.equal(pitchCredit(e), old(e), `e=${e}`);
    assert.equal(pitchCredit(e, DIFFICULTIES.normal), old(e), `e=${e}`);
    assert.equal(pitchCredit(e, "normal"), old(e), `e=${e}`);
  }
});

test("pitchCredit with easy is wider", () => {
  assert.equal(pitchCredit(0.7, "easy"), 1);          // inside easy's 0.75 window…
  assert.ok(pitchCredit(0.7) < 1);                    // …but outside normal's 0.5
  assert.ok(pitchCredit(2.7, DIFFICULTIES.easy) > 0); // easy still gives credit past 2.5
  assert.equal(pitchCredit(2.7), 0);
  assert.equal(pitchCredit(3, "easy"), 0);
  assert.equal(pitchCredit(0.4, "hard"), pitchCredit(0.4, "hard"));
  assert.ok(pitchCredit(0.4, "hard") < 1);            // hard's window is 0.35
  for (let k = 0; k <= 80; k++) {
    const e = k / 20;
    assert.ok(pitchCredit(e, "easy") >= pitchCredit(e), `easy ≥ normal at ${e}`);
    assert.ok(pitchCredit(e) >= pitchCredit(e, "hard"), `normal ≥ hard at ${e}`);
  }
});

test("curveScore default is unchanged for 0, .25, .5, .75, 1", () => {
  // Pinned from the pre-M9 code (curveScore(raw) = round(raw^0.72 · 100)) before any change.
  const pinned = [0, 37, 61, 81, 100];
  [0, 0.25, 0.5, 0.75, 1].forEach((r, k) => {
    assert.equal(curveScore(r), pinned[k], `raw ${r}`);
    assert.equal(curveScore(r, 0.72), pinned[k], `raw ${r}, explicit 0.72`);
    assert.equal(curveScore(r, DIFFICULTIES.normal.curve), pinned[k]);
  });
  // A difficulty's curve bends it: easy lifts the middle, hard lowers it.
  assert.ok(curveScore(0.5, 0.6) > curveScore(0.5));
  assert.ok(curveScore(0.5, 0.9) < curveScore(0.5));
  // A missing or nonsense exponent falls back to the old curve.
  for (const bad of [undefined, 0, -1, NaN, Infinity, "x", null]) assert.equal(curveScore(0.5, bad), 61, String(bad));
});

test("difficultyOf falls back for unknown / \"__proto__\"", () => {
  assert.equal(difficultyOf("easy"), DIFFICULTIES.easy);
  assert.equal(difficultyOf("normal"), DIFFICULTIES.normal);
  assert.equal(difficultyOf("hard"), DIFFICULTIES.hard);
  for (const bad of ["__proto__", "constructor", "toString", "hasOwnProperty", "valueOf", "", "Hard", "expert",
    undefined, null, 42, NaN, true, [], {}, { perfectSemis: 1, zeroAtSemis: 0.5, clear: 0.5, curve: 1 },
    { perfectSemis: 0.5, zeroAtSemis: 2, clear: 1.5, curve: 1 }]) {
    assert.equal(difficultyOf(bad), DIFFICULTIES.normal, JSON.stringify(bad) ?? String(bad));
  }
  // An entry object is accepted as-is (the same object, not a copy).
  assert.equal(difficultyOf(DIFFICULTIES.easy), DIFFICULTIES.easy);
  const custom = { perfectSemis: 0.6, zeroAtSemis: 2.8, clear: 0.5, curve: 0.8 };
  assert.equal(difficultyOf(custom), custom);
  // pitchCredit takes the same fallback: a hostile name scores as normal.
  assert.equal(pitchCredit(0.7, "__proto__"), pitchCredit(0.7));
});

test("a difficulty changes the score itself — and normal is the old score", () => {
  const notes = [{ note: 60, start: 0, end: 2 }];
  const score = (difficulty) => {
    const s = new Scorer(notes, { golden: false, difficulty });
    sing(s, 0, 2, 60, () => 61);                     // a whole semitone flat-side… sharp
    return s.finish().score;
  };
  assert.equal(score("normal"), curveScore(0.75));    // credit 0.75 on the old curve = 81
  assert.equal(score("normal"), 81);
  assert.equal(score(undefined), 81);
  assert.ok(score("easy") > score("normal"));
  assert.ok(score("hard") < score("normal"));
  // The curve is the difficulty's too — on the final score AND the live readout.
  for (const d of ["easy", "hard"]) {
    const s = new Scorer(notes, { golden: false, difficulty: d });
    sing(s, 0, 2, 60, () => 61);
    const res = s.finish();
    assert.equal(res.score, curveScore(res.raw, DIFFICULTIES[d].curve), d);
    assert.notEqual(res.score, curveScore(res.raw), `${d}: the curve must not be the default`);
    assert.equal(s.liveScore(), curveScore(s.ratio(), DIFFICULTIES[d].curve), d);
  }
});

test("a normal Scorer is indistinguishable from the default one", () => {
  const notes = [
    { note: 60, start: 0, end: 1 }, { note: 64, start: 1.2, end: 2.5 }, { note: 67, start: 3, end: 3.1 },
    { note: 65, start: 4, end: 6 },
  ];
  const messy = (t) => (t % 0.7 < 0.2 ? null : 60 + Math.sin(t * 3) * 3 + (t > 4 ? 5 : 0));
  const a = new Scorer(notes);
  const b = new Scorer(notes, { difficulty: "normal" });
  const c = new Scorer(notes, { difficulty: DIFFICULTIES.normal });
  for (const s of [a, b, c]) sing(s, -0.5, 6.5, 50, messy);
  for (const s of [b, c]) {
    assert.deepEqual(s.finish(), a.finish());
    assert.equal(s.liveScore(), a.liveScore());
    assert.equal(s.ratio(3), a.ratio(3));
    assert.equal(s.windowRatio(1, 3), a.windowRatio(1, 3));
    for (let i = 0; i < notes.length; i++) assert.equal(s.noteRatio(i), a.noteRatio(i));
  }
});

// --- time-weighted stats ------------------------------------------------------------------------

test("noteStats is time-weighted, not frame-weighted", () => {
  // One 6 s note: on pitch 0–3 s, a semitone off 3–4.5 s, silent 4.5–6 s.
  const notes = [{ note: 60, start: 0, end: 6 }];
  const voice = (t) => (t < 3 ? 60 : t < 4.5 ? 61 : null);
  const at = (fps) => { const s = new Scorer(notes, { golden: false }); sing(s, 0, 6, fps, voice); return s.noteStats(0); };
  const slow = at(30), fast = at(120);
  for (const k of ["len", "voiced", "on", "err"]) assert.ok(near(slow[k], fast[k], 0.02), `${k}: ${slow[k]} vs ${fast[k]}`);
  // …and they are SECONDS, not frame counts.
  assert.equal(fast.len, 6);
  assert.ok(near(fast.voiced, 4.5, 0.02), `voiced ${fast.voiced}`);
  assert.ok(near(fast.on, 3, 0.02), `on ${fast.on}`);
  assert.ok(near(fast.err, 1.5, 0.02), `err ${fast.err}`);   // 1 semitone × 1.5 s
});

test("uneven frame pacing does not skew a note's on-pitch share", () => {
  // On pitch for 1 s at 120 frames/s, then off for 1 s at only 20 frames/s (a frame-mean share
  // would read 86% on pitch). Time-weighted it is half — below clear, so a MISS.
  const s = new Scorer([{ note: 60, start: 0, end: 2 }], { golden: false });
  sing(s, 0, 1, 120, () => 60);
  sing(s, 1.05, 2, 20, () => 62);
  const st = s.noteStats(0);
  assert.ok(Math.abs(st.on / st.voiced - 0.5) < 0.03, `on share ${st.on / st.voiced}`);
  assert.equal(judgeNote(st, "normal"), "miss");
});

test("dt is clamped", () => {
  const s = new Scorer([{ note: 60, start: 0, end: 10 }], { golden: false });
  s.addFrame(1, 60);                                    // the first frame has no previous: adds 0
  assert.equal(s.noteStats(0).voiced, 0);
  s.addFrame(6, 60);                                    // a 5 s gap (a stall, a forward seek)
  assert.ok(s.noteStats(0).voiced <= 0.1 + 1e-12, `voiced ${s.noteStats(0).voiced}`);
  assert.equal(s.noteStats(0).voiced, MAX_FRAME_SEC);
  s.addFrame(3, 60);                                    // backwards (a seek): adds nothing
  assert.equal(s.noteStats(0).voiced, MAX_FRAME_SEC);
  s.addFrame(3.05, null);                               // an unvoiced frame still moves the clock…
  s.addFrame(3.1, 60);                                  // …so this one adds 0.05, not 0.1
  assert.ok(Math.abs(s.noteStats(0).voiced - (MAX_FRAME_SEC + 0.05)) < 1e-9, `voiced ${s.noteStats(0).voiced}`);
  s.addFrame(NaN, 60);                                  // a broken clock adds nothing either
  assert.ok(Math.abs(s.noteStats(0).voiced - (MAX_FRAME_SEC + 0.05)) < 1e-9);
  // An index with no note reads as zeros.
  assert.deepEqual(s.noteStats(5), { len: 0, voiced: 0, on: 0, err: 0 });
  assert.deepEqual(s.noteStats(-1), { len: 0, voiced: 0, on: 0, err: 0 });
});

// --- the verdict rule ---------------------------------------------------------------------------

test("an unsung note is a miss", () => {
  assert.equal(judgeNote(stats(1, 0, 0, 0), "normal"), "miss");
  const s = new Scorer([{ note: 60, start: 0, end: 1 }, { note: 62, start: 1, end: 2 }], { golden: false });
  const seen = [];
  const feed = createVerdictFeed({ scorer: s, difficulty: "normal", onVerdict: (v, i) => seen.push([v, i]) });
  sing(s, 0, 1, 60, () => 60, feed);                    // sing the first, breathe through the second
  sing(s, 1 + 1 / 60, 3, 60, () => null, feed);
  assert.deepEqual(seen, [["perfect", 0], ["miss", 1]]);
});

test("a note held dead on is perfect", () => {
  for (const name of ["easy", "normal", "hard"]) {
    const s = new Scorer([{ note: 60, start: 0, end: 1 }], { golden: false, difficulty: name });
    sing(s, 0, 1, 60, () => 60);
    const st = s.noteStats(0);
    assert.equal(st.err, 0);
    assert.ok(Math.abs(st.on - st.voiced) < 1e-12 && st.voiced > 0.98, `${name}: ${JSON.stringify(st)}`);
    assert.equal(judgeNote(st, name), "perfect", name);
  }
  // An octave down is the same note (the score is octave-invariant, so the verdict is too).
  const low = new Scorer([{ note: 72, start: 0, end: 1 }], { golden: false });
  sing(low, 0, 1, 60, () => 60);
  assert.equal(judgeNote(low.noteStats(0), "normal"), "perfect");
});

test("80% on pitch with small error is excellent", () => {
  assert.equal(judgeNote(stats(1, 1, 0.8, 0.15), "normal"), "excellent");   // err 0.15 / 0.5 = 0.3
  assert.equal(judgeNote(stats(1, 1, 0.8, 0.40), "normal"), "great");       // same share, err 0.8: not excellent
  assert.equal(judgeNote(stats(1, 1, 0.95, 0.30), "normal"), "excellent");  // on enough, err 0.6 > 0.4: not perfect
  assert.equal(judgeNote(stats(1, 1, 0.9, 0.2), "normal"), "perfect");      // the edge of perfect is perfect
  // Sung: ~85% of the note 0.1 semitone off, the rest 0.8 off (outside the window).
  const s = new Scorer([{ note: 60, start: 0, end: 1 }], { golden: false });
  sing(s, 0, 1, 60, (t) => (t < 0.85 ? 60.1 : 60.8));
  assert.equal(judgeNote(s.noteStats(0), s.difficulty), "excellent");
});

test("clear + 20% is great", () => {
  assert.equal(judgeNote(stats(1, 1, 0.75, 0.5), "normal"), "great");       // 0.55 + 0.20
  assert.equal(judgeNote(stats(1, 1, 0.7499, 0.5), "normal"), "good");
  assert.equal(judgeNote(stats(1, 1, 0.9, 1), "hard"), "great");            // 0.70 + 0.20 (0.8999… in floats)
  assert.equal(judgeNote(stats(1, 1, 0.6, 1), "easy"), "great");            // 0.40 + 0.20 (0.6000…1 in floats)
  assert.equal(judgeNote(stats(1, 1, 0.5999, 1), "easy"), "good");
  // A great without coverage: cov < 0.5 can never be perfect or excellent.
  assert.equal(judgeNote(stats(1, 0.4, 0.4, 0), "normal"), "great");
  // The GREAT bar is capped at 99%.
  const strict = { perfectSemis: 0.3, zeroAtSemis: 2, clear: 0.9, curve: 1 };
  assert.equal(judgeNote(stats(1, 1, 0.99, 1), strict), "great");
  assert.equal(judgeNote(stats(1, 1, 0.985, 1), strict), "good");
});

test("just cleared is good", () => {
  assert.equal(judgeNote(stats(1, 1, 0.55, 1), "normal"), "good");
  assert.equal(judgeNote(stats(1, 1, 0.70, 1), "hard"), "good");
  assert.equal(judgeNote(stats(1, 1, 0.40, 1), "easy"), "good");
  assert.equal(judgeNote(stats(1, 1, 0.55, 1), DIFFICULTIES.normal), "good");
});

test("below clear is a miss", () => {
  assert.equal(judgeNote(stats(1, 1, 0.5499, 0.5), "normal"), "miss");
  assert.equal(judgeNote(stats(1, 1, 0.69, 0.5), "hard"), "miss");
  assert.equal(judgeNote(stats(1, 1, 0.39, 0.5), "easy"), "miss");
  // Sung: half on pitch, half three semitones away.
  const s = new Scorer([{ note: 60, start: 0, end: 2 }], { golden: false });
  sing(s, 0, 2, 60, (t) => (t < 1 ? 60 : 63));
  assert.equal(judgeNote(s.noteStats(0), "normal"), "miss");
});

test("barely voiced is a miss even when on pitch", () => {
  assert.equal(judgeNote(stats(1, 0.1, 0.1, 0), "normal"), "miss");
  assert.equal(judgeNote(stats(1, 0.149, 0.149, 0), "easy"), "miss");      // coverage does not ease with difficulty
  assert.equal(judgeNote(stats(1, 0.15, 0.15, 0), "normal"), "great");     // 15% is enough to be judged on pitch
  const s = new Scorer([{ note: 60, start: 0, end: 2 }], { golden: false });
  sing(s, 0, 0.2, 60, () => 60);                                            // a dead-on 0.2 s of a 2 s note
  sing(s, 0.2 + 1 / 60, 2, 60, () => null);
  assert.equal(judgeNote(s.noteStats(0), "normal"), "miss");
});

test("a very short note is not judged", () => {
  assert.equal(judgeNote(stats(0.1, 0.1, 0.1, 0), "normal"), null);
  assert.equal(judgeNote(stats(MIN_NOTE_SEC, MIN_NOTE_SEC, MIN_NOTE_SEC, 0), "normal"), "perfect");
  assert.equal(judgeNote(null, "normal"), null);
  assert.equal(judgeNote({}, "normal"), null);
  const s = new Scorer([{ note: 60, start: 0, end: 0.1 }, { note: 62, start: 0.2, end: 1.2 }], { golden: false });
  const seen = [];
  const feed = createVerdictFeed({ scorer: s, difficulty: "normal", onVerdict: (v, i) => seen.push(i) });
  sing(s, 0, 1.2, 60, (t) => (t <= 0.1 ? 60 : 62), feed);
  feed.update(Infinity);
  assert.deepEqual(seen, [1]);                          // the 0.1 s note is scored but never shown…
  assert.equal(sum(feed.tally()), 1);                   // …or tallied
  assert.ok(s.noteRatio(0) > 0);                        // (it still counts in the score)
});

test("hard is stricter than normal on the same singing", () => {
  // Every note sung 40 cents sharp — the browser check's detuned singer.
  const notes = seconds(4);
  const sharp = detuned(notes, 40);
  const run = (difficulty) => {
    const s = new Scorer(notes, { golden: false, difficulty });
    const feed = createVerdictFeed({ scorer: s, difficulty });
    sing(s, 0, 4, 60, sharp, feed);
    feed.update(Infinity);
    return { score: s.finish().score, tally: feed.tally() };
  };
  const easy = run("easy"), normal = run("normal"), hard = run("hard");
  assert.equal(normal.tally.great, 4);                  // inside normal's window, mean error 0.8 of it
  assert.equal(hard.tally.miss, 4);                     // outside hard's 0.35 window entirely
  assert.equal(easy.tally.excellent, 4);
  assert.ok(hard.score < normal.score, `${hard.score} < ${normal.score}`);
  assert.ok(easy.score >= normal.score);
  // Note: no level gives a PERFECT here (perfect needs a mean error ≤ 0.4 of the window, i.e.
  // ≤ 0.2 semitone on normal), so "fewer PERFECTs on hard" cannot be seen with a 40-cent detune.
  assert.equal(normal.tally.perfect + hard.tally.perfect, 0);
  // Dead-on singing is perfect on every level — difficulty never punishes the right note.
  for (const d of ["easy", "normal", "hard"]) {
    const s = new Scorer(notes, { golden: false, difficulty: d });
    sing(s, 0, 4, 60, targetAt(notes));
    assert.equal(s.finish().score, 100, d);
  }
});

// --- the feed -----------------------------------------------------------------------------------

test("the feed emits each note once", () => {
  const notes = seconds(3);
  const s = new Scorer(notes, { golden: false });
  const seen = [];
  const feed = createVerdictFeed({ scorer: s, difficulty: "normal", onVerdict: (v, i) => seen.push(i) });
  let returned = 0;
  const target = targetAt(notes);
  const n = 3.5 * 60;
  for (let k = 0; k <= n; k++) {
    const t = k / 60;
    s.addFrame(t, target(t));
    returned += feed.update(t);
    returned += feed.update(t);                        // the same frame twice (two rAF reads)
  }
  returned += feed.update(Infinity) + feed.update(Infinity);
  assert.deepEqual(seen, [0, 1, 2]);
  assert.equal(returned, 3);
  assert.deepEqual(feed.tally(), { perfect: 3, excellent: 0, great: 0, good: 0, miss: 0 });
});

test("the feed waits for the grace period", () => {
  const mk = (graceSec) => {
    const s = new Scorer([{ note: 60, start: 0, end: 1 }], { golden: false });
    sing(s, 0, 1, 60, () => 60);
    return createVerdictFeed({ scorer: s, difficulty: "normal", graceSec });
  };
  const feed = mk(undefined);                           // the default 0.15 s
  assert.equal(feed.update(1), 0);
  assert.equal(feed.update(1.149), 0);
  assert.equal(feed.update(1.151), 1);
  const slow = mk(0.5);
  assert.equal(slow.update(1.4), 0);
  assert.equal(slow.update(1.5), 1);
  const none = mk(0);
  assert.equal(none.update(0.99), 0);
  assert.equal(none.update(1), 1);
});

test("a backward seek does not double count", () => {
  const notes = seconds(10);
  const s = new Scorer(notes, { golden: false });
  const seen = [];
  const feed = createVerdictFeed({ scorer: s, difficulty: "normal", onVerdict: (v, i) => seen.push(i) });
  sing(s, 0, 5.5, 60, targetAt(notes), feed);
  assert.deepEqual(seen, [0, 1, 2, 3, 4]);              // note 4 ended at 5, due at 5.15
  assert.equal(feed.update(5.0), 0);                    // a small step back (jitter) is not a seek
  assert.equal(feed.update(1.0), 0);                    // the seek back
  sing(s, 1, 5.9, 60, targetAt(notes), feed);           // singing the rewound passage again…
  assert.deepEqual(seen, [0, 1, 2, 3, 4]);              // …re-judges nothing already judged
  sing(s, 5.9 + 1 / 60, 10.5, 60, targetAt(notes), feed);
  assert.deepEqual(seen, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]); // the rest still comes, once each
  assert.equal(sum(feed.tally()), 10);
  // A forward seek judges what it skipped (unsung → miss), once.
  const s2 = new Scorer(notes, { golden: false });
  const feed2 = createVerdictFeed({ scorer: s2 });
  sing(s2, 0, 2.2, 60, targetAt(notes), feed2);
  assert.equal(feed2.update(8), 5);                     // notes 2…6 (2 was sung, 3–6 skipped)
  assert.equal(feed2.tally().miss, 4);
});

test("tally sums to the judged notes", () => {
  const notes = [
    { note: 60, start: 0, end: 1 },        // dead on → perfect
    { note: 62, start: 1, end: 1.05 },     // too short → not judged
    { note: 64, start: 1.1, end: 2.1 },    // a semitone off → miss
    { note: 65, start: 2.2, end: 3.2 },    // 0.4 sharp → great
    { note: 67, start: 3.3, end: 4.3 },    // silent → miss
  ];
  const voice = (t) => (t <= 1 ? 60 : t < 1.1 ? null : t <= 2.1 ? 65 : t < 2.2 ? null : t <= 3.2 ? 65.4 : null);
  const s = new Scorer(notes, { golden: false });
  let calls = 0, returned = 0;
  const feed = createVerdictFeed({ scorer: s, difficulty: "normal", onVerdict: () => calls++ });
  const n = 5 * 60;
  for (let k = 0; k <= n; k++) { const t = k / 60; s.addFrame(t, voice(t)); returned += feed.update(t); }
  returned += feed.update(Infinity);
  const tally = feed.tally();
  assert.deepEqual(Object.keys(tally), VERDICTS);
  assert.deepEqual(tally, { perfect: 1, excellent: 0, great: 1, good: 0, miss: 2 });
  const judged = notes.filter((x) => x.end - x.start >= MIN_NOTE_SEC).length;
  assert.equal(sum(tally), judged);
  assert.equal(calls, judged);
  assert.equal(returned, judged);
  // tally() is a copy: changing it changes nothing.
  tally.perfect = 99;
  assert.equal(feed.tally().perfect, 1);
});

test("reset zeroes the tally and the pointer", () => {
  const notes = seconds(3);
  const s = new Scorer(notes, { golden: false });
  const feed = createVerdictFeed({ scorer: s, difficulty: "normal" });
  sing(s, 0, 3, 60, targetAt(notes));
  assert.equal(feed.update(Infinity), 3);
  feed.reset();
  assert.deepEqual(feed.tally(), { perfect: 0, excellent: 0, great: 0, good: 0, miss: 0 });
  assert.equal(feed.update(2), 1);                      // judged again from the start
  assert.equal(feed.update(Infinity), 2);
});

test("the feed judges with the scorer's difficulty unless told otherwise", () => {
  const notes = seconds(2);
  const sharp = detuned(notes, 40);
  const s = new Scorer(notes, { golden: false, difficulty: "easy" });
  sing(s, 0, 2, 60, sharp);
  const own = createVerdictFeed({ scorer: s });           // easy: err 0.4 / 0.75 ≤ 0.7 → excellent
  own.update(Infinity);
  assert.equal(own.tally().excellent, 2);
  const told = createVerdictFeed({ scorer: s, difficulty: "normal" });
  told.update(Infinity);
  assert.equal(told.tally().great, 2);                    // err 0.4 / 0.5 = 0.8 → great
  // No scorer, or nonsense input: an inert feed.
  const inert = createVerdictFeed();
  assert.equal(inert.update(10), 0);
  assert.equal(inert.update(Infinity), 0);
  assert.equal(sum(inert.tally()), 0);
  assert.equal(own.update(NaN), 0);
  assert.equal(own.update("5"), 0);
});

test("finish reports the difficulty name", () => {
  const notes = [{ note: 60, start: 0, end: 1 }];
  const fin = (opts) => { const s = new Scorer(notes, { golden: false, ...opts }); sing(s, 0, 1, 30, () => 60); return s; };
  assert.equal(fin({}).finish().difficulty, "normal");
  assert.equal(fin({ difficulty: "easy" }).finish().difficulty, "easy");
  assert.equal(fin({ difficulty: "hard" }).finish().difficulty, "hard");
  assert.equal(fin({ difficulty: DIFFICULTIES.hard }).finish().difficulty, "hard");
  assert.equal(fin({ difficulty: "__proto__" }).finish().difficulty, "normal");   // what it was scored with
  assert.equal(fin({ difficulty: "Hard" }).finish().difficulty, "normal");
  assert.equal(fin({ difficulty: null }).finish().difficulty, "normal");
  const custom = { perfectSemis: 0.6, zeroAtSemis: 2.8, clear: 0.5, curve: 0.8 };
  const c = fin({ difficulty: custom });
  assert.equal(c.finish().difficulty, "custom");
  assert.equal(c.difficulty, custom);
  const h = fin({ difficulty: "hard" });
  assert.equal(h.difficulty, DIFFICULTIES.hard);
  assert.equal(h.difficultyName, "hard");
  // The rest of the result is untouched.
  assert.deepEqual(Object.keys(h.finish()), ["score", "raw", "band", "notes", "sung", "golden", "difficulty"]);
  assert.equal(new Scorer(notes, { difficulty: "hard" }).finish(), null);         // nobody sang → still null
});

test("the verdict constants", () => {
  assert.deepEqual(VERDICTS, ["perfect", "excellent", "great", "good", "miss"]);
  assert.ok(Object.isFrozen(VERDICTS) && Object.isFrozen(VERDICT_LABEL));
  for (const v of VERDICTS) assert.equal(VERDICT_LABEL[v], v.toUpperCase());
  assert.equal(MIN_NOTE_SEC, 0.12);
});
