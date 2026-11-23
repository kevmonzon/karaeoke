/*
 * overlays-dom.js — the overlay stack's DOM adapter and its history sync (M3, §4.2 of the plan).
 *
 * overlay-stack.js keeps the state; this module turns each stack change into what the page shows:
 *   - visibility: the `hidden` attribute + `.open` class (or only `.open` for a "class" overlay,
 *     which is how the control bar stays rendered — its one owner is shell.js);
 *   - `inert` on #stage and on every overlay below the top modal (aria-hidden + a focusin
 *     redirect where the browser has no `inert`); #status sits outside #stage and is never touched;
 *   - #scrim, body[data-ov] (top modal id) and body[data-panel] ("right" while a panel is open);
 *   - focus: into a modal when the user opened it, back to the opener when it closes, else #stage;
 *   - history: one entry per user-opened modal, a sentinel so Back never leaves the app after the
 *     first input, replaceState for a panel swap, and `expectPops` for closes we caused ourselves.
 *
 * It observes the stack through `stack.subscribe(fn)` (app.js adds that to the M1 stack), so
 * changes made elsewhere — the shell's 250 ms tick closing a toast, a direct stack.open — land too.
 */

import { OVERLAY_DEFS } from "./overlay-stack.js";

const SENTINEL = Object.freeze({ kv: "sentinel" });
const entryState = (id) => ({ kv: "overlay", id });
const isOurs = (st) => !!st && typeof st === "object" && (st.kv === "sentinel" || st.kv === "overlay");

const NO_HISTORY = Object.freeze({ state: null, pushState() {}, replaceState() {}, back() {}, go() {} });

/**
 * History bookkeeping for modal overlays. Pure given a history-like object
 * ({ pushState, replaceState, back, go?, state }).
 *
 * @param {object}   o
 * @param {object}   o.history   window.history or a fake
 * @param {Function} [o.onPop]   closes the top overlay (called from handlePop)
 * @param {Function} [o.schedule] (fn) => void. When given, the `back()`s that closes owe are run
 *   later, in one go: two closes in one turn become one `go(-2)`, and an open that follows a
 *   close in the same turn reuses the closed entry with replaceState instead of racing a pending
 *   back() against pushState. Omitted → each close calls back() at once.
 */
export function createHistorySync({ history, onPop = () => {}, schedule = null } = {}) {
  const h = history || NO_HISTORY;
  const entries = [];      // ids that own a history entry, bottom → top
  let armed = false;
  let expectPops = 0;
  let pendingBacks = 0;
  let flushQueued = false;

  const state = () => { try { return h.state; } catch { return null; } };

  // A reload keeps our entries. Standing on one means the sentinel already exists.
  const st0 = state();
  if (isOurs(st0)) {
    armed = true;
    if (st0.kv !== "sentinel") h.replaceState(SENTINEL, "");
  }

  function flush() {
    flushQueued = false;
    const n = pendingBacks;
    pendingBacks = 0;
    if (n <= 0) return;
    if (n > 1 && typeof h.go === "function") { expectPops++; h.go(-n); return; }
    for (let i = 0; i < n; i++) { expectPops++; h.back(); }
  }

  const api = {
    /** Push the ONE sentinel entry. Returns false when it already exists. */
    arm() {
      if (armed) return false;
      armed = true;
      h.pushState(SENTINEL, "");
      return true;
    },

    /**
     * A modal opened. → "push" | "replace" | "none".
     * activated=false (a relay command): no entry. swap=true: take over the entry of `replaces`
     * (default: the top entry) with replaceState; with no entry to take over it behaves like a
     * plain open.
     */
    opened(id, { activated = true, swap = false, replaces = null } = {}) {
      if (swap) {
        const i = replaces != null ? entries.lastIndexOf(replaces) : entries.length - 1;
        if (i >= 0) {
          entries[i] = id;
          if (i === entries.length - 1) h.replaceState(entryState(id), "");
          return "replace";
        }
      }
      if (!activated) return "none";
      if (pendingBacks > 0) {          // a close earlier in this turn still owes a back(): reuse it
        pendingBacks--;
        entries.push(id);
        h.replaceState(entryState(id), "");
        return "replace";
      }
      if (!armed) api.arm();          // keep the sentinel beneath the first entry
      entries.push(id);
      h.pushState(entryState(id), "");
      return "push";
    },

    /**
     * A modal closed. → "none" (it had no entry) | "popped" (the browser already consumed it) |
     * "back" (we consume it: expectPops++ and history.back(), possibly deferred by `schedule`).
     */
    closed(id, { byPop = false } = {}) {
      const i = entries.lastIndexOf(id);
      if (i < 0) return "none";
      entries.splice(i, 1);
      if (byPop) return "popped";
      pendingBacks++;
      if (!schedule) flush();
      else if (!flushQueued) { flushQueued = true; schedule(flush); }
      return "back";
    },

    /** The popstate handler. → "ignored" | "close" | "sentinel". */
    handlePop() {
      if (expectPops > 0) { expectPops--; return "ignored"; }
      if (entries.length) {
        const before = entries.length;
        onPop();
        if (entries.length === before) entries.pop();   // the browser consumed one entry regardless
        return "close";
      }
      if (!armed) return "ignored";
      const st = state();
      if (!st || st.kv !== "sentinel") {
        if (isOurs(st)) h.replaceState(SENTINEL, "");   // landed on a stale entry of ours (Forward)
        else h.pushState(SENTINEL, "");
      }
      onPop();   // an overlay opened without an entry (a relay command) still closes on Back
      return "sentinel";
    },

    get armed() { return armed; },
    get expectPops() { return expectPops; },
    get depth() { return entries.length; },
  };
  return api;
}

