// @ts-check
// Places on a film page — open-take's film kit. Real places as numbers a
// page can draw: longitude and latitude projected into a box the way web
// maps do it, a set of places switching on one after another, a line
// travelling from one place to another with its tip and length at every
// moment. What the map looks like — real imagery, the product's own map, an
// outline in its colours, dots on nothing — is the film's.
//
//   import { fit, switchOn, along, pathOf } from "./kit/map.js";
//   const map = fit(places.map((p) => [p.lng, p.lat]), { x: 160, y: 90, width: 1600, height: 900 });
//   const pts = places.map((p) => map.project([p.lng, p.lat]));
//   // the places switch on by opening year, faster as they go, from 6 s over 4 s
//   const on = switchOn(t, 6, pts.length, { over: 4, accel: 2 });
//   // a line from you to the nearest place, drawn 12 → 13.5 s
//   const r = along(t, 12, 13.5, [you, pts[k]]);   // r.tip, r.length, r.p
//
// The timings come from widely shared launch films, measured (`skill film craft`);
// each is an option of its call.

/** @typedef {{ x: number, y: number }} Pt */
/** @typedef {[number, number] | { lng?: number, lon?: number, lat: number }} LngLat */

/** @param {number} x */
const clamp01 = (x) => Math.max(0, Math.min(1, x));
/** smootherstep */
/** @param {number} p */
const smooth = (p) => {
  const x = clamp01(p);
  return x * x * x * (x * (x * 6 - 15) + 10);
};

/** @param {LngLat} p @returns {[number, number]} */
function lngLat(p) {
  if (Array.isArray(p)) return [p[0], p[1]];
  const lng = p.lng ?? p.lon;
  if (lng == null) throw new Error("map: a place needs lng (or lon) and lat");
  return [lng, p.lat];
}

/** Web Mercator, on a unit square: x 0..1 west to east, y 0..1 north to south */
/** @param {[number, number]} ll */
function mercator([lng, lat]) {
  const s = Math.sin((Math.max(-85.0511, Math.min(85.0511, lat)) * Math.PI) / 180);
  return { x: (lng + 180) / 360, y: 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI) };
}

/**
 * A projection that fits places into a box: Web Mercator (the projection
 * of web map tiles, so points line up with a tile map at the same zoom),
 * scaled so every place is inside the box with `pad` px to spare, centred.
 * `project` maps a place to px; `unproject` maps px back; `zoom` is the web
 * map zoom level that scale is (for fetching or baking tiles that match).
 * @param {LngLat[]} places
 * @param {{ x?: number, y?: number, width: number, height: number }} box
 * @param {{ pad?: number, maxZoom?: number }} [opts] pad in px (default 8 % of the short side); maxZoom caps how close one place, or a few close together, is drawn (default 16)
 * @returns {{ project: (p: LngLat) => Pt, unproject: (p: Pt) => [number, number], scale: number, zoom: number }}
 */
export function fit(places, box, opts = {}) {
  if (!places.length) throw new Error("fit: no places");
  const bx = box.x ?? 0;
  const by = box.y ?? 0;
  const pad = opts.pad ?? Math.min(box.width, box.height) * 0.08;
  const ms = places.map((p) => mercator(lngLat(p)));
  const x0 = Math.min(...ms.map((m) => m.x));
  const x1 = Math.max(...ms.map((m) => m.x));
  const y0 = Math.min(...ms.map((m) => m.y));
  const y1 = Math.max(...ms.map((m) => m.y));
  const w = Math.max(1, box.width - 2 * pad);
  const h = Math.max(1, box.height - 2 * pad);
  // a world 256 px wide at zoom 0: scale = 256 · 2^zoom
  const maxScale = 256 * 2 ** (opts.maxZoom ?? 16);
  const scale = Math.min(maxScale, w / Math.max(1e-12, x1 - x0), h / Math.max(1e-12, y1 - y0));
  const cx = (x0 + x1) / 2;
  const cy = (y0 + y1) / 2;
  const ox = bx + box.width / 2;
  const oy = by + box.height / 2;
  return {
    project: (p) => {
      const m = mercator(lngLat(p));
      return { x: ox + (m.x - cx) * scale, y: oy + (m.y - cy) * scale };
    },
    unproject: ({ x, y }) => {
      const mx = cx + (x - ox) / scale;
      const my = cy + (y - oy) / scale;
      const lat = (Math.atan(Math.sinh(Math.PI * (1 - 2 * my))) * 180) / Math.PI;
      return [mx * 360 - 180, lat];
    },
    scale,
    zoom: Math.log2(scale / 256),
  };
}

