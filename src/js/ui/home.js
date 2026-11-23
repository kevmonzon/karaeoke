/*
 * home.js — the home layer: the idle stage's tiles and room code (M3, P4 of the plan).
 *
 * Tiles are plain <button class="home-tile" data-tile="id"> children of #home-tiles, in
 * HOME_TILES order, with ONE delegated click listener (no inline handlers). `icon` names a
 * sprite symbol; a tile whose symbol is not in the document renders its label only.
 */

const tile = (id, label, icon) => Object.freeze({ id, label, icon });

export const HOME_TILES = Object.freeze([
  tile("songs", "Songs", "i-search"),
  tile("artists", "Artists", "i-mic"),
  tile("rankings", "Rankings", "i-up"),
  tile("favorites", "Favorites", "i-star"),
  tile("queue", "Queue", "i-queue"),
  tile("tonight", "Tonight", "i-melody"),
  tile("settings", "Settings", "i-settings"),
]);

const SVG_NS = "http://www.w3.org/2000/svg";

/** The enabled tiles in HOME_TILES order; unknown and disabled ids are dropped. No list → all. */
export function homeTiles(enabledIds) {
  if (enabledIds == null) return HOME_TILES.slice();
  const on = new Set(Array.isArray(enabledIds) ? enabledIds : [...enabledIds]);
  return HOME_TILES.filter((t) => on.has(t.id));
}

/**
 * @param {object}   o
 * @param {Element}  o.el       #home (or #home-tiles itself)
 * @param {string[]} [o.enabled] tile ids to show
 * @param {Function} [o.onTile]  (id, button, event) on a tile click
 * @param {Document} [o.doc]
 */
export function createHome({ el, enabled, onTile = () => {}, doc = document } = {}) {
  const find = (id) => {
    if (el && el.id === id) return el;
    const inside = el && typeof el.querySelector === "function" ? el.querySelector(`#${id}`) : null;
    return inside || doc.getElementById(id);
  };
  const tilesEl = find("home-tiles");
  const roomEl = find("home-room");

  if (tilesEl) {
    tilesEl.addEventListener("click", (e) => {
      const t = e && e.target;
      const btn = t && typeof t.closest === "function" ? t.closest(".home-tile") : null;
      if (!btn || !tilesEl.contains(btn)) return;
      onTile(btn.getAttribute("data-tile"), btn, e);
    });
  }

  function makeTile(t) {
    const b = doc.createElement("button");
    b.setAttribute("type", "button");
    b.className = "home-tile";
    b.setAttribute("data-tile", t.id);
    if (t.icon && doc.getElementById(t.icon)) {
      const svg = doc.createElementNS(SVG_NS, "svg");
      svg.setAttribute("class", "icon");
      svg.setAttribute("aria-hidden", "true");
      const use = doc.createElementNS(SVG_NS, "use");
      use.setAttribute("href", `#${t.icon}`);
      svg.append(use);
      b.append(svg);
    }
    const label = doc.createElement("span");
    label.className = "home-tile-label";
    label.textContent = t.label;
    b.append(label);
    return b;
  }

  return {
    /** (Re)build the tiles; a focused tile keeps focus across the rebuild. */
    render() {
      if (!tilesEl) return;
      const active = doc.activeElement;
      const keep = active && tilesEl.contains(active) && typeof active.getAttribute === "function"
        ? active.getAttribute("data-tile") : null;
      const buttons = homeTiles(enabled).map(makeTile);
      tilesEl.replaceChildren(...buttons);
      if (keep) {
        const again = buttons.find((b) => b.getAttribute("data-tile") === keep);
        if (again) again.focus({ preventScroll: true });
      }
    },

    /** Write the room code under the QR ("" clears it). */
    setRoom(code) {
      if (roomEl) roomEl.textContent = code ? `Room ${code}` : "";
    },
  };
}
