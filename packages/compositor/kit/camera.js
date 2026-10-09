// @ts-check
// A camera for a film page — open-take's film kit. You say when to see what;
// the camera works out how to get there. The motion is open-take's take
// camera, the one tuned by eye on recordings:
//
//   - the VIEW moves (its centre and its width together), so whatever is
//     framed heads for its place in a straight line and never swings the
//     wrong way first — moving the centre and the zoom separately does;
//   - a view is kept inside the content once, when you ask for it, never
//     mid-move (a clamp applied every frame bends the path: the camera stops
//     short, then lurches back);
//   - a move covers 96 % of the way in its time and settles the rest into the
//     hold, and the next move starts from wherever the camera really is — no
//     stop, no jolt.
//
// The defaults are measured (in 0.73 s, out 1.34 s; what is framed fills 60 %
// of the picture). Every move can set its own duration and curve — a fast
// push, a whip, a slow drift are yours to choose. One flat layer, seen through
// a 2D camera: for 3D, read at(t) and project it yourself.
//
// More is there when you ask for it, all of it off until you do: a camera
// that gets there early (`lead`), a hand holding it (`handheld`), a jolt on
// an impact (`shake`), layers that move at their own rate (`depth`), a zoom
// that runs at an even pace over big scale changes (`zoom: "log"`), and a view
// left free to go past the content (`keepInside: false`).
//
//   const cam = camera({ content: { width: 1920, height: 1080 } });
//   cam.frame(box, { arrive: 12 });          // framed by 12 s
//   cam.frame(other, { start: 15, dur: 0.3, ease: (p) => p * p });
//   cam.cut(third, 20);                      // a cut: no move
//   layer.style.transformOrigin = "0 0";
//   layer.style.transform = cam.transform(t); // in __render(t)

/** @typedef {{ x: number, y: number, width: number, height: number }} Box  a region of the content, in its CSS px */
/** @typedef {{ cx: number, cy: number, w: number }} View  what the picture shows: its centre and width, in content px */
/** @typedef {{ boxAt: (t: number) => Box, name?: string, used?: (use: string, t: number) => unknown }} PartLike  a part of the product (kit/media.js product()): framed where it is when the move lands */
/**
 * @typedef {object} When  when a move happens — one of `arrive` or `start`
 * @property {number} [arrive] the move lands here (s)
 * @property {number} [start] the move leaves here (s)
 * @property {number} [dur] how long it takes (s); default 0.73 in, 1.34 out
 * @property {(p: number) => number} [ease] progress 0..1 over the move; default: settle into the hold
 * @property {number} [fill] the share of the picture a framed box fills (default 0.6)
 * @property {"contain" | "width"} [fit] fit the box whole (default), or its width only — a tall box is then framed from its top
 * @property {number} [lead] this move leaves and lands this much earlier (s); default: the camera's `lead`
 * @property {boolean} [keepInside] keep this view inside the content; default: the camera's `keepInside`
 * @property {"linear" | "log"} [zoom] how this move's width changes; default: the camera's `zoom`
 */
/**
 * @typedef {object} Handheld  a hand on the camera: a slow, smooth wander that never repeats
 * @property {number} [amp] how far it wanders, in picture px (default 3)
 * @property {number} [rot] how far it tilts, in degrees (default 0)
 * @property {number} [period] about how long between turns (s, default 2.5)
 * @property {number} [seed] another seed, another hand (default 1)
 */
/**
 * @typedef {object} Shake  a jolt that dies away
 * @property {number} [amp] how far it throws the picture at first, in px (default 10)
 * @property {number} [rot] how far it tilts at first, in degrees (default 0)
 * @property {number} [dur] how long until it is still (s, default 0.45)
 * @property {number} [freq] how fast it rattles (about this many turns a second, default 16)
 * @property {number} [seed] another seed, another jolt (default: one per shake)
 */
/** @typedef {{ x: number, y: number, rot: number }} Jitter  what the hand and the shakes add at t: picture px, degrees */
/**
 * @typedef {object} Move
 * @property {"move" | "cut"} kind
 * @property {number} t0
 * @property {number} t1
 * @property {View} to
 * @property {((p: number) => number) | null} ease
 * @property {string} label
 * @property {true} [free] left free to go past the content
 * @property {true} [log] its width changes at an even pace in log space
 */

