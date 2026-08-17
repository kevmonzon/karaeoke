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

const $ = (id) => document.getElementById(id);

/**
 * The host-settings subset mirrored to phones AND the allowlist a guest may change.
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
 * @param {() => void} deps.positionFocusQr       stays in app.js: it measures the stage layout
 * @param {object} deps.actions      playback-touching operations, all implemented in app.js
 * @param {object} [deps.storage]
 */
export function createRemoteGlue({
  settings, catalog, queue, reactions, libraryView, durations,
  getNowPlaying, setStatus, positionFocusQr, actions, storage,
}) {
  const store = storage !== undefined ? storage : (() => {
    try { return window.localStorage; } catch (_) { return null; }
  })();

  let hostRoom = null;
  let lanUrl = null;   // server-detected LAN base (fetched once, cached)

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

  /** Resolve a song a phone asked to enqueue. Library songs resolve by id; a YouTube result
   *  (not in the local catalog) is reconstructed from the command metadata and registered so it
   *  resolves everywhere else — favorites, recents, the queue — like a local one. */
  function resolveSong(c) {
    const hit = catalog.getById(c.id);
    if (hit) return hit;
    if (c.kind === "youtube" && c.videoId) {
      return libraryView.registerYoutube(Catalog.makeYoutubeRecord({
        videoId: c.videoId, title: c.name, channelTitle: c.artist,
      }));
    }
    return null;
  }

  return {
    getHostRoom,

    /** Snapshot the host state for the phones. remote-host.js adds the ackSeq before POSTing. */
    snapshot() {
      const q = queue.list.map((s, i) => ({
        id: s.id, name: s.name || "", artist: s.artistName || "",
        kind: s.kind, code: s.code || "", by: queue.listBy[i] || "",
        dur: durations.get(s.id),   // learned length → the phone computes "how long until mine"
      }));
      const settingsSub = {};
      for (const p of REMOTE_SETTABLE) settingsSub[p] = settings.get(p);
      return { room: getHostRoom(), now: getNowPlaying(), queue: q, settings: settingsSub };
    },

    /** Apply one guest command (already validated server-side to a known type). */
    applyCommand(cmd) {
      switch (cmd.type) {
        case "enqueue": {
          const by = String(cmd.by || "").slice(0, MAX_NICKNAME);
          // Optional reservation cap — the digital form of "don't hog the mic". 0 = off.
          const cap = +settings.get("queue.maxPerGuest") || 0;
          if (cap > 0 && by && queue.countBy(by) >= cap) {
            setStatus(`${by} already has ${cap} song${cap === 1 ? "" : "s"} reserved — wait for your turn.`);
            break;
          }
          const song = resolveSong(cmd);
          if (song) actions.enqueue(song, by);
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
     * Render/refresh (or hide) the QR + URL + room code on the queue panel. The base URL is
     * auto-detected (settings override → the host page's own non-loopback origin → the server's
     * LAN IP); the room code is embedded so scanning auto-connects.
     */
    async refreshQr(on) {
      const box = $("remote-qr");
      if (!box) return;
      if (!on) { box.classList.remove("show"); renderQr($("focus-qr"), ""); return; }
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
      renderQr($("focus-qr"), url); // the same QR mirrored into the focus-mode overlay (CSS gates it)
      positionFocusQr();
      box.classList.add("show");
    },
  };
}
