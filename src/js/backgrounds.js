/*
 * backgrounds.js — the background layer behind the lyrics: looping videos, a photo slideshow or the live
 * camera, with a dim layer (M11, plan §5.22). Fills #bg-layer.
 *
 * CONTRACT STUB written by the orchestrator. Lane A fills the bodies; the exports, names and signatures
 * are the contract lane I codes against — do not change them.
 *
 * The media list comes from GET /api/backgrounds (lane B, tools/serve.py):
 *   {ok, videos:[{url, category}], photos:[{url, category}], categories:{videos:[…], photos:[…]}}
 */

// --- pure rules ------------------------------------------------------------------------------------

const hasAny = (a) => Array.isArray(a) && a.length > 0;

/** auto → "video" if any videos, else "photo" if any photos, else "off"; "video"/"photo" with nothing to
 *  show → "off"; "camera" stays "camera" (auto never picks the camera); "off" and unknown → "off". */
export function resolveMode(mode, { videos = [], photos = [] } = {}) {
  switch (mode) {
    case "auto": return hasAny(videos) ? "video" : hasAny(photos) ? "photo" : "off";
    case "video": return hasAny(videos) ? "video" : "off";
    case "photo": return hasAny(photos) ? "photo" : "off";
    case "camera": return "camera";
    default: return "off";
  }
}

/** The background shows for "midi" and "audio" songs and on the idle stage; never for "video" or "youtube". */
export function shouldShow(songKind, idle) {
  if (idle === true) return true;
  return songKind === "midi" || songKind === "audio";
}

/** "all" (or empty) → every item; else the items whose category equals it. A fresh array. */
export function filterCategory(items, category) {
  if (!Array.isArray(items)) return [];
  if (!category || category === "all") return items.slice();
  return items.filter((it) => it != null && it.category === category);
}

/** A Fisher–Yates permutation of 0..n−1 using `rand` (() → [0, 1)). */
export function shuffled(n, rand = Math.random) {
  const len = Number.isInteger(n) && n > 0 ? n : 0;
  const out = Array.from({ length: len }, (_, i) => i);
  for (let i = len - 1; i > 0; i--) {
    const r = Number(rand());
    // A misbehaving rand (≥ 1, < 0, NaN) still yields a permutation: j is clamped into 0..i.
    const j = Math.min(i, Math.max(0, Math.floor((Number.isFinite(r) ? r : 0) * (i + 1))));
    const t = out[i]; out[i] = out[j]; out[j] = t;
  }
  return out;
}

/** bg.camera.mirror: "on" → true, "off" → false, "auto" → true only for the front camera (facing "user"). */
export function mirrorFor(facing, mirrorSetting) {
  if (mirrorSetting === "on") return true;
  if (mirrorSetting === "off") return false;
  return facing === "user";
}

// --- the player ------------------------------------------------------------------------------------

const ANIMATIONS = ["none", "fade", "slide", "zoom"];
const DIM_DEFAULT = 0.35;
const INTERVAL_DEFAULT = 8;

/** One {url, category} list. URLs must be same-origin paths ("/bgv/…"), never "//host" or a scheme. */
function cleanItems(arr) {
  if (!Array.isArray(arr)) return [];
  const out = [];
  for (const it of arr) {
    if (!it || typeof it.url !== "string") continue;
    const url = it.url;
    if (!url.startsWith("/") || url.startsWith("//")) continue;
    out.push(Object.freeze({ url, category: typeof it.category === "string" ? it.category : "" }));
  }
  return out;
}
function cleanCategories(arr, items) {
  const src = Array.isArray(arr) ? arr : items.map((i) => i.category);
  return [...new Set(src.filter((c) => typeof c === "string" && c !== ""))].sort();
}
function normalizeList(body) {
  const videos = cleanItems(body && body.videos);
  const photos = cleanItems(body && body.photos);
  const cats = (body && body.categories) || {};
  return Object.freeze({
    videos: Object.freeze(videos),
    photos: Object.freeze(photos),
    categories: Object.freeze({
      videos: Object.freeze(cleanCategories(cats.videos, videos)),
      photos: Object.freeze(cleanCategories(cats.photos, photos)),
    }),
  });
}

