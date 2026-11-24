/*
 * rankings.js — the leaderboard: one row per scored song, kept across nights (M6, plan §5.9).
 *
 * CONTRACT STUB written by the orchestrator. Lane B fills the bodies; the exports, names and
 * signatures are the contract lanes C and I code against — do not change them.
 *
 * Storage handling mirrors recap.js / store.js jsonStore: a corrupt value reads as an empty list,
 * a throwing storage never crashes the app. The key carries the `karaeoke.` prefix, so the
 * existing Backup / Restore / Erase-all features cover it with no change.
 *
 * An entry: { player, songId, song, artist, score, difficulty, at }
 *   player     — the guest nickname that queued the song, else the host's name (trimmed, ≤ 24 chars,
 *                "" → "Host");
 *   songId     — the song's stable id; song / artist — display strings (≤ 200 chars each);
 *   score      — a finite number 0–100 (rounded to an integer when stored);
 *   difficulty — "easy" | "normal" | "hard" ("normal" until M9; anything else → "normal");
 *   at         — ms since the epoch (finite; else the injected clock's now).
 *
 * Normalisation details (lane B):
 *   - Lengths count code points, not UTF-16 units, so a cap never splits an emoji in half.
 *   - score: a number, or a non-blank numeric string ("85"); anything else (NaN, ±Infinity, "abc",
 *     "", null, a boolean, missing) makes the entry invalid. A valid score is clamped to 0–100.
 *   - The pure functions take any list: entries that do not normalise are skipped, never thrown on.
 *     A stored entry without a finite `at` (hand-edited backup) counts as the oldest (at 0);
 *     createRankings().add fills a missing `at` from its clock before it reaches addRanking.
 */
import { jsonStore } from "./store.js";

export const RANKINGS_KEY = "karaeoke.rankings.v1";
export const RANKINGS_MAX = 1000;
export const DIFFICULTIES = Object.freeze(["easy", "normal", "hard"]);

const PLAYER_MAX = 24;
const TEXT_MAX = 200;
const HOST_PLAYER = "Host";
const TOP_LIMIT = 50;

/** First `n` code points of `s`. */
const capChars = (s, n) => (s.length <= n ? s : Array.from(s).slice(0, n).join(""));

/** A display string: strings as given, finite numbers stringified, anything else "". */
const asText = (v) => (typeof v === "string" ? v : (typeof v === "number" && Number.isFinite(v) ? String(v) : ""));

/** The finite score, or NaN. A blank string is NOT 0 (Number("") is). */
function toScore(v) {
  if (typeof v === "number") return v;
  if (typeof v === "string" && v.trim() !== "") return Number(v);
  return NaN;
}

function normPlayer(v) {
  const p = capChars(asText(v).trim(), PLAYER_MAX).trimEnd();
  return p || HOST_PLAYER;
}

/**
 * One entry in canonical form, or null when its score is not finite. Returns a NEW object — the
 * input is never touched.
 */
function normalize(e, fallbackAt) {
  if (!e || typeof e !== "object") return null;
  const raw = toScore(e.score);
  if (!Number.isFinite(raw)) return null;
  return {
    player: normPlayer(e.player),
    songId: asText(e.songId),
    song: capChars(asText(e.song), TEXT_MAX),
    artist: capChars(asText(e.artist), TEXT_MAX),
    score: Math.round(Math.min(100, Math.max(0, raw))),
    difficulty: DIFFICULTIES.includes(e.difficulty) ? e.difficulty : "normal",
    at: typeof e.at === "number" && Number.isFinite(e.at) ? e.at : fallbackAt,
  };
}

/** Every entry of `list` that normalises, in order. A non-array reads as empty. */
function clean(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const e of list) {
    const n = normalize(e, 0);
    if (n) out.push(n);
  }
  return out;
}

/** Leaderboard order over `list`: score desc, then newest `at`, then the later-appended row. */
function ranked(list) {
  return list
    .map((e, i) => ({ e, i }))
    .sort((a, b) => b.e.score - a.e.score || b.e.at - a.e.at || b.i - a.i)
    .map((x) => x.e);
}

