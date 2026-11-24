/*
 * backgrounds.test.js — the background layer (M11, plan §5.22, src/js/backgrounds.js): the pure rules
 * (resolveMode, shouldShow, filterCategory, shuffled, mirrorFor) and the player against a small fake
 * DOM / navigator / window: the camera's permission rules (never prompt without a gesture, R27), one
 * background <video> at most (the decoder budget), tracks stopped on a switch, a hidden tab, the dim,
 * the photo pair, song changes.
 *
 * The fakes carry only the surface the module uses: createElement, className, set/get/removeAttribute,
 * appendChild / insertBefore / removeChild, parentNode, addEventListener, style.setProperty,
 * textContent; media play/pause/load/paused/src/srcObject; img decode(); body.dataset; document.hidden +
 * visibilitychange; navigator.permissions.query + mediaDevices.getUserMedia; window.isSecureContext +
 * setTimeout/clearTimeout (timers run by hand). innerHTML is a trap.
 * Run with:  node --test
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  resolveMode, shouldShow, filterCategory, shuffled, mirrorFor, createBackgrounds,
} from "../src/js/backgrounds.js";

// --- a minimal fake DOM ---------------------------------------------------------------------
class Node {
  constructor(doc, tag) {
    Object.assign(this, { doc, tagName: tag.toUpperCase(), className: "", attrs: new Map(), children: [],
      parentNode: null, ls: {}, textContent: "" });
    const props = new Map();
    this.style = { props, setProperty: (k, v) => props.set(k, String(v)), getPropertyValue: (k) => props.get(k) ?? "" };
  }
  set innerHTML(_) { throw new Error("innerHTML must not be used"); }
  setAttribute(k, v) { this.attrs.set(k, String(v)); }
  getAttribute(k) { return this.attrs.has(k) ? this.attrs.get(k) : null; }
  hasAttribute(k) { return this.attrs.has(k); }
  removeAttribute(k) { this.attrs.delete(k); }
  has(c) { return this.className.split(/\s+/).includes(c); }
  appendChild(c) { if (c.parentNode) c.parentNode.removeChild(c); c.parentNode = this; this.children.push(c); return c; }
  insertBefore(c, ref) {
    if (!ref) return this.appendChild(c);
    const i = this.children.indexOf(ref);
    if (i < 0) throw new Error("insertBefore: ref is not a child");
    if (c.parentNode) c.parentNode.removeChild(c);
    c.parentNode = this; this.children.splice(this.children.indexOf(ref), 0, c); return c;
  }
  removeChild(c) {
    const i = this.children.indexOf(c);
    if (i < 0) throw new Error("removeChild: not a child");
    this.children.splice(i, 1); c.parentNode = null; return c;
  }
  addEventListener(t, fn, opts) { (this.ls[t] ||= []).push({ fn, once: !!(opts && opts.once) }); }
  fire(type) {
    const ev = { type, target: this };
    for (const l of [...(this.ls[type] || [])]) { if (l.once) this.ls[type] = this.ls[type].filter((x) => x !== l); l.fn(ev); }
    return ev;
  }
  click() { return this.fire("click"); }
  q(cls) { return this.children.filter((c) => c.has(cls)); }
}
class Media extends Node {
  constructor(doc, tag) { super(doc, tag); Object.assign(this, { paused: true, muted: false, srcObject: null, _src: "", plays: 0, pauses: 0, loads: 0 }); }
  get src() { return this._src; }
  set src(v) { this._src = String(v); this.attrs.set("src", String(v)); }
  removeAttribute(k) { super.removeAttribute(k); if (k === "src") this._src = ""; }
  play() { this.plays++; this.paused = false; return Promise.resolve(); }
  pause() { this.pauses++; this.paused = true; }
  load() { this.loads++; }
}
class Img extends Node {
  constructor(doc, tag) { super(doc, tag); this.src = ""; }
  decode() { return this.doc.badUrls.has(this.src) ? Promise.reject(new Error("EncodingError")) : Promise.resolve(); }
}
function makeDoc() {
  const doc = { hidden: false, body: { dataset: {} }, ls: {}, created: [], badUrls: new Set() };
  doc.createElement = (tag) => {
    const t = tag.toLowerCase();
    const n = t === "video" ? new Media(doc, t) : t === "img" ? new Img(doc, t) : new Node(doc, t);
    doc.created.push(n);
    return n;
  };
  doc.addEventListener = (t, fn) => { (doc.ls[t] ||= []).push(fn); };
  doc.setHidden = (h) => { doc.hidden = h; for (const fn of doc.ls.visibilitychange || []) fn({ type: "visibilitychange" }); };
  return doc;
}
// --- end of the fake DOM --------------------------------------------------------------------

function fakeStream(facing, reported) {
  const track = {
    kind: "video", readyState: "live", stops: 0, ls: [],
    stop() { this.readyState = "ended"; this.stops++; },
    getSettings: () => (reported ? { facingMode: reported } : {}),
    addEventListener(t, fn) { if (t === "ended") this.ls.push(fn); },
    endOnItsOwn() { this.readyState = "ended"; for (const fn of this.ls) fn({ type: "ended" }); },
  };
  return { facing, track, getTracks: () => [track], getVideoTracks: () => [track] };
}
/** permission: what permissions.query answers; queryThrows: Firefox's TypeError; gumError: a rejection. */
function makeNav({ permission = "prompt", queryThrows = false, gumError = null, reported = "" } = {}) {
  const nav = { queries: 0, gum: [], streams: [], deferred: null };
  nav.permissions = {
    query: (d) => {
      nav.queries++;
      if (queryThrows) throw new TypeError(`'${d.name}' is not a valid PermissionName`);
      if (nav.holdQuery) return new Promise((res) => { nav.releaseQuery = () => res({ state: permission }); });
      return Promise.resolve({ state: permission });
    },
  };
  nav.mediaDevices = {
    getUserMedia: (c) => {
      nav.gum.push(c);
      // A runaway restart loop is a failed assertion, not an out-of-memory crash.
      if (nav.gum.length > 25) return Promise.reject(Object.assign(new Error("runaway"), { name: "AbortError" }));
      if (gumError) return Promise.reject(gumError);
      const s = fakeStream(c.video.facingMode, reported);
      nav.streams.push(s);
      if (nav.hold) return new Promise((res) => { nav.deferred = () => res(s); });
      return Promise.resolve(s);
    },
  };
  return nav;
}
function makeWin({ secure = true } = {}) {
  const win = { isSecureContext: secure, timers: new Map(), seq: 0 };
  win.setTimeout = (fn, ms) => { const id = ++win.seq; win.timers.set(id, { fn, ms }); return id; };
  win.clearTimeout = (id) => { win.timers.delete(id); };
  win.runTimers = () => { const all = [...win.timers]; win.timers.clear(); for (const [, t] of all) t.fn(); };
  return win;
}
const LIST = {
  ok: true,
  videos: [{ url: "/bgv/party/a.mp4", category: "party" }, { url: "/bgv/b.mp4", category: "" }, { url: "/bgv/party/c.webm", category: "party" }],
  photos: [{ url: "/bgphoto/beach/x.jpg", category: "beach" }, { url: "/bgphoto/beach/y.png", category: "beach" }, { url: "/bgphoto/z.webp", category: "" }],
  categories: { videos: ["party"], photos: ["beach"] },
};
const EMPTY = { ok: true, videos: [], photos: [], categories: { videos: [], photos: [] } };
const DEFAULTS = {
  "bg.mode": "auto", "bg.category": "all", "bg.dim": 0.35, "bg.changeOnSong": true, "bg.photo.intervalSec": 8,
  "bg.photo.animation": "fade", "bg.camera.facing": "environment", "bg.camera.mirror": "auto",
};
const flush = () => new Promise((r) => setImmediate(r));

