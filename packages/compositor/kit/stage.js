// @ts-check
// Depth for a film page — open-take's film kit. Parts of the product as flat
// slabs in 3D: a screen tilted into space while what is on it keeps working,
// a screen coming apart into its parts and back together, cards lowered onto
// the stage like prints or onto a pile, a card turning over to show the next
// scene, the whole layout turning into a table, the lens travelling past one
// slab into what lies behind it. A slab is one element — a part of a saved
// screen shown through a window its size (an iframe of state.html cropped to
// the part: live DOM), a part's own file (parts/), a crop of a picture, a
// <video>, any node — with its own pose over time; the stage turns the poses
// into one CSS transform per slab.
//
// Sharp by construction. Chrome draws a layer under a perspective at no more
// than about the frame's area and stretches it (`skill film render`: a whole
// saved page tilted and pushed to 2.3× went soft; a tilted box no bigger than
// the part it showed stayed sharp). So here:
//   - each slab is laid out at its part's own size, with its own perspective
//     — no perspective on a parent, no layer bigger than the part it shows;
//   - a slab square on to the lens (no tilt left) is written as a plain 2D
//     transform, no perspective at all, so a push into it — or the lens
//     travelling up to it — is drawn at its final scale;
//   - warnings() names a tilted slab drawn bigger than the frame (it would be
//     stretched) and when, and at(t) says it per slab (`soft`).
//
// Nothing is on until you ask: a film that never calls stage() stays flat, a
// slab never moved stays where its part sat, and no move has a default angle.
// The few defaults below each say where they come from (`skill film craft`).
//
//   import { stage, explode, together, drop, flip } from "./kit/stage.js";
//   const st = stage({ el: document.querySelector("#stage"), camera: cam });
//   const card = st.slab(frameOf("states/home/state.html"), { crop: { x: 607, y: 136, width: 706, height: 203 } });
//   card.to({ rx: 20, ry: -28 }, { start: 2, dur: 0.9 });   // tilts into depth, content still live
//   card.to({ rx: 0, ry: 0 }, { arrive: 5 });               // and square on again
//   st.turn({ rx: 40 }, { start: 6, dur: 1.2 });            // the whole layout becomes a table
//   explode([bg, header, card], { start: 7.5, gap: 140 });  // its parts lift apart
//   window.__render = (t) => st.apply(t);
//
// Or a picture, a video or a part the page already has, where it is — not
// moved, not wrapped, untouched until it is asked to move (`st.adopt`):
//
//   const st = stage();
//   const shot = st.adopt(document.querySelector("#nycShot"));
//   shot.to({ rx: 7, ry: -9 }, { start: 3.9, dur: 0.7 });  // tilted into depth, then
//   shot.to({ rx: 0, ry: 0 }, { arrive: 6 });               // square on: as it was
//   window.__render = (t) => { sc.show(t); st.apply(t); };  // after scenes, if any

/** @typedef {{ x: number, y: number, w?: number, h?: number, width?: number, height?: number }} BoxLike */
/** @typedef {{ x: number, y: number, w: number, h: number }} Box */
/**
 * @typedef {object} Pose  where a slab is, from where its part sat
 * @property {number} x px across, from its place (default 0)
 * @property {number} y px down
 * @property {number} z px toward the lens (+) or away (−)
 * @property {number} rx degrees about its horizontal axis — positive tips its top away
 * @property {number} ry degrees about its vertical axis — positive turns its right side away
 * @property {number} rz degrees in its own plane, clockwise
 * @property {number} scale its size, 1 as it sat
 * @property {number} opacity 0..1
 */
/**
 * @typedef {object} When  when a move happens — one of `arrive` or `start`
 * @property {number} [start] the move leaves here (s)
 * @property {number} [arrive] the move lands here (s)
 * @property {number} [dur] how long it takes (s, default 0.73 — the camera's push-in)
 * @property {(p: number) => number} [ease] progress 0..1 over `dur`; default: the camera's settle (96 % in `dur`, the rest into the hold)
 * @property {{ freq?: number, damping?: number, overshoot?: number }} [spring] a spring instead of `ease`:
 *   it runs until it settles (its `dur` is that time); freq Hz (default 1.6), damping ratio or overshoot share
 */
/** @typedef {{ cx: number, cy: number, w: number, scale: number }} View */
/** @typedef {{ at: (t: number) => View, jitter?: (t: number) => { x: number, y: number, rot: number }, view?: { width: number, height: number }, content?: { width: number, height: number } }} CameraLike  a kit camera (kit/camera.js) */
/** @typedef {number[]} Mat  a 4×4 matrix, column-major (as CSS matrix3d lists it) */

const FIELDS = /** @type {const} */ (["x", "y", "z", "rx", "ry", "rz", "scale", "opacity"]);
/** @type {Pose} */
const REST = Object.freeze({ x: 0, y: 0, z: 0, rx: 0, ry: 0, rz: 0, scale: 1, opacity: 1 });
// a lens 2000 px from the stage: the middle of the 1600–2800 px measured on
// the films that tilted a screen into space (`skill film craft`, Depth)
const DEFAULT_PERSPECTIVE = 2000;
// the camera's push-in: 0.73 s, 96 % of the way in its time, the rest
// settling into the hold (kit/camera.js)
const DEFAULT_DUR = 0.73;
const SETTLE = 0.04;

// --- small helpers ----------------------------------------------------------

