/*
 * audio.js — MIDI synthesis via SpessaSynth (WorkletSynthesizer + Sequencer),
 * wired exactly as verified against the reference build:
 *
 *   ctx  = new AudioContext()
 *   await ctx.audioWorklet.addModule('vendor/spessasynth_processor.min.js')
 *   synth = new WorkletSynthesizer(ctx);  await synth.isReady
 *   synth.connect(gain);  gain.connect(musicIn)          ← M10: the music bus, below
 *   await synth.soundBankManager.addSoundBank(sf2Buffer, 'main')
 *   seq  = new Sequencer(synth, { autoPlay:false })
 *   seq.loadNewSongList([{ binary: midiBuffer }]);  seq.play()
 *
 * Transport: play/pause/stop, key transpose (transposeChannel ×16),
 * tempo (seq.playbackRate), volume (GainNode).
 *
 * THE MUSIC BUS (M10, plan §5.19 / §5.20). Built with the context, so the mic-only path has it too:
 *
 *   synth → this.gain (Volume) ──────┐
 *   KeyShiftChain.gain (Volume) ─────┴→ musicIn ─┬→ [10 peaking biquads | a straight wire when flat]
 *                                                └→ analyser (pre-EQ: readMusicMeanSquare)
 *     → loudGain (setLoudnessGainDb) → limiter (DynamicsCompressor) → limiterTrim → ctx.destination
 *
 * The mic (mic.js), the calibration's raw tap and the reaction applause connect to ctx.destination
 * themselves and never touch the bus. YouTube cannot be on it (a cross-origin iframe).
 * Defaults are the pre-M10 sound: flat EQ = musicIn wired straight to loudGain (the biquads are not in
 * the path at all), loudGain 0 dB, reverb/chorus level 2 = master gain 1 (SpessaSynth's own default), and
 * the limiter idle below −1 dBFS with its automatic make-up gain cancelled by limiterTrim (see
 * limiterMakeupDb). What default playback does pick up is the compressor's fixed ~6 ms look-ahead
 * (a pure delay on the music; the mic monitor, outside the bus, is not delayed).
 */

import { WorkletSynthesizer, Sequencer } from "spessasynth_lib";
import { cachedArrayBuffer } from "./asset-cache.js";
import { MediaEngineBase } from "./media-engine.js";
import { EQ_BANDS, EQ_Q, eqGainsFor, isFlat, fxLevelToGain, transposeForce } from "./music-fx.js";
import { normalizeMeanSquare } from "./loudness.js";

// The pure half of readMusicMeanSquare lives with the meter it feeds; exported here too (plan contract).
export { normalizeMeanSquare };

const PROCESSOR_URL = "./vendor/spessasynth_processor.min.js";
const SOUNDFONT_URL = "/soundfont.sf2";  // served from DATA_DIR (see tools/serve.py routing)
const NUM_CHANNELS = 16;

/** The limiter after the loudness gain: a brick-wall-ish DynamicsCompressor (plan §5.20). */
export const LIMITER = Object.freeze({ thresholdDb: -1, kneeDb: 0, ratio: 20, attackSec: 0.003, releaseSec: 0.25 });
const METER_FFT = 4096;          // ≈ 85 ms at 48 kHz per readMusicMeanSquare (app.js reads every ≥ 100 ms)
const EQ_SMOOTH_SEC = 0.03;      // time constant for a gain change while the EQ is already in the path
const LOUD_MIN_DB = -24, LOUD_MAX_DB = 12;   // sanity bounds; app.js clamps far tighter (gainForDb)

const dbToGain = (db) => Math.pow(10, db / 20);

/**
 * The automatic make-up gain a DynamicsCompressorNode applies to EVERYTHING it passes, in dB.
 * The Web Audio spec (and the WebKit/Blink/Gecko kernel it was written from): full-range gain =
 * the static curve applied to 1.0 (0 dBFS); make-up = (1 / full-range gain) ^ 0.6. With a hard knee
 * the curve at 0 dB is threshold + (0 − threshold) / ratio, so make-up = 0.6 · −threshold · (1 − 1/ratio).
 * For −1 dB / 20:1 that is +0.57 dB on the whole mix — enough to break "default sound unchanged within
 * 0.2 dB" — so limiterTrim applies the inverse after the compressor. (Hard knee only; LIMITER uses 0.)
 */
