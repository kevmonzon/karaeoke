/*
 * spatial-nav.js — which focusable an arrow key lands on (pure geometry, no DOM).
 *
 * The caller measures the current element and the candidates in its scope (visible, enabled,
 * not skipped, not inert) and asks for the next one in a direction. The rule:
 *
 *  - Keep candidates whose CENTRE lies beyond the current centre in that direction, by more
 *    than TOLERANCE_PX (so sub-pixel layout noise in one row never reads as "below").
 *  - Score = distance between centres along the axis
 *          + 2 × offset across the axis, where the offset is 0 when the two rects' projections
 *            on that axis overlap, else the distance between their centres on it.
 *  - Lowest score wins; ties keep the earliest candidate (DOM order). Nothing → null (no wrap).
 *
 * Using the centre distance (not the edge gap) for the across offset matters for grids whose
 * cells touch: a diagonal neighbour's edge gap is 0, which would tie it with the straight one.
 */

/** How far (px) a centre must pass the current one, and how much projections must share. */
const TOLERANCE_PX = 1;

const AXES = {
  up:    { along: "y", sign: -1 },
  down:  { along: "y", sign: 1 },
  left:  { along: "x", sign: -1 },
  right: { along: "x", sign: 1 },
};

const finite = (r) => r != null
  && Number.isFinite(r.x) && Number.isFinite(r.y) && Number.isFinite(r.w) && Number.isFinite(r.h);

// Centre and extent of a rect on one axis ("x" or "y").
const span = (r, axis) => (axis === "x"
  ? { lo: r.x, hi: r.x + r.w, mid: r.x + r.w / 2 }
  : { lo: r.y, hi: r.y + r.h, mid: r.y + r.h / 2 });

/**
 * @param {{x:number,y:number,w:number,h:number,id?:*}} current
 * @param {Array<{id:*,x:number,y:number,w:number,h:number}>} candidates
 * @param {"up"|"down"|"left"|"right"} dir
 * @returns {*} the chosen candidate's id, or null
 */
export function pickNext(current, candidates, dir) {
  const ax = AXES[dir];
  if (!ax || !finite(current) || !Array.isArray(candidates)) return null;
  const across = ax.along === "x" ? "y" : "x";
  const curAlong = span(current, ax.along);
  const curAcross = span(current, across);
  const self = current.id;

  let best = null;
  let bestScore = Infinity;
  for (const c of candidates) {
    if (c === current || !finite(c)) continue;
    if (self != null && c.id === self) continue;
    const a = span(c, ax.along);
    const along = (a.mid - curAlong.mid) * ax.sign;
    if (!(along > TOLERANCE_PX)) continue;              // not beyond in that direction
    const b = span(c, across);
    const shared = Math.min(b.hi, curAcross.hi) - Math.max(b.lo, curAcross.lo);
    const offset = shared > TOLERANCE_PX ? 0 : Math.abs(b.mid - curAcross.mid);
    const score = along + 2 * offset;
    if (score < bestScore) { bestScore = score; best = c; }
  }
  return best ? best.id : null;
}
