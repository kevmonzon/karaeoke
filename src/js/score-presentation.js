/*
 * score-presentation.js — the visible half of the videoke score.
 *
 * scoring.js does the maths (per-note, octave-invariant, deliberately generous). This module
 * is presentation + persistence: the full-stage card at the end of a song, the per-line bonus
 * chip that drips feedback long before that, and the personal best per song id.
 *
 * The scorer itself stays in app.js — it belongs to the playback state machine — and is passed
 * in at call time. This module owns only its own DOM, its timers and the bests store.
 *
 * M9 (plan §5.15): the per-note verdict chip (#verdict), the card's five verdict tallies
 * (#sc-verdicts) and difficulty (#sc-difficulty). `score.feedback` picks which live feedback
 * shows: "note" (the default, and what a missing or unknown value means) = verdict chips,
 * "line" = the per-line bonus chips, "both", or "off". The two new card elements are optional:
 * an index.html without them still shows the rest of the card.
 */
import { jsonStore } from "./store.js";
import { VERDICTS, VERDICT_LABEL } from "./verdicts.js";

export const SCORES_KEY = "karaeoke.scores.v1";
export const SCORE_CARD_MS = 4500;   // the card holds the stage this long before the next song
/** How long a verdict chip stays up before it fades (a newer verdict replaces it sooner). */
export const VERDICT_MS = 700;

export const FEEDBACK_MODES = Object.freeze(["note", "line", "both", "off"]);
/** Pure: the `score.feedback` value to obey. Missing or unknown → "note", the default. */
export function feedbackMode(value) {
  return FEEDBACK_MODES.includes(value) ? value : "note";
}
const showsNotes = (mode) => mode === "note" || mode === "both";
const showsLines = (mode) => mode === "line" || mode === "both";

/** The card's difficulty names. Looked up with hasOwn: "constructor" is not a difficulty. */
export const DIFFICULTY_LABEL = Object.freeze({ easy: "Easy", normal: "Normal", hard: "Hard" });
export function difficultyLabel(name) {
  if (typeof name !== "string") return null;
  const key = name.trim().toLowerCase();
  // hasOwnProperty, not Object.hasOwn: older TV Chromium builds (before 93) lack the latter.
  return Object.prototype.hasOwnProperty.call(DIFFICULTY_LABEL, key) ? DIFFICULTY_LABEL[key] : null;
}

/**
 * Pure: a result's `verdicts` ({perfect, excellent, great, good, miss}) as five whole counts in
 * VERDICTS order, or null when there is nothing to show (absent, or every count zero). A missing,
 * negative or non-numeric count is 0.
 */
export function verdictTallies(v) {
  if (!v || typeof v !== "object") return null;
  const counts = VERDICTS.map((k) => {
    const n = Math.round(Number(v[k]));
    return Number.isFinite(n) && n > 0 ? n : 0;
  });
  return counts.some((n) => n > 0) ? counts : null;
}

/**
 * How long the card's opacity transition runs. MUST match `--dur-slow` in tokens.css: the card
 * has to be FULLY transparent before endOfSong hands over, or the next song's title card — same
 * size, same position, same tint, but a lower z-index — fades in underneath a score card that is
 * still on screen, and the two smear together.
 */
const CARD_FADE_MS = 450;
const CARD_FADE_MARGIN_MS = 100;   // land the fade just before the hand-off, not exactly on it

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

/**
 * `doc` is injectable for tests; by default the page's `document` is read at call time.
 */
