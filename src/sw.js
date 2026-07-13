/*
 * sw.js — SELF-DESTRUCTING STUB (the caching service worker was removed).
 *
 * A previously-shipped caching SW served stale/incompatible app code out of the
 * Cache API and crashed the site. Simply deleting this file would NOT rescue any
 * browser that already had the old worker installed — that worker keeps running
 * and keeps serving its cache until something replaces it. So this stub stays in
 * place as the replacement: when an infected browser does its routine sw.js
 * update check, it fetches THIS file, installs it, and on activation the worker
 * wipes every cache, unregisters itself, and reloads its controlled tabs.
 *
 * It intercepts nothing — all fetches go straight to the network.
 *
 * Once you're confident no clients are still running the old worker, this file
 * can be deleted outright.
 */

self.addEventListener("install", () => self.skipWaiting());

self.addEventListener("activate", (e) =>
  e.waitUntil((async () => {
    // 1. Purge every cache this origin ever created (incl. the old karaeoke-cache-v1).
    const names = await caches.keys();
    await Promise.all(names.map((n) => caches.delete(n)));
    // 2. Remove this worker so nothing controls the origin anymore.
    await self.registration.unregister();
    // 3. Reload the tabs we were controlling so they run fresh, uncached code.
    const clients = await self.clients.matchAll({ type: "window" });
    for (const client of clients) {
      client.navigate(client.url);
    }
  })())
);

// Do not intercept fetches — pass everything through to the network.
