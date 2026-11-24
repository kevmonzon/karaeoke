/*
 * kiosk.js — the Exit button of a kiosk host (Rae, 2026-11-25: "the browser that will open should
 * be closable without alt-f4 or ctrl-c (i only have a controller in steam deck)").
 *
 * tools/serve-lan.sh's kiosk mode (automatic on SteamOS) starts `serve.py --kiosk` and opens this
 * page fullscreen at http://localhost:<port>/. A kiosk browser has no close button, so the footer
 * gets one: #btn-quit, a panel button like the others, so the D-pad and a tap both reach it. It
 * asks first (Cancel is focused), then POST /api/quit stops the server; the launcher sees the
 * server exit and closes the browser. If that fails, #quit-screen says the app has stopped.
 *
 * The button shows only when BOTH hold: this page is on a loopback host, and GET /api/kiosk says
 * {canQuit: true} (the server runs with --kiosk AND the request came from this machine). A
 * guest's phone or a TV box on the LAN never sees it, and the server refuses their POST anyway.
 */

/** Hostnames that mean "this machine" — the only pages that may ever show the Exit button. */
export function isLoopbackHost(hostname) {
  const h = String(hostname || "").toLowerCase().replace(/^\[|\]$/g, "");
  return h === "localhost" || h === "::1" || /^127(\.\d{1,3}){3}$/.test(h);
}

const defaultFetch = (...a) => globalThis.fetch(...a);

/** Should this page show the Exit button? Never throws; any doubt is false. */
export async function canQuit({ fetchFn = defaultFetch, hostname = globalThis.location?.hostname } = {}) {
  if (!isLoopbackHost(hostname)) return false;
  try {
    const r = await fetchFn("/api/kiosk", { cache: "no-store" });
    if (!r || !r.ok) return false;
    const j = await r.json();
    return !!(j && j.ok === true && j.canQuit === true);
  } catch {
    return false;
  }
}

/** POST /api/quit. Resolves when the server has agreed to stop; rejects with its reason. */
export async function requestQuit({ fetchFn = defaultFetch } = {}) {
  const r = await fetchFn("/api/quit", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
  let j = null;
  try { j = await r.json(); } catch { /* not JSON: the status says enough */ }
  if (!r.ok || !j || j.ok !== true) throw new Error((j && j.error) || `HTTP ${r.status}`);
  return true;
}

export const QUIT_CONFIRM = Object.freeze({
  title: "Exit Ka-Rae-oke?",
  text: "The music stops, the browser closes and guests' phones disconnect.",
  okLabel: "Exit",
});

/**
 * Show and wire the Exit button when this page may quit. Resolves true when it was shown.
 * @param {object} o
 * @param {object} o.button                 #btn-quit (stays hidden unless canQuit)
 * @param {(opts:object, openOpts:object) => Promise<boolean>} o.confirm  overlays.confirm
 * @param {() => void} [o.onStopped]        the server is stopping: stop playback, show #quit-screen
 * @param {(msg:string) => void} [o.onError]
 * @param {() => void} [o.closeWindow]      best effort; the launcher closes the browser anyway
 * @param {Function} [o.fetchFn]
 * @param {string} [o.hostname]
 */
export async function setupKioskQuit({ button, confirm, onStopped, onError, closeWindow, fetchFn, hostname } = {}) {
  if (!button || typeof confirm !== "function") return false;
  if (!(await canQuit({ fetchFn, hostname }))) return false;
  button.hidden = false;
  let busy = false;
  button.addEventListener("click", async () => {
    if (busy) return;          // a second press while the dialog or the POST is still out
    busy = true;
    try {
      if (!(await confirm({ ...QUIT_CONFIRM }, { opener: button }))) return;
      await requestQuit({ fetchFn });
      if (onStopped) onStopped();
      if (closeWindow) closeWindow();
    } catch (e) {
      if (onError) onError(`Couldn't exit: ${(e && e.message) || e}`);
    } finally {
      busy = false;
    }
  });
  return true;
}
