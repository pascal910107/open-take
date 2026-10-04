// @ts-check
// A cursor for a film page — open-take's film kit. Say where it acts and
// when; it travels there the way open-take's take cursor does (tuned by eye
// on recordings):
//
//   - a steady speed on screen: 0.35 content widths a second at full view, so
//     a short hop takes its time and a long crossing does not crawl; each leg
//     lasts 0.30–0.85 s and lands exactly on the action;
//   - zoomed in, what the viewer sees is what counts: with the camera given,
//     a leg is timed by the distance it covers in the picture, not in the page;
//   - a smootherstep curve with a slight arc (5 % of the leg, at most 24 px).
//
// What it looks like is yours: at(t) says where it is, whether a button is
// held (a drag) and how far a click's ripple has spread (0..1 over 0.45 s).
// Every leg can set its own duration.
//
//   const cur = cursor({ camera: cam, start: { x: 960, y: 900 } });
//   cur.click(box, 12.4);                     // arrives at 12.4 s and clicks
//   cur.drag([from, to], 14.0, 15.2);         // button held from 14.0 to 15.2
//   const c = cur.at(t);                      // { x, y, sx, sy, down, ripple }

/** @typedef {{ x: number, y: number }} Pt  a point of the content, in its CSS px */
/** @typedef {{ x: number, y: number, width: number, height: number }} Box */
/**
 * @typedef {object} Leg
 * @property {number} t0
 * @property {number} t1
 * @property {Pt} a
 * @property {Pt} b
 * @property {Pt[]} [path] a drag's stroke
 * @property {(p: number) => number} [ease]
 */

/** smootherstep, 6p⁵ − 15p⁴ + 10p³ */
/** @param {number} p */
const smooth = (p) => {
  const x = Math.max(0, Math.min(1, p));
  return x * x * x * (x * (x * 6 - 15) + 10);
};

/** @param {Pt | Box} target */
const pointOf = (target) =>
  "width" in target ? { x: target.x + target.width / 2, y: target.y + target.height / 2 } : target;

/** a point a fraction u along a polyline, by length */
/** @param {Pt[]} path @param {number} u */
function along(path, u) {
  if (path.length === 1) return /** @type {Pt} */ (path[0]);
  let total = 0;
  const seg = [];
  for (let i = 0; i < path.length - 1; i++) {
    const a = /** @type {Pt} */ (path[i]);
    const b = /** @type {Pt} */ (path[i + 1]);
    const d = Math.hypot(b.x - a.x, b.y - a.y);
    seg.push(d);
    total += d;
  }
  if (total === 0) return /** @type {Pt} */ (path[0]);
  let left = u * total;
  for (let i = 0; i < seg.length; i++) {
    const d = /** @type {number} */ (seg[i]);
    if (left <= d || i === seg.length - 1) {
      const a = /** @type {Pt} */ (path[i]);
      const b = /** @type {Pt} */ (path[i + 1]);
      const f = d > 0 ? Math.min(1, left / d) : 0;
      return { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f };
    }
    left -= d;
  }
  return /** @type {Pt} */ (path[path.length - 1]);
}

/**
 * @param {object} opts
 * @param {{ content: { width: number, height: number }, view: { width: number, height: number }, at: (t: number) => { scale: number }, toView: (x: number, y: number, t: number) => number[] }} [opts.camera]
 *   the camera the cursor's layer is seen through (from kit/camera.js)
 * @param {{ width: number, height: number }} [opts.content] the layer's size, when there is no camera
 * @param {Pt} [opts.start] where it waits before its first move
 * @param {number} [opts.speed] content widths a second, at full view
 * @param {number} [opts.min] shortest leg (s)
 * @param {number} [opts.max] longest leg (s)
 * @param {number} [opts.ripple] how long a click's ripple lasts (s)
 */
