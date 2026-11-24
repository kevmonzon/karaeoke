/*
 * easter-egg.test.js — the Konami code (src/js/easter-egg.js, Rae 2026-11-25): how a keydown is
 * spelled, the rolling matcher, and the watcher on a fake window — it consumes only the final Enter,
 * ignores typing and held keys, shows one picture at a time and takes it away after EGG_MS.
 * The image module is never loaded here (loadImage is injected).
 * Run with:  node --test
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { KONAMI, EGG_MS, eggKey, createSequenceMatcher, installEasterEgg } from "../src/js/easter-egg.js";

const CODE = ["ArrowUp", "ArrowUp", "ArrowDown", "ArrowDown", "ArrowLeft", "ArrowRight", "ArrowLeft", "ArrowRight", "a", "b", "Enter"];

test("KONAMI is up up down down left right left right A B Enter", () => {
  assert.deepEqual([...KONAMI], CODE);
  assert.equal(EGG_MS, 5000);
});

test("eggKey: letters any case, either Enter, TV keyCodes", () => {
  assert.equal(eggKey({ key: "A" }), "a");
  assert.equal(eggKey({ key: "b" }), "b");
  assert.equal(eggKey({ key: "NumpadEnter" }), "Enter");
  assert.equal(eggKey({ key: "ArrowUp" }), "ArrowUp");
  assert.equal(eggKey({ key: "Unidentified", keyCode: 38 }), "ArrowUp");
  assert.equal(eggKey({ key: "", keyCode: 13 }), "Enter");
  assert.equal(eggKey({ key: "", keyCode: 66 }), "b");
  assert.equal(eggKey(null), "");
});

test("the matcher: exactly the code, once, then it starts over", () => {
  const m = createSequenceMatcher();
  const hits = CODE.map((k) => m.feed(k));
  assert.deepEqual(hits, [...Array(10).fill(false), true]);
  assert.equal(m.feed("Enter"), false, "a lone Enter after a hit is not another hit");
  assert.equal(CODE.map((k) => m.feed(k)).at(-1), true, "the whole code again → again");
});

test("the matcher: a stray key costs only what came before it", () => {
  const m = createSequenceMatcher();
  for (const k of ["ArrowUp", "ArrowUp", "ArrowUp"]) m.feed(k);          // one ↑ too many
  assert.equal(CODE.slice(2).map((k) => m.feed(k)).at(-1), true, "↑ ↑ ↑ ↓ ↓ … still counts");
  const n = createSequenceMatcher();
  for (const k of CODE.slice(0, 8)) n.feed(k);
  n.feed("x");                                                           // a wrong key mid-code
  assert.equal(n.feed("a") || n.feed("b") || n.feed("Enter"), false);
  n.reset();
  assert.equal(CODE.map((k) => n.feed(k)).at(-1), true);
});

// --- the watcher on a fake window ------------------------------------------------------------
function rig({ active = null } = {}) {
  const listeners = [];
  const win = {
    addEventListener: (type, fn, capture) => listeners.push({ type, fn, capture }),
    removeEventListener: (type, fn) => { const i = listeners.findIndex((l) => l.fn === fn); if (i >= 0) listeners.splice(i, 1); },
  };
  const body = { kids: [], appendChild(n) { this.kids.push(n); n.parent = this; } };
  const el = (tag) => ({ tag, className: "", attrs: {}, kids: [], parent: null,
    setAttribute(k, v) { this.attrs[k] = v; }, appendChild(n) { this.kids.push(n); n.parent = this; },
    remove() { if (this.parent) this.parent.kids = this.parent.kids.filter((x) => x !== this); this.parent = null; } });
  const doc = { body, activeElement: active, createElement: el };
  const timers = [];
  let loads = 0;
  const egg = installEasterEgg({
    win, doc,
    loadImage: async () => { loads++; return "data:image/png;base64,AAAA"; },
    setTimer: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
    clearTimer: () => {},
  });
  const press = (key, extra = {}) => {
    const ev = { key, repeat: false, prevented: false, stopped: false, ...extra,
      preventDefault() { this.prevented = true; }, stopPropagation() { this.stopped = true; } };
    for (const l of listeners) if (l.type === "keydown") l.fn(ev);
    return ev;
  };
  const tick = () => new Promise((r) => setTimeout(r, 0));
  return { win, doc, body, egg, press, timers, listeners, tick, get loads() { return loads; } };
}

test("watcher: listens in the capture phase; only the code's final Enter is consumed", async () => {
  const r = rig();
  assert.equal(r.listeners.length, 1);
  assert.equal(r.listeners[0].capture, true, "capture: sees the keys before any widget can swallow them");
  const evs = CODE.map((k) => r.press(k));
  assert.deepEqual(evs.map((e) => e.prevented), [...Array(10).fill(false), true], "arrows / A / B pass through untouched");
  assert.equal(evs.at(-1).stopped, true);
  await r.tick();
  assert.equal(r.loads, 1, "the picture loads only now");
  assert.equal(r.body.kids.length, 1);
  const egg = r.body.kids[0];
  assert.equal(egg.className, "egg");
  assert.equal(egg.attrs["aria-hidden"], "true");
  const img = egg.kids[0].kids[0];
  assert.equal(img.className, "egg-img");
  assert.equal(img.alt, "");
  assert.match(img.src, /^data:image\/png;base64,/);
  assert.equal(r.timers.at(-1).ms, EGG_MS);
  r.timers.at(-1).fn();
  assert.equal(r.body.kids.length, 0, "gone after 5 s");
});

test("watcher: one picture at a time; the code again afterwards plays again", async () => {
  const r = rig();
  CODE.forEach((k) => r.press(k));
  await r.tick();
  CODE.forEach((k) => r.press(k));
  await r.tick();
  assert.equal(r.body.kids.length, 1, "the code mid-dance adds no second picture");
  r.timers[0].fn();
  CODE.forEach((k) => r.press(k));
  await r.tick();
  assert.equal(r.body.kids.length, 1, "after it left, the code works again");
});

test("watcher: typing in a field and held keys never count", async () => {
  const r = rig({ active: { tagName: "INPUT", type: "search" } });
  const last = CODE.map((k) => r.press(k)).at(-1);
  await r.tick();
  assert.equal(last.prevented, false, "an Enter in the search box stays the search box's");
  assert.equal(r.body.kids.length, 0);
  const s = rig({ active: { tagName: "INPUT", type: "range" } });   // a slider is not typing
  CODE.forEach((k) => s.press(k));
  await s.tick();
  assert.equal(s.body.kids.length, 1);
  const h = rig();
  h.press("ArrowUp");
  h.press("ArrowUp", { repeat: true });                              // held, not pressed twice
  CODE.slice(2).forEach((k) => h.press(k));
  await h.tick();
  assert.equal(h.body.kids.length, 0);
});

test("watcher: uninstall stops listening and clears the stage", async () => {
  const r = rig();
  CODE.forEach((k) => r.press(k));
  await r.tick();
  r.egg.uninstall();
  assert.equal(r.listeners.length, 0);
  assert.equal(r.body.kids.length, 0);
});
