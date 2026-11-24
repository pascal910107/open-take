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
//   rng(seed)                       seeded numbers in [0, 1), the same every render
//   bezier(x1, y1, x2, y2)          a CSS cubic-bezier as an ease
//   ease.*                          linear, in2 … inOut4, out5, inOutSine, outExpo,
//                                   and the measured ones: push, count, pull, fling
//   keys(t, ks)                     a value through keyframes, each stretch with its own ease
//   track(ks)                       keys as a function of t
//   keyed(t, start, moves)          a value through moves that start at t and last dur (holds between)
//   stamp(t, t0, o)                 → { scale, opacity } — an object landing: 1.19× → 1 in one 24 fps frame, no bounce
//   spring(t, t0, o)                a damped spring 0 → 1
//   swing(t, t0, o)                 a damped swing amp → 0 (a dragged thing's tilt)
//   fling(t, t0, from, to, tau)     flung in: fastest at once, exponential arrival — a value;
//                                   its ease, for keys or your own progress, is ease.fling(u, tau)
//   rise(t, t0, o)                  a line rising into place
//   exit(t, t0, o)                  leaving by accelerating until gone
//   typeOn(t, t0, text, cps)        the part of a text typed so far
//   count(t, t0, dur, a, b, o)      a number counting a → b on the measured count curve
//   fmt(n, digits)                  1234.5 → "1,234.5"
//   pointer(t, marks, o)            a cursor going from target to target, in a slight arc
//   press(t, t0)                    a click's squash: 1 → 0.86 → 1 around t0
//   cam2d(c, w, h)                  a 2D camera { x, y, s } → its CSS transform and toScreen
//
// Named for what they do, and the GSAP names the reels' eases were measured in:
//
//   ease.arrive, leave, resume, step, pop, settle, drift    eases by purpose (below)
//   named(e)                        an ease, by its name or a GSAP name ("power2.out", "back.out(1.5)",
//                                   "elastic.out(1, 0.4)"); an unknown name is an error. Every ease
//                                   option here takes the same names.
//   gsapEase(name)                  a GSAP ease name as GSAP 3 computes it, or null
//   staggerGrid(i, cols, rows, o)   when cell i of a grid starts, by its distance from a cell or the centre
//   accelStagger(i, n, o)           when item i of n starts, the gaps shrinking: a run that speeds up
//   split(el, o)                    a line of text split into chars, words or lines (with a mask), to move each
//   springs(t, changes, o)          a value retargeted again and again, each change a spring on top of the last
//   anticipate(t, t0, o)            a move that winds up first: back, squashed, then launched and stretched
//   follow(drive, o)                a tag's swing, pushed by what it hangs from: a function of t, built once

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
 * Numbers that look random but are the same every render (mulberry32, as
 * kit/audio.mjs's rng for the score): a page built on Math.random() changes
 * each time it is drawn. `const r = rng(7); r()` → a number in [0, 1)
 * @param {number} seed @returns {() => number}
 */
export function rng(seed) {
  let a = seed | 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), a | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

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
  // (the reference's cursor: tau 0.14 s over 0.625 s ≈ 0.22). `(u) => ease.fling(u, 0.18)`.
  // A progress, not a value: to move a value from one place to another over
  // film time, fling(t, t0, from, to, tau) below (tau in seconds there)
  fling: (u, tau = 0.22) => (1 - Math.exp(-u / tau)) / (1 - Math.exp(-1 / tau)),
  // By purpose, each measured on a launch film (the GSAP name it is closest to after it):
  // something arriving, all its force in the first frame: a panel dropping
  // 195 px in 0.47 s, 65 px of it in the first frame (flying-machine film, 5.533 s; circ.out)
  arrive: bezier(0.1, 1, 0.95, 1),
  // leaving, faster every frame, cut on the fastest: a card sliding 85 px in 8 frames
  // (flying-machine film, 3.033–3.3 s; power3.in)
  leave: bezier(0.775, 0, 0.975, 1),
  // the next shot carrying on the same way and slowing: 57 px in 8 frames, −17.7 → −0.5 px a frame
  // (flying-machine film, 3.3–3.567 s)
  resume: bezier(0.275, 0.8, 0.675, 1),
  // one step of a list or wheel: 155 px in 10 frames (flying-machine film, 3.667–4.9 s; power2.inOut)
  step: bezier(0.425, 0, 0.2, 1),
  // a block snapping to a new size in two frames, a touch past (truck film, 28.46 s; back.out(1.5))
  pop: (u) => 1 + 2.5 * (u - 1) ** 3 + 1.5 * (u - 1) ** 2,
  // a number or a pill settling: a 1.07 s count (flying-machine film, 38.758 s), a pill 164 px
  // in 0.375 s (game film, 16.2 s) (power2.out)
  settle: (u) => 1 - (1 - u) ** 3,
  // a drift: the same speed throughout (a hold that never stops, a scroll)
  drift: (u) => u,
};
/** an ease of `ease` by its own name (not one every object inherits, such as "toString") @param {string} e */
const own = (e) => (Object.hasOwn(ease, e) ? /** @type {Record<string, Ease>} */ (ease)[e] : undefined);

