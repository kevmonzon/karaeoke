/*
 * lyrics-stage.js — the STAGE lyric view: fixed rows drawn on a <canvas>, the way a
 * videoke machine shows them (behaviour modelled on the commercial videoke app; clean-room —
 * the rules live in lyric-pager.js, the look is reproduced here from its numbers).
 *
 *   - two rows take turns (four in portrait): the line being sung, plus the line just sung
 *     (fully coloured) until the singer reaches the new line's 2nd syllable, then a preview of
 *     the next one (white)
 *   - three-pass paint: black outline + drop shadow, white fill for what is still to sing, and
 *     a hard-edged wipe that turns sung text to the highlight colour with a WHITE outline
 *   - (backing vocals) lose their brackets and turn orange; @m/@w/@c duet tags tint the line
 *   - a 4-3-2-1-GO count-in above a line that follows a long break (or the file's own '#'
 *     cues), an "Instrumental" pill while the rows are blank, and an optional 320 ms line
 *     change animation (fade / wipe / crossfade / flip / bounce)
 *
 * Same public surface as LyricsEngine (load / loadLines / update / reset / clear /
 * setOptions + lines / activeLine / hasLyrics), so the score's per-line bonus and app.js
 * treat both alike. LyricsSwitch (below) holds one of each and routes to the chosen style.
 *
 * Performance: each visible line is painted ONCE into two offscreen bitmaps (unsung + sung,
 * per wrapped row); a frame is then two drawImage calls per row, split at the wipe edge. The
 * outline + shadow text rendering — the expensive part — never runs per frame.
 */

import { buildLyrics, makeTickToSeconds } from "./lyrics.js";
import {
  STAGE, STAGE_ANIMATIONS, STAGE_ALIGNS, STAGE_PALETTE, SINGER_COLORS, SINGER_MARKS, BACKING_COLOR,
  COUNTDOWN_COLORS, GO_COLOR, makeBeatAt, prepareStageLines, buildCountdowns, makeStagePlan, pageAt,
  lineIndexAt, wipeWidth, wrapRows, alignX, animFrame,
} from "./lyric-pager.js";

const DEFAULTS = Object.freeze({
  rows: "auto",        // "auto" (2 rows, 4 when the screen is portrait) | "2" | "4"
  align: "center",     // STAGE_ALIGNS
  animation: "none",   // STAGE_ANIMATIONS
  color: "#0000FF",    // highlight (sung) colour
  randomColor: false,  // pick a highlight from STAGE_PALETTE once per song instead
  outline: 6,          // outline thickness, in "points" of a 63-point lyric font
  shadow: true,
  countdown: true,
  interlude: true,
  smooth: true,        // false = each syllable flips whole at its cue (shared with the scroll view)
});

// The reference proportions, relative to the lyric font size (landscape 63 / portrait 42).
const LANDSCAPE = { ref: 63, bottom: 45, gap: 12, side: 40 };
const PORTRAIT = { ref: 42, bottom: 40, gap: 8, side: 40 };
const LINE_PITCH = 1.33;
const FONT_BOOST = 1.3;          // vs the scroll view's font: two big rows instead of a column
const FIT_2 = 4.4, FIT_4 = 7.5;  // font-heights the 2- and 4-row layouts need (rows + margins + count-in)
const CACHE_LINES = 24;

const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));

export class StageLyricsEngine {
  /** @param {HTMLElement} container  #lyrics — the canvas is appended (the scroll view's DOM is left alone) */
  constructor(container, opts = {}) {
    this.container = container;
    this.canvas = document.createElement("canvas");
    this.canvas.className = "lyric-stage";
    this.canvas.setAttribute("aria-hidden", "true");
    container.appendChild(this.canvas);
    this.ctx = this.canvas.getContext("2d");

    this.opts = { ...DEFAULTS };
    this.enabled = true;     // LyricsSwitch turns drawing off while the scroll view is showing
    this.lines = [];
    this.plan = null;
    this.hasLyrics = false;
    this.activeLine = -1;
    this._noLyrics = false;  // a song is loaded but has no lyrics → placeholder (vs. a cleared stage)
    this._random = null;
    this.color = DEFAULTS.color;
    this._cache = new Map(); // line index → painted rows (LRU)
    this._geo = null;
    this._slots = [];
    this._anims = [];
    this._t = 0;

    this.setOptions(opts);
    if (typeof ResizeObserver === "function") {
      this._ro = new ResizeObserver(() => this.redraw());
      this._ro.observe(container);
    } else {
      window.addEventListener("resize", () => this.redraw());
    }
  }

