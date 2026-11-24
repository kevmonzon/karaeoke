/*
 * remote-glue.js — the host side of the phone remote, above the transport loop.
 *
 * remote-host.js is the transport (a ~1 s POST/drain loop). This is the glue it drives: the
 * room code that identifies THIS host browser, the QR that hands that code to a guest, the
 * snapshot the phones mirror, and the translation of a guest command into the SAME functions
 * the local UI calls.
 *
 * Nothing here touches the playback state machine. Every command that would — play, pause,
 * next, seek — arrives as an `actions` callback implemented in app.js, because each of those
 * writes `current`, `media` or the end-of-song guards.
 *
 * getNowPlaying is the one place a getter is genuinely right rather than lazy: remote-host's
 * interval calls snapshot() on its own schedule, so there is no caller to pass state in.
 */
import { pickRemoteBaseUrl, clampRemoteSetting, REMOTE_SETTABLE_PATHS } from "./remote-host.js";
import { Catalog } from "./catalog.js";

export const HOST_ROOM_KEY = "karaeoke.remote.host.v1";
const ROOM_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";   // no ambiguous glyphs (no O/0, I/1)
const ROOM_LEN = 6;
const MAX_NICKNAME = 24;

/** How long a refusal stays in the snapshot's `notice` (the phones show it, then it clears). */
export const NOTICE_MS = 5000;
const NOTICE_MAX = 200;   // serve.py keeps this many characters of it (NOTICE_MAX)

/**
 * Host settings mirrored to phones READ-ONLY, so a phone can hide what the host refuses (Play now,
 * Play next) instead of offering a button that only ever earns a "not allowed", and follow the
 * host's `remote.push` ("Instant updates": off forces polling everywhere, e.g. behind a proxy that
 * breaks the event stream — the phone stops its push client when it reads false). M8 adds the number
 * pad's two: `keypad.enabled` (false → the phone hides its `123` pad) and `remote.liveDigits` (false →
 * the phone's pad searches only the phone and its ⏎ sends an ordinary reservation). They are NOT in
 * REMOTE_SETTABLE: a guest `setting` command for one of them is ignored like any other unknown path.
 * Mirrored only when the host's settings hold a boolean for them (config.js gives the defaults); a
 * phone should read a missing gate as "not allowed", and a missing remote.push / keypad.enabled /
 * remote.liveDigits as on.
 */
export const REMOTE_READONLY_MIRROR = Object.freeze([
  "remote.guestPlayNow", "remote.guestPriority", "queue.fairPlay", "remote.push",
  "remote.liveDigits", "keypad.enabled",
]);
// The host gates' defaults when a setting is missing altogether (plan P11 / Q9: Play now off; §5.3 /
// §5.12: the number pad and guests' live digits on).
const GATE_DEFAULTS = Object.freeze({
  "remote.guestPlayNow": false, "remote.guestPriority": true, "queue.fairPlay": false,
  "remote.liveDigits": true, "keypad.enabled": true,
});

const $ = (id) => document.getElementById(id);
const nickname = (by) => String(by || "").slice(0, MAX_NICKNAME);

/**
 * The host-settings subset mirrored to phones AND the allowlist a guest may change. (The phones
 * also get REMOTE_READONLY_MIRROR, which is mirrored only — never settable.)
 *
 * A guest `setting` command with any other path is ignored — never settings.set() an arbitrary
 * path off the network. The paths and their legal value RANGES live together in remote-host.js:
 * allowlisting the path is not enough, because the phone UI clamps client-side and a raw POST
 * does not (see clampRemoteSetting).
 */
export const REMOTE_SETTABLE = new Set(REMOTE_SETTABLE_PATHS);

/** Draw a QR into `el` using the vendored qrcode-generator (window.qrcode). No-op if the lib
 *  is missing or the URL is empty — the feature is opt-in, so it degrades quietly. */
export function renderQr(el, text) {
  if (!el) return;
  el.innerHTML = "";
  const qrcode = window.qrcode;
  if (!text || typeof qrcode !== "function") return;
  try {
    const qr = qrcode(0, "M");        // type 0 = auto-fit the data, error-correction level M
    qr.addData(text);
    qr.make();
    el.innerHTML = qr.createSvgTag({ cellSize: 4, margin: 2, scalable: true });
  } catch (e) { console.error("QR render failed:", e); }
}