/** an ease, or one by its name or a GSAP name (a bare GSAP family, "sine", is
 *  its .out, as in GSAP); a name that is neither is inOut3
 *  @param {Ease | string | undefined} e @returns {Ease} */
const easeOf = (e) => (typeof e === "function" ? e : (own(e ?? "inOut3") ?? gsapEase(e ?? "")) ?? ease.inOut3);

/**
 * An ease, or one by its name in `ease` or a GSAP name; a name that is
 * neither is an error, saying which names there are.
 * `named("power2.out")(0.5)` → 0.875
 * @param {Ease | string} e @returns {Ease}
 */
export function named(e) {
  if (typeof e === "function") return e;
  const f = (typeof e === "string" ? own(e) : undefined) ?? gsapEase(e);
  if (!f)
    throw new Error(
      `anim: no ease named "${e}" — one of ${Object.keys(ease).join(", ")}, or a GSAP name such as "power2.out", "sine.inOut", "back.out(1.7)"`,
    );
  return f;
}

/** GSAP's power families: the power of their ease-in */
/** @type {Record<string, number>} */
const POWER = { linear: 1, none: 1, power0: 1, power1: 2, quad: 2, power2: 3, cubic: 3, power3: 4, quart: 4, power4: 5, quint: 5, strong: 5 };

/**
 * A GSAP 3 ease name as GSAP computes it: power0–4 (quad … quint), sine,
 * expo (GSAP's blended form, 0.9766 at 0.5 where ease.outExpo is 0.9688),
 * circ, back (overshoot, default 1.70158), elastic (amplitude, period),
 * bounce, none/linear; ".in", ".out" or ".inOut", a bare family being
 * ".out" as in GSAP. Names differ between libraries for the same curve:
 * GSAP's power2.out is ease.out3 here (and anime's outCubic). Null for a
 * name it does not know.
 * `gsapEase("power2.out")(0.5)` → 0.875; `gsapEase("back.out(1.5)")`
 * @param {string} name @returns {Ease | null}
 */
