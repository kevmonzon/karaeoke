/*
 * queue-ops.test.js — M5 lane B: the host's queue operations and the row activation they hang on.
 *
 *   1. queue.js: addFront / moveToFront / clear — the song and who reserved it stay in lockstep,
 *      every real change fires onChange exactly once, and a rejected one fires nothing.
 *   2. Song rows (library-ui.js, fake DOM): with onActivate a click / Enter hands the row to the
 *      song sheet and nothing else; ★ / ＋ never activate it; without onActivate the pre-M5 path.
 *   3. The queue list is a roving-tabindex list: one tab stop, listKeyPlan's edges, Enter / click →
 *      onQueueActivate, the ✕ is pointer-only, and focus follows the SAME song across a rebuild.
 * Run with:  node --test
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { createQueue } from "../src/js/queue.js";
import { createLibraryUI, queueFocusTarget } from "../src/js/library-ui.js";

const song = (id, extra = {}) => ({ id, name: `Song ${id}`, artistName: `Artist ${id}`, kind: "midi", code: 1, ...extra });
const ids = (q) => q.list.map((s) => s.id);

// --- 1. queue.js ---------------------------------------------------------------------------
test("queue ops: addFront inserts at 0 and keeps by in step", () => {
  let changes = 0;
  const q = createQueue({ onChange: () => { changes++; } });
  q.add(song("a"), "Rae");
  q.add(song("b"), "Mia");
  changes = 0;
  assert.equal(q.addFront(song("x"), "Cha"), 0);
  assert.deepEqual(ids(q), ["x", "a", "b"]);
  assert.deepEqual(q.listBy, ["Cha", "Rae", "Mia"]);
  assert.equal(changes, 1, "one change, one onChange");
  assert.equal(q.addFront(song("h")), 0);
  assert.deepEqual(q.listBy, ["", "Cha", "Rae", "Mia"], "a host Play next is attributed to nobody");
  assert.equal(changes, 2);
});

test("queue ops: addFront ignores fair play (an explicit jump, not a turn)", () => {
  const q = createQueue();
  q.add(song("a1"), "Rae", true);
  q.add(song("b1"), "Mia", true);
  q.add(song("a2"), "Rae", true);
  // Rae already has two waiting; fair play would put her third song last. Play next does not ask.
  q.addFront(song("a3"), "Rae");
  assert.deepEqual(ids(q), ["a3", "a1", "b1", "a2"]);
  assert.deepEqual(q.listBy, ["Rae", "Rae", "Mia", "Rae"]);
  // …and a normal reservation after it still takes its turn (Cha's first song: ahead of Rae's later rounds).
  q.add(song("c1"), "Cha", true);
  assert.equal(q.list.findIndex((s) => s.id === "c1") < q.list.findIndex((s) => s.id === "a2"), true);
});

test("queue ops: moveToFront moves one item and keeps by in step", () => {
  let changes = 0;
  const q = createQueue({ onChange: () => { changes++; } });
  for (const [id, who] of [["a", "Rae"], ["b", "Mia"], ["c", ""], ["d", "Cha"]]) q.add(song(id), who);
  changes = 0;
  assert.equal(q.moveToFront(2), true);
  assert.deepEqual(ids(q), ["c", "a", "b", "d"], "only c moved; the rest keep their order");
  assert.deepEqual(q.listBy, ["", "Rae", "Mia", "Cha"], "attribution moves WITH the song");
  assert.equal(changes, 1);
  assert.equal(q.moveToFront(3), true);
  assert.deepEqual(ids(q), ["d", "c", "a", "b"]);
  assert.deepEqual(q.listBy, ["Cha", "", "Rae", "Mia"]);
  assert.equal(changes, 2);
});

test("queue ops: moveToFront rejects bad indices (0 included) and fires nothing", () => {
  let changes = 0;
  const q = createQueue({ onChange: () => { changes++; } });
  q.add(song("a"), "Rae"); q.add(song("b"), "Mia"); q.add(song("c"), "");
  changes = 0;
  for (const i of [0, -1, 3, 1.5, "1", null, undefined, NaN, Infinity]) {
    assert.equal(q.moveToFront(i), false, `index ${String(i)}`);
  }
  assert.equal(changes, 0, "a rejected (or no-op) move must not render, persist or push");
  assert.deepEqual(ids(q), ["a", "b", "c"]);
  assert.deepEqual(q.listBy, ["Rae", "Mia", ""]);
  assert.equal(createQueue().moveToFront(0), false, "an empty queue has nothing to move");
});

test("queue ops: clear empties both arrays, fires once and returns the count", () => {
  let changes = 0;
  const q = createQueue({ onChange: () => { changes++; } });
  q.add(song("a"), "Rae"); q.add(song("b"), "Mia"); q.add(song("c"), "");
  const held = q.list;           // the getter's array, as a caller might hold it
  changes = 0;
  assert.equal(q.clear(), 3);
  assert.equal(changes, 1);
  assert.equal(q.length, 0);
  assert.deepEqual(q.list, []);
  assert.deepEqual(q.listBy, []);
  assert.equal(held.length, 0, "cleared in place, like every other mutation");
  assert.equal(q.countBy("Rae"), 0, "the reservation cap forgets cleared songs");
});

test("queue ops: clear on an empty queue does not fire", () => {
  let changes = 0;
  const q = createQueue({ onChange: () => { changes++; } });
  assert.equal(q.clear(), 0);
  assert.equal(changes, 0);
  q.add(song("a"));
  q.clear();
  changes = 0;
  assert.equal(q.clear(), 0, "a second clear is no change");
  assert.equal(changes, 0);
});

test("queue ops: matches still guards stale indices after addFront", () => {
  const q = createQueue();
  q.add(song("a")); q.add(song("b"));
  // A phone computed "remove index 0 = a" from a snapshot taken before the host's Play next.
  q.addFront(song("x"));
  assert.equal(q.matches(0, "a"), false, "index 0 is now x: the stale command must not act");
  assert.equal(q.matches(1, "a"), true);
  assert.equal(q.matches(0, "x"), true);
  assert.equal(q.matches(3, "b"), false, "out of range");
  assert.equal(q.matches(2), true, "a command with no id still applies by index");
});

test("queue ops: restore after clear works (silently, without attribution)", () => {
  let changes = 0;
  const q = createQueue({ onChange: () => { changes++; } });
  q.add(song("a"), "Rae");
  q.clear();
  changes = 0;
  q.restore([song("x"), song("y")]);
  assert.equal(changes, 0, "restore stays silent");
  assert.deepEqual(ids(q), ["x", "y"]);
  assert.deepEqual(q.listBy, ["", ""]);
  q.addFront(song("z"), "Mia");
  assert.deepEqual(ids(q), ["z", "x", "y"]);
  assert.deepEqual(q.listBy, ["Mia", "", ""]);
  assert.equal(q.clear(), 3);
});

// --- a fake DOM (the list-keys.test.js approach, with what the queue list needs on top) ------
function fakeDom() {
  const doc = { activeElement: null, focusLog: [] };
  const matches = (n, sel) => {
    if (!n || !n.classList) return false;
    if (sel.startsWith(".")) return n.classList.contains(sel.slice(1));
    const a = /^\[([\w-]+)\]$/.exec(sel);
    if (a) return a[1] in n.attrs;
    return n.tagName === sel.toUpperCase();
  };
  const make = (tag) => {
    const el = {
      tagName: String(tag).toUpperCase(), className: "", dataset: {}, attrs: {}, children: [], parent: null,
      listeners: {}, style: { setProperty() {} }, textContent: "", innerHTML: "", title: "",
      scrollTop: 0, clientHeight: 480, scrolled: 0,
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
        for (const k of kids) { if (k.parent) k.remove(); k.parent = el; el.children.push(k); }
        return c;
      },
      replaceChildren(...cs) { for (const c of el.children) c.parent = null; el.children = []; for (const c of cs) el.appendChild(c); },
      remove() { if (el.parent) el.parent.children = el.parent.children.filter((c) => c !== el); el.parent = null; },
      contains(n) { for (; n; n = n.parent) if (n === el) return true; return false; },
      closest(sel) { for (let n = el; n; n = n.parent) if (matches(n, sel)) return n; return null; },
      querySelectorAll(sel) {
        const out = [];
        const walk = (n) => { for (const c of n.children) { if (matches(c, sel)) out.push(c); walk(c); } };
        walk(el);
        return out;
      },
      querySelector(sel) {
        const m = /^\.song\[data-index="(\d+)"\]$/.exec(sel);
        if (m) return el.children.find((c) => String(c.dataset.index) === m[1]) || null;
        const found = el.querySelectorAll(sel)[0];
        if (found) return found;
        // The row template's spans (written with innerHTML, which the fake does not parse).
        if (/^\.[\w-]+$/.test(sel)) { const s = make("span"); s.className = sel.slice(1); el.appendChild(s); return s; }
        return null;
      },
      addEventListener(t, fn) { (el.listeners[t] ||= []).push(fn); },
      getBoundingClientRect: () => ({ height: 48 }),
      focus(opts) { doc.activeElement = el; doc.focusLog.push({ el, opts }); },
      scrollIntoView() { el.scrolled++; },
      onclick: null, ondblclick: null,
    };
    return el;
  };
  doc.createElement = make;
  doc.createDocumentFragment = () => make("#fragment");
  return { doc, make };
}

function withRig({ songs = 0, activate = true, queueActivate = true } = {}, fn) {
  const { doc, make } = fakeDom();
  const songList = make("ul");
  songList.ownerDocument = doc;
  const panel = make("section");
  panel.setAttribute("data-ov", "queue");
  const close = make("button");
  close.setAttribute("data-ov-close", "");
  const queueList = make("ul");
  panel.appendChild(close);
  panel.appendChild(queueList);
  const heading = make("span");
  const elsewhere = make("button");     // focus outside both lists (a song-sheet button, say)
  const byId = { "song-list": songList, "queue-list": queueList, "queue-heading-count": heading };
  doc.getElementById = (id) => byId[id] || null;

  const saved = { document: globalThis.document, window: globalThis.window, raf: globalThis.requestAnimationFrame };
  globalThis.document = doc;
  globalThis.window = { addEventListener() {} };
  globalThis.requestAnimationFrame = () => 0;
  try {
    const calls = { activate: [], queueActivate: [], played: [], queued: [], fav: [], removed: [] };
    const lib = createLibraryUI({
      onPlay: (s) => calls.played.push(s), onQueue: (s) => calls.queued.push(s),
      onRemoveFromQueue: (i) => calls.removed.push(i), onToggleFavorite: (s) => calls.fav.push(s),
      isFavorite: () => false, showSource: () => false,
      ...(activate ? { onActivate: (s, el) => calls.activate.push([s, el]) } : {}),
      ...(queueActivate ? { onQueueActivate: (i, s, el) => calls.queueActivate.push([i, s, el]) } : {}),
    });
    if (songs) lib.renderList(Array.from({ length: songs }, (_, i) => song(`s${i}`)));
    const row = (i) => songList.children.find((c) => String(c.dataset.index) === String(i));
    const qrow = (i) => queueList.children[i];
    // A keydown from the focused element, bubbling to every ancestor's listeners.
    const press = (key, target = doc.activeElement) => {
      let prevented = false;
      const ev = { key, target, preventDefault: () => { prevented = true; } };
      for (let n = target; n; n = n.parent) for (const f of n.listeners.keydown || []) f(ev);
      return prevented;
    };
    // A click that bubbles through onclick handlers until something stops it.
    const click = (el, detail = 1) => {
      let stopped = false;
      const ev = { detail, target: el, stopPropagation: () => { stopped = true; } };
      for (let n = el; n && !stopped; n = n.parent) if (typeof n.onclick === "function") n.onclick(ev);
    };
    // A real queue driving the list, the way app.js wires it (onChange → renderQueue).
    const queue = createQueue({ onChange: () => lib.renderQueue(queue.list, queue.listBy) });
    return fn({ doc, lib, calls, row, qrow, press, click, queue, queueList, close, heading, elsewhere });
  } finally {
    globalThis.document = saved.document; globalThis.window = saved.window; globalThis.requestAnimationFrame = saved.raf;
  }
}

const buttons = (el) => el.children.filter((c) => c.tagName === "BUTTON");
const stops = (ul) => ul.children.filter((c) => c.getAttribute("tabindex") === "0");

// --- 2. song rows --------------------------------------------------------------------------
test("row: with onActivate a click opens the sheet and does not select-then-play", () => {
  withRig({ songs: 5 }, ({ lib, calls, row, click }) => {
    const r = row(3);
    assert.equal(r.ondblclick, null, "no double-click handler: the first click already opened the sheet");
    click(r);
    assert.equal(calls.activate.length, 1);
    assert.equal(calls.activate[0][0].id, "s3");
    assert.equal(calls.activate[0][1], r, "the row element is handed over (the sheet's opener)");
    assert.deepEqual(calls.played, [], "no play");
    assert.equal(lib.getSelectedSong(), null, "no select");
    assert.equal(r.getAttribute("tabindex"), "0", "the activated row is the tab stop");
    assert.equal(row(0).getAttribute("tabindex"), "-1");
    click(r, 2);                                        // the second click of a double-click
    assert.equal(calls.activate.length, 1, "a double-click activates once");
  });
});

test("row: the star and plus buttons do not activate the row", () => {
  withRig({ songs: 3 }, ({ calls, row, click }) => {
    const [fav, add] = buttons(row(1));
    assert.equal(fav.className.includes("fav"), true);
    assert.equal(add.className.includes("add"), true);
    click(fav);
    click(add);
    assert.deepEqual(calls.fav.map((s) => s.id), ["s1"]);
    assert.deepEqual(calls.queued.map((s) => s.id), ["s1"]);
    assert.deepEqual(calls.activate, [], "★ / ＋ stop propagation: no sheet");
    for (const b of [fav, add]) assert.equal(b.getAttribute("tabindex"), "-1", "never a focus stop");
  });
});

test("row: without onActivate a double-click still plays (the pre-M5 path)", () => {
  withRig({ songs: 3, activate: false }, ({ lib, calls, row, click, press }) => {
    click(row(2));
    assert.equal(lib.getSelectedSong().id, "s2", "a click selects");
    assert.deepEqual(calls.played, []);
    assert.equal(typeof row(2).ondblclick, "function");
    row(2).ondblclick();
    assert.deepEqual(calls.played.map((s) => s.id), ["s2"], "a double-click plays");
    row(1).focus();
    assert.equal(press("Enter"), true);
    assert.deepEqual(calls.played.map((s) => s.id), ["s2", "s1"], "Enter plays");
  });
});

test("row: Enter with onActivate opens the sheet; Space still selects and + still queues", () => {
  withRig({ songs: 6 }, ({ lib, calls, row, press }) => {
    row(4).focus();                                     // a pointer-focused, non-roving row
    assert.equal(press("Enter"), true);
    assert.equal(calls.activate.length, 1);
    assert.equal(calls.activate[0][0].id, "s4");
    assert.equal(calls.activate[0][1], row(4));
    assert.deepEqual(calls.played, [], "Enter no longer plays");
    assert.equal(row(4).getAttribute("tabindex"), "0", "the roving row follows the activated row");
    assert.equal(row(0).getAttribute("tabindex"), "-1");
    assert.equal(press(" "), true);
    assert.equal(lib.getSelectedSong().id, "s4", "Space selects");
    assert.equal(press("+"), true);
    assert.deepEqual(calls.queued.map((s) => s.id), ["s4"], "+ queues");
    assert.equal(calls.activate.length, 1, "neither Space nor + opened the sheet");
  });
});

// --- 3. the queue list ---------------------------------------------------------------------
test("queue list: one tab stop, data-index on every row, role=list, ✕ is pointer-only", () => {
  withRig({}, ({ queue, queueList, heading }) => {
    for (const [id, who] of [["a", ""], ["b", "Mia"], ["c", ""], ["d", ""]]) queue.add(song(id), who);
    assert.equal(queueList.getAttribute("role"), "list");
    assert.equal(queueList.children.length, 4);
    assert.equal(queueList.children.every((c) => c.tagName === "LI" && c.classList.contains("qsong")), true, "ul → li only");
    assert.deepEqual(queueList.children.map((c) => String(c.dataset.index)), ["0", "1", "2", "3"]);
    assert.equal(stops(queueList).length, 1, "exactly one tab stop");
    assert.equal(stops(queueList)[0], queueList.children[0]);
    for (const li of queueList.children) {
      const rm = buttons(li);
      assert.equal(rm.length, 1);
      assert.equal(rm[0].textContent, "✕");
      assert.equal(rm[0].getAttribute("tabindex"), "-1");
    }
    // The row look is kept: title, artist + the "· name" badge.
    const b = queueList.children[1];
    assert.equal(b.querySelector(".title").textContent, "Song b");
    assert.equal(b.querySelector(".artist").textContent, "Artist b");
    assert.equal(b.querySelector(".by").textContent, " · Mia");
    assert.equal(heading.textContent, "(4)");
  });
});

test("queue list: Enter on a row calls onQueueActivate once with the right index", () => {
  withRig({}, ({ doc, lib, calls, queue, qrow, press }) => {
    for (const id of ["a", "b", "c"]) queue.add(song(id));
    assert.equal(lib.focusQueueRow(2), true);
    assert.equal(doc.activeElement, qrow(2));
    assert.equal(press("Enter"), true, "prevented: the router must not also act on it");
    assert.equal(calls.queueActivate.length, 1);
    const [i, s, el] = calls.queueActivate[0];
    assert.equal(i, 2);
    assert.equal(s.id, "c");
    assert.equal(el, qrow(2));
  });
});

test("queue list: a click on a row activates it (once per double-click); the roving row follows", () => {
  withRig({}, ({ calls, queue, qrow, click, queueList }) => {
    for (const id of ["a", "b", "c"]) queue.add(song(id));
    click(qrow(1));
    click(qrow(1), 2);
    assert.deepEqual(calls.queueActivate.map(([i, s]) => [i, s.id]), [[1, "b"]]);
    assert.equal(stops(queueList).length, 1);
    assert.equal(stops(queueList)[0], qrow(1));
  });
});

test("queue list: arrows move inside; Down at the last row and Up at the first are not prevented", () => {
  withRig({}, ({ doc, lib, queue, qrow, press }) => {
    for (const id of ["a", "b", "c"]) queue.add(song(id));
    lib.focusQueueRow(2);
    assert.equal(press("ArrowDown"), false, "the edge: the key router moves focus out once");
    assert.equal(doc.activeElement, qrow(2), "the list itself did not move");
    assert.equal(press("ArrowUp"), true);
    assert.equal(doc.activeElement, qrow(1));
    assert.equal(press("Home"), true);
    assert.equal(doc.activeElement, qrow(0));
    assert.equal(press("ArrowUp"), false, "the top edge");
    assert.equal(press("End"), true);
    assert.equal(doc.activeElement, qrow(2));
    assert.equal(press("PageUp"), true);
    assert.equal(doc.activeElement, qrow(0));
    assert.equal(press("PageDown"), true);
    assert.equal(doc.activeElement, qrow(2));
    assert.equal(press("ArrowLeft"), false);
    assert.equal(press("ArrowRight"), false);
    assert.equal(qrow(2).getAttribute("tabindex"), "0");
    assert.equal(qrow(0).getAttribute("tabindex"), "-1");
  });
});

test("queue list: the ✕ is not a tab stop and does not activate the row", () => {
  withRig({}, ({ calls, queue, qrow, click }) => {
    for (const id of ["a", "b", "c"]) queue.add(song(id));
    const [rm] = buttons(qrow(1));
    assert.equal(rm.getAttribute("tabindex"), "-1");
    click(rm);
    assert.deepEqual(calls.removed, [1], "✕ still removes, through onRemoveFromQueue");
    assert.deepEqual(calls.queueActivate, [], "and never opens the sheet");
  });
});

test("queue list: focus stays on the same song after a move (by id, nearest index)", () => {
  withRig({}, ({ doc, lib, queue, qrow, queueList }) => {
    for (const id of ["a", "b", "c", "d"]) queue.add(song(id));
    lib.focusQueueRow(2);                               // c
    queue.moveToFront(2);                               // → c a b d
    assert.equal(doc.activeElement, qrow(0));
    assert.equal(stops(queueList)[0], qrow(0), "the roving row follows");
    assert.equal(doc.focusLog.at(-1).opts.preventScroll, true);
    assert.equal(qrow(0).scrolled > 0, true, "and is brought into view");
    queue.move(0, 3);                                   // → a b d c
    assert.equal(doc.activeElement, qrow(3));
    // The same song queued twice: the copy nearest the old index wins.
    queue.clear();
    for (const id of ["a", "b", "a", "c"]) queue.add(song(id));
    lib.focusQueueRow(2);                               // the second a
    queue.move(2, 3);                                   // → a b c a
    assert.equal(doc.activeElement, qrow(3), "the moved copy, not the a at the top");
  });
});

test("queue list: after a remove (or the song starting) focus goes to the row at the old index, clamped", () => {
  withRig({}, ({ doc, lib, queue, qrow }) => {
    for (const id of ["a", "b", "c", "d"]) queue.add(song(id));
    lib.focusQueueRow(1);                               // b
    queue.removeAt(1);                                  // → a c d
    assert.equal(doc.activeElement, qrow(1), "the row now at the old index (c)");
    lib.focusQueueRow(2);                               // d, the last
    queue.removeAt(2);                                  // → a c
    assert.equal(doc.activeElement, qrow(1), "clamped to the new end");
    lib.focusQueueRow(0);
    queue.shift();                                      // a starts → c
    assert.equal(doc.activeElement, qrow(0));
  });
});

test("queue list: an emptied queue puts focus on the panel's Close", () => {
  withRig({}, ({ doc, lib, queue, close, heading }) => {
    queue.add(song("a")); queue.add(song("b"));
    lib.focusQueueRow(1);
    queue.clear();
    assert.equal(doc.activeElement, close);
    assert.equal(doc.focusLog.at(-1).opts.preventScroll, true);
    assert.equal(heading.textContent, "");
  });
});

test("queue list: a rebuild never steals focus, but the roving row still follows its song", () => {
  withRig({}, ({ doc, lib, queue, qrow, elsewhere }) => {
    for (const id of ["a", "b", "c"]) queue.add(song(id));
    lib.focusQueueRow(2);                               // c: the row the sheet was opened from
    elsewhere.focus();                                  // focus is in the song sheet now
    queue.move(2, 1);                                   // the sheet's "Move up" → a c b
    assert.equal(doc.activeElement, elsewhere, "the rebuild left focus where it was");
    assert.equal(lib.focusQueueRow(), true, "back to the roving row after the sheet closes…");
    assert.equal(doc.activeElement, qrow(1), "…which is the song that moved");
  });
});

test("queue list: focusQueueRow on an empty queue is false", () => {
  withRig({}, ({ doc, lib, queue, qrow }) => {
    assert.equal(lib.focusQueueRow(), false);
    assert.equal(lib.focusQueueRow(0), false);
    queue.add(song("a")); queue.add(song("b"));
    assert.equal(lib.focusQueueRow(9), true, "clamped");
    assert.equal(doc.activeElement, qrow(1));
    queue.clear();
    assert.equal(lib.focusQueueRow(), false);
  });
});

test("queueFocusTarget: same song by id, nearest copy, else the old index clamped", () => {
  const L = (...xs) => xs.map((id) => ({ id }));
  assert.equal(queueFocusTarget(L("a", "b", "c"), 1, L("b", "a", "c")), 0, "b moved up");
  assert.equal(queueFocusTarget(L("a", "b", "a", "c"), 2, L("a", "b", "c", "a")), 3, "nearest copy");
  assert.equal(queueFocusTarget(L("x", "a", "y"), 1, L("a", "z", "a")), 0, "a tie goes to the earlier row");
  assert.equal(queueFocusTarget(L("a", "b", "c"), 2, L("a", "b")), 1, "gone → clamped");
  assert.equal(queueFocusTarget(L("a", "b", "c"), 1, L("a", "c")), 1, "gone → the same index");
  assert.equal(queueFocusTarget(L("a"), 0, []), -1, "empty");
  assert.equal(queueFocusTarget([], 0, L("a", "b")), 0, "first render");
  assert.equal(queueFocusTarget(L("a", "b"), NaN, L("b", "a")), 1, "a bad index reads as 0 (a)");
  assert.equal(queueFocusTarget(L("a", "b"), -3, L("a", "b")), 0);
});
