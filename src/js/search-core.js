/*
 * search-core.js — the fuzzy ("close match") search engine, plus the two helpers that order and
 * merge the three result tiers (number · exact · close). Pure: no DOM, no Worker, no timers. The
 * search worker imports it, and so does the main thread (the fallback build in search-client.js,
 * and the tier helpers in library-view.js).
 *
 * How a close match is found. Every title and artist is folded (lower-case, accents removed,
 * punctuation → spaces) and split into words. The index keeps each DISTINCT word once, sorted,
 * with the ascending list of songs that contain it and whether it occurs in that song's title.
 * A query token is compared against the word list only — never against the songs. Words that
 * start with the token's first character are a contiguous range of the sorted list; a token of 5+
 * characters may also match a word whose first letter differs ("otday" → today), within the same
 * edit budget and at a lower weight, found by a filtered scan of the rest of the list. A song is a
 * close match when EVERY token matches one of its words: exactly, as a prefix, or within an edit
 * distance that grows with the token's length.
 */

export const MAX_CLOSE = 200;

// Per-token weights. A matched word in the title counts ×TITLE_BOOST.
const WEIGHT = { exact: 3, prefix: 2, d1: 1.5, d2: 1 };
// A word whose first letter differs from the token's: ×0.8 of the distance kind (1.5 → 1.2, 1 → 0.8).
const SHIFTED = { d1: 1.2, d2: 0.8 };
const SHIFT_MIN = 5;                // only tokens this long may change their first letter
const TITLE_BOOST = 1.5;
const TIE_BREAK = 0.002;            // × title length: prefer tighter titles (same as Catalog.search)

const NON_ASCII = /[^\x00-\x7f]/;
const MARKS = /\p{M}+/gu;
const NON_ALNUM = /[^\p{L}\p{N}]+/gu;
const NON_ALNUM_ASCII = /[^a-z0-9]+/g;

/**
 * Lower-case, decompose (NFD), drop combining marks, turn every non-alphanumeric run into one
 * space, trim. "Beyoncé" → "beyonce"; "Don't  Stop!" → "don t stop". Pure-ASCII text (almost all
 * of the library) skips the Unicode work.
 */
export function fold(text) {
  let s = String(text ?? "").toLowerCase();
  if (NON_ASCII.test(s)) s = s.normalize("NFD").replace(MARKS, "").replace(NON_ALNUM, " ");
  else s = s.replace(NON_ALNUM_ASCII, " ");
  return s.trim();
}

/** fold(text) split into words; never contains an empty string. */
export function tokenize(text) {
  const f = fold(text);
  return f ? f.split(" ").filter(Boolean) : [];
}

/** How many edits a token of `len` characters may be away from a word: <4 → 0, 4–7 → 1, ≥8 → 2. */
export function maxDistance(len) {
  return len < 4 ? 0 : len < 8 ? 1 : 2;
}

// Rolling rows for boundedDistance, grown on demand and reused (the module is single-threaded).
let rowA = new Int32Array(32), rowB = new Int32Array(32), rowC = new Int32Array(32);

/**
 * Damerau–Levenshtein distance in its optimal-string-alignment form (insert, delete, substitute,
 * swap two neighbours), compared by UTF-16 code unit. Stops as soon as a whole row exceeds `max`
 * and then returns `max + 1`, so a hopeless pair costs a row or two, not the full table.
 */
export function boundedDistance(a, b, max) {
  a = String(a ?? ""); b = String(b ?? "");
  const la = a.length, lb = b.length;
  const limit = Math.max(0, max | 0);
  if (Math.abs(la - lb) > limit) return limit + 1;
  if (la === 0 || lb === 0) return Math.max(la, lb);   // ≤ limit, by the check above
  if (rowA.length <= lb) {
    const n = (lb + 1) * 2;
    rowA = new Int32Array(n); rowB = new Int32Array(n); rowC = new Int32Array(n);
  }
  let pp = rowA, p = rowB, c = rowC;                 // rows i-2, i-1, i
  for (let j = 0; j <= lb; j++) p[j] = j;
  for (let i = 1; i <= la; i++) {
    const ai = a.charCodeAt(i - 1);
    const aPrev = i > 1 ? a.charCodeAt(i - 2) : -1;
    c[0] = i;
    let rowMin = i;
    for (let j = 1; j <= lb; j++) {
      const bj = b.charCodeAt(j - 1);
      let v = p[j - 1] + (ai === bj ? 0 : 1);        // substitute (or keep)
      const del = p[j] + 1, ins = c[j - 1] + 1;
      if (del < v) v = del;
      if (ins < v) v = ins;
      if (j > 1 && ai === b.charCodeAt(j - 2) && aPrev === bj) {
        const swap = pp[j - 2] + 1;                  // neighbours swapped
        if (swap < v) v = swap;
      }
      c[j] = v;
      if (v < rowMin) rowMin = v;
    }
    // No later row can dip below this row's minimum: a cell comes from the row above at a cost
    // ≥ 0, and a swap's source two rows up is at least d[i-1][j-1] − 1, so it adds back ≥ that
    // row's value. Once a whole row is above `limit`, so is the answer.
    if (rowMin > limit) return limit + 1;
    const t = pp; pp = p; p = c; c = t;
  }
  const d = p[lb];
  return d > limit ? limit + 1 : d;
}

