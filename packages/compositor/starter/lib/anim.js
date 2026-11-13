// anim.js — motion helpers for a film page. Plain functions of film time t (s):
// no state, no clock, nothing here knows any film. Gathered from what three
// films wrote for themselves in place of the kit's camera, cursor and motion
// files; the curves are the ones measured on the reference (reference/motion.md
// §3.1–3.3). Import what you use:
//
//   import { keys, ease, stamp, pointer } from "./lib/anim.js";
//
//   clamp(x, a, b)                  x held inside [a, b]
//   lerp(a, b, u)                   a → b at u
//   prog(t, a, b)                   0 → 1 as t goes from a to b
//   bezier(x1, y1, x2, y2)          a CSS cubic-bezier as an ease
//   ease.*                          linear, in2 … inOut4, out5, inOutSine, outExpo,
//                                   and the measured ones: push, count, pull, fling
//   keys(t, ks)                     a value through keyframes, each stretch with its own ease
//   track(ks)                       keys as a function of t
//   keyed(t, start, moves)          a value through moves that start at t and last dur (holds between)
//   stamp(t, t0, o)                 → { scale, opacity } — an object landing: 1.19× → 1 in one 24 fps frame, no bounce
//   spring(t, t0, o)                a damped spring 0 → 1
//   swing(t, t0, o)                 a damped swing amp → 0 (a dragged thing's tilt)
//   fling(t, t0, from, to, tau)     flung in: fastest at once, exponential arrival
//   rise(t, t0, o)                  a line rising into place
//   exit(t, t0, o)                  leaving by accelerating until gone
//   typeOn(t, t0, text, cps)        the part of a text typed so far
//   count(t, t0, dur, a, b, o)      a number counting a → b on the measured count curve
//   fmt(n, digits)                  1234.5 → "1,234.5"
//   pointer(t, marks, o)            a cursor going from target to target, in a slight arc
//   press(t, t0)                    a click's squash: 1 → 0.86 → 1 around t0
//   cam2d(c, w, h)                  a 2D camera { x, y, s } → its CSS transform and toScreen

/** @typedef {(u: number) => number} Ease  progress 0..1, eased */
/** @typedef {any} Value  a number, an array of numbers, or a flat object of numbers */
/** @typedef {[number, Value, (Ease | string)?]} Key  [t, value, the ease of the stretch that ends on it] */

/** x held inside [a, b]. `clamp(1.3)` → 1 @param {number} x @param {number} [a] @param {number} [b] */
export const clamp = (x, a = 0, b = 1) => Math.min(b, Math.max(a, x));

/** a → b at u (0..1, not clamped). `lerp(0, 100, 0.25)` → 25 @param {number} a @param {number} b @param {number} u */
export const lerp = (a, b, u) => a + (b - a) * u;

/** progress 0..1 of t through [a, b] (a time, not a duration). `prog(t, 2, 2.6)` @param {number} t @param {number} a @param {number} b */
export const prog = (t, a, b) => (b <= a ? (t >= b ? 1 : 0) : clamp((t - a) / (b - a)));

/**
 * CSS cubic-bezier(x1, y1, x2, y2) as an ease of progress 0..1 (Newton steps,
 * bisection when they stall). `const e = bezier(0.48, 0.08, 0.07, 1.02); e(0.3)`
 * @param {number} x1 @param {number} y1 @param {number} x2 @param {number} y2
 * @returns {Ease}
 */
export function bezier(x1, y1, x2, y2) {
  const cx = 3 * x1, bx = 3 * (x2 - x1) - cx, ax = 1 - cx - bx;
  const cy = 3 * y1, by = 3 * (y2 - y1) - cy, ay = 1 - cy - by;
  const X = (/** @type {number} */ s) => ((ax * s + bx) * s + cx) * s;
  const dX = (/** @type {number} */ s) => (3 * ax * s + 2 * bx) * s + cx;
  const Y = (/** @type {number} */ s) => ((ay * s + by) * s + cy) * s;
  return (x) => {
    if (x <= 0) return 0;
    if (x >= 1) return 1;
    let s = x;
    for (let i = 0; i < 8; i++) {
      const e = X(s) - x, d = dX(s);
      if (Math.abs(e) < 1e-6 || Math.abs(d) < 1e-6) break;
      s -= e / d;
    }
    let lo = 0, hi = 1;
    for (let i = 0; i < 20 && Math.abs(X(s) - x) > 1e-6; i++) {
      if (X(s) < x) lo = s; else hi = s;
      s = (lo + hi) / 2;
    }
    return Y(s);
  };
}

