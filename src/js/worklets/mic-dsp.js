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
    // PER-CHANNEL state (lazily grown to the live input channel count): the mic
    // feeds 1 channel (behaves exactly as the old mono shifter); a stereo music
    // file feeds 2, and each channel shifts through its OWN ring buffer + grain
    // phase so the stereo image is preserved (no L→mono collapse).
    this.bufs = []; // Float32Array[N] per channel
    this.wps = [];  // write pointer per channel
    this.rps = [];  // grain phase (read offset behind write, 0..G) per channel
  }

  _ensure(nCh) {
    while (this.bufs.length < nCh) {
      this.bufs.push(new Float32Array(this.N));
      this.wps.push(0);
      this.rps.push(0);
    }
  }

  _read(buf, pos) {
    // fractional read with wrap + linear interpolation
    let p = pos % this.N;
    if (p < 0) p += this.N;
    const i0 = Math.floor(p);
    const i1 = (i0 + 1) % this.N;
    const f = p - i0;
    return buf[i0] * (1 - f) + buf[i1] * f;
  }

  process(inputs, outputs, params) {
    const input = inputs[0];
    const output = outputs[0];
    if (!input || input.length === 0 || !input[0] || input[0].length === 0) return true;
    const nCh = input.length;
    const n = input[0].length;
    const enabled = params.enabled[0] > 0.5;
    const ratio = params.ratio[0];
    const shifting = enabled && Math.abs(ratio - 1) >= 1e-3;
    const G = this.G;
    const TWO_PI = Math.PI * 2;
    this._ensure(nCh);

    for (let i = 0; i < n; i++) {
      // write this sample into every input channel's ring buffer
      for (let c = 0; c < nCh; c++) this.bufs[c][this.wps[c]] = input[c][i];

      // produce each output channel from its (or the last available) input channel
      for (let oc = 0; oc < output.length; oc++) {
        const c = oc < nCh ? oc : nCh - 1;
        if (!shifting) {
          output[oc][i] = input[c] ? input[c][i] : 0;
          continue;
        }
        // two grains, half a grain apart, Hann-windowed, crossfaded
        const buf = this.bufs[c];
        const wp = this.wps[c];
        const rp = this.rps[c];
        const d1 = rp;
        const d2 = (rp + G / 2) % G;
        const s1 = this._read(buf, wp - d1);
        const s2 = this._read(buf, wp - d2);
        const w1 = 0.5 * (1 - Math.cos((TWO_PI * d1) / G));
        const w2 = 0.5 * (1 - Math.cos((TWO_PI * d2) / G));
        output[oc][i] = s1 * w1 + s2 * w2;
      }

      // advance write pointer (+ grain phase while shifting) once per input channel
      for (let c = 0; c < nCh; c++) {
        if (shifting) {
          this.rps[c] += 1 - ratio;
          this.rps[c] = ((this.rps[c] % G) + G) % G;
        }
        this.wps[c] = (this.wps[c] + 1) % this.N;
      }
    }
    return true;
  }
}

registerProcessor("noise-gate", NoiseGateProcessor);
registerProcessor("pitch-shift", PitchShiftProcessor);
