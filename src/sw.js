/*
 * sw.js — service worker that caches the app to the browser so repeat loads are
 * fast and work offline. Registered from index.html with scope "/". The app (src/) is
 * served at the site root, so this file lives at /sw.js and naturally controls the whole
 * origin (serve.py still sends `Service-Worker-Allowed: /`, now redundant but harmless).
 *
 * Strategy:
 *   - cache-first  for heavy, immutable assets: the vendored engine, worklets,
 *     workers, the 32 MB SoundFont, background videos, and played song files
 *     (they never change → serve from cache once fetched).
 *   - network-first for everything else (app code, catalog.json) so edits and
 *     catalog rebuilds are picked up, falling back to cache when offline.
 *
 * Bump CACHE to invalidate everything on a breaking change.
 */

const CACHE = "karaeoke-cache-v1";
const CACHE_FIRST = [
  /\/vendor\//,
  /\/js\/worklets\//,
  /\/js\/workers\//,
  /\.sf2$/,
  /\/bgv\//,
  /\/kar_raw\//,
];

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) =>
  e.waitUntil((async () => {
    // Drop any stale caches (e.g. a previous CACHE name) so a rename/bump doesn't
    // orphan the old ~32 MB soundfont cache.
    const names = await caches.keys();
    await Promise.all(names.filter((n) => n !== CACHE).map((n) => caches.delete(n)));
    await self.clients.claim();
  })())
);

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  // Range requests (video seeking) must go straight to the server for a 206 — the
  // Cache API can't store partials, so we don't intercept them at all.
  if (req.headers.has("range")) return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // don't touch cross-origin

  if (CACHE_FIRST.some((re) => re.test(url.pathname))) e.respondWith(cacheFirst(req));
  else e.respondWith(networkFirst(req));
});

async function cacheFirst(req) {
  const cache = await caches.open(CACHE);
  const hit = await cache.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  if (res.status === 200) cache.put(req, res.clone()); // never cache a 206 partial
  return res;
}

async function networkFirst(req) {
  const cache = await caches.open(CACHE);
  try {
    const res = await fetch(req);
    if (res.status === 200) cache.put(req, res.clone()); // never cache a 206 partial
    return res;
  } catch (err) {
    const hit = await cache.match(req);
    if (hit) return hit;
    throw err;
  }
}
