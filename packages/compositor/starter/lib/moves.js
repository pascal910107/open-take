// moves.js — camera and cut moves for a film built of flat layers (a desk,
// windows, cards, a screen): the 2.5D moves launch reels make out of them.
// Plain functions of film time t (s), no state, nothing here knows any film.
// Each gives back where each layer is — { x, y, s, … } with its CSS `css`
// and `origin` — for you to write onto your elements (`apply` does it).
// Their defaults are numbers measured frame by frame on launch reels; the
// comment over each says where. Read as px of a 1920 × 1080 frame unless a
// `view` says otherwise.
//
//   import { windowHop, momentumCut, apply } from "./lib/moves.js";
//
//   windowHop(t, t0, from, to, o)       pull out of one window to the desk, a beat, the next window lifts
//                                       to the lens while the desk only slides (layers, not one zoom);
//                                       `from` a window, or the camera the take is on, still moving
//   pullbackReveal(t, t0, o)            the full frame pulls back into a plane in space, its width shrinking
//                                       at an even rate on screen, then drifting on
//   stations(t, list, o)                a camera from station to station: quick to leave, eleven frames to
//                                       slow, then creeping on until it leaves again
//   station(rect, o)                    the camera that frames a rect the way each station did (0.635 W)
//   stationTimes(list, o)               when each leg peaks and lands, and how long each station is held
//   camPose(cam, view)                  a camera { x, y, s } as the pose of the world's layer
//   momentumCut(t, at, o)               leave faster every frame, cut on the fastest, the next shot
//                                       carrying on the same way and slowing; a scene's ground kept
//                                       past its edge meanwhile
//   rampJump(t, at, o)                  a push that speeds up, jumps 1.4× in one frame, and settles;
//                                       its `cam` is where a further move carries on from
//   exitDrift(t, t0, t1, o)             a hold that drifts, then speeds away into the cut at t1
//   arrivalShake(t, t0, o)              the page kicked sideways for 3–4 frames when something lands
//   blurBridge(t, at, o)                out of focus, cut, into focus
//   zoomThrough(t, start, end, rect, o) fly into a rect faster and faster, cut on the fastest frame
//   toThumbnail(t, start, from, to, o)  a flash, and the whole picture shrinks into its thumbnail
//   implodeTo(t, start, items, to, o)   a crowd collapses into a point that grows into one thing
//   develop(t, start, o)                a picture arriving as a duotone, then a second, then finished
//   remap(t, keys, o)                   film time → the time a stretch is drawn at: ramps, freezes, on twos
//   freeze(at, o)                       the keys of a freeze: slow, hold, speed up again
//   onTwos(t, n, fps)                   time held for n frames at a time (drawn on twos)
//   apply(el, pose)                     writes a pose onto an element
//
// A cut here falls between two frames of the film as it is drawn
// (window.__filmFps, which `film render` sets; else 60), so the master's
// shutter never mixes the two sides. Each move that cuts returns `cutAt`:
// declare it, `tl.event(m.cutAt, "cut")` — rampJump's jump, a cut hidden in
// the move, as `tl.event(j.cutAt, "hidden-cut")` — and the render report
// counts it as meant. A windowHop's lift is a picture jump the report cannot
// tell from a cut: declare its span as a segment of its own,
// `tl.segment(h.lifts, h.end, { handoff: "lift" })`. Nothing here blurs: the
// master's shutter smears what moves fast, and a move that cuts keeps moving
// at its last speed through the half of the last frame's shutter before the
// cut (and the next shot at its first speed through the half after), so the
// fastest frame is smeared whole. A draft has no shutter — `film still --at`
// shows a frame as the master will.
//
// One element per move. A pose is a whole transform: two moves applied to
// one element overwrite each other. A scene that comes in on one move and
// leaves on another is two elements, one inside the other, each given its
// own (`<div id="sceneOut"><div id="sceneIn">…</div></div>`). A Rect is in
// the layout of the element the pose is for — frame px when that element is
// at 0, 0 the size of the frame, as a desk, world or stage layer is — not
// where some other move has carried it on screen.
//
// One take, several moves: a camera is { x, y, s } — the world point at the
// frame's centre and the scale (anim.js cam2d) — and the moves that carry a
// take on read one where they start, as it is or as a function of t for one
// still moving: stations' `from`, windowHop's `from`, pullbackReveal's
// `from`, rampJump's `from`. Each gives a camera back (`cam`, or itself), so
// the world stays one element: `apply(world, camPose(stations(t, list,
// { from: (t) => rampJump(t, at, o).cam })))`. A move that starts from a
// camera still moving starts from rest on top of it (over `soft` s), so the
// picture's speed does not step where one move hands over to the next.

import { clamp, ease, lerp, named, prog } from "./anim.js";

/** @typedef {import("./anim.js").Ease} Ease */
/** @typedef {{ x: number, y: number, w: number, h: number }} Rect  in frame px */
/** @typedef {{ width: number, height: number }} View */
/**
 * @typedef {object} Pose  where a layer is drawn, against its place at rest
 * @property {number} x @property {number} y  translation (px)
 * @property {number} s  scale
 * @property {number} [r]  rotation (deg)
 * @property {number} [ry]  turned about its vertical axis (deg)
 * @property {number} [blur]  px
 * @property {number} [opacity]
 * @property {boolean} [visible]
 * @property {string} css  its CSS transform
 * @property {string} origin  the transform-origin `css` is written for
 * @property {{ px: number, view: View, ground?: string }} [cover]  a scene's ground kept this far past
 *   its edge while it is carried (momentumCut); `apply` paints it
 */
/** @typedef {Cam | ((t: number) => Cam)} CamFrom  a camera, or one read from film time (still moving) */
/** @typedef {Record<string, number>} Cam  a camera pose, e.g. anim.js cam2d's { x, y, s } (`s` mixes in log space) */

const FRAME = { width: 1920, height: 1080 };

/** the rate the film is drawn at: what `film render` tells the page, else 60 */
const filmFps = () => {
  const f = /** @type {{ __filmFps?: number }} */ (globalThis).__filmFps;
  return typeof f === "number" && f > 0 ? f : 60;
};
/** the frame t falls in, at fps @param {number} t @param {number} fps */
const frameOf = (t, fps) => Math.round(t * fps + 1e-9);
/** t is in the frame `at` falls in, or later @param {number} t @param {number} at @param {number} fps */
const crossed = (t, at, fps) => frameOf(t, fps) >= frameOf(at, fps);
const f3 = (/** @type {number} */ v) => +v.toFixed(3);

/**
 * An ease run on past its ends for the half frame of shutter on either side
 * of a cut: past 1 at the speed of its last frame, below 0 at the speed of
 * its first, so the frame on each side of the cut is smeared by a move that
 * is still going, not by one that stopped at the frame's own time.
 * @param {Ease} f @param {number} u @param {number} h  one frame, as a share of the move
 */
function carried(f, u, h) {
  const k = Math.min(1, Math.max(1e-6, h));
  if (u > 1) return 1 + ((f(1) - f(1 - k)) / k) * (u - 1);
  if (u < 0) return ((f(k) - f(0)) / k) * u;
  return f(u);
}

/** a rect with a size, or a plain error naming the move @param {string} who @param {string} what @param {Rect} r */
function sized(who, what, r) {
  if (!(r && r.w > 0 && r.h > 0))
    throw new Error(`moves: ${who}'s ${what} needs a width and height above 0 (got ${JSON.stringify(r)})`);
}

/**
 * A pose with its CSS. origin "0 0" or "50% 50%".
 * @param {{ x?: number, y?: number, s?: number, r?: number, ry?: number, blur?: number, opacity?: number, visible?: boolean, perspective?: number }} p
 * @param {string} [origin]
 * @returns {Pose}
 */
function pose(p, origin = "50% 50%") {
  const { x = 0, y = 0, s = 1, r = 0, ry = 0, perspective = 2000 } = p;
  let css = `translate(${f3(x)}px, ${f3(y)}px)`;
  if (ry) css += ` perspective(${perspective}px) rotateY(${f3(ry)}deg)`;
  css += ` scale(${+s.toFixed(5)})`;
  if (r) css += ` rotate(${f3(r)}deg)`;
  /** @type {Pose} */
  const out = { x, y, s, css, origin };
  if (r) out.r = r;
  if (ry) out.ry = ry;
  if (p.blur != null) out.blur = p.blur;
  if (p.opacity != null) out.opacity = p.opacity;
  if (p.visible != null) out.visible = p.visible;
  return out;
}

