/*
 * remote-prefs.js — the phone's device-local prefs (localStorage "karaeoke.remote.v1"): the defaults
 * and how a saved copy is read back. Pure: the caller reads and writes localStorage.
 *
 * Lyric defaults (Rae, 2026-11-28: "default lyrics settings - scroll style and 6 lines"). The phone
 * saves the WHOLE object (joining a room saves the guest's name), so every phone that has ever saved
 * holds the old defaults — Stage, 4 lines — and they cannot be told apart from a guest's own choice.
 * A saved copy without the LYRIC_DEFAULTS_REV marker is therefore moved to the new defaults ONCE; the
 * marker is saved with it, so a later choice on the You tab sticks.
 */

/** Bump to move every saved phone to new lyric defaults once more. */
export const LYRIC_DEFAULTS_REV = 2;

export const DEFAULT_PREFS = Object.freeze({
  nickname: "", theme: "dark", text: "m", room: "", lyricNudgeMs: 0,
  lyricLines: 6,         // visible lyric lines on THIS phone, scroll style (the host keeps its own)
  lyricScale: 1,         // lyric text multiplier on THIS phone (0.7–1.8)
  lyricStyle: "scroll",  // "scroll" (the column) | "stage" (the videoke rows, as on the TV)
  namedRooms: Object.freeze([]),   // room codes whose name prompt this phone has answered (2026-11-25)
  lyricDefaults: LYRIC_DEFAULTS_REV,
});

/** A fresh, mutable copy of the defaults (its own namedRooms array). */
export function defaultPrefs() {
  return { ...DEFAULT_PREFS, namedRooms: [] };
}

/**
 * The prefs a phone starts with, from the saved JSON text (null, junk or a non-object → the
 * defaults). `migrated` = the saved copy was just moved to the current lyric defaults: save it.
 * Merged by spread (own data properties), so a saved "__proto__" key can never reach a prototype.
 * @param {string|null} saved
 * @returns {{ prefs: object, migrated: boolean }}
 */
export function readPrefs(saved) {
  let p = null;
  try { p = typeof saved === "string" ? JSON.parse(saved) : null; } catch { p = null; }
  let prefs = defaultPrefs();
  let migrated = false;
  if (p && typeof p === "object" && !Array.isArray(p)) {
    prefs = { ...prefs, ...p };
    if (!Array.isArray(prefs.namedRooms)) prefs.namedRooms = [];
    if (p.lyricDefaults !== LYRIC_DEFAULTS_REV) {
      prefs.lyricStyle = DEFAULT_PREFS.lyricStyle;
      prefs.lyricLines = DEFAULT_PREFS.lyricLines;
      prefs.lyricDefaults = LYRIC_DEFAULTS_REV;
      migrated = true;
    }
  }
  prefs.lyricStyle = prefs.lyricStyle === "stage" ? "stage" : "scroll";
  return { prefs, migrated };
}
