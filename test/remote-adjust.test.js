/*
 * remote-adjust.test.js — the phone's Now-tab steps and the toast words both screens use
 * (src/js/remote-adjust.js, Rae 2026-11-25): volume in tenths, melody Off · 25 · 50 · 75 · 100, the
 * key with its root ("D maj → E maj"), and one label per setting for the phone's and the TV's toast.
 * Run with:  node --test
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { stepVolume, stepMelody, fmtSemis, keyText, adjustLabel, VOLUME_STEP } from "../src/js/remote-adjust.js";

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