/**
 * Write a pose onto an element: its transform and transform-origin, and its
 * opacity, blur and visibility when the pose has them. A pose that is
 * visible shows the element whenever its parent shows, whatever the
 * stylesheet says (a later scene hidden in CSS until its cut comes in); one
 * that is not hides it.
 * `apply(desk, hop.desk); apply(next, hop.to);`
 * @param {Element} el @param {Pose} p
 */
export function apply(el, p) {
  const st = /** @type {HTMLElement} */ (el).style;
  st.transform = p.css;
  st.transformOrigin = p.origin;
  if (p.opacity != null) st.opacity = String(p.opacity);
  if (p.blur != null) st.filter = p.blur > 0.01 ? `blur(${f3(p.blur)}px)` : "none";
  // shown as its parent is: "inherit" overrides a stylesheet's "hidden" yet
  // stays hidden inside a scene that is hidden ("visible" would show it there)
  if (p.visible != null) st.visibility = p.visible ? "inherit" : "hidden";
  // a ground painted for a cut is taken off by the next pose without one
  if (p.cover) ground(/** @type {HTMLElement} */ (el), p, p.cover);
  else unground(/** @type {HTMLElement} */ (el));
}

/** take off the ground `apply` painted past an element's edge, if it did @param {HTMLElement} el */
function unground(el) {
  if (el.dataset?.movesGround !== "1") return;
  el.style.boxShadow = "";
  delete el.dataset.movesGround;
}

/**
 * A scene carried off its place keeps its ground past its edge: an element
 * that covers the frame and paints one flat colour of its own has that
 * colour painted `px` further out on every side (a box-shadow: nothing is
 * laid out again, and the frame clips it); one that is, or is backed by, a
 * picture or a gradient is drawn larger about its middle by just what the
 * move uncovers; one that paints nothing of its own, or is smaller than the
 * frame (a card, a title), is left alone — what shows past it does not move.
 * @param {HTMLElement} el @param {Pose} p @param {{ px: number, view: View, ground?: string }} c
 */
function ground(el, p, c) {
  const st = el.style;
  const clear = () => unground(el);
  const w = el.offsetWidth, h = el.offsetHeight;
  if (!(c.px > 0) || w < c.view.width - 1 || h < c.view.height - 1) return clear();
  let colour = c.ground;
  if (!colour) {
    const cs = getComputedStyle(el);
    const flat = cs.backgroundColor;
    const picture = cs.backgroundImage !== "none" || /^(img|video|canvas)$/i.test(el.tagName);
    if (picture) {
      clear();
      st.transform = `${p.css} scale(${(1 + 2 * Math.max(Math.abs(p.x) / w, Math.abs(p.y) / h)).toFixed(5)})`;
      return;
    }
    if (!flat || flat === "transparent" || /,\s*0\)$/.test(flat)) return clear();
    colour = flat;
  }
  st.boxShadow = `0 0 0 ${Math.ceil(c.px)}px ${colour}`;
  el.dataset.movesGround = "1";
}

/**
 * A curve through measured points [[u, v], …] (u and v both 0 → 1),
 * monotone between them (Fritsch–Carlson), so a measured move is replayed
 * through its own frames without wiggles of its own.
 * @param {[number, number][]} pts @returns {Ease}
 */
function measured(pts) {
  const n = pts.length;
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  const d = [];
  for (let i = 0; i < n - 1; i++) d.push((/** @type {number} */ (ys[i + 1]) - /** @type {number} */ (ys[i])) / (/** @type {number} */ (xs[i + 1]) - /** @type {number} */ (xs[i])));
  const m = new Array(n).fill(0);
  m[0] = d[0];
  m[n - 1] = d[n - 2];
  for (let i = 1; i < n - 1; i++) {
    const a = /** @type {number} */ (d[i - 1]), b = /** @type {number} */ (d[i]);
    m[i] = a * b <= 0 ? 0 : (2 * a * b) / (a + b);
  }
  return (u) => {
    if (u <= /** @type {number} */ (xs[0])) return /** @type {number} */ (ys[0]);
    if (u >= /** @type {number} */ (xs[n - 1])) return /** @type {number} */ (ys[n - 1]);
    let i = 0;
    while (u > /** @type {number} */ (xs[i + 1])) i++;
    const x0 = /** @type {number} */ (xs[i]), x1 = /** @type {number} */ (xs[i + 1]);
    const h = x1 - x0, q = (u - x0) / h;
    const y0 = /** @type {number} */ (ys[i]), y1 = /** @type {number} */ (ys[i + 1]);
    const q2 = q * q, q3 = q2 * q;
    return (2 * q3 - 3 * q2 + 1) * y0 + (q3 - 2 * q2 + q) * h * m[i] + (-2 * q3 + 3 * q2) * y1 + (q3 - q2) * h * m[i + 1];
  };
}

/** a direction's unit step @param {"up" | "down" | "left" | "right"} dir @returns {[number, number]} */
const unit = (dir) => (dir === "up" ? [0, -1] : dir === "down" ? [0, 1] : dir === "left" ? [-1, 0] : [1, 0]);
/** @param {Rect} r */
const mid = (r) => [r.x + r.w / 2, r.y + r.h / 2];

/** a camera at t: as given, or read from film time @param {CamFrom} c @param {number} t @param {string} who @returns {Cam} */
function camAt(c, t, who) {
  const cam = typeof c === "function" ? c(t) : c;
  if (!(cam && Number.isFinite(cam.x) && Number.isFinite(cam.y) && /** @type {number} */ (cam.s) > 0))
    throw new Error(`moves: ${who}'s camera is { x, y, s } with s above 0 (got ${JSON.stringify(cam)})`);
  return cam;
}

/**
 * Time since a move began, started from rest: it lags the clock by `soft` s
 * once under way and has no speed at 0, so a move laid over a camera that
 * is still moving adds none of its own in its first instant.
 * @param {number} tau @param {number} soft
 */
const fromRest = (tau, soft) => (tau <= 0 ? 0 : soft > 0 ? tau - soft * (1 - Math.exp(-tau / soft)) : tau);

/**
 * The camera a layer's pose amounts to (origin 0 0: a point p of the layer
 * drawn at (x, y) + s·p), when that layer is already seen through the camera
 * `f` (none: the layer at rest fills the frame).
 * @param {number} x @param {number} y @param {number} s @param {View} view @param {Cam | null} [f] @returns {Cam}
 */
function camOf(x, y, s, view, f) {
  const S = s * /** @type {number} */ (f?.s ?? 1);
  return {
    x: /** @type {number} */ (f?.x ?? view.width / 2) + (view.width / 2 - x - (s * view.width) / 2) / S,
    y: /** @type {number} */ (f?.y ?? view.height / 2) + (view.height / 2 - y - (s * view.height) / 2) / S,
    s: S,
  };
}

/**
 * A camera { x, y, s } (anim.js cam2d's: the world point at the frame's
 * centre, and the scale) as the pose of the world's layer, origin 0 0 — what
 * `cam2d(cam).css` writes, for `apply` and for the moves here that give a
 * camera back.
 * `apply(world, camPose(stations(t, list)))`
 * @param {Cam} cam @param {View} [view] @returns {Pose}
 */
export function camPose(cam, view = FRAME) {
  const s = /** @type {number} */ (cam.s);
  return pose({ x: view.width / 2 - /** @type {number} */ (cam.x) * s, y: view.height / 2 - /** @type {number} */ (cam.y) * s, s }, "0 0");
}

// --- a window hop ---------------------------------------------------------------

