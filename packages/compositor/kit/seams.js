// @ts-check
// Seams for a film page — open-take's film kit. How one scene hands over to
// the next, as plain functions of time: give one the film's time t and the
// moment of the cut, read back where each side is, how big, how faint, how
// blurred — numbers and the CSS for them. Nothing here owns an element or
// keeps state, so a frame rendered twice or out of order comes out the same
// (`apply` at the bottom writes one side onto an element, for a page that
// wants it written).
//
//   - a cut on the curve: the outgoing scene leaves on an accelerating curve,
//     the cut falls at its fastest frame, the incoming one arrives at the
//     same speed in the same direction and brakes — whole scenes (`curve`) or
//     word by word (`waterfall`);
//   - one strip: both scenes on one mover a frame apart, whipped past
//     (`whip`) — the speed across the seam is the same by construction;
//   - a swap in depth: the scene flies at the lens into blur, the next comes
//     out of the same blur (`depth`, and `inverse` for a payoff); one line of
//     text becoming another on one curve, split at its fastest point
//     (`matchText`);
//   - a card that grows into its panel while the parts both share move to
//     their new places at their own size, not stretched (`morph`);
//   - one card out of a grid becomes the scene while the rest fly outward
//     (`parallax`), or the scene shrinks back into its tile (`reverse`);
//   - a hard cut on purpose: a small push on both sides and a flash
//     (`pushCut`), or the outgoing frame darkened for three frames (`dipCut`).
//
// `seams(tl, list)` names the seam at each boundary between scenes and
// declares each as a cut on the timeline. A boundary that names none gets a
// cut on the curve; one that says "cut" is a hard cut, on purpose.
//
// The numbers come from launch films measured frame by frame: HyperFrames'
// cut catalog and its registry components (github.com/heygen-com/hyperframes,
// Apache-2.0) and the saas-motion-kit transition atlas
// (github.com/Sylla431/saas-motion-kit, MIT), each re-derived here, none
// copied; where a default comes from is said beside it. None of them is a
// style: change any per call.
//
// Text stays sharp: a side at rest gets `transform: none` and `filter: none`
// (a layer left scaled or filtered is rastered once and stays soft); a scene
// that has to grow is laid out at its full size and scaled down into the
// move, never a small copy scaled up; blur peaks where the swap happens, the
// same on both sides of it. The master's shutter (film render) already
// smears what moves fast, so the blur here is only what a move needs at rest
// speed: a whip is left to the shutter unless asked.
//
//   import { curve, seams, apply } from "./kit/seams.js";
//   const c = curve(t, 6.0, { dir: "left" });    // { a, b, speed }
//   apply(sceneA, c.a); apply(sceneB, c.b);
//   // or name every boundary once:
//   const s = seams(tl, [
//     { at: 6.0, from: "#intro", to: "#map" },          // nothing named: on the curve
//     { at: 12.4, from: "#map", to: "#table", kind: "whip", dir: "up" },
//     { at: 18.0, from: "#table", to: "#end", kind: "cut" },
//   ], { view: { width: 1920, height: 1080 } });
//   window.__render = (t) => { s.apply(t); };

/** @typedef {{ x: number, y: number }} Pt  a point, in CSS px */
/** @typedef {{ x: number, y: number, w?: number, h?: number, width?: number, height?: number, r?: number }} RectLike  a Rect ({ x, y, w, h, r }) or a kit Box ({ x, y, width, height }) */
/** @typedef {{ width: number, height: number }} View  the picture's size */
/**
 * One side of a seam at one instant.
 * @typedef {object} Side
 * @property {boolean} visible whether it is on screen at all
 * @property {number} x offset from its place (px)
 * @property {number} y
 * @property {number} scale about `origin` (1: its own size)
 * @property {number} opacity
 * @property {number} blur Gaussian blur (px); 0 at rest
 * @property {"x" | "y" | null} blurAxis blur along one axis only (a whip), or both
 * @property {number} brightness 1: as it is
 * @property {string} transform CSS; "none" when it is at rest
 * @property {string} filter CSS; "none" when nothing is blurred or dimmed
 *   (an axis blur needs an SVG filter: `apply` makes one; see there)
 */

// --- small helpers ----------------------------------------------------------

/** @param {number} x */
const clamp01 = (x) => Math.max(0, Math.min(1, x));
/** @param {number} a @param {number} b @param {number} p */
const lerp = (a, b, p) => a + (b - a) * p;
/** progress through [start, start + dur], 0 before, 1 after @param {number} t @param {number} start @param {number} dur */
const prog = (t, start, dur) => (dur > 0 ? clamp01((t - start) / dur) : t >= start ? 1 : 0);
/** a number for CSS @param {number} v @param {number} [d] */
const f = (v, d = 3) => +v.toFixed(d);

/** eases by name: `in(n)` is pⁿ (GSAP's power3.in is in(4)), `out(n)` and
 *  `inOut(n)` its mirror and its two halves, an exponential ease-out,
 *  GSAP's back.out, a CSS cubic-bezier */
