/*
 * keymap.js — one keydown → one app action (pure: reads the event's fields, never the DOM).
 *
 * The key router builds `ctx` from where focus is and calls `keyToAction(ev, ctx, table)`; a null
 * result means "not ours, let the key through". Rules, first match wins:
 *
 *   1. a Ctrl / Meta / Alt chord is never ours (browser and OS shortcuts);
 *   2. a missing key name ("" / "Unidentified", as TV browsers send) is looked up by keyCode;
 *   3. Enter is never ours — the focused control activates itself;
 *   4. while typing, only the Back keys and the function keys F1–F24 map (an F-key never types a
 *      character, and unmapped it would reach the browser: F1 help, F3 find, F5 reload);
 *   5. on a focused list row, Space / "+" / "=" belong to the row;
 *   6. digits: not under a dialog, not on a row inside Songs (type-to-search takes them);
 *   7. Backspace is Back;
 *   8. arrows are spatial navigation; everything else by the binding table (letters
 *      case-insensitive).
 *
 * Rules 1–7 and the arrows are FIXED: they are how a TV remote moves, confirms, goes back and
 * dials a song number, so no binding can take them. Everything rule 8 looks up in the table is a
 * SHORTCUT the user may rebind in Settings (`keys.bindings` holds only the actions they changed;
 * `resolveBindings` merges that over `DEFAULT_BINDINGS`).
 */

/** Every action this map can return. */
export const ACTIONS = Object.freeze([
  "nav", "back", "digit", "playPause", "next", "restart", "stop",
  "keyUp", "keyDown", "tempoUp", "tempoDown", "offsetUp", "offsetDown",
  "melodyToggle", "melodyUp", "melodyDown", "volumeUp", "volumeDown",
  "openSearch", "searchToggle", "openQueue", "guideToggle", "bgNext", "fullscreen",
]);

/**
 * keyCode → key name, used only when the event carries no key name (TV platforms).
 * The remote's Back button becomes "GoBack", the standard key name that maps to `back`.
 * Bindings are stored by key NAME, so a binding to "ColorF0Red" matches the TV's 403 through this.
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

/**
 * The actions a user may rebind, in the order (and groups) the Settings list shows them.
 * nav / back / digit are not here: their keys are fixed (see the header).
 */
export const SHORTCUT_ACTIONS = Object.freeze([
  { id: "playPause", label: "Play / pause", group: "Playback" },
  { id: "next", label: "Next song", group: "Playback" },
  { id: "restart", label: "Restart the song", group: "Playback" },
  { id: "stop", label: "Stop", group: "Playback" },
  { id: "searchToggle", label: "Song search (open / close)", group: "Panels" },
  { id: "openSearch", label: "Open song search", group: "Panels" },
  { id: "openQueue", label: "Open the queue", group: "Panels" },
  { id: "volumeUp", label: "Volume up", group: "Sound" },
  { id: "volumeDown", label: "Volume down", group: "Sound" },
  { id: "melodyToggle", label: "Melody volume (next step)", group: "Sound" },
  { id: "melodyUp", label: "Melody louder", group: "Sound" },
  { id: "melodyDown", label: "Melody quieter", group: "Sound" },
  { id: "keyUp", label: "Key +", group: "Key & tempo" },
  { id: "keyDown", label: "Key −", group: "Key & tempo" },
  { id: "tempoUp", label: "Tempo +", group: "Key & tempo" },
  { id: "tempoDown", label: "Tempo −", group: "Key & tempo" },
  { id: "offsetUp", label: "Lyrics offset +", group: "Key & tempo" },
  { id: "offsetDown", label: "Lyrics offset −", group: "Key & tempo" },
  { id: "guideToggle", label: "Pitch guide (show / hide)", group: "Screen" },
  { id: "bgNext", label: "Next background", group: "Screen" },
  { id: "fullscreen", label: "Full screen", group: "Screen" },
].map((a) => Object.freeze(a)));

/** A stored list longer than this is cut (a hand-edited value cannot grow the table without bound). */
export const MAX_KEYS_PER_ACTION = 8;

/**
 * The shipped shortcuts: action id → key names (single characters lowercase). Every rebindable
 * action has an entry; [] = no key by default. No key appears twice.
 */
export const DEFAULT_BINDINGS = deepFreeze({
  playPause: [" ", "k", "MediaPlayPause", "MediaPlay", "MediaPause"],
  next: ["n", "MediaTrackNext"],
  restart: ["p", "MediaTrackPrevious"],
  stop: ["MediaStop"],
  searchToggle: ["F1"],
  openSearch: ["/", "s", "ColorF0Red"],
  openQueue: ["q", "ColorF1Green"],
  volumeUp: [],
  volumeDown: [],
  melodyToggle: ["m", "F2", "ColorF3Blue"],
  melodyUp: [],
  melodyDown: [],
  keyUp: ["+", "=", "ChannelUp", "F4"],
  keyDown: ["-", "ChannelDown", "F3"],
  tempoUp: [".", "F6"],
  tempoDown: [",", "F5"],
  offsetUp: ["]"],
  offsetDown: ["["],
  guideToggle: ["F8"],
  bgNext: ["ColorF2Yellow"],
  fullscreen: ["f"],
});

