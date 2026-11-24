/*
 * library-view.js — what the song list is currently SHOWING, and everything that decides it.
 *
 * Search, Recent, Favorites and the YouTube append are one state machine, not four features:
 * the three views are mutually exclusive, typing leaves whichever is open, and a YouTube
 * result that lands after the query moved on must be dropped. Splitting them apart would mean
 * four modules reaching into each other's flags.
 *
 * The two flags are exposed as LIVE getters on purpose. A captured boolean fails silently here
 * — the wrong view refreshes and nothing throws — which is the worst kind of bug to inherit.
 *
 * A search result is up to three tiers in ONE list: the songs numbered exactly as typed (every
 * songbook), the exact matches Catalog.search gives today, then — a moment later, from the
 * search worker — close matches (typos), appended below and marked "≈". The close tier is a
 * reply that can arrive after the list moved on, so it carries the render it was asked for and
 * is dropped when any newer render happened, exactly like the YouTube append.
 *
 * M6 (browse): every song list on the All tab — the three tiers, the whole library, Favorites,
 * Recent — goes through the songbook / kind chips (applyFilters), and a non-Relevance sort orders
 * the merged tiers as ONE list (the "≈" marks are song objects, so they survive it). The Artists
 * tab is two more views of the same virtual list: the artist index (built lazily, cached per
 * catalogue array + chip set) and one artist's songs under a "← Artists" row. `view` says which
 * of those is showing ("songs" | "artists" | "artist" | "none" while the Rankings tab hides the
 * list); every list still goes through one render generation, so a late close-tier or YouTube
 * reply can never draw songs over the artist list.
 */
import { jsonStore } from "./store.js";
import { Catalog, resolveSongRef, SOURCES, normalizeCode } from "./catalog.js";
import { orderNumberMatches, mergeTiers, MAX_CLOSE } from "./search-core.js";
import { applyFilters, sortSongs, buildArtistIndex, songsByArtist, filterArtists, UNKNOWN_ARTIST, UNKNOWN_ARTIST_LABEL } from "./library-browse.js";
import { BACK_ROW } from "./library-ui.js";

export const FAVORITES_KEY = "karaeoke.favorites.v1";
export const YOUTUBE_KEY = "karaeoke.youtube.v1";
export const YOUTUBE_BLOCKED_KEY = "karaeoke.youtube.blocked.v1";

const $ = (id) => document.getElementById(id);

export const EMPTY_LIBRARY = {
  title: "No songs in the library yet",
  hint: "Drop .kar/.mid files into data/kar_raw/ (or videos into data/videos/), then ⚙ → Rebuild Catalog.",
};

/** Pure: local hits first, live YouTube results appended after them (never interleaved, so a
 *  network result can't push the song you were looking at down the list). */
export function mergeSearchRows(local, ytRecords) {
  const rows = Array.isArray(local) ? local : [];
  if (!ytRecords || !ytRecords.length) return rows;
  return [...rows, ...ytRecords];
}

/** Pure: the empty-state copy for a search that found nothing. */
export function emptyHint(query) {
  const q = (query || "").trim();
  return q
    ? { title: `No matches for "${q}"`, hint: "Try fewer words, or a dial number." }
    : EMPTY_LIBRARY;
}

/**
 * Pure: the tiers a query gets at once (the close tier comes later, from the search worker).
 * A digits-only query lists every song numbered exactly that — leading zeros ignored, every
 * songbook and kind, in songbook order — and then today's code-prefix matches, without
 * repeats. Anything else is exactly what Catalog.search returns, in its order.
 * @returns {{ rows: object[], numeric: boolean }}
 */
export function searchTiers({ catalog, query, sources = SOURCES }) {
  const q = String(query ?? "");
  if (/^\d+$/.test(q.trim())) {
    const exact = orderNumberMatches(catalog.lookupCode(normalizeCode(q), "all"), sources);
    return { rows: mergeTiers(exact, catalog.search(q)), numeric: true };
  }
  return { rows: catalog.search(q), numeric: false };
}

