/*
 * keymap.js — one keydown → one app action (pure: reads the event's fields, never the DOM).
 *
 * The key router builds `ctx` from where focus is and calls `keyToAction(ev, ctx)`; a null
 * result means "not ours, let the key through". Rules, first match wins:
 *
 *   1. a Ctrl / Meta / Alt chord is never ours (browser and OS shortcuts);
 *   2. a missing key name ("" / "Unidentified", as TV browsers send) is looked up by keyCode;
 *   3. Enter is never ours — the focused control activates itself;
 *   4. while typing, only the Back keys map;
 *   5. on a focused list row, Space / "+" / "=" belong to the row;
 *   6. digits: not under a dialog, not on a row inside Songs (type-to-search takes them);
 *   7. Backspace is Back;
 *   8. everything else by the table below (letters case-insensitive).
 */

/** Every action this map can return. */
export const ACTIONS = Object.freeze([
  "nav", "back", "digit", "playPause", "next", "restart", "stop",
  "keyUp", "keyDown", "tempoUp", "tempoDown", "offsetUp", "offsetDown",
  "melodyToggle", "openSearch", "openQueue", "bgNext", "toggleControls", "fullscreen",
]);

/**
 * keyCode → key name, used only when the event carries no key name (TV platforms).
 * The remote's Back button becomes "GoBack", the standard key name that maps to `back`.
 */
export const TV_KEYCODES = Object.freeze({
  461: "GoBack",               // webOS
  10009: "GoBack",             // Tizen
  403: "ColorF0Red",
  404: "ColorF1Green",
  405: "ColorF2Yellow",
  406: "ColorF3Blue",
  415: "MediaPlay",
  19: "MediaPause",
  10252: "MediaPlayPause",
  413: "MediaStop",
  417: "MediaTrackNext",
  412: "MediaTrackPrevious",
  427: "ChannelUp",
  428: "ChannelDown",
});

const BACK_KEYS = new Set(["Escape", "BrowserBack", "GoBack"]);

const ARROWS = Object.freeze({ ArrowUp: "up", ArrowDown: "down", ArrowLeft: "left", ArrowRight: "right" });

// key name → [action, arg?]. Single characters are matched lowercased.
const TABLE = new Map([
  ["Escape", ["back"]], ["BrowserBack", ["back"]], ["GoBack", ["back"]],
  [" ", ["playPause"]], ["k", ["playPause"]], ["MediaPlayPause", ["playPause"]],
  ["MediaPlay", ["playPause", "play"]], ["MediaPause", ["playPause", "pause"]],
  ["n", ["next"]], ["MediaTrackNext", ["next"]],
  ["p", ["restart"]], ["MediaTrackPrevious", ["restart"]],
  ["MediaStop", ["stop"]],
  ["+", ["keyUp"]], ["=", ["keyUp"]], ["ChannelUp", ["keyUp"]],
  ["-", ["keyDown"]], ["ChannelDown", ["keyDown"]],
  [".", ["tempoUp"]], [",", ["tempoDown"]],
  ["]", ["offsetUp"]], ["[", ["offsetDown"]],
  ["m", ["melodyToggle"]], ["F2", ["melodyToggle"]], ["ColorF3Blue", ["melodyToggle"]],
  ["/", ["openSearch"]], ["s", ["openSearch"]], ["F1", ["openSearch"]], ["ColorF0Red", ["openSearch"]],
  ["q", ["openQueue"]], ["ColorF1Green", ["openQueue"]],
  ["ColorF2Yellow", ["bgNext"]],
  ["c", ["toggleControls"]],
  ["f", ["fullscreen"]],
]);

const hit = (action, arg) => (arg === undefined ? { action } : { action, arg });

const unnamed = (key) => key == null || key === "" || key === "Unidentified";

/**
 * @param {{key?:string, code?:string, keyCode?:number, ctrlKey?:boolean, metaKey?:boolean, altKey?:boolean}} ev
 * @param {{typing?:boolean, inList?:boolean, inSearch?:boolean, modal?:boolean}} [ctx]
 * @returns {{action:string, arg?:*} | null}
 */
export function keyToAction(ev, ctx) {
  if (!ev) return null;
  const { typing = false, inList = false, inSearch = false, modal = false } = ctx || {};

  // 1. chords
  if (ev.ctrlKey || ev.metaKey || ev.altKey) return null;

  // 2. TV platforms: no key name → keyCode
  let key = ev.key;
  if (unnamed(key) && Object.prototype.hasOwnProperty.call(TV_KEYCODES, ev.keyCode)) {
    key = TV_KEYCODES[ev.keyCode];
  }
  const code = typeof ev.code === "string" ? ev.code : "";

  // 3. Enter belongs to the focused control
  if (key === "Enter" || key === "NumpadEnter" || code === "NumpadEnter" || (unnamed(key) && ev.keyCode === 13)) {
    return null;
  }

  // 4. typing: Back only
  if (typing) return BACK_KEYS.has(key) ? hit("back") : null;

  // 5. the focused row owns Space and its "queue" keys
  if (inList && (key === " " || key === "+" || key === "=")) return null;

  // 6. digits (top row by key name; numpad by code when the key carries no name)
  let digit = null;
  if (typeof key === "string" && /^[0-9]$/.test(key)) digit = Number(key);
  else if (unnamed(key) && /^Numpad[0-9]$/.test(code)) digit = Number(code.slice(6));
  if (digit !== null) {
    if (modal || (inList && inSearch)) return null;
    return hit("digit", digit);
  }

  // 7. Backspace
  if (key === "Backspace") return hit("back");

  // 8. the table
  if (typeof key !== "string" || unnamed(key)) return null;
  if (Object.prototype.hasOwnProperty.call(ARROWS, key)) return hit("nav", ARROWS[key]);
  const entry = TABLE.get(key.length === 1 ? key.toLowerCase() : key);
  return entry ? hit(entry[0], entry[1]) : null;
}
