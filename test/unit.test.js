/*
 * unit.test.js — a small set of tests for the pure functions (no browser needed).
 * Run with:  node --test    (or  npm test)
 *
 * Covers the logic most worth locking in: melody/key detection, pitch snapping,
 * the SMF parser, and the catalog URL builder. Rendering/audio classes (PitchGuide,
 * AudioEngine, MicEngine, LyricsEngine) need the DOM/Web Audio and aren't tested here.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { snapNote, detectKey, keyName, extractMelody } from "../src/js/melody.js";
import { parseMidi, makeTickToSeconds, buildLines } from "../src/js/lyrics.js";
import { detectChords, chordLabel, simplifySuffix, diatonicThird, simplifiedSuffix } from "../src/js/chords.js";
import { Catalog } from "../src/js/catalog.js";
import { channelInfo } from "../src/js/midi-mixer.js";
import { matchesQuery } from "../src/js/settings-ui.js";
import { pickRemoteBaseUrl, clampRemoteSetting, REMOTE_SETTABLE_PATHS } from "../src/js/remote-host.js";
import { parseLrc, parseVtt, parseSrt, parsePlainText, linesFromLyricFile, distributeLineTimes } from "../src/js/lyrics-formats.js";
import { syncClock, clockTime, SNAP_SEC } from "../src/js/sync-clock.js";
import { fairInsertIndex, countBy, queueEta, formatEta, DEFAULT_SONG_SEC } from "../src/js/queue-order.js";
import { yinPitch, MAX_HZ } from "../src/js/pitch-yin.js";
import { MediaEngineBase } from "../src/js/media-engine.js";
import { jsonStore, collectAppData, restoreAppData, clearAppData, listAppKeys, APP_PREFIX } from "../src/js/store.js";
import {
  foldSemitones, pitchCredit, markGolden, curveScore, scoreBand, Scorer,
} from "../src/js/scoring.js";
import { REACTIONS, createReactions } from "../src/js/reactions.js";
import { createDurationHints, DURATIONS_KEY } from "../src/js/duration-hints.js";
import { readFileSync } from "node:fs";

// --- snapNote ---------------------------------------------------------------
test("snapNote: chromatic rounds to the nearest semitone", () => {
  assert.equal(snapNote(60.4, { mode: "chromatic" }), 60);
  assert.equal(snapNote(60.7, { mode: "chromatic" }), 61);
});

test("snapNote: scale snaps into the key", () => {
  assert.equal(snapNote(61.3, { mode: "scale", key: 0, scale: "major" }), 62); // C#→D in C major
  assert.equal(snapNote(60.2, { mode: "scale", key: 0, scale: "major" }), 60); // C stays
});

test("snapNote: melody snaps to the nearest octave of the target pitch class", () => {
  assert.equal(snapNote(69.2, { mode: "melody", targetMidi: 72 }), 72); // pulled toward C
  assert.equal(snapNote(69.2, { mode: "melody", targetMidi: null }), 69.2); // no target → untouched
});

// --- keyName ----------------------------------------------------------------
test("keyName: full and short forms", () => {
  assert.equal(keyName(2, "major"), "D major");
  assert.equal(keyName(9, "minor", true), "A min");
});

// --- detectKey --------------------------------------------------------------
test("detectKey: trusts an explicit (non-default) key signature", () => {
  const k = detectKey({ keySig: { sf: 2, mi: 0 }, noteEvents: [] }); // 2 sharps, major = D
  assert.equal(k.keyPc, 2);
  assert.equal(k.mode, "major");
  assert.equal(k.source, "metadata");
});

test("detectKey: falls back to histogram analysis without a meta", () => {
  const notes = [];
  let tick = 0;
  const cmaj = [60, 62, 64, 65, 67, 69, 71, 72];
  for (const n of cmaj) {
    notes.push({ tick, chan: 0, note: n, on: true });
    notes.push({ tick: tick + 480, chan: 0, note: n, on: false });
    tick += 480;
  }
  for (let i = 0; i < 6; i++) { // extra tonic weight
    notes.push({ tick, chan: 0, note: 60, on: true });
    notes.push({ tick: tick + 480, chan: 0, note: 60, on: false });
    tick += 480;
  }
  const k = detectKey({ keySig: null, noteEvents: notes });
  assert.equal(k.source, "analysis");
  assert.ok(k.confidence > 0.5, `confidence ${k.confidence} should be > 0.5`);
});

// --- extractMelody ----------------------------------------------------------
test("extractMelody: picks the named, monophonic melody track", () => {
  const noteEvents = [];
  for (let i = 0; i < 24; i++) { // accompaniment on ch0/track0, low notes
    noteEvents.push({ tick: i * 240, track: 0, chan: 0, note: 48, on: true });
    noteEvents.push({ tick: i * 240 + 240, track: 0, chan: 0, note: 48, on: false });
  }
  for (let i = 0; i < 24; i++) { // melody on ch1/track1, vocal range, mono
    const n = 64 + (i % 5);
    noteEvents.push({ tick: i * 240, track: 1, chan: 1, note: n, on: true });
    noteEvents.push({ tick: i * 240 + 200, track: 1, chan: 1, note: n, on: false });
  }
  const parsed = { noteEvents, trackNames: ["Accomp", "Melody"], lyricEvents: [] };
  const mel = extractMelody(parsed, (t) => t / 480, -1);
  assert.equal(mel.hasMelody, true);
  assert.equal(mel.channel, 1);
});

// --- parseMidi --------------------------------------------------------------
test("parseMidi: reads ppqn, tempo, a lyric, and a note", () => {
  const p = parseMidi(buildMinimalMidi());
  assert.equal(p.ppqn, 480);
  assert.ok(p.tempoMap.length >= 1);
  assert.equal(p.lyricEvents.length, 1);
  assert.equal(p.lyricEvents[0].text, "la");
  assert.ok(p.noteEvents.some((e) => e.on && e.note === 60));
});

test("makeTickToSeconds: tick 0 → 0, later ticks advance", () => {
  const p = parseMidi(buildMinimalMidi());
  const t2s = makeTickToSeconds(p);
  assert.equal(t2s(0), 0);
  assert.ok(t2s(480) > 0);
});

// --- parseMidi: program change ----------------------------------------------
test("parseMidi: records the first program change per channel", () => {
  const p = parseMidi(buildProgramMidi());
  assert.equal(p.programByChannel[0], 40); // ch0: first program (40) wins over a later 41
  assert.equal(p.programByChannel[9], 24); // ch9 program captured independently
  assert.equal(p.programByChannel[1], null); // untouched channel stays null
});

// --- channelInfo (MIDI mixer) -----------------------------------------------
test("channelInfo: flags active channels, tags drums, names by GM family", () => {
  const parsed = {
    noteEvents: [
      { on: true, chan: 0 }, { on: true, chan: 0 }, { on: false, chan: 0 },
      { on: true, chan: 9 },
    ],
    programByChannel: [24, null, null, null, null, null, null, null, null, null,
                       null, null, null, null, null, null], // ch0 → Guitar family
  };
  const info = channelInfo(parsed);
  assert.equal(info.length, 16);
  assert.equal(info[0].active, true);
  assert.equal(info[0].noteCount, 2);      // note-offs don't count
  assert.equal(info[0].name, "Guitar");    // program 24 >> 3 = family 3
  assert.equal(info[9].active, true);
  assert.equal(info[9].name, "Drums");     // channel 9 is always percussion
  assert.equal(info[5].active, false);     // no notes
  assert.equal(info[5].name, "Ch 6");      // no program → 1-based fallback label
});

test("channelInfo: tolerates a parsed object with no note/program data", () => {
  const info = channelInfo({});
  assert.equal(info.length, 16);
  assert.ok(info.every((c) => c.active === false));
});

// --- matchesQuery (settings search) -----------------------------------------
test("matchesQuery: empty query matches everything", () => {
  assert.equal(matchesQuery("Reverb mix Microphone", ""), true);
  assert.equal(matchesQuery("anything", "   "), true);
});

test("matchesQuery: case-insensitive substring hit on label and section", () => {
  const text = "Reverb mix Microphone & voice effect hall space";
  assert.equal(matchesQuery(text, "reverb"), true);   // label
  assert.equal(matchesQuery(text, "MICRO"), true);    // section, partial + case-fold
  assert.equal(matchesQuery(text, "hall"), true);     // keyword synonym
});

test("matchesQuery: all tokens must be present (AND), else miss", () => {
  const text = "Offset Lyrics latency delay sync";
  assert.equal(matchesQuery(text, "offset latency"), true);   // both present
  assert.equal(matchesQuery(text, "offset reverb"), false);   // second token absent
  assert.equal(matchesQuery(text, "zzz"), false);
});

// --- Catalog.fileUrl --------------------------------------------------------
test("Catalog.fileUrl: percent-encodes each path segment", () => {
  assert.equal(Catalog.fileUrl({ file: "kar_raw/1 - A & B.mid" }), "/kar_raw/1%20-%20A%20%26%20B.mid");
  assert.equal(Catalog.fileUrl({ file: null }), null);
});

test("Catalog.fileUrl: a videos/ path encodes the same way", () => {
  assert.equal(
    Catalog.fileUrl({ file: "videos/9001 - A - B - International - VIDEO.mp4" }),
    "/videos/9001%20-%20A%20-%20B%20-%20International%20-%20VIDEO.mp4",
  );
});

// --- Catalog.load (merge MIDI + video, stable ids) --------------------------
// Stub global fetch so load() can be exercised without a server.
function stubFetch(map) {
  const prev = global.fetch;
  global.fetch = async (url) => {
    const key = String(url);
    if (key in map) return { ok: true, json: async () => map[key] };
    return { ok: false, status: 404, json: async () => [] };
  };
  return () => { global.fetch = prev; };
}

test("Catalog.load: merges MIDI + video and tags kind/id (collision-safe)", async () => {
  const restore = stubFetch({
    "/catalog.json": [
      { code: 1, name: "A", artistName: "X", langName: "OPM", type: "MIDI", file: "kar_raw/1.mid" },
    ],
    "/catalog-video.json": [
      { code: 1, name: "V", artistName: "Y", langName: "Intl", type: "VIDEO", file: "videos/1.mp4" },
    ],
  });
  const c = new Catalog();
  const n = await c.load();
  restore();
  assert.equal(n, 2);
  assert.equal(c.getById("midi:1").name, "A");
  assert.equal(c.getById("video:1").name, "V");
  assert.equal(c.getById("midi:1").kind, "midi");
  assert.equal(c.getById("video:1").kind, "video");
  assert.equal(c.get(1).kind, "midi"); // first match wins on a shared code
});

test("Catalog.load: blank-code videos get distinct file-based ids (no clobber)", async () => {
  const restore = stubFetch({
    "/catalog.json": [],
    "/catalog-video.json": [
      { code: "", name: "Clip A", artistName: "", langName: "", type: "VIDEO", file: "videos/Clip A.mp4" },
      { code: "", name: "Clip B", artistName: "", langName: "", type: "VIDEO", file: "videos/Clip B.mp4" },
    ],
  });
  const c = new Catalog();
  const n = await c.load();
  restore();
  assert.equal(n, 2);
  assert.equal(c.getById("video:videos/Clip A.mp4").name, "Clip A");
  assert.equal(c.getById("video:videos/Clip B.mp4").name, "Clip B");
  assert.notEqual(c.songs[0].id, c.songs[1].id); // distinct despite both blank codes
  assert.equal(c.get(""), undefined); // blank codes aren't dialable
});

test("Catalog.load: songs that SHARE a dial code are all kept, with distinct ids", async () => {
  const restore = stubFetch({
    "/catalog.json": [
      { code: 5, name: "A", type: "MIDI", file: "kar_raw/5 - X - A.mid" },
      { code: 5, name: "B", type: "MIDI", file: "kar_raw/5 - Y - B.mid" },
    ],
  });
  const c = new Catalog();
  const n = await c.load();
  restore();
  assert.equal(n, 2);                            // BOTH kept — no drop on a shared code
  assert.equal(c.search("5").length, 2);         // both searchable by that code
  assert.equal(c.getById("midi:5").name, "A");   // first keeps the plain kind:code id (back-compat)
  assert.equal(c.getById("midi:kar_raw/5 - Y - B.mid").name, "B"); // dupe → file-path id
  assert.notEqual(c.songs[0].id, c.songs[1].id); // distinct → highlight/favorites/session work
  assert.equal(c.get(5).name, "A");              // numeric dial-search resolves to the first match
});

// --- Catalog.search (token-AND across fields + ranking) ---------------------
async function loadCatalog(songs) {
  const restore = stubFetch({ "/catalog.json": songs });
  const c = new Catalog();
  await c.load();
  restore();
  return c;
}

test("Catalog.search: token-AND matches across fields, order-independent (beer itchyworms)", async () => {
  const c = await loadCatalog([
    { code: 10, name: "Beer", artistName: "The Itchyworms", langName: "OPM", type: "MIDI", file: "kar_raw/10.mid" },
    { code: 11, name: "Pariwara", artistName: "The Itchyworms", langName: "OPM", type: "MIDI", file: "kar_raw/11.mid" },
    { code: 12, name: "Beer Belly", artistName: "Someone Else", langName: "Intl", type: "MIDI", file: "kar_raw/12.mid" },
  ]);
  assert.equal(c.search("beer itchyworms").length, 1);          // spans title + artist
  assert.equal(c.search("beer itchyworms")[0].name, "Beer");
  assert.equal(c.search("itchyworms beer").length, 1);          // word order doesn't matter
  assert.equal(c.search("itchy beer")[0].name, "Beer");         // partial tokens
  assert.equal(c.search("itchyworms").length, 2);               // artist-only → both Itchyworms songs
  assert.equal(c.search("beer nomatch").length, 0);             // every token must hit
});

test("Catalog.search: ranks exact/prefix title above looser matches", async () => {
  const c = await loadCatalog([
    { code: 1, name: "Better Days", artistName: "X", type: "MIDI", file: "kar_raw/1.mid" },
    { code: 2, name: "Bet", artistName: "Y", type: "MIDI", file: "kar_raw/2.mid" },
    { code: 3, name: "You Bet Your Life", artistName: "Z", type: "MIDI", file: "kar_raw/3.mid" },
  ]);
  const r = c.search("bet");
  assert.equal(r.length, 3);          // all contain "bet"
  assert.equal(r[0].name, "Bet");     // exact title ranked first
});

test("Catalog.search: numeric query is a dial-code prefix; empty → all", async () => {
  const c = await loadCatalog([
    { code: 5, name: "Five", artistName: "A", type: "MIDI", file: "kar_raw/5.mid" },
    { code: 51, name: "FiftyOne", artistName: "B", type: "MIDI", file: "kar_raw/51.mid" },
  ]);
  assert.equal(c.search("5").length, 2);              // prefix 5 → 5 and 51
  assert.equal(c.search("51")[0].name, "FiftyOne");
  assert.equal(c.search("").length, 2);               // empty → all
});

test("Catalog.load: a missing/invalid video catalog is non-fatal", async () => {
  const restore = stubFetch({
    "/catalog.json": [{ code: 5, name: "Solo", type: "MIDI", file: "kar_raw/5.mid" }],
  }); // no /catalog-video.json → 404
  const c = new Catalog();
  const n = await c.load();
  restore();
  assert.equal(n, 1);
  assert.equal(c.getById("midi:5").id, "midi:5");
});

// --- Catalog.makeYoutubeRecord + addExternal --------------------------------
test("Catalog.makeYoutubeRecord: builds a tagged youtube record from a search item", () => {
  const rec = Catalog.makeYoutubeRecord({ videoId: "abc123", title: "Song (Karaoke)", channelTitle: "Some Channel" });
  assert.equal(rec.kind, "youtube");
  assert.equal(rec.id, "youtube:abc123");
  assert.equal(rec.videoId, "abc123");
  assert.equal(rec.name, "Song (Karaoke)");
  assert.equal(rec.artistName, "Some Channel");
  assert.equal(rec.code, "");            // no dial code → excluded from numeric search / byCode
  assert.equal(rec.type, "YOUTUBE");
});

test("Catalog.makeYoutubeRecord: returns null without a videoId", () => {
  assert.equal(Catalog.makeYoutubeRecord({ title: "no id" }), null);
  assert.equal(Catalog.makeYoutubeRecord(null), null);
});

test("Catalog.addExternal: resolvable by id, but NOT in the browse list", () => {
  const c = new Catalog();
  const rec = Catalog.makeYoutubeRecord({ videoId: "xyz", title: "T", channelTitle: "C" });
  c.addExternal(rec);
  assert.equal(c.getById("youtube:xyz"), rec); // favorites/recent/queue can resolve it
  assert.equal(c.songs.length, 0);             // …but it never pollutes the default song list
  assert.equal(c.search("").length, 0);        // and it isn't returned by search
});

// ---------------------------------------------------------------------------
// A minimal, valid Standard MIDI File: format 0, 1 track, division 480, with a
// tempo, a lyric ("la"), and a C4 note.
function buildMinimalMidi() {
  const bytes = [];
  const str = (s) => { for (const c of s) bytes.push(c.charCodeAt(0)); };
  str("MThd"); bytes.push(0, 0, 0, 6, 0, 0, 0, 1, 0x01, 0xe0); // len6, fmt0, 1 trk, div 480

  const trk = [
    0x00, 0xff, 0x51, 0x03, 0x07, 0xa1, 0x20, // tempo 500000
    0x00, 0xff, 0x05, 0x02, 0x6c, 0x61,       // lyric "la"
    0x00, 0x90, 0x3c, 0x64,                   // note on  C4 v100
    0x83, 0x60, 0x80, 0x3c, 0x00,             // +480: note off C4
    0x00, 0xff, 0x2f, 0x00,                   // end of track
  ];
  str("MTrk");
  const len = trk.length;
  bytes.push((len >> 24) & 255, (len >> 16) & 255, (len >> 8) & 255, len & 255);
  for (const b of trk) bytes.push(b);
  return new Uint8Array(bytes).buffer;
}

// A one-track MIDI with program changes on ch0 (twice) and ch9, plus a note on each.
function buildProgramMidi() {
  const bytes = [];
  const str = (s) => { for (const c of s) bytes.push(c.charCodeAt(0)); };
  str("MThd"); bytes.push(0, 0, 0, 6, 0, 0, 0, 1, 0x01, 0xe0); // fmt0, 1 trk, div 480

  const trk = [
    0x00, 0xc0, 0x28,             // program change ch0 → 40 (first — should win)
    0x00, 0xc9, 0x18,             // program change ch9 → 24
    0x00, 0xc0, 0x29,             // program change ch0 → 41 (ignored; first wins)
    0x00, 0x90, 0x3c, 0x64,       // note on  ch0
    0x00, 0x99, 0x24, 0x64,       // note on  ch9
    0x81, 0x00, 0x80, 0x3c, 0x00, // +128: note off ch0
    0x00, 0xff, 0x2f, 0x00,       // end of track
  ];
  str("MTrk");
  const len = trk.length;
  bytes.push((len >> 24) & 255, (len >> 16) & 255, (len >> 8) & 255, len & 255);
  for (const b of trk) bytes.push(b);
  return new Uint8Array(bytes).buffer;
}

// --- chords -----------------------------------------------------------------
// chordLabel: pitch-class → name, with live transpose (the Key control).
test("chordLabel: names roots in sharps and transposes", () => {
  assert.equal(chordLabel(0, ""), "C");
  assert.equal(chordLabel(2, "m"), "Dm");
  assert.equal(chordLabel(9, "7"), "A7");
  assert.equal(chordLabel(0, "", 2), "D");   // +2 semitones
  assert.equal(chordLabel(11, "", 1), "C");  // B +1 wraps to C
  assert.equal(chordLabel(2, "", -2), "C");  // D −2
});

// simplifySuffix: collapse extensions to the strummer's triad, keep minor.
test("simplifySuffix: 7/sus4/'' → '' ; m stays", () => {
  assert.equal(simplifySuffix("7"), "");
  assert.equal(simplifySuffix("sus4"), "");
  assert.equal(simplifySuffix(""), "");
  assert.equal(simplifySuffix("m"), "m");
});

// detectChords: block chords on one channel (harmony) + a monophonic line on
// another (the melody, which detection excludes) → the right roots come out.
function chordTestParsed() {
  const ppqn = 480, bar = ppqn * 4; // 4/4 → 1920 ticks/bar
  const noteEvents = [];
  const span = (chan, note, start, end) => {
    noteEvents.push({ tick: start, track: 0, chan, note, on: true });
    noteEvents.push({ tick: end, track: 0, chan, note, on: false });
  };
  // ch0 harmony: bar0 = C major (C4 E4 G4 + bass C2), bar1 = G major (G3 B3 D4 + bass G2)
  for (const n of [60, 64, 67, 36]) span(0, n, 0, bar);
  for (const n of [55, 59, 62, 43]) span(0, n, bar, bar * 2);
  // ch1 melody: 8 monophonic quarter notes (so extractMelody picks ch1, not the chords)
  const mel = [72, 74, 76, 77, 79, 77, 76, 74];
  mel.forEach((n, i) => span(1, n, i * ppqn, (i + 1) * ppqn));
  return {
    ppqn, isSmpte: false,
    tempoMap: [{ tick: 0, usPerQuarter: 500000 }],
    noteEvents, trackNames: [], keySig: null, timeSig: { num: 4, den: 4 },
  };
}

test("detectChords: recovers C then G from a two-bar harmony", () => {
  const { chords } = detectChords(chordTestParsed());
  assert.ok(chords.length >= 2, `expected ≥2 chords, got ${chords.length}`);
  assert.equal(chordLabel(chords[0].root, chords[0].suf), "C");
  assert.equal(chordLabel(chords[1].root, chords[1].suf), "G");
  // times are seconds, ascending (500000 µs/qn @ 480 ppqn → bar = 2.0 s)
  assert.ok(chords[1].time > chords[0].time);
});

test("detectChords: no notes → empty, no throw", () => {
  const { chords } = detectChords({
    ppqn: 480, isSmpte: false, tempoMap: [{ tick: 0, usPerQuarter: 500000 }],
    noteEvents: [], trackNames: [], keySig: null, timeSig: null,
  });
  assert.deepEqual(chords, []);
});

// diatonicThird: the third the key implies for a root.
test("diatonicThird: reads major/minor from the key set", () => {
  const D = new Set([2, 4, 6, 7, 9, 11, 1]); // D major {D E F# G A B C#}
  assert.equal(diatonicThird(9, D), "");   // A in D major → major (V)
  assert.equal(diatonicThird(4, D), "m");  // E in D major → minor (ii)
  assert.equal(diatonicThird(6, D), "m");  // F# in D major → minor (iii)
  assert.equal(diatonicThird(3, D), null); // D# is non-diatonic → unknown
});

// simplifiedSuffix: corrects a thirdless power chord via the key; else collapses.
test("simplifiedSuffix: power chord → diatonic triad (confident key)", () => {
  const D = new Set([2, 4, 6, 7, 9, 11, 1]);
  // a bare E power chord mis-labelled sus4, in confident D major → Em (the ii)
  assert.equal(simplifiedSuffix({ root: 4, suf: "sus4", powerless: true }, D, 0.95), "m");
  // a real minor chord (not powerless) keeps m — the faint-key path isn't taken
  assert.equal(simplifiedSuffix({ root: 4, suf: "m", powerless: false }, D, 0.95), "m");
  // low key confidence → no correction, plain collapse (7 → "")
  assert.equal(simplifiedSuffix({ root: 4, suf: "7", powerless: true }, D, 0.5), "");
});

// The default (faithful) chord list must be unaffected by the simplify machinery:
// detectChords still emits the same root/suf, now carrying a `powerless` flag + key set.
test("detectChords: still emits roots + now a key set / confidence", () => {
  const ppqn = 480, bar = ppqn * 4;
  const noteEvents = [];
  const span = (chan, note, s, e) => {
    noteEvents.push({ tick: s, track: 0, chan, note, on: true });
    noteEvents.push({ tick: e, track: 0, chan, note, on: false });
  };
  for (const n of [60, 64, 67, 36]) span(0, n, 0, bar);      // C major
  for (const n of [55, 59, 62, 43]) span(0, n, bar, bar * 2); // G major
  [72, 74, 76, 77, 79, 77, 76, 74].forEach((n, i) => span(1, n, i * ppqn, (i + 1) * ppqn));
  const r = detectChords({
    ppqn, isSmpte: false, tempoMap: [{ tick: 0, usPerQuarter: 500000 }],
    noteEvents, trackNames: [], keySig: null, timeSig: { num: 4, den: 4 },
  });
  assert.equal(chordLabel(r.chords[0].root, r.chords[0].suf), "C");
  assert.equal(chordLabel(r.chords[1].root, r.chords[1].suf), "G");
  assert.ok(r.keySet instanceof Set && r.keySet.size === 7); // a 7-note diatonic set
  assert.ok(r.keyConf > 0 && r.keyConf <= 1);
  assert.ok("powerless" in r.chords[0]); // flag present for the simplify path
});

// --- pickRemoteBaseUrl (phone-remote QR base URL) ---------------------------
test("pickRemoteBaseUrl: explicit override wins and is trimmed", () => {
  assert.equal(
    pickRemoteBaseUrl("https://karaoke.example.com/", "http://127.0.0.1:8080", "http://192.168.1.5:8080"),
    "https://karaoke.example.com");
});
test("pickRemoteBaseUrl: a non-loopback page origin is used (LAN IP / cloudflared)", () => {
  assert.equal(pickRemoteBaseUrl("", "http://192.168.1.20:8080", "http://192.168.1.5:8080"),
    "http://192.168.1.20:8080");
  assert.equal(pickRemoteBaseUrl("", "https://abc.trycloudflare.com", "http://192.168.1.5:8080"),
    "https://abc.trycloudflare.com");
});
test("pickRemoteBaseUrl: loopback page origin falls back to the server LAN URL", () => {
  assert.equal(pickRemoteBaseUrl("", "http://127.0.0.1:8080", "http://192.168.1.5:8080"),
    "http://192.168.1.5:8080");
  assert.equal(pickRemoteBaseUrl("", "http://localhost:8080", "http://10.0.0.2:8080"),
    "http://10.0.0.2:8080");
  assert.equal(pickRemoteBaseUrl("  ", "http://[::1]:8080", "http://10.0.0.2:8080"),
    "http://10.0.0.2:8080");
});
test("pickRemoteBaseUrl: loopback + no LAN URL yields empty string", () => {
  assert.equal(pickRemoteBaseUrl("", "http://localhost:8080", ""), "");
});

// --- clampRemoteSetting (a guest `setting` command's VALUE, not just its path) ------
// The phone UI clamps client-side; a raw POST from anything else on the LAN does not, and
// audio.volume goes straight to a GainNode. `undefined` is the reject sentinel because 0,
// false and -12 are all legitimate stored values.
test("clampRemoteSetting: clamps each path to its own range", () => {
  assert.equal(clampRemoteSetting("audio.volume", 1e6), 2);      // the deafen-the-room case
  assert.equal(clampRemoteSetting("audio.volume", -5), 0);
  assert.equal(clampRemoteSetting("audio.volume", 1.25), 1.25);  // in range → untouched
  assert.equal(clampRemoteSetting("audio.key", 999999999), 12);
  assert.equal(clampRemoteSetting("audio.key", -99), -12);
  assert.equal(clampRemoteSetting("audio.tempo", 40), 1.5);
  assert.equal(clampRemoteSetting("audio.tempo", 0.1), 0.5);
  assert.equal(clampRemoteSetting("lyrics.offsetMs", 99999), 2000);
  assert.equal(clampRemoteSetting("lyrics.offsetMs", -99999), -2000);
});
test("clampRemoteSetting: integer paths round, and legitimate zero/false survive", () => {
  assert.equal(clampRemoteSetting("audio.key", 3.7), 4);
  assert.equal(clampRemoteSetting("lyrics.offsetMs", -50.4), -50);
  assert.equal(clampRemoteSetting("audio.key", 0), 0);          // not rejected
  assert.equal(clampRemoteSetting("audio.volume", 0), 0);       // not rejected
  assert.equal(clampRemoteSetting("guide.vocal.mute", false), false);
  assert.equal(clampRemoteSetting("guide.vocal.mute", true), true);
});
test("clampRemoteSetting: rejects unknown paths and junk values with undefined", () => {
  assert.equal(clampRemoteSetting("mic.volume", 1), undefined);        // not allowlisted
  assert.equal(clampRemoteSetting("__proto__", 1), undefined);
  assert.equal(clampRemoteSetting("audio.volume", "loud"), undefined); // wrong type
  assert.equal(clampRemoteSetting("audio.volume", NaN), undefined);
  assert.equal(clampRemoteSetting("audio.volume", Infinity), undefined);
  assert.equal(clampRemoteSetting("audio.volume", null), undefined);
  assert.equal(clampRemoteSetting("guide.vocal.mute", "yes"), undefined); // bool path, string value
  assert.equal(clampRemoteSetting("guide.vocal.mute", 1), undefined);
});
test("clampRemoteSetting: every allowlisted path is actually validatable", () => {
  // Guards the allowlist and the range table against drifting apart — a path with no range
  // would silently become un-settable, a range with no path would be dead code.
  for (const p of REMOTE_SETTABLE_PATHS) {
    const v = clampRemoteSetting(p, p === "guide.vocal.mute" ? true : 0);
    assert.notEqual(v, undefined, `${p} should accept a legal value`);
  }
});

// --- Catalog.lyricsUrl (AUDIO sidecar) --------------------------------------
test("Catalog.lyricsUrl: percent-encodes the sidecar path; null when absent", () => {
  assert.equal(
    Catalog.lyricsUrl({ lyrics: "audio_lyrics/9700 - Adele - Hello.lrc" }),
    "/audio_lyrics/9700%20-%20Adele%20-%20Hello.lrc",
  );
  assert.equal(Catalog.lyricsUrl({ file: "audio_lyrics/x.mp3" }), null); // no lyrics field
  assert.equal(Catalog.lyricsUrl({ lyrics: null }), null);
});

// --- Catalog.load merges the 3rd (audio) catalog ----------------------------
test("Catalog.load: merges the audio catalog, tags kind/id audio:<code>, keeps lyrics", async () => {
  const restore = stubFetch({
    "/catalog.json": [{ code: 1, name: "M", type: "MIDI", file: "kar_raw/1.mid" }],
    "/catalog-audio.json": [
      { code: 1, name: "A", type: "AUDIO", file: "audio_lyrics/1.mp3", lyrics: "audio_lyrics/1.lrc" },
    ],
  });
  const c = new Catalog();
  const n = await c.load();
  restore();
  assert.equal(n, 2);
  assert.equal(c.getById("audio:1").kind, "audio");
  assert.equal(c.getById("audio:1").lyrics, "audio_lyrics/1.lrc");
  assert.equal(c.getById("midi:1").name, "M");   // MIDI + AUDIO share code 1, distinct ids
  assert.equal(c.get(1).kind, "midi");           // MIDI still wins numeric lookup
});

// --- lyrics-formats: LRC ----------------------------------------------------
test("parseLrc: line timestamps become timed lines (synced)", () => {
  const { lines, synced } = parseLrc("[ti:x]\n[00:12.00]hello world\n[00:15.50]next line");
  assert.equal(synced, true);
  assert.equal(lines.length, 2);
  assert.equal(lines[0].start, 12);
  assert.equal(lines[0].syllables[0].text, "hello world");
  assert.equal(lines[1].start, 15.5);
});

test("parseLrc: enhanced <mm:ss.xx> word timing → per-word syllables", () => {
  const { lines } = parseLrc("[00:10.00]<00:10.00>I <00:10.50>was <00:11.00>here");
  assert.equal(lines[0].syllables.length, 3);
  assert.equal(lines[0].syllables[0].time, 10);
  assert.equal(lines[0].syllables[1].time, 10.5);
  assert.equal(lines[0].syllables[2].text, "here");
});

test("parseLrc: [offset] shifts every time exactly once", () => {
  const { lines } = parseLrc("[offset:+200]\n[00:12.00]hi");
  assert.equal(Math.round(lines[0].start * 1000), 12200);
  assert.equal(Math.round(lines[0].syllables[0].time * 1000), 12200);
});

test("parseLrc: one line, multiple timestamps → repeated lines", () => {
  const { lines } = parseLrc("[00:05.00][00:09.00]chorus");
  assert.equal(lines.length, 2);
  assert.deepEqual(lines.map((l) => l.start), [5, 9]);
});

// --- lyrics-formats: VTT / SRT ----------------------------------------------
test("parseVtt: cue start times, tags stripped", () => {
  const { lines, synced } = parseVtt("WEBVTT\n\n00:00:12.000 --> 00:00:15.000\nHello <b>there</b>");
  assert.equal(synced, true);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].start, 12);
  assert.equal(lines[0].syllables[0].text, "Hello there");
});

test("parseSrt: comma-millis timing + mm:ss forms", () => {
  const { lines } = parseSrt("1\n00:00:12,000 --> 00:00:15,000\nline one\n\n2\n00:00:15,500 --> 00:00:18,000\nline two");
  assert.deepEqual(lines.map((l) => l.start), [12, 15.5]);
  assert.equal(lines[1].syllables[0].text, "line two");
});

// --- lyrics-formats: plain text + dispatch ----------------------------------
test("parsePlainText: keeps non-empty lines, flags synced:false", () => {
  const { lines, synced } = parsePlainText("one\n\n  two  \nthree");
  assert.equal(synced, false);
  assert.deepEqual(lines.map((l) => l.syllables[0].text), ["one", "two", "three"]);
});

test("linesFromLyricFile: dispatches by extension (leading dot optional)", () => {
  assert.equal(linesFromLyricFile("lrc", "[00:01.00]x").synced, true);
  assert.equal(linesFromLyricFile(".srt", "1\n00:00:01,000 --> 00:00:02,000\nx").synced, true);
  assert.equal(linesFromLyricFile("txt", "a\nb").synced, false);
  assert.equal(linesFromLyricFile("unknown", "a\nb").synced, false); // fallback → plain text
});

// --- buildLines exported (lyrics-only .kar/.mid sidecar path) ----------------
test("buildLines: groups KAR syllables into a timed line", () => {
  const t2s = (tick) => tick / 1000; // trivial tick→sec for the test
  const events = [
    { tick: 0, type: 0x05, text: "Hel" },
    { tick: 500, type: 0x05, text: "lo" },
    { tick: 1000, type: 0x05, text: "/world" },
  ];
  const lines = buildLines(events, t2s);
  assert.equal(lines.length, 2);
  assert.deepEqual(lines[0].syllables.map((s) => s.text), ["Hel", "lo"]);
  assert.equal(lines[1].syllables[0].text, "world");
});

// --- distributeLineTimes (unsynced .txt pacing; shared host ↔ phone) ---------
test("distributeLineTimes: paces unsynced lines across the duration", () => {
  const { lines } = parsePlainText("a\nb\nc\nd");
  distributeLineTimes(lines, 100);
  const lead = Math.min(3, 100 * 0.05);              // 3 s lead-in
  assert.equal(lines[0].start, lead);
  assert.equal(lines[0].syllables[0].time, lead);    // the syllable rides the line
  assert.ok(lines[3].start > lines[2].start && lines[3].start < 100);
  const gaps = [1, 2, 3].map((i) => lines[i].start - lines[i - 1].start);
  assert.ok(Math.max(...gaps) - Math.min(...gaps) < 1e-9); // evenly spread
});

test("distributeLineTimes: falls back to ~1 s/line without a duration", () => {
  const { lines } = parsePlainText("a\nb\nc");
  distributeLineTimes(lines, 0);
  assert.ok(lines[2].start > lines[0].start && lines[2].start < 3);
  distributeLineTimes([], 100);                      // empty input must not throw
});

// --- sync-clock (the phone's lyric clock; see src/js/sync-clock.js) ----------
test("syncClock: first sample corrects the position by the snapshot's age", () => {
  const c = syncClock(null, { position: 10, age: 0.4, paused: false, rate: 1, songId: "midi:1", at: 1000 });
  assert.equal(c.base, 10.4);                        // the snapshot was already 0.4 s stale
  assert.equal(clockTime(c, 1000), 10.4);
  assert.ok(Math.abs(clockTime(c, 2000) - 11.4) < 1e-9); // free-runs a second later
});

test("clockTime: extrapolation follows the playback rate, and freezes when paused", () => {
  const fast = syncClock(null, { position: 10, age: 0, paused: false, rate: 1.5, songId: "s", at: 0 });
  assert.ok(Math.abs(clockTime(fast, 2000) - 13) < 1e-9);   // 2 s wall × 1.5 = 3 s of song
  const held = syncClock(null, { position: 10, age: 5, paused: true, rate: 1, songId: "s", at: 0 });
  assert.equal(held.base, 10);                              // a paused host doesn't age forward
  assert.equal(clockTime(held, 99999), 10);
});

test("syncClock: small drift is eased, not snapped (no visible stutter)", () => {
  const a = syncClock(null, { position: 10, age: 0, paused: false, rate: 1, songId: "s", at: 0 });
  // One second later the host reports 10.9 — 100 ms behind our free-running 11.0.
  const b = syncClock(a, { position: 10.9, age: 0, paused: false, rate: 1, songId: "s", at: 1000 });
  const now = clockTime(b, 1000);
  assert.ok(now < 11 && now > 10.9, `eased toward the target, got ${now}`);
});

test("syncClock: a seek, a song change or a pause flip snaps immediately", () => {
  const a = syncClock(null, { position: 10, age: 0, paused: false, rate: 1, songId: "s", at: 0 });
  const seek = syncClock(a, { position: 90, age: 0, paused: false, rate: 1, songId: "s", at: 0 });
  assert.equal(seek.base, 90);                              // > SNAP_SEC error → snap
  assert.ok(SNAP_SEC > 0 && SNAP_SEC < 1);
  const swap = syncClock(a, { position: 0, age: 0, paused: false, rate: 1, songId: "other", at: 0 });
  assert.equal(swap.base, 0);                               // new song → no easing from the old one
  const paused = syncClock(a, { position: 10.2, age: 0, paused: true, rate: 1, songId: "s", at: 0 });
  assert.equal(paused.base, 10.2);
});

test("syncClock: junk input can't fling the clock", () => {
  const c = syncClock(null, { position: 5, age: -3, paused: false, rate: 0, songId: "s", at: 0 });
  assert.equal(c.base, 5);      // negative age ignored
  assert.equal(c.rate, 1);      // a 0/absent rate falls back to 1×
  const d = syncClock(null, { position: undefined, age: undefined, paused: false, at: 0 });
  assert.equal(d.base, 0);
  assert.equal(clockTime(null, 123), 0);
});

// --- scoring (the videoke score) --------------------------------------------
// The maths that decides whether a room cheers. The behaviours pinned here are the ones
// that make it FEEL right, not just compute — see the rationale block in scoring.js.
test("foldSemitones: the octave does not matter", () => {
  assert.equal(foldSemitones(60, 60), 0);
  assert.equal(foldSemitones(72, 60), 0);      // an octave up is still the right note
  assert.equal(foldSemitones(48, 60), 0);      // …and an octave down
  assert.equal(foldSemitones(61, 60), 1);
  assert.equal(foldSemitones(59, 60), -1);
  assert.equal(foldSemitones(67, 60), -5);     // folded to the near side (a fifth up = 5 down)
  assert.equal(Math.abs(foldSemitones(66, 60)), 6);
});

test("pitchCredit: full inside the window, decaying to zero — never a cliff", () => {
  assert.equal(pitchCredit(0), 1);
  assert.equal(pitchCredit(0.5), 1);
  assert.equal(pitchCredit(-0.5), 1);
  assert.equal(pitchCredit(2.5), 0);
  assert.equal(pitchCredit(9), 0);
  const mid = pitchCredit(1.5);
  assert.ok(mid > 0 && mid < 1);
  assert.ok(pitchCredit(1) > pitchCredit(2));  // monotonic decay
});

test("markGolden: the longest notes become the hooks", () => {
  const notes = [
    { note: 60, start: 0, end: 0.2 },
    { note: 62, start: 1, end: 4 },   // longest
    { note: 64, start: 5, end: 5.2 },
    { note: 65, start: 6, end: 6.1 },
  ];
  const g = markGolden(notes, 0.25);
  assert.deepEqual(g, [false, true, false, false]);
  assert.deepEqual(markGolden([], 0.5), []);
  assert.deepEqual(markGolden(notes, 0), [false, false, false, false]);
});

test("curveScore + scoreBand: generous in the middle, Magic Sing's bands", () => {
  assert.equal(curveScore(0), 0);
  assert.equal(curveScore(1), 100);
  assert.ok(curveScore(0.5) > 50);            // the curve lifts an honest amateur
  assert.equal(curveScore(-1), 0);            // clamped
  assert.equal(curveScore(9), 100);
  assert.equal(scoreBand(100).tier, "excellent");
  assert.equal(scoreBand(96).tier, "excellent");
  assert.equal(scoreBand(90).tier, "good");
  assert.equal(scoreBand(75).tier, "ok");
  assert.equal(scoreBand(40).tier, "meh");
  assert.equal(scoreBand(0).tier, "none");
});

test("Scorer: perfect singing scores 100, an octave off still scores 100", () => {
  const notes = [{ note: 60, start: 0, end: 1 }, { note: 62, start: 1, end: 2 }];
  const perfect = new Scorer(notes, { golden: false });
  for (let t = 0; t < 1; t += 0.1) perfect.addFrame(t, 60);
  for (let t = 1; t < 2; t += 0.1) perfect.addFrame(t, 62);
  assert.equal(perfect.finish().score, 100);

  const octave = new Scorer(notes, { golden: false });
  for (let t = 0; t < 1; t += 0.1) octave.addFrame(t, 48);
  for (let t = 1; t < 2; t += 0.1) octave.addFrame(t, 74);
  assert.equal(octave.finish().score, 100);
});

test("Scorer: silence is neutral, but a note never sung still costs you", () => {
  const notes = [{ note: 60, start: 0, end: 1 }, { note: 62, start: 1, end: 2 }];
  const s = new Scorer(notes, { golden: false });
  for (let t = 0; t < 1; t += 0.1) s.addFrame(t, 60);   // first note nailed
  for (let t = 1; t < 2; t += 0.1) s.addFrame(t, null); // breathed through the second
  const res = s.finish();
  assert.equal(res.sung, 1);
  assert.ok(res.score > 40 && res.score < 100);          // half the song → not a zero, not a win
  // A frame of silence must not be counted as a wrong note on the FIRST note either.
  assert.equal(s.noteRatio(0), 1);
});

test("Scorer: unvoiced-only or no melody yields no result at all", () => {
  const notes = [{ note: 60, start: 0, end: 1 }];
  const quiet = new Scorer(notes);
  for (let t = 0; t < 1; t += 0.1) quiet.addFrame(t, null);
  assert.equal(quiet.finish(), null);                    // nobody sang → no card
  assert.equal(new Scorer([]).finish(), null);
  assert.equal(new Scorer(null).hasMelody, false);
});

test("Scorer: golden notes are worth double", () => {
  // Two notes of equal length; the scorer is told note 0 is golden by making it longest.
  const notes = [{ note: 60, start: 0, end: 3 }, { note: 62, start: 3, end: 4 }];
  const hitLong = new Scorer(notes, { goldenFraction: 0.5 });
  for (let t = 0; t < 3; t += 0.1) hitLong.addFrame(t, 60);   // the golden note, nailed
  for (let t = 3; t < 4; t += 0.1) hitLong.addFrame(t, 70);   // the other, badly missed
  const hitShort = new Scorer(notes, { goldenFraction: 0.5 });
  for (let t = 0; t < 3; t += 0.1) hitShort.addFrame(t, 70);  // golden note missed
  for (let t = 3; t < 4; t += 0.1) hitShort.addFrame(t, 62);  // the other nailed
  assert.ok(hitLong.finish().score > hitShort.finish().score);
});

test("Scorer: noteIndexAt finds the note, and gaps between phrases score nothing", () => {
  const s = new Scorer([{ note: 60, start: 0, end: 1 }, { note: 62, start: 5, end: 6 }]);
  assert.equal(s.noteIndexAt(0.5), 0);
  assert.equal(s.noteIndexAt(5.5), 1);
  assert.equal(s.noteIndexAt(3), -1);        // instrumental gap
  assert.equal(s.noteIndexAt(-1), -1);
  assert.equal(s.addFrame(3, 60), -1);       // singing over the gap is neither rewarded nor punished
  assert.equal(s.attempted, false);
});

test("Scorer: the live score only counts notes that have gone by", () => {
  const notes = [{ note: 60, start: 0, end: 1 }, { note: 62, start: 100, end: 101 }];
  const s = new Scorer(notes, { golden: false });
  for (let t = 0; t < 1; t += 0.1) s.addFrame(t, 60);
  assert.equal(s.liveScore(), 100);          // not dragged down by a note 99 s away
  assert.ok(s.finish().score < 100);         // the final tally does include it
});

test("Scorer: windowRatio rates a lyric line, and returns null for an instrumental one", () => {
  const s = new Scorer([{ note: 60, start: 0, end: 1 }], { golden: false });
  for (let t = 0; t < 1; t += 0.1) s.addFrame(t, 60);
  assert.equal(s.windowRatio(0, 1), 1);
  assert.equal(s.windowRatio(20, 30), null); // no melody in that window → don't rate the singer
});

// --- queue-order (fair play + "how long until mine?") -----------------------
test("fairInsertIndex: round-robin — everyone sings once before anyone sings twice", () => {
  // Alice, Bob, Alice already queued → rounds [0, 0, 1]. Carl's first song jumps the
  // second Alice song, because Carl hasn't had a turn at all yet.
  assert.equal(fairInsertIndex(["alice", "bob", "alice"], "carl"), 2);
  // Bob's second song goes after Alice's second (both round 1), not before it.
  assert.equal(fairInsertIndex(["alice", "bob", "alice"], "bob"), 3);
  // An empty queue is an empty queue.
  assert.equal(fairInsertIndex([], "alice"), 0);
  // The host ("") is just another singer: its 2nd song waits behind everyone's 1st.
  assert.equal(fairInsertIndex(["", "alice"], ""), 2);          // round 1 → the back
  assert.equal(fairInsertIndex(["", "alice", ""], "bob"), 2);   // Bob's 1st jumps the host's 2nd
  // A newcomer joins the BACK of the current round, not the front of it.
  assert.equal(fairInsertIndex(["", "alice"], "bob"), 2);
  assert.equal(fairInsertIndex(null, "x"), 0);
});

test("fairInsertIndex: never reorders the existing queue, only chooses an insert point", () => {
  // Whatever it returns must be a valid splice index into the current list.
  const q = ["a", "b", "a", "c", "a"];
  for (const who of ["a", "b", "c", "d", ""]) {
    const at = fairInsertIndex(q, who);
    assert.ok(at >= 0 && at <= q.length, `${who} → ${at}`);
  }
});

test("countBy: counts one singer's pending reservations", () => {
  assert.equal(countBy(["a", "b", "a"], "a"), 2);
  assert.equal(countBy(["a", "b", "a"], "z"), 0);
  assert.equal(countBy(["", "a"], ""), 1);     // host-added songs count as their own singer
  assert.equal(countBy(undefined, "a"), 0);
});

test("queueEta: sums known lengths and falls back to an average for unplayed songs", () => {
  assert.equal(queueEta(60, [180, 200], 0), 60);            // next up = whatever's left of now
  assert.equal(queueEta(60, [180, 200], 1), 240);
  assert.equal(queueEta(60, [180, 200], 2), 440);
  assert.equal(queueEta(0, [null, undefined], 2), DEFAULT_SONG_SEC * 2); // never played → estimate
  assert.equal(queueEta(-5, [], 3), 0);                      // junk clamps rather than throwing
});

test("formatEta: reads like a person would say it", () => {
  assert.equal(formatEta(0), "now");
  assert.equal(formatEta(44), "now");
  assert.equal(formatEta(240), "~4 min");
  assert.equal(formatEta(3600), "~1 h");
  assert.equal(formatEta(4200), "~1 h 10 min");
});

// --- YIN pitch detection ----------------------------------------------------
// The point of YIN over plain autocorrelation is octave errors, so that's what's tested:
// a signal with a strong harmonic must still report the FUNDAMENTAL.
function tone(hz, rate, n, harmonics = [1]) {
  const b = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let v = 0;
    harmonics.forEach((amp, k) => { v += amp * Math.sin(2 * Math.PI * hz * (k + 1) * i / rate); });
    b[i] = v / harmonics.length;
  }
  return b;
}

test("yinPitch: recovers a pure tone to within a few cents", () => {
  const rate = 44100;
  for (const hz of [110, 220, 440, 660]) {
    const got = yinPitch(tone(hz, rate, 4096), rate);
    assert.ok(Math.abs(got - hz) / hz < 0.01, `${hz} Hz → ${got}`);
  }
});

test("yinPitch: a harmonic-rich tone still reports the fundamental, not an octave up", () => {
  const rate = 44100;
  // A vowel-ish spectrum: fundamental plus louder 2nd and 3rd harmonics — precisely the case
  // that makes naive autocorrelation jump an octave.
  const got = yinPitch(tone(196, rate, 4096, [0.6, 1.0, 0.8, 0.4]), rate);
  assert.ok(Math.abs(got - 196) / 196 < 0.03, `expected ~196 Hz, got ${got}`);
});

test("yinPitch: silence and noise are reported as unvoiced, not guessed at", () => {
  const rate = 44100;
  assert.equal(yinPitch(new Float32Array(2048), rate), -1);        // digital silence
  const quiet = tone(440, rate, 2048);
  for (let i = 0; i < quiet.length; i++) quiet[i] *= 0.0005;       // below the RMS floor
  assert.equal(yinPitch(quiet, rate), -1);
  assert.equal(yinPitch(new Float32Array(0), rate), -1);
  assert.equal(yinPitch(tone(440, rate, 2048), 0), -1);            // junk sample rate
});

test("yinPitch: refuses frequencies outside a plausible human range", () => {
  const rate = 44100;
  assert.equal(yinPitch(tone(30, rate, 8192), rate), -1);   // below MIN_HZ
  const high = yinPitch(tone(2000, rate, 4096), rate);
  assert.ok(high === -1 || high <= MAX_HZ);
});

// --- MediaEngineBase (the surface all four playback engines share) ----------
// Four hand-rolled copies of toggle()/restart() had already drifted; these pin the shared
// behaviour so the next engine added to the app inherits the same contract.
class FakeEngine extends MediaEngineBase {
  constructor(opts = {}) {
    super();
    this.calls = [];
    this._paused = true;
    this._canPlay = opts.canPlay !== false;
  }
  get canPlay() { return this._canPlay; }
  get paused() { return this._paused; }
  play() { this.calls.push("play"); this._paused = false; }
  pause() { this.calls.push("pause"); this._paused = true; }
  seek(s) { this.calls.push(`seek:${s}`); }
}

test("MediaEngineBase: toggle follows the engine's own paused state", () => {
  const e = new FakeEngine();
  e.toggle();
  assert.deepEqual(e.calls, ["play"]);
  e.toggle();
  assert.deepEqual(e.calls, ["play", "pause"]);
});

test("MediaEngineBase: restart seeks to 0 and plays — in that order", () => {
  const e = new FakeEngine();
  e.restart();
  assert.deepEqual(e.calls, ["seek:0", "play"]);
});

test("MediaEngineBase: an engine that isn't ready ignores transport commands", () => {
  // This is AudioEngine before its Sequencer exists — its old `this.seq && …` guard, kept.
  const e = new FakeEngine({ canPlay: false });
  e.toggle();
  e.restart();
  assert.deepEqual(e.calls, []);
});

test("MediaEngineBase: setOffset is a no-op unless a subclass means it", () => {
  const e = new FakeEngine();
  assert.equal(e.setOffset(500), undefined);
  assert.deepEqual(e.calls, []);
});

// --- store (the localStorage layer) ----------------------------------------
// This is the one module that can destroy a user's whole library state, so it gets a fake
// Storage and real tests rather than hope.
function fakeStorage(initial = {}) {
  const m = new Map(Object.entries(initial));
  return {
    get length() { return m.size; },
    key: (i) => [...m.keys()][i] ?? null,
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => { m.set(k, String(v)); },
    removeItem: (k) => { m.delete(k); },
    _map: m,
  };
}

test("jsonStore: round-trips, and a missing key returns the fallback", () => {
  const s = fakeStorage();
  const store = jsonStore(`${APP_PREFIX}test.v1`, { a: 1 }, s);
  assert.deepEqual(store.read(), { a: 1 });          // fallback
  store.write({ a: 2 });
  assert.deepEqual(store.read(), { a: 2 });
  store.remove();
  assert.deepEqual(store.read(), { a: 1 });
});

test("jsonStore: corrupt JSON and a stored null both fall back instead of throwing", () => {
  const s = fakeStorage({ [`${APP_PREFIX}x`]: "{not json" });
  assert.deepEqual(jsonStore(`${APP_PREFIX}x`, [], s).read(), []);
  s.setItem(`${APP_PREFIX}x`, "null");
  assert.deepEqual(jsonStore(`${APP_PREFIX}x`, [], s).read(), []);
});

test("jsonStore: the fallback is copied, so a caller can't mutate the default", () => {
  const fallback = { list: [] };
  const store = jsonStore(`${APP_PREFIX}y`, fallback, fakeStorage());
  store.read().list.push("oops");
  assert.deepEqual(store.read(), { list: [] });
  assert.deepEqual(fallback, { list: [] });
});

test("jsonStore: a throwing storage (private mode / full quota) degrades quietly", () => {
  const boom = {
    get length() { throw new Error("denied"); },
    key() { throw new Error("denied"); },
    getItem() { throw new Error("denied"); },
    setItem() { throw new Error("denied"); },
    removeItem() { throw new Error("denied"); },
  };
  const store = jsonStore(`${APP_PREFIX}z`, "safe", boom);
  assert.equal(store.read(), "safe");
  assert.equal(store.write("x"), false);   // reports failure rather than throwing
  assert.doesNotThrow(() => store.remove());
  assert.deepEqual(listAppKeys(boom), []);
});

test("collectAppData / restoreAppData: a backup round-trips only karaeoke.* keys", () => {
  const src = fakeStorage({
    [`${APP_PREFIX}favorites.v1`]: '["midi:1"]',
    [`${APP_PREFIX}settings.v1`]: '{"audio":{"volume":1}}',
    "unrelated.other-app": "should not travel",
  });
  const payload = collectAppData(src);
  assert.equal(payload.app, "ka-rae-oke");
  assert.deepEqual(Object.keys(payload.data).sort(),
    [`${APP_PREFIX}favorites.v1`, `${APP_PREFIX}settings.v1`]);

  const dest = fakeStorage();
  assert.equal(restoreAppData(payload, dest), 2);
  assert.equal(dest.getItem(`${APP_PREFIX}favorites.v1`), '["midi:1"]');
  assert.equal(dest.getItem("unrelated.other-app"), null);
});

test("restoreAppData: a foreign or hostile file can't reach other origin state", () => {
  const dest = fakeStorage({ "someone.elses.token": "secret" });
  // Non-prefixed keys are dropped even when the file is otherwise well-formed.
  assert.throws(() => restoreAppData({ data: { "evil.key": "x" } }, dest), /no Ka-Rae-oke data/);
  assert.equal(dest.getItem("someone.elses.token"), "secret");
  assert.throws(() => restoreAppData(null, dest), /not a Ka-Rae-oke backup/);
  assert.throws(() => restoreAppData({ nope: 1 }, dest), /not a Ka-Rae-oke backup/);
  // Non-string values are ignored rather than stringified into nonsense.
  assert.throws(() => restoreAppData({ data: { [`${APP_PREFIX}a`]: { obj: 1 } } }, dest), /no Ka-Rae-oke data/);
});

test("clearAppData: wipes only this app's keys", () => {
  const s = fakeStorage({
    [`${APP_PREFIX}a`]: "1", [`${APP_PREFIX}b`]: "2", "other.app": "keep",
  });
  assert.equal(clearAppData(s), 2);
  assert.deepEqual(listAppKeys(s), []);
  assert.equal(s.getItem("other.app"), "keep");
});

// --- reactions --------------------------------------------------------------
// The allowlist is a security boundary: whatever it contains is rendered on a television
// from a stranger's phone. It must have exactly ONE definition, or the two ends can drift.
test("REACTIONS: one shared allowlist, no second copy in the phone or the host", () => {
  assert.ok(REACTIONS.length > 0);
  assert.ok(REACTIONS.every((e) => typeof e === "string" && e.length > 0));

  const literal = /REACTIONS\s*=\s*\[/;           // a re-declared array literal, anywhere
  for (const f of ["remote.js", "app.js"]) {
    const src = readFileSync(new URL(`../src/js/${f}`, import.meta.url), "utf8");
    assert.ok(!literal.test(src), `${f} re-declares the REACTIONS allowlist`);
  }
  const remote = readFileSync(new URL("../src/js/remote.js", import.meta.url), "utf8");
  assert.match(remote, /import\s*\{\s*REACTIONS\s*\}\s*from\s*"\.\/reactions\.js"/);
});

// The host gate + the applause throttle, which a browser can't show: without a user gesture
// the AudioContext never runs, so the audible half is invisible there but observable here.
function fakeReactionDeps(overrides = {}) {
  const calls = { ensure: 0 };
  const flags = { "reactions.enabled": true, "reactions.sound": true, ...overrides };
  const audio = {
    ctx: null,                                   // never "running" → applause stops after the throttle
    async ensureContext() { calls.ensure++; },
  };
  return { calls, deps: { settings: { get: (p) => flags[p] }, audio } };
}

test("reactions.handle: refuses anything off the allowlist, and obeys the enable flag", async () => {
  globalThis.document = { querySelector: () => null };   // float() no-ops without a stage
  try {
    const { deps } = fakeReactionDeps();
    const r = createReactions(deps);
    assert.equal(r.handle("👏"), true);
    assert.equal(r.handle("💀"), false);          // not on the list
    assert.equal(r.handle("<img src=x>"), false); // free text is never rendered
    assert.equal(r.handle(""), false);
    assert.equal(r.handle(undefined), false);

    const off = createReactions(fakeReactionDeps({ "reactions.enabled": false }).deps);
    assert.equal(off.handle("👏"), false);
  } finally { delete globalThis.document; }
});

test("reactions: applause is throttled, and only 👏 fires it", async () => {
  globalThis.document = { querySelector: () => null };
  try {
    const { calls, deps } = fakeReactionDeps();
    const r = createReactions(deps);
    r.handle("🎉");
    await new Promise((res) => setTimeout(res, 0));
    assert.equal(calls.ensure, 0, "only 👏 claps");

    r.handle("👏");
    r.handle("👏");                                // same tick — inside the 1.5 s gap
    await new Promise((res) => setTimeout(res, 0));
    assert.equal(calls.ensure, 1, "a rapid tapper can't machine-gun the applause");

    const muted = fakeReactionDeps({ "reactions.sound": false });
    createReactions(muted.deps).handle("👏");
    await new Promise((res) => setTimeout(res, 0));
    assert.equal(muted.calls.ensure, 0);
  } finally { delete globalThis.document; }
});

// --- duration hints ---------------------------------------------------------
test("durationHints: learns a length once per play and persists it", () => {
  const store = fakeStorage();
  const d = createDurationHints(store);
  d.load();
  const song = { id: "midi:1" }, other = { id: "midi:2" };

  d.arm();
  d.note(song, 214.6);
  assert.equal(d.get("midi:1"), 215, "rounded to whole seconds");
  assert.deepEqual(JSON.parse(store.getItem(DURATIONS_KEY)), { "midi:1": 215 });

  // Called every frame by the rAF loop: after the first hit it must stop writing.
  const writes = [];
  const spied = { ...store, setItem: (k, v) => { writes.push(k); store.setItem(k, v); } };
  const d2 = createDurationHints(spied);
  d2.load(); d2.arm(); d2.note(song, 100);
  for (let i = 0; i < 50; i++) d2.note(song, 100);
  assert.equal(writes.length, 1, "one write per play, not one per frame");

  // A second song in the same session is learned independently.
  d.arm(); d.note(other, 90);
  assert.equal(d.get("midi:2"), 90);
  assert.equal(d.get("midi:1"), 215);
});

test("durationHints: ignores junk, and a fresh library reports nothing", () => {
  const d = createDurationHints(fakeStorage());
  d.load(); d.arm();
  d.note(null, 100);
  d.note({ id: "x" }, 0);            // a song that never got a duration
  d.note({ id: "x" }, -5);
  d.note({ id: "x" }, NaN);
  assert.equal(d.get("x"), null);    // null, not 0 — queue-order.js falls back on null
  assert.equal(d.get("never-played"), null);
});

test("durationHints: survives a reload, and arm() re-opens the next song", () => {
  const store = fakeStorage();
  const first = createDurationHints(store);
  first.load(); first.arm(); first.note({ id: "midi:7" }, 180);

  const reloaded = createDurationHints(store);
  reloaded.load();
  assert.equal(reloaded.get("midi:7"), 180);

  // Same song again after a re-arm: a corrected length replaces the old one.
  reloaded.arm(); reloaded.note({ id: "midi:7" }, 200);
  assert.equal(reloaded.get("midi:7"), 200);
});
