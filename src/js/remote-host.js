/*
 * remote-host.js — host-side driver for the phone remote (see src/remote.html).
 *
 * The host browser is the AUTHORITATIVE player; this module is its single sync
 * loop with serve.py's in-memory relay. Every ~1s (and on demand via push()) it
 * POSTs the current snapshot to /api/remote/host and applies any guest COMMANDS
 * the server returns. Commands are deduped/acked by monotonic `seq` (the server
 * re-delivers un-acked commands, so applying is idempotent by seq). In-memory +
 * ephemeral; no auth (free-for-all, self-hosted trust model). DI factory, mirroring
 * the createLibraryUI / createSettingsUI pattern — app.js owns the actual behavior.
 *
 *   createRemoteHost({ getSnapshot, applyCommand })
 *     getSnapshot()      → { now, queue, settings }   (app.js builds it)
 *     applyCommand(cmd)  → apply one guest intent      (app.js dispatches it)
 *   → { start, stop, push, running }
 */
/**
 * Choose the base URL the QR should encode (pure — unit-tested).
 *   1. an explicit user override (settings) wins;
 *   2. else the host page's own origin, when it's already phone-reachable (not loopback) —
 *      this covers a host opened via its LAN IP or a public/cloudflared origin automatically;
 *   3. else the server-detected LAN URL (the http://127.0.0.1 dev case).
 * Returns "" if nothing usable is available. The caller appends "/remote".
 */
export function pickRemoteBaseUrl(override, pageOrigin, lanUrl) {
  const strip = (u) => String(u || "").trim().replace(/\/+$/, "");
  const ov = strip(override);
  if (ov) return ov;
  const origin = strip(pageOrigin);
  if (origin && !isLoopbackOrigin(origin)) return origin;
  return strip(lanUrl);
}

function isLoopbackOrigin(origin) {
  let host;
  try { host = new URL(origin).hostname; } catch (_) { return false; }
  return host === "localhost" || host === "::1" || host === "[::1]" || /^127\./.test(host);
}

export function createRemoteHost({
  getSnapshot,
  applyCommand,
  interval = 1000,
  hostUrl = "/api/remote/host",
} = {}) {
  let timer = null;
  let running = false;
  let syncing = false;   // never overlap requests (a slow POST must not stack)
  let lastApplied = 0;   // highest command seq applied → sent as ackSeq so the server drops it

  async function sync() {
    if (syncing) return;
    syncing = true;
    try {
      const snap = getSnapshot();
      const res = await fetch(hostUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...snap, ackSeq: lastApplied }),
      });
      const data = await res.json();
      for (const cmd of (data && data.commands) || []) {
        if (!cmd || cmd.seq <= lastApplied) continue;   // already applied (re-delivery)
        try { applyCommand(cmd); }
        catch (e) { console.error("remote command failed:", cmd, e); }
        lastApplied = Math.max(lastApplied, cmd.seq);
      }
    } catch (_) {
      // Server down / offline — swallow and retry on the next tick.
    } finally {
      syncing = false;
    }
  }

  function start() {
    if (running) return;
    running = true;
    sync();                          // push immediately so the phone sees state fast
    timer = setInterval(sync, interval);
  }
  function stop() {
    running = false;
    clearInterval(timer);
    timer = null;
  }
  /** Force an immediate sync (call after a queue / now-playing change for snappiness). */
  function push() { if (running) sync(); }

  return { start, stop, push, get running() { return running; } };
}
