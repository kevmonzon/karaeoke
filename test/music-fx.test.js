/*
 * music-fx.test.js — M10 lane A: the music bus (plan §5.18 / §5.19 / §5.20).
 *
 *   1. music-fx.js, pure: the EQ bands and presets, the reverb / chorus level scale, transposeForce.
 *   2. audio.js + pitch-chain.js against a FAKE Web Audio graph: the drums flag across loadSong, the
 *      bus wiring (flat = a straight wire, the EQ only when asked), reverb / chorus re-applied after
 *      init, the loudness gain ramp, the limiter's make-up compensation, readMusicMeanSquare's volume
 *      normalisation per source, and the key-shift chain feeding musicIn.
 *
 * audio.js imports the bare specifier "spessasynth_lib" (an import map in the browser). Node has no
 * import map, so a resolve hook maps that ONE specifier to a stub whose classes hand back whatever fake
 * the test installs on globalThis. node --test runs each file in its own process, so the hook stays here.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as nodeModule from "node:module";

import {
  EQ_BANDS, EQ_Q, EQ_PRESETS, eqGainsFor, isFlat, fxLevelToGain, transposeForce,
} from "../src/js/music-fx.js";
import { normalizeMeanSquare as nmsLoudness } from "../src/js/loudness.js";

const STUB = "data:text/javascript," + encodeURIComponent(
  "export class WorkletSynthesizer { constructor(ctx) { return globalThis.__m10FakeSynth(ctx); } }\n" +
  "export class Sequencer { constructor(synth, opts) { return globalThis.__m10FakeSeq(synth, opts); } }\n");
if (typeof nodeModule.registerHooks === "function") {            // Node ≥ 22.15 / 23.5 (in-thread)
  nodeModule.registerHooks({
    resolve(specifier, context, next) {
      if (specifier === "spessasynth_lib") return { url: STUB, shortCircuit: true };
      return next(specifier, context);
    },
  });
} else {                                                          // Node 20 (CI): off-thread hooks
  nodeModule.register("data:text/javascript," + encodeURIComponent(
    "export async function resolve(specifier, context, next) {\n" +
    `  if (specifier === "spessasynth_lib") return { url: ${JSON.stringify(STUB)}, shortCircuit: true };\n` +
    "  return next(specifier, context);\n}\n"));
}
const { AudioEngine, LIMITER, limiterMakeupDb, normalizeMeanSquare } = await import("../src/js/audio.js");
const { KeyShiftChain } = await import("../src/js/pitch-chain.js");

// --- a fake Web Audio graph -------------------------------------------------------------------------

class FakeParam {
  constructor(v) { this.value = v; this.events = []; }
  setValueAtTime(v, t) { this.events.push(["set", v, t]); this.value = v; }
  linearRampToValueAtTime(v, t) { this.events.push(["ramp", v, t]); }
  setTargetAtTime(v, t, c) { this.events.push(["target", v, t, c]); this.value = v; }
  cancelScheduledValues(t) { this.events.push(["cancel", t]); }
}

class FakeNode {
  constructor(ctx, kind) { this.ctx = ctx; this.kind = kind; this.outs = new Set(); }
  connect(n) { this.outs.add(n); return n; }
  disconnect(n) {
    if (n === undefined) { this.outs.clear(); return; }
    if (!this.outs.has(n)) throw new Error("InvalidAccessError: not connected");   // as the real API
    this.outs.delete(n);
  }
}

class FakeContext {
  constructor() {
    this.currentTime = 10;
    this.state = "running";
    this.destination = new FakeNode(this, "destination");
    this.signal = 0;                        // what every analyser "hears" (a constant sample value)
    this.nodes = [];
    this.audioWorklet = { added: [], addModule: async (url) => { this.audioWorklet.added.push(url); } };
  }
  _n(kind, extra) { const n = Object.assign(new FakeNode(this, kind), extra); this.nodes.push(n); return n; }
  createGain() { return this._n("gain", { gain: new FakeParam(1) }); }
  createAnalyser() {
    const ctx = this;
    return this._n("analyser", {
      fftSize: 2048, smoothingTimeConstant: 0.8,
      getFloatTimeDomainData(buf) { buf.fill(ctx.signal); },
    });
  }
  createBiquadFilter() {
    return this._n("biquad", { type: "lowpass", frequency: new FakeParam(350), Q: new FakeParam(1), gain: new FakeParam(0) });
  }
  createDynamicsCompressor() {
    return this._n("compressor", {
      threshold: new FakeParam(-24), knee: new FakeParam(30), ratio: new FakeParam(12),
      attack: new FakeParam(0.003), release: new FakeParam(0.25),
    });
  }
  createMediaElementSource(el) { return this._n("mediaSource", { el }); }
  async resume() { this.state = "running"; }
}

function fakeSynth() {
  return {
    calls: [], master: [], connected: [],
    isReady: Promise.resolve(),
    soundBankManager: { addSoundBank: async () => {} },
    connect(n) { this.connected.push(n); return n; },
    connectIndividualOutputs() {},
    transposeChannel(ch, semitones, force) { this.calls.push([ch, semitones, force]); },
    setMasterParameter(type, value) { this.master.push([type, value]); },
    lockController() {}, controllerChange() {}, muteChannel() {},
  };
}
function fakeSeq() { return { loaded: [], loadNewSongList(list) { this.loaded.push(list); }, play() {}, pause() {} }; }

/** An engine whose synth / sequencer are fakes, as if init() had finished (no context needed). */
function readyEngine() {
  const e = new AudioEngine();
  e.synth = fakeSynth();
  e.seq = fakeSeq();
  e.ready = true;
  return e;
}

