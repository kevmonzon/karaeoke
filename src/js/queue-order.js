/*
 * queue-order.js — pure queue arithmetic (no DOM, no state) → unit-tested.
 *
 * Two small things the party actually feels:
 *
 *  1. FAIR PLAY. A strict FIFO queue means whoever taps fastest sings most, which is exactly
 *     the problem videoke etiquette solves socially ("reserve, then wait your turn"). Karaoke
 *     Mugen's answer is round-robin: everyone gets one song before anyone gets two. That's
 *     `fairInsertIndex` — it doesn't reorder what's already queued (people watch the list and
 *     would notice their song sliding backwards), it only chooses where a NEW song lands.
 *
 *  2. "HOW LONG UNTIL MINE?" — the first question every guest asks, and the one the host
 *     spends the night answering. `queueEta` turns the queue into seconds.
 */

/** Fallback song length (seconds) for a song nobody has played yet. ~3½ minutes. */
export const DEFAULT_SONG_SEC = 210;

/**
 * Where a new song from `by` should be inserted for round-robin fairness.
 *
 * Each queued item belongs to a "round": their singer's 1st song is round 0, 2nd is round 1,
 * and so on. A new song joins the end of its own round, ahead of anyone already on a later
 * round. Host-added songs (`by === ""`) are just another singer, so the host doesn't get to
 * jump the line either.
 *
 * @param {string[]} queueBy  who queued each pending song, in queue order
 * @param {string} by         the new song's singer ("" for host-added)
 * @returns {number} the index to splice at
 */
export function fairInsertIndex(queueBy, by) {
  const list = Array.isArray(queueBy) ? queueBy : [];
  const me = by || "";
  const seen = new Map();
  const rounds = list.map((b) => {
    const key = b || "";
    const r = seen.get(key) || 0;
    seen.set(key, r + 1);
    return r;
  });
  const myRound = seen.get(me) || 0;
  for (let i = 0; i < rounds.length; i++) {
    if (rounds[i] > myRound) return i;   // first item belonging to a later round
  }
  return rounds.length;
}

/** How many of the pending songs belong to one singer (for a per-guest reservation cap). */
export function countBy(queueBy, by) {
  const me = by || "";
  return (Array.isArray(queueBy) ? queueBy : []).reduce((n, b) => n + ((b || "") === me ? 1 : 0), 0);
}

/**
 * Seconds until the song at `index` starts.
 *
 * `durations` holds each queued song's length where it's known — the host learns real
 * durations as songs play and remembers them, so a library you've used before estimates
 * well and a fresh one falls back to DEFAULT_SONG_SEC. Deliberately an estimate: being
 * roughly right immediately beats being exactly right never.
 *
 * @param {number} nowRemaining seconds left in the currently-playing song
 * @param {(number|null|undefined)[]} durations lengths of the queued songs, in order
 * @param {number} index position in the queue (0 = plays next)
 */
export function queueEta(nowRemaining, durations, index) {
  let t = Math.max(0, Number(nowRemaining) || 0);
  const d = Array.isArray(durations) ? durations : [];
  for (let i = 0; i < index && i < d.length; i++) {
    const s = Number(d[i]);
    t += Number.isFinite(s) && s > 0 ? s : DEFAULT_SONG_SEC;
  }
  return Math.round(t);
}

/** "now" / "~4 min" / "~1 h 10 min" — short enough for a queue row on a phone. */
export function formatEta(seconds) {
  const s = Math.max(0, Math.round(Number(seconds) || 0));
  if (s < 45) return "now";
  const mins = Math.round(s / 60);
  if (mins < 60) return `~${Math.max(1, mins)} min`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m ? `~${h} h ${m} min` : `~${h} h`;
}
