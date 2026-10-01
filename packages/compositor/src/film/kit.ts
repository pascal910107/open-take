// film-kit — small, optional helpers for a film you write as a web page
// (`open-take film`). Copy it next to your page (`open-take film kit`) and
// import what you need:
//
//   import { tempo, reveal, flight, count, rand } from "./film-kit.js";
//
// Every helper is a pure function of its arguments — none keeps state or
// touches the page, except split(), which wraps text in spans once. They do not
// decide anything: what moves, when, how far and how it sounds stays yours.
// Change them, replace them, or ignore them.

// --- time ------------------------------------------------------------------------

/** Seconds of `n` beats at `bpm`. */
export const beat = (n: number, bpm = 120): number => (n * 60) / bpm;

/** A beat grid: picture and score can read the same times.
 *    const T = tempo(96);            // 0.625 s a beat
 *    T.at(3)        → bar 3's downbeat (bars count from 1)
 *    T.at(3, 2)     → bar 3, two beats in
 *    T.beats(6)     → six beats from the start
 *    T.nearest(t)   → the grid time nearest t (every beat; `every` 0.5 = eighths) */
export function tempo(bpm: number, offset = 0) {
  const b = 60 / bpm;
  return {
    bpm,
    beat: b,
    bar: b * 4,
    beats: (n: number) => offset + n * b,
    at: (bar: number, beatInBar = 0) => offset + (bar - 1) * 4 * b + beatInBar * b,
    nearest: (t: number, every = 1) => offset + Math.round((t - offset) / (every * b)) * every * b,
  };
}

// --- shaping ---------------------------------------------------------------------

export const clamp = (x: number, lo = 0, hi = 1): number => Math.min(hi, Math.max(lo, x));
export const lerp = (a: number, b: number, p: number): number => a + (b - a) * p;
/** How far through [start, start + dur] time t is, 0 … 1. */
export const progress = (t: number, start: number, dur: number): number =>
  dur > 0 ? clamp((t - start) / dur) : t >= start ? 1 : 0;

export type Ease = (p: number) => number;

export const ease = {
  linear: ((p) => p) as Ease,
  in: ((p) => p * p * p) as Ease,
  out: ((p) => 1 - (1 - p) ** 3) as Ease,
  inOut: ((p) => (p < 0.5 ? 4 * p * p * p : 1 - (-2 * p + 2) ** 3 / 2)) as Ease,
  outExpo: ((p) => (p >= 1 ? 1 : 1 - 2 ** (-10 * p))) as Ease,
  inOutExpo: ((p) =>
    p <= 0
      ? 0
      : p >= 1
        ? 1
        : p < 0.5
          ? 2 ** (20 * p - 10) / 2
          : (2 - 2 ** (-20 * p + 10)) / 2) as Ease,
  /** overshoots by about 10 % and settles */
  outBack: ((p) => {
    const c = 1.70158;
    return 1 + (c + 1) * (p - 1) ** 3 + c * (p - 1) ** 2;
  }) as Ease,
};

/** A CSS cubic-bezier(x1, y1, x2, y2) as a function of progress. */
export function bezier(x1: number, y1: number, x2: number, y2: number): Ease {
  const at = (a: number, b: number, s: number) =>
    3 * a * s * (1 - s) ** 2 + 3 * b * s * s * (1 - s) + s ** 3;
  const slope = (a: number, b: number, s: number) =>
    3 * a * (1 - s) ** 2 + 6 * (b - a) * s * (1 - s) + 3 * (1 - b) * s * s;
  return (p) => {
    if (p <= 0) return 0;
    if (p >= 1) return 1;
    let s = p;
    for (let i = 0; i < 8; i++) {
      const d = slope(x1, x2, s);
      if (Math.abs(d) < 1e-6) break;
      s -= (at(x1, x2, s) - p) / d;
    }
    // bisection when Newton wandered off [0, 1]
    if (!(s >= 0 && s <= 1)) {
      let lo = 0;
      let hi = 1;
      s = p;
      for (let i = 0; i < 30; i++) {
        if (at(x1, x2, s) < p) lo = s;
        else hi = s;
        s = (lo + hi) / 2;
      }
    }
    return at(y1, y2, s);
  };
}

