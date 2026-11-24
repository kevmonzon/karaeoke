// Relay v2 on the host (M7, plan §5.10 / §5.11 / §5.14): remote-host.js (push stream, nextApplied,
// publishSong) and remote-glue.js (ref, songRev, notice, playnow / priority / restart / bg, the
// read-only mirror). Fake fetch, fake timers, fake push client — no network, no real EventSource.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { createRemoteHost, nextApplied, clampRemoteSetting, REMOTE_SETTABLE_PATHS } from "../src/js/remote-host.js";
import { createRemoteGlue, REMOTE_SETTABLE, REMOTE_READONLY_MIRROR, NOTICE_MS } from "../src/js/remote-glue.js";
import { Catalog } from "../src/js/catalog.js";

const HOST = "/api/remote/host";
const SONG = "/api/remote/song";
const settle = () => new Promise((r) => setImmediate(r));   // every pending promise chain has run

// --- fakes -------------------------------------------------------------------------------------
/** serve.py's room relay in miniature: rev per host POST, seq per guest command, ack drops. */
function fakeRelay() {
  const r = {
    rev: 0, seq: 0, commands: [], live: false, down: false, song: null,
    hostPosts: [], songPosts: [], hold: false, held: [], songReply: null,
    restart() { Object.assign(r, { rev: 0, seq: 0, commands: [], live: false, song: null }); },
    guest(cmd) {
      if (!r.live) return null;
      const c = { ...cmd, seq: ++r.seq };
      r.commands.push(c);
      return { ...c };
    },
    release() { const h = r.held; r.held = []; h.forEach((f) => f()); },
    fetch(url, init) {
      if (r.down) return Promise.reject(new TypeError("Failed to fetch"));
      const body = JSON.parse(init.body);
      let status = 200, out;
      if (url === HOST) {
        r.hostPosts.push(body);
        r.live = true;
        r.rev++;
        r.commands = r.commands.filter((c) => c.seq > (body.ackSeq || 0));
        out = { ok: true, rev: r.rev, commands: r.commands.map((c) => ({ ...c })) };
      } else if (url === SONG) {
        r.songPosts.push(body);
        if (r.songReply) [status, out] = r.songReply(body);
        else if (!r.live) [status, out] = [403, { ok: false, error: "no-room" }];
        else { r.song = body; out = { ok: true, songRev: body.songRev }; }
      } else {
        [status, out] = [404, { ok: false }];
      }
      const res = { ok: status >= 200 && status < 300, status, json: async () => out };
      return r.hold ? new Promise((done) => r.held.push(() => done(res))) : Promise.resolve(res);
    },
  };
  return r;
}

function fakeTimers() {
  const t = { fns: new Map(), next: 1 };
  t.set = (fn, ms) => { const id = t.next++; t.fns.set(id, { fn, ms }); return id; };
  t.clear = (id) => { t.fns.delete(id); };
  t.fire = () => { for (const { fn } of [...t.fns.values()]) fn(); };
  return t;
}

/** createPushClient stand-in: records how it was built; the test plays the server's events. */
function fakePushFactory() {
  const f = { clients: [] };
  f.create = (opts) => {
    const c = { opts, starts: 0, stops: 0, status: "connecting" };
    c.start = () => { c.starts++; c.status = "push"; };
    c.stop = () => { c.stops++; c.status = "off"; };
    c.emit = (type, data) => opts.onEvent(type, data);
    f.clients.push(c);
    return c;
  };
  return f;
}

function hostHarness(over = {}) {
  const relay = over.relay || fakeRelay();
  const timers = fakeTimers();
  const pushes = fakePushFactory();
  const applied = [];
  const events = { resets: 0, statuses: [] };
  let snap = { room: "ABC123", now: null, queue: [], settings: {}, songRev: 0, notice: "" };
  const host = createRemoteHost({
    getSnapshot: () => snap,
    applyCommand: (cmd) => applied.push(cmd),
    fetchImpl: relay.fetch,
    setIntervalImpl: timers.set, clearIntervalImpl: timers.clear,
    createPush: pushes.create,
    makeCid: () => "hostcid123456789",
    onRelayReset: () => { events.resets++; if (over.onRelayReset) over.onRelayReset(); },
    onPushStatus: (s) => events.statuses.push(s),
    ...(over.options || {}),
  });
  return { host, relay, timers, pushes, applied, events, setSnap: (s) => { snap = { ...snap, ...s }; } };
}

