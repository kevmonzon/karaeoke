// The lyric document the host publishes for phones (M7, plan §5.14): lyrics-doc.js, plus the
// stage engine's loadDoc / source pair and LyricsSwitch's pass-throughs (lyrics-stage.js).
import { test } from "node:test";
import assert from "node:assert/strict";

import { LYRICS_DOC_V, buildLyricsDoc, parseLyricsDoc } from "../src/js/lyrics-doc.js";
import { prepareStageLines, buildCountdowns, makeBeatAt, STAGE } from "../src/js/lyric-pager.js";
import { buildLyrics, makeTickToSeconds } from "../src/js/lyrics.js";
import { parseLrc } from "../src/js/lyrics-formats.js";
import { StageLyricsEngine, LyricsSwitch } from "../src/js/lyrics-stage.js";

const syl = (time, text) => ({ time, text });
const line = (singer, ...pairs) => ({
  start: pairs[0][0], end: pairs[pairs.length - 1][0], singer,
  syllables: pairs.map(([t, x]) => syl(t, x)),
});

// Deep equality where every number may differ by the document's millisecond rounding.
function assertClose(actual, expected, path = "") {
  if (typeof expected === "number") {
    assert.ok(typeof actual === "number" && Math.abs(actual - expected) < 0.0015, `${path}: ${actual} vs ${expected}`);
  } else if (expected && typeof expected === "object") {
    assert.equal(typeof actual, "object", path);
    assert.deepEqual(Object.keys(actual).sort(), Object.keys(expected).sort(), `${path} keys`);
    for (const k of Object.keys(expected)) assertClose(actual[k], expected[k], `${path}.${k}`);
  } else {
    assert.equal(actual, expected, path);
  }
}

// A stage engine without a canvas: the prototype's load paths only need these fields, and with
// `enabled` false redraw() never paints.
function bareStage() {
  const e = Object.create(StageLyricsEngine.prototype);
  Object.assign(e, { opts: { color: "#0000FF", randomColor: false }, enabled: false, _cache: new Map(), container: null });
  return e;
}

test("round trip keeps lines, singers, cues", () => {
  const lines = [
    line("", [1, "Bar"], [1.5, "ce"], [2, "lo"], [2.5, "na, "]),
    line("w", [4, "(oh "], [4.5, "oh)"]),
    line("m", [6, "We "], [6.25, "sing"]),
    line("c", [8, "to"], [8.5, "ge"], [9, "ther"]),
  ];
  const cues = [0, 0.25, 0.5, 0.75];
  const doc = buildLyricsDoc({ id: "midi:1", lines, cues, beats: [[0, 0.5]], duration: 200 });
  assert.equal(doc.v, LYRICS_DOC_V);
  assert.equal(doc.kind, "lines");
  assert.equal(doc.id, "midi:1");
  assert.equal(doc.dur, 200);
  // The common "" singer is left out of the document (size); the others ride along.
  assert.equal("s" in doc.lines[0], false);
  assert.deepEqual(doc.lines.slice(1).map((l) => l.s), ["w", "m", "c"]);

  const back = parseLyricsDoc(JSON.parse(JSON.stringify(doc)));   // it crosses the network as JSON
  assert.deepEqual(back.lines, lines, "the raw-line shape, start / end / singer / syllables included");
  assert.deepEqual(back.cues, cues);
  assert.equal(back.duration, 200);
  assert.equal(back.kind, "lines");
});

test("times are rounded to milliseconds", () => {
  const doc = buildLyricsDoc({
    id: "x",
    lines: [line("", [1.23456789, "a"], [2.0004999, "b"])],
    cues: [0.1234567],
    beats: [[0.0004, 0.4285714285]],
    duration: 180.123456,
  });
  assert.deepEqual(doc.lines[0].y, [[1.235, "a"], [2, "b"]]);
  assert.deepEqual(doc.cues, [0.123]);
  assert.equal(doc.dur, 180.123);
  assert.deepEqual(doc.beats, [[0, 0.428571]], "a beat length keeps microseconds (a MIDI tempo is whole µs)");
  // A start/end the syllables already imply is not carried at all.
  assert.equal("b" in doc.lines[0] || "e" in doc.lines[0], false);
});