function setup({ over = {}, list = LIST, nav, win, fetchList } = {}) {
  const doc = makeDoc();
  const layer = new Node(doc, "div");
  layer.className = "bg-layer"; layer.setAttribute("aria-hidden", "true");
  const values = { ...DEFAULTS, ...over };
  const settings = { values, get: (p) => values[p] };
  const statuses = [];
  const n = nav || makeNav();
  const w = win || makeWin();
  const bg = createBackgrounds({
    el: layer, settings, fetchList: fetchList || (() => Promise.resolve(list)), onStatus: (t) => statuses.push(t),
    doc, nav: n, win: w,
  });
  const videos = () => layer.children.filter((c) => c.tagName === "VIDEO");
  return { doc, layer, settings, values, statuses, nav: n, win: w, bg, videos };
}

// --- pure rules ------------------------------------------------------------------------------

const V = [{ url: "/bgv/a.mp4", category: "" }];
const P = [{ url: "/bgphoto/a.jpg", category: "" }];

test("auto prefers videos", () => {
  assert.equal(resolveMode("auto", { videos: V, photos: P }), "video");
  assert.equal(resolveMode("auto", { videos: V, photos: [] }), "video");
});

test("auto falls to photos", () => {
  assert.equal(resolveMode("auto", { videos: [], photos: P }), "photo");
  assert.equal(resolveMode("auto", { photos: P }), "photo", "a missing videos list counts as empty");
});

test("auto with nothing is off", () => {
  assert.equal(resolveMode("auto", { videos: [], photos: [] }), "off");
  assert.equal(resolveMode("auto"), "off");
  assert.equal(resolveMode("auto", { videos: null, photos: "x" }), "off", "non-arrays count as empty");
});