// Flying-machine film, 31.50–32.20 s (30 fps, 1276 wide), pulling out of a
// window that filled the frame onto the desk it sits on: the window's width
// 1276 → 1185 → 680 → 515 px in 0.7 s, slow to start, three frames fastest,
// ten frames settling. As [s after the start, the view's scale], read back
// to log progress below.
const HOP_PULL = [[0, 2.47], [0.233, 2.3], [0.333, 1.357], [0.367, 1.253], [0.4, 1.174], [0.433, 1.095], [0.467, 1.076], [0.5, 1.057], [0.567, 1.035], [0.633, 1.011], [0.7, 1]];
// …then (flying-machine film, 32.53–33.23 s) the next window lifting toward
// the lens: 430 → 470 → 660 → 780 → 1135 px → the whole frame in 0.67 s,
// fastest late (one step ×1.45), while the desk scaled 0.99–1.04 and only
// slid, about −50 px, carried out at ~40 px a frame in the last 5 frames.
const HOP_LIFT = [[0, 1], [0.07, 1.093], [0.27, 1.535], [0.403, 1.814], [0.47, 2.64], [0.67, 3.06]];
const hopPull = measured(/** @type {[number, number][]} */ (HOP_PULL.map(([t, s]) => [/** @type {number} */ (t) / 0.7, 1 - Math.log(/** @type {number} */ (s)) / Math.log(2.47)])));
const hopLift = measured(/** @type {[number, number][]} */ (HOP_LIFT.map(([t, s]) => [/** @type {number} */ (t) / 0.67, Math.log(/** @type {number} */ (s)) / Math.log(3.06)])));

/**
 * Out of one window and into the next across a desk, as layers: the camera
 * pulls back from `from` (filling the frame) until the desk is at rest
 * (`pull` s), holds `hold` s, then `to` lifts toward the lens until it fills
 * the frame (`lift` s) while the desk scales at most `deskScale` and slides
 * `pan` px toward where `to` was, carried a further `out` px in the last
 * frames. Measured on the flying-machine film, 31.50–33.23 s: pull 0.7 s,
 * hold 0.33 s, lift 0.67 s; the desk 0.99–1.04 while the window grew 3×. A
 * zoom of the whole desk instead scaled it 1.8×, and read as a zoom, not a
 * window coming forward.
 * `from` is the window the pull starts in, filling the frame — or, when the
 * take was not framed on one, the camera it is on: { x, y, s } over the
 * desk's layout, or a function of t for one still moving (`(t) =>
 * stations(t, list)`). The pull then starts where that camera is and at its
 * speed: it is read at every t, what is left of its move carries on under
 * the pull, and the pull itself starts from rest over `soft` s (so it ends
 * that much into the hold; keep `hold` longer than `soft`). Before t0 `desk`
 * is that camera's own pose, so one `apply(desk, h.desk)` serves the whole
 * take. A window's rect can match a moving camera's place at t0 but not its
 * speed: the picture stops dead for a frame, then starts again.
 * The desk is an element at 0, 0 the size of the view (the frame), its
 * transform-origin 0 0; lay the windows out inside it at their places at
 * rest, `to` above the others, and give `from` and `to` as those places
 * (the desk's own layout, which is frame px while the desk is unmoved).
 * `desk` is for the desk, `to` for the lifting window (its own centre), the
 * others ride the desk. The lift, from `lifts` to `end`, is a picture jump
 * to the render report: declare it, `tl.segment(h.lifts, h.end, { handoff:
 * "lift" })`. Once it has lifted (`end`), the next scene can take over from
 * the window filling the frame.
 * `const h = windowHop(t, 2, editorBox, simBox); apply(desk, h.desk); apply(sim, h.to);`
 * `const h = windowHop(t, T.hop, (t) => stations(t, tour, { from: cam0 }), simBox); apply(desk, h.desk); apply(sim, h.to);`
 * @param {number} t @param {number} t0  the pull starts
 * @param {Rect | CamFrom} from @param {Rect} to  in the desk's layout, frame px
 * @param {{ view?: View, pull?: number, hold?: number, lift?: number, fill?: number, grow?: number,
 *   deskScale?: number, pan?: number, out?: number, outDur?: number, soft?: number }} [o]
 *   fill: the view's scale at the start (default: `from` as wide as the frame; a camera's own s); grow:
 *   `to`'s scale at the end (default: filling the frame); soft: how long the pull takes to get under
 *   way over a camera still moving (default 2 frames of 24: 0.083 s; a camera at rest, or a window: 0)
 * @returns {{ desk: Pose, to: Pose, phase: "before" | "pull" | "hold" | "lift" | "done", p: number, lifts: number, end: number }}
 */
export function windowHop(t, t0, from, to, o = {}) {
  const view = o.view ?? FRAME;
  const moving = typeof from === "function";
  // a window has a width; a camera has a scale
  const cam = moving || !("w" in from) ? camAt(/** @type {CamFrom} */ (from), t, "windowHop") : null;
  if (!cam) sized("windowHop", "from", /** @type {Rect} */ (from));
  sized("windowHop", "to", to);
  const { pull = 0.7, hold = 0.33, lift = 0.67, deskScale = 1.04, pan = 75, out = 300, outDur = 5 / 30 } = o;
  const soft = moving ? (o.soft ?? 2 / 24) : 0;
  const fill = cam ? /** @type {number} */ (cam.s) : (o.fill ?? view.width / /** @type {Rect} */ (from).w);
  const grow = o.grow ?? Math.max(view.width / to.w, view.height / to.h);
  const vc = [view.width / 2, view.height / 2];
  const fc = cam ? [cam.x, cam.y] : mid(/** @type {Rect} */ (from)), tc = mid(to);
  const b = t0 + pull, c = b + hold, d = c + lift;
  const phase = t < t0 ? "before" : t < b ? "pull" : t < c ? "hold" : t < d ? "lift" : "done";
  const still = pose({}, "50% 50%");
  if (t < c) {
    const e = hopPull(pull > 0 ? clamp(fromRest(t - t0, soft) / pull) : t >= t0 ? 1 : 0);
    const S = fill ** (1 - e);
    const cx = lerp(/** @type {number} */ (vc[0]), /** @type {number} */ (fc[0]), e);
    const cy = lerp(/** @type {number} */ (vc[1]), /** @type {number} */ (fc[1]), e);
    return {
      desk: pose({ x: cx - /** @type {number} */ (fc[0]) * S, y: cy - /** @type {number} */ (fc[1]) * S, s: S }, "0 0"),
      to: still,
      phase,
      p: e,
      lifts: c,
      end: d,
    };
  }
  const q = hopLift(prog(t, c, d));
  const ds = 1 + (deskScale - 1) * q;
  const dx = /** @type {number} */ (vc[0]) - /** @type {number} */ (tc[0]), dy = /** @type {number} */ (vc[1]) - /** @type {number} */ (tc[1]);
  const len = Math.hypot(dx, dy);
  const [ux, uy] = len > 1e-6 ? [dx / len, dy / len] : [0, 0];
  const slide = pan * q + out * prog(t, d - outDur, d);
  const X = /** @type {number} */ (vc[0]) * (1 - ds) + ux * slide;
  const Y = /** @type {number} */ (vc[1]) * (1 - ds) + uy * slide;
  // the window: its centre to the frame's, its size `grow` on screen — written
  // inside the desk, so the desk's own move is taken out
  const Tx = lerp(/** @type {number} */ (tc[0]), /** @type {number} */ (vc[0]), q);
  const Ty = lerp(/** @type {number} */ (tc[1]), /** @type {number} */ (vc[1]), q);
  const sT = grow ** q;
  return {
    desk: pose({ x: X, y: Y, s: ds }, "0 0"),
    to: pose({ x: (Tx - X) / ds - /** @type {number} */ (tc[0]), y: (Ty - Y) / ds - /** @type {number} */ (tc[1]), s: sT / ds }, "50% 50%"),
    phase,
    p: q,
    lifts: c,
    end: d,
  };
}

// --- pulling back into space, and stations --------------------------------------

// Game film, 46.167–46.75 s (24 fps): the plane's width, share of the
// frame's, frame by frame from the full frame — nearly even on screen, the
// camera's distance speeding up.
const REVEAL = [1, 0.95, 0.892, 0.845, 0.797, 0.761, 0.722, 0.678, 0.642, 0.619, 0.578, 0.547, 0.527, 0.495, 0.472];
const reveal = measured(/** @type {[number, number][]} */ (REVEAL.map((w, i) => [i / 14, (1 - w) / (1 - 0.472)])));

