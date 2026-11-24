/*
 * actions.js — the named app actions the key router (and media keys) dispatch to (M4).
 *
 * Contract written by the orchestrator, body by M4 lane A. The export and its signature are the
 * contract lane I codes against — do not change them.
 *
 * A handler returns `false` to say "not handled" (the router then lets the key through, so it is
 * never swallowed); any other return value (including undefined) means handled.
 *
 * The table is a Map, so a lookup only ever finds what was registered: an inherited name
 * ("toString", "hasOwnProperty") is never a handler, and "__proto__" / "constructor" are refused
 * outright, so not even an explicit registration can make one of them a handler.
 */

/** Names that are never handlers, however they are registered. */
const RESERVED = new Set(["__proto__", "constructor"]);

const report = (...args) => { try { console.error(...args); } catch { /* no console */ } };

/**
 * @param {Object<string, (arg?: any) => (boolean|void)>} [handlers]
 * @returns {{
 *   run(action: string, arg?: any): boolean,   // false when no handler, or the handler returned false
 *   set(action: string, fn: ((arg?: any) => (boolean|void)) | null): void,   // null removes
 *   has(action: string): boolean,
 * }}
 *   A handler that throws is reported with console.error and counts as handled (true), so one
 *   broken action can never leave a key half-applied AND passed through to the browser.
 *   Lookups use own properties only ("__proto__", "constructor" are never handlers).
 *   Details:
 *   - only `handlers`' own enumerable keys are read; a null / undefined value registers nothing;
 *   - set(action, fn): null / undefined removes; a value that is not a function throws a
 *     TypeError (a wiring mistake should fail at boot, not on the night); a reserved name is a no-op;
 *   - run passes exactly one argument (`arg`). A handler that returns a promise counts as handled
 *     at once; a rejection is reported like a throw (it is never unhandled).
 */
export function createActions(handlers = {}) {
  const table = new Map();

  function put(action, fn) {
    if (typeof action !== "string" || RESERVED.has(action)) return;
    if (fn == null) { table.delete(action); return; }
    if (typeof fn !== "function") throw new TypeError(`actions: the handler for "${action}" is not a function`);
    table.set(action, fn);
  }

  if (handlers != null && typeof handlers === "object") {
    for (const key of Object.keys(handlers)) put(key, handlers[key]);
  }

  return {
    run(action, arg) {
      if (typeof action !== "string") return false;
      const fn = table.get(action);
      if (!fn) return false;
      let result;
      try {
        result = fn(arg);
      } catch (e) {
        report(`actions: "${action}" threw`, e);
        return true;
      }
      if (result === false) return false;
      if (result && typeof result.then === "function") {
        try { result.then(undefined, (e) => report(`actions: "${action}" rejected`, e)); } catch { /* not a real thenable */ }
      }
      return true;
    },
    set(action, fn) { put(action, fn); },
    has(action) { return typeof action === "string" && table.has(action); },
  };
}
