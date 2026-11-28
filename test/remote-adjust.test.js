/*
 * remote-adjust.test.js — the phone's Now-tab steps and the toast words both screens use
 * (src/js/remote-adjust.js, Rae 2026-11-25): volume in tenths, melody Off · 25 · 50 · 75 · 100, the
 * key with its root ("D maj → E maj"), and one label per setting for the phone's and the TV's toast.
 * Run with:  node --test
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  stepVolume, stepMelody, fmtSemis, keyText, adjustLabel, VOLUME_STEP,
  stepNudge, fmtMs, nudgeLabel, NUDGE_STEP_MS, NUDGE_MAX_MS,
} from "../src/js/remote-adjust.js";
import { readFileSync } from "node:fs";

test("stepVolume: tenths, snapped, clamped to 0..100 %", () => {
  assert.equal(VOLUME_STEP, 0.1);
  assert.equal(stepVolume(0.9, 1), 1);
  assert.equal(stepVolume(1, 1), 1, "never past 100 %");
  assert.equal(stepVolume(0.9, -1), 0.8);
  assert.equal(stepVolume(0, -1), 0, "never under 0");
  assert.equal(stepVolume(0.87, 1), 1, "an off-grid volume (the TV's slider) snaps to the grid first");
  assert.equal(stepVolume(0.84, -1), 0.7);
  assert.equal(stepVolume(0.3, 1), 0.4, "no float drift (0.30000000000000004)");
  assert.equal(stepVolume(undefined, -1), 0.8, "no value yet → from the 90 % default");
});

test("stepMelody: one level per step, Off keeps the volume, the ends hold", () => {
  assert.deepEqual(stepMelody(1, false, -1), { level: 3, settings: { volume: 0.75, mute: false } });
  assert.deepEqual(stepMelody(0.25, false, -1), { level: 0, settings: { mute: true } }, "Off is mute only");
  assert.deepEqual(stepMelody(0.5, true, 1), { level: 1, settings: { volume: 0.25, mute: false } }, "from Off, up is 25 %");
  assert.deepEqual(stepMelody(1, false, 1), { level: 4, settings: { volume: 1, mute: false } }, "100 % holds");
  assert.deepEqual(stepMelody(0.5, true, -1), { level: 0, settings: { mute: true } }, "Off holds");
});

test("fmtSemis: the TV's spelling", () => {
  assert.equal(fmtSemis(2), "+2");
  assert.equal(fmtSemis(0), "0");
  assert.equal(fmtSemis(-3), "-3");
  assert.equal(fmtSemis("x"), "0");
});

test("keyText: the root key, and where Key ± takes it", () => {
  const D = { pc: 2, mode: "major" };
  assert.equal(keyText(0, D), "D maj");
  assert.equal(keyText(2, D), "D maj → E maj");
  assert.equal(keyText(-3, { pc: 9, mode: "minor" }), "A min → F♯ min");
  assert.equal(keyText(12, D), "D maj → D maj", "an octave is the same key name");
  assert.equal(keyText(2, null), "", "no key known (video / YouTube / audio) → nothing");
  assert.equal(keyText(2, { pc: "D" }), "", "junk from the wire → nothing");
});

test("adjustLabel: one line per setting, the same on the phone and the TV", () => {
  assert.equal(adjustLabel("audio.volume", 0.8), "Volume 80%");
  assert.equal(adjustLabel("audio.key", 2, { key: { pc: 2, mode: "major" } }), "Key +2 · D maj → E maj");
  assert.equal(adjustLabel("audio.key", -1), "Key -1", "no key known → the number alone");
  assert.equal(adjustLabel("audio.tempo", 1.05), "Tempo 1.05×");
  const get = (p) => ({ "guide.vocal.volume": 0.5, "guide.vocal.mute": false })[p];
  assert.equal(adjustLabel("guide.vocal.volume", 0.5, { get }), "Melody 50%");
  assert.equal(adjustLabel("guide.vocal.mute", true, { get: (p) => (p === "guide.vocal.mute" ? true : 0.5) }), "Melody Off");
  assert.equal(adjustLabel("lyrics.offsetMs", 50), "Lyric offset +50 ms");
  assert.equal(adjustLabel("mic.volume", 1), null, "a path nobody toasts");
});

// --- the Lyrics tab's sync nudge (Rae, 2026-11-28: − value + like the Now tab) ---------------------
test("stepNudge: 25 ms steps, snapped to the grid, held at ±1000 ms", () => {
  assert.equal(NUDGE_STEP_MS, 25);
  assert.equal(NUDGE_MAX_MS, 1000);
  assert.equal(stepNudge(0, 1), 25);
  assert.equal(stepNudge(0, -1), -25);
  assert.equal(stepNudge(25, -1), 0);
  assert.equal(stepNudge(-25, 1), 0);
  assert.equal(stepNudge(990, 1), 1000, "never past +1000");
  assert.equal(stepNudge(1000, 1), 1000);
  assert.equal(stepNudge(-1000, -1), -1000, "never past -1000");
  assert.equal(stepNudge(5000, -1), 1000, "an out-of-range saved value is pulled back to the end (as stepVolume does)");
  assert.equal(stepNudge(37, 1), 50, "an off-grid value snaps to the grid first");
  assert.equal(stepNudge(-12, -1), -25);
  for (const junk of [undefined, null, NaN, "x", Infinity]) assert.equal(stepNudge(junk, 1), 25, String(junk));
  // A whole walk stays on the grid and inside the range.
  let v = 0;
  for (let i = 0; i < 60; i++) { v = stepNudge(v, 1); assert.equal(v % 25, 0); }
  assert.equal(v, 1000);
});

test("fmtMs / nudgeLabel: signed milliseconds, the phone's toast", () => {
  assert.equal(fmtMs(50), "+50 ms");
  assert.equal(fmtMs(0), "0 ms");
  assert.equal(fmtMs(-25), "-25 ms");
  assert.equal(fmtMs(undefined), "0 ms");
  assert.equal(nudgeLabel(75), "Sync nudge +75 ms");
  assert.equal(nudgeLabel(-1000), "Sync nudge -1000 ms");
  assert.equal(adjustLabel("lyrics.offsetMs", -50), "Lyric offset -50 ms", "the room offset reads the same way");
});

test("the Lyrics tab's nudge is a stepper, not a slider (structure: remote.js boots a DOM on import)", () => {
  const read = (p) => readFileSync(new URL(p, import.meta.url), "utf8");
  const html = read("../src/remote.html");
  const js = read("../src/js/remote.js");
  assert.doesNotMatch(html, /id="l-nudge"/, "the range is gone");
  assert.match(html, /<span class="stepper"><button id="l-nudge-down"[^>]*>–<\/button>\s*<em id="l-nudge-val" class="sval"[^>]*>0 ms<\/em>\s*<button id="l-nudge-up"[^>]*>\+<\/button><\/span>/);
  assert.match(js, /\$\("l-nudge-down"\)\.onclick = \(\) => stepLyricNudge\(-1\)/);
  assert.match(js, /\$\("l-nudge-up"\)\.onclick = \(\) => stepLyricNudge\(1\)/);
  assert.doesNotMatch(js, /cmd\(\{[^}]*lyricNudgeMs/, "the nudge is never sent to the TV");
});
