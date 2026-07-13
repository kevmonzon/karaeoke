/*
 * catalog.js — loads the song library and provides search/lookup.
 *
 * Two sources are merged into one list:
 *   /catalog.json        → MIDI/KAR songs   (tagged kind:"midi")
 *   /catalog-video.json  → video songs      (tagged kind:"video", may be absent)
 * Each record has the catalog schema + a `file` path, and gets:
 *   { code, name, artistName, langName, type, file, kind, id }
 * where `id = `${kind}:${code}`` — a stable identity so a MIDI song and a video
 * song that happen to share a dial `code` never clobber one another.
 */

export class Catalog {
  constructor() {
    this.songs = [];
    this.byCode = new Map(); // code → first matching record (numeric search / Enter)
    this.byId = new Map();   // `${kind}:${code}` → record (unambiguous identity)
  }

  /**
   * Load and merge the MIDI catalog and (if present) the video catalog.
   * The video catalog is optional: a 404 or parse error is non-fatal.
   * @returns total number of songs loaded.
   */
  async load(midiUrl = "/catalog.json", videoUrl = "/catalog-video.json") {
    const midi = await fetchArray(midiUrl, /*required*/ true);
    const video = await fetchArray(videoUrl, /*required*/ false);

    this.songs = [
      ...midi.map((s) => tag(s, "midi")),
      ...video.map((s) => tag(s, "video")),
    ];

    this.byCode.clear();
    this.byId.clear();
    for (const s of this.songs) {
      this.byId.set(s.id, s);
      // Blank codes (untitled drop-in videos) aren't dialable — keep them out of byCode.
      const codeKey = String(s.code);
      if (codeKey && !this.byCode.has(codeKey)) this.byCode.set(codeKey, s);
    }
    return this.songs.length;
  }

  /** Look up by dial code (first match; MIDI wins on a collision). */
  get(code) { return this.byCode.get(String(code)); }

  /** Look up by stable id (`${kind}:${code}`) — unambiguous across KAR/VID. */
  getById(id) { return this.byId.get(String(id)); }

  /**
   * Search by code (exact prefix) or title/artist/lang substring.
   * The list UI is virtualized, so the default cap is high (return all matches);
   * callers that only want the top hit pass `limit = 1`.
   */
  search(query, limit = 100000) {
    const q = query.trim().toLowerCase();
    if (!q) return this.songs.slice(0, limit);

    const isNumeric = /^\d+$/.test(q);
    const out = [];
    for (const s of this.songs) {
      let hit;
      if (isNumeric) {
        hit = String(s.code).startsWith(q);
      } else {
        hit =
          (s.name && s.name.toLowerCase().includes(q)) ||
          (s.artistName && s.artistName.toLowerCase().includes(q)) ||
          (s.langName && s.langName.toLowerCase().includes(q));
      }
      if (hit) {
        out.push(s);
        if (out.length >= limit) break;
      }
    }
    return out;
  }

  /** Build a fetchable URL for a song's local file (paths may contain spaces). */
  static fileUrl(song) {
    if (!song || !song.file) return null;
    return "/" + song.file.split("/").map(encodeURIComponent).join("/");
  }
}

/** Tag a raw catalog record with its kind + stable id (returns the same object).
 *  A blank code (an untitled drop-in video) can't identify the record, so we key the
 *  id on the file path instead — otherwise every code-less video collapses to the
 *  same id and they clobber each other in the list / queue / session. */
function tag(song, kind) {
  song.kind = kind;
  const key = (song.code === "" || song.code == null) ? (song.file || song.name) : song.code;
  song.id = `${kind}:${key}`;
  return song;
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
