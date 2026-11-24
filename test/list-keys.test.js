/*
 * list-keys.test.js — the key path's integration seams (M4, lane I).
 *
 *   1. listKeyPlan (library-ui.js, pure): the song list owns its movement keys but not its edges,
 *      so an arrow that leaves the list is handed to spatial navigation exactly once.
 *   2. The list's keydown handler really uses it (a fake <ul>): an edge is not prevented and calls
 *      onEdge once; a move inside is prevented; printable keys are left alone; ★ / ＋ are not stops.
 *   3. The control bar's `c` toggle and Back-hide (shell.js): the shell pokes the bar on EVERY
 *      keydown, so these must give the same result whichever document listener runs first.
 * Run with:  node --test
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { listKeyPlan, createLibraryUI } from "../src/js/library-ui.js";
import { createOverlayStack } from "../src/js/ui/overlay-stack.js";
import { createShell } from "../src/js/ui/shell.js";

// --- 1. listKeyPlan ----------------------------------------------------------------------
test("list keys: a list edge hands the key to spatial nav exactly once", () => {
  assert.deepEqual(listKeyPlan("ArrowDown", 4, 5), { move: null, edge: "down", prevent: false });
  assert.deepEqual(listKeyPlan("ArrowUp", 0, 5), { move: null, edge: "up", prevent: false });
  // A one-row list: both ends at once.
  assert.deepEqual(listKeyPlan("ArrowDown", 0, 1), { move: null, edge: "down", prevent: false });
  assert.deepEqual(listKeyPlan("ArrowUp", 0, 1), { move: null, edge: "up", prevent: false });
});

test("list keys: inside the list the key is consumed", () => {
  assert.deepEqual(listKeyPlan("ArrowDown", 0, 5), { move: 1, edge: null, prevent: true });
  assert.deepEqual(listKeyPlan("ArrowUp", 3, 5), { move: 2, edge: null, prevent: true });
  assert.deepEqual(listKeyPlan("Home", 3, 5), { move: 0, edge: null, prevent: true });
  assert.deepEqual(listKeyPlan("End", 1, 5), { move: 4, edge: null, prevent: true });
});

test("list keys: left and right always leave the list", () => {
  for (const [i, n] of [[0, 1], [0, 5], [2, 5], [4, 5], [0, 0]]) {
    assert.deepEqual(listKeyPlan("ArrowLeft", i, n), { move: null, edge: "left", prevent: false });
    assert.deepEqual(listKeyPlan("ArrowRight", i, n), { move: null, edge: "right", prevent: false });
  }
});

test("list keys: PageUp / PageDown / Home / End clamp and are consumed even at an end", () => {
  assert.deepEqual(listKeyPlan("PageDown", 0, 100), { move: 10, edge: null, prevent: true });
  assert.deepEqual(listKeyPlan("PageDown", 95, 100), { move: 99, edge: null, prevent: true });
  assert.deepEqual(listKeyPlan("PageUp", 4, 100), { move: 0, edge: null, prevent: true });
  assert.deepEqual(listKeyPlan("PageUp", 0, 100), { move: 0, edge: null, prevent: true });   // never an edge
  assert.deepEqual(listKeyPlan("End", 99, 100), { move: 99, edge: null, prevent: true });
  assert.deepEqual(listKeyPlan("Home", 0, 100), { move: 0, edge: null, prevent: true });
});

test("list keys: an out-of-range index is clamped first", () => {
  assert.deepEqual(listKeyPlan("ArrowDown", 40, 5), { move: null, edge: "down", prevent: false });
  assert.deepEqual(listKeyPlan("ArrowUp", -3, 5), { move: null, edge: "up", prevent: false });
  assert.deepEqual(listKeyPlan("ArrowUp", 40, 5), { move: 3, edge: null, prevent: true });
});

test("list keys: an empty list moves nowhere and swallows nothing", () => {
  assert.deepEqual(listKeyPlan("ArrowDown", 0, 0), { move: null, edge: "down", prevent: false });
  assert.deepEqual(listKeyPlan("ArrowUp", 0, 0), { move: null, edge: "up", prevent: false });
  for (const k of ["PageUp", "PageDown", "Home", "End"]) {
    assert.deepEqual(listKeyPlan(k, 0, 0), { move: null, edge: null, prevent: false });
  }
});

test("list keys: keys that are not movement are not the plan's", () => {
  for (const k of ["Enter", " ", "+", "=", "a", "7", "Escape", "Backspace", "Tab", "", undefined]) {
    assert.equal(listKeyPlan(k, 2, 5), null, `key ${JSON.stringify(k)}`);
  }
});

// --- 2. the list's handler on a fake <ul> --------------------------------------------------
// Just enough DOM for createLibraryUI: rows are made with innerHTML + querySelector, so a
// querySelector the fake cannot answer hands back a throwaway child.
function fakeDom() {
  const doc = { activeElement: null };
  const make = (tag) => {
    const el = {
      tagName: String(tag).toUpperCase(), className: "", dataset: {}, attrs: {}, children: [], parent: null,
      listeners: {}, style: { setProperty() {} }, textContent: "", innerHTML: "", title: "",
      scrollTop: 0, clientHeight: 480,
      classList: {
        contains: (c) => el.className.split(/\s+/).includes(c),
        toggle: (c, on) => { const s = new Set(el.className.split(/\s+/).filter(Boolean)); if (on ?? !s.has(c)) s.add(c); else s.delete(c); el.className = [...s].join(" "); },
        add: (c) => el.classList.toggle(c, true), remove: (c) => el.classList.toggle(c, false),
      },
      set tabIndex(v) { el.attrs.tabindex = String(v); },
      get tabIndex() { return Number(el.attrs.tabindex ?? -1); },
      setAttribute(k, v) { el.attrs[k] = String(v); },
      getAttribute(k) { return el.attrs[k] ?? null; },
      appendChild(c) {
        const kids = c.tagName === "#FRAGMENT" ? c.children.splice(0) : [c];
        for (const k of kids) { k.parent = el; el.children.push(k); }
        return c;
      },
      replaceChildren(...cs) { for (const c of el.children) c.parent = null; el.children = []; for (const c of cs) el.appendChild(c); },
      remove() { if (el.parent) el.parent.children = el.parent.children.filter((c) => c !== el); el.parent = null; },
      contains(n) { for (; n; n = n.parent) if (n === el) return true; return false; },
      closest(sel) { for (let n = el; n; n = n.parent) if (sel === ".song" && n.classList && n.classList.contains("song")) return n; return null; },
      querySelectorAll(sel) {
        const out = [];
        const walk = (n) => { for (const c of n.children) { if ((sel === ".song" && c.classList.contains("song")) || (sel === "li button" && c.tagName === "BUTTON")) out.push(c); walk(c); } };
        walk(el);
        return out;
      },
      querySelector(sel) {
        const m = /^\.song\[data-index="(\d+)"\]$/.exec(sel);
        if (m) return el.children.find((c) => String(c.dataset.index) === m[1]) || null;
        return make("span");
      },
      addEventListener(t, fn) { (el.listeners[t] ||= []).push(fn); },
      getBoundingClientRect: () => ({ height: 48 }),
      focus() { doc.activeElement = el; },
      onclick: null, ondblclick: null,
    };
    return el;
  };
  const list = make("ul");
  Object.assign(doc, {
    getElementById: (id) => (id === "song-list" ? list : null),
    createElement: make,
    createDocumentFragment: () => make("#fragment"),
  });
  list.ownerDocument = doc;
  return { doc, list };
}

function libRig(n) {
  const { doc, list } = fakeDom();
  const saved = { document: globalThis.document, window: globalThis.window, raf: globalThis.requestAnimationFrame };
  globalThis.document = doc;
  globalThis.window = { addEventListener() {} };
  globalThis.requestAnimationFrame = () => 0;
  const edges = [], played = [];
  let lib;
  try {
    lib = createLibraryUI({
      onPlay: (s) => played.push(s), onQueue() {}, onRemoveFromQueue() {}, onToggleFavorite() {},
      isFavorite: () => false, showSource: () => false, onEdge: (dir) => edges.push(dir),
    });
    lib.renderList(Array.from({ length: n }, (_, i) => ({ id: `s${i}`, code: i, name: `Song ${i}`, artistName: "" })));
  } catch (e) { Object.assign(globalThis, { document: saved.document, window: saved.window }); throw e; }
  const restore = () => {
    globalThis.document = saved.document; globalThis.window = saved.window; globalThis.requestAnimationFrame = saved.raf;
  };
  const row = (i) => list.children.find((c) => String(c.dataset.index) === String(i));
  const press = (key, target = doc.activeElement || row(0)) => {
    let prevented = false;
    const ev = { key, target, preventDefault: () => { prevented = true; } };
    for (const fn of list.listeners.keydown || []) fn(ev);
    return prevented;
  };
  return { doc, list, lib, edges, played, row, press, restore };
}

test("list keys: the handler hands an edge on unprevented and reports it once", () => {
  const r = libRig(3);
  try {
    assert.equal(r.lib.focusRow(2), true);
    assert.equal(r.doc.activeElement, r.row(2));
    assert.equal(r.press("ArrowDown"), false);          // not prevented: the router moves focus
    assert.deepEqual(r.edges, ["down"]);
    assert.equal(r.doc.activeElement, r.row(2));        // the list itself did not move
    assert.equal(r.press("ArrowLeft"), false);
    assert.deepEqual(r.edges, ["down", "left"]);
  } finally { r.restore(); }
});

test("list keys: the handler consumes moves inside the list and keeps Enter / Space / + its own", () => {
  const r = libRig(30);
  try {
    assert.equal(r.lib.focusRow(), true);               // the roving row: the first of a new list
    assert.equal(r.doc.activeElement, r.row(0));
    assert.equal(r.press("ArrowDown"), true);
    assert.equal(r.doc.activeElement, r.row(1));
    assert.equal(r.press("PageDown"), true);
    assert.equal(r.doc.activeElement, r.row(11));
    assert.equal(r.press("End"), true);
    assert.equal(r.doc.activeElement, r.row(29));
    assert.deepEqual(r.edges, []);
    assert.equal(r.press("Enter"), true);
    assert.deepEqual(r.played.map((s) => s.id), ["s29"]);   // exactly one play
    assert.equal(r.press(" "), true);
    assert.equal(r.press("a"), false);                  // printable: type-to-search's, not the list's
    assert.equal(r.press("7"), false);
  } finally { r.restore(); }
});

test("list keys: a row's ★ and ＋ are not focus stops; an empty list takes no focus", () => {
  const r = libRig(2);
  try {
    const buttons = r.row(0).children.filter((c) => c.tagName === "BUTTON");
    assert.equal(buttons.length, 2);
    for (const b of buttons) assert.equal(b.getAttribute("tabindex"), "-1");
    r.lib.renderList([]);
    assert.equal(r.lib.focusRow(), false);
  } finally { r.restore(); }
});

// --- 3. the `c` toggle and Back-hide (shell.js) ---------------------------------------------
function shellRig() {
  const listeners = [];
  const byId = new Map();
  const body = {
    dataset: { idle: "false" },
    cls: new Set(),
    classList: { toggle(c, on) { if (on) body.cls.add(c); else body.cls.delete(c); }, contains: (c) => body.cls.has(c) },
  };
  const doc = {
    body, activeElement: body,
    getElementById: (id) => byId.get(id) || null,
    addEventListener: (t, fn) => listeners.push([t, fn]),
  };
  const el = (id, parent = null) => {
    const e = { id, parent, contains(n) { for (; n; n = n.parent) if (n === e) return true; return false; }, focus() { doc.activeElement = e; } };
    byId.set(id, e);
    return e;
  };
  const stage = el("stage");
  const bar = el("ov-controls");
  const play = el("btn-play", bar);
  const subs = new Set();
  const clock = { t: 0 };
  const stack = createOverlayStack({ onChange: (c) => { for (const fn of subs) fn(c); }, now: () => clock.t });
  stack.subscribe = (fn) => { subs.add(fn); return () => subs.delete(fn); };
  const overlays = { register() {}, arm() {}, toggle() {} };
  const shell = createShell({
    overlays, stack, doc, settings: { get: () => undefined },
    timers: { setInterval() {}, clearInterval() {} },
  });
  shell.wire();
  shell.setIdle(false);
  const shellKeydown = listeners.filter(([t]) => t === "keydown").map(([, fn]) => fn);
  // One keydown through the shell's listener and the "router" (toggle/hide) in either order.
  const key = (routerFirst, router, ev = { type: "keydown", key: "c" }) => {
    if (routerFirst) { router(ev); for (const fn of shellKeydown) fn(ev); }
    else { for (const fn of shellKeydown) fn(ev); router(ev); }
  };
  const hidden = () => body.cls.has("controls-hidden");
  return { doc, stage, bar, play, stack, shell, key, hidden };
}

for (const routerFirst of [false, true]) {
  const order = routerFirst ? "router first" : "shell first";
  test(`keys: c shows a hidden bar and hides a shown one (${order})`, () => {
    const s = shellRig();
    assert.equal(s.hidden(), false);
    s.key(routerFirst, (ev) => s.shell.toggle(ev));
    assert.equal(s.hidden(), true, "shown → hidden");
    s.key(routerFirst, (ev) => s.shell.toggle(ev));
    assert.equal(s.hidden(), false, "hidden → shown");
    s.key(routerFirst, (ev) => s.shell.toggle(ev));
    assert.equal(s.hidden(), true, "and back");
  });

  test(`keys: Back hides the bar and the same keydown's poke does not undo it (${order})`, () => {
    const s = shellRig();
    s.play.focus();
    s.key(routerFirst, (ev) => assert.equal(s.shell.hide(ev), true));
    assert.equal(s.hidden(), true);
    assert.equal(s.doc.activeElement, s.stage, "focus leaves the hidden bar for #stage");
    s.key(routerFirst, () => {});                       // any later key shows it again
    assert.equal(s.hidden(), false);
  });
}

// Integration fix (orchestrator): after Back hides the bar, a further Back must leave it hidden
// (§4.2 rule 3: dialog → panel → bar → nothing). The shell's any-key wake used to bring it back.
test("keys: a Back key never wakes a hidden bar; any other key does", () => {
  const s = shellRig();
  const shellKeys = (ev) => s.key(false, () => {}, ev);
  s.play.focus();
  s.key(false, (ev) => assert.equal(s.shell.hide(ev), true));
  assert.equal(s.hidden(), true);
  for (const ev of [
    { type: "keydown", key: "Escape" },
    { type: "keydown", key: "Backspace" },
    { type: "keydown", key: "BrowserBack" },
    { type: "keydown", key: "Unidentified", keyCode: 461 },     // webOS Back
    { type: "keydown", key: "Unidentified", keyCode: 10009 },   // Tizen Back
  ]) {
    shellKeys(ev);
    assert.equal(s.hidden(), true, `${ev.key}/${ev.keyCode || ""} left the bar hidden`);
  }
  // Backspace while typing is not Back — it edits the field, and counts as activity.
  shellKeys({ type: "keydown", key: "Backspace", target: { tagName: "INPUT", type: "search" } });
  assert.equal(s.hidden(), false, "Backspace in a text field wakes the bar like any key");
  s.key(false, (ev) => s.shell.hide(ev));
  shellKeys({ type: "keydown", key: "ArrowDown" });
  assert.equal(s.hidden(), false, "an arrow wakes it");
});

test("keys: the bar never hides while idle or under a modal", () => {
  const s = shellRig();
  s.shell.setIdle(true);
  assert.equal(s.shell.toggle(null), false);
  assert.equal(s.shell.hide(null), false);
  assert.equal(s.hidden(), false);
  s.shell.setIdle(false);
  s.stack.open("search");
  assert.equal(s.shell.hide(null), false);
  assert.equal(s.hidden(), false);
});