/**
 * Eases of progress 0..1. The last four were measured on the reference
 * (reference/motion.md §3.3), which used three families: speed peaking near
 * 30 % with a long settle (push, count), pure acceleration until gone (in3,
 * in4: exits), fastest at once with an exponential settle (fling).
 * Anywhere an ease is taken, its name works too. `keys(t, [[0, 0], [1, 1, "push"]])`
 * @satisfies {Record<string, (u: number, tau?: number) => number>}
 */
export const ease = {
  linear: (u) => u,
  in2: (u) => u * u,
  out2: (u) => 1 - (1 - u) ** 2,
  inOut2: (u) => (u < 0.5 ? 2 * u * u : 1 - (-2 * u + 2) ** 2 / 2),
  in3: (u) => u ** 3, // an exit: accelerates until it is gone (reference: 0.8–1.0 s, no fade)
  out3: (u) => 1 - (1 - u) ** 3,
  inOut3: (u) => (u < 0.5 ? 4 * u ** 3 : 1 - (-2 * u + 2) ** 3 / 2),
  in4: (u) => u ** 4,
  out4: (u) => 1 - (1 - u) ** 4,
  inOut4: (u) => (u < 0.5 ? 8 * u ** 4 : 1 - (-2 * u + 2) ** 4 / 2),
  out5: (u) => 1 - (1 - u) ** 5,
  inOutSine: (u) => -(Math.cos(Math.PI * u) - 1) / 2,
  outExpo: (u) => (u >= 1 ? 1 : 1 - 2 ** (-10 * u)),
  // a camera push-in: gentle start, speed peaks at ~30 %, long settle (1.25–1.33 s)
  push: bezier(0.48, 0.08, 0.07, 1.02),
  // a number counting up (0.875 s, peak at 30 %, the last 0.25 s climbs 1 %)
  count: bezier(0.32, 0.15, 0.39, 1.06),
  // a pull-back (2.7 s, close to out3)
  pull: bezier(0.25, 0.06, 0.1, 0.91),
  // flung in: fastest at once, exponential settle; tau as a share of the stretch
  // (the reference's cursor: tau 0.14 s over 0.625 s ≈ 0.22). `(u) => ease.fling(u, 0.18)`
  fling: (u, tau = 0.22) => (1 - Math.exp(-u / tau)) / (1 - Math.exp(-1 / tau)),
};
/** an ease, or one by its name @param {Ease | string | undefined} e @returns {Ease} */
const easeOf = (e) =>
  typeof e === "function" ? e : (/** @type {Record<string, Ease>} */ (ease)[e ?? "inOut3"] ?? ease.inOut3);

/** a mix of two values: numbers, arrays of numbers, or flat objects of numbers (a key `s` mixes in log space)
 *  @param {Value} a @param {Value} b @param {number} u @returns {Value} */
function mixv(a, b, u) {
  if (typeof a === "number") return lerp(a, b, u);
  if (Array.isArray(a)) return a.map((v, i) => lerp(v, b[i], u));
  /** @type {Record<string, number>} */
  const o = {};
  for (const k of Object.keys(a)) {
    if (k === "s" && a.s > 0 && b.s > 0) o.s = a.s * (b.s / a.s) ** u;
    else o[k] = lerp(a[k], b[k] ?? a[k], u);
  }
  return o;
}

