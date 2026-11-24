/*
 * library-browse.js — pure helpers for the Songs panel's Artists tab: the artist key, the artist
 * index, one artist's songs and the typed artist filter (M6, plan §5.7).
 *
 * The songbook / type chips and the sort select were removed (2026-11-24, Rae): every list shows
 * every song in its Relevance order, so the filters, the facets and the library-wide sort left
 * with them. What stays is everything the Artists tab needs.
 *
 * Everything here is pure (no DOM, no storage, no clock) and must stay fast on the full library
 * (~124,000 songs): one pass, one Map, no sort inside a loop, one shared Intl.Collator.
 */

/** The key of the "(Unknown artist)" bucket. Sorts last; never collides with a real name. */
export const UNKNOWN_ARTIST = "\u0000unknown";
/** How the unknown bucket is labelled. */
export const UNKNOWN_ARTIST_LABEL = "(Unknown artist)";

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

// artistKey runs once per song in songsByArtist; a library has ~20k distinct
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
// One artist's songs, by title
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

/**
 * `songs` by title (the shared collator: numeric, base sensitivity), then by number, then in
 * input order — a sorted copy. The collator ranks each DISTINCT title once and the songs are then
 * sorted by integer rank: the unknown-artist bucket holds ~11,000 songs on the real catalogue, and a
 * comparator calling the collator on every comparison would pay for it ~150,000 times.
 */
function byTitle(songs) {
  const n = songs.length;
  const names = new Array(n);
  for (let i = 0; i < n; i++) {
    const name = songs[i] ? songs[i].name : undefined;
    names[i] = name == null ? "" : String(name);
  }
  const distinct = [...new Set(names)].sort(compare);
  const rankOf = new Map();
  for (let i = 0, r = 0; i < distinct.length; i++) {
    if (i > 0 && compare(distinct[i - 1], distinct[i]) !== 0) r++;   // equal rank ⇔ the collator says equal
    rankOf.set(distinct[i], r);
  }
  const rank = new Uint32Array(n), num = new Float64Array(n), order = new Uint32Array(n);
  for (let i = 0; i < n; i++) {
    rank[i] = rankOf.get(names[i]);
    num[i] = codeNumber(songs[i] ? songs[i].code : undefined);
    order[i] = i;
  }
  order.sort((x, y) => (rank[x] - rank[y]) || (num[x] < num[y] ? -1 : num[x] > num[y] ? 1 : 0) || (x - y));
  const out = new Array(n);
  for (let i = 0; i < n; i++) out[i] = songs[order[i]];
  return out;
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
  return byTitle(hits);
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
