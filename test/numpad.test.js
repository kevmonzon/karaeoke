// M8 — the number pad (src/js/ui/numpad.js) and the guest digit commands in remote-glue.js.
// Run with: node --test
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { NUMPAD_KEYS, applyPadKey, digitsOnly, createNumpad } from "../src/js/ui/numpad.js";
import { createRemoteGlue, REMOTE_SETTABLE, REMOTE_READONLY_MIRROR, NOTICE_MS } from "../src/js/remote-glue.js";
import { clampRemoteSetting, REMOTE_SETTABLE_PATHS } from "../src/js/remote-host.js";
import { Catalog } from "../src/js/catalog.js";

const read = (rel) => readFileSync(new URL(rel, import.meta.url), "utf8");

// --- pure ---------------------------------------------------------------------------------------

test("applyPadKey appends a digit", () => {
  for (const d of ["0", "1", "2", "3", "4", "5", "6", "7", "8", "9"]) {
    assert.deepEqual(applyPadKey("12", d), { value: `12${d}`, enter: false });
  }
  assert.deepEqual(applyPadKey("", "0"), { value: "0", enter: false }, "a leading zero is kept (the search ignores it)");
  assert.deepEqual(applyPadKey(null, "7"), { value: "7", enter: false });
  assert.deepEqual(applyPadKey(undefined, "7"), { value: "7", enter: false });
  assert.deepEqual(applyPadKey("love", "1"), { value: "love1", enter: false }, "it edits whatever the field holds");
  assert.deepEqual(applyPadKey(12, "3"), { value: "123", enter: false }, "a number value is read as its text");
});

test("del removes one character and is safe on empty", () => {
  assert.deepEqual(applyPadKey("123", "del"), { value: "12", enter: false });
  assert.deepEqual(applyPadKey("1", "del"), { value: "", enter: false });
  assert.deepEqual(applyPadKey("", "del"), { value: "", enter: false });
  assert.deepEqual(applyPadKey(null, "del"), { value: "", enter: false });
  // One character, not one UTF-16 unit: no lone surrogate is left behind.
  assert.deepEqual(applyPadKey("hi🎤", "del"), { value: "hi", enter: false });
  assert.deepEqual(applyPadKey("a\n", "del"), { value: "a", enter: false }, "a line break is a character too");
});

test("enter reports enter and keeps the value", () => {
  assert.deepEqual(applyPadKey("00123", "enter"), { value: "00123", enter: true });
  assert.deepEqual(applyPadKey("", "enter"), { value: "", enter: true });
  assert.deepEqual(applyPadKey(undefined, "enter"), { value: "", enter: true });
  // Anything that is not a pad key changes nothing and is not an Enter.
  for (const k of ["x", "10", "", " ", "Enter", "DEL", 5, null, undefined, {}, "٣"]) {
    assert.deepEqual(applyPadKey("12", k), { value: "12", enter: false }, String(k));
  }
});

test("digitsOnly accepts digits and rejects mixed text and empty", () => {
  for (const t of ["0", "7", "123", "00123", " 42 ", "\t9\n", 123]) assert.equal(digitsOnly(t), true, JSON.stringify(t));
  for (const t of ["", "   ", "12a", "a12", "1 2", "-1", "1.5", "+3", "١٢٣", "１２３", null, undefined, NaN, {}]) {
    assert.equal(digitsOnly(t), false, JSON.stringify(t));
  }
});

test("NUMPAD_KEYS is the 3×4 phone layout", () => {
  assert.equal(NUMPAD_KEYS.length, 12);
  const rows = [0, 3, 6, 9].map((i) => NUMPAD_KEYS.slice(i, i + 3));
  assert.deepEqual(rows, [["1", "2", "3"], ["4", "5", "6"], ["7", "8", "9"], ["del", "0", "enter"]]);
  assert.equal(Object.isFrozen(NUMPAD_KEYS), true, "the contract layout cannot be edited by a caller");
  assert.equal(new Set(NUMPAD_KEYS).size, 12);
  for (const k of NUMPAD_KEYS) assert.notDeepEqual(applyPadKey("5", k), { value: "5", enter: false }, `${k} does something`);
});

