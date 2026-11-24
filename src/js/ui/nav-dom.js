/*
 * nav-dom.js — arrow keys / D-pad on the real page: scope, candidates, native widgets (M4).
 *
 * Contract written by the orchestrator, bodies by M4 lane A. The exports, their names and their
 * signatures are the contract lane I codes against — do not change them.
 * Geometry is spatial-nav.js pickNext (M1). The rules are §4.3 of the plan (v2.2) with the M4
 * amendments A5–A9 (see the lane briefs):
 *   A6  an element with the attribute tabindex="-1" is never a candidate (the non-roving song
 *       rows and a row's ★ / ＋ buttons), so a song row is ONE stop;
 *   A7  with no modal open, the scope is the home tiles (while idle) PLUS the control bar (while
 *       visible) — on the home screen both are on show, and an arrow moves between them;
 *   A9  a range marked data-nav-axis="vertical" owns Up/Down instead of Left/Right, so a slider
 *       in a one-row bar (the bar's Volume) never traps the D-pad between its neighbours;
 *   A10 a range or select at a dead end swallows the arrow it released (move returns true), so
 *       the browser never steps it on a key that was meant to move focus.
 *   A11 move(dir, { release: true }) skips rule 1: the caller (the key router) has decided the
 *       focused widget let go of this arrow — a single-line text field whose caret sits at the
 *       start (Left) or end (Right) of its text — so the controls beside it on the same line
 *       (the Songs panel's search-row buttons) are reachable. Orchestrator integration fix.
 *
 * The DOM surface this module relies on (so a hand-built fake can stand in for it in Node):
 *   doc:      activeElement, contains(el)?, defaultView?.getComputedStyle(el)?, defaultView?.Event?
 *   element:  tagName, querySelectorAll(sel), contains(el), parentElement / parentNode,
 *             hasAttribute / getAttribute, hidden?, disabled?, type?, dataset?, getClientRects()?,
 *             getBoundingClientRect(), focus(opts), scrollIntoView(opts)?, click()?, showPicker()?,
 *             dispatchEvent(ev)?, ownerDocument?
 *   select:   selectedIndex, options (or querySelectorAll("option")); option: disabled, hidden
 * Everything marked ? is feature-detected; a missing one skips that check or that call.
 * No DOM access at import time.
 */

import { pickNext } from "./spatial-nav.js";

/** Everything that can take focus (before the visibility / inert / tabindex filters). */
export const FOCUSABLE =
  'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),summary,[tabindex]:not([tabindex="-1"])';

const DIRS = new Set(["up", "down", "left", "right"]);
const isHorizontal = (dir) => dir === "left" || dir === "right";

// <input> types whose caret owns Left/Right ("" = no type attribute).
const TEXT_TYPES = new Set(["", "text", "search", "url", "email", "tel", "password"]);

const lower = (v) => (v == null ? "" : String(v).trim().toLowerCase());
const attrOf = (el, name) => (el && typeof el.getAttribute === "function" ? el.getAttribute(name) : null);
const hasAttr = (el, name) => !!el && typeof el.hasAttribute === "function" && el.hasAttribute(name);
const parentOf = (n) => (n && (n.parentElement || n.parentNode)) || null;
const report = (e) => { try { console.error(e); } catch { /* no console */ } };

/**
 * Does this native widget keep the arrow `dir` for itself? Pure; the table in §4.3 + A9:
 *   range           → owns left/right (native value change), releases up/down;
 *                     with axis "vertical" (data-nav-axis="vertical", A9) → owns up/down (the
 *                     browser steps a range on ArrowUp/ArrowDown too), releases left/right;
 *   select          → owns left/right (nav.move steps it), releases up/down;
 *   text-like input (text, search, url, email, tel, password, or no type) → owns left/right
 *                     (caret), releases up/down;
 *   number          → owns all four;  textarea → owns all four;
 *   anything else (buttons, checkboxes, rows, summary, links) → owns nothing.
 * `axis` only matters for a range; a desc without it means "" (the default, horizontal).
 * Song and queue rows are NOT described here: the lists own their edges themselves.
 * @param {{tag:string, type?:string, role?:string, axis?:string}} desc
 * @param {"up"|"down"|"left"|"right"} dir
 * @returns {boolean}
 */