// --- nextApplied (pure) ------------------------------------------------------------------------
test("nextApplied: a growing rev keeps the seq baseline, a rev that did not grow resets it", () => {
  assert.deepEqual(nextApplied(0, 0, { rev: 1 }), { lastApplied: 0, lastRev: 1, reset: false }, "the first reply");
  assert.deepEqual(nextApplied(7, 10, { rev: 11 }), { lastApplied: 7, lastRev: 11, reset: false });
  assert.deepEqual(nextApplied(7, 10, { rev: 1 }), { lastApplied: 0, lastRev: 1, reset: true }, "serve.py restarted");
  assert.deepEqual(nextApplied(7, 1, { rev: 1 }), { lastApplied: 0, lastRev: 1, reset: true }, "a host with one POST before the restart");
  for (const junk of [null, undefined, {}, { rev: "5" }, { rev: 0 }, { rev: -2 }, { rev: 1.5 }, { ok: false, error: "full" }]) {
    assert.deepEqual(nextApplied(7, 10, junk), { lastApplied: 7, lastRev: 10, reset: false }, "an error body changes nothing");
  }
});

// --- remote-host transport ---------------------------------------------------------------------
test("a relay restart does not strand commands", async () => {
  const h = hostHarness();
  h.host.start();
  await settle();
  for (let i = 0; i < 5; i++) h.relay.guest({ type: "next", by: "Rae" });
  h.timers.fire(); await settle();
  assert.deepEqual(h.applied.map((c) => c.seq), [1, 2, 3, 4, 5]);
  h.timers.fire(); await settle();       // acks 5

  h.relay.restart();                     // serve.py restarted: rev and seq start again
  h.relay.down = true;
  h.timers.fire(); await settle();       // a POST fails while it is down
  h.relay.down = false;
  h.timers.fire(); await settle();       // the host re-creates the room (rev 1 again)
  const seq1 = h.relay.guest({ type: "pause", by: "Mia" });
  assert.equal(seq1.seq, 1, "the new room numbers its commands from 1");
  h.timers.fire(); await settle();
  assert.deepEqual(h.applied.slice(5).map((c) => [c.seq, c.type]), [[1, "pause"]], "seq 1 of the new room is applied, not skipped");
  // …and through the push stream as well.
  h.pushes.clients.at(-1).emit("command", { seq: 2, type: "play", by: "Mia" });
  assert.deepEqual(h.applied.slice(6).map((c) => c.seq), [2]);
});

test("a relay reset triggers onRelayReset", async () => {
  const h = hostHarness();
  h.host.start(); await settle();
  h.timers.fire(); await settle();
  h.timers.fire(); await settle();
  assert.equal(h.events.resets, 0, "a rev that grows is not a reset");
  const client = h.pushes.clients[0];
  const startsBefore = client.starts;
  h.relay.restart();
  h.timers.fire(); await settle();
  assert.equal(h.events.resets, 1);
  assert.equal(client.starts, startsBefore + 1, "the host stream reconnects at once rather than sit out a fallback delay");
  h.timers.fire(); await settle();
  assert.equal(h.events.resets, 1, "once per reset");
});

test("push commands are applied at once and run once, whichever way they arrive", async () => {
  const h = hostHarness();
  h.host.start();
  assert.equal(h.pushes.clients.length, 0, "no stream before the relay has accepted a POST (the room may not exist)");
  await settle();
  assert.equal(h.pushes.clients.length, 1);
  const { opts } = h.pushes.clients[0];
  assert.equal(opts.url, "/api/remote/events?room=ABC123&role=host&cid=hostcid123456789");
  // Integration fix: the host's limits sit above the server's 15 s heartbeat (a host stream gets
  // no state or ticks), or it fails three times and lives in fallback.
  assert.ok(opts.firstEventMs > 15000 && opts.silenceMs > 15000, `host push limits ${opts.firstEventMs}/${opts.silenceMs}`);

  const c1 = h.relay.guest({ type: "pause", by: "Rae" });
  h.pushes.clients[0].emit("command", c1);
  assert.deepEqual(h.applied.map((c) => c.seq), [1], "applied the moment the event lands");
  h.timers.fire(); await settle();               // the POST drain re-delivers seq 1 (not acked yet)
  assert.deepEqual(h.applied.map((c) => c.seq), [1], "…and the seq dedup drops the copy");
  h.pushes.clients[0].emit("command", c1);       // a reconnected stream re-sends the un-acked
  h.pushes.clients[0].emit("command", { type: "next" });          // no seq: junk
  h.pushes.clients[0].emit("command", null);
  assert.deepEqual(h.applied.map((c) => c.seq), [1]);
  h.timers.fire(); await settle();
  assert.equal(h.relay.hostPosts.at(-1).ackSeq, 1, "the POST loop still acks what the stream applied");
});