export function createScorePresentation({ settings, storage, doc } = {}) {
  const store = jsonStore(SCORES_KEY, {}, storage);
  const getDoc = () => doc || globalThis.document;
  const $ = (id) => { const d = getDoc(); return d ? d.getElementById(id) : null; };
  let cardTimer = null;
  let bonusTimer = null;
  let verdictTimer = null;
  let verdictFlip = false;  // alternates the chip's pop class, so a replacing verdict re-pops
  let lastBonusLine = -1;   // guards the per-line chip: one flash per lyric line
  let pendingLine = -1;     // a finished line waiting for the scorer's clock to pass its end (M9)

  const feedback = () => feedbackMode(settings.get("score.feedback"));

  /** The five tallies, or hide the row (absent / all zero — and always clear the last song's). */
  function renderTallies(el, verdicts) {
    if (!el) return;
    const counts = verdictTallies(verdicts);
    if (!counts) { el.replaceChildren(); el.hidden = true; return; }
    const d = getDoc();
    el.replaceChildren(...VERDICTS.map((k, i) => {
      const pair = d.createElement("span");
      pair.className = `scv v-${k}`;
      const label = d.createElement("span");
      label.className = "scv-l";
      label.textContent = VERDICT_LABEL[k];
      const n = d.createElement("span");
      n.className = "scv-n";
      n.textContent = String(counts[i]);
      pair.append(label, " ", n);   // a real space, so it reads "PERFECT 12", not "PERFECT12"
      return pair;
    }));
    el.hidden = false;
  }

  function renderDifficulty(el, name) {
    if (!el) return;
    const label = difficultyLabel(name);
    el.textContent = label || "";
    el.hidden = !label;
  }

  function resetVerdict() {
    clearTimeout(verdictTimer);
    const el = $("verdict");
    if (el) { el.classList.remove("show"); el.textContent = ""; }
  }

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
      renderTallies($("sc-verdicts"), res.verdicts);
      renderDifficulty($("sc-difficulty"), res.difficulty);
      $("sc-singer").textContent = res.by ? `🎤 ${res.by}` : "";
      $("sc-best").textContent = res.isBest
        ? (res.previous ? `★ New best — beat ${res.previous}` : "★ New best")
        : (res.previous ? `best ${res.previous}` : "");
      card.classList.add("show");
      clearTimeout(cardTimer);
      cardTimer = setTimeout(() => card.classList.remove("show"),
        Math.max(0, SCORE_CARD_MS - CARD_FADE_MS - CARD_FADE_MARGIN_MS));
    },

    hideCard() {
      clearTimeout(cardTimer);
      const card = $("score-card");
      if (card) card.classList.remove("show");
    },

    /**
     * Flash one per-note verdict ("perfect" … "miss") on #verdict. Only while `score.feedback`
     * is "note" or "both"; anything not in VERDICTS is ignored. A new verdict replaces the one
     * showing (text, colour, a fresh pop) and restarts the VERDICT_MS fade timer. Returns
     * whether a chip was shown.
     */
    showVerdict(verdict) {
      if (typeof verdict !== "string" || !VERDICTS.includes(verdict)) return false;
      if (!showsNotes(feedback())) return false;
      const el = $("verdict");
      if (!el) return false;
      verdictFlip = !verdictFlip;
      el.textContent = VERDICT_LABEL[verdict];
      // Two identical keyframes under two names: swapping the class restarts the pop with no
      // forced reflow (this runs inside the rAF loop).
      el.className = `verdict show v-${verdict} ${verdictFlip ? "pop-a" : "pop-b"}`;
      clearTimeout(verdictTimer);
      verdictTimer = setTimeout(() => el.classList.remove("show"), VERDICT_MS);
      return true;
    },

    /** Clear the verdict chip now (resetLineBonus does this too, at every song boundary). */
    resetVerdict,

    /**
     * Rate the lyric line that just FINISHED. Called every frame from the rAF loop, so it
     * must be idempotent within a line — the activeLine guard is what makes it so.
     * Shows nothing unless `score.feedback` is "line" or "both" (the default "note" shows verdict
     * chips instead); the guard still follows the lyrics, so turning line chips on mid-song rates
     * the line that just finished, never one from minutes ago.
     */
    lineBonus(scorer, lyrics) {
      if (!scorer || !lyrics || !lyrics.lines || !lyrics.lines.length) return;
      const idx = lyrics.activeLine;
      if (idx !== lastBonusLine) {
        const prev = lastBonusLine;
        lastBonusLine = idx;
        if (!showsLines(feedback())) { pendingLine = -1; return; }
        if (prev >= 0 && prev < lyrics.lines.length) {
          // A newer line finished while an older one still waited: rate the older one now.
          if (pendingLine >= 0 && pendingLine !== prev) rateLine(scorer, lyrics, pendingLine);
          pendingLine = prev;
        }
      }
      // The scorer reads the melody at gt − mic latency (M9), so its clock reaches a line's end that
      // much after the lyrics move on. Rate a finished line only once the clock has passed its end, or
      // the line's last notes count as unsung. A scorer without a clock is rated at once.
      if (pendingLine < 0) return;
      if (pendingLine >= lyrics.lines.length) { pendingLine = -1; return; }
      if (scorer.clock < lyrics.lines[pendingLine].end) return;
      const ready = pendingLine;
      pendingLine = -1;
      rateLine(scorer, lyrics, ready);
    },

    /** Clear the chip and re-arm the line guard. Called at every song boundary. Also clears
     *  the verdict chip, so a song's last verdict never lingers into the next one. */
    resetLineBonus() {
      clearTimeout(bonusTimer);
      lastBonusLine = -1;
      pendingLine = -1;
      const el = $("line-bonus");
      if (el) { el.classList.remove("show"); el.textContent = ""; }
      resetVerdict();
    },
  };

  // Flash the bonus chip for one finished line (lineBonus decides when).
  function rateLine(scorer, lyrics, index) {
    if (!showsLines(feedback())) return;
    const line = lyrics.lines[index];
    if (!line) return;
    const band = bonusBand(scorer.windowRatio(line.start, line.end));
    if (!band) return;                                     // instrumental line — don't rate it
    const el = $("line-bonus");
    if (!el) return;
    el.textContent = band.label;
    el.className = `line-bonus show ${band.cls}`;
    clearTimeout(bonusTimer);
    bonusTimer = setTimeout(() => el.classList.remove("show"), 1100);
  }
}