/** A damped spring released at t = 0 (seconds), from `from` toward `to`:
 *  its value at time t. Stiffness and damping as in CSS/Framer-style springs. */
export function spring(
  t: number,
  {
    from = 0,
    to = 1,
    stiffness = 170,
    damping = 26,
    mass = 1,
  }: {
    from?: number;
    to?: number;
    stiffness?: number;
    damping?: number;
    mass?: number;
  } = {},
): number {
  if (t <= 0) return from;
  const w0 = Math.sqrt(stiffness / mass);
  const z = damping / (2 * Math.sqrt(stiffness * mass));
  const x0 = from - to;
  let x: number;
  if (z < 1) {
    const wd = w0 * Math.sqrt(1 - z * z);
    x = Math.exp(-z * w0 * t) * (x0 * Math.cos(wd * t) + ((z * w0 * x0) / wd) * Math.sin(wd * t));
  } else if (z === 1) x = Math.exp(-w0 * t) * (x0 + w0 * x0 * t);
  else {
    const r1 = -w0 * (z - Math.sqrt(z * z - 1));
    const r2 = -w0 * (z + Math.sqrt(z * z - 1));
    const c2 = (r1 * x0) / (r1 - r2);
    x = (x0 - c2) * Math.exp(r1 * t) + c2 * Math.exp(r2 * t);
  }
  return to + x;
}

// --- entrances and exits -------------------------------------------------------------

export type RevealKind = "fade" | "rise" | "drop" | "scale" | "mask-up" | "mask-left" | "blur";

export type RevealStyle = { opacity: string; transform: string; clipPath: string; filter: string };

/** The style of something appearing at `at` over `dur` seconds (and, with
 *  `out`, leaving): assign it — Object.assign(el.style, reveal(t, { at: 2 })).
 *  `distance` is px for rise/drop, a fraction for scale (0.08 = from 92 %). */
export function reveal(
  t: number,
  {
    at,
    dur = 0.6,
    kind = "rise",
    distance,
    ease: e = ease.out,
    out,
  }: {
    at: number;
    dur?: number;
    kind?: RevealKind;
    distance?: number;
    ease?: Ease;
    out?: { at: number; dur?: number; kind?: RevealKind; ease?: Ease };
  },
): RevealStyle {
  const inP = e(progress(t, at, dur));
  if (out && t >= out.at) {
    const p = (out.ease ?? ease.in)(progress(t, out.at, out.dur ?? dur));
    return shape(out.kind ?? kind, 1 - p, distance, true);
  }
  return shape(kind, inP, distance, false);
}

function shape(
  kind: RevealKind,
  p: number,
  distance: number | undefined,
  leaving: boolean,
): RevealStyle {
  const none = { opacity: "1", transform: "none", clipPath: "none", filter: "none" };
  const q = 1 - p;
  switch (kind) {
    case "fade":
      return { ...none, opacity: String(p) };
    case "rise":
    case "drop": {
      const d = (distance ?? 24) * (kind === "rise" ? 1 : -1) * (leaving ? -1 : 1);
      return { ...none, opacity: String(p), transform: `translateY(${(q * d).toFixed(3)}px)` };
    }
    case "scale":
      return {
        ...none,
        opacity: String(p),
        transform: `scale(${(1 - q * (distance ?? 0.08)).toFixed(5)})`,
      };
    case "mask-up":
      return {
        ...none,
        clipPath: `inset(${(q * 100).toFixed(3)}% 0 0 0)`,
        transform: `translateY(${(q * (distance ?? 12)).toFixed(3)}px)`,
      };
    case "mask-left":
      return { ...none, clipPath: `inset(0 ${(q * 100).toFixed(3)}% 0 0)` };
    case "blur":
      return {
        ...none,
        opacity: String(p),
        filter: `blur(${(q * (distance ?? 12)).toFixed(3)}px)`,
      };
  }
}