export const ease = {
  /** @param {number} n the exponent @returns {(p: number) => number} */
  in: (n) => (p) => clamp01(p) ** n,
  /** @param {number} n @returns {(p: number) => number} */
  out: (n) => (p) => 1 - (1 - clamp01(p)) ** n,
  /** @param {number} n @returns {(p: number) => number} */
  inOut: (n) => (p) => {
    const x = clamp01(p);
    return x < 0.5 ? 2 ** (n - 1) * x ** n : 1 - (-2 * x + 2) ** n / 2;
  },
  /** 1 − 2^(−10p), set to land exactly on 1 @param {number} p */
  expoOut: (p) => {
    const x = clamp01(p);
    return x >= 1 ? 1 : (1 - 2 ** (-10 * x)) / (1 - 2 ** -10);
  },
  /** GSAP's back.out(c): past 1 and back; c 0.7 peaks at ≈ 1.0177 of the travel
   *  @param {number} [c] @returns {(p: number) => number} */
  backOut:
    (c = 0.7) =>
    (p) => {
      const x = clamp01(p) - 1;
      return 1 + (c + 1) * x * x * x + c * x * x;
    },
  /**
   * A CSS cubic-bezier(x1, y1, x2, y2), solved for x by Newton's method then
   * bisection — what a browser does.
   * @param {number} x1 @param {number} y1 @param {number} x2 @param {number} y2
   * @returns {(p: number) => number}
   */
  bezier: (x1, y1, x2, y2) => {
    /** @param {number} u @param {number} a @param {number} b */
    const at = (u, a, b) => 3 * a * u * (1 - u) ** 2 + 3 * b * u * u * (1 - u) + u ** 3;
    /** @param {number} u @param {number} a @param {number} b */
    const slope = (u, a, b) =>
      3 * a * (1 - u) ** 2 + 6 * (b - a) * u * (1 - u) + 3 * (1 - b) * u * u;
    return (p) => {
      const x = clamp01(p);
      if (x === 0 || x === 1) return x;
      let u = x;
      for (let i = 0; i < 8; i++) {
        const d = slope(u, x1, x2);
        if (Math.abs(d) < 1e-7) break;
        u -= (at(u, x1, x2) - x) / d;
      }
      if (!(u >= 0 && u <= 1) || Math.abs(at(u, x1, x2) - x) > 1e-7) {
        let lo = 0;
        let hi = 1;
        u = x;
        for (let i = 0; i < 60; i++) {
          if (at(u, x1, x2) < x) lo = u;
          else hi = u;
          u = (lo + hi) / 2;
        }
      }
      return at(u, y1, y2);
    };
  },
};

/** a direction word or a vector, as a unit vector: where the outgoing scene goes */
/** @param {"left" | "right" | "up" | "down" | Pt} dir @returns {Pt} */
function unit(dir) {
  if (dir === "left") return { x: -1, y: 0 };
  if (dir === "right") return { x: 1, y: 0 };
  if (dir === "up") return { x: 0, y: -1 };
  if (dir === "down") return { x: 0, y: 1 };
  if (dir && Number.isFinite(dir.x) && Number.isFinite(dir.y)) {
    const l = Math.hypot(dir.x, dir.y);
    if (l > 0) return { x: dir.x / l, y: dir.y / l };
  }
  throw new Error(
    `seams: dir is "left", "right", "up", "down" or { x, y } (got ${JSON.stringify(dir)})`,
  );
}

/** a Rect from a Rect or a kit Box */
/** @param {RectLike} b */
function rectOf(b) {
  return { x: b.x, y: b.y, w: b.w ?? b.width ?? 0, h: b.h ?? b.height ?? 0, r: b.r ?? 0 };
}

/**
 * A side from its numbers: the CSS strings follow, and a side that has come
 * to rest gets "none" for both, so the browser draws it from its own layout.
 * @param {Partial<Side> & { visible: boolean }} s
 * @returns {Side}
 */
export function side(s) {
  const x = s.x ?? 0;
  const y = s.y ?? 0;
  const scale = s.scale ?? 1;
  const blur = Math.max(0, s.blur ?? 0);
  const brightness = s.brightness ?? 1;
  const moved = Math.abs(x) > 1e-3 || Math.abs(y) > 1e-3 || Math.abs(scale - 1) > 1e-5;
  const transform = moved ? `translate(${f(x)}px, ${f(y)}px) scale(${f(scale, 5)})` : "none";
  /** @type {string[]} */
  const parts = [];
  if (blur >= 0.05 && !s.blurAxis) parts.push(`blur(${f(blur, 2)}px)`);
  if (Math.abs(brightness - 1) > 1e-3) parts.push(`brightness(${f(brightness)})`);
  return {
    visible: s.visible,
    x,
    y,
    scale,
    opacity: clamp01(s.opacity ?? 1),
    blur: blur >= 0.05 ? blur : 0,
    blurAxis: blur >= 0.05 ? (s.blurAxis ?? null) : null,
    brightness,
    transform,
    filter: parts.length ? parts.join(" ") : "none",
  };
}

/** a side that is off screen */
const gone = () => side({ visible: false, opacity: 0 });
/** a side at rest, on screen */
const still = () => side({ visible: true });

// --- a cut on the curve -------------------------------------------------------

/**
 * A cut on the curve: the outgoing scene accelerates away (ease-in, p⁴) and
 * the cut falls on its fastest frame; the incoming one arrives from the far
 * side moving the same way at the same speed and brakes (ease-out, the same
 * curve mirrored). Both speeds at the cut are 4·dist/dur, so the eye reads
 * one move with the picture changing inside it. The outgoing scene is gone by
 * the cut while it is still plainly accelerating — nothing has to reach the
 * edge of the frame — and the incoming one starts at `enter` opacity.
 * Defaults: 230 px (12 % of 1920) over 0.30 s each side, a 0.18 s fade, the
 * incoming at 0.35 — HyperFrames' cut catalog, "cut-the-curve", measured on
 * its launch films: ≈ 3070 px/s at the cut.
 * Translate only, no blur: what is on either side is sharp the moment it stops.
 * @param {number} t
 * @param {number} at the cut: the outgoing side's last frame is before it
 * @param {{ dir?: "left" | "right" | "up" | "down" | Pt, dist?: number, dur?: number, fade?: number, enter?: number }} [o]
 *   dir: the way both travel (default "left"); dist (px), dur (s each side),
 *   fade (s the outgoing takes to go, ending at the cut), enter (the incoming
 *   side's first opacity)
 * @returns {{ a: Side, b: Side, speed: number, p: number }} speed: px/s at the cut
 */