export function gsapEase(name) {
  const m = /^\s*([a-z][a-z0-9]*)(?:\.(in|out|inout))?\s*(?:\(([^)]*)\))?\s*$/i.exec(String(name));
  if (!m) return null;
  const fam = /** @type {string} */ (m[1]).toLowerCase();
  const kind = (m[2] ?? "out").toLowerCase();
  const args = m[3] ? m[3].split(",").map((s) => Number(s.trim())) : [];
  /** in → out → inOut, as GSAP derives them from the ease-in @param {Ease} f */
  const from_in = (f) =>
    kind === "in" ? f : kind === "out" ? (/** @type {Ease} */ (u) => 1 - f(1 - u)) : (/** @type {Ease} */ (u) => (u < 0.5 ? f(u * 2) / 2 : 1 - f((1 - u) * 2) / 2));
  /** …and from the ease-out, for back and elastic @param {Ease} f */
  const from_out = (f) =>
    kind === "out" ? f : kind === "in" ? (/** @type {Ease} */ (u) => 1 - f(1 - u)) : (/** @type {Ease} */ (u) => (u < 0.5 ? (1 - f(1 - u * 2)) / 2 : 0.5 + f((u - 0.5) * 2) / 2));
  const n = Object.hasOwn(POWER, fam) ? POWER[fam] : undefined;
  if (n != null) return n === 1 ? (u) => u : from_in((u) => u ** n);
  if (fam === "sine") return from_in((u) => (u === 1 ? 1 : 1 - Math.cos((u * Math.PI) / 2)));
  if (fam === "expo") return from_in((u) => 2 ** (10 * (u - 1)) * u + u ** 6 * (1 - u));
  if (fam === "circ") return from_in((u) => 1 - Math.sqrt(1 - u * u));
  if (fam === "back") {
    const o = Number.isFinite(args[0]) ? /** @type {number} */ (args[0]) : 1.70158;
    return from_out((u) => {
      if (!u) return 0;
      const q = u - 1;
      return q * q * ((o + 1) * q + o) + 1;
    });
  }
  if (fam === "elastic") {
    const amp = Number.isFinite(args[0]) ? /** @type {number} */ (args[0]) : 1;
    // a period of 0 is the default, as GSAP's `period ||` reads it
    const per = Number.isFinite(args[1]) && args[1] !== 0 ? /** @type {number} */ (args[1]) : kind === "inout" ? 0.45 : 0.3;
    const p1 = amp >= 1 ? amp : 1;
    const p2 = per / (amp < 1 ? amp : 1);
    const p3 = (p2 / (2 * Math.PI)) * (Math.asin(1 / p1) || 0);
    const w = (2 * Math.PI) / p2;
    return from_out((u) => (u === 1 ? 1 : p1 * 2 ** (-10 * u) * Math.sin((u - p3) * w) + 1));
  }
  if (fam === "bounce") {
    const k = 7.5625, c = 2.75;
    /** @type {Ease} */
    const out = (u) =>
      u < 1 / c ? k * u * u : u < 2 / c ? k * (u - 1.5 / c) ** 2 + 0.75 : u < 2.5 / c ? k * (u - 2.25 / c) ** 2 + 0.9375 : k * (u - 2.625 / c) ** 2 + 0.984375;
    return from_in((u) => 1 - out(1 - u));
  }
  return null;
}

/** a mix of two values: numbers, arrays of numbers, or flat objects of numbers (a key `s` mixes in log space)
 *  @param {Value} a @param {Value} b @param {number} u @returns {Value} */