/**
 * The whole frame pulls back into a plane in space: its width shrinking at
 * a nearly even rate on screen (the camera's distance speeding up), its
 * centre sliding to `at`, then drifting on, slower and slower. Measured on
 * the game film, 46.167–47.2 s (24 fps): 1.0 → 0.47 of the frame's width in
 * 14 frames, about 0.037 a frame, replayed here frame by frame; the centre
 * 0.50 → 0.68 W; then about 0.017 W a frame. A pull at an even distance
 * instead runs ahead early (0.08 W off in six frames). The drift starts at
 * `drift` and fades over `tau` as a share of the width left, so the plane
 * shrinks toward `rest` (about 0.21 W by default) and never through
 * nothing. `yaw` turns the plane by up to that many degrees on the way (the
 * parent needs no perspective of its own: `css` carries it).
 * Returns the pose of a frame-sized layer (origin its centre), `cam` — the
 * same as a camera for anim.js cam2d over a world whose plane fills the
 * frame (for stations' `from`) — and `rest`, where the drift ends.
 * `from`: the camera the take is on when the pull starts — { x, y, s } over
 * the world, or a function of t for one still moving (`(t) => stations(t,
 * list)`). `cam` and `rest` are then cameras over that world, the pull laid
 * over what the camera was doing: write `cam` onto the world's one element
 * (`apply(world, camPose(r.cam))`) and leave the pose be. Over a moving
 * camera the pull starts from rest over `soft` s, and so runs that much
 * behind the measured frames; what is left of the camera's own move carries
 * on under it.
 * `const r = pullbackReveal(t, 4); apply(screen, r);`
 * `const r = pullbackReveal(t, T.back, { from: (t) => stations(t, tour) }); apply(world, camPose(r.cam));`
 * @param {number} t @param {number} t0
 * @param {{ view?: View, dur?: number, to?: number, at?: [number, number], drift?: number, tau?: number, yaw?: number,
 *   from?: CamFrom, soft?: number }} [o]
 *   to: its width at the end, share of the frame's (above 0, below 1); at: its centre then, shares of the
 *   frame; drift: share of the frame's width a second, after; tau: how long the drift takes to fade (s);
 *   soft: how long the pull takes to get under way over a camera still moving (default 2 frames of 24)
 * @returns {Pose & { cam: Cam, rest: Cam, p: number }}
 */
export function pullbackReveal(t, t0, o = {}) {
  const view = o.view ?? FRAME;
  const { dur = 14 / 24, to = 0.47, at = [0.68, 0.5], drift = 0.42, tau = 0.9, yaw = 0 } = o;
  if (!(to > 0 && to < 1))
    throw new Error(`moves: pullbackReveal's \`to\` is the plane's width at the end, a share of the frame's above 0 and below 1 (got ${to})`);
  const W = view.width, H = view.height;
  const f = o.from ? camAt(o.from, t, "pullbackReveal") : null;
  const tau0 = typeof o.from === "function" && t > t0 ? fromRest(t - t0, o.soft ?? 2 / 24) : t - t0;
  // after the pull, the width falls at `drift` a second at first, the fall
  // fading over `tau` and taken out of what is left: it never reaches 0
  const left = (/** @type {number} */ x) => (tau > 0 ? to * Math.exp(-(drift / to) * tau * (1 - Math.exp(-x / tau))) : to);
  const sAt = (/** @type {number} */ x) => (x <= dur ? 1 - (1 - to) * reveal(clamp(x / dur)) : left(x - dur));
  const place = (/** @type {number} */ s) => {
    const k = (1 - s) / (1 - to);
    const cx = (0.5 + (at[0] - 0.5) * k) * W, cy = (0.5 + (at[1] - 0.5) * k) * H;
    // the plane drawn at its centre (cx, cy), scaled s about it: as a layer's pose, and the camera it amounts to
    return { cx, cy, k, cam: camOf(cx - (s * W) / 2, cy - (s * H) / 2, s, view, f) };
  };
  const s = sAt(Math.max(0, tau0));
  const { cx, cy, k, cam } = place(s);
  const rest = place(left(Infinity)).cam;
  return {
    ...pose({ x: cx - W / 2, y: cy - H / 2, s, ry: yaw * Math.min(1, k) }, "50% 50%"),
    cam,
    rest,
    p: clamp(tau0 / dur),
  };
}

/**
 * The camera that frames `rect` the way the game film's stations did
 * (50.54, 52.63, 55.0 s): centred, the rect `share` of the frame's width
 * (three panels landed at 0.635 W, 810, 814 and 809 px of 1276). A camera
 * for anim.js cam2d: { x, y, s }.
 * `stations(t, [{ t: 6, at: station(panelA) }, { t: 7.2, at: station(panelB) }], { from: cam0 })`
 * @param {Rect} rect @param {{ share?: number, view?: View }} [o] @returns {Cam}
 */
export function station(rect, { share = 0.635, view = FRAME } = {}) {
  const [x, y] = mid(rect);
  return { x: /** @type {number} */ (x), y: /** @type {number} */ (y), s: (share * view.width) / rect.w };
}

// Fly film, the tilted map, 39.25–44.25 s (24 fps, five stations): a leg
// speeds up for 5–6 frames, slows for 10–12 at about ×0.73 a frame from a
// peak of 110–187 px a frame, then the station is held 3–8 frames at 0.1–0.5
// px a frame and left; stations 0.75–1.08 s apart. Slowing by ×0.73 a frame
// for ever does not land in that time: from 150 px a frame it is still at
// 4.7 after 11 frames and reaches 0.5 only after 18, later than the next
// station leaves. So the slowing here ends: ×0.73 a frame at first, done in
// SETTLE, and CREEP of the leg is kept back for a slow drift on (losing
// CREEP_KEEP of its speed a frame), which from that peak is 0.4 px a frame
// as the leg lands and 0.15 eight frames on.
const ACCEL = 5.5 / 24;
const DECAY = 0.73;
const SETTLE = 11 / 24;
const CREEP = 0.02;
const CREEP_KEEP = 0.885;

/** progress of a move τ s after it leaves: speed rising over `ta` s, then falling at rate `lam` /s to nothing
 *  `td` s later (Infinity: for ever)
 *  @param {number} tau @param {number} ta @param {number} lam @param {number} td */
function legTo(tau, ta, lam, td) {
  if (tau <= 0) return 0;
  const ends = Number.isFinite(td);
  const floor = ends ? Math.exp(-lam * td) : 0;
  // ∫ of the fall, its speed 1 at 0 and 0 at td
  const fall = (/** @type {number} */ x) => (floor < 1 ? ((1 - Math.exp(-lam * x)) / lam - floor * x) / (1 - floor) : 0);
  const total = ta / 2 + (ends ? fall(td) : 1 / lam);
  if (!(total > 0)) return 1;
  if (tau < ta) return (tau / 2 - (ta / (2 * Math.PI)) * Math.sin((Math.PI * tau) / ta)) / total;
  return (ta / 2 + fall(Math.min(tau - ta, td))) / total;
}

/** progress of one leg τ s after it leaves: the move, and the share of it kept back to creep on
 *  @param {number} tau @param {number} ta @param {number} lam @param {number} td @param {number} creep */
const leg = (tau, ta, lam, td, creep) =>
  (1 - creep) * legTo(tau, ta, lam, td) + (creep > 0 ? creep * legTo(tau, ta, -Math.log(CREEP_KEEP) * 24, Infinity) : 0);

/**
 * A camera from station to station: list = [{ t, at }], each leaving for
 * `at` (a camera: anim.js cam2d's { x, y, s }, or any flat object of
 * numbers; `s` mixes in log space) at its t. Each leg speeds up over
 * `accel` s, slows by `decay` of its speed every 1/24 s at first and is
 * down to a creep `settle` s after its fastest frame, then drifts on, slower
 * and slower, until the next leaves: short to leave, longer to arrive, never
 * quite still, and what is left of one leg is still moving when the next
 * leaves. Measured on the fly film's tilted map, 39.25–44.25 s, five
 * stations: speeding up 5–6 frames, slowing 10–12 frames at about ×0.73 a
 * frame, a station held 3–8 frames at 0.1–0.5 px a frame, then off again;
 * stations 0.75–1.08 s apart. So a leg takes about 0.69 s (16.5 frames) and
 * a station list written 0.8–1.0 s apart moves for most of its time; one
 * written 1.5 s apart sits at a creep for half of it (`stationTimes` gives
 * each leg's landing and how long its station is held). `decay` is the share
 * of its speed a leg keeps every 1/24 s, above 0 and below 1: nearer 1 it
 * slows more evenly over the same `settle`. `creep` is the share of the leg
 * left to the drift (0: it stops dead when it lands); `settle: Infinity`
 * with `creep: 0` slows by `decay` for ever. `from`: where the camera is
 * before the first leg — a camera, or a function of t (pullbackReveal's or
 * rampJump's `cam`, still moving), which the first leg leaves from without a
 * jolt. The camera it returns is what windowHop's and pullbackReveal's
 * `from` take, as `(t) => stations(t, list, o)`, to leave the tour on.
 * `const cam = cam2d(stations(t, [{ t: 6, at: station(a) }, { t: 6.9, at: station(b) }], { from: (t) => pullbackReveal(t, 5).cam }))`
 * @param {number} t
 * @param {{ t: number, at: Cam, accel?: number, decay?: number, settle?: number, creep?: number }[]} list  in time order
 * @param {{ from?: CamFrom, accel?: number, decay?: number, settle?: number, creep?: number }} [o]
 * @returns {Cam & { leg: number }}  leg: the last one to leave (−1 before the first)
 */