export function curve(t, at, o = {}) {
  const { dir = "left", dist = 230, dur = 0.3, fade = 0.18, enter = 0.35 } = o;
  const u = unit(dir);
  const speed = dur > 0 ? (4 * dist) / dur : Number.POSITIVE_INFINITY;
  if (t < at) {
    const e = ease.in(4)(prog(t, at - dur, dur));
    const q = prog(t, at - fade, fade);
    return {
      a: side({ visible: true, x: u.x * dist * e, y: u.y * dist * e, opacity: 1 - q }),
      b: gone(),
      speed,
      p: e,
    };
  }
  const q = prog(t, at, dur);
  if (q >= 1) return { a: gone(), b: still(), speed, p: 1 };
  const e = ease.out(4)(q);
  return {
    a: gone(),
    b: side({
      visible: true,
      x: -u.x * dist * (1 - e),
      y: -u.y * dist * (1 - e),
      opacity: lerp(enter, 1, prog(t, at, fade)),
    }),
    speed,
    p: e,
  };
}

/**
 * The cut on the curve word by word: the outgoing line's words leave one
 * after another in reading order, each on its own ease-in, the last of them
 * gone exactly at the cut; the incoming words cascade in from the far side,
 * each on an ease-out, the gaps between them shrinking (a waterfall).
 * Defaults (HyperFrames' cut catalog, "waterfall"): out 0.34 s a word, a
 * 0.18 s fade, 0.022 s apart; in 0.30 s a word, the first gap 0.05 s, each
 * next ×0.84; 230 px.
 * @param {number} t
 * @param {number} at the cut
 * @param {number} nOut how many words leave
 * @param {number} nIn how many arrive
 * @param {{ dir?: "left" | "right" | "up" | "down" | Pt, dist?: number, outDur?: number, inDur?: number, fade?: number, stagger?: number, gap?: number, shrink?: number }} [o]
 * @returns {{ out: Side[], in: Side[], end: number }} end: when the last word has landed
 */
export function waterfall(t, at, nOut, nIn, o = {}) {
  const {
    dir = "left",
    dist = 230,
    outDur = 0.34,
    inDur = 0.3,
    fade = 0.18,
    stagger = 0.022,
    gap = 0.05,
    shrink = 0.84,
  } = o;
  const u = unit(dir);
  const out = [];
  for (let i = 0; i < nOut; i++) {
    const start = at - outDur - (nOut - 1 - i) * stagger;
    if (t >= start + outDur) {
      out.push(gone());
      continue;
    }
    const e = ease.in(4)(prog(t, start, outDur));
    const q = prog(t, start + outDur - fade, fade);
    out.push(side({ visible: true, x: u.x * dist * e, y: u.y * dist * e, opacity: 1 - q }));
  }
  const inn = [];
  let start = at;
  let g = gap;
  for (let i = 0; i < nIn; i++) {
    if (t < start) inn.push(gone());
    else {
      const e = ease.out(4)(prog(t, start, inDur));
      inn.push(
        side({
          visible: true,
          x: -u.x * dist * (1 - e),
          y: -u.y * dist * (1 - e),
          opacity: prog(t, start, fade),
        }),
      );
    }
    if (i < nIn - 1) {
      start += g;
      g *= shrink;
    }
  }
  return { out, in: inn, end: start + inDur };
}

// --- one strip ----------------------------------------------------------------

/**
 * A whip: both scenes ride one strip, the incoming docked a frame's width
 * (or height) beyond the outgoing, and the strip moves one frame on one
 * ease-in-out — so the speed across the seam is the same on both sides by
 * construction, and there is no swap at all. The cut is the strip's middle,
 * its fastest moment: 3·width/dur (≈ 10 500 px/s at 1920 px over 0.55 s, the
 * HyperFrames whip-pan component's default; its films measured 0.13–0.3 s of
 * smear). The master's shutter smears it along its path already; `blur`
 * adds a blur along that axis only, peaking with the speed — for a draft,
 * or a heavier smear. `edge` is where the two scenes meet, along the axis,
 * in frame px: a hairline there is the seam drawn.
 * @param {number} t
 * @param {number} at the middle of the whip
 * @param {View} view
 * @param {{ dir?: "left" | "right" | "up" | "down", dur?: number, blur?: number, power?: number }} [o]
 *   dir: the way the strip moves (default "left": the next scene comes in
 *   from the right); dur (default 0.55 s); blur (px at the fastest point,
 *   default 0); power: the in-out's exponent (default 3)
 * @returns {{ a: Side, b: Side, speed: number, edge: number | null, p: number }}
 */
export function whip(t, at, view, o = {}) {
  const { dir = "left", dur = 0.55, blur = 0, power = 3 } = o;
  const u = unit(dir);
  const horiz = u.x !== 0;
  const W = horiz ? view.width : view.height;
  const s = horiz ? u.x : u.y;
  const start = at - dur / 2;
  const speed = dur > 0 ? (power * W) / dur : Number.POSITIVE_INFINITY;
  if (t < start) return { a: still(), b: gone(), speed, edge: null, p: 0 };
  const p = prog(t, start, dur);
  if (p >= 1) return { a: gone(), b: still(), speed, edge: null, p: 1 };
  const e = ease.inOut(power)(p);
  // the in-out's speed against its fastest, 0 → 1 → 0
  const h = 1e-4;
  const v =
    (ease.inOut(power)(Math.min(1, p + h)) - ease.inOut(power)(Math.max(0, p - h))) /
    (Math.min(1, p + h) - Math.max(0, p - h));
  const sigma = blur * clamp01(v / power);
  const axis = horiz ? "x" : "y";
  const along = /** @param {number} d */ (d) => (horiz ? { x: d, y: 0 } : { x: 0, y: d });
  const da = s * W * e;
  const db = s * W * e - s * W;
  return {
    a: side({ visible: Math.abs(da) < W, ...along(da), blur: sigma, blurAxis: axis }),
    b: side({ visible: Math.abs(db) < W, ...along(db), blur: sigma, blurAxis: axis }),
    speed,
    edge: s < 0 ? W + da : da,
    p: e,
  };
}

// --- a swap in depth ------------------------------------------------------------

