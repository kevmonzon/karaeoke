/*
 * audiofile.js — AudioFileEngine: the playback path for AUDIO karaoke songs
 * (a recorded audio file + a separate lyric sidecar).
 *
 * Unlike VideoEngine (a bare media element), this routes the <audio> through
 * WebAudio so we get two things a plain element can't: volume >100% (a GainNode)
 * and on-the-fly KEY change (the shared `pitch-shift` worklet). The graph lives on
 * the SAME AudioContext as the synth + mic (audio.ensureContext()):
 *
 *   <audio> ─► MediaElementSource ─► [pitch-shift, bypassed at Key 0] ─► Gain ─► destination
 *
 * It exposes the same transport surface as AudioEngine/VideoEngine (so app.js drives
 * it through the one `media` handle) PLUS setKey(semitones). The lyric OFFSET is NOT
 * handled here — the lyrics are a separate rendered surface, so the offset moves the
 * lyric time in app.js (the MIDI way); setOffset() is a no-op.
 */

const WORKLET_URL = "./js/worklets/mic-dsp.js";
const clampKey = (s) => Math.max(-12, Math.min(12, s | 0));

export class AudioFileEngine {
  /**
   * @param {HTMLAudioElement} audioEl  the sound element (#kaudio)
   * @param {import('./audio.js').AudioEngine} audioEngine  shared engine (for the context + worklet)
   */
  constructor(audioEl, audioEngine) {
    this.el = audioEl;
    this.engine = audioEngine;
    this._volume = 0.9;
    this._rate = 1;
    this._key = 0;

    this._wired = false;
    this._routeMode = null; // "bypass" | "pitch"
    this._objUrl = null;    // in-memory blob URL for the current file
    this.ctx = null;
    this.src = null;   // MediaElementAudioSourceNode (once per element)
    this.pitch = null; // pitch-shift worklet node
    this.gain = null;  // dedicated gain → destination

    this.el.preload = "auto";
    this.el.volume = 1;                 // level is controlled by the GainNode
    try { this.el.preservesPitch = true; } catch (_) {} // tempo must not change pitch
  }

  // --- WebAudio wiring (lazy, on first play) --------------------------------
  async _wire() {
    if (this._wired) return;
    const ctx = await this.engine.ensureContext();
    this.ctx = ctx;
    // Resume BEFORE routing the element into the graph. A MediaElementSource tied to a
    // SUSPENDED context stalls the element's load (readyState stuck at HAVE_NOTHING), so
    // the context must be running when createMediaElementSource() is called.
    try { await ctx.resume(); } catch (_) {}
    // shared one-time worklet load (mic uses the same module → never double-add)
    let hasWorklet = true;
    try { await this.engine.ensureWorkletModule(WORKLET_URL); }
    catch (_) { hasWorklet = false; }

    this.src = ctx.createMediaElementSource(this.el);
    this.gain = ctx.createGain();
    this.gain.gain.value = this._volume;
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
    if (this._routeMode !== "pitch") this._route("pitch"); // only re-route on mode change (no click)
  }

  // --- loading --------------------------------------------------------------
  /** Fetch the whole file into an in-memory BLOB URL and point the element at it,
   *  rather than letting the element stream over HTTP. Karaoke audio files are small,
   *  and this makes loading + seeking reliable regardless of the server's HTTP
   *  range/keep-alive behavior (some setups stall a media element's byte-range
   *  streaming even though fetch() of the same URL works fine). Falls back to direct
   *  streaming if the fetch fails. */
  async load(url) {
    this._revokeObjUrl();
    try {
      const resp = await fetch(url);
      if (!resp.ok) throw new Error("audio " + resp.status);
      this._objUrl = URL.createObjectURL(await resp.blob());
      this.el.src = this._objUrl;
    } catch (_) {
      this.el.src = url; // fallback: let the element stream it directly
    }
    this.el.playbackRate = this._rate;
    try { this.el.preservesPitch = true; } catch (_) {}
  }

  _revokeObjUrl() {
    if (this._objUrl) { try { URL.revokeObjectURL(this._objUrl); } catch (_) {} this._objUrl = null; }
  }

  /** Detach the source (switching away to another kind) — frees the decoder + blob. */
  unload() {
    this.stop();
    this.el.removeAttribute("src");
    this._revokeObjUrl();
    try { this.el.load(); } catch (_) {}
  }

  // --- transport ------------------------------------------------------------
  async play() {
    await this._wire();
    try { await this.ctx.resume(); } catch (_) {} // context may be suspended if audio is the FIRST thing played
    await this._ready();                          // wait for the freshly-set src so play() isn't aborted
    try { await this.el.play(); } catch (_) {}
  }

  _ready() {
    const el = this.el;
    if (el.readyState >= 3) return Promise.resolve(); // HAVE_FUTURE_DATA
    return new Promise((res) => {
      const done = () => { el.removeEventListener("canplay", done); clearTimeout(t); res(); };
      const t = setTimeout(done, 4000); // never hang if the file can't load
      el.addEventListener("canplay", done, { once: true });
    });
  }

  pause() { this.el.pause(); }
  toggle() { this.el.paused ? this.play() : this.pause(); }

  stop() {
    this.el.pause();
    try { this.el.currentTime = 0; } catch (_) {}
  }

  restart() {
    try { this.el.currentTime = 0; } catch (_) {}
    this.play();
  }

  seek(seconds) {
    try { this.el.currentTime = Math.max(0, seconds); } catch (_) {}
  }

  // --- performance controls -------------------------------------------------
  /** KEY change = real pitch-shift (stereo). Clamped to ±12 semitones (worklet ratio 0.5–2). */
  setKey(semitones) {
    this._key = clampKey(semitones);
    this._applyKey();
  }
  get key() { return this._key; }

  /** GainNode → can boost past 100% (unlike a bare media element). */
  setVolume(v) {
    this._volume = v;
    if (this.gain) this.gain.gain.value = Math.max(0, v);
  }
  get volume() { return this._volume; }

  setTempo(rate) {
    this._rate = rate;
    this.el.playbackRate = rate; // preservesPitch=true → tempo without pitch change
  }
  get tempo() { return this._rate; }

  /** No-op: the lyric offset moves the lyric TIME (app.js), not the audio. */
  setOffset() {}

  // --- state for the UI loop ------------------------------------------------
  get currentTime() { return this.el.currentTime || 0; }
  get duration() { const d = this.el.duration; return isFinite(d) ? d : 0; }
  get paused() { return this.el.paused; }
}
