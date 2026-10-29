// @ts-check
// Marks and light on a film page — open-take's film kit. What a hand or a
// light does to a picture, as plain functions of time: a stroke drawn round
// something and drawn off again, a leader out to a label, the rest of the
// picture dimmed round one part, a line that sweeps an after over a before,
// a band of light that uncovers a screen, a flash on a beat. They return
// numbers and CSS strings; where they go (an SVG over a saved screen, a
// canvas, a mask) is the page's. Nothing here is a style: the colour, the
// width, whether to use any of it at all are the film's.
//
//   import { scribble, stroke, spotlight, sweep, lightSweep, flash } from "./kit/draw.js";
//   // a circle drawn round the price at 8.2 s, held, drawn off at 9.6 s
//   path.setAttribute("d", scribble(screen.box(".price"), { kind: "circle" }));
//   path.setAttribute("pathLength", "1");
//   const s = stroke(t, 8.2, { off: 9.6 });
//   path.style.strokeDasharray = s.dasharray;  path.style.strokeDashoffset = String(s.dashoffset);
//   // the after layer swept over the before, 4 → 4.5 s
//   after.style.clipPath = sweep(t, 4, 4.5, { width: 1920, height: 1080 }).clip;
//
// The numbers come from widely shared launch films, measured frame by frame (`skill
// film craft`); each is an option of its call.

/** @typedef {{ x: number, y: number }} Pt */
/** @typedef {{ x: number, y: number, w?: number, h?: number, width?: number, height?: number }} BoxLike */
/** @typedef {{ width: number, height: number }} Size */

/** @param {number} x */
const clamp01 = (x) => Math.max(0, Math.min(1, x));
/** @param {number} a @param {number} b @param {number} p */
const lerp = (a, b, p) => a + (b - a) * p;
/** smootherstep */
/** @param {number} p */
const smooth = (p) => {
  const x = clamp01(p);
  return x * x * x * (x * (x * 6 - 15) + 10);
};
/** @param {number} p */
const easeOut = (p) => 1 - (1 - clamp01(p)) ** 3;
/** @param {BoxLike} b */
const boxOf = (b) => ({ x: b.x, y: b.y, w: b.w ?? b.width ?? 0, h: b.h ?? b.height ?? 0 });
const f2 = (/** @type {number} */ v) => +v.toFixed(2);

