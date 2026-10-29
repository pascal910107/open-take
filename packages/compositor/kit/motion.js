// @ts-check
// Motion for a film page — open-take's film kit. Plain functions of time:
// give one the film's time t (s) and when the move starts, read back numbers,
// and put them wherever the film needs them (CSS, canvas, WebGL). Nothing
// here owns an element, keeps state or runs on its own clock, so a frame
// rendered twice or out of order comes out the same.
//
//   - springs that land: a damped spring in closed form, under-, critically
//     or over-damped, with or without an overshoot;
//   - entrances that read as arriving, not fading: the opacity is tied to the
//     travel and finishes first; a drop stretches with its speed and squashes
//     as it brakes; text can rise out of its own line or be typed;
//   - handoffs, where one picture becomes the next: a box growing into
//     another, a circle opening from a point, a zoom through a rect, items
//     gathering into one place;
//   - contact: a button that sinks and comes back, a hit that kicks;
//   - numbers and parts: a number counting in the product's own format, a
//     line of text scrambling into place, digits rolling like an odometer or
//     folding over like a split-flap board, a part's pieces arriving one
//     after another (assemble, which also writes its numbers onto elements
//     when it is given elements — from t alone).
//
// Every default below says where it comes from; none of them is a style.
// Change any of them per call, or write the move yourself.
//
//   import { rise, morphRect, rectClip, press } from "./kit/motion.js";
//   const w = rise(t, 2.0);                   // { x, y, opacity, p }
//   title.style.transform = `translate(${w.x}px, ${w.y}px)`;
//   title.style.opacity = String(w.opacity);
//   const r = morphRect(t, 4, 4.5, buttonBox, { x: 0, y: 0, w: 1920, h: 1080 });
//   card.style.clipPath = rectClip(r, { width: 1920, height: 1080 });
//   const b = press(t, 6.1);                  // { scale, y }

/** @typedef {{ x: number, y: number }} Pt  a point, in CSS px */
/** @typedef {{ x: number, y: number, w: number, h: number, r: number }} Rect  a box with a corner radius, in CSS px */
/** @typedef {{ x: number, y: number, w?: number, h?: number, width?: number, height?: number, r?: number }} RectLike  a Rect, or a kit Box ({ x, y, width, height }) */
/** @typedef {{ x?: number, y?: number, w?: number, h?: number, width?: number, height?: number }} Frame  an element's box: its size, and where it sits if not at 0, 0 */
/**
 * @typedef {object} SpringOpts
 * @property {number} [from] where it starts (default 0)
 * @property {number} [to] where it comes to rest (default 1)
 * @property {number} [start] when it is let go (s, default 0)
 * @property {number} [velocity] its speed when let go, in units a second (default 0)
 * @property {number} [freq] natural frequency in Hz (default 1.6 — see DEFAULT_FREQ)
 * @property {number} [stiffness] instead of freq: k for a unit mass (ω0 = √k)
 * @property {number} [damping] damping RATIO ζ: < 1 swings past the rest, 1 lands
 *   without, > 1 creeps in (default 0.7). Not a coefficient: framer-motion's
 *   { stiffness: 300, damping: 20 } is ratio 20 / (2·√300) ≈ 0.58 — or pass it as `friction`
 * @property {number} [friction] instead of damping: the coefficient c for a unit mass (ζ = c / 2√k)
 * @property {number} [overshoot] instead of damping: how far past the rest the
 *   first swing goes, as a share of the travel (0.1 = 10 %)
 */

// --- small helpers ----------------------------------------------------------

/** @param {number} x */
const clamp01 = (x) => Math.max(0, Math.min(1, x));
/** @param {number} a @param {number} b @param {number} p */
const lerp = (a, b, p) => a + (b - a) * p;

/** smootherstep, 6p⁵ − 15p⁴ + 10p³ (the camera's `smooth`) */
/** @param {number} p */
export const smooth = (p) => {
  const x = clamp01(p);
  return x * x * x * (x * (x * 6 - 15) + 10);
};

/** leaves from rest and is fastest at the end: how things get out of the way */
/** @param {number} p */
export const easeIn = (p) => {
  const x = clamp01(p);
  return x * x * x;
};

/** fastest at the start and lands softly */
/** @param {number} p */
export const easeOut = (p) => 1 - easeIn(1 - p);

/** a Rect from a Rect or a kit Box */
/** @param {RectLike} b @returns {Rect} */
export function rectOf(b) {
  return { x: b.x, y: b.y, w: b.w ?? b.width ?? 0, h: b.h ?? b.height ?? 0, r: b.r ?? 0 };
}

// --- springs ----------------------------------------------------------------

// 1.6 Hz with ζ 0.7: settles to within 2 % in ≈ 4 / (ζ·ω0) ≈ 0.57 s, with a
// first swing of ≈ 4.6 % of the travel. That is the take camera's push-in
// (0.73 s) scaled down for things smaller than the picture, which travel
// less and so should take less time; the swing is about the least an eye
// notices at 60 fps on a 24 px rise (≈ 1 px), so the landing is felt, not seen.
const DEFAULT_FREQ = 1.6;
const DEFAULT_DAMPING = 0.7;

/** the damping ratio whose first swing past the rest is `os` of the travel:
 *  for an underdamped step, os = exp(−ζπ / √(1−ζ²)), solved for ζ */
/** @param {number} os */
export function dampingFor(os) {
  if (!(os > 0)) return 1;
  const l = Math.log(Math.min(os, 0.999));
  return -l / Math.sqrt(Math.PI * Math.PI + l * l);
}

/** @param {SpringOpts} o */
function springParams(o) {
  const w0 = o.stiffness != null ? Math.sqrt(o.stiffness) : 2 * Math.PI * (o.freq ?? DEFAULT_FREQ);
  const zeta =
    o.overshoot != null
      ? dampingFor(o.overshoot)
      : o.friction != null
        ? o.friction / (2 * w0)
        : (o.damping ?? DEFAULT_DAMPING);
  if (!(w0 > 0)) throw new Error(`spring: the frequency must be above 0 (ω0 ${w0})`);
  if (!(zeta >= 0)) throw new Error(`spring: the damping must be 0 or more (ζ ${zeta})`);
  return { w0, zeta };
}

/** displacement from the rest and its speed, τ s after release, for
 *  x(0) = x0, x'(0) = v0: the closed-form solutions of x'' + 2ζω0x' + ω0²x = 0 */
