/*
 * remote-browse.js — the pure half of the phone's Search sub-tabs, All · Artists (Rae, 2026-11-28:
 * "the remote app -> search, this should also have All / Artists tab").
 *
 * The grouping is the TV's own: library-browse.js has no imports and no DOM, so the phone builds
 * the artist index, one artist's songs and the typed artist filter with exactly the functions the
 * TV's Artists tab uses (§5.37) — the same artists, the same counts, "(Unknown artist)" last.
 * What lives here is only the phone's view of them: the index cached per catalogue array (built on
 * the first visit to Artists, never before — most phones never open it), the "← Artists" row that
 * heads one artist's songs, and where the artist list lands when that row brings it back.
 *
 * Pure: no DOM, no storage, no clock. The sub-tab is view state and is never persisted, as on the TV.
 */
import { buildArtistIndex, songsByArtist, filterArtists, UNKNOWN_ARTIST, UNKNOWN_ARTIST_LABEL } from "./library-browse.js";

/** The Search tab's sub-tabs, in order. */
export const SEARCH_TABS = Object.freeze(["all", "artists"]);

/**
 * The key of the "← Artists" row. Never an artistKey: those are folded names (control characters
 * collapse to spaces, so none starts with U+0000) or UNKNOWN_ARTIST, which is a different string.
 */
export const BACK_KEY = "\u0000back";

/** Pure: the sub-tab a value names — "artists", else "all". */
export function searchTabOf(v) {
  return v === "artists" ? "artists" : "all";
}

/** Pure: "1 song", "1,234 songs" (the TV's artist-row wording). */
export function songCountLabel(n) {
  const k = Math.max(0, Number(n) || 0);
  return `${k.toLocaleString()} song${k === 1 ? "" : "s"}`;
}

/** Pure: is this item the "← Artists" row? */
export function isBackRow(item) {
  return !!item && item.key === BACK_KEY;
}

/** Pure: the row of artist `key` in a list of artist items, else -1. */
export function artistRowIndex(items, key) {
  if (!Array.isArray(items) || key == null) return -1;
  for (let i = 0; i < items.length; i++) if (items[i] && items[i].key === key) return i;
  return -1;
}

/**
 * The phone's artist browser over a catalogue array. The index is built on first use and rebuilt
 * only when a DIFFERENT array is passed (a new songbook), never per keystroke.
 */
export function createArtistBrowse() {
  let index = null;
  let indexFor = null;

  function artistIndex(songs) {
    const list = Array.isArray(songs) ? songs : [];
    if (!index || indexFor !== list) {
      index = buildArtistIndex(list);
      indexFor = list;
    }
    return index;
  }

  return {
    /** The whole artist index of `songs` (cached). */
    index: artistIndex,
    /** Is the index for `songs` already built (the next call costs nothing)? */
    ready(songs) {
      return !!index && indexFor === (Array.isArray(songs) ? songs : null);
    },
    /** The artist list, narrowed by `filter`: every typed word must occur in the folded name. */
    artists(songs, filter = "") {
      return filterArtists(artistIndex(songs), String(filter ?? ""));
    },
    /**
     * One artist's songs by title (then number), headed by the "← Artists" row, which carries the
     * index's spelling of the name and the count: `{ name, count, rows: [back, ...songs] }`.
     * An artist the songbook no longer has → no songs and an empty name (the row says only the count).
     */
    artistSongs(songs, key) {
      const own = songsByArtist(Array.isArray(songs) ? songs : [], key);
      const entry = artistIndex(songs).find((a) => a.key === key);
      const name = entry ? entry.name : (key === UNKNOWN_ARTIST && own.length ? UNKNOWN_ARTIST_LABEL : "");
      return { name, count: own.length, rows: [{ key: BACK_KEY, name, count: own.length }, ...own] };
    },
  };
}