/** @param {number} x */
const clamp01 = (x) => Math.max(0, Math.min(1, x));
/** @param {number} a @param {number} b @param {number} p */
const lerp = (a, b, p) => a + (b - a) * p;
const RAD = Math.PI / 180;
/** @param {BoxLike} b @returns {Box} */
const boxOf = (b) => ({ x: b.x, y: b.y, w: b.w ?? b.width ?? 0, h: b.h ?? b.height ?? 0 });
/** @param {number} v */
const f6 = (v) => (Math.abs(v) < 1e-12 ? 0 : +v.toPrecision(10));

/** what is left of a move at progress u: an overdamped spring's step (ζ 1.2)
 *  whose residual at u = 1 is `frac` — the camera's settleDecay (kit/camera.js) */
/** @param {number} frac */
function settleDecay(frac) {
  const zeta = 1.2;
  const s = Math.sqrt(zeta * zeta - 1);
  const l1 = zeta + s;
  const l2 = zeta - s;
  /** @param {number} x */
  const resid = (x) => (l1 * Math.exp(-l2 * x) - l2 * Math.exp(-l1 * x)) / (l1 - l2);
  let lo = 0.1;
  let hi = 60;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    if (resid(mid) > frac) lo = mid;
    else hi = mid;
  }
  const w0T = (lo + hi) / 2;
  /** @param {number} u */
  return (u) => (u <= 0 ? 1 : resid(w0T * u));
}
const decay = settleDecay(SETTLE);

/** a unit step of a damped spring, from 0 toward 1, τ s after release (the
 *  closed forms of kit/motion.js's spring) */
/** @param {number} tau @param {number} w0 @param {number} zeta */
function springStep(tau, w0, zeta) {
  if (tau <= 0) return 0;
  if (Math.abs(zeta - 1) < 1e-6) return 1 - Math.exp(-w0 * tau) * (1 + w0 * tau);
  if (zeta < 1) {
    const wd = w0 * Math.sqrt(1 - zeta * zeta);
    const a = zeta * w0;
    return 1 - Math.exp(-a * tau) * (Math.cos(wd * tau) + (a / wd) * Math.sin(wd * tau));
  }
  const q = Math.sqrt(zeta * zeta - 1);
  const r1 = -w0 * (zeta - q);
  const r2 = -w0 * (zeta + q);
  const c2 = r1 / (r1 - r2);
  const c1 = -1 - c2;
  return 1 + c1 * Math.exp(r1 * tau) + c2 * Math.exp(r2 * tau);
}

/** a spring's ω0 and ζ: 1.6 Hz and ζ 0.7 unless asked (kit/motion.js's defaults) */
/** @param {{ freq?: number, damping?: number, overshoot?: number }} o */
function springOf(o) {
  const w0 = 2 * Math.PI * (o.freq ?? 1.6);
  let zeta = o.damping ?? 0.7;
  if (o.overshoot != null) {
    const l = Math.log(Math.min(Math.max(o.overshoot, 1e-6), 0.999));
    zeta = o.overshoot > 0 ? -l / Math.sqrt(Math.PI * Math.PI + l * l) : 1;
  }
  if (!(w0 > 0)) throw new Error("stage: a spring's freq must be above 0");
  if (!(zeta > 0)) throw new Error("stage: a spring's damping must be above 0");
  // until it stays within 1 % of its travel: when the next thing can be planned
  const step = 1 / 240;
  let last = 0;
  for (let tau = 0; tau < 30; tau += step) {
    if (Math.abs(springStep(tau, w0, zeta) - 1) > 0.01) last = tau;
    else if (tau - last > 4 / w0) break;
  }
  return { w0, zeta, settle: last + step };
}

// --- 4×4 matrices, as CSS matrix3d lists them (column-major) ------------------

