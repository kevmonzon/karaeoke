/*
 * compact-catalog.js — the phone's catalogue: GET /api/catalog/compact decoded into song records
 * that catalog.js `adopt()` can index (M7, plan §5.13).
 *
 * Contract written by the orchestrator; the exports, names and signatures are the contract.
 *
 * The body (tools/serve.py `_compact_rows`, M1): { v: 1, rev?, sources: [...], kinds: ["midi","video",
 * "audio"], langs: [...], cols: ["code","name","artist","source","kind","lang"], rows: [[code, name,
 * artist, sourceIdx, kindIdx, langIdx], …] }. Row i is the HOST's catalog.songs[i] (same order), which
 * is why a phone can name a song to the host as ref { i, code } (the host checks the code).
 *
 * Pure apart from loadCompact's fetch. ~124k rows decode in one pass with no per-row allocation
 * beyond the record itself (the dictionaries are looked up, never copied).
 */

/**
 * rows → [{ i, code, name, artistName, source, kind, langName, type: "", id: `c:${i}`, _search }]
 *   source = sources[row[3]] ?? "" (an unknown index → ""); kind = kinds[row[4]] ?? "midi";
 *   langName = langs[row[5]] ?? "".
 *   _search is built EXACTLY as catalog.js builds it for a loaded record (read catalog.js: the same
 *   fields, order, separator and lower-casing — today title, artist, language, code, and the songbook
 *   when non-empty), so a phone search for "opm", "sh" or a number matches as on the host.
 * Returns null when the body is not an object, v !== 1, or rows/sources/kinds/langs are not arrays.
 * A malformed row (not an array) is KEPT as an empty record (code "", name "", artistName "") with its
 * index, so row i always stays song i — the host's index. The UI shows its own placeholder for "".
 *
 * A dictionary index counts only when it is an integer inside its array and names a string (an
 * index such as "length" or 1.5 is "unknown"). `code` keeps the type the row gives it (a number, as
 * catalog.json stores it, or a string); anything else becomes "". Names that are not strings are
 * stringified, as the server does.
 */
export function decodeCompact(body) {
  if (!body || typeof body !== "object" || Array.isArray(body) || body.v !== 1) return null;
  const { rows, sources, kinds, langs } = body;
  if (!Array.isArray(rows) || !Array.isArray(sources) || !Array.isArray(kinds) || !Array.isArray(langs)) return null;
  const out = new Array(rows.length);
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    let code = "", name = "", artistName = "", source = "", kind = "midi", langName = "";
    if (Array.isArray(r)) {
      code = codeOf(r[0]);
      name = textOf(r[1]);
      artistName = textOf(r[2]);
      source = pick(sources, r[3], "");
      kind = pick(kinds, r[4], "midi");
      langName = pick(langs, r[5], "");
    }
    // The haystack catalog.js tag() builds: title, artist, language, code, then the songbook.
    const _search = (`${name} ${artistName} ${langName} ${code ?? ""}` + (source ? ` ${source}` : "")).toLowerCase();
    out[i] = { i, code, name, artistName, source, kind, langName, type: "", id: `c:${i}`, _search };
  }
  return out;
}

/**
 * fetch(url) → JSON → decodeCompact. Returns { songs, rev } (rev = body.rev ?? the ETag header ??
 * null) or null on any failure (network, non-2xx, bad JSON, decode null). Never throws.
 * The browser's HTTP cache does the ETag revalidation (the server sends Cache-Control: no-cache
 * and an ETag, so a returning phone gets a 304 and the cached body, transparently).
 * @param {string} [url]
 * @param {Function} [fetchImpl]
 */
export async function loadCompact(url = "/api/catalog/compact", fetchImpl = globalThis.fetch) {
  try {
    if (typeof fetchImpl !== "function") return null;
    const res = await fetchImpl(url);
    if (!res || !res.ok) return null;
    const body = await res.json();
    const songs = decodeCompact(body);
    if (!songs) return null;
    let etag = null;
    try { etag = res.headers && typeof res.headers.get === "function" ? res.headers.get("ETag") : null; } catch (_) { etag = null; }
    return { songs, rev: body.rev ?? etag ?? null };
  } catch (_) {
    return null;
  }
}

function pick(dict, idx, fallback) {
  return Number.isInteger(idx) && idx >= 0 && idx < dict.length && typeof dict[idx] === "string" ? dict[idx] : fallback;
}

function codeOf(v) {
  if (typeof v === "number") return Number.isFinite(v) ? v : "";
  return typeof v === "string" ? v : "";
}

function textOf(v) {
  return v == null ? "" : (typeof v === "string" ? v : String(v));
}