  setOptions(o = {}) {
    for (const k of Object.keys(DEFAULTS)) if (o[k] !== undefined) this.opts[k] = o[k];
    if (!STAGE_ANIMATIONS.includes(this.opts.animation)) this.opts.animation = DEFAULTS.animation;
    if (!STAGE_ALIGNS.includes(this.opts.align)) this.opts.align = DEFAULTS.align;
    this.opts.outline = clamp(+this.opts.outline || 0, 0, 16);
    this.opts.rows = String(this.opts.rows);
    this._pickColor();
    this.redraw();
  }

  load(parsed) {
    const t2s = makeTickToSeconds(parsed);
    const { lines, cues } = buildLyrics(parsed.lyricEvents, t2s);
    const beatAt = parsed.isSmpte ? () => STAGE.DEFAULT_BEAT : makeBeatAt(parsed.tempoMap, t2s);
    return this._setLines(lines, cues, beatAt);
  }

  /** Pre-built raw lines (the AUDIO sidecars). No tempo, so beats default to 120 bpm. */
  loadLines(rawLines) {
    return this._setLines(Array.isArray(rawLines) ? rawLines : [], [], () => STAGE.DEFAULT_BEAT);
  }

  _setLines(raw, cues, beatAt) {
    this.lines = prepareStageLines(raw, beatAt);
    this.plan = makeStagePlan(this.lines, buildCountdowns(this.lines, cues, beatAt));
    this.hasLyrics = this.lines.length > 0;
    this._noLyrics = !this.hasLyrics;
    this._random = null;
    this._pickColor();
    this._cache.clear();
    this._slots = [];
    this._anims = [];
    this.activeLine = -1;
    this._t = 0;
    this.redraw();
    return this.hasLyrics;
  }

  reset() {
    this.activeLine = -1;
    this._slots = [];
    this._anims = [];
    this._t = 0;
    this.redraw();
  }

  clear() {
    this.lines = [];
    this.plan = null;
    this.hasLyrics = false;
    this._noLyrics = false;
    this.activeLine = -1;
    this._cache.clear();
    this._slots = [];
    this._anims = [];
    this.redraw();
  }

  /** Call every frame with the (offset-adjusted) playback time in seconds. */
  update(t) {
    this._t = t;
    this.activeLine = lineIndexAt(this.lines, t);
    if (this.enabled) this._render(t);
  }

  /** Re-measure (size / font / settings changed) and repaint at the last time. */
  redraw() {
    this._geo = null;
    if (this.enabled) this._render(this._t);
  }

  _pickColor() {
    if (this.opts.randomColor) {
      if (!this._random) this._random = STAGE_PALETTE[Math.floor(Math.random() * STAGE_PALETTE.length)];
      this.color = this._random;
    } else {
      this.color = this.opts.color || DEFAULTS.color;
    }
  }