/** @param {number} tau @param {number} x0 @param {number} v0 @param {number} w0 @param {number} zeta @returns {[number, number]} */
function springState(tau, x0, v0, w0, zeta) {
  if (tau <= 0) return [x0, v0];
  if (Math.abs(zeta - 1) < 1e-6) {
    // critically damped: x = e^(−ω0τ)·(x0 + (v0 + ω0x0)·τ)
    const e = Math.exp(-w0 * tau);
    const b = v0 + w0 * x0;
    return [e * (x0 + b * tau), e * (b - w0 * (x0 + b * tau))];
  }
  if (zeta < 1) {
    const wd = w0 * Math.sqrt(1 - zeta * zeta);
    const a = zeta * w0;
    const e = Math.exp(-a * tau);
    const B = (v0 + a * x0) / wd;
    const c = Math.cos(wd * tau);
    const s = Math.sin(wd * tau);
    return [e * (x0 * c + B * s), e * ((B * wd - a * x0) * c - (x0 * wd + a * B) * s)];
  }
  // overdamped: two decaying exponentials, r = −ω0·(ζ ∓ √(ζ²−1))
  const q = Math.sqrt(zeta * zeta - 1);
  const r1 = -w0 * (zeta - q);
  const r2 = -w0 * (zeta + q);
  const c2 = (v0 - r1 * x0) / (r2 - r1);
  const c1 = x0 - c2;
  const e1 = Math.exp(r1 * tau);
  const e2 = Math.exp(r2 * tau);
  return [c1 * e1 + c2 * e2, r1 * c1 * e1 + r2 * c2 * e2];
}

/** where a spring is at t (s): `from` until `start`, then on its way to `to` */
/** @param {number} t @param {SpringOpts} [opts] */
export function spring(t, opts = {}) {
  const { from = 0, to = 1, start = 0, velocity = 0 } = opts;
  const { w0, zeta } = springParams(opts);
  return to + springState(t - start, from - to, velocity, w0, zeta)[0];
}

/** how fast a spring moves at t (units a second) */
/** @param {number} t @param {SpringOpts} [opts] */
export function springVel(t, opts = {}) {
  const { from = 0, to = 1, start = 0, velocity = 0 } = opts;
  const { w0, zeta } = springParams(opts);
  if (t < start) return 0;
  return springState(t - start, from - to, velocity, w0, zeta)[1];
}

/** how long a spring takes to stay within `tol` of the travel (s) — to plan
 *  what comes next; the spring itself keeps going (by microns) after it.
 *  Infinity for an undamped spring, which never does */
/** @param {SpringOpts} [opts] @param {number} [tol] */
export function springSettle(opts = {}, tol = 0.01) {
  const { from = 0, to = 1, velocity = 0 } = opts;
  const { w0, zeta } = springParams(opts);
  const span = Math.abs(from - to) || Math.abs(velocity) / w0 || 1;
  // the envelope decays at ζω0 (swinging) or the slow root (creeping); with
  // no damping it never settles. Look as far as the envelope needs.
  const rate = zeta < 1 ? zeta * w0 : w0 * (zeta - Math.sqrt(zeta * zeta - 1));
  if (!(rate > 0)) return Infinity;
  const horizon = (Math.log(1 / tol) + 8) / rate + 8 / w0;
  let last = 0;
  const step = horizon / 30000;
  for (let tau = 0; tau < horizon; tau += step) {
    const [x, v] = springState(tau, from - to, velocity, w0, zeta);
    if (Math.abs(x) > tol * span || Math.abs(v) / w0 > tol * span) last = tau;
    else if (tau - last > 4 / w0) break; // quiet for well over a swing
  }
  return last;
}

/** a spring step squeezed to land exactly at p = 1: an ease for a move that
 *  must end on time (a handoff) and still land like a spring. ζ 1 by default:
 *  no swing; a lower damping (or `overshoot`) swings past and back */
/** @param {number} p @param {{ damping?: number, overshoot?: number }} [opts] */
export function settle(p, opts = {}) {
  if (p <= 0) return 0;
  if (p >= 1) return 1;
  const zeta = opts.overshoot != null ? dampingFor(opts.overshoot) : (opts.damping ?? 1);
  // ω0 = 1, run to the 0.1 % band (ln 1000 over the slowest decay rate: ζ
  // when it swings, the slow root ζ − √(ζ² − 1) when it creeps), then
  // normalised so the end value is exactly 1 — no snap. A swinging one is
  // run on to the next turn past the rest: it ends at rest there (no speed
  // to snap off) and the end value is ≥ 1, so the normalising never divides
  // by ≈ 0, even with next to no damping
  const rate = zeta < 1 ? zeta : zeta - Math.sqrt(zeta * zeta - 1);
  let T = Math.log(1000) / Math.max(0.05, rate);
  if (zeta < 1 - 1e-6) {
    const half = Math.PI / Math.sqrt(1 - zeta * zeta); // its turns are half a period apart
    T = (2 * Math.ceil((T / half - 1) / 2) + 1) * half; // the first odd turn at or after T
  }
  const end = 1 + springState(T, -1, 0, 1, zeta)[0];
  return (1 + springState(p * T, -1, 0, 1, zeta)[0]) / end;
}

// --- entrances and exits ----------------------------------------------------

// The opacity finishes once 60 % of the travel is covered: the element is
// solid while it is still visibly moving, so the eye reads a landing; an
// opacity that runs as long as the travel reads as a fade with a drift.
const LEAD = 0.6;
// An exit lasts 0.32 s: about half an entrance's settle (0.57 s) — leaving
// should not hold the eye — and still ≈ 19 frames, so it is seen to go.
const EXIT_DUR = 0.32;

/**
 * Rises (or slides) into place: the position springs from an offset to 0 and
 * the opacity, tied to the travel, arrives first.
 * @param {number} t
 * @param {number} start
 * @param {SpringOpts & { dx?: number, dy?: number, lead?: number }} [opts]
 *   dx/dy: the offset it comes from (default 0, 24 px below — about one line
 *   of 20 px text, far enough to read as a move); lead: the share of the travel
 *   by which it is solid (default 0.6)
 */
export function rise(t, start, opts = {}) {
  const { dx = 0, dy = 24, lead = LEAD } = opts;
  const p = spring(t, { ...opts, from: 0, to: 1, start });
  return { x: dx * (1 - p), y: dy * (1 - p), opacity: easeOut(p / lead), p };
}

/**
 * Leaves the way a rise came, continued: it accelerates away and the opacity
 * trails the position (the reverse of a rise: it moves, then goes).
 * @param {number} t
 * @param {number} start
 * @param {{ dx?: number, dy?: number, dur?: number, lead?: number }} [opts] dy default −24 (up and out)
 */
export function riseOut(t, start, opts = {}) {
  const { dx = 0, dy = -24, dur = EXIT_DUR, lead = LEAD } = opts;
  const p = easeIn((t - start) / dur);
  return { x: dx * p, y: dy * p, opacity: 1 - smooth((p - (1 - lead)) / lead), p };
}

