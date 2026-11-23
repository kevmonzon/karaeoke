/*
 * search-worker.js — holds the fuzzy-search word index off the main thread.
 *
 * A MODULE worker (created with { type: "module" }, like pitch-worker.js) so it runs the same
 * search-core.js the unit tests exercise. Message protocol (search-client.js is the other side):
 *   in : { type: "build", titles: string[], artists: string[] }
 *   out: { type: "ready", words, ms }
 *   in : { type: "query", seq, q, limit, exclude: Uint32Array }
 *   out: { type: "result", seq, hits: Uint32Array, scores: Float32Array }   (buffers transferred)
 * A query that arrives before any build answers with empty arrays.
 *
 * The handler is a factory so node can drive it without a Worker; the last lines attach it only
 * when this file really runs as a worker.
 */

import { MAX_CLOSE, buildIndex, searchClose, titleLengths } from "../search-core.js";

const now = () => (globalThis.performance ? performance.now() : Date.now());

/** `post(message, transfer)` sends a reply; returns `handle(message)`. */
export function createSearchWorker(post) {
  let index = null;
  let titleLen = null;                     // for searchClose's 0.002 × title-length tie-break

  return function handle(msg) {
    if (!msg || typeof msg !== "object") return;
    if (msg.type === "build") {
      const t0 = now();
      const titles = Array.isArray(msg.titles) ? msg.titles : [];
      const artists = Array.isArray(msg.artists) ? msg.artists : [];
      index = null; titleLen = null;       // drop the old index before building the new one
      index = buildIndex(titles, artists);
      titleLen = titleLengths(titles);
      post({ type: "ready", words: index.words.length, ms: now() - t0 });
    } else if (msg.type === "query") {
      let hits = new Uint32Array(0), scores = new Float32Array(0);
      if (index) {
        const exclude = msg.exclude && msg.exclude.length ? new Set(msg.exclude) : null;
        const limit = msg.limit == null ? MAX_CLOSE : msg.limit;
        const found = searchClose(index, String(msg.q ?? ""), { limit, exclude, titleLen });
        hits = new Uint32Array(found.length); scores = new Float32Array(found.length);
        for (let k = 0; k < found.length; k++) { hits[k] = found[k].i; scores[k] = found[k].score; }
      }
      post({ type: "result", seq: msg.seq, hits, scores }, [hits.buffer, scores.buffer]);
    }
  };
}

if (typeof WorkerGlobalScope !== "undefined" && self instanceof WorkerGlobalScope) {
  const handle = createSearchWorker((message, transfer) => self.postMessage(message, transfer || []));
  self.onmessage = (e) => handle(e.data);
}