  // ------------------------------------------------------------------ geometry
  _geometry() {
    if (this._geo) return this._geo;
    const cw = this.container.clientWidth;
    const ch = this.container.clientHeight;
    const dpr = clamp(window.devicePixelRatio || 1, 1, 3);
    const bw = Math.round(cw * dpr), bh = Math.round(ch * dpr);
    if (this.canvas.width !== bw || this.canvas.height !== bh) { this.canvas.width = bw; this.canvas.height = bh; }

    const cs = getComputedStyle(this.container);
    const cssFont = parseFloat(cs.fontSize) || 32;
    const fontScale = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--font-scale")) || 1;
    const portrait = window.innerHeight > window.innerWidth;
    const rows = this.opts.rows === "2" ? 2 : this.opts.rows === "4" ? 4 : (portrait ? 4 : 2);
    const P = rows === 4 ? PORTRAIT : LANDSCAPE;
    let font = Math.max(cssFont * FONT_BOOST, ch * 0.1 * fontScale);
    font = Math.max(12, Math.min(font, ch / (rows === 4 ? FIT_4 : FIT_2)));
    const u = font / P.ref;
    const family = cs.fontFamily || "system-ui, sans-serif";
    const fontStr = `800 ${font.toFixed(1)}px ${family}`;
    this.ctx.font = fontStr;
    const m = this.ctx.measureText("ÁÉgjy");
    const ascent = m.fontBoundingBoxAscent || font * 0.92;
    const descent = m.fontBoundingBoxDescent || font * 0.26;
    const side = P.side * u;
    const g = {
      cw, ch, dpr, rows, font, fontStr, family, ascent, descent,
      lineH: font * LINE_PITCH, bottom: P.bottom * u, gap: P.gap * u, side,
      maxW: Math.max(40, cw - 2 * side),
      stroke: this.opts.outline * u, shadowBlur: 4 * u, shadowOff: 2 * u,
    };
    const key = [dpr, font.toFixed(1), g.maxW.toFixed(0), rows, this.opts.outline, this.opts.shadow, this.color, family].join("|");
    if (key !== this._cacheKey) { this._cache.clear(); this._cacheKey = key; }
    this._geo = g;
    return g;
  }

  // ------------------------------------------------------------------ painting a line once
  _lineArt(idx) {
    const hit = this._cache.get(idx);
    if (hit) { this._cache.delete(idx); this._cache.set(idx, hit); return hit; }
    const g = this._geo;
    const L = this.lines[idx];
    const ctx = this.ctx;
    ctx.font = g.fontStr;
    const widths = L.syllables.map((s) => ctx.measureText(s.text).width);
    const mark = L.showSinger ? SINGER_MARKS[L.singer] || null : null;
    const markW = mark ? ctx.measureText(mark + " ").width : 0;
    const total = widths.reduce((a, b) => a + b, 0) + markW;
    const rowsOf = g.rows === 4
      ? [{ from: 0, to: L.syllables.length, width: total }]   // four-row mode never wraps (it squashes)
      : wrapRows(L.syllables, widths, g.maxW, markW);
    const lineColor = SINGER_COLORS[L.singer] || this.color;
    const pad = Math.ceil(g.stroke + g.shadowBlur * 1.5 + g.shadowOff + 2);
    const h = Math.ceil(g.ascent + g.descent + 2 * pad);
    const art = {
      rows: rowsOf.map((r, ri) => {
        const rowMark = ri === 0 ? mark : null;
        const rowMarkW = ri === 0 ? markW : 0;
        const paint = (sung) => this._paintRow(L, r, rowMark, rowMarkW, widths, pad, h, sung, lineColor);
        return {
          width: r.width, markW: rowMarkW, pad, h,
          sylls: L.syllables.slice(r.from, r.to), widths: widths.slice(r.from, r.to),
          base: paint(false), sung: paint(true),
        };
      }),
    };
    this._cache.set(idx, art);
    while (this._cache.size > CACHE_LINES) this._cache.delete(this._cache.keys().next().value);
    return art;
  }

