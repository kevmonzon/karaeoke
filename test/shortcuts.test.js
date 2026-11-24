/*
 * shortcuts.test.js — customizable keyboard shortcuts: the binding table in keymap.js
 * (DEFAULT_BINDINGS, resolveBindings over untrusted overrides, keyToAction with a table, labels)
 * and the Settings list (src/js/ui/shortcuts-ui.js: planChange / removeKey, then the DOM part —
 * capture, conflict, Swap / Move / Remove / Cancel, Reset). The DOM runs against a small
 * hand-built fake: createElement, attributes, hidden, textContent, replaceChildren, closest(),
 * focus() with a capture-phase focusin, and a document whose keydown runs the CAPTURE listeners
 * before a stand-in for the key router (bubble). innerHTML is a trap.
 * Run with:  node --test
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  ACTIONS, DEFAULT_BINDINGS, SHORTCUT_ACTIONS, MAX_KEYS_PER_ACTION, TV_KEYCODES,
  resolveBindings, overridesFor, keyToAction, keyLabel, keyName, isRebindableKey, isFunctionKey,
} from "../src/js/ui/keymap.js";
import { createShortcutsUI, planChange, removeKey, ownerOf } from "../src/js/ui/shortcuts-ui.js";

const K = (key, more = {}) => ({ key, code: "", keyCode: 0, ctrlKey: false, metaKey: false, altKey: false, ...more });
const STAGE = { typing: false, inList: false, inSearch: false, modal: false };
const TYPING = { ...STAGE, typing: true };
const FIXED = ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Enter", "Escape", "BrowserBack", "GoBack",
  "Backspace", "Tab", "0", "1", "2", "3", "4", "5", "6", "7", "8", "9"];

// --- the default table ------------------------------------------------------------------------
test("shortcuts: DEFAULT_BINDINGS is frozen, complete and has no key twice", () => {
  assert.ok(Object.isFrozen(DEFAULT_BINDINGS));
  const ids = SHORTCUT_ACTIONS.map((a) => a.id);
  assert.deepEqual(Object.keys(DEFAULT_BINDINGS).sort(), [...ids].sort());
  const seen = new Map();
  for (const [id, keys] of Object.entries(DEFAULT_BINDINGS)) {
    assert.ok(Object.isFrozen(keys), id);
    for (const k of keys) {
      assert.ok(!seen.has(k), `${k} is on ${seen.get(k)} and ${id}`);
      seen.set(k, id);
      assert.ok(isRebindableKey(k), `${k} (${id}) must be a rebindable key`);
      if (k.length === 1) assert.equal(k, k.toLowerCase(), "single characters are stored lowercase");
    }
  }
  for (const k of FIXED) assert.ok(!seen.has(k), `fixed key ${k} is not a shortcut`);
});

test("shortcuts: the product owner's defaults", () => {
  const want = {
    F1: "searchToggle", F2: "melodyToggle", F3: "keyDown", F4: "keyUp", F5: "tempoDown", F6: "tempoUp",
    F8: "guideToggle", MediaPlayPause: "playPause", MediaTrackNext: "next",
  };
  for (const [key, action] of Object.entries(want)) {
    assert.ok(DEFAULT_BINDINGS[action].includes(key), `${key} → ${action}`);
    assert.deepEqual(keyToAction(K(key), STAGE), { action }, key);
  }
  // the existing shortcuts stay
  for (const [key, action] of [[" ", "playPause"], ["s", "openSearch"], ["/", "openSearch"], ["q", "openQueue"],
    ["m", "melodyToggle"], ["[", "offsetDown"], ["]", "offsetUp"], ["f", "fullscreen"], ["n", "next"],
    ["ColorF0Red", "openSearch"], ["ColorF1Green", "openQueue"], ["ColorF2Yellow", "bgNext"],
    ["ColorF3Blue", "melodyToggle"], ["ChannelUp", "keyUp"], ["ChannelDown", "keyDown"]]) {
    assert.equal(keyToAction(K(key), STAGE).action, action, key);
  }
  // the four new level actions exist but have no key yet
  for (const id of ["volumeUp", "volumeDown", "melodyUp", "melodyDown"]) assert.deepEqual(DEFAULT_BINDINGS[id], [], id);
  // toggleControls is retired with its `c`
  assert.ok(!ACTIONS.includes("toggleControls"));
  assert.equal(keyToAction(K("c"), STAGE), null);
  assert.equal(keyToAction(K("C", { shiftKey: true }), STAGE), null);
});

test("shortcuts: SHORTCUT_ACTIONS lists the rebindable actions only", () => {
  assert.ok(Object.isFrozen(SHORTCUT_ACTIONS));
  const ids = SHORTCUT_ACTIONS.map((a) => a.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.deepEqual([...ids].sort(), ACTIONS.filter((a) => !["nav", "back", "digit"].includes(a)).sort());
  for (const a of SHORTCUT_ACTIONS) {
    assert.ok(Object.isFrozen(a));
    assert.equal(typeof a.label, "string"); assert.ok(a.label.length > 0, a.id);
    assert.equal(typeof a.group, "string"); assert.ok(a.group.length > 0, a.id);
  }
  // a group is one run, so the list never repeats a heading
  const runs = SHORTCUT_ACTIONS.map((a) => a.group).filter((g, i, all) => g !== all[i - 1]);
  assert.equal(new Set(runs).size, runs.length);
});

// --- the F-keys while typing ------------------------------------------------------------------
test("shortcuts: F-keys map while typing (they type nothing); other shortcuts still do not", () => {
  assert.deepEqual(keyToAction(K("F1"), TYPING), { action: "searchToggle" });   // close Songs from its field
  assert.deepEqual(keyToAction(K("F5"), TYPING), { action: "tempoDown" });      // not a page reload
  assert.equal(keyToAction(K("F7"), TYPING), null);                             // unbound stays null
  for (const key of ["s", "q", " ", "MediaPlayPause", "ColorF0Red", "+"]) assert.equal(keyToAction(K(key), TYPING), null, key);
  const table = resolveBindings({ fullscreen: ["F11"], next: ["x"] });
  assert.deepEqual(keyToAction(K("F11"), TYPING, table), { action: "fullscreen" });
  assert.equal(keyToAction(K("x"), TYPING, table), null);
  assert.ok(isFunctionKey("F1") && isFunctionKey("F12") && isFunctionKey("F24"));
  assert.ok(!isFunctionKey("F0") && !isFunctionKey("F25") && !isFunctionKey("f1") && !isFunctionKey("Fn") && !isFunctionKey(1));
});

// --- resolveBindings: the stored value is untrusted -------------------------------------------
test("shortcuts: resolveBindings falls back to the defaults for anything unusable", () => {
  for (const bad of [undefined, null, "x", 5, true, [], [["next", ["x"]]], () => {}]) {
    assert.deepEqual(resolveBindings(bad), DEFAULT_BINDINGS, String(bad));
  }
  const t = resolveBindings({
    next: "x",                                   // not a list
    restart: [1, null, {}, ["p"]],               // nothing usable → defaults
    stop: ["ArrowUp", "Enter", "5", "Escape", "GoBack", "Backspace", "Tab", "Shift", "Unidentified", "", "Dead"],
    fullscreen: ["a".repeat(40)],                // too long
    bgNext: ["\u0007"],                          // a control character
    openQueue: ["has space", "<b>", "F1)"],      // not key names
    bogus: ["z"],                                // not an action
    nav: ["z"], back: ["z"], digit: ["z"],       // not rebindable
  });
  for (const id of ["next", "restart", "stop", "fullscreen", "bgNext", "openQueue"]) {
    assert.deepEqual(t[id], DEFAULT_BINDINGS[id], id);
  }
  assert.ok(!("bogus" in t) && !("nav" in t) && !("back" in t) && !("digit" in t));
  assert.equal(keyToAction(K("z"), STAGE, t), null);
});

test("shortcuts: resolveBindings cleans, keeps [] and is idempotent", () => {
  const t = resolveBindings({
    next: ["X", "x", "ArrowLeft", "F9"],         // lowercased, deduped, the fixed key dropped
    stop: [],                                    // deliberately no key
    keyUp: Array.from({ length: 20 }, (_, i) => `F${i + 1}`).concat(["F21"]),
  });
  assert.deepEqual(t.next, ["x", "F9"]);
  assert.deepEqual(t.stop, []);
  assert.equal(keyToAction(K("MediaStop"), STAGE, t), null);
  assert.equal(t.keyUp.length, MAX_KEYS_PER_ACTION);
  assert.ok(Object.isFrozen(t) && Object.isFrozen(t.next));
  assert.deepEqual(resolveBindings(t), t);
  assert.deepEqual(resolveBindings(DEFAULT_BINDINGS), DEFAULT_BINDINGS);
  // a JSON-parsed "__proto__" is just an unknown id
  const evil = JSON.parse('{"__proto__": {"next": ["z"]}, "constructor": ["z"]}');
  assert.deepEqual(resolveBindings(evil), DEFAULT_BINDINGS);
  assert.equal(({}).next, undefined);
});

test("shortcuts: one key, one action — an override takes it from a default", () => {
  // `f` is fullscreen's by default; an override on next claims it
  const t = resolveBindings({ next: ["f"] });
  assert.deepEqual(t.next, ["f"]);
  assert.deepEqual(t.fullscreen, []);
  assert.deepEqual(keyToAction(K("f"), STAGE, t), { action: "next" });
  assert.equal(keyToAction(K("n"), STAGE, t), null, "next's old key is gone");
  // two overrides on one key: the earlier action in SHORTCUT_ACTIONS keeps it
  const u = resolveBindings({ fullscreen: ["g"], playPause: ["g", " "] });
  assert.deepEqual(u.playPause, ["g", " "]);
  assert.deepEqual(u.fullscreen, []);
});

// --- keyToAction with a table -----------------------------------------------------------------
test("shortcuts: keyToAction follows the table; the fixed rules do not move", () => {
  const t = resolveBindings({ fullscreen: ["ColorF0Red", "F12"], openSearch: ["/", "s"], keyUp: ["ChannelUp", "u"] });
  assert.deepEqual(keyToAction(K("ColorF0Red"), STAGE, t), { action: "fullscreen" });
  // the TV keyCode fallback reaches a rebound colour / channel key
  assert.deepEqual(keyToAction(K("Unidentified", { keyCode: 403 }), STAGE, t), { action: "fullscreen" });
  assert.deepEqual(keyToAction(K("", { keyCode: 427 }), STAGE, t), { action: "keyUp" });
  assert.deepEqual(keyToAction(K("U", { shiftKey: true }), STAGE, t), { action: "keyUp" });
  assert.equal(keyToAction(K("f"), STAGE, t), null);
  // fixed keys cannot be taken, even by a hand-made table
  const raw = { next: ["ArrowUp", "5", "Enter", "Escape", "Backspace"], fullscreen: ["f"] };
  assert.deepEqual(keyToAction(K("ArrowUp"), STAGE, raw), { action: "nav", arg: "up" });
  assert.deepEqual(keyToAction(K("5"), STAGE, raw), { action: "digit", arg: 5 });
  assert.equal(keyToAction(K("Enter"), STAGE, raw), null);
  assert.deepEqual(keyToAction(K("Escape"), STAGE, raw), { action: "back" });
  assert.deepEqual(keyToAction(K("Backspace"), STAGE, raw), { action: "back" });
  assert.deepEqual(keyToAction(K("n"), STAGE, raw), { action: "next" }, "the unusable list fell back to next's defaults");
  // chords, Enter and the row's keys stay out whatever the table says
  const sp = resolveBindings({ next: ["x", " "] });
  assert.equal(keyToAction(K("x", { ctrlKey: true }), STAGE, sp), null);
  assert.equal(keyToAction(K(" "), { ...STAGE, inList: true }, sp), null);
  assert.deepEqual(keyToAction(K(" "), STAGE, sp), { action: "next" });
  // garbage in the table slot is the defaults
  assert.deepEqual(keyToAction(K("F1"), STAGE, null), { action: "searchToggle" });
  assert.deepEqual(keyToAction(K("F1"), STAGE, "nope"), { action: "searchToggle" });
});

test("shortcuts: MediaPlay / MediaPause keep their direction only on playPause", () => {
  assert.deepEqual(keyToAction(K("MediaPlay"), STAGE), { action: "playPause", arg: "play" });
  assert.deepEqual(keyToAction(K("Unidentified", { keyCode: 19 }), STAGE), { action: "playPause", arg: "pause" });
  const t = resolveBindings({ next: ["MediaPlay"] });
  assert.deepEqual(keyToAction(K("MediaPlay"), STAGE, t), { action: "next" });
  assert.deepEqual(keyToAction(K("MediaPause"), STAGE, t), { action: "playPause", arg: "pause" });
  assert.ok(!t.playPause.includes("MediaPlay"));
});

test("shortcuts: overridesFor stores only what differs, and round-trips", () => {
  assert.deepEqual(overridesFor(DEFAULT_BINDINGS), {});
  assert.deepEqual(overridesFor(resolveBindings({})), {});
  const t = resolveBindings({ next: ["f"], volumeUp: ["F9"] });
  const o = overridesFor(t);
  assert.deepEqual(o, { next: ["f"], volumeUp: ["F9"], fullscreen: [] });
  assert.deepEqual(resolveBindings(o), t);
  assert.deepEqual(JSON.parse(JSON.stringify(o)), o, "plain JSON, fit for localStorage");
});

// --- labels and names -------------------------------------------------------------------------
test("shortcuts: keyLabel, keyName, isRebindableKey", () => {
  const want = {
    F1: "F1", " ": "Space", ColorF0Red: "Red", ColorF1Green: "Green", ColorF2Yellow: "Yellow", ColorF3Blue: "Blue",
    MediaPlayPause: "Play/Pause", MediaPlay: "Play", MediaPause: "Pause", MediaTrackNext: "Next track",
    s: "S", "/": "/", "[": "[", PageDown: "Page Down", ChannelUp: "Channel +", Pause: "Pause/Break",
  };
  for (const [key, label] of Object.entries(want)) assert.equal(keyLabel(key), label, key);
  assert.equal(keyLabel(""), ""); assert.equal(keyLabel(null), ""); assert.equal(keyLabel(7), "");

  assert.equal(keyName(K("S", { shiftKey: true })), "s");
  assert.equal(keyName(K("Unidentified", { keyCode: 403 })), "ColorF0Red");
  assert.equal(keyName(K("", { keyCode: 10009 })), "GoBack");
  assert.equal(keyName(K("Unidentified", { keyCode: 999 })), "");
  assert.equal(keyName(null), "");
  for (const k of Object.values(TV_KEYCODES)) assert.equal(isRebindableKey(k), k !== "GoBack", k);
  for (const k of FIXED) assert.equal(isRebindableKey(k), false, k);
  for (const k of ["s", "S", " ", "F5", "MediaPlayPause", "AudioVolumeUp", "Delete", ";"]) assert.ok(isRebindableKey(k), k);
  for (const k of ["Shift", "Control", "Meta", "Alt", "Dead", "Process", "Unidentified", "", null, 3]) {
    assert.equal(isRebindableKey(k), false, String(k));
  }
});

// --- planChange / removeKey (pure) ------------------------------------------------------------
test("shortcuts: planChange — a free key replaces in place or is added", () => {
  const t = resolveBindings({});
  const r = planChange(t, { action: "next", oldKey: "n", newKey: "x" });
  assert.equal(r.kind, "ok");
  assert.deepEqual(r.table.next, ["x", "MediaTrackNext"], "the replaced key keeps its place");
  const a = planChange(t, { action: "volumeUp", newKey: "F9" });
  assert.deepEqual(a.table.volumeUp, ["F9"]);
  assert.deepEqual(t.next, ["n", "MediaTrackNext"], "the input is not changed");
});

test("shortcuts: planChange — a taken key: Swap gives the owner the old key, Move takes it away", () => {
  const t = resolveBindings({});
  const s = planChange(t, { action: "next", oldKey: "n", newKey: "s" });
  assert.equal(s.kind, "conflict");
  assert.equal(s.owner, "openSearch");
  assert.equal(s.gets, "n");
  assert.deepEqual(s.table.next, ["s", "MediaTrackNext"]);
  assert.deepEqual(s.table.openSearch, ["/", "n", "ColorF0Red"], "the owner takes n where s was");
  assert.equal(ownerOf(resolveBindings(s.table), "s"), "next");

  const m = planChange(t, { action: "volumeUp", newKey: "f" });
  assert.equal(m.kind, "conflict");
  assert.equal(m.owner, "fullscreen");
  assert.equal(m.gets, null);
  assert.deepEqual(m.table.volumeUp, ["f"]);
  assert.deepEqual(m.table.fullscreen, [], "adding moves the key: its owner may end with none");
});

test("shortcuts: planChange — no-ops and the action's own keys", () => {
  const t = resolveBindings({});
  assert.equal(planChange(t, { action: "next", oldKey: "n", newKey: "n" }).kind, "noop");
  assert.equal(planChange(t, { action: "next", newKey: "n" }).kind, "noop", "adding a key it has");
  const own = planChange(t, { action: "next", oldKey: "n", newKey: "MediaTrackNext" });
  assert.equal(own.kind, "ok");
  assert.deepEqual(own.table.next, ["MediaTrackNext"], "changing to a key it already has drops the old one");
  for (const bad of ["ArrowUp", "Enter", "5", "Escape", "Tab", "", null]) {
    assert.equal(planChange(t, { action: "next", oldKey: "n", newKey: bad }).kind, "noop", String(bad));
  }
  assert.equal(planChange(t, { action: "nav", newKey: "x" }).kind, "noop");
  const full = resolveBindings({ volumeUp: ["F13", "F14", "F15", "F16", "F17", "F18", "F19", "F20"] });
  assert.equal(planChange(full, { action: "volumeUp", newKey: "F21" }).kind, "noop", "a full list takes no more");
  assert.equal(planChange(full, { action: "volumeUp", oldKey: "F13", newKey: "F21" }).kind, "ok", "but can change one");
  assert.deepEqual(removeKey(t, "playPause", "k").playPause, [" ", "MediaPlayPause", "MediaPlay", "MediaPause"]);
  assert.deepEqual(t.playPause.length, 5);
});

// --- a minimal fake DOM -----------------------------------------------------------------------
class El {
  constructor(doc, tag) {
    Object.assign(this, { doc, tagName: tag.toUpperCase(), className: "", attrs: new Map(),
      children: [], parentElement: null, ls: {}, ownText: "" });
  }
  get classList() {
    const set = () => new Set(this.className.split(/\s+/).filter(Boolean));
    return {
      add: (c) => { const s = set(); s.add(c); this.className = [...s].join(" "); },
      remove: (c) => { const s = set(); s.delete(c); this.className = [...s].join(" "); },
      contains: (c) => set().has(c),
    };
  }
  get hidden() { return this.attrs.has("hidden"); }
  set hidden(v) { if (v) this.attrs.set("hidden", ""); else this.attrs.delete("hidden"); }
  get textContent() { return this.ownText + this.children.map((c) => c.textContent).join(""); }
  set textContent(v) { this.detachAll(); this.ownText = String(v); }
  set innerHTML(_) { this.doc.htmlWrites++; throw new Error("innerHTML must not be used"); }
  insertAdjacentHTML() { this.doc.htmlWrites++; throw new Error("insertAdjacentHTML must not be used"); }
  setAttribute(k, v) { this.attrs.set(k, String(v)); }
  getAttribute(k) { return this.attrs.has(k) ? this.attrs.get(k) : null; }
  hasAttribute(k) { return this.attrs.has(k); }
  removeAttribute(k) { this.attrs.delete(k); }
  detachAll() { for (const c of this.children) c.parentElement = null; this.children = []; }
  appendChild(c) {
    if (c.parentElement) c.parentElement.children = c.parentElement.children.filter((x) => x !== c);
    c.parentElement = this; this.children.push(c); return c;
  }
  replaceChildren(...cs) { this.detachAll(); this.ownText = ""; for (const c of cs) this.appendChild(c); }
  get isConnected() { let n = this; while (n.parentElement) n = n.parentElement; return n === this.doc.root; }
  matches(sel) {
    return sel.split(",").map((s) => s.trim()).some((s) => {
      if (s[0] === "[") return this.hasAttribute(s.slice(1, -1));
      if (s[0] === ".") return this.className.split(/\s+/).includes(s.slice(1));
      return this.tagName === s.toUpperCase();
    });
  }
  closest(sel) { for (let n = this; n; n = n.parentElement) if (n.matches(sel)) return n; return null; }
  contains(o) { for (let n = o; n; n = n.parentElement) if (n === this) return true; return false; }
  *walk() { for (const c of this.children) { yield c; yield* c.walk(); } }
  all(sel) { return [...this.walk()].filter((e) => e.matches(sel)); }
  one(sel) { return this.all(sel)[0] || null; }
  addEventListener(t, fn) { (this.ls[t] ||= []).push(fn); }
  focus() {
    this.doc.activeElement = this;
    this.doc.dispatch("focusin", { target: this });
  }
  // a tap: pointerdown (document, capture) moves focus, then the click bubbles to the container
  click() {
    this.doc.dispatch("pointerdown", { target: this });
    this.focus();
    const ev = { type: "click", target: this };
    for (let n = this; n; n = n.parentElement) for (const fn of n.ls.click || []) fn(ev);
    return ev;
  }
}
function makeDoc() {
  const doc = { htmlWrites: 0, activeElement: null, capture: {}, bubble: {}, routerSaw: [] };
  doc.createElement = (tag) => new El(doc, tag);
  doc.root = doc.createElement("body");
  doc.addEventListener = (t, fn, capture) => { ((capture ? doc.capture : doc.bubble)[t] ||= []).push(fn); };
  doc.removeEventListener = (t, fn, capture) => {
    const m = capture ? doc.capture : doc.bubble;
    m[t] = (m[t] || []).filter((f) => f !== fn);
  };
  // the document's own listeners: capture first, then bubble (the key router lives there)
  doc.dispatch = (type, props) => {
    const ev = {
      type, defaultPrevented: false, stopped: false, key: "", code: "", keyCode: 0,
      ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, repeat: false, ...props,
      preventDefault() { ev.defaultPrevented = true; },
      stopImmediatePropagation() { ev.stopped = true; },
      stopPropagation() { ev.stopped = true; },
    };
    for (const fn of [...(doc.capture[type] || [])]) { fn(ev); if (ev.stopped) return ev; }
    for (const fn of [...(doc.bubble[type] || [])]) { fn(ev); if (ev.stopped) return ev; }
    return ev;
  };
  doc.addEventListener("keydown", (e) => doc.routerSaw.push(keyName(e) || e.key));   // the key router
  doc.key = (key, more = {}) => doc.dispatch("keydown", { key, target: doc.activeElement, ...more });
  doc.keyup = (key, more = {}) => doc.dispatch("keyup", { key, target: doc.activeElement, ...more });
  return doc;
}
// --- end of the fake DOM ----------------------------------------------------------------------

function rig(stored = undefined) {
  const doc = makeDoc();
  const panel = doc.root.appendChild(doc.createElement("div"));   // the Settings panel
  const el = panel.appendChild(doc.createElement("div"));
  const saved = [];
  let overrides = stored;
  const ui = createShortcutsUI({
    el, doc,
    getOverrides: () => overrides,
    setOverrides: (o) => { saved.push(o); overrides = o; },
  });
  ui.render();
  const row = (id) => el.all(".sc-row").find((r) => r.getAttribute("data-action") === id);
  const keysOf = (id) => row(id).all(".sc-key").map((b) => b.getAttribute("data-key"));
  const chip = (id, key) => row(id).all(".sc-key").find((b) => b.getAttribute("data-key") === key);
  const add = (id) => row(id).one(".sc-add");
  const prompt = () => el.one(".sc-prompt");
  const act = (what) => prompt().all("button").find((b) => b.getAttribute("data-do") === what);
  const store = (o) => { overrides = o; };   // the setting changed behind the UI's back
  return { doc, panel, el, ui, saved, row, keysOf, chip, add, prompt, act, store, get overrides() { return overrides; } };
}

test("shortcuts UI: lists every rebindable action with its keys, grouped, without innerHTML", () => {
  const s = rig();
  const rows = s.el.all(".sc-row");
  assert.deepEqual(rows.map((r) => r.getAttribute("data-action")), SHORTCUT_ACTIONS.map((a) => a.id));
  for (const { id, label } of SHORTCUT_ACTIONS) {
    assert.equal(s.row(id).one(".sc-label").textContent, label);
    assert.deepEqual(s.keysOf(id), [...DEFAULT_BINDINGS[id]], id);
    assert.ok(s.row(id).classList.contains("row"), "Settings search indexes .row");
  }
  assert.deepEqual(s.row("searchToggle").all(".sc-key").map((b) => b.textContent), ["F1"]);
  assert.deepEqual(s.row("openSearch").all(".sc-key").map((b) => b.textContent), ["/", "S", "Red"]);
  assert.equal(s.row("volumeUp").one(".sc-none").textContent, "No key");
  assert.deepEqual(s.el.all(".sc-group").map((g) => g.textContent), [...new Set(SHORTCUT_ACTIONS.map((a) => a.group))]);
  for (const b of s.el.all("button")) assert.equal(b.getAttribute("type"), "button");
  assert.equal(s.prompt().hidden, true);
  assert.ok(s.el.one(".sc-reset"));
  assert.equal(s.doc.htmlWrites, 0);
  // render() again changes nothing and keeps the same row elements (the Settings search holds them)
  const before = [...s.el.all(".sc-row"), ...s.el.all(".sc-key")];
  s.ui.render();
  const after = [...s.el.all(".sc-row"), ...s.el.all(".sc-key")];
  assert.ok(before.length === after.length && before.every((n, i) => n === after[i]));
});

test("shortcuts UI: Change takes the next key and never lets it reach the router", () => {
  const s = rig();
  s.chip("tempoDown", ",").click();
  assert.equal(s.prompt().hidden, false);
  assert.ok(s.row("tempoDown").contains(s.prompt()), "the prompt sits in the row being changed");
  assert.equal(s.doc.activeElement, s.act("cancel"), "focus on Cancel: an accidental OK does nothing");
  assert.ok(s.chip("tempoDown", ",").hasAttribute("data-capturing"));
  const ev = s.doc.key("x", { code: "KeyX" });
  assert.equal(ev.defaultPrevented, true);
  assert.equal(ev.stopped, true);
  assert.deepEqual(s.doc.routerSaw, [], "the router never saw it");
  assert.deepEqual(s.saved, [{ tempoDown: ["x", "F5"] }]);
  assert.deepEqual(s.keysOf("tempoDown"), ["x", "F5"]);
  assert.equal(s.doc.activeElement, s.chip("tempoDown", "x"), "focus on the new key");
  assert.equal(s.prompt().hidden, true);
  assert.match(s.el.one(".sc-status").textContent, /X → Tempo/);
  // its keyup is swallowed too; after that, keys go to the app again
  const up = s.doc.keyup("x", { code: "KeyX" });
  assert.equal(up.defaultPrevented, true);
  assert.equal(s.doc.key("x").defaultPrevented, false);
  assert.deepEqual(s.doc.routerSaw, ["x"]);
});

test("shortcuts UI: F5 while capturing is taken, not a reload", () => {
  const s = rig();
  s.add("volumeDown").click();
  const ev = s.doc.key("F5", { code: "F5" });
  assert.equal(ev.defaultPrevented, true);
  assert.equal(s.prompt().hidden, false, "F5 is tempo − already: Move or Cancel");
  const tempoDown = SHORTCUT_ACTIONS.find((a) => a.id === "tempoDown").label;
  assert.equal(s.prompt().one(".sc-msg").textContent, `F5 is already \u201c${tempoDown}\u201d. Move it here?`);
  assert.equal(s.act("swap").textContent, "Move", "adding: the other action just loses it");
  assert.deepEqual(s.saved, []);
  s.act("swap").click();
  assert.deepEqual(s.overrides, { volumeDown: ["F5"], tempoDown: [","] });
  assert.equal(s.doc.activeElement, s.chip("volumeDown", "F5"));
});

test("shortcuts UI: Back cancels — swallowed, so Settings stays open", () => {
  for (const ev of [{ key: "Escape" }, { key: "BrowserBack" }, { key: "Backspace" },
    { key: "Unidentified", keyCode: 461 }, { key: "", keyCode: 10009 }]) {
    const s = rig();
    s.chip("next", "n").click();
    const e = s.doc.key(ev.key, ev);
    assert.equal(e.defaultPrevented, true, ev.key);
    assert.deepEqual(s.doc.routerSaw, [], `${ev.key}/${ev.keyCode} never reached the router`);
    assert.equal(s.prompt().hidden, true);
    assert.equal(s.doc.activeElement, s.chip("next", "n"), "focus back on the key");
    assert.ok(!s.chip("next", "n").hasAttribute("data-capturing"));
    assert.deepEqual(s.saved, []);
  }
});

test("shortcuts UI: digits and nameless keys are refused; capture goes on", () => {
  const s = rig();
  s.chip("next", "n").click();
  for (const ev of [{ key: "5", code: "Digit5" }, { key: "Unidentified", code: "Numpad5" }]) {
    const e = s.doc.key(ev.key, ev);
    assert.equal(e.defaultPrevented, true, "a digit would open Songs: swallowed");
    assert.match(s.prompt().one(".sc-msg").textContent, /song number/);
  }
  s.doc.key("Unidentified", { keyCode: 999 });
  assert.match(s.prompt().one(".sc-msg").textContent, /no key name/);
  assert.deepEqual(s.doc.routerSaw, []);
  assert.equal(s.prompt().hidden, false);
  s.doc.key("j");
  assert.deepEqual(s.overrides, { next: ["j", "MediaTrackNext"] });
});

test("shortcuts UI: arrows, Enter and Tab pass through; chords too, with a reason; modifiers silently", () => {
  const s = rig();
  s.chip("next", "n").click();
  for (const key of ["ArrowLeft", "Enter", "Tab"]) {
    const e = s.doc.key(key);
    assert.equal(e.defaultPrevented, false, key);
  }
  assert.deepEqual(s.doc.routerSaw, ["ArrowLeft", "Enter", "Tab"], "spatial nav / OK / focus keep working");
  const chord = s.doc.key("r", { metaKey: true });
  assert.equal(chord.defaultPrevented, false, "Cmd+R is still the browser's");
  assert.match(s.prompt().one(".sc-msg").textContent, /single keys/);
  const msg = s.prompt().one(".sc-msg").textContent;
  s.doc.key("Shift", { shiftKey: true });
  assert.equal(s.prompt().one(".sc-msg").textContent, msg);
  assert.equal(s.prompt().hidden, false, "still capturing");
  // Shift+S is "s"
  s.doc.key("S", { shiftKey: true });
  assert.equal(s.prompt().one(".sc-msg").textContent.startsWith("S is already"), true);
});

test("shortcuts UI: a taken key — Swap gives the other action the old key; Cancel stores nothing", () => {
  const s = rig();
  s.chip("next", "n").click();
  s.doc.key("s");
  assert.match(s.prompt().one(".sc-msg").textContent, /S is already “Open song search”\. Swap, and “Open song search” gets N\?/);
  assert.equal(s.doc.activeElement, s.act("swap"), "focus on Swap");
  assert.equal(s.act("swap").textContent, "Swap");
  assert.deepEqual(s.saved, [], "nothing stored before the choice");
  s.act("cancel").click();
  assert.deepEqual(s.saved, []);
  assert.equal(s.prompt().hidden, true);
  assert.equal(s.doc.activeElement, s.chip("next", "n"));

  s.chip("next", "n").click();
  s.doc.key("s");
  s.act("swap").click();
  assert.deepEqual(s.overrides, { next: ["s", "MediaTrackNext"], openSearch: ["/", "n", "ColorF0Red"] });
  assert.deepEqual(s.keysOf("openSearch"), ["/", "n", "ColorF0Red"]);
  assert.equal(s.doc.activeElement, s.chip("next", "s"));
  assert.match(s.el.one(".sc-status").textContent, /S → Next song; N → Open song search/);
});

test("shortcuts UI: another key while asking replaces the question", () => {
  const s = rig();
  s.chip("next", "n").click();
  s.doc.key("s");
  assert.equal(s.prompt().hidden, false);
  s.doc.key("j");
  assert.deepEqual(s.overrides, { next: ["j", "MediaTrackNext"] });
  assert.equal(s.prompt().hidden, true);
});

test("shortcuts UI: Remove drops the key being changed", () => {
  const s = rig();
  s.chip("playPause", "k").click();
  assert.equal(s.act("remove").textContent, "Remove K");
  s.act("remove").click();
  assert.deepEqual(s.overrides, { playPause: [" ", "MediaPlayPause", "MediaPlay", "MediaPause"] });
  assert.equal(s.chip("playPause", "k"), undefined);
  assert.equal(s.doc.activeElement, s.add("playPause"), "focus stays in the row");
  // the last key goes too: "No key", and ＋ holds focus
  s.chip("stop", "MediaStop").click();
  s.act("remove").click();
  assert.equal(s.row("stop").one(".sc-none").textContent, "No key");
  assert.equal(s.doc.activeElement, s.add("stop"));
});

test("shortcuts UI: Reset restores the defaults and keeps focus", () => {
  const s = rig({ next: ["j"], fullscreen: ["F9"] });
  assert.deepEqual(s.keysOf("next"), ["j"]);
  const reset = s.el.one(".sc-reset");
  reset.click();
  assert.deepEqual(s.saved.at(-1), {});
  assert.deepEqual(s.keysOf("next"), ["n", "MediaTrackNext"]);
  assert.deepEqual(s.keysOf("fullscreen"), ["f"]);
  assert.equal(s.doc.activeElement, reset);
  assert.match(s.el.one(".sc-status").textContent, /defaults/);
});

test("shortcuts UI: a TV remote's nameless colour key is stored by name", () => {
  const s = rig();
  s.add("volumeUp").click();
  s.doc.key("Unidentified", { keyCode: 406 });   // Blue: melodyToggle's
  s.act("swap").click();                          // Move
  assert.deepEqual(s.overrides, { volumeUp: ["ColorF3Blue"], melodyToggle: ["m", "F2"] });
  assert.deepEqual(keyToAction(K("Unidentified", { keyCode: 406 }), STAGE, resolveBindings(s.overrides)), { action: "volumeUp" });
});

test("shortcuts UI: focus leaving the prompt, or Settings going away, ends the capture", () => {
  const s = rig();
  s.chip("next", "n").click();
  s.chip("fullscreen", "f").focus();             // an arrow moved focus to another row
  assert.equal(s.prompt().hidden, true);
  assert.equal(s.doc.key("x").defaultPrevented, false, "keys reach the app again");

  const t = rig();
  t.chip("next", "n").click();
  t.panel.hidden = true;                          // Settings closed under the capture
  const e = t.doc.key("x");
  assert.equal(e.defaultPrevented, false);
  assert.deepEqual(t.doc.routerSaw, ["x"]);
  assert.deepEqual(t.saved, []);

  const u = rig();
  u.chip("next", "n").click();
  u.ui.cancel();
  assert.equal(u.prompt().hidden, true);
  assert.equal(u.doc.activeElement, u.chip("next", "n"));
  assert.equal(u.doc.key("x").defaultPrevented, false);
});

test("shortcuts UI: a held key's repeats are swallowed and ignored", () => {
  const s = rig();
  s.chip("next", "n").click();
  const e = s.doc.key("Enter", { repeat: true });  // OK still held from pressing the key
  assert.equal(e.defaultPrevented, true);
  assert.equal(s.prompt().hidden, false, "Cancel was not pressed");
  s.doc.key("x", { repeat: true });
  assert.deepEqual(s.saved, []);
});

test("shortcuts UI: a garbage stored value shows the defaults", () => {
  for (const stored of ["{oops", 42, null, [], { next: "n", bogus: ["x"] }]) {
    const s = rig(stored);
    for (const { id } of SHORTCUT_ACTIONS) assert.deepEqual(s.keysOf(id), [...DEFAULT_BINDINGS[id]], `${JSON.stringify(stored)} ${id}`);
  }
});

test("shortcuts UI: an outside change re-renders only the rows that changed, keeping focus", () => {
  const s = rig();
  const untouched = s.chip("fullscreen", "f");
  s.chip("next", "MediaTrackNext").focus();
  s.store({ next: ["MediaTrackNext"] });   // e.g. app data imported while Settings is open
  s.ui.render();
  assert.equal(s.chip("fullscreen", "f"), untouched, "an unchanged row keeps its elements");
  assert.deepEqual(s.keysOf("next"), ["MediaTrackNext"]);
  assert.equal(s.doc.activeElement, s.chip("next", "MediaTrackNext"), "focus follows its key into the redrawn row");
  s.store({ next: [] });
  s.ui.render();
  assert.equal(s.doc.activeElement, s.add("next"), "its key gone: focus on \uFF0B, never <body>");
  // a capture open during an outside render ends, focus back on its key
  s.chip("fullscreen", "f").click();
  s.store({});
  s.ui.render();
  assert.equal(s.prompt().hidden, true);
  assert.equal(s.doc.activeElement, s.chip("fullscreen", "f"));
  assert.equal(s.doc.key("x").defaultPrevented, false);
  assert.deepEqual(s.saved, [], "render() never writes the setting");
});
