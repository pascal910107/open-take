// handoff.js — one scene handing over to the next, one call each, as plain
// functions of film time t: give it t and when, read back each side as CSS
// (transform, opacity, visibility) and where the thing carried across is.
// No state: a frame drawn twice or out of order comes out the same. Built on
// the kit's measured seams and moves — kit/seams.js's whip, kit/motion.js's
// morphRect and rectClip — with what a launch film's scene change does
// round them: one thing staying on screen and travelling to its place in the
// next scene, a panel rising in, a push through what was clicked into the view
// it opens.
//
// Nothing here blurs: the master's shutter (`film render`) smears whatever
// moves fast, so a whip or a panel's first frames come out blurred and its
// landing sharp. A draft has no shutter — `film still --at` shows a handoff as
// the master will.
//
//   import { whip, carry, panel, through, apply } from "./lib/handoff.js";
//   // this scene whips out to the left, the next arrives from the right on the
//   // same strip, and the avatar travels from its place here to its place there
//   const h = whip(t, 6.0, { dir: "left", carry: { from: avatarHere, to: avatarThere } });
//   apply(sceneA, h.a); apply(sceneB, h.b); apply(avatar, h.carry);
//
//   whip(t, at, o)                   the scene leaves along `dir`, the next arriving behind it on one
//                                    strip (dir "up": the next comes up from below as this one leaves
//                                    upward); `carry` travels one thing across meanwhile
//   carry(t, start, end, from, to, o) one thing between two places: in an arc, its size in log space
//   panel(t, at, o)                  a panel rising in from below, fastest at once and settling
//   through(t, start, end, rect, o)  a push through what was clicked: it opens into the view it leads
//                                    to, the scene growing with it
//   apply(el, side)                  writes one of them onto an element
//
// Rects are { x, y, w, h, r? } in frame px. A device's `at(pose).toFrame(x, y)`
// (lib/devices.js) gives a point of its screen in the frame, so a row on a
// laptop's screen can be the rect a push goes through.
// What each side is laid out as: a scene at its place at rest (the whole
// frame, usually); the thing carried at its place in the next scene (`to`),
// so it lands sharp; the view a push opens at the whole frame.

import { morphRect, rectClip } from "../kit/motion.js";
import { apply as applySide, ease, side, whip as stripWhip } from "../kit/seams.js";

/** @typedef {{ x: number, y: number, w: number, h: number, r?: number }} Rect  in frame px */
/** @typedef {{ width: number, height: number }} View */
/** @typedef {import("../kit/seams.js").Side & { origin?: string, radius?: string, clip?: string }} Side
 *  one side at t: kit/seams.js's, and the transform-origin, border-radius and clip it needs, if any */
/**
 * @typedef {object} Carried  the thing carried, at t
 * @property {number} x @property {number} y @property {number} w @property {number} h  where it is (frame px)
 * @property {number} scale  its size against its place in the next scene
 * @property {number} p  0 → 1 along the way
 * @property {boolean} visible
 * @property {number} opacity
 * @property {string} transform  for an element laid out at `to`, transform-origin 0 0 ("none" once there)
 * @property {string} filter
 * @property {string} origin  "0 0"
 */

const FRAME = { width: 1920, height: 1080 };

/** @param {number} x */
const clamp01 = (x) => Math.max(0, Math.min(1, x));
/** @param {number} a @param {number} b @param {number} p */
const lerp = (a, b, p) => a + (b - a) * p;
/** @param {number} v */
const f3 = (v) => +v.toFixed(3);
/** @param {unknown} r @param {string} who @returns {Rect} */
function rectOf(r, who) {
  const o = /** @type {Record<string, number> | null} */ (r && typeof r === "object" ? r : null);
  const w = o ? (o.w ?? o.width) : undefined;
  const h = o ? (o.h ?? o.height) : undefined;
  if (!o || !Number.isFinite(o.x) || !Number.isFinite(o.y) || !(Number(w) > 0) || !(Number(h) > 0))
    throw new Error(
      `handoff: ${who} is a rect { x, y, w, h } in frame px (got ${JSON.stringify(r)})`,
    );
  return { x: Number(o.x), y: Number(o.y), w: Number(w), h: Number(h), r: Number(o.r ?? 0) };
}

/**
 * One thing travelling from one place to another between `start` and `end`:
 * its middle on a straight line bowed upward by `arc` px at halfway (a thrown
 * thing's path; default a sixth of the distance), its width changing in log
 * space so a growth reads steady (its height follows its width). Before
 * `start` it is at `from`; from `end` on at `to`, untransformed.
 * `const c = carry(t, 4.2, 4.9, avatarOnLaptop, avatarOnPhone); apply(avatar, c);`
 * @param {number} t
 * @param {number} start
 * @param {number} end
 * @param {Rect} from
 * @param {Rect} to  where it is laid out
 * @param {{ ease?: (p: number) => number, arc?: number }} [o]  ease default in-out (cubic)
 * @returns {Carried}
 */