test("a command pushed while a POST is in flight waits for that POST's reply", async () => {
  // The reply might be the first one after a relay reset; its seq baseline must be fixed first.
  const h = hostHarness();
  h.host.start(); await settle();
  for (let i = 0; i < 3; i++) h.relay.guest({ type: "next" });
  h.timers.fire(); await settle();
  h.timers.fire(); await settle();               // applied 1..3, acked
  h.relay.restart();
  h.relay.hold = true;
  h.timers.fire();                               // this POST re-creates the room; its reply is held
  const c1 = h.relay.guest({ type: "pause" });   // seq 1 of the NEW room, already on the stream
  h.pushes.clients[0].emit("command", c1);
  assert.equal(h.applied.length, 3, "held, not judged against the old room's seqs");
  h.relay.hold = false;
  h.relay.release(); await settle();
  assert.deepEqual(h.applied.slice(3).map((c) => [c.seq, c.type]), [[1, "pause"]]);
  h.timers.fire(); await settle();
  assert.equal(h.applied.length, 4, "and the POST drain's copy is then a duplicate");
});

test("push off never opens a stream; a push function turns it on and off live", async () => {
  const off = hostHarness({ options: { push: false } });
  off.host.start(); await settle();
  off.timers.fire(); await settle();
  assert.equal(off.pushes.clients.length, 0);
  assert.equal(off.host.pushStatus, "off");

  let want = false;
  const live = hostHarness({ options: { push: () => want } });
  live.host.start(); await settle();
  assert.equal(live.pushes.clients.length, 0);
  want = true;
  live.timers.fire(); await settle();
  assert.equal(live.pushes.clients.length, 1);
  assert.equal(live.host.pushStatus, "push");
  want = false;
  live.timers.fire(); await settle();
  assert.equal(live.pushes.clients[0].stops, 1);
  assert.equal(live.host.pushStatus, "off");
  assert.deepEqual(live.events.statuses, ["off"], "onPushStatus hears the change");
});

test("stop closes the stream; a push client that cannot be built leaves polling working", async () => {
  const h = hostHarness();
  h.host.start(); await settle();
  h.host.stop();
  assert.equal(h.pushes.clients[0].stops, 1);
  assert.equal(h.host.running, false);
  assert.equal(h.timers.fns.size, 0, "the interval is cancelled");
  h.pushes.clients[0].emit("command", { seq: 99, type: "next" });
  assert.equal(h.applied.length, 0, "a late event after stop is ignored");

  // A push client that cannot be built (the M7 stub threw; an old browser might): the POST loop must not care.
  const warn = console.warn; console.warn = () => {};
  try {
    const broken = hostHarness({ options: { createPush: () => { throw new Error("not implemented"); } } });
    broken.host.start(); await settle();
    broken.relay.guest({ type: "play" });
    broken.timers.fire(); await settle();
    assert.deepEqual(broken.applied.map((c) => c.type), ["play"]);
    assert.equal(broken.host.pushStatus, "off");
  } finally { console.warn = warn; }
});

test("publishSong waits for the room, then uploads {room, songRev, id, doc}", async () => {
  const h = hostHarness();
  const doc = { v: 1, id: "midi:1", kind: "lines", lines: [], cues: [], beats: [], dur: 0 };
  const p = h.host.publishSong(3, "midi:1", doc);   // before start(): held, not sent
  await settle();
  assert.equal(h.relay.songPosts.length, 0);
  h.host.start(); await settle(); await settle();
  assert.equal(await p, true);
  assert.deepEqual(h.relay.songPosts, [{ room: "ABC123", songRev: 3, id: "midi:1", doc }]);

  // A newer document replaces one that has not gone out; uploads never overlap.
  h.relay.hold = true;
  const a = h.host.publishSong(4, "midi:2", { v: 1, n: "a" });
  const b = h.host.publishSong(5, "midi:3", { v: 1, n: "b" });   // a is in flight: b waits
  const c = h.host.publishSong(6, "midi:4", { v: 1, n: "c" });   // b never went out: replaced
  assert.equal(h.relay.songPosts.length, 2, "one upload in flight");
  h.relay.hold = false;
  h.relay.release(); await settle(); await settle();
  assert.deepEqual([await a, await b, await c], [false, false, true]);
  assert.deepEqual(h.relay.songPosts.slice(1).map((s) => s.songRev), [4, 6], "b was never uploaded; c went last");
});

