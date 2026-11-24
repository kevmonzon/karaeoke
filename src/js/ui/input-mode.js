/*
 * input-mode.js — which input the user is driving with right now: touch, mouse or keys (M4).
 *
 * Contract written by the orchestrator, bodies by M4 lane A. The exports, their names and their
 * signatures are the contract lane I codes against — do not change them.
 *
 * The mode is written to document.documentElement.dataset.input ("touch" | "mouse" | "keys"),
 * which overlays.css reads (html[data-input="keys"] shows key hints and grows focused tiles).
 *
 * The rules, and why:
 *  - A remote's keys (arrows, OK, Back, digits, media / colour / channel keys) mean "keys".
 *    Typing a search does not: a letter, Space or punctuation is never "keys", and NO key counts
 *    while a text field has focus — the person is typing, not steering.
 *  - A touch or a pen means "touch" at once.
 *  - A mouse BUTTON means "mouse" at once. A mouse MOVE must travel more than 4 px from where the
 *    pointer was when the current mode began, so a resting or jittering mouse (or the synthetic
 *    pointermove a browser fires when the layout shifts under a still cursor) can never steal the
 *    mode from the D-pad. "Where it was" is the first mouse position seen after the mode began
 *    (the browser does not report the pointer position without an event).
 *  - The listeners run in the CAPTURE phase on the document, so the mode is current before any
 *    other listener — the key router included — sees the event.
 *
 * No DOM access at import time. createInputMode touches only doc.addEventListener and
 * doc.documentElement (.dataset, else setAttribute("data-input")).
 */

import { TV_KEYCODES } from "./keymap.js";

const MODES = new Set(["touch", "mouse", "keys"]);

/** A mouse move must travel MORE than this (px) since the current mode began to switch to mouse. */
const MOUSE_TRAVEL_PX = 4;

/** The events wire() listens to. */
const WIRED_EVENTS = Object.freeze(["pointerdown", "pointermove", "touchstart", "keydown"]);

// <input> types that are controls, not text: a key on one of them is a key, not typing.
// (submit / reset / image / hidden are buttons or nothing; listed so they are never "typing".)
const NON_TEXT_INPUTS = new Set([
  "range", "checkbox", "radio", "button", "color", "file", "submit", "reset", "image", "hidden",
]);

// Named keys that mean "driving with a remote".
const REMOTE_KEYS = new Set([
  "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Enter", "NumpadEnter",
  "Backspace", "Escape", "BrowserBack", "GoBack",
]);
const REMOTE_PREFIX = /^(Media|Color|Channel)/;

const report = (e) => { try { console.error(e); } catch { /* no console */ } };
const attr = (el, name) => (el && typeof el.getAttribute === "function" ? el.getAttribute(name) : null);
const unnamed = (key) => key == null || key === "" || key === "Unidentified";

/** A text field: an <input> that takes text, a <textarea>, or anything contenteditable. */
function isTextField(t) {
  if (!t || typeof t !== "object") return false;
  if (typeof t.isContentEditable === "boolean") {
    if (t.isContentEditable) return true;
  } else {
    const ce = attr(t, "contenteditable");          // a fake / a node without the property
    if (ce != null && String(ce).toLowerCase() !== "false") return true;
  }
  const tag = String(t.tagName || "").toUpperCase();
  if (tag === "TEXTAREA") return true;
  if (tag !== "INPUT") return false;
  const raw = typeof t.type === "string" && t.type ? t.type : (attr(t, "type") || "text");
  return !NON_TEXT_INPUTS.has(String(raw).trim().toLowerCase());
}

function isRemoteKey(ev) {
  const key = ev.key;
  if (unnamed(key)) {
    // TV browsers send no key name: the keyCode decides (keymap.js's table, or 13 = OK/Enter),
    // and a numpad digit still carries its `code`.
    const kc = ev.keyCode;
    if (kc === 13 || (kc != null && Object.prototype.hasOwnProperty.call(TV_KEYCODES, kc))) return true;
    return typeof ev.code === "string" && /^Numpad([0-9]|Enter)$/.test(ev.code);
  }
  if (typeof key !== "string") return false;
  return REMOTE_KEYS.has(key) || /^[0-9]$/.test(key) || REMOTE_PREFIX.test(key);
}