// ---------------------------------------------------------------------------------------------
// The word index
// ---------------------------------------------------------------------------------------------

/**
 * Accumulates (word, song, inTitle) occurrences in song order, one per distinct word per song,
 * then packs them per word in sorted-word order. Shared by buildIndex and buildIndexSteps so the
 * two produce the same index by construction.
 */
function createBuilder(count) {
  const ids = new Map();                   // word → provisional id (first-seen order)
  const list = [];                         // provisional id → word
  let last = new Int32Array(1024).fill(-1);  // provisional id → last song that recorded it
  let cap = Math.max(1024, count * 6);
  let occW = new Uint32Array(cap), occS = new Uint32Array(cap), occT = new Uint8Array(cap);
  let n = 0;

  function record(word, song, inTitle) {
    let w = ids.get(word);
    if (w === undefined) {
      w = list.length;
      ids.set(word, w); list.push(word);
      if (w >= last.length) { const grown = new Int32Array(last.length * 2).fill(-1); grown.set(last); last = grown; }
    }
    if (last[w] === song) return;          // titles are recorded first, so the title flag wins
    last[w] = song;
    if (n === cap) {
      cap *= 2;
      const w2 = new Uint32Array(cap); w2.set(occW); occW = w2;
      const s2 = new Uint32Array(cap); s2.set(occS); occS = s2;
      const t2 = new Uint8Array(cap); t2.set(occT); occT = t2;
    }
    occW[n] = w; occS[n] = song; occT[n] = inTitle; n++;
  }

  return {
    add(song, title, artist) {
      for (const word of tokenize(title)) record(word, song, 1);
      for (const word of tokenize(artist)) record(word, song, 0);
    },
    finish() {
      const words = list.slice().sort();   // code-unit order: equal first letters are contiguous
      const rank = new Uint32Array(list.length);
      for (let k = 0; k < words.length; k++) rank[ids.get(words[k])] = k;
      const start = new Uint32Array(words.length + 1);
      for (let j = 0; j < n; j++) start[rank[occW[j]] + 1]++;
      for (let k = 0; k < words.length; k++) start[k + 1] += start[k];
      const flatS = new Uint32Array(n), flatT = new Uint8Array(n);
      const fill = start.slice(0, words.length);
      for (let j = 0; j < n; j++) {        // occurrences are in song order → postings stay ascending
        const at = fill[rank[occW[j]]]++;
        flatS[at] = occS[j]; flatT[at] = occT[j];
      }
      const songs = new Array(words.length), inTitle = new Array(words.length);
      for (let k = 0; k < words.length; k++) {
        songs[k] = flatS.subarray(start[k], start[k + 1]);
        inTitle[k] = flatT.subarray(start[k], start[k + 1]);
      }
      const index = { words, songs, inTitle, count };
      wordStats(index);                    // derive the scan filters now, not on the first query
      return index;
    },
  };
}

function songCount(titles, artists) {
  return Math.max(titles ? titles.length : 0, artists ? artists.length : 0);
}

/**
 * The word index over songs 0..n-1 (titles[i] and artists[i] belong to song i):
 *   { words: string[] (distinct folded words, sorted), songs: Uint32Array[] (ascending song
 *     indices per word), inTitle: Uint8Array[] (1 where the word is in that song's TITLE), count }
 */
export function buildIndex(titles, artists) {
  const count = songCount(titles, artists);
  const b = createBuilder(count);
  for (let i = 0; i < count; i++) b.add(i, titles?.[i], artists?.[i]);
  return b.finish();
}

/**
 * The same index as buildIndex, built in slices for the main-thread fallback: yields the number
 * of songs done after every `chunk` songs (the last slice may be shorter); the final next() packs
 * the index and returns it.
 */
export function* buildIndexSteps(titles, artists, chunk = 5000) {
  const count = songCount(titles, artists);
  const b = createBuilder(count);
  const size = Math.max(1, Math.floor(chunk) || 1);
  for (let i = 0; i < count;) {
    const end = Math.min(count, i + size);
    for (; i < end; i++) b.add(i, titles?.[i], artists?.[i]);
    yield i;
  }
  return b.finish();
}

