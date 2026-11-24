/*
 * numpad.js — the on-screen number pad (M8, plan §5.3, D4, P20). Shared by the host's Songs panel and
 * the phone's Search tab. The pad has no buffer and no resolver of its own: its keys edit a search field,
 * and the search's number tier (M2) lists every songbook's match.
 *
 * The exports, names and signatures are the M8 contract (written by the orchestrator; app.js codes
 * against them) — do not change them.
 */

/** The 3×4 phone layout, row by row: 1 2 3 / 4 5 6 / 7 8 9 / del 0 enter. */
export const NUMPAD_KEYS = Object.freeze(["1", "2", "3", "4", "5", "6", "7", "8", "9", "del", "0", "enter"]);

const DIGIT = /^[0-9]$/;
// What a key shows, and the name a screen reader reads when the glyph says nothing.
const LABELS = Object.freeze({ del: { text: "⌫", aria: "Delete" }, enter: { text: "⏎", aria: "Enter" } });

/**
 * Pure: what one pad key does to a field's value.
 *   a digit "0"–"9" → appended; "del" → the last character removed (safe on ""); "enter" → value
 *   unchanged and enter: true; anything else → unchanged, enter: false. value null/undefined → "".
 * @returns {{ value: string, enter: boolean }}
 */
export function applyPadKey(value, key) {
  const v = value == null ? "" : String(value);
  if (typeof key === "string" && DIGIT.test(key)) return { value: v + key, enter: false };
  // One CHARACTER, not one UTF-16 unit: a field may hold typed text, and slicing half of a surrogate
  // pair (an emoji, a rare CJK glyph) would leave a lone surrogate behind.
  if (key === "del") return { value: Array.from(v).slice(0, -1).join(""), enter: false };
  if (key === "enter") return { value: v, enter: true };
  return { value: v, enter: false };
}

/** Pure: true when `text`, trimmed, is one or more ASCII digits (/^\d+$/). "" and mixed text → false. */
export function digitsOnly(text) {
  return /^\d+$/.test(String(text ?? "").trim());   // \d without the u flag is ASCII 0–9 only
}

/**
 * @param {object} o
 * @param {HTMLElement} o.el   the pad's container (#numpad on the host; the phone's own container)
 * @param {(key: string) => void} o.onKey   one of NUMPAD_KEYS, on a click / tap / native Enter/Space
 * @param {Document} [o.doc]
 * @returns {{ render(): void, show(): void, hide(): void, readonly visible: boolean }}
 *   render(): fills el with twelve <button type="button" data-key="…"> in NUMPAD_KEYS order (labels:
 *   digits as themselves, "del" → "⌫" with aria-label "Delete", "enter" → "⏎" with aria-label "Enter"),
 *   one delegated click listener on el (added once). No keyboard handling of its own: spatial navigation
 *   (M4) moves between the buttons and native button activation presses them. The 3-column grid and the
 *   --hit height are CSS (the host's in src/css/sheet.css under a `/* numpad *\/` block; the phone's in
 *   remote.css). show()/hide() toggle el.hidden; `visible` = !el.hidden. All text via textContent.
 */
export function createNumpad({ el, onKey, doc = globalThis.document } = {}) {
  if (!el) throw new TypeError("createNumpad: `el` (the pad's container) is required");
  let wired = false;

  // The key a click landed on: the nearest data-key button between the target and the pad. Only a
  // key of OUR layout counts, so nothing else placed in the container can speak for the pad.
  function keyOf(target) {
    for (let n = target; n && n !== el; n = n.parentNode) {
      const k = typeof n.getAttribute === "function" ? n.getAttribute("data-key") : null;
      if (k != null) return NUMPAD_KEYS.includes(k) && !n.disabled ? k : null;
    }
    return null;
  }

  function onClick(e) {
    const k = keyOf(e && e.target);
    if (k && typeof onKey === "function") onKey(k);
  }

  return {
    render() {
      const keys = NUMPAD_KEYS.map((k) => {
        const b = doc.createElement("button");
        b.type = "button";
        b.className = "numpad-key";
        b.setAttribute("data-key", k);
        const label = LABELS[k];
        b.textContent = label ? label.text : k;
        if (label) b.setAttribute("aria-label", label.aria);
        return b;
      });
      el.replaceChildren(...keys);   // one swap; a second render replaces, never duplicates
      if (!wired) { el.addEventListener("click", onClick); wired = true; }
    },
    show() { el.hidden = false; },
    hide() { el.hidden = true; },
    get visible() { return !el.hidden; },
  };
}