// --- the pad's DOM (a minimal fake: what createNumpad touches, plus bubbling clicks) -----------

function fakeDoc() {
  class El {
    constructor(tag) {
      this.tagName = tag.toUpperCase();
      this.children = []; this.parentNode = null; this.attrs = {}; this.listeners = {};
      this.hidden = false; this.disabled = false; this.textContent = ""; this.type = ""; this.className = "";
    }
    setAttribute(k, v) { this.attrs[k] = String(v); }
    getAttribute(k) { return Object.hasOwn(this.attrs, k) ? this.attrs[k] : null; }
    appendChild(c) { c.parentNode = this; this.children.push(c); return c; }
    replaceChildren(...kids) {
      for (const c of this.children) c.parentNode = null;
      this.children = [];
      for (const k of kids) this.appendChild(k);
    }
    addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
    click() {   // bubbles from the target up, like a real click
      const ev = { type: "click", target: this };
      for (let n = this; n; n = n.parentNode) for (const fn of n.listeners.click || []) fn(ev);
    }
  }
  return { createElement: (tag) => new El(tag), El };
}

test("numpad renders twelve buttons and reports keys", () => {
  const doc = fakeDoc();
  const el = doc.createElement("div");
  el.hidden = true;
  const got = [];
  const pad = createNumpad({ el, onKey: (k) => got.push(k), doc });
  assert.equal(el.children.length, 0, "nothing is drawn until render()");
  pad.render();

  const keys = el.children;
  assert.equal(keys.length, 12);
  assert.deepEqual(keys.map((b) => b.getAttribute("data-key")), [...NUMPAD_KEYS]);
  for (const b of keys) {
    assert.equal(b.tagName, "BUTTON");
    assert.equal(b.type, "button", "never a submit button");
  }
  assert.deepEqual(keys.map((b) => b.textContent), ["1", "2", "3", "4", "5", "6", "7", "8", "9", "⌫", "0", "⏎"]);
  assert.equal(keys[9].getAttribute("aria-label"), "Delete");
  assert.equal(keys[11].getAttribute("aria-label"), "Enter");
  assert.equal(keys[0].getAttribute("aria-label"), null, "a digit is its own name");

  for (const b of keys) b.click();
  assert.deepEqual(got, [...NUMPAD_KEYS], "every key reports itself, once");

  // A second render replaces the keys and does not add a second listener.
  pad.render();
  assert.equal(el.children.length, 12);
  got.length = 0;
  el.children[4].click();
  assert.deepEqual(got, ["5"]);

  // A click on the pad's own box, a disabled key or something foreign reports nothing.
  got.length = 0;
  el.click();
  el.children[0].disabled = true; el.children[0].click(); el.children[0].disabled = false;
  const stray = doc.createElement("button"); stray.setAttribute("data-key", "clear"); el.appendChild(stray); stray.click();
  const inner = doc.createElement("span"); el.children[10].appendChild(inner); inner.click();   // a child of a key → that key
  assert.deepEqual(got, ["0"]);

  // show / hide / visible ride el.hidden.
  assert.equal(pad.visible, false);
  pad.show(); assert.equal(el.hidden, false); assert.equal(pad.visible, true);
  pad.hide(); assert.equal(el.hidden, true); assert.equal(pad.visible, false);
  assert.throws(() => createNumpad({ onKey() {}, doc }), TypeError, "a pad needs its container");
});

// --- remote-glue: the guest digit commands ----------------------------------------------------

function catalogOf(records) {
  const c = new Catalog();
  c.adopt(records.map((r) => ({ kind: "midi", langName: "", ...r })));
  return c;
}

