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
 * The settings a guest may change, WITH the range each value must fall in.
 *
 * The allowlist used to gate the *path* only, so the value arrived untrusted: the phone UI
 * clamps client-side (stepKey −12..12, stepTempo 0.5..1.5), but nothing stops a curl/script
 * on the LAN from POSTing `{"path":"audio.volume","value":1e6}` straight into the host's
 * GainNode — or an absurd semitone count into the pitch-shift worklet. The host is the
 * authority for a room full of people, so it re-validates every value here.
 *
 * Keep these ranges in step with the ⚙ controls in index.html (and remote.html's steppers).
 *
 * NOTE the null prototype: with a normal object literal, a lookup of the attacker-supplied
 * path "__proto__" returns Object.prototype — truthy — and the value would sail past the
 * "unknown path" check into the numeric branch (returning NaN). A prototype-less table has
 * no such inherited key. Caught by a unit test, not by inspection.
 */
export const REMOTE_SETTING_RANGES = Object.assign(Object.create(null), {
  "lyrics.offsetMs":  { type: "int",  min: -2000, max: 2000 },
  "audio.key":        { type: "int",  min: -12,   max: 12 },
  "audio.tempo":      { type: "num",  min: 0.5,   max: 1.5 },
  "audio.volume":     { type: "num",  min: 0,     max: 2 },
  "guide.vocal.mute": { type: "bool" },
});

/** The allowlisted paths — the mirrored-to-phones subset AND what a guest may write. */
export const REMOTE_SETTABLE_PATHS = Object.keys(REMOTE_SETTING_RANGES);

/**
 * Validate + clamp one guest `setting` value (pure — unit-tested).
 * Returns the value to store, or `undefined` when the command must be IGNORED
 * (unknown path, wrong type, NaN/Infinity). `undefined` is the only rejection
 * sentinel because `0`, `false` and `-12` are all legitimate values.
 */
export function clampRemoteSetting(path, value) {
  const r = REMOTE_SETTING_RANGES[path];
  if (!r) return undefined;
  if (r.type === "bool") return typeof value === "boolean" ? value : undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  const v = Math.max(r.min, Math.min(r.max, value));
  return r.type === "int" ? Math.round(v) : v;
}

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