/**
 * A swap in depth: the outgoing scene flies at the lens — grows, blurs,
 * fades — and on the cut the incoming one comes out of the same blur from
 * smaller and settles (a zoom-through); `inverse` runs it the other way for
 * a payoff — the old recedes, the new arrives oversized and retracts. The
 * blur at the cut is the same on both sides, so the eye does not see the
 * swap. Defaults (HyperFrames' cut catalog, "zoom-through"): out 0.2 s to
 * ×1.2 with blur to 10 px on an ease-in (p⁴), opacity to 0.15 on a straight
 * line; in 0.5 s from ×0.75, blur 10, opacity 0.15 on an exponential ease-out.
 * 10 px is for text-sized subjects ("at 20 px text smears"); 18–20 for a full
 * frame. Put it on the scene's wrapper, transform-origin at its centre (or
 * where `origin` says); the incoming scene is laid out at its full size and
 * grows into it from smaller (inverse: from larger, briefly, in blur).
 * @param {number} t
 * @param {number} at the cut
 * @param {{ inverse?: boolean, outDur?: number, inDur?: number, outScale?: number, inScale?: number, blur?: number, dim?: number }} [o]
 * @returns {{ a: Side, b: Side, p: number }}
 */
export function depth(t, at, o = {}) {
  const { inverse = false, outDur = 0.2, inDur = 0.5, blur = 10, dim = 0.15 } = o;
  const outScale = o.outScale ?? (inverse ? 0.8 : 1.2);
  const inScale = o.inScale ?? (inverse ? 1.25 : 0.75);
  if (t < at) {
    const q = prog(t, at - outDur, outDur);
    const e = ease.in(4)(q);
    return {
      a: side({
        visible: true,
        scale: lerp(1, outScale, e),
        blur: blur * e,
        opacity: lerp(1, dim, q),
      }),
      b: gone(),
      p: e,
    };
  }
  const q = prog(t, at, inDur);
  if (q >= 1) return { a: gone(), b: still(), p: 1 };
  const e = ease.expoOut(q);
  return {
    a: gone(),
    b: side({
      visible: true,
      scale: lerp(inScale, 1, e),
      blur: blur * (1 - e),
      opacity: lerp(dim, 1, e),
    }),
    p: e,
  };
}

/** the one curve of a text match cut: cubic-bezier(.85, 0, .15, 1) — slow out,
 *  very fast through the middle, slow in (HyperFrames' text-match-cut,
 *  measured at 60 fps on the tutorial it credits) */
const MATCH_EASE = ease.bezier(0.85, 0, 0.15, 1);

/**
 * One line of text becomes another on one curve: the whole move is one ease,
 * split at its middle — its fastest point — where the outgoing line is
 * swapped for the incoming on the same frame, no crossfade. The outgoing line
 * rides the first half, the incoming the second, so the motion runs on
 * across the swap.
 *   "zoom": the outgoing grows from 1 to `k`, the incoming grows from 1/k to
 *     1 — one push in, in log space (k < 1: one pull back); defaults k 1.7:
 *     the incoming starts at ≈ 0.59, built at its full size;
 *   "slide": the outgoing moves `dist` px, the incoming arrives from `dist`
 *     px the other side of its place and moves the same way;
 *   "track": letter-spacing runs from `from` to `to` em on the one curve, the
 *     incoming taking over at the middle — read `spacing` (defaults +0.22 →
 *     −0.05 em, the values it was measured at).
 * Default 2.0 s for the whole move.
 * @param {number} t
 * @param {number} start
 * @param {number} end
 * @param {{ mode?: "zoom" | "slide" | "track", k?: number, dir?: "left" | "right" | "up" | "down" | Pt, dist?: number, from?: number, to?: number, ease?: (p: number) => number }} [o]
 * @returns {{ a: Side, b: Side, cut: number, spacing: number | null, p: number }}
 *   cut: the time of the swap; spacing: letter-spacing in em ("track")
 */
export function matchText(t, start, end, o = {}) {
  const { mode = "zoom", k = 1.7, dir = "left", dist = 160, from = 0.22, to = -0.05 } = o;
  const curveOf = o.ease ?? MATCH_EASE;
  const cut = start + (end - start) / 2;
  const e = end > start ? curveOf(clamp01((t - start) / (end - start))) : t >= end ? 1 : 0;
  const first = t < cut;
  /** @param {Partial<Side>} s */
  const on = (s) => side({ visible: true, ...s });
  if (mode === "zoom") {
    if (!(k > 0)) throw new Error(`matchText: k is a scale above 0 (got ${k})`);
    // log scale runs 0 → 2·ln k over the move; each side shows it about its own rest
    const L = 2 * Math.log(k) * e;
    return first
      ? { a: on({ scale: Math.exp(L) }), b: gone(), cut, spacing: null, p: e }
      : { a: gone(), b: on({ scale: Math.exp(L - 2 * Math.log(k)) }), cut, spacing: null, p: e };
  }
  if (mode === "slide") {
    const u = unit(dir);
    const d = 2 * dist * e;
    return first
      ? { a: on({ x: u.x * d, y: u.y * d }), b: gone(), cut, spacing: null, p: e }
      : {
          a: gone(),
          b: on({ x: u.x * (d - 2 * dist), y: u.y * (d - 2 * dist) }),
          cut,
          spacing: null,
          p: e,
        };
  }
  if (mode === "track") {
    const spacing = lerp(from, to, e);
    return first
      ? { a: on({}), b: gone(), cut, spacing, p: e }
      : { a: gone(), b: on({}), cut, spacing, p: e };
  }
  throw new Error(`matchText: mode is "zoom", "slide" or "track" (got ${mode})`);
}

// --- a card that becomes its panel ------------------------------------------------