/**
 * Classify one event (pure: reads only the event's own fields, incl. ev.target's tag/type).
 *   - pointer events: by ev.pointerType — "touch" and "pen" → "touch", "mouse" → "mouse";
 *     a "touchstart" event → "touch";
 *   - keydown: "keys" only for Arrow*, Enter, NumpadEnter, digits (top row and numpad),
 *     Backspace, Escape, BrowserBack, GoBack, Media*, Color*, Channel*, and a key with no name
 *     ("" / "Unidentified") whose keyCode is one of keymap.js TV_KEYCODES or 13;
 *     null for typing keys (letters, Space, punctuation) and for ANY key while ev.target is a
 *     text field (input other than range/checkbox/radio/button/color/file, textarea,
 *     contenteditable) — typing a search is not "driving with a remote";
 *   - anything else → null (no change).
 * @param {Event|object} ev
 * @returns {"touch"|"mouse"|"keys"|null}
 */
export function classifyInput(ev) {
  if (!ev || typeof ev !== "object") return null;
  const type = ev.type;
  if (type === "touchstart") return "touch";
  if (typeof type === "string" && type.startsWith("pointer")) {
    const pt = ev.pointerType;
    if (pt === "touch" || pt === "pen") return "touch";
    if (pt === "mouse") return "mouse";
    return null;
  }
  if (type === "keydown") {
    if (isTextField(ev.target)) return null;
    return isRemoteKey(ev) ? "keys" : null;
  }
  return null;
}

// The pointer's position in an event, or null when it carries none.
function pointOf(ev) {
  const x = ev.clientX, y = ev.clientY;
  return Number.isFinite(x) && Number.isFinite(y) ? { x, y } : null;
}

/**
 * @param {object} [o]
 * @param {Document} [o.doc]
 * @param {(mode:string)=>void} [o.onChange]  called after the mode actually changes
 * @returns {{ readonly mode: string|null, wire(): void, set(mode: string): void }}
 *   - `mode` is null until the first classified input;
 *   - `wire()` (idempotent) listens on `doc` in the CAPTURE phase (so the mode is current before
 *     any other listener runs) to pointerdown, pointermove, touchstart and keydown;
 *   - "mouse" from pointermove needs the pointer to travel more than 4 px from where it was when
 *     the current mode began (a resting or jittering mouse cannot steal the mode from keys);
 *     a pointerdown with pointerType "mouse" switches at once;
 *   - `set(mode)` forces a mode (tests, and app.js if it ever needs to); an unknown mode is ignored;
 *   - writes doc.documentElement.dataset.input on every change.
 */
export function createInputMode({ doc = globalThis.document, onChange = () => {} } = {}) {
  let mode = null;
  let anchor = null;     // first mouse position seen since the current mode began
  let wired = false;

  function write(m) {
    const root = doc && doc.documentElement;
    if (!root) return;
    try {
      if (root.dataset) root.dataset.input = m;
      else if (typeof root.setAttribute === "function") root.setAttribute("data-input", m);
    } catch (e) { report(e); }
  }

  function change(m, at = null) {
    if (!MODES.has(m) || m === mode) return;
    mode = m;
    anchor = at;
    write(m);
    if (typeof onChange === "function") {
      try { onChange(m); } catch (e) { report(e); }
    }
  }

  function onEvent(ev) {
    const kind = classifyInput(ev);
    if (!kind) return;
    if (kind !== "mouse") { change(kind); return; }
    const at = pointOf(ev);
    if (ev.type === "pointerdown") { change("mouse", at); return; }
    if (mode === "mouse" || !at) return;
    if (!anchor) { anchor = at; return; }
    if (Math.hypot(at.x - anchor.x, at.y - anchor.y) > MOUSE_TRAVEL_PX) change("mouse", at);
  }

  return {
    get mode() { return mode; },
    wire() {
      if (wired || !doc || typeof doc.addEventListener !== "function") return;
      wired = true;
      for (const type of WIRED_EVENTS) doc.addEventListener(type, onEvent, { capture: true, passive: true });
    },
    set(m) { change(m); },
  };
}
