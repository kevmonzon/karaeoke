/*
 * bgv.js — configurable background video layer.
 *
 * Clip sources, in priority order:
 *   1. config.bgv.files  (bare names resolve under /bgv/, full URLs as-is)
 *   2. /manifest.json  (written by serve.py from whatever you drop in the
 *      data/bgv/ folder — the manifest sits one level up, beside the catalogs)
 * If no clips are available (or bgv is disabled) the layer stays hidden and the
 * page's animated gradient shows through.
 */

const BGV_DIR = "/bgv/";                       // served from DATA_DIR/bgv (see tools/serve.py)
const MANIFEST_URL = "/manifest.json";
const VIDEO_RE = /\.(mp4|webm|ogg|mov)$/i;

function resolve(name, dir) {
  return /^https?:\/\//.test(name) || name.startsWith("/") ? name : dir + name;
}

export class BackgroundVideo {
  constructor(videoEl, settings) {
    this.video = videoEl;
    this.settings = settings;
    this.clips = [];
    this._seq = 0;
    this._current = null;
    this.video.muted = true;
    this.video.loop = true;
    this.video.playsInline = true;
  }

  async init() {
    const dir = this.settings.get("data.bgvDir") || BGV_DIR;
    const manifestUrl = this.settings.get("data.bgvManifestUrl") || MANIFEST_URL;
    const configured = (this.settings.get("bgv.files") || []).map((n) => resolve(n, dir));
    let discovered = [];
    try {
      const res = await fetch(manifestUrl, { cache: "no-cache" });
      if (res.ok) {
        const list = await res.json();
        discovered = (Array.isArray(list) ? list : []).filter((n) => VIDEO_RE.test(n)).map((n) => resolve(n, dir));
      }
    } catch (_) {}
    // de-dupe, config first
    this.clips = [...new Set([...configured, ...discovered])];
    this.applySettings();
  }

  get available() {
    return this.clips.length > 0;
  }

  applySettings() {
    const enabled = this.settings.get("bgv.enabled") && this.available;
    this.video.style.opacity = enabled ? this.settings.get("bgv.opacity") : 0;
    this.video.style.display = enabled ? "block" : "none";
    document.body.classList.toggle("bgv-active", !!enabled);
    if (enabled && !this._current) this.next();
    else if (!enabled) this.video.pause();
  }

  _pick() {
    if (!this.clips.length) return null;
    if (this.settings.get("bgv.mode") === "sequential") {
      const clip = this.clips[this._seq % this.clips.length];
      this._seq++;
      return clip;
    }
    return this.clips[Math.floor(Math.random() * this.clips.length)];
  }

  /** Load and play the next clip (respects enabled state). */
  next() {
    if (!this.settings.get("bgv.enabled") || !this.available) return;
    const clip = this._pick();
    if (!clip) return;
    this._current = clip;
    this.video.src = clip;
    this.video.style.display = "block";
    this.video.style.opacity = this.settings.get("bgv.opacity");
    const p = this.video.play();
    if (p && p.catch) p.catch(() => {}); // muted autoplay should be allowed
  }

  /** Called when a new song starts. */
  onSongStart() {
    if (this.settings.get("bgv.changePerSong")) this.next();
  }
}