test("publishSong retries once after a 403", async () => {
  const h = hostHarness();
  h.host.start(); await settle();
  let refusals = 1;
  h.relay.songReply = () => (refusals-- > 0 ? [403, { ok: false, error: "no-room" }] : [200, { ok: true }]);
  const p = h.host.publishSong(1, "midi:1", { v: 1 });
  await settle();
  assert.equal(h.relay.songPosts.length, 1);
  await settle();
  assert.equal(h.relay.songPosts.length, 1, "no retry before the next accepted host POST");
  h.timers.fire(); await settle(); await settle();
  assert.equal(h.relay.songPosts.length, 2, "retried after it");
  assert.equal(await p, true);

  // A second 403 is final: false, and no third upload.
  h.relay.songReply = () => [403, { ok: false, error: "no-room" }];
  const q = h.host.publishSong(2, "midi:2", { v: 1 });
  await settle();
  h.timers.fire(); await settle(); await settle();
  h.timers.fire(); await settle(); await settle();
  assert.equal(await q, false);
  assert.equal(h.relay.songPosts.length, 4);
  // A 400 / 413 is not retried at all (the same body would fail again).
  h.relay.songReply = () => [413, { ok: false, error: "request too large" }];
  assert.equal(await h.host.publishSong(3, "midi:3", { v: 1 }), false);
  h.timers.fire(); await settle(); await settle();
  assert.equal(h.relay.songPosts.length, 5);
});

test("after a relay reset the re-published document reaches the new room", async () => {
  let host;
  const doc = { v: 1, id: "midi:9", kind: "lines", lines: [], cues: [], beats: [], dur: 0 };
  const h = hostHarness({ onRelayReset: () => host.publishSong(2, "midi:9", doc) });
  host = h.host;
  host.start(); await settle();
  assert.equal(await host.publishSong(2, "midi:9", doc), true);
  h.relay.restart();
  assert.equal(h.relay.song, null, "the restarted relay holds no document");
  h.timers.fire(); await settle(); await settle();
  assert.equal(h.events.resets, 1);
  assert.deepEqual(h.relay.song, { room: "ABC123", songRev: 2, id: "midi:9", doc });
});

test("push() during an in-flight POST runs one more right after it (no change waits a whole tick)", async () => {
  const h = hostHarness();
  h.host.start(); await settle();
  const before = h.relay.hostPosts.length;
  h.relay.hold = true;
  h.timers.fire();
  h.host.push(); h.host.push();
  assert.equal(h.relay.hostPosts.length, before + 1, "never two in flight");
  h.relay.hold = false;
  h.relay.release(); await settle(); await settle();
  assert.equal(h.relay.hostPosts.length, before + 2, "exactly one follow-up");
});

// --- remote-glue --------------------------------------------------------------------------------
function catalogOf(records) {
  const c = new Catalog();
  c.adopt(records.map((r) => ({ kind: "midi", langName: "", ...r })));
  return c;
}

function glueHarness(over = {}) {
  const calls = [];
  const record = (name) => (...args) => calls.push([name, ...args]);
  const list = over.list || [];
  const listBy = over.listBy || list.map(() => "");
  let clockMs = over.clockMs ?? 1_000_000;
  const settings = { ...(over.settings || {}) };
  const catalog = over.catalog || catalogOf([]);
  const glue = createRemoteGlue({
    settings: { get: (p) => settings[p] },
    catalog,
    queue: {
      list, listBy,
      countBy: (who) => listBy.filter((b) => b === who).length,
      matches: (i, id) => !!list[i] && (!id || list[i].id === id),
    },
    reactions: { handle: record("react") },
    libraryView: { registerYoutube: (r) => ({ ...r, registered: true }) },
    durations: { get: () => null },
    getNowPlaying: () => (over.now === undefined ? null : over.now),
    setStatus: record("status"),
    storage: { getItem: () => "ROOM42", setItem() {} },
    clock: () => clockMs,
    actions: {
      enqueue: record("enqueue"), removeFromQueue: record("remove"), reorderQueue: record("reorder"),
      play: record("play"), pause: record("pause"), next: record("next"),
      seek: record("seek"), setVolume: record("volume"), applySetting: record("setting"),
      playNow: record("playNow"), playNext: record("playNext"), restart: record("restart"), bgNext: record("bgNext"),
      ...(over.actions ? over.actions(record) : {}),
    },
  });
  return { glue, calls, catalog, settings, advance: (ms) => { clockMs += ms; } };
}