/**
 * Pure: append `entry` to a COPY of `list`; when the result is longer than `max`, drop the lowest
 * scores first, the OLDEST first among equal scores, until it fits. Returns the new list.
 * (An entry whose score is not finite is not appended. Equal score and time: the earlier-appended
 * row is the older. A new entry below every score of a full list is the one dropped.)
 */
export function addRanking(list, entry, max = RANKINGS_MAX) {
  const cap = typeof max === "number" && max >= 0 ? Math.floor(max) : RANKINGS_MAX;
  const out = clean(list);
  const add = normalize(entry, 0);
  if (add) out.push(add);
  const over = out.length - cap;
  if (over <= 0) return out;
  const drop = new Set(
    out.map((e, i) => ({ e, i }))
      .sort((a, b) => a.e.score - b.e.score || a.e.at - b.e.at || a.i - b.i)
      .slice(0, over)
      .map((x) => x.i),
  );
  return out.filter((_, i) => !drop.has(i));
}

/**
 * Pure: the top `limit` entries — score descending, then newest first — optionally only one
 * player's (exact match after trim) and/or one difficulty's.
 * ("" = no filter; a bad `limit` means the default 50; the rows are copies.)
 */
export function topRankings(list, { player = "", difficulty = "", limit = TOP_LIMIT } = {}) {
  const who = asText(player).trim();
  const diff = asText(difficulty);
  const n = typeof limit === "number" && limit >= 0 ? Math.floor(limit) : TOP_LIMIT;
  const rows = clean(list).filter((e) => (!who || e.player === who) && (!diff || e.difficulty === diff));
  return ranked(rows).slice(0, n);
}

/**
 * Pure: the distinct players, ordered by their best score descending (ties: most recent first).
 * "Most recent" = the newer of the tying best scores, i.e. the order in which each player first
 * appears in the full leaderboard (topRankings with no limit).
 */
export function rankingPlayers(list) {
  const seen = new Set();
  for (const e of ranked(clean(list))) seen.add(e.player);
  return [...seen];
}

/**
 * @param {object} [o]
 * @param {Storage} [o.storage]  injected for tests; default localStorage (via store.js jsonStore)
 * @param {() => number} [o.now] clock in ms, injected for tests
 * @returns {{
 *   add(entry): boolean,          // false (and nothing stored) when the score is not finite
 *   top(opts?): object[],         // topRankings over the stored list
 *   players(): string[],
 *   difficulties(): string[],     // the DIFFICULTIES present in the stored list, in DIFFICULTIES order
 *   clear(): void,                // empties and persists
 *   all(): object[],              // a copy of the stored list
 * }}
 * The list is read from storage once (lazily) and written back on every change.
 */
export function createRankings({ storage, now } = {}) {
  const store = jsonStore(RANKINGS_KEY, [], storage);
  const clock = typeof now === "function" ? now : () => Date.now();
  let list = null;                                   // null = not read yet

  const current = () => {
    if (list === null) list = clean(store.read());   // jsonStore never throws; clean never throws
    return list;
  };
  const stamp = () => {
    let t;
    try { t = clock(); } catch (_) { t = NaN; }
    return Number.isFinite(t) ? t : Date.now();
  };

  return {
    add(entry) {
      if (!entry || typeof entry !== "object" || !Number.isFinite(toScore(entry.score))) return false;
      const at = typeof entry.at === "number" && Number.isFinite(entry.at) ? entry.at : stamp();
      list = addRanking(current(), { ...entry, at });
      store.write(list);
      return true;
    },
    top(opts) { return topRankings(current(), opts && typeof opts === "object" ? opts : undefined); },
    players() { return rankingPlayers(current()); },
    difficulties() {
      const have = new Set(current().map((e) => e.difficulty));
      return DIFFICULTIES.filter((d) => have.has(d));
    },
    clear() {
      list = [];
      store.write(list);
    },
    all() { return current().map((e) => ({ ...e })); },
  };
}
