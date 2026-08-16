/*
 * audiofile.js — AudioFileEngine: the playback path for AUDIO karaoke songs
 * (a recorded audio file + a separate lyric sidecar).
 *
 * Unlike a bare media element, this routes the <audio> through WebAudio (the shared
 * KeyShiftChain — see pitch-chain.js) so we get two things a plain element can't:
 * volume >100% (a GainNode) and an on-the-fly stereo KEY change (the `pitch-shift`
 * worklet, bypassed at Key 0). The graph lives on the SAME AudioContext as the synth +
 * mic (audio.ensureContext()).
 *
 * It exposes the same transport surface as AudioEngine/VideoEngine (so app.js drives it
 * through the one `media` handle) PLUS setKey(semitones). The lyric OFFSET is NOT handled
 * here — the lyrics are a separate rendered surface, so the offset moves the lyric time in
 * app.js (the MIDI way); setOffset() is a no-op.
 */

import { KeyShiftChain } from "./pitch-chain.js";
import { cachedArrayBuffer } from "./asset-cache.js";

// Blob MIME by extension (a typed blob is safest for the media element, though it also sniffs).
const AUDIO_MIME = {
  mp3: "audio/mpeg", wav: "audio/wav", flac: "audio/flac", m4a: "audio/mp4", mp4a: "audio/mp4",
  aac: "audio/aac", opus: "audio/ogg", oga: "audio/ogg", ogg: "audio/ogg", weba: "audio/webm", mp4: "audio/mp4",
};
const mimeForUrl = (u) => AUDIO_MIME[(u.split("?")[0].split(".").pop() || "").toLowerCase()] || "";

export class AudioFileEngine {
  /**
   * @param {HTMLAudioElement} audioEl  the sound element (#kaudio)
   * @param {import('./audio.js').AudioEngine} audioEngine  shared engine (for the context + worklet)
   */
  constructor(audioEl, audioEngine) {
    this.el = audioEl;
    this.engine = audioEngine;
    this.chain = new KeyShiftChain(audioEngine); // WebAudio pitch/volume chain
    this._rate = 1;
    this._objUrl = null; // in-memory blob URL for the current file
    this._live = false;  // true between load() and unload() — see _bindErrors
    this.onError = null; // set by app.js: (reason) => skip this song

    this.el.preload = "auto";
    this.el.volume = 1;                 // level is controlled by the chain's GainNode once wired
    try { this.el.preservesPitch = true; } catch (_) {} // tempo must not change pitch
    this._bindErrors();
  }

  /**
   * Report a dead file instead of hanging. `_ready()` resolves on a 4 s timeout even when the
   * source never loads and duration stays 0, so without this a missing/corrupt audio file left
   * the stage silent with no auto-advance. `_live` suppresses the spurious "Empty src" error
   * that unload()'s removeAttribute + load() raises. Fires once per load.
   */
  _bindErrors() {
    this.el.addEventListener("error", (ev) => {
      if (!this._live) return;
      this._live = false;
      const err = ev && ev.target && ev.target.error;
      if (this.onError) this.onError(err ? (err.message || "error " + err.code) : "error");
    });
  }

  // --- loading --------------------------------------------------------------
  /** Load the whole file into an in-memory BLOB URL and point the element at it, rather
   *  than letting the element stream over HTTP. Goes through `cachedArrayBuffer` so the
   *  file is stored in Cache Storage (same cache as the SoundFont + kar_raw MIDI) — a
   *  repeat play is instant + offline. Karaoke audio files are small, and the blob also
   *  makes loading + seeking reliable regardless of the server's HTTP range/keep-alive
   *  behavior. Falls back to direct streaming if the fetch fails. */
  async load(url) {
    this._revokeObjUrl();
    this._live = true;   // arm error reporting for this file
    try {
      const buf = await cachedArrayBuffer(url); // cache-first (Cache Storage), like MIDI + soundfont
      this._objUrl = URL.createObjectURL(new Blob([buf], { type: mimeForUrl(url) }));
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
    this._live = false;  // the src-removal below fires a spurious error — ignore it
    this.el.removeAttribute("src");
    this._revokeObjUrl();
    try { this.el.load(); } catch (_) {}
  }

  // --- transport ------------------------------------------------------------
  async play() {
    const wired = await this.chain.ensure(this.el); // resumes ctx + routes the element (resilient)
    if (wired) this.el.volume = 1;                  // level is the chain gain's job once wired
    await this._ready();                            // wait for the freshly-set src so play() isn't aborted
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
  /** KEY change = real pitch-shift (stereo, via the shared chain). */
  setKey(semitones) { this.chain.setKey(semitones); }
  get key() { return this.chain.key; }

  /** Volume via the chain's GainNode (to 200%); falls back to the bare element until wired. */
  setVolume(v) {
    this.chain.setVolume(v); // store + apply on the gain if wired
    this.el.volume = this.chain.wired ? 1 : Math.max(0, Math.min(1, v));
  }
  get volume() { return this.chain.volume; }

  setTempo(rate) {
    this._rate = rate;
    this.el.playbackRate = rate; // preservesPitch=true → tempo without pitch change
  }
  get tempo() { return this._rate; }

  /** No-op: the lyric offset moves the lyric TIME (app.js), not the audio. */
  setOffset(_ms) {} // no-op: audio offset moves the lyric time in app.js, not the audio (surface parity)

  // --- state for the UI loop ------------------------------------------------
  get currentTime() { return this.el.currentTime || 0; }
  get duration() { const d = this.el.duration; return isFinite(d) ? d : 0; }
  get paused() { return this.el.paused; }
}
