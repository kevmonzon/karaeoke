/*
 * audio.js — MIDI synthesis via SpessaSynth (WorkletSynthesizer + Sequencer),
 * wired exactly as verified against the reference build:
 *
 *   ctx  = new AudioContext()
 *   await ctx.audioWorklet.addModule('vendor/spessasynth_processor.min.js')
 *   synth = new WorkletSynthesizer(ctx);  await synth.isReady
 *   synth.connect(gain);  gain.connect(ctx.destination)
 *   await synth.soundBankManager.addSoundBank(sf2Buffer, 'main')
 *   seq  = new Sequencer(synth, { autoPlay:false })
 *   seq.loadNewSongList([{ binary: midiBuffer }]);  seq.play()
 *
 * Transport: play/pause/stop, key transpose (transposeChannel ×16),
 * tempo (seq.playbackRate), volume (GainNode).
 */

import { WorkletSynthesizer, Sequencer } from "spessasynth_lib";
import { cachedArrayBuffer } from "./asset-cache.js";

const PROCESSOR_URL = "./vendor/spessasynth_processor.min.js";
const SOUNDFONT_URL = "/soundfont.sf2";  // served from DATA_DIR (see tools/serve.py routing)
const NUM_CHANNELS = 16;

export class AudioEngine {
  constructor() {
    this.ctx = null;
    this.gain = null;
    this.synth = null;
    this.seq = null;
    this.ready = false;
    this._transpose = 0;
    this._volume = 0.9;
    // Per-channel mixer state (MIDI mode). Defaults = "don't touch": CC7 stays
    // unlocked so the song's own authored volume plays, until the user moves a slider.
    this._chVol = new Array(NUM_CHANNELS).fill(1);
    this._chLocked = new Array(NUM_CHANNELS).fill(false);
    // Real per-channel VU: one AnalyserNode per channel, tapped off the synth's 16
    // individual worklet outputs (channel N → output N+2). Null if the tap failed.
    this._analysers = null;
    this._meterBuf = null;
  }

  /**
   * One-time init. Must be called from a user gesture (AudioContext autoplay policy).
   * @param {(msg:string, frac?:number)=>void} onProgress
   */
  /**
   * Create the AudioContext + master gain only (no soundfont). Cheap; lets the
   * mic share one context without paying for the 30 MB SoundFont load.
   */
  async ensureContext() {
    if (this.ctx) return this.ctx;
    this.ctx = new AudioContext();
    this.gain = this.ctx.createGain();
    this.gain.gain.value = this._volume;
    this.gain.connect(this.ctx.destination);
    return this.ctx;
  }

  /**
   * Add an AudioWorklet module to the shared context AT MOST ONCE. A module that
   * calls registerProcessor() a second time throws "already registered", so the
   * mic and the audio-file engine (which share mic-dsp.js) must both route through
   * here rather than each calling addModule() independently.
   */
  async ensureWorkletModule(url) {
    await this.ensureContext();
    this._workletModules = this._workletModules || new Map();
    if (!this._workletModules.has(url)) {
      this._workletModules.set(url, this.ctx.audioWorklet.addModule(url));
    }
    return this._workletModules.get(url);
  }

  async init(onProgress = () => {}, soundfontUrl = SOUNDFONT_URL) {
    if (this.ready) return;

    onProgress("Starting audio engine…");
    await this.ensureContext();
    await this.ctx.audioWorklet.addModule(PROCESSOR_URL);

    this.synth = new WorkletSynthesizer(this.ctx);
    await this.synth.isReady;
    this.synth.connect(this.gain);
    this._setupChannelMeters();

    onProgress("Loading SoundFont (~30 MB, first run only)…");
    // Cache-first via Cache Storage (asset-cache.js): downloaded once, then instant
    // on every later load. No service worker — app code is never cached.
    const sfBuf = await cachedArrayBuffer(soundfontUrl, (frac) =>
      onProgress("Loading SoundFont…", frac)
    );
    await this.synth.soundBankManager.addSoundBank(sfBuf, "main");

    this.seq = new Sequencer(this.synth, { autoPlay: false });
    this.ready = true;
    onProgress("Ready");
  }

