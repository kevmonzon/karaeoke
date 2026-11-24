/*
 * library-browse.js — pure helpers for browsing the library: songbook / kind filters, sort, and the
 * artist index (M6, plan §5.6 / §5.7).
 *
 * CONTRACT STUB written by the orchestrator. Lane A fills the bodies; the exports, names and
 * signatures are the contract lanes C and I code against — do not change them.
 *
 * Everything here is pure (no DOM, no storage, no clock) and must stay fast on the full library
 * (~121,000 songs): one pass, one Map, no sort inside a loop, a shared Intl.Collator.
 *
 * How the sort stays inside its budget. A comparator that calls the collator on every comparison
 * costs ~230 ms for the titles alone on the real library (2M comparisons), before any tie-break.
 * So the collator only ever sees DISTINCT strings: each one gets an integer rank (equal rank ⇔ the
 * collator calls them equal), and the songs are sorted by those integers. The ranks live in one
 * module-level table (a memo — results never depend on it), so the next sort of any subset of the
 * same library is integer work only. Only a long list adds strings to it (a short one with unseen
 * titles is ranked on its own), and it is rebuilt from scratch when it would pass RANK_TABLE_MAX
 * strings, so a long session of catalogue rebuilds cannot grow it forever.
 */

import { SOURCES } from "./catalog.js";

/** The key of the "(Unknown artist)" bucket. Sorts last; never collides with a real name. */
export const UNKNOWN_ARTIST = "\u0000unknown";
/** How the unknown bucket is labelled. */
export const UNKNOWN_ARTIST_LABEL = "(Unknown artist)";

/** Kind filter values in display order, with their chip labels and icons (the row icons). */
export const KINDS = Object.freeze([
  Object.freeze({ id: "midi", label: "MIDI", icon: "🎤" }),
  Object.freeze({ id: "audio", label: "Audio", icon: "🎵" }),
  Object.freeze({ id: "video", label: "Video", icon: "🎞️" }),
]);

/** The sort modes, in display order. "relevance" = today's ranking (no sort). */
export const SORTS = Object.freeze([
  Object.freeze({ id: "relevance", label: "Relevance" }),
  Object.freeze({ id: "title", label: "Title" }),
  Object.freeze({ id: "artist", label: "Artist" }),
  Object.freeze({ id: "code", label: "Number" }),
]);

// ---------------------------------------------------------------------------------------------
// Shared pieces
// ---------------------------------------------------------------------------------------------

/** The one collator every text comparison in this module goes through. */
const COLLATOR = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
const compare = COLLATOR.compare;          // a bound function (the getter binds it)

// "unknown artist" and "various artist" (singular) occur in the real catalogue (1 and 124 songs) —
// added at integration; "anonymous" (66) stays a real credit (traditional songs).
const PLACEHOLDERS = new Set(["", ".", "..", "-", "unknown", "unknown artist", "none", "n/a", "na", "various",
  "various artist", "various artists"]);
// Whitespace and C0/DEL control characters collapse to one space: a name such as "\0unknown" then
// folds to the placeholder "unknown", which is what keeps UNKNOWN_ARTIST from naming a real artist.
const SPACE_RUN = /[\s\u0000-\u001f\u007f]+/g;
const NON_ASCII = /[^\x00-\x7f]/;
const MARKS = /\p{M}+/gu;

const KIND_IDS = KINDS.map((k) => k.id);
const SOURCE_RANK = new Map(SOURCES.map((s, i) => [s, i]));
const KIND_RANK = new Map(KIND_IDS.map((k, i) => [k, i]));
const LAST = 0xffffffff;                   // the rank of "sorts after everything"

/** A name trimmed, with every run of whitespace (or control characters) made one space. Case kept. */
function cleanName(name) {
  return String(name).replace(SPACE_RUN, " ").trim();
}

/** cleanName → lower case (NFC for non-ASCII, so a decomposed "é" groups with a composed one). */
function keyOfClean(clean) {
  let k = clean.toLocaleLowerCase();
  if (NON_ASCII.test(k)) k = k.normalize("NFC");
  return PLACEHOLDERS.has(k) ? UNKNOWN_ARTIST : k;
}