/**
 * Pops into being: the scale springs up past full size and back.
 * @param {number} t
 * @param {number} start
 * @param {SpringOpts & { scale?: number }} [opts] scale: where it starts
 *   (default 0.6 — big enough that a 40 % growth reads as a pop, not a zoom);
 *   default overshoot 0.12 (≈ 5 % past full size at 0.6 → 1, visible)
 */
export function pop(t, start, opts = {}) {
  const { scale: s0 = 0.6 } = opts;
  const o = opts.damping == null && opts.friction == null ? { overshoot: 0.12, ...opts } : opts;
  const p = spring(t, { freq: 2.2, ...o, from: 0, to: 1, start });
  // the pop is a quick event; its opacity is done by a third of the growth
  return { scale: lerp(s0, 1, p), opacity: easeOut(p / 0.35), p };
}

/**
 * Pops out: a small swell (anticipation), then it shrinks away.
 * @param {number} t
 * @param {number} start
 * @param {{ scale?: number, dur?: number, swell?: number }} [opts] scale: where it ends (default 0.6);
 *   swell: how far past full size it grows first (default 0.04)
 */
export function popOut(t, start, opts = {}) {
  const { scale: s1 = 0.6, dur = EXIT_DUR * 0.8, swell = 0.04 } = opts;
  const u = clamp01((t - start) / dur);
  // the first quarter swells, the rest shrinks from the swell, accelerating
  const scale =
    u < 0.25 ? 1 + swell * smooth(u / 0.25) : lerp(1 + swell, s1, easeIn((u - 0.25) / 0.75));
  return { scale, opacity: 1 - smooth((u - 0.4) / 0.6), p: u };
}

/**
 * Drops in from above and lands: it stretches along its fall with its speed
 * and squashes as it sinks into the landing, keeping its area (sx = 1 / sy).
 * @param {number} t
 * @param {number} start
 * @param {SpringOpts & { height?: number, squash?: number }} [opts] height:
 *   how far above it starts (default 120 px); squash: how much it deforms at
 *   full speed and at the bottom of the landing (default 0.18 — a cartoon's is ≈ 0.3–0.5, text
 *   stays legible to ≈ 0.2); default damping 0.45 (one clear bounce)
 */
export function drop(t, start, opts = {}) {
  const { height = 120, squash = 0.18 } = opts;
  const o = { freq: 1.8, damping: 0.45, ...opts, from: -height, to: 0, start };
  const { w0, zeta } = springParams(o);
  const [x, v] = springState(t - start, -height, 0, w0, zeta);
  // Stretch: the speed against ω0·h (the most a spring released from h can
  // reach). Squash: how far it is pressed past its rest (into the landing),
  // against how deep the first swing goes — 1 at the bottom. Both are
  // shares, so the look does not depend on the drop's size or frequency; the
  // squash is 0 at the rest and follows the depth both ways, so the shape
  // never jumps. An overdamped drop never passes its rest: no squash.
  const h = Math.max(1e-9, Math.abs(height));
  const stretch = Math.abs(v) / (w0 * h);
  const os = zeta < 1 ? Math.exp((-zeta * Math.PI) / Math.sqrt(1 - zeta * zeta)) : 0;
  const past = height >= 0 ? x : -x; // > 0 beyond the rest, on the far side from where it fell
  const braking = os > 0 && past > 0 ? past / (os * h) : 0;
  const sy = Math.max(0.2, 1 + squash * (stretch - braking));
  const started = t >= start;
  return {
    y: x,
    sx: 1 / sy,
    sy,
    opacity: started ? clamp01(Math.abs(x + height) / (h * 0.15)) : 0,
  };
}

/**
 * Falls away below, stretching as it speeds up.
 * @param {number} t
 * @param {number} start
 * @param {{ depth?: number, dur?: number, squash?: number }} [opts] depth: how far it falls (default 160 px)
 */
export function dropOut(t, start, opts = {}) {
  const { depth = 160, dur = EXIT_DUR * 1.25, squash = 0.18 } = opts;
  const u = clamp01((t - start) / dur);
  const p = u * u; // falling: constant acceleration
  const sy = 1 + squash * u; // speed grows linearly with time
  return { y: depth * p, sx: 1 / sy, sy, opacity: 1 - smooth((u - 0.5) / 0.5) };
}

/**
 * Rises out of its own line: it slides up from below a mask the size of its
 * own box, so it needs no wrapper. Put `y` in a translate and `clip` in
 * clip-path on the same element.
 * @param {number} t
 * @param {number} start
 * @param {SpringOpts & { height: number }} opts height: the element's own height (px).
 *   Default damping 0.85: a swing past the line would be cut by the mask's top
 */
export function maskRise(t, start, opts) {
  const { height } = opts;
  const p = spring(t, { damping: 0.85, freq: 1.5, ...opts, from: 0, to: 1, start });
  const y = height * (1 - p);
  // translated down by y, the part of the element still inside its own box is its top h − y
  return { y, clip: `inset(0px 0px ${Math.max(0, Math.min(height, y)).toFixed(2)}px 0px)`, p };
}

/**
 * Sinks back into its line: the reverse of maskRise (or, with `up`, leaves through the top).
 * @param {number} t
 * @param {number} start
 * @param {{ height: number, dur?: number, up?: boolean }} opts
 */
export function maskOut(t, start, opts) {
  const { height, dur = EXIT_DUR, up = false } = opts;
  const p = easeIn((t - start) / dur);
  const d = Math.min(height, height * p);
  return up
    ? { y: -d, clip: `inset(${d.toFixed(2)}px 0px 0px 0px)`, p }
    : { y: d, clip: `inset(0px 0px ${d.toFixed(2)}px 0px)`, p };
}

// Typing: 16 characters a second by default. A fast real typist is ≈ 8 cps
// (100 wpm); a film shows the typing, not the typist, so it runs at about
// twice that — a 40-character query takes 2.5 s, a sentence a viewer can
// follow being written.
const TYPE_CPS = 16;

/** a small seeded random generator (mulberry32), so a cadence is the same on every frame */
/** @param {number} seed */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let x = a;
    x = Math.imul(x ^ (x >>> 15), x | 1);
    x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

/** @type {Map<string, number[]>} */
const typeCache = new Map();

/**
 * When each character of `text` appears (s, absolute), typed from `start`.
 * Also the times to put key sounds on. With `human`, the gaps vary: a word
 * boundary or punctuation takes longer, gaps inside a word are uneven
 * (a seeded, so repeatable, spread); the average rate stays `cps`.
 * @param {string} text
 * @param {number} start
 * @param {{ cps?: number, human?: boolean, seed?: number }} [opts]
 */
