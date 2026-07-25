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
import { parseMidi, makeTickToSeconds } from "../src/js/lyrics.js";
import { detectChords, chordLabel, simplifySuffix, diatonicThird, simplifiedSuffix } from "../src/js/chords.js";
import { Catalog } from "../src/js/catalog.js";
import { channelInfo } from "../src/js/midi-mixer.js";
import { matchesQuery } from "../src/js/settings-ui.js";
import { pickRemoteBaseUrl } from "../src/js/remote-host.js";

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