/**
 * A card grows into the panel it opens, and the parts both of them hold move
 * from their place in the card to their place in the panel at their own
 * size — the text re-flows, it does not stretch. The panel is laid out at its
 * full size (its own element, transform-origin 0 0) and `container.transform`
 * shrinks it onto the card and grows it back: a box interpolated in log
 * space for the size, its corner radius with it (`container.radius`, already
 * divided by the scale, for the element's own border-radius). For each part
 * the two share, `part(inCard, inPanel)` gives the transform for the part's
 * element inside the panel: it sits where it would between its two places,
 * uniformly scaled, the panel's own scale undone. The card's own content
 * leaves over the first `aOut` of the move, the panel's own arrives over the
 * last `bIn`. Defaults (HyperFrames' modal-morph and card-morph-anchor): a
 * smooth in-out, the card's content gone by 30 %, the panel's from 60 %;
 * `snappy` lands on GSAP back.out(0.7), overshooting ≈ 1.8 % of the travel.
 * At the end the transform is "none": the panel is its own DOM, unscaled.
 * @param {number} t
 * @param {number} start
 * @param {number} end 0.6–1.2 s after start was what the films used; under 0.5 s
 *   both contents' fades do not fit
 * @param {RectLike} from the card, in frame px
 * @param {RectLike} to the panel, in frame px
 * @param {{ snappy?: boolean, ease?: (p: number) => number, aOut?: number, bIn?: number }} [o]
 */
export function morph(t, start, end, from, to, o = {}) {
  const { snappy = false, aOut = 0.3, bIn = 0.4 } = o;
  const curveOf = o.ease ?? (snappy ? ease.backOut(0.7) : ease.inOut(3));
  const a = rectOf(from);
  const b = rectOf(to);
  const q = end > start ? clamp01((t - start) / (end - start)) : t >= end ? 1 : 0;
  const e = curveOf(q);
  /** sizes in log space: a ten-times growth looks steady @param {number} u @param {number} v */
  const size = (u, v) => (u > 0 && v > 0 ? u * (v / u) ** e : lerp(u, v, e));
  const w = size(a.w, b.w);
  const h = size(a.h, b.h);
  const cx = lerp(a.x + a.w / 2, b.x + b.w / 2, e);
  const cy = lerp(a.y + a.h / 2, b.y + b.h / 2, e);
  const box = { x: cx - w / 2, y: cy - h / 2, w, h, r: lerp(a.r, b.r, e) };
  const sx = b.w > 0 ? w / b.w : 1;
  const sy = b.h > 0 ? h / b.h : 1;
  const done = q >= 1;
  const container = {
    box,
    sx,
    sy,
    transform: done
      ? "none"
      : `translate(${f(box.x - b.x)}px, ${f(box.y - b.y)}px) scale(${f(sx, 5)}, ${f(sy, 5)})`,
    radius: done
      ? `${f(b.r)}px`
      : `${f(box.r / Math.max(1e-9, sx))}px / ${f(box.r / Math.max(1e-9, sy))}px`,
  };
  return {
    container,
    /** the card's own content (what the panel does not have) */
    a: { opacity: 1 - clamp01(q / Math.max(1e-9, aOut)) },
    /** the panel's own content (what the card did not have) */
    b: { opacity: clamp01((q - (1 - bIn)) / Math.max(1e-9, bIn)) },
    /**
     * A part both hold: its box in the card and in the panel, frame px. The
     * transform goes on the part's element inside the panel (transform-origin 0 0).
     * @param {RectLike} inCard
     * @param {RectLike} inPanel
     */
    part(inCard, inPanel) {
      const pa = rectOf(inCard);
      const pb = rectOf(inPanel);
      const want = { x: lerp(pa.x, pb.x, e), y: lerp(pa.y, pb.y, e), w: size(pa.w, pb.w) };
      if (done) return { transform: "none", scale: 1 };
      const g = pb.w > 0 ? want.w / pb.w : 1;
      const kx = g / Math.max(1e-9, sx);
      const ky = g / Math.max(1e-9, sy);
      // its place in the panel's own (unscaled) coordinates, then moved to
      // where it should show: frame = box + s·(local)
      const dx = (want.x - box.x) / Math.max(1e-9, sx) - (pb.x - b.x);
      const dy = (want.y - box.y) / Math.max(1e-9, sy) - (pb.y - b.y);
      return {
        transform: `translate(${f(dx)}px, ${f(dy)}px) scale(${f(kx, 5)}, ${f(ky, 5)})`,
        scale: g,
      };
    },
    p: e,
  };
}

// --- one card out of a grid --------------------------------------------------------

/**
 * One card of a grid becomes the scene: it grows until it fills the view —
 * one scale about a fixed point, in log space, as `zoomThrough` flies — while
 * every other card flies outward from it, shrinks and fades. `reverse` runs
 * it back: the scene shrinks into its tile while the grid forms round it (a
 * dolly-out). The next scene is meant to be laid out at the view's full size
 * (`scene.transform`, transform-origin 0 0, on an element that fills the
 * view): it is scaled down onto the tile and grows to "none" — sharp — rather
 * than a small card scaled up; `focal.transform` is for the card's own
 * element, if it has to be the one that grows. `radius` is the tile's corner
 * radius on screen (it goes to 0 as it fills); `scene.radius` is that divided
 * by the scene's scale, for its border-radius.
 * Defaults (HyperFrames' parallax-zoom, after eBay Playbook's hero; the
 * dolly-out from the saas-motion-kit atlas): siblings pushed 900 px per tile
 * of distance from the card, shrunk to 0.6 and faded out by the end; a smooth
 * in-out (2.4 s was its length; the dolly-out 1.2 s); a 16 px tile radius.
 * @param {number} t
 * @param {number} start
 * @param {number} end
 * @param {RectLike} card the card that becomes the scene, frame px
 * @param {RectLike[]} others the rest of the grid
 * @param {View} view
 * @param {{ reverse?: boolean, push?: number, shrink?: number, radius?: number, ease?: (p: number) => number }} [o]
 */
