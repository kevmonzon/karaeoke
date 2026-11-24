/*
 * shortcuts-ui.js — Settings → keyboard shortcuts: every rebindable action with its keys.
 *
 * Each key is a button: select it to CHANGE that key; ＋ adds a key. The next key pressed is
 * taken (capture); Back / Escape cancels. A key another action holds asks first — Swap (that
 * action takes the key being replaced) or Move (adding: it just loses the key) — or Cancel.
 * "Reset shortcuts" stores no overrides, so every action follows the defaults again.
 *
 * The keys themselves live in the `keys.bindings` setting as overrides ({ actionId: [keys] },
 * only the actions that differ from the defaults — keymap.js `overridesFor`); this module never
 * touches settings directly: `getOverrides` / `setOverrides` are the caller's.
 *
 * Capture is the one time a key must NOT reach the app: a document listener in the CAPTURE phase
 * runs before the key router (document, bubble) and before any widget, and the taken key gets
 * preventDefault + stopImmediatePropagation (so F5 does not reload and `s` does not open Songs).
 * Keys that cannot be shortcuts are told apart first:
 *   - Back / Escape / Backspace (and the TV Back codes) cancel — swallowed, or Back would also
 *     close Settings;
 *   - arrows, Enter and Tab are let through: they move between and press the prompt's buttons
 *     (Remove / Swap / Cancel), and focus leaving the prompt cancels the capture;
 *   - digits, keys with no name, and the rest of the fixed keys are swallowed with a reason;
 *   - a Ctrl / Alt / ⌘ chord is let through (browser shortcuts keep working) with a reason;
 *   - a held key's repeats are swallowed, so holding OK on "Change" never presses Cancel.
 * D-pad and touch alike: every control is a real <button> in the tab order, nothing is
 * hover-only, and focus always lands on a button that is still on screen. No innerHTML.
 */

import {
  SHORTCUT_ACTIONS, MAX_KEYS_PER_ACTION, resolveBindings, overridesFor,
  keyName, keyLabel, isRebindableKey, keyToAction,
} from "./keymap.js";

const LABEL = new Map(SHORTCUT_ACTIONS.map((a) => [a.id, a.label]));

// Held for a chord or a capital; never a key of their own, so capture ignores them silently.
const MODIFIERS = new Set([
  "Shift", "Control", "Alt", "AltGraph", "Meta", "OS", "Super", "Hyper", "Fn", "FnLock",
  "CapsLock", "NumLock", "ScrollLock", "Symbol", "SymbolLock",
]);

const AGAIN = " Press another key, or Back to cancel.";

const copyTable = (table) => {
  const t = {};
  for (const { id } of SHORTCUT_ACTIONS) t[id] = Array.isArray(table && table[id]) ? [...table[id]] : [];
  return t;
};

/** The action that holds `key` in `table`, or null. */
export function ownerOf(table, key) {
  for (const { id } of SHORTCUT_ACTIONS) if (table && Array.isArray(table[id]) && table[id].includes(key)) return id;
  return null;
}

/**
 * What putting `newKey` (a key name as keymap.js `keyName` gives it) on `action` does. Replacing
 * `oldKey` keeps its place in the list; without `oldKey` the key is added at the end.
 *   - noop:     nothing changes (the same key, a key the action already has, a full list, a
 *               key that cannot be a shortcut);
 *   - ok:       `table` is the result;
 *   - conflict: `owner` holds the key; `table` is the result of Swap / Move, where the owner
 *               takes `oldKey` in the key's place (`gets`), or, when adding, just loses it.
 * Pure: `table` is not changed.
 * @returns {{kind:"noop"} | {kind:"ok", table:object} | {kind:"conflict", owner:string, gets:string|null, table:object}}
 */
export function planChange(table, { action, oldKey = null, newKey } = {}) {
  if (!LABEL.has(action) || !isRebindableKey(newKey)) return { kind: "noop" };
  const t = copyTable(table);
  const mine = t[action];
  const replacing = oldKey !== null && mine.includes(oldKey);
  if (replacing && oldKey === newKey) return { kind: "noop" };
  const owner = ownerOf(t, newKey);
  if (owner === action) {
    if (!replacing) return { kind: "noop" };
    t[action] = mine.filter((k) => k !== oldKey);   // it has the new key already: only the old one goes
    return { kind: "ok", table: t };
  }
  if (!replacing && mine.length >= MAX_KEYS_PER_ACTION) return { kind: "noop" };
  if (replacing) mine[mine.indexOf(oldKey)] = newKey;
  else mine.push(newKey);
  if (!owner) return { kind: "ok", table: t };
  const theirs = t[owner];
  const at = theirs.indexOf(newKey);
  if (replacing) theirs[at] = oldKey;   // a swap: neither action ends up with fewer keys
  else theirs.splice(at, 1);
  return { kind: "conflict", owner, gets: replacing ? oldKey : null, table: t };
}

