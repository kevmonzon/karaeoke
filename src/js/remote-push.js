/*
 * remote-push.js — the relay v2 push client (SSE), shared by the phone (remote.js) and the host
 * (remote-host.js) (M7, plan §5.10).
 *
 * Contract written by the orchestrator; the exports, names and signatures are what lanes B and I
 * code against.
 *
 * The server (tools/serve.py, M1) streams `GET /api/remote/events?room=CODE&role=guest|host&cid=ID`:
 *   guest: named events `state` (the full room view: {ok, rev, ts, now, age, queue, settings, songRev,
 *          notice}), `tick` ({rev, age, position, duration, paused, score}), `gone` ({error:"no-room"});
 *   host:  `command` (one queued guest command: {seq, type, by, …}), `gone`;
 *   both:  `hb` (a NAMED heartbeat — EventSource never surfaces `:` comments — proves the stream lives).
 * The server ends every stream after 300 s (SSE_MAX_AGE); the client must reconnect quietly.
 *
 * How the client judges a stream. One EventSource at a time, one watchdog timer, one retry timer.
 * A source that has delivered nothing yet must deliver within firstEventMs (a proxy that buffers
 * the stream holds it open and silent); a source that has delivered must not go quiet for
 * silenceMs. Every failure closes the source and builds a new one — EventSource's own reconnect is
 * never relied on, so there is never a second source or a second set of timers.
 *
 *   failure                         counts toward fallback?               rebuilt after
 *   error / no first event          yes: 3 in a row with no event between  retryMs
 *   silence (events, then nothing)  yes: 2 in a row                        retryMs
 *   error after events (the 300 s   no — the events had reset the count    at once (retryMs if the
 *   max-age close, a server restart)                                       source gave only one)
 *
 * "2 silences in a row": a silence is always preceded by events, so the silence count is NOT reset
 * by a rebuilt source's FIRST event (every new stream opens with a `state` burst, even through a
 * proxy that then buffers everything after it). It is reset once a source has delivered a SECOND
 * event — proof the stream keeps flowing — or when the client falls back / is restarted.
 */

const CID_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
const PASS_ON = ["state", "tick", "command", "gone"];   // the named events handed to onEvent

/**
 * Is the host alive, judged ONLY with this device's own clock? true when an event arrived within
 * `maxSec` of `now` (both from the device's monotonic clock, e.g. performance.now()/1000) AND the
 * server-reported `age` (seconds since the host's last push landed on the server) is < maxSec.
 * It never compares the server's wall clock with the device's (a phone 60 s off must still work).
 * An `age` that is not a finite number (an older server) counts as 0; an event "from the future"
 * (now < lastEventAt) is not evidence of anything and counts as no event.
 * @param {{lastEventAt: number, age: number, now: number, maxSec?: number}} o  (seconds)
 * @returns {boolean}
 */
export function hostIsLive({ lastEventAt, age, now, maxSec = 6 } = {}) {
  const limit = typeof maxSec === "number" && maxSec > 0 ? maxSec : 6;
  if (!isNum(now) || !isNum(lastEventAt)) return false;
  const since = now - lastEventAt;
  if (!(since >= 0 && since < limit)) return false;
  const a = isNum(age) ? age : 0;
  return a < limit;
}

/**
 * Should a guest use the push channel, given the host's mirrored settings? The host mirrors its
 * `remote.push` toggle read-only; only an explicit `false` turns push off (absent — an older host,
 * or no view yet — means on). Added to the contract for the phone (M7 orchestrator addition).
 * @param {object|null|undefined} settings  state.settings
 * @returns {boolean}
 */
export function wantPush(settings) {
  return !(settings && typeof settings === "object" && settings["remote.push"] === false);
}

/** JSON.parse(text), or null on any failure (never throws). */
export function parseSseData(text) {
  if (typeof text !== "string") return null;
  try { return JSON.parse(text); } catch (_) { return null; }
}

/** 16 random characters [A-Za-z0-9] (crypto.getRandomValues when present). Call once per tab. */
export function makeCid() {
  const c = globalThis.crypto;
  let out = "";
  if (c && typeof c.getRandomValues === "function") {
    // Rejection sampling: 248 = 4 × 62, so a byte below it maps to a character without bias.
    while (out.length < 16) {
      const bytes = c.getRandomValues(new Uint8Array(24));
      for (let k = 0; k < bytes.length && out.length < 16; k++) {
        if (bytes[k] < 248) out += CID_CHARS[bytes[k] % 62];
      }
    }
    return out;
  }
  while (out.length < 16) out += CID_CHARS[Math.floor(Math.random() * 62)];
  return out;
}

