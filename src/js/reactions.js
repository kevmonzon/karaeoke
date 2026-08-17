/*
 * reactions.js — the crowd noise a videoke box has a physical Applause button for.
 *
 * A guest taps an emoji on their phone; it floats up the HOST's screen, and 👏 also fires a
 * burst of applause synthesized in WebAudio (the app ships no audio files).
 *
 * REACTIONS is the single source of truth for the allowlist, imported by BOTH sides: the phone
 * (remote.js) renders the buttons from it, and the host (app.js) refuses anything not in it.
 * That matters — this text is drawn on a television from a stranger's phone, so it must never
 * be free-form, and the two ends must never be able to drift apart.
 */

/** The only emoji that may ever reach the host's screen. Both ends import this list. */
export const REACTIONS = ["👏", "🎉", "🔥", "❤️", "😂", "🙌"];

const MAX_FLOATING = 24;     // a spammer must not be able to bury the lyrics
const APPLAUSE_GAP_MS = 1500;

/**
 * @param {object} deps
 * @param {{get:(path:string)=>any}} deps.settings
 * @param {{ensureContext:()=>Promise<any>, ctx:AudioContext|null}} deps.audio  the shared engine
 */
export function createReactions({ settings, audio }) {
  // -Infinity, not 0: performance.now() starts near zero, so a 0 seed makes the FIRST clap of
  // the session fall inside its own throttle window and vanish for the first 1.5 s after load.
  let lastApplauseAt = -Infinity;

  function float(emoji) {
    const stage = document.querySelector(".stage");
    if (!stage) return;
    const live = stage.querySelectorAll(".reaction");
    if (live.length >= MAX_FLOATING) live[0].remove();
    const el = document.createElement("div");
    el.className = "reaction";
    el.textContent = emoji;
    el.style.left = `${6 + Math.random() * 88}%`;
    el.style.setProperty("--drift", `${Math.round((Math.random() * 2 - 1) * 70)}px`);
    el.addEventListener("animationend", () => el.remove(), { once: true });
    stage.appendChild(el);
    setTimeout(() => el.remove(), 4000); // belt-and-braces if the animation never runs
  }

  /** Applause, SYNTHESIZED — a few hundred filtered noise bursts stand in for a small crowd.
   *  Silent (rather than throwing) if the AudioContext has never been unlocked by a gesture;
   *  throttled so a rapid tapper can't machine-gun it. */
  async function applause() {
    if (!settings.get("reactions.sound")) return;
    const now = performance.now();
    if (now - lastApplauseAt < APPLAUSE_GAP_MS) return;
    lastApplauseAt = now;
    try {
      await audio.ensureContext();
      const ctx = audio.ctx;
      if (!ctx || ctx.state !== "running") return;
      const rate = ctx.sampleRate, len = Math.ceil(rate * 1.6);
      const buf = ctx.createBuffer(1, len, rate);
      const d = buf.getChannelData(0);
      for (let c = 0; c < 700; c++) {           // each "clap" is a short, fast-decaying burst
        const at = Math.floor(Math.random() * (len - 900));
        const n = 100 + Math.floor(Math.random() * 380);
        const amp = 0.25 + Math.random() * 0.75;
        for (let j = 0; j < n; j++) d[at + j] += (Math.random() * 2 - 1) * Math.pow(1 - j / n, 3) * amp;
      }
      for (let i = 0; i < len; i++) {           // swell in, decay out — a room reacting
        const p = i / len;
        d[i] *= (p < 0.12 ? p / 0.12 : Math.pow(1 - (p - 0.12) / 0.88, 1.6)) * 0.45;
      }
      const src = ctx.createBufferSource(); src.buffer = buf;
      const bp = ctx.createBiquadFilter(); bp.type = "bandpass"; bp.frequency.value = 1800; bp.Q.value = 0.7;
      const g = ctx.createGain(); g.gain.value = 0.6;
      src.connect(bp).connect(g).connect(ctx.destination);
      src.start();
    } catch (_) { /* no context, no applause — never break playback over a sound effect */ }
  }

  /** The host's whole entry point for a guest `react` command: gate, then present. */
  function handle(emoji) {
    if (!settings.get("reactions.enabled")) return false;
    if (!REACTIONS.includes(String(emoji))) return false;
    float(emoji);
    if (emoji === "👏") applause();
    return true;
  }

  return { float, applause, handle };
}