test("an explicit mode with no media is off", () => {
  assert.equal(resolveMode("video", { videos: [], photos: P }), "off", "photos do not stand in for videos");
  assert.equal(resolveMode("photo", { videos: V, photos: [] }), "off", "videos do not stand in for photos");
  assert.equal(resolveMode("video", { videos: V }), "video");
  assert.equal(resolveMode("photo", { photos: P }), "photo");
  for (const m of ["off", "", undefined, null, "videos", "Camera", "__proto__", "constructor", 1]) {
    assert.equal(resolveMode(m, { videos: V, photos: P }), "off", `mode ${String(m)}`);
  }
});

test("camera is never chosen by auto", () => {
  for (const lists of [{ videos: [], photos: [] }, { videos: V, photos: [] }, { videos: [], photos: P }]) {
    assert.notEqual(resolveMode("auto", lists), "camera");
  }
  assert.equal(resolveMode("camera", { videos: V, photos: P }), "camera", "an explicit camera stays camera");
  assert.equal(resolveMode("camera", { videos: [], photos: [] }), "camera", "the camera needs no media");
});

test("shown for midi, audio and idle", () => {
  assert.equal(shouldShow("midi", false), true);
  assert.equal(shouldShow("audio", false), true);
  for (const k of [undefined, "", "midi", "video", "youtube"]) assert.equal(shouldShow(k, true), true, `idle with ${k}`);
});

test("hidden for video and youtube", () => {
  assert.equal(shouldShow("video", false), false);
  assert.equal(shouldShow("youtube", false), false);
  for (const k of [undefined, null, "", "MIDI", "karaoke"]) assert.equal(shouldShow(k, false), false, `unknown kind ${k}`);
});

test("category filter", () => {
  const items = LIST.videos;
  const all = filterCategory(items, "all");
  assert.deepEqual(all, items);
  assert.notEqual(all, items, "a fresh array");
  assert.deepEqual(filterCategory(items, ""), items, "empty → all");
  assert.deepEqual(filterCategory(items, undefined), items, "missing → all");
  assert.deepEqual(filterCategory(items, "party").map((i) => i.url), ["/bgv/party/a.mp4", "/bgv/party/c.webm"]);
  assert.deepEqual(filterCategory(items, "nope"), []);
  assert.deepEqual(filterCategory(null, "all"), []);
  assert.deepEqual(filterCategory([null, { url: "/x", category: "party" }], "party"), [{ url: "/x", category: "party" }]);
});

test("shuffle is a permutation", () => {
  for (const n of [0, 1, 2, 3, 7, 50]) {
    for (let k = 0; k < 20; k++) {
      const p = shuffled(n);
      assert.equal(p.length, n);
      assert.deepEqual([...p].sort((a, b) => a - b), Array.from({ length: n }, (_, i) => i), `n=${n}`);
    }
  }
  for (const bad of [-1, 2.5, NaN, "3", undefined]) assert.deepEqual(shuffled(bad), [], `n=${String(bad)}`);
  // a misbehaving rand still yields a permutation
  for (const rand of [() => 1, () => 7, () => -3, () => NaN]) {
    assert.deepEqual([...shuffled(6, rand)].sort((a, b) => a - b), [0, 1, 2, 3, 4, 5]);
  }
});

test("shuffle with an injected random is deterministic", () => {
  // rand() = 0 always picks j = 0: [0,1,2,3] → swap(3,0) [3,1,2,0] → swap(2,0) [2,1,3,0] → swap(1,0) [1,2,3,0]
  assert.deepEqual(shuffled(4, () => 0), [1, 2, 3, 0]);
  // rand() just under 1 always picks j = i: no swaps
  assert.deepEqual(shuffled(5, () => 0.999999), [0, 1, 2, 3, 4]);
  const lcg = (seed) => () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
  assert.deepEqual(shuffled(30, lcg(42)), shuffled(30, lcg(42)), "same seed, same order");
  assert.notDeepEqual(shuffled(30, lcg(42)), shuffled(30, lcg(7)), "another seed, another order");
});

test("front camera mirrors on auto", () => {
  assert.equal(mirrorFor("user", "auto"), true);
  assert.equal(mirrorFor("environment", "auto"), false);
  assert.equal(mirrorFor("user", undefined), true, "a missing setting is auto");
  assert.equal(mirrorFor(undefined, "auto"), false);
});

test("explicit mirror setting wins", () => {
  assert.equal(mirrorFor("environment", "on"), true);
  assert.equal(mirrorFor("user", "off"), false);
  assert.equal(mirrorFor("user", "on"), true);
  assert.equal(mirrorFor("environment", "off"), false);
});

// --- the camera -----------------------------------------------------------------------------