// MediaPlay / MediaPause are separate remote buttons: they carry which way to go, so pressing
// Play while playing never pauses. The arg rides on the KEY, and only for the action it means.
const KEY_ARGS = new Map([
  ["MediaPlay", new Map([["playPause", "play"]])],
  ["MediaPause", new Map([["playPause", "pause"]])],
]);

const BACK_KEYS = new Set(["Escape", "BrowserBack", "GoBack"]);

const ARROWS = Object.freeze({ ArrowUp: "up", ArrowDown: "down", ArrowLeft: "left", ArrowRight: "right" });

// Keys no binding may take: the rules above own them (plus Tab, which moves focus in every
// browser — a shortcut on it would trap a keyboard user — and the legacy names of the arrows and
// Escape that old TV browsers still send).
const FIXED_KEYS = new Set([
  "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Up", "Down", "Left", "Right",
  "Enter", "NumpadEnter", "Escape", "Esc", "BrowserBack", "GoBack", "Backspace", "Tab",
  "0", "1", "2", "3", "4", "5", "6", "7", "8", "9",
]);

// Not keys of their own: modifiers start a chord, Dead / Process are mid-composition.
const NOT_KEYS = new Set([
  "Shift", "Control", "Alt", "AltGraph", "Meta", "OS", "Super", "Hyper", "Fn", "FnLock",
  "CapsLock", "NumLock", "ScrollLock", "Symbol", "SymbolLock", "Dead", "Process", "Compose",
  "Unidentified",
]);

const LABELS = new Map([
  [" ", "Space"],
  ["ColorF0Red", "Red"], ["ColorF1Green", "Green"], ["ColorF2Yellow", "Yellow"], ["ColorF3Blue", "Blue"],
  ["ColorF4Grey", "Grey"], ["ColorF5Brown", "Brown"],
  ["MediaPlayPause", "Play/Pause"], ["MediaPlay", "Play"], ["MediaPause", "Pause"], ["MediaStop", "Stop"],
  ["MediaTrackNext", "Next track"], ["MediaTrackPrevious", "Previous track"],
  ["MediaFastForward", "Fast forward"], ["MediaRewind", "Rewind"], ["MediaRecord", "Record"],
  ["ChannelUp", "Channel +"], ["ChannelDown", "Channel −"],
  ["AudioVolumeUp", "Volume +"], ["AudioVolumeDown", "Volume −"], ["AudioVolumeMute", "Mute"],
  ["Pause", "Pause/Break"],   // the desktop key, so it never reads like the remote's Pause
  ["Escape", "Esc"], ["Esc", "Esc"], ["GoBack", "Back"], ["BrowserBack", "Back"],
  ["ArrowUp", "↑"], ["ArrowDown", "↓"], ["ArrowLeft", "←"], ["ArrowRight", "→"],
  ["ContextMenu", "Menu"],
]);

const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

const hit = (action, arg) => (arg === undefined ? { action } : { action, arg });

const unnamed = (key) => key == null || key === "" || key === "Unidentified";

// Single characters are stored and matched lowercased (Shift+S is still "s").
const norm = (key) => (key.length === 1 ? key.toLowerCase() : key);

function deepFreeze(table) {
  for (const k of Object.keys(table)) Object.freeze(table[k]);
  return Object.freeze(table);
}

/** F1–F24: never a character, so they map even while typing (rule 4). */
export function isFunctionKey(key) {
  return typeof key === "string" && /^F([1-9]|1[0-9]|2[0-4])$/.test(key);
}

// A stored key name → its normalized form, or null when no binding may hold it. The stored value
// comes from localStorage and may be hand-edited: only short, plain key names get through.
function cleanKey(key) {
  if (typeof key !== "string" || key.length === 0 || key.length > 32) return null;
  if (key.length === 1) {
    if (/[\u0000-\u001f\u007f]/.test(key)) return null;
  } else if (!/^[A-Za-z][A-Za-z0-9]*$/.test(key)) {
    return null;
  }
  const n = norm(key);
  return FIXED_KEYS.has(n) || NOT_KEYS.has(n) ? null : n;
}

/** True when `key` (a key name, as stored or as `keyName` returns it) may be a shortcut. */
export function isRebindableKey(key) {
  return cleanKey(key) !== null;
}

/**
 * The key name an event stands for, as bindings store it: the TV keyCode fallback applied and a
 * single character lowercased. "" when the event names no key (an unknown TV keyCode).
 */
export function keyName(ev) {
  if (!ev) return "";
  let key = ev.key;
  if (unnamed(key)) key = hasOwn(TV_KEYCODES, ev.keyCode) ? TV_KEYCODES[ev.keyCode] : "";
  return typeof key === "string" ? norm(key) : "";
}

// One stored list → its clean keys; null when it is not a list or held only rubbish (the action
// then keeps its defaults). An empty list is kept: it is how an action ends up with no key.
function cleanList(list) {
  if (!Array.isArray(list)) return null;
  if (list.length === 0) return [];
  const out = [];
  for (const raw of list.slice(0, 64)) {
    const k = cleanKey(raw);
    if (k !== null && !out.includes(k)) out.push(k);
    if (out.length === MAX_KEYS_PER_ACTION) break;
  }
  return out.length ? out : null;
}