test("beatAt steps through the tempo list", () => {
  const back = parseLyricsDoc(buildLyricsDoc({
    id: "x", lines: [line("", [1, "a"])],
    beats: [[10, 0.4], [0, 0.5], [20, 0.6], [20, 0.75]],   // unsorted on purpose; equal times keep order
  }));
  assert.equal(back.beatAt(0), 0.5);
  assert.equal(back.beatAt(9.999), 0.5);
  assert.equal(back.beatAt(10), 0.4, "an entry applies AT its own time");
  assert.equal(back.beatAt(19.5), 0.4);
  assert.equal(back.beatAt(20), 0.75, "the last entry at a time wins, as makeBeatAt picks");
  assert.equal(back.beatAt(1e6), 0.75);
  assert.equal(back.beatAt(-1), STAGE.DEFAULT_BEAT, "before the first entry: 120 bpm");
  assert.deepEqual(back.beats, [[0, 0.5], [10, 0.4], [20, 0.6], [20, 0.75]]);
});

test("empty beats default to 120 bpm", () => {
  const back = parseLyricsDoc(buildLyricsDoc({ id: "x", lines: [line("", [1, "a"])] }));
  assert.equal(back.beatAt(0), 0.5);
  assert.equal(back.beatAt(123), 0.5);
  // Junk tempo entries are dropped, not trusted.
  const junk = parseLyricsDoc({ v: 1, id: "x", kind: "lines", lines: [{ y: [[1, "a"]] }], beats: [[1, 0], [2, -1], ["3", 0.4], [NaN, 0.4], 5], dur: 0 });
  assert.deepEqual(junk.beats, []);
  assert.equal(junk.beatAt(2), 0.5);
});

test("baked and none kinds carry no lines", () => {
  const lines = [line("", [1, "a"])];
  const baked = buildLyricsDoc({ id: "video:9", kind: "baked", lines, cues: [1], beats: [[0, 0.5]], duration: 60 });
  assert.deepEqual(baked, { v: 1, id: "video:9", kind: "baked", lines: [], cues: [], beats: [], dur: 60 });
  assert.equal(buildLyricsDoc({ id: "x" }).kind, "none", "no lines → none");
  assert.equal(buildLyricsDoc({ id: "x", kind: "lines", lines: [] }).kind, "none", "an empty 'lines' document is 'none'");
  assert.equal(buildLyricsDoc({ id: "x", lines }).kind, "lines", "lines → lines by default");
  assert.equal(buildLyricsDoc({ id: "x", kind: "weird", lines }).kind, "lines", "an unknown kind falls back to the default");
  const parsed = parseLyricsDoc(JSON.parse(JSON.stringify(baked)));
  assert.equal(parsed.kind, "baked");
  assert.deepEqual(parsed.lines, []);
  assert.equal(parsed.beatAt(5), 0.5);
  assert.equal(parsed.duration, 60);
});

test("a wrong version parses to null", () => {
  const doc = buildLyricsDoc({ id: "x", lines: [line("", [1, "a"])] });
  assert.ok(parseLyricsDoc(doc));
  assert.equal(parseLyricsDoc({ ...doc, v: 2 }), null);
  assert.equal(parseLyricsDoc({ ...doc, v: "1" }), null);
  assert.equal(parseLyricsDoc({ ...doc, v: undefined }), null);
});

test("junk parses to null", () => {
  for (const junk of [null, undefined, 0, 1, "", "doc", true, [], [1, 2], () => {}, { v: 1 },
    { v: 1, kind: "lines" }, { v: 1, kind: "lines", lines: "nope" }, { v: 1, kind: "karaoke", lines: [] }]) {
    assert.equal(parseLyricsDoc(junk), null, `junk: ${String(junk)}`);
  }
  // A getter that throws never escapes.
  const evil = { v: 1, kind: "lines", get lines() { throw new Error("boom"); } };
  assert.equal(parseLyricsDoc(evil), null);
  // buildLyricsDoc never throws on junk either.
  for (const junk of [null, undefined, 7, "x", { lines: "nope" }, { lines: [null, 3, {}, { syllables: "x" }] }]) {
    assert.equal(buildLyricsDoc(junk).kind, "none");
  }
});

test("a malformed line or syllable inside a valid document is dropped, not fatal", () => {
  const back = parseLyricsDoc({
    v: 1, id: "x", kind: "lines", dur: -3,
    lines: [
      { y: [[2, "two"]], s: "zz" },                                   // unknown singer → ""
      null, 5, { y: "nope" }, { y: [] }, { y: [["1", "a"], [1, ""], [NaN, "b"], [1, 2]] },
      { y: [[1, "one"], "junk", [1.5, "x".repeat(2000)]], s: "m", b: 0.5 },
    ],
    cues: [3, "4", null, 1],
  });
  assert.deepEqual(back.lines.map((l) => l.syllables.map((s) => s.text.length)), [[3, 500], [3]], "sorted by start; the long text is capped");
  assert.equal(back.lines[0].start, 0.5, "an explicit start (b) is honoured");
  assert.equal(back.lines[0].singer, "m");
  assert.equal(back.lines[1].singer, "");
  assert.deepEqual(back.cues, [1, 3]);
  assert.equal(back.duration, 0);
});