export function ownsArrow(desc, dir) {
  if (!desc || !DIRS.has(dir)) return false;
  const tag = lower(desc.tag);
  const horizontal = isHorizontal(dir);
  if (tag === "textarea") return true;
  if (tag === "select") return horizontal;
  if (tag !== "input") return false;
  const type = lower(desc.type);
  if (type === "number") return true;
  if (type === "range") return lower(desc.axis) === "vertical" ? !horizontal : horizontal;
  return TEXT_TYPES.has(type) && horizontal;
}

/**
 * DOM element → desc ({ tag: lowercase tag name, type: lowercase input type or "", role,
 * axis: lowercase data-nav-axis or "" (A9) }).
 * null/undefined → { tag: "", type: "", role: "", axis: "" }.
 * `type` is read for <input> only (the browser's normalised `.type`, else the attribute).
 */
export function describe(el) {
  if (!el) return { tag: "", type: "", role: "", axis: "" };
  const tag = lower(el.tagName || el.nodeName);
  let type = "";
  if (tag === "input") type = lower(typeof el.type === "string" && el.type ? el.type : attrOf(el, "type"));
  const role = lower(attrOf(el, "role"));
  const ds = el.dataset && typeof el.dataset.navAxis === "string" ? el.dataset.navAxis : attrOf(el, "data-nav-axis");
  return { tag, type, role, axis: lower(ds) };
}

/**
 * What Enter must do for this control, because it does not act on Enter natively. Pure:
 *   checkbox, radio → "click";  select, input[type=color] → "picker";  everything else → null
 *   (buttons, links, summary and rows already act on Enter).
 * @returns {"click"|"picker"|null}
 */
export function needsActivate(desc) {
  if (!desc) return null;
  const tag = lower(desc.tag);
  if (tag === "select") return "picker";
  if (tag !== "input") return null;
  const type = lower(desc.type);
  if (type === "checkbox" || type === "radio") return "click";
  if (type === "color") return "picker";
  return null;
}

