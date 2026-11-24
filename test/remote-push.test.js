/*
 * remote-push.test.js — the relay v2 push client (src/js/remote-push.js, M7): the host-liveness
 * predicate, the SSE data parser, the per-tab client id, and the EventSource state machine
 * (first-event / silence / error failures, rebuilds, the fallback and its retry, stop/start).
 * Run with:  node --test    (or  npm test)
 *
 * node has no EventSource, so the client runs against FakeSource below, on a fake clock whose
 * timers fire only when a test advances it.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { hostIsLive, parseSseData, makeCid, createPushClient, wantPush } from "../src/js/remote-push.js";

// --- fakes ----------------------------------------------------------------------
function fakeClock() {
  let t = 0, nextId = 1;
  const timers = new Map();              // id -> { at, fn }
  return {
    now: () => t,
    setTimer(fn, ms) { const id = nextId++; timers.set(id, { at: t + Math.max(0, ms || 0), fn }); return id; },
    clearTimer(id) { timers.delete(id); },
    pending: () => timers.size,
    /** Move time forward, firing every timer that comes due, in due order. */
    advance(ms) {
      const end = t + ms;
      for (;;) {
        let id = null, best = null;
        for (const [k, v] of timers) if (v.at <= end && (best === null || v.at < best.at)) { id = k; best = v; }
        if (id === null) break;
        timers.delete(id);
        t = best.at;
        best.fn();
      }
      t = end;
    },
  };
}

function fakeSourceClass() {
  class FakeSource {
    constructor(url) {
      this.url = url;
      this.readyState = 0;
      this.closed = false;
      this.listeners = {};
      FakeSource.made.push(this);
    }
    addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
    close() { this.closed = true; this.readyState = 2; }
    emit(type, data) {
      this.readyState = 1;
      const ev = { type, data: typeof data === "string" ? data : JSON.stringify(data) };
      for (const fn of this.listeners[type] || []) fn(ev);
    }
    fail(readyState = 2) {
      this.readyState = readyState;
      for (const fn of this.listeners.error || []) fn({ type: "error" });
    }
  }
  FakeSource.made = [];
  FakeSource.last = () => FakeSource.made[FakeSource.made.length - 1];
  FakeSource.open = () => FakeSource.made.filter((s) => !s.closed);
  return FakeSource;
}

function harness(opts = {}) {
  const clock = fakeClock();
  const Source = fakeSourceClass();
  const events = [], statuses = [];
  const client = createPushClient({
    url: "/api/remote/events?room=ABCD&role=guest&cid=abcdefgh12345678",
    onEvent: (type, data) => events.push([type, data]),
    onStatus: (s) => statuses.push(s),
    EventSourceImpl: Source,
    setTimer: clock.setTimer, clearTimer: clock.clearTimer, now: clock.now,
    ...opts,
  });
  return { clock, Source, events, statuses, client };
}

// --- hostIsLive -------------------------------------------------------------------
test("hostIsLive is true for a fresh event with a small age", () => {
  assert.equal(hostIsLive({ lastEventAt: 100, age: 0.3, now: 101 }), true);
  assert.equal(hostIsLive({ lastEventAt: 100, age: 0, now: 100 }), true);
});

test("hostIsLive ignores wall-clock skew", () => {
  // The phone has only ever been given the server's wall clock in `ts`. A caller that spreads the
  // whole view in (ts included) must still get an answer from the device's own clock alone: the
  // phone runs 60 s fast, then 60 s slow, and the host is live either way.
  const realNow = Date.now;
  try {
    const serverTs = Math.floor(realNow() / 1000);
    const view = { ts: serverTs, age: 0.2 };
    Date.now = () => realNow() + 60_000;
    assert.equal(hostIsLive({ ...view, lastEventAt: 500, now: 501.5 }), true);
    Date.now = () => realNow() - 60_000;
    assert.equal(hostIsLive({ ...view, lastEventAt: 500, now: 501.5 }), true);
  } finally {
    Date.now = realNow;
  }
});

test("hostIsLive is false after silence", () => {
  assert.equal(hostIsLive({ lastEventAt: 100, age: 0.1, now: 106 }), false);    // exactly maxSec
  assert.equal(hostIsLive({ lastEventAt: 100, age: 0.1, now: 130 }), false);
  assert.equal(hostIsLive({ lastEventAt: 100, age: 0.1, now: 102, maxSec: 2 }), false);
});