/** Title lengths (characters, capped at 65535) for searchClose's tie-break. */
export function titleLengths(titles) {
  const n = titles ? titles.length : 0;
  const out = new Uint16Array(n);
  for (let i = 0; i < n; i++) out[i] = Math.min(65535, String(titles[i] ?? "").length);
  return out;
}

// ---------------------------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------------------------

function lowerBound(words, key) {
  let lo = 0, hi = words.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (words[mid] < key) lo = mid + 1; else hi = mid;
  }
  return lo;
}

/** The first string after every string that starts with `prefix` (its last code unit bumped). */
function prefixEnd(prefix) {
  const last = prefix.charCodeAt(prefix.length - 1);
  return last === 0xffff ? null : prefix.slice(0, -1) + String.fromCharCode(last + 1);
}

// Per-index word lengths and letter-class masks: the cheap filters in front of boundedDistance for
// the different-first-letter scan. Derived from index.words only, so the worker and the main
// thread compute identical values. Kept beside the index (never part of its shape).
const statsFor = new WeakMap();

/** One of 32 classes per code unit: a–z → 0–25, digits → 26–30 (paired), anything else → 31. */
function letterMask(s) {
  let m = 0;
  for (let k = 0; k < s.length; k++) {
    const c = s.charCodeAt(k);
    m |= 1 << (c >= 97 && c <= 122 ? c - 97 : c >= 48 && c <= 57 ? 26 + ((c - 48) % 5) : 31);
  }
  return m;
}

function wordStats(index) {
  let st = statsFor.get(index);
  if (!st || st.len.length !== index.words.length) {
    const n = index.words.length;
    const len = new Uint8Array(n), mask = new Int32Array(n);
    for (let w = 0; w < n; w++) {
      const word = index.words[w];
      len[w] = Math.min(255, word.length);
      mask[w] = letterMask(word);
    }
    st = { len, mask };
    statsFor.set(index, st);
  }
  return st;
}

/** True when `x` has at most `k` bits set. */
function fewBits(x, k) {
  for (let i = 0; i < k && x !== 0; i++) x &= x - 1;
  return x === 0;
}

/**
 * Words in [from, to) — none sharing the token's first letter — within `max` edits of `t`.
 * A class of characters in one string but absent from the other needs its own edit, so more than
 * `max` such classes either way rules the word out before any distance is computed.
 */
function shiftedMatches(index, t, max, from, to, out) {
  const { len, mask } = wordStats(index);
  const words = index.words, tl = t.length, tm = letterMask(t);
  for (let w = from; w < to; w++) {
    const dl = len[w] - tl;
    if (dl > max || dl < -max) continue;
    const m = mask[w];
    if (!fewBits(tm & ~m, max) || !fewBits(m & ~tm, max)) continue;
    const d = boundedDistance(t, words[w], max);
    if (d > max) continue;                 // max + 1 means "over budget", not "distance 2"
    out.push(d === 1 ? { w, kind: "d1", weight: SHIFTED.d1 } : { w, kind: "d2", weight: SHIFTED.d2 });
  }
}

/**
 * Every word matching one (already folded) token, in word order:
 *   "exact" (weight 3); "prefix" (2: the word starts with the token, token ≥ 2 characters);
 *   "d1" (1.5) / "d2" (1): same first letter, within maxDistance(token.length) edits;
 *   "d1" (1.2) / "d2" (0.8): a token of 5+ characters and a word whose FIRST letter differs, within
 *   the same budget — the first-letter edit is one of the allowed edits.
 * Same-first-letter words are a binary-searched range; the rest are scanned only for long tokens.
 */
export function matchWords(index, token) {
  const out = [];
  const t = String(token ?? "");
  if (!index || !t) return out;
  const words = index.words;
  const max = maxDistance(t.length);
  const prefixOk = t.length >= 2;
  // Distance kinds need the whole first-letter range; exact/prefix only the token's own range.
  const from = max > 0 ? t[0] : t;
  const lo = lowerBound(words, from);
  let hi;
  if (max === 0 && !prefixOk) hi = words[lo] === t ? lo + 1 : lo;
  else { const end = prefixEnd(from); hi = end === null ? words.length : lowerBound(words, end); }
  const shifted = t.length >= SHIFT_MIN;   // max ≥ 1 here, so [lo, hi) is the first-letter range
  if (shifted) shiftedMatches(index, t, max, 0, lo, out);
  for (let w = lo; w < hi; w++) {
    const word = words[w];
    if (word === t) out.push({ w, kind: "exact", weight: WEIGHT.exact });
    else if (prefixOk && word.startsWith(t)) out.push({ w, kind: "prefix", weight: WEIGHT.prefix });
    else if (max > 0 && Math.abs(word.length - t.length) <= max) {
      const d = boundedDistance(t, word, max);
      if (d > max) continue;               // max + 1 means "over budget", not "distance 2"
      out.push(d === 1 ? { w, kind: "d1", weight: WEIGHT.d1 } : { w, kind: "d2", weight: WEIGHT.d2 });
    }
  }
  if (shifted) shiftedMatches(index, t, max, hi, words.length, out);
  return out;
}

