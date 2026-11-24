/*
 * easter-egg.js — the Konami code (Rae, 2026-11-25): ↑ ↑ ↓ ↓ ← → ← → A B Enter, and a picture rises
 * from the bottom of the screen, dances around, and is gone after 5 seconds.
 *
 * The keys are WATCHED, not routed: one capture-phase listener on the window sees every key before
 * any widget or the key router (app.js routeKey) does, so a list that swallows its arrows cannot
 * hide them from the code. It changes nothing on the way — the arrows still move focus — except the
 * final Enter that completes the code, which it consumes so it does not also press whatever has
 * focus. Keys typed into a text field are not watched (they are typing, and A / B would land there).
 *
 * The picture (easter-egg-image.js, a base64 PNG) is imported only when the code is entered.
 * The motion is CSS (stage.css "Easter egg"); prefers-reduced-motion gets a plain fade instead.
 */

export const KONAMI = Object.freeze([
  "ArrowUp", "ArrowUp", "ArrowDown", "ArrowDown",
  "ArrowLeft", "ArrowRight", "ArrowLeft", "ArrowRight",
  "a", "b", "Enter",
]);

/** How long the picture is on screen (rise, dance, leave), in ms. Matches stage.css's 5 s. */
export const EGG_MS = 5000;

// keyCode → key name for remotes / TV browsers that send no key name.
const KEY_CODES = { 13: "Enter", 37: "ArrowLeft", 38: "ArrowUp", 39: "ArrowRight", 40: "ArrowDown", 65: "a", 66: "b" };

/** One keydown as the code spells it: arrows as named, letters lower-case, any Enter as "Enter". Pure. */
export function eggKey(ev) {
  if (!ev) return "";
  let k = typeof ev.key === "string" ? ev.key : "";
  if (!k || k === "Unidentified") k = KEY_CODES[ev.keyCode] || "";
  if (k === "NumpadEnter") return "Enter";
  return k.length === 1 ? k.toLowerCase() : k;
}

/**
 * Watches a key stream for `seq`. feed(key) → true exactly when the last keys spell it, then starts
 * over. A rolling window, so a stray key only costs the keys before it ("↑ ↑ ↑ ↓ ↓ …" still counts —
 * the last two ↑ start the code). Pure.
 */
export function createSequenceMatcher(seq = KONAMI) {
  const want = [...seq];
  let recent = [];
  return {
    feed(key) {
      recent.push(key);
      if (recent.length > want.length) recent.shift();
      if (recent.length === want.length && recent.every((k, i) => k === want[i])) { recent = []; return true; }
      return false;
    },
    reset() { recent = []; },
  };
}

/** Is focus in a field that takes typing? (the key router's own test, app.js routeKey). */
function typingIn(el) {
  if (!el) return false;
  if (el.isContentEditable) return true;
  return /^(INPUT|TEXTAREA)$/.test(el.tagName || "") && !/^(range|checkbox|radio|button|color)$/.test(el.type || "");
}

/**
 * Install the watcher. Returns { play, uninstall } (play() shows the picture without the code — tests).
 * @param {object} [o]
 * @param {Window} [o.win]
 * @param {Document} [o.doc]
 * @param {() => Promise<string>} [o.loadImage]  the picture's URL (default: the base64 module, lazily)
 * @param {Function} [o.setTimer] / [o.clearTimer]  setTimeout stand-ins (tests)
 */
export function installEasterEgg({
  win = typeof window !== "undefined" ? window : null,
  doc = typeof document !== "undefined" ? document : null,
  loadImage = () => import("./easter-egg-image.js").then((m) => m.EASTER_EGG_PNG),
  setTimer = (fn, ms) => setTimeout(fn, ms),
  clearTimer = (id) => clearTimeout(id),
} = {}) {
  if (!win || !doc) return { play: async () => false, uninstall() {} };
  const matcher = createSequenceMatcher(KONAMI);
  let showing = null;   // the element on screen, while it dances
  let timer = null;

  async function play() {
    if (showing) return false;   // one at a time: the code again mid-dance does nothing
    const host = doc.createElement("div");
    host.className = "egg";
    host.setAttribute("aria-hidden", "true");
    showing = host;
    let src;
    try { src = await loadImage(); } catch { showing = null; return false; }
    if (showing !== host || !doc.body) return false;
    const dancer = doc.createElement("div");
    dancer.className = "egg-dancer";
    const img = doc.createElement("img");
    img.className = "egg-img";
    img.alt = "";
    img.decoding = "async";
    img.src = src;
    dancer.appendChild(img);
    host.appendChild(dancer);
    doc.body.appendChild(host);
    timer = setTimer(() => {
      timer = null;
      host.remove();
      if (showing === host) showing = null;
    }, EGG_MS);
    return true;
  }

  function onKey(ev) {
    if (ev.repeat) return;                      // a held key is one key
    if (typingIn(doc.activeElement)) { matcher.reset(); return; }
    if (!matcher.feed(eggKey(ev))) return;
    // The code's last key is Enter: keep it from also activating the focused control.
    ev.preventDefault();
    ev.stopPropagation();
    play();
  }

  win.addEventListener("keydown", onKey, true);
  return {
    play,
    uninstall() {
      win.removeEventListener("keydown", onKey, true);
      if (timer != null) { clearTimer(timer); timer = null; }
      if (showing) { showing.remove(); showing = null; }
    },
  };
}
