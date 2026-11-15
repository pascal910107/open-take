// devices.js — a laptop, a phone and a plain box computer for a film page,
// built from the page's own elements. Each face is one flat element with its
// own perspective, the way kit/stage.js draws a slab: no perspective on a
// parent and no layer bigger than the face it shows. The faces are lit from
// one light up and to the left of the lens. A screen is any element: the
// film's own rebuilt interface keeps working on it — its text is text, its
// cursor moves and its rows open — or a picture, a canvas, a video. No logo and no maker's shape; the colours
// are options.
//
// Made once, then drawn from a pose: a plain object you write from film time
// (anim.js's `keys`), so the same pose draws the same frame, in any order;
// nothing here keeps time. The lid's angle is in the pose, shut (0) to open
// and back at any speed; a computer's light too.
//
//   import { laptop, phone, computer } from "./lib/devices.js";
//   import { keys } from "./lib/anim.js";
//   const lap = laptop(document.querySelector("#scene"), { screen: document.querySelector("#app") });
//   window.__render = (t) => {
//     const at = lap.draw({ x: 960, y: 860, rx: -18, ry: -24, scale: 0.55,
//       open: keys(t, [[0.4, 0], [1.2, 108, "out3"], [3.6, 108], [3.95, 0, "in3"]]) });
//     const [cx, cy] = at.toFrame(700, 420);   // a point of the screen (its own px), in the frame
//   };
//
//   laptop(host, o)    a lid on a hinge round the screen, a keyboard half, thickness
//                      enough to read as a laptop shut; pose.open: degrees between
//                      lid and keyboard (0 shut … 105 open … 180 flat), pose.screen: 0…1 lit
//   phone(host, o)     a rounded slab, the screen on its front; pose.screen: 0…1 lit
//   computer(host, o)  a rounded box with a status light — a desktop, a server, a cloud
//                      machine; pose.on: 0…1, the light and the glow under it
//
// `host` is a layer whose top-left is the frame's top-left (a scene the size of
// the frame) and that has no perspective of its own; null gives numbers only.
// Every device has
//   draw(pose, cam?)  writes its faces and returns at(pose, cam)
//   at(pose, cam?)    numbers only: `bounds` (the box it takes in the frame),
//                     `quad` and `toFrame(x, y)` (its screen — a computer's front
//                     — in the frame), `facing`, `depth`, `soft` (faces with the
//                     page's content Chrome would still stretch), `faces`
//   el                its layer in the host (null without one)
// A pose: { x, y, z, rx, ry, rz, scale, opacity, shadow } and the device's own
// fields. x, y: where its origin lands in the frame (px) — a laptop's and a
// computer's is the middle of its footprint on the table, a phone's the middle
// of its screen; z: px toward the lens. Turned as kit/stage.js turns a slab
// (rz, then ry, then rx, degrees): ry turns a laptop on the table, a negative
// rx shows it from above (−20: from 20° up). scale 1: its screen at the screen
// element's own px (a computer: its w, h, d in px). shadow 0…1: the soft
// shadow on the table under it (default 1; a phone 0).
// cam: anim.js's 2D camera { x, y, s }, for a host the camera does not move —
// the lens stays at the middle of the frame. A host inside the camera's layer
// needs none. The lens is 2800 px from the stage, at the frame's middle
// (option `lens: { d, cx, cy }`). Nothing here blurs: the master's shutter
// smears a lid that shuts in 0.3 s, as it does any fast move.
//
// Sharp up close. Chrome draws a layer under a perspective with no more
// pixels than the frame has and stretches it (`skill film render`), so a
// screen pushed in until it fills the frame went soft. Now:
//   - a screen face is cut to the part of it inside the frame;
//   - as the screen comes to need about as many pixels as the frame has, the
//     device's lens is drawn back toward none (a smooth step from 0.6 of the
//     frame's pixels to all of them), the screen's middle kept as big and where
//     it is; from there every face is a plain 2D transform, which Chrome draws
//     at the scale it shows, at any size. Up close the laptop then looks as a
//     long lens shows it: little foreshortening. `flatten: false` (an option)
//     keeps the lens as it is; pose.flatten (0…1) asks for more by hand.
//   - `soft` names a face that shows the page's content which Chrome would
//     still stretch (with `flatten: false`, a phone or a computer's mark, a
//     screen behind a host the page has scaled up): at() says it, so a draft
//     shows it before a master; the render's report names the layer too.
// The cut and the flattening read the frame as the host's 1920 × 1080 (or
// `frame`): a host the page itself moves or scales needs `cam` instead.
//
// Hiding a device: opacity 0 in its pose, or the page's own
// `el.style.visibility = "hidden"` / `display = "none"` — draw leaves those
// alone (it sets visibility only to hide a device at opacity 0, and gives the
// page's back after).
//
// Several devices in one host: each is its own layer (`el`); set its zIndex
// for which is in front (`depth` says which is nearer), and make the host a
// stacking context of its own (`isolation: isolate`) so that a zIndex there
// does not lift the device over what the page draws above the host.

import { matrices as M } from "../kit/stage.js";

/** @typedef {{ x: number, y: number, z: number }} V3 */
/** @typedef {number[]} Mat  4×4, column-major, as CSS matrix3d lists it */
/** @typedef {{ x: number, y: number, s: number }} Cam  anim.js's 2D camera */
/**
 * @typedef {object} Pose  where a device is and how it is
 * @property {number} [x] @property {number} [y] @property {number} [z]
 * @property {number} [rx] @property {number} [ry] @property {number} [rz]
 * @property {number} [scale] @property {number} [opacity] @property {number} [shadow]
 * @property {number} [open] a laptop: degrees between lid and keyboard (default 105)
 * @property {number} [screen] a laptop's or a phone's screen: 1 lit, 0 dark (default 1)
 * @property {number} [on] a computer: its light and glow, 0…1 (default 0)
 * @property {number} [lens] the lens's distance for this frame (px; default the device's, 2800)
 * @property {number} [flatten] 0…1: the lens drawn back toward none at 1 (no perspective), the
 *   screen's middle kept as big and where it is — for a screen filling the frame at a tilt (default 0)
 */
/**
 * @typedef {object} Face  one flat element of a device
 * @property {string} name
 * @property {string} part   what it moves with ("base", "lid", "body", "floor")
 * @property {number} layer  0 the body, 1 a mark on it, 2 a screen, 3 the screen's glass
 * @property {string} kind   body, bezel, keys, decal, screen, glass, shadow, glow
 * @property {V3} O  its top-left in its part's px
 * @property {V3} U  its x axis there (unit)
 * @property {V3} V  its y axis there (unit)
 * @property {number} w @property {number} h  its own px
 * @property {string | null} clip  a polygon in its own px, or none: the whole rectangle
 * @property {number} radius  its corners (px)
 * @property {string} color  a body's colour, before the light
 * @property {[V3, V3] | null} ends  a rounded piece: its normal (part px) at its x = 0 and at x = w,
 *   lit as a gradient between them so the pieces of a curve read as one curve
 * @property {HTMLElement | null} el
 */
/**
 * @typedef {object} DeviceAt  a device in the frame
 * @property {{ x: number, y: number, w: number, h: number }} bounds the box its faces take in the frame
 * @property {{ x: number, y: number }[]} quad its screen's (a computer's front's) corners in the frame, top-left first, clockwise
 * @property {(x: number, y: number) => [number, number]} toFrame a point of the screen (its own px) — a computer's front — in the frame
 * @property {boolean} facing the screen (a computer's front) toward the lens
 * @property {number} depth its origin's z after the turn (px, + nearer the lens)
 * @property {string[]} soft faces showing the page's content that Chrome would still draw with fewer pixels than they show (soft)
 * @property {{ name: string, facing: boolean, quad: { x: number, y: number }[], z: number }[]} faces every face: toward the lens, where, its order (higher in front)
 */