// Per-index scratch arrays for searchClose, reset after every query (single-threaded module).
const scratchFor = new WeakMap();
function scratch(index) {
  let s = scratchFor.get(index);
  if (!s || s.best.length !== index.count) {
    s = { best: new Float64Array(index.count), total: new Float64Array(index.count), alive: new Uint8Array(index.count) };
    scratchFor.set(index, s);
  }
  return s;
}

/**
 * Close matches for a query: AND across its tokens (a song must match every token through some
 * word). Per token the song's best weight counts, ×1.5 when that word is in its title; the tokens
 * are summed, minus 0.002 × titleLen[i] when titleLen is given. Songs in `exclude` (a Set) are
 * skipped. Sorted by score (best first), then song index; at most `limit`. Returns [] when no
 * token is at least 4 characters long.
 */
export function searchClose(index, query, { limit = MAX_CLOSE, exclude = null, titleLen = null } = {}) {
  const tokens = tokenize(query);
  if (!index || !index.count || !tokens.some((t) => t.length >= 4)) return [];
  const cap = limit == null || Number.isNaN(Number(limit)) ? MAX_CLOSE : Math.max(0, Math.floor(Number(limit)));
  if (cap === 0) return [];

  // One pass per DISTINCT token; a repeated token counts its weight once per occurrence.
  const times = new Map();
  for (const t of tokens) times.set(t, (times.get(t) || 0) + 1);
  const plan = [];
  for (const [t, mult] of times) {
    const matches = matchWords(index, t);
    if (!matches.length) return [];        // AND: one token with no word ends the search
    let cost = 0;
    for (const m of matches) cost += index.songs[m.w].length;
    plan.push({ matches, mult, cost });
  }
  plan.sort((a, b) => a.cost - b.cost);    // most selective first: later tokens only filter

  const { best, total, alive } = scratch(index);
  let cand = [];
  try {
    for (let k = 0; k < plan.length; k++) {
      const { matches, mult } = plan[k];
      for (const m of matches) {
        const posts = index.songs[m.w], flags = index.inTitle[m.w];
        for (let j = 0; j < posts.length; j++) {
          const s = posts[j];
          if (k > 0 && !alive[s]) continue;
          const wt = flags[j] ? m.weight * TITLE_BOOST : m.weight;
          if (wt > best[s]) {
            if (k === 0 && best[s] === 0) { cand.push(s); alive[s] = 1; }
            best[s] = wt;
          }
        }
      }
      const next = [];
      for (const s of cand) {
        if (best[s] > 0) { total[s] += best[s] * mult; best[s] = 0; next.push(s); }
        else { alive[s] = 0; total[s] = 0; }
      }
      cand = next;
      if (!cand.length) return [];
    }
    const ex = exclude == null ? null : (typeof exclude.has === "function" ? exclude : new Set(exclude));
    const out = [];
    for (const s of cand) {
      if (ex && ex.has(s)) continue;
      out.push({ i: s, score: titleLen ? total[s] - TIE_BREAK * titleLen[s] : total[s] });
    }
    out.sort((a, b) => b.score - a.score || a.i - b.i);
    return out.length > cap ? out.slice(0, cap) : out;
  } finally {
    for (const s of cand) { best[s] = 0; total[s] = 0; alive[s] = 0; }
  }
}

// ---------------------------------------------------------------------------------------------
// Tier helpers (used by library-view.js)
// ---------------------------------------------------------------------------------------------

const KIND_ORDER = ["midi", "audio", "video"];

/** Exact-number matches in songbook order (unknown / "" source last), then MIDI → audio → video → other. Stable. */
export function orderNumberMatches(songs, sources) {
  const srcRank = (s) => { const i = sources.indexOf(s.source || ""); return (s.source && i >= 0) ? i : sources.length; };
  const kindRank = (s) => { const i = KIND_ORDER.indexOf(s.kind); return i >= 0 ? i : KIND_ORDER.length; };
  return songs.map((s, i) => [s, i])
    .sort((a, b) => srcRank(a[0]) - srcRank(b[0]) || kindRank(a[0]) - kindRank(b[0]) || a[1] - b[1])
    .map(([s]) => s);
}

/** Concatenate result lists, dropping songs already seen (object identity), keeping first-seen order. */
export function mergeTiers(...lists) {
  const seen = new Set(); const out = [];
  for (const list of lists) for (const s of list || []) if (!seen.has(s)) { seen.add(s); out.push(s); }
  return out;
}