const SONGS = [
  { code: 100, name: "Tahan", artistName: "Bryan", source: "SH" },
  { code: 123, name: "Beer", artistName: "Itchyworms", source: "PLATKAR" },
  { code: 123, name: "Barcelona", artistName: "George Ezra", source: "SH" },
  { code: "", name: "Untitled clip", kind: "video", file: "videos/a.mp4" },
];

test("queue items carry ref when the song is in the catalogue", () => {
  const catalog = catalogOf(SONGS);
  const yt = { id: "youtube:abc", name: "From YouTube", kind: "youtube" };
  const { glue } = glueHarness({ catalog, list: [catalog.songs[2], yt, catalog.songs[0]], listBy: ["Rae", "", "Mia"] });
  const q = glue.snapshot().queue;
  assert.deepEqual(q.map((item) => item.ref ?? null), [{ i: 2, code: 123 }, null, { i: 0, code: 100 }]);
  assert.equal(q[0].id, catalog.songs[2].id, "the rest of the item is unchanged");

  // The song → index map is rebuilt when the catalogue array is replaced (a rebuild / adopt)…
  catalog.adopt([catalog.songs[2], catalog.songs[0], catalog.songs[1]]);
  assert.deepEqual(glue.snapshot().queue.map((item) => item.ref ?? null), [{ i: 0, code: 123 }, null, { i: 1, code: 100 }]);
  // …and not per push: the same array is never re-scanned.
  let reads = 0;
  const songs = catalog.songs;
  const spy = new Proxy(songs, { get(t, k) { if (k === "forEach") reads++; return Reflect.get(t, k); } });
  catalog.songs = spy;
  glue.snapshot(); glue.snapshot(); glue.snapshot();
  assert.equal(reads, 1);
});

test("songRev is lifted from the now block", () => {
  const now = { id: "midi:1", name: "Tahan", position: 3, songRev: 7 };
  const snap = glueHarness({ now }).glue.snapshot();
  assert.equal(snap.songRev, 7);
  assert.equal(snap.now, now, "the now block itself goes out as app.js built it");
  assert.equal(glueHarness({ now: null }).glue.snapshot().songRev, 0, "nothing playing → 0");
  for (const junk of [undefined, "7", -1, 1.5, NaN]) {
    assert.equal(glueHarness({ now: { id: "x", songRev: junk } }).glue.snapshot().songRev, 0);
  }
});

test("ref resolves by index when the code matches", () => {
  const catalog = catalogOf(SONGS);
  const { glue, calls } = glueHarness({ catalog });
  glue.applyCommand({ type: "enqueue", by: "Rae", ref: { i: 2, code: 123 }, source: "SH", name: "Barcelona" });
  glue.applyCommand({ type: "enqueue", by: "Rae", ref: { i: 1, code: "123" }, source: "PLATKAR" });   // the code as a string
  assert.deepEqual(calls.map((c) => [c[0], c[1].name, c[2]]), [["enqueue", "Barcelona", "Rae"], ["enqueue", "Beer", "Rae"]]);
  // A blank-code song (a drop-in video) must match its title too: index + "" is too weak alone.
  glue.applyCommand({ type: "enqueue", by: "Rae", ref: { i: 3, code: "" }, name: "Untitled clip" });
  glue.applyCommand({ type: "enqueue", by: "Rae", ref: { i: 3, code: "" }, name: "Something else" });
  assert.deepEqual(calls.slice(2).map((c) => c[1].name), ["Untitled clip"]);
});

