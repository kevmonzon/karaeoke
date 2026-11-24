/*
 * song-sheet.test.js — the song action sheet (M5, src/js/ui/song-sheet.js): which actions each
 * mode offers, what show() renders, and how a click is reported (the 250 ms guard, one action per
 * show). The DOM parts run against a small hand-built fake with only the surface the module
 * documents: createElement, setAttribute, textContent, appendChild / replaceChildren,
 * addEventListener on the sheet element, closest() on the click target. innerHTML is a trap.
 * Run with:  node --test
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { sheetActions, createSongSheet } from "../src/js/ui/song-sheet.js";

// --- a minimal fake DOM ---------------------------------------------------------------------
class El {
  constructor(doc, tag) {
    Object.assign(this, { doc, tagName: tag.toUpperCase(), className: "", attrs: new Map(),
      children: [], parentElement: null, ls: {}, ownText: "" });
  }
  get dataset() {   // reflects data-* like the real DOM (read-only here)
    const d = {};
    for (const [k, v] of this.attrs) if (k.startsWith("data-")) d[k.slice(5).replace(/-(\w)/g, (_, c) => c.toUpperCase())] = v;
    return d;
  }
  get textContent() { return this.ownText + this.children.map((c) => c.textContent).join(""); }
  set textContent(v) { this.detachAll(); this.ownText = String(v); }
  set innerHTML(_) { this.doc.htmlWrites++; throw new Error("innerHTML must not be used"); }
  insertAdjacentHTML() { this.doc.htmlWrites++; throw new Error("insertAdjacentHTML must not be used"); }
  setAttribute(k, v) { this.attrs.set(k, String(v)); }
  getAttribute(k) { return this.attrs.has(k) ? this.attrs.get(k) : null; }
  hasAttribute(k) { return this.attrs.has(k); }
  detachAll() { for (const c of this.children) c.parentElement = null; this.children = []; }
  appendChild(c) { if (c.parentElement) c.parentElement.children = c.parentElement.children.filter((x) => x !== c); c.parentElement = this; this.children.push(c); return c; }
  replaceChildren(...cs) { this.detachAll(); this.ownText = ""; for (const c of cs) this.appendChild(c); }
  matches(sel) {
    if (sel[0] === "[") return this.hasAttribute(sel.slice(1, -1));
    if (sel[0] === ".") return this.className.split(/\s+/).includes(sel.slice(1));
    return this.tagName === sel.toUpperCase();
  }
  closest(sel) { for (let n = this; n; n = n.parentElement) if (n.matches(sel)) return n; return null; }
  *walk() { for (const c of this.children) { yield c; yield* c.walk(); } }
  all(sel) { return [...this.walk()].filter((e) => e.matches(sel)); }
  one(sel) { return this.all(sel)[0] || null; }
  addEventListener(t, fn) { (this.ls[t] ||= []).push(fn); }
  fire(type, props = {}) {
    const ev = { type, target: this, defaultPrevented: false, preventDefault() { ev.defaultPrevented = true; }, ...props };
    for (let n = this; n; n = n.parentElement) for (const fn of n.ls[type] || []) fn(ev);
    return ev;
  }
  click() { return this.fire("click"); }
}
function makeDoc() {
  const doc = { htmlWrites: 0 };
  doc.createElement = (tag) => new El(doc, tag);
  return doc;
}
// --- end of the fake DOM --------------------------------------------------------------------

const ids = (acts) => acts.map((a) => a.id);
const labels = (acts) => acts.map((a) => a.label);

const SONG = { id: "midi:123", kind: "midi", code: 123, name: "Bosom Buddies", artistName: "Someone", source: "SH" };

// A sheet on a fake element with a hand-driven clock and a log of reported actions.
function setup({ t0 = 1000 } = {}) {
  const doc = makeDoc();
  const el = doc.createElement("section");
  const clock = { t: t0 };
  const calls = [];
  const sheet = createSongSheet({ el, doc, now: () => clock.t, onAction: (...a) => calls.push(a) });
  const btn = (id) => el.all("[data-act]").find((b) => b.getAttribute("data-act") === id);
  return { doc, el, clock, calls, sheet, btn };
}

// --- sheetActions -------------------------------------------------------------------------

test("library actions in order", () => {
  const acts = sheetActions("library");
  assert.deepEqual(ids(acts), ["reserve", "next", "now", "favorite", "cancel"]);
  assert.deepEqual(labels(acts), ["Reserve", "Play next", "Play now", "★ Favorite", "Cancel"]);
});

test("the favourite label flips", () => {
  const fav = (isFavorite) => sheetActions("library", { isFavorite }).find((a) => a.id === "favorite").label;
  assert.equal(fav(false), "★ Favorite");
  assert.equal(fav(true), "★ Remove favorite");
  assert.equal(sheetActions("library", {}).find((a) => a.id === "favorite").label, "★ Favorite");
});

test("queue actions drop top/up for the first row", () => {
  const acts = sheetActions("queue", { index: 0, length: 4 });
  assert.deepEqual(ids(acts), ["now", "down", "remove", "cancel"]);
  assert.deepEqual(labels(acts), ["Play now", "Move down", "Remove", "Cancel"]);
});

test("queue actions drop down for the last row", () => {
  assert.deepEqual(ids(sheetActions("queue", { index: 3, length: 4 })), ["now", "top", "up", "remove", "cancel"]);
  // a middle row gets every move, in order, with the contract's labels
  const mid = sheetActions("queue", { index: 1, length: 4 });
  assert.deepEqual(ids(mid), ["now", "top", "up", "down", "remove", "cancel"]);
  assert.deepEqual(labels(mid), ["Play now", "Move to top", "Move up", "Move down", "Remove", "Cancel"]);
});

test("a single-row queue offers only now, remove, cancel", () => {
  assert.deepEqual(ids(sheetActions("queue", { index: 0, length: 1 })), ["now", "remove", "cancel"]);
});

test("an index that names no row offers no moves; an unknown mode offers only cancel", () => {
  for (const index of [-1, NaN, 1.5, undefined]) {
    assert.deepEqual(ids(sheetActions("queue", { index, length: 5 })), ["now", "remove", "cancel"], `index ${index}`);
  }
  assert.deepEqual(sheetActions("party"), [{ id: "cancel", label: "Cancel" }]);
  assert.deepEqual(sheetActions(undefined), [{ id: "cancel", label: "Cancel" }]);
  // pure: each call hands out fresh objects
  const a = sheetActions("library");
  a[0].label = "changed";
  assert.equal(sheetActions("library")[0].label, "Reserve");
});

// --- createSongSheet: rendering -------------------------------------------------------------

test("show renders one button per action", () => {
  const { el, sheet } = setup();
  assert.equal(sheet.song, null);
  assert.equal(sheet.firstButton(), null);

  sheet.show(SONG, { mode: "library", isFavorite: true });
  const btns = el.all("[data-act]");
  assert.deepEqual(btns.map((b) => b.getAttribute("data-act")), ["reserve", "next", "now", "favorite", "cancel"]);
  assert.deepEqual(btns.map((b) => b.textContent), ["Reserve", "Play next", "Play now", "★ Remove favorite", "Cancel"]);
  for (const b of btns) {
    assert.equal(b.tagName, "BUTTON");
    assert.equal(b.getAttribute("type"), "button");
    assert.equal(b.dataset.act, b.getAttribute("data-act"));
    assert.equal(b.ls.click, undefined, "no per-button handlers");
    assert.equal(b.getAttribute("onclick"), null, "no inline handlers");
  }
  assert.equal(sheet.firstButton(), btns[0]);
  assert.equal(sheet.song, SONG);
  // header + action group, nothing else
  assert.equal(el.children.length, 2);
  assert.equal(el.one(".sheet-title").textContent, "Bosom Buddies");
  assert.equal(el.one(".sheet-artist").textContent, "Someone");
  const icon = el.one(".kind");
  assert.equal(icon.textContent, "🎤");
  assert.equal(icon.className, "kind kar");
  assert.equal(icon.getAttribute("aria-label"), "MIDI");

  // queue mode, middle row
  sheet.show(SONG, { mode: "queue", index: 2, length: 5 });
  assert.deepEqual(el.all("[data-act]").map((b) => b.getAttribute("data-act")), ["now", "top", "up", "down", "remove", "cancel"]);
  // no mode → library
  sheet.show(SONG);
  assert.equal(el.all("[data-act]").length, 5);
});

test("the kind icon follows the song's kind, like a library row", () => {
  const { el, sheet } = setup();
  const cases = [["midi", "🎤", "kar"], ["video", "🎞️", "vid"], ["youtube", "🌐", "yt"], ["audio", "🎵", "aud"],
    ["weird", "🎤", "kar"], ["__proto__", "🎤", "kar"], [undefined, "🎤", "kar"]];
  for (const [kind, glyph, cls] of cases) {
    sheet.show({ ...SONG, kind });
    const icon = el.one(".kind");
    assert.equal(icon.textContent, glyph, String(kind));
    assert.equal(icon.className, `kind ${cls}`, String(kind));
  }
});

test("the header shows the number and the songbook chip only when present", () => {
  const { el, sheet } = setup();
  sheet.show(SONG);
  assert.equal(el.one(".sheet-code").textContent, "123");
  const chip = el.one(".src-chip");
  assert.equal(chip.textContent, "SH");
  assert.equal(chip.getAttribute("data-src"), "SH");
  assert.equal(chip.parentElement, el.one(".sheet-num"), "the chip sits under the number, as in a row");

  sheet.show({ ...SONG, source: "" });
  assert.equal(el.one(".src-chip"), null);
  assert.equal(el.one(".sheet-code").textContent, "123");

  sheet.show({ ...SONG, source: undefined, code: 0 });            // 0 is a real dial number
  assert.equal(el.one(".sheet-code").textContent, "0");

  sheet.show({ ...SONG, kind: "youtube", code: "", source: "" });  // YouTube: no number, no chip
  assert.equal(el.one(".sheet-num"), null);
  assert.equal(el.one(".sheet-code"), null);
  assert.equal(el.one(".src-chip"), null);

  sheet.show({ ...SONG, code: null, source: "PLATKAR" });          // a chip without a number
  assert.equal(el.one(".sheet-code"), null);
  assert.equal(el.one(".src-chip").textContent, "PLATKAR");

  sheet.show({ id: "x", kind: "midi", code: 7 });                  // no name, no artist
  assert.equal(el.one(".sheet-title").textContent, "(untitled)");
  assert.equal(el.one(".sheet-artist"), null);
});

test("titles and artists render as text, never HTML", () => {
  const { doc, el, sheet } = setup();
  const evil = '<img src=x onerror="alert(1)">';
  sheet.show({ ...SONG, name: evil, artistName: `<b>${evil}</b>`, source: "<i>SH</i>" });
  assert.equal(doc.htmlWrites, 0);
  assert.equal(el.one(".sheet-title").textContent, evil);
  assert.equal(el.one(".sheet-artist").textContent, `<b>${evil}</b>`);
  assert.equal(el.one(".src-chip").textContent, "<i>SH</i>");
  assert.deepEqual(el.all("img"), []);
  assert.deepEqual(el.all("b"), []);
  assert.deepEqual(el.all("i"), []);
  assert.equal(el.one(".sheet-title").children.length, 0);
});

// --- createSongSheet: clicks ----------------------------------------------------------------

test("clicking a button reports the action with the song and index", () => {
  const { clock, calls, sheet, btn } = setup();
  const QSONG = { ...SONG, id: "midi:9" };
  sheet.show(QSONG, { mode: "queue", index: 2, length: 5 });
  clock.t += 300;
  btn("up").click();
  assert.equal(calls.length, 1);
  const [id, song, ctx] = calls[0];
  assert.equal(id, "up");
  assert.equal(song, QSONG);
  assert.deepEqual(ctx, { mode: "queue", index: 2 });

  // library mode reports its own mode and the index it was given (-1 by default)
  sheet.show(SONG);
  clock.t += 300;
  btn("favorite").click();
  assert.deepEqual(calls[1], ["favorite", SONG, { mode: "library", index: -1 }]);
});

test("clicks inside the first 250 ms are ignored and a later click goes through", () => {
  const { clock, calls, sheet, btn } = setup({ t0: 5000 });
  sheet.show(SONG);
  btn("reserve").click();           // the second click of a double-click: same instant
  clock.t = 5100;
  btn("reserve").click();
  clock.t = 5249.9;
  btn("now").click();
  assert.equal(calls.length, 0);
  clock.t = 5250;
  btn("now").click();
  assert.deepEqual(calls.map((c) => c[0]), ["now"]);
});

test("the guard restarts on every show, and the default clock guards too", () => {
  const { clock, calls, sheet, btn } = setup();
  sheet.show(SONG);
  clock.t += 1000;
  sheet.show(SONG);                 // re-shown: a fresh 250 ms
  btn("next").click();
  assert.equal(calls.length, 0);
  clock.t += 250;
  btn("next").click();
  assert.equal(calls.length, 1);

  // no injected clock: an immediate click after show() is still the guarded double-click
  const doc = makeDoc();
  const el = doc.createElement("section");
  const seen = [];
  const real = createSongSheet({ el, doc, onAction: (id) => seen.push(id) });
  real.show(SONG);
  real.firstButton().click();
  assert.deepEqual(seen, []);
});

test("one show, one action: a second click is ignored until the next show", () => {
  const { clock, calls, sheet, btn } = setup();
  sheet.show(SONG, { mode: "queue", index: 1, length: 3 });
  clock.t += 300;
  btn("remove").click();
  btn("remove").click();            // a double-click on Remove must not remove two songs
  btn("down").click();
  assert.deepEqual(calls.map((c) => c[0]), ["remove"]);
  sheet.show(SONG, { mode: "queue", index: 1, length: 2 });
  clock.t += 300;
  btn("remove").click();
  assert.deepEqual(calls.map((c) => c[0]), ["remove", "remove"]);
});

test("a held Enter (auto-repeat) never presses a sheet button", () => {
  const { el, clock, sheet, btn } = setup();
  sheet.show(SONG);
  clock.t += 1000;
  const b = btn("reserve");
  assert.equal(b.fire("keydown", { key: "Enter", repeat: true }).defaultPrevented, true);
  assert.equal(b.fire("keydown", { key: "Unidentified", keyCode: 13, repeat: true }).defaultPrevented, true, "a TV's OK");
  assert.equal(b.fire("keydown", { key: "Enter", repeat: false }).defaultPrevented, false, "a fresh press is the user's");
  assert.equal(b.fire("keydown", { key: "ArrowDown", repeat: true }).defaultPrevented, false, "arrows stay the router's");
  assert.equal(el.one(".sheet-title").fire("keydown", { key: "Enter", repeat: true }).defaultPrevented, false);
  assert.equal(el.ls.keydown.length, 1);
});

test("a throwing onAction re-arms the sheet", () => {
  const doc = makeDoc();
  const el = doc.createElement("section");
  const clock = { t: 0 };
  let fail = true;
  const seen = [];
  const sheet = createSongSheet({ el, doc, now: () => clock.t,
    onAction: (id) => { seen.push(id); if (fail) throw new Error("boom"); } });
  sheet.show(SONG);
  clock.t = 1000;
  assert.throws(() => sheet.firstButton().click(), /boom/);
  fail = false;
  sheet.firstButton().click();
  assert.deepEqual(seen, ["reserve", "reserve"]);
});

test("a second show() replaces the content and reports the NEW song", () => {
  const { el, clock, calls, sheet, btn } = setup();
  const A = { ...SONG, id: "midi:1", name: "Song A" };
  const B = { ...SONG, id: "video:2", kind: "video", code: 2, name: "Song B", source: "" };
  sheet.show(A);
  const oldFirst = sheet.firstButton();
  clock.t += 500;
  sheet.show(B, { mode: "queue", index: 0, length: 1 });
  assert.equal(el.children.length, 2);
  assert.equal(el.all(".sheet-title").length, 1);
  assert.equal(el.one(".sheet-title").textContent, "Song B");
  assert.equal(el.one(".kind").textContent, "🎞️");
  assert.deepEqual(el.all("[data-act]").map((b) => b.getAttribute("data-act")), ["now", "remove", "cancel"]);
  assert.notEqual(sheet.firstButton(), oldFirst);
  assert.equal(sheet.song, B);
  clock.t += 300;
  oldFirst.click();                 // a detached button from the old content does nothing
  assert.equal(calls.length, 0);
  btn("now").click();
  assert.deepEqual(calls, [["now", B, { mode: "queue", index: 0 }]]);
});

test("one delegated listener, added once; clicks off the buttons report nothing", () => {
  const { el, clock, calls, sheet } = setup();
  assert.equal(el.ls.click.length, 1);
  for (let i = 0; i < 5; i++) sheet.show(SONG);
  assert.equal(el.ls.click.length, 1);
  clock.t += 300;
  el.one(".sheet-title").click();
  el.one(".sheet-head").click();
  el.click();
  // closest() walking out of the sheet to someone else's [data-act] is not a sheet button
  const outer = el.doc.createElement("div");
  outer.setAttribute("data-act", "reserve");
  outer.appendChild(el);
  el.one(".sheet-title").click();
  assert.equal(calls.length, 0);
  el.one("[data-act]").click();
  assert.equal(calls.length, 1, "one click, one report");
});

test("works without appendChild/replaceChildren, and asks for its element", () => {
  // the shell test's style of fake: append() only
  const doc = makeDoc();
  const el = doc.createElement("section");
  const mk = doc.createElement;
  doc.createElement = (tag) => {
    const n = mk(tag);
    n.append = (...cs) => { for (const c of cs) El.prototype.appendChild.call(n, c); };
    n.appendChild = undefined;
    n.replaceChildren = undefined;
    return n;
  };
  const bare = doc.createElement("section");
  const sheet = createSongSheet({ el: bare, doc, now: () => 0, onAction() {} });
  sheet.show(SONG);
  assert.equal(bare.all("[data-act]").length, 5);
  sheet.show(SONG, { mode: "queue", index: 0, length: 1 });
  assert.equal(bare.all("[data-act]").length, 3, "the old content is gone");
  assert.ok(el);
  assert.throws(() => createSongSheet({ onAction() {} }), TypeError);
  assert.throws(() => sheet.show(null), TypeError);
});
