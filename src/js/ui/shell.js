/*
 * shell.js — the stage shell (M3, §4.2 rule 8 of the plan).
 *
 * THE CONTROL BAR HAS ONE OWNER, and it is this module:
 *   - it registers "controls" itself (#ov-controls, visibility "class": overlays-dom only toggles
 *     `.open` on it and never sets `hidden`);
 *   - it maps stack.isOpen("controls") → body.classList.toggle("controls-hidden", !open);
 *   - the bar is open at boot, and never hides while paused, idle or while a modal overlay is
 *     open (its auto-hide period is 0 then; a modal closing re-arms it);
 *   - stack.tick() runs from the shell's OWN 250 ms timer, so a 2500 ms toast closes within
 *     2500–2750 ms whatever else app.js is doing.
 * Also: the bar's buttons, the activity events that poke the bar, the first-activation history
 * sentinel, and the body[data-idle] / body[data-kind] / #status writes.
 *
 * The cursor hides with the bar in CSS (body.controls-hidden). Because the bar never hides
 * while idle, `controls-hidden` implies data-idle="false".
 */

export const TICK_MS = 250;
const ACTIVITY = ["pointermove", "pointerdown", "keydown", "touchstart"];

/** Auto-hide period for the bar in ms; 0 = never hide. */
export function nextAutoHide({ playing, alwaysShow, seconds } = {}) {
  if (!playing || alwaysShow) return 0;
  return Math.max(1, Number(seconds) || 3) * 1000;
}

/**
 * @param {object} o
 * @param {object} o.overlays  createOverlays() result
 * @param {object} o.stack     the same stack (with subscribe)
 * @param {object} o.settings  Settings (get(path))
 * @param {Document} [o.doc]
 * @param {object} [o.actions] { restart(), fullscreen() }
 * @param {object} [o.timers]  { setInterval, clearInterval } (injected for tests)
 */
export function createShell({ overlays, stack, settings, doc = document, actions = {}, timers = null } = {}) {
  if (!stack || typeof stack.subscribe !== "function") {
    throw new TypeError("createShell: the stack must expose subscribe(fn)");
  }
  const T = timers || {
    setInterval: (fn, ms) => globalThis.setInterval(fn, ms),
    clearInterval: (h) => globalThis.clearInterval(h),
  };
  const byId = (id) => doc.getElementById(id);
  const body = doc.body;

  let idle = !body || body.dataset.idle !== "false";
  let playing = false;
  let modal = stack.top() !== null;
  let wired = false;
  let lastX, lastY;

  const read = (path, fallback) => {
    try { const v = settings && settings.get(path); return v === undefined ? fallback : v; }
    catch { return fallback; }
  };
  const hideMs = () => (idle || stack.top() !== null ? 0 : nextAutoHide({
    playing, alwaysShow: !!read("ui.playback", false), seconds: read("ui.autoHideSec", 3),
  }));
  const mapControls = () => { if (body) body.classList.toggle("controls-hidden", !stack.isOpen("controls")); };

  // Show the bar (no-op if shown) and restart its timer with the current period.
  function poke() {
    stack.open("controls");
    stack.setAutoHide("controls", hideMs());
    stack.touch("controls");
    mapControls();
  }

  overlays.register("controls", { el: byId("ov-controls"), visibility: "class" });

  stack.subscribe((change) => {
    const nowModal = change && change.top != null;
    if (nowModal !== modal) {
      modal = nowModal;
      // A modal suspends the timer; closing it starts a full period again. A hidden bar stays hidden.
      if (stack.isOpen("controls")) stack.setAutoHide("controls", hideMs());
    }
    mapControls();
  });

  function tick() {
    stack.tick();
    mapControls();
  }

  function onActivity(e) {
    if (e && e.type === "pointermove") {
      // A pointer resting over changing content can report moves at the same spot; ignore those.
      if (e.clientX === lastX && e.clientY === lastY) return;
      lastX = e.clientX; lastY = e.clientY;
    }
    if (e && (e.type === "keydown" || e.type === "pointerdown") && overlays.arm) overlays.arm();
    poke();
  }

  poke();   // open at boot

  return {
    /** Bar buttons, activity events, and the 250 ms stack tick. Idempotent. */
    wire() {
      if (wired) return;
      wired = true;
      const bind = (id, fn) => { const el = byId(id); if (el) el.addEventListener("click", () => fn(el)); };
      const panel = (id) => (el) => overlays.toggle(id, { opener: el });
      bind("toggle-lib", panel("search"));
      bind("toggle-queue", panel("queue"));
      bind("queue-count", panel("queue"));
      bind("btn-mixer", panel("mixer"));
      bind("btn-settings", panel("settings"));
      bind("btn-fullscreen", () => { if (actions && actions.fullscreen) actions.fullscreen(); });
      bind("btn-restart", () => { if (actions && actions.restart) actions.restart(); });
      for (const type of ACTIVITY) doc.addEventListener(type, onActivity, { passive: true });
      T.setInterval(tick, TICK_MS);
    },

    setIdle(on) {
      const v = !!on;
      if (body) body.dataset.idle = v ? "true" : "false";
      const changed = v !== idle;
      idle = v;
      if (changed || (v && !stack.isOpen("controls"))) poke();
    },

    setKind(kind) {
      if (body) body.dataset.kind = kind ? String(kind) : "";
    },

    setPlaying(on) {
      const v = !!on;
      if (v === playing) return;
      playing = v;
      poke();
    },

    poke,

    /** Re-read ui.playback / ui.autoHideSec (they are read live), then poke. */
    applyAutoHide() { poke(); },

    setStatus(text) {
      const el = byId("status");
      if (el) el.textContent = text == null ? "" : String(text);
    },
  };
}