function mixv(a, b, u) {
  if (a == null || b == null)
    throw new Error(
      `anim: a value to move is missing (from ${JSON.stringify(a)} to ${JSON.stringify(b)}) — a number, an array of numbers or a flat object of numbers`,
    );
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
  if (from == null || to == null)
    throw new Error(
      "anim: fling(t, t0, from, to, tau) moves a value from `from` to `to` — given no from or to. " +
        "The ease of the same shape, a progress 0..1 → 0..1 for keys or your own lerp, is ease.fling(u, tau)",
    );
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

// --- many things at once, and moves with a body ---------------------------------

/**
 * When cell i of a grid (row by row, `cols` wide) starts, in s after the
 * first: its distance from `from`, in cells, times `each`. `from` is
 * "center", "start" (the first cell), "end" (the last), "edges" (outer cells
 * first, the middle last), a cell's index, or [col, row]. `amount` instead of
 * `each`: the whole spread, first to last, whatever the grid's size.
 * Libraries mean different things by these: GSAP's grid `each` is the spread
 * over the longest side, anime's is per cell; here `each` is per cell of
 * distance and `amount` the total. `ease` bends the spread (default linear).
 * The default `each` is the fly film's layer list growing a row every 2
 * frames (11.5–13.25 s); a grid falls into place from the middle out.
 * `const d = staggerGrid(i, 6, 4, { from: "center", each: 0.06 }); const r = rise(t, T.grid + d);`
 * @param {number} i @param {number} cols @param {number} rows
 * @param {{ from?: "center" | "start" | "end" | "edges" | number | [number, number], each?: number, amount?: number, ease?: Ease | string }} [o]
 */
export function staggerGrid(i, cols, rows, { from = "center", each = 2 / 24, amount, ease: e = "linear" } = {}) {
  const c = i % cols, r = Math.floor(i / cols);
  const at = (/** @type {number} */ k) => [k % cols, Math.floor(k / cols)];
  const corners = [[0, 0], [cols - 1, 0], [0, rows - 1], [cols - 1, rows - 1]];
  /** distance of cell (x, y) from `from` @param {number} x @param {number} y */
  const dist = (x, y) => {
    if (from === "edges") return Math.min(x, y, cols - 1 - x, rows - 1 - y);
    const [fx, fy] =
      from === "center" ? [(cols - 1) / 2, (rows - 1) / 2]
      : from === "start" ? [0, 0]
      : from === "end" ? [cols - 1, rows - 1]
      : typeof from === "number" ? at(from)
      : from;
    return Math.hypot(x - /** @type {number} */ (fx), y - /** @type {number} */ (fy));
  };
  let max = 0;
  if (from === "edges") max = Math.floor((Math.min(cols, rows) - 1) / 2);
  else for (const [x, y] of corners) max = Math.max(max, dist(/** @type {number} */ (x), /** @type {number} */ (y)));
  const d = dist(c, r);
  const span = amount ?? each * max;
  return max > 0 ? span * easeOf(e)(d / max) : 0;
}

/**
 * When item i of n starts, in s after the first, the gaps shrinking evenly
 * (in ratio) from `first` to `last`: a run that speeds up as it goes. The
 * fly film's packshot (47.6 s): 13 layers popping in at gaps of 8 frames
 * down to 1; the app film's worker list: rows 0.5–0.65 s apart, then three
 * in 0.3 s (14.6–14.9 s). A gap of 0 has no ratio: then the gaps change
 * evenly from `first` to `last`.
 * `layers.forEach((el, i) => { el.style.opacity = t >= T.pack + accelStagger(i, layers.length) ? 1 : 0; })`
 * @param {number} i @param {number} n @param {{ first?: number, last?: number }} [o]  gaps in s (default 8 and 1 frames at 24 fps)
 */
export function accelStagger(i, n, { first = 8 / 24, last = 1 / 24 } = {}) {
  let s = 0;
  const k = Math.max(0, Math.min(i, n - 1));
  const ratio = first > 0 && last > 0;
  for (let j = 0; j < k; j++) {
    const u = n <= 2 ? 0 : j / (n - 2);
    s += ratio ? first * (last / first) ** u : lerp(first, last, u);
  }
  return s;
}

/**
 * Split an element's text into pieces to move one by one: "chars", "words"
 * or "lines" (lines as the text wraps now, so call it once its fonts are in).
 * Returns the pieces, in order; spaces stay as text between them. With
 * `mask`, each piece sits in a clip of its own height, so a piece moved down
 * by its height is hidden and rises into view (`rise`). Calling it again
 * splits the original text again. Build-time, not per frame: split once,
 * then move the pieces in __render.
 * `const words = split(title, { by: "lines", mask: true }); words.forEach((w, i) => { const r = rise(t, T.title + i * 0.1, { dy: 90 }); w.style.transform = `translateY(${r.y}px)`; });`
 * @param {HTMLElement} el @param {{ by?: "chars" | "words" | "lines", mask?: boolean }} [o]
 * @returns {HTMLElement[]}
 */
export function split(el, { by = "words", mask = false } = {}) {
  const doc = el.ownerDocument;
  const text = el.dataset.splitText ?? el.textContent ?? "";
  el.dataset.splitText = text;
  el.textContent = "";
  /** @param {string} cls @param {string} display */
  const span = (cls, display) => {
    const s = doc.createElement("span");
    s.className = cls;
    s.style.display = display;
    return s;
  };
  /** a piece, in its mask if asked; returns the piece @param {HTMLElement} parent @param {string} txt @param {string} cls @param {string} display */
  const piece = (parent, txt, cls, display) => {
    const p = span(cls, display);
    p.textContent = txt;
    if (!mask) {
      parent.appendChild(p);
      return p;
    }
    const m = span(`${cls}-mask`, display);
    m.style.overflow = "hidden";
    m.style.verticalAlign = "top";
    m.appendChild(p);
    parent.appendChild(m);
    return p;
  };
  const words = text.split(/(\s+)/);
  if (by === "lines") {
    // lay the words out, read where each line starts, then rebuild one block per line
    /** @type {HTMLElement[]} */
    const probes = [];
    for (const w of words) {
      if (/^\s+$/.test(w)) el.appendChild(doc.createTextNode(" "));
      else if (w) {
        const s = span("word", "inline");
        s.textContent = w;
        el.appendChild(s);
        probes.push(s);
      }
    }
    /** @type {string[][]} */
    const lines = [];
    let top = -Infinity;
    for (const s of probes) {
      if (s.offsetTop > top + 1) {
        lines.push([]);
        top = s.offsetTop;
      }
      /** @type {string[]} */ (lines[lines.length - 1]).push(s.textContent ?? "");
    }
    el.textContent = "";
    return lines.map((ws) => piece(el, ws.join(" "), "line", "block"));
  }
  /** @type {HTMLElement[]} */
  const out = [];
  for (const w of words) {
    if (!w) continue;
    if (/^\s+$/.test(w)) {
      el.appendChild(doc.createTextNode(" "));
      continue;
    }
    if (by === "words") out.push(piece(el, w, "word", "inline-block"));
    else {
      // chars inside a word that does not break apart
      const word = span("word", "inline-block");
      el.appendChild(word);
      for (const ch of Array.from(w)) out.push(piece(word, ch, "char", "inline-block"));
    }
  }
  return out;
}

/**
 * A value retargeted again and again: each change starts a spring from where
 * the value is going to where it goes next, on top of the ones still
 * settling, so a change mid-move bends the path instead of stopping it dead
 * (a tween restarted from the current value drops its speed to 0 there).
 * changes = [[t, value], …], times ascending; before the first, its value.
 * Numbers, arrays or flat objects. Default freq 3.2 Hz, zeta 0.78: about 2 %
 * past the mark. A tab indicator whose leading edge rides a faster spring
 * than its trailing one stretches as it moves: two calls, freq 4.6 and 2.4.
 * `const x = springs(t, [[0, 0], [1.0, 240], [1.22, 0], [1.6, 480]])`
 * @param {number} t @param {[number, Value][]} changes @param {{ freq?: number, zeta?: number }} [o]
 * @returns {Value}
 */
export function springs(t, changes, { freq = 3.2, zeta = 0.78 } = {}) {
  if (!changes.length) throw new Error("anim: springs(t, changes) needs at least one change, [[t, value], …]");
  const first = /** @type {[number, Value]} */ (changes[0]);
  let v = first[1];
  for (let i = 1; i < changes.length; i++) {
    const [ti, vi] = /** @type {[number, Value]} */ (changes[i]);
    if (t <= ti) break;
    const [, prev] = /** @type {[number, Value]} */ (changes[i - 1]);
    const k = spring(t, ti, { freq, zeta });
    v = addv(v, prev, vi, k);
  }
  return v;
}

/** v + (b − a)·k, for numbers, arrays or flat objects @param {Value} v @param {Value} a @param {Value} b @param {number} k @returns {Value} */
function addv(v, a, b, k) {
  if (typeof v === "number") return v + (b - a) * k;
  if (Array.isArray(v)) return v.map((x, i) => x + (b[i] - a[i]) * k);
  /** @type {Record<string, number>} */
  const o = {};
  for (const key of Object.keys(v)) o[key] = v[key] + ((b[key] ?? a[key]) - a[key]) * k;
  return o;
}

/**
 * A move with a body: it winds up for `prep` s before t0 — back by `back` px,
 * squashed, leaning away — then launches at t0, overshooting a little
 * (back.out, `overshoot`) and stretched along the way, and lands with a
 * small wobble. from, to: numbers (along x) or [x, y]. Every part is
 * continuous through the launch (a frame from the wind-up and the next one
 * from the launch never jump). Amounts are a card's, scaled down from a
 * character's: back 30 px, squash 1.06 × 0.94, lean 2.5°, prep 0.4 s, launch
 * 0.45 s, stretch 1.10 × 0.93, wobble 0.04. Kept small, it reads as weight;
 * larger, as a cartoon. Returns { x, y, sx, sy, r (deg), p }.
 * `const a = anticipate(t, T.send, { from: 230, to: 1290 }); card.style.transform = `translate(${a.x}px, ${a.y}px) rotate(${a.r}deg) scale(${a.sx}, ${a.sy})`;`
 * @param {number} t @param {number} t0  the launch
 * @param {{ from?: number | [number, number], to?: number | [number, number], back?: number, prep?: number, dur?: number,
 *   squash?: [number, number], stretch?: [number, number], lean?: number, overshoot?: number, wobble?: number }} [o]
 */
export function anticipate(t, t0, o = {}) {
  const {
    from = 0, to = 0, back = 30, prep = 0.4, dur = 0.45, squash = [1.06, 0.94], stretch = [1.1, 0.93],
    lean = 2.5, overshoot = 1.1, wobble = 0.04,
  } = o;
  /** @type {[number, number]} */
  const A = typeof from === "number" ? [from, 0] : from;
  /** @type {[number, number]} */
  const B = typeof to === "number" ? [to, 0] : to;
  const dx = B[0] - A[0], dy = B[1] - A[1];
  const len = Math.hypot(dx, dy) || 1;
  const ux = dx / len, uy = dy / len;
  const side = ux < 0 ? -1 : 1; // leans away from where it goes
  const w = ease.inOut2(prog(t, t0 - prep, t0)); // the wind-up
  if (t < t0) {
    return {
      x: A[0] - ux * back * w, y: A[1] - uy * back * w,
      sx: lerp(1, squash[0], w), sy: lerp(1, squash[1], w), r: -side * lean * w, p: 0,
    };
  }
  const q = prog(t, t0, t0 + dur);
  const g = /** @type {Ease} */ (gsapEase(`back.out(${overshoot})`));
  const d = lerp(-back, len, g(q));
  // squash → stretch over the first 30 %, stretch → 1 by 70 %; the lean eases out over the first 35 %
  const s1 = ease.out2(prog(q, 0, 0.3)), s2 = ease.inOut2(prog(q, 0.3, 0.7));
  let sx = q < 0.3 ? lerp(squash[0], stretch[0], s1) : lerp(stretch[0], 1, s2);
  let sy = q < 0.3 ? lerp(squash[1], stretch[1], s1) : lerp(stretch[1], 1, s2);
  const r = -side * lean * (1 - ease.out3(prog(q, 0, 0.35)));
  if (t > t0 + dur) {
    const k = t - t0 - dur;
    const wob = wobble * Math.exp(-7 * k) * Math.sin(17 * k);
    sx = 1 + wob;
    sy = 1 - wob;
  }
  return { x: A[0] + ux * d, y: A[1] + uy * d, sx, sy, r, p: q };
}

/**
 * A thing hanging from a moving one — a tag, a flag, a cable — swinging
 * from the mover's acceleration: angle'' = −ω²·angle − c·angle' − gain·acc
 * (ω 11 rad/s, c 5.5: it swings past twice and settles in about 2 s). The
 * swing has a past, so it is integrated once, here, over [from, to] in
 * 1/600 s steps into a table; the function it returns reads the table, so a
 * frame drawn twice or out of order is the same. drive(t) is the mover's
 * position (px, a number or [x, y]: the x is used, or `axis: "y"`). Returns
 * the angle in degrees (gain in rad per px/s²: 0.001 swings a tag about 26°
 * either way when a card crosses 1060 px in 0.45 s).
 * `const tag = follow((t) => anticipate(t, T.send, { from: 230, to: 1290 }).x, { from: 0, to: 4 }); el.style.rotate = `${tag(t)}deg``
 * @param {(t: number) => number | number[]} drive
 * @param {{ from?: number, to?: number, omega?: number, damping?: number, gain?: number, axis?: "x" | "y", max?: number }} [o]
 *   max: the swing held inside ± this many degrees (default 63)
 * @returns {(t: number) => number}
 */
export function follow(drive, { from = 0, to = 10, omega = 11, damping = 5.5, gain = 0.001, axis = "x", max = 63 } = {}) {
  if (!(to >= from))
    throw new Error(`anim: follow's table runs from \`from\` to \`to\`, so \`to\` is not before \`from\` (got from ${from}, to ${to})`);
  const dt = 1 / 600;
  const n = Math.max(2, Math.ceil((to - from) / dt) + 1);
  const tab = new Float64Array(n);
  const pos = (/** @type {number} */ i) => {
    const v = drive(from + i * dt);
    return typeof v === "number" ? v : /** @type {number} */ (v[axis === "y" ? 1 : 0]);
  };
  let a = 0, v = 0;
  let p0 = pos(-1), p1 = pos(0);
  for (let i = 0; i < n; i++) {
    const p2 = pos(i + 1);
    const acc = (p2 - 2 * p1 + p0) / (dt * dt);
    v += (-omega * omega * a - damping * v - gain * acc) * dt;
    a += v * dt;
    tab[i] = a;
    p0 = p1;
    p1 = p2;
  }
  const lim = (max * Math.PI) / 180;
  return (t) => {
    const x = (Math.min(Math.max(t, from), to) - from) / dt;
    const i = Math.min(n - 2, Math.floor(x));
    const u = x - i;
    const rad = lerp(/** @type {number} */ (tab[i]), /** @type {number} */ (tab[i + 1]), u);
    return (clamp(rad, -lim, lim) * 180) / Math.PI;
  };
}