// The glue harness of test/remote-v2.test.js, with M8's four actions.
function glueHarness(over = {}) {
  const calls = [];
  const record = (name) => (...args) => calls.push([name, ...args]);
  const list = over.list || [];
  const listBy = over.listBy || list.map(() => "");
  let clockMs = over.clockMs ?? 1_000_000;
  const settings = { ...(over.settings || {}) };
  const catalog = over.catalog || catalogOf([]);
  const glue = createRemoteGlue({
    settings: { get: (p) => settings[p] },
    catalog,
    queue: {
      list, listBy,
      countBy: (who) => listBy.filter((b) => b === who).length,
      matches: (i, id) => !!list[i] && (!id || list[i].id === id),
    },
    reactions: { handle: record("react") },
    libraryView: { registerYoutube: (r) => ({ ...r, registered: true }) },
    durations: { get: () => null },
    getNowPlaying: () => (over.now === undefined ? null : over.now),
    setStatus: record("status"),
    storage: { getItem: () => "ROOM42", setItem() {} },
    clock: () => clockMs,
    actions: {
      enqueue: record("enqueue"), removeFromQueue: record("remove"), reorderQueue: record("reorder"),
      play: record("play"), pause: record("pause"), next: record("next"),
      seek: record("seek"), setVolume: record("volume"), applySetting: record("setting"),
      playNow: record("playNow"), playNext: record("playNext"), restart: record("restart"), bgNext: record("bgNext"),
      digit: record("digit"), digitDelete: record("digitDelete"), digitClear: record("digitClear"),
      digitCommit: record("digitCommit"),
    },
  });
  return { glue, calls, catalog, settings, advance: (ms) => { clockMs += ms; } };
}

const SONGS = [
  { code: 100, name: "Tahan", artistName: "Bryan", source: "SH" },
  { code: 123, name: "Beer", artistName: "Itchyworms", source: "PLATKAR" },
];
const ALL_FOUR = [{ type: "digit", d: 4 }, { type: "digit_delete" }, { type: "digit_clear" }, { type: "digit_commit" }];

test("glue: digit accepts 0–9 only", () => {
  const { glue, calls } = glueHarness();
  for (let d = 0; d <= 9; d++) glue.applyCommand({ type: "digit", d, by: "Rae" });
  assert.deepEqual(calls, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map((d) => ["digit", d, "Rae"]));
  calls.length = 0;
  // Off the network, every field is untrusted: only an integer 0–9 is a digit.
  for (const d of [10, -1, 1.5, "3", "", NaN, Infinity, -0.5, null, undefined, true, [3], { valueOf: () => 3 }, 99999]) {
    glue.applyCommand({ type: "digit", d, by: "Rae" });
  }
  glue.applyCommand({ type: "digit", by: "Rae" });   // no d at all
  assert.deepEqual(calls, [], "nothing but 0–9 reaches the search field");
});

test("glue: digits are ignored when liveDigits is off", () => {
  const catalog = catalogOf(SONGS);
  const off = glueHarness({ catalog, settings: { "remote.liveDigits": false } });
  for (const c of ALL_FOUR) off.glue.applyCommand({ ...c, by: "Rae" });
  assert.deepEqual(off.calls, [], "all four, silently (the phone sends a normal enqueue instead)");
  assert.equal(off.glue.snapshot().notice, "", "no refusal notice: the phone already knows from the mirror");
  // The phone's ordinary reservation still works with live digits off.
  off.glue.applyCommand({ type: "enqueue", by: "Rae", ref: { i: 1, code: 123 } });
  assert.deepEqual(off.calls.map((c) => [c[0], c[1].name, c[2]]), [["enqueue", "Beer", "Rae"]]);

  // The number pad off altogether (§5.3): remote digit commands are ignored too.
  const padOff = glueHarness({ settings: { "keypad.enabled": false } });
  for (const c of ALL_FOUR) padOff.glue.applyCommand({ ...c, by: "Rae" });
  assert.deepEqual(padOff.calls, []);

  // Missing, or not a boolean → the default, which is ON.
  for (const settings of [{}, { "remote.liveDigits": true, "keypad.enabled": true }, { "remote.liveDigits": 0, "keypad.enabled": "no" }]) {
    const on = glueHarness({ settings });
    for (const c of ALL_FOUR) on.glue.applyCommand({ ...c, by: "Rae" });
    assert.deepEqual(on.calls.map((c) => c[0]), ["digit", "digitDelete", "digitClear", "digitCommit"], JSON.stringify(settings));
  }
});

test("glue: digit_delete and digit_clear delegate in the guest's name", () => {
  const { glue, calls } = glueHarness();
  glue.applyCommand({ type: "digit_delete", by: "Mia" });
  glue.applyCommand({ type: "digit_clear", by: "Mia" });
  glue.applyCommand({ type: "digit_clear" });   // a nameless guest
  assert.deepEqual(calls, [["digitDelete", "Mia"], ["digitClear", "Mia"], ["digitClear", ""]]);
});