/** A short status line for a getUserMedia rejection. */
function cameraReason(err) {
  const name = err && err.name;
  if (name === "NotAllowedError" || name === "SecurityError" || name === "PermissionDeniedError") {
    return "Camera blocked: allow it in the browser's site settings";
  }
  if (name === "NotFoundError" || name === "DevicesNotFoundError" || name === "OverconstrainedError") {
    return "No camera found";
  }
  if (name === "NotReadableError" || name === "TrackStartError" || name === "AbortError") {
    return "The camera is busy in another app";
  }
  return "The camera could not start";
}

function stopTracks(stream) {
  try { for (const t of stream.getTracks()) { try { t.stop(); } catch { /* already stopped */ } } } catch { /* not a stream */ }
}
function detach(node) {
  if (node && node.parentNode) { try { node.parentNode.removeChild(node); } catch { /* gone */ } }
}
function quiet(p) { if (p && typeof p.catch === "function") p.catch(() => {}); }

/**
 * @param {object} o
 * @param {HTMLElement} o.el                 #bg-layer
 * @param {{get(path:string):any}} o.settings  bg.mode, bg.category, bg.dim, bg.changeOnSong, bg.photo.intervalSec,
 *                                             bg.photo.animation, bg.camera.facing, bg.camera.mirror
 * @param {() => Promise<object>} o.fetchList  resolves to the /api/backgrounds body (or rejects)
 * @param {(text:string) => void} [o.onStatus] a status line for the app (camera blocked, …)
 * @returns {{ init(): Promise<void>, applySettings({gesture?:boolean}?): void, onSongChange(kind:string, idle:boolean): void,
 *             next(): void, stop(): void, readonly state: {mode:string, index:number, count:number, camera:string},
 *             readonly list: object }}
 *   init(): fetchList() once (safe to call again to refresh); applySettings(): re-resolve the mode, start/stop
 *   elements, set --bg-dim; `gesture: true` when the user just picked Camera (then getUserMedia is called
 *   directly). onSongChange(kind, idle): show/hide; advance when bg.changeOnSong. next(): video → next clip,
 *   photo → next image, camera → no-op. stop(): remove elements, stop camera tracks.
 *   DOM inside el: ONE <video class="bg-video" muted loop playsinline> OR two <img class="bg-photo"> (cross-fade
 *   pair) OR one <video class="bg-camera" muted playsinline autoplay>, plus <div class="bg-dim">. Never more than
 *   one <video>. Elements are removed (not left idle) when not needed. Video pauses on document.hidden and
 *   resumes on return; the camera stops when hidden.
 *   Camera without a gesture (boot, or a stored "camera" mode): navigator.permissions.query({name:"camera"}) →
 *   "granted" starts it; anything else (or the query throws) does NOT call getUserMedia: state.camera =
 *   "needs-tap" and <button class="bg-camera-start">Tap to start camera</button> appears in the layer; its click
 *   starts it. A rejection → state.camera "blocked", resolved mode "off", onStatus(reason); never re-prompts in a
 *   loop. Not a secure context → state.camera "insecure", nothing called.
 *   Sets document.body.dataset.bg = "on" | "off" (the scroll lyric style adds a text-shadow under "on").
 *   state.camera ∈ "off" | "on" | "needs-tap" | "blocked" | "insecure".
 *
 * Lane A notes (behaviour the contract leaves open — see the M11 report):
 *   - The mode is resolved against the CATEGORY-FILTERED lists, so auto + a photo-only category shows photos.
 *     An explicit Videos / Photos ignores a category its kind does not carry; one nothing carries is "all".
 *   - onSongChange("" | null, false) (between songs) keeps what is on screen and does not advance; a song
 *     (a kind with idle false) advances when bg.changeOnSong; idle true shows without advancing.
 *   - A camera hidden by a video/YouTube song or a hidden tab stops its tracks; it comes back through the
 *     no-gesture path (permission query), except a facing change while the camera is live (direct).
 *   - A camera track that ends on its own (unplugged, permission revoked) → "blocked", off, onStatus once.
 *   - Clips / photos that fail are skipped; once every item failed in a row the layer gives up (one status).
 *   - While the tap button shows, the layer gets data-tap (CSS raises it above the flow) and loses aria-hidden.
 *   - The scroll-lyric halo under body[data-bg="on"] is a drop-shadow FILTER, not a text-shadow: the syllables
 *     are background-clip:text gradients, and a text-shadow paints over the clipped gradient (backgrounds.css).
 */