export function carry(t, start, end, from, to, o = {}) {
  const a = rectOf(from, "carry's from");
  const b = rectOf(to, "carry's to");
  const curve = o.ease ?? ease.inOut(3);
  const p = end > start ? curve(clamp01((t - start) / (end - start))) : t >= end ? 1 : 0;
  const ca = { x: a.x + a.w / 2, y: a.y + a.h / 2 };
  const cb = { x: b.x + b.w / 2, y: b.y + b.h / 2 };
  const arc = o.arc ?? Math.hypot(cb.x - ca.x, cb.y - ca.y) / 6;
  const w = a.w * (b.w / a.w) ** p;
  const s = w / b.w;
  const h = b.h * s;
  const cx = lerp(ca.x, cb.x, p);
  const cy = lerp(ca.y, cb.y, p) - 4 * arc * p * (1 - p);
  const x = cx - w / 2;
  const y = cy - h / 2;
  const there = p >= 1 - 1e-9;
  return {
    x,
    y,
    w,
    h,
    scale: s,
    p,
    visible: true,
    opacity: 1,
    transform: there
      ? "none"
      : `translate(${f3(x - b.x)}px, ${f3(y - b.y)}px) scale(${+s.toFixed(5)})`,
    filter: "none",
    origin: "0 0",
  };
}

/**
 * A whip: this scene and the next ride one strip one frame long, the next
 * docked beyond this one, and the strip moves a frame's width (or height) on
 * one ease-in-out — kit/seams.js's whip, whose speed across the seam is the
 * same on both sides by construction. `at` is the middle, its fastest moment.
 * With `carry`, one thing stays on screen above both and travels from its
 * place in this scene to its place in the next, leaving as the whip starts
 * and landing `settle` s after it ends — the thing the film follows, moving
 * on while the world round it changes. Default 0.5 s (the launch film these
 * notes came from changed scene in 0.4–0.5 s).
 * `const h = whip(t, 6, { dir: "up", carry: { from: here, to: there } })`
 * @param {number} t
 * @param {number} at
 * @param {{ dir?: "left" | "right" | "up" | "down", dur?: number, power?: number, view?: View, carry?: { from: Rect, to: Rect, arc?: number, settle?: number } }} [o]
 * @returns {{ a: Side, b: Side, carry: Carried | null, p: number, edge: number | null }}
 *   a: this scene, b: the next (each at its place at rest); edge: where they meet, along the strip (frame px)
 */
export function whip(t, at, o = {}) {
  const { dir = "left", dur = 0.5, power = 3, view = FRAME } = o;
  const s = stripWhip(t, at, view, { dir, dur, power });
  const c = o.carry;
  return {
    a: s.a,
    b: s.b,
    carry: c
      ? carry(t, at - dur / 2, at + dur / 2 + (c.settle ?? 0.2), c.from, c.to, {
          ...(c.arc != null ? { arc: c.arc } : {}),
        })
      : null,
    p: s.p,
    edge: s.edge,
  };
}

/**
 * A panel rising in over the scene from `dy` px below its place: fastest at
 * once, closing on its place exponentially (the reference's fling, τ 22 % of
 * the move), so the master's shutter smears its first frames and it lands
 * sharp; seen from its first frame (opacity over the first 0.08 s). With
 * `recede` and `dim`, the scene under it steps back a little meanwhile and
 * stays so.
 * `const r = panel(t, 7.4, { dy: 260 }); apply(card, r.panel); apply(scene, r.under);`
 * @param {number} t
 * @param {number} at
 * @param {{ dy?: number, dur?: number, tau?: number, from?: number, recede?: number, dim?: number }} [o]
 *   dy (default 240 px), dur (default 0.6 s), tau (share of dur, default 0.22), from: its first
 *   scale (default 0.97); recede: the scene under it ends at this scale (default 1: unmoved),
 *   dim: its brightness (default 1)
 * @returns {{ panel: Side, under: Side, p: number }}
 */
