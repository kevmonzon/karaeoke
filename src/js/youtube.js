/*
 * youtube.js — YouTubeEngine: the playback path for YOUTUBE karaoke songs (BYOC).
 *
 * A YouTube karaoke video already has its lyrics burned into the picture and carries
 * no MIDI note data, so — like VideoEngine — there is no synth, no soundfont, no
 * lyric/melody parsing. It just drives the official YouTube IFrame Player API. The engine
 * exposes the SAME transport surface as AudioEngine/VideoEngine (play/pause/toggle/stop/
 * restart/seek + currentTime/duration/paused + setVolume/setTempo/setOffset) so app.js can
 * drive whichever engine owns the current song through one `media` handle.
 *
 * CROSS-ORIGIN ISOLATION (the one twist): the app runs cross-origin-isolated for
 * SpessaSynth (COOP:same-origin + COEP). YouTube ships no CORP/COEP, so a plain iframe
 * would be blocked. serve.py therefore sends COEP: **credentialless** (which keeps
 * crossOriginIsolated === true, so the synth still works) and the player lives in an
 * **<iframe credentialless>** — an anonymous, cookieless frame that a COEP page is allowed
 * to embed even though YouTube doesn't opt in. We must construct that iframe ourselves and
 * attach YT.Player to it (the API's own auto-created iframe would lack the attribute), then
 * swap songs with loadVideoById so the one credentialless iframe is reused.
 *
 * Chromium-only: the credentialless-iframe attribute is not in Firefox. `YouTubeEngine.supported`
 * gates the feature; the rest of the app (MIDI/video/mic) is unaffected where it's absent.
 *
 * OFFSET is a no-op here: there's a single baked stream (picture + sound together, lyrics in
 * the frames), so there's nothing to shift. We accept the setter for surface parity.
 */

// The YT IFrame API is loaded lazily (on first YouTube play/search) so the offline-first
// boot never touches the network. It calls the global `onYouTubeIframeAPIReady` when ready.
let _apiPromise = null;
function ytApiReady() {
  if (window.YT && window.YT.Player) return Promise.resolve();
  if (_apiPromise) return _apiPromise;
  _apiPromise = new Promise((resolve) => {
    const prev = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => {
      if (typeof prev === "function") { try { prev(); } catch (_) {} }
      resolve();
    };
    const tag = document.createElement("script");
    tag.src = "https://www.youtube.com/iframe_api";
    tag.async = true;
    document.head.appendChild(tag);
  });
  return _apiPromise;
}

export class YouTubeEngine {
  /** True only where <iframe credentialless> exists (Chromium 110+). */
  static get supported() {
    return typeof HTMLIFrameElement !== "undefined"
      && "credentialless" in HTMLIFrameElement.prototype;
  }

  /**
   * @param {HTMLIFrameElement} iframeEl  the pre-created `<iframe id="ytplayer" credentialless>`
   */
  constructor(iframeEl) {
    this.iframe = iframeEl;
    this.player = null;         // the YT.Player, created lazily on first load()
    this._loadPromise = null;   // resolves when the current video is cued/ready
    this._videoId = null;
    this._volume = 0.9;
    this._rate = 1;
    this._state = -1;           // last YT.PlayerState (1=playing, 3=buffering ⇒ "not paused")
    this.onState = null;        // optional callback(state) — lets app.js resync the play/pause icon
    this.onEnded = null;        // optional callback() — fires on natural end (state 0) so app can unload
    this.onError = null;        // optional callback(code) — e.g. 101/150 = embedding disabled by owner

    // Belt-and-braces: the HTML sets it, but ensure the anonymous-frame attribute is on.
    try { this.iframe.credentialless = true; } catch (_) {}
  }

  /** Preload the IFrame API up front so the first play doesn't lose the click's user
   *  activation to a script fetch (which would make the browser block autoplay). Idempotent;
   *  call it when the feature is enabled. */
  warm() { if (YouTubeEngine.supported) ytApiReady().catch(() => {}); }

  // --- loading --------------------------------------------------------------
  /** Load a video id and start it (autoplay). On the first call this creates the player on
   *  our credentialless iframe; afterwards it reuses the same iframe via loadVideoById
   *  (which autoplays). play() awaits this. */
  load(videoId) {
    this._videoId = videoId;
    this._loadPromise = this._ensurePlayer(videoId);
    return this._loadPromise;
  }

