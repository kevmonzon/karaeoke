/*
 * list-keys.test.js — the key path's integration seams (M4, lane I).
 *
 *   1. listKeyPlan (library-ui.js, pure): the song list owns its movement keys but not its edges,
 *      so an arrow that leaves the list is handed to spatial navigation exactly once.
 *   2. The list's keydown handler really uses it (a fake <ul>): an edge is not prevented and calls
 *      onEdge once; a move inside is prevented; printable keys are left alone; ★ / ＋ are not stops.
   (The control bar's `c` / Back-hide tests went with the bar — Rae removed the dock, 2026-11-24.)
 * Run with:  node --test
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { listKeyPlan, createLibraryUI } from "../src/js/library-ui.js";

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
