/*
 * latency-cal.test.js — microphone latency calibration (M9, plan §5.17):
 *   - the pure maths in src/js/latency-cal.js, on synthetic signals;
 *   - the "capture" AudioWorkletProcessor (src/js/worklets/capture.js) under fake worklet globals;
 *   - MicEngine.secure / openRawTap (src/js/mic.js) against a fake context and getUserMedia;
 *   - the dialog (src/js/ui/calibrate-ui.js) on a small fake DOM, a fake audio clock and a fake raw
 *     tap that "hears" the scheduled clicks after a chosen delay.
 * Run with:  node --test
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  CLICKS, CLICK_GAP_SEC, CLICK_SEC, CLICK_HZ, PITCH_CHAIN_MS,
  clickTimes, detectOnsets, estimateLatency, matchClicks, noiseFloorDb, suggestGateDb, onsetThresholdDb,
} from "../src/js/latency-cal.js";
import { createCalibrateUI, calibrateUnavailable, CAL_TEXT } from "../src/js/ui/calibrate-ui.js";
import { MicEngine } from "../src/js/mic.js";

const SR = 48000;

// A deterministic noise source (mulberry32), so a failing test fails the same way every run.
function rng(seed = 1) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// A mono buffer of `seconds` with 1 kHz tone bursts (CLICK_SEC long) starting at `at` (seconds),
// plus uniform noise of peak amplitude `noise`.
function signal(seconds, at, { level = 0.5, noise = 0, burst = CLICK_SEC, seed = 7 } = {}) {
  const n = Math.round(seconds * SR);
  const out = new Float32Array(n);
  const r = rng(seed);
  for (let i = 0; i < n; i++) out[i] = noise ? (r() * 2 - 1) * noise : 0;
  for (const t of at) {
    const i0 = Math.round(t * SR);
    const len = Math.round(burst * SR);
    for (let k = 0; k < len && i0 + k < n; k++) out[i0 + k] += level * Math.sin((2 * Math.PI * CLICK_HZ * k) / SR);
  }
  return out;
}

// ---- the pure maths --------------------------------------------------------------------------

test("clickTimes spacing", () => {
  const t = clickTimes(1.25);
  assert.equal(t.length, CLICKS);
  assert.equal(CLICKS, 8);
  assert.equal(t[0], 1.25);
  for (let i = 1; i < t.length; i++) assert.ok(Math.abs(t[i] - t[i - 1] - CLICK_GAP_SEC) < 1e-9, `gap ${i}`);
});

test("onsets found in a clean synthetic signal within 2 ms", () => {
  const at = [0.3, 0.9, 1.5, 2.1];
  const on = detectOnsets(signal(2.5, at), SR);
  assert.equal(on.length, at.length);
  on.forEach((o, i) => assert.ok(o >= at[i] && o - at[i] <= 0.002, `onset ${i}: ${o} vs ${at[i]}`));
});

test("onsets ignore noise below the threshold", () => {
  // uniform noise of peak 0.01 → RMS ≈ −45 dBFS, well under the −30 default
  const noisy = signal(2, [], { noise: 0.01 });
  assert.ok(noiseFloorDb(noisy) < -40);
  assert.deepEqual(detectOnsets(noisy, SR), []);
  // the same noise with one click in it → exactly that click
  const withClick = signal(2, [1.0], { noise: 0.01 });
  const on = detectOnsets(withClick, SR);
  assert.equal(on.length, 1);
  assert.ok(Math.abs(on[0] - 1.0) <= 0.002);
  // and a threshold under the noise finds the noise at once (the threshold is what keeps it out)
  assert.ok(detectOnsets(noisy, SR, { thresholdDb: -60 }).length >= 1);
});

test("minGap merges a ringing click", () => {
  // a click, 40 ms of silence, then the ring coming back above the threshold
  const ring = signal(1, [0.2, 0.2 + CLICK_SEC + 0.04]);
  assert.equal(detectOnsets(ring, SR).length, 1, "minGap 150 ms: one onset");
  assert.equal(detectOnsets(ring, SR, { minGapMs: 20 }).length, 2, "minGap 20 ms: the ring is its own onset");
  // a continuous tone is one onset whatever the gap (it never goes below)
  assert.equal(detectOnsets(signal(1, [0.1], { burst: 0.6 }), SR, { minGapMs: 0 }).length, 1);
});

test("latency is the median plus the chain constant", () => {
  const sched = clickTimes(1);
  const deltas = [100, 104, 108, 110, 112, 116, 118, 120];        // median 111
  const est = estimateLatency(sched, sched.map((t, i) => t + deltas[i] / 1000));
  assert.ok(est);
  assert.equal(est.matched, 8);
  assert.ok(Math.abs(est.latencyMs - (111 + PITCH_CHAIN_MS)) < 1e-6, String(est.latencyMs));
  assert.ok(Math.abs(est.spreadMs - (116.5 - 107)) < 1e-6, `IQR ${est.spreadMs}`);   // interpolated quartiles
});

test("one outlier does not move the estimate", () => {
  const sched = clickTimes(2);
  const clean = sched.map((t) => t + 0.12);
  const one = clean.slice(); one[5] = sched[5] + 0.45;            // one late echo
  const a = estimateLatency(sched, clean), b = estimateLatency(sched, one);
  assert.ok(a && b);
  assert.ok(Math.abs(a.latencyMs - 180) < 1e-6);
  assert.ok(Math.abs(b.latencyMs - 180) < 1e-6, String(b.latencyMs));
  assert.equal(b.matched, 8);
});

test("fewer than five matches is a failure", () => {
  const sched = clickTimes(0);
  const all = sched.map((t) => t + 0.1);
  assert.equal(estimateLatency(sched, all.slice(0, 4)), null);
  assert.ok(estimateLatency(sched, all.slice(0, 5)));
  assert.equal(estimateLatency(sched, []), null);
  assert.equal(matchClicks(sched, all.slice(0, 4)).length, 4);
});

test("a wide spread is a failure", () => {
  const sched = clickTimes(0);
  const wide = [40, 80, 120, 160, 200, 240, 280, 320];            // IQR 140 ms
  assert.equal(estimateLatency(sched, sched.map((t, i) => t + wide[i] / 1000)), null);
  const edge = [100, 100, 100, 120, 130, 140, 140, 140];          // IQR exactly 40 → accepted
  assert.ok(estimateLatency(sched, sched.map((t, i) => t + edge[i] / 1000)));
});

test("an onset is matched only inside (t, t + maxMs]", () => {
  const sched = clickTimes(0);
  assert.equal(matchClicks([1], [1]).length, 0, "an onset AT the click is not a reply to it");
  assert.equal(matchClicks([1], [0.9]).length, 0, "nor one before it");
  assert.equal(matchClicks([1], [1.601]).length, 0, "past 600 ms");
  assert.equal(matchClicks([1], [1.5]).length, 1);
  assert.equal(matchClicks([1], [1.25], { maxMs: 200 }).length, 0, "maxMs is honoured");
  // the first onset after the click counts, not a later one; unsorted onsets are fine
  const onsets = sched.flatMap((t) => [t + 0.3, t + 0.1]);
  assert.deepEqual(matchClicks(sched, onsets).map((d) => Math.round(d)), new Array(CLICKS).fill(100));
});

test("noise floor of silence is −100", () => {
  assert.equal(noiseFloorDb(new Float32Array(4800)), -100);
  assert.equal(noiseFloorDb(new Float32Array(0)), -100);
  assert.equal(noiseFloorDb(new Float32Array(4800).fill(1e-9)), -100, "below the floor is the floor");
  assert.ok(Math.abs(noiseFloorDb(new Float32Array(100).fill(1))) < 1e-9, "full scale is 0 dBFS");
  const sine = signal(1, [0], { level: 0.5, burst: 1 });
  assert.ok(Math.abs(noiseFloorDb(sine) - 20 * Math.log10(0.5 / Math.SQRT2)) < 0.05);
});

test("gate suggestion is clamped", () => {
  assert.equal(suggestGateDb(-52), -42);
  assert.equal(suggestGateDb(-52.4), -42);
  assert.equal(suggestGateDb(-52.6), -43);
  assert.equal(suggestGateDb(-100), -70);
  assert.equal(suggestGateDb(-80.2), -70);
  assert.equal(suggestGateDb(-5), -20);
  assert.equal(suggestGateDb(-30), -20);
  assert.equal(suggestGateDb(-Infinity), -70);
  assert.equal(suggestGateDb(NaN), -70);
});

test("the dialog's onset threshold stays 20 dB over the room, within −50…−30", () => {
  assert.equal(onsetThresholdDb(-60), -40);
  assert.equal(onsetThresholdDb(-100), -50);
  assert.equal(onsetThresholdDb(-35), -30);
  assert.equal(onsetThresholdDb(NaN), -50);
});

test("a synthetic loopback with a known 137 ms delay → 137 ± 3 + 60", () => {
  const sched = clickTimes(0.5);
  const mic = signal(6, sched.map((t) => t + 0.137), { level: 0.2, noise: 0.002, seed: 3 });
  const est = estimateLatency(sched, detectOnsets(mic, SR));
  assert.ok(est, "measured");
  assert.equal(est.matched, 8);
  assert.ok(Math.abs(est.latencyMs - (137 + PITCH_CHAIN_MS)) <= 3, String(est.latencyMs));
  assert.ok(est.spreadMs < 2);
});

// ---- the capture worklet ---------------------------------------------------------------------

async function loadCapture() {
  const registered = {};
  globalThis.AudioWorkletProcessor = class {
    constructor() { this.port = { posted: [], onmessage: null, postMessage(m, t) { this.posted.push([m, t]); } }; }
  };
  globalThis.registerProcessor = (name, cls) => { registered[name] = cls; };
  globalThis.currentFrame = 0;
  await import("../src/js/worklets/capture.js");
  return registered;
}

test("capture worklet posts each quantum as a mono copy with its frame, transferred", async () => {
  const { capture: Capture } = await loadCapture();
  assert.equal(typeof Capture, "function", "registered as \"capture\"");
  const p = new Capture();
  const L = new Float32Array(128).fill(0.5), R = new Float32Array(128).fill(-0.25);
  globalThis.currentFrame = 4096;
  assert.equal(p.process([[L, R]], [[new Float32Array(128)]]), true);
  assert.equal(p.port.posted.length, 1);
  const [msg, transfer] = p.port.posted[0];
  assert.equal(msg.frame, 4096);
  assert.equal(msg.samples.length, 128);
  assert.ok(Math.abs(msg.samples[0] - 0.125) < 1e-7, "the mean of the channels");
  assert.deepEqual(transfer, [msg.samples.buffer]);
  L[0] = 9;
  assert.notEqual(msg.samples[0], 4.375, "a copy, not the input");
  // no input → stays alive, posts nothing
  assert.equal(p.process([[]], [[]]), true);
  assert.equal(p.process([], []), true);
  assert.equal(p.port.posted.length, 1);
  // "stop" ends it
  p.port.onmessage({ data: "stop" });
  assert.equal(p.process([[L]], [[new Float32Array(128)]]), false);
  assert.equal(p.port.posted.length, 1);
});

// ---- MicEngine.secure / openRawTap -------------------------------------------------------------

function withNavigator(nav, fn) {
  const before = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  Object.defineProperty(globalThis, "navigator", { value: nav, configurable: true, writable: true });
  return Promise.resolve().then(fn).finally(() => {
    if (before) Object.defineProperty(globalThis, "navigator", before);
    else delete globalThis.navigator;
  });
}

// A fake shared context + AudioEngine + getUserMedia that records the graph it is asked to build.
function micRig({ refuse = 0, enabled = false } = {}) {
  const log = [];
  const nodes = [];
  const mk = (kind, extra = {}) => {
    const n = {
      kind, outs: [], disconnected: false, ...extra,
      connect(t) { n.outs.push(t); return t; },
      disconnect() { n.disconnected = true; },
    };
    nodes.push(n);
    return n;
  };
  const destination = mk("destination");
  const ctx = {
    sampleRate: 48000, destination,
    resume: async () => { log.push("resume"); },
    createMediaStreamSource: (stream) => mk("source", { stream }),
    createGain: () => mk("gain", { gain: { value: 1 } }),
  };
  const audio = {
    ctx,
    ensureContext: async () => ctx,
    ensureWorkletModule: async (url) => { log.push("module " + url); },
  };
  globalThis.AudioWorkletNode = class {
    constructor(c, name, opts) {
      const n = mk("worklet", { name, opts, ctx: c });
      n.port = { onmessage: null, sent: [], postMessage(m) { this.sent.push(m); } };
      return n;
    }
  };
  const streams = [];
  let calls = 0;
  const nav = {
    mediaDevices: {
      async getUserMedia(c) {
        calls++;
        log.push("gum");
        if (calls <= refuse) { const e = new Error("busy"); e.name = "NotReadableError"; throw e; }
        const track = { stopped: 0, stop() { this.stopped++; } };
        const stream = { constraints: c, track, getTracks: () => [track] };
        streams.push(stream);
        return stream;
      },
    },
  };
  const settings = { get: () => undefined, set: () => {} };
  const mic = new MicEngine(audio, settings);
  mic.enabled = enabled;
  mic.disable = () => { log.push("disable"); mic.enabled = false; };
  mic.enable = async () => { log.push("enable"); mic.enabled = true; return true; };
  return { mic, audio, ctx, log, nodes, streams, nav, destination };
}

test("mic.secure is isSecureContext === true", () => {
  const mic = new MicEngine({}, { get: () => undefined });
  const before = Object.getOwnPropertyDescriptor(globalThis, "isSecureContext");
  try {
    globalThis.isSecureContext = true;
    assert.equal(mic.secure, true);
    globalThis.isSecureContext = false;
    assert.equal(mic.secure, false);
    globalThis.isSecureContext = "yes";
    assert.equal(mic.secure, false, "only a real true counts");
    delete globalThis.isSecureContext;
    assert.equal(mic.secure, false);
  } finally {
    if (before) Object.defineProperty(globalThis, "isSecureContext", before);
    else delete globalThis.isSecureContext;
  }
});

test("openRawTap: a second raw stream, only into the capture worklet, pulled through a zero gain", async () => {
  const r = micRig({ enabled: true });
  await withNavigator(r.nav, async () => {
    const tap = await r.mic.openRawTap();
    assert.equal(tap.path, "second");
    assert.equal(tap.ctx, r.ctx);
    assert.equal(tap.sampleRate, 48000);
    assert.ok(r.log.includes("module ./js/worklets/capture.js"));
    assert.ok(!r.log.includes("disable"), "the main mic is not touched");
    assert.equal(r.mic.enabled, true);
    assert.deepEqual(r.streams[0].constraints.audio,
      { echoCancellation: false, noiseSuppression: false, autoGainControl: false });
    const src = r.nodes.find((n) => n.kind === "source");
    const cap = r.nodes.find((n) => n.kind === "worklet");
    const sink = r.nodes.find((n) => n.kind === "gain");
    assert.equal(cap.name, "capture");
    assert.equal(cap.opts.numberOfOutputs, 1);
    assert.deepEqual(src.outs, [cap], "the stream goes only into the worklet");
    assert.deepEqual(cap.outs, [sink]);
    assert.equal(sink.gain.value, 0, "silent pull");
    assert.deepEqual(sink.outs, [r.destination]);

    // blocks: time = frame / sampleRate
    const got = [];
    const off = tap.onBlock((b) => got.push(b));
    const samples = new Float32Array(128);
    cap.port.onmessage({ data: { frame: 96000, samples } });
    assert.equal(got.length, 1);
    assert.equal(got[0].time, 2);
    assert.equal(got[0].samples, samples);
    off();
    cap.port.onmessage({ data: { frame: 96128, samples } });
    assert.equal(got.length, 1, "unsubscribed");

    // stop: everything disconnected, the track stopped, the worklet told; idempotent
    tap.onBlock((b) => got.push(b));
    await tap.stop();
    await tap.stop();
    assert.ok(src.disconnected && cap.disconnected && sink.disconnected);
    assert.equal(r.streams[0].track.stopped, 1);
    assert.deepEqual(cap.port.sent, ["stop"]);
    cap.port.onmessage && cap.port.onmessage({ data: { frame: 0, samples } });
    assert.equal(got.length, 1, "no blocks after stop");
    assert.ok(!r.log.includes("enable"), "nothing to re-enable on the second-stream path");
  });
});

test("openRawTap: refused while the main mic is on → pauses it, re-enables it on stop", async () => {
  const r = micRig({ enabled: true, refuse: 1 });
  await withNavigator(r.nav, async () => {
    const tap = await r.mic.openRawTap();
    assert.equal(tap.path, "paused-main");
    assert.deepEqual(r.log.filter((x) => x === "gum" || x === "disable" || x === "enable"), ["gum", "disable", "gum"]);
    assert.equal(r.mic.enabled, false);
    await tap.stop();
    assert.equal(r.mic.enabled, true, "the user's mic is back");
    await tap.stop();
    assert.equal(r.log.filter((x) => x === "enable").length, 1);
  });
});

test("openRawTap: refused with the main mic off → throws, nothing paused", async () => {
  const r = micRig({ enabled: false, refuse: 1 });
  await withNavigator(r.nav, async () => {
    await assert.rejects(r.mic.openRawTap(), { name: "NotReadableError" });
    assert.ok(!r.log.includes("disable") && !r.log.includes("enable"));
  });
});

test("openRawTap: refused twice → the main mic is re-enabled and the error thrown", async () => {
  const r = micRig({ enabled: true, refuse: 2 });
  await withNavigator(r.nav, async () => {
    await assert.rejects(r.mic.openRawTap(), { name: "NotReadableError" });
    assert.equal(r.mic.enabled, true);
    assert.deepEqual(r.log.filter((x) => x === "disable" || x === "enable"), ["disable", "enable"]);
  });
});

// ---- the dialog --------------------------------------------------------------------------------

class Text {
  constructor(t) { this.ownText = String(t); this.parentElement = null; }
  get textContent() { return this.ownText; }
  matches() { return false; }
  *walk() {}
}
class El {
  constructor(doc, tag) {
    Object.assign(this, { doc, tagName: tag.toUpperCase(), className: "", attrs: new Map(),
      children: [], parentElement: null, ls: {}, ownText: "", props: {} });
    this.style = { vars: {}, setProperty: (k, v) => { this.style.vars[k] = v; } };
  }
  get textContent() { return this.ownText + this.children.map((c) => c.textContent).join(""); }
  set textContent(v) { this.detachAll(); this.ownText = String(v); }
  set innerHTML(_) { throw new Error("innerHTML must not be used"); }
  setAttribute(k, v) { this.attrs.set(k, String(v)); }
  getAttribute(k) { return this.attrs.has(k) ? this.attrs.get(k) : null; }
  hasAttribute(k) { return this.attrs.has(k); }
  detachAll() { for (const c of this.children) c.parentElement = null; this.children = []; }
  appendChild(c) { if (c.parentElement) c.parentElement.children = c.parentElement.children.filter((x) => x !== c); c.parentElement = this; this.children.push(c); return c; }
  replaceChildren(...cs) { this.detachAll(); this.ownText = ""; for (const c of cs) this.appendChild(c); }
  contains(n) { for (let x = n; x; x = x.parentElement) if (x === this) return true; return false; }
  matches(sel) {
    if (sel[0] === "[") return this.hasAttribute(sel.slice(1, -1));
    if (sel[0] === ".") return this.className.split(/\s+/).includes(sel.slice(1));
    return this.tagName === sel.toUpperCase();
  }
  closest(sel) { for (let n = this; n; n = n.parentElement) if (n.matches(sel)) return n; return null; }
  *walk() { for (const c of this.children) { yield c; yield* c.walk(); } }
  all(sel) { return [...this.walk()].filter((e) => e.matches(sel)); }
  one(sel) { return this.all(sel)[0] || null; }
  addEventListener(t, fn) { (this.ls[t] ||= []).push(fn); }
  click() {
    const ev = { type: "click", target: this };
    for (let n = this; n; n = n.parentElement) for (const fn of n.ls.click || []) fn(ev);
  }
}
const makeDoc = () => {
  const doc = {};
  doc.createElement = (tag) => new El(doc, tag);
  doc.createTextNode = (t) => new Text(t);
  return doc;
};

// A fake audio clock that the dialog's sleep() advances, and a raw tap that renders what a
// microphone would hear: noise, plus each scheduled click `delay` seconds after its start.
function calRig({ secure = true, bt = false, delay = 0.137, level = 0.5, noise = 0.001, refuse = null, deliver = true } = {}) {
  const sr = 48000;
  const clicks = [];        // oscillators the dialog scheduled
  const envs = [];
  const ctx = {
    currentTime: 3.0, sampleRate: sr, destination: { id: "dest" },
    resume: async () => {},
    createOscillator() {
      const o = { type: "", frequency: { value: 0 }, outs: [], disconnected: false,
        connect(t) { o.outs.push(t); return t; }, disconnect() { o.disconnected = true; },
        start(t) { o.startAt = t; clicks.push(o); }, stop(t) { o.stopAt = t; }, onended: null };
      return o;
    },
    createGain() {
      const g = { outs: [], disconnected: false, gain: { value: 1, events: [],
        setValueAtTime(v, t) { this.events.push(["set", v, t]); },
        linearRampToValueAtTime(v, t) { this.events.push(["ramp", v, t]); } },
        connect(t) { g.outs.push(t); return t; }, disconnect() { g.disconnected = true; } };
      envs.push(g);
      return g;
    },
  };
  const master = { id: "master" };
  const audio = { ctx: null, gain: null, async ensureContext() { this.ctx = ctx; this.gain = master; return ctx; } };
  const r = rng(11);
  const subs = new Set();
  let frame = 0, open = false;
  const stops = { n: 0 };
  const sampleAt = (t) => {
    let v = (r() * 2 - 1) * noise;
    for (const o of clicks) {
      if (o.disconnected) continue;
      const s = o.startAt + delay;
      if (t >= s && t < s + CLICK_SEC) v += level * Math.sin(2 * Math.PI * CLICK_HZ * (t - s));
    }
    return v;
  };
  const emit = () => {
    const until = Math.floor(ctx.currentTime * sr);
    while (open && deliver && frame + 128 <= until) {
      const samples = new Float32Array(128);
      for (let i = 0; i < 128; i++) samples[i] = sampleAt((frame + i) / sr);
      for (const fn of subs) fn({ time: frame / sr, samples });
      frame += 128;
    }
  };
  const tap = {
    ctx, sampleRate: sr, path: "second",
    onBlock(fn) { subs.add(fn); return () => subs.delete(fn); },
    stop() { stops.n++; open = false; subs.clear(); return Promise.resolve(); },
  };
  const mic = {
    secure, opened: 0,
    async openRawTap() {
      this.opened++;
      if (refuse) throw refuse;
      frame = Math.ceil((ctx.currentTime * sr) / 128) * 128;
      open = true;
      return tap;
    },
  };
  const store = { "bt.enabled": bt, "mic.latencyMs": 100, "mic.gateThresholdDb": -50 };
  const sets = [];
  const settings = { get: (k) => store[k], set: (k, v) => { sets.push([k, v]); store[k] = v; } };
  const saved = [];
  const doc = makeDoc();
  const el = doc.createElement("section");
  let pause = null;          // a test can hold the clock at a step
  const sleep = async (ms) => {
    if (pause && pause()) return new Promise(() => {});      // never resolves: the run waits here
    ctx.currentTime += ms / 1000;
    emit();
  };
  const cal = createCalibrateUI({ el, mic, audio, settings, doc, sleep, onSave: (x) => saved.push(x) });
  const btn = (id) => el.all("[data-cal]").find((b) => b.getAttribute("data-cal") === id) || null;
  const ids = () => el.all("[data-cal]").map((b) => b.getAttribute("data-cal"));
  const text = () => (el.one(".cal-text") || { textContent: "" }).textContent;
  const settle = async (until = () => cal.step !== "silence" && cal.step !== "clicks") => {
    for (let i = 0; i < 2000 && !until(); i++) await new Promise((res) => setImmediate(res));
  };
  return { cal, el, mic, audio, ctx, master, settings, store, sets, saved, stops, clicks, envs, btn, ids, text, settle,
    hold(fn) { pause = fn; } };
}

test("calibrate: not a secure context → the https text; Start never calls openRawTap", async () => {
  const r = calRig({ secure: false });
  r.cal.open();
  assert.equal(r.cal.step, "unavailable");
  assert.equal(r.text(), "Open the app on https or localhost to use the microphone");
  assert.deepEqual(r.ids(), ["cancel"], "no Start button");
  assert.ok(r.btn("cancel").hasAttribute("data-ov-close"));
  assert.equal(r.cal.firstButton(), r.btn("cancel"));
  r.btn("cancel").click();
  await r.settle();
  assert.equal(r.mic.opened, 0);
  assert.equal(r.sets.length, 0);
  assert.equal(calibrateUnavailable({ mic: r.mic, settings: r.settings }), CAL_TEXT.insecure);
});

test("calibrate: Bluetooth mode on → the Bluetooth text; insecure wins over it", async () => {
  const r = calRig({ bt: true });
  r.cal.open();
  assert.equal(r.cal.step, "unavailable");
  assert.equal(r.text(), "Turn off Bluetooth mode first");
  assert.deepEqual(r.ids(), ["cancel"]);
  assert.equal(r.mic.opened, 0);
  assert.equal(calibrateUnavailable({ mic: { secure: false }, settings: r.settings }), CAL_TEXT.insecure);
  assert.equal(calibrateUnavailable({ mic: { secure: true }, settings: { get: () => false } }), null);
});

test("calibrate: Bluetooth turned on after open → Start shows the reason and never opens the tap", async () => {
  const r = calRig();
  r.cal.open();
  assert.equal(r.cal.step, "intro");
  assert.equal(r.text(), "Hold the microphone 20 cm from the speaker. You will hear 8 clicks.");
  assert.deepEqual(r.ids(), ["start", "cancel"], "Start first (initial focus)");
  assert.ok(r.btn("cancel").hasAttribute("data-ov-close"));
  assert.ok(!r.btn("start").hasAttribute("data-ov-close"));
  r.store["bt.enabled"] = true;
  r.btn("start").click();
  await r.settle();
  assert.equal(r.cal.step, "unavailable");
  assert.equal(r.mic.opened, 0);
});

test("calibrate: a loopback 137 ms late → result 197 ms, Save writes it rounded to 5 ms and the gate", async () => {
  const r = calRig({ delay: 0.137 });
  r.cal.open();
  r.btn("start").click();
  assert.equal(r.cal.step, "silence");
  await r.settle();
  assert.equal(r.cal.step, "result", r.text());
  assert.equal(r.text(), "Latency 197 ms (8 of 8 clicks heard). Room noise −65 dB → gate −55 dB.");
  assert.equal(r.el.all(".cal-num").length, 3);
  assert.deepEqual(r.ids(), ["save", "retry", "cancel"]);
  assert.equal(r.stops.n, 1, "the tap is stopped before the result shows");
  assert.equal(r.sets.length, 0, "nothing saved before Save");
  // the clicks: 8 × 1 kHz on the shared context, through audio.gain, at the scheduled times
  assert.equal(r.clicks.length, CLICKS);
  assert.ok(r.clicks.every((o) => o.frequency.value === CLICK_HZ && o.outs[0].outs[0] === r.master));
  for (let i = 1; i < CLICKS; i++) assert.ok(Math.abs(r.clicks[i].startAt - r.clicks[i - 1].startAt - CLICK_GAP_SEC) < 1e-9);
  r.btn("save").click();
  assert.deepEqual(r.sets, [["mic.latencyMs", 195], ["mic.gateThresholdDb", -55]]);
  assert.equal(r.saved.length, 1);
  assert.equal(r.saved[0].latencyMs, 195);
  assert.equal(r.saved[0].matched, 8);
  assert.equal(r.saved[0].gateDb, -55);
  assert.equal(r.saved[0].gateSaved, true);
  assert.equal(r.saved[0].path, "second");
  assert.ok(r.saved[0].noiseDb < -60 && r.saved[0].spreadMs < 5);
  assert.equal(r.cal.step, "saved");
  assert.deepEqual(r.ids(), ["done"]);
  assert.ok(r.btn("done").hasAttribute("data-ov-close"));
  r.btn("save") && r.btn("save").click();
  assert.equal(r.saved.length, 1, "one save");
});

test("calibrate: the gate is left alone when its box is unticked; latency clamps to 500", async () => {
  const r = calRig({ delay: 0.47 });            // 470 + 60 = 530 → 500
  r.cal.open();
  r.btn("start").click();
  await r.settle();
  assert.equal(r.cal.step, "result", r.text());
  const box = r.el.one("input");
  assert.equal(box.getAttribute("type"), "checkbox");
  assert.equal(box.checked, true, "ticked by default");
  box.checked = false;
  r.btn("save").click();
  assert.deepEqual(r.sets, [["mic.latencyMs", 500]]);
  assert.equal(r.saved[0].gateSaved, false);
  assert.match(r.text(), /noise gate was not changed/);
});

test("calibrate: a failed measurement (silent loopback) saves nothing and stops the tap", async () => {
  const r = calRig({ level: 0 });
  r.cal.open();
  r.btn("start").click();
  await r.settle();
  assert.equal(r.cal.step, "failed");
  assert.ok(r.text().startsWith("Could not measure: "), r.text());
  assert.match(r.text(), /no clicks were heard/);
  assert.deepEqual(r.ids(), ["retry", "cancel"]);
  assert.equal(r.sets.length, 0);
  assert.equal(r.saved.length, 0);
  assert.equal(r.stops.n, 1);
  // Retry runs again (and fails again, the same way)
  r.btn("retry").click();
  assert.equal(r.cal.step, "silence");
  await r.settle();
  assert.equal(r.cal.step, "failed");
  assert.equal(r.mic.opened, 2);
  assert.equal(r.stops.n, 2);
  assert.equal(r.sets.length, 0);
});

test("calibrate: a microphone that sends nothing → failed during the silence, the tap stopped", async () => {
  const r = calRig({ deliver: false });
  r.cal.open();
  r.btn("start").click();
  await r.settle();
  assert.equal(r.cal.step, "failed");
  assert.equal(r.text(), "Could not measure: the microphone sent no sound.");
  assert.equal(r.stops.n, 1, "stopped on the failure path");
  assert.equal(r.clicks.length, 0, "no clicks were played");
  assert.equal(r.sets.length, 0);
  assert.equal(r.saved.length, 0);
});

test("calibrate: too few clicks heard → the count in the reason, nothing saved", async () => {
  const r = calRig();
  // make only the first three clicks audible
  const orig = r.ctx.createOscillator.bind(r.ctx);
  let made = 0;
  r.ctx.createOscillator = () => { const o = orig(); if (++made > 3) o.disconnect(); return o; };
  r.cal.open();
  r.btn("start").click();
  await r.settle();
  assert.equal(r.cal.step, "failed");
  assert.match(r.text(), /^Could not measure: only 3 of 8 clicks were heard/);
  assert.equal(r.sets.length, 0);
});

test("calibrate: the microphone refused → failed with the reason, nothing saved", async () => {
  const e = new Error("denied"); e.name = "NotAllowedError";
  const r = calRig({ refuse: e });
  r.cal.open();
  r.btn("start").click();
  await r.settle();
  assert.equal(r.cal.step, "failed");
  assert.equal(r.text(), "Could not measure: the microphone could not be opened (NotAllowedError).");
  assert.equal(r.sets.length, 0);
  assert.equal(r.saved.length, 0);
});

test("calibrate: Cancel mid-clicks stops the tap, silences the clicks and saves nothing", async () => {
  const r = calRig();
  r.hold(() => r.cal.step === "clicks" && r.clicks.length > 0);
  r.cal.open();
  r.btn("start").click();
  await r.settle(() => r.cal.step === "clicks" && r.clicks.length > 0);
  assert.equal(r.cal.step, "clicks");
  assert.deepEqual(r.ids(), ["cancel"]);
  assert.ok(r.btn("cancel").hasAttribute("data-ov-close"));
  const cancel = r.btn("cancel");
  cancel.click();
  assert.equal(cancel.parentElement && r.el.contains(cancel), true,
    "the button stays in the dialog during its click (the overlay runtime looks it up)");
  assert.equal(r.stops.n, 1);
  assert.ok(r.clicks.every((o) => o.disconnected), "scheduled clicks silenced");
  await new Promise((res) => setTimeout(res, 5));
  assert.equal(r.cal.step, "intro", "back to the intro after the close");
  assert.equal(r.sets.length, 0);
  assert.equal(r.saved.length, 0);
});

test("calibrate: close() (the overlay's onClose) during the silence stops the tap; open() starts over", async () => {
  const r = calRig();
  r.hold(() => r.cal.step === "silence" && r.mic.opened > 0);
  r.cal.open();
  r.btn("start").click();
  await r.settle(() => r.mic.opened > 0);
  for (let i = 0; i < 20; i++) await new Promise((res) => setImmediate(res));
  assert.equal(r.cal.step, "silence");
  r.cal.close();
  assert.equal(r.stops.n, 1);
  assert.equal(r.cal.step, "intro");
  r.cal.close();
  assert.equal(r.stops.n, 1, "idempotent");
  r.cal.open();
  assert.equal(r.cal.step, "intro");
  assert.equal(r.sets.length, 0);
});

// ---- Q6: the reason the microphone is unavailable (integration, M9) ---------------------------
test("MicEngine.unavailableReason: an insecure page says why (https or localhost), not 'not supported'", () => {
  const hadSecure = Object.prototype.hasOwnProperty.call(globalThis, "isSecureContext");
  const saved = globalThis.isSecureContext;
  const mic = Object.create(MicEngine.prototype);   // the getter reads nothing from the instance
  try {
    globalThis.isSecureContext = false;
    assert.equal(mic.unavailableReason, CAL_TEXT.insecure, "the same words as the Calibrate dialog");
    globalThis.isSecureContext = true;
    assert.equal(mic.unavailableReason, "Microphone not supported in this browser");
  } finally {
    if (hadSecure) globalThis.isSecureContext = saved; else delete globalThis.isSecureContext;
  }
});