/**
 * Places switching on one after another — shops, stops, offices lighting up on a dimmed
 * map, in whatever order means something (pass them sorted: by year, by
 * distance). Item i comes on at `start + over · f(i / n)`; with `accel` > 1
 * the gaps shrink as it goes (the spread speeds up, as the films measured
 * did: 1.0 → 0.9 → 0.75 s per group), below 1 they grow. Each fades in over
 * `fade` s with a `flash` (1 → 0 over `flashFor` s) to add as white.
 * `lit` is how many are fully on — for a counter that lands with them.
 * @param {number} t
 * @param {number} start
 * @param {number} n
 * @param {{ over?: number, accel?: number, fade?: number, flashFor?: number }} [opts]
 * @returns {{ items: { on: number, flash: number, at: number }[], lit: number, done: boolean }}
 */
export function switchOn(t, start, n, opts = {}) {
  const { over = Math.min(4, 0.12 * n), accel = 1.6, fade = 0.22, flashFor = 0.16 } = opts;
  let lit = 0;
  const items = Array.from({ length: n }, (_, i) => {
    const u = n > 1 ? i / (n - 1) : 0;
    // f(u) = 1 − (1 − u)^accel: slope accel at the start, 0 at the end — gaps shrink
    const at = start + over * (accel === 1 ? u : 1 - (1 - u) ** accel);
    const on = fade > 0 ? clamp01((t - at) / fade) : t >= at ? 1 : 0;
    const e = t - at;
    const flash =
      e >= 0 && flashFor > 0 ? Math.exp(-e / (flashFor / 3)) * (e < flashFor ? 1 : 0) : 0;
    if (on >= 1) lit++;
    return { on, flash, at };
  });
  return { items, lit, done: lit === n };
}

/** an SVG path `d` through points */
/** @param {Pt[]} points */
export function pathOf(points) {
  return `M${points.map((p) => `${+p.x.toFixed(2)} ${+p.y.toFixed(2)}`).join(" L")}`;
}

/**
 * A line travelling along points from `start` to `end`: where its tip is,
 * which way it faces, how long the drawn part is (px) and how much of the
 * whole that is — for a route drawn ahead of what travels it, a distance
 * line with a counter rolling with its tip (`count(…)` at `p`, or the real
 * metres × p), a camera chasing the tip (`cam.frame` on `tip`). Draw the
 * line with `pathOf(points)` and `pathLength="1"`, `stroke-dasharray: 1 1`,
 * `stroke-dashoffset: 1 − p`. Default smootherstep over the whole length.
 * @param {number} t
 * @param {number} start
 * @param {number} end
 * @param {Pt[]} points
 * @param {{ ease?: (p: number) => number }} [opts]
 * @returns {{ tip: Pt, angle: number, length: number, total: number, p: number }}
 */
export function along(t, start, end, points, opts = {}) {
  if (points.length < 2) throw new Error("along: needs two points or more");
  const { ease = smooth } = opts;
  const seg = points.slice(1).map((b, i) => Math.hypot(b.x - points[i].x, b.y - points[i].y));
  const total = seg.reduce((a, b) => a + b, 0);
  const p = end > start ? ease(clamp01((t - start) / (end - start))) : t >= end ? 1 : 0;
  let left = p * total;
  let i = 0;
  while (i < seg.length - 1 && left > seg[i]) left -= seg[i++];
  const a = points[i];
  const b = points[i + 1];
  const k = seg[i] > 0 ? Math.min(1, left / seg[i]) : 1;
  return {
    tip: { x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k },
    angle: Math.atan2(b.y - a.y, b.x - a.x),
    length: p * total,
    total,
    p,
  };
}