/**
 * @param {object} o
 * @param {object}   o.stack           the overlay stack (top() → the top MODAL id or null)
 * @param {Document} [o.doc]
 * @param {(id:string)=>Element|null} o.getOverlayEl  the element registered for an overlay id
 * @param {()=>Element|null} o.getHomeRoot   a focusable home layer while idle (app.js: none since the home tiles
 *                                          went, 2026-11-24 — it passes () => null)
 * @param {()=>Element|null} o.getBarRoot    the bar the bare stage's D-pad reaches: #stage-foot (the stage footer)
 * @param {()=>Element[]}    [o.getExtraRoots] more roots on the bare stage (M11: the background layer while its
 *                                          "Tap to start camera" button shows) — added after home + bar
 * @param {()=>Element|null} [o.getBarEntry] the bar's entry point: #toggle-lib (Songs) (else its first focusable)
 * @param {()=>boolean} o.isIdle             body[data-idle="true"]
 * @param {()=>boolean} o.isBarVisible       app.js: always true (the footer is never out of the D-pad's reach)
 * @param {()=>void}    o.showBar            app.js: a no-op (kept for the old control bar's "show it first")
 * @returns {{
 *   scopeRoots(): Element[],
 *   focusables(roots?: Element|Element[]): Element[],
 *   move(dir: "up"|"down"|"left"|"right", opts?: { release?: boolean }): boolean,
 *   activate(el: Element|null): boolean,
 *   focusFirst(root?: Element|Element[]): boolean,
 *   stepSelect(el: HTMLSelectElement, delta: number): boolean,
 * }}
 *
 * scopeRoots(): the top modal's element if one is open (stack.top() → getOverlayEl); else
 *   [home root if isIdle()] + [bar root if isBarVisible()] (A7) + getExtraRoots() (M11); else [] (bare stage).
 *   A modal whose element is not registered gives [] too — but move() then does nothing
 *   (returns false) rather than showing a bar that the modal has made inert.
 * focusables(roots = scopeRoots()): elements matching FOCUSABLE inside the roots, in DOM order,
 *   that are visible (getClientRects().length > 0 and computed visibility !== "hidden"), not
 *   inside [hidden] / [inert] / [data-nav-skip], and without the attribute tabindex="-1" (A6).
 *   Also excluded: an element whose `disabled` property is true (a control in a disabled
 *   <fieldset>, which :not([disabled]) cannot see), any negative tabindex, and computed
 *   visibility "collapse". Roots nested in another root are folded into it; duplicates are dropped.
 * move(dir), first match wins:
 *   1. the focused element is a native widget that ownsArrow(describe(el), dir) — skipped when
 *      opts.release is true (A11):
 *        a <select> with left/right → stepSelect(el, ±1), return true;
 *        otherwise return false (the key goes through to the widget);
 *   2. scopeRoots() is empty (bare stage, bar hidden): showBar(), then focus getBarEntry() if it
 *      is usable, else focusFirst(bar root); return true;
 *   3. focus is not inside any scope root (body, #stage, a closed panel…): focus the scope's
 *      entry — the modal's first focusable; else (idle) the first home tile; else the bar entry —
 *      return true if focus landed;
 *   4. pickNext(rect(focused), rects(focusables() minus focused), dir) with rects from
 *      getBoundingClientRect() as {id, x, y, w, h}; focus the winner with
 *      focus({preventScroll:true}) then scrollIntoView({block:"nearest", inline:"nearest"});
 *      return true. No candidate → focus stays, return false — EXCEPT (A10) when the focused
 *      element is a range or a select that released this arrow (ownsArrow was false for dir):
 *      then return true, so the router's preventDefault stops the browser stepping the value or
 *      opening the popup on a key that was meant to move focus. (Also false when the winner
 *      refuses focus: nothing changed, so the key must not be swallowed.)
 *   "Focus landed" always means doc.activeElement === el after el.focus({preventScroll:true}).
 * activate(el): needsActivate(describe(el)): "click" → el.click(), true; "picker" →
 *   el.showPicker() inside try/catch (fall back to el.click()), true; else false.
 * focusFirst(root = scopeRoots()): focus the first of focusables(root); true if focus landed.
 *   (If the first refuses focus, the next is tried; every focus is followed by the same
 *   scrollIntoView({block:"nearest", inline:"nearest"}) as move.)
 * stepSelect(el, delta): move selectedIndex by delta to the next ENABLED option (clamped, no
 *   wrap); if it changed, dispatch a bubbling "change" event (and "input"); returns whether it changed.
 *   "Enabled" also skips a hidden option and an option in a disabled <optgroup>; "input" is
 *   dispatched before "change" (the browser's order). A disabled select never steps.
 */
