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

  async init(onProgress = () => {}, soundfontUrl = SOUNDFONT_URL) {
    if (this.ready) return;

    onProgress("Starting audio engine…");
    await this.ensureContext();
    await this.ctx.audioWorklet.addModule(PROCESSOR_URL);

    this.synth = new WorkletSynthesizer(this.ctx);
    await this.synth.isReady;
    this.synth.connect(this.gain);

    onProgress("Loading SoundFont (~30 MB, first run only)…");
    const sfBuf = await fetchBuffer(soundfontUrl, (frac) =>
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
          if (active) { this.synth.controllerChange(ch, 7, melCC); this.synth.lockController(ch, 7, true); }
          else this.synth.lockController(ch, 7, false);
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
}

/** fetch() an ArrayBuffer with optional progress (Content-Length based). */
async function fetchBuffer(url, onProgress) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Fetch failed ${res.status} for ${url}`);
  const total = +res.headers.get("content-length") || 0;
  if (!res.body || !total) return await res.arrayBuffer();

  const reader = res.body.getReader();
  const chunks = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.length;
    if (onProgress) onProgress(received / total);
  }
  const out = new Uint8Array(received);
  let off = 0;
  for (const c of chunks) { out.set(c, off); off += c.length; }
  return out.buffer;
}