test("glue: digit_commit reserves in the guest's name", () => {
  const { glue, calls } = glueHarness({ settings: {} });
  glue.applyCommand({ type: "digit_commit", by: "Rae" });
  // The host resolves the top hit itself (the field is app.js's): the glue names only who and how.
  assert.deepEqual(calls, [["digitCommit", "Rae", { playIfIdle: false }]]);
  assert.equal(glue.snapshot().notice, "");
  // Junk on the command is not passed through.
  glue.applyCommand({ type: "digit_commit", by: "Rae", ref: { i: 0, code: 100 }, playIfIdle: true, d: 5 });
  assert.deepEqual(calls[1], ["digitCommit", "Rae", { playIfIdle: false }], "a guest cannot ask for play-now itself");
});

test("glue: digit_commit respects the per-guest cap", () => {
  const catalog = catalogOf(SONGS);
  const settings = { "queue.maxPerGuest": 2 };
  const capped = glueHarness({ catalog, list: [catalog.songs[0], catalog.songs[1]], listBy: ["Rae", "Rae"], settings });
  capped.glue.applyCommand({ type: "digit_commit", by: "Rae" });
  assert.equal(capped.calls.length, 1);
  assert.equal(capped.calls[0][0], "status");
  const refusal = capped.calls[0][1];
  assert.match(refusal, /already has 2 songs reserved/);
  assert.equal(capped.glue.snapshot().notice, refusal, "the guest sees why");

  // Exactly what an enqueue refusal says and shows.
  const viaEnqueue = glueHarness({ catalog, list: [catalog.songs[0], catalog.songs[1]], listBy: ["Rae", "Rae"], settings });
  viaEnqueue.glue.applyCommand({ type: "enqueue", by: "Rae", ref: { i: 1, code: 123 } });
  assert.deepEqual(viaEnqueue.calls, capped.calls);
  assert.equal(viaEnqueue.glue.snapshot().notice, capped.glue.snapshot().notice);

  // Someone else is unaffected; the notice still clears after five seconds.
  capped.glue.applyCommand({ type: "digit_commit", by: "Mia" });
  assert.deepEqual(capped.calls.at(-1), ["digitCommit", "Mia", { playIfIdle: false }]);
  capped.advance(NOTICE_MS);
  assert.equal(capped.glue.snapshot().notice, "");
  // Digits themselves are never capped: only the reservation is.
  capped.glue.applyCommand({ type: "digit", d: 1, by: "Rae" });
  assert.deepEqual(capped.calls.at(-1), ["digit", 1, "Rae"]);
});

test("glue: digit_commit passes playIfIdle true only when the host allows play-now", () => {
  const cases = [
    [{}, false],                                   // the default: Play now is off for guests (P11 / Q9)
    [{ "remote.guestPlayNow": false }, false],
    [{ "remote.guestPlayNow": "true" }, false],    // not a boolean → the default
    [{ "remote.guestPlayNow": 1 }, false],
    [{ "remote.guestPlayNow": true }, true],
  ];
  for (const [settings, playIfIdle] of cases) {
    const { glue, calls } = glueHarness({ settings });
    glue.applyCommand({ type: "digit_commit", by: "Rae" });
    assert.deepEqual(calls, [["digitCommit", "Rae", { playIfIdle }]], JSON.stringify(settings));
  }
  // Allowed play-now still goes through the cap first: a capped guest gets the refusal, not a play.
  const catalog = catalogOf(SONGS);
  const h = glueHarness({ catalog, list: [catalog.songs[0]], listBy: ["Rae"], settings: { "remote.guestPlayNow": true, "queue.maxPerGuest": 1 } });
  h.glue.applyCommand({ type: "digit_commit", by: "Rae" });
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0][0], "status");
});