/**
 * @param {object} deps
 * @param {object} deps.settings
 * @param {object} deps.catalog
 * @param {object} deps.queue        the queue module
 * @param {object} deps.reactions
 * @param {object} deps.libraryView  for registering a YouTube song a phone asked for
 * @param {object} deps.durations
 * @param {() => object|null} deps.getNowPlaying  the `now` block, built by app.js
 * @param {(msg:string)=>void} deps.setStatus
 * @param {object} deps.actions      playback-touching operations, all implemented in app.js:
 *   enqueue, removeFromQueue, reorderQueue, play, pause, next, seek, setVolume, applySetting,
 *   (M7) playNow(song, by), playNext(song, by), restart(), bgNext() (a no-op until M11), and
 *   (M8) digit(d, by), digitDelete(by), digitClear(by), digitCommit(by, { playIfIdle }) — a guest's
 *   live number entry into the host's Songs search (plan §5.12); app.js owns the field and the panel
 * @param {object} [deps.storage]
 * @param {() => number} [deps.clock]  ms, for the notice's 5 s life (Date.now; injected in tests)
 * (A `positionFocusQr` dependency is still accepted and ignored: the focus-mode QR it placed
 *  is gone, and the stage QR chip is positioned by CSS.)
 */
export function createRemoteGlue({
  settings, catalog, queue, reactions, libraryView, durations,
  getNowPlaying, setStatus, actions, storage, clock = () => Date.now(),
}) {
  const store = storage !== undefined ? storage : (() => {
    try { return window.localStorage; } catch (_) { return null; }
  })();

  let hostRoom = null;
  let lanUrl = null;   // server-detected LAN base (fetched once, cached)
  let notice = "";     // the last refusal, shown on the phones for NOTICE_MS
  let noticeAt = 0;
  // song → its index in catalog.songs, so a queue item can carry ref {i, code} (the phone's compact
  // catalogue row i is the host's catalog.songs[i]). Rebuilt only when catalog.songs is replaced
  // (load / adopt assign a new array) — never an indexOf per push over 120k songs.
  let indexedSongs = null;
  let songIndex = null;

  function refOf(song) {
    const songs = catalog && catalog.songs;
    if (!Array.isArray(songs)) return null;
    if (songs !== indexedSongs) {
      songIndex = new Map();
      songs.forEach((s, i) => { if (s && !songIndex.has(s)) songIndex.set(s, i); });
      indexedSongs = songs;
    }
    const i = songIndex.get(song);
    return i === undefined ? null : { i, code: song.code };
  }

  /** A gate's value: the host's boolean, else the documented default. */
  function gate(path) {
    const v = settings.get(path);
    return typeof v === "boolean" ? v : GATE_DEFAULTS[path];
  }

  /** Refuse a guest command where the room can see why: the phones' notice and the host's status line. */
  function refuse(text) {
    notice = String(text).slice(0, NOTICE_MAX);
    noticeAt = clock();
    setStatus(text);
  }
  const notAllowed = (by) => refuse(`${by || "A guest"}: not allowed by the host`);
  /** Guests' live digits reach the host's search only while both switches are on (missing = on). */
  const digitsLive = () => gate("remote.liveDigits") && gate("keypad.enabled");

  /** Optional reservation cap — the digital form of "don't hog the mic". 0 = off; the host ("") is never capped. */
  function overCap(by) {
    const cap = +settings.get("queue.maxPerGuest") || 0;
    if (cap > 0 && by && queue.countBy(by) >= cap) {
      refuse(`${by} already has ${cap} song${cap === 1 ? "" : "s"} reserved — wait for your turn.`);
      return true;
    }
    return false;
  }

  /**
   * The room code, OWNED BY THIS HOST BROWSER: generated once and kept in localStorage, so it
   * is stable across reloads and unique per host. The server never mints it — the code is only
   * the routing key for its multi-room relay.
   */
  function getHostRoom() {
    if (hostRoom) return hostRoom;
    try { hostRoom = store?.getItem(HOST_ROOM_KEY) || ""; } catch (_) { hostRoom = ""; }
    if (!new RegExp(`^[A-Z0-9]{${ROOM_LEN}}$`).test(hostRoom)) {
      const buf = new Uint32Array(ROOM_LEN);
      globalThis.crypto.getRandomValues(buf);   // globalThis, not window: this module is unit-tested
      hostRoom = Array.from(buf, (n) => ROOM_ALPHABET[n % ROOM_ALPHABET.length]).join("");
      try { store?.setItem(HOST_ROOM_KEY, hostRoom); } catch (_) {}
    }
    return hostRoom;
  }

  /** Resolve a song a phone asked for. In order: by `id` (older phones, and the queue); by `ref`
   *  {i, code} — the phone's compact-catalogue row, which IS catalog.songs[i] unless the catalogue
   *  was rebuilt since, so the code must match (a blank code must match the title too); else every
   *  song with that code in the named songbook (`source`, else all), first wins; else a YouTube
   *  result (not in the local catalog), reconstructed from the command metadata and registered so it
   *  resolves everywhere else — favorites, recents, the queue — like a local one. Every field is
   *  untrusted (a raw POST is not the phone UI): shapes are checked, lookups are Maps. */
  function resolveSong(c) {
    const hit = c.id != null && c.id !== "" ? catalog.getById(c.id) : null;
    if (hit) return hit;
    const ref = c.ref;
    if (ref && typeof ref === "object" && (typeof ref.code === "string" || (typeof ref.code === "number" && Number.isFinite(ref.code)))) {
      const code = String(ref.code);
      const songs = Array.isArray(catalog.songs) ? catalog.songs : [];
      const at = Number.isInteger(ref.i) && ref.i >= 0 && ref.i < songs.length ? songs[ref.i] : null;
      if (at && String(at.code ?? "") === code && (code !== "" || (typeof c.name === "string" && at.name === c.name))) return at;
      if (code !== "" && typeof catalog.lookupCode === "function") {
        const source = typeof c.source === "string" && c.source ? c.source : "all";
        const byCode = catalog.lookupCode(code, source)[0];
        if (byCode) return byCode;
      }
    }
    if (c.kind === "youtube" && c.videoId) {
      return libraryView.registerYoutube(Catalog.makeYoutubeRecord({
        videoId: c.videoId, title: c.name, channelTitle: c.artist,
      }));
    }
    return null;
  }

  return {
    getHostRoom,

    /**
     * Snapshot the host state for the phones. remote-host.js adds the ackSeq before POSTing.
     * `songRev` is lifted out of the now block (app.js keeps it there — the one getter, §5.29) to
     * the top level, where serve.py reads it; 0 with nothing playing. `notice` is the last refusal
     * for NOTICE_MS, then "". A queue item carries `ref: {i, code}` when the song is in the catalogue.
     */
    snapshot() {
      const q = queue.list.map((s, i) => {
        const item = {
          id: s.id, name: s.name || "", artist: s.artistName || "",
          kind: s.kind, code: s.code || "", by: queue.listBy[i] || "",
          dur: durations.get(s.id),   // learned length → the phone computes "how long until mine"
        };
        const ref = refOf(s);
        if (ref) item.ref = ref;
        return item;
      });
      const settingsSub = {};
      for (const p of REMOTE_SETTABLE) settingsSub[p] = settings.get(p);
      for (const p of REMOTE_READONLY_MIRROR) {
        const v = settings.get(p);
        if (typeof v === "boolean") settingsSub[p] = v;
      }
      const now = getNowPlaying();
      const rev = now && now.songRev;
      if (notice && clock() - noticeAt >= NOTICE_MS) notice = "";
      return {
        room: getHostRoom(), now, queue: q, settings: settingsSub,
        songRev: Number.isInteger(rev) && rev > 0 ? rev : 0,
        notice,
      };
    },

    /** Apply one guest command (already validated server-side to a known type). */
    applyCommand(cmd) {
      switch (cmd.type) {
        case "enqueue": {
          const by = nickname(cmd.by);
          if (overCap(by)) break;
          const song = resolveSong(cmd);
          if (song) actions.enqueue(song, by);
          break;
        }
        // M7. The relay only routes these; whether a guest may is the host's call, every time.
        case "playnow": {
          // Off by default (plan P11 / Q9): it stops the current singer mid-song.
          const by = nickname(cmd.by);
          if (!gate("remote.guestPlayNow")) { notAllowed(by); break; }
          const song = resolveSong(cmd);
          if (song) actions.playNow(song, by);
          break;
        }
        case "priority": {
          // "Play next" jumps the queue, which is exactly what fair play exists to prevent.
          const by = nickname(cmd.by);
          if (!gate("remote.guestPriority") || gate("queue.fairPlay")) { notAllowed(by); break; }
          if (overCap(by)) break;
          const song = resolveSong(cmd);
          if (song) actions.playNext(song, by);
          break;
        }
        case "restart": actions.restart(); break;
        case "bg": if (typeof actions.bgNext === "function") actions.bgNext(); break;
        // M8 — a guest's live number entry (plan §5.12): the phone's pad types into the HOST's Songs
        // search, where the number tier lists every songbook's match. All four are ignored when the
        // host turned guests' live digits off (the phone then searches on its own and sends a plain
        // `enqueue`) or the number pad off altogether (§5.3: remote digit commands are ignored).
        case "digit": {
          // One decimal digit, as a NUMBER: "3", 10, -1 and 1.5 are refused, so nothing but 0–9
          // can ever reach the search field from the network.
          if (!digitsLive() || !Number.isInteger(cmd.d) || cmd.d < 0 || cmd.d > 9) break;
          actions.digit(cmd.d, nickname(cmd.by));
          break;
        }
        case "digit_delete": if (digitsLive()) actions.digitDelete(nickname(cmd.by)); break;
        case "digit_clear":  if (digitsLive()) actions.digitClear(nickname(cmd.by)); break;
        case "digit_commit": {
          // The guest's Enter: the top hit, reserved in their name — so the per-guest cap applies
          // exactly as for `enqueue` (same refusal, same notice). It plays at once only when the host
          // allows guests Play now AND app.js finds the stage idle; app.js decides the idle half.
          if (!digitsLive()) break;
          const by = nickname(cmd.by);
          if (overCap(by)) break;
          actions.digitCommit(by, { playIfIdle: gate("remote.guestPlayNow") === true });
          break;
        }
        // The id check is what stops a stale index deleting the wrong song — a guest's index
        // can be ~2 s out of date by the time the command lands. See queue.js.
        case "remove":
          if (queue.matches(cmd.index, cmd.id)) actions.removeFromQueue(cmd.index);
          break;
        case "reorder":
          if (Number.isInteger(cmd.to) && queue.matches(cmd.from, cmd.id)) actions.reorderQueue(cmd.from, cmd.to);
          break;
        case "react":
          // Allowlisted, never free text: this is drawn on the host's TV from a stranger's phone.
          reactions.handle(cmd.emoji);
          break;
        case "play":  actions.play();  break;
        case "pause": actions.pause(); break;
        case "next":  actions.next();  break;
        case "seek":
          if (Number.isFinite(cmd.position)) actions.seek(cmd.position);
          break;
        case "volume":
          if (Number.isFinite(cmd.value)) actions.setVolume(cmd.value);
          break;
        case "setting": {
          // Two gates, not one: the PATH must be allowlisted and the VALUE must be in range.
          // A raw POST is unclamped, and audio.volume goes straight to a GainNode.
          if (typeof cmd.path !== "string" || !REMOTE_SETTABLE.has(cmd.path)) break;
          const v = clampRemoteSetting(cmd.path, cmd.value);
          if (v === undefined) break;          // wrong type / NaN / unknown path → ignore
          actions.applySetting(cmd.path, v);
          break;
        }
      }
    },

    /**
     * Render/refresh (or clear) the QR + URL + room code. One renderer, three places: the queue
     * panel (#remote-qr-code), the home layer (#home-qr, with the code in #home-room) and the
     * small stage chip (#stage-qr). Which of the stage copies is VISIBLE is not decided here: it
     * depends on body[data-idle], which changes without this running, so the CSS owns it
     * (body.remote-on + body[data-qr] = remote.qrOnStage, written by app.js). The base URL is
     * auto-detected (settings override → the host page's own non-loopback origin → the server's
     * LAN IP); the room code is embedded so scanning auto-connects.
     */
    async refreshQr(on) {
      const box = $("remote-qr");
      if (!box) return;
      const homeQr = $("home-qr"), homeRoom = $("home-room"), stageQr = $("stage-qr");
      if (!on) {
        box.classList.remove("show");
        renderQr(homeQr, ""); renderQr(stageQr, "");
        if (homeRoom) homeRoom.textContent = "";
        return;
      }
      if (lanUrl == null) {
        try {
          const d = await (await fetch("/api/remote/info")).json();
          lanUrl = (d && d.lanUrl) || "";
        } catch (_) { lanUrl = ""; }
      }
      const room = getHostRoom();
      const base = pickRemoteBaseUrl(settings.get("remote.baseUrl"), location.origin, lanUrl);
      const url = base ? `${base}/remote?room=${room}` : "";
      const roomEl = $("remote-room"); if (roomEl) roomEl.textContent = room;
      const link = $("remote-qr-url");
      if (link) { link.textContent = base ? `${base}/remote` : "(no reachable URL)"; link.href = url || "#"; }
      renderQr($("remote-qr-code"), url);
      renderQr(homeQr, url);
      renderQr(stageQr, url);
      if (homeRoom) homeRoom.textContent = `Room code ${room}`;
      box.classList.add("show");
    },
  };
}