test("a 400-line song stays under 60 KB", () => {
  // Denser than real songs: over 2,980 real KAR files the p95 is ~99 bytes of JSON per line and the
  // largest document 53.6 KB (685 lines). Here: 400 lines × 6 syllables, 4-digit seconds with ms
  // fractions, every third line tagged, 20 count-in cues and a 50-step tempo map.
  const lines = [];
  for (let i = 0; i < 400; i++) {
    const t0 = 3 + i * 2.987654321;
    const syls = [];
    for (let j = 0; j < 6; j++) syls.push(syl(t0 + j * 0.41234567, ["la ", "love ", "night ", "oh ", "baby ", "(yeah) "][j]));
    lines.push({ start: t0, end: syls[5].time, singer: i % 3 === 0 ? "w" : "", syllables: syls });
  }
  const cues = Array.from({ length: 20 }, (_, i) => 60 * i + 0.123456);
  const beats = Array.from({ length: 50 }, (_, i) => [i * 24.123456, 0.4 + (i % 7) * 0.012345]);
  const doc = buildLyricsDoc({ id: "midi:12345", lines, cues, beats, duration: 1203.456789 });
  const bytes = Buffer.byteLength(JSON.stringify(doc));
  assert.ok(bytes < 60_000, `${bytes} bytes`);
  assert.ok(bytes < 400_000, "and far under the relay's SONG_DOC_MAX");
  assert.equal(parseLyricsDoc(JSON.parse(JSON.stringify(doc))).lines.length, 400);
});

test("the stage view of a round trip matches the source even on exact-beat boundaries", () => {
  // Quantised MIDI puts syllables exactly 4 beats apart and lines exactly 3 s in, and float noise
  // in the 15th digit decides the stage rule on the HOST. Plain ms rounding flips both cases below
  // (measured: 0.2% of real syllables, in 36% of real songs); the document must not.
  const gapA = 116.72833333333334, gapB = 118.32833333333333;   // 1.5999999999999943 apart: NOT > 4 × 0.4
  const lines = [
    { start: 3.0000000000000004, end: 3.5, singer: "", syllables: [syl(3.0000000000000004, "First "), syl(3.5, "line")] },
    { start: 115, end: gapA, singer: "", syllables: [syl(115, "a "), syl(gapA, "b ")] },
    { start: gapB, end: gapB + 0.4, singer: "", syllables: [syl(gapB, "c "), syl(gapB + 0.4, "d")] },
  ];
  const beats = [[0, 0.75], [100, 0.4]];
  const srcBeat = makeBeatAt([{ tick: 0, usPerQuarter: 750000 }, { tick: 100, usPerQuarter: 400000 }], (t) => t);
  const A = prepareStageLines(lines, srcBeat);
  assert.equal(A[0].start > STAGE.FIRST_COUNTDOWN_AFTER, true, "the host gives the first line a count-in");
  assert.equal(A[1].syllables[1].end, gapB, "and does not cap the 4-beat gap");

  const back = parseLyricsDoc(JSON.parse(JSON.stringify(buildLyricsDoc({ id: "x", lines, beats }))));
  const B = prepareStageLines(back.lines, back.beatAt);
  assert.equal(B.length, A.length);
  A.forEach((l, k) => l.syllables.forEach((s, j) => {
    assert.ok(Math.abs(s.end - B[k].syllables[j].end) < 0.005, `line ${k} syllable ${j}: ${s.end} vs ${B[k].syllables[j].end}`);
  }));
  const cdA = buildCountdowns(A, [], srcBeat), cdB = buildCountdowns(B, back.cues, back.beatAt);
  assert.deepEqual(cdB.map((c) => [c.line, c.beats.length]), cdA.map((c) => [c.line, c.beats.length]));
  // …and the nudge that bought it is a millisecond or two, never more.
  back.lines.forEach((l, k) => l.syllables.forEach((s, j) => assert.ok(Math.abs(s.time - lines[k].syllables[j].time) <= 0.0035)));
});

