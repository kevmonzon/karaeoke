/*
 * catalog.js — loads the song library and provides search/lookup.
 *
 * Three sources are merged into one list:
 *   /catalog.json        → MIDI/KAR songs   (tagged kind:"midi")
 *   /catalog-video.json  → video songs      (tagged kind:"video", may be absent)
 *   /catalog-audio.json  → audio+lyrics     (tagged kind:"audio", may be absent)
 * Each record has the catalog schema + a `file` path, and gets:
 *   { code, name, artistName, langName, type, source, file, kind, id }
 * where `id = `${kind}:${code}`` — a stable identity so a MIDI song and a video
 * song that happen to share a dial `code` never clobber one another.
 * `source` is the songbook the file came from (one of SOURCES), or "" — including for
 * every record of a catalogue built before the field existed.
 */

// Above this many matches, skip the relevance sort and return in catalog order — keeps a
// broad single-word query (thousands of hits) snappy per keystroke. Narrow (multi-token)
// queries — the ones ranking actually helps — are well under this.
const SEARCH_RANK_CAP = 2000;

/** The songbooks a record's `source` can name (tools/catalog_common.py SOURCE_TAGS). */
export const SOURCES = ["SH", "PLATKAR", "TJMEDIA", "MIDI"];

/** A typed dial number → the form `String(song.code)` takes: digits only, leading zeros
 *  dropped ("00123" → "123", "000" → "0", "12a" → "12", "" → ""). */
export function normalizeCode(text) {
  const digits = String(text ?? "").replace(/\D/g, "");
  return digits.replace(/^0+(?=\d)/, "");
}

/** Relevance score for a matched song (higher = better). Title hits weigh more than artist;
 *  exact / prefix / whole-query-in-title get bonuses; shorter titles win ties. */
export function scoreMatch(song, q, tokens) {
  const name = (song.name || "").toLowerCase();
  const artist = (song.artistName || "").toLowerCase();
  let sc = 0;
  if (name === q) sc += 100;                 // exact title
  else if (name.startsWith(q)) sc += 40;     // title starts with the whole query
  else if (name.includes(q)) sc += 20;       // whole query somewhere in the title
  if (name.startsWith(tokens[0])) sc += 10;  // title starts with the first word
  for (const t of tokens) {
    if (name.includes(t)) sc += 4;           // each word in the title
    else if (artist.includes(t)) sc += 2;    // …or the artist
  }
  return sc - name.length * 0.002;           // tie-break: prefer tighter titles
}

export class Catalog {
  constructor() {
    this.songs = [];
    this.byCode = new Map(); // code → first matching record (numeric search / Enter)
    this.byId = new Map();   // `${kind}:${code}` → record (unambiguous identity)
    this.bySourceCode = new Map(); // `${source}:${code}` → every record, catalogue order
    this._byCodeAll = new Map();   // code → every record of every source, catalogue order
    this._codeIndexPending = false; // adopt(…, {deferCodeIndex}) left the three code maps unbuilt
  }

  /**
   * Load and merge the MIDI catalog and (if present) the video + audio catalogs.
   * The video/audio catalogs are optional: a 404 or parse error is non-fatal.
   * `audioUrl` defaults so callers that pass only (midi, video) still get audio songs.
   * @returns total number of songs loaded.
   */
  async load(midiUrl = "/catalog.json", videoUrl = "/catalog-video.json", audioUrl = "/catalog-audio.json") {
    const midi = await fetchArray(midiUrl, /*required*/ true);
    const video = await fetchArray(videoUrl, /*required*/ false);
    const audioSongs = await fetchArray(audioUrl, /*required*/ false);

    this.songs = [
      ...midi.map((s) => tag(s, "midi")),
      ...video.map((s) => tag(s, "video")),
      ...audioSongs.map((s) => tag(s, "audio")),
    ];

    this.byCode.clear();
    this.byId.clear();
    this._clearCodeIndex();
    this._codeIndexPending = false;
    for (const s of this.songs) {
      // Duplicate dial codes are allowed (several files can share a code). The FIRST record
      // keeps the plain `kind:code` id (stable for saved sessions/favorites); a later collision
      // is disambiguated by file path so it stays a distinct, resolvable song (mirrors the
      // blank-code handling in tag() — see §5.10).
      if (this.byId.has(s.id)) s.id = `${s.kind}:${s.file || s.name}`;
      this.byId.set(s.id, s);
      this._indexCode(s);
    }
    return this.songs.length;
  }