export function parallax(t, start, end, card, others, view, o = {}) {
  const { reverse = false, push = 900, shrink = 0.4, radius = 16 } = o;
  const curveOf = o.ease ?? ease.inOut(3);
  const c = rectOf(card);
  const q0 = end > start ? clamp01((t - start) / (end - start)) : t >= end ? 1 : 0;
  const e = curveOf(reverse ? 1 - q0 : q0);
  // the scale that makes the card cover the view, and the point it grows about
  // so its centre lands on the view's: f = (S·c − v) / (S − 1)
  const S = Math.max(view.width / Math.max(1e-9, c.w), view.height / Math.max(1e-9, c.h));
  const cc = { x: c.x + c.w / 2, y: c.y + c.h / 2 };
  const v = { x: view.width / 2, y: view.height / 2 };
  const fx = Math.abs(S - 1) < 1e-9 ? cc.x : (S * cc.x - v.x) / (S - 1);
  const fy = Math.abs(S - 1) < 1e-9 ? cc.y : (S * cc.y - v.y) / (S - 1);
  const s = S ** e;
  const done = e >= 1 - 1e-9;
  const scene = s / S;
  const r = radius * (1 - e);
  return {
    focal: {
      scale: s,
      // for the card's own element, transform-origin 0 0: about f, in its own box
      transform:
        e <= 1e-9
          ? "none"
          : `translate(${f((1 - s) * (fx - c.x))}px, ${f((1 - s) * (fy - c.y))}px) scale(${f(s, 5)})`,
    },
    scene: {
      scale: scene,
      transform: done
        ? "none"
        : `translate(${f(fx * (1 - scene))}px, ${f(fy * (1 - scene))}px) scale(${f(scene, 5)})`,
      radius: `${f(r / Math.max(1e-9, scene))}px`,
    },
    others: others.map((b) => {
      const r2 = rectOf(b);
      const dCol = c.w > 0 ? (r2.x + r2.w / 2 - cc.x) / c.w : 0;
      const dRow = c.h > 0 ? (r2.y + r2.h / 2 - cc.y) / c.h : 0;
      return side({
        visible: e < 1 - 1e-9,
        x: e * push * dCol,
        y: e * push * dRow,
        scale: 1 - shrink * e,
        opacity: 1 - e,
      });
    }),
    radius: r,
    p: e,
  };
}

// --- a hard cut on purpose -------------------------------------------------------------

/**
 * A hard cut that reads as meant: both sides keep pushing in — the outgoing
 * from 1 to 1.04 on an ease-in, the incoming from 1.04/1.07 (≈ 0.972) to 1 on
 * an ease-out, so the push runs on at the same rate across the cut and the
 * incoming lands on its own size — and a pale flash rises in the frame
 * before the cut and dies over two frames after it. The cut sits 5/11 of the
 * way through the window. Defaults: Remotion's pushCut (its numbers: 1.04,
 * 1.07, a 0.2 flash of #f5f2ed; the incoming here ends at 1, built at full
 * size, instead of held at 1.07) over 0.36 s.
 * @param {number} t
 * @param {number} at the cut
 * @param {{ dur?: number, push?: number, flash?: number, colour?: string, fps?: number }} [o]
 * @returns {{ a: Side, b: Side, flash: { colour: string, opacity: number }, p: number }}
 */
export function pushCut(t, at, o = {}) {
  const { dur = 0.36, push = 1.04, flash = 0.2, colour = "#f5f2ed", fps = filmFps() } = o;
  const pre = (dur * 5) / 11;
  const post = dur - pre;
  const fr = 1 / fps;
  const fl =
    t >= at - fr && t < at
      ? flash * ((t - (at - fr)) / fr)
      : t >= at && t < at + 2 * fr
        ? flash * (1 - (t - at) / (2 * fr))
        : 0;
  const fo = { colour, opacity: clamp01(fl) };
  if (t < at) {
    const e = ease.in(2)(prog(t, at - pre, pre));
    return { a: side({ visible: true, scale: lerp(1, push, e) }), b: gone(), flash: fo, p: e };
  }
  const e = ease.out(2)(prog(t, at, post));
  // the outgoing's push carried on as Remotion's second stage (1.04 → 1.07):
  // the same ratio, ending on 1 instead of above it
  const from = push / (1 + (push - 1) * 1.75);
  return {
    a: gone(),
    b: side({ visible: true, scale: lerp(from, 1, e) }),
    flash: fo,
    p: e,
  };
}

/** the rate the film is drawn at: what `film render` tells the page
 *  (window.__filmFps; a draft is 30), else 60 */
const filmFps = () => {
  const f = /** @type {{ __filmFps?: number }} */ (globalThis).__filmFps;
  return typeof f === "number" && f > 0 ? f : 60;
};

/**
 * A dip cut: the outgoing frame darkens to `level` for its last frames before
 * a hard cut (≈ 40 % darker for 3 frames, as HyperFrames' motion notes
 * measured), so the cut reads as meant; with `settle`, the incoming arrives a
 * little large and settles on an ease-out (a cut on a click's rebound).
 * @param {number} t
 * @param {number} at the cut
 * @param {{ frames?: number, level?: number, settle?: number, settleDur?: number, fps?: number }} [o]
 *   settle: the incoming's first scale (default 1: none; 1.03 is a light one)
 * @returns {{ a: Side, b: Side, p: number }}
 */
export function dipCut(t, at, o = {}) {
  const { frames = 3, level = 0.6, settle = 1, settleDur = 0.25, fps = filmFps() } = o;
  if (t < at) {
    const dark = t >= at - frames / fps;
    return { a: side({ visible: true, brightness: dark ? level : 1 }), b: gone(), p: 0 };
  }
  const e = ease.out(3)(prog(t, at, settleDur));
  return { a: gone(), b: side({ visible: true, scale: lerp(settle, 1, e) }), p: e };
}

// --- every boundary, named once -----------------------------------------------------------

