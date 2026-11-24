/*
 * shell.js — the stage shell (M3, §4.2 rule 8 of the plan).
 *
 * Since 2026-11-24 (Rae) there is no control bar: the playback dock is gone and the stage footer
 * (#stage-foot: the panel buttons, the status line, the seek bar) replaces it. What the shell owns:
 *   - the footer's AUTO-HIDE (Rae, same day): while a song PLAYS, with ui.footer.autoHide on, it
 *     hides after ui.footer.hideSec idle seconds (body.foot-hidden — the cursor hides with it); a
 *     tap, a mouse move or any key but Back shows it again. Never while idle, paused or under a
 *     modal overlay. Focus inside it when it hides goes to #stage;
 *   - the footer's panel buttons (Songs, Mixer, Settings, Full screen), and the queue bar's count,
 *     which opens the Songs panel on its Queue tab (actions.queue — the queue is a tab since
 *     2026-11-24, Rae; there is no Queue panel or button);
 *   - the activity events that arm the history sentinel on the first key or tap;
 *   - stack.tick() from its OWN 250 ms timer, so a 2500 ms toast closes within 2500–2750 ms
 *     whatever else app.js is doing;
 *   - body[data-idle] / body[data-kind] (and focus off the home layer when it fades — it holds
 *     nothing focusable since the home tiles went, so that guard is a safety net).
 */

export const TICK_MS = 250;
import { keyToAction } from "./keymap.js";

// Activity that shows the footer. keydown and pointerdown also arm the history sentinel.
const ACTIVITY = ["pointermove", "pointerdown", "keydown", "touchstart"];

// A Back key never WAKES the footer: Back is the "go away" key (Escape, Backspace outside a text
// field, BrowserBack, a TV remote's Back).
function isBackKey(e) {
  const t = e.target;
  const typing = !!t && ((/^(INPUT|TEXTAREA)$/.test(t.tagName || "") && !/^(range|checkbox|radio|button|color|file)$/.test(t.type || ""))
    || !!t.isContentEditable);
  const hit = keyToAction(e, { typing });
  return !!hit && hit.action === "back";
}

/** The footer's auto-hide period in ms; 0 = never hide. */
export function footHideMs({ playing, autoHide, seconds, idle = false, modal = false } = {}) {
  if (!playing || idle || modal || autoHide === false) return 0;
  return Math.max(1, Number(seconds) || 3) * 1000;
}

/**
 * @param {object} o
 * @param {object} o.overlays  createOverlays() result
 * @param {object} o.stack     the same stack (with subscribe)
 * @param {object} [o.settings]  Settings (get(path)) — ui.footer.autoHide / ui.footer.hideSec, read live
 * @param {Document} [o.doc]
 * @param {object} [o.actions] { fullscreen(), queue(opener) }
 * @param {object} [o.timers]  { setInterval, clearInterval, setTimeout, clearTimeout } (injected for tests)
 */