/** Wrap an element's text in one span per character (or word), once; returns
 *  the spans — e.g. to reveal them one after another with stagger(). */
export function split(el: HTMLElement, by: "chars" | "words" = "chars"): HTMLElement[] {
  if (el.dataset.split !== by) {
    const text = el.textContent ?? "";
    const parts = by === "words" ? text.split(/(\s+)/) : Array.from(text);
    el.textContent = "";
    for (const part of parts) {
      if (by === "words" && /^\s+$/.test(part)) {
        el.append(part);
        continue;
      }
      const span = document.createElement("span");
      span.textContent = part;
      span.style.display = "inline-block";
      if (part === " ") span.style.whiteSpace = "pre";
      el.append(span);
    }
    el.dataset.split = by;
  }
  return Array.from(el.querySelectorAll(":scope > span")) as HTMLElement[];
}

/** `start` plus `step` per index: when the i-th of several things starts. */
export const stagger = (i: number, step = 0.04, start = 0): number => start + i * step;

// --- travel --------------------------------------------------------------------------

export type Box = { x: number; y: number; width: number; height: number };

/** Something travelling from one box to another (a card flying from one scene
 *  into its place in the next): its box at progress p (0 … 1), on an arc that
 *  lifts the midpoint by `arc` px (negative dips), turning `spin` degrees.
 *  `transform` moves an element laid out at `from` (transform-origin 0 0). */
export function flight(
  p: number,
  from: Box,
  to: Box,
  { ease: e = ease.inOut, arc = 0, spin = 0 }: { ease?: Ease; arc?: number; spin?: number } = {},
): Box & { scale: number; rotate: number; transform: string } {
  const q = e(clamp(p));
  const width = lerp(from.width, to.width, q);
  const height = lerp(from.height, to.height, q);
  const cx = lerp(from.x + from.width / 2, to.x + to.width / 2, q);
  const cy = lerp(from.y + from.height / 2, to.y + to.height / 2, q) - arc * 4 * q * (1 - q);
  const x = cx - width / 2;
  const y = cy - height / 2;
  const scale = from.width ? width / from.width : 1;
  const rotate = spin * q;
  const sy = from.height ? height / from.height : 1;
  return {
    x,
    y,
    width,
    height,
    scale,
    rotate,
    transform: `translate(${(x - from.x).toFixed(3)}px, ${(y - from.y).toFixed(3)}px) rotate(${rotate.toFixed(3)}deg) scale(${scale.toFixed(5)}, ${sy.toFixed(5)})`,
  };
}

// --- numbers ---------------------------------------------------------------------------

/** A number counting from `from` to `to` over [at, at + dur], formatted. */
export function count(
  t: number,
  {
    at,
    dur = 1,
    from = 0,
    to,
    ease: e = ease.out,
    format = (n: number) => Math.round(n).toLocaleString("en-US"),
  }: {
    at: number;
    dur?: number;
    from?: number;
    to: number;
    ease?: Ease;
    format?: (n: number) => string;
  },
): string {
  return format(lerp(from, to, e(progress(t, at, dur))));
}

// --- randomness ---------------------------------------------------------------------------

/** A stable number in [0, 1) for a key: the same key, the same number, on
 *  every frame and in every render worker. */
export function rand(key: string | number): number {
  let h = 2166136261;
  const s = String(key);
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  h ^= h >>> 16;
  h = Math.imul(h, 0x45d9f3b);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

/** Smooth noise in [-1, 1] that drifts with time t — `speed` changes per second.
 *  Continuous in t, stable per key (a particle's wobble, a flicker). */
export function noise(
  key: string | number,
  t: number,
  { speed = 1 }: { speed?: number } = {},
): number {
  const x = t * speed;
  const i = Math.floor(x);
  const f = x - i;
  const u = f * f * (3 - 2 * f);
  const a = rand(`${key}:${i}`) * 2 - 1;
  const b = rand(`${key}:${i + 1}`) * 2 - 1;
  return a + (b - a) * u;
}
