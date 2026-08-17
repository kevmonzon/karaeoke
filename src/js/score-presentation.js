/*
 * score-presentation.js — the visible half of the videoke score.
 *
 * scoring.js does the maths (per-note, octave-invariant, deliberately generous). This module
 * is presentation + persistence: the full-stage card at the end of a song, the per-line bonus
 * chip that drips feedback long before that, and the personal best per song id.
 *
 * The scorer itself stays in app.js — it belongs to the playback state machine — and is passed
 * in at call time. This module owns only its own DOM, its timers and the bests store.
 */
import { jsonStore } from "./store.js";

export const SCORES_KEY = "karaeoke.scores.v1";
export const SCORE_CARD_MS = 4500;   // the card holds the stage this long before the next song

const $ = (id) => document.getElementById(id);

/** How a finished lyric line is rated. Ordered high→low; the first threshold met wins. */
export const BONUS_BANDS = [
  [0.90, "Perfect!", "perfect"],
  [0.75, "Great!", "great"],
  [0.50, "Good", ""],
  [0.25, "Almost", ""],
  [0.00, "Miss", "miss"],
];

/** Pure: the band a line's ratio earns. Null ratio = an instrumental line, which is not rated. */
export function bonusBand(ratio) {
  if (ratio == null || !Number.isFinite(ratio)) return null;
  const hit = BONUS_BANDS.find(([min]) => ratio >= min) || BONUS_BANDS[BONUS_BANDS.length - 1];
  return { label: hit[1], cls: hit[2] };
}

export function createScorePresentation({ settings, storage } = {}) {
  const store = jsonStore(SCORES_KEY, {}, storage);
  let cardTimer = null;
  let bonusTimer = null;
  let lastBonusLine = -1;   // guards the per-line chip: one flash per lyric line

  function best(id) { return (id && store.read()[id]) || 0; }
  function saveBest(id, score) {
    if (!id) return;
    const all = store.read();
    all[id] = score;
    store.write(all);
  }

  return {
    best,

    /**
     * Close out a song's scoring. Returns null when there is nothing worth showing (no melody,
     * mic off, score disabled, or the singer never made a sound) — a card saying 0 would be a
     * worse answer than no card.
     *
     * MUST be called before clearStage(), which drops the song and singer this needs.
     */
    finish(scorer, song, by) {
      if (!scorer || !settings.get("score.enabled")) return null;
      const res = scorer.finish();
      if (!res) return null;
      const id = song ? song.id : null;
      const previous = best(id);
      const isBest = res.score > previous;
      if (isBest) saveBest(id, res.score);
      return { ...res, isBest, previous, song: song || null, by: by || "" };
    },

    showCard(res) {
      const card = $("score-card");
      if (!card || !settings.get("score.card")) return;
      $("sc-song").textContent = res.song
        ? `${res.song.name || ""}${res.song.artistName ? ` · ${res.song.artistName}` : ""}` : "";
      $("sc-score").textContent = String(res.score);
      const band = $("sc-band");
      band.textContent = res.band.label;
      band.className = `sc-band ${res.band.tier}`;
      $("sc-singer").textContent = res.by ? `🎤 ${res.by}` : "";
      $("sc-best").textContent = res.isBest
        ? (res.previous ? `★ New best — beat ${res.previous}` : "★ New best")
        : (res.previous ? `best ${res.previous}` : "");
      card.classList.add("show");
      clearTimeout(cardTimer);
      cardTimer = setTimeout(() => card.classList.remove("show"), SCORE_CARD_MS - 400);
    },

    hideCard() {
      clearTimeout(cardTimer);
      const card = $("score-card");
      if (card) card.classList.remove("show");
    },

    /**
     * Rate the lyric line that just FINISHED. Called every frame from the rAF loop, so it
     * must be idempotent within a line — the activeLine guard is what makes it so.
     */
    lineBonus(scorer, lyrics) {
      if (!scorer || !lyrics || !lyrics.lines || !lyrics.lines.length) return;
      const idx = lyrics.activeLine;
      if (idx === lastBonusLine) return;
      const prev = lastBonusLine;
      lastBonusLine = idx;
      if (prev < 0 || prev >= lyrics.lines.length) return;   // nothing has finished yet
      const line = lyrics.lines[prev];
      const band = bonusBand(scorer.windowRatio(line.start, line.end));
      if (!band) return;                                     // instrumental line — don't rate it
      const el = $("line-bonus");
      if (!el) return;
      el.textContent = band.label;
      el.className = `line-bonus show ${band.cls}`;
      clearTimeout(bonusTimer);
      bonusTimer = setTimeout(() => el.classList.remove("show"), 1100);
    },

    /** Clear the chip and re-arm the line guard. Called at every song boundary. */
    resetLineBonus() {
      clearTimeout(bonusTimer);
      lastBonusLine = -1;
      const el = $("line-bonus");
      if (el) { el.classList.remove("show"); el.textContent = ""; }
    },
  };
}
