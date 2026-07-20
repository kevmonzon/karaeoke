/*
 * midi-mixer.js — the "MIDI mode" channel mixer band.
 *
 * A panel between the lyrics and the transport bar (shown when body.midi-mode is
 * set) with one row per MIDI channel: [label] [volume] [mute] [solo] [VU]. Volume
 * drives the synth's per-channel CC7 (via AudioEngine.setChannelVolume); mute/solo
 * resolve to an effective per-channel mute; the VU bars are fed each frame by the
 * channel's real audio level (AudioEngine.getChannelLevels).
 *
 * All 16 channels are always shown; channels with no notes in the current song are
 * dimmed (.inactive). Per-song state is transient — every load() resets sliders to
 * 100%, clears mute/solo, and hands the mix back to the song (audio.releaseChannelMix).
 */

const NUM_CHANNELS = 16;

// General MIDI instrument *family* per program (program >> 3). Enough for a compact
// channel label without a full 128-name table. Channel 9 is always drums.
const GM_FAMILIES = [
  "Piano", "Chroma", "Organ", "Guitar", "Bass", "Strings", "Ensemble", "Brass",
  "Reed", "Pipe", "Lead", "Pad", "Synth FX", "Ethnic", "Perc", "FX",
];

/**
 * Pure: summarise the 16 MIDI channels of a parsed song for the mixer.
 * @returns {Array<{chan:number, active:boolean, noteCount:number, name:string}>}
 */
export function channelInfo(parsed) {
  const counts = new Array(NUM_CHANNELS).fill(0);
  const notes = (parsed && parsed.noteEvents) || [];
  for (const e of notes) if (e.on && e.chan >= 0 && e.chan < NUM_CHANNELS) counts[e.chan]++;
  const programs = (parsed && parsed.programByChannel) || [];
  return counts.map((noteCount, chan) => ({
    chan,
    active: noteCount > 0,
    noteCount,
    name: channelName(chan, programs[chan]),
  }));
}

function channelName(chan, program) {
  if (chan === 9) return "Drums"; // GM percussion channel
  if (program != null) return GM_FAMILIES[(program >> 3) & 0x0f];
  return `Ch ${chan + 1}`;
}

/**
 * @param {object} deps
 * @param {HTMLElement} deps.container  the #midi-mixer element
 * @param {object} deps.audio          the AudioEngine (per-channel mix + levels)
 * @returns {{ load, update, clear }}
 */
export function createMidiMixer({ container, audio }) {
  const rows = [];          // per-channel { root, label, vol, mute, solo, fill }
  const vols = new Array(NUM_CHANNELS).fill(1); // slider fraction per channel (0..1)
  const mutes = new Set();  // channels muted
  const solo = new Set();   // channels soloed
  const levels = new Float32Array(NUM_CHANNELS);

  // Effective level for a channel: 0 if muted or (something soloed and not this one),
  // else its slider value. Everything routes through CC7 (audio.setChannelVolume) so
  // both the audible mix and the VU tap stay consistent (see AudioEngine notes).
  const effective = (ch) =>
    (mutes.has(ch) || (solo.size > 0 && !solo.has(ch))) ? 0 : vols[ch];
  const apply = (ch) => audio.setChannelVolume(ch, effective(ch));
  const applyAll = () => { for (let ch = 0; ch < NUM_CHANNELS; ch++) apply(ch); };

  // Build the 16 rows once. Labels + dim state are filled in on load().
  for (let ch = 0; ch < NUM_CHANNELS; ch++) {
    const root = document.createElement("div");
    root.className = "mx-row";
    root.innerHTML =
      `<span class="mx-label"></span>` +
      `<input class="mx-vol" type="range" min="0" max="100" value="100" ` +
        `title="Channel ${ch + 1} volume" aria-label="Channel ${ch + 1} volume" />` +
      `<button class="mx-btn mx-mute" title="Mute">M</button>` +
      `<button class="mx-btn mx-solo" title="Solo">S</button>` +
      `<div class="mx-vu"><div class="mx-vu-mask"></div></div>`;
    const row = {
      root,
      label: root.querySelector(".mx-label"),
      vol: root.querySelector(".mx-vol"),
      mute: root.querySelector(".mx-mute"),
      solo: root.querySelector(".mx-solo"),
      mask: root.querySelector(".mx-vu-mask"),
    };
    row.vol.addEventListener("input", () => {
      vols[ch] = +row.vol.value / 100;
      apply(ch); // only affects audio if not muted / soloed-out
    });
    row.mute.addEventListener("click", () => {
      const on = !mutes.has(ch);
      row.mute.classList.toggle("on", on);
      if (on) mutes.add(ch); else mutes.delete(ch);
      apply(ch);
    });
    row.solo.addEventListener("click", () => {
      const on = !solo.has(ch);
      row.solo.classList.toggle("on", on);
      if (on) solo.add(ch); else solo.delete(ch);
      applyAll(); // solo changes every channel's effective level
    });
    rows.push(row);
    container.appendChild(root);
  }

  function load(parsed) {
    audio.releaseChannelMix(); // fresh song → hand the mix back to the song
    mutes.clear();
    solo.clear();
    vols.fill(1);
    const info = channelInfo(parsed);
    for (let ch = 0; ch < NUM_CHANNELS; ch++) {
      const r = rows[ch], ci = info[ch];
      r.label.textContent = `${ch + 1} · ${ci.name}`;
      r.root.classList.toggle("inactive", !ci.active);
      r.vol.value = 100;
      r.mute.classList.remove("on");
      r.solo.classList.remove("on");
      r.mask.style.width = "100%"; // empty meter
    }
  }

  // Per-frame: paint each channel's VU from its real audio level. Called from the
  // rAF loop only while the mixer is visible. The mask hides the unlit right part,
  // so a higher level = a narrower mask = more of the green→red track showing.
  function update() {
    audio.getChannelLevels(levels);
    for (let ch = 0; ch < NUM_CHANNELS; ch++) {
      // RMS is small; sqrt + scale, soft-clipped to a readable 0–100% bar length.
      const pct = Math.min(100, Math.sqrt(levels[ch]) * 140);
      rows[ch].mask.style.width = (100 - pct).toFixed(1) + "%";
    }
  }

  function clear() {
    mutes.clear();
    solo.clear();
    vols.fill(1);
    audio.releaseChannelMix();
    for (const r of rows) {
      r.vol.value = 100;
      r.mute.classList.remove("on");
      r.solo.classList.remove("on");
      r.mask.style.width = "100%";
    }
  }

  return { load, update, clear };
}