// artistKey runs once per song in songsByArtist and the artist sort; a library has ~20k distinct
// spellings, so the folding is memoised per string (bounded; cleared, never trimmed).
const keyMemo = new Map();
const KEY_MEMO_MAX = 200000;

/**
 * The grouping key of an artist name: trimmed, inner whitespace collapsed, toLocaleLowerCase().
 * Placeholders fold into UNKNOWN_ARTIST: "", ".", "..", "-", "unknown", "none", "n/a", "na",
 * "various", "various artists", and (integration) "unknown artist", "various artist" (compared after
 * folding). null/undefined → UNKNOWN_ARTIST.
 */
export function artistKey(name) {
  if (name == null) return UNKNOWN_ARTIST;
  if (typeof name !== "string") return keyOfClean(cleanName(name));
  let k = keyMemo.get(name);
  if (k === undefined) {
    k = keyOfClean(cleanName(name));
    if (keyMemo.size >= KEY_MEMO_MAX) keyMemo.clear();
    keyMemo.set(name, k);
  }
  return k;
}

/** The artistKey folding plus diacritics removed (NFD, marks stripped): what filterArtists matches. */
function foldForMatch(text) {
  let f = cleanName(text ?? "").toLocaleLowerCase();
  if (NON_ASCII.test(f)) f = f.normalize("NFD").replace(MARKS, "");
  return f;
}

// ---------------------------------------------------------------------------------------------
// Filters
// ---------------------------------------------------------------------------------------------

/**
 * Which filter values occur in `songs`: { sources: string[], kinds: string[] }.
 * sources in catalog.js SOURCES order (SH, PLATKAR, TJMEDIA, MIDI), only those present; the empty
 * songbook ("" — an old catalogue, or a code-less file) is never a chip. kinds in KINDS order
 * (midi, audio, video), only those present (YouTube records are not in the catalogue list).
 */
export function presentFacets(songs) {
  const list = Array.isArray(songs) ? songs : [];
  const src = new Set(), kind = new Set();
  for (let i = 0; i < list.length; i++) {
    const s = list[i];
    if (!s) continue;
    if (SOURCE_RANK.has(s.source)) src.add(s.source);
    if (KIND_RANK.has(s.kind)) kind.add(s.kind);
    if (src.size === SOURCES.length && kind.size === KIND_IDS.length) break;   // nothing left to find
  }
  return {
    sources: SOURCES.filter((s) => src.has(s)),
    kinds: KIND_IDS.filter((k) => kind.has(k)),
  };
}

/** A filter axis → a Set to test against, or null when that axis does not filter. */
function activeSet(values) {
  if (values == null) return null;
  const set = typeof values.has === "function" && typeof values.size === "number" ? values : new Set(values);
  return set.size ? set : null;
}

/**
 * Keep the songs whose `source` is in `sources` AND whose `kind` is in `kinds`.
 * null or an empty Set for either = no filter on that axis. When nothing filters, return THE SAME
 * array (callers compare by identity to skip work). Order is preserved. A kind:"youtube" record is
 * kept only when no kind filter is active (it has no songbook either: kept only when no source
 * filter is active).
 * @param {object[]} songs
 * @param {{sources?: Set<string>|null, kinds?: Set<string>|null}} [f]
 */
