/*
 * search-client.js — the main thread's handle on the fuzzy-search index.
 *
 * build() hands every title and artist to a module Worker (workers/search-worker.js) and resolves
 * when it answers "ready". Without a Worker — none in this environment, the constructor throws, or
 * the worker reports an `error` (a blocked URL, a crash) — the same index is built HERE instead,
 * in slices: one buildIndexSteps() step per schedule() call, so no single slice blocks the page
 * for long. `mode` says which path is live: "worker", "main", or "off" (before build / disposed).
 *
 * query() resolves [{ i, score }] — i indexes the arrays given to build() — or null when the
 * index is not ready or a newer query was issued meanwhile (only the latest query is answered).
 * A build() makes every earlier query resolve null: its indices describe the old song list.
 */

import { MAX_CLOSE, buildIndexSteps, searchClose, titleLengths } from "./search-core.js";

export function createSearchClient({ WorkerImpl = globalThis.Worker,
                                     workerUrl = new URL("./workers/search-worker.js", import.meta.url),
                                     schedule = (fn) => setTimeout(fn, 0) } = {}) {
  let mode = "off";
  let ready = false;
  let disposed = false;
  let worker = null;
  let workerFailed = false;     // once the worker has failed, later builds stay on the main thread
  let buildsInFlight = 0;       // "build" messages the worker has not answered yet (FIFO)
  let gen = 0;                  // bumped by build() and dispose(); stale main-thread work checks it
  let titles = [], artists = []; // the latest build's input, kept for a fallback rebuild
  let index = null, titleLen = null;   // the main-thread index
  let seq = 0;
  let pending = null;           // the one outstanding query: { seq, resolve }
  let waiters = [];             // build() promises waiting for "ready"

  function dropPending() {
    if (!pending) return;
    const { resolve } = pending;
    pending = null;
    resolve(null);
  }

  function flushWaiters() {
    const list = waiters;
    waiters = [];
    for (const resolve of list) resolve();
  }

  function becomeReady() {
    ready = true;
    flushWaiters();
  }

  function startWorker() {
    if (workerFailed || typeof WorkerImpl !== "function") return false;
    let w;
    try { w = new WorkerImpl(workerUrl, { type: "module" }); } catch { workerFailed = true; return false; }
    worker = w;
    w.onmessage = (e) => onWorkerMessage(w, e && e.data);
    w.onerror = (e) => onWorkerFailure(w, e);
    w.onmessageerror = (e) => onWorkerFailure(w, e);
    return true;
  }

  function onWorkerMessage(w, msg) {
    if (w !== worker || !msg) return;
    if (msg.type === "ready") {
      if (buildsInFlight > 0) buildsInFlight--;
      if (buildsInFlight === 0) becomeReady();     // the reply to the LATEST build
    } else if (msg.type === "result") {
      if (!pending || msg.seq !== pending.seq) return;   // superseded: already resolved null
      const { resolve } = pending;
      pending = null;
      const hits = msg.hits || [], scores = msg.scores || [];
      const out = new Array(hits.length);
      for (let k = 0; k < hits.length; k++) out[k] = { i: hits[k], score: scores[k] };
      resolve(out);
    }
  }

  /** The worker is unusable: drop it and build on the main thread from the latest input. */
  function onWorkerFailure(w, e) {
    if (w !== worker) return;
    if (e && typeof e.preventDefault === "function") e.preventDefault();   // handled here
    worker = null;
    workerFailed = true;
    try { w.terminate(); } catch { /* already gone */ }
    buildsInFlight = 0;
    ready = false;
    dropPending();
    buildMain(gen);
  }

  function post(message, transfer) {
    try { worker.postMessage(message, transfer || []); return true; }
    catch (e) { onWorkerFailure(worker, e); return false; }
  }

  function buildMain(myGen) {
    mode = "main";
    index = null; titleLen = null;
    const steps = buildIndexSteps(titles, artists);
    const step = () => {
      if (myGen !== gen) return;            // a newer build() or dispose() took over
      const r = steps.next();
      if (!r.done) { schedule(step); return; }
      index = r.value;
      titleLen = titleLengths(titles);
      becomeReady();
    };
    schedule(step);
  }

  return {
    /** Index these songs (titles[i], artists[i] = song i). Resolves once queries can answer. */
    build(nextTitles, nextArtists) {
      if (disposed) return Promise.resolve();
      titles = nextTitles || []; artists = nextArtists || [];
      const myGen = ++gen;
      ready = false;
      dropPending();
      const done = new Promise((resolve) => waiters.push(resolve));
      if (worker || startWorker()) {
        mode = "worker";
        buildsInFlight++;
        post({ type: "build", titles, artists });   // a failure here falls back to buildMain
      } else {
        buildMain(myGen);
      }
      return done;
    },

    /** Close matches for `q`, or null (not ready / superseded). `exclude`: song indices to skip. */
    query(q, { limit = MAX_CLOSE, exclude = [] } = {}) {
      if (!ready || disposed) return Promise.resolve(null);
      dropPending();                          // a newer query: the older one resolves null now
      const my = ++seq;
      return new Promise((resolve) => {
        pending = { seq: my, resolve };
        const text = String(q ?? "");
        if (mode === "worker") {
          const ex = Uint32Array.from(exclude || []);
          post({ type: "query", seq: my, q: text, limit, exclude: ex }, [ex.buffer]);
          return;
        }
        const skip = new Set(exclude || []);
        schedule(() => {
          if (!pending || pending.seq !== my) return;
          pending = null;
          resolve(ready && index ? searchClose(index, text, { limit, exclude: skip, titleLen }) : null);
        });
      });
    },

    get ready() { return ready && !disposed; },
    get mode() { return mode; },

    /** Stop the worker and any main-thread build; every later query resolves null. */
    dispose() {
      if (disposed) return;
      disposed = true;
      gen++;
      ready = false;
      mode = "off";
      dropPending();
      if (worker) { try { worker.terminate(); } catch { /* already gone */ } }
      worker = null;
      index = null; titleLen = null;
      titles = []; artists = [];
      flushWaiters();
    },
  };
}