  /** Load a MIDI ArrayBuffer into the sequencer (does not auto-play). */
  loadSong(midiBuffer) {
    if (!this.ready) throw new Error("AudioEngine not initialised");
    this.seq.loadNewSongList([{ binary: midiBuffer }]);
    this.applyTranspose(this._transpose); // re-assert on the new song
    this.reassertChannelMix();            // re-apply any locked mixer channels on the new song
  }

  async play() {
    if (this.ctx.state === "suspended") await this.ctx.resume();
    this.seq.play();
  }
  pause() { if (this.seq) this.seq.pause(); }
  toggle() { this.seq && (this.seq.paused ? this.play() : this.pause()); }

  restart() {
    if (!this.seq) return;
    this.seq.currentTime = 0;
    this.play();
  }

  stop() {
    if (!this.seq) return;
    this.seq.pause();
    this.seq.currentTime = 0;
  }

  seek(seconds) { if (this.seq) this.seq.currentTime = seconds; }

  // --- performance controls -------------------------------------------------

  /**
   * Guide-vocal control on the detected melody channel: volume + mute (+ solo).
   * Uses CC7 (channel volume) locked so the song's own volume events don't fight
   * it. Non-intrusive at the default (volume 1, no mute/solo → the song controls
   * the melody as authored). Re-apply after each song load.
   */
  setGuideVocal(channel, { volume = 1, mute = false, solo = false } = {}) {
    if (!this.synth || channel == null || channel < 0) return;
    const boosting = volume > 1.001;              // >100%: emphasise melody
    const active = mute || solo || volume < 0.999 || boosting;
    // MIDI channel volume (CC7) maxes at 127 (=100%). Above 100% we instead DUCK
    // the other channels so the melody stands out (2.0 → backing silenced).
    const melCC = mute ? 0 : Math.min(127, Math.round(volume * 127));
    const duckCC = Math.round(127 * Math.max(0, 2 - Math.min(2, volume)));
    for (let ch = 0; ch < NUM_CHANNELS; ch++) {
      try {
        if (ch === channel) {
          this.synth.muteChannel(ch, mute);
          // Unlock BEFORE writing CC7 — a locked controller ignores controllerChange (§5.15),
          // so returning from a muted/locked state (CC7=0) needs unlock → set → (maybe) re-lock;
          // otherwise the melody stays silent after un-muting. melCC is 127 at volume 1 unmuted,
          // so this re-asserts full level instead of leaving the channel stuck at 0.
          this.synth.lockController(ch, 7, false);
          this.synth.controllerChange(ch, 7, melCC);
          if (active) this.synth.lockController(ch, 7, true);
        } else if (solo) {
          this.synth.muteChannel(ch, true); // solo = mute everything else
        } else {
          this.synth.muteChannel(ch, false);
          if (boosting) { this.synth.controllerChange(ch, 7, duckCC); this.synth.lockController(ch, 7, true); }
          else this.synth.lockController(ch, 7, false); // restore the song's own mix
        }
      } catch (_) {}
    }
  }

  // --- per-channel mixer (MIDI mode) ---------------------------------------
  //
  // Everything (volume, mute, solo) is driven through CC7 (channel volume): the mixer
  // passes an *effective* level per channel and mute/solo are just level 0. We do NOT
  // use `muteChannel` here — it mutes only the main mix, not the synth's individual
  // per-channel outputs, so the CC7 taps that feed the VU meters wouldn't reflect it
  // (the bar would keep bouncing on a "muted" channel). CC7 affects both the audible
  // mix and the individual output, so volume + VU stay consistent. A channel is only
  // *locked* once the user touches it, so untouched channels keep the song's authored
  // mix; the mixer is then authoritative for touched channels (last write wins with
  // setGuideVocal, which shares CC7).