export function applyFilters(songs, { sources = null, kinds = null } = {}) {
  const src = activeSet(sources), kin = activeSet(kinds);
  if (!src && !kin) return songs;
  const list = Array.isArray(songs) ? songs : [];
  const out = [];
  for (let i = 0; i < list.length; i++) {
    const s = list[i];
    // Any active filter drops a YouTube record: it has no songbook, and it is not a library kind.
    if (!s || s.kind === "youtube") continue;
    if (src && !src.has(s.source || "")) continue;
    if (kin && !kin.has(s.kind)) continue;
    out.push(s);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Collation ranks
// ---------------------------------------------------------------------------------------------

const RANK_TABLE_MAX = 600000;
const LOCAL_BELOW = 4096;                  // a shorter list with unseen strings is ranked on its own
const ranks = { map: new Map(), count: 0 };  // the shared table: string → rank, ranks 0..count-1
let rankOrder = [];                        // every string in the shared table, in collation order

/** Merge two collation-sorted string lists (ties keep `a` first). */
function mergeSorted(a, b) {
  const out = new Array(a.length + b.length);
  let i = 0, j = 0, k = 0;
  while (i < a.length && j < b.length) out[k++] = compare(a[i], b[j]) <= 0 ? a[i++] : b[j++];
  while (i < a.length) out[k++] = a[i++];
  while (j < b.length) out[k++] = b[j++];
  return out;
}

/** Ranks for distinct strings already in collation order: equal rank ⇔ the collator says equal. */
function rankSorted(sorted, table) {
  const map = new Map();
  let r = 0;
  for (let i = 0; i < sorted.length; i++) {
    if (i > 0 && compare(sorted[i - 1], sorted[i]) !== 0) r++;
    map.set(sorted[i], r);
  }
  table.map = map;
  table.count = sorted.length ? r + 1 : 0;
  return table;
}

/** The distinct strings of `lists` that `map` lacks (all of them when `map` is null). */
function missing(lists, map) {
  const out = new Set();
  for (const list of lists) {
    for (let i = 0; i < list.length; i++) if (!map || !map.has(list[i])) out.add(list[i]);
  }
  return out;
}

/** Give every string in `lists` a rank in the shared table: the new ones are sorted once and merged. */
function rankShared(lists) {
  let fresh = missing(lists, ranks.map);
  if (!fresh.size) return;
  let base = rankOrder;
  if (base.length + fresh.size > RANK_TABLE_MAX) {     // start over with only what this call needs
    base = [];
    fresh = missing(lists, null);
  }
  const add = [...fresh].sort(compare);
  rankOrder = base.length ? mergeSorted(base, add) : add;
  rankSorted(rankOrder, ranks);
}

/** The ranks of `list` in `table` (UNKNOWN_ARTIST → LAST when `unknownLast`), or null if one is missing. */
function lookupRanks(table, list, unknownLast) {
  const out = new Uint32Array(list.length);
  for (let i = 0; i < list.length; i++) {
    const s = list[i];
    if (unknownLast && s === UNKNOWN_ARTIST) { out[i] = LAST; continue; }
    const r = table.map.get(s);
    if (r === undefined) return null;
    out[i] = r;
  }
  return out;
}

/**
 * { nr, ar, count } — the ranks of the songs' titles and artist keys, and how many ranks the
 * table they came from has. Known strings come from the shared table; a short list that brings
 * strings the table has never seen (fresh YouTube rows, say) is ranked on its own instead, so it
 * neither pays for re-ranking the whole library nor leaves its strings in the table.
 */
function textRanks(names, artists) {
  let table = ranks;
  let nr = lookupRanks(table, names, false), ar = nr && lookupRanks(table, artists, true);
  if (!nr || !ar) {
    if (names.length < LOCAL_BELOW) {
      table = rankSorted([...missing([names, artists], null)].sort(compare), { map: null, count: 0 });
    } else {
      rankShared([names, artists]);
    }
    nr = lookupRanks(table, names, false);
    ar = lookupRanks(table, artists, true);
  }
  return { nr, ar, count: table.count };
}

// ---------------------------------------------------------------------------------------------
// Sort
// ---------------------------------------------------------------------------------------------

/** A song's dial number as a number, or Infinity when it has none (so it sorts last). */
function codeNumber(code) {
  if (typeof code === "number") return Number.isFinite(code) ? code : Infinity;
  if (typeof code === "string") {
    const t = code.trim();
    if (t && /^\d+$/.test(t)) return Number(t);
  }
  return Infinity;
}

function cmpNum(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** The title and artist-key ranks of `songs` (see textRanks), indexed like `songs`. */
function textKeys(songs) {
  const n = songs.length;
  const names = new Array(n), artists = new Array(n);
  for (let i = 0; i < n; i++) {
    const s = songs[i];
    const name = s ? s.name : undefined;
    names[i] = name == null ? "" : String(name);
    artists[i] = artistKey(s ? s.artistName : undefined);
  }
  return textRanks(names, artists);
}

function numbers(songs) {
  const out = new Float64Array(songs.length);
  for (let i = 0; i < songs.length; i++) out[i] = codeNumber(songs[i] ? songs[i].code : undefined);
  return out;
}

/** songs picked in `order` (an index permutation). */
function pick(songs, order) {
  const out = new Array(order.length);
  for (let i = 0; i < order.length; i++) out[i] = songs[order[i]];
  return out;
}

/** songs reordered by an index comparator; the index is the last tie-break, so it is stable. */
function sortedBy(songs, cmp) {
  const order = new Uint32Array(songs.length);
  for (let i = 0; i < order.length; i++) order[i] = i;
  return pick(songs, order.sort(cmp));
}

/**
 * The same order as sortedBy(songs, (x, y) => primary[x] - primary[y] || tieCmp(x, y)), where
 * `primary` holds ranks 0..rankCount-1 (or LAST) and tieCmp ends with the index. A large list is
 * counting-sorted on the rank (indices stay ascending inside a bucket) and only the runs of equal
 * rank go through the comparator; a list much smaller than the rank table is just sorted.
 */
function sortedByRank(songs, primary, rankCount, tieCmp) {
  const n = songs.length;
  const buckets = rankCount + 1;           // the last bucket holds LAST
  if (n < 1024 || buckets > n * 8) {
    return sortedBy(songs, (x, y) => (primary[x] - primary[y]) || tieCmp(x, y));
  }
  const start = new Uint32Array(buckets + 1);
  for (let i = 0; i < n; i++) start[(primary[i] === LAST ? rankCount : primary[i]) + 1]++;
  for (let b = 0; b < buckets; b++) start[b + 1] += start[b];
  const fill = start.slice(0, buckets);
  const order = new Uint32Array(n);
  for (let i = 0; i < n; i++) order[fill[primary[i] === LAST ? rankCount : primary[i]]++] = i;
  for (let b = 0; b < buckets; b++) {
    if (start[b + 1] - start[b] > 1) order.subarray(start[b], start[b + 1]).sort(tieCmp);
  }
  return pick(songs, order);
}

/**
 * "relevance" (or anything unknown) → the same array. "title" → by name, then artist, then
 * number; "artist" → by artist, then name; "code" → by number (numeric; songs without a number
 * last), then songbook in SOURCES order, then kind. All text comparisons use one shared
 * Intl.Collator (numeric, base sensitivity). Returns a sorted COPY; the sort is stable.
 * Budget: ≤ 300 ms for 121,000 songs on a laptop (measure it and report the number).
 *
 * "artist" compares artistKey values, so spellings of one artist sort together, and the
 * UNKNOWN_ARTIST bucket (placeholder names) sorts last, as it does in the artist index.
 */
export function sortSongs(songs, mode) {
  if (!Array.isArray(songs)) return songs;
  switch (mode) {
    case "title": {
      const { nr, ar, count } = textKeys(songs);
      const num = numbers(songs);
      return sortedByRank(songs, nr, count, (x, y) => (ar[x] - ar[y]) || cmpNum(num[x], num[y]) || (x - y));
    }
    case "artist": {
      const { nr, ar, count } = textKeys(songs);
      return sortedByRank(songs, ar, count, (x, y) => (nr[x] - nr[y]) || (x - y));
    }
    case "code": {
      const n = songs.length;
      const num = numbers(songs);
      const src = new Uint8Array(n), kind = new Uint8Array(n);
      for (let i = 0; i < n; i++) {
        const s = songs[i];
        const sr = s ? SOURCE_RANK.get(s.source) : undefined;
        const kr = s ? KIND_RANK.get(s.kind) : undefined;
        src[i] = sr === undefined ? SOURCES.length : sr;   // "" (no songbook) after every songbook
        kind[i] = kr === undefined ? KIND_IDS.length : kr;
      }
      return sortedBy(songs, (x, y) => cmpNum(num[x], num[y]) || (src[x] - src[y]) || (kind[x] - kind[y]) || (x - y));
    }
    default:
      return songs;
  }
}

// ---------------------------------------------------------------------------------------------
// Artists
// ---------------------------------------------------------------------------------------------

/**
 * The artist list: [{ key, name, count }], one per artistKey, where name = the most frequent
 * original spelling (ties: the first seen), count = songs in the bucket. Sorted by name with the
 * shared collator; the UNKNOWN_ARTIST bucket (labelled UNKNOWN_ARTIST_LABEL) is last.
 * One pass over `songs` (one Map), then one sort of the buckets. Budget: ≤ 150 ms for 121,000.
 *
 * A "spelling" is the name trimmed with its whitespace collapsed (case and accents kept). The pass
 * looks each song's raw artistName up in one Map; only a name not seen before is folded.
 */
export function buildArtistIndex(songs) {
  const list = Array.isArray(songs) ? songs : [];
  const seen = new Map();                  // raw artistName → its spelling record
  const buckets = new Map();               // artistKey → { key, spellings: [{ text, n }], count }
  for (let i = 0; i < list.length; i++) {
    const s = list[i];
    if (!s) continue;
    const raw = s.artistName;
    let sp = seen.get(raw);
    if (sp === undefined) {
      const key = artistKey(raw);
      let b = buckets.get(key);
      if (!b) { b = { key, spellings: [], count: 0 }; buckets.set(key, b); }
      const text = raw == null ? "" : cleanName(raw);
      sp = b.spellings.find((x) => x.text === text);
      if (!sp) { sp = { text, n: 0, b }; b.spellings.push(sp); }
      seen.set(raw, sp);
    }
    sp.n++;
    sp.b.count++;
  }

  const out = [];
  let unknown = null;
  for (const b of buckets.values()) {
    if (b.key === UNKNOWN_ARTIST) { unknown = { key: UNKNOWN_ARTIST, name: UNKNOWN_ARTIST_LABEL, count: b.count }; continue; }
    let best = b.spellings[0];
    for (let k = 1; k < b.spellings.length; k++) if (b.spellings[k].n > best.n) best = b.spellings[k];
    out.push({ key: b.key, name: best.text, count: b.count });
  }
  out.sort((a, b) => compare(a.name, b.name) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  if (unknown) out.push(unknown);
  return out;
}

/** The songs whose artistKey(artistName) === key, sorted by title (then number). */
export function songsByArtist(songs, key) {
  const list = Array.isArray(songs) ? songs : [];
  const hits = [];
  for (let i = 0; i < list.length; i++) {
    const s = list[i];
    if (s && artistKey(s.artistName) === key) hits.push(s);
  }
  // One artist key, so "title" (name, then artist key, then number) is exactly name, then number.
  return sortSongs(hits, "title");
}

// The folded names of an artist index, computed once per index array (typing filters it per key).
const foldedNames = new WeakMap();

/**
 * Filter the artist list by a typed query: every whitespace token must occur in the folded name
 * (same folding as artistKey, diacritics stripped with NFD). Empty query → the same array.
 */
export function filterArtists(index, query) {
  if (!Array.isArray(index)) return index;
  const q = foldForMatch(query);
  if (!q) return index;
  const tokens = q.split(" ");
  let folded = foldedNames.get(index);
  if (!folded || folded.length !== index.length) {
    folded = index.map((a) => foldForMatch(a ? a.name : ""));
    foldedNames.set(index, folded);
  }
  const out = [];
  next: for (let i = 0; i < index.length; i++) {
    const f = folded[i];
    for (let t = 0; t < tokens.length; t++) if (!f.includes(tokens[t])) continue next;
    out.push(index[i]);
  }
  return out;
}