export function limiterMakeupDb(thresholdDb = LIMITER.thresholdDb, ratio = LIMITER.ratio) {
  const curveAt0 = thresholdDb + (0 - thresholdDb) / ratio;   // dB, ≤ 0
  return 0.6 * (0 - curveAt0);   // (0 − x), not −x: no −0 for a 0 dB threshold
}

/** An object that sounds through a KeyShiftChain: the chain itself, or an engine holding `.chain`. */
function chainOf(x) {
  if (!x || typeof x !== "object") return null;
  if (x.chain && typeof x.chain === "object" && "gain" in x.chain) return x.chain;  // AudioFileEngine / VideoEngine
  if ("gain" in x && "volume" in x) return x;                                       // a KeyShiftChain
  return null;
}

export class AudioEngine extends MediaEngineBase {
  constructor() {
    super();
    this.ctx = null;
    this.gain = null;
    this.synth = null;
    this.seq = null;
    this.ready = false;
    this._started = false;  // has the CURRENTLY loaded song been played? (see loadSong / get ended)
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
    // --- M10: drums, effects, the music bus (all stored before init / before the context, applied later)
    this._transposeDrums = false;  // default: key changes leave the drum kit alone (plan §5.18)
    this._drumsShifted = false;    // did an earlier FORCED pass leave the drum channel off 0? (see applyTranspose)
    this._reverbLevel = 2;         // 0..4, 2 = unity = SpessaSynth's own default
    this._chorusLevel = 2;
    this._eqGains = null;          // null = flat = bypassed
    this._eqRoute = null;          // "wire" | "eq" — what musicIn feeds right now
    this._loudDb = 0;
    this._source = "synth";        // which source's volume readMusicMeanSquare divides out (setActiveSource)
    this._sourceChain = null;
    this._musicIn = null;          // GainNode (unity): every musical source connects here
    this._musicAnalyser = null;
    this._musicBuf = null;
    this._eq = null;               // 10 BiquadFilterNodes, chained eq[0] → … → eq[9] → loudGain
    this._loudGain = null;
    this._limiter = null;
    this._limiterTrim = null;
  }

  /**
   * Create the AudioContext + master gain only (no soundfont). Cheap; lets the
   * mic share one context without paying for the 30 MB SoundFont load.
   * M10: also builds the music bus, and the master gain feeds it instead of the destination.
   */
  async ensureContext() {
    if (this.ctx) return this.ctx;
    this.ctx = new AudioContext();
    this.gain = this.ctx.createGain();
    this.gain.gain.value = this._volume;
    this._buildMusicBus();
    this.gain.connect(this._musicIn);
    return this.ctx;
  }

  /** Where every musical source connects (the synth's volume gain, the key-shift chains' gains).
   *  Null until ensureContext(). The mic must NOT connect here. */
  get musicIn() { return this._musicIn; }

  _buildMusicBus() {
    const ctx = this.ctx;
    this._musicIn = ctx.createGain();   // unity
    try {
      this._musicAnalyser = ctx.createAnalyser();
      this._musicAnalyser.fftSize = METER_FFT;
      this._musicAnalyser.smoothingTimeConstant = 0;
      this._musicBuf = new Float32Array(this._musicAnalyser.fftSize);
      this._musicIn.connect(this._musicAnalyser);   // a tap: an analyser passes nothing on
    } catch (e) { this._musicAnalyser = null; this._musicBuf = null; }
    try {
      this._loudGain = ctx.createGain();
      this._loudGain.gain.value = dbToGain(this._loudDb);
      const lim = ctx.createDynamicsCompressor();
      lim.threshold.value = LIMITER.thresholdDb;
      lim.knee.value = LIMITER.kneeDb;
      lim.ratio.value = LIMITER.ratio;
      lim.attack.value = LIMITER.attackSec;
      lim.release.value = LIMITER.releaseSec;
      const trim = ctx.createGain();
      trim.gain.value = dbToGain(-limiterMakeupDb(LIMITER.thresholdDb, LIMITER.ratio));
      this._loudGain.connect(lim);
      lim.connect(trim);
      trim.connect(ctx.destination);
      this._limiter = lim;
      this._limiterTrim = trim;
      this._eq = EQ_BANDS.map((f) => {
        const b = ctx.createBiquadFilter();
        b.type = "peaking";
        b.frequency.value = f;
        b.Q.value = EQ_Q;
        b.gain.value = 0;
        return b;
      });
      for (let i = 0; i < this._eq.length - 1; i++) this._eq[i].connect(this._eq[i + 1]);
      this._eq[this._eq.length - 1].connect(this._loudGain);
      this._eqRoute = null;
      this._applyEq();                  // wire (flat) or through the stored EQ
    } catch (e) {
      // A browser without one of these nodes must still play: the bus degrades to a straight wire.
      console.warn("music bus unavailable, playing unprocessed:", e);
      this._eq = null; this._limiter = null; this._limiterTrim = null; this._loudGain = null;
      try { this._musicIn.disconnect(); } catch (_) {}
      try { if (this._musicAnalyser) this._musicIn.connect(this._musicAnalyser); } catch (_) {}
      try { this._musicIn.connect(ctx.destination); } catch (_) {}
      this._eqRoute = "none";
    }
  }