export function typeTimes(text, start, opts = {}) {
  const { cps = TYPE_CPS, human = false, seed = 1 } = opts;
  if (!(cps > 0)) throw new Error(`type: cps must be above 0 (${cps})`);
  const chars = Array.from(text);
  const key = `${text}\u0000${cps}\u0000${human}\u0000${seed}`;
  let gaps = typeCache.get(key);
  if (!gaps) {
    const rand = rng(seed);
    gaps = chars.map((ch, i) => {
      if (!human || i === 0) return 1;
      const prev = /** @type {string} */ (chars[i - 1]);
      // a lognormal-ish spread inside a word (×0.6–1.5), longer after a word
      // (×1.8) and after punctuation (×2.6): where a typist's hand pauses
      let g = Math.exp((rand() + rand() - 1) * 0.45);
      if (prev === " ") g *= 1.8;
      else if (/[.,;:!?]/.test(prev)) g *= 2.6;
      else if (ch === " ") g *= 0.85;
      return g;
    });
    // normalise the gaps after the first key to the asked rate
    const rest = gaps.slice(1).reduce((s, g) => s + g, 0);
    const scale = rest > 0 ? (gaps.length - 1) / rest : 1;
    gaps = gaps.map((g, i) => (i === 0 ? 0 : g * scale));
    if (typeCache.size > 256) typeCache.clear();
    typeCache.set(key, gaps);
  }
  /** @type {number[]} */
  const times = [];
  let at = start;
  for (const g of gaps) {
    at += g / cps;
    times.push(at);
  }
  return times;
}

/**
 * Text typed over time: `text` is what shows at t. The first character
 * appears at `start`.
 * @param {number} t
 * @param {number} start
 * @param {string} text
 * @param {{ cps?: number, human?: boolean, seed?: number }} [opts]
 */
export function type(t, start, text, opts = {}) {
  const times = typeTimes(text, start, opts);
  let n = 0;
  while (n < times.length && /** @type {number} */ (times[n]) <= t + 1e-9) n++;
  const chars = Array.from(text);
  return {
    text: chars.slice(0, n).join(""),
    count: n,
    done: n === chars.length,
    /** when the last shown character appeared (s), for a caret's blink or a key sound */
    lastAt: n > 0 ? /** @type {number} */ (times[n - 1]) : null,
  };
}

/**
 * Text deleted from the end, as a held backspace does: steady and faster
 * than typing (default 30 cps — a key's auto-repeat rate).
 * @param {number} t
 * @param {number} start
 * @param {string} text
 * @param {{ cps?: number }} [opts]
 */
export function untype(t, start, text, opts = {}) {
  const { cps = 30 } = opts;
  const chars = Array.from(text);
  const gone = t < start ? 0 : Math.min(chars.length, Math.floor((t - start) * cps + 1e-9) + 1);
  return {
    text: chars.slice(0, chars.length - gone).join(""),
    count: chars.length - gone,
    done: gone === chars.length,
  };
}

// --- handoffs ---------------------------------------------------------------

/** progress through a window [start, end] through an ease */
/** @param {number} t @param {number} start @param {number} end @param {(p: number) => number} ease */
const windowP = (t, start, end, ease) =>
  end > start ? ease(clamp01((t - start) / (end - start))) : t >= end ? 1 : 0;

/** the default handoff ease: a critically damped spring landing exactly on `end` */
/** @param {number} p */
const handoffEase = (p) => settle(p);

/**
 * One box grows (or shrinks) into another between `start` and `end`: a
 * button becoming the page, a card becoming a panel. The sizes change in
 * log space (a 10× growth looks steady instead of fast-then-slow), the
 * centre and the corner radius change with the same progress.
 * @param {number} t
 * @param {number} start
 * @param {number} end
 * @param {RectLike} from
 * @param {RectLike} to
 * @param {{ ease?: (p: number) => number, log?: boolean }} [opts] log: false for linear sizes
 * @returns {Rect & { p: number }}
 */
export function morphRect(t, start, end, from, to, opts = {}) {
  const { ease = handoffEase, log = true } = opts;
  const a = rectOf(from);
  const b = rectOf(to);
  const p = windowP(t, start, end, ease);
  const size = /** @param {number} u @param {number} v */ (u, v) =>
    log && u > 0 && v > 0 ? u * (v / u) ** p : lerp(u, v, p);
  const w = size(a.w, b.w);
  const h = size(a.h, b.h);
  const cx = lerp(a.x + a.w / 2, b.x + b.w / 2, p);
  const cy = lerp(a.y + a.h / 2, b.y + b.h / 2, p);
  return { x: cx - w / 2, y: cy - h / 2, w, h, r: lerp(a.r, b.r, p), p };
}

/**
 * A rect as a CSS clip-path for an element whose box is `frame` (its own
 * size, or, with x/y, where it sits in the rect's coordinates).
 * @param {RectLike} rect
 * @param {Frame} frame
 */
export function rectClip(rect, frame) {
  const i = inset(rect, frame);
  const px = /** @param {number} v */ (v) => `${v.toFixed(2)}px`;
  const round = i.r > 0 ? ` round ${px(i.r)}` : "";
  return `inset(${px(i.top)} ${px(i.right)} ${px(i.bottom)} ${px(i.left)}${round})`;
}

/**
 * How far a rect sits inside a frame on each side (px) — the numbers of a
 * CSS inset(), for a canvas or anything else.
 * @param {RectLike} rect
 * @param {Frame} frame
 */
export function inset(rect, frame) {
  const r = rectOf(rect);
  const f = rectOf({ x: 0, y: 0, ...frame });
  const fx = f.x;
  const fy = f.y;
  return {
    top: r.y - fy,
    right: fx + f.w - (r.x + r.w),
    bottom: fy + f.h - (r.y + r.h),
    left: r.x - fx,
    r: r.r,
  };
}

/**
 * A circle opening from a point until it covers the frame: the radius
 * reaches the farthest corner, so at `end` nothing of the frame is left out.
 * Ease is on the radius, smootherstep by default: the area (∝ r²) then
 * opens slowly, grows fast through the middle and arrives without a snap.
 * @param {number} t
 * @param {number} start
 * @param {number} end
 * @param {Pt} at the centre
 * @param {{ width: number, height: number }} frame
 * @param {{ ease?: (p: number) => number, from?: number, to?: number, close?: boolean }} [opts]
 *   from/to: radii instead of 0 → covering; close: run it backwards (covering → 0)
 */
