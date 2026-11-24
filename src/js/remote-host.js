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
 *   createRemoteHost({ getSnapshot, applyCommand, … })
 *     getSnapshot()      → { room, now, queue, settings, songRev, notice }   (remote-glue builds it)
 *     applyCommand(cmd)  → apply one guest intent                            (remote-glue dispatches it)
 *   → { start, stop, push, running, publishSong, pushStatus }
 *
 * Relay v2 (M7, plan §5.10 / §5.14):
 *   - PUSH. After the first accepted POST the host opens its own event stream (role "host", its
 *     own cid) and applies each `command` event at once — through the SAME seq dedup as the POST
 *     drain, so a command that arrives both ways runs once. The POST loop stays: it carries the
 *     clock to the phones, the ack, and every command the stream missed.
 *   - A RELAY RESET (serve.py restarted, or the room lapsed and was re-created) restarts the
 *     relay's rev and seq. nextApplied sees it (rev did not grow) and drops lastApplied to 0, or
 *     the new room's low-seq commands would all be skipped as "already applied"; onRelayReset
 *     tells app.js to publish its lyric document again (the old room's died with it).
 *   - The LYRIC DOCUMENT (publishSong) goes to POST /api/remote/song once the relay has accepted a
 *     host POST; a 403 (no room yet / any more) or a network failure is retried ONCE, after the next
 *     accepted host POST. Uploads never overlap, and a newer publishSong replaces an unsent one.
 */
import { createPushClient, makeCid as makeCidDefault } from "./remote-push.js";

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

/**
 * Fold one host-POST reply into the seq bookkeeping (pure — unit-tested, mutation-proven).
 *
 * The relay bumps a room's `rev` on EVERY host POST, so from one host's point of view rev only
 * grows. A reply whose rev did not grow (resp.rev <= lastRev) means the room this host is talking to
 * is not the one it talked to before: serve.py restarted, or the room lapsed (ROOM_TTL) and this POST
 * re-created it. Its command seq restarted from 1 too, so lastApplied must drop to 0 — otherwise
 * every new command with seq <= the old lastApplied is skipped as "already applied" and stranded.
 * (`<=` rather than `<`: a host that managed a single POST before the restart has lastRev 1, and the
 * new room's first reply is rev 1 again.)
 * @returns {{ lastApplied: number, lastRev: number, reset: boolean }}  a reply with no usable rev
 *   (an error body) changes nothing.
 */
/** The host stream's push-client limits: above the server's 15 s heartbeat (see startPush). */
export const HOST_FIRST_EVENT_MS = 20000;
export const HOST_SILENCE_MS = 40000;

export function nextApplied(lastApplied, lastRev, resp) {
  const la = Number.isInteger(lastApplied) && lastApplied > 0 ? lastApplied : 0;
  const lr = Number.isInteger(lastRev) && lastRev > 0 ? lastRev : 0;
  const rev = resp && typeof resp === "object" && Number.isInteger(resp.rev) && resp.rev > 0 ? resp.rev : 0;
  if (!rev) return { lastApplied: la, lastRev: lr, reset: false };
  const reset = lr > 0 && rev <= lr;
  return { lastApplied: reset ? 0 : la, lastRev: rev, reset };
}

/**
 * @param {object} o
 * @param {() => object} o.getSnapshot
 * @param {(cmd: object) => void} o.applyCommand
 * @param {number} [o.interval=1000]      ms between host POSTs
 * @param {string} [o.hostUrl] [o.eventsUrl] [o.songUrl]
 * @param {boolean | (() => boolean)} [o.push=true]  open the host event stream. A function is read
 *        after every accepted POST, so a live setting (remote.push) turns the stream on/off without
 *        rebuilding the host (and without resetting its seq bookkeeping).
 * @param {Function} [o.createPush=createPushClient]  remote-push.js (injected in tests)
 * @param {() => void} [o.onRelayReset]   the relay restarted / the room was re-created: re-publish
 * @param {(status: string) => void} [o.onPushStatus]  the stream's status changed (see pushStatus)
 * @param {() => string} [o.makeCid]      remote-push.js makeCid (injected in tests)
 * @param {Function} [o.fetchImpl] [o.setIntervalImpl] [o.clearIntervalImpl]  test seams
 * @returns {{ start(): void, stop(): void, push(): void, readonly running: boolean,
 *             publishSong(songRev: number, id: string, doc: object): Promise<boolean>,
 *             readonly pushStatus: "off"|"connecting"|"push"|"fallback" }}
 *   publishSong resolves true once the relay holds `doc` for this room; false when the upload
 *   failed for good (a second 403, a 400/413, an unserialisable doc) or a newer publishSong
 *   replaced it first. Called before the relay has accepted a host POST (remote just turned on,
 *   or the host is stopped), the document WAITS and goes out after the next accepted POST.
 */
export function createRemoteHost({
  getSnapshot,
  applyCommand,
  interval = 1000,
  hostUrl = "/api/remote/host",
  eventsUrl = "/api/remote/events",
  songUrl = "/api/remote/song",
  push = true,
  createPush = createPushClient,
  onRelayReset = () => {},
  onPushStatus = () => {},
  makeCid = makeCidDefault,
  fetchImpl = (...args) => globalThis.fetch(...args),
  setIntervalImpl = (fn, ms) => setInterval(fn, ms),
  clearIntervalImpl = (id) => clearInterval(id),
} = {}) {
  const pushOption = push;
  let timer = null;
  let running = false;
  let syncing = false;   // never overlap requests (a slow POST must not stack)
  let again = false;     // push() asked for a sync while one was in flight: run one more after it
  let lastApplied = 0;   // highest command seq applied → sent as ackSeq so the server drops it
  let lastRev = 0;       // the relay rev of the last accepted POST (nextApplied)
  let room = "";         // the room code the last accepted POST carried
  let roomOk = false;    // the relay accepted the last host POST: the room exists right now
  let deferred = [];     // stream commands that arrived while a POST was in flight

  let pushClient = null;
  let pushRoom = "";
  let pushBroken = false;   // createPush / makeCid threw: poll only, until the next start()
  let cid = "";

  let song = null;          // { songRev, id, doc, resolve, retried } — the newest unsent document
  let songBusy = false;

  /** The one place a command is applied, whichever way it came (POST drain or event stream). */
  function applyOne(cmd) {
    if (!cmd || typeof cmd !== "object" || !Number.isInteger(cmd.seq) || cmd.seq <= lastApplied) return;
    try { applyCommand(cmd); }
    catch (e) { console.error("remote command failed:", cmd, e); }
    lastApplied = Math.max(lastApplied, cmd.seq);
  }

  function onPushEvent(type, data) {
    if (!running) return;
    if (type === "command") {
      // Held while a POST is in flight and applied after its reply: if that reply turns out to be
      // the first one after a relay reset, lastApplied is reset BEFORE these new-room seqs are seen.
      if (syncing) deferred.push(data); else applyOne(data);
    } else if (type === "gone") {
      roomOk = false;   // the room died; the next POST re-creates it (and reports the reset)
    }
  }

  function reportStatus(status) {
    try { onPushStatus(status); } catch (e) { console.error("onPushStatus failed:", e); }
  }

  function wantPush() {
    try { return typeof pushOption === "function" ? !!pushOption() : !!pushOption; }
    catch (_) { return false; }
  }

  function stopPush() {
    if (!pushClient) return;
    const c = pushClient;
    pushClient = null;
    pushRoom = "";
    try { c.stop(); } catch (_) {}
    reportStatus("off");
  }

  /** Open, keep or close the host event stream after an accepted POST. */
  function ensurePush() {
    if (!running || pushBroken) return;
    const want = wantPush() && !!room;
    if (pushClient && (!want || pushRoom !== room)) stopPush();
    if (!want || pushClient) return;
    try {
      if (!cid) cid = String(makeCid());
      const url = `${eventsUrl}?room=${encodeURIComponent(room)}&role=host&cid=${encodeURIComponent(cid)}`;
      // A HOST stream carries only `command` events and the server's named `hb` every
      // SSE_HEARTBEAT (15 s) — no state, no ticks. With the phone's limits (4 s to the first event,
      // 6 s of silence) it failed three times, fell back, and spent most of its life polling. The
      // host's POST loop always drains commands anyway, so its stream is only an accelerator and
      // needs no 4 s buffering-proxy fuse: wait past one heartbeat (integration fix, M7).
      const client = createPush({ url, onEvent: onPushEvent, onStatus: reportStatus,
        firstEventMs: HOST_FIRST_EVENT_MS, silenceMs: HOST_SILENCE_MS });
      pushClient = client;
      pushRoom = room;
      client.start();
    } catch (e) {
      pushClient = null;
      pushRoom = "";
      pushBroken = true;
      console.warn("Remote push channel unavailable — polling only:", e);
    }
  }

  function relayReset() {
    // A stream that failed while the relay was down may be sitting out its fallback delay:
    // reconnect it now that the room is back.
    if (pushClient) {
      try { pushClient.stop(); pushClient.start(); } catch (_) {}
    }
    try { onRelayReset(); } catch (e) { console.error("onRelayReset failed:", e); }
  }

  async function sync() {
    if (syncing) return;
    syncing = true;
    let accepted = false;
    try {
      const snap = getSnapshot() || {};
      const res = await fetchImpl(hostUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...snap, ackSeq: lastApplied }),
      });
      const data = await res.json();
      if (data && data.ok === true) {
        const next = nextApplied(lastApplied, lastRev, data);
        lastApplied = next.lastApplied;
        lastRev = next.lastRev;
        room = String(snap.room || "");
        roomOk = true;
        accepted = true;
        for (const cmd of Array.isArray(data.commands) ? data.commands : []) applyOne(cmd);
        if (next.reset) relayReset();
      } else {
        roomOk = false;   // {ok:false, error:"room"|"full"} or an error body
      }
    } catch (_) {
      roomOk = false;     // server down / offline — retry on the next tick
    } finally {
      syncing = false;
      const late = deferred;
      deferred = [];
      for (const cmd of late) applyOne(cmd);
      if (accepted) { ensurePush(); pumpSong(); }
      if (again && running) { again = false; sync(); }
      again = false;
    }
  }

  async function pumpSong() {
    if (songBusy || !song || !running || !roomOk || !room) return;
    const job = song;
    let body;
    try {
      body = JSON.stringify({ room, songRev: job.songRev, id: job.id, doc: job.doc });
    } catch (e) {
      song = null;
      console.error("Lyric document could not be serialised:", e);
      job.resolve(false);
      return;
    }
    songBusy = true;
    let outcome = "fail";
    try {
      const res = await fetchImpl(songUrl, { method: "POST", headers: { "Content-Type": "application/json" }, body });
      let reply = null;
      try { reply = await res.json(); } catch (_) {}
      if (res.ok && reply && reply.ok === true) outcome = "ok";
      else if (res.status === 403 || (reply && reply.error === "no-room")) outcome = "retry";
    } catch (_) {
      outcome = "retry";   // network: the relay may be restarting — the same one retry
    }
    songBusy = false;
    if (song !== job) { pumpSong(); return; }        // replaced while uploading (already resolved false)
    if (outcome === "retry" && !job.retried) {
      job.retried = true;
      roomOk = false;                                // wait for the next accepted host POST
      return;
    }
    song = null;
    job.resolve(outcome === "ok");
  }

  function publishSong(songRev, id, doc) {
    return new Promise((resolve) => {
      if (song) song.resolve(false);                 // superseded: never upload an older document
      song = { songRev, id, doc, resolve, retried: false };
      pumpSong();
    });
  }

  function start() {
    if (running) return;
    running = true;
    pushBroken = false;
    sync();                          // push immediately so the phone sees state fast
    timer = setIntervalImpl(() => { if (!syncing) sync(); }, interval);
  }
  function stop() {
    running = false;
    if (timer != null) clearIntervalImpl(timer);
    timer = null;
    roomOk = false;
    deferred = [];
    again = false;
    stopPush();
    // An unsent lyric document is kept: it goes out after the first accepted POST of the next start().
  }
  /** Force an immediate sync (call after a queue / now-playing change for snappiness). */
  function pushNow() {
    if (!running) return;
    if (syncing) again = true; else sync();
  }

  return {
    start, stop, push: pushNow, publishSong,
    get running() { return running; },
    get pushStatus() { return (pushClient && pushClient.status) || "off"; },
  };
}
