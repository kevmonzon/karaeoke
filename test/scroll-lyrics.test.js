/*
 * scroll-lyrics.test.js — the scroll lyric style in the stage look (Rae, 2026-11-24): how a
 * syllable is cut into word pieces (lyrics.js sylPieces), the bracket rule both engines share
 * (lyric-pager.js splitParens), and LyricsSwitch handing the stage engine's colour / outline /
 * shadow to the scroll column (lyrics-stage.js). The DOM drawing itself is checked in a browser.
 * Run with:  node --test
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { sylPieces } from "../src/js/lyrics.js";
import { splitParens, prepareStageLines } from "../src/js/lyric-pager.js";
import { LyricsSwitch } from "../src/js/lyrics-stage.js";

const near = (a, b) => Math.abs(a - b) < 1e-9;

test("sylPieces: one word → one piece with the whole syllable's time", () => {
  const p = sylPieces("Bar", 10, 10.5);
  assert.equal(p.length, 1);
  assert.deepEqual({ ...p[0] }, { text: "Bar", word: true, t: 10, e: 10.5 });
});

test("sylPieces: a line-timed syllable is cut into words, each with its share of the time by position", () => {
  // "I love you" = 10 characters over 10 s → I [0,1) · ' ' [1,2) · love [2,6) · ' ' [6,7) · you [7,10)
  const p = sylPieces("I love you", 0, 10);
  assert.deepEqual(p.map((x) => x.text), ["I", " ", "love", " ", "you"]);
  assert.deepEqual(p.map((x) => x.word), [true, false, true, false, true]);
  assert.ok(near(p[0].t, 0) && near(p[0].e, 1));
  assert.ok(near(p[2].t, 2) && near(p[2].e, 6));
  assert.ok(near(p[4].t, 7) && near(p[4].e, 10));
  // the pieces tile the syllable: each starts where the previous ended
  for (let i = 1; i < p.length; i++) assert.ok(near(p[i].t, p[i - 1].e), `piece ${i}`);
  // no word piece ever holds a space (its sung copy must never wrap away from it)
  assert.ok(p.filter((x) => x.word).every((x) => !/\s/.test(x.text)));
});

test("sylPieces: leading / trailing spaces become plain pieces; junk input is safe", () => {
  assert.deepEqual(sylPieces("na, ", 1, 2).map((x) => [x.text, x.word]), [["na,", true], [" ", false]]);
  assert.deepEqual(sylPieces("  so", 0, 4).map((x) => [x.text, x.word]), [["  ", false], ["so", true]]);
  assert.deepEqual(sylPieces("", 0, 1), []);
  assert.deepEqual(sylPieces(null, 0, 1), []);
  const back = sylPieces("ab", 5, 3);            // an end before the start: no negative durations
  assert.ok(back.every((x) => x.e >= x.t && x.t === 5));
});

test("splitParens: brackets removed, backing syllables flagged, an open bracket closes at the line end", () => {
  const out = splitParens([
    { time: 1, text: "I " }, { time: 2, text: "(ooh " }, { time: 3, text: "yeah) " }, { time: 4, text: "go " },
    { time: 5, text: "(" }, { time: 6, text: "la " }, { time: 7, text: "la" },
  ]);
  assert.deepEqual(out.map((s) => [s.text, s.paren]),
    [["I ", false], ["ooh ", true], ["yeah ", true], ["go ", false], ["la ", true], ["la", true]]);
  assert.equal(out.length, 6, "a syllable that was only a bracket is dropped");
  const kept = splitParens([{ time: 1, text: "(x)", end: 9, extra: "kept" }]);
  assert.deepEqual({ ...kept[0] }, { time: 1, text: "x", end: 9, extra: "kept", paren: true });
  assert.deepEqual(splitParens(undefined), []);
  // the stage engine's lines use the same rule (the refactor changed nothing there)
  const st = prepareStageLines([{ start: 0, end: 1, syllables: [{ time: 0, text: "a " }, { time: 1, text: "(b)" }] }]);
  assert.deepEqual(st[0].syllables.map((s) => [s.text, s.paren]), [["a ", false], ["b", true]]);
});

// A stage engine and a scroll engine with just the surface LyricsSwitch uses.
function rig({ withLook = true } = {}) {
  const looks = [];
  const stage = {
    color: "#0000ff", opts: { outline: 6, shadow: true }, enabled: false,
    container: { classList: { toggle() {} } },
    redraw() {}, setOptions(o) { Object.assign(this.opts, o); if (o.color) this.color = o.color; },
    loadLines() { this.color = "#123456"; return true; },   // a per-song random pick
    load() { return true; }, loadDoc() { return true; },
  };
  const scroll = {
    setOptions() {}, loadLines() { return true; }, load() { return true; },
    ...(withLook ? { setLook: (l) => looks.push({ ...l }) } : {}),
  };
  return { stage, scroll, looks };
}

test("LyricsSwitch hands the stage look to the scroll column: at once, on option changes, after every load", () => {
  const r = rig();
  const sw = new LyricsSwitch(r.scroll, r.stage, "scroll");
  assert.deepEqual(r.looks.at(-1), { color: "#0000ff", outline: 6, shadow: true });
  sw.setStageOptions({ color: "#ff0000", outline: 3, shadow: false });
  assert.deepEqual(r.looks.at(-1), { color: "#ff0000", outline: 3, shadow: false });
  sw.loadLines([]);
  assert.equal(r.looks.at(-1).color, "#123456", "a new song's random colour reaches the column");
  const n = r.looks.length;
  sw.load({});
  sw.loadDoc({ lines: [] });
  assert.equal(r.looks.length, n + 2);
});

test("LyricsSwitch: a scroll engine without setLook is left alone", () => {
  const r = rig({ withLook: false });
  const sw = new LyricsSwitch(r.scroll, r.stage, "stage");
  assert.doesNotThrow(() => { sw.setStageOptions({ outline: 2 }); sw.loadLines([]); });
});
