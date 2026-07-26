/*
 * pitch-chain.js — KeyShiftChain: routes ONE media element through the shared
 * AudioContext into the `pitch-shift` worklet, giving a real-time (stereo) KEY
 * change + volume >100%. Shared by AudioFileEngine (audio songs) and VideoEngine
 * (the video's #kva sound element) so the stereo-worklet integration lives in one place.
 *
 *   mediaEl → MediaElementSource → [pitch-shift, bypassed at Key 0] → Gain → destination
 *
 * The pitch node is BYPASSED entirely at Key 0 (source→gain), so the default case is
 * pristine full-quality stereo; the worklet only sits in the path when actually re-keyed.
 */

const WORKLET_URL = "./js/worklets/mic-dsp.js";
const clampKey = (s) => Math.max(-12, Math.min(12, s | 0));

export class KeyShiftChain {
  /** @param {import('./audio.js').AudioEngine} audioEngine  shared engine (context + worklet) */
  constructor(audioEngine) {
    this.engine = audioEngine;
    this._key = 0;
    this._vol = 0.9;
    this._wired = false;
    this._routeMode = null; // "bypass" | "pitch"
    this.ctx = null;
    this.src = null;   // MediaElementAudioSourceNode (once per element)
    this.pitch = null; // pitch-shift worklet node
    this.gain = null;  // dedicated gain → destination
  }

  get wired() { return this._wired; }

  /**
   * Wire the element into the graph ONCE. Returns true if it is now routed through
   * WebAudio, false if it couldn't be (the caller should keep the bare element so audio
   * never goes silent). Resumes the context BEFORE createMediaElementSource — a source
   * tied to a suspended context stalls the element's load (see §5.20) — and only routes
   * onto a *running* context.
   */
  async ensure(mediaEl) {
    if (this._wired) return true;
    let ctx;
    try {
      ctx = await this.engine.ensureContext();
      try { await ctx.resume(); } catch (_) {}
      if (ctx.state !== "running") return false; // don't route onto a dead context
    } catch (_) { return false; }

    // shared one-time worklet load (mic uses the same module → never double-add)
    let hasWorklet = true;
    try { await this.engine.ensureWorkletModule(WORKLET_URL); } catch (_) { hasWorklet = false; }

    let src;
    try { src = ctx.createMediaElementSource(mediaEl); }
    catch (_) { return false; } // already wrapped / failed → keep the bare element

    this.ctx = ctx;
    this.src = src;
    this.gain = ctx.createGain();
    this.gain.gain.value = this._vol;
    this.gain.connect(ctx.destination);
    if (hasWorklet) {
      try {
        this.pitch = new AudioWorkletNode(ctx, "pitch-shift", {
          outputChannelCount: [2], channelCount: 2, channelCountMode: "explicit",
        });
      } catch (_) { this.pitch = null; } // no re-key available → always bypass
    }
    this._wired = true;
    this._applyKey(); // establish initial routing (bypass at Key 0)
    return true;
  }

  _route(mode) {
    if (!this._wired) return;
    try { this.src.disconnect(); } catch (_) {}
    if (this.pitch) { try { this.pitch.disconnect(); } catch (_) {} }
    if (mode === "pitch" && this.pitch) {
      this.src.connect(this.pitch);
      this.pitch.connect(this.gain);
    } else {
      this.src.connect(this.gain); // pristine stereo passthrough
      mode = "bypass";
    }
    this._routeMode = mode;
  }

  _applyKey() {
    if (!this._wired) return;
    if (this._key === 0 || !this.pitch) {
      if (this._routeMode !== "bypass") this._route("bypass");
      return;
    }
    const p = this.pitch.parameters;
    p.get("enabled").value = 1;
    p.get("ratio").value = Math.pow(2, this._key / 12);
    if (this._routeMode !== "pitch") this._route("pitch"); // only re-route on a mode change (no click)
  }

  /** KEY change = real pitch-shift (stereo). Clamped to ±12 semitones (worklet ratio 0.5–2). */
  setKey(semitones) {
    this._key = clampKey(semitones);
    this._applyKey();
  }
  get key() { return this._key; }

  /** GainNode → can boost past 100% (unlike a bare media element). Stored so it's applied on wire. */
  setVolume(v) {
    this._vol = v;
    if (this.gain) this.gain.gain.value = Math.max(0, v);
  }
  get volume() { return this._vol; }
}
