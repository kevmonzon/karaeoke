/*
 * browse-ui.test.js — the Songs panel's browse controls (M6, src/js/ui/browse-ui.js): the three
 * tabs and their keys, the songbook / type chips, the sort select, and the rankings view (rows as
 * text, player / difficulty filters, Clear, the empty state), plus setTab / reset and which
 * container shows on which tab. The DOM parts run against a small hand-built fake with only the
 * surface the module documents: createElement, setAttribute, textContent, appendChild /
 * replaceChildren, addEventListener, hidden, parentElement — plus activeElement / focus() /
 * contains() and a select's `value`, which the module feature-detects. innerHTML is a trap.
 * Run with:  node --test
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { BROWSE_TABS, createBrowseUI } from "../src/js/ui/browse-ui.js";
import { KINDS, SORTS } from "../src/js/library-browse.js";

// --- a minimal fake DOM ---------------------------------------------------------------------
class El {
  constructor(doc, tag) {
    Object.assign(this, { doc, tagName: tag.toUpperCase(), className: "", attrs: new Map(),
      children: [], parentElement: null, ls: {}, ownText: "", hidden: false });
  }
  get id() { return this.attrs.get("id") || ""; }
  set id(v) { this.attrs.set("id", String(v)); }
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
  appendChild(c) {
    if (c.parentElement) c.parentElement.children = c.parentElement.children.filter((x) => x !== c);
    c.parentElement = this; this.children.push(c); return c;
  }
  replaceChildren(...cs) { this.detachAll(); this.ownText = ""; for (const c of cs) this.appendChild(c); }
  contains(n) { for (let x = n; x; x = x.parentElement) if (x === this) return true; return false; }
  matches(sel) {
    const m = /^\[([\w-]+)(?:="([^"]*)")?\]$/.exec(sel);
    if (m) return m[2] === undefined ? this.hasAttribute(m[1]) : this.getAttribute(m[1]) === m[2];
    if (sel[0] === ".") return this.className.split(/\s+/).includes(sel.slice(1));
    if (sel[0] === "#") return this.id === sel.slice(1);
    return this.tagName === sel.toUpperCase();
  }
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
  focus() {   // like a browser: a hidden or detached element does not take focus
    let n = this;
    for (; n; n = n.parentElement) { if (n.hidden) return; if (n === this.doc.body) break; }
    if (!n) return;
    this.doc.activeElement = this;
  }
}
function makeDoc() {
  const doc = { htmlWrites: 0, made: [] };
  doc.createElement = (tag) => { doc.made.push(tag.toUpperCase()); return new El(doc, tag); };
  doc.body = new El(doc, "body");
  doc.activeElement = doc.body;
  return doc;
}
// --- end of the fake DOM --------------------------------------------------------------------

// A tiny stand-in for lane I's getRankings (rankings.js topRankings / rankingPlayers semantics).
function rankingsOf(list) {
  return ({ player = "", difficulty = "" } = {}) => {
    const byScore = [...list].sort((a, b) => b.score - a.score || b.at - a.at);
    const players = [...new Set(byScore.map((e) => e.player))];
    const present = new Set(list.map((e) => e.difficulty));
    return {
      rows: byScore.filter((e) => (!player || e.player === player) && (!difficulty || e.difficulty === difficulty)).slice(0, 50),
      players,
      difficulties: ["easy", "normal", "hard"].filter((d) => present.has(d)),
    };
  };
}
const AT = Date.UTC(2026, 10, 24, 20, 30);
const entry = (player, score, difficulty = "normal", i = 0) =>
  ({ player, songId: `midi:${i}`, song: `Song ${i}`, artist: `Artist ${i}`, score, difficulty, at: AT + i * 60000 });

const FACETS = { sources: ["SH", "PLATKAR", "TJMEDIA"], kinds: ["midi", "audio"] };

function setup({ facets = FACETS, rankings = [], getRankings = null } = {}) {
  const doc = makeDoc();
  const panel = doc.body.appendChild(doc.createElement("section"));
  const mk = (id) => {
    const el = panel.appendChild(doc.createElement("div"));
    el.id = id;
    el.hidden = true;
    return el;
  };
  const tabsEl = mk("browse-tabs");
  const chipsEl = mk("filter-chips");
  const paneEl = mk("browse-pane");
  doc.made.length = 0;
  const calls = { tab: [], filters: [], sort: [], clear: 0, facets: 0, rankings: [] };
  const state = { facets, rankings };
  const rank = getRankings || ((f) => rankingsOf(state.rankings)(f));
  const ui = createBrowseUI({
    tabsEl, chipsEl, paneEl, doc,
    getFacets: () => { calls.facets++; return state.facets; },
    getRankings: (f) => { calls.rankings.push({ ...f }); return rank(f); },
    onTab: (id) => calls.tab.push(id),
    onFilters: (f) => calls.filters.push(f),
    onSort: (m) => calls.sort.push(m),
    onClearRankings: () => { calls.clear++; },
  });
  const tabBtns = () => tabsEl.all("[role=\"tab\"]");
  const tabBtn = (id) => tabsEl.one(`[data-tab="${id}"]`);
  const srcChip = (v) => (v === "" ? chipsEl.one(".chip-group-src").all(".chip").find((c) => c.textContent === "All")
    : chipsEl.one(`[data-src="${v}"]`));
  const kindChip = (v) => chipsEl.one(`[data-kind="${v}"]`);
  const playerChip = (name) => paneEl.one(".chip-group-player").all(".chip").find((c) => c.textContent === name);
  const diffChip = (v) => (v === "" ? paneEl.one(".chip-group-diff").all(".chip").find((c) => c.textContent === "All")
    : paneEl.one(`[data-difficulty="${v}"]`));
  const sortEl = () => chipsEl.one("#browse-sort");
  const rows = () => paneEl.one("tbody").children;
  const clearBtn = () => paneEl.one("[data-act=\"clear-rankings\"]");
  const emptyEl = () => paneEl.one(".rank-empty");
  return { doc, panel, tabsEl, chipsEl, paneEl, ui, calls, state, tabBtns, tabBtn, srcChip, kindChip,
    playerChip, diffChip, sortEl, rows, clearBtn, emptyEl };
}
const pressed = (b) => b.getAttribute("aria-pressed") === "true";
const keydown = (el, key, extra = {}) => el.fire("keydown", { key, ...extra });
const sorted = (set) => [...set].sort();
const shown = (el, root) => { for (let n = el; n; n = n.parentElement) { if (n.hidden) return false; if (n === root) return true; } return false; };

// --- tabs -----------------------------------------------------------------------------------

test("three tabs, in order", () => {
  const r = setup();
  assert.deepEqual(BROWSE_TABS.map((t) => t.id), ["all", "artists", "rankings"]);
  assert.equal(r.doc.made.length, 0, "nothing is built before render()");
  assert.equal(r.tabsEl.hidden, true);

  r.ui.render();
  assert.equal(r.tabsEl.hidden, false);
  assert.equal(r.tabsEl.getAttribute("role"), "tablist");
  const tabs = r.tabBtns();
  assert.equal(r.tabsEl.children.length, 3);
  assert.deepEqual(tabs.map((b) => b.textContent), ["All", "Artists", "Rankings"]);
  assert.deepEqual(tabs.map((b) => b.dataset.tab), ["all", "artists", "rankings"]);
  for (const b of tabs) {
    assert.equal(b.tagName, "BUTTON");
    assert.equal(b.getAttribute("type"), "button");
    assert.equal(b.ls.click, undefined, "no per-button handlers");
    assert.equal(b.getAttribute("onclick"), null, "no inline handlers");
    assert.equal(b.getAttribute("style"), null, "no inline styles");
  }
  assert.deepEqual(tabs.map((b) => b.getAttribute("aria-selected")), ["true", "false", "false"]);
  assert.deepEqual(tabs.map((b) => b.getAttribute("tabindex")), ["0", "-1", "-1"]);
  assert.deepEqual(tabs.map((b) => b.getAttribute("aria-controls")), ["song-list", "song-list", "browse-pane"]);
  assert.equal(r.ui.tab, "all");
  assert.deepEqual(r.calls.tab, [], "render fires no callback");

  r.ui.render();   // a second render keeps the same three tabs
  assert.equal(r.tabsEl.children.length, 3);
  assert.equal(r.tabBtns()[0], tabs[0]);
});

test("arrow keys move the selected tab", () => {
  const r = setup();
  r.ui.render();
  r.tabBtn("all").focus();

  let ev = keydown(r.tabBtn("all"), "ArrowRight");
  assert.equal(ev.defaultPrevented, true);
  assert.equal(r.ui.tab, "artists");
  assert.equal(r.doc.activeElement, r.tabBtn("artists"), "focus moves with the selection");
  assert.deepEqual(r.tabBtns().map((b) => b.getAttribute("aria-selected")), ["false", "true", "false"]);
  assert.deepEqual(r.tabBtns().map((b) => b.getAttribute("tabindex")), ["-1", "0", "-1"]);
  assert.deepEqual(r.calls.tab, ["artists"]);

  ev = keydown(r.tabBtn("artists"), "ArrowRight");
  assert.equal(ev.defaultPrevented, true);
  assert.equal(r.ui.tab, "rankings");

  // the last tab: the arrow is NOT prevented, so the D-pad router moves on
  ev = keydown(r.tabBtn("rankings"), "ArrowRight");
  assert.equal(ev.defaultPrevented, false);
  assert.equal(r.ui.tab, "rankings");
  assert.deepEqual(r.calls.tab, ["artists", "rankings"]);

  ev = keydown(r.tabBtn("rankings"), "ArrowLeft");
  assert.equal(ev.defaultPrevented, true);
  assert.equal(r.ui.tab, "artists");
  keydown(r.tabBtn("artists"), "ArrowLeft");
  assert.equal(r.ui.tab, "all");
  // the first tab: Left is not prevented either
  ev = keydown(r.tabBtn("all"), "ArrowLeft");
  assert.equal(ev.defaultPrevented, false);
  assert.deepEqual(r.calls.tab, ["artists", "rankings", "artists", "all"]);

  // a TV remote with no key name (keyCode 39), and chords / other keys left alone
  ev = keydown(r.tabBtn("all"), "Unidentified", { keyCode: 39 });
  assert.equal(ev.defaultPrevented, true);
  assert.equal(r.ui.tab, "artists");
  for (const extra of [{ ctrlKey: true }, { altKey: true }, { metaKey: true }]) {
    ev = keydown(r.tabBtn("artists"), "ArrowRight", extra);
    assert.equal(ev.defaultPrevented, false);
  }
  for (const k of ["ArrowUp", "ArrowDown", "Enter", " ", "Home"]) {
    assert.equal(keydown(r.tabBtn("artists"), k).defaultPrevented, false, k);
  }
  assert.equal(r.ui.tab, "artists");
  // an event another widget already handled is not acted on
  ev = keydown(r.tabBtn("artists"), "ArrowRight", { defaultPrevented: true });
  assert.equal(r.ui.tab, "artists");
});

test("a click selects a tab; the selected tab again reports nothing", () => {
  const r = setup();
  r.ui.render();
  r.tabBtn("rankings").click();
  assert.equal(r.ui.tab, "rankings");
  assert.equal(r.tabBtn("rankings").getAttribute("aria-selected"), "true");
  r.tabBtn("rankings").click();
  r.tabBtn("artists").click();
  assert.deepEqual(r.calls.tab, ["rankings", "artists"]);
});

// --- chips ----------------------------------------------------------------------------------

test("a chip toggles aria-pressed and reports the filter set", () => {
  const r = setup();
  r.ui.render();
  assert.equal(r.chipsEl.hidden, false);
  const sh = r.srcChip("SH");
  assert.equal(sh.tagName, "BUTTON");
  assert.equal(sh.getAttribute("type"), "button");
  assert.equal(pressed(sh), false);
  assert.equal(pressed(r.srcChip("")), true, "All is pressed while no songbook is");

  sh.click();
  assert.equal(pressed(sh), true);
  assert.equal(pressed(r.srcChip("")), false);
  assert.equal(r.calls.filters.length, 1);
  assert.deepEqual(sorted(r.calls.filters[0].sources), ["SH"]);
  assert.deepEqual(sorted(r.calls.filters[0].kinds), []);

  r.srcChip("PLATKAR").click();   // multi-select
  assert.deepEqual(sorted(r.calls.filters[1].sources), ["PLATKAR", "SH"]);
  r.kindChip("audio").click();
  assert.equal(pressed(r.kindChip("audio")), true);
  assert.equal(pressed(r.kindChip("midi")), false);
  assert.deepEqual(sorted(r.calls.filters[2].kinds), ["audio"]);
  assert.deepEqual(sorted(r.calls.filters[2].sources), ["PLATKAR", "SH"]);

  sh.click();                     // toggles back off
  assert.equal(pressed(sh), false);
  assert.deepEqual(sorted(r.ui.filters.sources), ["PLATKAR"]);
  r.kindChip("audio").click();
  assert.deepEqual(sorted(r.ui.filters.kinds), []);

  // the reported sets and the getter are copies
  const f = r.ui.filters;
  f.sources.add("TJMEDIA");
  r.calls.filters[0].sources.add("TJMEDIA");
  assert.deepEqual(sorted(r.ui.filters.sources), ["PLATKAR"]);
  // a click on a chip's icon counts as the chip; a click on a group label is nothing
  r.kindChip("midi").one(".chip-icon").click();
  assert.deepEqual(sorted(r.ui.filters.kinds), ["midi"]);
  const before = r.calls.filters.length;
  r.chipsEl.one(".chip-label").click();
  r.chipsEl.click();
  assert.equal(r.calls.filters.length, before);
});

test("All clears the other chips", () => {
  const r = setup();
  r.ui.render();
  r.srcChip("SH").click();
  r.srcChip("TJMEDIA").click();
  r.kindChip("midi").click();
  r.srcChip("").click();
  assert.equal(pressed(r.srcChip("")), true);
  assert.equal(pressed(r.srcChip("SH")), false);
  assert.equal(pressed(r.srcChip("TJMEDIA")), false);
  assert.equal(pressed(r.kindChip("midi")), true, "All clears only the songbook chips");
  const last = r.calls.filters.at(-1);
  assert.deepEqual(sorted(last.sources), []);
  assert.deepEqual(sorted(last.kinds), ["midi"]);
  const n = r.calls.filters.length;
  r.srcChip("").click();          // already all: nothing changed, nothing reported
  assert.equal(r.calls.filters.length, n);
});

test("the two groups: labelled, in order, and a group with no present values is hidden", () => {
  const r = setup({ facets: { sources: ["SH", "MIDI"], kinds: ["video", "midi", "youtube"] } });
  r.ui.render();
  const groups = r.chipsEl.all("[role=\"group\"]");
  assert.equal(groups.length, 2);
  const label = (g) => r.chipsEl.one(`#${g.getAttribute("aria-labelledby")}`).textContent;
  assert.deepEqual(groups.map(label), ["Songbook", "Type"]);
  assert.deepEqual(groups[0].all(".chip").map((c) => c.textContent), ["All", "SH", "MIDI"]);
  // kinds in KINDS order with their icons; a kind KINDS does not know is not a chip
  const kindChips = groups[1].all(".chip");
  assert.deepEqual(kindChips.map((c) => c.dataset.kind), ["midi", "video"]);
  for (const c of kindChips) {
    const k = KINDS.find((x) => x.id === c.dataset.kind);
    assert.equal(c.one(".chip-icon").textContent, k.icon);
    assert.equal(c.one(".chip-icon").getAttribute("aria-hidden"), "true");
    assert.equal(c.one(".chip-text").textContent, k.label);
  }

  r.state.facets = { sources: [], kinds: ["midi"] };   // an old catalogue: no songbooks
  r.ui.render();
  assert.equal(r.chipsEl.one(".chip-group-src").hidden, true);
  assert.equal(r.chipsEl.one(".chip-group-src").all(".chip").length, 0);
  assert.equal(r.chipsEl.one(".chip-group-kind").hidden, false);
  r.state.facets = { sources: [], kinds: [] };
  r.ui.render();
  assert.equal(r.chipsEl.one(".chip-group-kind").hidden, true);
  assert.equal(r.chipsEl.hidden, false, "the sort is still there");
  assert.ok(shown(r.sortEl(), r.chipsEl));

  // getFacets missing or throwing renders no chips rather than throwing
  const r2 = setup({ facets: null });
  r2.ui.render();
  assert.equal(r2.chipsEl.one(".chip-group-src").hidden, true);
  const errs = [];
  const orig = console.error;
  console.error = (e) => errs.push(e);
  try {
    const r3 = setup();
    r3.state.facets = undefined;
    Object.defineProperty(r3.state, "facets", { get() { throw new Error("not loaded"); } });
    r3.ui.render();
    assert.equal(r3.chipsEl.one(".chip-group-kind").hidden, true);
  } finally { console.error = orig; }
  assert.equal(errs.length, 1);
});

test("the sort select reports its mode", () => {
  const r = setup();
  r.ui.render();
  const sel = r.sortEl();
  assert.equal(sel.tagName, "SELECT");
  assert.equal(sel.parentElement.parentElement, r.chipsEl);
  assert.deepEqual(sel.children.map((op) => op.value), SORTS.map((s) => s.id));
  assert.deepEqual(sel.children.map((op) => op.textContent), SORTS.map((s) => s.label));
  assert.equal(r.ui.sort, "relevance");
  assert.equal(sel.value, "relevance");
  const lbl = r.chipsEl.one("[for=\"browse-sort\"]");
  assert.equal(lbl.tagName, "LABEL");
  assert.equal(lbl.textContent, "Sort");

  sel.value = "title";
  sel.fire("change");
  assert.equal(r.ui.sort, "title");
  assert.deepEqual(r.calls.sort, ["title"]);
  sel.fire("change");             // unchanged → nothing
  sel.value = "nonsense";         // not a SORTS id → ignored
  sel.fire("change");
  assert.equal(r.ui.sort, "title");
  sel.value = "code";
  sel.fire("change");
  assert.deepEqual(r.calls.sort, ["title", "code"]);
  assert.deepEqual(r.calls.filters, [], "a sort is not a filter");

  r.ui.render();                  // a re-render keeps the sort and the select
  assert.equal(r.sortEl(), sel);
  assert.equal(sel.value, "code");
  assert.equal(r.ui.sort, "code");
});

test("render keeps the current tab, filters and sort where still valid", () => {
  const r = setup();
  r.ui.render();
  r.srcChip("SH").click();
  r.srcChip("PLATKAR").click();
  r.kindChip("audio").click();
  r.sortEl().value = "artist";
  r.sortEl().fire("change");
  r.tabBtn("artists").click();
  const n = { filters: r.calls.filters.length, sort: r.calls.sort.length, tab: r.calls.tab.length };

  r.srcChip("SH").focus();
  r.state.facets = { sources: ["SH", "TJMEDIA"], kinds: ["midi"] };   // PLATKAR and audio are gone
  r.ui.render();
  assert.deepEqual(sorted(r.ui.filters.sources), ["SH"]);
  assert.deepEqual(sorted(r.ui.filters.kinds), []);
  assert.equal(r.ui.sort, "artist");
  assert.equal(r.ui.tab, "artists");
  assert.equal(pressed(r.srcChip("SH")), true);
  assert.equal(pressed(r.srcChip("")), false);
  assert.equal(r.srcChip("PLATKAR"), null);
  assert.equal(r.doc.activeElement, r.srcChip("SH"), "focus follows the rebuilt chip");
  assert.deepEqual({ filters: r.calls.filters.length, sort: r.calls.sort.length, tab: r.calls.tab.length }, n,
    "render fires no callbacks");

  r.kindChip("midi").focus();
  r.state.facets = { sources: ["SH", "TJMEDIA"], kinds: ["video"] };
  r.ui.render();
  assert.equal(r.doc.activeElement, r.srcChip(""), "a vanished chip hands focus to the group's first chip");
  assert.equal(r.doc.htmlWrites, 0);
});

// --- which container shows on which tab -----------------------------------------------------

test("chips and sort are hidden on Rankings, the pane on All and Artists", () => {
  const r = setup({ rankings: [entry("Rae", 90)] });
  r.ui.render();
  assert.equal(r.chipsEl.hidden, false);
  assert.equal(r.paneEl.hidden, true);
  assert.equal(r.calls.rankings.length, 0, "the rankings are not read while hidden");
  r.tabBtn("artists").click();
  assert.equal(r.chipsEl.hidden, false);
  assert.equal(r.paneEl.hidden, true);
  r.tabBtn("rankings").click();
  assert.equal(r.chipsEl.hidden, true);
  assert.equal(r.paneEl.hidden, false);
  assert.equal(r.tabsEl.hidden, false);
  assert.equal(r.paneEl.getAttribute("role"), "tabpanel");
  assert.equal(r.paneEl.getAttribute("aria-labelledby"), "browse-tab-rankings");
  assert.equal(r.calls.rankings.length, 1, "switching to Rankings reads them");

  // a chip that had focus hands it to the selected tab when its row goes away
  r.tabBtn("all").click();
  r.srcChip("SH").focus();
  r.ui.setTab("rankings");
  assert.equal(r.doc.activeElement, r.tabBtn("rankings"));
});

test("setTab and reset", () => {
  const r = setup({ rankings: [entry("Rae", 90), entry("Ana", 70, "hard", 1)] });
  r.ui.setTab("rankings");        // before render(): builds first, then switches
  assert.equal(r.ui.tab, "rankings");
  assert.equal(r.tabsEl.hidden, false);
  assert.equal(r.paneEl.hidden, false);
  assert.equal(r.chipsEl.hidden, true);
  assert.deepEqual(r.calls.tab, ["rankings"]);
  r.ui.setTab("rankings");        // already there: no-op
  r.ui.setTab("bogus");
  r.ui.setTab(undefined);
  assert.deepEqual(r.calls.tab, ["rankings"]);
  assert.equal(r.ui.tab, "rankings");

  r.playerChip("Ana").click();
  r.diffChip("hard").click();
  r.ui.setTab("all");
  r.srcChip("SH").click();
  r.kindChip("midi").click();
  r.sortEl().value = "title";
  r.sortEl().fire("change");
  r.ui.setTab("artists");
  const n = { tab: r.calls.tab.length, filters: r.calls.filters.length, sort: r.calls.sort.length };

  r.ui.reset();
  assert.equal(r.ui.tab, "all");
  assert.deepEqual(sorted(r.ui.filters.sources), []);
  assert.deepEqual(sorted(r.ui.filters.kinds), []);
  assert.equal(r.ui.sort, "relevance");
  assert.equal(r.sortEl().value, "relevance");
  assert.equal(pressed(r.srcChip("")), true);
  assert.equal(pressed(r.srcChip("SH")), false);
  assert.equal(pressed(r.kindChip("midi")), false);
  assert.equal(r.tabBtn("all").getAttribute("aria-selected"), "true");
  assert.equal(r.tabBtn("artists").getAttribute("tabindex"), "-1");
  assert.equal(r.paneEl.hidden, true);
  assert.equal(r.chipsEl.hidden, false);
  assert.deepEqual({ tab: r.calls.tab.length, filters: r.calls.filters.length, sort: r.calls.sort.length }, n,
    "reset fires no callbacks");

  // the rankings filters were reset too
  r.calls.rankings.length = 0;
  r.ui.setTab("rankings");
  assert.deepEqual(r.calls.rankings, [{ player: "", difficulty: "" }]);
  assert.equal(pressed(r.playerChip("All")), true);

  // reset before anything was rendered builds nothing
  const r2 = setup();
  r2.ui.reset();
  assert.equal(r2.doc.made.length, 0);
  assert.equal(r2.tabsEl.hidden, true);
});

// --- the rankings view ----------------------------------------------------------------------

test("the rankings view renders at most 50 rows, as text", () => {
  const evil = "<img src=x onerror=\"alert(1)\">";
  const list = Array.from({ length: 60 }, (_, i) => entry(i === 0 ? evil : `P${i % 7}`, 100 - i * 0.6, "normal", i));
  list[0].song = "<b>Bold</b> & <script>x()</script>";
  list[1].artist = "";
  const r = setup({ rankings: list });
  r.ui.setTab("rankings");

  assert.equal(r.rows().length, 50);
  const heads = r.paneEl.one("thead").all("th");
  assert.deepEqual(heads.map((h) => h.textContent), ["#", "Player", "Song", "Score", "Difficulty", "Date"]);
  assert.ok(heads.every((h) => h.getAttribute("scope") === "col"));

  const first = r.rows()[0];
  assert.deepEqual(first.children.map((c) => c.className), ["rk-pos", "rk-player", "rk-song", "rk-score", "rk-diff", "rk-date"]);
  assert.equal(first.children[0].textContent, "1");
  assert.equal(first.children[1].textContent, evil, "a player named <img onerror> stays text");
  assert.equal(first.one(".rk-title").textContent, "<b>Bold</b> & <script>x()</script>");
  assert.equal(first.one(".rk-artist").textContent, "Artist 0");
  assert.equal(first.children[3].textContent, "100");
  assert.equal(first.children[4].textContent, "Normal");
  const time = first.one("time");
  assert.equal(time.textContent, new Intl.DateTimeFormat(undefined, { dateStyle: "short" }).format(new Date(AT)));
  assert.equal(time.getAttribute("datetime"), new Date(AT).toISOString());

  const second = r.rows()[1];
  assert.equal(second.children[0].textContent, "2");
  assert.equal(second.children[3].textContent, String(Math.round(100 - 0.6)), "scores are rounded");
  assert.equal(second.one(".rk-artist"), null, "no artist line without an artist");
  assert.equal(r.rows()[49].children[0].textContent, "50");

  assert.equal(r.doc.htmlWrites, 0);
  for (const tag of ["IMG", "SCRIPT", "B"]) assert.ok(!r.doc.made.includes(tag), `no <${tag.toLowerCase()}> was created`);
  assert.equal(r.paneEl.one(".rank-scroll").hidden, false);
  assert.equal(r.emptyEl().hidden, true);

  // a getRankings that returns more than 50 rows (or junk rows) is still capped and cleaned
  const many = Array.from({ length: 80 }, (_, i) => entry("X", 50, "normal", i));
  const r2 = setup({ getRankings: () => ({ rows: [null, 7, ...many], players: ["X"], difficulties: ["normal"] }) });
  r2.ui.setTab("rankings");
  assert.equal(r2.rows().length, 50);
});

test("the rankings view filters by player and difficulty through getRankings", () => {
  const list = [entry("Rae", 95, "hard", 0), entry("Ana", 90, "normal", 1), entry("Rae", 80, "normal", 2),
    entry("Ben", 70, "easy", 3)];
  const r = setup({ rankings: list });
  r.ui.setTab("rankings");
  assert.deepEqual(r.calls.rankings, [{ player: "", difficulty: "" }]);
  const pgroup = r.paneEl.one(".chip-group-player");
  const dgroup = r.paneEl.one(".chip-group-diff");
  assert.deepEqual(pgroup.all(".chip").map((c) => c.textContent), ["All", "Rae", "Ana", "Ben"]);
  assert.deepEqual(dgroup.all(".chip").map((c) => c.textContent), ["All", "Easy", "Normal", "Hard"]);
  assert.equal(r.paneEl.one(`#${pgroup.getAttribute("aria-labelledby")}`).textContent, "Player");
  assert.equal(r.paneEl.one(`#${dgroup.getAttribute("aria-labelledby")}`).textContent, "Difficulty");
  assert.equal(pressed(r.playerChip("All")), true);
  assert.equal(r.rows().length, 4);

  const rae = r.playerChip("Rae");
  rae.focus();
  rae.click();
  assert.deepEqual(r.calls.rankings.at(-1), { player: "Rae", difficulty: "" });
  assert.equal(pressed(r.playerChip("Rae")), true);
  assert.equal(pressed(r.playerChip("All")), false);
  assert.deepEqual(r.rows().map((tr) => tr.children[1].textContent), ["Rae", "Rae"]);
  assert.equal(r.doc.activeElement, r.playerChip("Rae"), "focus stays on the chip");

  r.diffChip("normal").click();
  assert.deepEqual(r.calls.rankings.at(-1), { player: "Rae", difficulty: "normal" });
  assert.deepEqual(r.rows().map((tr) => tr.children[3].textContent), ["80"]);
  assert.equal(pressed(r.diffChip("normal")), true);

  const n = r.calls.rankings.length;
  r.diffChip("normal").click();   // already selected: nothing to do
  assert.equal(r.calls.rankings.length, n);

  r.diffChip("easy").click();     // Rae has no easy rankings
  assert.equal(r.rows().length, 0);
  assert.equal(r.emptyEl().hidden, false);
  assert.equal(r.emptyEl().textContent, "No rankings match this filter.");
  assert.equal(r.paneEl.one(".rank-filters").hidden, false, "the chips stay so the filter can be changed");

  r.playerChip("All").click();
  r.diffChip("").click();
  assert.deepEqual(r.calls.rankings.at(-1), { player: "", difficulty: "" });
  assert.equal(r.rows().length, 4);
  assert.deepEqual(r.calls.filters, [], "rankings filters are not library filters");
});

test("Clear calls onClearRankings and is hidden with no rows", () => {
  const list = [entry("Rae", 95, "hard", 0), entry("Ana", 90, "normal", 1)];
  const r = setup({ rankings: list });
  r.ui.setTab("rankings");
  const clear = r.clearBtn();
  assert.equal(clear.tagName, "BUTTON");
  assert.equal(clear.getAttribute("type"), "button");
  assert.equal(clear.textContent, "Clear");
  assert.equal(clear.hidden, false);

  clear.click();
  assert.equal(r.calls.clear, 1);
  assert.equal(r.ui.tab, "rankings", "Clear does nothing else by itself");
  assert.equal(r.rows().length, 2);

  // the caller cleared the store and asks for a refresh: no rows → no Clear, and focus moves on
  clear.focus();
  r.state.rankings = [];
  r.ui.refreshPane();
  assert.equal(r.clearBtn().hidden, true);
  assert.equal(r.rows().length, 0);
  assert.equal(r.doc.activeElement, r.tabBtn("rankings"), "focus is not left on a hidden button");

  // filtered down to nothing (rankings exist): Clear is hidden too
  r.state.rankings = list;
  r.ui.refreshPane();
  assert.equal(r.clearBtn().hidden, false);
  r.playerChip("Rae").click();
  r.diffChip("normal").click();
  assert.equal(r.rows().length, 0);
  assert.equal(r.clearBtn().hidden, true);
});

test("the empty state", () => {
  const r = setup({ rankings: [] });
  r.ui.setTab("rankings");
  assert.equal(r.emptyEl().hidden, false);
  assert.equal(r.emptyEl().textContent, "No rankings yet — finish a song with scoring on.");
  assert.equal(r.paneEl.one(".rank-filters").hidden, true);
  assert.equal(r.paneEl.one(".rank-scroll").hidden, true);
  assert.equal(r.clearBtn().hidden, true);
  assert.equal(r.rows().length, 0);

  // a selected player who has since gone (cleared elsewhere) falls back to All
  r.state.rankings = [entry("Rae", 90), entry("Ana", 80, "normal", 1)];
  r.ui.refreshPane();
  r.playerChip("Ana").click();
  r.state.rankings = [entry("Rae", 90)];
  r.ui.refreshPane();
  assert.deepEqual(r.calls.rankings.at(-1), { player: "", difficulty: "" });
  assert.equal(pressed(r.playerChip("All")), true);
  assert.equal(r.rows().length, 1);

  // getRankings throwing or returning junk reads as no rankings
  const orig = console.error;
  const errs = [];
  console.error = (e) => errs.push(e);
  try {
    const r2 = setup({ getRankings: () => { throw new Error("storage"); } });
    r2.ui.setTab("rankings");
    assert.equal(r2.emptyEl().textContent, "No rankings yet — finish a song with scoring on.");
    const r3 = setup({ getRankings: () => 42 });
    r3.ui.setTab("rankings");
    assert.equal(r3.emptyEl().hidden, false);
  } finally { console.error = orig; }
  assert.equal(errs.length, 1);
});

test("refreshPane re-renders the rankings view only while it is shown", () => {
  const r = setup({ rankings: [entry("Rae", 90)] });
  r.ui.render();
  r.ui.refreshPane();
  assert.equal(r.calls.rankings.length, 0, "not on Rankings: nothing to do");
  r.ui.setTab("rankings");
  assert.equal(r.rows().length, 1);
  r.state.rankings = [entry("Rae", 90), entry("Ben", 99, "hard", 1)];
  r.ui.refreshPane();
  assert.equal(r.rows().length, 2);
  assert.equal(r.rows()[0].children[1].textContent, "Ben");
  assert.deepEqual(r.paneEl.one(".chip-group-player").all(".chip").map((c) => c.textContent), ["All", "Ben", "Rae"]);
  assert.deepEqual(r.paneEl.one(".chip-group-diff").all(".chip").map((c) => c.textContent), ["All", "Normal", "Hard"]);
});

test("the table's scroll region owns Up/Down until its edges", () => {
  // two difficulties, so the difficulty chips exist (one difficulty shows none — see below)
  const list = Array.from({ length: 30 }, (_, i) => entry("Rae", 90 - i, i === 29 ? "hard" : "normal", i));
  const r = setup({ rankings: list });
  r.ui.setTab("rankings");
  const region = r.paneEl.one(".rank-scroll");
  assert.equal(region.getAttribute("tabindex"), "0");
  assert.equal(region.getAttribute("role"), "region");
  assert.ok(region.getAttribute("aria-label"));

  // no layout (no numbers): the arrows are left to the router
  assert.equal(keydown(region, "ArrowDown").defaultPrevented, false);

  Object.assign(region, { scrollTop: 0, clientHeight: 200, scrollHeight: 600 });
  assert.equal(keydown(region, "ArrowUp").defaultPrevented, false, "at the top Up is released");
  let ev = keydown(region, "ArrowDown");
  assert.equal(ev.defaultPrevented, true);
  assert.equal(region.scrollTop, 50, "no row height measurable: a quarter of the view");
  r.rows()[0].getBoundingClientRect = () => ({ height: 40 });
  keydown(region, "ArrowDown");
  assert.equal(region.scrollTop, 90);
  region.scrollTop = 399;
  assert.equal(keydown(region, "ArrowDown").defaultPrevented, false, "at the bottom Down is released");
  ev = keydown(region, "ArrowUp");
  assert.equal(ev.defaultPrevented, true);
  assert.equal(region.scrollTop, 359);
  assert.equal(keydown(region, "ArrowLeft").defaultPrevented, false);
  assert.equal(keydown(region, "ArrowDown", { ctrlKey: true }).defaultPrevented, false);

  // a filter change starts the table from the top
  region.scrollTop = 120;
  r.diffChip("normal").click();
  assert.equal(r.paneEl.one(".rank-scroll").scrollTop, 0);
});

// Integration amendment: with one difficulty present ("normal" for everyone until M9) the
// difficulty group offers no choice and is not shown; a second difficulty brings it back.
test("a single difficulty shows no difficulty chips", () => {
  const r = setup({ rankings: [entry("Rae", 90, "normal", 1), entry("Kai", 80, "normal", 2)] });
  r.ui.setTab("rankings");
  assert.equal(r.paneEl.one('[data-difficulty="normal"]'), null, "no Normal chip");
  const r2 = setup({ rankings: [entry("Rae", 90, "normal", 1), entry("Kai", 80, "hard", 2)] });
  r2.ui.setTab("rankings");
  assert.ok(r2.paneEl.one('[data-difficulty="normal"]') && r2.paneEl.one('[data-difficulty="hard"]'), "two difficulties: chips");
});

test("createBrowseUI needs its three containers", () => {
  const doc = makeDoc();
  const el = () => doc.createElement("div");
  assert.throws(() => createBrowseUI({ chipsEl: el(), paneEl: el(), doc }), TypeError);
  assert.throws(() => createBrowseUI({ tabsEl: el(), paneEl: el(), doc }), TypeError);
  assert.throws(() => createBrowseUI({ tabsEl: el(), chipsEl: el(), doc }), TypeError);
  assert.throws(() => createBrowseUI(), TypeError);
  // the getters work before render, and report the defaults
  const ui = createBrowseUI({ tabsEl: el(), chipsEl: el(), paneEl: el(), doc });
  assert.equal(ui.tab, "all");
  assert.equal(ui.sort, "relevance");
  assert.deepEqual(sorted(ui.filters.sources), []);
  assert.ok(ui.filters.sources instanceof Set && ui.filters.kinds instanceof Set);
});