export function iris(t, start, end, at, frame, opts = {}) {
  const { ease = smooth, close = false } = opts;
  const cover = Math.max(
    Math.hypot(at.x, at.y),
    Math.hypot(frame.width - at.x, at.y),
    Math.hypot(at.x, frame.height - at.y),
    Math.hypot(frame.width - at.x, frame.height - at.y),
  );
  const r0 = opts.from ?? 0;
  const r1 = opts.to ?? cover;
  const p = windowP(t, start, end, ease);
  const r = close ? lerp(r1, r0, p) : lerp(r0, r1, p);
  return { r, clip: `circle(${r.toFixed(2)}px at ${at.x.toFixed(2)}px ${at.y.toFixed(2)}px)`, p };
}

/**
 * The picture flies into a rect until it fills the view: one scale about a
 * fixed point, changing in log space, so every step of the zoom looks the
 * same size — a straight flight in, not a lurch then a crawl. Put
 * `transform` on the layer (transform-origin 0 0) whose coordinates `rect` is in.
 * @param {number} t
 * @param {number} start
 * @param {number} end
 * @param {RectLike} rect what to fly into
 * @param {{ width: number, height: number }} view the picture
 * @param {{ ease?: (p: number) => number, fit?: "cover" | "contain", through?: number }} [opts]
 *   fit: the rect covers the view at the end (default — what a handoff into it
 *   needs) or fits inside it; through: keep zooming past it by this factor
 */
export function zoomThrough(t, start, end, rect, view, opts = {}) {
  const { ease = smooth, fit = "cover", through = 1 } = opts;
  const r = rectOf(rect);
  const sx = view.width / Math.max(1e-9, r.w);
  const sy = view.height / Math.max(1e-9, r.h);
  const S = (fit === "cover" ? Math.max(sx, sy) : Math.min(sx, sy)) * through;
  // the end transform maps the rect's centre c to the view's centre v:
  // x' = S·(x − c) + v. A pure scale about f that ends there needs
  // f = S·(f − c) + v, so f = (S·c − v) / (S − 1).
  const c = { x: r.x + r.w / 2, y: r.y + r.h / 2 };
  const v = { x: view.width / 2, y: view.height / 2 };
  const p = windowP(t, start, end, ease);
  const scale = S ** p;
  /** @type {Pt} */
  let f;
  let tx;
  let ty;
  if (Math.abs(S - 1) < 1e-9) {
    // no zoom: a slide from c to v
    f = c;
    tx = (v.x - c.x) * p;
    ty = (v.y - c.y) * p;
  } else {
    f = { x: (S * c.x - v.x) / (S - 1), y: (S * c.y - v.y) / (S - 1) };
    tx = (1 - scale) * f.x;
    ty = (1 - scale) * f.y;
  }
  return {
    scale,
    x: tx,
    y: ty,
    origin: f,
    transform: `translate(${tx.toFixed(3)}px, ${ty.toFixed(3)}px) scale(${scale.toFixed(5)})`,
    p,
  };
}

/**
 * Items converge on one place, one after another: a ripple of arrivals.
 * Each leaves `stagger` s after the one before (in `order`) and travels
 * `dur` s; with `scale`, it ends at that size.
 * @param {number} t
 * @param {number} start
 * @param {Pt[]} from where each item starts
 * @param {Pt} to where they gather
 * @param {{ dur?: number, stagger?: number, ease?: (p: number) => number, scale?: number, order?: "index" | "far" | "near" }} [opts]
 *   stagger default 0.04 s: under a frame apart they arrive as one block, over
 *   ≈ 0.1 s they read as a queue; 0.04 (2–3 frames) reads as a ripple.
 *   dur default 0.5 s; ease default smootherstep; order: by index, farthest first, or nearest first
 */
export function gather(t, start, from, to, opts = {}) {
  const { dur = 0.5, stagger = 0.04, ease = smooth, scale = 1, order = "index" } = opts;
  const rank = from.map((_, i) => i);
  if (order !== "index") {
    const d = from.map((q) => Math.hypot(q.x - to.x, q.y - to.y));
    rank.sort((i, j) => (order === "far" ? (d[j] ?? 0) - (d[i] ?? 0) : (d[i] ?? 0) - (d[j] ?? 0)));
  }
  /** @type {number[]} */
  const slot = new Array(from.length).fill(0);
  rank.forEach((i, k) => {
    slot[i] = k;
  });
  return from.map((q, i) => {
    const p = ease(clamp01((t - start - (slot[i] ?? 0) * stagger) / dur));
    return { x: lerp(q.x, to.x, p), y: lerp(q.y, to.y, p), scale: lerp(1, scale, p), p };
  });
}

/**
 * Hops from one point to another along an arc (a parabola — the path of a
 * thrown thing), `height` px above the straight line at its middle.
 * @param {number} t
 * @param {number} start
 * @param {number} end
 * @param {Pt} from
 * @param {Pt} to
 * @param {{ height?: number, ease?: (p: number) => number }} [opts] default height 80 px; ease: along the path (default smootherstep)
 */
export function hop(t, start, end, from, to, opts = {}) {
  const { height = 80, ease = smooth } = opts;
  const p = windowP(t, start, end, ease);
  return {
    x: lerp(from.x, to.x, p),
    // 4h·p(1−p) peaks at h in the middle
    y: lerp(from.y, to.y, p) - 4 * height * p * (1 - p),
    p,
  };
}

// --- contact ----------------------------------------------------------------

/**
 * A button pressed at `at`: it sinks fast and comes back on a spring with a
 * small swing. Use `scale` (about its centre) and/or `y`.
 * @param {number} t
 * @param {number} at when it is pressed (s)
 * @param {{ depth?: number, sink?: number, hold?: number, freq?: number, damping?: number, drop?: number }} [opts]
 *   depth: how much smaller it gets (default 0.06 — a 200 px button loses
 *   12 px, plainly seen; most interfaces use 0.02–0.05, a film reads smaller);
 *   sink: how long going down takes (default 0.07 s ≈ 4 frames, a click's
 *   travel); hold: how long it stays down before release (default 0.05 s);
 *   drop: how many px it moves down at the bottom (default 2)
 */
export function press(t, at, opts = {}) {
  const { depth = 0.06, sink = 0.07, hold = 0.05, freq = 3, damping = 0.5, drop = 2 } = opts;
  const up = at + sink + hold;
  let d; // 0 at rest, 1 fully down
  if (t < at) d = 0;
  else if (t < up) d = easeOut((t - at) / sink);
  else d = spring(t, { from: 1, to: 0, start: up, freq, damping });
  return { scale: 1 - depth * d, y: drop * d, down: d };
}