test("ref falls back to code lookup when the index drifted", () => {
  const catalog = catalogOf(SONGS);
  const { glue, calls } = glueHarness({ catalog });
  // The phone's copy is older than the host's catalogue: row 0 is no longer a 123.
  glue.applyCommand({ type: "enqueue", by: "Rae", ref: { i: 0, code: 123 }, source: "SH" });
  glue.applyCommand({ type: "enqueue", by: "Rae", ref: { i: 0, code: 123 }, source: "" });          // no songbook → all
  glue.applyCommand({ type: "enqueue", by: "Rae", ref: { i: 9999, code: 100 } });                    // out of range
  assert.deepEqual(calls.map((c) => c[1].name), ["Barcelona", "Beer", "Tahan"]);
  // Junk never resolves to something arbitrary.
  for (const ref of [null, "x", { i: 0 }, { i: 0, code: null }, { i: 0, code: {} }, { i: -1, code: 404 }, { i: "0", code: 404 }, { i: 0, code: NaN }]) {
    glue.applyCommand({ type: "enqueue", by: "Rae", ref, source: { toString: () => "SH" } });
  }
  glue.applyCommand({ type: "enqueue", by: "Rae", ref: { i: 0, code: 123 }, source: "__proto__" });
  assert.equal(calls.length, 3);
});

test("old-style enqueue by id still works", () => {
  const catalog = catalogOf(SONGS);
  const { glue, calls } = glueHarness({ catalog });
  glue.applyCommand({ type: "enqueue", id: catalog.songs[1].id, by: "Rae" });
  // An id wins over a ref that disagrees with it (the id is unambiguous).
  glue.applyCommand({ type: "enqueue", id: catalog.songs[0].id, ref: { i: 2, code: 123 }, by: "Rae" });
  glue.applyCommand({ type: "enqueue", id: "youtube:zz", kind: "youtube", videoId: "zz", name: "T", artist: "C", by: "Rae" });
  assert.deepEqual(calls.slice(0, 2).map((c) => [c[0], c[1].name, c[2]]), [["enqueue", "Beer", "Rae"], ["enqueue", "Tahan", "Rae"]]);
  assert.equal(calls[2][1].kind, "youtube");
  assert.equal(calls[2][1].registered, true, "the YouTube path is unchanged");
});

test("playnow is refused by default and sets a notice", () => {
  const catalog = catalogOf(SONGS);
  const { glue, calls } = glueHarness({ catalog, settings: {} });   // no setting at all → the default (off)
  glue.applyCommand({ type: "playnow", by: "Rae", ref: { i: 0, code: 100 } });
  assert.deepEqual(calls, [["status", "Rae: not allowed by the host"]], "the host's status line, and no playback");
  assert.equal(glue.snapshot().notice, "Rae: not allowed by the host");
  const off = glueHarness({ catalog, settings: { "remote.guestPlayNow": false } });
  off.glue.applyCommand({ type: "playnow", ref: { i: 0, code: 100 } });
  assert.equal(off.glue.snapshot().notice, "A guest: not allowed by the host", "a nameless guest still gets a line");
  assert.equal(off.calls.some((c) => c[0] === "playNow"), false);
});

test("playnow works when the host allows it", () => {
  const catalog = catalogOf(SONGS);
  const { glue, calls } = glueHarness({ catalog, settings: { "remote.guestPlayNow": true } });
  glue.applyCommand({ type: "playnow", by: "x".repeat(40), ref: { i: 2, code: 123 } });
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], "playNow");
  assert.equal(calls[0][1], catalog.songs[2]);
  assert.equal(calls[0][2].length, 24, "the nickname is truncated as for enqueue");
  assert.equal(glue.snapshot().notice, "");
  glue.applyCommand({ type: "playnow", by: "Rae", ref: { i: 0, code: 404 } });
  assert.equal(calls.length, 1, "a song that resolves to nothing plays nothing");
});

test("priority is refused under fair play", () => {
  const catalog = catalogOf(SONGS);
  const on = glueHarness({ catalog, settings: { "remote.guestPriority": true, "queue.fairPlay": true } });
  on.glue.applyCommand({ type: "priority", by: "Rae", ref: { i: 0, code: 100 } });
  assert.deepEqual(on.calls, [["status", "Rae: not allowed by the host"]]);
  assert.equal(on.glue.snapshot().notice, "Rae: not allowed by the host");

  const off = glueHarness({ catalog, settings: { "remote.guestPriority": false } });
  off.glue.applyCommand({ type: "priority", by: "Rae", ref: { i: 0, code: 100 } });
  assert.equal(off.calls[0][0], "status", "turned off by the host");

  const ok = glueHarness({ catalog, settings: {} });   // defaults: priority on, fair play off
  ok.glue.applyCommand({ type: "priority", by: "Rae", ref: { i: 0, code: 100 } });
  assert.deepEqual(ok.calls.map((c) => [c[0], c[1].name, c[2]]), [["playNext", "Tahan", "Rae"]]);
});