test("hostIsLive is false for a stale age", () => {
  // The relay is reachable and answering, but the host's last push landed 7 s ago.
  assert.equal(hostIsLive({ lastEventAt: 100, age: 7, now: 100.2 }), false);
  assert.equal(hostIsLive({ lastEventAt: 100, age: 6, now: 100.2 }), false);
});

test("hostIsLive is false without an event, and treats a missing age as fresh", () => {
  assert.equal(hostIsLive(), false);
  assert.equal(hostIsLive({ lastEventAt: undefined, age: 0, now: 5 }), false);
  assert.equal(hostIsLive({ lastEventAt: 10, age: 0, now: 5 }), false);       // "from the future"
  assert.equal(hostIsLive({ lastEventAt: 10, now: 11 }), true);               // an older server: no age
  assert.equal(hostIsLive({ lastEventAt: 10, age: "x", now: 11 }), true);
});

// --- wantPush ----------------------------------------------------------------------
test("wantPush follows the host's mirrored remote.push; only an explicit false turns it off", () => {
  assert.equal(wantPush({ "remote.push": false }), false);
  assert.equal(wantPush({ "remote.push": true }), true);
  assert.equal(wantPush({ "audio.volume": 0.9 }), true);      // an older host does not mirror it
  assert.equal(wantPush(null), true);
  assert.equal(wantPush(undefined), true);
  assert.equal(wantPush({ "remote.push": 0 }), true);         // not false: junk does not switch push off
  assert.equal(wantPush("nope"), true);
});

// --- parseSseData / makeCid -------------------------------------------------------
test("parseSseData tolerates junk", () => {
  assert.deepEqual(parseSseData('{"rev":3,"now":null}'), { rev: 3, now: null });
  assert.equal(parseSseData("{nope"), null);
  assert.equal(parseSseData(""), null);
  assert.equal(parseSseData(undefined), null);
  assert.equal(parseSseData(null), null);
  assert.equal(parseSseData({ rev: 1 }), null);
  assert.equal(parseSseData("null"), null);
});

test("makeCid is 16 characters of [A-Za-z0-9] and differs per call", () => {
  const a = makeCid(), b = makeCid();
  assert.match(a, /^[A-Za-z0-9]{16}$/);
  assert.match(b, /^[A-Za-z0-9]{16}$/);
  assert.notEqual(a, b);
  // The server's cid rule (serve.py _CID_RE) accepts it.
  assert.match(a, /^[A-Za-z0-9_-]{8,32}$/);
});

test("makeCid works without crypto.getRandomValues", () => {
  const desc = Object.getOwnPropertyDescriptor(globalThis, "crypto");
  try {
    Object.defineProperty(globalThis, "crypto", { value: undefined, configurable: true, writable: true });
    assert.match(makeCid(), /^[A-Za-z0-9]{16}$/);
  } finally {
    if (desc) Object.defineProperty(globalThis, "crypto", desc);
  }
});

// --- createPushClient ---------------------------------------------------------------
test("client opens one source at the given url and reports connecting", () => {
  const { client, Source, statuses } = harness();
  assert.equal(client.status, "off");
  client.start();
  assert.equal(Source.made.length, 1);
  assert.equal(Source.last().url, "/api/remote/events?room=ABCD&role=guest&cid=abcdefgh12345678");
  assert.equal(client.status, "connecting");
  assert.deepEqual(statuses, ["connecting"]);
  client.start();                                     // already running: no second source
  assert.equal(Source.made.length, 1);
});

test("client reports push after the first event", () => {
  const { client, Source, statuses } = harness();
  client.start();
  Source.last().emit("state", { ok: true, rev: 1 });
  assert.equal(client.status, "push");
  assert.deepEqual(statuses, ["connecting", "push"]);
  Source.last().emit("tick", { rev: 2 });
  assert.deepEqual(statuses, ["connecting", "push"]);  // onStatus fires on CHANGES only
});

test("events reach onEvent with their type", () => {
  const { client, Source, events } = harness();
  client.start();
  const s = Source.last();
  s.emit("state", { ok: true, rev: 4, queue: [] });
  s.emit("tick", { rev: 5, age: 0.1, position: 12.5 });
  s.emit("command", { seq: 9, type: "pause" });
  s.emit("gone", { error: "no-room" });
  assert.deepEqual(events, [
    ["state", { ok: true, rev: 4, queue: [] }],
    ["tick", { rev: 5, age: 0.1, position: 12.5 }],
    ["command", { seq: 9, type: "pause" }],
    ["gone", { error: "no-room" }],
  ]);
});