  /** Point musicIn at the EQ chain or straight at loudGain, and set the band gains. Never throws. */
  _applyEq() {
    if (!this._musicIn || !this._eq || !this._loudGain || this._eqRoute === "none") return;
    const gains = this._eqGains;
    const want = !gains || isFlat(gains) ? "wire" : "eq";
    if (want === "eq") {
      const now = this.ctx.currentTime;
      for (let i = 0; i < this._eq.length; i++) {
        const p = this._eq[i].gain;
        const v = gains[i];
        try {
          if (this._eqRoute === "eq") p.setTargetAtTime(v, now, EQ_SMOOTH_SEC);   // live: glide, no zipper
          else { p.cancelScheduledValues(now); p.value = v; }                  // not in the path yet: jump
        } catch (_) { try { p.value = v; } catch (_) {} }
      }
    }
    if (this._eqRoute === want) return;
    const to = want === "eq" ? this._eq[0] : this._loudGain;
    const from = this._eqRoute === "eq" ? this._eq[0] : this._eqRoute === "wire" ? this._loudGain : null;
    try { this._musicIn.connect(to); } catch (_) { return; }        // new path first: never a silent gap
    if (from) { try { this._musicIn.disconnect(from); } catch (_) {} } // targeted: the analyser tap stays
    this._eqRoute = want;
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
      // Drop the entry if the load rejects, so a transient failure isn't cached forever
      // (a later call can retry) — resolved loads stay memoised.
      const p = this.ctx.audioWorklet.addModule(url)
        .catch((e) => { this._workletModules.delete(url); throw e; });
      this._workletModules.set(url, p);
    }
    return this._workletModules.get(url);
  }

  /**
   * One-time full init: AudioContext + SpessaSynth worklet + SoundFont + Sequencer.
   * Must be called from a user gesture (AudioContext autoplay policy).
   * @param {(msg:string, frac?:number)=>void} onProgress
   */
  async init(onProgress = () => {}, soundfontUrl = SOUNDFONT_URL) {
    if (this.ready) return;
    // `ready` only flips at the END of a multi-second init (32 MB soundfont), so a second
    // caller arriving mid-flight used to pass the guard and build a SECOND WorkletSynthesizer,
    // clobbering this.synth and the channel meters. Concurrent callers share one promise; a
    // rejected init is forgotten so a later attempt can retry.
    if (!this._initPromise) {
      this._initPromise = this._doInit(onProgress, soundfontUrl)
        .catch((e) => { this._initPromise = null; throw e; });
    }
    return this._initPromise;
  }

  async _doInit(onProgress, soundfontUrl) {
    onProgress("Starting audio engine…");
    await this.ensureContext();
    await this.ctx.audioWorklet.addModule(PROCESSOR_URL);

    this.synth = new WorkletSynthesizer(this.ctx);
    await this.synth.isReady;
    this.synth.connect(this.gain);
    this._applyFx();                 // reverb / chorus levels set before init land now
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
    // `isFinished` is NOT cleared by loadNewSongList — it keeps describing the PREVIOUS song
    // until the new one is actually played. MEASURED: a freshly loaded song reported
    // {ended:true, currentTime:1.55, duration:179.46}, which app.js read as "this song is over".
    // `_started` is the missing half: the flag only means anything once we have started THIS song.
    this._started = false;
    this.applyTranspose(this._transpose); // re-assert on the new song (with the stored drums flag)
    this.reassertChannelMix();            // re-apply any locked mixer channels on the new song
    this._applyFx();                      // cheap insurance: a song's reset must not undo the room's levels
  }

  async play() {
    if (this.ctx.state === "suspended") await this.ctx.resume();
    this.seq.play();
    this._started = true;   // from here on, `isFinished` describes the song we are playing
  }
  pause() { if (this.seq) this.seq.pause(); }
  /** The one engine that can legitimately not be ready: no Sequencer until init() has
   *  pulled the ~32 MB soundfont. MediaEngineBase.toggle/restart honour this. */
  get canPlay() { return !!this.seq; }

  stop() {
    if (!this.seq) return;
    this.seq.pause();
    this.seq.currentTime = 0;
    this._started = false;
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

  /**
   * Semitone transpose, applied to all 16 channels. The third transposeChannel argument (`force`) is
   * the STORED drums flag — transposeForce(this._transposeDrums), false by default — never a per-call
   * option: loadSong re-asserts with applyTranspose(this._transpose) and would drop one (F42).
   * With force false SpessaSynth skips drum channels outright (`drumChannel && !force` returns before
   * touching them; melodic channels transpose exactly as with true — measured, F30). Skipping also
   * means it never RESETS a drum channel, so after a forced pass left the kit at +N, turning the flag
   * off first brings every channel to 0 with force (once), then applies the key without it.
   */
  applyTranspose(semitones) {
    this._transpose = semitones;
    if (!this.synth) return;
    const force = transposeForce(this._transposeDrums);
    if (!force && this._drumsShifted) {
      for (let ch = 0; ch < NUM_CHANNELS; ch++) {
        try { this.synth.transposeChannel(ch, 0, true); } catch (_) {}
      }
      this._drumsShifted = false;
    }
    for (let ch = 0; ch < NUM_CHANNELS; ch++) {
      try { this.synth.transposeChannel(ch, semitones, force); } catch (_) {}
    }
    if (force) this._drumsShifted = !!semitones;
  }
  get transpose() { return this._transpose; }

  /** Transpose the drum kit with the key too (the pre-M10 behaviour)? Default false. Stored on the
   *  engine and re-applied at once; survives every loadSong (plan §5.18). */
  setTransposeDrums(on) {
    const next = on === true;
    if (next === this._transposeDrums) return;
    this._transposeDrums = next;
    this.applyTranspose(this._transpose);
  }
  get transposeDrums() { return this._transposeDrums; }

  // --- M10: reverb / chorus (SpessaSynth master parameters, F31) ------------

  /** Reverb level 0..4 (2 = the song's own sends at unity, the default). Before init: stored, applied by init. */
  setReverbLevel(level) { this._reverbLevel = level; this._applyFx(); }
  /** Chorus level 0..4 (2 = unity, the default). Before init: stored, applied by init. */
  setChorusLevel(level) { this._chorusLevel = level; this._applyFx(); }
  get reverbLevel() { return this._reverbLevel; }
  get chorusLevel() { return this._chorusLevel; }

  _applyFx() {
    const s = this.synth;
    if (!s || typeof s.setMasterParameter !== "function") return;
    try { s.setMasterParameter("reverbGain", fxLevelToGain(this._reverbLevel)); } catch (_) {}
    try { s.setMasterParameter("chorusGain", fxLevelToGain(this._chorusLevel)); } catch (_) {}
  }

  // --- M10: the music bus ---------------------------------------------------

  /**
   * The 10-band EQ, in dB per band of EQ_BANDS (music-fx.js eqGainsFor gives them). null, or every band
   * within 0.05 dB of 0 → BYPASSED: musicIn is wired straight to the loudness gain and the biquads are
   * not in the path at all. Values are clamped to ±12; missing / non-finite → 0. Before the context
   * exists the gains are stored and applied when it is created.
   */
  setEq(gainsDb) {
    const g = Array.isArray(gainsDb) ? eqGainsFor("custom", gainsDb) : null;   // ±12, junk → 0, a copy
    this._eqGains = g && !isFlat(g) ? g : null;
    this._applyEq();
  }
  /** True while the EQ is in the signal path (false = the straight wire). */
  get eqActive() { return this._eqRoute === "eq"; }

  /**
   * The loudness-equalisation gain in dB, ramped linearly over rampMs (0 = at once). Clamped to
   * [−24, +12] as a sanity bound; non-finite → 0. Before the context exists it is stored and the bus
   * starts at it.
   */
  setLoudnessGainDb(db, rampMs = 200) {
    const d = typeof db === "number" && Number.isFinite(db) ? Math.max(LOUD_MIN_DB, Math.min(LOUD_MAX_DB, db)) : 0;
    this._loudDb = d;
    const g = this._loudGain;
    if (!g || !this.ctx) return;
    const p = g.gain;
    const now = this.ctx.currentTime;
    const target = dbToGain(d);
    const sec = typeof rampMs === "number" && Number.isFinite(rampMs) && rampMs > 0 ? rampMs / 1000 : 0;
    try {
      const cur = p.value;                 // read BEFORE cancelling: mid-ramp this is where we are
      p.cancelScheduledValues(now);
      p.setValueAtTime(cur, now);          // a ramp needs an event to start from, or it starts at t = 0
      if (sec) p.linearRampToValueAtTime(target, now + sec);
      else p.setValueAtTime(target, now);
    } catch (_) { try { p.value = target; } catch (_) {} }
  }
  get loudnessGainDb() { return this._loudDb; }

  /**
   * Which source is playing, so readMusicMeanSquare divides out the right volume (plan R12):
   *   setActiveSource("synth")                 MIDI songs (the default) → this.volume
   *   setActiveSource("chain", audioFile)      AUDIO songs → that KeyShiftChain's gain value
   *   setActiveSource("chain", video)          VIDEO songs  (an engine with `.chain`, or the chain itself)
   * Forgiving on purpose: any name but "synth" ("audio", "video") with a resolvable chain counts as a
   * chain, and setActiveSource(audioFile) alone works too. Without a chain it falls back to "synth".
   * app.js calls it in each play*: the synth's volume is only kept current while the synth is ready
   * (applyAudioSettings skips it before init), so an audio-only night left on the default would divide
   * by a stale 0.9 instead of the real volume.
   */
  setActiveSource(source, chainOrEngine = null) {
    if (source && typeof source === "object") { chainOrEngine = source; source = "chain"; }
    const chain = source !== "synth" ? chainOf(chainOrEngine) : null;
    this._source = chain ? "chain" : "synth";
    this._sourceChain = chain;
  }
  get activeSource() { return this._source; }

  /** The volume the active source was set to (what readMusicMeanSquare divides out). */
  _activeVolume() {
    const c = this._source === "chain" ? this._sourceChain : null;
    if (c) {
      const g = c.gain && c.gain.gain;
      if (g && typeof g.value === "number") return g.value;   // what the chain actually applies
      if (typeof c.volume === "number") return Math.max(0, c.volume);
    }
    return this._volume;
  }

  /**
   * Mean-square of the music bus over the analyser's last window (≈ 85 ms), measured on musicIn —
   * BEFORE the EQ, the loudness gain and the limiter, so the loudness follower never hears itself —
   * and DIVIDED by the active source's volume² (normalizeMeanSquare), so the number does not depend on
   * where the Volume slider sat while a song was learned. The mono mix ((L+R)/2, the analyser's own
   * down-mix). 0 before the context exists or when the tap is unavailable.
   */
  readMusicMeanSquare() {
    const a = this._musicAnalyser, buf = this._musicBuf;
    if (!a || !buf) return 0;
    a.getFloatTimeDomainData(buf);
    let sum = 0;
    for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
    return normalizeMeanSquare(sum / buf.length, this._activeVolume());
  }

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
  // The Sequencer doesn't loop (loopCount:0). At natural end it pauses itself AND raises
  // `isFinished`, with the clock landing exactly on `duration` (measured). `isFinished` is the
  // "song is over" flag — but it is NOT cleared on load, so on its own it also reports true for
  // a song that merely FOLLOWS a finished one. `_started` scopes it to the song we actually
  // played; app.js pairs it with a clock-reached-duration check. See CLAUDE.md §5.14.
  get ended() { return !!(this._started && this.seq && this.seq.isFinished); }
}