/**
 * A value through keyframes ks = [[t, value, ease?], …], times ascending. The
 * ease of key i shapes the stretch that ends on it (default inOut3). Values
 * are numbers, arrays, or flat objects; a key named `s` is mixed in log space,
 * so a zoom changes at an even rate of scale. Holds the first value before the
 * first key and the last after the last.
 * `const cam = keys(t, [[0, { x: 960, y: 540, s: 1 }], [2, { x: 700, y: 400, s: 1.4 }, "push"]])`
 * @param {number} t
 * @param {Key[]} ks
 * @returns {Value}
 */
export function keys(t, ks) {
  const first = /** @type {Key} */ (ks[0]);
  if (t <= first[0]) return first[1];
  for (let i = 1; i < ks.length; i++) {
    const [t1, v1, e] = /** @type {Key} */ (ks[i]);
    if (t <= t1) {
      const [t0, v0] = /** @type {Key} */ (ks[i - 1]);
      return mixv(v0, v1, easeOf(e)(prog(t, t0, t1)));
    }
  }
  return /** @type {Key} */ (ks[ks.length - 1])[1];
}

/** keys(t, ks) as a function of t, to define once and read every frame. `const x = track([[0, 0], [1, 300, "out3"]]); x(t)`
 *  @param {Key[]} ks @returns {(t: number) => Value} */
export const track = (ks) => (t) => keys(t, ks);

/**
 * A value through moves, each starting at its own t and lasting dur: moves =
 * [{ t, dur, v, ease? }], in time order. Between moves the value holds, so the
 * holds are written by leaving gaps. Default ease inOut3.
 * `keyed(t, [0, 0], [{ t: 1, dur: 0.6, v: [400, 200], ease: "push" }, { t: 3, dur: 0.8, v: [-900, 200], ease: "in3" }])`
 * @param {number} t
 * @param {Value} start
 * @param {{ t: number, dur: number, v: Value, ease?: Ease | string }[]} moves
 * @returns {Value}
 */
export function keyed(t, start, moves) {
  let v = start;
  for (const m of moves) {
    if (t < m.t) break;
    const u = easeOf(m.ease)(prog(t, m.t, m.t + m.dur));
    if (t < m.t + m.dur) return mixv(v, m.v, u);
    v = m.v;
  }
  return v;
}

/**
 * An object stamped down where it lands: scale `from` → 1 over `dur`, then
 * still; no bounce. The reference: 1.19× → 1.0 in one 24 fps frame (42 ms).
 * Before t0: { scale: from, opacity: 0 }.
 * `const st = stamp(t, T.result); el.style.transform = `scale(${st.scale})`; el.style.opacity = st.opacity;`
 * @param {number} t @param {number} t0
 * @param {{ from?: number, dur?: number, ease?: Ease | string }} [o]
 */
export function stamp(t, t0, { from = 1.19, dur = 1 / 24, ease: e = "linear" } = {}) {
  if (t < t0) return { scale: from, opacity: 0 };
  return { scale: lerp(from, 1, easeOf(e)(prog(t, t0, t0 + dur))), opacity: 1 };
}

/**
 * A damped spring from 0 toward 1, released at t0. freq in Hz; zeta the
 * damping ratio (below 1 it overshoots, 1 and above it does not).
 * `const k = spring(t, T.mark, { freq: 2.6, zeta: 0.42 }); el.style.transform = `scale(${k})`;`
 * @param {number} t @param {number} t0 @param {{ freq?: number, zeta?: number }} [o]
 */
export function spring(t, t0, { freq = 2.2, zeta = 0.45 } = {}) {
  const x = t - t0;
  if (x <= 0) return 0;
  const w = 2 * Math.PI * freq;
  if (zeta >= 1) return 1 - (1 + w * x) * Math.exp(-w * x);
  const wd = w * Math.sqrt(1 - zeta * zeta);
  return 1 - Math.exp(-zeta * w * x) * (Math.cos(wd * x) + ((zeta * w) / wd) * Math.sin(wd * x));
}

