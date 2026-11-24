/*
 * shell.test.js — the stage shell's runtime (M3): the history sync, the overlay DOM adapter,
 * the control bar's one owner, and the home tiles (src/js/ui/overlays-dom.js, shell.js, home.js).
 * A minimal fake document, a fake history and fake timers; the stack is the real M1 stack with
 * the `subscribe` wrapper app.js adds, so the tests run the real integration path.
 * Run with:  node --test
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { createOverlayStack } from "../src/js/ui/overlay-stack.js";
import { createHistorySync, createOverlays } from "../src/js/ui/overlays-dom.js";
import { nextAutoHide, createShell } from "../src/js/ui/shell.js";
import { HOME_TILES, homeTiles, createHome } from "../src/js/ui/home.js";

// --- a minimal fake document (keep under 60 lines) ----------------------------------------
class El {
  constructor(doc, tag, id = "") {
    Object.assign(this, { doc, tagName: tag.toUpperCase(), id, hidden: false, dataset: {}, children: [],
      parentElement: null, textContent: "", className: "", attrs: new Map(), ls: {} });
    const s = new Set();
    this.classList = { add: (c) => s.add(c), remove: (c) => s.delete(c), contains: (c) => s.has(c),
      toggle: (c, f = !s.has(c)) => (f ? s.add(c) : s.delete(c), f) };
  }
  setAttribute(k, v) { this.attrs.set(k, String(v)); }
  getAttribute(k) { return this.attrs.has(k) ? this.attrs.get(k) : null; }
  hasAttribute(k) { return this.attrs.has(k); }
  removeAttribute(k) { this.attrs.delete(k); }
  append(...cs) { for (const c of cs) { c.parentElement = this; this.children.push(c); } }
  replaceChildren(...cs) { for (const c of this.children) c.parentElement = null; this.children = []; this.append(...cs); }
  remove() { const p = this.parentElement; if (p) p.children = p.children.filter((c) => c !== this); this.parentElement = null; }
  contains(n) { for (; n; n = n.parentElement) if (n === this) return true; return false; }
  matches(sel) {
    const k = sel.slice(1);
    return sel[0] === "[" ? this.hasAttribute(k.slice(0, -1))
      : sel[0] === "." && (this.classList.contains(k) || this.className.split(" ").includes(k));
  }
  closest(sel) { for (let n = this; n && n.matches; n = n.parentElement) if (n.matches(sel)) return n; return null; }
  addEventListener(t, fn) { (this.ls[t] ||= []).push(fn); }
  dispatch(type, props = {}) {
    const ev = { type, target: this, ...props };
    for (let n = this; n; n = n.parentElement) for (const fn of n.ls[type] || []) fn(ev);
    return ev;
  }
  focus() {   // refuses hidden subtrees, and inert ones where the "browser" supports inert
    const d = this.doc;
    for (let n = this; n; n = n.parentElement) if (n.hidden || (d.nativeInert && n.hasAttribute("inert"))) return;
    if (!d.contains(this)) return;
    d.activeElement = this;
    this.dispatch("focusin");
  }
}
function makeDoc({ nativeInert = true } = {}) {
  const doc = new El(null, "#document");
  const html = new El(doc, "html"), body = new El(doc, "body");
  Object.assign(doc, { doc, nodeType: 9, nativeInert, documentElement: html, body, activeElement: body });
  doc.append(html); html.append(body);
  const walk = (n, id) => (n.id === id ? n : n.children.reduce((f, c) => f || walk(c, id), null));
  doc.getElementById = (id) => walk(doc, id);
  doc.createElement = (tag) => new El(doc, tag);
  doc.createElementNS = (ns, tag) => new El(doc, tag);
  doc.add = (id, parent = body, tag = "div") => { const el = new El(doc, tag, id); parent.append(el); return el; };
  return doc;
}
// --- end of the fake document -----------------------------------------------------------

// A fake history whose traversals (back/go/the user's Back) land when settle() runs, like the
// browser's asynchronous popstate.
function makeHistory() {
  const h = {
    stack: [null], index: 0, queued: [], onpop: null, calls: { push: 0, replace: 0, back: 0, go: [] },
    get state() { return h.stack[h.index]; },
    get length() { return h.stack.length; },
    pushState(s) { h.calls.push++; h.stack = h.stack.slice(0, h.index + 1); h.stack.push(s); h.index++; },
    replaceState(s) { h.calls.replace++; h.stack[h.index] = s; },
    back() { h.calls.back++; h.queued.push(-1); },
    go(n) { h.calls.go.push(n); h.queued.push(n); },
    settle() { while (h.queued.length) { h.index = Math.max(0, h.index + h.queued.shift()); if (h.onpop) h.onpop(); } },
    user() { h.queued.push(-1); h.settle(); },     // the browser's own Back
  };
  return h;
}

// The real M1 stack plus the subscribe() wrapper app.js builds around it.
function makeStack(clock) {
  const subs = new Set();
  const stack = createOverlayStack({ onChange: (c) => { for (const fn of subs) fn(c); }, now: () => clock.t });
  stack.subscribe = (fn) => { subs.add(fn); return () => subs.delete(fn); };
  return stack;
}

function rig({ nativeInert = true, register = true } = {}) {
  const doc = makeDoc({ nativeInert });
  const h = makeHistory();
  const win = {
    history: h,
    HTMLElement: { prototype: nativeInert ? { inert: false } : {} },
    addEventListener: (t, fn) => { if (t === "popstate") h.onpop = fn; },
  };
  const clock = { t: 0 };
  const stack = makeStack(clock);
  const add = doc.add;
  const stage = add("stage", doc.body, "main");
  stage.setAttribute("tabindex", "-1");
  const homeBtn = add("home-songs", stage, "button");
  add("queue-count", stage, "button");
  add("scrim").hidden = true;
  add("status");
  const ctl = add("ov-controls", doc.body, "section");
  for (const id of ["btn-restart", "btn-play", "toggle-lib", "toggle-queue", "btn-mixer", "btn-settings", "btn-fullscreen"]) add(id, ctl, "button");
  const panels = { search: "ov-search", queue: "ov-queue", mixer: "ov-mixer", settings: "settings-panel", song: "ov-song", adjust: "ov-adjust" };
  for (const [id, elId] of Object.entries(panels)) {
    const el = add(elId, doc.body, "section");
    el.hidden = true;
    el.setAttribute("data-ov", id);
    add(`${id}-first`, el, "button");
    const close = add(`${id}-close`, el, "button");
    close.setAttribute("data-ov-close", "");
    add(`${id}-close-icon`, close, "svg");
  }
  const conf = add("ov-confirm", doc.body, "section");
  conf.hidden = true;
  add("ov-confirm-title", conf, "h2");
  add("ov-confirm-text", conf, "p");
  add("ov-confirm-cancel", conf, "button");
  add("ov-confirm-ok", conf, "button");
  const ov = createOverlays({ stack, doc, win });
  const el = (id) => doc.getElementById(id);
  if (register) {
    for (const [id, elId] of Object.entries(panels)) {
      if (id !== "adjust") ov.register(id, { el: el(elId), initialFocus: () => el(`${id}-first`) });
    }
    ov.register("adjust", { el: el("ov-adjust") });
  }
  return { doc, win, h, clock, stack, ov, el, stage, homeBtn, panels };
}

function shellRig(opts = {}) {
  const r = rig(opts);
  if (opts.before) opts.before(r);
  const values ={ "ui.playback": false, "ui.autoHideSec": 3, ...(opts.settings || {}) };
  const calls = { restart: 0, fullscreen: 0 };
  let tickFn = null, tickMs = 0;
  const shell = createShell({
    overlays: r.ov, stack: r.stack, doc: r.doc,
    settings: { get: (p) => values[p] },
    actions: { restart: () => calls.restart++, fullscreen: () => calls.fullscreen++ },
    timers: { setInterval: (fn, ms) => { tickFn = fn; tickMs = ms; }, clearInterval() {} },
  });
  shell.wire();
  const advance = (ms) => { for (let left = ms; left > 0; left -= tickMs) { r.clock.t += tickMs; tickFn(); } };
  const hidden = () => r.doc.body.classList.contains("controls-hidden");
  return { ...r, shell, values, calls, advance, hidden, get tickMs() { return tickMs; } };
}

const isInert = (el) => el.hasAttribute("inert");

// --- history -----------------------------------------------------------------------------
test("history: opening a modal pushes one entry", () => {
  const r = rig();
  r.ov.arm();
  const len = r.h.length;
  assert.equal(r.ov.open("search"), true);
  assert.equal(r.h.length, len + 1);
  assert.deepEqual(r.h.state, { kv: "overlay", id: "search" });
  assert.equal(r.ov.history.depth, 1);
});

test("history: a pop closes the top overlay", () => {
  const r = rig();
  r.ov.wire();
  r.ov.arm();
  r.ov.open("settings");
  r.h.user();
  assert.equal(r.stack.isOpen("settings"), false);
  assert.equal(r.el("settings-panel").hidden, true);
  assert.equal(r.h.calls.back, 0);                // the browser consumed the entry; we owe nothing
  assert.equal(r.ov.history.depth, 0);
  assert.equal(r.h.state.kv, "sentinel");
});

test("history: closing by button consumes the entry", () => {
  const r = rig();
  r.ov.wire();
  r.ov.arm();
  r.ov.open("search");
  r.ov.open("song");
  r.el("song-close-icon").dispatch("click");     // the click lands on the icon inside the button
  assert.equal(r.stack.isOpen("song"), false);
  assert.equal(r.h.calls.back, 1);
  r.h.settle();                                   // our own back() arrives as a popstate…
  assert.equal(r.stack.isOpen("search"), true);   // …and closes nothing else
  assert.equal(r.h.calls.back, 1);
});

test("history: two stacked modals unwind in order", () => {
  const r = rig();
  r.ov.wire();
  r.ov.arm();
  r.ov.open("search");
  r.ov.open("song");
  r.h.user();
  assert.deepEqual(r.stack.list(), ["search"]);
  r.h.user();
  assert.deepEqual(r.stack.list(), []);
  r.h.user();                                      // nothing open: the sentinel comes back
  assert.equal(r.h.state.kv, "sentinel");
  assert.ok(r.h.index >= 1);                       // still inside the app
});

test("history: the sentinel is pushed once, on arm", () => {
  const h = makeHistory();
  const hs = createHistorySync({ history: h });
  assert.equal(hs.armed, false);
  assert.equal(h.calls.push, 0);
  assert.equal(hs.arm(), true);
  assert.equal(hs.arm(), false);                   // a second arm() pushes nothing
  assert.equal(h.calls.push, 1);
  assert.deepEqual(h.state, { kv: "sentinel" });
});

test("history: a pop with nothing open re-pushes the sentinel", () => {
  const h = makeHistory();
  let pops = 0;
  const hs = createHistorySync({ history: h, onPop: () => pops++ });
  assert.equal(hs.handlePop(), "ignored");         // before arm there is no sentinel to keep
  hs.arm();
  h.index = 0;                                     // the browser left the sentinel
  assert.equal(hs.handlePop(), "sentinel");
  assert.equal(h.calls.push, 2);
  assert.deepEqual(h.state, { kv: "sentinel" });
  assert.equal(pops, 1);                           // a relay-opened overlay would close here
});

test("history: an overlay opened without activation pushes no entry", () => {
  const r = rig();
  r.ov.arm();
  r.stage.focus();
  assert.equal(r.ov.open("queue", { activated: false }), true);
  assert.equal(r.h.calls.push, 1);                 // the sentinel only
  assert.equal(r.doc.activeElement, r.stage);     // focus is not moved by a relay open
  r.ov.close("queue");
  assert.equal(r.h.calls.back, 0);
});

test("history: a panel swap replaces the entry", () => {
  const r = rig();
  r.ov.wire();
  r.ov.arm();
  r.ov.open("search");
  r.h.calls.push = 0;
  assert.equal(r.ov.open("queue"), true);
  assert.equal(r.h.calls.replace, 1);
  assert.equal(r.h.calls.push, 0);
  assert.equal(r.h.calls.back, 0);
  assert.deepEqual(r.h.state, { kv: "overlay", id: "queue" });
  assert.equal(r.el("ov-search").hidden, true);
  r.h.user();                                      // one Back closes Queue and nothing else
  assert.deepEqual(r.stack.list(), []);
  assert.equal(r.h.state.kv, "sentinel");
});

test("history: expectPops swallows the pop caused by a button close", () => {
  const r = rig();
  r.ov.wire();
  r.ov.arm();
  r.ov.open("search");
  r.ov.open("song");
  r.ov.close("song", "button");
  assert.equal(r.ov.history.expectPops, 1);
  r.h.settle();
  assert.equal(r.ov.history.expectPops, 0);
  assert.equal(r.stack.isOpen("search"), true);
  r.h.user();                                      // the next real pop still closes
  assert.equal(r.stack.isOpen("search"), false);
});

test("history: a close then an open in one turn becomes one replaceState", () => {
  const h = makeHistory();
  const queue = [];
  const hs = createHistorySync({ history: h, schedule: (fn) => queue.push(fn) });
  hs.arm();
  hs.opened("search");
  assert.equal(hs.closed("search"), "back");
  assert.equal(h.calls.back, 0);                   // deferred to the end of the turn
  assert.equal(hs.opened("song"), "replace");      // reuses the entry instead of racing back()
  queue.forEach((fn) => fn());
  assert.equal(h.calls.back, 0);
  assert.equal(h.calls.push, 2);
  assert.deepEqual(h.state, { kv: "overlay", id: "song" });
});

test("history: two closes in one turn go back once", () => {
  const h = makeHistory();
  const queue = [];
  const hs = createHistorySync({ history: h, schedule: (fn) => queue.push(fn) });
  hs.arm();
  hs.opened("search");
  hs.opened("song");
  hs.closed("song");
  hs.closed("search");
  queue.forEach((fn) => fn());
  assert.deepEqual(h.calls.go, [-2]);
  assert.equal(h.calls.back, 0);
  assert.equal(hs.expectPops, 1);                  // go(-2) fires ONE popstate
  h.settle();                                      // (no listener here: deliver it by hand)
  assert.equal(hs.handlePop(), "ignored");
  assert.equal(hs.expectPops, 0);
  assert.deepEqual(h.state, { kv: "sentinel" });
});

test("history: a reload on one of our entries does not push a second sentinel", () => {
  const h = makeHistory();
  h.stack = [null, { kv: "sentinel" }, { kv: "overlay", id: "search" }];
  h.index = 2;
  const hs = createHistorySync({ history: h });
  assert.equal(hs.armed, true);
  assert.deepEqual(h.state, { kv: "sentinel" });   // the stale overlay entry is now a sentinel
  assert.equal(hs.arm(), false);
  assert.equal(h.calls.push, 0);
});

test("history: a relay-opened overlay closes on browser Back without leaving the app", () => {
  const r = rig();
  r.ov.wire();
  r.ov.arm();
  r.ov.open("queue", { activated: false });
  r.h.user();
  assert.equal(r.stack.isOpen("queue"), false);
  assert.equal(r.h.state.kv, "sentinel");
});

// --- overlays ----------------------------------------------------------------------------
test("overlays: a modal makes the stage inert and shows the scrim", () => {
  const r = rig();
  r.ov.register("controls", { el: r.el("ov-controls"), visibility: "class" });
  r.ov.open("search");
  assert.equal(isInert(r.stage), true);
  assert.equal(isInert(r.el("ov-controls")), true);  // the bar is behind the modal
  assert.equal(isInert(r.el("ov-search")), false);
  assert.equal(r.el("ov-search").hidden, false);
  assert.equal(r.el("ov-search").classList.contains("open"), true);
  assert.equal(r.el("scrim").hidden, false);
  assert.equal(r.doc.body.dataset.ov, "search");
  r.ov.close();
  assert.equal(isInert(r.stage), false);
  assert.equal(isInert(r.el("ov-controls")), false);
  assert.equal(r.el("scrim").hidden, true);
  assert.equal(r.doc.body.dataset.ov, "");
});

test("overlays: #status is never made inert", () => {
  const r = rig();
  r.ov.open("search");
  r.ov.open("song");
  r.ov.confirm({ title: "t", text: "x", okLabel: "OK" });
  const status = r.el("status");
  assert.equal(isInert(status), false);
  assert.equal(status.getAttribute("aria-hidden"), null);
});

test("overlays: closing returns focus to the opener", () => {
  const r = rig();
  const btn = r.el("btn-settings");
  btn.focus();
  r.ov.open("settings");
  assert.equal(r.doc.activeElement, r.el("settings-first"));   // focus moved in
  r.ov.back();
  assert.equal(r.doc.activeElement, btn);
});

test("overlays: a vanished opener sends focus to the stage", () => {
  const r = rig();
  r.homeBtn.focus();
  r.ov.open("search");
  r.homeBtn.remove();
  r.ov.close("search");
  assert.equal(r.doc.activeElement, r.stage);
});

test("overlays: a panel swap moves inert correctly", () => {
  const r = rig();
  r.ov.open("search");
  r.ov.open("queue");
  assert.equal(isInert(r.el("ov-search")), false);
  assert.equal(isInert(r.el("ov-queue")), false);
  assert.equal(isInert(r.stage), true);
  r.ov.open("song");                               // a sheet above the panel
  assert.equal(isInert(r.el("ov-queue")), true);
  assert.equal(isInert(r.el("ov-song")), false);
  r.ov.close("song");
  assert.equal(isInert(r.el("ov-queue")), false);
  r.ov.close("queue");
  const all = [r.stage, ...Object.values(r.panels).map(r.el), r.el("ov-controls"), r.el("scrim")];
  assert.deepEqual(all.filter(isInert), []);       // nothing left inert after both close
});

test("overlays: body[data-panel] follows the open panel", () => {
  const r = rig();
  for (const id of ["search", "queue", "mixer", "settings"]) {
    r.ov.open(id);
    assert.equal(r.doc.body.dataset.panel, "right", id);
    r.ov.close(id);
    assert.equal(r.doc.body.dataset.panel, "", id);
  }
  r.ov.open("song");                               // a sheet alone is not a panel
  assert.equal(r.doc.body.dataset.panel, "");
  r.ov.close("song");
  r.ov.open("search");
  r.ov.open("queue");                              // a swap keeps it "right"
  assert.equal(r.doc.body.dataset.panel, "right");
});

test("overlays: confirm resolves true on OK and false on Back", async () => {
  const r = rig();
  r.ov.arm();
  const p = r.ov.confirm({ title: "Clear the queue?", text: "All 4 songs are removed.", okLabel: "Clear" });
  assert.equal(r.el("ov-confirm").hidden, false);
  assert.equal(r.el("ov-confirm-title").textContent, "Clear the queue?");
  assert.equal(r.el("ov-confirm-text").textContent, "All 4 songs are removed.");
  assert.equal(r.el("ov-confirm-ok").textContent, "Clear");
  assert.equal(r.doc.activeElement, r.el("ov-confirm-cancel"));  // initial focus is Cancel
  r.el("ov-confirm-ok").dispatch("click");
  assert.equal(await p, true);
  assert.equal(r.el("ov-confirm").hidden, true);
  const p2 = r.ov.confirm({ title: "Erase?", text: "", okLabel: "Erase" });
  r.ov.back();
  assert.equal(await p2, false);
  const p3 = r.ov.confirm({ title: "Again?" });
  r.el("ov-confirm-cancel").dispatch("click");
  assert.equal(await p3, false);
});

test("overlays: changes closed by tick() update visibility", () => {
  const r = rig();
  r.ov.open("adjust", { activated: false });
  const toast = r.el("ov-adjust");
  assert.equal(toast.hidden, false);
  r.clock.t += 2500;
  assert.deepEqual(r.stack.tick(), ["adjust"]);
  assert.equal(toast.hidden, true);
  assert.equal(toast.classList.contains("open"), false);
});

test("overlays: a toast is non-modal: no inert, no data-ov, no history, and it stays announced", () => {
  const r = rig();
  r.ov.arm();
  r.stage.focus();
  r.ov.open("adjust", { activated: false });
  assert.equal(isInert(r.stage), false);
  assert.equal(r.doc.body.dataset.ov, "");
  assert.equal(r.el("scrim").hidden, true);
  assert.equal(r.h.calls.push, 1);                 // the sentinel only
  assert.equal(r.doc.activeElement, r.stage);
  r.ov.open("search");                             // a panel above an open toast
  assert.equal(isInert(r.el("ov-adjust")), false);
  assert.equal(r.el("ov-adjust").getAttribute("aria-hidden"), null);
});

test("overlays: re-opening an open toast restarts its timer", () => {
  const r = rig();
  r.ov.open("adjust", { activated: false });
  r.clock.t = 2000;
  assert.equal(r.ov.open("adjust", { activated: false }), false);
  r.clock.t = 2600;
  assert.deepEqual(r.stack.tick(), []);
  r.clock.t = 4500;
  assert.deepEqual(r.stack.tick(), ["adjust"]);
});

test("overlays: the scrim and [data-ov-close] close the overlay they belong to", () => {
  const r = rig();
  r.ov.wire();
  r.ov.open("search");
  r.el("scrim").dispatch("click");
  assert.equal(r.stack.isOpen("search"), false);
  r.ov.open("settings");
  r.ov.open("song");
  r.el("settings-close").dispatch("click");        // a lower overlay's close button names its own overlay
  assert.deepEqual(r.stack.list(), ["song"]);
});

// M5 integration fix: the second click of a double-click on a row lands on the scrim the first
// click's sheet put over the panel; it must not close that sheet. A single click still does.
test("overlays: the second click of a double-click on the scrim closes nothing", () => {
  const r = rig();
  r.ov.wire();
  r.ov.open("search");
  r.ov.open("song");
  r.el("scrim").dispatch("click", { detail: 2 });
  assert.deepEqual(r.stack.list(), ["search", "song"], "detail 2: the sheet stays open");
  r.el("scrim").dispatch("click", { detail: 1 });
  assert.deepEqual(r.stack.list(), ["search"], "a single click closes the top overlay");
});

test("overlays: focus goes to initialFocus, else the first focusable, else the overlay root", () => {
  const r = rig({ register: false });
  const mixer = r.el("ov-mixer");
  mixer.querySelectorAll = () => [r.el("mixer-first")];
  r.ov.register("mixer", { el: mixer });
  r.ov.open("mixer");
  assert.equal(r.doc.activeElement, r.el("mixer-first"));
  r.ov.close("mixer");
  const song = r.el("ov-song");
  r.ov.register("song", { el: song, initialFocus: () => null });
  r.ov.open("song");
  assert.equal(song.getAttribute("tabindex"), "-1");
  assert.equal(r.doc.activeElement, song);
});

test("overlays: without native inert, aria-hidden and a focus redirect stand in", () => {
  const r = rig({ nativeInert: false });
  r.ov.wire();
  r.ov.open("search");
  assert.equal(r.stage.getAttribute("aria-hidden"), "true");
  assert.equal(isInert(r.stage), true);            // still set, for the CSS dimming
  r.homeBtn.focus();                               // this browser lets focus into the stage…
  assert.equal(r.doc.activeElement, r.el("search-first"));  // …and the redirect pulls it back
  r.ov.close("search");
  assert.equal(r.stage.getAttribute("aria-hidden"), null);
  assert.equal(isInert(r.stage), false);
});

// --- shell -------------------------------------------------------------------------------
test("shell: nextAutoHide is 0 while paused, idle or always-show", () => {
  assert.equal(nextAutoHide({ playing: false, alwaysShow: false, seconds: 3 }), 0);   // paused or idle
  assert.equal(nextAutoHide({ playing: true, alwaysShow: true, seconds: 3 }), 0);
  assert.equal(nextAutoHide({ playing: false, alwaysShow: true, seconds: 9 }), 0);
  assert.equal(nextAutoHide({}), 0);
  const s = shellRig();
  s.shell.setPlaying(true);                        // idle wins over playing
  s.advance(5000);
  assert.equal(s.hidden(), false);
});

test("shell: nextAutoHide uses the setting in seconds", () => {
  const on = (seconds) => nextAutoHide({ playing: true, alwaysShow: false, seconds });
  assert.equal(on(3), 3000);
  assert.equal(on(1.5), 1500);
  assert.equal(on(15), 15000);
  assert.equal(on(0.5), 1000);                     // at least one second
  assert.equal(on(undefined), 3000);               // missing or invalid → the 3 s default
  assert.equal(on("x"), 3000);
});

test("shell: the bar is visible at boot and after poke", () => {
  const s = shellRig();
  assert.equal(s.tickMs, 250);
  assert.equal(s.stack.isOpen("controls"), true);
  assert.equal(s.hidden(), false);
  s.shell.setIdle(false);
  s.shell.setPlaying(true);
  s.advance(2750);
  assert.equal(s.hidden(), false);
  s.advance(250);                                  // 3 s of no input while playing
  assert.equal(s.hidden(), true);
  s.shell.poke();
  assert.equal(s.hidden(), false);
  s.values["ui.playback"] = true;                  // "always show"
  s.shell.applyAutoHide();
  s.advance(10000);
  assert.equal(s.hidden(), false);
});

test("shell: overlays-dom leaves #ov-controls unhidden", () => {
  let writes = 0;
  const s = shellRig({   // trap `hidden` before the shell registers the bar
    before: (r) => Object.defineProperty(r.el("ov-controls"), "hidden", { get: () => false, set: () => { writes++; } }),
  });
  const ctl = s.el("ov-controls");
  assert.equal(ctl.classList.contains("open"), true);
  s.shell.setIdle(false);
  s.shell.setPlaying(true);
  s.advance(3000);                                 // hides by timer
  assert.equal(s.hidden(), true);
  assert.equal(ctl.classList.contains("open"), false);
  s.shell.poke();
  assert.equal(ctl.classList.contains("open"), true);
  s.ov.open("search");
  s.ov.close("search");
  s.stack.close("controls");
  assert.equal(writes, 0);                         // `hidden` never set on a "class" element
});

test("shell: adjust toast closes within 2500–2750 ms", () => {
  const s = shellRig();
  s.ov.open("adjust", { activated: false });
  const toast = s.el("ov-adjust");
  let elapsed = 0;
  while (!toast.hidden && elapsed < 5000) { s.advance(s.tickMs); elapsed += s.tickMs; }
  assert.ok(elapsed >= 2500 && elapsed <= 2750, `closed after ${elapsed} ms`);
});

test("shell: the bar never hides while a modal is open, and re-arms after", () => {
  const s = shellRig();
  s.shell.setIdle(false);
  s.shell.setPlaying(true);
  s.ov.open("search");
  s.advance(6000);
  assert.equal(s.hidden(), false);
  s.ov.close("search");
  s.advance(2750);
  assert.equal(s.hidden(), false);                 // a full period again after the close
  s.advance(250);
  assert.equal(s.hidden(), true);
});

test("shell: pausing or going idle shows the bar", () => {
  const s = shellRig();
  s.shell.setIdle(false);
  s.shell.setPlaying(true);
  s.advance(3000);
  assert.equal(s.hidden(), true);
  s.shell.setPlaying(false);
  assert.equal(s.hidden(), false);
  s.advance(10000);
  assert.equal(s.hidden(), false);
  s.shell.setPlaying(true);
  s.advance(3000);
  s.shell.setIdle(true);
  assert.equal(s.hidden(), false);
});

test("shell: wire binds the bar buttons to the overlays and the actions", () => {
  const s = shellRig();
  const click = (id) => s.el(id).dispatch("click");
  click("toggle-lib");
  assert.equal(s.stack.isOpen("search"), true);
  assert.equal(s.stack.opener("search"), s.el("toggle-lib"));
  click("toggle-lib");
  assert.equal(s.stack.isOpen("search"), false);
  click("toggle-queue");
  assert.equal(s.stack.isOpen("queue"), true);
  s.ov.close("queue");
  click("queue-count");
  assert.equal(s.stack.isOpen("queue"), true);
  click("btn-mixer");
  assert.deepEqual(s.stack.list(), ["controls", "mixer"]);
  click("btn-settings");
  assert.deepEqual(s.stack.list(), ["controls", "settings"]);
  click("btn-fullscreen");
  click("btn-restart");
  assert.deepEqual(s.calls, { restart: 1, fullscreen: 1 });
});

test("shell: the first keydown or pointerdown arms the sentinel once", () => {
  const s = shellRig();
  assert.equal(s.h.calls.push, 0);
  s.doc.body.dispatch("pointermove", { clientX: 5, clientY: 5 });
  assert.equal(s.h.calls.push, 0);                 // a move is not a user activation
  s.doc.body.dispatch("keydown", { key: "a" });
  s.doc.body.dispatch("pointerdown", {});
  s.doc.body.dispatch("keydown", { key: "b" });
  assert.equal(s.h.calls.push, 1);
  assert.deepEqual(s.h.state, { kv: "sentinel" });
});

test("shell: activity pokes the bar; a pointer resting in place does not", () => {
  const s = shellRig();
  s.shell.setIdle(false);
  s.shell.setPlaying(true);
  s.advance(3000);
  assert.equal(s.hidden(), true);
  s.doc.body.dispatch("pointermove", { clientX: 10, clientY: 10 });
  assert.equal(s.hidden(), false);
  s.advance(3000);
  s.doc.body.dispatch("pointermove", { clientX: 10, clientY: 10 });
  assert.equal(s.hidden(), true);
  s.doc.body.dispatch("touchstart", {});
  assert.equal(s.hidden(), false);
});

test("shell: setIdle, setKind and setStatus write the document", () => {
  const s = shellRig();
  s.shell.setIdle(false);
  assert.equal(s.doc.body.dataset.idle, "false");
  s.shell.setIdle(true);
  assert.equal(s.doc.body.dataset.idle, "true");
  s.shell.setKind("midi");
  assert.equal(s.doc.body.dataset.kind, "midi");
  s.shell.setKind("");
  assert.equal(s.doc.body.dataset.kind, "");
  s.shell.setStatus("Song A: 87, Good job!");
  assert.equal(s.el("status").textContent, "Song A: 87, Good job!");
  s.shell.setStatus(null);
  assert.equal(s.el("status").textContent, "");
});

// --- home --------------------------------------------------------------------------------
test("home: homeTiles keeps order and drops disabled ids", () => {
  assert.deepEqual(HOME_TILES.map((t) => t.id),
    ["songs", "artists", "rankings", "favorites", "queue", "tonight", "settings"]);
  assert.deepEqual(homeTiles(["settings", "songs", "queue", "tonight", "favorites"]).map((t) => t.id),
    ["songs", "favorites", "queue", "tonight", "settings"]);
  assert.deepEqual(homeTiles([]), []);
  for (const t of HOME_TILES) assert.ok(t.label && t.icon, t.id);
});

test("home: unknown ids are ignored", () => {
  assert.deepEqual(homeTiles(["nope", "songs", "__proto__", "constructor"]).map((t) => t.id), ["songs"]);
  assert.deepEqual(homeTiles(new Set(["queue", "x"])).map((t) => t.id), ["queue"]);
});

test("home: render builds button tiles with one delegated listener", () => {
  const doc = makeDoc();
  const home = doc.add("home");
  const tiles = doc.add("home-tiles", home, "nav");
  const room = doc.add("home-room", home);
  doc.add("i-search", doc.add("sprite", doc.body, "svg"), "symbol");
  const got = [];
  const h = createHome({ el: home, enabled: ["queue", "songs", "favorites"], onTile: (id) => got.push(id), doc });
  h.render();
  assert.deepEqual(tiles.children.map((b) => b.getAttribute("data-tile")), ["songs", "favorites", "queue"]);
  assert.ok(tiles.children.every((b) => b.tagName === "BUTTON" && b.className === "home-tile"));
  assert.equal(tiles.children[0].children[0].tagName, "SVG");      // its symbol exists
  assert.equal(tiles.children[1].children.length, 1);              // no symbol → label only
  tiles.children[2].children[0].dispatch("click");                 // a click on the label
  assert.deepEqual(got, ["queue"]);
  assert.equal(tiles.ls.click.length, 1);
  tiles.children[1].focus();
  h.render();                                      // a rebuild keeps the focused tile focused
  assert.equal(doc.activeElement.getAttribute("data-tile"), "favorites");
  assert.equal(tiles.ls.click.length, 1);          // still one listener
  h.setRoom("ABC123");
  assert.equal(room.textContent, "Room ABC123");
  h.setRoom("");
  assert.equal(room.textContent, "");
});
