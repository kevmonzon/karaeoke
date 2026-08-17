/*
 * store.js — the localStorage layer, in one place.
 *
 * app.js had grown EIGHT persisted stores (settings, session, favorites, the ⚙ panel layout,
 * the remote room code, saved-YouTube pointers + blocklist, per-song bests, learned song
 * lengths, tonight's recap), each with its own hand-rolled
 * `try { JSON.parse(localStorage.getItem(k)) } catch {}` pair. Same five lines, ten times,
 * each an opportunity to forget the try (localStorage throws outright in some privacy modes,
 * and a full quota throws on write) or to mis-handle the null.
 *
 * `storage` is injectable so this is testable in node without a browser — which also means
 * the backup/restore logic, the one place a user's whole library state can be destroyed, is
 * covered by tests rather than by hope.
 */

/** Every key this app owns is namespaced. Backup and factory-reset both key off this. */
export const APP_PREFIX = "karaeoke.";

/** Version stamped into an export file, so a future format change can be detected. */
export const EXPORT_VERSION = 1;

const defaultStorage = () => {
  try { return globalThis.localStorage || null; } catch (_) { return null; }
};

/**
 * A tiny JSON-backed store. Every operation is failure-tolerant on purpose: persistence is a
 * convenience here, and no read or write of it should ever be able to break playback.
 *
 * @param {string} key       full localStorage key (must start with APP_PREFIX)
 * @param {*} fallback       returned when the key is missing or unreadable
 * @param {Storage} [storage]
 */
export function jsonStore(key, fallback = null, storage = undefined) {
  const get = () => (storage !== undefined ? storage : defaultStorage());
  return {
    key,
    read() {
      try {
        const raw = get()?.getItem(key);
        if (raw == null) return structuredCloneish(fallback);
        const v = JSON.parse(raw);
        return v === null || v === undefined ? structuredCloneish(fallback) : v;
      } catch (_) {
        return structuredCloneish(fallback);
      }
    },
    write(value) {
      try { get()?.setItem(key, JSON.stringify(value)); return true; } catch (_) { return false; }
    },
    remove() {
      try { get()?.removeItem(key); } catch (_) {}
    },
  };
}

/** Cheap deep copy for the fallback, so callers can't mutate a shared default into place. */
function structuredCloneish(v) {
  if (v === null || typeof v !== "object") return v;
  try { return JSON.parse(JSON.stringify(v)); } catch (_) { return Array.isArray(v) ? [] : {}; }
}

/** Every `karaeoke.*` key currently present. */
export function listAppKeys(storage = undefined) {
  const s = storage !== undefined ? storage : defaultStorage();
  const out = [];
  try {
    for (let i = 0; i < s.length; i++) {
      const k = s.key(i);
      if (k && k.startsWith(APP_PREFIX)) out.push(k);
    }
  } catch (_) {}
  return out;
}

/** Snapshot every app key as a portable object (the shape written to a backup file). */
export function collectAppData(storage = undefined) {
  const s = storage !== undefined ? storage : defaultStorage();
  const data = {};
  for (const k of listAppKeys(storage)) {
    try { data[k] = s.getItem(k); } catch (_) {}
  }
  return { app: "ka-rae-oke", version: EXPORT_VERSION, data };
}

/**
 * Restore a backup. Only `karaeoke.*` string entries are written, so a foreign or
 * hand-edited file can never reach any other state this origin keeps.
 * @returns {number} how many keys were restored
 * @throws if the payload isn't a recognisable backup
 */
export function restoreAppData(payload, storage = undefined) {
  const s = storage !== undefined ? storage : defaultStorage();
  const data = payload && payload.data;
  if (!data || typeof data !== "object") throw new Error("not a Ka-Rae-oke backup");
  const keys = Object.keys(data).filter((k) => k.startsWith(APP_PREFIX) && typeof data[k] === "string");
  if (!keys.length) throw new Error("no Ka-Rae-oke data in that file");
  for (const k of keys) {
    try { s.setItem(k, data[k]); } catch (_) {}
  }
  return keys.length;
}

/** Remove every app key — the localStorage half of the factory reset. */
export function clearAppData(storage = undefined) {
  const s = storage !== undefined ? storage : defaultStorage();
  const keys = listAppKeys(storage);
  for (const k of keys) {
    try { s.removeItem(k); } catch (_) {}
  }
  return keys.length;
}
