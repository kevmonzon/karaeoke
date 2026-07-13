/*
 * settings.js — runtime settings = DEFAULT_CONFIG (config.js) merged with the
 * user's saved overrides (localStorage). Provides dot-path get/set, persistence,
 * reset, and change notifications.
 */

import { DEFAULT_CONFIG } from "../config.js";

const STORAGE_KEY = "karaeoke.settings.v1";

function clone(o) {
  return JSON.parse(JSON.stringify(o));
}

// deep-merge src over a clone of base (objects only; arrays/scalars replace)
function deepMerge(base, src) {
  const out = clone(base);
  if (!src || typeof src !== "object") return out;
  for (const k of Object.keys(src)) {
    if (
      src[k] && typeof src[k] === "object" && !Array.isArray(src[k]) &&
      out[k] && typeof out[k] === "object" && !Array.isArray(out[k])
    ) {
      out[k] = deepMerge(out[k], src[k]);
    } else {
      out[k] = src[k];
    }
  }
  return out;
}

export class Settings {
  constructor() {
    let saved = null;
    try {
      saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || "null");
    } catch (_) {}
    this.data = deepMerge(DEFAULT_CONFIG, saved);
    this._listeners = [];
  }

  get(path) {
    return path.split(".").reduce((o, k) => (o == null ? o : o[k]), this.data);
  }

  set(path, value, { silent = false } = {}) {
    const keys = path.split(".");
    let node = this.data;
    for (let i = 0; i < keys.length - 1; i++) {
      node[keys[i]] = node[keys[i]] ?? {};
      node = node[keys[i]];
    }
    node[keys[keys.length - 1]] = value;
    this.save();
    if (!silent) this._emit(path, value);
  }

  save() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.data));
    } catch (_) {}
  }

  reset() {
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch (_) {}
    this.data = clone(DEFAULT_CONFIG);
    this._emit("*", this.data);
  }

  /** fn(path, value, allData) — called on every change; "*" path on reset. */
  onChange(fn) {
    this._listeners.push(fn);
  }

  _emit(path, value) {
    for (const fn of this._listeners) {
      try { fn(path, value, this.data); } catch (e) { console.error(e); }
    }
  }
}