/**
 * Pure: what Enter in the search box does with the top hit. `enterAction` is the
 * search.enterAction setting: "now" always plays, "reserve" always queues, and "auto" (also
 * anything unknown) queues while a song is playing or loading (`busy`) and plays when idle —
 * so one mistyped number never cuts off the singer.
 * @returns {"play" | "reserve"}
 */
export function enterDecision(enterAction, busy) {
  if (enterAction === "now") return "play";
  if (enterAction === "reserve") return "reserve";
  return busy ? "reserve" : "play";
}

const DEFAULT_FUZZY_BELOW = 20;
// With a chip on, the close tier asks the index for more than it shows: the cap is applied AFTER
// the chips, or a songbook filter would throw away most of the 200 the index returns.
const WIDE_CLOSE = 1000;
const ALL_CACHE_MAX = 8;      // filtered / sorted whole-library lists kept (per catalogue array)
const ARTIST_CACHE_MAX = 4;   // artist indexes kept (per catalogue array), keyed by the chip set

const FILTERED_EMPTY = Object.freeze({ title: "No songs match these filters", hint: "Turn a chip off, or tap All." });

/** Pure: "1 song", "12,345 songs", "2 artists". */
export function countLabel(n, noun) {
  const k = Math.max(0, Number(n) || 0);
  return `${k.toLocaleString()} ${noun}${k === 1 ? "" : "s"}`;
}

/** A stable key for a chip set: the same chips in any order give the same key. "" = no filter. */
function filterKey({ sources, kinds } = {}) {
  const part = (set) => (set && set.size ? [...set].sort().join(",") : "");
  const s = part(sources), k = part(kinds);
  return s || k ? `${s}|${k}` : "";
}

/**
 * @param {object} deps
 * @param {Catalog} deps.catalog
 * @param {object}  deps.settings
 * @param {() => object} deps.getLib          library-ui, which is created after this module
 * @param {(msg:string)=>void} deps.setStatus
 * @param {() => boolean} deps.youtubeSupported
 * @param {() => string[]} deps.getQueueIds   LIVE — see persistYoutubeCache
 * @param {() => string[]} deps.getRecentIds  LIVE
 * @param {() => object[]} deps.getRecentSongs
 * @param {() => void} [deps.warmYoutube]
 * @param {{ready:boolean, query:Function}} [deps.searchClient]  the close-match index (search-client.js)
 * @param {() => boolean} [deps.getFuzzy]     LIVE: search.fuzzy
 * @param {number | (() => number)} [deps.fuzzyBelow]  close matches only while the exact list is shorter
 */