export function panel(t, at, o = {}) {
  const { dy = 240, dur = 0.6, tau = 0.22, from = 0.97, recede = 1, dim = 1 } = o;
  if (t < at)
    return { panel: side({ visible: false, opacity: 0 }), under: side({ visible: true }), p: 0 };
  const u = clamp01((t - at) / dur);
  const e = (1 - Math.exp(-u / tau)) / (1 - Math.exp(-1 / tau));
  return {
    panel: {
      ...side({
        visible: true,
        y: dy * (1 - e),
        scale: lerp(from, 1, e),
        opacity: clamp01((t - at) / 0.08),
      }),
      origin: "50% 100%",
    },
    under: {
      ...side({ visible: true, scale: lerp(1, recede, e), brightness: lerp(1, dim, e) }),
      origin: "50% 50%",
    },
    p: e,
  };
}

/**
 * A push through what was clicked: `rect` opens into the view it leads to.
 * A window grows from `rect` to the whole frame (kit/motion.js's morphRect:
 * its size in log space, its corners going square); the view, built at the
 * frame's size, is scaled to cover the window and shown through it (a clip,
 * no stretch), fading in over the first `fade` of the move; the scene under
 * it grows with the window, so what was clicked stays under it, and is hidden
 * once the window fills the frame. One ease for all of it (default in-out,
 * cubic). Put both on elements the size of the frame: `apply` sets their
 * transform-origin (0 0) and the view's clip.
 * `const g = through(t, 8.1, 8.75, rowRect); apply(list, g.a); apply(detail, g.b);`
 * @param {number} t
 * @param {number} start
 * @param {number} end  0.5–0.8 s after start reads as a push; longer, as a zoom
 * @param {Rect} rect  what was clicked, in frame px
 * @param {{ view?: View, ease?: (p: number) => number, fade?: number }} [o]  fade: share of the move (default 0.3)
 * @returns {{ a: Side, b: Side & { clip: string }, window: Rect, p: number }}
 *   window: where the view shows through, frame px
 */
export function through(t, start, end, rect, o = {}) {
  const r = rectOf(rect, "through's rect");
  const { view = FRAME, fade = 0.3 } = o;
  const curve = o.ease ?? ease.inOut(3);
  const q = end > start ? clamp01((t - start) / (end - start)) : t >= end ? 1 : 0;
  const whole = { x: 0, y: 0, w: view.width, h: view.height, r: 0 };
  if (t < start)
    return {
      a: { ...side({ visible: true }), origin: "0 0" },
      b: { ...side({ visible: false, opacity: 0 }), origin: "0 0", clip: "" },
      window: r,
      p: 0,
    };
  const win = morphRect(t, start, end, r, whole, { ease: curve });
  const done = q >= 1;
  // the scene: what was clicked kept under the window — its width (or its
  // height, for something taller than the frame's shape) grown to the window's
  const wide = r.w / r.h >= view.width / view.height;
  const sa = wide ? win.w / r.w : win.h / r.h;
  const ax = win.x + win.w / 2 - sa * (r.x + r.w / 2);
  const ay = win.y + win.h / 2 - sa * (r.y + r.h / 2);
  // the view: covering the window, centred on it
  const sb = Math.max(win.w / view.width, win.h / view.height);
  const bx = win.x + win.w / 2 - (sb * view.width) / 2;
  const by = win.y + win.h / 2 - (sb * view.height) / 2;
  // the window in the view's own px, for its clip
  const local = {
    x: (win.x - bx) / sb,
    y: (win.y - by) / sb,
    w: win.w / sb,
    h: win.h / sb,
    r: win.r / sb,
  };
  return {
    a: { ...side({ visible: !done, x: ax, y: ay, scale: sa }), origin: "0 0" },
    b: {
      ...side({
        visible: true,
        x: done ? 0 : bx,
        y: done ? 0 : by,
        scale: done ? 1 : sb,
        opacity: clamp01(q / Math.max(1e-9, fade)),
      }),
      origin: "0 0",
      clip: done ? "" : rectClip(local, view),
    },
    window: { x: win.x, y: win.y, w: win.w, h: win.h, r: win.r },
    p: win.p,
  };
}

/**
 * Write a side (or a carried thing) onto an element: visibility, opacity,
 * transform, filter (kit/seams.js's apply), and the transform-origin,
 * border-radius and clip it names. A side at rest is left with no transform or filter.
 * @param {Element} el
 * @param {Side | Carried} s
 */
export function apply(el, s) {
  applySide(
    el,
    /** @type {import("../kit/seams.js").Side} */ ({
      blur: 0,
      blurAxis: null,
      brightness: 1,
      ...s,
    }),
  );
  const st = /** @type {HTMLElement} */ (el).style;
  if (s.origin) st.transformOrigin = s.origin;
  if ("radius" in s && s.radius != null) st.borderRadius = s.radius;
  if ("clip" in s && typeof s.clip === "string") st.clipPath = s.clip;
}