/**
 * A hit at `at`: a kick that rings down — an offset along `angle` and a
 * scale bump, both shaped as a struck spring (0 at the hit, out to `amount`,
 * back through 0, smaller each time).
 * @param {number} t
 * @param {number} at
 * @param {{ amount?: number, angle?: number, scale?: number, freq?: number, damping?: number }} [opts]
 *   amount: the first swing (default 10 px); angle: its direction in degrees
 *   (default 90, down — what is hit gives way); scale: the scale bump at the
 *   first swing (default 0.03); freq default 7 Hz and damping 0.35: the first
 *   swing peaks ≈ 30 ms after the hit (2 frames — instant to the eye) and
 *   the ring is under 5 % of that swing in ≈ 0.23 s, so it reads as one hit, not a wobble
 */
export function impact(t, at, opts = {}) {
  const { amount = 10, angle = 90, scale = 0.03, freq = 7, damping = 0.35 } = opts;
  const w0 = 2 * Math.PI * freq;
  const zeta = Math.min(damping, 0.999);
  const wd = w0 * Math.sqrt(1 - zeta * zeta);
  // the impulse response e^(−ζω0τ)·sin(ωdτ), normalised by its first peak
  // (at τp = atan(ωd / ζω0) / ωd) so `amount` is exactly the first swing
  const tp = Math.atan2(wd, zeta * w0) / wd;
  const peak = Math.exp(-zeta * w0 * tp) * Math.sin(wd * tp);
  const tau = t - at;
  const k = tau <= 0 ? 0 : (Math.exp(-zeta * w0 * tau) * Math.sin(wd * tau)) / peak;
  const rad = (angle * Math.PI) / 180;
  return { x: amount * k * Math.cos(rad), y: amount * k * Math.sin(rad), scale: 1 + scale * k, k };
}

// --- numbers and parts ------------------------------------------------------

/**
 * @typedef {object} NumberFormat how a number is written: what comes before
 *   and after it, the mark between thousands ("" for none) and before the
 *   decimals, how many decimals
 * @property {string} prefix e.g. "$"
 * @property {string} suffix e.g. "%", "+", " 萬"
 * @property {string} sep e.g. ",", ".", " ", ""
 * @property {string} point e.g. ".", ","
 * @property {number} decimals
 * @property {string} [minus] the sign a negative number is written with ("-", "−")
 */

/**
 * A number as written, read back: "$4,466" → 4466 with prefix "$" and
 * separator ","; "12.5%" → 12.5, one decimal, suffix "%"; "1.234,56 €" →
 * 1234.56. One mark that occurs once with three digits after it is a
 * thousands separator if it is "," (or a space or an apostrophe), a decimal
 * point if it is "." — say `sep` / `point` when the product writes it the
 * other way. A plain number has no prefix, suffix or separator.
 * @param {string | number} s
 * @param {Partial<NumberFormat>} [o] what to take as given instead of reading it
 * @returns {{ value: number } & NumberFormat}
 */
