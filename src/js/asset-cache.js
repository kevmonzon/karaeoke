/*
 * asset-cache.js — page-side Cache Storage for the two heavy, immutable binaries:
 * the SoundFont (~32 MB) and the song files (kar_raw/*.mid). This deliberately runs
 * from the PAGE, not a service worker: the app never caches its own HTML / JS /
 * catalog, so it can never serve stale, mismatched app code (the failure that made
 * us pull the old caching service worker). Only these fixed binaries are stored, and
 * they're immutable per URL, so cache-first is always safe.
 *
 * The Cache API is available in any secure context (localhost qualifies), and it
 * ignores HTTP `Cache-Control` on match — a stored entry is returned as-is — which
 * is exactly the cache-first behaviour we want, and why it beats the browser's HTTP
 * cache here (serve.py sends `Cache-Control: no-cache`).
 */

const ASSET_CACHE = "karaeoke-assets-v1";
const supported = typeof caches !== "undefined";

/*
 * BUDGET + LRU. Cache Storage keeps no access times and enforces no size of its own, so every
 * song ever played used to accumulate for the life of the browser profile. When the origin
 * quota was finally hit, `cache.put` rejected, the rejection was swallowed, and caching simply
 * stopped working — silently. Nobody learns why the app "feels slower now".
 *
 * So we keep our own tiny manifest (url → {size, at}) in localStorage and evict the
 * least-recently-USED entries when the budget is exceeded. The soundfont is pinned: it is the
 * single most expensive thing to re-download and it is needed by every MIDI song.
 */
const MANIFEST_KEY = "karaeoke.assets.v1";
const BUDGET_BYTES = 512 * 1024 * 1024;   // generous — a long night of songs plus the soundfont
const PINNED = /soundfont\.sf2$/i;

let manifest = null;      // { [url]: { size, at } }
let quotaExceeded = false; // surfaced in ⚙ → Library; see getCacheStatus()

function loadManifest() {
  if (manifest) return manifest;
  try {
    const m = JSON.parse(localStorage.getItem(MANIFEST_KEY) || "{}");
    manifest = m && typeof m === "object" ? m : {};
  } catch (_) { manifest = {}; }
  return manifest;
}
function saveManifest() {
  try { localStorage.setItem(MANIFEST_KEY, JSON.stringify(manifest)); } catch (_) {}
}
function touch(url, size) {
  const m = loadManifest();
  m[url] = { size: size || (m[url] && m[url].size) || 0, at: Date.now() };
  saveManifest();
}

/** Evict least-recently-used entries until the manifest fits the budget (soundfont pinned). */
async function enforceBudget(cache) {
  const m = loadManifest();
  const entries = Object.entries(m);
  let total = entries.reduce((n, [, v]) => n + (v.size || 0), 0);
  if (total <= BUDGET_BYTES) return;
  const evictable = entries
    .filter(([url]) => !PINNED.test(url))
    .sort((a, b) => (a[1].at || 0) - (b[1].at || 0));   // oldest touch first
  for (const [url, v] of evictable) {
    if (total <= BUDGET_BYTES) break;
    try { await cache.delete(url); } catch (_) {}
    delete m[url];
    total -= v.size || 0;
  }
  saveManifest();
}

/**
 * What the UI can tell the user about caching. `quotaExceeded` means the browser refused to
 * store something — repeat plays will re-download until space is freed.
 */
export function getCacheStatus() {
  const m = loadManifest();
  const entries = Object.values(m);
  return {
    supported,
    quotaExceeded,
    files: entries.length,
    bytes: entries.reduce((n, v) => n + (v.size || 0), 0),
    budget: BUDGET_BYTES,
  };
}

/**
 * Cache-first ArrayBuffer fetch.
 *   - hit  → returns the cached bytes instantly (no network).
 *   - miss → streams from the network (calling onProgress(frac) for a progress bar),
 *            stores a copy, and returns the bytes.
 * onProgress(frac) matches the old audio.js fetchBuffer signature (0..1 fraction).
 * Any Cache API failure (private mode, quota) degrades to a plain streamed fetch.
 */
export async function cachedArrayBuffer(url, onProgress = () => {}) {
  if (supported) {
    try {
      const cache = await caches.open(ASSET_CACHE);
      const hit = await cache.match(url);
      if (hit) {
        onProgress(1); // instant — complete any progress bar
        const buf = await hit.arrayBuffer();
        touch(url, buf.byteLength);   // a play is a USE — that's what LRU has to know
        return buf;
      }
      const buf = await streamToBuffer(url, onProgress);
      // Store a fresh copy (slice() so we hand back our own buffer untouched).
      try {
        await cache.put(url, new Response(buf.slice(0)));
        touch(url, buf.byteLength);
        await enforceBudget(cache);
      } catch (e) {
        // Almost always QuotaExceededError. Recorded rather than swallowed: silent failure
        // here is indistinguishable from "the app got slower for no reason".
        quotaExceeded = true;
        console.warn("Asset cache write failed (quota?):", e && e.name);
      }
      return buf;
    } catch (_) {
      // Cache unavailable — fall through to a direct fetch.
    }
  }
  return await streamToBuffer(url, onProgress);
}

/**
 * Delete every cache that isn't our current one. Sweeps the old service-worker
 * cache (`karaeoke-cache-v1`) and any bumped asset-cache versions. Runs once;
 * safe to call on every boot. Never touches the current ASSET_CACHE.
 */
let purged = false;
export async function purgeStaleCaches() {
  if (!supported || purged) return;
  purged = true;
  try {
    const names = await caches.keys();
    await Promise.all(
      names.filter((n) => n !== ASSET_CACHE).map((n) => caches.delete(n))
    );
  } catch (_) {}
}

/**
 * Delete EVERY Cache Storage cache, including the current asset cache — used by the
 * full "Erase all app data" factory reset (unlike purgeStaleCaches, which spares the
 * asset cache). The ~32 MB soundfont + cached songs re-download on next play.
 */
export async function purgeAllCaches() {
  manifest = {};
  quotaExceeded = false;
  try { localStorage.removeItem(MANIFEST_KEY); } catch (_) {}
  if (!supported) return;
  try {
    const names = await caches.keys();
    await Promise.all(names.map((n) => caches.delete(n)));
  } catch (_) {}
}

/** fetch() → ArrayBuffer, streaming with Content-Length progress when available. */
async function streamToBuffer(url, onProgress) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Fetch failed ${res.status} for ${url}`);
  const total = +res.headers.get("content-length") || 0;
  if (!res.body || !total) return await res.arrayBuffer();

  const reader = res.body.getReader();
  const chunks = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.length;
    onProgress(received / total);
  }
  const out = new Uint8Array(received);
  let off = 0;
  for (const c of chunks) { out.set(c, off); off += c.length; }
  return out.buffer;
}
