/*
 * title-card.test.js — the song intro (src/js/ui/title-card.js): what each line says, that text
 * is only ever written with textContent, show / hide and the timer, the body class title-card.css
 * hides the lyrics under, and when the card yields to the lyrics (checked against the stage
 * pager's own intro boundary on real plans). The DOM parts run against a small hand-built fake
 * with only the surface the module uses: createElement, className, classList, setAttribute,
 * textContent, replaceChildren, body. innerHTML is a trap.
 * Run with:  node --test
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  createTitleCard, titleCardText, lyricsStartAt, titleCardYields,
  TITLE_CARD_BODY_CLASS, TITLE_CARD_ON_CLASS,
} from "../src/js/ui/title-card.js";
import { prepareStageLines, buildCountdowns, makeStagePlan, pageAt } from "../src/js/lyric-pager.js";

// --- a minimal fake DOM ---------------------------------------------------------------------
class ClassList {
  constructor(el) { this.el = el; }
  get set() { return new Set(this.el.className.split(/\s+/).filter(Boolean)); }
  contains(c) { return this.set.has(c); }
  add(c) { const s = this.set; s.add(c); this.el.className = [...s].join(" "); }
  remove(c) { const s = this.set; s.delete(c); this.el.className = [...s].join(" "); }
  toggle(c, force) {
    const on = force === undefined ? !this.contains(c) : !!force;
    if (on) this.add(c); else this.remove(c);
    return on;
  }
}
class El {
  constructor(doc, tag) {
    Object.assign(this, { doc, tagName: tag.toUpperCase(), className: "", attrs: new Map(),
      children: [], parentElement: null, ownText: "" });
    this.classList = new ClassList(this);
  }
  get textContent() { return this.ownText + this.children.map((c) => c.textContent).join(""); }
  set textContent(v) { this.detachAll(); this.ownText = String(v); this.doc.textWrites++; }
  set innerHTML(_) { this.doc.htmlWrites++; throw new Error("innerHTML must not be used"); }
  insertAdjacentHTML() { this.doc.htmlWrites++; throw new Error("insertAdjacentHTML must not be used"); }
  setAttribute(k, v) { this.attrs.set(k, String(v)); }
  getAttribute(k) { return this.attrs.has(k) ? this.attrs.get(k) : null; }
  detachAll() { for (const c of this.children) c.parentElement = null; this.children = []; }
  appendChild(c) { if (c.parentElement) c.parentElement.children = c.parentElement.children.filter((x) => x !== c); c.parentElement = this; this.children.push(c); return c; }
  replaceChildren(...cs) { this.detachAll(); this.ownText = ""; for (const c of cs) this.appendChild(c); }
  *walk() { for (const c of this.children) { yield c; yield* c.walk(); } }
  one(cls) { return [...this.walk()].find((e) => e.classList.contains(cls)) || null; }
}
function makeDoc({ body = true } = {}) {
  const doc = { htmlWrites: 0, textWrites: 0 };
  doc.createElement = (tag) => new El(doc, tag);
  if (body) doc.body = new El(doc, "body");
  return doc;
}
// A hand-driven timer: setTimer returns an id; fire() runs the live ones.
function makeTimers() {
  let next = 1;
  const live = new Map();
  return {
    live,
    setTimer: (fn, ms) => { const id = next++; live.set(id, { fn, ms }); return id; },
    clearTimer: (id) => { live.delete(id); },
    fire() { for (const [id, t] of [...live]) { live.delete(id); t.fn(); } },
  };
}
// --- end of the fake DOM --------------------------------------------------------------------

function setup(opts = {}) {
  const doc = makeDoc(opts);
  const el = doc.createElement("div");
  el.className = "tcard";
  const timers = makeTimers();
  const card = createTitleCard({ el, doc, setTimer: timers.setTimer, clearTimer: timers.clearTimer });
  const part = (cls) => el.one(cls);
  return { doc, el, timers, card, part };
}

const INFO = { title: "Barcelona", artist: "George Ezra", singer: "Kai", keyName: "A minor" };

// --- titleCardText --------------------------------------------------------------------------

test("each line's text", () => {
  assert.deepEqual(titleCardText(INFO), { title: "Barcelona", artist: "George Ezra", singer: "🎤 Kai", key: "Key A minor" });
});

test("missing fields are empty, never 'undefined' or 'null'", () => {
  assert.deepEqual(titleCardText(), { title: "", artist: "", singer: "", key: "" });
  assert.deepEqual(titleCardText({ title: null, artist: undefined, singer: "", keyName: "  " }),
    { title: "", artist: "", singer: "", key: "" });
  // no name → no glyph; no key → no "Key"
  assert.equal(titleCardText({ title: "X", singer: "   " }).singer, "");
  assert.equal(titleCardText({ title: "X", keyName: null }).key, "");
});

test("whitespace and control characters are tidied; non-strings become strings", () => {
  const t = titleCardText({ title: "  Bohemian \t Rhapsody\n(Live)  ", artist: "Queen\u0000\u0007", singer: 42, keyName: "C  major" });
  assert.equal(t.title, "Bohemian Rhapsody (Live)");
  assert.equal(t.artist, "Queen");
  assert.equal(t.singer, "🎤 42");
  assert.equal(t.key, "Key C major");
});

test("a very long field is capped by code points (an emoji is never split)", () => {
  const long = "😀".repeat(250);
  const t = titleCardText({ title: long });
  assert.equal(Array.from(t.title).length, 201);   // 200 + "…"
  assert.ok(t.title.endsWith("…"));
  assert.ok(Array.from(t.title).slice(0, 200).every((c) => c === "😀"));
  assert.equal(titleCardText({ title: "a".repeat(200) }).title, "a".repeat(200));
});

// --- createTitleCard: content -----------------------------------------------------------------

test("it builds its own children once, inside the element, and is aria-hidden", () => {
  const { el, part } = setup();
  assert.equal(el.children.length, 1);
  assert.ok(el.children[0].classList.contains("tcard-block"));
  for (const cls of ["tcard-title", "tcard-artist", "tcard-meta", "tcard-singer", "tcard-key"]) {
    assert.ok(part(cls), `${cls} exists`);
  }
  // singer and key sit inside the meta line, in that order
  const meta = part("tcard-meta");
  assert.deepEqual(meta.children.map((c) => c.className), ["tcard-singer", "tcard-key"]);
  assert.equal(el.getAttribute("aria-hidden"), "true");
  assert.equal(el.className, "tcard");   // its own class is kept; not shown yet
});

test("show() writes every line with textContent", () => {
  const { doc, card, part } = setup();
  assert.equal(card.show(INFO), true);
  assert.equal(part("tcard-title").textContent, "Barcelona");
  assert.equal(part("tcard-artist").textContent, "George Ezra");
  assert.equal(part("tcard-singer").textContent, "🎤 Kai");
  assert.equal(part("tcard-key").textContent, "Key A minor");
  assert.equal(doc.htmlWrites, 0);
  assert.deepEqual(card.text, titleCardText(INFO));
});

test("markup in a title stays literal text (textContent only, never innerHTML)", () => {
  const { doc, el, card, part } = setup();
  const evil = '<img src=x onerror="alert(1)"><b>Hi</b>';
  card.show({ title: evil, artist: "<script>x()</script>", singer: "<i>Kai</i>" });
  assert.equal(part("tcard-title").textContent, evil);
  assert.equal(part("tcard-artist").textContent, "<script>x()</script>");
  assert.equal(part("tcard-singer").textContent, "🎤 <i>Kai</i>");
  assert.equal(doc.htmlWrites, 0);
  // no element was created from the text: still exactly the five built parts
  assert.equal([...el.walk()].length, 6);
});

test("empty lines are written empty (CSS :empty hides them)", () => {
  const { card, part } = setup();
  card.show({ title: "Solo", artist: "" });
  assert.equal(part("tcard-artist").textContent, "");
  assert.equal(part("tcard-singer").textContent, "");
  assert.equal(part("tcard-key").textContent, "");
});

// --- createTitleCard: show / hide and the body class ---------------------------------------------

test("show() turns the card and the body class on; hide() turns both off", () => {
  const { doc, el, card } = setup();
  assert.equal(card.visible, false);
  assert.equal(doc.body.classList.contains(TITLE_CARD_BODY_CLASS), false);
  card.show(INFO);
  assert.equal(card.visible, true);
  assert.ok(el.classList.contains(TITLE_CARD_ON_CLASS));
  assert.ok(el.classList.contains("tcard"));
  assert.ok(doc.body.classList.contains(TITLE_CARD_BODY_CLASS));
  assert.equal(TITLE_CARD_BODY_CLASS, "title-card-on");   // title-card.css keys on this name
  card.hide();
  assert.equal(card.visible, false);
  assert.equal(el.classList.contains(TITLE_CARD_ON_CLASS), false);
  assert.equal(doc.body.classList.contains(TITLE_CARD_BODY_CLASS), false);
  assert.ok(el.classList.contains("tcard"));
});

test("hide() is idempotent and leaves other body classes alone", () => {
  const { doc, card } = setup();
  doc.body.className = "video-mode remote-on";
  card.hide();
  assert.equal(doc.body.className, "video-mode remote-on");
  card.show(INFO);
  card.hide();
  card.hide();
  assert.deepEqual([...doc.body.classList.set].sort(), ["remote-on", "video-mode"]);
});

test("showing again while up replaces the text and stays up", () => {
  const { doc, card, part } = setup();
  card.show(INFO);
  card.show({ title: "Next One", artist: "Someone" });
  assert.equal(card.visible, true);
  assert.equal(part("tcard-title").textContent, "Next One");
  assert.equal(part("tcard-singer").textContent, "");
  assert.ok(doc.body.classList.contains(TITLE_CARD_BODY_CLASS));
});

test("nothing to say (no title, no artist) → not shown, lyrics not hidden", () => {
  const { doc, card } = setup();
  assert.equal(card.show({ title: "  ", artist: "", singer: "Kai", keyName: "C major" }), false);
  assert.equal(card.visible, false);
  assert.equal(doc.body.classList.contains(TITLE_CARD_BODY_CLASS), false);
  // and an empty show() hides a card that was up
  card.show(INFO);
  assert.equal(card.show({}), false);
  assert.equal(card.visible, false);
  assert.equal(doc.body.classList.contains(TITLE_CARD_BODY_CLASS), false);
});

test("an artist alone is enough to show", () => {
  const { card } = setup();
  assert.equal(card.show({ artist: "George Ezra" }), true);
  assert.equal(card.visible, true);
});

test("a document without a body still works (the card's own class only)", () => {
  const { el, card } = setup({ body: false });
  card.show(INFO);
  assert.ok(el.classList.contains(TITLE_CARD_ON_CLASS));
  card.hide();
  assert.equal(card.visible, false);
});

test("el and doc are required", () => {
  assert.throws(() => createTitleCard({ doc: makeDoc() }), /el is required/);
  assert.throws(() => createTitleCard({ el: {}, doc: null }), /doc is required/);
});

// --- createTitleCard: the timer -------------------------------------------------------------

test("show(info, {ms}) hides by itself after ms", () => {
  const { doc, card, timers } = setup();
  card.show(INFO, { ms: 5000 });
  assert.equal(timers.live.size, 1);
  assert.equal([...timers.live.values()][0].ms, 5000);
  timers.fire();
  assert.equal(card.visible, false);
  assert.equal(doc.body.classList.contains(TITLE_CARD_BODY_CLASS), false);
});

test("no ms, zero, negative or NaN → no timer", () => {
  for (const ms of [undefined, 0, -1, NaN, Infinity]) {
    const { card, timers } = setup();
    card.show(INFO, { ms });
    assert.equal(timers.live.size, 0, `ms ${ms}`);
    assert.equal(card.visible, true);
  }
});

test("hide() cancels the timer; a new show() replaces it", () => {
  const { card, timers } = setup();
  card.show(INFO, { ms: 5000 });
  card.hide();
  assert.equal(timers.live.size, 0);

  card.show(INFO, { ms: 5000 });
  const first = [...timers.live.keys()][0];
  card.show({ title: "Next" }, { ms: 3000 });
  assert.equal(timers.live.size, 1);
  assert.ok(!timers.live.has(first), "the first song's timer was cancelled");
  assert.equal([...timers.live.values()][0].ms, 3000);
  // a show() without ms cancels a pending timer too (it would hide the new song's card)
  card.show({ title: "Third" });
  assert.equal(timers.live.size, 0);
  assert.equal(card.visible, true);
});

// --- lyricsStartAt / titleCardYields ------------------------------------------------------------

const raw = (start, words = ["la", "la", "la"], step = 0.4) =>
  ({ syllables: words.map((text, i) => ({ time: start + i * step, text })) });
const planOf = (rawLines, cues = []) => {
  const lines = prepareStageLines(rawLines);
  return makeStagePlan(lines, buildCountdowns(lines, cues));
};

test("no plan or no lines → null, and the card never yields on its own", () => {
  for (const p of [null, undefined, {}, { lines: [] }, makeStagePlan([], [])]) {
    assert.equal(lyricsStartAt(p), null);
    assert.equal(titleCardYields(p, 999), false);
  }
});

test("an early first line (no count-in) → its start", () => {
  const plan = planOf([raw(1.2), raw(4)]);
  assert.equal(plan.cdByLine.has(0), false);
  assert.equal(lyricsStartAt(plan), 1.2);
  assert.equal(titleCardYields(plan, 1.19), false);
  assert.equal(titleCardYields(plan, 1.2), true);
});

test("a late first line → the first beat of its count-in", () => {
  const plan = planOf([raw(10), raw(13)]);
  const cd = plan.cdByLine.get(0);
  assert.ok(cd, "a first line after 3 s gets a count-in");
  assert.equal(lyricsStartAt(plan), cd.beats[0]);
  assert.equal(lyricsStartAt(plan), 8);   // 4 beats of 0.5 s before 10 s
});

test("the file's own count-in cues decide it when present", () => {
  const plan = planOf([raw(6), raw(9)], [3.5, 4, 4.5, 5, 5.5]);
  assert.equal(lyricsStartAt(plan), 3.5);
});

test("a count-in later in the song does not move the intro boundary", () => {
  const plan = planOf([raw(1), raw(30)]);   // a long break before line 1
  assert.ok(plan.cdByLine.has(1));
  assert.equal(lyricsStartAt(plan), 1);
});

test("hand-built plans: a beat after the line (bad data) never pushes the boundary late; junk is ignored", () => {
  const cdByLine = new Map([[0, { beats: [12] }]]);
  assert.equal(lyricsStartAt({ lines: [{ start: 10 }], cdByLine }), 10);
  assert.equal(lyricsStartAt({ lines: [{ start: 10 }], cdByLine: new Map([[0, { beats: [] }]]) }), 10);
  assert.equal(lyricsStartAt({ lines: [{ start: 10 }], cdByLine: { nope: 1 } }), 10);
  assert.equal(lyricsStartAt({ lines: [{ start: NaN }], cdByLine: new Map([[0, { beats: [7] }]]) }), 7);
  assert.equal(lyricsStartAt({ lines: [{}] }), null);
  assert.equal(titleCardYields({ lines: [{ start: 1 }] }, NaN), false);
});

test("it yields exactly where the stage pager's intro ends", () => {
  const plans = [
    planOf([raw(0.3), raw(3)]),
    planOf([raw(1.2), raw(4)]),
    planOf([raw(10), raw(13)]),
    planOf([raw(6), raw(9)], [3.5, 4, 4.5, 5, 5.5]),
    planOf([raw(4.1, ["one"]), raw(30)]),
  ];
  for (const plan of plans) {
    for (let t = 0; t <= 15; t += 0.05) {
      assert.equal(titleCardYields(plan, t), !pageAt(plan, t).intro, `t ${t.toFixed(2)}`);
    }
  }
});