test("priority honours the per-guest cap", () => {
  const catalog = catalogOf(SONGS);
  const { glue, calls } = glueHarness({
    catalog, list: [catalog.songs[0], catalog.songs[1]], listBy: ["Rae", "Rae"],
    settings: { "queue.maxPerGuest": 2, "remote.guestPriority": true },
  });
  glue.applyCommand({ type: "priority", by: "Rae", ref: { i: 2, code: 123 } });
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], "status");
  assert.match(calls[0][1], /already has 2 songs reserved/);
  assert.match(glue.snapshot().notice, /already has 2 songs reserved/, "the guest sees why");
  glue.applyCommand({ type: "priority", by: "Mia", ref: { i: 2, code: 123 } });
  assert.equal(calls.at(-1)[0], "playNext", "someone else is unaffected");
});

test("restart and bg delegate", () => {
  const { glue, calls } = glueHarness();
  glue.applyCommand({ type: "restart", by: "Rae" });
  glue.applyCommand({ type: "bg", by: "Rae" });
  assert.deepEqual(calls, [["restart"], ["bgNext"]]);
});

test("M8's live-digit commands are ignored like any unknown type", () => {
  // The phone no longer sends them, but a page cached from before may and the relay still routes
  // them: with every old switch on and a host that still offered digit actions, nothing happens.
  const { glue, calls } = glueHarness({
    settings: { "remote.liveDigits": true, "keypad.enabled": true, "remote.guestPlayNow": true },
    actions: (record) => ({
      digit: record("digit"), digitDelete: record("digitDelete"),
      digitClear: record("digitClear"), digitCommit: record("digitCommit"),
    }),
  });
  for (const type of ["digit", "digit_delete", "digit_clear", "digit_commit"]) {
    glue.applyCommand({ type, d: 1, by: "Rae" });
  }
  assert.deepEqual(calls, []);
  assert.equal(glue.snapshot().notice, "", "and no refusal either");
});

test("snapshot carries songRev and notice", () => {
  const { glue } = glueHarness({ now: { id: "midi:1", songRev: 3 } });
  const snap = glue.snapshot();
  assert.deepEqual(Object.keys(snap).sort(), ["notice", "now", "queue", "room", "settings", "songRev"]);
  assert.equal(snap.room, "ROOM42");
  assert.equal(snap.songRev, 3);
  assert.equal(snap.notice, "");
  // Both ride at the top level of the POST body, where serve.py's _room_host_sync reads them.
  glue.applyCommand({ type: "playnow", by: "Rae", id: "midi:404" });
  assert.equal(glue.snapshot().notice, "Rae: not allowed by the host");
});

test("notice clears after five seconds", () => {
  const h = glueHarness();
  h.glue.applyCommand({ type: "playnow", by: "Rae" });
  h.advance(NOTICE_MS - 1);
  assert.equal(h.glue.snapshot().notice, "Rae: not allowed by the host");
  h.advance(1);
  assert.equal(h.glue.snapshot().notice, "");
  // A new refusal starts its own five seconds.
  h.settings["queue.fairPlay"] = true;
  h.glue.applyCommand({ type: "priority", by: "Mia", ref: { i: 0, code: 1 } });
  assert.equal(h.glue.snapshot().notice, "Mia: not allowed by the host");
  h.advance(NOTICE_MS);
  assert.equal(h.glue.snapshot().notice, "");
});