test("an event whose data does not parse is dropped but keeps the stream alive", () => {
  const { client, Source, events, clock } = harness();
  client.start();
  Source.last().emit("state", "{broken");
  assert.equal(events.length, 0);
  assert.equal(client.status, "push");
  clock.advance(5000);
  Source.last().emit("tick", "not json either");
  clock.advance(5000);                                // 10 s in, but never 6 s without an event
  assert.equal(Source.made.length, 1);
  assert.equal(client.status, "push");
});

test("hb keeps the stream alive but is not passed to onEvent", () => {
  const { client, Source, events, clock } = harness();
  client.start();
  const s = Source.last();
  s.emit("hb", {});
  assert.equal(client.status, "push");
  for (let k = 0; k < 10; k++) { clock.advance(5000); s.emit("hb", {}); }
  assert.equal(events.length, 0);
  assert.equal(Source.made.length, 1);
  assert.equal(s.closed, false);
  assert.equal(client.status, "push");
});

test("client falls back when the stream opens but stays silent", () => {
  const { client, Source, statuses, clock } = harness();
  client.start();
  Source.last().readyState = 1;                       // a buffering proxy: open, never a byte
  clock.advance(3999);
  assert.equal(Source.made.length, 1);
  clock.advance(1);                                   // firstEventMs: failure 1
  assert.equal(Source.made[0].closed, true);
  assert.equal(client.status, "connecting");
  clock.advance(2000);                                // retryMs → source 2
  assert.equal(Source.made.length, 2);
  clock.advance(4000);                                // failure 2
  clock.advance(2000);                                // source 3
  assert.equal(Source.made.length, 3);
  clock.advance(4000);                                // failure 3 → fallback
  assert.equal(client.status, "fallback");
  assert.equal(Source.open().length, 0);
  assert.deepEqual(statuses, ["connecting", "fallback"]);
  assert.equal(clock.now(), 16000);                   // 3 × firstEventMs + 2 × retryMs
});

test("client rebuilds after a closed (404) source", () => {
  const { client, Source, clock } = harness();
  client.start();
  Source.last().fail(2);                              // CLOSED: EventSource will never retry this itself
  assert.equal(Source.made[0].closed, true);
  clock.advance(1999);
  assert.equal(Source.made.length, 1);
  clock.advance(1);
  assert.equal(Source.made.length, 2);
  assert.equal(Source.open().length, 1);
  Source.last().emit("state", { rev: 1 });
  assert.equal(client.status, "push");
});

test("a reconnecting (readyState 0) error is closed and rebuilt, never doubled", () => {
  const { client, Source, clock } = harness();
  client.start();
  Source.last().fail(0);                              // EventSource would reconnect by itself
  assert.equal(Source.made[0].closed, true);
  clock.advance(2000);
  assert.equal(Source.made.length, 2);
  assert.equal(Source.open().length, 1);
  assert.equal(clock.pending(), 1);                   // one watchdog, nothing else
});

test("client falls back after three errors", () => {
  const { client, Source, clock } = harness();
  client.start();
  Source.last().fail(2);
  clock.advance(2000);
  Source.last().fail(2);
  clock.advance(2000);
  assert.equal(client.status, "connecting");
  Source.last().fail(2);
  assert.equal(client.status, "fallback");
  assert.equal(Source.made.length, 3);
  clock.advance(59_999);
  assert.equal(Source.made.length, 3);                // no source while falling back
});

test("any event resets the failure count", () => {
  const { client, Source, clock } = harness();
  client.start();
  Source.last().fail(2); clock.advance(2000);
  Source.last().fail(2); clock.advance(2000);
  Source.last().emit("hb", {});                       // one real event
  Source.last().fail(2);                              // (a failure after events: not counted)
  clock.advance(2000);
  Source.last().fail(2); clock.advance(2000);
  Source.last().fail(2); clock.advance(2000);
  assert.equal(client.status, "connecting");          // two in a row since the event, not five
  Source.last().fail(2);
  assert.equal(client.status, "fallback");
});

test("client retries after the fallback delay", () => {
  const { client, Source, statuses, clock } = harness();
  client.start();
  for (let k = 0; k < 3; k++) { Source.last().fail(2); clock.advance(2000); }
  assert.equal(client.status, "fallback");
  const made = Source.made.length;
  clock.advance(60_000 - 2000 - 1);
  assert.equal(Source.made.length, made);
  clock.advance(1);                                   // retryFallbackMs after the fallback
  assert.equal(Source.made.length, made + 1);
  assert.equal(client.status, "connecting");
  Source.last().emit("state", { rev: 1 });
  assert.equal(client.status, "push");
  assert.deepEqual(statuses, ["connecting", "fallback", "connecting", "push"]);
});

