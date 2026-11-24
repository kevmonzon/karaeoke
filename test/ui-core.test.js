/*
 * ui-core.test.js — the shell's pure foundations: the overlay stack, spatial navigation and
 * the key map (src/js/ui/). No DOM; the stack runs on a fake clock.
 * Run with:  node --test
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { OVERLAY_DEFS, createOverlayStack } from "../src/js/ui/overlay-stack.js";
import { pickNext } from "../src/js/ui/spatial-nav.js";
import { ACTIONS, TV_KEYCODES, keyToAction } from "../src/js/ui/keymap.js";

// A stack on a settable clock that records every change.
function makeStack(t0 = 1000) {
  const changes = [];
  const clock = { t: t0 };
  const stack = createOverlayStack({ onChange: (c) => changes.push(c), now: () => clock.t });
  return { stack, changes, clock };
}

// --- overlay stack ----------------------------------------------------------
test("stack: open and close report through onChange", () => {
  const { stack, changes } = makeStack();
  assert.equal(stack.open("search"), true);
  assert.deepEqual(changes, [{ opened: ["search"], closed: [], top: "search", reason: "open" }]);
  assert.equal(stack.close("search", "button"), true);
  assert.deepEqual(changes[1], { opened: [], closed: ["search"], top: null, reason: "button" });
  assert.equal(stack.close("search"), false);       // already closed: no event
  assert.equal(stack.open("controls"), true);
  assert.equal(stack.close("controls"), true);
  assert.equal(changes[3].reason, "api");           // the default reason
  assert.equal(changes.length, 4);
});

test("stack: opening a panel closes the other panel", () => {
  const { stack, changes } = makeStack();
  stack.open("search");
  changes.length = 0;
  assert.equal(stack.open("queue"), true);
  assert.deepEqual(stack.list(), ["queue"]);
  assert.equal(changes.length, 1);
  assert.deepEqual(changes[0].opened, ["queue"]);
  assert.deepEqual(changes[0].closed, ["search"]);
  assert.equal(changes[0].top, "queue");
  assert.equal(changes[0].reason, "swap");          // a panel swap, so history can replaceState
  // a non-panel overlay never closes a panel
  stack.open("controls");
  assert.deepEqual(stack.list(), ["controls", "queue"]);
});

test("stack: a sheet stacks above a panel", () => {
  const { stack } = makeStack();
  stack.open("search");
  stack.open("song");
  assert.equal(stack.top(), "song");
  assert.equal(stack.isOpen("search"), true);
  assert.equal(stack.isOpen("song"), true);
  assert.deepEqual(stack.list(), ["search", "song"]);
  stack.open("confirm");                            // a dialog goes above everything
  assert.deepEqual(stack.list(), ["search", "song", "confirm"]);
  assert.equal(stack.top(), "confirm");
});

test("stack: back closes only the top modal", () => {
  const { stack, changes } = makeStack();
  stack.open("controls");
  stack.open("search");
  stack.open("song");
  changes.length = 0;
  assert.equal(stack.back(), "song");
  assert.equal(stack.top(), "search");
  assert.deepEqual(stack.list(), ["controls", "search"]);
  assert.deepEqual(changes, [{ opened: [], closed: ["song"], top: "search", reason: "back" }]);
});

test("stack: back ignores non-modal overlays", () => {
  const { stack, changes } = makeStack();
  stack.open("controls");
  stack.open("adjust");
  changes.length = 0;
  assert.equal(stack.back(), null);
  assert.deepEqual(stack.list(), ["controls", "adjust"]);
  assert.equal(stack.top(), null);
  assert.equal(stack.modalOpen(), false);
  assert.equal(changes.length, 0);
});

test("stack: unknown id is refused", () => {
  const { stack, changes } = makeStack();
  assert.equal(stack.open("nope"), false);
  assert.equal(stack.open("toString"), false);      // not fooled by the prototype
  assert.equal(stack.close("nope"), false);
  assert.equal(stack.toggle("nope"), false);
  assert.equal(stack.isOpen("nope"), false);
  assert.deepEqual(stack.list(), []);
  assert.equal(changes.length, 0);
  stack.open("search");
  assert.equal(stack.open("search"), false);        // already open
  assert.equal(changes.length, 1);
});

test("stack: auto-hide closes after the period", () => {
  const { stack, changes, clock } = makeStack(5000);
  const t = clock.t;
  stack.open("controls");
  stack.setAutoHide("controls", 3000);
  changes.length = 0;
  assert.deepEqual(stack.tick(t + 2999), []);
  assert.equal(changes.length, 0);
  assert.deepEqual(stack.tick(t + 3000), ["controls"]);
  assert.deepEqual(changes, [{ opened: [], closed: ["controls"], top: null, reason: "timeout" }]);
  // adjust carries its own 2500 ms from the definitions, and tick() defaults to now()
  stack.open("adjust");
  clock.t += 2500;
  assert.deepEqual(stack.tick(), ["adjust"]);
});

test("stack: touch restarts the timer", () => {
  const { stack, clock } = makeStack(0);
  stack.open("adjust");                             // deadline 2500
  clock.t = 2000;
  stack.touch("adjust");                            // deadline 4500
  assert.deepEqual(stack.tick(2600), []);
  assert.deepEqual(stack.tick(4499), []);
  assert.deepEqual(stack.tick(4500), ["adjust"]);
  stack.touch("adjust");                            // closed: no-op, no throw
  stack.touch("nope");
});

test("stack: opener and data round-trip", () => {
  const { stack } = makeStack();
  const opener = { el: "songs-button" };
  const data = { digit: 7 };
  stack.open("search", { opener, data });
  assert.equal(stack.opener("search"), opener);
  assert.equal(stack.data("search"), data);
  stack.open("controls");
  assert.equal(stack.opener("controls"), null);     // defaults
  assert.equal(stack.data("controls"), null);
  stack.close("search");
  assert.equal(stack.opener("search"), null);       // forgotten on close
  assert.equal(stack.data("search"), null);
});

test("stack: swap closes one panel and opens another in one change", () => {
  const { stack, changes } = makeStack();
  stack.open("controls");
  stack.open("queue");
  changes.length = 0;
  assert.equal(stack.swap("queue", "settings", { opener: "q", data: 1 }), true);
  assert.equal(changes.length, 1);
  assert.deepEqual(changes[0], { opened: ["settings"], closed: ["queue"], top: "settings", reason: "swap" });
  assert.deepEqual(stack.list(), ["controls", "settings"]);
  assert.equal(stack.opener("settings"), "q");
  assert.equal(stack.data("settings"), 1);
  // refused, with nothing changed: from not open, to already open, same id, unknown id
  assert.equal(stack.swap("queue", "mixer"), false);
  assert.equal(stack.swap("controls", "settings"), false);
  assert.equal(stack.swap("settings", "settings"), false);
  assert.equal(stack.swap("settings", "nope"), false);
  assert.equal(changes.length, 1);
});

test("stack: the nine overlay ids match the spec", () => {
  const P = (kind, modal, group, z, autoHideMs = 0) => ({ kind, modal, group, z, autoHideMs });
  assert.deepEqual(OVERLAY_DEFS, {
    controls:  P("bar",    false, null,     20),
    adjust:    P("toast",  false, null,     25, 2500),
    search:    P("panel",  true,  "panel",  40),
    queue:     P("panel",  true,  "panel",  40),
    mixer:     P("panel",  true,  "panel",  40),
    settings:  P("panel",  true,  "panel",  40),
    song:      P("sheet",  true,  "sheet",  50),
    calibrate: P("dialog", true,  "dialog", 60),
    confirm:   P("dialog", true,  "dialog", 70),
  });
  assert.equal(Object.keys(OVERLAY_DEFS).length, 9);
  assert.ok(Object.isFrozen(OVERLAY_DEFS));
  for (const d of Object.values(OVERLAY_DEFS)) assert.ok(Object.isFrozen(d));
});

// Extra contract coverage beyond the plan's table.
test("stack: toggle returns the new open state", () => {
  const { stack, changes } = makeStack();
  assert.equal(stack.toggle("queue"), true);
  assert.equal(stack.toggle("queue"), false);
  assert.equal(stack.isOpen("queue"), false);
  assert.deepEqual(changes.map((c) => c.reason), ["open", "toggle"]);
});

test("stack: closeAll closes everything in one change, top first", () => {
  const { stack, changes } = makeStack();
  stack.open("controls");
  stack.open("settings");
  stack.open("confirm");
  changes.length = 0;
  assert.deepEqual(stack.closeAll("reset"), ["confirm", "settings", "controls"]);
  assert.deepEqual(changes, [{ opened: [], closed: ["confirm", "settings", "controls"], top: null, reason: "reset" }]);
  assert.deepEqual(stack.closeAll(), []);
  assert.equal(changes.length, 1);                  // nothing to close: no event
});

test("stack: an auto-hide period survives close and 0 disables it", () => {
  const { stack, clock } = makeStack(0);
  stack.setAutoHide("controls", 1000);              // set while closed (shell does this at runtime)
  stack.open("controls");
  assert.deepEqual(stack.tick(1000), ["controls"]);
  clock.t = 2000;
  stack.open("controls");                           // the period still applies
  assert.deepEqual(stack.tick(3000), ["controls"]);
  stack.open("controls");
  stack.setAutoHide("controls", 0);                 // paused: never hide
  assert.deepEqual(stack.tick(1e12), []);
  assert.equal(stack.isOpen("controls"), true);
});

test("stack: same-z dialogs stack in the order they opened", () => {
  // The app has one z-60 dialog since Tonight's recap went (2026-11-24): two custom ones keep the rule tested.
  const d = { kind: "dialog", modal: true, group: "dialog", z: 60, autoHideMs: 0 };
  const stack = createOverlayStack({ defs: { first: d, second: d } });
  stack.open("first");
  stack.open("second");
  assert.deepEqual(stack.list(), ["first", "second"]);
  assert.equal(stack.back(), "second");
  assert.equal(stack.back(), "first");
  assert.equal(stack.back(), null);
});

// --- spatial navigation -----------------------------------------------------
// A 3×3 grid of 100×50 cells with a 10 px gap; ids "r<row>c<col>".
function grid({ w = 100, h = 50, gap = 10 } = {}) {
  const cells = [];
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) cells.push({ id: `r${r}c${c}`, x: c * (w + gap), y: r * (h + gap), w, h });
  }
  return cells;
}

test("nav: picks the nearest in the direction", () => {
  for (const gap of [10, 0]) {                      // with a gap, and with touching cells
    const cells = grid({ gap });
    const centre = cells.find((c) => c.id === "r1c1");
    assert.equal(pickNext(centre, cells, "up"), "r0c1");
    assert.equal(pickNext(centre, cells, "down"), "r2c1");
    assert.equal(pickNext(centre, cells, "left"), "r1c0");
    assert.equal(pickNext(centre, cells, "right"), "r1c2");
  }
  const cells = grid();
  assert.equal(pickNext(cells[0], cells, "right"), "r0c1");   // nearest, not the far one
  assert.equal(pickNext(cells[0], cells, "down"), "r1c0");
});

test("nav: prefers overlap over a closer diagonal", () => {
  const current = { x: 0, y: 0, w: 10, h: 10 };
  const candidates = [
    { id: "diagonal", x: 25, y: 25, w: 10, h: 10 },  // centre 35 px away as the crow flies
    { id: "inline", x: 40, y: 0, w: 10, h: 10 },     // 40 px away, but its rows overlap
  ];
  assert.equal(pickNext(current, candidates, "right"), "inline");
  assert.equal(pickNext(current, candidates, "down"), "diagonal"); // the only one below
});

test("nav: no candidate returns null", () => {
  const cells = grid();
  const corner = cells[0];
  assert.equal(pickNext(corner, cells, "up"), null);    // no wrap to the bottom row
  assert.equal(pickNext(corner, cells, "left"), null);
  assert.equal(pickNext(corner, [], "down"), null);
  assert.equal(pickNext(corner, cells, "sideways"), null);
  // a neighbour in the same row whose centre is within 1 px is not "below"
  const nudged = [{ id: "same-row", x: 120, y: 0.8, w: 100, h: 50 }];
  assert.equal(pickNext(corner, nudged, "down"), null);
  assert.equal(pickNext(corner, nudged, "right"), "same-row");
});

test("nav: ties resolve in candidate order", () => {
  const current = { x: 100, y: 0, w: 20, h: 20 };
  const a = { id: "a", x: 70, y: 100, w: 20, h: 20 };    // mirror images below-left / below-right
  const b = { id: "b", x: 130, y: 100, w: 20, h: 20 };
  assert.equal(pickNext(current, [a, b], "down"), "a");
  assert.equal(pickNext(current, [b, a], "down"), "b");
});

test("nav: ignores the current element when it is in the list", () => {
  const cells = grid();
  const centre = cells[4];
  // the same object, and a fresh copy carrying the same id (a re-measure)
  assert.equal(pickNext(centre, cells, "right"), "r1c2");
  const copy = { ...centre };
  const shifted = [{ ...centre, x: centre.x + 5 }, ...cells.filter((c) => c !== centre)];
  assert.equal(pickNext(copy, shifted, "right"), "r1c2");
  assert.equal(pickNext(copy, [centre], "right"), null);
});

// --- key map ----------------------------------------------------------------
const K = (key, more = {}) => ({ key, code: "", keyCode: 0, ctrlKey: false, metaKey: false, altKey: false, ...more });
const STAGE = { typing: false, inList: false, inSearch: false, modal: false };
const TYPING = { ...STAGE, typing: true };
const ROW = { ...STAGE, inList: true };
const ROW_IN_SONGS = { ...STAGE, inList: true, inSearch: true };
const DIALOG = { ...STAGE, modal: true };

test("keymap: digits map with their value", () => {
  for (let n = 0; n <= 9; n++) {
    assert.deepEqual(keyToAction(K(String(n), { code: `Digit${n}` }), STAGE), { action: "digit", arg: n });
    assert.deepEqual(keyToAction(K(String(n), { code: `Numpad${n}` }), STAGE), { action: "digit", arg: n });
    // a numpad that reports no key name still dials by its code
    assert.deepEqual(keyToAction(K("Unidentified", { code: `Numpad${n}` }), STAGE), { action: "digit", arg: n });
  }
  // a queue row (not inside Songs) still dials
  assert.deepEqual(keyToAction(K("4"), ROW), { action: "digit", arg: 4 });
});

test("keymap: digits are ignored while typing", () => {
  for (let n = 0; n <= 9; n++) {
    assert.equal(keyToAction(K(String(n), { code: `Digit${n}` }), TYPING), null);
    assert.equal(keyToAction(K(String(n), { code: `Numpad${n}` }), TYPING), null);
  }
  // and so is every other non-Back key
  for (const key of ["s", "q", " ", "ArrowDown", "Backspace", "+", "MediaPlayPause"]) {
    assert.equal(keyToAction(K(key), TYPING), null, key);
  }
  // the Back keys still work while typing, including their TV keyCode forms
  for (const key of ["Escape", "BrowserBack", "GoBack"]) {
    assert.deepEqual(keyToAction(K(key), TYPING), { action: "back" }, key);
  }
  assert.deepEqual(keyToAction(K("Unidentified", { keyCode: 461 }), TYPING), { action: "back" });
  assert.deepEqual(keyToAction(K("", { keyCode: 10009 }), TYPING), { action: "back" });
});

test("keymap: Enter is never mapped", () => {
  const enters = [
    K("Enter", { code: "Enter", keyCode: 13 }),
    K("Enter", { code: "NumpadEnter", keyCode: 13 }),
    K("Unidentified", { keyCode: 13 }),
  ];
  for (const ev of enters) {
    for (const ctx of [STAGE, ROW, ROW_IN_SONGS, TYPING, DIALOG, undefined]) {
      assert.equal(keyToAction(ev, ctx), null);
    }
  }
});

test("keymap: Backspace is back outside a text field", () => {
  assert.deepEqual(keyToAction(K("Backspace"), STAGE), { action: "back" });
  assert.deepEqual(keyToAction(K("Backspace"), ROW_IN_SONGS), { action: "back" });
  assert.deepEqual(keyToAction(K("Backspace"), DIALOG), { action: "back" });
  assert.equal(keyToAction(K("Backspace"), TYPING), null);
});

test("keymap: digits on a song row inside Songs go to search", () => {
  for (let n = 0; n <= 9; n++) {
    assert.equal(keyToAction(K(String(n)), ROW_IN_SONGS), null);
    assert.equal(keyToAction(K(String(n), { code: `Numpad${n}` }), ROW_IN_SONGS), null);
  }
  // inside Songs but not on a row (a button in the panel) a digit still dials
  assert.deepEqual(keyToAction(K("3"), { ...STAGE, inSearch: true }), { action: "digit", arg: 3 });
});

test("keymap: digits are ignored under a dialog", () => {
  for (let n = 0; n <= 9; n++) assert.equal(keyToAction(K(String(n)), DIALOG), null);
  assert.deepEqual(keyToAction(K("Escape"), DIALOG), { action: "back" });   // Back still works
});

test("keymap: keyCode fallbacks for TV platforms", () => {
  assert.deepEqual(TV_KEYCODES, {
    461: "GoBack", 10009: "GoBack",
    403: "ColorF0Red", 404: "ColorF1Green", 405: "ColorF2Yellow", 406: "ColorF3Blue",
    415: "MediaPlay", 19: "MediaPause", 10252: "MediaPlayPause", 413: "MediaStop",
    417: "MediaTrackNext", 412: "MediaTrackPrevious", 427: "ChannelUp", 428: "ChannelDown",
  });
  assert.ok(Object.isFrozen(TV_KEYCODES));
  const expect = {
    461: { action: "back" }, 10009: { action: "back" },
    403: { action: "openSearch" }, 404: { action: "openQueue" },
    405: { action: "bgNext" }, 406: { action: "melodyToggle" },
    415: { action: "playPause", arg: "play" }, 19: { action: "playPause", arg: "pause" },
    10252: { action: "playPause" }, 413: { action: "stop" },
    417: { action: "next" }, 412: { action: "restart" },
    427: { action: "keyUp" }, 428: { action: "keyDown" },
  };
  for (const [keyCode, want] of Object.entries(expect)) {
    assert.deepEqual(keyToAction(K("Unidentified", { keyCode: Number(keyCode) }), STAGE), want, keyCode);
    assert.deepEqual(keyToAction(K("", { keyCode: Number(keyCode) }), STAGE), want, keyCode);
  }
  assert.equal(keyToAction(K("Unidentified", { keyCode: 999 }), STAGE), null);
});

test("keymap: a real key name wins over keyCode", () => {
  assert.deepEqual(keyToAction(K("ArrowLeft", { keyCode: 461 }), STAGE), { action: "nav", arg: "left" });
  assert.deepEqual(keyToAction(K("q", { keyCode: 403 }), STAGE), { action: "openQueue" });
  assert.equal(keyToAction(K("Pause", { keyCode: 19 }), STAGE), null);   // a desktop Pause key is not MediaPause
  // NumLock off: the numpad's arrow keeps its navigation meaning
  assert.deepEqual(keyToAction(K("ArrowDown", { code: "Numpad2", keyCode: 40 }), STAGE), { action: "nav", arg: "down" });
});

test("keymap: Space and plus are left to a focused list row", () => {
  for (const key of [" ", "+", "="]) {
    assert.equal(keyToAction(K(key), ROW), null, key);
    assert.equal(keyToAction(K(key), ROW_IN_SONGS), null, key);
  }
  assert.deepEqual(keyToAction(K(" ", { code: "Space" }), STAGE), { action: "playPause" });
  assert.deepEqual(keyToAction(K("+"), STAGE), { action: "keyUp" });
  assert.deepEqual(keyToAction(K("="), STAGE), { action: "keyUp" });
  // the rest of the map still works on a row
  assert.deepEqual(keyToAction(K("-"), ROW), { action: "keyDown" });
  assert.deepEqual(keyToAction(K("MediaPlayPause"), ROW), { action: "playPause" });
});

test("keymap: modifier chords are never mapped", () => {
  assert.equal(keyToAction(K("f", { ctrlKey: true }), STAGE), null);       // Ctrl+F
  assert.equal(keyToAction(K("r", { metaKey: true }), STAGE), null);       // Cmd+R
  assert.equal(keyToAction(K("s", { altKey: true }), STAGE), null);
  assert.equal(keyToAction(K("Escape", { ctrlKey: true }), TYPING), null);
  assert.equal(keyToAction(K("1", { metaKey: true }), STAGE), null);
  assert.equal(keyToAction(K("ArrowLeft", { altKey: true }), STAGE), null); // Alt+Left = browser back
  // Shift alone is not a chord: "+" and capitals need it
  assert.deepEqual(keyToAction(K("+", { shiftKey: true }), STAGE), { action: "keyUp" });
  assert.deepEqual(keyToAction(K("S", { shiftKey: true }), STAGE), { action: "openSearch" });
});

// The §4.3 key map, row by row (stage scope).
const KEY_TABLE = [
  ["ArrowUp", "nav", "up"], ["ArrowDown", "nav", "down"], ["ArrowLeft", "nav", "left"], ["ArrowRight", "nav", "right"],
  ["Escape", "back"], ["BrowserBack", "back"], ["GoBack", "back"], ["Backspace", "back"],
  ["0", "digit", 0], ["9", "digit", 9],
  [" ", "playPause"], ["k", "playPause"], ["MediaPlayPause", "playPause"],
  ["MediaPlay", "playPause", "play"], ["MediaPause", "playPause", "pause"],
  ["n", "next"], ["MediaTrackNext", "next"],
  ["p", "restart"], ["MediaTrackPrevious", "restart"],
  ["MediaStop", "stop"],
  ["+", "keyUp"], ["=", "keyUp"], ["ChannelUp", "keyUp"],
  ["-", "keyDown"], ["ChannelDown", "keyDown"],
  [".", "tempoUp"], [",", "tempoDown"],
  ["]", "offsetUp"], ["[", "offsetDown"],
  ["m", "melodyToggle"], ["F2", "melodyToggle"], ["ColorF3Blue", "melodyToggle"],
  ["/", "openSearch"], ["s", "openSearch"], ["F1", "openSearch"], ["ColorF0Red", "openSearch"],
  ["q", "openQueue"], ["ColorF1Green", "openQueue"],
  ["ColorF2Yellow", "bgNext"],
  ["c", "toggleControls"],
  ["f", "fullscreen"],
];

test("keymap: media and colour keys", () => {
  for (const [key, action, arg] of KEY_TABLE) {
    const want = arg === undefined ? { action } : { action, arg };
    assert.deepEqual(keyToAction(K(key), STAGE), want, key);
    if (key.length === 1 && /[a-z]/.test(key)) {
      assert.deepEqual(keyToAction(K(key.toUpperCase()), STAGE), want, key.toUpperCase());
    }
  }
  // unmapped keys stay null
  for (const key of ["x", "F3", "Tab", "Shift", "PageDown", "Home", "ColorF4Grey"]) {
    assert.equal(keyToAction(K(key), STAGE), null, key);
  }
  assert.equal(keyToAction(null, STAGE), null);
});

test("keymap: every mapped action is in ACTIONS", () => {
  assert.ok(Object.isFrozen(ACTIONS));
  assert.equal(new Set(ACTIONS).size, ACTIONS.length);
  const produced = new Set();
  const events = [
    ...KEY_TABLE.map(([key]) => K(key)),
    ...Object.keys(TV_KEYCODES).map((kc) => K("Unidentified", { keyCode: Number(kc) })),
  ];
  for (const ev of events) {
    for (const ctx of [STAGE, ROW, ROW_IN_SONGS, TYPING, DIALOG]) {
      const h = keyToAction(ev, ctx);
      if (!h) continue;
      assert.ok(ACTIONS.includes(h.action), `${ev.key}/${ev.keyCode} → ${h.action}`);
      produced.add(h.action);
    }
  }
  // and the reverse: nothing in ACTIONS is dead
  assert.deepEqual([...produced].sort(), [...ACTIONS].sort());
});