/** @returns {Mat} */
const identity = () => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
/** a · b: b applied first, as CSS reads a transform list right to left */
/** @param {Mat} a @param {Mat} b @returns {Mat} */
function mul(a, b) {
  const o = new Array(16).fill(0);
  for (let c = 0; c < 4; c++)
    for (let r = 0; r < 4; r++) {
      let s = 0;
      for (let k = 0; k < 4; k++)
        s += /** @type {number} */ (a[k * 4 + r]) * /** @type {number} */ (b[c * 4 + k]);
      o[c * 4 + r] = s;
    }
  return o;
}
/** @param {number} x @param {number} y @param {number} [z] @returns {Mat} */
const translate = (x, y, z = 0) => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1];
/** @param {number} sx @param {number} [sy] @returns {Mat} */
const scale = (sx, sy = sx) => [sx, 0, 0, 0, 0, sy, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
// CSS's rotations (y points down, z toward the viewer)
/** @param {number} deg @returns {Mat} */
const rotateX = (deg) => {
  const c = Math.cos(deg * RAD);
  const s = Math.sin(deg * RAD);
  return [1, 0, 0, 0, 0, c, s, 0, 0, -s, c, 0, 0, 0, 0, 1];
};
/** @param {number} deg @returns {Mat} */
const rotateY = (deg) => {
  const c = Math.cos(deg * RAD);
  const s = Math.sin(deg * RAD);
  return [c, 0, -s, 0, 0, 1, 0, 0, s, 0, c, 0, 0, 0, 0, 1];
};
/** @param {number} deg @returns {Mat} */
const rotateZ = (deg) => {
  const c = Math.cos(deg * RAD);
  const s = Math.sin(deg * RAD);
  return [c, s, 0, 0, -s, c, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
};
/** CSS perspective(d): a point at z is seen d / (d − z) times its size */
/** @param {number} d @returns {Mat} */
const perspective = (d) => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, -1 / d, 0, 0, 0, 1];
/** @param {Mat} m @param {number} x @param {number} y @param {number} [z] */
function apply(m, x, y, z = 0) {
  /** @param {number} i */
  const g = (i) => /** @type {number} */ (m[i]);
  const w = g(3) * x + g(7) * y + g(11) * z + g(15);
  return {
    x: (g(0) * x + g(4) * y + g(8) * z + g(12)) / w,
    y: (g(1) * x + g(5) * y + g(9) * z + g(13)) / w,
    z: (g(2) * x + g(6) * y + g(10) * z + g(14)) / w,
    w,
  };
}

// --- moves over time -----------------------------------------------------------

/**
 * @typedef {object} Track  one field's moves, in the order asked
 * @property {{ t0: number, dur: number, to: number, curve: ((tau: number) => number) | null }[]} moves
 */

/** a When resolved to its start, its length and its progress curve (null: a cut) */
/** @param {When} w @param {string} label */
function timing(w, label) {
  const at = w.arrive ?? w.start;
  if (at == null || !Number.isFinite(at))
    throw new Error(`stage: ${label} needs { arrive } or { start }`);
  if (w.arrive != null && w.start != null)
    throw new Error(`stage: ${label} takes { arrive } or { start }, not both`);
  /** @type {(tau: number) => number} */
  let curve;
  /** @type {number} */
  let dur;
  if (w.spring) {
    const s = springOf(w.spring);
    dur = w.dur ?? s.settle;
    curve = (tau) => springStep(tau, s.w0, s.zeta);
  } else {
    dur = w.dur ?? DEFAULT_DUR;
    if (!(dur > 0)) throw new Error(`stage: ${label}: dur must be above 0`);
    const ease = w.ease;
    curve = ease ? (tau) => ease(clamp01(tau / dur)) : (tau) => 1 - decay(tau / dur);
  }
  const t0 = w.arrive != null ? w.arrive - dur : at;
  return { t0, dur, curve };
}

/** a field at t: each move starts from wherever the field is when it begins
 *  and runs until the next one does — the camera's rule (kit/camera.js) */
/** @param {Track} track @param {number} rest @param {number} t */
function fieldAt(track, rest, t) {
  let v = rest;
  const ms = track.moves;
  for (let i = 0; i < ms.length; i++) {
    const m = /** @type {Track["moves"][number]} */ (ms[i]);
    if (t < m.t0) break;
    const next = ms[i + 1];
    const until = next ? Math.min(t, next.t0) : t;
    v = m.curve ? lerp(v, m.to, m.curve(until - m.t0)) : m.to;
    if (!next || t < next.t0) break;
  }
  return v;
}

/** the moves of a pose, one track per field */
function poseTracks() {
  /** @type {Record<keyof Pose, Track>} */
  const tracks = /** @type {any} */ ({});
  for (const f of FIELDS) tracks[f] = { moves: [] };
  return tracks;
}

/** @param {Record<keyof Pose, Track>} tracks @param {Partial<Pose>} to @param {When | null} w @param {number} at @param {string} label */
function ask(tracks, to, w, at, label) {
  const tm = w ? timing(w, label) : { t0: at, dur: 0, curve: null };
  for (const [k, v] of Object.entries(to)) {
    if (!FIELDS.includes(/** @type {any} */ (k)))
      throw new Error(`stage: ${label}: no pose field "${k}" (${FIELDS.join(", ")})`);
    if (v == null) continue;
    if (!Number.isFinite(v)) throw new Error(`stage: ${label}: ${k} must be a number`);
    const track = tracks[/** @type {keyof Pose} */ (k)];
    track.moves.push({ t0: tm.t0, dur: tm.dur, to: v, curve: tm.curve });
    // in time order; at one instant, in the order asked
    track.moves.sort((a, b) => (a.t0 < b.t0 ? -1 : a.t0 > b.t0 ? 1 : 0));
  }
  return tm;
}

/** @param {Record<keyof Pose, Track>} tracks @param {Pose} rest @param {number} t @returns {Pose} */
function poseOf(tracks, rest, t) {
  /** @type {any} */
  const p = {};
  for (const f of FIELDS) p[f] = fieldAt(tracks[f], rest[f], t);
  return p;
}

// --- the stage -------------------------------------------------------------------

/**
 * @typedef {object} SlabOpts
 * @property {BoxLike} [box] where the slab sits on the stage (px); default its crop's box, else the node's own box
 * @property {BoxLike} [crop] show this region of the node (a saved screen's iframe, a picture, a video at the stage's size): the window is the region's size, the slab sits where it was
 * @property {string} [name] what warnings call it
 * @property {[number, number]} [origin] the point it turns about, as shares of its box (default [0.5, 0.5]: its centre)
 * @property {"hidden" | "visible"} [backface] its back when turned away (default hidden: a card's other side is another slab)
 * @property {number} [blur] px of blur per 1000 px it is in front of or behind the focus (default 0: off) — the ones nearer the lens softer
 * @property {number} [sheen] 0..1: a band of light that crosses it as it turns (default 0: off)
 * @property {number} [shadow] 0..1: a shadow under it, wide and soft when lifted, close and sharp when down (default 0: off)
 * @property {Partial<Pose>} [rest] its pose before any move (default where its part sat)
 * @property {boolean} [inPlace] (internal) the node is adopted where it is — `st.adopt`
 */

/**
 * @typedef {object} Slab  a slab on the stage
 * @property {string} name
 * @property {Box} box where it sits (px)
 * @property {HTMLElement | null} el its element (null on a stage without `el`): put what it shows in it
 * @property {[number, number]} origin
 * @property {"hidden" | "visible"} backface
 * @property {number} blur
 * @property {number} sheen
 * @property {number} shadow
 * @property {HTMLElement | null} light its light band's layer, when it has a sheen
 * @property {boolean} inPlace an element adopted where it was (`st.adopt`)
 * @property {(to: Partial<Pose>, when: When) => Slab} to move to a pose — only the fields given; the rest keep moving as they were
 * @property {(to: Partial<Pose>, at: number) => Slab} set a cut: from `at` on (-Infinity: from the start), these fields are this, with no move
 * @property {(t: number) => Pose} pose its own pose at t
 */

/**
 * @typedef {object} SlabState  a slab at t, ready for CSS
 * @property {string} name
 * @property {Pose} pose its own pose (the stage's turn and lens not in it)
 * @property {{ transform: string, opacity: string, visibility: string, zIndex: string, filter: string, boxShadow: string }} style
 * @property {{ background: string, opacity: number } | null} sheen the light band's layer (null: no sheen asked)
 * @property {boolean} flat square on to the lens: drawn with a 2D transform, no perspective
 * @property {boolean} facing its front toward the lens
 * @property {{ x: number, y: number }[]} quad its corners in the picture (px), top-left first, clockwise
 * @property {number} area px² it covers in the picture
 * @property {number} depth its centre's z after the turn and the lens (px, + nearer)
 * @property {boolean} soft tilted and drawn bigger than the frame: Chrome stretches such a layer
 */

/**
 * A stage of slabs: the picture's size, a lens, and optionally the film's
 * camera, whose view frames it (slabs are placed in its content px, and the
 * vanishing point is the middle of what it shows — a zoom is a longer lens,
 * the depth unchanged).
 * @param {object} [opts]
 * @param {HTMLElement} [opts.el] the element slabs are put in: at the picture's top-left, not transformed (default: slabs are numbers only — at(t))
 * @param {number} [opts.width] the picture (px, default the camera's view, else 1920)
 * @param {number} [opts.height] (default the camera's view, else 1080)
 * @param {number} [opts.perspective] how far the lens is from the stage (px, default 2000)
 * @param {CameraLike} [opts.camera] a kit camera: its view at t frames the stage
 * @param {[number, number]} [opts.pivot] what the stage turns about (px, default the middle of the content)
 * @param {number} [opts.focus] the depth in focus, for slabs that blur (px, default 0)
 */
export function stage(opts = {}) {
  const cam = opts.camera ?? null;
  const W = opts.width ?? cam?.view?.width ?? 1920;
  const H = opts.height ?? cam?.view?.height ?? 1080;
  const content = cam?.content ?? { width: W, height: H };
  const d = opts.perspective ?? DEFAULT_PERSPECTIVE;
  if (!(d > 0)) throw new Error("stage: perspective must be a distance above 0 px");
  const pivot = opts.pivot ?? [content.width / 2, content.height / 2];
  const focus = opts.focus ?? 0;
  const host = opts.el ?? null;
  /** @type {Slab[]} */
  const slabs = [];
  // the stage's own turn (rx, ry, rz about the pivot), the lens's travel (z)
  const world = poseTracks();
  /** every move asked, as [start, end] (s): where warnings() looks */
  /** @type {[number, number][]} */
  const spans = [];
  /** @param {{ t0: number, dur: number }} tm */
  const note = (tm) => {
    if (Number.isFinite(tm.t0)) spans.push([tm.t0, tm.t0 + tm.dur]);
  };

  /** the camera's view as a 2D map, content → picture (kit/camera.js's css()) */
  /** @param {number} t */
  const viewAt = (t) => {
    if (!cam) return { m: identity(), cx: content.width / 2, cy: content.height / 2 };
    const v = cam.at(t);
    const s = v.scale ?? W / v.w;
    let m = mul(translate(W / 2 - v.cx * s, H / 2 - v.cy * s), scale(s));
    const j = cam.jitter?.(t);
    if (j && (j.x || j.y || j.rot))
      m = mul(
        mul(translate(W / 2 + j.x, H / 2 + j.y), rotateZ(j.rot)),
        mul(translate(-W / 2, -H / 2), m),
      );
    return { m, cx: v.cx, cy: v.cy };
  };

  /** @param {Slab} sl @param {number} t @returns {SlabState} */
  const state = (sl, t) => {
    const p = sl.pose(t);
    const w = poseOf(world, REST, t);
    const b = sl.box;
    const ox = b.w * sl.origin[0];
    const oy = b.h * sl.origin[1];
    // the slab: turned and sized about its origin, moved from where it sat
    const own = mul(
      mul(
        translate(b.x + ox + p.x, b.y + oy + p.y, p.z),
        mul(mul(rotateX(p.rx), rotateY(p.ry)), rotateZ(p.rz)),
      ),
      mul(scale(p.scale), translate(-ox, -oy)),
    );
    // the stage turned about its pivot, then the lens's travel
    const turned = mul(
      mul(
        translate(pivot[0], pivot[1], w.z),
        mul(mul(rotateX(w.rx), rotateY(w.ry)), rotateZ(w.rz)),
      ),
      translate(-pivot[0], -pivot[1]),
    );
    const placed = mul(turned, own);
    const view = viewAt(t);
    const lens = mul(
      mul(translate(view.cx, view.cy), perspective(d)),
      translate(-view.cx, -view.cy),
    );
    // an adopted element is drawn from where it already sits: its transform
    // is the move away from that place, not the whole way from the corner
    const full = sl.inPlace
      ? mul(translate(-b.x, -b.y), mul(view.m, mul(lens, placed)))
      : mul(view.m, mul(lens, placed));
    // which way it faces, and how deep its centre is, before the lens
    const n = {
      x: /** @type {number} */ (placed[8]),
      y: /** @type {number} */ (placed[9]),
      z: /** @type {number} */ (placed[10]),
    };
    const len = Math.hypot(n.x, n.y, n.z) || 1;
    const facing = n.z / len > 0;
    const c = apply(placed, b.w / 2, b.h / 2);
    const corners = [
      [0, 0],
      [b.w, 0],
      [b.w, b.h],
      [0, b.h],
    ].map(([x, y]) =>
      apply(
        sl.inPlace ? mul(translate(b.x, b.y), full) : full,
        /** @type {number} */ (x),
        /** @type {number} */ (y),
      ),
    );
    const behind = corners.some((q) => !(q.w > 1e-6));
    const quad = corners.map((q) => ({ x: q.x, y: q.y }));
    let area = 0;
    for (let i = 0; i < 4; i++) {
      const a = /** @type {{x:number,y:number}} */ (quad[i]);
      const e = /** @type {{x:number,y:number}} */ (quad[(i + 1) % 4]);
      area += a.x * e.y - e.x * a.y;
    }
    area = behind ? Number.POSITIVE_INFINITY : Math.abs(area) / 2;
    // square on: every point of it at one depth, so the lens only scales it —
    // a 2D transform, drawn by Chrome at its final scale
    const flat = Math.abs(Math.abs(n.z) / len - 1) < 1e-7;
    let transform;
    if (flat && !behind) {
      const o = apply(full, 0, 0);
      const ex = apply(full, 1, 0);
      const ey = apply(full, 0, 1);
      transform = `matrix(${[ex.x - o.x, ex.y - o.y, ey.x - o.x, ey.y - o.y, o.x, o.y].map(f6).join(", ")})`;
    } else transform = `matrix3d(${full.map(f6).join(", ")})`;
    // close to the lens it fades: the last quarter of the way it is gone
    const ahead = d - c.z;
    const nearFade = clamp01((ahead - 0.02 * d) / (0.23 * d));
    const opacity = clamp01(p.opacity) * nearFade;
    const hidden = behind || opacity <= 0 || (!facing && sl.backface === "hidden");
    const lifted = Math.max(0, p.z);
    const blur = sl.blur > 0 ? (sl.blur * Math.abs(c.z - focus)) / 1000 : 0;
    const shadow =
      sl.shadow > 0
        ? `0 ${f6(4 + 0.08 * lifted)}px ${f6(8 + 0.15 * lifted)}px rgba(0, 0, 0, ${f6(sl.shadow * 0.35 * (1 - 0.5 * clamp01(lifted / (0.3 * d))))})`
        : "none";
    /** @type {SlabState["sheen"]} */
    let sheen = null;
    if (sl.sheen > 0) {
      // a light up and to the left of the lens: turning the slab moves the
      // band across it, square on it is gone
      const turn = p.ry + w.ry + 0.5 * (p.rx + w.rx);
      const at = 50 - turn * 2.2;
      const k = clamp01(Math.abs(turn) / 25);
      sheen = {
        background: `linear-gradient(105deg, rgba(255,255,255,0) ${f6(at - 18)}%, rgba(255,255,255,${f6(0.55 * sl.sheen)}) ${f6(at)}%, rgba(255,255,255,0) ${f6(at + 18)}%)`,
        opacity: f6(k),
      };
    }
    return {
      name: sl.name,
      pose: p,
      style: {
        transform,
        opacity: String(f6(opacity)),
        visibility: hidden ? "hidden" : "visible",
        zIndex: "0", // set by at(t), nearest on top
        filter: blur > 0.05 ? `blur(${f6(blur)}px)` : "none",
        boxShadow: shadow,
      },
      sheen,
      flat,
      facing,
      quad,
      area,
      depth: c.z,
      soft: !flat && !hidden && area > W * H,
    };
  };

  /** every slab at t, the nearest drawn on top */
  /** @param {number} t @returns {SlabState[]} */
  const at = (t) => {
    const all = slabs.map((s) => state(s, t));
    const order = all.map((s, i) => ({ s, i })).sort((a, b) => a.s.depth - b.s.depth || a.i - b.i);
    order.forEach(({ s }, k) => {
      s.style.zIndex = String(k + 1);
    });
    return all;
  };

  /**
   * A slab: a node shown flat in space. With `crop`, the node is a whole
   * screen, picture or video at the stage's size and the slab a window onto
   * that region (an iframe of a saved screen cropped to one part: live DOM,
   * sharp at any size); without, the node itself at its own size.
   * @param {HTMLElement | string | null} node an element, a saved screen's state.html or a picture's URL (put in an iframe or an img at the stage's size), or null: an empty slab of `box` to draw into (`slab.el`)
   * @param {SlabOpts} [o]
   */
  const slab = (node, o = {}) => {
    const name = o.name ?? `slab ${slabs.length + 1}`;
    const crop = o.crop ? boxOf(o.crop) : null;
    /** @type {Box | null} */
    let box = o.box ? boxOf(o.box) : crop;
    /** @type {HTMLElement | null} */
    let el = null;
    const inPlace = !!o.inPlace;
    if (inPlace) {
      if (!node || typeof node !== "object")
        throw new Error(`stage: ${name}: adopt takes an element the page already has`);
      el = node;
      box ??= placeOf(node);
      if (!box) throw new Error(`stage: ${name} has no size where it sits (give it a box)`);
      // turning about its own corner, as the stage's matrices are written;
      // nothing shows of it until a transform is written
      el.style.transformOrigin = "0 0";
      if (o.backface) el.style.backfaceVisibility = o.backface;
    } else if (host) {
      el = document.createElement("div");
      el.dataset.otSlab = name;
      /** @type {HTMLElement | null} */
      let inner = null;
      if (typeof node === "string") {
        inner = document.createElement(/\.html?(\?|#|$)/.test(node) ? "iframe" : "img");
        inner.setAttribute("src", node);
        inner.setAttribute("aria-hidden", "true");
        Object.assign(inner.style, {
          border: "0",
          width: `${content.width}px`,
          height: `${content.height}px`,
          maxWidth: "none",
        });
      } else if (node) inner = node;
      if (inner && !box) {
        const r = {
          x: inner.offsetLeft,
          y: inner.offsetTop,
          w: inner.offsetWidth,
          h: inner.offsetHeight,
        };
        box = r.w && r.h ? r : null;
      }
      if (!box) throw new Error(`stage: ${name} needs a box (or a crop, or a node with a size)`);
      Object.assign(el.style, {
        position: "absolute",
        left: "0px",
        top: "0px",
        width: `${box.w}px`,
        height: `${box.h}px`,
        overflow: "hidden",
        transformOrigin: "0 0",
        backfaceVisibility: o.backface ?? "hidden",
      });
      if (inner) {
        Object.assign(inner.style, {
          position: "absolute",
          left: `${-(crop?.x ?? 0)}px`,
          top: `${-(crop?.y ?? 0)}px`,
        });
        el.appendChild(inner);
      }
      host.appendChild(el);
    }
    if (!box) throw new Error(`stage: ${name} needs a box (or a crop)`);
    /** @type {HTMLElement | null} */
    let light = null;
    if (el && !inPlace && (o.sheen ?? 0) > 0) {
      light = document.createElement("div");
      Object.assign(light.style, {
        position: "absolute",
        inset: "0",
        pointerEvents: "none",
        zIndex: "1",
      });
      el.appendChild(light);
    }
    const tracks = poseTracks();
    const rest = { ...REST, ...(o.rest ?? {}) };
    const handle = {
      name,
      box,
      /** the slab's element (null on a stage without `el`): put what it shows in it */
      el,
      origin: o.origin ?? /** @type {[number, number]} */ ([0.5, 0.5]),
      backface: o.backface ?? "hidden",
      blur: o.blur ?? 0,
      sheen: o.sheen ?? 0,
      shadow: o.shadow ?? 0,
      /** @internal */
      light,
      inPlace,
      /** move to a pose — only the fields given; the rest keep moving as they were
       * @param {Partial<Pose>} to @param {When} when */
      to(to, when) {
        note(ask(tracks, to, when, 0, `${name} to`));
        return handle;
      },
      /** a cut: from `at` on (-Infinity: from the start), these fields are this, with no move
       * @param {Partial<Pose>} to @param {number} at */
      set(to, at) {
        if (!(Number.isFinite(at) || at === Number.NEGATIVE_INFINITY))
          throw new Error(`stage: ${name} set needs a time (s, or -Infinity: from the start)`);
        note(ask(tracks, to, null, at, `${name} set`));
        return handle;
      },
      /** its own pose at t */
      /** @param {number} t @returns {Pose} */
      pose: (t) => poseOf(tracks, rest, t),
    };
    slabs.push(handle);
    return handle;
  };

  return {
    width: W,
    height: H,
    perspective: d,
    slab,
    /**
     * A slab made of an element where it already is — a picture, a video, a
     * player of frames, a part of the page: not moved into the stage, not
     * wrapped, its layout and its children untouched. Until it is asked to
     * move it is left exactly as it was; moved, it gets a transform (and an
     * opacity, a blur, a shadow when those are asked), nothing else — the
     * page's own visibility (`scenes`) still decides whether it shows.
     * Its place is where its layout puts it on the page (`box` to say
     * otherwise). A sheen is not drawn on an adopted element.
     * @param {HTMLElement} el
     * @param {Omit<SlabOpts, "crop" | "sheen">} [o]
     */
    adopt: (el, o = {}) => slab(el, { ...o, inPlace: true }),
    /** the whole stage turns about its pivot — a flat layout becoming a table
     * @param {{ rx?: number, ry?: number, rz?: number }} to @param {When} when */
    turn(to, when) {
      const { rx, ry, rz } = to;
      note(ask(world, { rx, ry, rz }, when, 0, "turn"));
    },
    /** the lens travels into the stage (px, + toward and past what is in
     *  front): a slab it nears grows, fades over the last quarter of the way
     *  and is gone; what was behind it comes up
     * @param {number} z @param {When} when */
    dolly(z, when) {
      note(ask(world, { z }, when, 0, "dolly"));
    },
    /** the stage's own turn and the lens's travel at t ({ rx, ry, rz, z }) */
    /** @param {number} t */
    world: (t) => {
      const w = poseOf(world, REST, t);
      return { rx: w.rx, ry: w.ry, rz: w.rz, z: w.z };
    },
    at,
    /** write every slab's state at t onto its element */
    /** @param {number} t */
    apply(t) {
      const all = at(t);
      all.forEach((s, i) => {
        const sl = /** @type {Slab} */ (slabs[i]);
        if (!sl.el) return;
        if (sl.inPlace) {
          // only what the stage changed: at rest and square on, the element's
          // own styles — its visibility (scenes'), its stacking — stay its own
          const st = sl.el.style;
          // a move settling into the hold ends a hair off: within 0.01 px
          // and 1e-5 of scale, it is back where it was
          const m = /^matrix\(([^)]*)\)$/.exec(s.style.transform);
          const still =
            !!m &&
            (m[1] ?? "")
              .split(",")
              .map(Number)
              .every((v, i) => Math.abs(v - (i === 0 || i === 3 ? 1 : 0)) < (i < 4 ? 1e-5 : 0.01));
          st.transform = still ? "" : s.style.transform;
          const gone = s.style.visibility === "hidden";
          st.opacity = gone ? "0" : s.style.opacity === "1" ? "" : s.style.opacity;
          st.filter = s.style.filter === "none" ? "" : s.style.filter;
          if (sl.shadow > 0) st.boxShadow = s.style.boxShadow === "none" ? "" : s.style.boxShadow;
          return;
        }
        Object.assign(sl.el.style, s.style);
        if (sl.light && s.sheen) {
          sl.light.style.background = s.sheen.background;
          sl.light.style.opacity = String(s.sheen.opacity);
        }
      });
      return all;
    },
    /**
     * What the stage would draw soft: a tilted slab bigger in the picture than
     * the frame, which Chrome draws at about the frame's area and stretches —
     * checked every 1/30 s from `from` to `to` (default: the span of every
     * move asked, plus a second).
     * @param {number} [from] @param {number} [to]
     */
    warnings(from, to) {
      const lo = Math.min(...spans.map((s) => s[0]));
      const hi = Math.max(...spans.map((s) => s[1]));
      const t0 = from ?? (Number.isFinite(lo) ? lo : 0);
      const t1 = to ?? (Number.isFinite(hi) ? hi + 1 : t0);
      /** @type {Map<string, [number, number]>} */
      const soft = new Map();
      /** @type {string[]} */
      const out = [];
      const flush = (/** @type {string} */ n) => {
        const r = soft.get(n);
        if (!r) return;
        out.push(
          `${n}: tilted and bigger than the frame ${r[0].toFixed(2)}–${r[1].toFixed(2)} s — Chrome draws it at about the frame's area and stretches it (soft); smaller, or square on before it grows`,
        );
        soft.delete(n);
      };
      for (let t = t0; t <= t1 + 1e-9; t += 1 / 30) {
        const all = at(t);
        for (const s of all) {
          const r = soft.get(s.name);
          if (s.soft) soft.set(s.name, r ? [r[0], t] : [t, t]);
          else flush(s.name);
        }
      }
      for (const n of [...soft.keys()]) flush(n);
      return out;
    },
  };
}

/**
 * Where an element's layout puts it on the page, with no transform of any
 * ancestor's counted: its offsets summed up to the page, its own size.
 * @param {HTMLElement} el
 * @returns {Box | null}
 */
function placeOf(el) {
  const w = el.offsetWidth;
  const h = el.offsetHeight;
  if (!(w > 0 && h > 0)) return null;
  let x = 0;
  let y = 0;
  /** @type {HTMLElement | null} */
  let e = el;
  while (e) {
    x += e.offsetLeft || 0;
    y += e.offsetTop || 0;
    e = /** @type {HTMLElement | null} */ (e.offsetParent);
  }
  return { x, y, w, h };
}

// --- moves made of moves ---------------------------------------------------------

/**
 * Slabs lift apart in depth — a screen coming apart into its parts — each
 * `gap` px nearer the lens than the one before (the first stays where it is),
 * `spread` pushing them out from their middle as they rise (a share of each
 * one's distance from it). Seen square on it reads as a slight swell; under a
 * stage `turn` or a tilt it reads as layers.
 * @param {Slab[]} list in order, back to front
 * @param {When & { gap?: number, spread?: number, every?: number }} when gap: px between layers
 *   (default 120: about a sixteenth of the lens's distance); spread: default 0; every: s between one
 *   slab leaving and the next (default 0)
 */
export function explode(list, when) {
  const { gap = 120, spread = 0, every = 0, ...w } = when;
  const mx = list.reduce((s, sl) => s + sl.box.x + sl.box.w / 2, 0) / Math.max(1, list.length);
  const my = list.reduce((s, sl) => s + sl.box.y + sl.box.h / 2, 0) / Math.max(1, list.length);
  list.forEach((sl, i) => {
    const cx = sl.box.x + sl.box.w / 2;
    const cy = sl.box.y + sl.box.h / 2;
    sl.to(
      { z: i * gap, ...(spread ? { x: (cx - mx) * spread, y: (cy - my) * spread } : {}) },
      shift(w, i * every),
    );
  });
}

/** Slabs back where their parts sat, square on (explode's undoing) */
/** @param {Slab[]} list @param {When & { every?: number }} when */
export function together(list, when) {
  const { every = 0, ...w } = when;
  list.forEach((sl, i) => {
    sl.to({ x: 0, y: 0, z: 0, rx: 0, ry: 0, rz: 0, scale: 1 }, shift(w, i * every));
  });
}

/**
 * Lowered onto the stage like a print: it starts nearer the lens — 1.25× its
 * size — and settles down with a 3 % bounce, its shadow (if it has one)
 * tightening from wide and soft to close and sharp (`skill film craft`,
 * Arrivals with weight). It is not seen until it drops. `tilt` given: it
 * falls from that angle and lands square.
 * @param {Slab} sl
 * @param {When & { from?: number, z?: number, tilt?: { rx?: number, ry?: number, rz?: number } }} when
 *   from: how far above its rest it starts (px; default 400, which reads as 1.25× under the default
 *   lens of 2000 px); z: where it comes to rest (default 0); default a spring of 2 Hz swinging 12 %
 *   of its fall past its rest (a 3 % bounce of its size)
 */
export function drop(sl, when) {
  const { from, z = 0, tilt, ...w } = when;
  const h = from ?? 0.2 * DEFAULT_PERSPECTIVE;
  /** @type {When} */
  const motion = w.ease || w.spring ? w : { spring: { freq: 2, overshoot: 0.12 }, ...w };
  const tm = timing(motion, `${sl.name} drop`);
  // unseen until it drops
  sl.set({ opacity: 0 }, Number.NEGATIVE_INFINITY);
  sl.set({ z: z + h, opacity: 0, ...(tilt ?? {}) }, tm.t0);
  sl.to({ opacity: 1 }, { start: tm.t0, dur: Math.min(0.12, tm.dur), ease: (p) => p });
  /** @type {Partial<Pose>} */
  const square = {};
  for (const k of /** @type {const} */ (["rx", "ry", "rz"])) if (tilt?.[k] != null) square[k] = 0;
  sl.to({ z, ...square }, { ...motion, start: tm.t0, arrive: undefined });
}

/**
 * A pile: slabs dropped one after another onto the same place, each resting
 * `gap` px above the last — panels landing on a stack. Under a stage `turn`
 * the pile has thickness.
 * @param {Slab[]} list first dropped first
 * @param {When & { every?: number, gap?: number, from?: number, rz?: number[] }} when every: s between
 *   drops (default 0.16 — labels in those films stacked one every ≈0.16 s); gap: px each rests above
 *   the last (default 6); rz: the angle each lies at (default none)
 */
export function stack(list, when) {
  const { every = 0.16, gap = 6, rz, ...w } = when;
  list.forEach((sl, i) => {
    const wi = shift(w, i * every);
    drop(sl, { ...wi, z: i * gap });
    const r = rz?.[i];
    if (r != null)
      sl.set(
        { rz: r },
        timing(
          wi.ease || wi.spring ? wi : { spring: { freq: 2, overshoot: 0.12 }, ...wi },
          `${sl.name} stack`,
        ).t0,
      );
  });
}

/**
 * A card turns over: `front` turns away about its vertical (or horizontal)
 * axis while `back` — the next scene, the other side — turns in from behind,
 * each hidden while it faces away. `lift` px toward the lens at the middle of
 * the turn (default 0).
 * @param {Slab} front
 * @param {Slab} back
 * @param {When & { axis?: "x" | "y", dir?: 1 | -1, lift?: number }} when
 */
export function flip(front, back, when) {
  const { axis = "y", dir = 1, lift = 0, ...w } = when;
  const k = axis === "y" ? "ry" : "rx";
  const tm = timing(w, `${front.name} flip`);
  back.set({ [k]: -180 * dir }, tm.t0);
  front.to({ [k]: 180 * dir }, w);
  back.to({ [k]: 0 }, w);
  if (lift) {
    // up over the first half of the turn, down over the second
    const half = {
      dur: tm.dur / 2,
      ease: (/** @type {number} */ p) => Math.sin((p * Math.PI) / 2),
    };
    const down = {
      dur: tm.dur / 2,
      ease: (/** @type {number} */ p) => 1 - Math.cos((p * Math.PI) / 2),
    };
    for (const sl of [front, back]) {
      sl.to({ z: lift }, { ...half, start: tm.t0 });
      sl.to({ z: 0 }, { ...down, start: tm.t0 + tm.dur / 2 });
    }
  }
}

/** a When moved later by s */
/** @param {When} w @param {number} s @returns {When} */
function shift(w, s) {
  if (!s) return w;
  return w.arrive != null ? { ...w, arrive: w.arrive + s } : { ...w, start: (w.start ?? 0) + s };
}

/** the stage's matrices (CSS's, column-major), for kit/world.js: the same
 *  poses drawn in WebGL */
export const matrices = {
  identity,
  mul,
  translate,
  scale,
  rotateX,
  rotateY,
  rotateZ,
  perspective,
  apply,
};
