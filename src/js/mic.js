/*
 * mic.js — microphone input + voice-effects chain, mixed alongside the music.
 *
 * Signal flow (all on the shared AudioContext from AudioEngine):
 *
 *   getUserMedia → MediaStreamSource
 *     → highpass (rumble cut)
 *     → noise-gate (worklet)
 *     → pitch-shift (worklet)          ← inline: shifts the whole voice
 *     → [tap] ─┬─ dryGain ─────────────────────────┐
 *              ├─ delay(+feedback) → echoWet ───────┤
 *              ├─ chorusDelay(LFO)  → chorusWet ────┤→ micGain → ctx.destination
 *              └─ convolver(IR)     → reverbWet ────┘
 *
 * Feedback control:
 *   - browser AEC / noise-suppression / auto-gain via getUserMedia constraints
 *   - a high-pass and a noise gate on top
 *   - (best fix is still headphones — see the panel hint)
 *
 * Everything is driven by Settings under the `mic.*` group. Effects toggle by
 * setting their wet gain to 0 and the worklets pass through when disabled, so no
 * graph surgery is needed except when the getUserMedia constraints change.
 */

import { hzToMidi } from "./melody.js";

const WORKLET_URL = "./js/worklets/mic-dsp.js";

// Hold the last voiced pitch this long across unvoiced/missed frames (~4 detect ticks).
// Long enough to bridge consonants/transitions, short enough that a real note-off frees it.
const PITCH_HOLD_MS = 120;

const dbToLin = (db) => Math.pow(10, db / 20);
const semisToRatio = (s) => Math.pow(2, s / 12);
// median of up to 3 recent values — rejects a lone octave-jumped frame without lag.
const median3 = (a) => {
  if (a.length === 1) return a[0];
  const s = [...a].sort((x, y) => x - y);
  return s[s.length >> 1];
};

export class MicEngine {
  constructor(audioEngine, settings) {
    this.audio = audioEngine;
    this.settings = settings;
    this.enabled = false;
    this.stream = null;
    this._nodes = null;
    this._workletsLoaded = false;
    this.autotuneActive = false;
    this._autoShift = 0; // smoothed autotune shift in semitones
    // Pitch tracking: the worker returns a value every ~30 ms but misses the odd frame
    // (consonants, vibrato troughs, transitions). We median-filter recent detections to
    // reject single-frame octave jumps, smooth lightly, and HOLD the last good value for
    // PITCH_HOLD_MS so one unvoiced frame doesn't blank the note (the visible dropout).
    this._heldMidi = null;     // smoothed pitch returned to consumers (guide/score/autotune)
    this._lastValidAt = 0;     // performance.now() of the last voiced detection
    this._recent = [];         // recent voiced MIDI values, for the median filter
    this._worker = null;
    this._detectTimer = null;
    this.onStatus = () => {};
  }

  get available() {
    return !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
  }

  _constraints() {
    const g = (k) => this.settings.get("mic." + k);
    return {
      audio: {
        echoCancellation: !!g("echoCancellation"),
        noiseSuppression: !!g("noiseSuppression"),
        autoGainControl: !!g("autoGainControl"),
      },
      video: false,
    };
  }

  async enable() {
    if (this.enabled) return true;
    if (!this.available) { this.onStatus("Microphone not supported in this browser"); return false; }
    const ctx = await this.audio.ensureContext();
    try { await ctx.resume(); } catch (_) {}

    if (!this._workletsLoaded) {
      await this.audio.ensureWorkletModule(WORKLET_URL); // shared one-time load (also used by audiofile.js)
      this._workletsLoaded = true;
    }

    try {
      this.stream = await navigator.mediaDevices.getUserMedia(this._constraints());
    } catch (e) {
      this.onStatus("Mic access denied or unavailable: " + e.name);
      return false;
    }

    this._build(ctx);
    this._startDetection();
    this.enabled = true;
    this.applySettings();
    this.settings.set("mic.enabled", true, { silent: true });
    this.onStatus("Microphone live" + (this.settings.get("mic.echoCancellation") ? " (echo-cancel on)" : ""));
    return true;
  }