test("camera at boot without a granted permission waits for a tap", async () => {
  const s = setup({ over: { "bg.mode": "camera" }, nav: makeNav({ permission: "prompt" }) });
  await s.bg.init();
  await flush();
  assert.equal(s.nav.queries, 1, "asked the permission");
  assert.equal(s.nav.gum.length, 0, "getUserMedia NOT called without a gesture");
  assert.equal(s.bg.state.camera, "needs-tap");
  assert.equal(s.bg.state.mode, "camera");
  const btn = s.layer.q("bg-camera-start");
  assert.equal(btn.length, 1);
  assert.equal(btn[0].tagName, "BUTTON");
  assert.equal(btn[0].textContent, "Tap to start camera");
  assert.equal(btn[0].getAttribute("type"), "button");
  assert.ok(s.layer.hasAttribute("data-tap"), "the layer rises so the button can be tapped");
  assert.equal(s.layer.getAttribute("aria-hidden"), null, "the button is not hidden from assistive tech");
  assert.equal(s.doc.body.dataset.bg, "off", "no picture yet");
  // settings churn (a dim change) neither re-asks nor prompts
  s.values["bg.dim"] = 0.5; s.bg.applySettings();
  await flush();
  assert.equal(s.nav.queries, 1); assert.equal(s.nav.gum.length, 0);
  assert.equal(s.layer.q("bg-camera-start").length, 1);
  // the tap is the gesture
  btn[0].click();
  assert.equal(s.nav.gum.length, 1, "called inside the click");
  assert.deepEqual(s.nav.gum[0], { video: { facingMode: "environment" }, audio: false });
  await flush();
  assert.equal(s.bg.state.camera, "on");
  assert.equal(s.layer.q("bg-camera-start").length, 0, "the button is gone");
  assert.equal(s.layer.hasAttribute("data-tap"), false);
  assert.equal(s.layer.getAttribute("aria-hidden"), "true");
  assert.equal(s.layer.q("bg-camera").length, 1);
});

test("camera at boot: a permission query that throws (Firefox) also waits for a tap", async () => {
  const s = setup({ over: { "bg.mode": "camera" }, nav: makeNav({ queryThrows: true }) });
  await s.bg.init();
  await flush();
  assert.equal(s.nav.gum.length, 0);
  assert.equal(s.bg.state.camera, "needs-tap");
  const nav2 = makeNav(); delete nav2.permissions;
  const t = setup({ over: { "bg.mode": "camera" }, nav: nav2 });
  await t.bg.init(); await flush();
  assert.equal(t.nav.gum.length, 0, "no Permissions API at all: no prompt either");
  assert.equal(t.bg.state.camera, "needs-tap");
});

test("camera: picking Camera while the boot-time permission query is still out asks the browser at once", async () => {
  const nav = makeNav({ permission: "prompt" });
  nav.holdQuery = true;
  const s = setup({ over: { "bg.mode": "camera" }, nav });
  await s.bg.init();
  assert.equal(s.nav.queries, 1);
  assert.equal(s.nav.gum.length, 0);
  s.bg.applySettings({ gesture: true });
  assert.equal(s.nav.gum.length, 1, "the gesture is not swallowed by the pending query");
  s.nav.releaseQuery(); await flush();
  assert.equal(s.bg.state.camera, "on", "the stale 'prompt' answer is ignored");
  assert.equal(s.layer.q("bg-camera-start").length, 0);
  assert.equal(s.nav.gum.length, 1);
});

test("camera at boot with a granted permission starts", async () => {
  const s = setup({ over: { "bg.mode": "camera" }, nav: makeNav({ permission: "granted" }) });
  await s.bg.init();
  await flush();
  assert.equal(s.nav.gum.length, 1);
  assert.deepEqual(s.nav.gum[0], { video: { facingMode: "environment" }, audio: false });
  assert.equal(s.bg.state.camera, "on");
  assert.equal(s.bg.state.mode, "camera");
  const cams = s.layer.q("bg-camera");
  assert.equal(cams.length, 1);
  const v = cams[0];
  assert.equal(v.tagName, "VIDEO");
  assert.equal(v.srcObject, s.nav.streams[0]);
  for (const a of ["muted", "playsinline", "autoplay"]) assert.ok(v.hasAttribute(a), a);
  assert.equal(v.muted, true);
  assert.equal(v.has("bg-mirror"), false, "the back camera is not mirrored on auto");
  assert.equal(s.layer.q("bg-dim").length, 1);
  assert.equal(s.doc.body.dataset.bg, "on");
  assert.equal(s.layer.q("bg-camera-start").length, 0);
  // a second applySettings with nothing changed keeps the same stream
  s.bg.applySettings(); await flush();
  assert.equal(s.nav.gum.length, 1);
  assert.equal(s.nav.streams[0].track.readyState, "live");
});