export function createLibraryView({
  catalog, settings, getLib, setStatus, youtubeSupported,
  getQueueIds, getRecentIds, getRecentSongs, warmYoutube = () => {}, storage,
  searchClient = null, getFuzzy = () => false, fuzzyBelow = DEFAULT_FUZZY_BELOW,
}) {
  const favoritesStore = jsonStore(FAVORITES_KEY, [], storage);
  const youtubeStore = jsonStore(YOUTUBE_KEY, {}, storage);
  const blockedStore = jsonStore(YOUTUBE_BLOCKED_KEY, [], storage);

  let recentMode = false;
  let favoritesMode = false;
  let favorites = new Set();          // starred song ids
  const youtubeCache = new Map();     // id → YouTube record (favorites/recent/queue resolution)
  const blocked = new Set();          // videoIds that failed to embed
  let ytSearchTimer = null;           // the (long) debounce before actually querying YouTube
  let renderGen = 0;                  // bumped by every list this module shows (stale-reply guard)
  let lastClose = null;               // { query, songs, close } — the last close tier, for re-renders
  let indexOf = null;                 // Map song → its index in catalog.songs (the worker's ids)
  let indexedSongs = null;            // …for this catalog.songs array (a reload replaces the array)

  // --- browse state (M6) — handed in by app.js (setBrowse) from the browse UI, never persisted ---
  let filters = { sources: new Set(), kinds: new Set() };   // empty Set = no filter on that axis
  let sortMode = "relevance";
  let view = "songs";                 // "songs" (All tab) | "artists" | "artist" (one artist) | "none"
  let artistFilter = "";              // the typed artist filter the artist list was drawn with
  let artistShown = null;             // the artist whose songs are showing (view "artist")
  const allCache = new Map();         // `${filterKey}#${sort}` → the whole library, filtered + sorted
  let allCacheSongs = null;           // …for this catalog.songs array
  const artistCache = new Map();      // filterKey → buildArtistIndex(the filtered library)
  let artistCacheSongs = null;        // …for this catalog.songs array

  const lib = () => getLib();
  const filtering = () => filterKey(filters) !== "";
  const sorting = () => !!sortMode && sortMode !== "relevance";
  // The chips. applyFilters returns the SAME array when nothing filters; skipping the call then is
  // the same answer for free.
  const narrow = (rows) => (filtering() ? applyFilters(rows, filters) : rows);
  const order = (rows) => (sorting() ? sortSongs(rows, sortMode) : rows);

  /** Every list goes through here, so a close tier still in flight knows it was overtaken. */
  function show(rows, empty, opts) {
    renderGen++;
    lib().renderList(rows, empty, opts);
  }

  /** The artist list and one artist's songs (renderRows), through the same render generation. */
  function showRows(items, opts) {
    renderGen++;
    lib().renderRows(items, opts);
  }

  /**
   * The whole library as the chips and the sort say — every song (catalog.songs), not the first
   * 100,000 that catalog.search("") returns (that cap hid every audio song, which sits at the end
   * of the array, so the Audio chip would have shown nothing). No chip and Relevance → the array
   * itself, no copy. Otherwise the filtered / sorted copy is cached per (catalog.songs, chip set,
   * sort): sorting 121k songs costs a few hundred ms once, then a chip toggle back is free.
   */
  function allSongs() {
    const songs = catalog.songs;
    if (!filtering() && !sorting()) return songs;
    if (allCacheSongs !== songs) { allCache.clear(); allCacheSongs = songs; }
    const key = `${filterKey(filters)}#${sorting() ? sortMode : "relevance"}`;
    let rows = allCache.get(key);
    if (rows) { allCache.delete(key); allCache.set(key, rows); return rows; }   // most recent last
    rows = order(narrow(songs));
    if (allCache.size >= ALL_CACHE_MAX) allCache.delete(allCache.keys().next().value);
    allCache.set(key, rows);
    return rows;
  }

  /** The artist index of the filtered library, built on first use, cached per (songs, chips). */
  function artistIndex() {
    const songs = catalog.songs;
    if (artistCacheSongs !== songs) { artistCache.clear(); artistCacheSongs = songs; }
    const key = filterKey(filters);
    let index = artistCache.get(key);
    if (index) return index;
    index = buildArtistIndex(narrow(songs));
    if (artistCache.size >= ARTIST_CACHE_MAX) artistCache.delete(artistCache.keys().next().value);
    artistCache.set(key, index);
    return index;
  }

  /** What an empty list says: the chips' fault when the unfiltered list had rows. */
  function emptyFor(query, unfiltered, rows) {
    if (!rows.length && filtering() && unfiltered && unfiltered.length) return FILTERED_EMPTY;
    return emptyHint(query);
  }

  // --- favorites ------------------------------------------------------------
  function loadFavorites() {
    const data = favoritesStore.read();
    const ids = (Array.isArray(data) ? data : [])
      .map((r) => resolveSongRef(catalog, r)).filter(Boolean).map((s) => s.id);
    favorites = new Set(ids);
  }
  function saveFavorites() {
    favoritesStore.write([...favorites]);
    persistYoutubeCache(); // a starred YouTube song must keep its pointer so it resolves on reload
  }

  // --- YouTube pointer cache ------------------------------------------------
  /** Register a YouTube record so catalog.getById() resolves it — WITHOUT adding it to the
   *  browse list. Used for live results and before persisting favorites/queue/recent. */
  function registerYoutube(rec) {
    if (!rec || rec.kind !== "youtube") return rec;
    youtubeCache.set(rec.id, rec);
    catalog.addExternal(rec);
    return rec;
  }

  /**
   * Persist only the YouTube records still referenced by a favorite, the queue or recents.
   *
   * The keep-set spans three owners, so the queue and recent ids MUST be read here, at call
   * time. Capturing them when this module was built would silently stop persisting whatever
   * was starred or queued afterwards — the song would simply fail to resolve after a reload.
   */
  function persistYoutubeCache() {
    const keep = new Set([...favorites, ...getQueueIds(), ...getRecentIds()]);
    const obj = {};
    for (const id of keep) {
      const rec = youtubeCache.get(id);
      if (rec && rec.kind === "youtube") obj[id] = rec;
    }
    youtubeStore.write(obj);
  }

  // --- rendering ------------------------------------------------------------
  /**
   * The number/exact tiers now, then (when the exact list is short) the close tier appended
   * once the search worker answers. YouTube rows always come last. Resolves when the close
   * step is settled; nothing awaits it in the app, so it never rejects.
   */
  function renderSearchResults(query, ytRecords, { announce = false } = {}) {
    view = "songs";
    // YouTube rows have no songbook and no library kind: any chip drops them (applyFilters).
    const yt = ytRecords && ytRecords.length ? narrow(ytRecords) : ytRecords;
    // The empty query is the whole library (filtered + sorted, cached) — no tiers to compute.
    if (!String(query ?? "").trim()) {
      const rows = allSongs();
      show(mergeSearchRows(rows, yt), emptyFor("", catalog.songs, rows));   // emptyHint("") = EMPTY_LIBRARY
      if (announce) say(rows.length);
      return;
    }
    const tiers = searchTiers({ catalog, query, sources: SOURCES });
    const rows = order(narrow(tiers.rows));
    const wanted = closeWanted(query, tiers, rows);
    // A re-render of the same search (the YouTube append, a fuzzy toggle, a chip) reuses the close
    // tier it already has — re-asking would drop it for a frame and move the YouTube rows. A tier
    // asked for without chips is too narrow to reuse once a chip is on (see WIDE_CLOSE).
    if (wanted && lastClose && lastClose.query === query && lastClose.songs === catalog.songs
        && (lastClose.wide || !filtering())) {
      showWithClose(rows, lastClose.close, yt, query, announce);
      return;
    }
    const asking = wanted && !!searchClient && searchClient.ready;
    // Nothing exact but close matches on the way: say so, rather than flash "No matches" first.
    const looking = asking && !rows.length && !(yt && yt.length);
    show(mergeSearchRows(rows, yt), looking ? lookingHint(query, tiers.rows) : emptyFor(query, tiers.rows, rows));
    if (announce) say(rows.length);
    if (!asking) return;
    return appendClose(renderGen, query, tiers.rows, rows, yt, looking, announce);
  }

  /** The status line's count for a list a browse control just changed. */
  function say(n, noun = "song") { setStatus(countLabel(n, noun)); }

  // `exact` = the exact tier before the chips: when it had rows, the chips emptied the list.
  function lookingHint(query, exact = []) {
    const title = filtering() && exact.length
      ? "No songs match these filters"
      : `No exact matches for "${String(query).trim()}"`;
    return { title, hint: "Looking for close spellings…" };
  }

  // `rows` = the exact tier as SHOWN (after the chips): a songbook chip that leaves three exact
  // rows on screen wants the close tier as much as a query that only found three.
  function closeWanted(query, tiers, rows = tiers.rows) {
    const below = Number(typeof fuzzyBelow === "function" ? fuzzyBelow() : fuzzyBelow);
    return !!getFuzzy() && !tiers.numeric && String(query ?? "").trim() !== ""
      && rows.length < (Number.isFinite(below) ? below : DEFAULT_FUZZY_BELOW);
  }

  /** catalog.songs index of each song — what the worker's hits and `exclude` speak in. */
  function songIndex() {
    if (indexedSongs !== catalog.songs) {
      indexedSongs = catalog.songs;
      indexOf = new Map();
      indexedSongs.forEach((s, i) => indexOf.set(s, i));
    }
    return indexOf;
  }

  // `exact` = the exact tier before the chips (what the index must skip, by catalogue index);
  // `rows` = the exact tier as shown (filtered, sorted).
  async function appendClose(gen, query, exact, rows, ytRecords, looking, announce) {
    const songs = catalog.songs;       // the hits index THIS list; a reload during the wait drops them
    const at = songIndex();
    const exclude = [];
    for (const s of exact) { const i = at.get(s); if (i !== undefined) exclude.push(i); }
    const wide = filtering();
    let hits = null;
    try { hits = await searchClient.query(query, wide ? { exclude, limit: WIDE_CLOSE } : { exclude }); } catch (e) {
      console.error("Close-match search failed:", e);
    }
    // A newer render (a keystroke, a chip, a sort, another tab), or a reloaded catalogue,
    // overtook this reply: the newer list stands.
    if (gen !== renderGen || catalog.songs !== songs) return;
    const close = [];
    if (hits) {                        // null = the client dropped it (a rebuild, a failed worker)
      for (const h of hits) { const s = songs[h.i]; if (s) close.push(s); }
      lastClose = { query, songs, close, wide };
    }
    if (close.length) showWithClose(rows, close, ytRecords, query, announce);
    else if (looking) show(mergeSearchRows(rows, ytRecords), emptyFor(query, exact, rows));   // nothing close after all
  }

  /**
   * Exact rows, then the close rows, then YouTube; "≈" on the close ones. Relevance: the close
   * rows are appended, never above. Another sort: exact + close are sorted as ONE list — the
   * closeSet holds the song objects, so the marks follow their rows.
   */
  function showWithClose(rows, close, ytRecords, query, announce = false) {
    const merged = mergeTiers(rows, narrow(close));
    if (merged.length === rows.length) {
      show(mergeSearchRows(rows, ytRecords), emptyFor(query, close, rows));   // the chips may have emptied it
      if (announce) say(rows.length);
      return;
    }
    const extra = merged.slice(rows.length, rows.length + MAX_CLOSE);   // the cap, after the chips
    const local = sorting() ? sortSongs(rows.concat(extra), sortMode) : rows.concat(extra);
    show(mergeSearchRows(local, ytRecords), emptyHint(query), { closeSet: new Set(extra) });
    if (announce) say(local.length);
  }

  function youtubeOn() { return settings.get("youtube.enabled") && youtubeSupported(); }

  /** After a long idle, query YouTube — but only when enabled and the local list came up
   *  short (< autoThreshold hits). Appends the results if the query is still the active one. */
  function scheduleYoutubeSearch(query) {
    clearTimeout(ytSearchTimer);
    if (!youtubeOn() || !query.trim()) return;
    ytSearchTimer = setTimeout(async () => {
      // A chip on drops every YouTube row (no songbook, not a library kind): don't ask for them.
      if (view !== "songs" || filtering()) return;
      const threshold = settings.get("youtube.autoThreshold") || 2;
      // 11 = the ⚙ slider's max = "always" → skip the local-count gate and always query.
      if (threshold < 11 && catalog.search(query, threshold).length >= threshold) return;
      let recs = [];
      try { recs = await searchYoutube(query); } catch (_) { recs = []; }
      recs.forEach(registerYoutube);
      // The query moved on, or the list is showing something else now (Recent, Favorites, the
      // Artists or Rankings tab): the answer is dropped.
      if ($("search").value !== query || recentMode || favoritesMode || view !== "songs") return;
      renderSearchResults(query, recs);
    }, settings.get("youtube.debounceMs") || 3000);
  }

  /** POST the query to serve.py's keyless-scrape proxy → transient YouTube records. The
   *  configured keyword (default "karaoke") is appended so YouTube filters to karaoke versions
   *  server-side — e.g. "tetoris" → "tetoris karaoke". */
  async function searchYoutube(query) {
    const url = settings.get("youtube.searchUrl") || "/api/youtube-search";
    const keyword = (settings.get("youtube.keyword") || "").trim();
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ q: keyword ? `${query} ${keyword}` : query, maxResults: settings.get("youtube.maxResults") }),
    });
    const data = await res.json();
    return ((data && data.items) || [])
      .map((it) => Catalog.makeYoutubeRecord(it))
      .filter((r) => r && !blocked.has(r.videoId)); // hide videos that already failed to embed
  }

  /** Push un-embeddable videoIds to the server's shared blocklist (fire-and-forget). The
   *  server filters them from /api/youtube-search for everyone. */
  function reportBlockedToServer(ids) {
    if (!ids || !ids.length) return;
    const url = settings.get("youtube.blockUrl") || "/api/youtube-block";
    try {
      fetch(url, { method: "POST", headers: { "Content-Type": "application/json" },
                   body: JSON.stringify({ videoIds: ids }) }).catch(() => {});
    } catch (_) {}
  }

  return {
    // --- view flags: LIVE getters, never captured copies ---
    get recentMode() { return recentMode; },
    get favoritesMode() { return favoritesMode; },
    get blockedCount() { return blocked.size; },
    /** "songs" (the All tab) | "artists" (the artist list) | "artist" (one artist's songs) | "none". */
    get view() { return view; },
    /** The artist key whose songs are showing (view "artist"), else null. */
    get artistShown() { return view === "artist" ? artistShown : null; },

    // --- boot ---
    loadFavorites,
    loadYoutubeCache() {
      const data = youtubeStore.read();
      if (data && typeof data === "object") {
        for (const rec of Object.values(data)) {
          if (rec && rec.id && rec.kind === "youtube") registerYoutube(rec);
        }
      }
    },
    loadBlocked() {
      const a = blockedStore.read();
      if (Array.isArray(a)) a.forEach((id) => id && blocked.add(id));
    },
    /** Seed the server's shared blocklist from this browser's, once at boot. */
    seedServerBlocklist() {
      if (youtubeOn() && blocked.size) reportBlockedToServer([...blocked]);
    },

    // --- favorites ---
    isFavorite(song) { return !!song && favorites.has(song.id); },
    toggleFavorite(song) {
      if (!song) return;
      if (favorites.has(song.id)) favorites.delete(song.id);
      else favorites.add(song.id);
      saveFavorites();
      if (favoritesMode) this.showFavorites();  // in the Favorites view, un-starring drops the row
      else lib().refresh();                     // otherwise just repaint the star in place
    },
    persistYoutubeCache,
    registerYoutube,

    // --- the three views ---
    setRecentMode(on) {
      recentMode = on;
      $("btn-recent").classList.toggle("active", on);
      if (on && favoritesMode) this.setFavoritesMode(false); // the views are mutually exclusive
    },
    setFavoritesMode(on) {
      favoritesMode = on;
      $("btn-favorites").classList.toggle("active", on);
      if (on && recentMode) this.setRecentMode(false);
    },
    showRecent() {
      view = "songs";
      const all = getRecentSongs();
      const songs = order(narrow(all));      // the chips and the sort apply here too (M6)
      show(songs, all.length && !songs.length
        ? emptyFor("", all, songs)
        : { title: "Nothing played yet tonight", hint: "Songs you play show up here." });
      setStatus(songs.length ? `${songs.length} recently played` : (all.length ? "no recent songs match the filters" : "no recent songs yet"));
    },
    showFavorites() {
      view = "songs";
      const all = [...favorites].map((id) => catalog.getById(id)).filter(Boolean);
      const songs = order(narrow(all));
      show(songs, all.length && !songs.length
        ? emptyFor("", all, songs)
        : { title: "No favorites yet", hint: "Tap the ☆ on any song to keep it here." });
      setStatus(songs.length
        ? `${songs.length} favorite${songs.length === 1 ? "" : "s"}`
        : (all.length ? "no favorites match the filters" : "no favorites yet — tap ☆ on a song"));
    },
    /** Leave Recent/Favorites if either is open. True when one actually closed. */
    leaveSpecialViews() {
      const was = recentMode || favoritesMode;
      if (recentMode) this.setRecentMode(false);
      if (favoritesMode) this.setFavoritesMode(false);
      return was;
    },

    // --- search ---
    renderSearchResults,
    /** Instant local results + a scheduled YouTube append. */
    runSearch(query) {
      renderSearchResults(query, null);
      scheduleYoutubeSearch(query);
    },
    scheduleYoutubeSearch,
    cancelYoutubeSearch() { clearTimeout(ytSearchTimer); },
    /** The whole library, through the chips and the sort (see allSongs). */
    renderAll() { renderSearchResults("", null); },
    /**
     * The first SONG of the list as it is rendered right now (what Enter in the search box
     * takes): the "← Artists" row is skipped, and the artist list has no song to take (null).
     */
    topHit() {
      if (view === "artists") return null;
      const list = (lib().getList && lib().getList()) || [];
      const first = list[0] && list[0].key === BACK_ROW ? list[1] : list[0];   // a back row only ever heads a list
      return first || null;
    },

    // --- browse (M6) ---
    /**
     * The browse controls' state, at call time (app.js passes the browse UI's values; nothing
     * here reads them back later). Partial: a missing field keeps its value. Nothing re-renders:
     * the caller follows with rerender().
     * @param {{filters?: {sources?: Set<string>, kinds?: Set<string>}, sort?: string}} b
     */
    setBrowse({ filters: f, sort } = {}) {
      if (f) filters = { sources: new Set(f.sources || []), kinds: new Set(f.kinds || []) };
      if (sort != null) sortMode = String(sort);
    },
    /**
     * Draw the ACTIVE view again (the chips or the sort changed, the catalogue was rebuilt): the
     * artist list, one artist's songs, Recent, Favorites, or the search for `query`. The count
     * goes to the status line.
     */
    rerender(query = "") {
      switch (view) {
        case "artists": return this.showArtists(artistFilter);
        case "artist": return this.showArtistSongs(artistShown);
        case "none": return undefined;
        default:
          if (recentMode) return this.showRecent();
          if (favoritesMode) return this.showFavorites();
          return renderSearchResults(query, null, { announce: true });
      }
    },
    /** The All tab: Recent or Favorites if one is on, else the search for `query` (+ YouTube). */
    showAll(query = "") {
      view = "songs";
      if (recentMode) return this.showRecent();
      if (favoritesMode) return this.showFavorites();
      const done = renderSearchResults(query, null, { announce: true });
      scheduleYoutubeSearch(String(query ?? ""));
      return done;
    },
    /**
     * The Artists tab: the artist index of the filtered library (built on first use), narrowed by
     * `filterText` (every word in the folded name). Returns the items shown.
     */
    showArtists(filterText = "") {
      clearTimeout(ytSearchTimer);
      view = "artists";
      artistShown = null;
      artistFilter = String(filterText ?? "");
      const index = artistIndex();
      const items = filterArtists(index, artistFilter);
      const q = artistFilter.trim();
      showRows(items, {
        rowKind: "artist",
        empty: q
          ? { title: `No artists match "${q}"`, hint: "Try fewer letters, or clear the search." }
          : (index.length || !filtering()
            ? { title: "No artists yet", hint: EMPTY_LIBRARY.hint }
            : { title: "No artists match these filters", hint: FILTERED_EMPTY.hint }),
      });
      say(items.length, "artist");
      return items;
    },
    /**
     * One artist's songs (through the chips, and the sort when it is not Relevance) under a
     * "← Artists" row at index 0 — a song list whose first item is the BACK_ROW.
     */
    showArtistSongs(key) {
      clearTimeout(ytSearchTimer);
      const every = songsByArtist(catalog.songs, key);           // by title already
      const songs = narrow(every);
      const rows = sorting() ? sortSongs(songs, sortMode) : songs;
      // The index's spelling of the name; a chip can drop the artist from the filtered index,
      // so fall back to the label / the first song's own spelling.
      const entry = artistIndex().find((a) => a.key === key);
      const name = entry ? entry.name
        : key === UNKNOWN_ARTIST ? UNKNOWN_ARTIST_LABEL
          : (every[0] && every[0].artistName) || "";
      view = "artist";
      artistShown = key;
      showRows([{ key: BACK_ROW, name: "← Artists", artist: name, count: rows.length }, ...rows], { rowKind: "song" });
      setStatus(name ? `${name}: ${countLabel(rows.length, "song")}` : countLabel(rows.length, "song"));
      return rows;
    },
    /** The first artist of the artist list as shown (Enter in the search field), else null. */
    topArtist() {
      if (view !== "artists") return null;
      const list = (lib().getList && lib().getList()) || [];
      return list[0] && list[0].key != null ? list[0] : null;
    },
    /** The Rankings tab hides the list: nothing late may draw into it (a close tier, YouTube). */
    showNone() {
      clearTimeout(ytSearchTimer);
      view = "none";
      renderGen++;
    },
    renderCatalogError() {
      show([], {
        title: "Couldn't load the song catalog",
        hint: "Is the server running? Start it with: python tools/serve.py",
      });
    },

    // --- YouTube failures ---
    youtubeOn,
    isBlocked(videoId) { return blocked.has(videoId); },
    blockYoutube(videoId) {
      if (!videoId || blocked.has(videoId)) return;
      blocked.add(videoId);
      blockedStore.write([...blocked]);
      reportBlockedToServer([videoId]); // share it so every user's results omit it too
    },
    /** The next kind:"youtube" record after `song` in the CURRENTLY-RENDERED list, skipping any
     *  already blocked. null if there isn't one. */
    nextYoutubeInList(song) {
      const list = (lib().getList && lib().getList()) || [];
      const i = list.findIndex((s) => s.id === song.id);
      if (i < 0) return null;
      for (let j = i + 1; j < list.length; j++) {
        const s = list[j];
        if (s.kind === "youtube" && !blocked.has(s.videoId)) return s;
      }
      return null;
    },

    /** Reflect the 🌐 pill's on/off/unsupported state (and keep the ⚙ checkbox in step). */
    updateYoutubeToggle() {
      const b = $("btn-youtube");
      if (b) {
        const supported = youtubeSupported();
        b.classList.toggle("active", youtubeOn());
        b.disabled = !supported;
        b.title = !supported
          ? "YouTube search needs a Chromium-based browser (credentialless iframes)"
          : (settings.get("youtube.enabled")
              ? "YouTube search ON — searches also query YouTube"
              : "Search YouTube for karaoke videos");
      }
      const chk = $("set-youtube");
      if (chk) chk.checked = settings.get("youtube.enabled");
      // preload the YT IFrame API while enabled so the first play can autoplay
      if (youtubeOn()) warmYoutube();
    },
  };
}