  _paintRow(L, row, mark, markW, widths, pad, h, sung, lineColor) {
    const g = this._geo;
    const c = document.createElement("canvas");
    c.width = Math.max(1, Math.ceil((row.width + 2 * pad) * g.dpr));
    c.height = Math.max(1, Math.ceil(h * g.dpr));
    const x = c.getContext("2d");
    x.scale(g.dpr, g.dpr);
    x.font = g.fontStr;
    x.textBaseline = "alphabetic";
    x.lineJoin = "round";
    const y = pad + g.ascent;
    const items = [];
    let cx = pad;
    if (mark) { items.push({ text: mark + " ", x: cx, fill: lineColor, mark: true }); cx += markW; }
    for (let i = row.from; i < row.to; i++) {
      const s = L.syllables[i];
      items.push({ text: s.text, x: cx, fill: s.paren ? BACKING_COLOR : lineColor, mark: false });
      cx += widths[i];
    }
    // shadow lives on the FIRST visible pass only (the black outline, or the fill without one).
    // Canvas shadows ignore the transform, hence the explicit × dpr.
    const shadowOn = () => {
      if (!this.opts.shadow) return;
      x.shadowColor = "#000";
      x.shadowBlur = g.shadowBlur * g.dpr;
      x.shadowOffsetX = x.shadowOffsetY = g.shadowOff * g.dpr;
    };
    const shadowOff = () => { x.shadowColor = "transparent"; x.shadowBlur = 0; x.shadowOffsetX = x.shadowOffsetY = 0; };
    const hasStroke = g.stroke > 0.05;
    if (hasStroke) {
      x.lineWidth = g.stroke;
      x.strokeStyle = "#000";
      shadowOn();
      for (const it of items) x.strokeText(it.text, it.x, y);
      shadowOff();
    } else {
      shadowOn();
    }
    if (!sung) {
      for (const it of items) { x.fillStyle = it.mark ? it.fill : "#FFFFFF"; x.fillText(it.text, it.x, y); }
    } else {
      if (hasStroke) {
        x.strokeStyle = "#FFFFFF";
        for (const it of items) if (!it.mark) x.strokeText(it.text, it.x, y);
      }
      for (const it of items) { x.fillStyle = it.fill; x.fillText(it.text, it.x, y); }
    }
    shadowOff();
    return c;
  }

  // ------------------------------------------------------------------ per-frame
  _render(t) {
    const g = this._geometry();
    const ctx = this.ctx;
    ctx.setTransform(g.dpr, 0, 0, g.dpr, 0, 0);
    ctx.clearRect(0, 0, g.cw, g.ch);
    if (!g.cw || !g.ch) return;
    if (!this.hasLyrics) { if (this._noLyrics) this._drawNote("♪  instrumental — no lyrics in this file  ♪", g.ch / 2, 0.42); return; }

    const page = pageAt(this.plan, t, g.rows);
    const now = performance.now();
    this._track(page.slots, now);

    // Baselines of each slot's LAST row. Rows of a wrapped line stack upward from there.
    const y = new Array(g.rows);
    if (g.rows === 2) {
      const bottomRows = page.slots[1] ? this._lineArt(page.slots[1].index).rows.length : 1;
      y[1] = g.ch - g.bottom;
      y[0] = y[1] - bottomRows * g.lineH - g.gap;
    } else {
      y[3] = g.ch - g.bottom;
      for (let i = 2; i >= 0; i--) y[i] = y[i + 1] - g.lineH - g.gap;
    }

    for (let i = 0; i < g.rows; i++) {
      const cur = page.slots[i];
      const a = this._anims[i];
      if (a) {
        const fr = animFrame(this.opts.animation, (now - a.t0) / STAGE.ANIM_MS);
        if (fr.old) this._drawLine(i, a.old, y[i], t, fr.old);
        if (fr.new && cur) this._drawLine(i, cur, y[i], t, fr.new);
      } else if (cur) {
        this._drawLine(i, cur, y[i], t, null);
      }
    }

    if (page.countdown && this.opts.countdown && page.focus >= 0) {
      const slot = page.slots.findIndex((s) => s && s.index === page.focus);
      if (slot >= 0) {
        const art = this._lineArt(page.focus);
        const firstBaseline = y[slot] - (art.rows.length - 1) * g.lineH;
        const x = this._rowX(art.rows[0], slot);
        this._drawCountdown(page.countdown, x, firstBaseline - g.ascent - g.font * 0.12);
      }
    }
    if (page.interlude && this.opts.interlude) this._drawNote("♪  Instrumental  ♪", g.ch - g.bottom - g.lineH * 0.55, 0.5);
  }