/** An engine with a fake context (ensureContext → the music bus). */
async function busEngine() {
  globalThis.AudioContext = FakeContext;
  const e = new AudioEngine();
  await e.ensureContext();
  return e;
}

/** Equal within a relative 1e-6 (the analyser buffer is a Float32Array). */
const near = (a, b) => Math.abs(a - b) <= 1e-6 * Math.max(1e-12, Math.abs(b));

/** The last call per channel: ch → [semitones, force]. */
function lastPerChannel(calls) {
  const m = new Map();
  for (const [ch, s, f] of calls) m.set(ch, [s, f]);
  return m;
}

// --- 1. music-fx.js ---------------------------------------------------------------------------------

test("ten bands, ascending", () => {
  assert.equal(EQ_BANDS.length, 10);
  assert.deepEqual([...EQ_BANDS], [31, 62, 125, 250, 500, 1000, 2000, 4000, 8000, 16000]);
  for (let i = 1; i < EQ_BANDS.length; i++) assert.ok(EQ_BANDS[i] > EQ_BANDS[i - 1]);
  assert.equal(EQ_Q, 1.4);
  assert.ok(Object.isFrozen(EQ_BANDS));
});

test("every preset has ten values within ±8", () => {
  assert.deepEqual(Object.keys(EQ_PRESETS).sort(), ["bass", "bright", "flat", "small", "tv", "vocal", "warm"]);
  assert.ok(Object.isFrozen(EQ_PRESETS));
  for (const [name, gains] of Object.entries(EQ_PRESETS)) {
    assert.equal(gains.length, 10, name);
    assert.ok(Object.isFrozen(gains), `${name} is frozen`);
    for (const g of gains) assert.ok(Number.isFinite(g) && Math.abs(g) <= 8, `${name}: ${g}`);
    if (name !== "flat") assert.ok(!isFlat(gains), `${name} is not flat`);
  }
});

