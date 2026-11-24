/*
 * overlay-stack.js — the one overlay stack (pure: no DOM, no history, no timers of its own).
 *
 * Every layer that sits above the stage (control bar, adjust toast, the right-hand panels,
 * the song sheet, dialogs) is opened and closed through here, so Back, the navigation scope
 * and the DOM adapter all agree on what is showing. The adapter listens to `onChange` and
 * turns each change into `hidden` / `inert` / history work; this module only keeps the state.
 *
 * Rules kept here:
 *  - Groups: opening a `panel` closes any other open `panel` in the SAME change (a panel swap).
 *    A `sheet` stacks above a panel; a `dialog` stacks above everything.
 *  - Order: open ids are kept bottom → top by `z`, ties by the order they were opened.
 *  - Back closes the top MODAL overlay only; non-modal ones (bar, toast) are never its target.
 *  - Auto-hide: each id has a period (ms, 0 = off). Opening or `touch()` starts a deadline;
 *    the caller drives `tick()` from its own timer, so tests can run on a fake clock.
 */

const def = (kind, modal, group, z, autoHideMs = 0) => Object.freeze({ kind, modal, group, z, autoHideMs });

/** id → { kind, modal, group, z, autoHideMs }. `controls`' period is set at runtime. */
export const OVERLAY_DEFS = Object.freeze({
  controls:  def("bar",    false, null,     20),
  adjust:    def("toast",  false, null,     25, 2500),
  search:    def("panel",  true,  "panel",  40),
  queue:     def("panel",  true,  "panel",  40),
  mixer:     def("panel",  true,  "panel",  40),
  settings:  def("panel",  true,  "panel",  40),
  song:      def("sheet",  true,  "sheet",  50),
  calibrate: def("dialog", true,  "dialog", 60),
  confirm:   def("dialog", true,  "dialog", 70),
});

const has = (obj, key) => obj != null && Object.prototype.hasOwnProperty.call(obj, key);

/**
 * @param {object}   [o]
 * @param {object}   [o.defs]      id → definition (defaults to OVERLAY_DEFS)
 * @param {Function} [o.onChange]  ({ opened, closed, top, reason }) after every real change
 * @param {Function} [o.now]       clock in ms (injected for tests)
 */
export function createOverlayStack({ defs = OVERLAY_DEFS, onChange = () => {}, now = () => Date.now() } = {}) {
  const open = new Map();      // id → { seq, opener, data, deadline }  (deadline 0 = no timer)
  const periods = new Map();   // id → ms; survives close so a runtime period applies to the next open
  let seq = 0;

  const known = (id) => typeof id === "string" && has(defs, id);
  const period = (id) => (periods.has(id) ? periods.get(id) : Number(defs[id].autoHideMs) || 0);
  const deadlineFor = (id, t) => {
    const ms = period(id);
    return ms > 0 ? t + ms : 0;
  };

  const list = () => [...open.keys()].sort((a, b) =>
    (defs[a].z - defs[b].z) || (open.get(a).seq - open.get(b).seq));

  const top = () => {
    const ids = list();
    for (let i = ids.length - 1; i >= 0; i--) if (defs[ids[i]].modal) return ids[i];
    return null;
  };

  const emit = (opened, closed, reason) => {
    if (!opened.length && !closed.length) return;
    onChange({ opened, closed, top: top(), reason });
  };

  // Close without emitting; the caller batches into one change.
  const drop = (id) => open.delete(id);

  // Add without emitting. Applies the group rule; returns the ids it closed.
  const add = (id, opts) => {
    const { opener = null, data = null } = opts || {};
    const closed = [];
    if (defs[id].group === "panel") {
      for (const other of list()) {
        if (other !== id && defs[other].group === "panel") { drop(other); closed.push(other); }
      }
    }
    open.set(id, { seq: ++seq, opener, data, deadline: deadlineFor(id, now()) });
    return closed;
  };

  const reasonOf = (opts, fallback) =>
    (opts && typeof opts.reason === "string" && opts.reason) || fallback;

  const api = {
    /** Open `id`. False for an unknown id or one already open. A panel replaces another panel. */
    open(id, opts = {}) {
      if (!known(id) || open.has(id)) return false;
      const closed = add(id, opts);
      emit([id], closed, reasonOf(opts, closed.length ? "swap" : "open"));
      return true;
    },

    /** Close `id`. False if unknown or not open. */
    close(id, reason = "api") {
      if (!known(id) || !open.has(id)) return false;
      drop(id);
      emit([], [id], reason);
      return true;
    },

    /** Open if closed, close if open. Returns the new open state. */
    toggle(id, opts = {}) {
      if (!known(id)) return false;
      if (open.has(id)) { api.close(id, reasonOf(opts, "toggle")); return false; }
      return api.open(id, opts);
    },

    /** Close the top MODAL overlay; returns its id, or null when no modal is open. */
    back() {
      const id = top();
      if (id === null) return null;
      drop(id);
      emit([], [id], "back");
      return id;
    },

    /**
     * Close `fromId` and open `toId` in ONE change (reason "swap"). False, and nothing changes,
     * when either id is unknown, they are the same, `fromId` is not open or `toId` already is.
     */
    swap(fromId, toId, opts = {}) {
      if (!known(fromId) || !known(toId) || fromId === toId) return false;
      if (!open.has(fromId) || open.has(toId)) return false;
      drop(fromId);
      const closed = [fromId, ...add(toId, opts)];
      emit([toId], closed, reasonOf(opts, "swap"));
      return true;
    },

    /** Close everything in one change; returns the closed ids, top first. */
    closeAll(reason = "api") {
      const closed = list().reverse();
      for (const id of closed) drop(id);
      emit([], closed, reason);
      return closed;
    },

    isOpen: (id) => known(id) && open.has(id),
    top,
    list,
    modalOpen: () => top() !== null,
    opener: (id) => (known(id) && open.has(id) ? open.get(id).opener : null),
    data: (id) => (known(id) && open.has(id) ? open.get(id).data : null),

    /** Set `id`'s auto-hide period (0 disables). Restarts its timer when it is open. */
    setAutoHide(id, ms) {
      if (!known(id)) return;
      const n = Number(ms);
      periods.set(id, Number.isFinite(n) && n > 0 ? n : 0);
      if (open.has(id)) open.get(id).deadline = deadlineFor(id, now());
    },

    /** Input inside `id`: restart its timer (no-op when closed or without a period). */
    touch(id) {
      if (!known(id) || !open.has(id)) return;
      open.get(id).deadline = deadlineFor(id, now());
    },

    /** Close every overlay whose deadline has passed, in one change; returns their ids. */
    tick(nowMs = now()) {
      const closed = list().reverse().filter((id) => {
        const d = open.get(id).deadline;
        return d > 0 && nowMs >= d;
      });
      for (const id of closed) drop(id);
      emit([], closed, "timeout");
      return closed;
    },
  };
  return api;
}
