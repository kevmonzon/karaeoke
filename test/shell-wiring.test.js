// The stage-first shell's integration seams that can be checked without a browser (M3, lane I).
//
// library-ui.js measures a real row instead of parsing --row-h, because --row-h is now an
// expression over the viewport-driven scale unit. The list lives in a panel that is display:none
// until it opens, so the first measurements are 0. Caching that would lay the first open out on
// the wrong grid; these tests pin "never cache a zero, cache a real height until refresh".
import { test } from "node:test";
import assert from "node:assert/strict";
import { measureRow, createLibraryUI } from "../src/js/library-ui.js";

/** A <ul> stand-in: a probe appended to it measures `list.rowHeight`; detached, it measures 0. */
function fakeList() {
  const listeners = {};
  const list = {
    rowHeight: 0,
    children: [],
    probes: 0,
    style: { props: {}, setProperty(k, v) { this.props[k] = v; } },
    scrollTop: 0,
    clientHeight: 400,
    addEventListener(type, fn) { listeners[type] = fn; },
    appendChild(el) { el.parent = list; list.children.push(el); if (el.className === "song") list.probes++; return el; },
    replaceChildren(...els) { list.children = []; for (const el of els) list.appendChild(el); },
    contains: () => false,
    querySelector: () => null,
    querySelectorAll: () => [],
  };
  const makeEl = (tag) => ({
    tagName: String(tag).toUpperCase(),
    className: "",
    attrs: {},
    innerHTML: "",
    textContent: "",
    parent: null,
    children: [],
    style: {},
    setAttribute(k, v) { this.attrs[k] = String(v); },
    appendChild(c) { this.children.push(c); return c; },
    getBoundingClientRect() { return { height: this.parent === list ? list.rowHeight : 0 }; },
    remove() {
      if (!this.parent) return;
      const i = this.parent.children.indexOf(this);
      if (i >= 0) this.parent.children.splice(i, 1);
      this.parent = null;
    },
  });
  list.ownerDocument = { createElement: makeEl };
  return { list, makeEl, listeners };
}

/** Just enough of document/window for createLibraryUI + refresh() on an empty list. */
function withFakeDom(fn) {
  const { list, makeEl } = fakeList();
  const win = {};
  const saved = { document: globalThis.document, window: globalThis.window, raf: globalThis.requestAnimationFrame };
  globalThis.document = {
    activeElement: null,
    getElementById: (id) => (id === "song-list" ? list : null),
    createElement: makeEl,
    createDocumentFragment: () => makeEl("#fragment"),
  };
  globalThis.window = { addEventListener(type, f) { win[type] = f; } };
  globalThis.requestAnimationFrame = (f) => f();
  try {
    return fn({ list, win });
  } finally {
    globalThis.document = saved.document;
    globalThis.window = saved.window;
    globalThis.requestAnimationFrame = saved.raf;
  }
}

const noop = () => {};
const libDeps = { onPlay: noop, onQueue: noop, onRemoveFromQueue: noop, onToggleFavorite: noop, isFavorite: () => false };

// Runs first: the module-level cache is still empty in this process.
test("library-ui: a zero-height probe is not cached", () => {
  const { list } = fakeList();
  list.rowHeight = 0;                       // the panel is display:none
  assert.equal(measureRow(list), 48, "a zero measurement falls back to 48");
  assert.equal(list.children.length, 0, "the probe is removed again");
  assert.equal(list.probes, 1);

  list.rowHeight = 72;                      // the panel opened (1080p, medium)
  assert.equal(measureRow(list), 72, "the fallback was not cached: the next call measures again");
  assert.equal(list.probes, 2);
  assert.equal(list.children.length, 0);
});

test("library-ui: a measured height is cached until refresh", () => {
  withFakeDom(({ list }) => {
    const lib = createLibraryUI(libDeps);
    list.rowHeight = 60;
    lib.refresh();                          // clears the cache, then re-measures for --vlist-h
    assert.equal(measureRow(list), 60);
    const probes = list.probes;

    list.rowHeight = 90;                    // the CSS changed, but nothing told the list yet
    assert.equal(measureRow(list), 60, "a real height is cached");
    assert.equal(list.probes, probes, "…and cached means no new probe (no forced layout per scroll)");

    lib.refresh();                          // the font-size path and the panel's onOpen call this
    assert.equal(measureRow(list), 90, "refresh() re-measures");
    assert.equal(list.style.props["--vlist-h"], "0px", "the scroll extent is re-sized from the new height");
  });
});

test("library-ui: a window resize clears the cached height", () => {
  withFakeDom(({ list, win }) => {
    const lib = createLibraryUI(libDeps);
    list.rowHeight = 72;
    lib.refresh();
    assert.equal(measureRow(list), 72);

    list.rowHeight = 44;                    // the scale unit follows the viewport
    assert.equal(typeof win.resize, "function", "library-ui listens for resize");
    win.resize();
    assert.equal(measureRow(list), 44);
  });
});

test("library-ui: the probe is an invisible, aria-hidden song row", () => {
  withFakeDom(({ list }) => {
    const lib = createLibraryUI(libDeps);
    list.rowHeight = 0;
    lib.refresh();                          // empty cache and a hidden panel → every call probes
    let seen = null;
    const append = list.appendChild;
    list.appendChild = (el) => { if (el.className === "song") seen = el; return append(el); };
    measureRow(list);
    list.appendChild = append;
    assert.ok(seen, "a probe row was appended to the list");
    assert.equal(seen.tagName, "LI");
    assert.equal(seen.attrs["aria-hidden"], "true");
    assert.match(seen.attrs.style, /visibility:\s*hidden/);
    assert.equal(seen.parent, null, "and taken out again");
  });
});