/**
 * A damped swing about 0 from `amp` at t0: a tilt that overshoots and settles.
 * The reference's dragged boxes: 21° → past 0 by ~24 % → upright, ζ ≈ 0.4.
 * Holds `amp` before t0.
 * `el.style.rotate = `${swing(t, T.drag, { amp: 18, freq: 0.9, zeta: 0.42 })}deg``
 * @param {number} t @param {number} t0 @param {{ amp?: number, freq?: number, zeta?: number }} [o]
 */
export function swing(t, t0, { amp = 10, freq = 1.1, zeta = 0.35 } = {}) {
  if (t < t0) return amp;
  const w = 2 * Math.PI * freq;
  const x = t - t0;
  return amp * Math.exp(-zeta * w * x) * Math.cos(w * Math.sqrt(1 - zeta * zeta) * x);
}

/**
 * Flung in: from → to, fastest at t0, closing on its mark exponentially with
 * time constant tau (s). The reference's cursor: 8600 px/s at first, tau ≈
 * 0.14 s, settled in ~0.63 s. Numbers, arrays or flat objects.
 * `const [x, y] = fling(t, T.cursorIn, [2100, 300], [960, 540], 0.14)`
 * @param {number} t @param {number} t0 @param {Value} from @param {Value} to @param {number} [tau]
 * @returns {Value}
 */
export function fling(t, t0, from, to, tau = 0.14) {
  if (t <= t0) return from;
  return mixv(from, to, 1 - Math.exp(-(t - t0) / tau));
}

/**
 * A line rising into place: y offset dy → 0 on out5, opacity following the
 * travel. The reference's section titles: up 35 px over ~14 frames, a second
 * line 3 frames later. Returns { y, opacity, p }.
 * `const r = rise(t, T.title + i * 0.125); line.style.transform = `translateY(${r.y}px)`; line.style.opacity = r.opacity;`
 * @param {number} t @param {number} t0 @param {{ dy?: number, dur?: number }} [o]
 */
export function rise(t, t0, { dy = 36, dur = 0.55 } = {}) {
  const p = ease.out5(prog(t, t0, t0 + dur));
  return { y: (1 - p) * dy, opacity: clamp(p * 1.6), p };
}

/**
 * Leaving by accelerating (in3) along dx, dy until gone. The reference's
 * outgoing scenes never fade (0.8–1.0 s, last frame ~6000 px/s); fade: true
 * fades over the last 60 %. Returns { x, y, opacity, p }.
 * `const e = exit(t, T.out, { dx: -2200, dur: 0.9 }); win.style.transform = `translateX(${e.x}px)`;`
 * @param {number} t @param {number} t0
 * @param {{ dx?: number, dy?: number, dur?: number, fade?: boolean, ease?: Ease | string }} [o]
 */
export function exit(t, t0, { dx = 0, dy = 0, dur = 0.8, fade = false, ease: e = "in3" } = {}) {
  const p = easeOf(e)(prog(t, t0, t0 + dur));
  return { x: dx * p, y: dy * p, opacity: fade ? 1 - clamp((p - 0.4) / 0.6) : 1, p };
}

/**
 * The part of `text` typed by t, from t0 at `cps` characters a second. The
 * reference: a title word ~15–17 cps, a long prompt ~45–55 cps.
 * `field.textContent = typeOn(t, T.type, "Red pandas, up close", 30)`
 * @param {number} t @param {number} t0 @param {string} text @param {number} [cps]
 */
export function typeOn(t, t0, text, cps = 20) {
  const n = Math.floor(Math.max(0, t - t0) * cps);
  return text.slice(0, Math.min(text.length, n));
}

/**
 * A number counting a → b over dur from t0, on the measured count curve
 * (never passing b), rounded to `digits` places.
 * `kpi.textContent = fmt(count(t, T.result, 0.875, 0, 58500))`
 * @param {number} t @param {number} t0 @param {number} dur @param {number} a @param {number} b
 * @param {{ ease?: Ease | string, digits?: number }} [o]
 */