export function stations(t, list, o = {}) {
  const { accel = ACCEL, decay = DECAY, settle = SETTLE, creep = CREEP } = o;
  const from = o.from ?? /** @type {{ at: Cam }} */ (list[0]).at;
  const base = typeof from === "function" ? from(t) : from;
  /** @type {Record<string, number>} */
  const cam = { ...base };
  /** @type {Cam} */
  let prev = base;
  let last = -1;
  for (let i = 0; i < list.length; i++) {
    const st = /** @type {{ t: number, at: Cam, accel?: number, decay?: number, settle?: number, creep?: number }} */ (list[i]);
    const keep = st.decay ?? decay;
    if (!(keep > 0 && keep < 1))
      throw new Error(`moves: stations' decay is the share of its speed a leg keeps every 1/24 s, above 0 and below 1 (got ${keep})`);
    const lam = -Math.log(keep) * 24;
    const k = leg(t - st.t, st.accel ?? accel, lam, Math.max(0, st.settle ?? settle), clamp(st.creep ?? creep));
    if (t >= st.t) last = i;
    for (const key of Object.keys(st.at)) {
      // the first leg mixes from where the camera is now (a moving start is
      // left smoothly); each later one adds its own step on top of the last
      const a = /** @type {number} */ (prev[key] ?? st.at[key]), b = /** @type {number} */ (st.at[key]);
      const c = i === 0 ? a : (cam[key] ?? a);
      if (key === "s" && a > 0 && b > 0) cam[key] = c * (b / a) ** k;
      else cam[key] = c + (b - a) * k;
    }
    prev = st.at;
  }
  return { ...cam, leg: last };
}

/**
 * When each leg of a station list is fastest and when it has landed (down
 * to its creep), and how long its station is then held before the next
 * leaves — the measured tour held each 3–8 frames of 24 (0.125–0.33 s).
 * A hold below 0: the next leg leaves before this one has landed.
 * `stationTimes(tour).map((s) => s.held)`
 * @param {{ t: number, accel?: number, settle?: number }[]} list
 * @param {{ accel?: number, settle?: number }} [o]
 * @returns {{ t: number, peak: number, lands: number, held: number }[]}  held: Infinity for the last
 */
export function stationTimes(list, o = {}) {
  const { accel = ACCEL, settle = SETTLE } = o;
  return list.map((st, i) => {
    const peak = st.t + (st.accel ?? accel);
    const lands = peak + (st.settle ?? settle);
    const next = list[i + 1];
    return { t: st.t, peak, lands, held: next ? next.t - lands : Infinity };
  });
}

// --- cuts in motion --------------------------------------------------------------

/**
 * Leave faster every frame and cut on the fastest; the next shot carries on
 * the same way from behind its place and slows into it. Measured on the
 * flying-machine film, 3.033–3.567 s (30 fps, 718 px tall): the title card
 * left 85 px up in 8 frames (cubic-bezier(0.775, 0, 0.975, 1), ease.leave),
 * cut on its fastest frame at 3.300; the next began 57 px below its place
 * and slowed into it in 8 frames (cubic-bezier(0.275, 0.8, 0.675, 1),
 * ease.resume), −17.7 → −0.5 px a frame. Here 128 and 86 px of a 1080
 * frame; the way out reaches `out` on the last frame drawn before the cut,
 * so its largest step is seen, and runs on at that step's speed until the
 * cut, so that frame's shutter smears all of it; the next shot runs at its
 * first step's speed from the cut to its first frame. `a` is the shot
 * leaving, `b` the next, each at its place at rest; each is visible on its
 * side of the cut.
 * A whole scene carried 128 px off its place uncovers a strip that wide at
 * the edge it leaves (the reel's card moved over a ground that did not).
 * `cover` says what fills it, and `apply` does it: "ground" (the default) —
 * a scene that covers the frame and paints one flat colour has that colour
 * painted past its edge, as far as it has moved (`ground`: the colour, when
 * the scene's own is not the one to use, or it paints a gradient whose edge
 * colour you name); a scene that is or is backed by a picture, a gradient
 * or a canvas is drawn larger about its middle by just what the move
 * uncovers (1.24× at the cut for 128 px of 1080, back to 1 as it lands);
 * anything smaller than the frame — a card, a title — is left as it is.
 * "scale" draws every scene larger that way, and the pose's `s` and `css`
 * say so; false leaves the edge to you (a scene laid out larger than the
 * frame, or a ground behind both that does not move). The painted ground is
 * a box-shadow on the scene's element: a clip-path or `contain: paint` on
 * that element cuts it off. It is written by `apply` and taken off by
 * `apply` — when the scene is hidden, when it has landed, or by any later
 * pose — so keep applying the cut's poses until `b` is back on its place
 * (`inDur`, 0.27 s); a film that stops part way leaves the last of it
 * painted, and a frame then depends on the ones drawn before it.
 * `const m = momentumCut(t, 3.3, { dir: "up" }); apply(title, m.a); apply(list, m.b); tl.event(m.cutAt, "cut");`
 * @param {number} t @param {number} at  the cut
 * @param {{ dir?: "up" | "down" | "left" | "right", out?: number, outDur?: number, in?: number, inDur?: number,
 *   leave?: Ease | string, resume?: Ease | string, fps?: number, cover?: "ground" | "scale" | false,
 *   ground?: string | [string, string], view?: View }} [o]
 *   ground: a CSS colour for both scenes, or [a's, b's]
 * @returns {{ a: Pose, b: Pose, cutAt: number, p: number }}
 */
export function momentumCut(t, at, o = {}) {
  const { dir = "up", out = 128, outDur = 8 / 30, inDur = 8 / 30, fps = filmFps() } = o;
  const inn = o.in ?? 86;
  const [ux, uy] = unit(dir);
  const after = crossed(t, at, fps);
  const cutAt = frameOf(at, fps) / fps;
  // the way out ends on the last frame drawn before the cut: its fastest step
  // is seen; through the half frame to the cut it carries on at that speed
  const lastA = cutAt - 1 / fps;
  const half = 0.5 / fps;
  const ua = outDur > 0 ? clamp((t - lastA + outDur) / outDur, 0, 1 + half / outDur) : t >= lastA ? 1 : 0;
  const ub = inDur > 0 ? clamp((t - cutAt) / inDur, -half / inDur, 1) : t >= cutAt ? 1 : 0;
  const ea = carried(named(o.leave ?? "leave"), ua, 1 / (fps * outDur));
  const eb = carried(named(o.resume ?? "resume"), ub, 1 / (fps * inDur));
  const view = o.view ?? FRAME;
  const cover = o.cover ?? "ground";
  const grounds = Array.isArray(o.ground) ? o.ground : [o.ground, o.ground];
  /** one side, `d` px along the move from its place @param {number} d @param {boolean} visible @param {string | undefined} colour */
  const sideOf = (d, visible, colour) => {
    const far = Math.abs(d);
    // drawn larger about its middle: what a move of `far` px uncovers at one edge
    const s = cover === "scale" ? 1 + (2 * far) / (ux ? view.width : view.height) : 1;
    const p = pose({ x: ux * d, y: uy * d, s, visible });
    // 2 px over, for the half pixel the browser may round the scene's edge to
    // (a side that is hidden has none: nothing is left painted on the scene the cut has left)
    if (cover === "ground") p.cover = { px: visible && far > 0 ? far + 2 : 0, view, ...(colour ? { ground: colour } : {}) };
    return p;
  };
  return {
    a: sideOf(out * ea, !after, grounds[0]),
    b: sideOf(-inn * (1 - eb), after, grounds[1]),
    cutAt,
    p: after ? clamp(eb) : clamp(ea),
  };
}

