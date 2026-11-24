/*
 * nav.test.js — the M4 nav runtime: which input is driving (src/js/ui/input-mode.js), arrow keys
 * on the page (src/js/ui/nav-dom.js) and the named actions the key router runs
 * (src/js/ui/actions.js). The DOM parts run against a small hand-built fake that has exactly the
 * surface nav-dom.js documents; the overlay stack is the real M1 one where scope is under test.
 * Run with:  node --test
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { classifyInput, createInputMode } from "../src/js/ui/input-mode.js";
import { FOCUSABLE, ownsArrow, describe as describeEl, needsActivate, createNav } from "../src/js/ui/nav-dom.js";
import { createActions } from "../src/js/ui/actions.js";
import { createOverlayStack } from "../src/js/ui/overlay-stack.js";

// --- a minimal fake DOM (only what nav-dom.js / input-mode.js read) ------------------------
// Selectors: the simple forms FOCUSABLE uses — tag, [a], [a="v"], :not([a]), :not([a="v"]).
const compile = (sel) => sel.split(",").map((part) => {
  const [, tag, rest] = /^([a-z]*)(.*)$/.exec(part.trim());
  const conds = [...rest.matchAll(/(:not\()?\[([\w-]+)(?:="([^"]*)")?\]\)?/g)]
    .map(([, not, name, val]) => ({ not: !!not, name, val }));
  return { tag, conds };
});
const matches = (el, sel) => compile(sel).some(({ tag, conds }) => (!tag || el.tag === tag)
  && conds.every(({ not, name, val }) => not !== (el.attrs.has(name) && (val === undefined || el.attrs.get(name) === val))));

class El {
  constructor(doc, tag, attrs = {}, rect = null) {
    Object.assign(this, { doc, tag, tagName: tag.toUpperCase(), attrs: new Map(Object.entries(attrs).map(([k, v]) => [k, String(v)])),
      children: [], parentElement: null, rect, style: {}, dataset: {}, ls: {}, events: [],
      calls: { focus: [], scroll: [], click: 0, picker: 0 } });
  }
  get hidden() { return this.attrs.has("hidden"); }
  get disabled() { return this.attrs.has("disabled"); }
  get type() { return this.attrs.get("type") ?? (this.tag === "input" ? "text" : ""); }
  get options() { return this.tag === "select" ? [...this.walk()].filter((e) => e.tag === "option") : undefined; }
  getAttribute(k) { return this.attrs.has(k) ? this.attrs.get(k) : null; }
  hasAttribute(k) { return this.attrs.has(k); }
  setAttribute(k, v) { this.attrs.set(k, String(v)); }
  add(tag, attrs, rect) { const c = new El(this.doc, tag, attrs, rect); c.parentElement = this; this.children.push(c); return c; }
  contains(n) { for (; n; n = n.parentElement) if (n === this) return true; return false; }
  *walk() { for (const c of this.children) { yield c; yield* c.walk(); } }
  querySelectorAll(sel) { return [...this.walk()].filter((e) => matches(e, sel)); }
  getClientRects() { for (let n = this; n; n = n.parentElement) if (n.style.display === "none") return []; return this.rect ? [this.rect] : []; }
  getBoundingClientRect() { const { x, y, w, h } = this.rect || { x: 0, y: 0, w: 0, h: 0 }; return { left: x, top: y, width: w, height: h }; }
  focus(opts) { this.calls.focus.push(opts); if (this.doc.contains(this)) this.doc.activeElement = this; }  // permissive on purpose
  scrollIntoView(opts) { this.calls.scroll.push(opts); }
  click() { this.calls.click++; if (this.type === "checkbox") this.checked = !this.checked; }
  showPicker() { this.calls.picker++; }
  addEventListener(t, fn, opts) { (this.ls[t] ||= []).push(fn); (this.added ||= []).push({ type: t, opts }); }
  dispatchEvent(ev) { this.events.push(ev.type); for (let n = this; n; n = n.parentElement) for (const fn of n.ls[ev.type] || []) fn(ev); return true; }
}
function makeDoc({ computed = true } = {}) {
  const doc = new El(null, "#document");
  doc.doc = doc;
  doc.nodeType = 9;
  doc.documentElement = doc.add("html");
  doc.body = doc.documentElement.add("body", {}, R(0, 0, 1920, 1080));
  doc.activeElement = doc.body;
  const visibility = (el) => { for (let n = el; n; n = n.parentElement) if (n.style.visibility) return n.style.visibility; return "visible"; };
  doc.defaultView = computed ? { getComputedStyle: (el) => ({ visibility: visibility(el) }) } : null;
  doc.fire = (ev) => { for (const fn of doc.ls[ev.type] || []) fn(ev); };   // the document's capture listeners
  return doc;
}
const R = (x, y, w, h) => ({ x, y, w, h });
// --- end of the fake DOM ------------------------------------------------------------------

// The home screen + control bar + a Songs panel and a Settings panel, laid out like 1920×1080.
function navRig({ idle = false, bar = true, computed = true, entry = true, stack } = {}) {
  const doc = makeDoc({ computed });
  const stage = doc.body.add("main", { id: "stage", tabindex: "-1" }, R(0, 0, 1920, 1080));
  const home = stage.add("nav", { id: "home-tiles" }, R(200, 400, 1500, 200));
  const tiles = ["songs", "favorites", "queue", "tonight", "settings"]
    .map((id, i) => home.add("button", { id: `tile-${id}` }, R(200 + i * 300, 400, 250, 200)));
  const barEl = doc.body.add("section", { id: "ov-controls" }, R(0, 980, 1920, 100));
  const restart = barEl.add("button", { id: "btn-restart" }, R(40, 1000, 60, 60));
  const play = barEl.add("button", { id: "btn-play" }, R(120, 1000, 60, 60));
  const next = barEl.add("button", { id: "btn-next" }, R(200, 1000, 60, 60));
  const volume = barEl.add("input", { id: "volume", type: "range" }, R(300, 1010, 200, 40));
  const songsBtn = barEl.add("button", { id: "toggle-lib" }, R(560, 1000, 60, 60));
  const fullscreen = barEl.add("button", { id: "btn-fullscreen" }, R(1820, 1000, 60, 60));

  const search = doc.body.add("section", { id: "ov-search" }, R(1400, 0, 520, 980));
  const field = search.add("input", { id: "search", type: "search" }, R(1420, 20, 480, 60));
  const list = search.add("ul", { id: "song-list" }, R(1420, 100, 480, 860));
  const rows = [0, 1, 2].map((i) => {
    const li = list.add("li", { class: "song", tabindex: i === 0 ? "0" : "-1" }, R(1420, 100 + i * 60, 480, 60));
    li.add("button", { class: "fav", tabindex: "-1" }, R(1800, 110 + i * 60, 40, 40));
    li.add("button", { class: "add", tabindex: "-1" }, R(1850, 110 + i * 60, 40, 40));
    return li;
  });

  const settingsEl = doc.body.add("section", { id: "settings-panel" }, R(1400, 0, 520, 980));
  const theme = settingsEl.add("select", { id: "set-theme" }, R(1420, 100, 480, 50));
  for (const v of ["auto", "dark", "light"]) theme.add("option", { value: v });
  theme.selectedIndex = 0;
  const check = settingsEl.add("input", { id: "set-smooth", type: "checkbox" }, R(1420, 180, 40, 40));
  const range = settingsEl.add("input", { id: "set-lines", type: "range" }, R(1420, 260, 300, 40));

  const state = { top: null, idle, bar, shown: 0 };
  const overlays = { search, settings: settingsEl };
  const nav = createNav({
    stack: stack || { top: () => state.top },
    doc,
    getOverlayEl: (id) => overlays[id] || null,
    getHomeRoot: () => home,
    getBarRoot: () => barEl,
    ...(entry ? { getBarEntry: () => play } : {}),
    isIdle: () => state.idle,
    isBarVisible: () => state.bar,
    showBar: () => { state.shown++; state.bar = true; },
  });
  const focus = (el) => { doc.activeElement = el; };
  return { doc, nav, state, stage, home, tiles, barEl, restart, play, next, volume, songsBtn, fullscreen,
    search, field, rows, settingsEl, theme, check, range, focus };
}

const key = (k, target, extra = {}) => ({ type: "keydown", key: k, target, ...extra });

// --- input mode -------------------------------------------------------------------------
test("input: arrows switch to keys mode", () => {
  const doc = makeDoc();
  for (const k of ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Enter", "NumpadEnter", "7", "0",
    "Backspace", "Escape", "BrowserBack", "GoBack", "MediaPlayPause", "MediaTrackNext", "ColorF0Red", "ChannelUp"]) {
    assert.equal(classifyInput(key(k, doc.body)), "keys", k);
  }
  const seen = [];
  const im = createInputMode({ doc, onChange: (m) => seen.push(m) });
  im.wire();
  assert.equal(im.mode, null);                       // nothing until the first classified input
  doc.fire(key("ArrowDown", doc.body));
  assert.equal(im.mode, "keys");
  assert.equal(doc.documentElement.dataset.input, "keys");
  doc.fire(key("ArrowUp", doc.body));
  assert.deepEqual(seen, ["keys"]);                  // onChange only on a real change
});

test("input: typing letters in a field does not switch (returns null)", () => {
  const doc = makeDoc();
  const text = doc.body.add("input", { type: "search" });
  const plain = doc.body.add("input");                     // no type attribute = text
  const area = doc.body.add("textarea");
  const editable = doc.body.add("div");
  editable.isContentEditable = true;
  for (const t of [text, plain, area, editable]) {
    for (const k of ["a", "ArrowLeft", "ArrowDown", "Enter", "7", "Backspace"]) {
      assert.equal(classifyInput(key(k, t)), null, `${k} in ${t.tag}`);
    }
  }
  for (const k of ["a", "Q", " ", "/", "+", "Tab", "Shift"]) assert.equal(classifyInput(key(k, doc.body)), null, k);
  // controls that are not text fields still count
  for (const type of ["range", "checkbox", "radio", "button", "color", "file"]) {
    assert.equal(classifyInput(key("ArrowRight", doc.body.add("input", { type }))), "keys", type);
  }
  assert.equal(classifyInput(key("ArrowDown", doc.body.add("select"))), "keys");

  const im = createInputMode({ doc });
  im.wire();
  im.set("mouse");
  doc.fire(key("ArrowLeft", text));                  // moving the caret in the search box
  assert.equal(im.mode, "mouse");
});

test("input: touch and pen are touch", () => {
  assert.equal(classifyInput({ type: "pointerdown", pointerType: "touch" }), "touch");
  assert.equal(classifyInput({ type: "pointerdown", pointerType: "pen" }), "touch");
  assert.equal(classifyInput({ type: "pointermove", pointerType: "pen" }), "touch");
  assert.equal(classifyInput({ type: "touchstart" }), "touch");
  assert.equal(classifyInput({ type: "pointerdown", pointerType: "mouse" }), "mouse");
  assert.equal(classifyInput({ type: "pointerdown", pointerType: "" }), null);
  assert.equal(classifyInput({ type: "click" }), null);
  assert.equal(classifyInput(null), null);

  const doc = makeDoc();
  const im = createInputMode({ doc });
  im.wire();
  doc.fire({ type: "pointerdown", pointerType: "pen", clientX: 5, clientY: 5 });
  assert.equal(im.mode, "touch");
  assert.equal(doc.documentElement.dataset.input, "touch");
});

test("input: a tiny mouse jitter does not switch mode (and a real move does)", () => {
  const doc = makeDoc();
  const seen = [];
  const im = createInputMode({ doc, onChange: (m) => seen.push(m) });
  im.wire();
  im.set("keys");
  const mv = (x, y) => doc.fire({ type: "pointermove", pointerType: "mouse", clientX: x, clientY: y });
  mv(100, 100);                // where the mouse rests when keys mode began
  mv(102, 102);
  mv(104, 100);                // exactly 4 px: not MORE than 4
  mv(100, 96);
  assert.equal(im.mode, "keys");
  mv(105, 100);                // 5 px from the rest point
  assert.equal(im.mode, "mouse");
  assert.equal(doc.documentElement.dataset.input, "mouse");

  im.set("keys");              // a new mode: the next move re-anchors, wherever the mouse is
  mv(300, 300);
  mv(302, 301);
  assert.equal(im.mode, "keys");
  doc.fire({ type: "pointerdown", pointerType: "mouse", clientX: 302, clientY: 301 });
  assert.equal(im.mode, "mouse");                    // a mouse button switches at once
  assert.deepEqual(seen, ["keys", "mouse", "keys", "mouse"]);
});

test("input: a TV keyCode with key \"Unidentified\" counts as keys", () => {
  const body = makeDoc().body;
  assert.equal(classifyInput(key("Unidentified", body, { keyCode: 461 })), "keys");   // webOS Back
  assert.equal(classifyInput(key("", body, { keyCode: 10009 })), "keys");            // Tizen Back
  assert.equal(classifyInput(key("Unidentified", body, { keyCode: 415 })), "keys");   // MediaPlay
  assert.equal(classifyInput(key("Unidentified", body, { keyCode: 13 })), "keys");    // OK
  assert.equal(classifyInput(key("Unidentified", body, { keyCode: 0, code: "Numpad5" })), "keys");
  assert.equal(classifyInput(key("Unidentified", body, { keyCode: 65 })), null);      // an unknown key
  assert.equal(classifyInput({ type: "keydown", keyCode: 403, target: body }), "keys"); // no key field at all
});

test("input: wire() listens once per event type, in the capture phase", () => {
  const doc = makeDoc();
  const im = createInputMode({ doc });
  im.wire();
  im.wire();
  assert.deepEqual(doc.added.map((a) => a.type).sort(), ["keydown", "pointerdown", "pointermove", "touchstart"]);
  assert.ok(doc.added.every((a) => a.opts && a.opts.capture === true));
});

test("input: set() forces a mode; an unknown mode is ignored", () => {
  const doc = makeDoc();
  const seen = [];
  const im = createInputMode({ doc, onChange: (m) => seen.push(m) });
  im.set("touch");
  im.set("touch");
  im.set("bogus");
  assert.equal(im.mode, "touch");
  assert.equal(doc.documentElement.dataset.input, "touch");
  assert.deepEqual(seen, ["touch"]);
});

// --- native widgets (pure) ----------------------------------------------------------------
const DIRS = ["up", "down", "left", "right"];
const owned = (desc) => DIRS.filter((d) => ownsArrow(desc, d));

test("ownsArrow: a range keeps left/right, releases up/down", () => {
  assert.deepEqual(owned({ tag: "input", type: "range" }), ["left", "right"]);
  assert.deepEqual(owned({ tag: "input", type: "range", axis: "" }), ["left", "right"]);
  assert.deepEqual(owned({ tag: "input", type: "range", axis: "horizontal" }), ["left", "right"]);
});

test("ownsArrow: a vertical-axis range keeps up/down and releases left/right (A9)", () => {
  assert.deepEqual(owned({ tag: "input", type: "range", axis: "vertical" }), ["up", "down"]);
  const el = makeDoc().body.add("input", { type: "range", "data-nav-axis": "Vertical" });
  assert.deepEqual(owned(describeEl(el)), ["up", "down"]);
  // other widgets ignore the axis
  assert.deepEqual(owned({ tag: "select", axis: "vertical" }), ["left", "right"]);
  assert.deepEqual(owned({ tag: "button", axis: "vertical" }), []);
});

test("ownsArrow: a select releases up/down", () => {
  assert.deepEqual(owned({ tag: "select" }), ["left", "right"]);
});

test("ownsArrow: a text field keeps left/right", () => {
  for (const type of ["text", "search", "url", "email", "tel", "password", "", undefined]) {
    assert.deepEqual(owned({ tag: "input", type }), ["left", "right"], String(type));
  }
});

test("ownsArrow: rows and buttons are not native widgets (they own nothing)", () => {
  for (const desc of [{ tag: "li", role: "listitem" }, { tag: "button" }, { tag: "a" }, { tag: "summary" },
    { tag: "input", type: "checkbox" }, { tag: "input", type: "radio" }, { tag: "input", type: "button" },
    { tag: "div", role: "slider" }, { tag: "" }]) {
    assert.deepEqual(owned(desc), [], JSON.stringify(desc));
  }
  assert.equal(ownsArrow(null, "left"), false);
  assert.equal(ownsArrow({ tag: "textarea" }, "sideways"), false);
});

test("ownsArrow: number and textarea own all four", () => {
  assert.deepEqual(owned({ tag: "input", type: "number" }), DIRS);
  assert.deepEqual(owned({ tag: "textarea" }), DIRS);
});

test("describe: lowercases tag, input type, role and data-nav-axis", () => {
  assert.deepEqual(describeEl(null), { tag: "", type: "", role: "", axis: "" });
  const body = makeDoc().body;
  assert.deepEqual(describeEl(body.add("input", { type: "RANGE", role: "Slider" })),
    { tag: "input", type: "range", role: "slider", axis: "" });
  assert.deepEqual(describeEl(body.add("input")), { tag: "input", type: "text", role: "", axis: "" });
  assert.equal(describeEl(body.add("button", { type: "submit" })).type, "");   // type is for <input> only
  const viaDataset = body.add("input", { type: "range" });
  viaDataset.dataset.navAxis = "vertical";
  assert.equal(describeEl(viaDataset).axis, "vertical");
});

test("needsActivate: checkbox and radio click, select and color open a picker, a button needs nothing", () => {
  assert.equal(needsActivate({ tag: "input", type: "checkbox" }), "click");
  assert.equal(needsActivate({ tag: "input", type: "radio" }), "click");
  assert.equal(needsActivate({ tag: "select" }), "picker");
  assert.equal(needsActivate({ tag: "input", type: "color" }), "picker");
  for (const desc of [{ tag: "button" }, { tag: "a" }, { tag: "summary" }, { tag: "li" },
    { tag: "input", type: "text" }, { tag: "input", type: "range" }, null]) {
    assert.equal(needsActivate(desc), null, JSON.stringify(desc));
  }
});

// --- createNav --------------------------------------------------------------------------
test("nav: move lets the key through when a range owns it (false, focus unchanged)", () => {
  const r = navRig({ idle: true });
  r.focus(r.volume);
  assert.equal(r.nav.move("left"), false);
  assert.equal(r.nav.move("right"), false);
  assert.equal(r.doc.activeElement, r.volume);
  assert.equal(r.nav.move("up"), true);              // released: spatial nav takes it up to the tiles
  assert.ok(r.tiles.includes(r.doc.activeElement));
});

test("nav: left/right on a select steps it and reports handled; up/down leave it", () => {
  const r = navRig();
  r.state.top = "settings";
  r.focus(r.theme);
  let changes = 0;
  r.settingsEl.addEventListener("change", () => changes++);      // it bubbles
  assert.equal(r.nav.move("right"), true);
  assert.equal(r.theme.selectedIndex, 1);
  assert.equal(changes, 1);
  assert.deepEqual(r.theme.events, ["input", "change"]);
  assert.equal(r.doc.activeElement, r.theme);
  assert.equal(r.nav.move("left"), true);
  assert.equal(r.theme.selectedIndex, 0);
  assert.equal(r.nav.move("left"), true);              // at the first option: still the select's key
  assert.equal(changes, 2);
  assert.equal(r.nav.move("down"), true);
  assert.equal(r.doc.activeElement, r.check);
});

test("nav: Left on a vertical-axis range moves to its left neighbour, Up goes to the range (A9)", () => {
  const r = navRig();
  r.volume.setAttribute("data-nav-axis", "vertical");
  r.focus(r.volume);
  assert.equal(r.nav.move("up"), false);               // the browser steps the value
  assert.equal(r.nav.move("down"), false);
  assert.equal(r.doc.activeElement, r.volume);
  assert.equal(r.nav.move("left"), true);
  assert.equal(r.doc.activeElement, r.next);
  r.focus(r.volume);
  assert.equal(r.nav.move("right"), true);
  assert.equal(r.doc.activeElement, r.songsBtn);
});

test("nav: the scope is the top modal when one is open", () => {
  const stack = createOverlayStack();
  const r = navRig({ idle: true, stack });
  stack.open("controls");                            // not modal: the scope stays home + bar
  assert.deepEqual(r.nav.scopeRoots(), [r.home, r.barEl]);
  stack.open("search");
  assert.deepEqual(r.nav.scopeRoots(), [r.search]);
  const found = r.nav.focusables();
  assert.ok(found.length > 0 && found.every((el) => r.search.contains(el)));
  r.focus(r.field);
  assert.equal(r.nav.move("down"), true);
  assert.equal(r.doc.activeElement, r.rows[0]);      // the roving row, not the ★ beside it
  stack.close("search");
  stack.open("mixer");                               // a modal with no element registered
  assert.deepEqual(r.nav.scopeRoots(), []);
  r.focus(r.stage);
  assert.equal(r.nav.move("down"), false);           // nothing to walk, and no bar under a modal
  assert.equal(r.state.shown, 0);
  assert.equal(r.doc.activeElement, r.stage);
});

test("nav: scope is home + bar while idle, the bar alone while a song is loaded, nothing when the bar is hidden", () => {
  const r = navRig({ idle: true, bar: true });
  assert.deepEqual(r.nav.scopeRoots(), [r.home, r.barEl]);
  r.state.idle = false;
  assert.deepEqual(r.nav.scopeRoots(), [r.barEl]);
  r.state.bar = false;
  assert.deepEqual(r.nav.scopeRoots(), []);
  r.state.idle = true;
  assert.deepEqual(r.nav.scopeRoots(), [r.home]);

  r.state.bar = true;                                // idle home screen: arrows cross tiles ↔ bar
  r.focus(r.tiles[0]);
  assert.equal(r.nav.move("down"), true);
  assert.ok(r.barEl.contains(r.doc.activeElement));
  assert.equal(r.nav.move("up"), true);
  assert.ok(r.home.contains(r.doc.activeElement));
});

test("nav: skips hidden, disabled, inert, data-nav-skip and tabindex=\"-1\" elements", () => {
  for (const computed of [true, false]) {
    const r = navRig({ computed });
    const b = r.barEl;
    const bad = [
      b.add("button", { hidden: "" }, R(700, 1000, 60, 60)),
      b.add("button", { disabled: "" }, R(780, 1000, 60, 60)),
      b.add("div", { inert: "" }, R(860, 1000, 60, 60)).add("button", {}, R(860, 1000, 60, 60)),
      b.add("div", { "data-nav-skip": "" }, R(940, 1000, 60, 60)).add("button", {}, R(940, 1000, 60, 60)),
      b.add("button", { tabindex: "-1" }, R(1020, 1000, 60, 60)),
      b.add("div", { hidden: "" }, R(1100, 1000, 60, 60)).add("a", { href: "#" }, R(1100, 1000, 60, 60)),
      b.add("button", {}, null),                                   // not rendered: no client rects
    ];
    const gone = b.add("div", {}, R(1180, 1000, 60, 60));
    gone.style.display = "none";
    bad.push(gone.add("button", {}, R(1180, 1000, 60, 60)));
    const invisible = b.add("button", {}, R(1260, 1000, 60, 60));
    invisible.style.visibility = "hidden";
    const kept = b.add("div", { tabindex: "0" }, R(1340, 1000, 60, 60));    // [tabindex] counts
    const inFieldset = b.add("fieldset", { disabled: "" }, R(1420, 1000, 60, 60)).add("button", {}, R(1420, 1000, 60, 60));
    Object.defineProperty(inFieldset, "disabled", { value: true });   // :disabled by its fieldset, no attribute
    bad.push(inFieldset);
    const found = r.nav.focusables(b);
    for (const el of bad) assert.ok(!found.includes(el), `${computed}: ${[...el.attrs.keys()]}`);
    assert.ok(found.includes(kept));
    // computed visibility is read only where the platform has getComputedStyle
    assert.equal(found.includes(invisible), !computed);
    assert.deepEqual(found.slice(0, 6), [r.restart, r.play, r.next, r.volume, r.songsBtn, r.fullscreen]);
  }
});

test("nav: an arrow on the bare stage shows the bar and focuses the bar entry (Play), not its first button", () => {
  const r = navRig({ idle: false, bar: false });
  r.focus(r.stage);
  assert.equal(r.nav.move("down"), true);
  assert.equal(r.state.shown, 1);
  assert.equal(r.doc.activeElement, r.play);
  assert.deepEqual(r.play.calls.focus.at(-1), { preventScroll: true });
  assert.deepEqual(r.play.calls.scroll.at(-1), { block: "nearest", inline: "nearest" });

  const noEntry = navRig({ idle: false, bar: false, entry: false });   // no getBarEntry: first focusable
  noEntry.focus(noEntry.doc.body);
  assert.equal(noEntry.nav.move("right"), true);
  assert.equal(noEntry.doc.activeElement, noEntry.restart);
});

test("nav: an arrow with focus outside the scope (#stage / body) focuses the scope's entry", () => {
  const r = navRig({ idle: true, bar: true });
  r.focus(r.stage);
  assert.equal(r.nav.move("right"), true);
  assert.equal(r.doc.activeElement, r.tiles[0]);     // idle: the first home tile
  r.focus(r.doc.body);
  assert.equal(r.nav.move("up"), true);
  assert.equal(r.doc.activeElement, r.tiles[0]);
  r.state.idle = false;                              // a song is loaded: the bar's entry
  r.focus(r.stage);
  assert.equal(r.nav.move("left"), true);
  assert.equal(r.doc.activeElement, r.play);
  r.state.top = "search";                            // a modal: its first focusable
  assert.equal(r.nav.move("down"), true);
  assert.equal(r.doc.activeElement, r.field);
  r.focus(r.search);                                 // on the panel itself (overlays-dom's fallback)
  assert.equal(r.nav.move("down"), true);
  assert.equal(r.doc.activeElement, r.field);        // that is not "inside": enter at the top
  assert.equal(r.state.shown, 0);                    // the bar was already up: never "shown"
});

test("nav: focus has landed only when activeElement is the element", () => {
  const r = navRig({ idle: true });
  r.tiles[0].focus = () => {};                       // refuses focus, like a browser would
  r.focus(r.stage);
  assert.equal(r.nav.move("down"), true);
  assert.equal(r.doc.activeElement, r.tiles[1]);     // the next candidate is tried
  for (const t of r.tiles) t.focus = () => {};
  r.state.bar = false;
  r.focus(r.stage);
  assert.equal(r.nav.move("down"), false);           // nothing landed: let the key through
  assert.equal(r.nav.focusFirst(r.home), false);
});

test("nav: spatial moves focus without scrolling, then scrolls the winner into view", () => {
  const r = navRig();
  r.focus(r.play);
  assert.equal(r.nav.move("right"), true);
  assert.equal(r.doc.activeElement, r.next);
  assert.deepEqual(r.next.calls.focus.at(-1), { preventScroll: true });
  assert.deepEqual(r.next.calls.scroll, [{ block: "nearest", inline: "nearest" }]);
  r.restart.scrollIntoView = undefined;              // feature-detected, never assumed
  r.focus(r.play);
  assert.equal(r.nav.move("left"), true);
  assert.equal(r.doc.activeElement, r.restart);
});

// A11 (orchestrator integration fix): a text field whose caret is at an end lets the router
// release Left / Right, so a button beside the field on the same line is reachable.
test("nav: move(dir, {release:true}) skips a text field's ownership of Left/Right (A11)", () => {
  const r = navRig();
  r.state.top = "search";
  const pill = r.search.add("button", { id: "btn-favorites" }, R(1905, 20, 10, 60));
  r.focus(r.field);
  assert.equal(r.nav.move("right"), false, "owned: the caret moves");
  assert.equal(r.doc.activeElement, r.field);
  assert.equal(r.nav.move("right", { release: true }), true, "released: focus moves on");
  assert.equal(r.doc.activeElement, pill);
  r.focus(r.field);
  assert.equal(r.nav.move("left", { release: true }), false, "released but nothing to the left: a text field is not swallowed");
  assert.equal(r.doc.activeElement, r.field);
});

test("nav: no candidate leaves focus where it was (false)", () => {
  const r = navRig({ idle: false, bar: true });
  r.focus(r.fullscreen);
  assert.equal(r.nav.move("right"), false);
  assert.equal(r.nav.move("down"), false);
  assert.equal(r.nav.move("up"), false);
  assert.equal(r.doc.activeElement, r.fullscreen);
  assert.equal(r.nav.move("diagonal"), false);
});

test("nav: a range or select at a dead end swallows the arrow it released; a button does not (A10)", () => {
  const r = navRig();
  r.state.top = "settings";
  r.focus(r.range);                                  // the last control in the panel
  assert.equal(r.nav.move("down"), true);            // handled: the browser must not step the value
  assert.equal(r.doc.activeElement, r.range);
  assert.deepEqual(r.range.events, []);
  r.focus(r.theme);                                  // the first control in the panel
  assert.equal(r.nav.move("up"), true);              // handled: no native popup / option change
  assert.equal(r.doc.activeElement, r.theme);
  assert.equal(r.theme.selectedIndex, 0);
  assert.deepEqual(r.theme.events, []);
  r.focus(r.check);                                  // released arrows still move when they can
  assert.equal(r.nav.move("down"), true);
  assert.equal(r.doc.activeElement, r.range);

  const b = navRig({ idle: false, bar: true });
  b.focus(b.fullscreen);
  assert.equal(b.nav.move("down"), false);           // a button at a dead end lets the key through
  assert.equal(b.nav.move("right"), false);
  b.volume.setAttribute("data-nav-axis", "vertical");
  b.focus(b.volume);
  assert.equal(b.nav.move("up"), false);             // an OWNED arrow still goes to the range (rule 1)
});

test("nav: stepSelect skips disabled options, clamps, fires change once", () => {
  const doc = makeDoc();
  const sel = doc.body.add("select", {}, R(0, 0, 100, 30));
  const opts = ["a", "b", "c", "d", "e"].map((v) => sel.add("option", { value: v }));
  opts[1].setAttribute("disabled", "");
  const group = sel.add("optgroup", { disabled: "" });
  group.add("option", { value: "f" });              // inside a disabled optgroup
  sel.selectedIndex = 0;
  let changes = 0;
  doc.body.addEventListener("change", () => changes++);
  const nav = createNav({ doc });
  assert.equal(nav.stepSelect(sel, 1), true);
  assert.equal(sel.selectedIndex, 2);                // b is disabled
  assert.equal(changes, 1);
  assert.equal(nav.stepSelect(sel, 10), true);       // clamps at the last enabled option (e)
  assert.equal(sel.selectedIndex, 4);
  assert.equal(nav.stepSelect(sel, 1), false);       // f is in a disabled group: nothing further
  assert.equal(changes, 2);
  assert.equal(nav.stepSelect(sel, -10), true);
  assert.equal(sel.selectedIndex, 0);
  assert.equal(nav.stepSelect(sel, -1), false);      // no wrap
  assert.equal(nav.stepSelect(sel, 0), false);
  assert.equal(changes, 3);
  assert.deepEqual(sel.events.filter((t) => t === "change").length, 3);
  assert.deepEqual(sel.events.filter((t) => t === "input").length, 3);
});

test("nav: activate clicks a checkbox exactly once and returns false for a button", () => {
  const r = navRig();
  assert.equal(r.nav.activate(r.check), true);
  assert.equal(r.check.calls.click, 1);
  assert.equal(r.check.checked, true);
  assert.equal(r.nav.activate(r.play), false);
  assert.equal(r.play.calls.click, 0);
  assert.equal(r.nav.activate(null), false);
  assert.equal(r.nav.activate(r.rows[0]), false);    // a row acts on Enter itself

  assert.equal(r.nav.activate(r.theme), true);       // a select opens its picker…
  assert.equal(r.theme.calls.picker, 1);
  assert.equal(r.theme.calls.click, 0);
  const color = r.settingsEl.add("input", { type: "color" }, R(1420, 320, 40, 40));
  color.showPicker = () => { throw new Error("NotAllowedError"); };
  assert.equal(r.nav.activate(color), true);         // …and falls back to a click when it cannot
  assert.equal(color.calls.click, 1);
  const old = r.settingsEl.add("select", {}, R(1420, 380, 200, 40));
  old.showPicker = undefined;
  assert.equal(r.nav.activate(old), true);
  assert.equal(old.calls.click, 1);
});

test("nav: FOCUSABLE matches the native controls and positive tabindex only", () => {
  const body = makeDoc().body;
  const yes = [body.add("a", { href: "#" }), body.add("button"), body.add("input"), body.add("select"),
    body.add("textarea"), body.add("summary"), body.add("div", { tabindex: "0" })];
  const no = [body.add("a"), body.add("button", { disabled: "" }), body.add("input", { disabled: "" }),
    body.add("div"), body.add("li", { tabindex: "-1" })];
  const found = body.querySelectorAll(FOCUSABLE);
  for (const el of yes) assert.ok(found.includes(el), el.tag);
  for (const el of no) assert.ok(!found.includes(el), el.tag);
});

// --- actions ------------------------------------------------------------------------------
test("actions: run reports unhandled actions", () => {
  const a = createActions({});
  assert.equal(a.run("next"), false);
  assert.equal(a.has("next"), false);
  let n = 0;
  a.set("next", () => { n++; });
  assert.equal(a.has("next"), true);
  assert.equal(a.run("next"), true);
  assert.equal(n, 1);
  a.set("next", null);
  assert.equal(a.has("next"), false);
  assert.equal(a.run("next"), false);
  assert.equal(a.run(undefined), false);
  assert.throws(() => a.set("next", "not a function"), TypeError);
  assert.equal(createActions().run("digit", 3), false);   // digit stays unhandled until M8
});

test("actions: a handler returning false does not swallow the key", () => {
  const got = [];
  const a = createActions({
    digit: (d) => { got.push(d); return false; },
    keyUp: () => undefined,
    keyDown: () => 0,
    stop: () => true,
  });
  assert.equal(a.run("digit", 7), false);
  assert.deepEqual(got, [7]);
  assert.equal(a.run("keyUp"), true);
  assert.equal(a.run("keyDown"), true);              // only `false` means "not handled"
  assert.equal(a.run("stop"), true);
});

test("actions: a throwing handler is reported and counts as handled", (t) => {
  const errors = t.mock.method(console, "error", () => {});
  const a = createActions({ next: () => { throw new Error("boom"); } });
  assert.equal(a.run("next"), true);
  assert.equal(errors.mock.callCount(), 1);
  assert.ok(errors.mock.calls[0].arguments.some((x) => x instanceof Error && x.message === "boom"));
});

test("actions: \"__proto__\" is never a handler", () => {
  const a = createActions({ next() {} });
  for (const name of ["__proto__", "constructor", "toString", "hasOwnProperty", "valueOf"]) {
    assert.equal(a.has(name), false, name);
    assert.equal(a.run(name), false, name);
  }
  const sneaky = {};
  Object.defineProperty(sneaky, "__proto__", { value: () => true, enumerable: true });
  const b = createActions(sneaky);
  assert.equal(b.has("__proto__"), false);
  b.set("__proto__", () => true);
  b.set("constructor", () => true);
  assert.equal(b.run("__proto__"), false);
  assert.equal(b.run("constructor"), false);
  assert.equal({}.next, undefined);                  // nothing leaked onto Object.prototype
});