test("Bass boost lifts every band below 150 Hz by at least 3 dB", () => {
  const bass = eqGainsFor("bass");
  EQ_BANDS.forEach((f, i) => { if (f < 150) assert.ok(bass[i] >= 3, `${f} Hz: ${bass[i]}`); });
  // and the cascaded peaking response (RBJ, as BiquadFilterNode computes it) is ≥ +3 dB from 40 to 150 Hz
  const fs = 48000;
  const peakDb = (f0, G, f) => {
    const A = 10 ** (G / 40), w0 = 2 * Math.PI * f0 / fs, al = Math.sin(w0) / (2 * EQ_Q), c = Math.cos(w0);
    const b = [1 + al * A, -2 * c, 1 - al * A], a = [1 + al / A, -2 * c, 1 - al / A], w = 2 * Math.PI * f / fs;
    const mag = (k) => Math.hypot(k[0] + k[1] * Math.cos(w) + k[2] * Math.cos(2 * w), k[1] * Math.sin(w) + k[2] * Math.sin(2 * w));
    return 20 * Math.log10(mag(b) / mag(a));
  };
  for (let f = 40; f <= 150; f += 5) {
    const db = bass.reduce((s, G, i) => s + peakDb(EQ_BANDS[i], G, f), 0);
    assert.ok(db >= 3, `${f} Hz: ${db.toFixed(2)} dB`);
  }
});