test("camera: the front camera is mirrored on auto, the setting wins, a mirror change needs no restart", async () => {
  const s = setup({ over: { "bg.mode": "camera", "bg.camera.facing": "user" }, nav: makeNav({ permission: "granted" }) });
  await s.bg.init(); await flush();
  assert.equal(s.nav.gum[0].video.facingMode, "user");
  assert.ok(s.layer.q("bg-camera")[0].has("bg-mirror"));
  s.values["bg.camera.mirror"] = "off"; s.bg.applySettings(); await flush();
  assert.equal(s.layer.q("bg-camera")[0].has("bg-mirror"), false);
  assert.equal(s.nav.gum.length, 1, "no restart for a mirror change");
  // facing change while live → one direct restart, the old track stopped first
  s.values["bg.camera.mirror"] = "auto"; s.values["bg.camera.facing"] = "environment"; s.bg.applySettings(); await flush();
  assert.equal(s.nav.gum.length, 2);
  assert.equal(s.nav.gum[1].video.facingMode, "environment");
  assert.equal(s.nav.streams[0].track.readyState, "ended");
  assert.equal(s.layer.q("bg-camera").length, 1);
  assert.equal(s.layer.q("bg-camera")[0].has("bg-mirror"), false);
});

test("camera: a reported facing (a laptop webcam answering 'environment' as 'user') drives the mirror, not a restart", async () => {
  const s = setup({ over: { "bg.mode": "camera" }, nav: makeNav({ permission: "granted", reported: "user" }) });
  await s.bg.init(); await flush();
  assert.ok(s.layer.q("bg-camera")[0].has("bg-mirror"));
  s.bg.applySettings(); s.bg.onSongChange("midi", false); await flush();
  assert.equal(s.nav.gum.length, 1, "asked 'environment', got 'user': no restart loop");
});

test("camera: a getUserMedia rejection → blocked, mode off, one status, no retry", async () => {
  const err = Object.assign(new Error("denied"), { name: "NotAllowedError" });
  const s = setup({ over: { "bg.mode": "camera" }, nav: makeNav({ permission: "granted", gumError: err }) });
  await s.bg.init(); await flush();
  assert.equal(s.nav.gum.length, 1);
  assert.equal(s.bg.state.camera, "blocked");
  assert.equal(s.bg.state.mode, "off");
  assert.equal(s.statuses.length, 1);
  assert.match(s.statuses[0], /blocked/i);
  assert.equal(s.layer.children.length, 0, "nothing left in the layer");
  assert.equal(s.doc.body.dataset.bg, "off");
  // every non-gesture path leaves it alone: settings churn, songs, the tab coming back, a refresh
  s.bg.applySettings(); s.bg.applySettings({}); s.bg.onSongChange("midi", false); s.bg.onSongChange("", true);
  s.doc.setHidden(true); s.doc.setHidden(false);
  await s.bg.init(); await flush();
  assert.equal(s.nav.gum.length, 1, "never re-prompts on its own");
  assert.equal(s.statuses.length, 1, "onStatus once");
  assert.equal(s.bg.state.camera, "blocked");
  // the user picking Camera again is a new, explicit try
  s.bg.applySettings({ gesture: true });
  assert.equal(s.nav.gum.length, 2);
  await flush();
  assert.equal(s.statuses.length, 2);
});

test("camera: insecure → 'insecure' and nothing called", async () => {
  const s = setup({ over: { "bg.mode": "camera" }, win: makeWin({ secure: false }), nav: makeNav({ permission: "granted" }) });
  await s.bg.init(); await flush();
  s.bg.applySettings({ gesture: true }); await flush();
  assert.equal(s.bg.state.camera, "insecure");
  assert.equal(s.bg.state.mode, "off");
  assert.equal(s.nav.queries, 0);
  assert.equal(s.nav.gum.length, 0);
  assert.equal(s.statuses.length, 0);
  assert.equal(s.layer.children.length, 0);
});

test("camera: switching away stops the tracks — also a stream that arrives after the switch", async () => {
  const s = setup({ over: { "bg.mode": "camera" }, nav: makeNav({ permission: "granted" }) });
  await s.bg.init(); await flush();
  const first = s.nav.streams[0];
  assert.equal(first.track.readyState, "live");
  s.values["bg.mode"] = "video"; s.bg.applySettings(); await flush();
  assert.equal(first.track.readyState, "ended", "tracks stopped");
  assert.equal(s.layer.q("bg-camera").length, 0);
  assert.equal(s.bg.state.camera, "off");
  assert.equal(s.bg.state.mode, "video");
  // a slow getUserMedia: the user picks Camera, then Videos before the browser answers
  s.nav.hold = true;
  s.values["bg.mode"] = "camera"; s.bg.applySettings({ gesture: true });
  s.values["bg.mode"] = "video"; s.bg.applySettings();
  s.nav.deferred(); await flush();
  const late = s.nav.streams[1];
  assert.equal(late.track.readyState, "ended", "a late stream is stopped on arrival");
  assert.equal(s.layer.q("bg-camera").length, 0);
  assert.equal(s.videos().length, 1, "still exactly the one background video");
});

test("camera: a track that ends on its own (unplugged, revoked) → blocked, one status, no re-prompt", async () => {
  const s = setup({ over: { "bg.mode": "camera" }, nav: makeNav({ permission: "granted" }) });
  await s.bg.init(); await flush();
  s.nav.streams[0].track.endOnItsOwn();
  assert.equal(s.bg.state.camera, "blocked");
  assert.equal(s.bg.state.mode, "off");
  assert.equal(s.statuses.length, 1);
  s.bg.applySettings(); await flush();
  assert.equal(s.nav.gum.length, 1);
});

