/*
 * remote-prefs.test.js — the phone's device-local prefs (src/js/remote-prefs.js, Rae 2026-11-28:
 * "default lyrics settings - scroll style and 6 lines"): a new phone gets Scroll + 6 lines, a phone
 * saved before the change is moved there ONCE, and a guest's later choice sticks.
 * Run with:  node --test
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { readPrefs, defaultPrefs, DEFAULT_PREFS, LYRIC_DEFAULTS_REV } from "../src/js/remote-prefs.js";

test("a new phone: Scroll, 6 lines, and nothing to save", () => {
  for (const saved of [null, undefined, "", "null"]) {
    const { prefs, migrated } = readPrefs(saved);
    assert.equal(prefs.lyricStyle, "scroll", String(saved));
    assert.equal(prefs.lyricLines, 6);
    assert.equal(prefs.lyricDefaults, LYRIC_DEFAULTS_REV);
    assert.equal(migrated, false, "nothing was saved, so nothing moves");
  }
  assert.equal(DEFAULT_PREFS.lyricStyle, "scroll");
  assert.equal(DEFAULT_PREFS.lyricLines, 6);
});

test("a phone saved with the old defaults is moved once, keeping everything else", () => {
  const old = JSON.stringify({ nickname: "Kai", theme: "light", text: "l", room: "ABC123", lyricNudgeMs: 75,
    lyricLines: 4, lyricScale: 1.2, lyricStyle: "stage", namedRooms: ["ABC123"] });
  const { prefs, migrated } = readPrefs(old);
  assert.equal(migrated, true, "the caller saves it");
  assert.equal(prefs.lyricStyle, "scroll");
  assert.equal(prefs.lyricLines, 6);
  assert.equal(prefs.lyricDefaults, LYRIC_DEFAULTS_REV);
  assert.deepEqual(
    { n: prefs.nickname, t: prefs.theme, x: prefs.text, r: prefs.room, ms: prefs.lyricNudgeMs, sc: prefs.lyricScale, rooms: prefs.namedRooms },
    { n: "Kai", t: "light", x: "l", r: "ABC123", ms: 75, sc: 1.2, rooms: ["ABC123"] });
  // …and once saved, it is not moved again: a guest's own Stage / 3 lines stick.
  const again = readPrefs(JSON.stringify({ ...prefs, lyricStyle: "stage", lyricLines: 3 }));
  assert.equal(again.migrated, false);
  assert.equal(again.prefs.lyricStyle, "stage");
  assert.equal(again.prefs.lyricLines, 3);
});

test("an older marker is moved too (bumping LYRIC_DEFAULTS_REV moves every phone again)", () => {
  const { prefs, migrated } = readPrefs(JSON.stringify({ lyricStyle: "stage", lyricLines: 2, lyricDefaults: LYRIC_DEFAULTS_REV - 1 }));
  assert.equal(migrated, true);
  assert.equal(prefs.lyricStyle, "scroll");
  assert.equal(prefs.lyricLines, 6);
});

test("junk is the defaults; a junk style is Scroll; prototypes are never touched", () => {
  for (const junk of ["{", "42", "[1,2]", "\"text\"", "true"]) {
    const { prefs, migrated } = readPrefs(junk);
    assert.equal(migrated, false, junk);
    assert.deepEqual(prefs, defaultPrefs(), junk);
  }
  const odd = readPrefs(JSON.stringify({ lyricStyle: "karaoke", lyricDefaults: LYRIC_DEFAULTS_REV, namedRooms: "ABC" }));
  assert.equal(odd.prefs.lyricStyle, "scroll");
  assert.deepEqual(odd.prefs.namedRooms, [], "a non-array namedRooms is reset");
  const evil = readPrefs('{"__proto__": {"polluted": true}, "nickname": "x"}');
  assert.equal(Object.getPrototypeOf(evil.prefs), Object.prototype, "a saved __proto__ is an own key, not a prototype");
  assert.equal(({}).polluted, undefined);
  assert.equal(evil.prefs.polluted, undefined);
});

test("every copy owns its namedRooms (the defaults are never mutated)", () => {
  const a = defaultPrefs();
  const b = readPrefs(null).prefs;
  a.namedRooms.push("ABC123");
  assert.deepEqual(b.namedRooms, []);
  assert.deepEqual(DEFAULT_PREFS.namedRooms, []);
  assert.ok(Object.isFrozen(DEFAULT_PREFS));
});