// Fly film, the map at 33.5–34.33 s, the jump at 34.083 (24 fps): the view's
// scale frame by frame, one frame of 1.45× between the 14th and 15th, then
// settling — 2.07× in all in 0.83 s; the same push as one smooth move needs
// 1.106× a frame at its peak.
const RAMP = [1.0, 1.0014, 1.0018, 1.0026, 1.0032, 1.0034, 1.0071, 1.0145, 1.0289, 1.047, 1.0794, 1.1226, 1.1885, 1.244, 1.7978, 1.9644, 2.0184, 2.0539, 2.071, 2.0776, 2.0751];
const RAMP_LOG = RAMP.map((s) => Math.log(s) / Math.log(/** @type {number} */ (RAMP[RAMP.length - 1])));
const rampPre = measured(/** @type {[number, number][]} */ (RAMP_LOG.slice(0, 14).map((v, i) => [i / 13, v / /** @type {number} */ (RAMP_LOG[13])])));
const rampPost = measured(/** @type {[number, number][]} */ (RAMP_LOG.slice(14).map((v, i) => [i / 6, v])));

/**
 * A push that speeds up, jumps in one frame, and settles: the cut that
 * hides inside a move. Speeding up for 14 reel frames (24 fps; 1.0004× →
 * 1.059× a frame), one frame of about 1.4×, then 6 frames settling (1.075×,
 * 1.026×, 1.016×, 1.008×, 1.003×) — 2.07× in all in 0.83 s, measured on the
 * fly film's map, the jump at 34.083 s. `by` scales the whole push (in log
 * space); it zooms about `focus` (frame px), which stays put. `shift` is
 * [x, y] in px of the frame, as seen on screen (not px of the layer, which
 * the push has made larger): how far the picture — the focus with it — has
 * slid by the time the push has settled — a third of it by the frame before
 * the jump, half of it in the jump, as the scale goes (the fly film's other
 * ramp, 30.875 s, jumped 1.5× and travelled about 300 px in that frame). A
 * pose for the layer (origin 0 0). The jump falls between two frames of the film: declare
 * `cutAt` as a cut hidden in the move, `tl.event(j.cutAt, "hidden-cut")`.
 * `cam` is the same push as a camera over the layer and `rest` the camera
 * it settles on, for a move that carries on in the same picture: the layer
 * stays one element and the next move starts where this one is —
 * `apply(map, camPose(stations(t, [{ t: 9.4, at: station(rows) }], { from:
 * (t) => rampJump(t, 8.125, o).cam })))`. `from`: the camera the layer is
 * already seen through when the push begins ({ x, y, s }, or a function of
 * t); the pose, `cam` and `rest` are then the push laid over it, and `focus`
 * and `shift` stay px of the frame.
 * `const j = rampJump(t, 8.125, { focus: [700, 400], by: 2 }); apply(map, j); tl.event(j.cutAt, "hidden-cut");`
 * @param {number} t @param {number} at  the jump
 * @param {{ by?: number, focus?: [number, number], shift?: [number, number], view?: View, fps?: number, from?: CamFrom }} [o]
 * @returns {Pose & { cutAt: number, p: number, cam: Cam, rest: Cam }}
 */
export function rampJump(t, at, o = {}) {
  const view = o.view ?? FRAME;
  const { by = 2.0751, focus = [view.width / 2, view.height / 2], shift = [0, 0], fps = filmFps() } = o;
  const after = crossed(t, at, fps);
  const cutAt = frameOf(at, fps) / fps;
  const phi = (t - cutAt) * 24 + 14; // in reel frames; the jump at 14
  const L13 = /** @type {number} */ (RAMP_LOG[13]), L12 = /** @type {number} */ (RAMP_LOG[12]);
  let L;
  if (after) L = rampPost(clamp((phi - 14) / 6));
  else if (phi <= 13) L = rampPre(clamp(phi / 13)) * L13;
  else L = L13 + (phi - 13) * (L13 - L12); // the last frame before the jump, still speeding up
  const s = Math.exp(L * Math.log(by));
  const [fx, fy] = focus;
  const f = o.from ? camAt(o.from, t, "rampJump") : null;
  const cam = camOf(fx * (1 - s) + shift[0] * L, fy * (1 - s) + shift[1] * L, s, view, f);
  const rest = camOf(fx * (1 - by) + shift[0], fy * (1 - by) + shift[1], by, view, f);
  const own = f ? camPose(cam, view) : pose({ x: fx * (1 - s) + shift[0] * L, y: fy * (1 - s) + shift[1] * L, s }, "0 0");
  return { ...own, cutAt, p: L, cam, rest };
}

/**
 * A hold that never stops: from t0 it drifts at `v0` px/s along `dir`, and
 * over the last `kick` s before t1 speeds up to `v1` px/s, so the cut at t1
 * comes on a move. Measured on the truck film, 20.08–21.5 s (24 fps, 1080
 * tall): lines of text slowing in, near still at 16–56 px/s, then 176, 328,
 * 560 px/s in the last three eighths of a second into a hard cut; nine of
 * its shots (3, 5, 6, 13, 14, 15, 17, 19, 20) drift 10–60 px/s and reach
 * 250–560 px/s 0.1–0.25 s before their cut. `grow` changes the scale that
 * much a second meanwhile (the game film's title card at 37.92 s shrinking
 * 5 % a second: −0.05). `kick` 0 jumps to `v1` at once.
 * `const d = exitDrift(t, 9.2, 10.67); apply(lines, d);`
 * @param {number} t @param {number} t0 @param {number} t1  the cut
 * @param {{ dir?: "up" | "down" | "left" | "right", v0?: number, v1?: number, kick?: number, grow?: number }} [o]
 * @returns {Pose & { speed: number }}
 */
export function exitDrift(t, t0, t1, o = {}) {
  const { dir = "up", v0 = 40, v1 = 560, kick = 0.375, grow = 0 } = o;
  const [ux, uy] = unit(dir);
  const tau = Math.max(0, t - t0);
  const k0 = Math.max(0, t1 - t0 - kick);
  const kk = Math.max(0, tau - k0);
  // speed v0 until k0, then rising evenly to v1 over `kick`, then v1
  const ramp = Math.min(kk, kick);
  const d = v0 * tau + (kick > 0 ? ((v1 - v0) * ramp * ramp) / (2 * kick) : 0) + (v1 - v0) * Math.max(0, kk - kick);
  const speed = kick > 0 ? v0 + (v1 - v0) * clamp(kk / kick) : kk > 0 ? v1 : v0;
  return { ...pose({ x: ux * d, y: uy * d, s: 1 + grow * tau }), speed };
}

/**
 * The page kicked sideways when something lands on it, gone in 3–4 frames:
 * a damped swing, amp·e^(−τ/decay)·sin(2πfτ). The manga film's page shook
 * with every new panel (26.33 and 27.12 s), 3–4 frames of sideways blur
 * (the frames were looked at, the distance not measured: amp 60 moves it
 * 30 px, then −30, −7, +7 at 24 fps). A softer, longer one (a motion
 * component library's impact shake): amp 15, ampY 11, freq 5, decay 0.2,
 * rot 1.1. `lag` delays it, for a layer behind that follows 0.03–0.06 s
 * late.
 * `const k = arrivalShake(t, T.panel3); apply(page, k);`
 * @param {number} t @param {number} t0
 * @param {{ amp?: number, ampY?: number, rot?: number, freq?: number, decay?: number, lag?: number }} [o]
 * @returns {Pose}
 */
export function arrivalShake(t, t0, o = {}) {
  const { amp = 60, ampY = 0, rot = 0, freq = 6, decay = 0.06, lag = 0 } = o;
  const tau = t - t0 - lag;
  if (tau <= 0) return pose({});
  const e = Math.exp(-tau / decay);
  const w = 2 * Math.PI * freq * tau;
  return pose({ x: amp * e * Math.sin(w), y: ampY * e * Math.sin(1.3 * w), r: rot * e * Math.sin(1.1 * w) });
}

