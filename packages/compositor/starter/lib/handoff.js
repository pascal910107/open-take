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
//   import { whip, carry, carryAlong, panel, through, apply } from "./lib/handoff.js";
//   // this scene whips out to the left, the next arrives from the right on the
//   // same strip, and the avatar travels from its place here to its place there
//   const h = whip(t, 6.0, { dir: "left", carry: { from: avatarHere, to: avatarThere } });
//   apply(sceneA, h.a); apply(sceneB, h.b); apply(avatar, h.carry);
//
//   whip(t, at, o)                   the scene leaves along `dir`, the next arriving behind it on one
//                                    strip (dir "up": the next comes up from below as this one leaves
//                                    upward); `carry` travels one thing across meanwhile
//   carry(t, start, end, from, to, o) one thing between two places: in an arc, its size in log space
//   carryAlong(t, places, o)         one thing through a list of places over the film, each of them
//                                    still or moving, travelling to the next when its time comes
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
 * @typedef {object} Place  one place the thing sits, and how it gets there
 * @property {Rect | ((t: number) => Rect | null)} at  where: a rect, or one read at t (an element's box, a
 *   device's `toFrame`, a 3D point seen by the lens) — null while it cannot be seen
 * @property {number} [from]  when it leaves the place before for this one (not read on the first place)
 * @property {number} [to]  when it lands (default 0.6 s after `from`)
 * @property {number} [arc]  the bow of that trip (px; default a sixth of the distance)
 * @property {(p: number) => number} [ease]
 */

/**
 * One thing through many places — the face, the file, the card a film
 * follows from its first scene to its last. `places` in time order: it sits
 * on the first until the second's `from`, travels to the second by its `to`
 * (carry's path: an arc, its width in log space), sits there, and so on.
 * A place may be a function of t — where an element is now
 * (`() => box(el)`), a point on a device's screen, a point in 3D — and is
 * read at every t, during the trip too, so the thing leaves a place that is
 * moving and lands on one that is moving, and rides it after. Between trips
 * it is at its place, to the pixel.
 * Lay the element out once, anywhere, and say where with `laid` (default: at
 * 0, 0, the size of the first place): `transform` is for that layout, origin
 * 0 0, so the same element serves every place. `place` is the place it is
 * on or travelling to, `moving` whether it is between two.
 * A place that cannot be read (null) hides the thing while it is on it or
 * bound for it; one it is leaving is read where it last could be.
 * `const c = carryAlong(t, [{ at: () => box(replyFace) }, { from: 5.3, to: 6.5, at: () => box(cloudSlot) },
 *   { from: 9.5, to: 11, at: () => box(paneFace) }], { laid: { x: 0, y: 0, w: 160, h: 160 } }); apply(face, c);`
 * @param {number} t
 * @param {Place[]} places  in time order
 * @param {{ laid?: Rect, ease?: (p: number) => number, arc?: number }} [o]  ease and arc: for every trip
 *   that does not say its own
 * @returns {Carried & { place: number, moving: boolean }}
 */
export function carryAlong(t, places, o = {}) {
  if (!places.length) throw new Error("handoff: carryAlong needs places [{ at }, { from, to, at }, …]");
  let i = 0;
  for (let k = 1; k < places.length; k++) {
    const at = /** @type {Place} */ (places[k]).from;
    if (!Number.isFinite(at)) throw new Error(`handoff: carryAlong's place ${k} needs \`from\`, when the thing leaves for it`);
    if (t >= /** @type {number} */ (at)) i = k;
  }
  const read = (/** @type {number} */ k) => {
    const pl = /** @type {Place} */ (places[k]);
    const r = typeof pl.at === "function" ? pl.at(t) : pl.at;
    return r == null ? null : rectOf(r, `carryAlong's place ${k}`);
  };
  const cur = /** @type {Place} */ (places[i]);
  const here = read(i);
  // the place it left: the nearest one before that can be read
  let prev = null;
  for (let k = i - 1; k >= 0 && !prev; k--) prev = read(k);
  const first = read(0);
  const laid = o.laid ? rectOf(o.laid, "carryAlong's laid") : { x: 0, y: 0, w: first?.w ?? here?.w ?? 1, h: first?.h ?? here?.h ?? 1 };
  const start = cur.from ?? -Infinity;
  const end = cur.to ?? start + 0.6;
  const moving = i > 0 && t < end;
  if (!here) {
    return {
      x: 0, y: 0, w: laid.w, h: laid.h, scale: 1, p: moving ? 0 : 1, visible: false, opacity: 0,
      transform: "none", filter: "none", origin: "0 0", place: i, moving,
    };
  }
  const ease = cur.ease ?? o.ease;
  const arc = cur.arc ?? o.arc;
  const c =
    i === 0 || !prev
      ? { x: here.x, y: here.y, w: here.w, h: here.h, p: 1 }
      : carry(t, start, end, prev, here, { ...(ease ? { ease } : {}), ...(arc != null ? { arc } : {}) });
  const s = c.w / laid.w;
  return {
    x: c.x,
    y: c.y,
    w: c.w,
    h: c.h,
    scale: s,
    p: c.p,
    visible: true,
    opacity: 1,
    transform: `translate(${f3(c.x - laid.x * s)}px, ${f3(c.y - laid.y * s)}px) scale(${+s.toFixed(5)})`,
    filter: "none",
    origin: "0 0",
    place: i,
    moving,
  };
}

/**
 * The box of an element in the frame, now: for a place of carryAlong's, or
 * a rect of `through`'s. It reads the page's layout when called, so draw the
 * scene for t first. `host`: the element the frame is measured from
 * (default the page's top-left).
 * `{ from: 9.5, to: 11, at: () => box(paneFace) }`
 * @param {Element} el @param {{ host?: Element | null }} [o] @returns {Rect | null}  null when it has no box (hidden by display)
 */
export function box(el, o = {}) {
  const r = el.getBoundingClientRect();
  if (r.width === 0 && r.height === 0) return null;
  const h = o.host?.getBoundingClientRect() ?? { left: 0, top: 0 };
  return { x: r.left - h.left, y: r.top - h.top, w: r.width, h: r.height };
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
 * The push goes through what can be seen: the part of `rect` inside the
 * frame is used (a row running off the right edge opens from its visible
 * part; taken whole, a rect wider than the frame would shrink the scene and
 * show the ground round it), and a rect wholly outside the frame is an
 * error. The scene is never drawn short of the frame's edges: where the
 * window travels faster than the scene grows (a rect near an edge), the
 * scene is held to the edge and what was clicked slips a little under the
 * window, which the view is covering by then.
 * Over a live 3D canvas (lib/space.js): `a` goes on the element that holds
 * the canvas, the size of the frame, and scales it as a flat picture — so
 * give the rect as the lens sees it when the push starts
 * (`st.toFrame(p, start)` for two corners, not at t: the push holds the
 * picture it began on), keep the lens from travelling on during the push
 * (its move would slide what was clicked out from under the window; a slow
 * drift is fine), and keep drawing the canvas each frame until `a` is
 * hidden. The canvas's pixels are enlarged with it, up to frame ÷ rect
 * (3.7× for a 520 px row); the view has faded in over them by the first
 * `fade` of the move, when the push has barely begun (1.15× for that row).
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
  const asked = rectOf(rect, "through's rect");
  const { view = FRAME, fade = 0.3 } = o;
  // the part of it inside the frame
  const x0 = Math.max(0, asked.x), y0 = Math.max(0, asked.y);
  const x1 = Math.min(view.width, asked.x + asked.w), y1 = Math.min(view.height, asked.y + asked.h);
  if (!(x1 > x0 && y1 > y0))
    throw new Error(
      `handoff: through's rect is outside the ${view.width} × ${view.height} frame (got ${JSON.stringify(rect)}): it is what was clicked, in frame px`,
    );
  const r = { x: x0, y: y0, w: x1 - x0, h: y1 - y0, r: Math.min(asked.r ?? 0, (x1 - x0) / 2, (y1 - y0) / 2) };
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
  // …and never short of the frame's edges (sa is 1 or more: the rect is inside the frame)
  const ax = Math.min(0, Math.max(view.width * (1 - sa), win.x + win.w / 2 - sa * (r.x + r.w / 2)));
  const ay = Math.min(0, Math.max(view.height * (1 - sa), win.y + win.h / 2 - sa * (r.y + r.h / 2)));
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