test("host disallow flags are mirrored but not guest-settable", () => {
  const { glue, calls } = glueHarness({
    settings: {
      "remote.guestPlayNow": false, "remote.guestPriority": true, "queue.fairPlay": true, "remote.push": false,
      "remote.liveDigits": false, "keypad.enabled": true,   // M8's two: no longer mirrored (no phone pad)
      "audio.key": 0, "audio.tempo": 1, "audio.volume": 1, "lyrics.offsetMs": 0, "guide.vocal.mute": false,
    },
  });
  const mirrored = glue.snapshot().settings;
  assert.equal(mirrored["remote.guestPlayNow"], false);
  assert.equal(mirrored["remote.guestPriority"], true);
  assert.equal(mirrored["queue.fairPlay"], true);
  assert.equal(mirrored["remote.push"], false, "the host's Instant-updates switch: false tells phones to poll");
  assert.deepEqual([...REMOTE_READONLY_MIRROR].sort(), ["queue.fairPlay", "remote.guestPlayNow", "remote.guestPriority", "remote.push"]);
  assert.deepEqual(Object.keys(mirrored).sort(), [...REMOTE_SETTABLE, ...REMOTE_READONLY_MIRROR].sort());
  for (const p of ["remote.liveDigits", "keypad.enabled"]) assert.equal(p in mirrored, false, p);

  // Not settable: the allowlist is what it was before M7, plus the melody's level (Rae, 2026-11-25:
  // the phone steps Off · 25 · 50 · 75 · 100 % like the TV).
  assert.deepEqual(REMOTE_SETTABLE_PATHS, ["lyrics.offsetMs", "audio.key", "audio.tempo", "audio.volume", "guide.vocal.mute", "guide.vocal.volume"]);
  for (const p of REMOTE_READONLY_MIRROR) {
    assert.equal(REMOTE_SETTABLE.has(p), false, p);
    assert.equal(clampRemoteSetting(p, true), undefined, p);
    glue.applyCommand({ type: "setting", path: p, value: true });
  }
  assert.deepEqual(calls, [], "a guest cannot switch the host's gates");

  // A flag the host has no boolean for is not mirrored (the phone reads absent as not allowed).
  const bare = glueHarness({ settings: {} }).glue.snapshot().settings;
  for (const p of REMOTE_READONLY_MIRROR) assert.equal(p in bare, false, p);
});

// --- the phone page (structure only: remote.js boots a DOM on import) ----------------------------
test("the phone has no number pad and prints no song numbers", () => {
  const read = (p) => readFileSync(new URL(p, import.meta.url), "utf8");
  const html = read("../src/remote.html");
  const js = read("../src/js/remote.js");
  const css = read("../src/css/remote.css");
  assert.doesNotMatch(html, /r-numpad|>123</, "no 123 toggle, no pad");
  assert.doesNotMatch(js, /ui\/numpad\.js/, "the retired pad module is not imported");
  assert.doesNotMatch(js, /type: "digit/, "no live-digit command is sent");
  assert.doesNotMatch(js, /cmdInOrder|PAD_RESYNC_MS/);
  assert.doesNotMatch(js, /keypad\.enabled|remote\.liveDigits/, "nothing reads the retired mirror entries");
  assert.doesNotMatch(js, /src-chip|el\("span", "code"|#\$\{/, "no dial code, songbook chip or #number on screen");
  assert.doesNotMatch(css, /\.numpad|\.pad-toggle|\.src-chip|\.song \.code|\.song \.num\b/);
  // The number tier stays: digits typed into the field still find songs by number.
  assert.match(js, /orderNumberMatches\(catalog\.lookupCode\(normalizeCode\(q\), "all"\), SOURCES\)/);
});

// --- R13 (review, 2026-11-24): a host request that never settles must not stop the loop --------
test("a hung host POST times out and the next tick posts again (the loop is never wedged)", async () => {
  const relay = fakeRelay();
  const calls = [];
  const signals = [];
  let hang = true;
  const fetchImpl = (url, init) => {
    calls.push(String(url));
    if (!hang) return relay.fetch(url, init);
    // Never answers — unless its signal aborts, as a real fetch does.
    return new Promise((_, reject) => {
      if (init && init.signal) init.signal.addEventListener("abort", () => reject(new DOMException("timed out", "TimeoutError")));
    });
  };
  const h = hostHarness({
    relay,
    options: {
      fetchImpl,
      requestTimeoutMs: 1234,
      timeoutSignal: (ms) => { const c = new AbortController(); signals.push({ ms, c }); return c.signal; },
    },
  });
  h.host.start(); await settle();
  assert.equal(calls.length, 1, "the first POST went out");
  assert.equal(signals.length, 1, "with a timeout signal");
  assert.equal(signals[0].ms, 1234);
  h.timers.fire(); await settle();
  assert.equal(calls.length, 1, "still in flight: no overlapping POST");
  signals[0].c.abort();                // the timeout fires
  await settle();
  hang = false;
  h.timers.fire(); await settle();
  assert.equal(calls.length, 2, "the loop posts again after the timeout");
});

test("the host's requests carry a timeout signal by default (AbortSignal.timeout)", async () => {
  const relay = fakeRelay();
  const seen = [];
  const h = hostHarness({ relay, options: { fetchImpl: (url, init) => { seen.push(init && init.signal); return relay.fetch(url, init); } } });
  h.host.start(); await settle();
  assert.ok(seen[0] instanceof AbortSignal, "the host POST has a signal");
  assert.equal(seen[0].aborted, false);
});
