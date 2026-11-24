/*
 * verdict-ui.test.js — the M9 scoring surfaces (plan §5.15, §5.17): score-presentation.js's
 * per-note verdict chip, the score card's tallies + difficulty, `score.feedback` gating the line
 * chip, and PitchGuide.update's micShiftSec (melody.js).
 *
 * The DOM parts run against a small hand-built fake with only the surface the module uses:
 * getElementById, createElement, className / classList, textContent, hidden, append /
 * replaceChildren. innerHTML throws. Timers are node:test's mock timers. PitchGuide gets a fake
 * canvas whose 2D context records calls — enough to read the trail buffer and where the pitch
 * dot was drawn, without a real canvas.
 * Run with:  node --test
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  createScorePresentation, feedbackMode, verdictTallies, difficultyLabel, VERDICT_MS,
} from "../src/js/score-presentation.js";
import { VERDICTS } from "../src/js/verdicts.js";
import { PitchGuide } from "../src/js/melody.js";

// --- a minimal fake DOM ---------------------------------------------------------------------
class Text {
  constructor(s) { this.data = String(s); this.parentElement = null; }
  get textContent() { return this.data; }
}
class El {
  constructor(doc, tag, id = "") {
    Object.assign(this, { doc, id, tagName: tag.toUpperCase(), className: "", hidden: false,
      children: [], parentElement: null, ownText: "" });
  }
  get classList() {
    const el = this;
    const list = () => el.className.split(/\s+/).filter(Boolean);
    return {
      add: (...cs) => { el.className = [...new Set([...list(), ...cs])].join(" "); },
      remove: (...cs) => { el.className = list().filter((c) => !cs.includes(c)).join(" "); },
      contains: (c) => list().includes(c),
    };
  }
  has(c) { return this.classList.contains(c); }
  get textContent() { return this.ownText + this.children.map((c) => c.textContent).join(""); }
  set textContent(v) { this.detachAll(); this.ownText = String(v); }
  set innerHTML(_) { this.doc.htmlWrites++; throw new Error("innerHTML must not be used"); }
  insertAdjacentHTML() { this.doc.htmlWrites++; throw new Error("insertAdjacentHTML must not be used"); }
  detachAll() { for (const c of this.children) c.parentElement = null; this.children = []; }
  appendChild(c) { c.parentElement = this; this.children.push(c); return c; }
  append(...xs) { for (const x of xs) this.appendChild(typeof x === "string" ? new Text(x) : x); }
  replaceChildren(...xs) { this.detachAll(); this.ownText = ""; this.append(...xs); }
  get elements() { return this.children.filter((c) => c instanceof El); }
}
const CARD_IDS = ["score-card", "sc-song", "sc-score", "sc-band", "sc-singer", "sc-best"];
const M9_IDS = ["sc-verdicts", "sc-difficulty"];
function makeDoc(ids = [...CARD_IDS, ...M9_IDS, "line-bonus", "verdict"]) {
  const doc = { htmlWrites: 0, byId: new Map() };
  doc.createElement = (tag) => new El(doc, tag);
  doc.getElementById = (id) => doc.byId.get(id) || null;
  for (const id of ids) doc.byId.set(id, new El(doc, "div", id));
  return doc;
}
// --- end of the fake DOM --------------------------------------------------------------------

const fakeStorage = () => {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) };
};
const fakeSettings = (over = {}) => {
  const f = { "score.enabled": true, "score.card": true, ...over };
  return { values: f, get: (p) => f[p] };
};
function setup(over = {}, ids) {
  const doc = makeDoc(ids);
  const settings = fakeSettings(over);
  const sp = createScorePresentation({ settings, storage: fakeStorage(), doc });
  return { doc, settings, sp, el: (id) => doc.getElementById(id) };
}
const RES = (extra = {}) => ({
  score: 88, band: { label: "Excellent!", tier: "excellent" }, isBest: false, previous: 0,
  song: { name: "Tahan", artistName: "Bryan Chong" }, by: "Rae", ...extra,
});

// --- pure helpers ---------------------------------------------------------------------------

test("feedbackMode: the four modes pass, a missing or unknown value counts as 'note'", () => {
  for (const m of ["note", "line", "both", "off"]) assert.equal(feedbackMode(m), m);
  for (const m of [undefined, null, "", "per-note", "NOTE", 1, true, "constructor"]) assert.equal(feedbackMode(m), "note");
});

test("verdictTallies: five counts in verdict order, null when absent or all zero", () => {
  assert.deepEqual(verdictTallies({ perfect: 3, excellent: 2, great: 1, good: 4, miss: 5 }), [3, 2, 1, 4, 5]);
  assert.deepEqual(verdictTallies({ miss: 2 }), [0, 0, 0, 0, 2], "missing counts are 0");
  assert.deepEqual(verdictTallies({ perfect: 2.6, great: -3, good: "x", miss: NaN, excellent: Infinity }), [3, 0, 0, 0, 0]);
  assert.equal(verdictTallies({ perfect: 0, excellent: 0, great: 0, good: 0, miss: 0 }), null);
  for (const v of [undefined, null, 7, "perfect"]) assert.equal(verdictTallies(v), null);
});

test("difficultyLabel: easy / normal / hard, nothing else", () => {
  assert.equal(difficultyLabel("easy"), "Easy");
  assert.equal(difficultyLabel("normal"), "Normal");
  assert.equal(difficultyLabel("Hard"), "Hard");
  for (const v of [undefined, null, "", "expert", "constructor", "__proto__", 2, {}]) assert.equal(difficultyLabel(v), null);
});

// --- showVerdict ----------------------------------------------------------------------------

test("showVerdict: shows under 'note' and 'both', with the label and a per-verdict class", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  for (const mode of ["note", "both"]) {
    const { sp, el } = setup({ "score.feedback": mode });
    assert.equal(sp.showVerdict("perfect"), true);
    const v = el("verdict");
    assert.equal(v.textContent, "PERFECT");
    assert.ok(v.has("verdict") && v.has("show") && v.has("v-perfect"), `classes under ${mode}: ${v.className}`);
  }
});

test("showVerdict: a missing score.feedback counts as 'note'", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { sp, el } = setup();   // no score.feedback key at all
  assert.equal(sp.showVerdict("good"), true);
  assert.equal(el("verdict").textContent, "GOOD");
  assert.ok(el("verdict").has("v-good"));
});

test("showVerdict: shows nothing under 'line' or 'off'", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  for (const mode of ["line", "off"]) {
    const { sp, el } = setup({ "score.feedback": mode });
    assert.equal(sp.showVerdict("perfect"), false);
    assert.equal(el("verdict").textContent, "");
    assert.equal(el("verdict").className, "");
  }
});

test("showVerdict: every verdict gets its label and class", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { sp, el } = setup();
  const labels = { perfect: "PERFECT", excellent: "EXCELLENT", great: "GREAT", good: "GOOD", miss: "MISS" };
  for (const v of VERDICTS) {
    sp.showVerdict(v);
    assert.equal(el("verdict").textContent, labels[v]);
    assert.ok(el("verdict").has(`v-${v}`));
    for (const o of VERDICTS) if (o !== v) assert.ok(!el("verdict").has(`v-${o}`), "only one verdict class at a time");
  }
});

test("showVerdict: fades after VERDICT_MS, keeping its text for the fade-out", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { sp, el } = setup();
  sp.showVerdict("great");
  t.mock.timers.tick(VERDICT_MS - 1);
  assert.ok(el("verdict").has("show"));
  t.mock.timers.tick(1);
  assert.ok(!el("verdict").has("show"), "faded");
  assert.equal(el("verdict").textContent, "GREAT", "the text stays, so the colour fades out with it");
  assert.ok(VERDICT_MS >= 500 && VERDICT_MS <= 900, "about 700 ms");
});

test("showVerdict: a new verdict replaces the one showing and restarts the fade and the pop", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { sp, el } = setup();
  sp.showVerdict("perfect");
  const firstPop = el("verdict").className.match(/pop-\w/)[0];
  t.mock.timers.tick(500);
  sp.showVerdict("miss");
  const v = el("verdict");
  assert.equal(v.textContent, "MISS");
  assert.ok(v.has("v-miss") && !v.has("v-perfect"));
  const secondPop = v.className.match(/pop-\w/)[0];
  assert.notEqual(secondPop, firstPop, "the pop class flips, so the animation restarts");
  t.mock.timers.tick(VERDICT_MS - 1);   // 1199 ms after the first: the first timer must be gone
  assert.ok(v.has("show"), "the replaced chip's timer was cleared");
  t.mock.timers.tick(1);
  assert.ok(!v.has("show"));
});

test("showVerdict: unknown verdicts are ignored and leave a showing chip alone", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { sp, el, doc } = setup();
  for (const bad of ["fantastic", "", "PERFECT", "constructor", "__proto__", "toString", null, undefined, 3, {}]) {
    assert.equal(sp.showVerdict(bad), false, String(bad));
  }
  assert.equal(el("verdict").textContent, "");
  sp.showVerdict("excellent");
  const before = el("verdict").className;
  sp.showVerdict("nope");
  assert.equal(el("verdict").textContent, "EXCELLENT");
  assert.equal(el("verdict").className, before);
  assert.equal(doc.htmlWrites, 0, "text only through textContent");
});

test("showVerdict: tolerates a page without #verdict", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { sp } = setup({}, [...CARD_IDS, "line-bonus"]);
  assert.equal(sp.showVerdict("perfect"), false);
  sp.resetVerdict();
  sp.resetLineBonus();
});

test("resetLineBonus also clears the verdict chip (song boundaries)", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { sp, el } = setup();
  sp.showVerdict("perfect");
  sp.resetLineBonus();
  assert.equal(el("verdict").textContent, "");
  assert.ok(!el("verdict").has("show"));
  t.mock.timers.tick(VERDICT_MS * 2);   // the cleared timer must not fire on a later chip
  sp.showVerdict("good");
  t.mock.timers.tick(VERDICT_MS - 1);
  assert.ok(el("verdict").has("show"));
});

// --- showCard -------------------------------------------------------------------------------

test("showCard: five tallies in order, each label + count in its verdict colour", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { sp, el } = setup();
  sp.showCard(RES({ verdicts: { perfect: 12, excellent: 7, great: 3, good: 2, miss: 0 }, difficulty: "normal" }));
  const row = el("sc-verdicts");
  assert.equal(row.hidden, false);
  const pairs = row.elements;
  assert.deepEqual(pairs.map((p) => p.className), VERDICTS.map((v) => `scv v-${v}`));
  assert.deepEqual(pairs.map((p) => p.textContent), ["PERFECT 12", "EXCELLENT 7", "GREAT 3", "GOOD 2", "MISS 0"]);
  assert.deepEqual(pairs.map((p) => p.elements.map((c) => c.className)), VERDICTS.map(() => ["scv-l", "scv-n"]));
  assert.equal(el("sc-difficulty").textContent, "Normal");
  assert.equal(el("sc-difficulty").hidden, false);
  assert.equal(el("sc-score").textContent, "88", "the rest of the card is unchanged");
  assert.ok(el("score-card").has("show"));
});

test("showCard: difficulty names", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { sp, el } = setup();
  for (const [name, label] of [["easy", "Easy"], ["normal", "Normal"], ["hard", "Hard"]]) {
    sp.showCard(RES({ difficulty: name }));
    assert.equal(el("sc-difficulty").textContent, label);
  }
});

test("showCard: tallies and difficulty are hidden when absent, all zero or unknown — and never left over", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { sp, el } = setup();
  sp.showCard(RES({ verdicts: { perfect: 1, excellent: 0, great: 0, good: 0, miss: 0 }, difficulty: "hard" }));
  assert.equal(el("sc-verdicts").hidden, false);

  sp.showCard(RES());   // a result without the M9 fields (mic off for the verdicts, older code)
  assert.equal(el("sc-verdicts").hidden, true);
  assert.equal(el("sc-verdicts").children.length, 0, "the previous song's tallies are gone");
  assert.equal(el("sc-difficulty").hidden, true);
  assert.equal(el("sc-difficulty").textContent, "");

  sp.showCard(RES({ verdicts: { perfect: 0, excellent: 0, great: 0, good: 0, miss: 0 }, difficulty: "expert" }));
  assert.equal(el("sc-verdicts").hidden, true, "all zero → hidden");
  assert.equal(el("sc-difficulty").hidden, true, "an unknown difficulty is not shown");
});

test("showCard: works on a page without #sc-verdicts / #sc-difficulty", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { sp, el } = setup({}, CARD_IDS);
  sp.showCard(RES({ verdicts: { perfect: 4 }, difficulty: "easy" }));
  assert.equal(el("sc-score").textContent, "88");
  assert.ok(el("score-card").has("show"));
});

test("showCard: with score.card off nothing is rendered", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { sp, el } = setup({ "score.card": false });
  sp.showCard(RES({ verdicts: { perfect: 4 }, difficulty: "easy" }));
  assert.equal(el("sc-verdicts").children.length, 0);
  assert.equal(el("sc-difficulty").textContent, "");
  assert.ok(!el("score-card").has("show"));
});

// --- lineBonus gated by score.feedback -------------------------------------------------------

function lineRig(over) {
  const rig = setup(over);
  rig.calls = 0;
  rig.scorer = { windowRatio: () => { rig.calls++; return 0.95; } };
  rig.lyrics = { lines: [{ start: 0, end: 2 }, { start: 2, end: 4 }, { start: 4, end: 6 }, { start: 6, end: 8 }], activeLine: 0 };
  rig.step = (i) => { rig.lyrics.activeLine = i; rig.sp.lineBonus(rig.scorer, rig.lyrics); };
  return rig;
}

test("lineBonus: a no-op under the default 'note' (and under 'off')", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  for (const over of [{}, { "score.feedback": "note" }, { "score.feedback": "off" }]) {
    const r = lineRig(over);
    r.step(0); r.step(1); r.step(2);
    assert.equal(r.calls, 0, "the line is not even rated");
    assert.equal(r.el("line-bonus").textContent, "");
    assert.equal(r.el("line-bonus").className, "");
  }
});

test("lineBonus: shows under 'line' and 'both'", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  for (const mode of ["line", "both"]) {
    const r = lineRig({ "score.feedback": mode });
    r.step(0); r.step(1);
    assert.equal(r.calls, 1);
    assert.equal(r.el("line-bonus").textContent, "Perfect!");
    assert.ok(r.el("line-bonus").has("show"));
  }
});

test("lineBonus: turning line chips on mid-song rates the line that just finished", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const r = lineRig({ "score.feedback": "note" });
  const ranges = [];
  r.scorer.windowRatio = (from, to) => { ranges.push([from, to]); return 0.6; };
  r.step(0); r.step(1); r.step(2);
  r.settings.values["score.feedback"] = "line";
  r.step(3);
  assert.deepEqual(ranges, [[4, 6]], "line 2 (4–6 s), not a stale line from before the switch");
  assert.equal(r.el("line-bonus").textContent, "Good");
});

test("lineBonus: with a lagging scorer clock (mic latency) a finished line waits until the clock passes its end", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const r = lineRig({ "score.feedback": "line" });
  const ranges = [];
  r.scorer.windowRatio = (from, to) => { ranges.push([from, to]); return 0.95; };
  r.scorer.clock = 1.9;                       // the lyrics are at line 1 (2 s); the scorer is 100 ms behind
  r.step(0); r.step(1);
  assert.deepEqual(ranges, [], "line 0 is not rated while its last 100 ms are unscored");
  r.scorer.clock = 1.99; r.step(1);
  assert.deepEqual(ranges, [], "still before its end");
  r.scorer.clock = 2.0; r.step(1);
  assert.deepEqual(ranges, [[0, 2]], "rated once the scorer reaches the line's end — and only once");
  r.step(1); r.scorer.clock = 3; r.step(1);
  assert.equal(ranges.length, 1);
  assert.equal(r.el("line-bonus").textContent, "Perfect!");
});

test("lineBonus: a line still waiting when the next one finishes is rated then, never dropped", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const r = lineRig({ "score.feedback": "line" });
  const ranges = [];
  r.scorer.windowRatio = (from, to) => { ranges.push([from, to]); return 0.95; };
  r.scorer.clock = 0;
  r.step(0); r.step(1); r.step(2);            // line 0 waited; line 1 finished before the clock moved
  assert.deepEqual(ranges, [[0, 2]], "line 0 is rated when line 1 takes its place");
  r.scorer.clock = 4; r.step(2);
  assert.deepEqual(ranges, [[0, 2], [2, 4]]);
  r.sp.resetLineBonus(); r.scorer.clock = 99; r.step(3);
  assert.deepEqual(ranges, [[0, 2], [2, 4]], "a song boundary drops nothing stale into the next song");
});

test("resetLineBonus still clears the line chip and re-arms the guard", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const r = lineRig({ "score.feedback": "line" });
  r.step(0); r.step(1);
  r.sp.resetLineBonus();
  assert.equal(r.el("line-bonus").textContent, "");
  assert.ok(!r.el("line-bonus").has("show"));
  r.step(1);   // first sight of a line after a reset: nothing has finished yet
  assert.equal(r.calls, 1);
});

// --- PitchGuide.update micShiftSec ----------------------------------------------------------

function guideRig({ trail = true, win = 5, width = 1000 } = {}) {
  const calls = [];
  const state = {};
  const ctx = new Proxy(state, {
    get(target, prop) {
      if (prop in target) return target[prop];
      return (...args) => {
        calls.push({ fn: prop, args, fillStyle: target.fillStyle });
        return { addColorStop() {} };
      };
    },
    set(target, prop, value) { target[prop] = value; return true; },
  });
  const canvas = { getContext: () => ctx, getBoundingClientRect: () => ({ width, height: 150 }), width: 0, height: 0 };
  const settings = { get: (p) => ({ "guide.windowSec": win, "guide.trail": trail })[p] };
  const g = new PitchGuide(canvas, settings);
  // Two notes: C4 for 0–1 s, G4 for 1–2 s.
  g.load({ hasMelody: true, notes: [{ start: 0, end: 1, note: 60 }, { start: 1, end: 2, note: 67 }], range: { min: 58, max: 69 } });
  const dot = () => calls.filter((c) => c.fn === "arc").at(-1);
  return { g, calls, dot, width, win };
}
const NOW_FRAC = 0.28;   // melody.js's "now" line
// PitchGuide reads window (resize listener, devicePixelRatio). Node has none; each test file runs
// in its own process, so a stand-in here touches nothing else.
if (typeof globalThis.window === "undefined") globalThis.window = { devicePixelRatio: 1, addEventListener() {} };

test("PitchGuide.update: without a third argument the trace point is recorded at t", () => {
  const { g, dot, width } = guideRig();
  g.update(0.5, 60);
  g.update(0.6, 60.2);
  assert.deepEqual(g.trail.map((p) => p.t), [0.5, 0.6]);
  assert.equal(dot().args[0], NOW_FRAC * width, "the dot sits on the now line");
});

test("PitchGuide.update: micShiftSec records the trace point that much earlier", () => {
  const { g } = guideRig();
  g.update(0.5, 60, { micShiftSec: 0.1 });
  g.update(0.6, 60, { micShiftSec: 0.1 });
  assert.equal(g.trail.length, 2);
  assert.ok(Math.abs(g.trail[0].t - 0.4) < 1e-9 && Math.abs(g.trail[1].t - 0.5) < 1e-9, JSON.stringify(g.trail));
});

test("PitchGuide.update: the pitch dot moves to the shifted time and is judged against that note", () => {
  const { g, dot, width, win } = guideRig();
  // t = 1.05: the note at t is G4 (67), the note at t − 0.1 is C4 (60). Singing C:
  g.update(1.05, 60);
  assert.equal(dot().fillStyle, "#ffffff", "unshifted: C against G is off pitch");
  g.trail.length = 0;
  g.update(1.05, 60, { micShiftSec: 0.1 });
  assert.equal(dot().fillStyle, "#5dff9b", "shifted: C against the C the scorer judges is on pitch");
  const nowX = NOW_FRAC * width;
  assert.ok(Math.abs(dot().args[0] - (nowX - (0.1 / win) * width)) < 1e-6, `dot x ${dot().args[0]}`);
});

test("PitchGuide.update: a zero, negative, non-finite or missing shift is no shift", () => {
  for (const opts of [{ micShiftSec: 0 }, { micShiftSec: -0.2 }, { micShiftSec: NaN }, { micShiftSec: "0.1" }, {}, null]) {
    const { g, dot, width } = guideRig();
    g.update(0.5, 60, opts);
    assert.deepEqual(g.trail.map((p) => p.t), [0.5], JSON.stringify(opts));
    assert.equal(dot().args[0], NOW_FRAC * width);
  }
});

test("PitchGuide.update: seek-back detection compares shifted times (a steady shift never clears the trail)", () => {
  const { g } = guideRig();
  for (let t = 0.2; t < 1.0; t += 1 / 60) g.update(t, 61, { micShiftSec: 0.15 });
  const n = g.trail.length;
  assert.ok(n > 40, `steady frames all kept (${n})`);
  g.update(0.3, 61, { micShiftSec: 0.15 });   // a real seek back
  assert.equal(g.trail.length, 1, "a seek still clears it");

  // A seek back SHORTER than the shift: the new point lands 0.25 s behind the last one on the
  // melody timeline. Comparing the unshifted clock (0.75 vs 0.6 − 0.1) would miss it.
  const r = guideRig();
  r.g.update(1.0, 61, { micShiftSec: 0.4 });    // recorded at 0.6
  r.g.update(0.75, 61, { micShiftSec: 0.4 });   // recorded at 0.35
  assert.equal(r.g.trail.length, 1, "the trail never runs backwards");
  assert.ok(Math.abs(r.g.trail[0].t - 0.35) < 1e-9);
});

test("PitchGuide.update: no trail is recorded with the trail off, shifted or not", () => {
  const { g } = guideRig({ trail: false });
  g.update(0.5, 60, { micShiftSec: 0.1 });
  assert.equal(g.trail.length, 0);
});
