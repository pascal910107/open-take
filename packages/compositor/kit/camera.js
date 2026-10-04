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
//   const cam = camera({ content: { width: 1920, height: 1080 } });
//   cam.frame(box, { arrive: 12 });          // framed by 12 s
//   cam.frame(other, { start: 15, dur: 0.3, ease: (p) => p * p });
//   cam.cut(third, 20);                      // a cut: no move
//   layer.style.transformOrigin = "0 0";
//   layer.style.transform = cam.transform(t); // in __render(t)

/** @typedef {{ x: number, y: number, width: number, height: number }} Box  a region of the content, in its CSS px */
/** @typedef {{ cx: number, cy: number, w: number }} View  what the picture shows: its centre and width, in content px */
/**
 * @typedef {object} When  when a move happens — one of `arrive` or `start`
 * @property {number} [arrive] the move lands here (s)
 * @property {number} [start] the move leaves here (s)
 * @property {number} [dur] how long it takes (s); default 0.73 in, 1.34 out
 * @property {(p: number) => number} [ease] progress 0..1 over the move; default: settle into the hold
 * @property {number} [fill] the share of the picture a framed box fills (default 0.6)
 * @property {"contain" | "width"} [fit] fit the box whole (default), or its width only — a tall box is then framed from its top
 */
/**
 * @typedef {object} Move
 * @property {"move" | "cut"} kind
 * @property {number} t0
 * @property {number} t1
 * @property {View} to
 * @property {((p: number) => number) | null} ease
 * @property {string} label
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

/**
 * @param {object} opts
 * @param {{ width: number, height: number }} opts.content the layer the camera looks at, in CSS px
 * @param {{ width: number, height: number }} [opts.view] the film's picture (default: the content's size)
 * @param {number} [opts.zoomIn] default duration of a move that closes in (s)
 * @param {number} [opts.zoomOut] default duration of a move that pulls out (s)
 * @param {number} [opts.settle] the share of a move left to settle into the hold
 */
export function camera({ content, view = content, zoomIn = 0.73, zoomOut = 1.34, settle = 0.04 }) {
  const aspect = view.width / view.height;
  const decay = settleDecay(settle);
  /** @type {{ kind: "move" | "cut", at: number, anchor: "arrive" | "start", target: View, dur?: number, ease?: (p: number) => number, label: string }[]} */
  const asked = [];
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
    const wanted = viewOf(target, o);
    const kept = inside(wanted);
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
    });
    moves = null;
  };

  /** the moves in time order, each with its start and end resolved */
  const plan = () => {
    if (moves) return moves;
    const order = [...asked].sort((a, b) => a.at - b.at);
    /** @type {Move[]} */
    const out = [];
    let leaving = all(); // the view the camera was last asked for
    for (const a of order) {
      if (a.kind === "cut") {
        out.push({ kind: "cut", t0: a.at, t1: a.at, to: a.target, ease: null, label: a.label });
      } else {
        const dur = a.dur ?? (a.target.w > leaving.w + 1e-9 ? zoomOut : zoomIn);
        const t0 = a.anchor === "arrive" ? a.at - dur : a.at;
        out.push({
          kind: "move",
          t0,
          t1: t0 + Math.max(dur, 1e-6),
          to: a.target,
          ease: a.ease ?? null,
          label: a.label,
        });
      }
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

  /** a curve of your own may overshoot: say where the view then leaves the content */
  /** @param {Move[]} ms */
  const overshoot = (ms) => {
    for (const m of ms) {
      if (m.kind !== "move" || !m.ease) continue;
      for (let k = 0; k <= 60; k++) {
        const v = at(m.t0 + ((m.t1 - m.t0) * k) / 60);
        const h = v.w / aspect;
        const out =
          (v.w <= content.width &&
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

  /** @param {number} t */
  const place = (t) => {
    const v = at(t);
    return {
      s: v.scale,
      tx: view.width / 2 - v.cx * v.scale,
      ty: view.height / 2 - v.cy * v.scale,
    };
  };

  return {
    /** the layer's size and the picture's, as given */
    content,
    view,
    /** frame a box (or a view) — `{ arrive }` or `{ start }`, optionally `dur`, `ease`, `fill`, `fit` */
    /** @param {Box | View} target @param {When} when */
    frame: (target, when) => ask("move", target, when, "frame"),
    /** pull out to the whole content */
    /** @param {When} when */
    rest: (when) => ask("move", all(), when, "rest"),
    /** a cut: from `at` on the camera shows `target`, with no move */
    /** @param {Box | View} target @param {number} at @param {When} [o] */
    cut: (target, at, o = {}) => ask("cut", target, { ...o, start: at }, "cut"),
    /** the view at t ({ cx, cy, w, scale }) — for a camera of your own */
    at,
    /** the CSS transform for the layer at t (give the layer transform-origin 0 0) */
    /** @param {number} t */
    transform: (t) => {
      const p = place(t);
      return `translate(${p.tx}px, ${p.ty}px) scale(${p.s})`;
    },
    /** a point of the content → where it is in the picture at t */
    /** @param {number} x @param {number} y @param {number} t */
    toView: (x, y, t) => {
      const p = place(t);
      return [p.tx + x * p.s, p.ty + y * p.s];
    },
    /** a point of the picture → the content under it at t */
    /** @param {number} x @param {number} y @param {number} t */
    toContent: (x, y, t) => {
      const p = place(t);
      return [(x - p.tx) / p.s, (y - p.ty) / p.s];
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
