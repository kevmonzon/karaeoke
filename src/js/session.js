/*
 * session.js — what survives a reload: the queue and the recently-played list.
 *
 * Both are stored as stable song ids (§5.10), so a MIDI and a video sharing a dial code stay
 * distinct. The queue is restored but deliberately NEVER auto-played — a page load carries no
 * user gesture, and starting a song at someone unprompted is worse than making them press play.
 *
 * Attribution is not persisted: who queued what belongs to tonight, not to the browser.
 */
import { jsonStore } from "./store.js";
import { resolveSongRef } from "./catalog.js";

export const SESSION_KEY = "karaeoke.session.v1";
const MAX_RECENT = 40;

export function createSession({ catalog, storage } = {}) {
  const store = jsonStore(SESSION_KEY, null, storage);
  let recent = [];   // recently-played ids, most-recent first

  return {
    get recent() { return recent; },

    /** Write the current state. The queue's ids are passed in — the queue owns that list. */
    save(queueIds) {
      store.write({ queue: queueIds, recent });
    },

    /** Move a song to the front of "recently played". Caller persists. */
    push(song) {
      if (!song || !song.id) return recent;
      recent = [song.id, ...recent.filter((id) => id !== song.id)].slice(0, MAX_RECENT);
      return recent;
    },

    /**
     * Read the saved session and resolve it against the catalog. Returns the songs rather than
     * the raw ids, since a stored song may no longer exist in the library (a deleted file, a
     * rebuilt catalog) and must simply be dropped.
     */
    restore() {
      const data = store.read();
      if (!data) return { recent: [], queue: [] };
      const resolve = (ref) => resolveSongRef(catalog, ref);
      recent = (Array.isArray(data.recent) ? data.recent : [])
        .map(resolve).filter(Boolean).map((s) => s.id);
      const queue = (Array.isArray(data.queue) ? data.queue : []).map(resolve).filter(Boolean);
      return { recent, queue };
    },

    /** The recently-played songs, in order, skipping any that have left the library. */
    recentSongs() {
      return recent.map((id) => catalog.getById(id)).filter(Boolean);
    },
  };
}
