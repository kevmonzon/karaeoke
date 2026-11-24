/*
 * audiofile-load.test.js — AudioFileEngine.load() when loads overlap (review R2, 2026-11-24): a slow
 * first audio song whose file arrives AFTER a quick second song took the element must not point the
 * element back at itself (silence under the second song's lyrics, a leaked blob URL, a queue that
 * never advances). Node has no Cache Storage, so cachedArrayBuffer() goes straight to fetch(), which
 * the tests hold and release in any order.
 * Run with:  node --test
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { AudioFileEngine } from "../src/js/audiofile.js";

// fetch() that answers only when the test says so, per URL.
function heldFetch() {
  const waiting = new Map();
  const fetchImpl = (url) => new Promise((resolve) => { waiting.set(String(url), resolve); });
  const release = (url, bytes = 4) => {
    const r = waiting.get(url);
    assert.ok(r, `no fetch pending for ${url}`);
    waiting.delete(url);
    r(new Response(new Uint8Array(bytes)));
  };
  return { fetchImpl, release };
}

function fakeEl() {
  const el = {
    src: "", preload: "", volume: 1, playbackRate: 1, preservesPitch: true, currentTime: 0, removed: 0,
    addEventListener() {}, pause() {}, load() {},
    removeAttribute(k) { if (k === "src") { el.src = ""; el.removed++; } },
  };
  return el;
}

// URL.createObjectURL / revokeObjectURL, counted.
function urls() {
  const made = [], revoked = [];
  const saved = { create: URL.createObjectURL, revoke: URL.revokeObjectURL };
  URL.createObjectURL = () => { const u = `blob:test/${made.length + 1}`; made.push(u); return u; };
  URL.revokeObjectURL = (u) => { revoked.push(u); };
  return { made, revoked, restore() { URL.createObjectURL = saved.create; URL.revokeObjectURL = saved.revoke; } };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

test("a load that finishes after a newer one leaves the element to the newer one, and makes no URL", async () => {
  const f = heldFetch();
  const u = urls();
  const savedFetch = globalThis.fetch;
  globalThis.fetch = f.fetchImpl;
  try {
    const el = fakeEl();
    const eng = new AudioFileEngine(el, {});
    const a = eng.load("/audio_lyrics/a.mp3");   // slow
    const b = eng.load("/audio_lyrics/b.mp3");   // quick
    f.release("/audio_lyrics/b.mp3");
    await b;
    assert.equal(el.src, "blob:test/1", "B owns the element");
    f.release("/audio_lyrics/a.mp3");
    await a;
    await tick();
    assert.equal(el.src, "blob:test/1", "A's late file did not take the element back");
    assert.deepEqual(u.made, ["blob:test/1"], "no blob URL was made for the superseded load (nothing to leak)");
    // B's URL is still alive (only revoked when B is replaced or unloaded)
    assert.deepEqual(u.revoked, []);
  } finally {
    globalThis.fetch = savedFetch;
    u.restore();
  }
});

test("unload() while a file is on its way: the late file does not reattach itself", async () => {
  const f = heldFetch();
  const u = urls();
  const savedFetch = globalThis.fetch;
  globalThis.fetch = f.fetchImpl;
  try {
    const el = fakeEl();
    const eng = new AudioFileEngine(el, {});
    const a = eng.load("/audio_lyrics/a.mp3");
    eng.unload();                                // switching to a MIDI / video song
    f.release("/audio_lyrics/a.mp3");
    await a;
    await tick();
    assert.equal(el.src, "", "the element stays empty");
    assert.deepEqual(u.made, []);
  } finally {
    globalThis.fetch = savedFetch;
    u.restore();
  }
});

test("a single load still points the element at its blob, and the next load frees the old one", async () => {
  const f = heldFetch();
  const u = urls();
  const savedFetch = globalThis.fetch;
  globalThis.fetch = f.fetchImpl;
  try {
    const el = fakeEl();
    const eng = new AudioFileEngine(el, {});
    const a = eng.load("/audio_lyrics/a.mp3");
    f.release("/audio_lyrics/a.mp3");
    await a;
    assert.equal(el.src, "blob:test/1");
    const b = eng.load("/audio_lyrics/b.mp3");
    assert.deepEqual(u.revoked, ["blob:test/1"], "the old blob is freed as the next load starts");
    f.release("/audio_lyrics/b.mp3");
    await b;
    assert.equal(el.src, "blob:test/2");
  } finally {
    globalThis.fetch = savedFetch;
    u.restore();
  }
});