  // Off-main-thread pitch detection: post the analyser buffer to the worker on a
  // timer; it replies with Hz, which we cache as a MIDI note for getPitchMidi().
  _startDetection() {
    if (this._worker) return;
    this._worker = new Worker(new URL("./workers/pitch-worker.js", import.meta.url));
    this._worker.onmessage = (e) => {
      if (e.data > 0) {
        const m = hzToMidi(e.data);
        this._recent.push(m);
        if (this._recent.length > 3) this._recent.shift();
        const med = median3(this._recent);         // drop single-frame octave spikes
        this._heldMidi = this._heldMidi == null ? med : this._heldMidi + 0.5 * (med - this._heldMidi); // light smoothing
        this._lastValidAt = performance.now();
      }
      // An unvoiced frame (e.data <= 0) is NOT applied here — getPitchMidi holds the
      // last good value for PITCH_HOLD_MS, then releases it (see below).
    };
    this._detectTimer = setInterval(() => {
      if (!this._nodes) return;
      this._nodes.analyser.getFloatTimeDomainData(this._pitchBuf);
      this._worker.postMessage({ buf: this._pitchBuf, rate: this.audio.ctx.sampleRate });
    }, 30);
  }
  _stopDetection() {
    if (this._detectTimer) { clearInterval(this._detectTimer); this._detectTimer = null; }
    if (this._worker) { this._worker.terminate(); this._worker = null; }
    this._heldMidi = null;
    this._recent.length = 0;
    this._lastValidAt = 0;
  }

  disable() {
    this._stopDetection();
    if (this.stream) { this.stream.getTracks().forEach((t) => t.stop()); this.stream = null; }
    if (this._nodes) {
      try { this._nodes.src.disconnect(); } catch (_) {}
      try { this._nodes.micGain.disconnect(); } catch (_) {}
      try { this._nodes.lfo.stop(); } catch (_) {}
      this._nodes = null;
    }
    this.enabled = false;
    this.settings.set("mic.enabled", false, { silent: true });
    this.onStatus("Microphone off");
  }

  /** Re-acquire the stream (needed when AEC/NS/AGC constraints change). */
  async reacquire() {
    if (!this.enabled) return; // nothing to re-acquire when the mic is off
    this.disable();
    await this.enable();
  }