  /** Start a row's line-change animation when its content changes (old + new both present). */
  _track(slots, now) {
    for (let i = 0; i < slots.length; i++) {
      const cur = slots[i] || null;
      const prev = this._slots[i] || null;
      if ((cur ? cur.index : -1) !== (prev ? prev.index : -1)) {
        this._anims[i] = this.opts.animation !== "none" && cur && prev ? { old: prev, t0: now } : null;
      } else if (this._anims[i] && now - this._anims[i].t0 >= STAGE.ANIM_MS) {
        this._anims[i] = null;
      }
      this._slots[i] = cur;
    }
  }

  _rowX(row, slot) {
    const g = this._geo;
    if (g.rows === 4) return (g.cw - Math.min(row.width, g.maxW)) / 2;   // four rows: always centred
    return alignX(row.width, g.cw, slot % 2 ? "right" : "left", this.opts.align, g.side);
  }

  _drawLine(slot, entry, lastBaseline, t, fx) {
    const g = this._geo;
    const art = this._lineArt(entry.index);
    const k = art.rows.length;
    for (let r = 0; r < k; r++) {
      const row = art.rows[r];
      const baseline = lastBaseline - (k - 1 - r) * g.lineH;
      const squash = g.rows === 4 && row.width > g.maxW ? g.maxW / row.width : 1;
      this._drawRow(row, this._rowX(row, slot), baseline, entry.state, t, fx, squash);
    }
  }

  _drawRow(row, x, baseline, state, t, fx, squash) {
    const g = this._geo;
    const ctx = this.ctx;
    const dpr = g.dpr;
    const dx = x - row.pad;
    const dy = baseline - g.ascent - row.pad;
    const W = row.base.width / dpr;
    const H = row.base.height / dpr;
    ctx.save();
    if (fx && fx.alpha < 1) ctx.globalAlpha = Math.max(0, fx.alpha);
    if (fx && fx.scaleY !== 1) {
      const py = baseline - g.ascent / 2;   // pivot on the middle of the glyphs
      ctx.translate(0, py); ctx.scale(1, fx.scaleY); ctx.translate(0, -py);
    }
    if (squash !== 1) {
      const px = g.cw / 2;
      ctx.translate(px, 0); ctx.scale(squash, 1); ctx.translate(-px, 0);
    }
    if (fx && fx.reveal < 1) { ctx.beginPath(); ctx.rect(0, 0, fx.reveal * g.cw, g.ch); ctx.clip(); }

    if (state === 2) {
      ctx.drawImage(row.sung, dx, dy, W, H);
    } else if (state === 0) {
      ctx.drawImage(row.base, dx, dy, W, H);
    } else {
      const w = wipeWidth(row.sylls, row.widths, t, this.opts.smooth);
      const textW = row.width - row.markW;
      let cut = 0;
      if (w > 0) cut = row.pad + row.markW + w + (w >= textW - 1 ? row.pad : 0);  // keep the last outline pixel
      const cutD = clamp(Math.round(cut * dpr), 0, row.base.width);
      if (cutD > 0) ctx.drawImage(row.sung, 0, 0, cutD, row.sung.height, dx, dy, cutD / dpr, H);
      if (cutD < row.base.width) {
        ctx.drawImage(row.base, cutD, 0, row.base.width - cutD, row.base.height, dx + cutD / dpr, dy, (row.base.width - cutD) / dpr, H);
      }
    }
    ctx.restore();
  }

