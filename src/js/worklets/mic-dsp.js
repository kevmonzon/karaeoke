/*
 * mic-dsp.js — AudioWorklet DSP for the microphone chain.
 * Registers two processors, both mono-in/mono-out (channel 0 processed, copied
 * to all output channels). Each passes audio through untouched when disabled.
 *
 *   'noise-gate'  — envelope-following gate: mutes the mic below a threshold so
 *                   room noise / low-level feedback buildup isn't amplified.
 *   'pitch-shift' — 2-grain crossfading delay-line pitch shifter (manual shift;
 *                   the building block toward auto-tune).
 *
 * Loaded on the shared AudioContext via audioWorklet.addModule().
 */

class NoiseGateProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      // linear amplitude threshold (mic.js converts dB → linear)
      { name: "threshold", defaultValue: 0.003, minValue: 0, maxValue: 1, automationRate: "k-rate" },
      { name: "enabled", defaultValue: 0, minValue: 0, maxValue: 1, automationRate: "k-rate" },
    ];
  }
  constructor() {
    super();
    this.env = 0;   // envelope follower
    this.gain = 0;  // smoothed gate gain
  }
  process(inputs, outputs, params) {
    const input = inputs[0];
    const output = outputs[0];
    if (!input || !input[0]) return true;
    const inCh = input[0];
    const n = inCh.length;
    const enabled = params.enabled[0] > 0.5;
    const thr = params.threshold[0];

    for (let i = 0; i < n; i++) {
      const a = Math.abs(inCh[i]);
      // fast attack, slow release envelope
      this.env += (a - this.env) * (a > this.env ? 0.25 : 0.005);
      const target = !enabled || this.env > thr ? 1 : 0;
      // smooth the gate so it doesn't click
      this.gain += (target - this.gain) * (target > this.gain ? 0.2 : 0.02);
      const g = this.gain;
      for (let c = 0; c < output.length; c++) {
        const src = input[c] || inCh;
        output[c][i] = src[i] * g;
      }
    }
    return true;
  }
}

class PitchShiftProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: "ratio", defaultValue: 1, minValue: 0.5, maxValue: 2, automationRate: "k-rate" },
      { name: "enabled", defaultValue: 0, minValue: 0, maxValue: 1, automationRate: "k-rate" },
    ];
  }
  constructor() {
    super();
    // Larger grain = smoother pitch shifting on sustained voice (fewer grain
    // transitions → less warble), at the cost of a little more latency. N = 2·G.
    this.N = 6144;            // ring buffer size
    this.G = 3072;            // grain length (samples)
    this.buf = new Float32Array(this.N);
    this.wp = 0;              // write pointer
    this.rp = 0;             // read offset behind write (grain phase), 0..G
  }

  _read(pos) {
    // fractional read with wrap + linear interpolation
    let p = pos % this.N;
    if (p < 0) p += this.N;
    const i0 = Math.floor(p);
    const i1 = (i0 + 1) % this.N;
    const f = p - i0;
    return this.buf[i0] * (1 - f) + this.buf[i1] * f;
  }

  process(inputs, outputs, params) {
    const input = inputs[0];
    const output = outputs[0];
    if (!input || !input[0]) return true;
    const inCh = input[0];
    const n = inCh.length;
    const enabled = params.enabled[0] > 0.5;
    const ratio = params.ratio[0];
    const G = this.G;
    const TWO_PI = Math.PI * 2;

    for (let i = 0; i < n; i++) {
      this.buf[this.wp] = inCh[i];

      let out;
      if (!enabled || Math.abs(ratio - 1) < 1e-3) {
        out = inCh[i];
      } else {
        // two grains, half a grain apart, Hann-windowed, crossfaded
        const d1 = this.rp;
        const d2 = (this.rp + G / 2) % G;
        const s1 = this._read(this.wp - d1);
        const s2 = this._read(this.wp - d2);
        const w1 = 0.5 * (1 - Math.cos((TWO_PI * d1) / G));
        const w2 = 0.5 * (1 - Math.cos((TWO_PI * d2) / G));
        out = s1 * w1 + s2 * w2;

        // advance grain phase so playback pitch = ratio
        this.rp += 1 - ratio;
        this.rp = ((this.rp % G) + G) % G;
      }

      for (let c = 0; c < output.length; c++) output[c][i] = out;
      this.wp = (this.wp + 1) % this.N;
    }
    return true;
  }
}

registerProcessor("noise-gate", NoiseGateProcessor);
registerProcessor("pitch-shift", PitchShiftProcessor);