/** what is left of a move at progress u (0 at its start, 0.04 at its end, still
 *  decaying after): the step response of an overdamped spring (ζ 1.2), the
 *  shape frame-tracked off a reference recording's camera; ω0 is solved so the
 *  residual at u = 1 equals `frac`. Same function as the take camera's. */
export function settleDecay(frac = 0.04) {
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

/** smootherstep, 6p⁵ − 15p⁴ + 10p³: a symmetric ease for moves that should end exactly on time */
/** @param {number} p */
export const smooth = (p) => {
  const x = Math.max(0, Math.min(1, p));
  return x * x * x * (x * (x * 6 - 15) + 10);
};

/** @param {number} p */
export const linear = (p) => Math.max(0, Math.min(1, p));

/** a seeded number in -1..1 for each whole i — the same i and seed, the same number */
/** @param {number} i @param {number} seed */
const lattice = (i, seed) => {
  let h = Math.imul(i | 0, 0x27d4eb2d) ^ Math.imul(seed | 0, 0x165667b1);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  h ^= h >>> 16;
  return (h >>> 0) / 0x7fffffff - 1;
};

/** smooth seeded noise along one axis, about -1..1: zero on every whole x,
 *  with a seeded slope there, eased between (gradient noise). It starts from
 *  rest at x = 0, so a jolt never jumps on its first frame. */
/** @param {number} x @param {number} seed */
export const noise = (x, seed = 1) => {
  const i = Math.floor(x);
  const f = x - i;
  const u = f * f * f * (f * (f * 6 - 15) + 10);
  const a = lattice(i, seed) * f;
  const b = lattice(i + 1, seed) * (f - 1);
  return 2 * (a + (b - a) * u);
};

/**
 * @param {object} opts
 * @param {{ width: number, height: number }} opts.content the layer the camera looks at, in CSS px
 * @param {{ width: number, height: number }} [opts.view] the film's picture (default: the content's size)
 * @param {number} [opts.zoomIn] default duration of a move that closes in (s)
 * @param {number} [opts.zoomOut] default duration of a move that pulls out (s)
 * @param {number} [opts.settle] the share of a move left to settle into the hold
 * @param {number} [opts.lead] every move leaves and lands this much earlier (s, default 0): the camera is there before what it waits for
 * @param {boolean} [opts.keepInside] keep each view inside the content (default true); false lets the camera look past its edge
 * @param {"linear" | "log"} [opts.zoom] how a move's width changes: evenly in px (default), or at an even pace in log space, which reads better when the scale changes a lot
 * @param {Handheld} [opts.handheld] a hand on the camera (default: none)
 */
export function camera({
  content,
  view = content,
  zoomIn = 0.73,
  zoomOut = 1.34,
  settle = 0.04,
  lead = 0,
  keepInside = true,
  zoom = "linear",
  handheld,
}) {
  const aspect = view.width / view.height;
  const decay = settleDecay(settle);
  if (!Number.isFinite(lead)) throw new Error("camera: lead must be a number of seconds");
  if (zoom !== "linear" && zoom !== "log")
    throw new Error(`camera: zoom is "linear" or "log", not ${JSON.stringify(zoom)}`);
  if (handheld && !((handheld.period ?? 2.5) > 0))
    throw new Error("camera: handheld period must be above 0 s");
  /** @type {{ kind: "move" | "cut", at: number, anchor: "arrive" | "start", target: View, dur?: number, ease?: (p: number) => number, label: string, lead: number, free: boolean, log: boolean }[]} */
  const asked = [];
  /** @type {{ at: number, amp: number, rot: number, dur: number, freq: number, seed: number }[]} */
  const shakes = [];
  /** @type {Move[] | null} */
  let moves = null;
  /** @type {string[]} */
  const warnings = []; // from asking: views that had to be kept inside
  /** @type {string[]} */
  let overshoots = []; // from planning: curves that leave the content

  /** the whole content, centred */
  const all = () =>
    /** @type {View} */ ({
      cx: content.width / 2,
      cy: content.height / 2,
      w: Math.max(content.width, content.height * aspect),
    });

  /** a view kept inside the content: on an axis the view covers, its centre
   *  stops at the content's edge; on one it does not, it is centred — the
   *  take camera's clampCenter */
  /** @param {View} v */
  const inside = (v) => {
    const h = v.w / aspect;
    return {
      cx:
        v.w <= content.width
          ? Math.min(Math.max(v.cx, v.w / 2), content.width - v.w / 2)
          : content.width / 2,
      cy:
        h <= content.height
          ? Math.min(Math.max(v.cy, h / 2), content.height - h / 2)
          : content.height / 2,
      w: v.w,
    };
  };

  /** @param {Box | View} b @param {When} [o] */
  const viewOf = (b, o = {}) => {
    if ("w" in b) return b;
    const fill = o.fill ?? 0.6;
    if (o.fit === "width") {
      const w = b.width / fill;
      const tall = b.height > w / aspect;
      const pad = (w - b.width) / 2;
      return {
        cx: b.x + b.width / 2,
        cy: tall ? b.y - pad + w / aspect / 2 : b.y + b.height / 2,
        w,
      };
    }
    return {
      cx: b.x + b.width / 2,
      cy: b.y + b.height / 2,
      w: Math.max(b.width, b.height * aspect) / fill,
    };
  };

  /** @param {"move" | "cut"} kind @param {Box | View} target @param {When} o @param {string} label */
  const ask = (kind, target, o, label) => {
    const at = o.arrive ?? o.start;
    if (at == null || !Number.isFinite(at))
      throw new Error(`camera: ${label} needs { arrive } or { start }`);
    if (o.arrive != null && o.start != null)
      throw new Error(`camera: ${label} takes { arrive } or { start }, not both`);
    const moveLead = o.lead ?? lead;
    if (!Number.isFinite(moveLead))
      throw new Error(`camera: ${label} at ${at}s: lead must be a number`);
    const moveZoom = o.zoom ?? zoom;
    if (moveZoom !== "linear" && moveZoom !== "log")
      throw new Error(`camera: ${label} at ${at}s: zoom is "linear" or "log"`);
    const free = !(o.keepInside ?? keepInside);
    const wanted = viewOf(target, o);
    const kept = free ? wanted : inside(wanted);
    const off = Math.hypot(kept.cx - wanted.cx, kept.cy - wanted.cy);
    if (off > 1)
      warnings.push(
        `${label} at ${at}s: the content ends there — the view stops ${Math.round(off)} px short of centring it`,
      );
    asked.push({
      kind,
      at,
      anchor: o.arrive != null ? "arrive" : "start",
      target: kept,
      dur: o.dur,
      ease: o.ease,
      label: `${label} at ${at}s`,
      lead: moveLead,
      free,
      log: moveZoom === "log",
    });
    moves = null;
  };

  /** a part of the product is framed where it is when the move lands (a
   *  cut: where it is at the cut); a box or a view as it is
   * @param {"move" | "cut"} kind @param {Box | View | PartLike} target @param {When} o @param {string} label */
  const askFor = (kind, target, o, label) => {
    if (!("boxAt" in target) || typeof target.boxAt !== "function")
      return ask(kind, /** @type {Box | View} */ (target), o, label);
    const named = `${label} ${target.name ?? "part"}`;
    const part = target;
    if (kind === "cut" || o.arrive != null || o.dur != null || o.start == null) {
      const lands =
        kind === "cut"
          ? (o.start ?? Number.NaN)
          : (o.arrive ?? (o.start ?? Number.NaN) + (o.dur ?? zoomIn)) - (o.lead ?? lead);
      if (!Number.isFinite(lands)) return ask(kind, { cx: 0, cy: 0, w: 1 }, o, named);
      part.used?.(kind === "cut" ? "cut" : label, lands);
      return ask(kind, part.boxAt(lands), o, named);
    }
    // a move given by its start alone lasts as plan() times it — longer when
    // it pulls out wider than the view asked for before it — so the part is
    // read where that lands, and the move keeps that duration
    const start = o.start;
    const moveLead = o.lead ?? lead;
    let leaving = all();
    let latest = Number.NEGATIVE_INFINITY;
    for (const a of asked)
      if (a.at <= start && a.at >= latest) {
        latest = a.at;
        leaving = a.target;
      }
    let dur = zoomIn;
    if (viewOf(part.boxAt(start + zoomIn - moveLead), o).w > leaving.w + 1e-9) dur = zoomOut;
    part.used?.(label, start + dur - moveLead);
    return ask(kind, part.boxAt(start + dur - moveLead), { ...o, dur }, named);
  };

  /** the moves in time order, each with its start and end resolved */
  const plan = () => {
    if (moves) return moves;
    const order = [...asked].sort((a, b) => a.at - b.at);
    /** @type {Move[]} */
    const out = [];
    let leaving = all(); // the view the camera was last asked for
    for (const a of order) {
      /** @type {Move} */
      let m;
      if (a.kind === "cut") {
        // a cut is where you put it: a lead moves only the moves
        m = { kind: "cut", t0: a.at, t1: a.at, to: a.target, ease: null, label: a.label };
      } else {
        const dur = a.dur ?? (a.target.w > leaving.w + 1e-9 ? zoomOut : zoomIn);
        let t0 = a.anchor === "arrive" ? a.at - dur : a.at;
        if (a.lead) t0 -= a.lead;
        m = {
          kind: "move",
          t0,
          t1: t0 + Math.max(dur, 1e-6),
          to: a.target,
          ease: a.ease ?? null,
          label: a.label,
        };
        if (a.log) m.log = true;
      }
      if (a.free) m.free = true;
      out.push(m);
      leaving = a.target;
    }
    // at one instant a cut comes first and a move leaves from it; two cuts or
    // two moves at one instant would be a guess, so they are refused
    out.sort((a, b) => a.t0 - b.t0 || (a.kind === b.kind ? 0 : a.kind === "cut" ? -1 : 1));
    for (let i = 1; i < out.length; i++) {
      const a = out[i - 1];
      const b = out[i];
      if (a && b && Math.abs(a.t0 - b.t0) < 1e-9 && a.kind === b.kind)
        throw new Error(
          `camera: ${a.label} and ${b.label} begin at the same instant — which one wins is not yours to guess`,
        );
    }
    moves = out;
    overshoots = [];
    overshoot(out);
    return out;
  };

  /** where the camera is at t: each move starts from wherever the camera is
   *  when it begins, and runs (settling) until the next one does */
  /** @param {number} t */
  const at = (t) => {
    const ms = plan();
    let from = all();
    for (let i = 0; i < ms.length; i++) {
      const m = /** @type {Move} */ (ms[i]);
      if (t < m.t0) break;
      const next = ms[i + 1];
      const until = next ? Math.min(t, next.t0) : t;
      if (m.kind === "cut") from = m.to;
      else {
        const u = (until - m.t0) / (m.t1 - m.t0);
        const left = m.ease ? 1 - m.ease(Math.min(1, u)) : decay(u);
        if (m.log) {
          // the width at an even pace in log space; the centre keeps the
          // point that stays put on screen where it is, so everything still
          // heads for its place in a straight line
          const r = from.w / m.to.w;
          const w = m.to.w * r ** left;
          const k = Math.abs(Math.log(r)) < 1e-9 ? left : (w - m.to.w) / (from.w - m.to.w);
          from = {
            cx: m.to.cx + (from.cx - m.to.cx) * k,
            cy: m.to.cy + (from.cy - m.to.cy) * k,
            w,
          };
        } else
          from = {
            cx: m.to.cx + (from.cx - m.to.cx) * left,
            cy: m.to.cy + (from.cy - m.to.cy) * left,
            w: Math.max(m.to.w + (from.w - m.to.w) * left, Math.min(from.w, m.to.w) * 0.5),
          };
      }
      if (!next || t < next.t0) break;
    }
    return { ...from, scale: view.width / from.w };
  };

  /** how far a view passes the content's edge on an axis it fits (0: inside) */
  /** @param {View} v */
  const past = (v) => {
    const h = v.w / aspect;
    return Math.max(
      0,
      v.w <= content.width ? Math.max(v.w / 2 - v.cx, v.cx + v.w / 2 - content.width) : 0,
      h <= content.height ? Math.max(h / 2 - v.cy, v.cy + h / 2 - content.height) : 0,
    );
  };

  /** a curve of your own may overshoot: say where the view then leaves the content */
  /** @param {Move[]} ms */
  const overshoot = (ms) => {
    const anyFree = ms.some((m) => m.free);
    for (const m of ms) {
      if (m.kind !== "move" || !m.ease || m.free) continue;
      // a move that leaves from a view left past the edge is past it at first:
      // that is not the curve's doing, only going further out is
      const from = anyFree ? past(at(m.t0)) : 0;
      for (let k = 0; k <= 60; k++) {
        const v = at(m.t0 + ((m.t1 - m.t0) * k) / 60);
        const h = v.w / aspect;
        const out = anyFree
          ? past(v) > from + 0.5
          : (v.w <= content.width &&
              (v.cx - v.w / 2 < -0.5 || v.cx + v.w / 2 > content.width + 0.5)) ||
            (h <= content.height && (v.cy - h / 2 < -0.5 || v.cy + h / 2 > content.height + 0.5));
        if (out) {
          overshoots.push(
            `${m.label}: its curve overshoots — the view passes the content's edge mid-move`,
          );
          break;
        }
      }
    }
  };

  /** what the hand and the shakes add at t, in picture px and degrees */
  /** @param {number} t @returns {Jitter} */
  const jitter = (t) => {
    let x = 0;
    let y = 0;
    let rot = 0;
    if (handheld) {
      const { amp = 3, rot: tilt = 0, period = 2.5, seed = 1 } = handheld;
      const p = t / period;
      // two octaves, the second faint: a hand drifts and corrects; each axis
      // is shifted off the others so they never rest at one instant together
      /** @param {number} k */
      const wander = (k) =>
        (noise(p + 0.37 * k, seed * 7 + k) + 0.35 * noise(p * 2.13 + 17.5, seed * 7 + k + 3)) /
        1.35;
      x += amp * wander(0);
      y += amp * wander(1);
      rot += tilt * wander(2);
    }
    for (const s of shakes) {
      const tau = t - s.at;
      if (tau <= 0 || tau >= s.dur) continue;
      // a rattle that starts from rest and reaches about `amp` on its first
      // swing, then dies away to nothing at `dur`; each axis swings at its
      // own seeded rate and drifts off a clean sine, so no two read alike
      const env = (1 - tau / s.dur) ** 2;
      const p = tau * s.freq;
      /** @param {number} k @param {number} rate */
      const swing = (k, rate) =>
        Math.sin(
          2 * Math.PI * p * rate * (1 + 0.12 * lattice(k, s.seed)) +
            1.2 * noise(p * 0.5, s.seed * 5 + k),
        );
      x += s.amp * env * swing(0, 1);
      y += s.amp * env * (0.6 + 0.3 * lattice(9, s.seed)) * swing(1, 1.31);
      rot += s.rot * env * swing(2, 0.83);
    }
    return { x, y, rot };
  };
  const jitters = () => !!handheld || shakes.length > 0;

  /** where the layer goes at t; `k` is its depth factor (1: the content's own plane) */
  /** @param {number} t @param {number} [k] */
  const place = (t, k = 1) => {
    const v = at(t);
    let p;
    if (k === 1)
      p = {
        s: v.scale,
        tx: view.width / 2 - v.cx * v.scale,
        ty: view.height / 2 - v.cy * v.scale,
        r: 0,
      };
    else {
      // a layer at factor k sees the move k times over from the whole
      // content: its centre goes k of the way, its scale k of the way in log
      const r0 = all();
      const cx = r0.cx + (v.cx - r0.cx) * k;
      const cy = r0.cy + (v.cy - r0.cy) * k;
      const s = (view.width / r0.w) * (r0.w / v.w) ** k;
      p = { s, tx: view.width / 2 - cx * s, ty: view.height / 2 - cy * s, r: 0 };
    }
    if (jitters()) {
      const j = jitter(t);
      p.tx += j.x * k;
      p.ty += j.y * k;
      p.r = j.rot * k;
    }
    return p;
  };

  /** the transform's own point mapping: content → picture, and back */
  /** @param {{ s: number, tx: number, ty: number, r: number }} p */
  const css = (p) => {
    if (!p.r) return `translate(${p.tx}px, ${p.ty}px) scale(${p.s})`;
    const hx = view.width / 2;
    const hy = view.height / 2;
    return `translate(${hx}px, ${hy}px) rotate(${p.r}deg) translate(${p.tx - hx}px, ${p.ty - hy}px) scale(${p.s})`;
  };
  /** @param {{ s: number, tx: number, ty: number, r: number }} p @param {number} x @param {number} y */
  const project = (p, x, y) => {
    const qx = p.tx + x * p.s;
    const qy = p.ty + y * p.s;
    if (!p.r) return [qx, qy];
    const a = (p.r * Math.PI) / 180;
    const hx = view.width / 2;
    const hy = view.height / 2;
    const c = Math.cos(a);
    const n = Math.sin(a);
    return [hx + (qx - hx) * c - (qy - hy) * n, hy + (qx - hx) * n + (qy - hy) * c];
  };
  /** @param {{ s: number, tx: number, ty: number, r: number }} p @param {number} x @param {number} y */
  const unproject = (p, x, y) => {
    let qx = x;
    let qy = y;
    if (p.r) {
      const a = (-p.r * Math.PI) / 180;
      const hx = view.width / 2;
      const hy = view.height / 2;
      const c = Math.cos(a);
      const n = Math.sin(a);
      qx = hx + (x - hx) * c - (y - hy) * n;
      qy = hy + (x - hx) * n + (y - hy) * c;
    }
    return [(qx - p.tx) / p.s, (qy - p.ty) / p.s];
  };

  return {
    /** the layer's size and the picture's, as given */
    content,
    view,
    /** frame a box, a view or a part of the product (where it is when the
     *  move lands) — `{ arrive }` or `{ start }`, optionally `dur`, `ease`, `fill`, `fit` */
    /** @param {Box | View | PartLike} target @param {When} when */
    frame: (target, when) => askFor("move", target, when, "frame"),
    /** pull out to the whole content */
    /** @param {When} when */
    rest: (when) => ask("move", all(), when, "rest"),
    /** a cut: from `at` on the camera shows `target`, with no move */
    /** @param {Box | View | PartLike} target @param {number} at @param {When} [o] */
    cut: (target, at, o = {}) => askFor("cut", target, { ...o, start: at }, "cut"),
    /** a jolt from `at` on, dying away over `dur` — an impact, a slam, a beat
     *  that lands; shakes that overlap add up */
    /** @param {number} at @param {Shake} [o] */
    shake: (at, o = {}) => {
      if (!Number.isFinite(at)) throw new Error("camera: shake needs a time (s)");
      const { amp = 10, rot = 0, dur = 0.45, freq = 16, seed = shakes.length + 1 } = o;
      if (!(dur > 0)) throw new Error(`camera: shake at ${at}s: dur must be above 0`);
      shakes.push({ at, amp, rot, dur, freq, seed });
    },
    /** the view at t ({ cx, cy, w, scale }) — for a camera of your own; the
     *  hand and the shakes are not in it, they are in jitter(t) */
    at,
    /** what the hand and the shakes add at t ({ x, y, rot }: picture px, degrees about its centre) */
    jitter,
    /** the CSS transform for the layer at t (give the layer transform-origin 0 0) */
    /** @param {number} t */
    transform: (t) => css(place(t)),
    /** a point of the content → where it is in the picture at t */
    /** @param {number} x @param {number} y @param {number} t */
    toView: (x, y, t) => project(place(t), x, y),
    /** a point of the picture → the content under it at t */
    /** @param {number} x @param {number} y @param {number} t */
    toContent: (x, y, t) => unproject(place(t), x, y),
    /** a layer the size of the content at depth factor k: 1 moves with the
     *  content, 0 holds still, 0.3 is far behind, 1.5 passes in front — its
     *  centre goes k of the way of each move and its zoom k of the way (in
     *  log), the hand and shakes k times as far */
    /** @param {number} k */
    depth: (k) => {
      if (!Number.isFinite(k)) throw new Error("camera: depth needs a factor");
      return {
        /** @param {number} t */
        transform: (t) => css(place(t, k)),
        /** @param {number} x @param {number} y @param {number} t */
        toView: (x, y, t) => project(place(t, k), x, y),
        /** @param {number} x @param {number} y @param {number} t */
        toContent: (x, y, t) => unproject(place(t, k), x, y),
      };
    },
    /** the moves as planned (times resolved) */
    moves: () => plan(),
    /** what the camera could not do as asked, and why */
    warnings: () => {
      plan();
      return [...warnings, ...overshoots];
    },
  };
}