  _drawCountdown({ count, phase }, x, baseline) {
    const g = this._geo;
    const ctx = this.ctx;
    const size = g.font * 55 / 63;
    const text = count > 0 ? String(count) : "GO!";
    const fill = count > 0 ? COUNTDOWN_COLORS[(count - 1) % COUNTDOWN_COLORS.length] : GO_COLOR;
    // pop in (1.35 → 1 over the first quarter of the beat), fade over its last fifth
    const scale = phase < 0.25 ? 1.35 - 0.35 * (phase / 0.25) : 1;
    const alpha = phase > 0.8 ? 1 - (phase - 0.8) / 0.2 : 1;
    ctx.save();
    ctx.font = `800 ${size.toFixed(1)}px ${g.family}`;
    const tw = ctx.measureText(text).width;
    const by = Math.max(size * 0.85, baseline);
    const cx = x + tw / 2, cy = by - size * 0.35;
    ctx.globalAlpha = clamp(alpha, 0, 1);
    ctx.translate(cx, cy); ctx.scale(scale, scale); ctx.translate(-cx, -cy);
    ctx.lineJoin = "round";
    ctx.lineWidth = size * 6 / 55;
    ctx.strokeStyle = "#000";
    if (this.opts.shadow) {
      ctx.shadowColor = "#000";
      ctx.shadowBlur = size * 5 / 55 * g.dpr;
      ctx.shadowOffsetX = ctx.shadowOffsetY = size * 3 / 55 * g.dpr;
    }
    ctx.strokeText(text, x, by);
    ctx.shadowColor = "transparent";
    ctx.fillStyle = fill;
    ctx.fillText(text, x, by);
    ctx.restore();
  }

  /** A small centred pill: "Instrumental" during a break, or the no-lyrics note. */
  _drawNote(text, cy, rel) {
    const g = this._geo;
    const ctx = this.ctx;
    const size = Math.max(12, g.font * rel);
    ctx.save();
    ctx.font = `700 ${size.toFixed(1)}px ${g.family}`;
    const tw = ctx.measureText(text).width;
    const w = tw + size * 1.6, h = size * 1.9;
    const x = (g.cw - w) / 2, y = cy - h / 2;
    ctx.fillStyle = "rgba(0, 0, 0, 0.45)";
    ctx.strokeStyle = "rgba(255, 255, 255, 0.28)";
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(x, y, w, h, h / 2); else ctx.rect(x, y, w, h);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = "#FFFFFF";
    ctx.textBaseline = "middle";
    ctx.fillText(text, x + size * 0.8, cy + size * 0.04);
    ctx.restore();
  }
}

/**
 * One lyric surface, two styles. Both engines are always loaded (parsing is milliseconds), so
 * switching style mid-song is instant; only the active one is updated and drawn each frame.
 */
export class LyricsSwitch {
  constructor(scroll, stage, style = "stage") {
    this.scroll = scroll;
    this.stage = stage;
    this.setStyle(style);
  }

  get active() { return this.style === "scroll" ? this.scroll : this.stage; }
  get lines() { return this.active.lines; }
  get activeLine() { return this.active.activeLine; }
  get hasLyrics() { return this.active.hasLyrics; }

  setStyle(style) {
    this.style = style === "scroll" ? "scroll" : "stage";
    const stageOn = this.style === "stage";
    this.stage.enabled = stageOn;
    this.stage.container.classList.toggle("stage-mode", stageOn);
    if (stageOn) this.stage.redraw();
    else this.scroll.setOptions({});   // re-anchor the column now that it is visible again
  }

  /** The scroll view's options (lineCount / smooth / mergeLines); `smooth` is shared. */
  setOptions(o = {}) {
    this.scroll.setOptions(o);
    if (o.smooth !== undefined) this.stage.setOptions({ smooth: o.smooth });
  }

  setStageOptions(o) { this.stage.setOptions(o); }
  redraw() { if (this.style === "stage") this.stage.redraw(); }

  load(parsed) {
    const a = this.scroll.load(parsed);
    const b = this.stage.load(parsed);
    return this.style === "scroll" ? a : b;
  }

  loadLines(rawLines) {
    const a = this.scroll.loadLines(rawLines);
    const b = this.stage.loadLines(rawLines);
    return this.style === "scroll" ? a : b;
  }

  update(t) { this.active.update(t); }
  reset() { this.scroll.reset(); this.stage.reset(); }
  clear() { this.scroll.clear(); this.stage.clear(); }
}