  /** Set a channel's effective volume (0..1) via CC7, locked against the song's own CC7. */
  setChannelVolume(ch, v01) {
    if (ch < 0 || ch >= NUM_CHANNELS) return;
    this._chVol[ch] = v01;
    this._chLocked[ch] = true;
    if (!this.synth) return;
    try {
      // Unlock → set → re-lock: a locked controller ignores a plain change (the `force`
      // flag proved unreliable in the vendored build), so raising a channel back up after
      // it was set low would otherwise freeze it silent. Setting while unlocked always
      // lands; the re-lock then holds it against the song's own CC7 automation.
      this.synth.lockController(ch, 7, false);
      this.synth.controllerChange(ch, 7, Math.max(0, Math.min(127, Math.round(v01 * 127))));
      this.synth.lockController(ch, 7, true);
    } catch (_) {}
  }

  /** Re-apply the stored per-channel CC7 mix (called after a new song loads). */
  reassertChannelMix() {
    if (!this.synth) return;
    for (let ch = 0; ch < NUM_CHANNELS; ch++) {
      if (!this._chLocked[ch]) continue;
      try {
        this.synth.lockController(ch, 7, false);
        this.synth.controllerChange(ch, 7, Math.max(0, Math.min(127, Math.round(this._chVol[ch] * 127))));
        this.synth.lockController(ch, 7, true);
      } catch (_) {}
    }
  }

  /** Hand the mix back to the song: unlock CC7 on every channel, reset state. */
  releaseChannelMix() {
    for (let ch = 0; ch < NUM_CHANNELS; ch++) {
      this._chVol[ch] = 1; this._chLocked[ch] = false;
      if (!this.synth) continue;
      try { this.synth.lockController(ch, 7, false); } catch (_) {}
    }
  }

  /** Tap the synth's 16 individual outputs with AnalyserNodes for real per-channel VU. */
  _setupChannelMeters() {
    try {
      const nodes = [];
      for (let i = 0; i < NUM_CHANNELS; i++) {
        const a = this.ctx.createAnalyser();
        a.fftSize = 256;
        a.smoothingTimeConstant = 0.3;
        nodes.push(a);
      }
      this.synth.connectIndividualOutputs(nodes); // channel N → worklet output N+2
      this._analysers = nodes;
      this._meterBuf = new Float32Array(nodes[0].fftSize);
    } catch (e) {
      this._analysers = null; // metering unavailable → VU falls back to zeros
      console.warn("channel meters unavailable:", e);
    }
  }

  /**
   * Fill `out` (Float32Array length 16) with each channel's RMS level (0..~1).
   * Cheap; call once per frame only while the mixer is visible. Zeros if no taps.
   */
  getChannelLevels(out) {
    if (!this._analysers) { out.fill(0); return out; }
    const buf = this._meterBuf;
    for (let ch = 0; ch < NUM_CHANNELS; ch++) {
      this._analysers[ch].getFloatTimeDomainData(buf);
      let sum = 0;
      for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
      out[ch] = Math.sqrt(sum / buf.length);
    }
    return out;
  }

  /** Semitone transpose, applied to all 16 channels. */
  applyTranspose(semitones) {
    this._transpose = semitones;
    if (!this.synth) return;
    for (let ch = 0; ch < NUM_CHANNELS; ch++) {
      try { this.synth.transposeChannel(ch, semitones, true); } catch (_) {}
    }
  }
  get transpose() { return this._transpose; }

  /** Playback tempo multiplier (1.0 = original). */
  setTempo(rate) { if (this.seq) this.seq.playbackRate = rate; }
  get tempo() { return this.seq ? this.seq.playbackRate : 1; }

  setVolume(v) {
    this._volume = v;
    if (this.gain) this.gain.gain.value = v;
  }
  get volume() { return this._volume; }

  // --- state for the UI loop ------------------------------------------------

  get currentTime() { return this.seq ? this.seq.currentTime : 0; }
  get duration() { return this.seq ? this.seq.duration : 0; }
  get paused() { return this.seq ? this.seq.paused : true; }
  // The Sequencer doesn't loop (loopCount:0) and, at natural end, leaves `paused`
  // false with `currentTime` plateaued just short of `duration` — so a time-threshold
  // end-check misses it. `isFinished` is the authoritative "song is over" flag.
  get ended() { return this.seq ? !!this.seq.isFinished : false; }
}