  /**
   * Replace the song list with records prepared elsewhere and rebuild every index.
   * A record that already has an `id` and a `_search` haystack is taken as it is — its id
   * may be a file-path disambiguation that re-tagging would undo. Any other record is
   * tagged as load() would (its own `kind`, else "midi"). The first record keeps an id
   * that two pre-tagged records share. @returns the number of songs.
   *
   * `deferCodeIndex: true` (the phone, M7) leaves byCode / bySourceCode / the every-code map
   * unbuilt — about 3/4 of adopt()'s time on a 124k-song catalogue — until the first get() or
   * lookupCode(), or an explicit ensureCodeIndex() (the phone schedules one right after its first
   * paint). Default: built at once, as before.
   */
  adopt(songs, { deferCodeIndex = false } = {}) {
    this.songs = Array.isArray(songs) ? songs.filter((s) => s && typeof s === "object") : [];
    this.byCode.clear();
    this.byId.clear();
    this._clearCodeIndex();
    for (const s of this.songs) {
      if (s.id && typeof s._search === "string") {
        if (!this.byId.has(s.id)) this.byId.set(s.id, s);
      } else {
        tag(s, s.kind || "midi");
        if (this.byId.has(s.id)) s.id = `${s.kind}:${s.file || s.name}`;
        this.byId.set(s.id, s);
      }
      if (!deferCodeIndex) this._indexCode(s);
    }
    this._codeIndexPending = !!deferCodeIndex;
    return this.songs.length;
  }

  /** Build the code maps now if adopt() deferred them (a no-op otherwise). */
  ensureCodeIndex() {
    if (!this._codeIndexPending) return;
    this._codeIndexPending = false;
    for (const s of this.songs) this._indexCode(s);
  }

  /**
   * Every song dialled by `code`, in catalogue order. `source` "all" (the default, also
   * null) spans every songbook and kind; any other value keeps only that `source` ("" =
   * records with none). `code` is compared as a string, unnormalised — pass a typed
   * number through normalizeCode() first. Returns a fresh array ([] when nothing matches).
   */
  lookupCode(code, source = "all") {
    this.ensureCodeIndex();
    const key = String(code ?? "");
    if (!key) return [];
    const hits = (source == null || source === "all")
      ? this._byCodeAll.get(key)
      : this.bySourceCode.get(`${source}:${key}`);
    return hits ? hits.slice() : [];
  }

  _clearCodeIndex() {
    this.bySourceCode.clear();
    this._byCodeAll.clear();
  }

  /** Add one record to byCode (first wins, as before) and the two every-record code maps. */
  _indexCode(s) {
    // Blank codes (untitled drop-in videos) aren't dialable — keep them out of byCode.
    const codeKey = String(s.code);
    if (codeKey && !this.byCode.has(codeKey)) this.byCode.set(codeKey, s);
    if (s.code === "" || s.code == null) return;
    pushTo(this._byCodeAll, codeKey, s);
    pushTo(this.bySourceCode, `${s.source || ""}:${codeKey}`, s);
  }

  /** Look up by dial code (first match; MIDI wins on a collision). */
  get(code) { this.ensureCodeIndex(); return this.byCode.get(String(code)); }

  /** Look up by stable id (`${kind}:${code}`) — unambiguous across KAR/VID. */
  getById(id) { return this.byId.get(String(id)); }

  /**
   * Register a record (a live YouTube search result or a persisted YouTube favorite/recent)
   * so getById() resolves it, WITHOUT adding it to the browse list (this.songs) — YouTube
   * songs aren't part of the local library, they only appear while searching / in
   * favorites / recent / queue. Idempotent. Returns the record.
   */
  addExternal(record) {
    if (record && record.id) this.byId.set(record.id, record);
    return record;
  }