export function count(t, t0, dur, a, b, { ease: e = "count", digits = 0 } = {}) {
  const v = lerp(a, b, clamp(easeOf(e)(prog(t, t0, t0 + dur))));
  const k = 10 ** digits;
  return Math.round(v * k) / k;
}

/** a number with thousands separators. `fmt(2576)` → "2,576"; `fmt(3.14159, 1)` → "3.1" @param {number} n @param {number} [digits] */
export const fmt = (n, digits) =>
  n.toLocaleString("en-US", digits == null ? undefined : { minimumFractionDigits: digits, maximumFractionDigits: digits });

/**
 * A cursor going from target to target: marks = [{ t, at, travel?, ease?, bow? }],
 * `at` an [x, y] or a function giving one (read every frame, so it follows a
 * target that moves). It arrives on each mark at its t, travelling over the
 * `travel` s before (default 0.5, ease inOut3), and bows sideways a little as
 * a hand does (bow 0.08 of the distance). ease: "fling" for a flung cursor.
 * `const [x, y] = pointer(t, [{ t: 0, at: [1500, 900] }, { t: 1.2, at: () => [knob.x, knob.y] }, { t: 2.4, at: [880, 610], ease: "fling", travel: 0.6 }])`
 * To ride a moving target for a whole stretch (a drag), give that mark `ease: () => 1`.
 * @typedef {{ t: number, at: [number, number] | (() => [number, number]), travel?: number, ease?: Ease | string, bow?: number }} Mark
 * @param {number} t @param {Mark[]} marks
 * @param {{ travel?: number, ease?: Ease | string, bow?: number }} [o]
 * @returns {[number, number]}
 */
export function pointer(t, marks, { travel = 0.5, ease: e = "inOut3", bow = 0.08 } = {}) {
  const at = (/** @type {Mark} */ m) => (typeof m.at === "function" ? m.at() : m.at);
  const first = /** @type {Mark} */ (marks[0]);
  if (t <= first.t) return at(first);
  for (let i = 1; i < marks.length; i++) {
    const m = /** @type {Mark} */ (marks[i]);
    if (t <= m.t) {
      const prev = /** @type {Mark} */ (marks[i - 1]);
      const start = Math.max(prev.t, m.t - (m.travel ?? travel));
      const u = easeOf(m.ease ?? e)(prog(t, start, m.t));
      const a = at(prev);
      const b = at(m);
      const dx = b[0] - a[0];
      const dy = b[1] - a[1];
      const k = (m.bow ?? bow) * Math.sin(Math.PI * u);
      return [lerp(a[0], b[0], u) - dy * k, lerp(a[1], b[1], u) + dx * k];
    }
  }
  return at(/** @type {Mark} */ (marks[marks.length - 1]));
}

/** a click's squash on the pressed thing (or the cursor): 1 → 0.86 → 1 in 0.2 s around t0. `btn.style.transform = `scale(${press(t, T.click)})`` @param {number} t @param {number} t0 */
export function press(t, t0) {
  const d = t - t0;
  if (d < -0.06 || d > 0.14) return 1;
  return d < 0 ? 1 - (0.14 * (d + 0.06)) / 0.06 : 0.86 + (0.14 * d) / 0.14;
}

/**
 * A 2D camera c = { x, y, s }: the world point (x, y) at the frame's centre,
 * scaled s. Returns c with `css` (the transform for the world's element, with
 * transform-origin 0 0) and `toScreen(x, y)` (where a world point is in the
 * frame). Move it with keys: an `s` key mixes in log space.
 * `const cam = cam2d(keys(t, camKeys)); world.style.transform = cam.css;`
 * @param {{ x: number, y: number, s: number }} c @param {number} [w] @param {number} [h]
 */
export function cam2d(c, w = 1920, h = 1080) {
  return {
    ...c,
    css: `translate(${w / 2}px, ${h / 2}px) scale(${c.s}) translate(${-c.x}px, ${-c.y}px)`,
    toScreen: (/** @type {number} */ px, /** @type {number} */ py) => [(px - c.x) * c.s + w / 2, (py - c.y) * c.s + h / 2],
  };
}