/**
 * @param {object} o
 * @param {string} o.url  the full events URL (room, role and cid already in it)
 * @param {(type: string, data: object) => void} o.onEvent   "state" | "tick" | "command" | "gone"
 *        (the named "hb" is consumed here and never passed on; data = parseSseData(ev.data), events
 *        whose data does not parse to an object are dropped but still count as "alive")
 * @param {(status: string) => void} [o.onStatus]  called on every status CHANGE
 * @param {Function} [o.EventSourceImpl]  default globalThis.EventSource (injected for tests)
 * @param {Function} [o.setTimer] [o.clearTimer] [o.now]  injected for tests (now in ms)
 * @param {number} [o.firstEventMs=4000] [o.silenceMs=6000] [o.retryMs=2000] [o.retryFallbackMs=60000]
 * @returns {{ start(): void, stop(): void, readonly status: "off"|"connecting"|"push"|"fallback" }}
 *
 * Rules (plan M7 contract, exactly):
 *   - A FAILURE is: an `error` event; no event at all (hb included) within firstEventMs of opening (a
 *     proxy that buffers the stream); after status "push", no event for silenceMs.
 *   - On a failure: close the source. If it was an `error` with readyState 2 (CLOSED — a 404/503, which
 *     EventSource never retries by itself) or a silence, build a NEW EventSource after retryMs. (An
 *     `error` with readyState 0 is EventSource reconnecting by itself: close it anyway and rebuild after
 *     retryMs, so there is only ever one source and one set of timers.)
 *   - 3 failures in a row before any event, or 2 silences in a row → status "fallback"; stop; try again
 *     after retryFallbackMs (status "connecting" again).
 *   - Any real event (hb included) resets the failure counters and sets status "push".
 *   - The 300 s server close arrives as an error after events had been flowing: it is rebuilt at once
 *     (or after retryMs) and must NOT push the client toward "fallback".
 *   - No EventSource in this browser → status "fallback" at once (and stay there; the caller polls).
 *   - stop(): closes the source, cancels every timer, status "off". start() after stop() works.
 *
 * Status while rebuilding: an error after events keeps "push" (the 300 s close must never look like
 * a degraded link); a silence, or a failure of a source that never delivered, is "connecting".
 */
export function createPushClient({
  url, onEvent = () => {}, onStatus = () => {},
  EventSourceImpl = globalThis.EventSource,
  setTimer = (fn, ms) => setTimeout(fn, ms), clearTimer = (id) => clearTimeout(id),
  now = () => (globalThis.performance ? globalThis.performance.now() : Date.now()),
  firstEventMs = 4000, silenceMs = 6000, retryMs = 2000, retryFallbackMs = 60000,
} = {}) {
  let status = "off";
  let running = false;
  let es = null;          // the one live source
  let watch = null;       // first-event / silence watchdog
  let retry = null;       // the pending rebuild (or the fallback retry)
  let events = 0;         // events the CURRENT source has delivered
  let lastEventAt = 0;    // now() of the current source's last event
  let fails = 0;          // failures in a row with no event between them
  let silences = 0;       // silences in a row (see the header)

  function setStatus(s) {
    if (s === status) return;
    status = s;
    try { onStatus(s); } catch (e) { console.error("push onStatus failed:", e); }
  }

  function cancel(id) { if (id != null) clearTimer(id); }
  function clearWatch() { cancel(watch); watch = null; }
  function clearRetry() { cancel(retry); retry = null; }

  function closeSource() {
    clearWatch();
    const src = es;
    es = null;
    if (src) { try { src.close(); } catch (_) { /* already closed */ } }
  }

  function open() {
    retry = null;
    if (!running) return;
    let src;
    try { src = new EventSourceImpl(url); } catch (_) { src = null; }
    if (!src) { failure("error", false); return; }
    es = src;
    events = 0;
    const listen = (type) => src.addEventListener(type, (ev) => onSourceEvent(src, type, ev));
    for (const type of PASS_ON) listen(type);
    listen("hb");
    src.addEventListener("error", () => { if (src === es) failure("error", events > 0); });
    watch = setTimer(onWatch, firstEventMs);
  }

  function onSourceEvent(src, type, ev) {
    if (src !== es || !running) return;          // a closed source's straggler
    events++;
    lastEventAt = now();
    fails = 0;
    if (events >= 2) silences = 0;               // the stream keeps flowing, not just its opening burst
    if (events === 1) { clearWatch(); watch = setTimer(onWatch, silenceMs); }
    setStatus("push");
    if (type === "hb") return;
    const data = parseSseData(ev && ev.data);
    if (data === null || typeof data !== "object") return;   // unparsable: dropped, but alive
    try { onEvent(type, data); } catch (e) { console.error(`push ${type} handler failed:`, e); }
  }

  function onWatch() {
    watch = null;
    if (!es || !running) return;
    if (events === 0) { failure("first", false); return; }
    const idle = now() - lastEventAt;
    if (idle >= silenceMs) { failure("silence", true); return; }
    watch = setTimer(onWatch, silenceMs - idle);  // events kept coming: check again at the new deadline
  }

  /** @param {"error"|"first"|"silence"} kind  @param {boolean} flowed  the source had delivered */
  function failure(kind, flowed) {
    closeSource();
    clearRetry();
    if (kind === "silence") {
      silences++;
      if (silences >= 2) { fallBack(); return; }
      setStatus("connecting");
      retry = setTimer(open, retryMs);
      return;
    }
    if (flowed) {                                // the 300 s close, a restart: never toward fallback
      // At once after a stream that kept flowing; a stream that closes after one event every
      // time (an odd proxy) is retried at the normal pace instead of in a tight loop.
      retry = setTimer(open, events >= 2 ? 0 : retryMs);
      return;
    }
    fails++;
    if (fails >= 3) { fallBack(); return; }
    setStatus("connecting");
    retry = setTimer(open, retryMs);
  }

  function fallBack() {
    fails = 0;
    silences = 0;
    setStatus("fallback");
    retry = setTimer(() => {
      retry = null;
      if (!running) return;
      setStatus("connecting");
      open();
    }, retryFallbackMs);
  }

  return {
    start() {
      if (running) return;
      running = true;
      fails = 0;
      silences = 0;
      if (typeof EventSourceImpl !== "function") { setStatus("fallback"); return; }
      setStatus("connecting");
      open();
    },
    stop() {
      running = false;
      closeSource();
      clearRetry();
      fails = 0;
      silences = 0;
      setStatus("off");
    },
    get status() { return status; },
  };
}

function isNum(x) { return typeof x === "number" && Number.isFinite(x); }
