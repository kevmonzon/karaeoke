/*
 * queue.js — the song queue and who reserved each song.
 *
 * Two arrays kept in lockstep: `list[i]` is the song, `listBy[i]` is who queued it (a phone
 * nickname, or "" for a host-added song). Every mutation has to move both, which is exactly
 * why they belong behind one object instead of two module-scope arrays edited in six places.
 *
 * What deliberately does NOT live here: whether to start playing. That depends on `current`
 * and `loadingSong`, which belong to app.js's playback state machine — see the note on add().
 */
import { fairInsertIndex, countBy as countByName } from "./queue-order.js";

/**
 * Pure: may a command that names index `index` act on it?
 *
 * A guest computes an index from a snapshot up to ~2 s stale, so by the time `remove` or
 * `reorder` lands it can point at a DIFFERENT song — the queue auto-advanced, or another guest
 * acted first. When the command carries the song's stable id we require it to match, so the
 * worst case is "nothing happened" instead of "the wrong song vanished". Commands with no id
 * (an older phone build) still apply by index.
 */
export function queueItemMatches(list, index, id) {
  if (!Array.isArray(list)) return false;
  if (!Number.isInteger(index) || index < 0 || index >= list.length) return false;
  return !id || list[index].id === id;
}

/**
 * @param {object} deps
 * @param {() => void} [deps.onChange] run after every mutation — render + persist + push.
 */
export function createQueue({ onChange = () => {} } = {}) {
  let list = [];
  let by = [];

  return {
    get list() { return list; },
    get listBy() { return by; },
    get length() { return list.length; },

    /**
     * Add a song and return the index it landed at.
     *
     * With fair play on, a new song joins the end of its OWN singer's round rather than the end
     * of the list, so one enthusiastic guest can't own the night. Already-queued songs never
     * move — people watch this list and would notice theirs sliding backwards.
     *
     * The caller decides whether to start playing: `current` is not set until a play* gets past
     * its awaits, so "is anything playing?" is only answerable in app.js.
     */
    add(song, who = "", fairPlay = false) {
      const at = fairPlay ? fairInsertIndex(by, who) : list.length;
      list.splice(at, 0, song);
      by.splice(at, 0, who);
      onChange();
      return at;
    },

    /** Remove by index. Bounds-checked: splice(-1, 1) counts from the END, so an out-of-range
     *  index would silently delete the wrong song rather than doing nothing. */
    removeAt(i) {
      if (!Number.isInteger(i) || i < 0 || i >= list.length) return false;
      list.splice(i, 1);
      by.splice(i, 1);
      onChange();
      return true;
    },

    /** Move a queued song (the phone remote's reorder). */
    move(from, to) {
      if (!Number.isInteger(from) || !Number.isInteger(to)) return false;
      if (from < 0 || from >= list.length || to < 0 || to >= list.length || from === to) return false;
      const [s] = list.splice(from, 1); list.splice(to, 0, s);
      const [b] = by.splice(from, 1); by.splice(to, 0, b);
      onChange();
      return true;
    },

    /** Take the next song off the front. Returns null when the queue is empty. */
    shift() {
      if (!list.length) { onChange(); return null; }
      const song = list.shift();
      const who = by.shift() || "";
      onChange();
      return { song, by: who };
    },

    /** How many songs this guest already has waiting (the reservation cap). */
    countBy(who) { return countByName(by, who); },

    matches(index, id) { return queueItemMatches(list, index, id); },

    /** Restore a saved queue. Silent: loading is not a change worth persisting or pushing,
     *  and attribution is deliberately not persisted, so everyone comes back as the host. */
    restore(songs) {
      list = songs.slice();
      by = songs.map(() => "");
    },
  };
}