test("camera: a hidden tab stops it; the return goes back through the permission query", async () => {
  const s = setup({ over: { "bg.mode": "camera" }, nav: makeNav({ permission: "granted" }) });
  await s.bg.init(); await flush();
  s.doc.setHidden(true);
  assert.equal(s.nav.streams[0].track.readyState, "ended");
  assert.equal(s.layer.q("bg-camera").length, 0);
  assert.equal(s.nav.queries, 1);
  s.doc.setHidden(false); await flush();
  assert.equal(s.nav.queries, 2, "asked again, no direct prompt");
  assert.equal(s.nav.gum.length, 2);
  assert.equal(s.bg.state.camera, "on");
});

test("camera: hidden for a video song (tracks stopped), back for a MIDI song", async () => {
  const s = setup({ over: { "bg.mode": "camera" }, nav: makeNav({ permission: "granted" }) });
  await s.bg.init(); await flush();
  s.bg.onSongChange("video", false);
  assert.equal(s.nav.streams[0].track.readyState, "ended");
  assert.equal(s.layer.children.length, 0);
  s.bg.onSongChange("midi", false); await flush();
  assert.equal(s.bg.state.camera, "on");
  assert.equal(s.layer.q("bg-camera").length, 1);
});

// --- videos and photos ------------------------------------------------------------------------

test("auto shows ONE looping muted video that fills the layer, under a dim", async () => {
  const s = setup();
  await s.bg.init();
  assert.equal(s.bg.state.mode, "video");
  assert.equal(s.bg.state.count, 3);
  const vids = s.videos();
  assert.equal(vids.length, 1);
  const v = vids[0];
  assert.ok(v.has("bg-video"));
  for (const a of ["muted", "loop", "playsinline"]) assert.ok(v.hasAttribute(a), a);
  assert.equal(v.muted, true);
  assert.ok(LIST.videos.some((i) => i.url === v.src), v.src);
  assert.equal(LIST.videos[s.bg.state.index].url, v.src, "state.index names the clip on screen");
  assert.equal(v.paused, false, "playing");
  const dim = s.layer.q("bg-dim");
  assert.equal(dim.length, 1);
  assert.equal(s.layer.children.indexOf(v) < s.layer.children.indexOf(dim[0]), true, "the dim is above the clip");
  assert.equal(s.layer.style.getPropertyValue("--bg-dim"), "0.35");
  assert.equal(s.doc.body.dataset.bg, "on");
  assert.deepEqual(s.bg.list.categories, { videos: ["party"], photos: ["beach"] });
  // a dim change only moves the dim: same element, same clip
  const src = v.src;
  s.values["bg.dim"] = 0.8; s.bg.applySettings();
  assert.equal(s.layer.style.getPropertyValue("--bg-dim"), "0.8");
  assert.equal(s.videos()[0], v); assert.equal(v.src, src);
});

test("no media and default settings: the layer stays empty and body[data-bg] is off", async () => {
  const s = setup({ list: EMPTY });
  await s.bg.init();
  assert.equal(s.bg.state.mode, "off");
  assert.equal(s.layer.children.length, 0);
  assert.equal(s.doc.body.dataset.bg, "off");
  const t = setup({ fetchList: () => Promise.reject(new Error("offline")) });
  await t.bg.init();    // never rejects
  assert.equal(t.bg.state.mode, "off");
  assert.equal(t.layer.children.length, 0);
});

test("a failed refresh keeps the last good list; URLs that are not same-origin paths are dropped", async () => {
  let fail = false;
  const s = setup({ fetchList: () => (fail ? Promise.reject(new Error("x")) : Promise.resolve(LIST)) });
  await s.bg.init();
  const v = s.videos()[0];
  fail = true; await s.bg.init();
  assert.equal(s.bg.state.count, 3);
  assert.equal(s.videos()[0], v, "the clip plays on");
  const t = setup({ list: { videos: [{ url: "https://evil.example/x.mp4" }, { url: "//evil.example/y.mp4" }, { url: "javascript:alert(1)" }, { url: 5 }, null, { url: "/bgv/ok.mp4" }], photos: [] } });
  await t.bg.init();
  assert.deepEqual(t.bg.list.videos.map((i) => i.url), ["/bgv/ok.mp4"]);
  assert.equal(t.videos()[0].src, "/bgv/ok.mp4");
});

