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
 */
import { jsonStore } from "./store.js";
import { Catalog, resolveSongRef } from "./catalog.js";

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
 */
export function createLibraryView({
  catalog, settings, getLib, setStatus, youtubeSupported,
  getQueueIds, getRecentIds, getRecentSongs, warmYoutube = () => {}, storage,
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

  const lib = () => getLib();

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
  function renderSearchResults(query, ytRecords) {
    lib().renderList(mergeSearchRows(catalog.search(query), ytRecords), emptyHint(query));
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
      lib().renderList(songs, { title: "Nothing played yet tonight", hint: "Songs you play show up here." });
      setStatus(songs.length ? `${songs.length} recently played` : "no recent songs yet");
    },
    showFavorites() {
      const songs = [...favorites].map((id) => catalog.getById(id)).filter(Boolean);
      lib().renderList(songs, { title: "No favorites yet", hint: "Tap the ☆ on any song to keep it here." });
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
    renderAll() { lib().renderList(catalog.search(""), EMPTY_LIBRARY); },
    renderCatalogError() {
      lib().renderList([], {
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