const RAD = Math.PI / 180;
const FRAME = { width: 1920, height: 1080 };
// a lens 2800 px from the stage: the long end of the 1600–2800 px measured
// on films that tilted a screen into space (kit/stage.js takes the middle,
// 2000) — a device seen from three-quarters keeps its shape, as product shots
// taken with a long lens do
const LENS = 2800;

/** @param {number} x @param {number} y @param {number} z @returns {V3} */
const v3 = (x, y, z) => ({ x, y, z });
/** @param {V3} a @param {V3} b */
const add = (a, b) => v3(a.x + b.x, a.y + b.y, a.z + b.z);
/** @param {V3} a @param {V3} b */
const sub = (a, b) => v3(a.x - b.x, a.y - b.y, a.z - b.z);
/** @param {V3} a @param {number} k */
const mulv = (a, k) => v3(a.x * k, a.y * k, a.z * k);
/** @param {V3} a @param {V3} b */
const dot = (a, b) => a.x * b.x + a.y * b.y + a.z * b.z;
/** @param {V3} a @param {V3} b */
const cross = (a, b) => v3(a.y * b.z - a.z * b.y, a.z * b.x - a.x * b.z, a.x * b.y - a.y * b.x);
/** @param {V3} a */
function unit(a) {
  const l = Math.hypot(a.x, a.y, a.z) || 1;
  return v3(a.x / l, a.y / l, a.z / l);
}
// one light, up and to the left of the lens, as far from the stage as the
// lens again (px from the lens, y down): near enough that a large face is a
// little brighter at its end nearer the light
const LIGHT = { x: -0.5, y: -1.9, z: -0.2 };
const AMBIENT = 0.56;
/** @param {number} x @param {number} [a] @param {number} [b] */
const clamp = (x, a = 0, b = 1) => Math.min(b, Math.max(a, x));
/** a matrix's entry @param {Mat} m @param {number} i */
const g = (m, i) => /** @type {number} */ (m[i]);
/** a number for CSS @param {number} v */
const f6 = (v) => (Math.abs(v) < 1e-12 ? 0 : +v.toPrecision(10));
/** a point through a matrix — x, y, z divided by w, and w @param {Mat} m @param {V3} p */
const through = (m, p) => M.apply(m, p.x, p.y, p.z);
/** a direction through a matrix, as a unit vector @param {Mat} m @param {V3} v */
const turned = (m, v) =>
  unit(
    v3(
      g(m, 0) * v.x + g(m, 4) * v.y + g(m, 8) * v.z,
      g(m, 1) * v.x + g(m, 5) * v.y + g(m, 9) * v.z,
      g(m, 2) * v.x + g(m, 6) * v.y + g(m, 10) * v.z,
    ),
  );