test("glue: the nickname is trimmed", () => {
  const long = "x".repeat(40);
  const { glue, calls } = glueHarness();
  for (const c of ALL_FOUR) glue.applyCommand({ ...c, by: long });
  assert.equal(calls.length, 4);
  for (const c of calls) {
    const by = c[0] === "digit" ? c[2] : c[1];
    assert.equal(by, "x".repeat(24), `${c[0]}: 24 characters, as for enqueue`);
  }
  // As for enqueue: a missing nickname is "", a non-string one is its text, truncated.
  calls.length = 0;
  glue.applyCommand({ type: "digit", d: 2 });
  glue.applyCommand({ type: "digit", d: 2, by: 1234567890 });
  glue.applyCommand({ type: "enqueue", by: long, id: "nope" });   // resolves to nothing: no call
  assert.deepEqual(calls.map((c) => c[2]), ["", "1234567890"]);
});

test("glue: liveDigits and keypad.enabled are mirrored but not guest-settable", () => {
  const { glue, calls } = glueHarness({ settings: { "remote.liveDigits": false, "keypad.enabled": true, "keypad.idleSec": 8 } });
  const mirrored = glue.snapshot().settings;
  assert.equal(mirrored["remote.liveDigits"], false);
  assert.equal(mirrored["keypad.enabled"], true);
  assert.equal("keypad.idleSec" in mirrored, false, "only the two switches the phone needs");
  assert.ok(REMOTE_READONLY_MIRROR.includes("remote.liveDigits"));
  assert.ok(REMOTE_READONLY_MIRROR.includes("keypad.enabled"));
  for (const p of ["remote.guestPlayNow", "remote.guestPriority", "queue.fairPlay", "remote.push"]) {
    assert.ok(REMOTE_READONLY_MIRROR.includes(p), `M7's ${p} is still mirrored`);
  }

  // Not settable: the allowlist and its ranges are exactly M7's.
  assert.deepEqual(REMOTE_SETTABLE_PATHS, ["lyrics.offsetMs", "audio.key", "audio.tempo", "audio.volume", "guide.vocal.mute"]);
  for (const p of ["remote.liveDigits", "keypad.enabled", "keypad.idleSec"]) {
    assert.equal(REMOTE_SETTABLE.has(p), false, p);
    assert.equal(clampRemoteSetting(p, true), undefined, p);
    glue.applyCommand({ type: "setting", path: p, value: true });
  }
  assert.deepEqual(calls, [], "a guest cannot switch the host's pad or live digits");

  // Mirrored only when the host holds a boolean (the phone reads absent as on).
  const bare = glueHarness({ settings: { "remote.liveDigits": "yes" } }).glue.snapshot().settings;
  assert.equal("remote.liveDigits" in bare, false);
  assert.equal("keypad.enabled" in bare, false);
});

// --- the wiring the browser run relies on (structure only) -------------------------------------

test("the phone and the host carry the pad", () => {
  const html = read("../src/remote.html");
  assert.match(html, /<button id="r-numpad-toggle"[^>]*aria-pressed="false"[^>]*>123<\/button>/);
  assert.match(html, /<div id="r-numpad" class="numpad" role="group" aria-label="Number pad" hidden><\/div>/);
  const js = read("../src/js/remote.js");
  assert.match(js, /import \{ createNumpad, applyPadKey, digitsOnly \} from "\.\/ui\/numpad\.js";/);
  for (const type of ["digit", "digit_delete", "digit_clear", "digit_commit"]) assert.ok(js.includes(`type: "${type}"`), type);

  const phoneCss = read("../src/css/remote.css");
  assert.match(phoneCss, /\.numpad \{[^}]*grid-template-columns: repeat\(3, minmax\(0, 1fr\)\)/);
  const keyH = /\.numpad button \{[^}]*min-height: (\d+)px/.exec(phoneCss);
  assert.ok(keyH && +keyH[1] >= 44, "phone keys are at least 44 px tall");

  const hostCss = read("../src/css/sheet.css");
  const block = hostCss.slice(hostCss.indexOf("/* ---- numpad"));
  assert.ok(block.length > 20, "sheet.css has a numpad block");
  assert.match(block, /#numpad \{[^}]*grid-template-columns: repeat\(3, minmax\(0, 1fr\)\)/);
  assert.match(block, /#numpad button \{[^}]*min-height: var\(--hit\)/);
  assert.doesNotMatch(block, /@media[^{]*(width|height)/, "no width breakpoints");
});