/** a seeded number in [0, 1) for (i, seed): the same every render */
/** @param {number} i @param {number} seed */
function hash(i, seed) {
  let h = Math.imul(i ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(seed + 0x632be5ab, 0xc2b2ae35);
  h ^= h >>> 15;
  h = Math.imul(h, 0x2c1b3c6d);
  h ^= h >>> 12;
  return (h >>> 0) / 4294967296;
}

/** smooth seeded wobble along u (about -1..1), a few bumps per turn */
/** @param {number} u @param {number} seed */
function wobble(u, seed) {
  const i = Math.floor(u);
  const f = u - i;
  const s = f * f * (3 - 2 * f);
  return lerp(hash(i, seed) * 2 - 1, hash(i + 1, seed) * 2 - 1, s);
}

// --- strokes ---------------------------------------------------------------------

/**
 * A hand-drawn mark as an SVG path `d`, round or under a box: deterministic
 * per `seed`, slightly uneven like a quick stroke of a pen. Draw it with
 * `pathLength="1"` and `stroke()`.
 *
 * - "circle": an ellipse round the box, `pad` px outside it, starting a little
 *   above-left and running past its start (`turns` 1.1: the end overlaps the
 *   beginning, as a quick circle does; 2.1 is a double scribble);
 * - "underline": a slightly bowed line under the box;
 * - "box": a rough rectangle round it;
 * - "strike": a line through its middle;
 * - "arrow": from `from` to the box's nearest edge, bowed, with a head.
 *
 * `wobble` is how far the hand strays, in px (default 3% of the box's short
 * side, at least 2): marks in those films strayed a few px, never
 * enough to read as shaky.
 * @param {BoxLike} box
 * @param {{ kind?: "circle" | "underline" | "box" | "strike" | "arrow", pad?: number,
 *   turns?: number, wobble?: number, seed?: number, from?: Pt, bow?: number, head?: number }} [opts]
 * @returns {string}
 */
export function scribble(box, opts = {}) {
  const b = boxOf(box);
  const { kind = "circle", seed = 1 } = opts;
  const short = Math.max(1, Math.min(b.w, b.h));
  const wob = opts.wobble ?? Math.max(2, short * 0.03);
  const cx = b.x + b.w / 2;
  const cy = b.y + b.h / 2;
  /** @type {Pt[]} */
  const pts = [];
  if (kind === "circle") {
    const pad = opts.pad ?? Math.max(8, short * 0.18);
    // an ellipse round a box passes outside its corners at √2 × the half sizes
    const rx = (b.w / 2) * Math.SQRT2 + pad;
    const ry = (b.h / 2) * Math.SQRT2 + pad;
    const turns = opts.turns ?? 1.1;
    const n = Math.ceil(48 * turns);
    const a0 = -2.4; // starts upper left, as a right hand does
    for (let i = 0; i <= n; i++) {
      const u = i / n;
      const a = a0 + u * turns * Math.PI * 2;
      // each lap a little off the last, as a hand never closes on itself
      const k = 1 + wobble(u * turns * 5, seed) * (wob / Math.min(rx, ry)) + u * 0.04;
      pts.push({ x: cx + Math.cos(a) * rx * k, y: cy + Math.sin(a) * ry * k });
    }
  } else if (kind === "underline" || kind === "strike") {
    const y0 = kind === "strike" ? cy : b.y + b.h + (opts.pad ?? Math.max(4, b.h * 0.12));
    const x0 = b.x - b.w * 0.03;
    const x1 = b.x + b.w * 1.03;
    const bow = opts.bow ?? b.w * 0.015;
    for (let i = 0; i <= 24; i++) {
      const u = i / 24;
      pts.push({
        x: lerp(x0, x1, u),
        y: y0 + Math.sin(u * Math.PI) * bow + wobble(u * 4, seed) * wob * 0.6 + u * wob,
      });
    }
  } else if (kind === "box") {
    const pad = opts.pad ?? Math.max(6, short * 0.12);
    const c = [
      { x: b.x - pad, y: b.y - pad },
      { x: b.x + b.w + pad, y: b.y - pad },
      { x: b.x + b.w + pad, y: b.y + b.h + pad },
      { x: b.x - pad, y: b.y + b.h + pad },
      { x: b.x - pad, y: b.y - pad },
    ];
    for (let s = 0; s < 4; s++)
      for (let i = s ? 1 : 0; i <= 12; i++) {
        const u = i / 12;
        const c0 = /** @type {{ x: number, y: number }} */ (c[s]);
        const c1 = /** @type {{ x: number, y: number }} */ (c[s + 1]);
        pts.push({
          x: lerp(c0.x, c1.x, u) + wobble(s * 3 + u * 2, seed) * wob,
          y: lerp(c0.y, c1.y, u) + wobble(s * 3 + u * 2, seed + 7) * wob,
        });
      }
  } else if (kind === "arrow") {
    const from = opts.from ?? { x: b.x - b.w, y: b.y + b.h * 2 };
    // land on the box's edge nearest the start, a little outside it
    const to = {
      x: Math.max(b.x - 6, Math.min(b.x + b.w + 6, from.x)),
      y: Math.max(b.y - 6, Math.min(b.y + b.h + 6, from.y)),
    };
    if (to.x === from.x && to.y === from.y) to.y = b.y - 6;
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const len = Math.hypot(dx, dy) || 1;
    const nx = -dy / len;
    const ny = dx / len;
    const bow = opts.bow ?? len * 0.12;
    for (let i = 0; i <= 24; i++) {
      const u = i / 24;
      const off = Math.sin(u * Math.PI) * bow + wobble(u * 3, seed) * wob * 0.5;
      pts.push({ x: from.x + dx * u + nx * off, y: from.y + dy * u + ny * off });
    }
    // the head: two short strokes back from the tip, along the last direction
    const a = /** @type {{ x: number, y: number }} */ (pts[pts.length - 1]);
    const p = /** @type {{ x: number, y: number }} */ (pts[pts.length - 3]);
    const ang = Math.atan2(a.y - p.y, a.x - p.x);
    const h = opts.head ?? Math.max(10, Math.min(28, len * 0.12));
    const d = `M${pts.map((q) => `${f2(q.x)} ${f2(q.y)}`).join(" L")}`;
    const wing = (/** @type {number} */ s) =>
      `M${f2(a.x)} ${f2(a.y)} L${f2(a.x - Math.cos(ang + s * 0.5) * h)} ${f2(a.y - Math.sin(ang + s * 0.5) * h)}`;
    return `${d} ${wing(1)} ${wing(-1)}`;
  } else {
    throw new Error(`scribble: no kind "${kind}" (circle, underline, box, strike, arrow)`);
  }
  return `M${pts.map((q) => `${f2(q.x)} ${f2(q.y)}`).join(" L")}`;
}

/**
 * A stroke drawn on and, if `off` is given, drawn off again from where it
 * began — the way a pen's mark is taken back, not faded. For a path with
 * `pathLength="1"`: put `dasharray` and `dashoffset` on its style.
 * Defaults: on in 0.4 s (marks in the films measured drew on in 0.3–0.5 s),
 * off in 0.3 s, eased in and out.
 *
 *   const s = stroke(t, 8.2, { off: 9.6 });
 * @param {number} t
 * @param {number} start when it begins to draw
 * @param {{ dur?: number, off?: number, offDur?: number, ease?: (p: number) => number }} [opts]
 * @returns {{ dasharray: string, dashoffset: number, visible: boolean, p: number }}
 *   p: 0 → 1 drawn on, 1 → 2 drawn off
 */
export function stroke(t, start, opts = {}) {
  const { dur = 0.4, offDur = 0.3, ease = smooth } = opts;
  const on = ease(dur > 0 ? (t - start) / dur : t >= start ? 1 : 0);
  const gone =
    opts.off == null ? 0 : ease(offDur > 0 ? (t - opts.off) / offDur : t >= opts.off ? 1 : 0);
  // pathLength 1: the dash is the whole path and so is the gap; the offset
  // slides it on (1 → 0) and then on past its start (0 → −1)
  const dashoffset = gone > 0 ? -gone : 1 - on;
  return {
    dasharray: "1 1",
    dashoffset: +dashoffset.toFixed(5),
    visible: t >= start && gone < 1,
    p: gone > 0 ? 1 + gone : on,
  };
}

/**
 * A leader from a point on the subject out to where its label sits: a short
 * diagonal, then level — the way labels on a teardown or a map are drawn.
 * Returns the path (`pathLength="1"`, drawn with `stroke`) and where the
 * label's text starts.
 * @param {Pt} at the point on the subject
 * @param {Pt} label where the leader ends
 * @param {{ rise?: number, gap?: number }} [opts] rise: share of the way
 *   spent on the diagonal (default 0.35); gap: px between the line's end and the text
 * @returns {{ d: string, text: Pt, side: "left" | "right" }}
 */
export function leader(at, label, opts = {}) {
  const { rise = 0.35, gap = 12 } = opts;
  const dx = label.x - at.x;
  const knee = { x: at.x + dx * rise, y: label.y };
  const side = dx >= 0 ? "right" : "left";
  return {
    d: `M${f2(at.x)} ${f2(at.y)} L${f2(knee.x)} ${f2(knee.y)} L${f2(label.x)} ${f2(label.y)}`,
    text: { x: label.x + (side === "right" ? gap : -gap), y: label.y },
    side,
  };
}

// --- light -----------------------------------------------------------------------

/**
 * The rest of the picture dimmed round one part: a soft ellipse, clear over
 * the part, darkening outside. Coming on over `in` s from `start` and, if
 * `release` is given, going off over `out` s from then. Returns a CSS
 * background for a full-frame layer over the picture (`pointer-events:
 * none`). Measure the part each frame (`box()` on a saved screen,
 * `throughCamera` through the camera) so the light stays on it as the
 * camera pushes in. Defaults from a film's spotlight: 55 % dark at the
 * edge, on in 0.3 s, off in 0.5 s.
 * @param {number} t
 * @param {number} start
 * @param {BoxLike} box the part, in the picture's px
 * @param {{ amount?: number, in?: number, release?: number, out?: number, color?: string, spread?: number }} [opts]
 *   color: the dark, as "r,g,b" (default "0,0,0"); spread: how far past the part the clear centre reaches (default 1.6 × its size)
 * @returns {{ background: string, k: number }}
 */
export function spotlight(t, start, box, opts = {}) {
  const { amount = 0.55, color = "0,0,0", spread = 1.6 } = opts;
  const b = boxOf(box);
  const kIn = smooth(opts.in === 0 ? (t >= start ? 1 : 0) : (t - start) / (opts.in ?? 0.3));
  const kOut =
    opts.release == null ? 0 : smooth((t - opts.release) / Math.max(1e-6, opts.out ?? 0.5));
  const k = clamp01(kIn - kOut);
  const rx = Math.max(1, (b.w / 2) * spread + 40);
  const ry = Math.max(1, (b.h / 2) * spread + 40);
  const cx = b.x + b.w / 2;
  const cy = b.y + b.h / 2;
  const a = +(amount * k).toFixed(4);
  return {
    background: `radial-gradient(ellipse ${f2(rx)}px ${f2(ry)}px at ${f2(cx)}px ${f2(cy)}px, rgba(${color},0) 60%, rgba(${color},${a}) 100%), rgba(${color},${a})`,
    k,
  };
}

/**
 * A line sweeping across the frame with the changed picture behind it: the
 * before and the after on the same material, so the change cannot be missed.
 * Put `clip` on the after layer (stacked over the before) and draw the line
 * at `at` (x for "right"/"left", y for "down"/"up"). Default 0.5 s,
 * smootherstep (the films measured swept in 0.45–0.6 s).
 * @param {number} t
 * @param {number} start
 * @param {number} end
 * @param {Size} frame
 * @param {{ dir?: "right" | "left" | "down" | "up", ease?: (p: number) => number }} [opts]
 * @returns {{ clip: string, at: number, p: number, moving: boolean }}
 */
export function sweep(t, start, end, frame, opts = {}) {
  const { dir = "right", ease = smooth } = opts;
  const p = end > start ? ease(clamp01((t - start) / (end - start))) : t >= end ? 1 : 0;
  const pct = (/** @type {number} */ v) => `${(v * 100).toFixed(3)}%`;
  /** @type {string} */
  let clip;
  /** @type {number} */
  let at;
  if (dir === "right") {
    clip = `inset(0 ${pct(1 - p)} 0 0)`;
    at = p * frame.width;
  } else if (dir === "left") {
    clip = `inset(0 0 0 ${pct(1 - p)})`;
    at = (1 - p) * frame.width;
  } else if (dir === "down") {
    clip = `inset(0 0 ${pct(1 - p)} 0)`;
    at = p * frame.height;
  } else {
    clip = `inset(${pct(1 - p)} 0 0 0)`;
    at = (1 - p) * frame.height;
  }
  return { clip, at, p, moving: p > 0 && p < 1 };
}

/**
 * A band of light crossing a screen and leaving it lit: two copies of the
 * screen, one dim (`filter: brightness(dim)`), one lit with `mask` as its
 * `mask-image` (and `-webkit-mask-image`); `glint` is a soft bright band on
 * the front, for a `mix-blend-mode: screen` layer over both. From a film's
 * reveal: the band at 115°, the lit part trailing the front by 700 px, the
 * unlit screen at 7 %, 1.3 s across. `frame` is the screen's own size.
 * @param {number} t
 * @param {number} start
 * @param {number} end
 * @param {Size} frame
 * @param {{ angle?: number, soft?: number, glint?: number, dim?: number, ease?: (p: number) => number }} [opts]
 *   angle: of the band, degrees as CSS gradients count them; soft: px of the soft edge; glint: px of the bright band (0: none)
 * @returns {{ mask: string, glint: string, dim: number, p: number }}
 */
export function lightSweep(t, start, end, frame, opts = {}) {
  const { angle = 115, soft = 700, glint = 360, dim = 0.07, ease = smooth } = opts;
  const p = end > start ? ease(clamp01((t - start) / (end - start))) : t >= end ? 1 : 0;
  // the gradient line's length for this angle over this frame, as CSS works it out
  const rad = (angle * Math.PI) / 180;
  const L = Math.abs(frame.width * Math.sin(rad)) + Math.abs(frame.height * Math.cos(rad));
  // the front runs from before the frame (nothing lit) to past it by `soft` (all lit)
  const front = lerp(-glint, L + soft, p);
  const lit = `linear-gradient(${angle}deg, #000 ${f2(front - soft)}px, transparent ${f2(front)}px)`;
  const g =
    glint > 0
      ? `linear-gradient(${angle}deg, rgba(255,255,255,0) ${f2(front - glint)}px, rgba(255,255,255,0.2) ${f2(front - glint / 2)}px, rgba(255,255,255,0) ${f2(front)}px)`
      : "none";
  return { mask: lit, glint: g, dim, p };
}

/**
 * A flash on a beat: white (or any colour) over the frame, up in `attack` s
 * and gone over `decay` s, eased out — punctuation that makes a hard cut read
 * as meant. Defaults from the films measured: 40 ms up, 0.3 s down, peaking
 * at 0.55 (a full white frame reads as an error on a phone).
 * @param {number} t
 * @param {number} at the beat
 * @param {{ attack?: number, decay?: number, peak?: number }} [opts]
 * @returns {{ opacity: number }}
 */
export function flash(t, at, opts = {}) {
  const { attack = 0.04, decay = 0.3, peak = 0.55 } = opts;
  if (t < at - attack || t > at + decay) return { opacity: 0 };
  if (t < at) return { opacity: +(peak * clamp01((t - (at - attack)) / attack)).toFixed(4) };
  return { opacity: +(peak * (1 - easeOut((t - at) / decay))).toFixed(4) };
}
