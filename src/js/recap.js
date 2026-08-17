/*
 * recap.js — "Tonight's recap" (⚙ → Library → 🏆).
 *
 * Every performance is logged as it finishes — song, singer, score — and a long enough gap
 * starts a new night. Nothing new is recorded to make this work: it is the same data the
 * queue, the singer banner and the scorer already produce, kept in order. No recording, no
 * upload.
 *
 * The module owns its own dialog DOM (#recap / #recap-body / #recap-close), the same way
 * midi-mixer.js owns its band — app.js only says "log this" and "show it".
 */
import { jsonStore } from "./store.js";

export const RECAP_KEY = "karaeoke.recap.v1";
export const RECAP_GAP_MS = 6 * 3600 * 1000;   // a gap this long means it's a different night
const MAX_ITEMS = 200;                          // a very long night still stays bounded

const $ = (id) => document.getElementById(id);

/**
 * The numbers across the top of the card. Pure — the whole reason it is separable from the
 * rendering below.
 * @param {Array<{by?:string, score?:number|null}>} items
 * @returns {{songs:number, singers:number, top:object|null}}
 */
export function recapSummary(items) {
  const list = Array.isArray(items) ? items : [];
  const scored = list.filter((i) => i && i.score != null).sort((a, b) => b.score - a.score);
  const singers = new Set(list.map((i) => (i && i.by) || "—"));
  return { songs: list.length, singers: singers.size, top: scored[0] || null };
}

/**
 * Fold one finished performance into a night's log, starting a fresh night after a long gap.
 * Pure: takes the current log and returns the next one, so the gap rule is testable without
 * a clock or storage.
 */
export function appendPerformance(recap, entry, now) {
  const items = (recap && Array.isArray(recap.items)) ? recap.items : [];
  const last = items.length ? items[items.length - 1].at : 0;
  const fresh = !items.length || now - last > RECAP_GAP_MS;
  const next = fresh ? { startedAt: now, items: [] } : { startedAt: recap.startedAt, items: [...items] };
  next.items.push({ ...entry, at: now });
  if (next.items.length > MAX_ITEMS) next.items.shift();
  return next;
}

export function createRecap(storage) {
  const store = jsonStore(RECAP_KEY, null, storage);
  let recap = { startedAt: 0, items: [] };

  return {
    /** Read the saved log, discarding it if the last song was long enough ago. */
    load(now = Date.now()) {
      const r = store.read();
      if (r && Array.isArray(r.items)) recap = r;
      const last = recap.items.length ? recap.items[recap.items.length - 1].at : 0;
      if (!last || now - last > RECAP_GAP_MS) recap = { startedAt: 0, items: [] };
    },

    /** Record one finished performance. `score` is null when nothing was scored (mic off, video). */
    log(song, by, score, now = Date.now()) {
      if (!song) return;
      recap = appendPerformance(recap, {
        id: song.id, name: song.name || "", artist: song.artistName || "",
        by: by || "", score: Number.isFinite(score) ? score : null,
      }, now);
      store.write(recap);
    },

    get items() { return recap.items; },

    isOpen() {
      const el = $("recap");
      return !!el && !el.classList.contains("hidden");
    },

    hide() { const el = $("recap"); if (el) el.classList.add("hidden"); },

    show() {
      const el = $("recap");
      if (!el) return;
      const items = recap.items;
      const body = $("recap-body");
      body.replaceChildren();
      if (!items.length) {
        const p = document.createElement("p");
        p.className = "hint";
        p.textContent = "No songs yet tonight. Sing something.";
        body.appendChild(p);
      } else {
        const { songs, singers, top } = recapSummary(items);

        const stats = document.createElement("div");
        stats.className = "recap-stats";
        stats.append(
          stat(String(songs), songs === 1 ? "song" : "songs"),
          stat(String(singers), singers === 1 ? "singer" : "singers"),
          stat(top ? String(top.score) : "—", top ? `top score · ${top.by || "host"}` : "no scores"),
        );
        body.appendChild(stats);

        const ul = document.createElement("ul");
        ul.className = "recap-list";
        for (const i of [...items].reverse()) {   // most recent first — that's what people ask about
          const li = document.createElement("li");
          const t = document.createElement("span");
          t.className = "rc-title";
          t.textContent = i.name || "(untitled)";
          const a = document.createElement("span");
          a.className = "rc-meta";
          a.textContent = [i.artist, i.by ? `🎤 ${i.by}` : ""].filter(Boolean).join(" · ");
          const s = document.createElement("span");
          s.className = "rc-score";
          s.textContent = i.score != null ? String(i.score) : "";
          li.append(t, a, s);
          ul.appendChild(li);
        }
        body.appendChild(ul);
      }
      el.classList.remove("hidden");
    },

    /** Wire the close button and the click-the-scrim-to-dismiss. Call once at boot. */
    wire() {
      const close = $("recap-close");
      if (close) close.onclick = () => this.hide();
      const el = $("recap");
      if (el) el.onclick = (e) => { if (e.target === el) this.hide(); };
    },
  };
}

function stat(n, k) {
  const d = document.createElement("div");
  d.className = "recap-stat";
  const a = document.createElement("b"); a.textContent = n;
  const b = document.createElement("span"); b.textContent = k;
  d.append(a, b);
  return d;
}