export function createBackgrounds({ el, settings, fetchList, onStatus = () => {}, doc = globalThis.document, nav = globalThis.navigator, win = globalThis.window } = {}) {
  const get = (path) => {
    try { return settings && typeof settings.get === "function" ? settings.get(path) : undefined; } catch { return undefined; }
  };
  const status = (text) => { try { onStatus(text); } catch { /* the app's problem */ } };
  const setT = (fn, ms) => (win && typeof win.setTimeout === "function" ? win.setTimeout(fn, ms) : setTimeout(fn, ms));
  const clearT = (id) => { if (win && typeof win.clearTimeout === "function") win.clearTimeout(id); else clearTimeout(id); };
  const docHidden = () => !!(doc && doc.hidden === true);
  const insecure = () => !!(win && win.isSecureContext === false);

  // settings, with the plan's defaults when a key is missing
  const dimValue = () => {
    const v = Number(get("bg.dim"));
    return Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : DIM_DEFAULT;
  };
  const intervalMs = () => {
    const v = Number(get("bg.photo.intervalSec"));
    return (Number.isFinite(v) ? Math.min(60, Math.max(3, v)) : INTERVAL_DEFAULT) * 1000;
  };
  const animation = () => { const a = get("bg.photo.animation"); return ANIMATIONS.includes(a) ? a : "fade"; };
  const facingSetting = () => (get("bg.camera.facing") === "user" ? "user" : "environment");
  const changeOnSong = () => get("bg.changeOnSong") !== false;

  let list = normalizeList(null);
  let listLoaded = false;
  let initToken = 0;

  let mode = "off";              // the RESOLVED mode
  let items = [];                // the media the mode plays (category-filtered)
  let itemsKey = "";
  let order = [];                // a shuffled play order over items
  let pos = 0;
  let shown = true;              // false while a video / YouTube song owns the stage
  let failures = 0;              // items that failed in a row (video or photo)
  let gaveUp = false;

  let videoEl = null; let videoUrl = "";
  let photoEls = null; let front = -1; let photoTarget = ""; let photoToken = 0; let photoTimer = null;
  let dimEl = null; let tapBtn = null;

  let cam = "off";
  let stream = null; let camEl = null;
  let camAsked = "";             // the facing the live stream was asked for (restart decisions)
  let camFacing = "";            // the facing it reports, else the asked one (the mirror)
  let camToken = 0; let camAskedFacing = "";
  let camPending = null;          // {facing, kind: "ask" | "start"} while a query or getUserMedia is in flight
  let camBlocked = false;

  // --- DOM helpers ---------------------------------------------------------------------------------
  const make = (tag, className) => { const n = doc.createElement(tag); n.className = className; return n; };
  // Media go under the dim and the button (the CSS z-index also says so; this keeps the DOM honest).
  const insertMedia = (node) => {
    if (!el) return;
    const ref = dimEl && dimEl.parentNode === el ? dimEl : tapBtn && tapBtn.parentNode === el ? tapBtn : null;
    if (ref && typeof el.insertBefore === "function") el.insertBefore(node, ref); else el.appendChild(node);
  };
  const hasPicture = () => !!videoEl || !!camEl || (!!photoEls && front >= 0);

  /** Dim, body[data-bg], the tap button's layer state, --bg-dim and data-anim. */
  function chrome() {
    if (el) {
      try { el.style.setProperty("--bg-dim", String(dimValue())); } catch { /* no style */ }
      try { el.setAttribute("data-anim", animation()); } catch { /* no attributes */ }
    }
    const pic = hasPicture();
    if (pic && !dimEl && el) { dimEl = make("div", "bg-dim"); el.appendChild(dimEl); }
    if (!pic && dimEl) { detach(dimEl); dimEl = null; }
    if (el) {
      if (tapBtn) { el.setAttribute("data-tap", ""); el.removeAttribute("aria-hidden"); }
      else { el.removeAttribute("data-tap"); el.setAttribute("aria-hidden", "true"); }
    }
    if (doc && doc.body && doc.body.dataset) doc.body.dataset.bg = pic ? "on" : "off";
  }

  // --- play order ------------------------------------------------------------------------------------
  const currentIndex = () => (items.length && order.length ? order[pos] : -1);
  const currentUrl = () => { const i = currentIndex(); return i >= 0 && items[i] ? items[i].url : ""; };
  function step() {
    if (items.length < 2) return false;
    const last = order[pos];
    pos++;
    if (pos >= order.length) {
      order = shuffled(items.length);
      pos = 0;
      if (order[0] === last) { const t = order[0]; order[0] = order[1]; order[1] = t; }   // no immediate repeat
    }
    return true;
  }
  function onItemFailed() {
    failures++;
    if (failures >= items.length) {
      gaveUp = true;
      render();
      status(mode === "video" ? "Background videos could not play" : "Background photos could not load");
      return;
    }
    step();
    render();
  }

  // --- video ---------------------------------------------------------------------------------------
  function dropVideo() {
    if (!videoEl) return;
    const v = videoEl; videoEl = null; videoUrl = "";
    try { v.pause(); } catch { /* not playing */ }
    try { v.removeAttribute("src"); v.load(); } catch { /* releases the decoder where supported */ }
    detach(v);
  }
  function showVideo() {
    const url = currentUrl();
    if (!url || gaveUp) { dropVideo(); return; }
    if (!videoEl) {
      const v = make("video", "bg-video");
      v.muted = true; v.loop = true; v.playsInline = true;
      v.setAttribute("muted", ""); v.setAttribute("loop", ""); v.setAttribute("playsinline", "");
      v.preload = "auto";
      v.addEventListener("playing", () => { if (v === videoEl) failures = 0; });
      // A removed clip's own "Empty src" error (dropVideo) arrives with v !== videoEl and is ignored.
      v.addEventListener("error", () => { if (v === videoEl) onItemFailed(); });
      videoEl = v;
      insertMedia(v);
    }
    if (videoUrl !== url) { videoUrl = url; videoEl.src = url; }
    if (docHidden()) { try { videoEl.pause(); } catch { /* fine */ } }
    else if (videoEl.paused !== false) { try { quiet(videoEl.play()); } catch { /* autoplay refused */ } }
  }

  // --- photos --------------------------------------------------------------------------------------
  function clearPhotoTimer() { if (photoTimer != null) { clearT(photoTimer); photoTimer = null; } }
  function schedulePhoto() {
    clearPhotoTimer();
    if (mode !== "photo" || !shown || docHidden() || items.length < 2 || gaveUp) return;
    photoTimer = setT(() => { photoTimer = null; if (step()) render(); }, intervalMs());
  }
  function dropPhotos() {
    clearPhotoTimer();
    photoToken++;
    if (!photoEls) return;
    for (const img of photoEls) detach(img);
    photoEls = null; front = -1; photoTarget = "";
  }
  function swapTo(backIdx) {
    const a = photoEls[backIdx], b = photoEls[1 - backIdx];
    a.className = "bg-photo is-on";
    if (front >= 0) b.className = "bg-photo is-out";
    front = backIdx;
    failures = 0;
    chrome();
    schedulePhoto();
  }
  function loadPhoto(url) {
    const backIdx = front === 0 ? 1 : 0;
    const img = photoEls[backIdx];
    const token = ++photoToken;
    let settled = false;
    const ok = () => { if (settled) return; settled = true; if (token === photoToken && photoEls) swapTo(backIdx); };
    const bad = () => { if (settled) return; settled = true; if (token === photoToken && photoEls) onItemFailed(); };
    img.className = "bg-photo";
    img.src = url;
    if (typeof img.decode === "function") {
      let p; try { p = img.decode(); } catch (e) { p = Promise.reject(e); }
      Promise.resolve(p).then(ok, bad);
    } else {
      img.addEventListener("load", ok, { once: true });
      img.addEventListener("error", bad, { once: true });
    }
  }
  function showPhotos() {
    const url = currentUrl();
    if (!url || gaveUp) { dropPhotos(); return; }
    if (!photoEls) {
      photoEls = [make("img", "bg-photo"), make("img", "bg-photo")];
      for (const img of photoEls) { img.alt = ""; img.decoding = "async"; insertMedia(img); }
      front = -1; photoTarget = "";
    }
    if (photoTarget !== url) { photoTarget = url; clearPhotoTimer(); loadPhoto(url); }
    else if (docHidden()) clearPhotoTimer();
    else if (photoTimer == null && front >= 0) schedulePhoto();
  }

  // --- camera --------------------------------------------------------------------------------------
  function removeCamEl() {
    if (!camEl) return;
    const v = camEl; camEl = null;
    try { v.pause(); } catch { /* fine */ }
    try { v.srcObject = null; } catch { /* fine */ }
    detach(v);
  }
  function removeTap() { if (tapBtn) { detach(tapBtn); tapBtn = null; } }
  function dropCamera() {
    camToken++;               // anything in flight is now stale (a late stream is stopped on arrival)
    camPending = null;
    if (stream) { stopTracks(stream); stream = null; camAsked = ""; camFacing = ""; }
    removeCamEl();
    removeTap();
    if (cam === "on" || cam === "needs-tap") cam = "off";
  }
  function paintCamera() {
    if (stream) {
      removeTap();
      const mirror = mirrorFor(camFacing, get("bg.camera.mirror"));
      if (!camEl) {
        const v = make("video", "bg-camera");
        v.muted = true; v.playsInline = true; v.autoplay = true;
        v.setAttribute("muted", ""); v.setAttribute("playsinline", ""); v.setAttribute("autoplay", "");
        camEl = v;
        insertMedia(v);
      }
      camEl.className = mirror ? "bg-camera bg-mirror" : "bg-camera";
      if (camEl.srcObject !== stream) camEl.srcObject = stream;
      if (camEl.paused !== false) { try { quiet(camEl.play()); } catch { /* autoplay attr covers it */ } }
    } else {
      removeCamEl();
      if (cam === "needs-tap" && !tapBtn && el) {
        const b = make("button", "bg-camera-start");
        b.setAttribute("type", "button");
        b.textContent = "Tap to start camera";
        b.addEventListener("click", () => {
          if (mode !== "camera" || b !== tapBtn) return;
          camBlocked = false;
          startCamera(facingSetting());      // inside the click: a real gesture
        });
        tapBtn = b;
        el.appendChild(b);
      } else if (cam !== "needs-tap") removeTap();
    }
  }
  function startCamera(facing) {
    const token = ++camToken;
    camPending = { facing, kind: "start" };
    if (stream) { stopTracks(stream); stream = null; camAsked = ""; camFacing = ""; }   // one camera at a time (phones can't open two)
    removeCamEl();
    removeTap();
    cam = "off";
    chrome();
    let p;
    try { p = nav.mediaDevices.getUserMedia({ video: { facingMode: facing }, audio: false }); } catch (e) { p = Promise.reject(e); }
    Promise.resolve(p).then((s) => {
      if (token !== camToken) { stopTracks(s); return; }
      camPending = null; stream = s; camAsked = facing; camFacing = facing; cam = "on";
      try {
        const actual = s.getVideoTracks && s.getVideoTracks()[0];
        const f = actual && typeof actual.getSettings === "function" ? actual.getSettings().facingMode : "";
        if (f === "user" || f === "environment") camFacing = f;
        for (const t of s.getTracks()) {
          if (typeof t.addEventListener === "function") t.addEventListener("ended", () => { if (s === stream) cameraLost("The camera stopped"); });
        }
      } catch { /* a minimal stream */ }
      render();
    }, (err) => {
      if (token !== camToken) return;
      cameraLost(cameraReason(err));
    });
  }
  function cameraLost(reason) {
    camPending = null;
    camBlocked = true;
    if (stream) { stopTracks(stream); stream = null; camAsked = ""; camFacing = ""; }
    mode = "off"; items = []; order = []; pos = 0; itemsKey = "off";
    cam = "blocked";
    render();
    status(reason);
  }
  function askThenStart(facing) {
    const token = ++camToken;
    camPending = { facing, kind: "ask" };
    let p;
    try {
      p = nav.permissions && typeof nav.permissions.query === "function"
        ? nav.permissions.query({ name: "camera" })
        : Promise.reject(new Error("no Permissions API"));
    } catch (e) { p = Promise.reject(e); }
    Promise.resolve(p).then((r) => (r && r.state) || "unknown", () => "unknown").then((state) => {
      if (token !== camToken) return;
      camPending = null;
      if (state === "granted") startCamera(facing);
      else { cam = "needs-tap"; camAskedFacing = facing; render(); }
    });
  }
  function ensureCamera(gesture) {
    if (docHidden()) { dropCamera(); return; }
    const facing = facingSetting();
    if (stream) {
      if (camAsked === facing) { cam = "on"; paintCamera(); return; }
      startCamera(facing);                 // a facing change while live: the permission is already in use
      return;
    }
    // A start already on its way for this facing: wait for it. A pending QUERY yields to a gesture (the
    // user just picked Camera: ask the browser now, inside their action, rather than show the tap button).
    if (camPending && camPending.facing === facing && (camPending.kind === "start" || !gesture)) return;
    if (gesture) { startCamera(facing); return; }
    if (cam === "needs-tap" && camAskedFacing === facing) { paintCamera(); return; }
    askThenStart(facing);
  }

  // --- the one reconcile ----------------------------------------------------------------------------
  function render(gesture = false) {
    const want = shown ? mode : "off";
    if (want !== "video") dropVideo();
    if (want !== "photo") dropPhotos();
    if (want !== "camera") dropCamera();
    if (want === "video") showVideo();
    else if (want === "photo") showPhotos();
    else if (want === "camera") ensureCamera(gesture);
    chrome();
  }

  function update(gesture) {
    const wanted = get("bg.mode");
    // The category. Auto follows it to whichever kind carries it (a photo-only folder shows photos); an
    // explicit Videos / Photos ignores a category its kind does not carry, and a category nothing carries
    // any more counts as "all" — the Settings select lists only the shown kind's folders, so a stale
    // value must never leave the stage blank with no way to see why.
    const cat = get("bg.category");
    const carries = (arr) => typeof cat === "string" && cat !== "" && cat !== "all" && arr.some((i) => i.category === cat);
    const inV = carries(list.videos), inP = carries(list.photos);
    const vCat = wanted === "auto" ? (inV || inP ? cat : "all") : inV ? cat : "all";
    const pCat = wanted === "auto" ? (inV || inP ? cat : "all") : inP ? cat : "all";
    const vids = filterCategory(list.videos, vCat);
    const pics = filterCategory(list.photos, pCat);
    let m = resolveMode(wanted, { videos: vids, photos: pics });
    if (m === "camera") {
      if (insecure()) { m = "off"; cam = "insecure"; }
      else if (!nav || !nav.mediaDevices || typeof nav.mediaDevices.getUserMedia !== "function") {
        if (!camBlocked) { camBlocked = true; cam = "blocked"; status("This browser has no camera access"); }
        m = "off"; cam = "blocked";
      } else {
        if (gesture) camBlocked = false;
        if (camBlocked) { m = "off"; cam = "blocked"; }
        else if (cam === "insecure" || cam === "blocked") cam = "off";
      }
    } else if (cam !== "off") {
      // Not in camera mode: whatever ran is stopped by render(); the state reads "off".
      cam = "off";
    }
    const pool = m === "video" ? vids : m === "photo" ? pics : [];
    const key = m + "\n" + pool.map((i) => i.url).join("\n");
    if (key !== itemsKey) {
      itemsKey = key; items = pool; order = shuffled(pool.length); pos = 0;
      failures = 0; gaveUp = false;
    }
    mode = m;
    render(gesture);
    if (mode === "photo" && photoEls && front >= 0) schedulePhoto();   // a new interval applies at once
  }

  function onVisibility() { render(); }
  try { if (doc && typeof doc.addEventListener === "function") doc.addEventListener("visibilitychange", onVisibility); } catch { /* no document */ }
  chrome();

  return {
    async init() {
      const token = ++initToken;
      let body = null; let ok = false;
      try {
        if (typeof fetchList === "function") { body = await fetchList(); ok = true; }
      } catch { ok = false; }
      if (token !== initToken) return;          // a newer refresh is on its way
      if (ok) { list = normalizeList(body); listLoaded = true; }
      else if (!listLoaded) list = normalizeList(null);   // a failed refresh keeps the last good list
      update(false);
    },
    applySettings({ gesture = false } = {}) { update(gesture === true); },
    onSongChange(kind, idle) {
      const k = typeof kind === "string" ? kind : "";
      const isIdle = idle === true;
      if (!isIdle && !k) return;               // between songs: keep what is on screen
      if (!isIdle && changeOnSong() && (mode === "video" || mode === "photo")) step();
      shown = shouldShow(k, isIdle);
      render();
    },
    next() {
      if (mode !== "video" && mode !== "photo") return;
      if (step()) render();
    },
    stop() {
      dropVideo(); dropPhotos(); dropCamera();
      mode = "off"; items = []; order = []; pos = 0; itemsKey = "";
      if (cam === "on" || cam === "needs-tap") cam = "off";
      chrome();
    },
    get state() {
      const i = mode === "video" || mode === "photo" ? currentIndex() : -1;
      return { mode, index: i, count: mode === "video" || mode === "photo" ? items.length : 0, camera: cam };
    },
    get list() { return list; },
  };
}