/**
 * Out of focus, cut, back into focus: the blur itself is what crosses. The
 * shot leaving blurs over `out` s (ease-in), deepest on the last frame drawn
 * before the cut; the next starts as blurred on its first frame and sharpens
 * over `in` s (ease-out). Measured: the game film defocused 4 frames at
 * 64.71–64.875 s (24 fps; sharpness 141 → 16); the fly film 4 frames, cut
 * at 36.625 s, 9 frames back; a catalogue film wrapped all 10 of its cuts
 * in 3 frames out, 4–6 in. Here 4 frames out, 6 in; `blur` px at the
 * deepest (a 1080 frame). Write `a.blur` and `b.blur` as a CSS blur (apply
 * does).
 * `const f = blurBridge(t, 12.4); apply(shotA, f.a); apply(shotB, f.b); tl.event(f.cutAt, "cut");`
 * @param {number} t @param {number} at
 * @param {{ out?: number, in?: number, blur?: number, fps?: number }} [o]
 * @returns {{ a: Pose, b: Pose, cutAt: number }}
 */
export function blurBridge(t, at, o = {}) {
  const { out = 4 / 24, blur = 24, fps = filmFps() } = o;
  const inn = o.in ?? 6 / 24;
  const after = crossed(t, at, fps);
  const cutAt = frameOf(at, fps) / fps;
  // deepest on the last frame drawn: the frame at cutAt is already the next shot
  const lastA = cutAt - 1 / fps;
  return {
    a: pose({ blur: blur * ease.in2(prog(t, lastA - out, lastA)), visible: !after }),
    b: pose({ blur: after ? blur * (1 - ease.out2(prog(t, cutAt, cutAt + inn))) : blur, visible: after }),
    cutAt,
  };
}

// --- carrying something across ---------------------------------------------------

/**
 * Fly into `rect` faster every frame and cut on the fastest frame, into what
 * it was: the scale grows exponentially in log space (k 3), so each frame's
 * step is larger than the last — measured on the app film, 2.20–2.50 s:
 * 1.02× a frame rising to 1.39× over 9 frames (3.05× in 0.3 s); and on the
 * flying-machine film, 57.43–58.53 s: 8 frames of +14, 18, 25, 36, 48, 64,
 * 88, 131 px (1.55×). It ends with `rect` covering the view, `through`
 * times more, on the last frame drawn before the cut, and keeps speeding up
 * through the half frame to the cut; then the next shot (`b`, at rest at
 * the whole frame) starts `land` large and settles on ease-out over
 * `settle` s, the push carrying on. `rect` is in the layout of the element
 * `a` is for (frame px when it sits at 0, 0 the size of the frame), not
 * where another move has put it on screen. (kit/motion.js zoomThrough grows
 * one box into another on a smooth ease; this is the camera's fly-in to a
 * cut.)
 * `const z = zoomThrough(t, 7.4, 7.75, panelBox); apply(world, z.a); apply(next, z.b); tl.event(z.cutAt, "cut");`
 * @param {number} t @param {number} start @param {number} end  the cut
 * @param {Rect} rect  in the layout of `a`'s element
 * @param {{ view?: View, through?: number, k?: number, land?: number, settle?: number, fps?: number }} [o]
 * @returns {{ a: Pose, b: Pose, cutAt: number, p: number }}
 */
export function zoomThrough(t, start, end, rect, o = {}) {
  const view = o.view ?? FRAME;
  sized("zoomThrough", "rect", rect);
  const { through = 1.25, k = 3, land = 1.2, settle = 0.3, fps = filmFps() } = o;
  const S = Math.max(view.width / rect.w, view.height / rect.h) * through;
  const [cx, cy] = mid(rect);
  // the point that stays put; with no zoom at all (S 1) any point does
  const still = Math.abs(S - 1) < 1e-9;
  const fx = still ? view.width / 2 : (S * /** @type {number} */ (cx) - view.width / 2) / (S - 1);
  const fy = still ? view.height / 2 : (S * /** @type {number} */ (cy) - view.height / 2) / (S - 1);
  const after = crossed(t, end, fps);
  const cutAt = frameOf(end, fps) / fps;
  // all the way in on the last frame drawn before the cut, and on, faster
  // still, through the half frame of its shutter up to the cut
  const lastA = cutAt - 1 / fps;
  const half = 0.5 / fps;
  const u = lastA > start ? clamp((t - start) / (lastA - start), 0, 1 + half / (lastA - start)) : t >= lastA ? 1 : 0;
  const e = k ? (Math.exp(k * u) - 1) / (Math.exp(k) - 1) : u;
  const s = S ** e;
  // the next shot from the cut, its first speed carried back over the half frame before its first frame
  const ub = settle > 0 ? clamp((t - cutAt) / settle, -half / settle, 1) : t >= cutAt ? 1 : 0;
  const eb = 1 - (1 - ub) ** 3;
  return {
    a: pose({ x: fx * (1 - s), y: fy * (1 - s), s, visible: !after }, "0 0"),
    b: pose({ s: land ** (1 - eb), visible: after }, "50% 50%"),
    cutAt,
    p: after ? clamp(eb) : clamp(e),
  };
}

/**
 * A flash, and the whole picture shrinks into its thumbnail in the next
 * scene: the thing carried across is the picture itself. Measured on the
 * truck film, 5.33–5.67 s (24 fps, frames 128–136): 3 frames of overexposed
 * white, then the photo shrank into the chat card's thumbnail in 6 frames
 * (0.25 s), blurred by its speed. The
 * picture is laid out at `from` (usually the whole frame); its size changes
 * in log space, its height following its width. `flash` is the white
 * layer's opacity over everything.
 * `const th = toThumbnail(t, 5.4, frameBox, thumbBox); apply(photo, th.photo); white.style.opacity = th.flash;`
 * @param {number} t @param {number} start  the shrink starts (the flash is before it)
 * @param {Rect} from @param {Rect} to
 * @param {{ dur?: number, flash?: number, peak?: number, ease?: Ease | string }} [o]
 * @returns {{ photo: Pose, flash: number, rect: Rect, p: number }}
 */
export function toThumbnail(t, start, from, to, o = {}) {
  const { dur = 6 / 24, flash = 3 / 24, peak = 0.85 } = o;
  const e = named(o.ease ?? "out3")(prog(t, start, start + dur));
  const w = from.w * (to.w / from.w) ** e;
  const k = w / from.w;
  const [ax, ay] = mid(from), [bx, by] = mid(to);
  const cx = lerp(/** @type {number} */ (ax), /** @type {number} */ (bx), e), cy = lerp(/** @type {number} */ (ay), /** @type {number} */ (by), e);
  const h = from.h * k;
  const fl = t < start ? prog(t, start - flash, start) : 1 - prog(t, start, start + 2 / 24);
  return {
    photo: pose({ x: cx - w / 2 - from.x, y: cy - h / 2 - from.y, s: k }, "0 0"),
    flash: peak * ease.in2(fl),
    rect: { x: cx - w / 2, y: cy - h / 2, w, h },
    p: e,
  };
}

/**
 * A crowd collapses into one point, and the point becomes one thing: items
 * (their centres, frame px) rush to `to`'s centre, faster and faster,
 * shrinking and blurring, and are gone at `dur`; then the thing laid out at
 * `to` grows from that point over `grow` s. Measured on the app film,
 * 44.133 s: about 30 figures collapsing in 0.3 s, radial blur → a ball → a
 * point, the point becoming the next section's avatar. The grow is not
 * measured there (it
 * lands across a cut): 0.25 s, ease-out. Each item's pose is against its own
 * place; `blur` is for the crowd's layer.
 * `const im = implodeTo(t, 10.1, dots.map(centre), avatarBox); dots.forEach((d, i) => apply(d, im.items[i])); apply(avatar, im.into);`
 * @param {number} t @param {number} start
 * @param {{ x: number, y: number }[]} items @param {Rect} to
 * @param {{ dur?: number, grow?: number, blur?: number, shrink?: number }} [o]  shrink: the items' size at the point
 * @returns {{ items: Pose[], into: Pose, blur: number, p: number }}
 */
export function implodeTo(t, start, items, to, o = {}) {
  const { dur = 0.3, grow = 0.25, blur = 18, shrink = 0.12 } = o;
  const u = prog(t, start, start + dur);
  const e = ease.in3(u);
  const gone = t >= start + dur;
  const [tx, ty] = mid(to);
  const g = ease.out3(prog(t, start + dur, start + dur + grow));
  return {
    items: items.map((it) =>
      pose({ x: (/** @type {number} */ (tx) - it.x) * e, y: (/** @type {number} */ (ty) - it.y) * e, s: lerp(1, shrink, e), visible: !gone }),
    ),
    into: pose({ s: lerp(0.02, 1, g), visible: gone }),
    blur: gone ? 0 : blur * clamp(e * 2),
    p: u,
  };
}