  async _ensurePlayer(videoId) {
    await ytApiReady();
    if (!this.player) {
      this.iframe.src = this._embedUrl(videoId); // src carries autoplay=1
      await new Promise((resolve) => {
        this.player = new YT.Player(this.iframe, {
          events: {
            onReady: () => { this._disableCaptions(); resolve(); },
            onStateChange: (e) => {
              this._state = e.data;
              if (e.data === 1) this._disableCaptions(); // captions can reload with a new video
              // ENDED → let the app unload us before YouTube paints its suggested-videos end screen
              if (e.data === 0 && this.onEnded) this.onEnded();
              if (this.onState) this.onState(e.data);
            },
            onError: (e) => { if (this.onError) this.onError(e && e.data); },
          },
        });
        setTimeout(resolve, 6000); // never hang if the embed can't initialise
      });
      try { this.player.setPlaybackRate(this._rate); } catch (_) {}
      try { this.player.setVolume(this._ytVol()); } catch (_) {}
    } else {
      try { this.player.loadVideoById(videoId); } catch (_) {} // loadVideoById autoplays
    }
  }

  /** Force YouTube's caption/subtitle track off (the karaoke lyrics are baked into the
   *  picture; the CC track is redundant noise). Params alone don't reliably suppress it —
   *  the module unload does. Both legacy ("cc") and current ("captions") module names. */
  _disableCaptions() {
    for (const m of ["captions", "cc"]) {
      try { this.player.unloadModule(m); } catch (_) {}
    }
    try { this.player.setOption("captions", "track", {}); } catch (_) {}
  }

  /** Stop the sound when switching away to a MIDI/VIDEO song. We keep the player + iframe
   *  (recreating would lose the credentialless attribute); stopVideo silences it. */
  unload() {
    try { this.player && this.player.stopVideo(); } catch (_) {}
    this._state = -1;
  }

  // --- transport ------------------------------------------------------------
  async play() {
    if (this._loadPromise) { try { await this._loadPromise; } catch (_) {} }
    if (!this.player) return;
    try { this.player.setVolume(this._ytVol()); } catch (_) {}
    try { this.player.playVideo(); } catch (_) {} // a prior user gesture already occurred
  }

  pause() { try { this.player && this.player.pauseVideo(); } catch (_) {} }

  toggle() { this.paused ? this.play() : this.pause(); }

  stop() {
    this.pause();
    try { this.player && this.player.seekTo(0, true); } catch (_) {}
  }

  restart() {
    try { this.player && this.player.seekTo(0, true); } catch (_) {}
    this.play();
  }

  seek(seconds) {
    try { this.player && this.player.seekTo(Math.max(0, seconds), true); } catch (_) {}
  }

  // --- performance controls -------------------------------------------------
  /** No-op: a YouTube clip is a single baked stream (lyrics in the picture, no separate
   *  audio to shift). Kept for surface parity with AudioEngine/VideoEngine. */
  setOffset(_ms) {}

  /** YouTube volume is 0–100 and can't boost past 100% (like a bare media element). */
  setVolume(v) {
    this._volume = v;
    try { this.player && this.player.setVolume(this._ytVol()); } catch (_) {}
  }
  get volume() { return this._volume; }

  setTempo(rate) {
    this._rate = rate;
    try { this.player && this.player.setPlaybackRate(rate); } catch (_) {}
  }
  get tempo() { return this._rate; }

  // --- state for the UI loop ------------------------------------------------
  get currentTime() {
    try { return (this.player && this.player.getCurrentTime()) || 0; } catch (_) { return 0; }
  }
  get duration() {
    try { return (this.player && this.player.getDuration()) || 0; } catch (_) { return 0; }
  }
  /** Playing (1) or buffering (3) ⇒ not paused; everything else (unstarted/paused/ended/
   *  cued) ⇒ paused. Lets the rAF loop's `t >= d − 0.15 && !paused` end-of-song check fire
   *  while still playing, then go quiet once ended. */
  get paused() { return this._state !== 1 && this._state !== 3; }

  // --- internals ------------------------------------------------------------
  _ytVol() { return Math.max(0, Math.min(100, Math.round(this._volume * 100))); }

  _embedUrl(id) {
    const origin = encodeURIComponent(location.origin);
    // Hide YouTube's own chrome so only the video shows — we drive playback from the app's
    // transport (params lifted from yoke.ydhub.net's embed): controls=0 (no control bar),
    // disablekb=1 (no YT hotkeys stealing Space), rel=0 (no cross-channel "related"),
    // modestbranding=1, iv_load_policy=3 (no annotations), fs=0 (no fullscreen btn).
    // autoplay=1 so the video starts on the click that opened the song.
    return `https://www.youtube.com/embed/${encodeURIComponent(id)}`
      + `?enablejsapi=1&origin=${origin}`
      + `&autoplay=1&controls=0&disablekb=1&rel=0&modestbranding=1&playsinline=1`
      + `&iv_load_policy=3&fs=0&cc_load_policy=0&cc_lang_pref=none`;
  }
}
