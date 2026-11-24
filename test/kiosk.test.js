/*
 * kiosk.test.js — the kiosk Exit button (src/js/kiosk.js, Rae 2026-11-25).
 *
 *   1. Who may see it: only a loopback page, and only when GET /api/kiosk says canQuit; any
 *      doubt (a failed fetch, a bad reply) keeps it hidden.
 *   2. What it does: it asks first; Cancel sends nothing; Exit POSTs /api/quit, then stops
 *      the stage and tries to close the window; a refusal is reported, not swallowed; a
 *      second press while the first is still out does nothing.
 * Run with:  node --test
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { isLoopbackHost, canQuit, requestQuit, setupKioskQuit, QUIT_CONFIRM } from "../src/js/kiosk.js";

/** A fetch that answers from `routes` (path → {status, body}) and records every call. */
function fakeFetch(routes) {
  const calls = [];
  const fn = async (url, opts = {}) => {
    calls.push({ url, ...opts });
    const r = routes[url];
    if (!r) throw new Error(`no route ${url}`);
    if (r instanceof Error) throw r;
    return { ok: r.status >= 200 && r.status < 300, status: r.status, json: async () => r.body };
  };
  fn.calls = calls;
  return fn;
}

function fakeButton() {
  return {
    hidden: true,
    click: null,
    addEventListener(type, fn) { if (type === "click") this.click = fn; },
  };
}

const KIOSK = { "/api/kiosk": { status: 200, body: { ok: true, kiosk: true, canQuit: true } } };

test("isLoopbackHost: this machine's names only", () => {
  for (const h of ["localhost", "LOCALHOST", "127.0.0.1", "127.1.2.3", "::1", "[::1]"]) assert.equal(isLoopbackHost(h), true, h);
  for (const h of ["", undefined, "192.168.1.20", "10.42.0.1", "abc.trycloudflare.com", "localhost.evil.com", "127.0.0.1.nip.io"]) {
    assert.equal(isLoopbackHost(h), false, String(h));
  }
});

test("canQuit: a LAN or tunnel page never even asks the server", async () => {
  const f = fakeFetch(KIOSK);
  assert.equal(await canQuit({ fetchFn: f, hostname: "192.168.1.20" }), false);
  assert.equal(await canQuit({ fetchFn: f, hostname: "abc.trycloudflare.com" }), false);
  assert.equal(f.calls.length, 0);
});

test("canQuit: true only on an explicit canQuit:true", async () => {
  assert.equal(await canQuit({ fetchFn: fakeFetch(KIOSK), hostname: "localhost" }), true);
  const no = { "/api/kiosk": { status: 200, body: { ok: true, kiosk: false, canQuit: false } } };
  assert.equal(await canQuit({ fetchFn: fakeFetch(no), hostname: "localhost" }), false);
  const truthy = { "/api/kiosk": { status: 200, body: { ok: true, canQuit: "yes" } } };
  assert.equal(await canQuit({ fetchFn: fakeFetch(truthy), hostname: "localhost" }), false);
  // an older serve.py without the route answers 404 (static handler) → hidden
  assert.equal(await canQuit({ fetchFn: fakeFetch({ "/api/kiosk": { status: 404, body: null } }), hostname: "localhost" }), false);
  assert.equal(await canQuit({ fetchFn: fakeFetch({ "/api/kiosk": new Error("offline") }), hostname: "localhost" }), false);
});

test("requestQuit: POSTs JSON, rejects with the server's reason", async () => {
  const ok = fakeFetch({ "/api/quit": { status: 200, body: { ok: true } } });
  assert.equal(await requestQuit({ fetchFn: ok }), true);
  assert.equal(ok.calls[0].method, "POST");
  assert.equal(ok.calls[0].headers["Content-Type"], "application/json");
  const refused = fakeFetch({ "/api/quit": { status: 403, body: { ok: false, error: "only the kiosk screen can quit" } } });
  await assert.rejects(requestQuit({ fetchFn: refused }), /only the kiosk screen can quit/);
  await assert.rejects(requestQuit({ fetchFn: fakeFetch({ "/api/quit": { status: 404, body: null } }) }), /HTTP 404/);
});

test("setupKioskQuit: the button stays hidden when this page may not quit", async () => {
  const button = fakeButton();
  const shown = await setupKioskQuit({ button, confirm: async () => true, fetchFn: fakeFetch(KIOSK), hostname: "10.42.0.1" });
  assert.equal(shown, false);
  assert.equal(button.hidden, true);
  assert.equal(button.click, null);
});

/** The button shown and wired on a kiosk page; `quit` = the /api/quit reply. */
async function wired({ answer = true, quit = { status: 200, body: { ok: true } } } = {}) {
  const button = fakeButton();
  const log = [];
  const f = fakeFetch({ ...KIOSK, "/api/quit": quit });
  const shown = await setupKioskQuit({
    button,
    fetchFn: f,
    hostname: "localhost",
    confirm: async (opts, openOpts) => { log.push(["confirm", opts, openOpts]); return answer; },
    onStopped: () => log.push(["stopped"]),
    onError: (msg) => log.push(["error", msg]),
    closeWindow: () => log.push(["close"]),
  });
  return { button, log, f, shown };
}

test("setupKioskQuit: Exit asks, then quits, stops the stage and closes the window", async () => {
  const { button, log, f, shown } = await wired();
  assert.equal(shown, true);
  assert.equal(button.hidden, false);
  await button.click();
  assert.deepEqual(log.map((e) => e[0]), ["confirm", "stopped", "close"]);
  assert.deepEqual(log[0][1], { ...QUIT_CONFIRM });
  assert.equal(log[0][2].opener, button, "focus goes back to the button on Cancel");
  assert.deepEqual(f.calls.map((c) => [c.url, c.method || "GET"]), [["/api/kiosk", "GET"], ["/api/quit", "POST"]]);
});

test("setupKioskQuit: Cancel sends nothing", async () => {
  const { button, log, f } = await wired({ answer: false });
  await button.click();
  assert.deepEqual(log.map((e) => e[0]), ["confirm"]);
  assert.equal(f.calls.filter((c) => c.url === "/api/quit").length, 0);
});

test("setupKioskQuit: a refused quit is reported and the app keeps running", async () => {
  const { button, log } = await wired({ quit: { status: 403, body: { ok: false, error: "only the kiosk screen can quit" } } });
  await button.click();
  assert.deepEqual(log.map((e) => e[0]), ["confirm", "error"]);
  assert.match(log[1][1], /^Couldn't exit: only the kiosk screen can quit$/);
  // and the button works again afterwards
  await button.click();
  assert.equal(log.filter((e) => e[0] === "confirm").length, 2);
});

test("setupKioskQuit: a second press while the dialog is open does nothing", async () => {
  const button = fakeButton();
  const pending = [];   // every dialog still open — all answered at the end, so nothing hangs
  await setupKioskQuit({
    button,
    fetchFn: fakeFetch({ ...KIOSK, "/api/quit": { status: 200, body: { ok: true } } }),
    hostname: "127.0.0.1",
    confirm: () => new Promise((r) => { pending.push(r); }),
  });
  const first = button.click();
  const second = button.click();
  const asked = pending.length;
  for (const r of pending) r(false);
  await Promise.all([first, second]);
  assert.equal(asked, 1);
});