export function readNumber(s, o = {}) {
  if (typeof s === "number") {
    if (!Number.isFinite(s)) throw new Error(`count: ${s} is not a number`);
    const dec = String(s).split(".")[1]?.length ?? 0;
    return {
      value: s,
      prefix: o.prefix ?? "",
      suffix: o.suffix ?? "",
      sep: o.sep ?? "",
      point: o.point ?? ".",
      decimals: o.decimals ?? dec,
      minus: o.minus ?? "-",
    };
  }
  const m = /^(.*?)([-−]?)(\d(?:[\d.,'’   ]*\d)?)(.*)$/su.exec(String(s));
  if (!m) throw new Error(`count: "${s}" has no number in it`);
  const [, before = "", minus = "", body = "", after = ""] = m;
  const marks = [...new Set(body.replace(/\d/g, ""))];
  let sep = "";
  let point = ".";
  if (o.sep != null || o.point != null) {
    sep = o.sep ?? "";
    point = o.point ?? (sep === "." ? "," : ".");
  } else if (marks.length >= 2) {
    // the last mark is the decimal point, the other the thousands
    point = /** @type {string} */ (body.replace(/\d/g, "").slice(-1));
    sep = /** @type {string} */ (marks.find((c) => c !== point));
  } else if (marks.length === 1) {
    const c = /** @type {string} */ (marks[0]);
    const groups = body.split(c);
    const last = groups[groups.length - 1] ?? "";
    if (groups.length > 2 || (c !== "." && c !== ",")) sep = c;
    else if (c === ".") point = c;
    else if (last.length === 3) sep = c;
    else point = c;
  }
  const esc = (/** @type {string} */ c) => c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const plain = (sep ? body.replace(new RegExp(esc(sep), "g"), "") : body).replace(point, ".");
  const value = Number(plain) * (minus ? -1 : 1);
  if (!Number.isFinite(value)) throw new Error(`count: "${s}" does not read as a number`);
  const dec = plain.includes(".") ? (plain.split(".")[1]?.length ?? 0) : 0;
  return {
    value,
    prefix: o.prefix ?? before,
    suffix: o.suffix ?? after,
    sep,
    point,
    decimals: o.decimals ?? dec,
    minus: o.minus ?? (minus || "-"),
  };
}

/**
 * A number written the way `f` writes them.
 * @param {number} v
 * @param {NumberFormat} f
 */
export function writeNumber(v, f) {
  const fixed = Math.abs(v).toFixed(Math.max(0, Math.min(20, f.decimals)));
  const [int = "0", frac] = fixed.split(".");
  const grouped = f.sep ? int.replace(/\B(?=(\d{3})+(?!\d))/g, f.sep) : int;
  const neg = v < 0 && Number(fixed) !== 0 ? (f.minus ?? "-") : "";
  return `${f.prefix}${neg}${grouped}${frac != null ? f.point + frac : ""}${f.suffix}`;
}

// A count runs 1 s by default: at 60 fps that is 60 frames of numbers
// changing — enough for the eye to see a run, not a flicker — and it lands
// on a critically damped spring, so it slows into its last value and never
// shows a digit past it.
const COUNT_DUR = 1;

/**
 * A number running from one value to another, written the product's way:
 * the format is read from `to` ("$4,466": prefix "$", "," between
 * thousands, no decimals) — or from `from` for what `to` does not show —
 * and every value along the way is written in it. `from` may be a number
 * (0) or a string as the product wrote it. `steps`: how many values it
 * shows along the way (an odometer feel); `ease`: the run's shape (default:
 * lands without overshoot); `dur` s long (default 1).
 *
 *   part.text(count(t, 4, "$4,212", "$4,466").text);
 * @param {number} t
 * @param {number} start
 * @param {string | number} from
 * @param {string | number} to
 * @param {{ dur?: number, ease?: (p: number) => number, steps?: number } & Partial<NumberFormat>} [opts]
 * @returns {{ text: string, value: number, p: number }}
 */
export function count(t, start, from, to, opts = {}) {
  const { dur = COUNT_DUR, ease = settle, steps, ...given } = opts;
  if (!(dur > 0)) throw new Error(`count: dur must be above 0 (${dur})`);
  const b = readNumber(to, given);
  const a = readNumber(from, typeof from === "number" ? { ...b, ...given } : given);
  /** @type {NumberFormat} */
  const f = {
    prefix: b.prefix || a.prefix,
    suffix: b.suffix || a.suffix,
    sep: b.sep || a.sep,
    point: b.point,
    decimals: given.decimals ?? Math.max(b.decimals, typeof from === "number" ? 0 : a.decimals),
    minus: b.minus,
  };
  let p = clamp01(ease(clamp01((t - start) / dur)));
  if (steps != null && steps > 0) p = Math.floor(p * steps + 1e-9) / steps;
  const k = 10 ** f.decimals;
  const value = Math.round((a.value + (b.value - a.value) * p) * k) / k;
  return { text: writeNumber(value, f), value, p };
}

// --- a line, a figure, landing -----------------------------------------------

const GLYPHS = "ABCDEFGHJKLMNPQRSTUVWXYZ0123456789#$%&*+?<>/";

/** a seeded integer in [0, n) for (a, b, seed): the same every render */
/** @param {number} a @param {number} b @param {number} seed @param {number} n */
function pick(a, b, seed, n) {
  let h = Math.imul(a ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(b + 0x632be5ab, 0xc2b2ae35) ^ seed;
  h ^= h >>> 15;
  h = Math.imul(h, 0x2c1b3c6d);
  h ^= h >>> 12;
  return (h >>> 0) % n;
}

/**
 * A line resolving out of random glyphs: each character cycles through
 * `glyphs` until its lock time, then holds — left to right (or `from:
 * "right"`), `each` s apart, the first after `lead` s. The glyph shown
 * changes `rate` times a second and is seeded by the character and that
 * step, so any frame renders the same. Spaces stay spaces; characters
 * outside the glyph set's script (Chinese, say) cycle through `glyphs` too
 * unless `keep` says which to leave. Defaults from films measured: the first
 * locks after 0.2 s, then one every 0.05 s, glyphs changing 30 times a second.
 *
 *   el.textContent = scramble(t, 3, "$990").text;
 * @param {number} t
 * @param {number} start
 * @param {string} text what it lands on
 * @param {{ each?: number, lead?: number, rate?: number, glyphs?: string, seed?: number,
 *   from?: "left" | "right", keep?: RegExp }} [opts]
 * @returns {{ text: string, locked: number, done: boolean }}
 */
export function scramble(t, start, text, opts = {}) {
  const { each = 0.05, lead = 0.2, rate = 30, glyphs = GLYPHS, seed = 1, from = "left" } = opts;
  const keep = opts.keep ?? /\s/;
  const chars = Array.from(text);
  const n = chars.length;
  if (t < start) return { text: "", locked: 0, done: false };
  const step = Math.floor((t - start) * rate);
  let locked = 0;
  const out = chars.map((c, i) => {
    const k = from === "right" ? n - 1 - i : i;
    if (keep.test(c) || t >= start + lead + k * each) {
      locked++;
      return c;
    }
    return glyphs[pick(i, step, seed, glyphs.length)];
  });
  return { text: out.join(""), locked, done: locked === n };
}

/** an ease-out that runs past the end by `overshoot` of the travel and comes
 *  back (the "back" ease, its constant solved for the overshoot asked): a
 *  roll that slows into place, unlike a spring step, which is most of the
 *  way there in its first fifth */
/** @param {number} overshoot */
function backOut(overshoot) {
  const f = (/** @type {number} */ c, /** @type {number} */ p) =>
    1 + (c + 1) * (p - 1) ** 3 + c * (p - 1) ** 2;
  // the peak of f is at p = 1 − 2c / (3(c + 1)); bisect c for the overshoot
  const peak = (/** @type {number} */ c) => f(c, 1 - (2 * c) / (3 * (c + 1))) - 1;
  let lo = 0;
  let hi = 10;
  if (!(overshoot > 0)) return (/** @type {number} */ p) => 1 - (1 - clamp01(p)) ** 3;
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    if (peak(mid) < overshoot) lo = mid;
    else hi = mid;
  }
  const c = (lo + hi) / 2;
  return (/** @type {number} */ p) => (p <= 0 ? 0 : p >= 1 ? 1 : f(c, p));
}

/**
 * Digits rolling into place like an odometer: each digit column spins from
 * its old digit to its new one (going round `laps` extra times), the
 * columns landing left to right `each` s apart, each over `dur` s, with a
 * small overshoot. A column's `pos` is how far down its strip of digits it
 * is (in digit heights; 0–9 then 0 again …): translate a strip of
 * "0123456789" stacked `laps + 2` times by −pos em. `blur` is its speed in
 * digit heights a second, for a vertical motion blur. Non-digits (",", "$")
 * come back as fixed columns. The format of `to` is kept: "1,240" lands as
 * "1,240". From films measured: columns 0.15 s apart, ≈5 % overshoot.
 * @param {number} t
 * @param {number} start
 * @param {string | number} to
 * @param {{ from?: string | number, each?: number, dur?: number, laps?: number, overshoot?: number,
 *   order?: "left" | "right" }} [opts]
 * @returns {{ columns: { char: string, digit: boolean, pos: number, value: number, speed: number }[], text: string, done: boolean }}
 */
export function odometer(t, start, to, opts = {}) {
  const { each = 0.15, dur = 0.6, laps = 1, overshoot = 0.05, order = "left" } = opts;
  const target = String(to);
  const fromStr = opts.from == null ? "" : String(opts.from);
  const digitsTo = Array.from(target).filter((c) => /\d/.test(c)).length;
  // the old value's digits, right-aligned against the new ones
  const fromDigits = Array.from(fromStr).filter((c) => /\d/.test(c));
  const pad = Array(Math.max(0, digitsTo - fromDigits.length)).fill("0");
  const old = [...pad, ...fromDigits].slice(-digitsTo || 0);
  const ease = backOut(overshoot);
  let d = -1;
  const chars = Array.from(target);
  const columns = chars.map((c) => {
    if (!/\d/.test(c)) return { char: c, digit: false, pos: 0, value: 0, speed: 0 };
    d++;
    const k = order === "left" ? d : digitsTo - 1 - d;
    const a = Number(old[d] ?? 0);
    const b = Number(c);
    const span = ((b - a + 10) % 10) + laps * 10;
    const t0 = start + k * each;
    const p = dur > 0 ? ease(clamp01((t - t0) / dur)) : t >= t0 ? 1 : 0;
    const h = 1 / 240;
    const p2 = dur > 0 ? ease(clamp01((t + h - t0) / dur)) : p;
    const pos = a + span * p;
    return {
      char: c,
      digit: true,
      pos,
      value: ((Math.round(pos) % 10) + 10) % 10,
      speed: (span * (p2 - p)) / h,
    };
  });
  const text = columns.map((c) => (c.digit ? String(c.value) : c.char)).join("");
  return { columns, text, done: t >= start + Math.max(0, digitsTo - 1) * each + dur };
}

/**
 * A split-flap board turning from one value to the next: per character
 * tile, the old character's top half folds down (`top` 1 → 0, a scaleY
 * about the tile's middle) in the first half of `dur`, then the new
 * character's bottom half folds open (`bottom` 0 → 1). Draw each tile as
 * four halves: the new top behind, the old bottom behind, then the folding
 * old top and new bottom. Tiles turn `each` s apart, left to right; the
 * shorter string is padded with spaces on the left. From a film's board:
 * 0.26 s a tile, 0.2 s apart.
 * @param {number} t
 * @param {number} start
 * @param {string | number} from
 * @param {string | number} to
 * @param {{ each?: number, dur?: number }} [opts]
 * @returns {{ tiles: { old: string, now: string, top: number, bottom: number, p: number }[], done: boolean }}
 */
export function flap(t, start, from, to, opts = {}) {
  const { each = 0.2, dur = 0.26 } = opts;
  const a = Array.from(String(from));
  const b = Array.from(String(to));
  const n = Math.max(a.length, b.length);
  while (a.length < n) a.unshift(" ");
  while (b.length < n) b.unshift(" ");
  const tiles = b.map((now, i) => {
    const old = a[i] ?? " ";
    if (old === now) return { old, now, top: 0, bottom: 1, p: 1 };
    const p = dur > 0 ? clamp01((t - (start + i * each)) / dur) : t >= start + i * each ? 1 : 0;
    // gravity on the fold: it leaves slowly and slaps down
    const top = p < 0.5 ? 1 - easeIn(p / 0.5) : 0;
    const bottom = p < 0.5 ? 0 : easeOut((p - 0.5) / 0.5);
    return { old, now, top, bottom, p };
  });
  return { tiles, done: tiles.every((x) => x.p >= 1) };
}

// Parts arrive 0.06 s apart by default: ≈ 4 frames at 60 fps, so each one is
// seen to come on its own (gather's 0.04 reads as one ripple), while five of
// them are all moving within a third of a second — one gesture, not a queue.
const EACH = 0.06;

/** @param {unknown} x @returns {x is HTMLElement} */
const isEl = (x) =>
  !!x &&
  typeof x === "object" &&
  /** @type {{ nodeType?: unknown }} */ (x).nodeType === 1 &&
  "style" in /** @type {object} */ (x);

/**
 * Parts arriving one after another — a list's rows, a card's stat pills, a
 * page's sections: `move` (default rise) run on each, `each` s after the one
 * before, in `order` ("index", or "reverse"). `with`: the move's own options.
 * Returns the move's values, one a part; given elements (a lifted part's
 * `parts()`), it also puts them on each: translate (x, y), scale (scale or
 * sx / sy), opacity and clip — an inline element is made inline-block so it
 * can move — and gives a move that needs one (maskRise, maskOut) the
 * element's height. What the product gave the element is kept: its own
 * transform stays under the move's, its own opacity is multiplied by the
 * move's, and at rest the transform is the product's again.
 *
 *   assemble(t, 5, card.parts(), { each: 0.08, move: pop });
 *   const v = assemble(t, 5, 4);                       // four sets of numbers, for a canvas
 * @param {number} t
 * @param {number} start
 * @param {number | ArrayLike<unknown>} items how many, or the elements
 * @param {{ each?: number, move?: (t: number, start: number, o?: any) => Record<string, unknown>,
 *   with?: Record<string, unknown>, order?: "index" | "reverse" }} [opts]
 */
export function assemble(t, start, items, opts = {}) {
  const { each = EACH, with: w = {}, order = "index" } = opts;
  /** @type {(t: number, start: number, o?: any) => Record<string, unknown>} */
  const move = opts.move ?? rise;
  const list = typeof items === "number" ? Array.from({ length: items }) : Array.from(items);
  const n = list.length;
  return list.map((item, i) => {
    const k = order === "reverse" ? n - 1 - i : i;
    const el = isEl(item) ? item : null;
    // only the masks take the element's height: drop's `height` is how far it falls
    const own =
      el && w.height == null && (move === maskRise || move === maskOut)
        ? { height: el.offsetHeight }
        : {};
    const v = move(t, start + k * each, { ...own, ...w });
    if (el) putOn(el, v);
    return v;
  });
}

/** what the product gave an element before assemble first moved it: its
 *  own transform and opacity (computed), and its inline transform
 * @type {WeakMap<object, { transform: string, opacity: number, inline: string }>} */
const ownStyle = new WeakMap();

/** a move's numbers onto an element's style, over what the product gave it
 * @param {HTMLElement} el @param {Record<string, unknown>} v */
function putOn(el, v) {
  const num = (/** @type {unknown} */ x) =>
    typeof x === "number" && Number.isFinite(x) ? x : null;
  const view = el.ownerDocument?.defaultView;
  let base = ownStyle.get(el);
  if (!base) {
    const cs = view?.getComputedStyle(el);
    const tf = cs?.transform;
    const op = Number(cs?.opacity);
    base = {
      transform: tf && tf !== "none" ? tf : "",
      opacity: Number.isFinite(op) ? op : 1,
      inline: el.style.transform ?? "",
    };
    ownStyle.set(el, base);
    if (cs?.display === "inline") el.style.display = "inline-block";
  }
  const x = num(v.x) ?? 0;
  const y = num(v.y) ?? 0;
  const s = num(v.scale);
  const sx = num(v.sx) ?? s ?? 1;
  const sy = num(v.sy) ?? s ?? 1;
  const parts = [];
  // what rounds to nothing is nothing (a spring's last ten-thousandth of a px)
  if (Math.abs(x) >= 5e-4 || Math.abs(y) >= 5e-4)
    parts.push(`translate(${x.toFixed(3)}px, ${y.toFixed(3)}px)`);
  if (Math.abs(sx - 1) >= 5e-6 || Math.abs(sy - 1) >= 5e-6)
    parts.push(`scale(${sx.toFixed(5)}, ${sy.toFixed(5)})`);
  // the move about the element's own place, the product's transform under it
  el.style.transform = parts.length ? [...parts, base.transform].join(" ").trim() : base.inline;
  const o = num(v.opacity);
  if (o != null) el.style.opacity = String(clamp01(o) * base.opacity);
  if (typeof v.clip === "string") el.style.clipPath = v.clip;
}