test("next on song change: the clip changes; changeOnSong off: it does not; between songs nothing moves", async () => {
  const s = setup();
  await s.bg.init();
  const v = s.videos()[0];
  let src = v.src;
  s.bg.onSongChange("midi", false);
  assert.notEqual(v.src, src, "next clip");
  assert.equal(s.videos()[0], v, "the same element, a new src (one decoder)");
  src = v.src;
  s.bg.onSongChange("", false); s.bg.onSongChange(null, false);
  assert.equal(v.src, src, "between songs: unchanged");
  s.bg.onSongChange("midi", true);
  assert.equal(v.src, src, "going idle does not advance");
  s.values["bg.changeOnSong"] = false;
  s.bg.onSongChange("audio", false);
  assert.equal(v.src, src, "changeOnSong off");
  s.bg.next();
  assert.notEqual(v.src, src, "the manual next still works");
  // a full cycle of nexts visits every clip
  const seen = new Set();
  for (let i = 0; i < 9; i++) { s.bg.next(); seen.add(s.videos()[0].src); }
  assert.equal(seen.size, 3);
});

test("hidden for video and youtube songs: the clip is removed (not left idle) and comes back", async () => {
  const s = setup();
  await s.bg.init();
  s.bg.onSongChange("video", false);
  assert.equal(s.videos().length, 0);
  assert.equal(s.layer.children.length, 0, "dim gone too");
  assert.equal(s.doc.body.dataset.bg, "off");
  const removed = s.doc.created.filter((n) => n.tagName === "VIDEO")[0];
  assert.equal(removed.paused, true);
  assert.equal(removed.getAttribute("src"), null, "src released");
  assert.ok(removed.loads >= 1, "load() after removing src frees the decoder");
  const at = s.bg.state.index;
  removed.fire("error");    // the removed clip's own "Empty src" error (§5.23) is not a failure
  assert.equal(s.bg.state.index, at, "the play order did not move");
  assert.equal(s.statuses.length, 0);
  s.bg.onSongChange("youtube", false);
  assert.equal(s.layer.children.length, 0);
  s.bg.onSongChange("midi", false);
  assert.equal(s.videos().length, 1);
  s.bg.onSongChange("video", false);
  s.bg.onSongChange("", true);
  assert.equal(s.videos().length, 1, "the idle stage shows it");
});

test("hidden document pauses the video and resumes on return", async () => {
  const s = setup();
  await s.bg.init();
  const v = s.videos()[0];
  assert.equal(v.paused, false);
  s.doc.setHidden(true);
  assert.equal(v.paused, true);
  assert.equal(s.videos()[0], v, "kept, just paused");
  s.doc.setHidden(false);
  assert.equal(v.paused, false);
});

test("never more than one <video> in the layer across mode switches", async () => {
  const s = setup({ nav: makeNav({ permission: "granted" }) });
  await s.bg.init();
  const steps = [["video"], ["camera", true], ["video"], ["photo"], ["camera", true], ["auto"], ["camera"], ["off"], ["video"]];
  for (const [m, gesture] of steps) {
    s.values["bg.mode"] = m;
    s.bg.applySettings({ gesture: !!gesture });
    assert.ok(s.videos().length <= 1, `right after → ${m}`);
    await flush();
    assert.ok(s.videos().length <= 1, `settled at ${m}`);
    s.bg.next(); s.bg.onSongChange("midi", false);
    assert.ok(s.videos().length <= 1, `after next / song change at ${m}`);
  }
  const live = s.nav.streams.filter((x) => x.track.readyState === "live");
  assert.equal(live.length, 0, "no camera left running after leaving camera mode");
});

test("photos: a cross-fade pair, the interval, data-anim, next", async () => {
  const s = setup({ over: { "bg.mode": "photo", "bg.photo.intervalSec": 5, "bg.photo.animation": "slide" } });
  await s.bg.init(); await flush();
  assert.equal(s.bg.state.mode, "photo");
  const imgs = s.layer.q("bg-photo");
  assert.equal(imgs.length, 2);
  assert.equal(s.videos().length, 0);
  const on = () => imgs.filter((i) => i.has("is-on"));
  assert.equal(on().length, 1);
  const first = on()[0].src;
  assert.ok(LIST.photos.some((p) => p.url === first));
  assert.equal(s.layer.getAttribute("data-anim"), "slide");
  assert.equal(s.doc.body.dataset.bg, "on");
  assert.equal(s.win.timers.size, 1);
  assert.equal([...s.win.timers.values()][0].ms, 5000);
  s.win.runTimers(); await flush();
  assert.equal(on().length, 1);
  assert.notEqual(on()[0].src, first, "the next photo is on");
  assert.equal(imgs.filter((i) => i.has("is-out"))[0].src, first, "the old one is going out");
  assert.equal(s.win.timers.size, 1, "rescheduled");
  const second = on()[0].src;
  s.bg.next(); await flush();
  assert.notEqual(on()[0].src, second);
  // interval clamp + unknown animation falls back to fade
  s.values["bg.photo.intervalSec"] = 1; s.values["bg.photo.animation"] = "spin"; s.bg.applySettings();
  assert.equal([...s.win.timers.values()][0].ms, 3000);
  assert.equal(s.layer.getAttribute("data-anim"), "fade");
  // hidden tab: no timer; back: one
  s.doc.setHidden(true);
  assert.equal(s.win.timers.size, 0);
  s.doc.setHidden(false);
  assert.equal(s.win.timers.size, 1);
  // a photo that finishes decoding after the tab hid does not arm the timer
  let release;
  const imgsNow = s.layer.q("bg-photo");
  for (const img of imgsNow) img.decode = () => new Promise((r) => { release = r; });
  s.bg.next();
  s.doc.setHidden(true);
  release(); await flush();
  assert.equal(s.win.timers.size, 0, "no slideshow timer while hidden");
  s.doc.setHidden(false);
  assert.equal(s.win.timers.size, 1);
  // a video song removes both photos and the timer
  s.bg.onSongChange("video", false);
  assert.equal(s.layer.children.length, 0);
  assert.equal(s.win.timers.size, 0);
});

