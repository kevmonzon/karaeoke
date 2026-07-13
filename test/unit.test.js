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
import { Catalog } from "../src/js/catalog.js";

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
