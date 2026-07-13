# Vendored third-party libraries

These files are **committed to the repo** and are the canonical runtime source for
the engine. The app never fetches them from a third-party site at runtime, so it
keeps working even if the upstream origin changes or goes offline. `serve.py` only
downloads a fallback copy if one is somehow missing from this folder.

| File | What it is | License |
|------|------------|---------|
| `spessasynth_lib.js` | SpessaSynth high-level library (`WorkletSynthesizer`, `Sequencer`, …) — ES module | Apache-2.0 |
| `spessasynth_core.js` | SpessaSynth core (SF2/DLS/MIDI); imported by the lib via the import map | Apache-2.0 |
| `spessasynth_processor.min.js` | SpessaSynth AudioWorklet processor (added via `addModule`) | Apache-2.0 |
| `pako.min.js` | zlib/deflate (used to inflate the raw-DEFLATE MIDI payloads) — UMD `window.pako` | MIT |

Full license texts live beside these files: **`spessasynth.LICENSE`** (Apache-2.0),
**`pako.LICENSE`** (MIT), plus a **`NOTICE`** attribution summary. All three
SpessaSynth files are redistributed **verbatim** (unmodified) from the upstream build.

## Provenance
- **SpessaSynth** — https://github.com/spessasus/SpessaSynth (Apache-2.0; core pinned
  at `spessasynth_core@4.0.18`). These three files are the self-contained build the app
  was verified against. To update, replace all three together with a matching build and
  re-run the browser verification. (Note: older SpessaSynth releases were MIT; the
  vendored 4.x build is Apache-2.0 — keep `spessasynth.LICENSE` in sync with whatever
  version you vendor.)
- **pako** — https://github.com/nodeca/pako (MIT).

## Not third-party
Everything under `../js/` (including `js/worklets/`) is this project's own code.
