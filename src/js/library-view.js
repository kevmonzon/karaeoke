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
 */
import { jsonStore } from "./store.js";
import { Catalog, resolveSongRef, SOURCES, normalizeCode } from "./catalog.js";
import { orderNumberMatches, mergeTiers } from "./search-core.js";

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

  const lib = () => getLib();

  /** Every list goes through here, so a close tier still in flight knows it was overtaken. */
  function show(rows, empty, opts) {
    renderGen++;
    lib().renderList(rows, empty, opts);
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
  function renderSearchResults(query, ytRecords) {
    const tiers = searchTiers({ catalog, query, sources: SOURCES });
    const wanted = closeWanted(query, tiers);
    // A re-render of the same search (the YouTube append, a fuzzy toggle) reuses the close
    // tier it already has — re-asking would drop it for a frame and move the YouTube rows.
    if (wanted && lastClose && lastClose.query === query && lastClose.songs === catalog.songs) {
      showWithClose(tiers.rows, lastClose.close, ytRecords, query);
      return;
    }
    const asking = wanted && !!searchClient && searchClient.ready;
    // Nothing exact but close matches on the way: say so, rather than flash "No matches" first.
    const looking = asking && !tiers.rows.length && !(ytRecords && ytRecords.length);
    show(mergeSearchRows(tiers.rows, ytRecords), looking ? lookingHint(query) : emptyHint(query));
    if (!asking) return;
    return appendClose(renderGen, query, tiers.rows, ytRecords, looking);
  }

  function lookingHint(query) {
    return { title: `No exact matches for "${String(query).trim()}"`, hint: "Looking for close spellings…" };
  }

  function closeWanted(query, tiers) {
    const below = Number(typeof fuzzyBelow === "function" ? fuzzyBelow() : fuzzyBelow);
    return !!getFuzzy() && !tiers.numeric && String(query ?? "").trim() !== ""
      && tiers.rows.length < (Number.isFinite(below) ? below : DEFAULT_FUZZY_BELOW);
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

  async function appendClose(gen, query, rows, ytRecords, looking) {
    const songs = catalog.songs;       // the hits index THIS list; a reload during the wait drops them
    const at = songIndex();
    const exclude = [];
    for (const s of rows) { const i = at.get(s); if (i !== undefined) exclude.push(i); }
    let hits = null;
    try { hits = await searchClient.query(query, { exclude }); } catch (e) {
      console.error("Close-match search failed:", e);
    }
    // A newer render, or a reloaded catalogue, overtook this reply: the newer list stands.
    if (gen !== renderGen || catalog.songs !== songs) return;
    const close = [];
    if (hits) {                        // null = the client dropped it (a rebuild, a failed worker)
      for (const h of hits) { const s = songs[h.i]; if (s) close.push(s); }
      lastClose = { query, songs, close };
    }
    if (close.length) showWithClose(rows, close, ytRecords, query);
    else if (looking) show(mergeSearchRows(rows, ytRecords), emptyHint(query));   // nothing close after all
  }

  /** Exact rows, then the close rows (appended, never above), then YouTube; "≈" on the close ones. */
  function showWithClose(rows, close, ytRecords, query) {
    const merged = mergeTiers(rows, close);
    if (merged.length === rows.length) { show(mergeSearchRows(rows, ytRecords), emptyHint(query)); return; }
    show(mergeSearchRows(merged, ytRecords), emptyHint(query), { closeSet: new Set(merged.slice(rows.length)) });
  }

  function youtubeOn() { return settings.get("youtube.enabled") && youtubeSupported(); }

  /** After a long idle, query YouTube — but only when enabled and the local list came up
   *  short (< autoThreshold hits). Appends the results if the query is still the active one. */
  function scheduleYoutubeSearch(query) {
    clearTimeout(ytSearchTimer);
    if (!youtubeOn() || !query.trim()) return;
    ytSearchTimer = setTimeout(async () => {
      const threshold = settings.get("youtube.autoThreshold") || 2;
      // 11 = the ⚙ slider's max = "always" → skip the local-count gate and always query.
      if (threshold < 11 && catalog.search(query, threshold).length >= threshold) return;
      let recs = [];
      try { recs = await searchYoutube(query); } catch (_) { recs = []; }
      recs.forEach(registerYoutube);
      if ($("search").value !== query || recentMode || favoritesMode) return; // query moved on
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
      const songs = getRecentSongs();
      show(songs, { title: "Nothing played yet tonight", hint: "Songs you play show up here." });
      setStatus(songs.length ? `${songs.length} recently played` : "no recent songs yet");
    },
    showFavorites() {
      const songs = [...favorites].map((id) => catalog.getById(id)).filter(Boolean);
      show(songs, { title: "No favorites yet", hint: "Tap the ☆ on any song to keep it here." });
      setStatus(songs.length
        ? `${songs.length} favorite${songs.length === 1 ? "" : "s"}`
        : "no favorites yet — tap ☆ on a song");
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
    renderAll() { show(catalog.search(""), EMPTY_LIBRARY); },
    /** Row one of the list as it is rendered right now (what Enter in the search box takes). */
    topHit() {
      const list = (lib().getList && lib().getList()) || [];
      return list[0] || null;
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