/** "#rrggbb" or "#rgb" → [r, g, b] @param {string} hex @returns {[number, number, number]} */
function rgbOf(hex) {
  const h = hex.trim().replace(/^#/, "");
  const full = h.length === 3 ? [...h].map((c) => c + c).join("") : h;
  if (!/^[0-9a-f]{6}$/i.test(full))
    throw new Error(`devices: a colour is "#rrggbb" or "#rgb" (got ${JSON.stringify(hex)})`);
  const n = (/** @type {number} */ i) => parseInt(full.slice(i, i + 2), 16);
  return [n(0), n(2), n(4)];
}
/** a colour lit: k times as bright, then `spec` of the way to white @param {[number, number, number]} c @param {number} k @param {number} spec */
function lit(c, k, spec) {
  const ch = (/** @type {number} */ v) => Math.round(clamp(v * k + (255 - v * k) * spec, 0, 255));
  return `rgb(${ch(c[0])}, ${ch(c[1])}, ${ch(c[2])})`;
}

// --- faces ------------------------------------------------------------------------

/**
 * A rectangle face: its top-left O and its axes U, V (unit) in its part's px.
 * Its front is U × V.
 * @param {Partial<Face> & { name: string, part: string, O: V3, U: V3, V: V3, w: number, h: number }} o
 * @returns {Face}
 */
function rect(o) {
  return {
    layer: 0,
    kind: "body",
    clip: null,
    radius: 0,
    color: "#888888",
    ends: null,
    el: null,
    ...o,
  };
}

/**
 * A flat polygon (its points in one plane) as a face: the rectangle round it,
 * the polygon its clip. `out` says which way its front is; `along`, if given,
 * its x axis (else its longest edge).
 * @param {string} part @param {string} name @param {V3[]} pts @param {V3} out
 * @param {Partial<Face>} [o] @param {V3} [along]
 * @returns {Face}
 */
function poly(part, name, pts, out, o = {}, along) {
  // the plane's normal (Newell's), turned to face `out`
  let n = v3(0, 0, 0);
  for (let i = 0; i < pts.length; i++) {
    const a = /** @type {V3} */ (pts[i]);
    const b = /** @type {V3} */ (pts[(i + 1) % pts.length]);
    n = add(n, v3((a.y - b.y) * (a.z + b.z), (a.z - b.z) * (a.x + b.x), (a.x - b.x) * (a.y + b.y)));
  }
  n = unit(n);
  if (dot(n, out) < 0) n = mulv(n, -1);
  // its x along its longest edge, or as asked (in its plane)
  let U = v3(1, 0, 0);
  let longest = along ? Number.POSITIVE_INFINITY : -1;
  if (along) U = unit(sub(along, mulv(n, dot(along, n))));
  for (let i = 0; i < pts.length; i++) {
    const e = sub(/** @type {V3} */ (pts[(i + 1) % pts.length]), /** @type {V3} */ (pts[i]));
    const l = Math.hypot(e.x, e.y, e.z);
    if (l > longest) {
      longest = l;
      U = unit(e);
    }
  }
  const V = cross(n, U);
  const p0 = /** @type {V3} */ (pts[0]);
  const uv = pts.map((p) => [dot(sub(p, p0), U), dot(sub(p, p0), V)]);
  const us = uv.map((q) => /** @type {number} */ (q[0]));
  const vs = uv.map((q) => /** @type {number} */ (q[1]));
  const u0 = Math.min(...us);
  const v0 = Math.min(...vs);
  const w = Math.max(...us) - u0;
  const h = Math.max(...vs) - v0;
  const local = uv.map((q) => [
    /** @type {number} */ (q[0]) - u0,
    /** @type {number} */ (q[1]) - v0,
  ]);
  const whole =
    local.length === 4 &&
    local.every(
      ([a, b]) =>
        (Math.abs(/** @type {number} */ (a)) < 1e-6 ||
          Math.abs(/** @type {number} */ (a) - w) < 1e-6) &&
        (Math.abs(/** @type {number} */ (b)) < 1e-6 ||
          Math.abs(/** @type {number} */ (b) - h) < 1e-6),
    );
  return rect({
    ...o,
    part,
    name,
    O: add(p0, add(mulv(U, u0), mulv(V, v0))),
    U,
    V,
    w,
    h,
    clip: whole
      ? null
      : `polygon(${local.map(([a, b]) => `${f6(/** @type {number} */ (a))}px ${f6(/** @type {number} */ (b))}px`).join(", ")})`,
  });
}

/**
 * A slab lying flat — a box whose upright edges are rounded (r, in `seg`
 * pieces a corner) and whose top edge may be bevelled (`bevel` px at 45°):
 * x from x0 to x1, z from z0 (back) to z1 (front), y from y0 (its top, y is
 * down) to y1. The top's x runs along x and its y from back to front; the
 * bottom's from front to back (so a lid's underside reads upright once the
 * lid is raised).
 * @param {string} part
 * @param {{ x0: number, x1: number, z0: number, z1: number, y0: number, y1: number, r: number, seg: number, bevel?: number, color: string, top?: Partial<Face>, bottom?: Partial<Face>, side?: Partial<Face> }} o
 * @returns {{ faces: Face[], top: Face, bottom: Face }}
 */
function slab(part, o) {
  const { x0, x1, z0, z1, y0, y1, seg } = o;
  const r = Math.max(0, Math.min(o.r, (x1 - x0) / 2, (z1 - z0) / 2));
  const b = Math.max(0, Math.min(o.bevel ?? 0, r || Number.POSITIVE_INFINITY, (y1 - y0) / 2));
  const body = { part, color: o.color };
  /** @type {Face[]} */
  const faces = [];
  const top = rect({
    ...body,
    name: `${part} top`,
    O: v3(x0 + b, y0, z0 + b),
    U: v3(1, 0, 0),
    V: v3(0, 0, 1),
    w: x1 - x0 - 2 * b,
    h: z1 - z0 - 2 * b,
    radius: Math.max(0, r - b),
    ...o.top,
  });
  const bottom = rect({
    ...body,
    name: `${part} bottom`,
    O: v3(x0, y1, z1),
    U: v3(1, 0, 0),
    V: v3(0, 0, -1),
    w: x1 - x0,
    h: z1 - z0,
    radius: r,
    ...o.bottom,
  });
  faces.push(top, bottom);
  const ys = y0 + b;
  const hs = y1 - ys;
  const side = { ...body, ...o.side };
  if (x1 - x0 - 2 * r > 1e-6) {
    faces.push(
      rect({
        ...side,
        name: `${part} front`,
        O: v3(x0 + r, ys, z1),
        U: v3(1, 0, 0),
        V: v3(0, 1, 0),
        w: x1 - x0 - 2 * r,
        h: hs,
      }),
      rect({
        ...side,
        name: `${part} back`,
        O: v3(x1 - r, ys, z0),
        U: v3(-1, 0, 0),
        V: v3(0, 1, 0),
        w: x1 - x0 - 2 * r,
        h: hs,
      }),
    );
  }
  if (z1 - z0 - 2 * r > 1e-6) {
    faces.push(
      rect({
        ...side,
        name: `${part} right`,
        O: v3(x1, ys, z1 - r),
        U: v3(0, 0, -1),
        V: v3(0, 1, 0),
        w: z1 - z0 - 2 * r,
        h: hs,
      }),
      rect({
        ...side,
        name: `${part} left`,
        O: v3(x0, ys, z0 + r),
        U: v3(0, 0, 1),
        V: v3(0, 1, 0),
        w: z1 - z0 - 2 * r,
        h: hs,
      }),
    );
  }
  // the bevel's straight pieces
  if (b > 0) {
    const yb = y0 + b;
    /** @type {[V3[], V3][]} */
    const bands = [
      [
        [v3(x0 + r, y0, z1 - b), v3(x1 - r, y0, z1 - b), v3(x1 - r, yb, z1), v3(x0 + r, yb, z1)],
        v3(0, -1, 1),
      ],
      [
        [v3(x1 - r, y0, z0 + b), v3(x0 + r, y0, z0 + b), v3(x0 + r, yb, z0), v3(x1 - r, yb, z0)],
        v3(0, -1, -1),
      ],
      [
        [v3(x1 - b, y0, z1 - r), v3(x1 - b, y0, z0 + r), v3(x1, yb, z0 + r), v3(x1, yb, z1 - r)],
        v3(1, -1, 0),
      ],
      [
        [v3(x0 + b, y0, z0 + r), v3(x0 + b, y0, z1 - r), v3(x0, yb, z1 - r), v3(x0, yb, z0 + r)],
        v3(-1, -1, 0),
      ],
    ];
    bands.forEach(([pts, out], i) => {
      const a = /** @type {V3} */ (pts[0]);
      const c = /** @type {V3} */ (pts[1]);
      if (Math.hypot(c.x - a.x, c.z - a.z) > 1e-6)
        faces.push(poly(part, `${part} bevel ${i}`, pts, out, side));
    });
  }
  // the rounded corners: upright strips, and the bevel round them
  if (r > 0) {
    const corners = [
      [x1 - r, z1 - r, 0],
      [x0 + r, z1 - r, 90],
      [x0 + r, z0 + r, 180],
      [x1 - r, z0 + r, 270],
    ];
    for (const [cx, cz, a0] of /** @type {[number, number, number][]} */ (corners)) {
      for (let k = 0; k < seg; k++) {
        const a = (a0 + (90 * k) / seg) * RAD;
        const c = (a0 + (90 * (k + 1)) / seg) * RAD;
        const m = (a + c) / 2;
        const at = (
          /** @type {number} */ ang,
          /** @type {number} */ rad,
          /** @type {number} */ y,
        ) => v3(cx + rad * Math.cos(ang), y, cz + rad * Math.sin(ang));
        const out = v3(Math.cos(m), 0, Math.sin(m));
        const nA = v3(Math.cos(a), 0, Math.sin(a));
        const nC = v3(Math.cos(c), 0, Math.sin(c));
        // its x from the end at angle c to the one at a: so its front is outward
        const chord = sub(at(a, r, 0), at(c, r, 0));
        faces.push(
          poly(
            part,
            `${part} corner ${a0}.${k}`,
            [at(c, r, ys), at(a, r, ys), at(a, r, y1), at(c, r, y1)],
            out,
            { ...side, ends: [nC, nA] },
            chord,
          ),
        );
        if (b > 0) {
          const ri = r - b;
          const pts =
            ri > 1e-6
              ? [at(a, ri, y0), at(c, ri, y0), at(c, r, ys), at(a, r, ys)]
              : [at(a, 0, y0), at(c, r, ys), at(a, r, ys)];
          const bevelN = (/** @type {V3} */ q) => unit(v3(q.x, -1, q.z));
          faces.push(
            poly(
              part,
              `${part} bevel ${a0}.${k}`,
              pts,
              v3(out.x, -1, out.z),
              { ...side, ends: [bevelN(nC), bevelN(nA)] },
              chord,
            ),
          );
        }
      }
    }
  }
  return { faces, top, bottom };
}

/** a face that shows something of the page's (a screen, the keys, a mark on a face)
 *  @param {Face} f */
const holds = (f) => f.kind === "screen" || f.kind === "keys" || (f.kind === "decal" && !!f.el);

/** the 3×3 that takes a face's px (u, v) to the frame's, from its 4×4 (z 0, divide by w) @param {Mat} m */
const homography = (m) => [
  g(m, 0),
  g(m, 4),
  g(m, 12),
  g(m, 1),
  g(m, 5),
  g(m, 13),
  g(m, 3),
  g(m, 7),
  g(m, 15),
];

/** a 3×3's inverse (rows) @param {number[]} a @returns {number[] | null} */
function inverse3(a) {
  const [A = 0, B = 0, C = 0, D = 0, E = 0, F = 0, G = 0, H = 0, I = 0] = a;
  const c0 = E * I - F * H;
  const c1 = -(D * I - F * G);
  const c2 = D * H - E * G;
  const det = A * c0 + B * c1 + C * c2;
  if (!(Math.abs(det) > 1e-12)) return null;
  const k = 1 / det;
  return [
    c0 * k,
    -(B * I - C * H) * k,
    (B * F - C * E) * k,
    c1 * k,
    (A * I - C * G) * k,
    -(A * F - C * D) * k,
    c2 * k,
    -(A * H - B * G) * k,
    (A * E - B * D) * k,
  ];
}

/**
 * The part of a face (its own px, whole px) that lands inside the frame, with
 * a margin round it — or null when all of it is needed or it cannot be told
 * (a corner of the frame looks past the face's plane).
 * @param {Mat} m the face's px to the frame's @param {number} w @param {number} h
 * @param {{ width: number, height: number }} frame
 */
function cropOf(m, w, h, frame) {
  const inv = inverse3(homography(m));
  if (!inv) return null;
  const at = (/** @type {number} */ x, /** @type {number} */ y) => {
    const q = (/** @type {number} */ i) => /** @type {number} */ (inv[i]);
    const u = q(0) * x + q(1) * y + q(2);
    const v = q(3) * x + q(4) * y + q(5);
    const s = q(6) * x + q(7) * y + q(8);
    return { u: u / s, v: v / s, s };
  };
  // the face's middle, to know which sign of w is in front
  const mid = M.apply(m, w / 2, h / 2, 0);
  const ref = at(mid.x, mid.y).s;
  const corners = [
    at(0, 0),
    at(frame.width, 0),
    at(frame.width, frame.height),
    at(0, frame.height),
  ];
  if (corners.some((c) => !(c.s * ref > 0) || !Number.isFinite(c.u) || !Number.isFinite(c.v)))
    return null;
  const pad = 24 + 0.02 * Math.max(w, h);
  const x0 = Math.max(0, Math.floor(Math.min(...corners.map((c) => c.u)) - pad));
  const y0 = Math.max(0, Math.floor(Math.min(...corners.map((c) => c.v)) - pad));
  const x1 = Math.min(w, Math.ceil(Math.max(...corners.map((c) => c.u)) + pad));
  const y1 = Math.min(h, Math.ceil(Math.max(...corners.map((c) => c.v)) + pad));
  if (!(x1 > x0 && y1 > y0)) return null;
  if (x0 === 0 && y0 === 0 && x1 >= w && y1 >= h) return null;
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/**
 * A plain 2D transform for a rect of a face (CSS matrix(a, b, c, d, e, f) in
 * the rect's own px) when it lands within half a frame pixel of the true,
 * perspective one everywhere on the rect — the true one's first-order fit
 * about the rect's middle, checked at its corners and edge middles — else null.
 * @param {Mat} m @param {{ x: number, y: number, w: number, h: number }} r
 * @returns {number[] | null}
 */
function affineOf(m, r) {
  const P = (/** @type {number} */ u, /** @type {number} */ v) => M.apply(m, u, v, 0);
  const u0 = r.x + r.w / 2;
  const v0 = r.y + r.h / 2;
  const o = P(u0, v0);
  if (!(o.w > 0)) return null;
  const e = 0.5;
  const du = P(u0 + e, v0);
  const dv = P(u0, v0 + e);
  const a = (du.x - o.x) / e;
  const b = (du.y - o.y) / e;
  const c = (dv.x - o.x) / e;
  const d = (dv.y - o.y) / e;
  let worst = 0;
  for (const [u = 0, v = 0] of [
    [r.x, r.y],
    [r.x + r.w, r.y],
    [r.x + r.w, r.y + r.h],
    [r.x, r.y + r.h],
    [u0, r.y],
    [r.x + r.w, v0],
    [u0, r.y + r.h],
    [r.x, v0],
  ]) {
    const t = P(u, v);
    if (!(t.w > 0)) return null;
    const x = o.x + a * (u - u0) + c * (v - v0);
    const y = o.y + b * (u - u0) + d * (v - v0);
    worst = Math.max(worst, Math.hypot(t.x - x, t.y - y));
  }
  if (worst > 0.5) return null;
  // in the rect's own px (its top-left at 0, 0)
  return [a, b, c, d, o.x - a * (u0 - r.x) - c * (v0 - r.y), o.y - b * (u0 - r.x) - d * (v0 - r.y)];
}

/** the most a px of the face is enlarged in the frame, over a rect of it (its corners and middle)
 *  @param {Mat} m @param {{ x: number, y: number, w: number, h: number }} c */
function maxScale(m, c) {
  let most = 0;
  for (const [u, v] of [
    [c.x, c.y],
    [c.x + c.w, c.y],
    [c.x + c.w, c.y + c.h],
    [c.x, c.y + c.h],
    [c.x + c.w / 2, c.y + c.h / 2],
  ]) {
    const a = M.apply(m, /** @type {number} */ (u), /** @type {number} */ (v), 0);
    const bu = M.apply(m, /** @type {number} */ (u) + 1, /** @type {number} */ (v), 0);
    const bv = M.apply(m, /** @type {number} */ (u), /** @type {number} */ (v) + 1, 0);
    if (!(a.w > 0)) continue;
    most = Math.max(most, Math.hypot(bu.x - a.x, bu.y - a.y), Math.hypot(bv.x - a.x, bv.y - a.y));
  }
  return most;
}

/** a face's own matrix: its px (u, v, 0) to its part's px @param {Face} f @returns {Mat} */
function faceMatrix(f) {
  const N = cross(f.U, f.V);
  return [f.U.x, f.U.y, f.U.z, 0, f.V.x, f.V.y, f.V.z, 0, N.x, N.y, N.z, 0, f.O.x, f.O.y, f.O.z, 1];
}

/** a face on the table under a device: a soft shadow or a glow, y the table's height
 *  @param {string} name @param {string} kind @param {number} cx @param {number} cz @param {number} w @param {number} d @param {number} y */
const floor = (name, kind, cx, cz, w, d, y) =>
  rect({
    name,
    part: "floor",
    kind,
    O: v3(cx - w / 2, y, cz - d / 2),
    U: v3(1, 0, 0),
    V: v3(0, 0, 1),
    w,
    h: d,
  });

// --- the device ------------------------------------------------------------------------

/**
 * @typedef {object} Build  what a device is made of
 * @property {Face[]} faces
 * @property {(pose: Required<Pose>) => Record<string, Mat>} parts each part's matrix in the device's px
 * @property {(pose: Required<Pose>, eye: (p: V3, n: V3) => boolean) => string[]} order the parts back to front; `eye(p, n)`: is the lens on n's side of the plane through p (device px)
 * @property {Face} main its screen (a computer: its front)
 * @property {(pose: Required<Pose>, f: Face) => Record<string, string> | null} [style] a face's own look at this pose, beyond the light
 * @property {(f: Face) => Record<string, string> | null} [look] a face's look that never changes, written once
 */

/**
 * @param {HTMLElement | null} host
 * @param {Build} build
 * @param {{ lens?: { d?: number, cx?: number, cy?: number }, frame?: { width: number, height: number }, crop?: boolean, flatten?: boolean }} o
 * @param {Partial<Pose>} defaults
 */
function device(host, build, o, defaults) {
  const frame = o.frame ?? FRAME;
  const d = o.lens?.d ?? LENS;
  if (!(d > 0)) throw new Error("devices: the lens's distance (lens.d) is px above 0");
  const lensC = { x: o.lens?.cx ?? frame.width / 2, y: o.lens?.cy ?? frame.height / 2 };
  const base = {
    x: 0,
    y: 0,
    z: 0,
    rx: 0,
    ry: 0,
    rz: 0,
    scale: 1,
    opacity: 1,
    shadow: 1,
    open: 105,
    screen: 1,
    on: 0,
    lens: d,
    flatten: 0,
    ...defaults,
  };
  /** @type {HTMLElement | null} */
  let el = null;
  if (host) {
    el = document.createElement("div");
    el.dataset.otDevice = "";
    // its own stacking context: its faces are ordered among themselves, and
    // the device as one among other things on the page
    Object.assign(el.style, {
      position: "absolute",
      left: "0px",
      top: "0px",
      width: "0px",
      height: "0px",
      isolation: "isolate",
    });
    for (const f of build.faces) {
      const e = f.el ?? document.createElement("div");
      f.el = e;
      e.dataset.otFace = f.name;
      Object.assign(e.style, {
        position: "absolute",
        left: "0px",
        top: "0px",
        width: `${f6(f.w)}px`,
        height: `${f6(f.h)}px`,
        transformOrigin: "0 0",
        backfaceVisibility: "hidden",
        boxSizing: "border-box",
        ...(f.radius > 0 ? { borderRadius: `${f6(f.radius)}px` } : {}),
        ...(f.clip ? { clipPath: f.clip } : {}),
        ...(f.kind === "screen" ? { overflow: "hidden", background: "#000" } : {}),
        // the screen's glass and the light on the table are not in the way of
        // what is under them (a hit test finds the screen's own elements)
        ...(f.kind === "glass" || f.kind === "shadow" || f.kind === "glow"
          ? { pointerEvents: "none" }
          : {}),
        ...build.look?.(f),
      });
      el.appendChild(e);
    }
    host.appendChild(el);
  }
  const colours = new Map(build.faces.map((f) => [f, rgbOf(f.color)]));
  const cropOn = o.crop !== false;
  const autoOn = o.flatten !== false;
  /**
   * How far to flatten by itself: none while the screen (cut to the frame)
   * needs well under the pixels the frame has (0.6 of them), all of it once
   * it would need as many — a smooth step between — so a screen pushed in
   * until it fills the frame is drawn with no perspective, at the scale it
   * shows, and one that would not fill it keeps the device's lens.
   * @param {Mat} view @param {{ x: number, y: number }} c @param {number} d0
   * @param {(name: string) => Mat} partM
   */
  const autoFlatten = (view, c, d0, partM) => {
    const mf = build.main;
    if (mf.kind !== "screen") return 0;
    const lens0 = M.mul(M.mul(M.translate(c.x, c.y), M.perspective(d0)), M.translate(-c.x, -c.y));
    const seen0 = M.mul(view, M.mul(lens0, M.mul(partM(mf.part), faceMatrix(mf))));
    const corners = [v3(0, 0, 0), v3(mf.w, 0, 0), v3(mf.w, mf.h, 0), v3(0, mf.h, 0)].map((q) =>
      through(seen0, q),
    );
    if (corners.some((q) => !(q.w > 1e-6))) return 0;
    const whole = { x: 0, y: 0, w: mf.w, h: mf.h };
    const part = (cropOn ? cropOf(seen0, mf.w, mf.h, frame) : null) ?? whole;
    const r = (part.w * part.h * maxScale(seen0, part) ** 2) / (frame.width * frame.height);
    const u = clamp((r - 0.6) / 0.4);
    return u * u * (3 - 2 * u);
  };
  // the layer's visibility is the page's: draw sets it only to hide a device
  // at opacity 0, and gives it back after
  let hiddenByPose = false;
  let pageVisibility = "";

  /** @param {Partial<Pose>} [pose] @param {Cam} [cam] @param {boolean} [write] @returns {DeviceAt} */
  const run = (pose = {}, cam, write = false) => {
    /** @type {Required<Pose>} */
    const p = /** @type {any} */ ({ ...base });
    for (const [k, v] of Object.entries(pose)) {
      if (v == null) continue;
      if (!Number.isFinite(v)) throw new Error(`devices: pose.${k} must be a number (got ${v})`);
      /** @type {any} */ (p)[k] = v;
    }
    // the view: anim.js's 2D camera, the lens at the middle of what it shows
    const c = cam ? { x: cam.x, y: cam.y } : lensC;
    const s = cam ? cam.s : 1;
    const view = cam
      ? M.mul(M.translate(frame.width / 2 - cam.x * s, frame.height / 2 - cam.y * s), M.scale(s))
      : M.identity();
    if (!(p.lens > 0))
      throw new Error(`devices: pose.lens is a distance in px above 0 (got ${p.lens})`);
    const placed = M.mul(
      M.mul(
        M.translate(p.x, p.y, p.z),
        M.mul(M.mul(M.rotateX(p.rx), M.rotateY(p.ry)), M.rotateZ(p.rz)),
      ),
      [p.scale, 0, 0, 0, 0, p.scale, 0, 0, 0, 0, p.scale, 0, 0, 0, 0, 1],
    );
    const parts = build.parts(p);
    const partM = (/** @type {string} */ name) => M.mul(placed, parts[name] ?? M.identity());
    // flatten: the lens drawn back toward no perspective at all (1), the whole
    // picture scaled about the lens's middle so the screen's middle stays as
    // big and where it is under the device's own lens
    const flatten = Math.max(clamp(p.flatten), autoOn ? autoFlatten(view, c, p.lens, partM) : 0);
    const L = flatten > 0 ? p.lens / Math.max(1e-7, (1 - flatten) ** 2) : p.lens;
    let k = 1;
    if (L !== p.lens) {
      const mf = build.main;
      const zs = through(M.mul(partM(mf.part), faceMatrix(mf)), v3(mf.w / 2, mf.h / 2, 0)).z;
      k = p.lens / (p.lens - zs) / (L / (L - zs));
    }
    const lens = M.mul(
      M.mul(M.mul(M.translate(c.x, c.y), M.scale(k)), M.perspective(L)),
      M.translate(-c.x, -c.y),
    );
    const eyeAt = v3(c.x, c.y, L);
    // the light stays where the device's own lens puts it
    const lightAt = add(
      v3(c.x, c.y, p.lens),
      v3(LIGHT.x * frame.width, LIGHT.y * frame.height, LIGHT.z * p.lens),
    );
    // which side of a plane of the device the lens is on
    const eye = (/** @type {V3} */ q, /** @type {V3} */ n) => {
      const a = through(placed, q);
      const b = through(placed, add(q, n));
      const nn = v3(b.x - a.x, b.y - a.y, b.z - a.z);
      return dot(sub(eyeAt, v3(a.x, a.y, a.z)), nn) > 0;
    };
    const order = build.order(p, eye);
    const ink = s * p.scale;
    // a face grown by about half a frame pixel each side, so two faces meet
    // without the background showing along their edge
    const grow = 0.55 / Math.max(1e-6, ink);
    /** @type {string[]} */
    const soft = [];
    /** @type {DeviceAt["faces"]} */
    const faces = [];
    let x0 = Number.POSITIVE_INFINITY;
    let y0 = Number.POSITIVE_INFINITY;
    let x1 = Number.NEGATIVE_INFINITY;
    let y1 = Number.NEGATIVE_INFINITY;
    /** @type {DeviceAt["quad"]} */
    let quad = [];
    let mainFacing = false;
    /** @type {Mat} */
    let mainFull = M.identity();
    for (const f of build.faces) {
      const fp = M.mul(partM(f.part), faceMatrix(f));
      const body = f.kind === "body" || f.kind === "bezel";
      const seen = M.mul(view, M.mul(lens, fp));
      // a body face drawn grown by `grow` each side: its corner moved out,
      // its size scaled to w + 2·grow
      const full = body
        ? M.mul(
            seen,
            M.mul(
              M.translate(-grow, -grow),
              M.scale((f.w + 2 * grow) / f.w, (f.h + 2 * grow) / f.h),
            ),
          )
        : seen;
      const n = unit(v3(g(fp, 8), g(fp, 9), g(fp, 10)));
      const centre = through(fp, v3(f.w / 2, f.h / 2, 0));
      const toEye = unit(sub(eyeAt, v3(centre.x, centre.y, centre.z)));
      const facing = dot(toEye, n) > 0;
      const corners = [v3(0, 0, 0), v3(f.w, 0, 0), v3(f.w, f.h, 0), v3(0, f.h, 0)].map((q) =>
        through(seen, q),
      );
      const behind = corners.some((q) => !(q.w > 1e-6));
      const q4 = corners.map((q) => ({ x: q.x, y: q.y }));
      let area = 0;
      for (let i = 0; i < 4; i++) {
        const a = /** @type {{x:number,y:number}} */ (q4[i]);
        const b = /** @type {{x:number,y:number}} */ (q4[(i + 1) % 4]);
        area += a.x * b.y - b.x * a.y;
      }
      area = behind ? Number.POSITIVE_INFINITY : Math.abs(area) / 2;
      // square on to the lens: the lens only scales it — a 2D transform,
      // drawn by Chrome at its final scale
      const flat = Math.abs(Math.abs(n.z) - 1) < 1e-7;
      let transform;
      if (flat && !behind) {
        // (through() has divided by w already)
        const o2 = through(full, v3(0, 0, 0));
        const ex = through(full, v3(1, 0, 0));
        const ey = through(full, v3(0, 1, 0));
        const e1 = { x: ex.x - o2.x, y: ex.y - o2.y };
        const e2 = { x: ey.x - o2.x, y: ey.y - o2.y };
        transform = `matrix(${[e1.x, e1.y, e2.x, e2.y, o2.x, o2.y].map(f6).join(", ")})`;
      } else transform = `matrix3d(${full.map(f6).join(", ")})`;
      // Chrome draws a layer under a perspective with no more pixels than
      // the frame has, and stretches it: a screen that would need more —
      // large, or magnified at its near edge — goes soft. So a face that
      // shows the page's content is
      //   - cut to the part of it inside the frame (and a little round it):
      //     the layer no bigger than what shows;
      //   - drawn with no perspective at all where, over that part, a plain
      //     2D transform lands within half a frame pixel of the true one
      //     (square on, or nearly, as a push into a screen ends): Chrome then
      //     draws it at the scale it shows, at any size.
      // What is left — a large screen still turned well away from the lens —
      // is named in `soft`.
      const content = f.kind === "screen" || f.kind === "glass" || holds(f);
      const frameArea = frame.width * frame.height;
      const whole = { x: 0, y: 0, w: f.w, h: f.h };
      const needOf = (/** @type {{ x: number, y: number, w: number, h: number }} */ r) =>
        r.w * r.h * maxScale(seen, r) ** 2;
      const cut =
        content && !flat && !behind && cropOn && needOf(whole) > frameArea
          ? cropOf(seen, f.w, f.h, frame)
          : null;
      const part = cut ?? whole;
      // (any face: a body face that fits is drawn plainly too, one layer
      // fewer under a perspective)
      const affine = !flat && !behind ? affineOf(full, part) : null;
      if (affine) {
        transform = `matrix(${affine.map(f6).join(", ")})`;
      } else if (cut) {
        transform = `matrix3d(${M.mul(full, M.translate(cut.x, cut.y)).map(f6).join(", ")})`;
      }
      if (holds(f) && !flat && !affine && facing && !behind && needOf(part) > 1.05 * frameArea)
        soft.push(f.name);
      const rank = order.indexOf(f.part);
      const z = (rank < 0 ? 0 : rank) * 10 + f.layer;
      faces.push({ name: f.name, facing, quad: q4, z });
      if (facing && !behind && (body || f.kind === "screen")) {
        for (const q of q4) {
          x0 = Math.min(x0, q.x);
          y0 = Math.min(y0, q.y);
          x1 = Math.max(x1, q.x);
          y1 = Math.max(y1, q.y);
        }
      }
      if (f === build.main) {
        quad = q4;
        mainFacing = facing;
        mainFull = seen;
      }
      if (!write || !f.el) continue;
      const st = f.el.style;
      st.transform = transform;
      if (f.kind === "screen" || f.kind === "glass") {
        const c = cut ?? { x: 0, y: 0, w: f.w, h: f.h };
        st.width = `${c.w}px`;
        st.height = `${c.h}px`;
        const pane = /** @type {HTMLElement | null} */ (
          f.kind === "screen" ? f.el.firstElementChild : null
        );
        if (pane) {
          pane.style.left = `${-c.x}px`;
          pane.style.top = `${-c.y}px`;
        }
        if (f.radius > 0) {
          // round only the corners that are the screen's own
          const r = `${f6(f.radius)}px`;
          const L = c.x === 0;
          const T = c.y === 0;
          const R = c.x + c.w >= f.w;
          const B = c.y + c.h >= f.h;
          st.borderRadius = `${T && L ? r : "0px"} ${T && R ? r : "0px"} ${B && R ? r : "0px"} ${B && L ? r : "0px"}`;
        }
      }
      st.zIndex = String(z + 1);
      st.visibility = behind ? "hidden" : "inherit";
      // the light on it, at the two ends of its x (half way down its y): how
      // much it turns to the light, and a glint where it mirrors the light into
      // the lens. A piece of a curve takes its normal at each end, so the
      // pieces of one curve and the flat faces beside them meet in one tone.
      const col = /** @type {[number, number, number]} */ (colours.get(f));
      /** the light at a point of the face (its own px) with this normal @param {number} u @param {V3} nn */
      const light = (u, nn) => {
        const q = through(fp, v3(u, f.h / 2, 0));
        const P = v3(q.x, q.y, q.z);
        const L = unit(sub(lightAt, P));
        const half = unit(add(L, unit(sub(eyeAt, P))));
        return lit(
          col,
          AMBIENT + (1 - AMBIENT) * Math.max(0, dot(nn, L)),
          0.28 * Math.max(0, dot(nn, half)) ** 36,
        );
      };
      if (body) {
        const pm = partM(f.part);
        const n0 = f.ends ? turned(pm, f.ends[0]) : n;
        const n1 = f.ends ? turned(pm, f.ends[1]) : n;
        st.background = `linear-gradient(90deg, ${light(0, n0)}, ${light(f.w, n1)})`;
      }
      if (f.kind === "glass") {
        const half = unit(add(unit(sub(lightAt, v3(centre.x, centre.y, centre.z))), toEye));
        const glint = 0.05 + 0.22 * Math.max(0, dot(n, half)) ** 10;
        const dark = clamp(1 - p.screen);
        st.background = `linear-gradient(115deg, rgba(255,255,255,${f6(glint)}) 0%, rgba(255,255,255,0) 42%), rgba(6,6,8,${f6(dark)})`;
      }
      const extra = build.style?.(p, f);
      if (extra) Object.assign(st, extra);
    }
    if (write && el) {
      el.style.opacity = p.opacity >= 1 ? "" : String(f6(clamp(p.opacity)));
      if (p.opacity <= 0 && !hiddenByPose) {
        pageVisibility = el.style.visibility;
        el.style.visibility = "hidden";
        hiddenByPose = true;
      } else if (p.opacity > 0 && hiddenByPose) {
        el.style.visibility = pageVisibility;
        hiddenByPose = false;
      }
    }
    const origin = through(placed, v3(0, 0, 0));
    return {
      bounds: Number.isFinite(x0)
        ? { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }
        : { x: 0, y: 0, w: 0, h: 0 },
      quad,
      toFrame: (x, y) => {
        const q = through(mainFull, v3(x, y, 0));
        return [q.x, q.y];
      },
      facing: mainFacing,
      depth: origin.z,
      soft,
      faces,
    };
  };
  return {
    el,
    /** numbers only: where it is at this pose @param {Partial<Pose>} [pose] @param {Cam} [cam] */
    at: (pose, cam) => run(pose, cam, false),
    /** write its faces at this pose, and say where it is @param {Partial<Pose>} [pose] @param {Cam} [cam] */
    draw: (pose, cam) => run(pose, cam, true),
  };
}

/** a screen: the element given (moved onto the device), or a picture's or a
 *  video's URL as an <img> or a muted <video> at its size
 *  @param {HTMLElement | string | null | undefined} s @param {number | undefined} w @param {number | undefined} h @param {string} who */
function screenOf(s, w, h, who) {
  if (s == null) {
    if (!(w && h))
      throw new Error(
        `devices: a ${who} needs a screen (an element, or a picture's URL) or its w and h`,
      );
    return { el: null, w, h };
  }
  if (typeof s === "string") {
    if (!(w && h)) throw new Error(`devices: a ${who}'s screen from a URL needs its w and h (px)`);
    if (typeof document === "undefined") return { el: null, w, h };
    const video = /\.(mp4|webm|mov|m4v)(\?|#|$)/i.test(s);
    const e = /** @type {HTMLImageElement | HTMLVideoElement} */ (
      document.createElement(video ? "video" : "img")
    );
    e.src = s;
    if (e instanceof HTMLVideoElement) e.muted = true;
    Object.assign(e.style, {
      width: `${w}px`,
      height: `${h}px`,
      display: "block",
      objectFit: "cover",
    });
    return { el: /** @type {HTMLElement} */ (e), w, h };
  }
  const W = w ?? s.offsetWidth;
  const H = h ?? s.offsetHeight;
  if (!(W > 0 && H > 0))
    throw new Error(
      `devices: the ${who}'s screen element has no size where it is — give its w and h (px)`,
    );
  return { el: s, w: W, h: H };
}

/** the element a screen face holds, placed at its top-left
 *  @param {HTMLElement | null} el @param {number} w @param {number} h */
function screenFace(el, w, h) {
  if (!el || typeof document === "undefined") return null;
  const face = document.createElement("div");
  // a pane between them: when only part of the screen is in the frame, the
  // face is cut to that part and the pane moved so the part shows (draw)
  const pane = document.createElement("div");
  Object.assign(pane.style, {
    position: "absolute",
    left: "0px",
    top: "0px",
    width: `${w}px`,
    height: `${h}px`,
  });
  Object.assign(el.style, {
    position: "absolute",
    left: "0px",
    top: "0px",
    margin: "0px",
    width: `${w}px`,
    height: `${h}px`,
  });
  pane.appendChild(el);
  face.appendChild(pane);
  return face;
}

/** a keyboard and a touchpad drawn flat, keys a little darker than what is
 *  under them, as an SVG picture of w × d px (the back edge at the top)
 *  @param {number} w @param {number} d @param {string} keys */
function keyboard(w, d, keys) {
  const kw = 0.86 * w;
  const u = kw / 15;
  const gap = 0.11 * u;
  const x0 = (w - kw) / 2;
  let y = 0.07 * d;
  const rows = [
    { h: 0.55, keys: Array(14).fill(15 / 14) },
    { h: 1, keys: [...Array(13).fill(1), 2] },
    { h: 1, keys: [1.5, ...Array(12).fill(1), 1.5] },
    { h: 1, keys: [1.75, ...Array(11).fill(1), 2.25] },
    { h: 1, keys: [2.25, ...Array(10).fill(1), 2.75] },
    { h: 1, keys: [1, 1, 1, 1.25, 5.5, 1.25, 1, 1, 1, 1] },
  ];
  /** @type {string[]} */
  const out = [];
  for (const row of rows) {
    let x = x0;
    const hh = row.h * u;
    for (const k of row.keys) {
      const kwid = k * u;
      out.push(
        `<rect x="${f6(x + gap / 2)}" y="${f6(y + gap / 2)}" width="${f6(kwid - gap)}" height="${f6(hh - gap)}" rx="${f6(0.14 * u)}"/>`,
      );
      x += kwid;
    }
    y += hh;
  }
  const pw = 0.42 * w;
  const ph = Math.min(0.34 * d, d - y - 0.08 * d - 0.06 * d);
  const py = y + 0.07 * d;
  return `url("data:image/svg+xml,${encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${f6(w)}" height="${f6(d)}" viewBox="0 0 ${f6(w)} ${f6(d)}">` +
      `<rect x="0" y="0" width="${f6(w)}" height="${f6(0.028 * d)}" fill="rgba(0,0,0,0.22)"/>` +
      `<g fill="${keys}">${out.join("")}</g>` +
      `<rect x="${f6((w - pw) / 2)}" y="${f6(py)}" width="${f6(pw)}" height="${f6(ph)}" rx="${f6(0.03 * w)}" fill="rgba(0,0,0,0.05)" stroke="rgba(0,0,0,0.12)" stroke-width="${f6(0.0015 * w)}"/>` +
      "</svg>",
  )}") 0 0 / 100% 100% no-repeat`;
}

// --- the three -------------------------------------------------------------------------

/**
 * A laptop round a screen: the lid on a hinge at the back of the keyboard
 * half, the screen inside the lid, the keyboard and a touchpad drawn on the
 * keyboard half, enough thickness that shut it reads as a laptop. Its px are
 * the screen's: a bezel 2.8 % of the screen's width at the sides, 4 % above,
 * 5.5 % below; the keyboard half 70 % as deep as it is wide and 2.1 % of its
 * width thick, the lid 1.1 % (a 13-inch laptop is about 304 × 215 mm, 11 mm
 * shut). Its origin is the middle of its footprint, on the table.
 * Pose: open (degrees between lid and keyboard: 0 shut, 105 default, 180
 * flat), screen (1 lit … 0 dark), shadow.
 * @param {HTMLElement | null} host
 * @param {{ screen?: HTMLElement | string, w?: number, h?: number, color?: string, bezel?: string, keys?: string, thick?: number, lens?: { d?: number, cx?: number, cy?: number }, frame?: { width: number, height: number } }} [o]
 *   screen: the element shown on it (moved onto the lid), or a picture's or a video's URL;
 *   w, h: the screen's px (default the element's own size); color: its body (default "#c6c8cd");
 *   bezel: the glass round the screen (default "#0d0d10"); keys: the keys (default "rgba(18,18,22,0.78)");
 *   thick: the keyboard half's thickness as a share of its width (default 0.021)
 */
export function laptop(host, o = {}) {
  const scr = screenOf(o.screen, o.w, o.h, "laptop");
  const sw = scr.w;
  const sh = scr.h;
  const color = o.color ?? "#c6c8cd";
  const side = 0.028 * sw;
  const top = 0.04 * sw;
  const chin = 0.055 * sw;
  const W = sw + 2 * side;
  const L = sh + top + chin; // the lid, hinge to far edge
  const D = Math.max(0.7 * W, L + 0.02 * W);
  const T = (o.thick ?? 0.021) * W;
  const TL = 0.011 * W;
  const gap = 0.003 * W;
  const r = 0.03 * W;
  const hinge = v3(0, -T, -D / 2);
  const baseS = slab("base", {
    x0: -W / 2,
    x1: W / 2,
    z0: -D / 2,
    z1: D / 2,
    y0: -T,
    y1: 0,
    r,
    seg: 4,
    color,
  });
  const keysFace = rect({ ...baseS.top, name: "keys", kind: "decal", layer: 1 });
  const lidS = slab("lid", {
    x0: -W / 2,
    x1: W / 2,
    z0: -D / 2,
    z1: -D / 2 + L,
    y0: -T - gap - TL,
    y1: -T - gap,
    r,
    seg: 4,
    color,
    bottom: { kind: "bezel", color: o.bezel ?? "#0d0d10" },
  });
  // the screen on the lid's underside: its x along the lid, its y from the
  // far edge toward the hinge — upright once the lid is raised
  const B = lidS.bottom;
  const at0 = add(B.O, add(mulv(B.U, side), mulv(B.V, top)));
  const screen = rect({
    name: "screen",
    part: "lid",
    kind: "screen",
    layer: 2,
    O: at0,
    U: B.U,
    V: B.V,
    w: sw,
    h: sh,
  });
  const glass = rect({
    name: "glass",
    part: "lid",
    kind: "glass",
    layer: 3,
    O: at0,
    U: B.U,
    V: B.V,
    w: sw,
    h: sh,
  });
  const shadow = floor("shadow", "shadow", 0, 0, 1.22 * W, 1.32 * D, 0);
  screen.el = screenFace(scr.el, sw, sh);
  const faces = [shadow, ...baseS.faces, keysFace, ...lidS.faces, screen, glass];
  const keyPic = keyboard(baseS.top.w, baseS.top.h, o.keys ?? "rgba(18,18,22,0.78)");
  return device(
    host,
    {
      faces,
      main: screen,
      parts: (p) => ({
        lid: M.mul(
          M.mul(M.translate(hinge.x, hinge.y, hinge.z), M.rotateX(clamp(p.open, 0, 180))),
          M.translate(-hinge.x, -hinge.y, -hinge.z),
        ),
      }),
      // the keyboard half's top divides them: the lid is always on its upper side
      order: (_p, eye) =>
        eye(v3(0, -T, 0), v3(0, -1, 0)) ? ["floor", "base", "lid"] : ["floor", "lid", "base"],
      look: (f) => (f === keysFace ? { background: keyPic } : null),
      style: (p, f) =>
        f === shadow
          ? {
              background: `radial-gradient(closest-side, rgba(0,0,0,${f6(0.26 * clamp(p.shadow))}), rgba(0,0,0,${f6(0.1 * clamp(p.shadow))}) 62%, rgba(0,0,0,0))`,
            }
          : null,
    },
    o,
    { open: 105 },
  );
}

/**
 * A phone: a rounded slab, the screen on its front with rounded corners, the
 * front edge bevelled. Its px are the screen's: a border 4.5 % of the screen's
 * width, outer corners 16 %, 8.5 % thick (a 7.8 mm phone 71.5 mm wide is
 * 11 %). Its origin is the middle of its screen, the screen toward the lens.
 * Pose: screen (1 lit … 0 dark).
 * @param {HTMLElement | null} host
 * @param {{ screen?: HTMLElement | string, w?: number, h?: number, color?: string, bezel?: string, lens?: { d?: number, cx?: number, cy?: number }, frame?: { width: number, height: number } }} [o]
 *   color: its body (default "#1d1e22"); bezel: the glass round the screen (default "#050507")
 */
export function phone(host, o = {}) {
  const scr = screenOf(o.screen, o.w, o.h, "phone");
  const sw = scr.w;
  const sh = scr.h;
  const color = o.color ?? "#1d1e22";
  const border = 0.045 * sw;
  const W = sw + 2 * border;
  const H = sh + 2 * border;
  const T = 0.085 * sw;
  const R = 0.16 * sw;
  const bevel = 0.3 * T;
  // lying flat, screen up; stood up by its part's matrix (the top toward the lens)
  const body = slab("body", {
    x0: -W / 2,
    x1: W / 2,
    z0: -H / 2,
    z1: H / 2,
    y0: 0,
    y1: T,
    r: R,
    seg: 6,
    bevel,
    color,
    top: { kind: "bezel", color: o.bezel ?? "#050507" },
  });
  const sr = Math.max(0, R - border);
  const screen = rect({
    name: "screen",
    part: "body",
    kind: "screen",
    layer: 2,
    O: v3(-sw / 2, 0, -sh / 2),
    U: v3(1, 0, 0),
    V: v3(0, 0, 1),
    w: sw,
    h: sh,
    radius: sr,
  });
  const glass = rect({ ...screen, name: "glass", kind: "glass", layer: 3 });
  const shadow = floor("shadow", "shadow", 0, 0, 1.25 * W, 1.12 * H, T);
  screen.el = screenFace(scr.el, sw, sh);
  return device(
    host,
    {
      faces: [shadow, ...body.faces, screen, glass],
      main: screen,
      parts: () => ({ body: M.rotateX(-90), floor: M.rotateX(-90) }),
      order: () => ["floor", "body"],
      style: (p, f) =>
        f === shadow
          ? {
              background: `radial-gradient(closest-side, rgba(0,0,0,${f6(0.3 * clamp(p.shadow))}), rgba(0,0,0,0))`,
            }
          : null,
    },
    o,
    { shadow: 0 },
  );
}

/**
 * A plain box computer — a desktop, a small server, a machine in the cloud:
 * a rounded box with a bevelled top and a status light on its front. pose.on
 * (0…1) lights it: the light in its colour and a glow on the table round it.
 * Its px are its own (w × h × d, default 300 × 110 × 300); its origin is the
 * middle of its footprint, on the table; its front faces the lens.
 * @param {HTMLElement | null} host
 * @param {{ w?: number, h?: number, d?: number, r?: number, bevel?: number, color?: string, light?: string, front?: HTMLElement, top?: HTMLElement, lens?: { d?: number, cx?: number, cy?: number }, frame?: { width: number, height: number } }} [o]
 *   color: its body (default "#ecebe7"); light: the status light's and the glow's colour
 *   (default "#38c172"); front, top: an element of the page shown on that face
 *   (front: (w − 2r) × (h − bevel) px; top: the top's flat part)
 */
export function computer(host, o = {}) {
  const w = o.w ?? 300;
  const h = o.h ?? 110;
  const dd = o.d ?? 300;
  const r = o.r ?? 0.16 * Math.min(w, dd);
  const bevel = Math.min(r, o.bevel ?? 0.16 * h);
  const color = o.color ?? "#ecebe7";
  const light = o.light ?? "#38c172";
  const lc = rgbOf(light);
  const body = slab("body", {
    x0: -w / 2,
    x1: w / 2,
    z0: -dd / 2,
    z1: dd / 2,
    y0: -h,
    y1: 0,
    r,
    seg: 6,
    bevel,
    color,
  });
  const fw = w - 2 * r;
  const fh = h - bevel;
  const front = rect({
    name: "front",
    part: "body",
    kind: "decal",
    layer: 1,
    O: v3(-w / 2 + r, -h + bevel, dd / 2),
    U: v3(1, 0, 0),
    V: v3(0, 1, 0),
    w: fw,
    h: fh,
  });
  const topFace = rect({ ...body.top, name: "top mark", kind: "decal", layer: 1 });
  const glow = floor("glow", "glow", 0, 0, 2.6 * w, 2.6 * dd, 0);
  const shadow = floor("shadow", "shadow", 0, 0, 1.3 * w, 1.3 * dd, 0);
  /** @type {HTMLElement | null} */
  let led = null;
  if (typeof document !== "undefined") {
    const fe = document.createElement("div");
    led = document.createElement("div");
    const size = Math.max(4, 0.045 * Math.min(w, h * 2));
    Object.assign(led.style, {
      position: "absolute",
      left: `${f6(0.06 * fw)}px`,
      top: `${f6(fh / 2 - size / 2)}px`,
      width: `${f6(size)}px`,
      height: `${f6(size)}px`,
      borderRadius: "50%",
    });
    fe.appendChild(led);
    if (o.front) {
      Object.assign(o.front.style, {
        position: "absolute",
        left: "0px",
        top: "0px",
        margin: "0px",
      });
      fe.appendChild(o.front);
    }
    front.el = fe;
    if (o.top) {
      const te = document.createElement("div");
      Object.assign(o.top.style, { position: "absolute", left: "0px", top: "0px", margin: "0px" });
      te.appendChild(o.top);
      topFace.el = te;
    }
  }
  const faces = [glow, shadow, ...body.faces, front, ...(o.top ? [topFace] : [])];
  return device(
    host,
    {
      faces,
      main: front,
      parts: () => ({}),
      order: () => ["floor", "body"],
      /** @returns {Record<string, string> | null} */
      style: (p, f) => {
        const on = clamp(p.on);
        if (f === glow)
          return {
            background: `radial-gradient(closest-side, rgba(${lc.join(",")},${f6(0.42 * on)}), rgba(${lc.join(",")},${f6(0.14 * on)}) 55%, rgba(${lc.join(",")},0))`,
            visibility: on > 0 ? "inherit" : "hidden",
          };
        if (f === shadow)
          return {
            background: `radial-gradient(closest-side, rgba(0,0,0,${f6(0.24 * clamp(p.shadow))}), rgba(0,0,0,0))`,
          };
        if (f === front && led) {
          const dim = [150, 150, 150];
          const mix = dim.map((v, i) => Math.round(v + ((lc[i] ?? v) - v) * on));
          Object.assign(led.style, {
            background: `rgb(${mix.join(",")})`,
            boxShadow:
              on > 0
                ? `0 0 ${f6(4 + 10 * on)}px ${f6(1 + 3 * on)}px rgba(${lc.join(",")},${f6(0.85 * on)})`
                : "none",
          });
        }
        return null;
      },
    },
    o,
    { on: 0 },
  );
}