const FOCUSABLE = [
  "button:not([disabled])", "a[href]", "input:not([disabled]):not([type=\"hidden\"])",
  "select:not([disabled])", "textarea:not([disabled])", "summary",
  "[tabindex]:not([tabindex=\"-1\"])",
].join(", ");

const report = (e) => { try { console.error(e); } catch { /* no console */ } };

/**
 * @param {object}   o
 * @param {object}   o.stack     createOverlayStack() result that also has subscribe(fn) → unsubscribe
 * @param {Document} [o.doc]
 * @param {Window}   [o.win]     history, popstate, setTimeout, getComputedStyle, HTMLElement
 * @param {Function} [o.onChange] ({ opened, closed, top, reason }) after the DOM is updated
 * @param {object}   [o.defs]     the stack's definitions (default OVERLAY_DEFS)
 * @param {Function|null} [o.schedule] how deferred history.back()s run; default win.setTimeout(fn, 0)
 */
export function createOverlays({
  stack, doc = document, win = window, onChange = () => {}, defs = OVERLAY_DEFS, schedule,
} = {}) {
  if (!stack || typeof stack.subscribe !== "function") {
    throw new TypeError("createOverlays: the stack must expose subscribe(fn)");
  }
  const regs = new Map();       // id → { el, visibility, initialFocus, onOpen, onClose }
  const meta = new Map();       // open id → { opener, activated }
  const pending = new Map();    // id → { opener, activated }, set by open() around stack.open()
  const hideTimers = new Map(); // el → timer handle (exit motion before `hidden`)
  const inerted = new Set();    // elements this module made inert
  const ariaHidden = new Set(); // elements this module gave aria-hidden (fallback)
  const nativeInert = !!(win && win.HTMLElement && win.HTMLElement.prototype
    && "inert" in win.HTMLElement.prototype);
  let confirmState = null;      // { resolve, result }
  let confirmWired = false;
  let wired = false;
  let redirecting = false;

  const byId = (id) => doc.getElementById(id);
  const defOf = (id) => (defs && Object.prototype.hasOwnProperty.call(defs, id) ? defs[id] : null);
  const isModal = (id) => !!defOf(id)?.modal;
  const isPanel = (id) => defOf(id)?.group === "panel";
  const parentOf = (n) => n.parentElement || n.parentNode || null;

  const deferred = schedule !== undefined ? schedule
    : (win && typeof win.setTimeout === "function" ? (fn) => win.setTimeout(fn, 0) : null);
  const hist = createHistorySync({
    history: win && win.history,
    onPop: () => { const t = stack.top(); if (t) stack.close(t, "pop"); },
    schedule: deferred,
  });

  // --- visibility ------------------------------------------------------------------------
  function exitMs(el) {
    if (!win || typeof win.getComputedStyle !== "function") return 0;
    try {
      const cs = win.getComputedStyle(el);
      const ms = (s) => String(s || "0s").split(",").map((v) => {
        const n = parseFloat(v);
        return Number.isFinite(n) ? (/ms\s*$/.test(v) ? n : n * 1000) : 0;
      });
      const d = ms(cs.transitionDuration), l = ms(cs.transitionDelay);
      let max = 0;
      d.forEach((x, i) => { max = Math.max(max, x + (l[i % l.length] || 0)); });
      return Math.min(max, 2000);
    } catch { return 0; }
  }

  function setShown(el, on, visibility, instant = false) {
    if (!el) return;
    const t = hideTimers.get(el);
    if (t !== undefined) { if (typeof win.clearTimeout === "function") win.clearTimeout(t); hideTimers.delete(el); }
    if (on) {
      if (visibility !== "class" && el.hidden) {
        el.hidden = false;
        void el.offsetWidth;          // style the shown state once so the .open transition runs
      }
      el.classList.add("open");
      return;
    }
    el.classList.remove("open");
    if (visibility === "class" || el.hidden) return;
    const ms = instant ? 0 : exitMs(el);
    if (ms > 0 && typeof win.setTimeout === "function") {
      hideTimers.set(el, win.setTimeout(() => { hideTimers.delete(el); el.hidden = true; }, ms));
    } else {
      el.hidden = true;
    }
  }

  // --- inert -----------------------------------------------------------------------------
  function setInert(el, on) {
    if (on) {
      if (!el.hasAttribute("inert")) { el.setAttribute("inert", ""); inerted.add(el); }
      if (!nativeInert && el.getAttribute("aria-hidden") !== "true") {
        el.setAttribute("aria-hidden", "true");
        ariaHidden.add(el);
      }
      return;
    }
    if (inerted.has(el)) { el.removeAttribute("inert"); inerted.delete(el); }
    if (ariaHidden.has(el)) { el.removeAttribute("aria-hidden"); ariaHidden.delete(el); }
  }

  function refreshLayers() {
    const top = stack.top();
    const open = stack.list();
    const topAt = top ? open.indexOf(top) : -1;
    const want = new Set();
    if (top) {
      const stage = byId("stage");
      if (stage) want.add(stage);
      for (const [id, r] of regs) {
        if (id === top || !r.el) continue;
        const at = open.indexOf(id);
        if (at > topAt) continue;                       // open above the top modal
        if (defOf(id)?.kind === "toast") continue;      // a status read-out stays announced
        if (at >= 0 || r.visibility === "class") want.add(r.el);
      }
      const status = byId("status");
      if (status) want.delete(status);                  // never inert (R23)
    }
    for (const el of [...inerted, ...ariaHidden]) if (!want.has(el)) setInert(el, false);
    for (const el of want) setInert(el, true);

    const scrim = byId("scrim");
    if (scrim) setShown(scrim, !!top, "hidden");
    const body = doc.body;
    if (body) {
      body.dataset.ov = top || "";
      body.dataset.panel = open.some(isPanel) ? "right" : "";
    }
  }

  // --- focus -----------------------------------------------------------------------------
  function under(el, test) {
    for (let n = el; n; n = parentOf(n)) if (n.nodeType !== 9 && test(n)) return true;
    return false;
  }
  function usable(el) {
    if (!el || typeof el.focus !== "function") return false;
    if (typeof doc.contains === "function" && !doc.contains(el)) return false;
    if (under(el, (n) => n.hidden === true || (n.hasAttribute && n.hasAttribute("inert")))) return false;
    if (typeof el.checkVisibility === "function" && !el.checkVisibility()) return false;
    return true;
  }
  function tryFocus(el) {
    if (!usable(el)) return false;
    try { el.focus({ preventScroll: true }); } catch { return false; }
    return doc.activeElement === el;
  }
  function firstFocusable(root) {
    if (!root || typeof root.querySelectorAll !== "function") return null;
    for (const c of root.querySelectorAll(FOCUSABLE)) if (usable(c)) return c;
    return null;
  }
  function focusInto(id) {
    const r = regs.get(id);
    if (!r || !r.el) return false;
    let target = null;
    if (r.initialFocus) { try { target = r.initialFocus(); } catch (e) { report(e); } }
    if (tryFocus(target) || tryFocus(firstFocusable(r.el))) return true;
    if (!r.el.hasAttribute("tabindex")) r.el.setAttribute("tabindex", "-1");
    return tryFocus(r.el);
  }
  function focusLost(closedEl) {
    const a = doc.activeElement;
    if (!a || a === doc.body || a === doc.documentElement) return true;
    if (closedEl && typeof closedEl.contains === "function" && closedEl.contains(a)) return true;
    return !usable(a);
  }
  function restoreFocus(id, opener) {
    if (!focusLost(regs.get(id)?.el)) return;
    if (opener && opener !== doc.body && tryFocus(opener)) return;
    const top = stack.top();
    if (top && focusInto(top)) return;
    tryFocus(byId("stage"));
  }

  // --- the one stack listener --------------------------------------------------------------
  function hook(fn) { if (fn) { try { fn(); } catch (e) { report(e); } } }

  function onStackChange(change) {
    const opened = (change && change.opened) || [];
    const closed = (change && change.closed) || [];
    const reason = change && change.reason;
    const openedModal = opened.filter(isModal);
    const closedModal = closed.filter(isModal);

    // A panel-to-panel change (or a stack.swap) is ONE change: the new overlay takes the old
    // one's history entry and its opener.
    let swapFrom = null;
    if (openedModal.length && closedModal.length) {
      if (isPanel(openedModal[0]) && closedModal.some(isPanel)) swapFrom = closedModal.find(isPanel);
      else if (reason === "swap") swapFrom = closedModal[0];
    }

    const closedMeta = new Map();
    for (const id of closed) { closedMeta.set(id, meta.get(id) || { opener: null, activated: false }); meta.delete(id); }
    for (const id of opened) {
      const p = pending.get(id);
      const m = { opener: p ? p.opener : (stack.opener(id) || null), activated: p ? p.activated : false };
      if (swapFrom) {
        const old = closedMeta.get(swapFrom);
        const oldEl = regs.get(swapFrom)?.el;
        if (!m.opener || (oldEl && typeof oldEl.contains === "function" && oldEl.contains(m.opener))) m.opener = old.opener;
      }
      meta.set(id, m);
    }

    for (const id of closed) { const r = regs.get(id); if (r) setShown(r.el, false, r.visibility); }
    for (const id of opened) { const r = regs.get(id); if (r) setShown(r.el, true, r.visibility); }
    refreshLayers();

    for (const id of closed) hook(regs.get(id)?.onClose);
    for (const id of opened) hook(regs.get(id)?.onOpen);

    for (const id of closedModal) {
      if (id !== swapFrom) hist.closed(id, { byPop: reason === "pop" });
    }
    for (const id of openedModal) {
      hist.opened(id, { activated: meta.get(id).activated, swap: !!swapFrom, replaces: swapFrom });
    }

    for (const id of openedModal) if (meta.get(id).activated && id === stack.top()) focusInto(id);
    for (const id of closedModal) restoreFocus(id, closedMeta.get(id).opener);

    if (closed.includes("confirm") && confirmState) {
      const s = confirmState;
      confirmState = null;
      s.resolve(s.result);
    }
    try { onChange(change); } catch (e) { report(e); }
  }

  stack.subscribe(onStackChange);

  // --- confirm ---------------------------------------------------------------------------
  function setText(id, text) { const el = byId(id); if (el) el.textContent = text == null ? "" : String(text); }
  function wireConfirm() {
    if (confirmWired) return;
    confirmWired = true;
    const ok = byId("ov-confirm-ok"), cancel = byId("ov-confirm-cancel");
    if (ok) ok.addEventListener("click", () => { if (confirmState) confirmState.result = true; api.close("confirm", "ok"); });
    if (cancel) cancel.addEventListener("click", () => api.close("confirm", "cancel"));
  }

  function overlayOf(node) {
    for (const [id, r] of regs) if (r.el && typeof r.el.contains === "function" && r.el.contains(node)) return id;
    const host = typeof node.closest === "function" ? node.closest("[data-ov]") : null;
    const id = host && host.getAttribute("data-ov");
    return id && defOf(id) ? id : null;
  }

  const api = {
    register(id, { el = null, visibility = "hidden", initialFocus = null, onOpen = null, onClose = null } = {}) {
      const r = { el, visibility: visibility === "class" ? "class" : "hidden", initialFocus, onOpen, onClose };
      regs.set(id, r);
      if (el) setShown(el, stack.isOpen(id), r.visibility, true);
      refreshLayers();
    },

    /** Open `id`. Re-opening an open overlay restarts its auto-hide timer and returns false. */
    open(id, { opener = doc.activeElement, data = null, activated = true } = {}) {
      if (stack.isOpen(id)) { stack.touch(id); return false; }
      pending.set(id, { opener: opener || null, activated: activated !== false });
      try { return stack.open(id, { opener: opener || null, data }); }
      finally { pending.delete(id); }
    },

    close(id = stack.top(), reason = "api") {
      if (id == null) return false;
      return stack.close(id, reason);
    },

    /** Returns the new open state. `opts` are open()'s options. */
    toggle(id, opts) {
      if (stack.isOpen(id)) { api.close(id, "toggle"); return false; }
      return api.open(id, opts);
    },

    /** Close the top modal overlay; true when something closed. */
    back() { return stack.back() !== null; },

    isOpen: (id) => stack.isOpen(id),
    top: () => stack.top(),
    data: (id) => stack.data(id),

    /** Push the history sentinel (the shell calls this on the first keydown / pointerdown). */
    arm: () => hist.arm(),
    get history() { return hist; },

    /** Drive #ov-confirm. Resolves true on OK, false on Cancel, Back, the scrim or any other close. */
    confirm({ title = "", text = "", okLabel = "OK" } = {}, openOpts) {
      const el = byId("ov-confirm");
      if (!el) return Promise.resolve(false);
      if (!regs.has("confirm")) api.register("confirm", { el, initialFocus: () => byId("ov-confirm-cancel") });
      wireConfirm();
      if (confirmState) { const prev = confirmState; confirmState = null; prev.resolve(false); }
      setText("ov-confirm-title", title);
      setText("ov-confirm-text", text);
      setText("ov-confirm-ok", okLabel || "OK");
      return new Promise((resolve) => {
        confirmState = { resolve, result: false };
        if (!stack.isOpen("confirm")) api.open("confirm", openOpts);
        if (!stack.isOpen("confirm") && confirmState) { confirmState = null; resolve(false); }
      });
    },

    /** Scrim click, [data-ov-close] clicks, popstate, and (without native inert) the focus trap. */
    wire() {
      if (wired) return;
      wired = true;
      const scrim = byId("scrim");
      if (scrim) scrim.addEventListener("click", () => { const t = stack.top(); if (t) api.close(t, "scrim"); });
      doc.addEventListener("click", (e) => {
        const t = e && e.target;
        const btn = t && typeof t.closest === "function" ? t.closest("[data-ov-close]") : null;
        if (!btn) return;
        const id = overlayOf(btn);
        if (id && stack.isOpen(id)) api.close(id, "button");
      });
      if (win && typeof win.addEventListener === "function") win.addEventListener("popstate", () => hist.handlePop());
      if (!nativeInert) {
        doc.addEventListener("focusin", (e) => {
          const top = stack.top();
          if (redirecting || !top) return;
          const r = regs.get(top);
          const t = e && e.target;
          if (!r || !r.el || !t || r.el.contains(t)) return;
          if (!under(t, (n) => n.hasAttribute && n.hasAttribute("inert"))) return;
          redirecting = true;
          try { focusInto(top); } finally { redirecting = false; }
        });
      }
    },
  };

  refreshLayers();
  return api;
}