test("a category narrows the list; auto follows a photo-only category; explicit modes and stale values fall back to all", async () => {
  const s = setup({ over: { "bg.category": "party" } });
  await s.bg.init();
  assert.equal(s.bg.state.count, 2);
  for (let i = 0; i < 6; i++) { assert.match(s.videos()[0].src, /^\/bgv\/party\//); s.bg.next(); }
  s.values["bg.category"] = "beach"; s.bg.applySettings(); await flush();
  assert.equal(s.bg.state.mode, "photo");
  assert.equal(s.videos().length, 0);
  assert.equal(s.bg.state.count, 2);
  s.values["bg.mode"] = "photo"; s.bg.applySettings();
  assert.equal(s.bg.state.count, 2, "explicit Photos keeps a photo category");
  s.values["bg.mode"] = "video"; s.bg.applySettings();
  assert.equal(s.bg.state.mode, "video", "explicit Videos ignores a photo-only category (never a blank stage)");
  assert.equal(s.bg.state.count, 3);
  s.values["bg.mode"] = "photo"; s.values["bg.category"] = "party"; s.bg.applySettings();
  assert.equal(s.bg.state.mode, "photo");
  assert.equal(s.bg.state.count, 3, "explicit Photos ignores a video-only category");
  s.values["bg.mode"] = "auto"; s.values["bg.category"] = "gone-folder"; s.bg.applySettings();
  assert.equal(s.bg.state.mode, "video");
  assert.equal(s.bg.state.count, 3);
});

test("failing clips are skipped; when every one failed the layer gives up with one status", async () => {
  const s = setup();
  await s.bg.init();
  const v = s.videos()[0];
  const a = v.src;
  v.fire("error");
  assert.notEqual(s.videos()[0].src, a, "skipped to another clip");
  s.videos()[0].fire("error");
  s.videos()[0].fire("error");
  assert.equal(s.videos().length, 0, "gave up");
  assert.equal(s.statuses.length, 1);
  s.bg.onSongChange("midi", false); s.bg.next();
  assert.equal(s.videos().length, 0, "no retry loop");
  assert.equal(s.statuses.length, 1);
  // photos: a broken image is skipped
  const t = setup({ over: { "bg.mode": "photo" } });
  for (const p of LIST.photos.slice(0, 2)) t.doc.badUrls.add(p.url);
  await t.bg.init(); await flush();
  const on = t.layer.q("bg-photo").filter((i) => i.has("is-on"));
  assert.equal(on.length, 1);
  assert.equal(on[0].src, "/bgphoto/z.webp");
});

test("stop() removes every element and stops the camera; a later applySettings brings it back", async () => {
  const s = setup({ over: { "bg.mode": "camera" }, nav: makeNav({ permission: "granted" }) });
  await s.bg.init(); await flush();
  s.bg.stop();
  assert.equal(s.layer.children.length, 0);
  assert.equal(s.nav.streams[0].track.readyState, "ended");
  assert.equal(s.bg.state.mode, "off");
  assert.equal(s.bg.state.camera, "off");
  assert.equal(s.doc.body.dataset.bg, "off");
  s.doc.setHidden(true); s.doc.setHidden(false); s.bg.onSongChange("midi", false); await flush();
  assert.equal(s.layer.children.length, 0, "stays stopped");
  s.values["bg.mode"] = "auto"; s.bg.applySettings();
  assert.equal(s.videos().length, 1);
});

test("missing settings keys: unknown mode is off, the plan's defaults fill the rest", async () => {
  const doc = makeDoc();
  const layer = new Node(doc, "div");
  const bg = createBackgrounds({ el: layer, settings: { get: () => undefined }, fetchList: () => Promise.resolve(LIST), doc, nav: makeNav(), win: makeWin() });
  await bg.init();
  assert.equal(bg.state.mode, "off");
  assert.equal(layer.children.length, 0);
  assert.equal(layer.style.getPropertyValue("--bg-dim"), "0.35");
  assert.equal(layer.getAttribute("data-anim"), "fade");
});
