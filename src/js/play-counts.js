/*
 * play-counts.js — decides WHEN a song counts as played, and reports it once. Pure: no DOM; the
 * clock and the reporter are injected, so node --test drives it without a browser or a server.
 *
 * The rule (product owner: "keep track how many times a song is being played"):
 *   · a play counts ONCE per song start (start()),
 *   · after THRESHOLD seconds of actual playback, or at a natural end (ended()), whichever
 *     comes first;
 *   · "actual playback" is wall-clock time between two consecutive ticks that both saw the
 *     music playing, so paused time and the title-card hold (the MIDI engine is paused through
 *     it) never count, and a seek forward adds nothing (the media clock is never read);
 *   · a skip or a stop before the threshold (stop(), or start() of the next song) counts
 *     nothing; a Restart is the SAME play — it must not call start(), so it cannot count twice.
 *
 * A natural end counts only if the play was seen playing at least once: an end reported for a
 * song that never sounded is a stale engine flag (§5.14 has measured more than one), not a play.
 * One tick step is capped at MAX_STEP_SEC, so a laptop that slept mid-song does not wake up to
 * find the whole nap counted; the app's 1 s hidden-tab watchdog keeps every honest step small.
 *
 * The server only counts (tools/serve.py POST /api/played); deciding is the client's job, and
 * a failed report is swallowed: a play count is never worth an error on the stage.
 */

/** Seconds of actual playback after which a play counts. */
export const PLAY_THRESHOLD_SEC = 30;
/** The longest single tick step that counts; a longer gap is clamped to it. */
export const MAX_STEP_SEC = 2;

/**
 * The default reporter: one POST /api/played {id}. Resolves when the server counted it; an HTTP
 * error rejects like a network one. `keepalive` lets a report fired at the very end of a song
 * outlive the tab being closed right after it.
 * @param {string} id  the song's catalog id ("midi:123", "youtube:<videoId>", …)
 */
export async function reportPlayed(id) {
  const res = await fetch("/api/played", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id }),
    keepalive: true,
  });
  if (!res.ok) throw new Error(`POST /api/played → HTTP ${res.status}`);
}

/**
 * @param {object} [opts]
 * @param {(id: string) => (void|Promise<unknown>)} [opts.report]  sends one play; may return a promise
 * @param {number} [opts.thresholdSec]  seconds of playback that make a play count (default 30)
 * @param {number} [opts.maxStepSec]    the cap on one tick step (default 2)
 * @param {(...args: unknown[]) => void} [opts.warn]  where the one failure warning goes
 * @returns {{ start(song: {id?: string}|null): void, tick(playing: boolean, nowSec: number): void,
 *             ended(): void, stop(): void }}
 *   start(song)          a new song started (every pick, queue advance, YouTube walk) — begins a play
 *   tick(playing, now)   call often (every frame and/or every second): is the music sounding,
 *                        and a MONOTONIC clock in seconds (performance.now() / 1000)
 *   ended()              the song reached its natural end — counts it if it has not counted yet
 *   stop()               the song was abandoned (skip, stop, failure) — counts nothing more
 */
export function createPlayCounter({
  report = reportPlayed,
  thresholdSec = PLAY_THRESHOLD_SEC,
  maxStepSec = MAX_STEP_SEC,
  warn = (...args) => console.warn(...args),
} = {}) {
  const threshold = Number.isFinite(thresholdSec) && thresholdSec >= 0 ? thresholdSec : PLAY_THRESHOLD_SEC;
  const maxStep = Number.isFinite(maxStepSec) && maxStepSec > 0 ? maxStepSec : MAX_STEP_SEC;

  let id = null;          // the open play's song id; null = no play open (nothing will count)
  let playedSec = 0;      // actual playback so far in this play
  let lastNow = null;     // the previous tick's clock, kept only while that tick saw playing
  let sawPlaying = false; // has this play ever been heard?
  let warned = false;     // one console line per counter, however often the server is away

  function fail(err) {
    if (warned) return;
    warned = true;
    try { warn("Play count not recorded:", err); } catch { /* a broken logger is not our problem */ }
  }

  // Close the play and send it. The play is closed FIRST, so a reporter that throws (or calls
  // back into the counter) can never make the same play count twice.
  function count() {
    const sid = id;
    close();
    try {
      const pending = report(sid);
      if (pending && typeof pending.then === "function") pending.then(undefined, fail);
    } catch (err) {
      fail(err);
    }
  }

  function close() {
    id = null;
    playedSec = 0;
    lastNow = null;
    sawPlaying = false;
  }

  return {
    start(song) {
      close();   // whatever was open is abandoned: a song change before the threshold is a skip
      const sid = song && song.id;
      id = typeof sid === "string" && sid ? sid : null;
    },

    tick(playing, nowSec) {
      if (id === null) return;
      if (!playing || !Number.isFinite(nowSec)) { lastNow = null; return; }
      sawPlaying = true;
      if (lastNow !== null) {
        const step = nowSec - lastNow;
        if (step > 0) playedSec += Math.min(step, maxStep);
      }
      lastNow = nowSec;
      if (playedSec >= threshold) count();
    },

    ended() {
      if (id !== null && sawPlaying) count();
      else close();
    },

    stop() {
      close();
    },
  };
}