export function createNav(o = {}) {
  const {
    stack = null,
    doc = globalThis.document,
    getOverlayEl = () => null,
    getHomeRoot = () => null,
    getBarRoot = () => null,
    getExtraRoots = () => [],
    getBarEntry = null,
    isIdle = () => false,
    isBarVisible = () => false,
    showBar = () => {},
  } = o || {};

  // Callbacks come from app.js; one that throws must not take the key router down with it.
  function call(fn, fallback = null, ...args) {
    if (typeof fn !== "function") return fallback;
    try { return fn(...args); } catch (e) { report(e); return fallback; }
  }

  // --- candidates ------------------------------------------------------------------------
  function blockedByAncestor(el) {
    for (let n = el; n && n.nodeType !== 9; n = parentOf(n)) {
      if (n.hidden === true || hasAttr(n, "hidden") || hasAttr(n, "inert") || hasAttr(n, "data-nav-skip")) return true;
    }
    return false;
  }

  function outOfTabOrder(el) {
    const t = attrOf(el, "tabindex");
    return t != null && Number.parseInt(t, 10) < 0;
  }

  function rendered(el) {
    try {
      if (typeof el.getClientRects === "function") {
        const rects = el.getClientRects();
        if (!rects || !(rects.length > 0)) return false;
      }
      const view = doc && doc.defaultView;
      if (view && typeof view.getComputedStyle === "function") {
        const cs = view.getComputedStyle(el);
        const v = cs && cs.visibility;
        if (v === "hidden" || v === "collapse") return false;
      }
    } catch { return false; }
    return true;
  }

  /** Could focus land here? (Everything but the FOCUSABLE selector itself.) */
  function usable(el) {
    if (!el || typeof el.focus !== "function") return false;
    if (el.disabled === true || outOfTabOrder(el)) return false;
    if (doc && typeof doc.contains === "function" && !doc.contains(el)) return false;
    if (blockedByAncestor(el)) return false;
    return rendered(el);
  }

  function rootList(roots) {
    const given = (Array.isArray(roots) ? roots : [roots])
      .filter((r) => r && typeof r.querySelectorAll === "function");
    const list = [...new Set(given)];
    const outer = list.filter((r) => !list.some((q) => q !== r && typeof q.contains === "function" && q.contains(r)));
    if (outer.length > 1 && outer.every((r) => typeof r.compareDocumentPosition === "function")) {
      outer.sort((a, b) => (a.compareDocumentPosition(b) & 4 /* b FOLLOWS a */ ? -1 : 1));
    }
    return outer;
  }

  function focusables(roots = scopeRoots()) {
    const out = [];
    const seen = new Set();
    for (const root of rootList(roots)) {
      let found;
      try { found = root.querySelectorAll(FOCUSABLE); } catch (e) { report(e); continue; }
      for (const el of found) {
        if (seen.has(el)) continue;
        seen.add(el);
        if (usable(el)) out.push(el);
      }
    }
    return out;
  }

  // --- scope -----------------------------------------------------------------------------
  function scope() {
    const top = call(() => (stack && typeof stack.top === "function" ? stack.top() : null));
    if (top) {
      const el = call(getOverlayEl, null, top);
      return { modal: top, roots: el ? [el] : [], home: null, bar: null };
    }
    const home = call(isIdle, false) ? call(getHomeRoot) : null;
    const bar = call(isBarVisible, false) ? call(getBarRoot) : null;
    const extra = call(getExtraRoots, []);
    return { modal: null, roots: [home, bar, ...(Array.isArray(extra) ? extra : [])].filter(Boolean), home, bar };
  }

  function scopeRoots() { return scope().roots; }

  // --- focus -----------------------------------------------------------------------------
  function land(el) {
    if (!usable(el)) return false;
    try { el.focus({ preventScroll: true }); } catch { return false; }
    if (!doc || doc.activeElement !== el) return false;
    if (typeof el.scrollIntoView === "function") {
      try { el.scrollIntoView({ block: "nearest", inline: "nearest" }); } catch { /* old engines */ }
    }
    return true;
  }

  function focusFirst(root = scopeRoots()) {
    for (const el of focusables(root)) if (land(el)) return true;
    return false;
  }

  function focusBarEntry(bar) {
    const entry = typeof getBarEntry === "function" ? call(getBarEntry) : null;
    if (entry && land(entry)) return true;
    return bar ? focusFirst(bar) : false;
  }

  function focusEntry(sc) {
    if (sc.modal) return focusFirst(sc.roots);
    if (sc.home && focusFirst(sc.home)) return true;
    if (sc.bar) return focusBarEntry(sc.bar);
    return focusFirst(sc.roots);   // M11: only an extra root (the background's camera button) is in scope
  }

  function rectOf(el, id) {
    if (!el || typeof el.getBoundingClientRect !== "function") return null;
    try {
      const b = el.getBoundingClientRect();
      if (!b) return null;
      const x = Number.isFinite(b.left) ? b.left : b.x;
      const y = Number.isFinite(b.top) ? b.top : b.y;
      const w = Number.isFinite(b.width) ? b.width : b.right - x;
      const h = Number.isFinite(b.height) ? b.height : b.bottom - y;
      return id === undefined ? { x, y, w, h } : { id, x, y, w, h };
    } catch { return null; }
  }

  // --- move ------------------------------------------------------------------------------
  function move(dir, { release = false } = {}) {
    if (!DIRS.has(dir)) return false;
    const active = doc ? doc.activeElement : null;

    // 1. a native widget that owns this arrow (unless the caller says the widget released it:
    //    A11, a text field's caret already at that end of its text)
    const desc = describe(active);
    if (active && !release && ownsArrow(desc, dir)) {
      if (desc.tag === "select" && isHorizontal(dir)) {
        stepSelect(active, dir === "left" ? -1 : 1);
        return true;
      }
      return false;
    }

    const sc = scope();

    // 2. the bare stage: bring the bar up and land on its entry
    if (!sc.roots.length) {
      if (sc.modal) return false;
      call(showBar);
      focusBarEntry(call(getBarRoot));
      return true;
    }

    // 3. focus is outside the scope: enter it
    const inside = !!active && sc.roots.some((r) => r !== active && typeof r.contains === "function" && r.contains(active));
    if (!inside) return focusEntry(sc);

    // 4. spatial navigation inside the scope
    const current = rectOf(active);
    if (!current) return false;
    const candidates = focusables(sc.roots).filter((el) => el !== active);
    const rects = [];
    candidates.forEach((el, i) => { const r = rectOf(el, i); if (r) rects.push(r); });
    const id = pickNext(current, rects, dir);
    if (id == null) return releasedByWidget(desc);   // A10: a dead end on a range / select
    return land(candidates[id]);
  }

  // A range or a select that RELEASED this arrow (rule 1 did not claim it) and has nowhere to
  // go: swallow the key, or the browser would step the value / open the popup on a key that was
  // meant to move focus.
  function releasedByWidget(desc) {
    return desc.tag === "select" || (desc.tag === "input" && desc.type === "range");
  }

  // --- widgets ---------------------------------------------------------------------------
  function click(el) {
    if (typeof el.click !== "function") return;
    try { el.click(); } catch (e) { report(e); }
  }

  function activate(el) {
    if (!el) return false;
    const kind = needsActivate(describe(el));
    if (kind === "click") { click(el); return true; }
    if (kind === "picker") {
      let opened = false;
      if (typeof el.showPicker === "function") {
        try { el.showPicker(); opened = true; } catch { opened = false; }   // no activation, iframe…
      }
      if (!opened) click(el);
      return true;
    }
    return false;
  }

  function optionsOf(el) {
    if (el.options && typeof el.options.length === "number") return Array.from(el.options);
    if (typeof el.querySelectorAll === "function") return Array.from(el.querySelectorAll("option"));
    return [];
  }

  function pickable(opt) {
    if (!opt || opt.disabled === true || hasAttr(opt, "disabled")) return false;
    if (opt.hidden === true || hasAttr(opt, "hidden")) return false;
    const group = parentOf(opt);
    if (group && lower(group.tagName) === "optgroup" && (group.disabled === true || hasAttr(group, "disabled"))) return false;
    return true;
  }

  function fire(el, type) {
    if (typeof el.dispatchEvent !== "function") return;
    const view = (el.ownerDocument && el.ownerDocument.defaultView) || (doc && doc.defaultView) || null;
    const Ctor = view && typeof view.Event === "function" ? view.Event
      : (typeof globalThis.Event === "function" ? globalThis.Event : null);
    let ev = null;
    try {
      if (Ctor) ev = new Ctor(type, { bubbles: true });
      else if (doc && typeof doc.createEvent === "function") { ev = doc.createEvent("Event"); ev.initEvent(type, true, false); }
    } catch { ev = null; }
    if (!ev) return;
    try { el.dispatchEvent(ev); } catch (e) { report(e); }
  }

  function stepSelect(el, delta) {
    if (!el || el.disabled === true) return false;
    const steps = Math.trunc(Number(delta));
    if (!Number.isFinite(steps) || steps === 0) return false;
    const opts = optionsOf(el);
    const from = Number.isInteger(el.selectedIndex) ? el.selectedIndex : -1;
    const sign = steps > 0 ? 1 : -1;
    let left = Math.abs(steps);
    let to = from;
    for (let i = from + sign; i >= 0 && i < opts.length && left > 0; i += sign) {
      if (!pickable(opts[i])) continue;
      to = i;
      left--;
    }
    if (to === from) return false;
    el.selectedIndex = to;
    fire(el, "input");
    fire(el, "change");
    return true;
  }

  return { scopeRoots, focusables, move, activate, focusFirst, stepSelect };
}