/** "#rgb" or "#rrggbb" → [r, g, b] 0..1 @param {string} hex @returns {[number, number, number]} */
function rgb(hex) {
  const h = hex.replace("#", "");
  const f = h.length === 3 ? h.split("").map((c) => c + c).join("") : h;
  const n = parseInt(f, 16);
  if (!/^[0-9a-f]{6}$/i.test(f)) throw new Error(`moves: develop's colours are "#rgb" or "#rrggbb" (got ${JSON.stringify(hex)})`);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}
/** the colour matrix mapping a pixel's luminance from `dark` to `light` @param {string} dark @param {string} light */
function duotone(dark, light) {
  const d = rgb(dark), l = rgb(light);
  const Y = [0.2126, 0.7152, 0.0722];
  /** @type {number[]} */
  const m = [];
  for (let c = 0; c < 3; c++) {
    const span = /** @type {number} */ (l[c]) - /** @type {number} */ (d[c]);
    m.push(span * /** @type {number} */ (Y[0]), span * /** @type {number} */ (Y[1]), span * /** @type {number} */ (Y[2]), 0, /** @type {number} */ (d[c]));
  }
  m.push(0, 0, 0, 1, 0);
  return m;
}
const IDENTITY = [1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0];

/**
 * A picture arriving in the colours of something still being made, then
 * finished: a first duotone, a second, then the picture as it is. Measured
 * on the manga film, 26.33–26.75 s (24 fps): a new comic panel magenta from
 * its arrival (deepest 0.09–0.13 s in), lime at 0.25–0.38 s, finished from
 * 0.42 s — 10 frames.
 * `values` is for an SVG feColorMatrix (type "matrix") the picture is
 * filtered through; mixing matrices mixes the pictures. Put the filter in
 * the page once, with color-interpolation-filters="sRGB":
 *   <svg width="0" height="0"><filter id="dev" color-interpolation-filters="sRGB"><feColorMatrix id="devm" type="matrix"/></filter></svg>
 *   img.style.filter = "url(#dev)"
 * `devm.setAttribute("values", develop(t, T.panel).values)` (and the filter off once `p` is 1).
 * @param {number} t @param {number} start
 * @param {{ dur?: number, first?: [string, string], second?: [string, string] }} [o]  each [dark, light]
 * @returns {{ values: string, stage: "first" | "second" | "done", p: number }}
 */
export function develop(t, start, o = {}) {
  const { dur = 0.42, first = ["#2b0030", "#ff4fd8"], second = ["#0d2600", "#c5fb27"] } = o;
  const A = duotone(...first), B = duotone(...second);
  const u = prog(t, start, start + dur);
  // [share of dur, matrix]: the first held to 31 %, the second from 60 to 90 %, done at 100 %
  /** @type {[number, number[]][]} */
  const ks = [[0, A], [0.31, A], [0.6, B], [0.9, B], [1, IDENTITY]];
  let m = IDENTITY;
  for (let i = 1; i < ks.length; i++) {
    const [u0, m0] = /** @type {[number, number[]]} */ (ks[i - 1]);
    const [u1, m1] = /** @type {[number, number[]]} */ (ks[i]);
    if (u <= u1) {
      const q = ease.inOut2(prog(u, u0, u1));
      m = m0.map((v, j) => lerp(v, /** @type {number} */ (m1[j]), q));
      break;
    }
  }
  return {
    values: m.map((v) => +v.toFixed(4)).join(" "),
    stage: u < 0.45 ? "first" : u < 1 ? "second" : "done",
    p: u,
  };
}

// --- time ------------------------------------------------------------------------

// ∫ from 0 to u of an ease, as a running sum over one fixed grid of 0 → 1
// read between its steps: an ease that is never below 0 gives a sum that
// never falls, however steep it is (a rule refitted to each u can).
const STEPS = 1024;
/** @type {WeakMap<Function, Float64Array>} */
const sumsOfFns = new WeakMap();
/** @type {Map<string, Float64Array>} */
const sumsOfNames = new Map();
/** @param {Ease | string} e @returns {Float64Array} */
function sums(e) {
  const known = typeof e === "function" ? sumsOfFns.get(e) : sumsOfNames.get(e);
  if (known) return known;
  const f = named(e);
  const tab = new Float64Array(STEPS + 1);
  let prev = f(0);
  for (let i = 1; i <= STEPS; i++) {
    const v = f(i / STEPS);
    tab[i] = /** @type {number} */ (tab[i - 1]) + (prev + v) / (2 * STEPS);
    prev = v;
  }
  if (typeof e === "function") sumsOfFns.set(e, tab);
  else sumsOfNames.set(e, tab);
  return tab;
}
/** ∫ from 0 to x of the ease e (x in 0..1) @param {Ease | string} e @param {number} x */
function integral(e, x) {
  if (x <= 0) return 0;
  const tab = sums(e);
  const q = Math.min(1, x) * STEPS;
  const i = Math.min(STEPS - 1, Math.floor(q));
  const a = /** @type {number} */ (tab[i]), b = /** @type {number} */ (tab[i + 1]);
  return a + (b - a) * (q - i);
}

/**
 * Film time → the time a stretch of the film is drawn at, from speed keys
 * [[t, speed, ease?], …] in film time (ascending): the speed changes from
 * one key's to the next's on that key's ease (default inOut2), and the drawn
 * time is its integral — so a ramp, a freeze (speed 0) or slow motion is
 * one function wrapped round the page's own: `__render = (t) =>
 * draw(remap(t, keys))`. Before the first key the drawn time is film time
 * (at the first speed); after the last, it runs on at the last speed. The
 * master's shutter samples film time, so a slowed move is drawn with less
 * blur on its own. `twos`: the drawn time held for that many frames at a
 * time at `fps` (2: on twos), as the game film's animated shots were
 * (78.67–79.83 s: on twos, then threes). The drawn time never runs back
 * while every speed is 0 or more.
 * `draw(remap(t, freeze(6.2)))`; `draw(remap(t, [[2, 1], [2.2, 0.2], [3.45, 0.2], [3.8, 1]]))`
 * @param {number} t
 * @param {[number, number, (Ease | string)?][]} keys
 * @param {{ twos?: number, fps?: number }} [o]
 */
export function remap(t, keys, { twos = 0, fps = 24 } = {}) {
  let tau = t;
  if (keys.length) {
    const [k0, v0] = /** @type {[number, number]} */ (keys[0]);
    if (t <= k0) tau = k0 + v0 * (t - k0);
    else {
      tau = k0;
      let done = false;
      for (let i = 1; i < keys.length && !done; i++) {
        const [ta, va] = /** @type {[number, number]} */ (keys[i - 1]);
        const [tb, vb, e] = /** @type {[number, number, (Ease | string)?]} */ (keys[i]);
        const span = tb - ta;
        const x = Math.min(t, tb) - ta;
        tau += span > 0 ? va * x + (vb - va) * span * integral(e ?? "inOut2", x / span) : 0;
        if (t <= tb) done = true;
      }
      if (!done) {
        const [tl, vl] = /** @type {[number, number]} */ (keys[keys.length - 1]);
        tau += vl * (t - tl);
      }
    }
  }
  return twos > 0 ? onTwos(tau, twos, fps) : tau;
}

/**
 * The speed keys of a freeze, for remap: slowing to `speed` over `slow` s
 * before `at`, held `hold` s, back to full speed over `back` s. Measured on
 * the game film, 43.29–44.58 s (24 fps): 9 frames slowing, 14 frozen
 * (0.58 s), 9 speeding up. What
 * is drawn then runs behind film time by about hold + (slow + back) / 2.
 * `draw(remap(t, freeze(43.3)))`
 * @param {number} at  the freeze begins
 * @param {{ slow?: number, hold?: number, back?: number, speed?: number }} [o]
 * @returns {[number, number][]}
 */
export function freeze(at, { slow = 9 / 24, hold = 14 / 24, back = 9 / 24, speed = 0 } = {}) {
  return [[at - slow, 1], [at, speed], [at + hold, speed], [at + hold + back, 1]];
}

/**
 * Time held for `n` frames at a time at `fps`: drawn on twos (n 2) or threes.
 * `draw(onTwos(t))`
 * @param {number} t @param {number} [n] @param {number} [fps]
 */
export function onTwos(t, n = 2, fps = 24) {
  return (Math.floor((t * fps) / n + 1e-6) * n) / fps;
}