/**
 * The effective binding table: `overrides` ({ actionId: [keys] }, the `keys.bindings` setting)
 * over the defaults. Unknown action ids, fixed keys and non-key values are ignored; an entry that
 * is not a usable list falls back to that action's defaults. One key, one action: a key an
 * override claims leaves every action that has it only by default, and between two overrides
 * the earlier action in SHORTCUT_ACTIONS keeps it. Returns a frozen table shaped like
 * DEFAULT_BINDINGS (every rebindable action present). Idempotent: resolving a table gives it back.
 */
export function resolveBindings(overrides) {
  const src = overrides && typeof overrides === "object" && !Array.isArray(overrides) ? overrides : {};
  const claimed = new Set();
  const custom = new Map();
  for (const { id } of SHORTCUT_ACTIONS) {
    if (!hasOwn(src, id)) continue;
    const list = cleanList(src[id]);
    if (list === null) continue;
    const kept = list.filter((k) => !claimed.has(k));
    for (const k of kept) claimed.add(k);
    custom.set(id, kept);
  }
  const out = {};
  for (const { id } of SHORTCUT_ACTIONS) {
    out[id] = custom.has(id) ? custom.get(id) : DEFAULT_BINDINGS[id].filter((k) => !claimed.has(k));
  }
  return deepFreeze(out);
}

const sameList = (a, b) => a.length === b.length && a.every((k, i) => k === b[i]);

/**
 * The smallest `keys.bindings` value that resolves to `table`: only the actions whose keys differ
 * from the defaults. Storing the difference lets a later default reach every action left alone.
 */
export function overridesFor(table) {
  const t = resolveBindings(table);
  const out = {};
  for (const { id } of SHORTCUT_ACTIONS) if (!sameList(t[id], DEFAULT_BINDINGS[id])) out[id] = [...t[id]];
  return out;
}

// key name → action, per table. Frozen tables (DEFAULT_BINDINGS, resolveBindings' results) are
// inverted once; anything else is resolved first, so a raw or hand-made table is as safe as one
// from resolveBindings.
const LOOKUPS = new WeakMap();
function lookupFor(table) {
  if (!table || typeof table !== "object") table = DEFAULT_BINDINGS;
  let map = LOOKUPS.get(table);
  if (map) return map;
  const t = table === DEFAULT_BINDINGS ? table : resolveBindings(table);
  map = new Map();
  for (const { id } of SHORTCUT_ACTIONS) for (const k of t[id]) map.set(k, id);
  if (Object.isFrozen(table)) LOOKUPS.set(table, map);
  return map;
}

function lookup(table, key) {
  const action = lookupFor(table).get(key);
  if (!action) return null;
  const args = KEY_ARGS.get(key);
  return hit(action, args ? args.get(action) : undefined);
}

/**
 * @param {{key?:string, code?:string, keyCode?:number, ctrlKey?:boolean, metaKey?:boolean, altKey?:boolean}} ev
 * @param {{typing?:boolean, inList?:boolean, inSearch?:boolean, modal?:boolean}} [ctx]
 * @param {object} [table] a binding table (resolveBindings' result); the defaults when omitted
 * @returns {{action:string, arg?:*} | null}
 */
export function keyToAction(ev, ctx, table = DEFAULT_BINDINGS) {
  if (!ev) return null;
  const { typing = false, inList = false, inSearch = false, modal = false } = ctx || {};

  // 1. chords
  if (ev.ctrlKey || ev.metaKey || ev.altKey) return null;

  // 2. TV platforms: no key name → keyCode
  let key = ev.key;
  if (unnamed(key) && hasOwn(TV_KEYCODES, ev.keyCode)) {
    key = TV_KEYCODES[ev.keyCode];
  }
  const code = typeof ev.code === "string" ? ev.code : "";

  // 3. Enter belongs to the focused control
  if (key === "Enter" || key === "NumpadEnter" || code === "NumpadEnter" || (unnamed(key) && ev.keyCode === 13)) {
    return null;
  }

  // 4. typing: Back, and the F-keys (they type nothing)
  if (typing) {
    if (BACK_KEYS.has(key)) return hit("back");
    return isFunctionKey(key) ? lookup(table, key) : null;
  }

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

  // 8. arrows, then the binding table
  if (typeof key !== "string" || unnamed(key)) return null;
  if (hasOwn(ARROWS, key)) return hit("nav", ARROWS[key]);
  if (BACK_KEYS.has(key)) return hit("back");
  return lookup(table, norm(key));
}

/** A key name as the Settings list shows it: "F1", "Space", "Red", "Play/Pause", "S". */
export function keyLabel(key) {
  if (typeof key !== "string" || key === "") return "";
  if (LABELS.has(key)) return LABELS.get(key);
  if (key.length === 1) return key.toUpperCase();
  return key.replace(/([a-z0-9])([A-Z])/g, "$1 $2");   // "PageDown" → "Page Down"
}
