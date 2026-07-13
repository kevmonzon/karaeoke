/*
 * video.js — VideoEngine: the playback path for VIDEO karaoke songs.
 *
 * A karaoke video already has its lyrics burned into the picture and carries no
 * MIDI note data, so there is no synth, no soundfont, no lyric/melody parsing — it
 * is just a <video> element. VideoEngine exposes the SAME transport surface as
 * AudioEngine (play/pause/toggle/stop/restart/seek + currentTime/duration/paused +
 * setVolume/setTempo) so app.js can drive whichever engine owns the current song
 * through one `media` handle.
 *
 * OFFSET (the one twist): the offset feature is retained for video, but it can only
 * move the AUDIO — the lyrics are painted into the frames, so the picture is the
 * fixed reference. We therefore split the two streams: the <video> element plays the
 * PICTURE (muted), and a separate <audio> element plays the SOUND from the same file,
 * its clock shifted relative to the picture. Sign matches MIDI:
 *   offsetMs > 0  → picture/lyrics LEAD the sound (audio lags behind the picture)
 *   offsetMs < 0  → sound leads the picture
 * i.e. audioTime = pictureTime − offsetMs/1000 (clamped ≥ 0). We re-align on
 * load/seek/offset-change and gently correct drift while playing.
 */

const DRIFT_TOLERANCE = 0.08; // seconds of picture↔sound drift we allow before nudging

export class VideoEngine {
  /**
   * @param {HTMLVideoElement} videoEl  the picture element (#kv), kept muted
   * @param {HTMLAudioElement} audioEl  the sound element (#kva)
   */
  constructor(videoEl, audioEl) {
    this.video = videoEl;
    this.audio = audioEl;
    this._offsetSec = 0;
    this._volume = 0.9;
    this._rate = 1;
    this._driftTimer = null;

    this.video.muted = true;      // the picture never makes sound
    this.video.playsInline = true;
    this.video.loop = false;
    this.audio.preload = "auto";
    this.audio.volume = Math.min(1, this._volume);
  }

  // --- loading --------------------------------------------------------------
  /** Point both elements at the same file. Setting .src schedules the load; we do
   *  NOT call the .load() method here — doing so would abort the play() that
   *  playVideo() issues right after, leaving the clip loaded-but-paused. */
  load(url) {
    this._stopDriftTimer();
    this.video.src = url;
    this.audio.src = url;
    this.video.playbackRate = this.audio.playbackRate = this._rate;
    this.audio.volume = Math.min(1, this._volume);
  }

  /** Detach sources (called when switching away to a MIDI song) — frees decoders. */
  unload() {
    this.stop();
    this.video.removeAttribute("src");
    this.audio.removeAttribute("src");
    this.video.load();
    this.audio.load();
  }

  // --- transport ------------------------------------------------------------
  async play() {
    await this._ready();      // wait for the freshly-set src so play() isn't aborted
    this._resyncAudio();
    try { await this.video.play(); } catch (_) {} // muted picture → autoplay allowed
    try { await this.audio.play(); } catch (_) {} // sound needs a prior user gesture
    this._startDriftTimer();
  }

  /** Resolve once the picture has enough data to start (or a safety timeout). */
  _ready() {
    const v = this.video;
    if (v.readyState >= 3) return Promise.resolve(); // HAVE_FUTURE_DATA
    return new Promise((res) => {
      const done = () => { v.removeEventListener("canplay", done); clearTimeout(t); res(); };
      const t = setTimeout(done, 4000); // never hang if the file can't load
      v.addEventListener("canplay", done, { once: true });
    });
  }

  pause() {
    this.video.pause();
    this.audio.pause();
    this._stopDriftTimer();
  }

  toggle() { this.video.paused ? this.play() : this.pause(); }

  stop() {
    this.pause();
    try { this.video.currentTime = 0; } catch (_) {}
    try { this.audio.currentTime = this._audioTargetFor(0); } catch (_) {}
  }

  restart() {
    try { this.video.currentTime = 0; } catch (_) {}
    this.play();
  }

  /** Seek to a picture time; the sound follows the offset. */
  seek(seconds) {
    const t = Math.max(0, seconds);
    try { this.video.currentTime = t; } catch (_) {}
    try { this.audio.currentTime = this._audioTargetFor(t); } catch (_) {}
  }

  // --- performance controls -------------------------------------------------
  /** Offset in ms (same sign as MIDI: >0 = picture/lyrics lead the sound). */
  setOffset(ms) {
    this._offsetSec = (ms || 0) / 1000;
    this._resyncAudio();
  }

  /** A bare <video>/<audio> can't boost past 100%; clamp to 1. */
  setVolume(v) {
    this._volume = v;
    this.audio.volume = Math.max(0, Math.min(1, v));
  }
  get volume() { return this._volume; }

  setTempo(rate) {
    this._rate = rate;
    this.video.playbackRate = rate;
    this.audio.playbackRate = rate;
  }
  get tempo() { return this._rate; }

  // --- state for the UI loop (the PICTURE is the visual reference) ----------
  get currentTime() { return this.video.currentTime || 0; }
  get duration() { return this.video.duration || this.audio.duration || 0; }
  get paused() { return this.video.paused; }

  // --- internals ------------------------------------------------------------
  _audioTargetFor(pictureTime) {
    return Math.max(0, pictureTime - this._offsetSec);
  }

  /** Snap the sound back onto the offset relative to the current picture time. */
  _resyncAudio() {
    try { this.audio.currentTime = this._audioTargetFor(this.video.currentTime || 0); } catch (_) {}
    if (this.audio.playbackRate !== this._rate) this.audio.playbackRate = this._rate;
  }

  _startDriftTimer() {
    this._stopDriftTimer();
    // Two independent media clocks drift a little; nudge the sound only when it
    // strays past the tolerance (constant re-seeking would stutter).
    this._driftTimer = setInterval(() => {
      if (this.video.paused || this.audio.seeking) return;
      const target = this._audioTargetFor(this.video.currentTime || 0);
      if (Math.abs((this.audio.currentTime || 0) - target) > DRIFT_TOLERANCE) {
        try { this.audio.currentTime = target; } catch (_) {}
      }
    }, 400);
  }

  _stopDriftTimer() {
    if (this._driftTimer) { clearInterval(this._driftTimer); this._driftTimer = null; }
  }
}