/** `table` without `key` on `action` (pure). */
export function removeKey(table, action, key) {
  const t = copyTable(table);
  if (LABEL.has(action)) t[action] = t[action].filter((k) => k !== key);
  return t;
}

/**
 * @param {{el:Element, getOverrides:()=>object, setOverrides:(o:object)=>void, doc?:Document}} opts
 * @returns {{render:()=>void, cancel:()=>void}}
 *   render(): (re)draws the list from getOverrides(); safe to call on every settings change.
 *   cancel(): ends a capture in progress (e.g. when Settings closes) and frees the keys.
 */
export function createShortcutsUI({ el, getOverrides, setOverrides, doc = document }) {
  const rows = new Map();   // action id → { row, box, sig }
  let built = false;
  let status = null, prompt = null, msg = null, btns = null;
  let cap = null;           // { action, oldKey, origin, pending: newKey | null }

  const table = () => resolveBindings(typeof getOverrides === "function" ? getOverrides() : null);

  const make = (tag, cls, text) => {
    const n = doc.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
  };
  const button = (cls, text, attrs = {}) => {
    const b = make("button", cls, text);
    b.setAttribute("type", "button");
    for (const [k, v] of Object.entries(attrs)) b.setAttribute(k, v);
    return b;
  };

  function build() {
    built = true;
    el.classList.add("sc");
    const parts = [
      make("p", "hint sc-hint", "Select a key to change it, or ＋ to add one. Arrows, OK, Back and 0–9 stay as they are."),
    ];
    status = make("p", "sc-status");
    status.setAttribute("role", "status");
    status.setAttribute("aria-live", "polite");
    parts.push(status);
    let group = null;
    for (const { id, label, group: g } of SHORTCUT_ACTIONS) {
      if (g !== group) { group = g; parts.push(make("div", "sub-h sc-group", g)); }
      // class "row": the Settings search indexes `.row`s, so "tempo" finds these too
      const row = make("div", "row sc-row");
      row.setAttribute("data-action", id);
      const box = make("div", "sc-keys");
      box.setAttribute("role", "group");
      box.setAttribute("aria-label", label);
      row.appendChild(make("div", "sc-label", label));
      row.appendChild(box);
      parts.push(row);
      rows.set(id, { row, box, sig: null });
    }
    prompt = make("div", "sc-prompt");
    prompt.setAttribute("role", "group");
    prompt.setAttribute("aria-label", "Change a shortcut");
    prompt.hidden = true;
    msg = make("p", "sc-msg");
    msg.setAttribute("aria-live", "assertive");
    btns = make("div", "sc-btns");
    prompt.appendChild(msg);
    prompt.appendChild(btns);
    parts.push(prompt);   // hidden here until a capture moves it under its row
    parts.push(button("reset-btn sc-reset", "Reset shortcuts", { "data-do": "reset" }));
    el.replaceChildren(...parts);
    el.addEventListener("click", onClick);
  }

  // Redraw only the rows whose keys changed. A rebuilt row keeps focus on the same key if it is
  // still there, else on the key in the same place, else on ＋ — never on <body>.
  function refresh() {
    const t = table();
    for (const { id, label } of SHORTCUT_ACTIONS) {
      const r = rows.get(id);
      const keys = t[id];
      const sig = keys.join("\n");
      if (r.sig === sig) continue;
      r.sig = sig;
      const a = doc.activeElement;
      const had = !!a && a !== r.box && r.box.contains(a);
      const was = had ? { key: a.getAttribute("data-key"), at: chipsOf(r.box).indexOf(a) } : null;
      const chips = keys.map((k) => button("sc-key", keyLabel(k), {
        "data-key": k, "aria-label": `${keyLabel(k)}: change this key for ${label}`, title: "Change",
      }));
      const parts = [...chips];
      if (!keys.length) parts.push(make("div", "sc-none", "No key"));   // not a span: `.settings-body .row span` would restyle it
      if (keys.length < MAX_KEYS_PER_ACTION) {
        parts.push(button("sc-add", "＋", { "data-do": "add", "aria-label": `Add a key for ${label}`, title: "Add a key" }));
      }
      r.box.replaceChildren(...parts);
      if (was) {
        const add = parts.find((p) => p.getAttribute && p.getAttribute("data-do") === "add");
        const same = was.key !== null ? chips.find((c) => c.getAttribute("data-key") === was.key) : null;
        const target = same || (was.at >= 0 ? chips[Math.min(was.at, chips.length - 1)] : null) || add || chips[chips.length - 1];
        if (target) target.focus();
      }
    }
  }

  function chipsOf(box) {
    const out = [];
    for (const c of box.children) if (c.getAttribute && c.getAttribute("data-key") !== null) out.push(c);
    return out;
  }

  function focusOn(action, key) {
    const r = rows.get(action);
    if (!r) return;
    const chips = chipsOf(r.box);
    const want = (key !== null && chips.find((c) => c.getAttribute("data-key") === key))
      || [...r.box.children].find((c) => c.getAttribute && c.getAttribute("data-do") === "add")
      || chips[0];
    if (want) want.focus();
  }

  // --- the prompt ------------------------------------------------------------------------------
  function showPrompt(text, actions, focusIdx) {
    msg.textContent = text;
    const bs = actions.map(([what, text]) => button(`sc-act${what === "swap" ? " primary" : ""}`, text, { "data-do": what }));
    btns.replaceChildren(...bs);
    prompt.hidden = false;
    if (bs[focusIdx]) bs[focusIdx].focus();
  }

  function captureText() {
    const label = LABEL.get(cap.action);
    return cap.oldKey !== null
      ? `Press the new key for “${label}” (now ${keyLabel(cap.oldKey)}). Back cancels.`
      : `Press a key to add to “${label}”. Back cancels.`;
  }

  function startCapture(action, oldKey, origin) {
    if (cap) endCapture(false);
    const r = rows.get(action);
    if (!r) return;
    cap = { action, oldKey, origin, pending: null };
    status.textContent = "";
    origin.setAttribute("data-capturing", "");
    r.row.appendChild(prompt);   // right under the key being changed: one arrow from it
    listen(true);
    const acts = [];
    if (oldKey !== null) acts.push(["remove", `Remove ${keyLabel(oldKey)}`]);
    acts.push(["cancel", "Cancel"]);
    showPrompt(captureText(), acts, acts.length - 1);   // Cancel: an accidental OK does nothing
  }

  function endCapture(restoreFocus) {
    if (!cap) return;
    const { origin } = cap;
    cap = null;
    listen(false);
    origin.removeAttribute("data-capturing");
    if (restoreFocus && origin.isConnected !== false) origin.focus();   // before the prompt hides
    prompt.hidden = true;
  }

  // Store the new table (null: nothing changed), redraw, put focus on the key that changed —
  // before the prompt hides, so focus never drops to <body> — and say what happened.
  function commit(next, action, key, text) {
    const { origin } = cap;
    cap = null;
    listen(false);
    origin.removeAttribute("data-capturing");
    if (next && typeof setOverrides === "function") setOverrides(overridesFor(next));
    refresh();
    focusOn(action, key);
    prompt.hidden = true;
    status.textContent = text;
  }

  function choose(key) {
    const label = LABEL.get(cap.action);
    const plan = planChange(table(), { action: cap.action, oldKey: cap.oldKey, newKey: key });
    const k = keyLabel(key);
    if (plan.kind === "noop") { commit(null, cap.action, key, `${k} is already a key for ${label}.`); return; }
    if (plan.kind === "ok") { commit(plan.table, cap.action, key, `${k} → ${label}.`); return; }
    cap.pending = key;
    const theirs = LABEL.get(plan.owner);
    const text = plan.gets !== null
      ? `${k} is already “${theirs}”. Swap, and “${theirs}” gets ${keyLabel(plan.gets)}?`
      : `${k} is already “${theirs}”. Move it here${plan.table[plan.owner].length ? "" : `, leaving “${theirs}” with no key`}?`;
    showPrompt(text, [["swap", plan.gets !== null ? "Swap" : "Move"], ["cancel", "Cancel"]], 0);
  }

  function swap() {
    const key = cap.pending;
    const label = LABEL.get(cap.action);
    const plan = planChange(table(), { action: cap.action, oldKey: cap.oldKey, newKey: key });
    if (plan.kind === "noop") { endCapture(true); return; }
    const k = keyLabel(key);
    const text = plan.kind === "conflict" && plan.gets !== null
      ? `${k} → ${label}; ${keyLabel(plan.gets)} → ${LABEL.get(plan.owner)}.`
      : plan.kind === "conflict" ? `${k} → ${label} (moved from ${LABEL.get(plan.owner)}).` : `${k} → ${label}.`;
    commit(plan.table, cap.action, key, text);
  }

  function remove() {
    const { action, oldKey } = cap;
    commit(removeKey(table(), action, oldKey), action, null, `Removed ${keyLabel(oldKey)} from ${LABEL.get(action)}.`);
  }

  function reset() {
    if (cap) endCapture(false);
    if (typeof setOverrides === "function") setOverrides({});
    refresh();
    status.textContent = "Shortcuts are back to the defaults.";
  }

  function onClick(e) {
    const b = e.target && e.target.closest ? e.target.closest("button") : null;
    if (!b || !el.contains(b)) return;
    const what = b.getAttribute("data-do");
    if (what === "reset") { reset(); return; }
    if (what === "cancel") { endCapture(true); return; }
    if (what === "swap") { if (cap && cap.pending !== null) swap(); return; }
    if (what === "remove") { if (cap && cap.oldKey !== null) remove(); return; }
    const row = b.closest(".sc-row");
    const action = row && row.getAttribute("data-action");
    if (!rows.has(action)) return;
    if (what === "add") startCapture(action, null, b);
    else if (b.getAttribute("data-key") !== null) startCapture(action, b.getAttribute("data-key"), b);
  }

  // --- capture-phase listeners (only while a capture is open) -----------------------------------
  // Settings closed under an open capture: let keys go again rather than swallow them unseen.
  const shown = () => el.isConnected !== false && !(el.closest && el.closest("[hidden], [inert]"));

  // The swallowed key's own keyup goes nowhere either (a Space keyup on a button is its click).
  // One pending keyup at a time, matched by the physical key (Shift may be let go first).
  let pendingUp = null;
  function swallow(e) {
    e.preventDefault();
    e.stopImmediatePropagation();
    if (pendingUp) doc.removeEventListener("keyup", pendingUp, true);
    const code = e.code, key = e.key;
    const up = (u) => {
      if (code ? u.code !== code : u.key !== key) return;
      u.preventDefault();
      u.stopImmediatePropagation();
      doc.removeEventListener("keyup", up, true);
      if (pendingUp === up) pendingUp = null;
    };
    pendingUp = up;
    doc.addEventListener("keyup", up, true);
  }

  function onKeydown(e) {
    if (!cap) return;
    if (!shown()) { endCapture(false); return; }
    const name = keyName(e);
    if (e.ctrlKey || e.metaKey || e.altKey) {
      if (!MODIFIERS.has(name)) msg.textContent = `Shortcuts are single keys: Ctrl, Alt and ⌘ stay with the browser.${AGAIN}`;
      return;
    }
    const fixed = keyToAction(e, {});   // the default map, ctx-free: what the fixed rules make of it
    if (fixed && fixed.action === "nav") return;   // arrows move, held or not
    if (MODIFIERS.has(name)) return;
    if (e.repeat) { swallow(e); return; }          // a held OK on a key never goes on to press Cancel
    if (fixed && fixed.action === "back") { swallow(e); endCapture(true); return; }
    if (name === "Enter" || name === "Tab" || (name === "" && e.keyCode === 13)) return;
    swallow(e);
    if (fixed && fixed.action === "digit") { msg.textContent = `0–9 type a song number, so they can't be shortcuts.${AGAIN}`; return; }
    if (name === "") { msg.textContent = `That button sends no key name, so it can't be a shortcut.${AGAIN}`; return; }
    if (!isRebindableKey(name)) { msg.textContent = `${keyLabel(name)} can't be a shortcut.${AGAIN}`; return; }
    choose(name);
  }

  // Focus leaving the prompt (an arrow, Tab, a tap elsewhere) is a cancel.
  function onFocusin(e) {
    if (cap && e.target && !prompt.contains(e.target)) endCapture(false);
  }
  function onPointerdown(e) {
    if (cap && e.target && !prompt.contains(e.target)) endCapture(false);
  }

  function listen(on) {
    const m = on ? "addEventListener" : "removeEventListener";
    doc[m]("keydown", onKeydown, true);
    doc[m]("focusin", onFocusin, true);
    doc[m]("pointerdown", onPointerdown, true);
  }

  return {
    render() {
      if (!built) build();
      if (cap) endCapture(true);
      refresh();
    },
    cancel() { endCapture(true); },
  };
}