test("an enhanced-LRC line keeps its own start, so the scroll view lines up too", () => {
  const { lines } = parseLrc("[00:10.00]<00:10.50>Hel<00:10.90>lo\n[00:12.00]World\n");
  assert.equal(lines[0].start, 10);
  assert.equal(lines[0].syllables[0].time, 10.5, "the first word comes after the line's stamp");
  const doc = buildLyricsDoc({ id: "audio:1", lines });
  assert.equal(doc.lines[0].b, 10, "carried as b, because the syllables do not imply it");
  assert.equal("b" in doc.lines[1], false);
  assert.deepEqual(parseLyricsDoc(doc).lines.map((l) => [l.start, l.end]), lines.map((l) => [l.start, l.end]));
});

test("StageLyricsEngine.source feeds buildLyricsDoc, and loadDoc round-trips it", () => {
  // A small parsed MIDI: 480 ppqn, 120 bpm then 150 bpm from tick 1920 (2 s), '#' count-in cues.
  const parsed = {
    ppqn: 480, isSmpte: false,
    tempoMap: [{ tick: 0, usPerQuarter: 500000 }, { tick: 1920, usPerQuarter: 400000 }],
    lyricEvents: [
      ...[960, 1440].map((tick) => ({ tick, type: 0x05, text: "#" })),
      { tick: 1920, type: 0x05, text: "/@w Hel" }, { tick: 2400, type: 0x05, text: "lo " },
      { tick: 4800, type: 0x05, text: "/F: wor" }, { tick: 5280, type: 0x05, text: "ld" },
    ],
  };
  const stage = bareStage();
  assert.deepEqual(stage.source, { lines: [], cues: [], beats: [] }, "never loaded: empty, not undefined");
  assert.equal(stage.load(parsed), true);
  const src = stage.source;
  const t2s = makeTickToSeconds(parsed);
  assert.deepEqual(src.lines, buildLyrics(parsed.lyricEvents, t2s).lines, "the RAW lines, singer tags included");
  assert.deepEqual(src.cues, [1, 1.5]);
  assert.deepEqual(src.beats, [[0, 0.5], [2, 0.4]], "the tempo map, flattened");

  const doc = buildLyricsDoc({ id: "midi:7", lines: src.lines, cues: src.cues, beats: src.beats });
  const phone = bareStage();
  assert.equal(phone.loadDoc(parseLyricsDoc(JSON.parse(JSON.stringify(doc)))), true);
  assertClose(phone.lines, stage.lines, "the phone's stage lines are the host's");
  assertClose(phone.plan.countdowns, stage.plan.countdowns, "countdowns");
  assertClose(phone.plan.anchors, stage.plan.anchors, "row anchors");
  assert.deepEqual(buildLyricsDoc({ id: "midi:7", ...phone.source }), doc, "and source after loadDoc rebuilds the same document");

  // loadLines (a sidecar) has no tempo map; clear() empties the source.
  stage.loadLines([line("", [1, "a"])]);
  assert.deepEqual(stage.source.beats, []);
  assert.deepEqual(stage.source.cues, []);
  stage.clear();
  assert.deepEqual(stage.source.lines, []);
  assert.equal(phone.loadDoc({}), false, "an empty document loads as no lyrics");
});

test("LyricsSwitch.loadDoc gives the stage engine the document and the scroll view the same lines", () => {
  const calls = [];
  const scroll = { loadLines: (l) => { calls.push(["scroll", l]); return true; }, setOptions() {} };
  const stage = {
    container: { classList: { toggle() {} } }, redraw() {}, enabled: true,
    loadDoc: (d) => { calls.push(["stage", d]); return false; },
    get source() { return "stage-source"; },
  };
  const sw = new LyricsSwitch(scroll, stage, "stage");
  const parsed = parseLyricsDoc(buildLyricsDoc({ id: "x", lines: [line("m", [1, "a"])], cues: [0.5] }));
  assert.equal(sw.loadDoc(parsed), false, "the ACTIVE engine's answer (stage)");
  assert.equal(calls[0][0], "scroll");
  assert.equal(calls[0][1], parsed.lines);
  assert.equal(calls[1][1], parsed);
  sw.setStyle("scroll");
  assert.equal(sw.loadDoc(parsed), true, "…or the scroll view's");
  assert.equal(sw.source, "stage-source", "source is always the stage engine's (the host's doc input)");
  assert.equal(sw.loadDoc(null), true, "junk is an empty document, not a throw");
});