/** the kinds `seams` knows by name */
export const KINDS = Object.freeze(["curve", "whip", "depth", "inverse", "push", "dip", "cut"]);

/** other names a kind goes by: the functions' own names, and the words a
 *  beat sheet tends to use for the same seam */
export const ALIASES = Object.freeze({
  pushCut: "push",
  dipCut: "dip",
  "cut on the curve": "curve",
  "whip pan": "whip",
  "whip-pan": "whip",
  "into the lens": "depth",
  "hard cut": "cut",
});

/** seams that need more than two scenes and a time — each is a call of its
 *  own, with what it carries across */
const CALLS = Object.freeze({
  waterfall: "waterfall(t, at, nOut, nIn) — word by word, with how many words each side has",
  matchText: "matchText(t, start, end) — one line becoming another",
  morph: "morph(t, start, end, from, to) — a card growing into its panel, with both rects",
  parallax: "parallax(t, start, end, card, others, view) — one card of a grid becoming the scene",
});

/**
 * The kind a name means: one of KINDS, by its own name or one it goes by
 * ("pushCut" is "push", "into the lens" is "depth"), any case; null for any
 * other words. A seam that is a call of its own (`morph`, `waterfall`,
 * `matchText`, `parallax`) is null too — `seamCall(name)` says how to call it.
 * @param {unknown} name
 * @returns {string | null}
 */
export function kindOf(name) {
  if (typeof name !== "string") return null;
  const n = name.trim();
  if (KINDS.includes(n)) return n;
  const low = n.toLowerCase();
  for (const k of KINDS) if (k === low) return k;
  for (const [a, k] of Object.entries(ALIASES)) if (a.toLowerCase() === low) return k;
  return null;
}

/** how to call a seam that is not a kind but a call of its own, or null
 *  @param {unknown} name @returns {string | null} */
export function seamCall(name) {
  if (typeof name !== "string") return null;
  const low = name.trim().toLowerCase();
  for (const [k, how] of Object.entries(CALLS)) if (k.toLowerCase() === low) return how;
  return null;
}

/**
 * The seam at every boundary between two scenes, named once. Each entry:
 * `at` (a time, or a moment's name on the timeline), `from` and `to` (the two
 * scenes' elements, or their ids or selectors), `kind` — "curve" (also when
 * left out), "whip", "depth", "inverse", "push", "dip", "cut" (a plain hard
 * cut, on purpose) — or a name they go by, as `kindOf` reads it ("pushCut",
 * "into the lens") — or a function (t, at) → { a, b } of your own — and that
 * seam's options beside them (`dir`, `dur`, …; `span: [before, after]` (s) is
 * how long round `at` an own function's seam is open, default 1 s each side).
 * Each is declared on the
 * timeline as a cut at `at`, labelled with its kind, so `film render` lists
 * it and the score and `film probe` see it. `apply(t)` writes both sides of
 * every seam whose window is open at t onto its elements (see `apply`);
 * `at(t)` gives the same as numbers. Outside every window nothing is touched:
 * which scene shows then is the page's (or `scenes`', kit/time.js).
 * @param {{ event: (at: number | string, kind: string, o?: { label?: string }) => number } | null} tl
 * @param {{ at: number | string, from: unknown, to: unknown, kind?: string | ((t: number, at: number) => { a: Side, b: Side }), [k: string]: unknown }[]} list
 * @param {{ view?: View, el?: (name: unknown) => Element | null }} [o]
 */
