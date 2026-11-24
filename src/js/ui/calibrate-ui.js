/*
 * calibrate-ui.js — the microphone calibration dialog (M9, plan §5.17). Fills #ov-calibrate.
 *
 * CONTRACT STUB written by the orchestrator. Lane B fills it; app.js (lane I) codes against it:
 *
 *   const cal = createCalibrateUI({ el: $("ov-calibrate"), mic, audio, settings, onSave });
 *   // the "Calibrate…" button: overlays.open("calibrate") and cal.open()
 *
 * Steps: intro → silence (2 s) → clicks (≈ 5 s) → result | failed.
 *   intro:   "Hold the microphone 20 cm from the speaker. You will hear 8 clicks." [Start] [Cancel]
 *   silence: 2 s of room noise through mic.openRawTap() → noiseFloorDb.
 *   clicks:  CLICKS clicks scheduled on audio.ctx (the app's shared context, via audio.ensureContext())
 *            and connected to audio.gain — the node songs play through; the raw tap's blocks are
 *            timestamped on the same clock (worklet frame / sampleRate) → detectOnsets → estimateLatency.
 *   result:  "Latency 138 ms (6 of 8 clicks heard). Room noise −52 dB → gate −42 dB." [Save] [Retry] [Cancel]
 *            Save → settings.set("mic.latencyMs", round to 5 ms, clamp 0–500), and the gate threshold
 *            (mic.gateThresholdDb) only if the user keeps that checkbox ticked; then onSave(result).
 *   failed:  "Could not measure: …" [Retry] [Cancel]. NOTHING is saved on failure.
 * Unavailable states (open() shows the reason instead of the intro; Start never runs):
 *   !mic.secure            → "Open the app on https or localhost to use the microphone"
 *   settings bt.enabled on → "Turn off Bluetooth mode first"
 * The raw tap is always stopped (Cancel, Back, failure, Save) and the user's mic is left as it was.
 * Buttons carry data-cal="start|save|retry|cancel"; Cancel and Done close via the overlay
 * ([data-ov-close]) — the dialog never closes itself any other way. All text via textContent.
 *
 * @param {object} o
 * @param {HTMLElement} o.el
 * @param {import("../mic.js").MicEngine} o.mic
 * @param {import("../audio.js").AudioEngine} o.audio
 * @param {{get(path:string):any, set(path:string, v:any):void}} o.settings
 * @param {(result:{latencyMs:number, matched:number, spreadMs:number, noiseDb:number, gateDb:number}) => void} [o.onSave]
 * @param {Document} [o.doc]
 * @returns {{ open(): void, readonly step: string }}
 *
 * Lane B notes (additions — nothing above changes):
 *   - Two more steps: "unavailable" (the reason + [Close]) and "saved" ("Saved: …" + [Done],
 *     data-cal="done", data-ov-close). `step` is one of intro · unavailable · silence · clicks ·
 *     result · failed · saved.
 *   - The returned object also has close() — abort a measurement and stop the tap (idempotent;
 *     wire it as the overlay's onClose) — and firstButton() (the step's primary button, for
 *     initialFocus). Without them the dialog still notices its overlay closing (Back, the scrim)
 *     through a MutationObserver on its own class / hidden attributes.
 *   - Exported calibrateUnavailable({mic, settings}) → the reason text or null, and CAL_TEXT, so
 *     the Settings button can be disabled with exactly the dialog's wording.
 *   - o.sleep(ms) → Promise (default setTimeout) is a test seam for the clock polling.
 *   - onSave's result also carries gateSaved (whether the gate threshold was written) and path
 *     (the raw tap's "second" | "paused-main").
 *
 * DOM built inside el (all classes are styled by the "calibrate (M9)" block of overlays.css):
 *   div.cal[data-step]
 *     h2.cal-title                              "Microphone calibration"
 *     p.cal-text                                the step's sentence (result numbers in strong.cal-num)
 *     div.cal-meter[role=progressbar] > span.cal-meter-fill   (silence / clicks only; --cal-p 0…1)
 *     p.cal-progress[aria-live=polite]          (silence / clicks only)
 *     label.cal-check > input[type=checkbox] + span           (result only)
 *     div.cal-actions.ov-actions > button[data-cal]…          primary button first
 */

import {
  CLICKS, CLICK_SEC, CLICK_HZ, clickTimes, detectOnsets, estimateLatency, matchClicks,
  noiseFloorDb, suggestGateDb, onsetThresholdDb,
} from "../latency-cal.js";