export function cursor({
  camera,
  content,
  start,
  speed = 0.35,
  min = 0.3,
  max = 0.85,
  ripple = 0.45,
} = {}) {
  const size = camera?.content ?? content;
  if (!size) throw new Error("cursor: give it the camera, or the content's { width, height }");
  /** @type {{ kind: "click" | "move" | "drag" | "type", at: number, end: number, to: Pt, path?: Pt[], dur?: number, ease?: (p: number) => number }[]} */
  const asked = [];
  /** @type {{ legs: Leg[], clicks: number[], held: [number, number][] } | null} */
  let planned = null;

  // how much of the picture one content px buys at t, relative to full view:
  // integrating it over a leg gives the distance the viewer sees it cross
  const full = camera
    ? Math.min(camera.view.width / size.width, camera.view.height / size.height)
    : 1;
  /** @param {number} t */
  const frac = (t) => (camera ? full / Math.max(camera.at(t).scale, 1e-6) : 1);
  /** when a leg of `dist` content px must leave to land at `arrive` at the steady on-screen speed */
  /** @param {number} dist @param {number} arrive */
  const travel = (dist, arrive) => {
    const pxPerS = speed * size.width;
    let sec;
    if (!camera) sec = dist / pxPerS;
    else {
      // walk back from the arrival, 5 ms at a time, until the leg's worth of
      // full-view distance is covered (the take cursor inverts the same integral)
      const need = dist / pxPerS;
      const step = 0.005;
      let acc = 0;
      let t = arrive;
      while (acc < need && arrive - t < max + step) {
        const f = (frac(t) + frac(t - step)) / 2;
        acc += f * step;
        t -= step;
      }
      sec = arrive - t;
    }
    return Math.min(max, Math.max(min, sec));
  };

  const plan = () => {
    if (planned) return planned;
    const order = [...asked].sort((a, b) => a.at - b.at);
    /** @type {Leg[]} */
    const legs = [];
    /** @type {number[]} */
    const clicks = [];
    /** @type {[number, number][]} */
    const held = [];
    let cur = start ?? { x: size.width / 2, y: size.height / 2 };
    let free = 0; // when the last action ended: a move never departs before it
    for (const a of order) {
      const dist = Math.hypot(a.to.x - cur.x, a.to.y - cur.y);
      if (dist > 0.5) {
        const dur = a.dur ?? travel(dist, a.at);
        const prev = legs.length ? /** @type {Leg} */ (legs[legs.length - 1]).t1 : 0;
        const t0 = Math.min(a.at, Math.max(a.at - dur, prev, free, 0));
        legs.push({ t0, t1: a.at, a: cur, b: a.to });
      }
      cur = a.to;
      if (a.kind === "click") clicks.push(a.at);
      if (a.kind === "drag" && a.path) {
        legs.push({
          t0: a.at,
          t1: a.end,
          a: a.to,
          b: /** @type {Pt} */ (a.path[a.path.length - 1]),
          path: a.path,
          ease: a.ease ?? smooth,
        });
        held.push([a.at, a.end]);
        cur = /** @type {Pt} */ (a.path[a.path.length - 1]);
      }
      free = Math.max(free, a.end);
    }
    planned = { legs, clicks, held };
    return planned;
  };

  /** @param {number} t */
  const pos = (t) => {
    const { legs } = plan();
    for (const lg of legs) {
      if (t < lg.t0 || t > lg.t1) continue;
      const span = lg.t1 - lg.t0;
      const u = span > 0 ? Math.max(0, Math.min(1, (t - lg.t0) / span)) : 1;
      if (lg.path) return along(lg.path, (lg.ease ?? smooth)(u));
      const p = smooth(u);
      const dx = lg.b.x - lg.a.x;
      const dy = lg.b.y - lg.a.y;
      const L = Math.hypot(dx, dy) || 1;
      const arc = Math.min(0.05 * L, 24) * Math.sin(Math.PI * p);
      return { x: lg.a.x + dx * p + (-dy / L) * arc, y: lg.a.y + dy * p + (dx / L) * arc };
    }
    let at = start ?? { x: size.width / 2, y: size.height / 2 };
    for (const lg of legs)
      if (lg.t1 <= t) at = lg.path ? /** @type {Pt} */ (lg.path[lg.path.length - 1]) : lg.b;
    return at;
  };

  /** @param {"click" | "move" | "drag" | "type"} kind @param {Pt | Box} target @param {number} at @param {number} end @param {{ dur?: number, ease?: (p: number) => number }} o @param {Pt[]} [path] */
  const add = (kind, target, at, end, o, path) => {
    if (!Number.isFinite(at)) throw new Error(`cursor: ${kind} needs a time`);
    if (end < at) throw new Error(`cursor: ${kind} at ${at}s ends before it starts`);
    asked.push({ kind, at, end, to: pointOf(target), path, dur: o.dur, ease: o.ease });
    planned = null;
  };

  return {
    /** travel to the target and click at `at` (`dur`: this leg's travel time) */
    /** @param {Pt | Box} target @param {number} at @param {{ dur?: number }} [o] */
    click: (target, at, o = {}) => add("click", target, at, at, o),
    /** travel to the target, arriving at `at`, without clicking */
    /** @param {Pt | Box} target @param {number} at @param {{ dur?: number }} [o] */
    move: (target, at, o = {}) => add("move", target, at, at, o),
    /** travel to the field by `at` and stay there while typing until `end` */
    /** @param {Pt | Box} target @param {number} at @param {number} end @param {{ dur?: number }} [o] */
    type: (target, at, end, o = {}) => add("type", target, at, end, o),
    /** hold the button down along `path` from `at` to `end` (travelling to its start first) */
    /** @param {Pt[]} path @param {number} at @param {number} end @param {{ dur?: number, ease?: (p: number) => number }} [o] */
    drag: (path, at, end, o = {}) => {
      if (path.length < 2) throw new Error("cursor: a drag needs a path of at least two points");
      add("drag", /** @type {Pt} */ (path[0]), at, end, o, path);
    },
    /** where it is at t (content px, and picture px with a camera), whether a
     *  button is held, and a click's ripple (0..1, or null) */
    /** @param {number} t */
    at: (t) => {
      const { clicks, held } = plan();
      const p = pos(t);
      const v = camera ? camera.toView(p.x, p.y, t) : [p.x, p.y];
      let r = null;
      for (const c of clicks)
        if (t >= c && t - c <= ripple + 1e-9) r = Math.min(1, (t - c) / ripple);
      return {
        x: p.x,
        y: p.y,
        sx: /** @type {number} */ (v[0]),
        sy: /** @type {number} */ (v[1]),
        down: held.some(([a, b]) => t >= a && t <= b),
        ripple: r,
      };
    },
    /** the legs as planned */
    legs: () => plan().legs,
  };
}