test("flat is flat", () => {
  assert.deepEqual(eqGainsFor("flat"), [0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
  assert.equal(isFlat(eqGainsFor("flat")), true);
  assert.equal(isFlat(null), true, "no EQ at all counts as flat");
  assert.equal(isFlat([0.04, -0.05, 0, 0, 0, 0, 0, 0, 0, 0]), true, "within 0.05 dB");
  assert.equal(isFlat([0, 0, 0, 0, 0, 0, 0, 0, 0, 0.06]), false);
  assert.equal(isFlat([0, 0, NaN, undefined, 0, 0, 0, 0, 0, 0]), true, "junk reads as 0, as eqGainsFor does");
});

test("unknown preset is flat", () => {
  for (const p of ["nope", "", undefined, null, 7, "__proto__", "constructor", "toString", "hasOwnProperty"]) {
    assert.deepEqual(eqGainsFor(p), [0, 0, 0, 0, 0, 0, 0, 0, 0, 0], String(p));
  }
});

test("custom is clamped to ±12", () => {
  assert.deepEqual(
    eqGainsFor("custom", [20, -20, 12, -12, 3.5, "4", NaN, Infinity, null]),
    [12, -12, 12, -12, 3.5, 4, 0, 0, 0, 0], "clamped; numeric strings read; junk and missing → 0");
  assert.deepEqual(eqGainsFor("custom", "loud"), [0, 0, 0, 0, 0, 0, 0, 0, 0, 0], "not an array → flat");
  assert.deepEqual(eqGainsFor("custom"), [0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
});

test("eqGainsFor always returns a fresh array of ten", () => {
  const a = eqGainsFor("warm");
  a[0] = 99;
  assert.equal(EQ_PRESETS.warm[0], 2, "the preset is untouched");
  assert.notEqual(eqGainsFor("warm"), eqGainsFor("warm"));
  const custom = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
  assert.notEqual(eqGainsFor("custom", custom), custom);
});

test("fx levels map 0–4 to 0–2", () => {
  assert.deepEqual([0, 1, 2, 3, 4].map(fxLevelToGain), [0, 0.5, 1, 1.5, 2]);
  assert.equal(fxLevelToGain(-3), 0, "clamps low");
  assert.equal(fxLevelToGain(9), 2, "clamps high");
  for (const junk of [NaN, Infinity, "3", null, undefined, {}]) assert.equal(fxLevelToGain(junk), 1, String(junk));
});

test("level 2 is unity", () => {
  assert.equal(fxLevelToGain(2), 1);
});

// MUTATION-PROVEN: `return drumsSetting !== true` (inverted) and `return true` (the pre-M10 behaviour)
// both fail the first assertion.
test("transposeForce defaults to leaving drums alone", () => {
  assert.equal(transposeForce(), false, "the default: drums are NOT transposed");
  assert.equal(transposeForce(false), false);
  assert.equal(transposeForce(true), true, "the setting on: the old behaviour");
  assert.equal(transposeForce("true"), false, "only a real true turns it on");
});

// --- 2. audio.js: the drums flag --------------------------------------------------------------------

test("applyTranspose passes force=false by default (drums are not transposed)", () => {
  const e = readyEngine();
  e.applyTranspose(3);
  assert.equal(e.synth.calls.length, 16, "one call per channel");
  for (const [, s, f] of e.synth.calls) { assert.equal(s, 3); assert.equal(f, false); }
  assert.equal(e.transposeDrums, false);
});

// MUTATION-PROVEN: a per-call option instead of the stored flag (setTransposeDrums calling
// `this.applyTranspose(this._transpose, next)`, so loadSong's re-assert passes none) fails at
// "after loadSong"; so does loadSong resetting `_transposeDrums`.
test("the drums flag survives a song load", () => {
  const e = readyEngine();
  e.applyTranspose(2);
  e.setTransposeDrums(true);
  let last = lastPerChannel(e.synth.calls);
  for (let ch = 0; ch < 16; ch++) assert.deepEqual(last.get(ch), [2, true], `ch ${ch} after the toggle`);
  e.synth.calls.length = 0;
  e.loadSong(new ArrayBuffer(8));
  assert.equal(e.seq.loaded.length, 1);
  assert.equal(e.synth.calls.length, 16, "loadSong re-asserts the transpose");
  last = lastPerChannel(e.synth.calls);
  for (let ch = 0; ch < 16; ch++) assert.deepEqual(last.get(ch), [2, true], `ch ${ch} after loadSong`);
});

test("turning drums off brings a transposed kit back to 0 first", () => {
  const e = readyEngine();
  e.setTransposeDrums(true);
  e.applyTranspose(4);                       // drums now at +4 (forced)
  e.synth.calls.length = 0;
  e.setTransposeDrums(false);
  // SpessaSynth SKIPS a drum channel when force is false, so +4 would stick: reset with force first
  assert.deepEqual(e.synth.calls.slice(0, 16), Array.from({ length: 16 }, (_, ch) => [ch, 0, true]));
  assert.deepEqual(e.synth.calls.slice(16), Array.from({ length: 16 }, (_, ch) => [ch, 4, false]));
  e.synth.calls.length = 0;
  e.applyTranspose(5);                       // the reset happens once, not on every key change
  assert.deepEqual(e.synth.calls, Array.from({ length: 16 }, (_, ch) => [ch, 5, false]));
});

test("setTransposeDrums before init is stored and used once the synth exists", () => {
  const e = new AudioEngine();
  e.setTransposeDrums(true);
  e.applyTranspose(1);                        // no synth: stored only
  e.synth = fakeSynth(); e.seq = fakeSeq(); e.ready = true;
  e.loadSong(new ArrayBuffer(8));
  assert.ok(e.synth.calls.length === 16 && e.synth.calls.every(([, s, f]) => s === 1 && f === true));
});

// --- 2. audio.js: the music bus wiring --------------------------------------------------------------

/** Follow single-output links from `node` and name them, stopping at the destination. */
function pathFrom(node, skip = new Set()) {
  const names = [];
  let n = node;
  for (let i = 0; i < 30 && n; i++) {
    names.push(n.kind);
    if (n.kind === "destination") break;
    const outs = [...n.outs].filter((o) => !skip.has(o));
    assert.equal(outs.length, 1, `${n.kind} has exactly one onward output`);
    n = outs[0];
  }
  return names;
}

test("default bus: gain → musicIn → straight wire → loudGain → limiter → trim → destination", async () => {
  const e = await busEngine();
  const ctx = e.ctx;
  assert.ok(e.musicIn && e.musicIn.kind === "gain");
  assert.ok(e.gain.outs.has(e.musicIn), "the synth's volume gain feeds the bus");
  assert.ok(!e.gain.outs.has(ctx.destination), "and no longer the destination directly");
  const analyser = [...e.musicIn.outs].find((n) => n.kind === "analyser");
  assert.ok(analyser, "the loudness tap sits on musicIn (pre-EQ)");
  assert.deepEqual(pathFrom(e.musicIn, new Set([analyser])),
    ["gain", "gain", "compressor", "gain", "destination"], "flat = no biquad in the path");
  assert.equal(e.eqActive, false);
  const comp = ctx.nodes.find((n) => n.kind === "compressor");
  assert.equal(comp.threshold.value, -1);
  assert.equal(comp.knee.value, 0);
  assert.equal(comp.ratio.value, 20);
  assert.equal(comp.attack.value, LIMITER.attackSec);
  assert.equal(comp.release.value, LIMITER.releaseSec);
  // the loudness gain starts at 0 dB
  const loud = [...e.musicIn.outs].find((n) => n !== analyser);
  assert.equal(loud.gain.value, 1);
});

test("the limiter's automatic make-up gain is cancelled after it", async () => {
  // spec: makeup = (1 / curve(0 dBFS))^0.6; hard knee −1 dB, 20:1 → curve(0) = −0.95 dB → +0.57 dB
  assert.ok(Math.abs(limiterMakeupDb(-1, 20) - 0.57) < 1e-9);
  assert.equal(limiterMakeupDb(0, 20), 0, "a 0 dB threshold has nothing to make up");
  const e = await busEngine();
  const comp = e.ctx.nodes.find((n) => n.kind === "compressor");
  const trim = [...comp.outs][0];
  assert.ok(Math.abs(20 * Math.log10(trim.gain.value) + 0.57) < 1e-9, "trim = −0.57 dB");
});

test("setEq puts ten peaking bands in the path; null or flat takes them out again", async () => {
  const e = await busEngine();
  const analyser = [...e.musicIn.outs].find((n) => n.kind === "analyser");
  e.setEq(eqGainsFor("bass"));
  assert.equal(e.eqActive, true);
  const path = pathFrom(e.musicIn, new Set([analyser]));
  assert.deepEqual(path, ["gain", ...Array(10).fill("biquad"), "gain", "compressor", "gain", "destination"]);
  const bands = e.ctx.nodes.filter((n) => n.kind === "biquad");
  assert.deepEqual(bands.map((b) => b.frequency.value), [...EQ_BANDS]);
  assert.ok(bands.every((b) => b.type === "peaking" && b.Q.value === EQ_Q));
  assert.deepEqual(bands.map((b) => b.gain.value), [...EQ_PRESETS.bass]);
  assert.ok([...e.musicIn.outs].includes(analyser), "the meter tap survives the re-route");

  e.setEq(eqGainsFor("warm"));                 // already in the path: the gains glide
  assert.deepEqual(bands.map((b) => b.gain.value), [...EQ_PRESETS.warm]);
  assert.equal(bands[0].gain.events.at(-1)[0], "target");

  e.setEq(null);
  assert.equal(e.eqActive, false);
  assert.deepEqual(pathFrom(e.musicIn, new Set([analyser])), ["gain", "gain", "compressor", "gain", "destination"]);
  e.setEq(eqGainsFor("custom", [0.01, 0, 0, 0, 0, 0, 0, 0, 0, 0]));
  assert.equal(e.eqActive, false, "flat within 0.05 dB is bypassed too");
  e.setEq([40, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
  assert.equal(bands[0].gain.value, 12, "clamped to ±12");
});

test("an EQ set before the context exists is applied when the bus is built", async () => {
  globalThis.AudioContext = FakeContext;
  const e = new AudioEngine();
  e.setEq(eqGainsFor("tv"));
  e.setLoudnessGainDb(-6);
  await e.ensureContext();
  assert.equal(e.eqActive, true);
  assert.deepEqual(e.ctx.nodes.filter((n) => n.kind === "biquad").map((b) => b.gain.value), [...EQ_PRESETS.tv]);
  const analyser = [...e.musicIn.outs].find((n) => n.kind === "analyser");
  assert.equal([...e.musicIn.outs].filter((n) => n !== analyser).length, 1, "one path out, not two");
  const loud = e.ctx.nodes.find((n) => n.kind === "compressor");
  const loudGain = e.ctx.nodes.find((n) => n.kind === "gain" && n.outs.has(loud));
  assert.ok(Math.abs(20 * Math.log10(loudGain.gain.value) + 6) < 1e-9);
});

test("setLoudnessGainDb ramps linearly from where the gain is", async () => {
  const e = await busEngine();
  const comp = e.ctx.nodes.find((n) => n.kind === "compressor");
  const loudGain = e.ctx.nodes.find((n) => n.kind === "gain" && n.outs.has(comp));
  e.setLoudnessGainDb(6);
  const ev = loudGain.gain.events;
  assert.deepEqual(ev[0], ["cancel", 10]);
  assert.deepEqual(ev[1], ["set", 1, 10], "the ramp starts from the current value, now");
  assert.equal(ev[2][0], "ramp");
  assert.ok(Math.abs(ev[2][1] - 10 ** (6 / 20)) < 1e-12);
  assert.ok(Math.abs(ev[2][2] - 10.2) < 1e-12, "200 ms by default");
  assert.equal(e.loudnessGainDb, 6);
  loudGain.gain.events.length = 0;
  e.setLoudnessGainDb(-3, 0);
  assert.equal(loudGain.gain.events.at(-1)[0], "set", "rampMs 0 = at once");
  e.setLoudnessGainDb(NaN);
  assert.equal(e.loudnessGainDb, 0, "non-finite → 0 dB");
  e.setLoudnessGainDb(99);
  assert.equal(e.loudnessGainDb, 12, "sanity bound");
});

test("reverb and chorus levels set before init are applied by init, then on each level change", async () => {
  globalThis.AudioContext = FakeContext;
  let synth = null;
  globalThis.__m10FakeSynth = () => (synth = fakeSynth());
  globalThis.__m10FakeSeq = () => fakeSeq();
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(new Uint8Array(4));
  try {
    const e = new AudioEngine();
    e.setReverbLevel(4);
    e.setChorusLevel(0);
    assert.equal(synth, null, "before init: nothing to talk to, stored only");
    await e.init(() => {}, "/x.sf2");
    assert.ok(e.ready);
    assert.ok(synth.connected.includes(e.gain), "the synth still feeds the volume gain");
    assert.deepEqual(synth.master, [["reverbGain", 2], ["chorusGain", 0]]);
    synth.master.length = 0;
    e.setReverbLevel(1);
    assert.deepEqual(synth.master, [["reverbGain", 0.5], ["chorusGain", 0]]);
    synth.master.length = 0;
    e.loadSong(new ArrayBuffer(8));
    assert.deepEqual(synth.master, [["reverbGain", 0.5], ["chorusGain", 0]], "a song load re-asserts them");
    assert.equal(e.reverbLevel, 1);
    assert.equal(e.chorusLevel, 0);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("the default reverb / chorus level is unity", async () => {
  const e = readyEngine();
  e.setReverbLevel(2);
  assert.deepEqual(e.synth.master, [["reverbGain", 1], ["chorusGain", 1]]);
});

// --- 2. audio.js: the loudness reading --------------------------------------------------------------

// MUTATION-PROVEN: returning the raw `sum / buf.length` from readMusicMeanSquare fails the first
// equality; dividing by this._volume for a "chain" source fails the chain case.
test("readMusicMeanSquare divides out the active source's volume", async () => {
  const e = await busEngine();
  assert.equal(normalizeMeanSquare, nmsLoudness, "audio.js re-exports the pure helper");
  const level = 0.1;                                        // the song's own amplitude
  e.setVolume(0.5); e.ctx.signal = level * 0.5;
  const atHalf = e.readMusicMeanSquare();
  e.setVolume(1); e.ctx.signal = level * 1;
  const atFull = e.readMusicMeanSquare();
  assert.ok(near(atHalf, level * level), `synth at 50%: ${atHalf}`);
  assert.ok(near(atFull, level * level));

  // an audio song: the chain's own gain is the volume (the synth's _volume is stale on purpose)
  e.setVolume(0.9);
  const chain = { gain: { gain: { value: 0.25 } }, volume: 0.25 };
  e.setActiveSource("chain", { chain });                   // an engine holding .chain
  assert.equal(e.activeSource, "chain");
  e.ctx.signal = level * 0.25;
  assert.ok(near(e.readMusicMeanSquare(), level * level), "divided by the chain's 0.25²");
  e.setActiveSource("chain", chain);                       // the chain itself works too
  assert.ok(near(e.readMusicMeanSquare(), level * level));
  e.setActiveSource({ chain });                            // the engine alone, or another name, works too
  assert.equal(e.activeSource, "chain");
  e.setActiveSource("synth");
  e.setActiveSource("audio", { chain });
  assert.equal(e.activeSource, "chain");
  e.setActiveSource("chain", null);                        // no chain → back to the synth
  assert.equal(e.activeSource, "synth");
  e.setActiveSource("chain", { chain });
  e.setActiveSource("synth", { chain });                   // "synth" always means the synth
  assert.equal(e.activeSource, "synth");
  e.setActiveSource("synth");
  e.ctx.signal = level * 0.9;
  assert.ok(near(e.readMusicMeanSquare(), level * level));
});

test("readMusicMeanSquare is 0 before the context and never divides by zero", async () => {
  assert.equal(new AudioEngine().readMusicMeanSquare(), 0);
  const e = await busEngine();
  e.setVolume(0); e.ctx.signal = 0;
  assert.equal(e.readMusicMeanSquare(), 0);
});

// --- 2. pitch-chain.js ------------------------------------------------------------------------------

globalThis.AudioWorkletNode = class {
  constructor(ctx, name, opts) {
    Object.assign(this, new FakeNode(ctx, "worklet:" + name));
    this.connect = FakeNode.prototype.connect; this.disconnect = FakeNode.prototype.disconnect;
    this.opts = opts;
    this.parameters = new Map([["enabled", new FakeParam(0)], ["ratio", new FakeParam(1)]]);
  }
};

test("the key-shift chain's gain feeds musicIn, and still key-shifts there", async () => {
  const e = await busEngine();
  const chain = new KeyShiftChain(e);
  chain.setVolume(1.5);
  assert.equal(await chain.ensure({}), true);
  assert.ok(chain.gain.outs.has(e.musicIn), "audio / video songs go through the music bus");
  assert.ok(!chain.gain.outs.has(e.ctx.destination));
  assert.equal(chain.gain.gain.value, 1.5);
  chain.setKey(3);
  assert.ok(chain.src.outs.has(chain.pitch) && chain.pitch.outs.has(chain.gain), "re-keyed: through the worklet");
  assert.ok(Math.abs(chain.pitch.parameters.get("ratio").value - 2 ** (3 / 12)) < 1e-12);
  e.setActiveSource("chain", chain);
  e.ctx.signal = 0.1 * 1.5;
  assert.ok(near(e.readMusicMeanSquare(), 0.01), "normalised by the chain's 1.5");
});

test("an engine without musicIn still gets a chain wired to the destination", async () => {
  const ctx = new FakeContext();
  const engine = { ensureContext: async () => ctx, ensureWorkletModule: async () => {} };
  const chain = new KeyShiftChain(engine);
  assert.equal(await chain.ensure({}), true);
  assert.ok(chain.gain.outs.has(ctx.destination));
});