export const CAL_TEXT = Object.freeze({
  title: "Microphone calibration",
  intro: `Hold the microphone 20 cm from the speaker. You will hear ${CLICKS} clicks.`,
  insecure: "Open the app on https or localhost to use the microphone",
  bluetooth: "Turn off Bluetooth mode first",
  silence: "Listening to the room — please stay quiet…",
  clicks: `Playing ${CLICKS} clicks — keep the microphone still.`,
  fail: "Could not measure: ",
  failOpen: "the microphone could not be opened",
  failNoSound: "the microphone sent no sound.",
  failNoClicks: "no clicks were heard. Turn the volume up, hold the microphone closer to the speaker and retry.",
  failUneven: "the clicks were heard at uneven delays. Keep the room quiet and retry.",
  failStalled: "the audio clock is not running.",
  failError: "the measurement stopped with an error",
});

const SETTLE_SEC = 0.25;     // skip the first moments of the new stream (device start-up)
const SILENCE_SEC = 2;
const LEAD_SEC = 0.5;        // the first click this long after the silence ends
const MAX_MS = 600;          // estimateLatency's pairing window (its default)
const TAIL_SEC = 0.15;       // let the last blocks arrive from the worklet
const POLL_MS = 50;
const STALL_MS = 3000;       // the audio clock may lag the wall clock this much before we give up
const CLICK_LEVEL = 0.6;
const RAMP_SEC = 0.001;
const MIN_COVER = 0.5;       // a collected span must be at least this full of microphone blocks

/** The reason calibration cannot run, or null. Order: secure context first, then Bluetooth mode. */
export function calibrateUnavailable({ mic, settings } = {}) {
  if (!mic || mic.secure !== true) return CAL_TEXT.insecure;
  let bt = false;
  try { bt = !!(settings && settings.get("bt.enabled")); } catch (_) { bt = false; }
  if (bt) return CAL_TEXT.bluetooth;
  return null;
}

const minus = (v) => (v < 0 ? "−" : "") + Math.abs(v);       // U+2212, as in the plan's texts
const fmtDb = (v) => `${minus(Math.round(v))} dB`;

class CalError extends Error {
  constructor(text) { super(text); this.calText = text; }
}

// Join the tap's blocks that fall in [from, to) into one buffer on the context's clock. Blocks are
// placed by their own frame time, so a dropped quantum leaves a gap of zeros, never a time shift.
// → { start, samples } or null when the microphone delivered too little of the span.
function collect(blocks, from, to, sr) {
  const picked = blocks.filter((b) => b.time + b.samples.length / sr > from && b.time < to);
  if (!picked.length) return null;
  const base = picked[0].time;
  const last = picked[picked.length - 1];
  const len = Math.max(0, Math.round((last.time - base) * sr) + last.samples.length);
  const all = new Float32Array(len);
  let covered = 0;
  for (const b of picked) {
    const at = Math.round((b.time - base) * sr);
    if (at < 0 || at >= len) continue;
    const n = Math.min(b.samples.length, len - at);
    all.set(n === b.samples.length ? b.samples : b.samples.subarray(0, n), at);
    covered += n;
  }
  const i0 = Math.max(0, Math.round((from - base) * sr));
  const i1 = Math.min(len, Math.round((to - base) * sr));
  if (i1 <= i0) return null;
  const want = Math.round((to - from) * sr);
  if (covered < MIN_COVER * want || (i1 - i0) < MIN_COVER * want) return null;
  return { start: base + i0 / sr, samples: all.subarray(i0, i1) };
}