  /**
   * Search the library. A **pure number** is a dial-code prefix (unchanged). Anything else
   * is **token-AND**: the query is split into words and a song matches when EVERY word appears
   * somewhere in its title / artist / language / code — so a query can span fields and word
   * order doesn't matter ("beer itchyworms" → "Beer" by "The Itchyworms"; "itchy beer" too).
   * Matches are then relevance-ranked (title hits > artist, exact/prefix > contains). The list
   * UI is virtualized, so the default cap is high; callers wanting the top hit pass `limit = 1`.
   */
  search(query, limit = 100000) {
    const q = query.trim().toLowerCase();
    if (!q) return this.songs.slice(0, limit);

    // Pure numeric → dial-code prefix (fast path, first matches win).
    if (/^\d+$/.test(q)) {
      const out = [];
      for (const s of this.songs) {
        if (String(s.code).startsWith(q)) { out.push(s); if (out.length >= limit) break; }
      }
      return out;
    }

    // Token-AND substring across the precomputed haystack.
    const tokens = q.split(/\s+/).filter(Boolean);
    const matches = [];
    for (const s of this.songs) {
      const hay = s._search || "";
      let ok = true;
      for (let i = 0; i < tokens.length; i++) {
        if (!hay.includes(tokens[i])) { ok = false; break; }
      }
      if (ok) matches.push(s);
    }

    // Relevance-rank the matched subset (cheap; skipped for very broad result sets to stay snappy).
    if (matches.length > 1 && matches.length <= SEARCH_RANK_CAP) {
      matches.sort((a, b) => scoreMatch(b, q, tokens) - scoreMatch(a, q, tokens));
    }
    return matches.length > limit ? matches.slice(0, limit) : matches;
  }

  /** Build a fetchable URL for a song's local file (paths may contain spaces). */
  static fileUrl(song) {
    if (!song || !song.file) return null;
    return "/" + song.file.split("/").map(encodeURIComponent).join("/");
  }

  /** Build a fetchable URL for an AUDIO song's lyric sidecar (null if none). */
  static lyricsUrl(song) {
    if (!song || !song.lyrics) return null;
    return "/" + song.lyrics.split("/").map(encodeURIComponent).join("/");
  }

  /**
   * Build a transient catalog record from a YouTube search item
   * `{videoId, title, channelTitle}`. YouTube songs carry no dial `code` and no local
   * `file` — identity is the `videoId` (`id = "youtube:<videoId>"`). Pure + testable.
   * Returns null for an item without a videoId.
   */
  static makeYoutubeRecord(item) {
    const videoId = item && item.videoId;
    if (!videoId) return null;
    return {
      kind: "youtube",
      id: `youtube:${videoId}`,
      code: "",
      videoId,
      name: item.title || "(untitled)",
      artistName: item.channelTitle || "",
      langName: "YouTube",
      type: "YOUTUBE",
    };
  }
}

/** Tag a raw catalog record with its kind + stable id (returns the same object).
 *  A blank code (an untitled drop-in video) can't identify the record, so we key the
 *  id on the file path instead — otherwise every code-less video collapses to the
 *  same id and they clobber each other in the list / queue / session. */
function tag(song, kind) {
  song.kind = kind;
  song.source = song.source || "";
  const key = (song.code === "" || song.code == null) ? (song.file || song.name) : song.code;
  song.id = `${kind}:${key}`;
  // Precomputed lowercased haystack (title + artist + lang + code + source) for token search —
  // built once at load so a keystroke over 60k+ songs doesn't re-lowercase every field.
  // A record with no source gets exactly the haystack it had before the field existed.
  song._search = (`${song.name || ""} ${song.artistName || ""} ${song.langName || ""} ${song.code ?? ""}`
    + (song.source ? ` ${song.source}` : "")).toLowerCase();
  return song;
}

/** Append `value` to the array stored under `key`, creating it on first use. */
function pushTo(map, key, value) {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

/**
 * Resolve a STORED reference back to a song.
 *
 * The current format is a stable id ("midi:5" / "video:5" / "youtube:<videoId>"); sessions
 * written before ids existed stored a bare numeric code, which means a MIDI code. Shared by
 * the session, favorites and the YouTube pointer cache so the back-compat rule has exactly
 * one implementation.
 */
export function resolveSongRef(catalog, ref) {
  if (!catalog) return undefined;
  return (typeof ref === "string" && ref.includes(":")) ? catalog.getById(ref) : catalog.get(ref);
}

/** fetch() a JSON array. `required` sources throw on failure; optional ones → []. */
async function fetchArray(url, required) {
  try {
    const res = await fetch(url);
    if (!res.ok) {
      if (required) throw new Error(`Could not load ${url}: ${res.status}`);
      return [];
    }
    const data = await res.json();
    return Array.isArray(data) ? data : [];
  } catch (e) {
    if (required) throw e;
    return []; // optional catalog absent/invalid — carry on with MIDI only
  }
}