  _makeIR(ctx, seconds = 2.2, decay = 3) {
    const rate = ctx.sampleRate;
    const len = Math.max(1, Math.floor(rate * seconds));
    const buf = ctx.createBuffer(2, len, rate);
    for (let c = 0; c < 2; c++) {
      const d = buf.getChannelData(c);
      for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decay);
    }
    return buf;
  }

  _build(ctx) {
    const src = ctx.createMediaStreamSource(this.stream);

    const highpass = ctx.createBiquadFilter();
    highpass.type = "highpass";

    const gate = new AudioWorkletNode(ctx, "noise-gate");
    const pitch = new AudioWorkletNode(ctx, "pitch-shift");

    // analyser on the PRE-gate (post-highpass) voice for pitch detection: the noise
    // gate closes on quiet notes / between phrases, and tapping after it starved the
    // detector → dropouts. Tapping before it keeps the gate for feedback control while
    // the detector always sees the raw sung voice (real silence is still rejected by
    // the worker's RMS floor + the hold in getPitchMidi). Highpass first drops rumble.
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 2048;
    this._pitchBuf = new Float32Array(analyser.fftSize);

    // dry + parallel effect sends → micGain
    const micGain = ctx.createGain();
    const dryGain = ctx.createGain();
    dryGain.gain.value = 1;

    // echo
    const delay = ctx.createDelay(1.5);
    const delayFb = ctx.createGain();
    const echoWet = ctx.createGain();
    delay.connect(delayFb); delayFb.connect(delay);

    // chorus (modulated delay)
    const chorusDelay = ctx.createDelay(0.1);
    chorusDelay.delayTime.value = 0.025;
    const lfo = ctx.createOscillator();
    lfo.type = "sine";
    const lfoGain = ctx.createGain();
    lfo.connect(lfoGain); lfoGain.connect(chorusDelay.delayTime); lfo.start();
    const chorusWet = ctx.createGain();

    // reverb
    const convolver = ctx.createConvolver();
    convolver.buffer = this._makeIR(ctx, this.settings.get("mic.reverb.seconds") || 2.2);
    const reverbWet = ctx.createGain();

    // wire: src → highpass → gate → pitch;  detection tap on highpass (pre-gate)
    src.connect(highpass);
    highpass.connect(analyser); // detection tap, pre-gate (analyser has no output; parallel)
    highpass.connect(gate);
    gate.connect(pitch);

    pitch.connect(dryGain); dryGain.connect(micGain);
    pitch.connect(delay); delay.connect(echoWet); echoWet.connect(micGain);
    pitch.connect(chorusDelay); chorusDelay.connect(chorusWet); chorusWet.connect(micGain);
    pitch.connect(convolver); convolver.connect(reverbWet); reverbWet.connect(micGain);

    micGain.connect(ctx.destination);

    this._nodes = { src, highpass, gate, pitch, analyser, micGain, dryGain,
      delay, delayFb, echoWet, chorusDelay, lfo, lfoGain, chorusWet, convolver, reverbWet };
  }

  // The pitch-shift worklet is driven by manual pitch + live autotune correction.
  _updatePitchNode() {
    if (!this._nodes) return;
    const manualOn = this.settings.get("mic.pitch.enabled");
    const manual = manualOn ? this.settings.get("mic.pitch.semitones") : 0;
    const auto = this.autotuneActive ? this._autoShift : 0;
    const p = this._nodes.pitch.parameters;
    p.get("enabled").value = manualOn || this.autotuneActive ? 1 : 0;
    p.get("ratio").value = semisToRatio(manual + auto);
  }

  /** Drive the correction from the rAF loop (semitones, smoothed to avoid zippering). */
  setAutotuneShift(semis) {
    this.autotuneActive = true;
    // gentle glide toward the target shift — less "zipper"/robotic than a hard jump
    this._autoShift += (semis - this._autoShift) * 0.3;
    this._updatePitchNode();
  }
  clearAutotune() {
    if (!this.autotuneActive) return;
    this.autotuneActive = false;
    this._autoShift = 0;
    this._updatePitchNode();
  }

  /** Live detected pitch as a (float) MIDI note, or null if unvoiced/off.
   *  Cheap read: returns the smoothed value, held across brief detection gaps so a
   *  single missed frame doesn't blank the note; released after PITCH_HOLD_MS of silence. */
  getPitchMidi() {
    if (!this.enabled || this._heldMidi == null) return null;
    if (performance.now() - this._lastValidAt > PITCH_HOLD_MS) {
      this._heldMidi = null;      // genuinely unvoiced now — release the note
      this._recent.length = 0;    // start the median fresh on the next phrase
      return null;
    }
    return this._heldMidi;
  }

  /** Push all live-adjustable params from Settings onto the graph. */
  applySettings() {
    if (!this._nodes) return;
    const g = (k) => this.settings.get("mic." + k);
    const N = this._nodes;
    const t = this.audio.ctx.currentTime;

    N.micGain.gain.setTargetAtTime(g("volume"), t, 0.02);

    // high-pass: bypass by dropping to 20 Hz when off
    N.highpass.frequency.setTargetAtTime(g("highpass") ? g("highpassHz") : 20, t, 0.02);

    // gate
    N.gate.parameters.get("enabled").value = g("gate") ? 1 : 0;
    N.gate.parameters.get("threshold").value = dbToLin(g("gateThresholdDb"));

    // pitch (manual + autotune combined)
    this._updatePitchNode();

    // echo
    N.delay.delayTime.setTargetAtTime((g("echo.timeMs") || 300) / 1000, t, 0.02);
    N.delayFb.gain.setTargetAtTime(g("echo.feedback"), t, 0.02);
    N.echoWet.gain.setTargetAtTime(g("echo.enabled") ? g("echo.mix") : 0, t, 0.02);

    // chorus
    N.lfo.frequency.setTargetAtTime(g("chorus.rateHz") || 1.5, t, 0.05);
    N.lfoGain.gain.setTargetAtTime(g("chorus.depth") || 0.006, t, 0.05);
    N.chorusWet.gain.setTargetAtTime(g("chorus.enabled") ? g("chorus.mix") : 0, t, 0.02);

    // reverb
    N.reverbWet.gain.setTargetAtTime(g("reverb.enabled") ? g("reverb.mix") : 0, t, 0.02);
  }
}