export function createCalibrateUI({ el, mic, audio, settings, onSave = () => {}, doc = globalThis.document, sleep } = {}) {
  if (!el || typeof el.addEventListener !== "function") {
    throw new TypeError("createCalibrateUI: `el` (the #ov-calibrate element) is required");
  }
  const win = (doc && doc.defaultView) || globalThis;
  const wait = typeof sleep === "function" ? sleep
    : (ms) => new Promise((r) => (win.setTimeout || globalThis.setTimeout)(r, ms));

  let step = "intro";
  let runId = 0;              // bumped by every abort; a stale measurement checks it after each await
  let tap = null;             // the open raw tap, if any
  let clickNodes = [];        // scheduled click oscillators / envelopes (silenced on abort)
  let result = null;          // the last good measurement, shown until Save / Retry / open
  let buttons = [];           // the current step's buttons, primary first
  let gateBox = null;         // the result step's checkbox
  let meterFill = null, meterBar = null, progressEl = null;
  let renders = 0;            // bumped by every render (a deferred render checks it)

  const D = () => doc || el.ownerDocument;
  const make = (tag, className, text) => {
    const n = D().createElement(tag);
    if (className) n.className = className;
    if (text != null) n.textContent = text;
    return n;
  };
  const add = (parent, ...kids) => {
    for (const k of kids) {
      if (k == null) continue;
      if (typeof k === "string") {
        const d = D();
        if (typeof d.createTextNode === "function") parent.appendChild(d.createTextNode(k));
        else parent.appendChild(make("span", "", k));
      } else parent.appendChild(k);
    }
    return parent;
  };
  const shown = () => !el.hidden && (!el.classList || el.classList.contains("open"));

  // ---- render --------------------------------------------------------------------------------
  function button(id, label, { close = false, primary = false } = {}) {
    const b = make("button", primary ? "primary" : "", label);
    b.setAttribute("type", "button");
    b.setAttribute("data-cal", id);
    if (close) b.setAttribute("data-ov-close", "");
    buttons.push(b);
    return b;
  }

  function render(next, { text = null, textNodes = null } = {}) {
    const d = D();
    const active = d && d.activeElement;
    const hadFocus = !active || active === d.body || active === el
      || (typeof el.contains === "function" && el.contains(active));
    step = next;
    renders++;
    buttons = [];
    gateBox = null;
    meterFill = meterBar = progressEl = null;

    const box = make("div", "cal");
    box.setAttribute("data-step", next);
    add(box, make("h2", "cal-title", CAL_TEXT.title));
    const p = make("p", "cal-text", textNodes ? null : text);
    if (textNodes) add(p, ...textNodes);
    add(box, p);

    if (next === "silence" || next === "clicks") {
      meterBar = make("div", "cal-meter");
      meterBar.setAttribute("role", "progressbar");
      meterBar.setAttribute("aria-label", "Progress");
      meterBar.setAttribute("aria-valuemin", "0");
      meterBar.setAttribute("aria-valuemax", "100");
      meterFill = make("span", "cal-meter-fill");
      add(meterBar, meterFill);
      progressEl = make("p", "cal-progress");
      progressEl.setAttribute("aria-live", "polite");
      add(box, meterBar, progressEl);
      setProgress(0, "");
    }

    if (next === "result" && result) {
      const label = make("label", "cal-check");
      gateBox = make("input");
      gateBox.setAttribute("type", "checkbox");
      gateBox.checked = true;
      add(label, gateBox, make("span", "", `Also set the noise gate to ${fmtDb(result.gateDb)}`));
      add(box, label);
    }

    const actions = make("div", "cal-actions ov-actions");
    if (next === "intro") add(actions, button("start", "Start", { primary: true }), button("cancel", "Cancel", { close: true }));
    else if (next === "unavailable") add(actions, button("cancel", "Close", { close: true }));
    else if (next === "silence" || next === "clicks") add(actions, button("cancel", "Cancel", { close: true }));
    else if (next === "result") add(actions, button("save", "Save", { primary: true }), button("retry", "Retry"), button("cancel", "Cancel", { close: true }));
    else if (next === "failed") add(actions, button("retry", "Retry", { primary: true }), button("cancel", "Cancel", { close: true }));
    else if (next === "saved") add(actions, button("done", "Done", { primary: true, close: true }));
    add(box, actions);

    if (typeof el.replaceChildren === "function") el.replaceChildren(box);
    else { el.textContent = ""; el.appendChild(box); }

    // The old step's buttons are gone: keep the D-pad on the dialog (its primary button).
    if (hadFocus && shown() && buttons[0] && typeof buttons[0].focus === "function") {
      try { buttons[0].focus({ preventScroll: true }); } catch (_) {}
    }
  }

  function setProgress(fraction, text) {
    const f = Math.max(0, Math.min(1, Number(fraction) || 0));
    if (meterFill && meterFill.style && typeof meterFill.style.setProperty === "function") {
      meterFill.style.setProperty("--cal-p", String(f));
    }
    if (meterBar) meterBar.setAttribute("aria-valuenow", String(Math.round(f * 100)));
    if (progressEl && progressEl.textContent !== text) progressEl.textContent = text;
  }

  // ---- measurement ---------------------------------------------------------------------------
  function silenceClicks() {
    for (const n of clickNodes) {
      try { if (typeof n.stop === "function") n.stop(0); } catch (_) {}
      try { n.disconnect(); } catch (_) {}
    }
    clickNodes = [];
  }

  function stopTap() {
    const t = tap;
    tap = null;
    if (t) { try { const p = t.stop(); if (p && typeof p.catch === "function") p.catch(() => {}); } catch (_) {} }
  }

  function abort() {
    runId++;
    stopTap();
    silenceClicks();
  }

  function scheduleClicks(ctx, times) {
    const out = audio && audio.gain ? audio.gain : ctx.destination;
    for (const t of times) {
      const osc = ctx.createOscillator();
      osc.type = "sine";
      osc.frequency.value = CLICK_HZ;
      const env = ctx.createGain();
      env.gain.value = 0;
      env.gain.setValueAtTime(0, t);
      env.gain.linearRampToValueAtTime(CLICK_LEVEL, t + RAMP_SEC);
      env.gain.setValueAtTime(CLICK_LEVEL, t + CLICK_SEC - RAMP_SEC);
      env.gain.linearRampToValueAtTime(0, t + CLICK_SEC);
      osc.connect(env);
      env.connect(out);
      osc.start(t);
      osc.stop(t + CLICK_SEC + 0.005);
      osc.onended = () => { try { osc.disconnect(); env.disconnect(); } catch (_) {} };
      clickNodes.push(osc, env);
    }
  }

  // Poll the AUDIO clock until it reaches `target`. Throws when it stops advancing.
  async function waitClock(ctx, target, alive, onTick) {
    const budget = Math.max(0, target - ctx.currentTime) * 1000 + STALL_MS;
    let waited = 0;
    while (alive() && ctx.currentTime < target) {
      if (onTick) onTick(ctx.currentTime);
      if (waited > budget) throw new CalError(CAL_TEXT.failStalled);
      await wait(POLL_MS);
      waited += POLL_MS;
    }
    if (alive() && onTick) onTick(ctx.currentTime);
  }

  async function measure() {
    abort();
    const gen = runId;
    const alive = () => gen === runId;
    result = null;
    render("silence", { text: CAL_TEXT.silence });
    try {
      const ctx = await audio.ensureContext();
      if (!alive()) return;
      let t;
      try {
        t = await mic.openRawTap();
      } catch (e) {
        const why = e && (e.name && e.name !== "Error" ? e.name : e.message);
        throw new CalError(CAL_TEXT.failOpen + (why ? ` (${why}).` : "."));
      }
      if (!alive()) { try { t.stop(); } catch (_) {} return; }
      tap = t;
      const sr = t.sampleRate || ctx.sampleRate;
      const blocks = [];
      t.onBlock((b) => { if (b && b.samples && Number.isFinite(b.time)) blocks.push(b); });
      try { await ctx.resume(); } catch (_) {}
      if (!alive()) return;

      // 1. room noise
      const opened = ctx.currentTime;
      const s0 = opened + SETTLE_SEC;
      const s1 = s0 + SILENCE_SEC;
      await waitClock(ctx, s1 + TAIL_SEC / 3, alive, (now) => {
        const left = Math.max(0, Math.ceil(s1 - now));
        setProgress((now - opened) / (s1 - opened), left > 0 ? `${left} s` : "");
      });
      if (!alive()) return;
      const quiet = collect(blocks, s0, s1, sr);
      if (!quiet) throw new CalError(CAL_TEXT.failNoSound);
      const noiseDb = noiseFloorDb(quiet.samples);

      // 2. the clicks, on the same clock the blocks carry
      const times = clickTimes(ctx.currentTime + LEAD_SEC);
      render("clicks", { text: CAL_TEXT.clicks });
      scheduleClicks(ctx, times);
      const end = times[times.length - 1] + MAX_MS / 1000;
      const first = times[0];
      await waitClock(ctx, end + TAIL_SEC, alive, (now) => {
        const played = times.filter((x) => x <= now).length;
        setProgress((now - first + LEAD_SEC) / (end - first + LEAD_SEC),
          played ? `Click ${played} of ${CLICKS}` : "Get ready…");
      });
      if (!alive()) return;
      stopTap();
      clickNodes = [];

      const heard = collect(blocks, first - 0.25, end, sr);
      if (!heard) throw new CalError(CAL_TEXT.failNoSound);
      const onsets = detectOnsets(heard.samples, sr, { thresholdDb: onsetThresholdDb(noiseDb) })
        .map((o) => heard.start + o);
      const est = estimateLatency(times, onsets, { maxMs: MAX_MS });
      if (!est) {
        const matched = matchClicks(times, onsets, { maxMs: MAX_MS }).length;
        if (matched === 0) throw new CalError(CAL_TEXT.failNoClicks);
        if (matched < 5) {
          throw new CalError(`only ${matched} of ${CLICKS} clicks were heard. Turn the volume up or hold the microphone closer, then retry.`);
        }
        throw new CalError(CAL_TEXT.failUneven);
      }
      result = { ...est, noiseDb, gateDb: suggestGateDb(noiseDb), path: t.path || "second" };
      const ms = Math.round(est.latencyMs);
      render("result", {
        textNodes: [
          "Latency ", make("strong", "cal-num", `${ms} ms`),
          ` (${est.matched} of ${CLICKS} clicks heard). Room noise `, make("strong", "cal-num", fmtDb(noiseDb)),
          " → gate ", make("strong", "cal-num", fmtDb(result.gateDb)), ".",
        ],
      });
    } catch (e) {
      if (!alive()) return;
      abort();
      result = null;
      const text = e && e.calText ? e.calText
        : CAL_TEXT.failError + (e && e.message ? ` (${e.message}).` : ".");
      render("failed", { text: CAL_TEXT.fail + text });
    } finally {
      if (alive()) { stopTap(); }
    }
  }

  function save() {
    if (step !== "result" || !result) return;
    const r = result;
    const latencyMs = Math.min(500, Math.max(0, Math.round(r.latencyMs / 5) * 5));
    const gateSaved = !!(gateBox && gateBox.checked);
    settings.set("mic.latencyMs", latencyMs);
    if (gateSaved) settings.set("mic.gateThresholdDb", r.gateDb);
    result = null;
    render("saved", {
      text: `Saved: microphone latency ${latencyMs} ms` + (gateSaved
        ? `, noise gate ${fmtDb(r.gateDb)}.`
        : ". The noise gate was not changed."),
    });
    onSave({ latencyMs, matched: r.matched, spreadMs: r.spreadMs, noiseDb: r.noiseDb, gateDb: r.gateDb, gateSaved, path: r.path });
  }

  function start() {
    if (step === "silence" || step === "clicks") return;     // already measuring
    const why = calibrateUnavailable({ mic, settings });
    if (why) { abort(); result = null; render("unavailable", { text: why }); return; }
    measure();
  }

  // ---- events --------------------------------------------------------------------------------
  const actionOf = (target) => {
    let n = target;
    if (n && typeof n.closest === "function") n = n.closest("[data-cal]");
    else while (n && !(typeof n.getAttribute === "function" && n.getAttribute("data-cal") != null)) n = n.parentElement;
    return n && buttons.includes(n) ? n.getAttribute("data-cal") : null;
  };
  // After Cancel / Done the overlay closes the dialog ([data-ov-close]). The intro comes back on
  // the NEXT task: re-rendering now would detach the clicked button before the overlay runtime's
  // document listener looks up which overlay it belongs to, and the dialog would stay open.
  function introLater() {
    const at = renders;
    (win.setTimeout || globalThis.setTimeout)(() => { if (renders === at) render("intro", { text: CAL_TEXT.intro }); }, 0);
  }
  el.addEventListener("click", (ev) => {
    const act = actionOf(ev && ev.target);
    if (!act) return;
    if (act === "start" || act === "retry") start();
    else if (act === "save") save();
    else if (act === "cancel" || act === "done") {
      const busy = step === "silence" || step === "clicks" || !!tap;
      abort();
      if (busy) introLater();
    }
  });

  // Back, the scrim or any other close of the overlay: stop measuring at once.
  const MO = win && win.MutationObserver;
  if (typeof MO === "function") {
    try {
      new MO(() => {
        if (!shown() && (step === "silence" || step === "clicks" || tap)) { abort(); render("intro", { text: CAL_TEXT.intro }); }
      }).observe(el, { attributes: true, attributeFilter: ["class", "hidden"] });
    } catch (_) { /* no observer: close() from the overlay's onClose still works */ }
  }

  function open() {
    abort();
    result = null;
    const why = calibrateUnavailable({ mic, settings });
    if (why) render("unavailable", { text: why });
    else render("intro", { text: CAL_TEXT.intro });
  }

  return {
    open,
    get step() { return step; },
    /** Abort a measurement and stop the raw tap. Idempotent; safe as the overlay's onClose. */
    close() {
      const busy = step === "silence" || step === "clicks" || !!tap;
      abort();
      if (busy) render("intro", { text: CAL_TEXT.intro });
    },
    firstButton() { return buttons[0] || null; },
  };
}