test("a max-age close after events does not count toward fallback", () => {
  const { client, Source, statuses, clock } = harness();
  client.start();
  // Ten 300 s streams in a row, each closed by the server after its events flowed.
  for (let round = 0; round < 10; round++) {
    const s = Source.last();
    s.emit("state", { rev: 1 });
    for (let k = 0; k < 5; k++) { clock.advance(1000); s.emit("tick", { rev: 2 + k }); }
    s.fail(0);                                        // the server ended the stream
    assert.equal(client.status, "push");              // never "connecting", never "fallback"
    clock.advance(0);                                 // rebuilt at once
    assert.equal(Source.open().length, 1);
  }
  assert.deepEqual(statuses, ["connecting", "push"]);
  // And the close itself is not failure #1: after it, three MORE failures are needed.
  Source.last().fail(2); clock.advance(2000);
  Source.last().fail(2); clock.advance(2000);
  assert.equal(client.status, "connecting");
  Source.last().fail(2);
  assert.equal(client.status, "fallback");
});

test("a stream that goes quiet once recovers on the rebuilt source", () => {
  const { client, Source, clock } = harness();
  client.start();
  const s1 = Source.last();
  s1.emit("state", { rev: 1 }); s1.emit("tick", { rev: 2 });
  clock.advance(6000);                                // silence 1
  assert.equal(s1.closed, true);
  assert.equal(client.status, "connecting");
  clock.advance(2000);
  const s2 = Source.last();
  s2.emit("state", { rev: 3 });
  for (let k = 0; k < 4; k++) { clock.advance(1000); s2.emit("tick", { rev: 4 + k }); }   // flowing again
  clock.advance(6000);                                // a later, unrelated silence
  assert.equal(client.status, "connecting");          // silence count was reset: not fallback
});

test("two silences in a row fall back (a proxy that passes only the opening burst)", () => {
  const { client, Source, clock } = harness();
  client.start();
  Source.last().emit("state", { rev: 1 });
  clock.advance(6000);                                // silence 1
  clock.advance(2000);
  Source.last().emit("state", { rev: 1 });            // the new stream's opening burst, then nothing
  assert.equal(client.status, "push");
  clock.advance(6000);                                // silence 2
  assert.equal(client.status, "fallback");
  assert.equal(Source.open().length, 0);
});

test("no EventSource means fallback at once", () => {
  const statuses = [];
  const client = createPushClient({ url: "/x", EventSourceImpl: undefined, onStatus: (s) => statuses.push(s) });
  client.start();
  assert.equal(client.status, "fallback");
  assert.deepEqual(statuses, ["fallback"]);
  client.stop();
  assert.equal(client.status, "off");
});

test("stop closes the source and cancels timers", () => {
  const { client, Source, statuses, clock } = harness();
  client.start();
  Source.last().emit("state", { rev: 1 });
  client.stop();
  assert.equal(Source.last().closed, true);
  assert.equal(client.status, "off");
  assert.equal(clock.pending(), 0);
  clock.advance(120_000);
  assert.equal(Source.made.length, 1);                // nothing reopened behind our back
  // A straggler from the closed source is ignored.
  Source.made[0].emit("tick", { rev: 9 });
  assert.equal(client.status, "off");
  assert.deepEqual(statuses, ["connecting", "push", "off"]);
});

test("stop during a pending rebuild or a fallback cancels it; start after stop works", () => {
  const { client, Source, clock } = harness();
  client.start();
  Source.last().fail(2);                              // rebuild pending
  client.stop();
  assert.equal(clock.pending(), 0);
  clock.advance(10_000);
  assert.equal(Source.made.length, 1);
  client.start();
  assert.equal(Source.made.length, 2);
  for (let k = 0; k < 3; k++) { Source.last().fail(2); clock.advance(2000); }
  assert.equal(client.status, "fallback");
  client.stop();
  assert.equal(clock.pending(), 0);
  client.start();                                     // a fresh start: the counters start over
  assert.equal(client.status, "connecting");
  Source.last().fail(2); clock.advance(2000);
  Source.last().fail(2); clock.advance(2000);
  assert.equal(client.status, "connecting");
});

test("a throwing onEvent handler does not break the stream", () => {
  const errors = [];
  const realError = console.error;
  console.error = (...a) => errors.push(a);
  try {
    const { client, Source } = harness({ onEvent: () => { throw new Error("boom"); } });
    client.start();
    Source.last().emit("state", { rev: 1 });
    assert.equal(client.status, "push");
    assert.equal(errors.length, 1);
  } finally {
    console.error = realError;
  }
});