export function seams(tl, list, o = {}) {
  const view = o.view ?? { width: 1920, height: 1080 };
  if (!Array.isArray(list)) throw new Error("seams: give it a list of boundaries");
  const items = list.map((s, i) => {
    const named = s.kind ?? "curve";
    const kind = typeof named === "function" ? named : kindOf(named);
    if (kind == null) {
      const call = seamCall(named);
      throw new Error(
        call
          ? `seams: boundary ${i}: "${named}" is a call of its own, not a kind: ${call}`
          : `seams: boundary ${i}: kind "${named}" is not one of ${KINDS.join(", ")} — or give a function`,
      );
    }
    const label = typeof kind === "function" ? kind.name || "own" : kind;
    const at = tl
      ? tl.event(s.at, "cut", { label: `seam: ${label}` })
      : typeof s.at === "number"
        ? s.at
        : Number.NaN;
    if (!Number.isFinite(at)) throw new Error(`seams: boundary ${i} is not at a time (${s.at})`);
    const { at: _a, from, to, kind: _k, ...opts } = s;
    return { at, from, to, kind, label, opts };
  });
  /** the window a seam touches its scenes in, [a, b]
   *  @param {(typeof items)[number]} s @returns {[number, number]} */
  const span = (s) => {
    const own = s.opts.span;
    if (Array.isArray(own)) return [s.at - Number(own[0]), s.at + Number(own[1])];
    /** an option's number, or its default @param {string} k @param {number} d */
    const n = (k, d) => (typeof s.opts[k] === "number" ? /** @type {number} */ (s.opts[k]) : d);
    switch (s.kind) {
      case "curve":
        return [s.at - n("dur", 0.3), s.at + n("dur", 0.3)];
      case "whip":
        return [s.at - n("dur", 0.55) / 2, s.at + n("dur", 0.55) / 2];
      case "depth":
      case "inverse":
        return [s.at - n("outDur", 0.2), s.at + n("inDur", 0.5)];
      case "push":
        return [s.at - (n("dur", 0.36) * 5) / 11, s.at + (n("dur", 0.36) * 6) / 11];
      case "dip":
        // its dark frames, and one more, before the cut
        return [
          s.at - Math.max(0.1, (n("frames", 3) + 1) / n("fps", filmFps())),
          s.at + n("settleDur", 0.25),
        ];
      case "cut":
        return [s.at - 1 / 120, s.at + 1 / 120];
      default:
        return [s.at - 1, s.at + 1];
    }
  };
  /** @param {(typeof items)[number]} s @param {number} t */
  const sidesAt = (s, t) => {
    const k = s.kind;
    const opts = /** @type {Record<string, any>} */ (s.opts);
    if (typeof k === "function") return k(t, s.at);
    if (k === "curve") return curve(t, s.at, opts);
    if (k === "whip") return whip(t, s.at, view, opts);
    if (k === "depth") return depth(t, s.at, opts);
    if (k === "inverse") return depth(t, s.at, { ...opts, inverse: true });
    if (k === "push") return pushCut(t, s.at, opts);
    if (k === "dip") return dipCut(t, s.at, opts);
    return t < s.at ? { a: still(), b: gone() } : { a: gone(), b: still() };
  };
  /** @type {Map<unknown, Element>} */
  const found = new Map();
  /** @param {unknown} name */
  const elOf = (name) => {
    if (name && typeof name === "object") return /** @type {Element} */ (name);
    const had = found.get(name);
    if (had) return had;
    const n = String(name);
    const el = o.el
      ? o.el(name)
      : (document.getElementById(n) ??
        (/^[#.[]|[\s>:]/.test(n) ? document.querySelector(n) : null));
    if (!el) throw new Error(`seams: no element for "${n}" (an element, an id or a selector)`);
    found.set(name, el);
    return el;
  };
  return {
    /** every boundary: its time, its kind, its window */
    list: () =>
      items.map((s) => ({ at: s.at, kind: s.label, from: s.from, to: s.to, span: span(s) })),
    /** the seams open at t, with both sides as numbers @param {number} t */
    at(t) {
      return items
        .filter((s) => {
          const [a, b] = span(s);
          return t >= a && t <= b;
        })
        .map((s) => ({ at: s.at, kind: s.label, ...sidesAt(s, t) }));
    },
    /**
     * Write both sides of every open seam onto its scenes. The scenes of every
     * closed seam are first set back to rest (no transform, filter or opacity
     * of a seam's), so a frame drawn out of order comes out the same; which
     * of them shows outside a seam is left alone — call `scenes`' show(t)
     * (kit/time.js) first, then this.
     * @param {number} t
     */
    apply(t) {
      const open = items.filter((s) => {
        const [a, b] = span(s);
        return t >= a && t <= b;
      });
      for (const s of items) {
        if (open.includes(s)) continue;
        for (const name of [s.from, s.to]) rest(elOf(name));
      }
      let fl = 0;
      let colour = "#fff";
      for (const s of open) {
        const r = sidesAt(s, t);
        apply(elOf(s.from), r.a);
        apply(elOf(s.to), r.b);
        if ("flash" in r && r.flash) {
          const x = /** @type {{ colour: string, opacity: number }} */ (r.flash);
          if (x.opacity > fl) {
            fl = x.opacity;
            colour = x.colour;
          }
        }
      }
      if (fl > 0 || flashLayer) flashOn({ colour, opacity: fl });
    },
  };
}

// --- writing a side onto an element ---------------------------------------------------------

/** @type {WeakMap<Element, SVGFEGaussianBlurElement>} */
const axisBlurs = new WeakMap();
let blurIds = 0;

/**
 * Write one side onto an element: visibility (never display, so what is in
 * it keeps its layout), opacity, transform (transform-origin is the page's:
 * the centre, unless it set another), filter. A blur along one axis is an SVG
 * filter (feGaussianBlur with "σ 0"), made once per element and removed from
 * the element's style the moment the blur is 0 — a filter left on keeps the
 * layer soft.
 * @param {Element} el
 * @param {Side} s
 */
export function apply(el, s) {
  const st = /** @type {HTMLElement} */ (el).style;
  st.visibility = s.visible ? "inherit" : "hidden";
  st.opacity = s.opacity >= 1 ? "" : String(f(s.opacity, 4));
  st.transform = s.transform === "none" ? "" : s.transform;
  if (s.blurAxis && s.blur > 0) {
    let fe = axisBlurs.get(el);
    if (!fe) {
      const ns = "http://www.w3.org/2000/svg";
      const svg = document.createElementNS(ns, "svg");
      svg.setAttribute("width", "0");
      svg.setAttribute("height", "0");
      svg.style.position = "absolute";
      const filter = document.createElementNS(ns, "filter");
      const id = `ot-seam-blur-${++blurIds}`;
      filter.setAttribute("id", id);
      filter.setAttribute("x", "-20%");
      filter.setAttribute("width", "140%");
      filter.setAttribute("y", "-20%");
      filter.setAttribute("height", "140%");
      fe = /** @type {SVGFEGaussianBlurElement} */ (document.createElementNS(ns, "feGaussianBlur"));
      filter.append(fe);
      svg.append(filter);
      document.body.append(svg);
      axisBlurs.set(el, fe);
      fe.dataset.id = id;
    }
    fe.setAttribute("stdDeviation", s.blurAxis === "x" ? `${f(s.blur, 2)} 0` : `0 ${f(s.blur, 2)}`);
    const rest = s.filter === "none" ? "" : ` ${s.filter}`;
    st.filter = `url(#${fe.dataset.id})${rest}`;
  } else st.filter = s.filter === "none" ? "" : s.filter;
}

/** a seam's own styles off an element: at rest @param {Element} el */
function rest(el) {
  const st = /** @type {HTMLElement} */ (el).style;
  st.opacity = "";
  st.transform = "";
  st.filter = "";
}

/** a flash over the whole frame: one layer, made once, above everything */
/** @type {HTMLElement | null} */
let flashLayer = null;
/** @param {{ colour: string, opacity: number }} fl */
function flashOn(fl) {
  let d = flashLayer;
  if (!d) {
    d = document.createElement("div");
    d.style.cssText = "position:fixed;inset:0;pointer-events:none;z-index:2147483647";
    document.body.append(d);
    flashLayer = d;
  }
  d.style.background = fl.colour;
  d.style.opacity = String(f(fl.opacity, 4));
  d.style.visibility = fl.opacity > 0 ? "inherit" : "hidden";
}
