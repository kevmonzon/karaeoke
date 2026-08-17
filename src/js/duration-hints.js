/*
 * duration-hints.js — how long each song actually runs.
 *
 * The catalog is built from filenames, so it carries no duration. The only honest way to
 * answer a guest's "how long until mine?" is to LEARN each song's length the first time it
 * plays and remember it: a library you have used before estimates well, a fresh one falls
 * back to an average (queue-order.js DEFAULT_SONG_SEC). Approximate on purpose — roughly
 * right immediately beats exactly right never.
 */
import { jsonStore } from "./store.js";

export const DURATIONS_KEY = "karaeoke.durations.v1";

export function createDurationHints(storage) {
  const store = jsonStore(DURATIONS_KEY, {}, storage);
  let hints = {};
  let notedSongId = null;   // the song already recorded during THIS play

  return {
    /** Read the saved lengths. Call once at boot. */
    load() { hints = store.read(); },

    /** Re-arm the learner for an incoming song. Call from playNow, before the fetch. */
    arm() { notedSongId = null; },

    /** Learn a song's length. Called from the rAF loop, so it must be cheap and idempotent. */
    note(song, seconds) {
      if (!song || !(seconds > 0) || notedSongId === song.id) return;
      notedSongId = song.id;
      const rounded = Math.round(seconds);
      if (hints[song.id] === rounded) return;
      hints[song.id] = rounded;
      store.write(hints);
    },

    /** The learned length in whole seconds, or null if this song has never played here. */
    get(id) { return hints[id] || null; },
  };
}