export function createShell({ overlays, stack, settings = null, doc = document, actions = {}, timers = null } = {}) {
  if (!stack || typeof stack.subscribe !== "function") {
    throw new TypeError("createShell: the stack must expose subscribe(fn)");
  }
  const T = {
    setInterval: (fn, ms) => globalThis.setInterval(fn, ms),
    clearInterval: (h) => globalThis.clearInterval(h),
    setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
    clearTimeout: (h) => globalThis.clearTimeout(h),
    ...(timers || {}),
  };
  const byId = (id) => doc.getElementById(id);
  const body = doc.body;

  let idle = !body || body.dataset.idle !== "false";
  let wired = false;
  let playing = false;
  let hidden = false;
  let hideTimer = null;
  let lastX, lastY;
  const read = (path, fallback) => {
    try { const v = settings && settings.get(path); return v === undefined ? fallback : v; }
    catch { return fallback; }
  };

  // Is focus inside `root`? And the place focus goes when that root stops showing: #stage
  // (tabindex -1, drawn without a ring), never <body>.
  const inside = (root) => {
    const a = doc.activeElement;
    return !!(root && a && a !== root && typeof root.contains === "function" && root.contains(a));
  };
  const focusStage = () => {
    const stage = byId("stage");
    if (stage && typeof stage.focus === "function") {
      try { stage.focus({ preventScroll: true }); } catch { /* detached */ }
    }
  };
  // The idle layer fades out once a song is coming; nothing in it may keep focus under it. Runs
  // after overlays-dom has restored focus (it subscribed first).
  const evictHome = () => { if (!idle && inside(byId("home"))) focusStage(); };

  // The footer's auto-hide. show() is idempotent and always restarts the countdown with the
  // current period (0 = stay shown).
  const apply = () => { if (body) body.classList.toggle("foot-hidden", hidden); };
  function rearm() {
    if (hideTimer !== null) { T.clearTimeout(hideTimer); hideTimer = null; }
    const ms = footHideMs({
      playing, idle, modal: stack.top() !== null,
      autoHide: read("ui.footer.autoHide", true), seconds: read("ui.footer.hideSec", 3),
    });
    if (ms > 0) hideTimer = T.setTimeout(hide, ms);
  }
  function show() {
    if (hidden) { hidden = false; apply(); }
    rearm();
  }
  function hide() {
    hideTimer = null;
    if (footHideMs({ playing, idle, modal: stack.top() !== null, autoHide: read("ui.footer.autoHide", true), seconds: 1 }) === 0) return;
    hidden = true;
    apply();
    if (inside(byId("stage-foot"))) focusStage();   // nothing keeps focus on what is not shown
  }

  // A modal opening shows the footer and stops the countdown; closing it starts a full period. Only
  // a change of modal state counts: a toast closing by itself must not bring the footer back.
  let modalWas = stack.top() !== null;
  stack.subscribe((change) => {
    evictHome();
    const m = !!(change && change.top != null);
    if (m !== modalWas) { modalWas = m; show(); }
  });

  function onActivity(e) {
    if (e && (e.type === "keydown" || e.type === "pointerdown") && overlays.arm) overlays.arm();
    if (e && e.type === "pointermove") {
      // A pointer resting over changing content can report moves at the same spot; ignore those.
      if (e.clientX === lastX && e.clientY === lastY) return;
      lastX = e.clientX; lastY = e.clientY;
    }
    if (e && e.type === "keydown" && isBackKey(e)) return;   // Back never wakes the footer
    show();
  }

  return {
    /** The panel buttons, the activity events, and the 250 ms stack tick. Idempotent. */
    wire() {
      if (wired) return;
      wired = true;
      const bind = (id, fn) => { const el = byId(id); if (el) el.addEventListener("click", () => fn(el)); };
      const panel = (id) => (el) => overlays.toggle(id, { opener: el });
      bind("toggle-lib", panel("search"));
      bind("queue-count", (el) => { if (actions && actions.queue) actions.queue(el); });
      bind("btn-mixer", panel("mixer"));
      bind("btn-settings", panel("settings"));
      bind("btn-fullscreen", () => { if (actions && actions.fullscreen) actions.fullscreen(); });
      for (const type of ACTIVITY) doc.addEventListener(type, onActivity, { passive: true });
      T.setInterval(() => stack.tick(), TICK_MS);
    },

    setIdle(on) {
      const v = !!on;
      if (body) body.dataset.idle = v ? "true" : "false";
      idle = v;
      evictHome();
      show();
    },

    /** Playing vs paused: the footer only auto-hides while a song plays; pausing shows it. */
    setPlaying(on) {
      const v = !!on;
      if (v === playing) return;
      playing = v;
      show();
    },

    /** Show the footer now (and restart its countdown). */
    show,

    /** Is the footer hidden (body.foot-hidden)? */
    get hidden() { return hidden; },

    /** Re-read ui.footer.autoHide / hideSec (they are read live), then restart the countdown. */
    applyAutoHide() { show(); },

    setKind(kind) {
      if (body) body.dataset.kind = kind ? String(kind) : "";
    },
  };
}
