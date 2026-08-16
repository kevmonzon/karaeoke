/*
 * media-engine.js — the transport surface every playback engine shares.
 *
 * app.js drives whichever engine owns the current song through ONE `media` handle, so the
 * four engines (AudioEngine/MIDI, VideoEngine, AudioFileEngine, YouTubeEngine) must expose an
 * identical surface. That contract used to be maintained purely by convention and a comment in
 * each file — and predictably, four hand-rolled copies of the same two methods drifted apart
 * (three spellings of `toggle`, four of `restart`, one of which silently did less).
 *
 * This base class owns only the parts that are genuinely identical — the ones DERIVED from
 * each engine's own primitives. Everything that differs per medium (how you actually start a
 * sound, where the clock lives, what a key change means) stays in the subclass, which is where
 * the interesting differences belong.
 *
 * Subclasses MUST provide: play(), pause(), seek(seconds), and a `paused` getter.
 */
export class MediaEngineBase {
  /**
   * Whether the engine is loaded enough to act on a transport command. AudioEngine is the
   * one that can legitimately answer "no" — its Sequencer only exists after the ~32 MB
   * soundfont init — and its old `this.seq && …` guard is preserved through this hook rather
   * than lost to the shared implementation.
   */
  get canPlay() { return true; }

  /** Play/pause, from whichever clock the subclass reports. */
  toggle() {
    if (!this.canPlay) return;
    if (this.paused) this.play();
    else this.pause();
  }

  /** Back to the top and go. Routed through seek() on purpose: some engines do real work
   *  there (VideoEngine re-aligns its separate sound element), which a raw `currentTime = 0`
   *  in each subclass skipped. */
  restart() {
    if (!this.canPlay) return;
    this.seek(0);
    this.play();
  }

  /** Lyric-offset handling differs per medium (video shifts its own audio; MIDI/AUDIO shift
   *  the lyric clock instead), so the default is simply "not my problem". */
  setOffset() {}
}
