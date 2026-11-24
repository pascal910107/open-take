// space.js — a 3D stage for a film page, on three.js: the product's live
// interface as windows floating in depth over a backdrop, a lens that travels
// between them with real depth of field, and a cut to a lit object. For the
// shots of a launch film that tilt, fly through or focus — most "3D" in those
// films is flat layers scaled apart (anim.js and a 2D camera do that, cheaper
// and sharper); reach for this when the lens itself has to move in space or
// the focus has to fall off with distance.
//
// Measured on six launch films and tried under `film render`: a window is a
// live element of the page drawn into WebGL through Chrome's HTML-in-Canvas
// (its text is typed, its strokes drawn, frame by frame), the lens is a thin
// lens and a 180° shutter, and one loop of N samples gives depth of field,
// motion blur and anti-aliasing together — the same t gives the same pixels.
//
//   import * as THREE from "./kit/three.module.min.js";
//   import { space, riseIn } from "./lib/space.js";
//   const st = space({ three: THREE, canvas: document.querySelector("#gl") });
//   const prompt = st.slab(document.querySelector("#prompt"), { scale: 3 });
//   st.slab(document.querySelector("#board"), { layer: "far", pos: [-700, 220, 80], ry: 15, move: riseIn(3.0) });
//   st.backdrop(myTexture);
//   st.shots([
//     { start: 0, dur: 2.6, from: { pos: [0, 0, 900] }, to: { pos: [0, 0, 860] }, focus: [0, 0, 0], aperture: 13 },
//     { start: 2.6, dur: 2, to: { pos: [-150, 30, 2050], at: [-40, 10, -260] }, ease: "inOut3", aperture: 30 },
//   ]);
//   window.__film = st.film({ duration: 10 });          // before any await: ready, motion, cuts
//   window.__render = async (t) => { setTheDom(t); await st.draw(t); };
//
//   space(o)                 the stage: o.three, o.canvas (`<canvas layoutsubtree content="drawable">`
//                            with the slabs' elements inside it, each `<div drawable>`: Chrome
//                            builds have read either attribute, so carry both), o.width/height
//                            (1920×1080), o.samples (draft 8, master 32), o.shutter (0.5 of a
//                            frame: 180°; 0 leaves the blur to `film render`)
//   st.scene(name, o)        a scene, made or changed ("main" is there; one is drawn at a time, a
//                            shot names it): o.clear — its ground colour: 0x…, "#…", a THREE.Color,
//                            or (t) => one of those, so it changes over the film with no call
//                            from __render — o.update(t, pose), o.finish (solid.js `finish`: bloom
//                            and a grade), o.environment. It gives back the scene:
//     .add(obj, layer?)        a three object into a layer ("hero") — or one of solid.js's ready
//                              objects (a laptop, a desk): its `tick` then runs with the scene
//     .animate((t, at) => …)   what its objects are at t: run at every sample's time, as o.update is
//     .clearAt(t), .three, .layer(name), .watch(obj)
//   st.layer(name, scene?)   a group: backdrop (z −1900), far (−600), hero (0), near (+190)
//   st.slab(el, o)           a live element as a window in depth: o.pos [x,y,z] in its layer
//                            (CSS px, y up), o.rx/ry/rz (°), o.scale (texture px per CSS px;
//                            ≥ the most it is magnified on screen, 3 for a close-up),
//                            o.shadow, o.parent (another slab, or any three object — a lid, a
//                            THREE.Group you turn: it rides on it, in its scene),
//                            o.move(t) → { x, y, z, rx, ry, rz, scale, opacity } from its home,
//                            o.picture (an image used where HTML-in-Canvas is missing). It gives
//                            back the slab:
//     .point(x, y, t)          a point of the element (its own CSS px, from its top-left) in the
//                              space at t — right before the first draw too, on a lid at any angle
//     .toFrame(x, y, t)        the same point in the frame, px: where to pin a label, a cursor
//     .station(rect, o)        the lens that frames a part of it (rect in its CSS px; o.share of
//                              the frame's width, o.yaw/o.pitch off square on): a shot's `to`
//     .group, .mesh, .el, .width, .height
//   st.backdrop(tex, o)      a plane behind everything, big enough for a wide lens
//   st.nearLens(o)           something passing near the lens: a soft card placed from the lens
//   st.shots([...])          the lens: shots in time (see `rig`); a shot with `cut: true` or
//                            another `scene` starts on a hard cut, which no shutter crosses.
//                            Three kinds move as lib/moves.js moves a 2D camera, on its maths:
//                            { stations: [{ t, to }, …] } (quick to leave, long to slow, never at
//                            rest), { momentum: "up", … } (starts on a momentumCut) and
//                            { jump: t, to } (a rampJump) — a 3D stretch and a 2.5D one of the
//                            same film are timed alike
//                            It gives back the lens: `.pose(t)` is where it is, and `.pose(t).shot`
//                            the index of the shot t is in — a momentum cut falls between two
//                            frames, half a frame before its shot's start, so ask that, not t
//   st.draw(t)               the frame at t: textures of what changed, then N samples
//   st.toFrame(p, t)         a point of the space in the frame (px), for a label pinned to it —
//                            a slab's own point: slab.toFrame(x, y, t)
//   st.travel(t, half)       how far the picture moves across [t−half, t+half], px
//   st.film(o)               window.__film: { duration, ready, motion, events } — motion is the
//                            stage's travel() when o.shutter is 0, else 0, the stage blurring
//                            itself; the render measures the DOM outside the canvas on its own
//                            and takes the larger, and each draw exposes the share of the
//                            shutter the render gives it (window.__filmShare)
//   st.events()              the cuts, as { t, kind } for the events file ("cut"; a jump's,
//                            "hidden-cut") — st.film() hands them on
//   riseIn(t0, o), float(…)  a slab's `move`: rising into place from behind; a slow float
//   eases                    a shot's eases (fly, station, …); any name lib/anim.js knows works too
//
// Text up close: a window's texture is drawn once at o.scale times its CSS
// size (HTML-in-Canvas rasterises at that size, it does not stretch a 1×
// picture), and while a window is shown at more than half its texture's
// pixels the texture is read from its full-size level only — blending in the
// smaller mip levels is what softened text most (stroke edge 2.15 px against
// 1.50 px for the same text as DOM; 1.64 px with the full level only).
//
// Blur that outruns the samples: N samples of a disk or a smear tens of px
// wide land px apart, and a sharp texture drawn N times shows N copies. So
// each frame a slab's texture is read no finer than the mip level blurred by
// the gap between its copies (`sampleGap`, from its depth against the focus
// and its travel across the shutter): defocused or fast text smears into one
// piece. A slab's outline is not softened that way; what passes near the lens
// gets a pre-blurred soft edge (`softCard`), as nearLens does.
//
// What changes over the film is a function of t the stage calls, not a value
// __render sets: a frame is N samples at N times across the shutter, and the
// stage places everything again for each. A lid's angle, a light, a colour
// written from __render(t) is the same in all N — a lid that shuts in 0.3 s
// then has no blur and the lens does. So: a slab's `move`, a scene's `update`
// or `.animate`, a ready object's own `open`/`look`, a scene's `clear` as a
// function. The same holds for slab.point and toFrame: they put the scene as
// it is at the t they are asked for, so they need no draw first.
//
//   const main = st.scene("main", { clear: (t) => (t < 15 ? 0x2a211b : 0xe9dfcf) });
//   const lid = new THREE.Group(); main.add(lid);
//   const screen = st.slab(appEl, { parent: lid, shadow: false });
//   main.animate((t) => { lid.rotation.x = -keys(t, [[3, 105], [3.3, 0, "in2"]]) * Math.PI / 180; });
//   const row = screen.station(rectOf(rowEl), { share: 0.6, yaw: -8 });   // a lens on a part of it
//   st.shots([{ start: 0, stations: [{ t: 0, to: screen.station() }, { t: 1.2, to: row }] },
//             { start: 4, dur: 2, momentum: "up", from: wide, to: wide2 }, { jump: 7, to: row }]);
//   label.style.transform = `translate(${screen.toFrame(40, 20, t).join("px,")}px)`;
// (lib/solid.js has the laptop and the desk ready: `main.add(S.laptop({ open: (t) => … }))`.)
//
// Costs, Apple M5 at 1080p: 32 samples 14–30 ms a frame on the GPU; a draft
// (960×540, 8 samples) about 76 ms a frame through `film render`.
//
// Pure functions of t, no clock: `rig`, `handheld`, eases, `shutterTimes`
// and `cutsOf` also work without three, for planning and tests. Its eases
// and clamp are lib/anim.js's and its stations, momentum cut and jump
// lib/moves.js's, which sit beside it.

import { bezier, clamp, ease, named } from "./anim.js";
import { momentumCut, rampJump, stations } from "./moves.js";

/** @typedef {[number, number, number]} V3 */
/** @typedef {(u: number) => number} Ease */
/**
 * @typedef {object} Pose a lens: where it is, what it looks at, its lens
 * @property {V3} [pos] @property {V3} [at] @property {number} [fov] vertical, degrees @property {number} [roll] degrees
 */
/**
 * @typedef {object} Shot
 * @property {number} [start] s (a `jump` shot: 14/24 s before its jump unless given)
 * @property {number} [dur] s (a `jump` shot: 20/24; a `stations` shot needs none — it runs until the next shot)
 * @property {Pose} [from] where the lens starts (default: where the last shot ended, or was when this one starts)
 * @property {Pose} [to] where it ends (a `stations` shot: its last station)
 * @property {{ t: number, to: Pose, accel?: number, decay?: number, settle?: number, creep?: number }[]} [stations] the
 *   lens from station to station as lib/moves.js `stations` moves a 2D camera: each leg leaves for its `to` at
 *   its t, quick to leave, eleven frames of 24 to slow, then creeping on until the next leaves
 * @property {number} [accel] a `stations` shot: s each leg speeds up over (5.5/24)
 * @property {number} [decay] a `stations` shot: the share of its speed a leg keeps every 1/24 s at first (0.73)
 * @property {number} [settle] a `stations` shot: s from a leg's fastest frame to its creep (11/24)
 * @property {number} [creep] a `stations` shot: the share of a leg left to the drift after it lands (0.02)
 * @property {true | "up" | "down" | "left" | "right" | { dir?: "up" | "down" | "left" | "right" | V3, out?: number, in?: number,
 *   outDur?: number, inDur?: number, leave?: Ease | string, resume?: Ease | string }} [momentum]
 *   it starts on lib/moves.js's `momentumCut`: the shot before leaves faster every frame, the cut on its
 *   fastest, this one carrying on the same way and slowing into its place
 * @property {number} [jump] s: the shot is lib/moves.js's `rampJump` from `from` to `to` — speeding up for
 *   14/24 s, one frame's jump at this time, 6/24 s settling
 * @property {V3[]} [via] points the path passes through on the way
 * @property {Ease | string} [ease] default "inOut3"
 * @property {number | V3 | ((t: number) => number | V3) | { from: V3, to: V3, start: number, dur: number, ease?: Ease | string }} [focus]
 *   a distance, a point kept sharp, a function of t, or a pull from one point to another (default: the `at` point)
 * @property {number | ((t: number) => number)} [aperture] the lens's radius in scene units (0: all sharp)
 * @property {number | ((t: number) => { yaw: number, pitch: number, roll: number })} [handheld] amplitude (°) or a handheld()
 * @property {string} [scene] which scene it shows (default "main")
 * @property {boolean} [cut] it starts on a hard cut
 * @property {string} [name]
 */
/**
 * @typedef {object} LensAt the lens at t
 * @property {V3} pos @property {V3} at @property {number} fov @property {number} roll
 * @property {number} yaw @property {number} pitch @property {number} focus distance to the plane kept sharp
 * @property {number} aperture @property {string} scene @property {number} shot index of the shot
 */
/**
 * @typedef {object} Mark a cut of the lens's own
 * @property {number} t the frame it falls on (s) @property {number} edge where no shutter crosses: t, or half a
 *   frame before it for a cut that falls between two frames @property {"cut" | "hidden-cut"} kind
 */

// --- pure: eases, paths, the lens over time ---------------------------------

/** @param {number} x */
const clamp01 = (x) => clamp(x);

/** eases by name, for shots: the camera moves of the reels leave gently and
 *  land fast then settle ("fly": cubic-bezier(.55,0,.12,1), the spike's
 *  fly-to-a-window); "station" accelerates over about a third and settles
 *  over two thirds, as stations in long takes did (5–6 frames up, 10–12 down)
 *  — but it comes to rest, where the reels' stations never reached zero
 *  speed: follow it with a slow drift shot from where it lands
 *  @type {Record<string, Ease>} */
export const eases = {
  linear: (x) => clamp01(x),
  smooth: (x) => { x = clamp01(x); return x * x * (3 - 2 * x); },
  inOut3: (x) => ease.inOut3(clamp01(x)),
  out3: (x) => ease.out3(clamp01(x)),
  in3: (x) => ease.in3(clamp01(x)),
  outExpo: (x) => ease.outExpo(clamp01(x)),
  fly: bezier(0.55, 0, 0.12, 1),
  station: bezier(0.42, 0, 0.18, 1),
};

/** a shot's ease: one of `eases`, any name lib/anim.js knows (its own and GSAP's) or a
 *  function, fed the shot's progress held to 0..1 — so an ease that overshoots
 *  (back.out) overshoots inside its shot and the lens holds where it ended after it.
 *  An unknown name throws here, when the shots are set.
 *  @param {Ease | string | undefined} e @returns {Ease} */
const easeOf = (e) => {
  if (!e) return /** @type {Ease} */ (eases.inOut3);
  const f = typeof e === "function" ? e : (eases[e] ?? named(e));
  return (x) => f(clamp01(x));
};

/** @param {V3} a @param {V3} b @param {number} u @returns {V3} */
export const lerp3 = (a, b, u) => [a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u, a[2] + (b[2] - a[2]) * u];
/** @param {V3} a @param {V3} b */
const dist3 = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

/**
 * A point at u (0..1) along a centripetal Catmull-Rom path through `pts`
 * (each stretch between two points an equal share of u, as three's
 * CatmullRomCurve3). Two points: a straight line. A u a little past 0 or 1
 * (an ease that overshoots) carries on along the first or last stretch, as
 * the lens's aim and fov do.
 * @param {V3[]} pts @param {number} u @returns {V3}
 */
export function pathAt(pts, u) {
  const n = pts.length;
  if (n === 0) return [0, 0, 0];
  if (n === 1) return /** @type {V3} */ ([...(/** @type {V3} */ (pts[0]))]);
  const f = u * (n - 1);
  const i = Math.max(0, Math.min(n - 2, Math.floor(f)));
  const s = f - i;
  const p1 = /** @type {V3} */ (pts[i]), p2 = /** @type {V3} */ (pts[i + 1]);
  if (n === 2) return lerp3(p1, p2, s);
  // the ends are mirrored, as three does for an open curve
  const p0 = pts[i - 1] ?? lerp3(p1, p2, -1), p3 = pts[i + 2] ?? lerp3(p2, p1, -1);
  const k = (/** @type {V3} */ a, /** @type {V3} */ b) => Math.max(1e-4, Math.sqrt(dist3(a, b)));
  const t0 = 0, t1 = t0 + k(p0, p1), t2 = t1 + k(p1, p2), t3 = t2 + k(p2, p3);
  const t = t1 + (t2 - t1) * s;
  /** @param {V3} a @param {V3} b @param {number} ta @param {number} tb @returns {V3} */
  const mixT = (a, b, ta, tb) => lerp3(a, b, (t - ta) / (tb - ta));
  const a1 = mixT(p0, p1, t0, t1), a2 = mixT(p1, p2, t1, t2), a3 = mixT(p2, p3, t2, t3);
  const b1 = mixT(a1, a2, t0, t2), b2 = mixT(a2, a3, t1, t3);
  return mixT(b1, b2, t1, t2);
}

/**
 * Deterministic handheld: sums of sines at incommensurate rates, in degrees,
 * the phases set by `seed` so two shots never shake alike. The amplitudes are
 * chosen by eye, not measured on the reels.
 * @param {number} [amp] degrees (0.12: a lens held still; 0.3: walking)
 * @param {number} [speed] @param {number} [seed]
 */
export function handheld(amp = 0.12, speed = 1, seed = 1) {
  const ph = (/** @type {number} */ k) => ((Math.sin(seed * 12.9898 + k * 78.233) * 43758.5453) % 1) * 6.283;
  return (/** @type {number} */ t) => {
    const s = t * speed;
    return {
      yaw: amp * (0.6 * Math.sin(s * 1.31 + ph(1)) + 0.3 * Math.sin(s * 2.73 + ph(2)) + 0.1 * Math.sin(s * 5.9 + ph(3))),
      pitch: amp * (0.6 * Math.sin(s * 1.07 + ph(4)) + 0.3 * Math.sin(s * 2.31 + ph(5)) + 0.1 * Math.sin(s * 6.3 + ph(6))),
      roll: amp * 0.5 * (0.7 * Math.sin(s * 0.83 + ph(7)) + 0.3 * Math.sin(s * 1.9 + ph(8))),
    };
  };
}

/** the times hard cuts fall on: a shot with `cut`, or showing another scene than the one before
 *  @param {Shot[]} shots @returns {number[]} */
export function cutsOf(shots) {
  const s = [...shots].sort((a, b) => (a.start ?? 0) - (b.start ?? 0));
  /** @type {number[]} */
  const out = [];
  for (let i = 1; i < s.length; i++) {
    const a = /** @type {Shot} */ (s[i - 1]), b = /** @type {Shot} */ (s[i]);
    if (b.cut || b.momentum || (b.scene ?? "main") !== (a.scene ?? "main")) out.push(b.start ?? 0);
  }
  return out;
}

// --- the lens's moves, lib/moves.js's own ------------------------------------
// A 3D shot is driven as a 2.5D layer is: the same functions give the
// progress, and the lens takes it — so a station, a momentum cut and a ramp
// jump are timed alike on either side of a film.

const POSE_KEYS = /** @type {const} */ (["px", "py", "pz", "ax", "ay", "az", "fov", "roll"]);
/** a lens as flat numbers, for moves.js `stations` @param {Required<Pose>} p @returns {Record<string, number>} */
const flatOf = (p) => ({ px: p.pos[0], py: p.pos[1], pz: p.pos[2], ax: p.at[0], ay: p.at[1], az: p.at[2], fov: p.fov, roll: p.roll });
/** @param {Record<string, number>} c @returns {Required<Pose>} */
const poseOf = (c) => {
  const [px = 0, py = 0, pz = 0, ax = 0, ay = 0, az = 0, fov = 30, roll = 0] = POSE_KEYS.map((k) => c[k]);
  return { pos: [px, py, pz], at: [ax, ay, az], fov, roll };
};
/** the lens's own right and up, from where it is and what it looks at (roll left out)
 *  @param {V3} pos @param {V3} at @returns {{ right: V3, up: V3 }} */
function axesOf(pos, at) {
  const f = [at[0] - pos[0], at[1] - pos[1], at[2] - pos[2]], fl = Math.hypot(f[0] ?? 0, f[1] ?? 0, f[2] ?? 0) || 1;
  const fx = (f[0] ?? 0) / fl, fy = (f[1] ?? 0) / fl, fz = (f[2] ?? 0) / fl;
  // right = forward × world up; looking straight up or down, world x
  let rx = -fz, rz = fx;
  const rl = Math.hypot(rx, rz);
  if (rl < 1e-6) { rx = 1; rz = 0; } else { rx /= rl; rz /= rl; }
  return { right: [rx, 0, rz], up: [-rz * fy, rz * fx - rx * fz, rx * fy] };
}
/** how a leg moves, as moves.js `stations` takes it: only what was given
 *  @param {{ accel?: number, decay?: number, settle?: number, creep?: number }} o */
const legOpts = (o) => ({
  ...(o.accel != null ? { accel: o.accel } : {}),
  ...(o.decay != null ? { decay: o.decay } : {}),
  ...(o.settle != null ? { settle: o.settle } : {}),
  ...(o.creep != null ? { creep: o.creep } : {}),
});
/** the frame a time falls on (moves.js snaps a cut the same way)
 *  @param {number} at @param {number} fps */
const frameAt = (at, fps) => Math.round(at * fps + 1e-9) / fps;

/**
 * The lens through shots, as a function of t. Each shot runs from `from` to
 * `to` (along `via`), eased; before the first shot the lens is at its start,
 * between shots it holds where the last one ended — add a slow drift shot
 * rather than letting it stop: the reels' lens is still for 8–17% of a film.
 *
 * Three kinds of shot move as lib/moves.js moves a 2D camera, on its maths
 * and its measured numbers:
 *   { start, stations: [{ t, to }, …] }   station to station (`stations`): quick to leave, long to slow,
 *                                         never at rest before the next leg leaves
 *   { start, momentum: "up", from, to }   starts on a `momentumCut`: the shot before runs out of frame
 *                                         faster every frame, this one carries on and slows. A name is the
 *                                         way the picture travels (as in moves.js; the lens goes the other
 *                                         way, sideways to its aim); a [x, y, z] is the way the lens goes.
 *                                         `out` and `in` are frame px at the depth of the point looked at
 *                                         (128 and 86 of a 1080 frame)
 *   { jump: 8.125, to }                   a `rampJump`: a push that speeds up, jumps in one frame, settles —
 *                                         the lens's distance to `to.at` in log space, as a zoom's scale is
 * A momentum cut and a jump fall between two frames of the film as it is
 * drawn (o.fps, else window.__filmFps, else 60): `marks()` lists them with
 * the plain cuts, `cuts` is where no shutter crosses.
 * @param {Shot[]} shots
 * @param {{ fps?: number | (() => number), height?: number }} [o] height: the frame's, px (1080), for a momentum cut's px
 * @returns {{ pose: (t: number) => LensAt, shots: Shot[], cuts: number[], marks: () => Mark[] }}
 */
export function rig(shots, o = {}) {
  const FRAME_H = o.height ?? 1080;
  const fpsNow = () => {
    const f = typeof o.fps === "function" ? o.fps() : (o.fps ?? /** @type {{ __filmFps?: number }} */ (globalThis).__filmFps);
    return typeof f === "number" && f > 0 ? f : 60;
  };
  const s = shots.map((sh) => {
    if (sh.jump == null) return { ...sh, start: sh.start ?? 0, dur: sh.dur ?? 0 };
    return { ...sh, start: sh.start ?? sh.jump - 14 / 24, dur: sh.dur ?? 20 / 24 };
  }).sort((a, b) => a.start - b.start);
  /** @typedef {{ from: Required<Pose>, to: Required<Pose>, pts: V3[], shake: ((t: number) => { yaw: number, pitch: number, roll: number }) | null,
   *   shot: typeof s[number], ease: Ease, pull: Ease | null, legs: { t: number, at: Record<string, number>, accel?: number, decay?: number, settle?: number, creep?: number }[] | null,
   *   mo: { dir: "up" | "down" | "left" | "right" | V3, out: number, in: number, rest: object } | null }} Prep */
  /** @type {Prep[]} */
  const prep = [];
  /** @type {Required<Pose>} */
  const START = { pos: [0, 0, 1000], at: [0, 0, 0], fov: 30, roll: 0 };
  s.forEach((sh, i) => {
    // from where the last shot ended — a `stations` shot never ends: where it was then
    const before = prep[i - 1];
    const last = !before ? START : before.legs ? plain(before, sh.start) : before.to;
    const from = { ...last, ...(sh.from ?? {}) };
    /** @type {Prep["legs"]} */
    let legs = null;
    let to = { ...from, ...(sh.to ?? {}) };
    if (sh.stations) {
      if (!sh.stations.length) throw new Error("space: a shot's `stations` needs at least one { t, to }");
      let at = from;
      legs = sh.stations.map((st) => {
        at = { ...at, ...st.to };
        return { t: st.t, at: flatOf(at), ...legOpts(st) };
      });
      to = at;
    } else if (!sh.to) throw new Error("space: a shot needs `to` (where the lens ends), or `stations`");
    const hh = sh.handheld;
    const fo = sh.focus;
    const m = sh.momentum;
    const { dir = "up", out = 128, in: inn = 86, ...rest } = m && typeof m === "object" ? m : { dir: typeof m === "string" ? m : undefined };
    prep.push({
      from, to,
      pts: [from.pos, ...(sh.via ?? []), to.pos],
      shake: typeof hh === "function" ? hh : hh ? handheld(hh, 1, i + 1) : null,
      shot: sh,
      ease: easeOf(sh.ease),
      pull: fo && !Array.isArray(fo) && typeof fo === "object" ? easeOf(fo.ease ?? "smooth") : null,
      legs,
      mo: m ? { dir, out, in: inn, rest } : null,
    });
  });

  /** shot p's lens at t, before any momentum cut moves it @param {Prep} p @param {number} t @returns {Required<Pose>} */
  function plain(p, t) {
    const sh = p.shot;
    if (p.legs) {
      const { leg: _leg, ...c } = stations(t, p.legs, { from: flatOf(p.from), ...legOpts(sh) });
      return poseOf(c);
    }
    let u;
    if (sh.jump != null) {
      // rampJump's progress is the log of a zoom's scale: the lens's distance to what it
      // ends looking at goes the same way, d0 → d1 in log space
      const L = rampJump(t, sh.jump, { fps: fpsNow() }).p;
      const d0 = dist3(p.from.pos, p.to.at), d1 = dist3(p.to.pos, p.to.at);
      u = d0 > 1e-6 && d1 > 1e-6 && Math.abs(d0 - d1) > 1e-6 ? (d0 - d0 * (d1 / d0) ** L) / (d0 - d1) : L;
    } else u = p.ease((t - sh.start) / Math.max(1e-6, sh.dur));
    return {
      pos: pathAt(p.pts, u),
      at: lerp3(p.from.at, p.to.at, u),
      fov: p.from.fov + (p.to.fov - p.from.fov) * u,
      roll: p.from.roll + (p.to.roll - p.from.roll) * u,
    };
  }

  /** the frame a shot's cut falls on, and the half frame before it where its side begins
   *  @param {number} at @param {number} fps */
  const between = (at, fps) => { const t = frameAt(at, fps); return { t, edge: t - 0.5 / fps }; };
  /** when shot i takes over @param {number} i @param {number} fps */
  const edgeOf = (i, fps) => {
    const p = /** @type {Prep} */ (prep[i]);
    return i > 0 && p.mo ? between(p.shot.start, fps).edge : p.shot.start;
  };

  /** how far a momentum cut has carried the lens off its shot's path at t, in the space
   *  @param {Prep} p the shot that starts on the cut @param {Required<Pose>} l the lens it moves
   *  @param {number} t @param {boolean} leaving l is the shot before @param {number} fps @returns {V3} */
  function carriedBy(p, l, t, leaving, fps) {
    const mo = /** @type {NonNullable<Prep["mo"]>} */ (p.mo);
    // moves.js's own curve, read as shares of `out` and `in`
    const m = momentumCut(t, p.shot.start, { ...mo.rest, dir: "right", out: 1, in: 1, fps });
    const share = leaving ? -m.a.x * mo.out : -m.b.x * mo.in;
    if (!share) return [0, 0, 0];
    const px = (2 * dist3(l.pos, l.at) * Math.tan((l.fov * Math.PI) / 360)) / FRAME_H;
    /** @type {V3} */
    let d;
    if (Array.isArray(mo.dir)) {
      const n = Math.hypot(...mo.dir) || 1;
      d = [-mo.dir[0] / n, -mo.dir[1] / n, -mo.dir[2] / n];
    } else {
      const { right, up } = axesOf(l.pos, l.at);
      d = mo.dir === "up" ? up : mo.dir === "down" ? [-up[0], -up[1], -up[2]] : mo.dir === "left" ? [-right[0], -right[1], -right[2]] : right;
    }
    return [d[0] * share * px, d[1] * share * px, d[2] * share * px];
  }

  /** @param {number} t @returns {LensAt} */
  function pose(t) {
    const fps = fpsNow();
    let k = 0;
    for (let i = 0; i < prep.length; i++) if (t >= edgeOf(i, fps)) k = i;
    const p = prep[k];
    if (!p) return { pos: [0, 0, 1000], at: [0, 0, 0], fov: 30, roll: 0, yaw: 0, pitch: 0, focus: 1000, aperture: 0, scene: "main", shot: 0 };
    const sh = p.shot;
    const l = plain(p, t);
    let { pos, at } = l;
    const { fov, roll } = l;
    // a momentum cut: this shot still landing from one, or leaving into the next
    const next = prep[k + 1];
    for (const [q, leaving] of /** @type {[Prep | undefined, boolean][]} */ ([[k > 0 ? p : undefined, false], [next, true]])) {
      if (!q?.mo) continue;
      const c = carriedBy(q, l, t, leaving, fps);
      pos = [pos[0] + c[0], pos[1] + c[1], pos[2] + c[2]];
      at = [at[0] + c[0], at[1] + c[1], at[2] + c[2]];
    }
    const ap = typeof sh.aperture === "function" ? sh.aperture(t) : (sh.aperture ?? 0);
    const fo = typeof sh.focus === "function" ? sh.focus(t) : sh.focus;
    /** @type {number | V3} */
    let f;
    if (fo && !Array.isArray(fo) && typeof fo === "object") f = lerp3(fo.from, fo.to, (p.pull ?? easeOf(fo.ease ?? "smooth"))((t - fo.start) / Math.max(1e-6, fo.dur)));
    else f = fo ?? at;
    // the distance along the lens's axis to the plane through the point, never under 1
    // (the lens's offset is divided by it)
    const ax = [at[0] - pos[0], at[1] - pos[1], at[2] - pos[2]], al = Math.hypot(ax[0] ?? 0, ax[1] ?? 0, ax[2] ?? 0) || 1;
    const focus = Math.max(1, typeof f === "number" ? f
      : ((f[0] - pos[0]) * (ax[0] ?? 0) + (f[1] - pos[1]) * (ax[1] ?? 0) + (f[2] - pos[2]) * (ax[2] ?? 0)) / al) || 1;
    const sk = p.shake ? p.shake(t) : { yaw: 0, pitch: 0, roll: 0 };
    return { pos, at, fov, roll: roll + sk.roll, yaw: sk.yaw, pitch: sk.pitch, focus, aperture: ap, scene: sh.scene ?? "main", shot: k };
  }

  /** the lens's cuts: a shot marked `cut` or in another scene (on its start), a momentum cut and a
   *  jump (between two frames) @returns {Mark[]} */
  function marks() {
    const fps = fpsNow();
    /** @type {Mark[]} */
    const out = [];
    s.forEach((b, i) => {
      const a = s[i - 1];
      if (a && b.momentum) out.push({ ...between(b.start, fps), kind: "cut" });
      else if (a && (b.cut || (b.scene ?? "main") !== (a.scene ?? "main"))) out.push({ t: b.start, edge: b.start, kind: "cut" });
      if (b.jump != null) out.push({ ...between(b.jump, fps), kind: "hidden-cut" });
    });
    return out.sort((x, y) => x.t - y.t);
  }
  return { pose, shots: s, get cuts() { return marks().map((m) => m.edge); }, marks };
}

/** Halton low-discrepancy number i in base b (0..1) @param {number} i @param {number} b */
export function halton(i, b) {
  let f = 1, r = 0;
  while (i > 0) { f /= b; r += f * (i % b); i = Math.floor(i / b); }
  return r;
}

/**
 * When each of n samples of the frame at t is taken: spread through a shutter
 * of `shutter` s centred on t, stratified and shuffled (i·k mod n, k the
 * first of 7, 8, … sharing no factor with n, so every slot is taken once),
 * and held inside [lo, hi) — the shot the frame belongs to — so no sample
 * shows the picture on the other side of a cut.
 * @param {number} t @param {number} n @param {number} shutter s @param {number} [lo] @param {number} [hi]
 * @returns {number[]}
 */
export function shutterTimes(t, n, shutter, lo = -Infinity, hi = Infinity) {
  const gcd = (/** @type {number} */ a, /** @type {number} */ b) => { while (b) [a, b] = [b, a % b]; return a; };
  let k = 7;
  while (n > 1 && gcd(k, n) !== 1) k++;
  /** @type {number[]} */
  const out = [];
  for (let i = 0; i < n; i++) {
    const at = t + ((((i * k) % n) + 0.5) / n - 0.5) * shutter;
    out.push(Math.min(hi - 1e-6, Math.max(lo, at)));
  }
  return out;
}

/** the run of picture t falls in: from the cut before it to the cut after
 *  @param {number} t @param {number[]} cuts @returns {[number, number]} */
export function runOf(t, cuts) {
  let lo = -Infinity, hi = Infinity;
  for (const c of cuts) {
    if (c <= t) lo = Math.max(lo, c);
    else hi = Math.min(hi, c);
  }
  return [lo, hi];
}

/** a rise into place from behind: back 260 and down 40, fading in over 0.75 s
 *  (the spike's windows coming up as the lens pulls back) — a slab's `move`
 *  @param {number} t0 @param {{ dz?: number, dy?: number, dur?: number }} [o] */
export function riseIn(t0, { dz = -260, dy = -40, dur = 0.75 } = {}) {
  return (/** @type {number} */ t) => {
    const u = dur > 0 ? (eases.smooth?.((t - t0) / dur) ?? 0) : t >= t0 ? 1 : 0;
    return { y: dy * (1 - u), z: dz * (1 - u), opacity: u };
  };
}

/** a slow float, a few px on two axes, for things that should never sit dead still
 *  @param {number} [ax] @param {number} [ay] @param {number} [seed] */
export function float(ax = 12, ay = 7, seed = 1) {
  return (/** @type {number} */ t) => ({ x: ax * Math.sin(t * 1.2 + seed * 2.1), y: ay * Math.sin(t * 1.6 + seed * 1.3) });
}

/**
 * How far apart the copies of a thing are in one frame of n samples, frame
 * px: its blur (a lens's disk of radius `coc`, swept `travel` px across the
 * shutter) shared among the samples. A texture blurred by about this much
 * before it is drawn fills the gaps, so a far defocus or a fast move reads
 * as one smear rather than stacked copies.
 * @param {number} coc @param {number} travel @param {number} n
 */
export function sampleGap(coc, travel, n) {
  if (n <= 1) return 0;
  return Math.max(travel / n, Math.sqrt((Math.PI * coc * coc + 2 * coc * travel) / n));
}

/**
 * The finest mip level a texture may be read from so it is blurred by `gap`
 * px, when `texelsPerPx` of its texels fall on one px: 0 (its full level) for
 * a gap under a px — copies that close merge on their own, and text held
 * still stays as sharp as its full level draws it.
 * @param {number} gap @param {number} texelsPerPx
 */
export function prefilterLevel(gap, texelsPerPx) {
  const texels = gap * texelsPerPx;
  return gap >= 1 && texels > 1 ? Math.log2(texels) : 0;
}

// --- the stage --------------------------------------------------------------

const LAYERS = { backdrop: -1900, far: -600, hero: 0, near: 190 };
const DEG = Math.PI / 180;

/** wait for the canvas's next paint (the snapshot of its drawable children);
 *  no timer as a guard: under the film clock a held timer fires within real
 *  milliseconds, before the paint, and the texture would show an old snapshot
 *  @param {any} canvas */
function nextPaint(canvas) {
  if (typeof canvas.requestPaint !== "function") return Promise.resolve();
  return new Promise((resolve) => {
    canvas.addEventListener("paint", () => resolve(undefined), { once: true });
    canvas.requestPaint();
  });
}

/**
 * The stage. See the top of this file.
 * @param {{ three: any, canvas: HTMLCanvasElement, width?: number, height?: number,
 *   samples?: { draft?: number, master?: number } | number, shutter?: number, near?: number, far?: number,
 *   hic?: boolean }} o
 */
export function space(o) {
  const T = o.three;
  if (!T) throw new Error("space: needs three — space({ three: THREE, canvas })");
  const canvas = /** @type {any} */ (o.canvas);
  const FW = o.width ?? 1920, FH = o.height ?? 1080, aspect = FW / FH;
  const shutterShare = o.shutter ?? 0.5;
  const renderer = new T.WebGLRenderer({ canvas, antialias: false, preserveDrawingBuffer: true, powerPreference: "high-performance" });
  renderer.autoClear = false;
  renderer.toneMapping = T.NoToneMapping;
  const gl = renderer.getContext();
  const hic = o.hic !== false && typeof gl.texElementSubImage2D === "function";

  // --- targets and the accumulation ---
  let dpr = 0, W = 0, H = 0;
  /** @type {any} */ let sampleRT = null;
  /** @type {any} */ let accRT = null;
  function ensureSize() {
    const d = window.devicePixelRatio || 1;
    if (d === dpr) return;
    dpr = d;
    renderer.setPixelRatio(d);
    renderer.setSize(FW, FH, false);
    W = Math.round(FW * d); H = Math.round(FH * d);
    sampleRT?.dispose(); accRT?.dispose();
    sampleRT = new T.WebGLRenderTarget(W, H, { type: T.HalfFloatType, depthBuffer: true });
    accRT = new T.WebGLRenderTarget(W, H, { type: T.FloatType, depthBuffer: false });
  }
  const VS = "varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }";
  const accMat = new T.ShaderMaterial({
    uniforms: { map: { value: null }, weight: { value: 1 } }, vertexShader: VS,
    fragmentShader: "uniform sampler2D map; uniform float weight; varying vec2 vUv; void main(){ gl_FragColor = vec4(texture2D(map, vUv).rgb * weight, 1.0); }",
    blending: T.CustomBlending, blendSrc: T.OneFactor, blendDst: T.OneFactor, blendEquation: T.AddEquation, depthTest: false, depthWrite: false,
  });
  // the plain finish: linear to sRGB, nothing else — an interface keeps its colours
  const outMat = new T.ShaderMaterial({
    uniforms: { map: { value: null } }, vertexShader: VS,
    fragmentShader: `uniform sampler2D map; varying vec2 vUv;
      vec3 srgb(vec3 c){ return mix(c*12.92, 1.055*pow(c, vec3(1.0/2.4))-0.055, step(0.0031308, c)); }
      void main(){ gl_FragColor = vec4(srgb(clamp(texture2D(map, vUv).rgb, 0.0, 1.0)), 1.0); }`,
    depthTest: false, depthWrite: false,
  });
  const quad = new T.PlaneGeometry(2, 2);
  const accScene = new T.Scene(); accScene.add(new T.Mesh(quad, accMat));
  const outScene = new T.Scene(); const outQuad = new T.Mesh(quad, outMat); outScene.add(outQuad);
  const ortho = new T.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const cam = new T.PerspectiveCamera(30, aspect, o.near ?? 10, o.far ?? 40000);
  const NEAR = o.near ?? 10, FAR = o.far ?? 40000;

  /** a lens pose on three's camera, offset on the lens (lx, ly on the unit disk, times the
   *  aperture) with the plane of focus held, and a sub-pixel jitter (jx, jy px)
   *  @param {LensAt} p @param {number} [lx] @param {number} [ly] @param {number} [jx] @param {number} [jy] */
  function aim(p, lx = 0, ly = 0, jx = 0, jy = 0) {
    cam.position.set(...p.pos);
    cam.up.set(0, 1, 0);
    cam.lookAt(...p.at);
    cam.rotateY(p.yaw * DEG); cam.rotateX(p.pitch * DEG); cam.rotateZ(p.roll * DEG);
    cam.updateMatrixWorld();
    const right = new T.Vector3().setFromMatrixColumn(cam.matrixWorld, 0);
    const up = new T.Vector3().setFromMatrixColumn(cam.matrixWorld, 1);
    const dx = lx * p.aperture, dy = ly * p.aperture;
    cam.position.addScaledVector(right, dx).addScaledVector(up, dy);
    cam.updateMatrixWorld();
    const h = NEAR * Math.tan((p.fov * DEG) / 2), w = h * aspect;
    const sx = (-dx * NEAR) / p.focus + jx * ((2 * w) / Math.max(1, W));
    const sy = (-dy * NEAR) / p.focus + jy * ((2 * h) / Math.max(1, H));
    cam.near = NEAR; cam.far = FAR; cam.fov = p.fov; cam.aspect = aspect; // read by levels()
    cam.projectionMatrix.makePerspective(-w + sx, w + sx, h + sy, -h + sy, NEAR, FAR);
    cam.projectionMatrixInverse.copy(cam.projectionMatrix).invert();
  }

  // --- scenes and layers ---
  /** @typedef {number | string | { isColor: true } | ((t: number) => number | string | { isColor: true })} Clear a colour (0x…, "#…", a THREE.Color), or one from film time */
  /** @typedef {(t: number, at: { clear: any, pose: LensAt }) => void} Tick */
  /** @typedef {{ name: string, three: any, clear: Clear, update: ((t: number, p: LensAt) => void) | null, ticks: Tick[], finish: any, layers: Record<string, any>, watch: any[] }} Scene */
  /** @type {Record<string, Scene>} */
  const scenes = {};
  const clearColour = new T.Color();
  /** a scene's ground colour at t (one colour object, read it before the next call)
   *  @param {Scene} sc @param {number} t */
  const clearOf = (sc, t) => {
    const c = typeof sc.clear === "function" ? sc.clear(t) : sc.clear;
    return clearColour.set(/** @type {any} */ (c));
  };
  /** @param {string} name @param {{ clear?: Clear, update?: (t: number, p: LensAt) => void, finish?: any, environment?: any, environmentIntensity?: number }} [so] */
  function scene(name, so = {}) {
    if (!scenes[name]) scenes[name] = { name, three: new T.Scene(), clear: 0x0b0d12, update: null, ticks: [], finish: null, layers: {}, watch: [] };
    const sc = scenes[name];
    if (so.clear !== undefined) sc.clear = so.clear;
    if (so.update) sc.update = so.update;
    if (so.finish) sc.finish = so.finish;
    if (so.environment) sc.three.environment = so.environment;
    if (so.environmentIntensity !== undefined) sc.three.environmentIntensity = so.environmentIntensity;
    return {
      name, three: sc.three,
      layer: (/** @type {string} */ l) => layer(l, name),
      /** things whose motion counts in travel(): their bounding boxes' corners are followed */
      watch: (/** @type {any} */ obj) => { sc.watch.push(obj); return obj; },
      /** a three object into a layer — or one of solid.js's ready objects ({ group, tick?, fog? }):
       *  its group goes in, its `tick` is run at every sample's time, its fog becomes the scene's */
      add: (/** @type {any} */ obj, /** @type {string} */ l = "hero") => {
        layer(l, name).add(obj?.isObject3D ? obj : obj.group);
        if (!obj?.isObject3D) {
          if (obj.fog) sc.three.fog = obj.fog;
          if (typeof obj.tick === "function") sc.ticks.push(obj.tick);
        }
        return obj;
      },
      /** run fn(t, { clear, pose }) at every sample's time, as well as the scene's `update`:
       *  what an object is at t (a lid's angle, a light) belongs here, not in __render */
      animate: (/** @type {Tick} */ fn) => { sc.ticks.push(fn); },
      /** the ground colour at t, a new THREE.Color */
      clearAt: (/** @type {number} */ t) => clearOf(sc, t).clone(),
    };
  }
  /** @param {string} name @param {string} [sceneName] */
  function layer(name, sceneName = "main") {
    scene(sceneName);
    const sc = /** @type {Scene} */ (scenes[sceneName]);
    if (!sc.layers[name]) {
      const g = new T.Group();
      g.name = name;
      g.position.z = /** @type {Record<string, number>} */ (LAYERS)[name] ?? 0;
      sc.three.add(g);
      sc.layers[name] = g;
    }
    return sc.layers[name];
  }
  scene("main");

  // --- live slabs ---
  /** @typedef {{ el: HTMLElement, w: number, h: number, tw: number, th: number, glTex: any, tex: any, mesh: any, group: any, shadow: any,
   *   home: any, homeRot: any, move: ((t: number) => any) | null, dirty: boolean, allocated: boolean, lod: string, picture: string | null, scene: string }} Slab */
  /** @type {Slab[]} */
  const slabs = [];
  const aniso = gl.getExtension("EXT_texture_filter_anisotropic");
  // A slab's texture holds the element as the browser drew it: sRGB, its
  // alpha premultiplied there, so filtering and mip levels blend the way the
  // page composites (no dark fringe round a rounded corner). The shader takes
  // the colour back out, decodes it to linear, and three's premultipliedAlpha
  // multiplies by alpha once (and blends ONE, 1−α): half-white glass over a
  // white card stays white.
  const SLAB_MAP = `#ifdef USE_MAP
    vec4 texel = texture2D( map, vMapUv );
    vec3 c = texel.a > 0.0 ? clamp( texel.rgb / texel.a, 0.0, 1.0 ) : vec3( 0.0 );
    c = mix( c / 12.92, pow( ( c + 0.055 ) / 1.055, vec3( 2.4 ) ), step( 0.04045, c ) );
    diffuseColor *= vec4( c, texel.a );
  #endif`;

  /** a soft rounded card drawn by code: a blurred shape, for shadows and things near the lens
   *  @param {number} w @param {number} h @param {number} blur px @param {string} fill @param {number} [radius] */
  function softCard(w, h, blur, fill, radius = 24) {
    const pad = blur * 3, c = document.createElement("canvas");
    c.width = w + pad * 2; c.height = h + pad * 2;
    const ctx = /** @type {CanvasRenderingContext2D} */ (c.getContext("2d"));
    ctx.filter = `blur(${blur}px)`; ctx.fillStyle = fill;
    ctx.beginPath(); ctx.roundRect(pad, pad, w, h, radius); ctx.fill();
    const tex = new T.CanvasTexture(c); tex.colorSpace = T.SRGBColorSpace;
    return { texture: tex, width: c.width, height: c.height };
  }

  /**
   * @param {HTMLElement} el a drawable child of the canvas (`<div drawable>` inside `<canvas content="drawable">`)
   * @param {{ layer?: string, scene?: string, pos?: V3, rx?: number, ry?: number, rz?: number, scale?: number,
   *   shadow?: boolean, parent?: any, move?: (t: number) => any, picture?: string, size?: [number, number] }} [so]
   *   parent: another slab, or any three object (a lid, a turntable): the slab rides on it, in its scene
   */
  function slab(el, so = {}) {
    const w = so.size?.[0] ?? el.offsetWidth, h = so.size?.[1] ?? el.offsetHeight;
    const k = so.scale ?? 2;
    const tw = Math.round(w * k), th = Math.round(h * k);
    const glTex = gl.createTexture();
    const tex = new T.ExternalTexture(glTex);
    const mat = new T.MeshBasicMaterial({ map: tex, transparent: true, premultipliedAlpha: true, toneMapped: false, depthWrite: so.shadow !== false });
    mat.onBeforeCompile = (/** @type {any} */ sh) => { sh.fragmentShader = sh.fragmentShader.replace("#include <map_fragment>", SLAB_MAP); };
    mat.customProgramCacheKey = () => "space-slab";
    const mesh = new T.Mesh(new T.PlaneGeometry(w, h), mat);
    const group = new T.Group(); group.add(mesh);
    /** @type {any} */ let shadow = null;
    if (so.shadow !== false) {
      const s = softCard(w, h, 22, "rgba(0,0,0,0.55)", 22);
      shadow = new T.Mesh(new T.PlaneGeometry(s.width, s.height), new T.MeshBasicMaterial({ map: s.texture, transparent: true, depthWrite: false, toneMapped: false }));
      shadow.position.set(0, -26, -24);
      group.add(shadow);
    }
    group.position.set(...(so.pos ?? [0, 0, 0]));
    group.rotation.set((so.rx ?? 0) * DEG, (so.ry ?? 0) * DEG, (so.rz ?? 0) * DEG);
    // a slab riding on another is in its scene; one on a three object, in the scene that
    // object is in (looked up each time: the object may be put in its scene after)
    const host = so.parent ? (so.parent.isObject3D ? so.parent : so.parent.group) : null;
    if (so.parent && !host?.isObject3D) throw new Error("space: a slab's `parent` is another slab or a three object (a Group, a Mesh)");
    const sceneName = so.parent?.slab?.scene ?? so.scene ?? "main";
    (host ?? layer(so.layer ?? "hero", sceneName)).add(group);
    /** @type {Slab} */
    const s = { el, w, h, tw, th, glTex, tex, mesh, group, shadow, home: group.position.clone(), homeRot: group.rotation.clone(),
      move: so.move ?? null, dirty: true, allocated: false, lod: "", picture: so.picture ?? null, scene: sceneName };
    if (host && !so.parent.slab && !so.scene) Object.defineProperty(s, "scene", { get: () => sceneHolding(host) ?? "main" });
    slabs.push(s);

    /** everything the slab hangs on, as it is at t — before any draw too */
    const settleAt = (/** @type {number} */ t) => {
      const sc = scenes[s.scene];
      if (sc) settle(sc, t, lens.pose(t));
      mesh.updateWorldMatrix(true, false);
    };
    /** a point of the element (its own CSS px, from its top-left) in the space at t
     *  @param {number} x @param {number} y @param {number} [t] @returns {V3} */
    function point(x, y, t = 0) {
      settleAt(t);
      const v = new T.Vector3(x - w / 2, h / 2 - y, 0).applyMatrix4(mesh.matrixWorld);
      return [v.x, v.y, v.z];
    }
    /**
     * The lens that frames a part of the slab as lib/moves.js `station` frames
     * a rect for a 2D camera: aimed at its middle, the rect `share` of the
     * frame's width (0.635), square on — or `yaw`/`pitch` degrees round it
     * (yaw + from the slab's right, pitch + from above). A Pose for a shot's
     * `from`/`to` or a station's `to`; with the slab where it is at `t`.
     * @param {{ x: number, y: number, w: number, h: number } | null} [rect] in the element's CSS px (default: all of it)
     * @param {{ share?: number, fov?: number, t?: number, yaw?: number, pitch?: number, dist?: number }} [fo]
     *   dist: how far the lens stands off, in place of `share`
     * @returns {{ pos: V3, at: V3, fov: number }}
     */
    function station(rect, fo = {}) {
      const r = rect ?? { x: 0, y: 0, w, h };
      const { share = 0.635, fov = 30, t = 0, yaw = 0, pitch = 0 } = fo;
      const at = point(r.x + r.w / 2, r.y + r.h / 2, t);
      const m = mesh.matrixWorld;
      const right = new T.Vector3().setFromMatrixColumn(m, 0), up = new T.Vector3().setFromMatrixColumn(m, 1), out = new T.Vector3().setFromMatrixColumn(m, 2);
      const k = right.length();
      right.normalize(); up.normalize(); out.normalize();
      out.applyAxisAngle(right, -pitch * DEG).applyAxisAngle(up, yaw * DEG);
      const d = fo.dist ?? (r.w * k) / (share * 2 * Math.tan((fov * DEG) / 2) * aspect);
      return { pos: [at[0] + out.x * d, at[1] + out.y * d, at[2] + out.z * d], at, fov };
    }
    return {
      group, mesh, el, width: w, height: h, slab: s, point, station,
      /** a point of the element (its own CSS px) in the frame at t, px; null behind the lens
       *  @param {number} x @param {number} y @param {number} [t] */
      toFrame: (x, y, t = 0) => toFrame(point(x, y, t), t),
    };
  }

  /** the name of the scene a three object is in, if it is in one @param {any} obj @returns {string | null} */
  function sceneHolding(obj) {
    let root = obj;
    while (root.parent) root = root.parent;
    for (const sc of Object.values(scenes)) if (sc.three === root) return sc.name;
    return null;
  }

  /** @param {Slab} s @param {TexImageSource | null} [img] */
  function upload(s, img = null) {
    gl.bindTexture(gl.TEXTURE_2D, s.glTex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
    if (!s.allocated) {
      // sRGB bytes, premultiplied: decoded in the slab's shader (see SLAB_MAP)
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, s.tw, s.th, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      s.allocated = true;
    }
    if (img) gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, gl.RGBA, gl.UNSIGNED_BYTE, img);
    else gl.texElementSubImage2D(gl.TEXTURE_2D, 0, 0, 0, s.el, { width: s.tw, height: s.th });
    gl.generateMipmap(gl.TEXTURE_2D);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    if (aniso) gl.texParameterf(gl.TEXTURE_2D, aniso.TEXTURE_MAX_ANISOTROPY_EXT, 16);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    s.lod = "";
    renderer.resetState();
  }

  /** where HTML-in-Canvas is missing: the slab's `picture`, or the element through an SVG
   *  foreignObject with the page's own style sheets (system fonts only; no outside images)
   *  @param {Slab} s @returns {Promise<HTMLCanvasElement>} */
  async function raster(s) {
    const c = document.createElement("canvas");
    c.width = s.tw; c.height = s.th;
    const ctx = /** @type {CanvasRenderingContext2D} */ (c.getContext("2d"));
    const img = new Image();
    if (s.picture) img.src = s.picture;
    else {
      let css = "";
      for (const sh of Array.from(document.styleSheets)) {
        try { for (const r of Array.from(sh.cssRules)) css += r.cssText + "\n"; } catch { /* another origin's sheet */ }
      }
      const xml = new XMLSerializer().serializeToString(s.el);
      img.src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(
        `<svg xmlns="http://www.w3.org/2000/svg" width="${s.tw}" height="${s.th}" viewBox="0 0 ${s.w} ${s.h}"><foreignObject x="0" y="0" width="${s.w}" height="${s.h}"><style>${css}</style>${xml}</foreignObject></svg>`);
    }
    await img.decode();
    ctx.drawImage(img, 0, 0, c.width, c.height);
    return c;
  }

  // what changed in a slab's element since its last upload: the observer's
  // own deliveries (a page that awaits between setting its DOM and draw(t))
  // and the records still queued, taken in draw() — either way exactly the
  // slabs it touched are uploaded
  /** @param {MutationRecord[]} recs */
  const markDirty = (recs) => {
    for (const r of recs) for (const s of slabs) if (s.el === r.target || s.el.contains(r.target)) s.dirty = true;
  };
  const watcher = new MutationObserver(markDirty);
  watcher.observe(canvas, { subtree: true, childList: true, attributes: true, characterData: true });

  /** @type {Promise<void> | null} */
  let fresh = null;
  async function refresh() {
    markDirty(watcher.takeRecords());
    const todo = slabs.filter((s) => s.dirty);
    if (!todo.length) return;
    if (hic) {
      await nextPaint(canvas);
      markDirty(watcher.takeRecords());
      for (const s of slabs.filter((x) => x.dirty)) { upload(s); s.dirty = false; }
    } else {
      for (const s of todo) { upload(s, await raster(s)); s.dirty = false; }
    }
  }

  /** where a slab is in the frame for the lens as aimed now: its middle and corners (frame
   *  px), how many device px its width covers, and how far it is along the lens's axis
   *  @param {Slab} s */
  function seen(s) {
    const e = s.mesh.matrixWorld.elements;
    const sx = Math.hypot(e[0], e[1], e[2]);
    const c = new T.Vector3().setFromMatrixPosition(s.mesh.matrixWorld);
    const fwd = new T.Vector3(); cam.getWorldDirection(fwd);
    const depth = Math.max(1, c.clone().sub(cam.position).dot(fwd));
    const pxPerUnit = H / (2 * depth * Math.tan((cam.fov * DEG) / 2) || 1);
    const pts = [[0, 0], [-0.5, -0.5], [0.5, -0.5], [0.5, 0.5], [-0.5, 0.5]].map(([x, y]) =>
      onFrame(new T.Vector3((x ?? 0) * s.w, (y ?? 0) * s.h, 0).applyMatrix4(s.mesh.matrixWorld)));
    return { depth, shownPx: s.w * sx * pxPerUnit, pts };
  }

  /**
   * Which mip levels a slab's texture is read from this frame. Shown at more
   * than half its texture's pixels and sharp: its full level only (blending
   * in smaller levels softened text most). Blurred by the lens or the shutter
   * further than its samples are apart: never finer than the level blurred by
   * that gap (sampleGap), so its copies merge into one smear.
   * @param {Slab} s @param {number} gap frame px between its copies
   * @param {number} shownPx device px across it */
  function levels(s, gap, shownPx) {
    // blurred by 1.5 × the mean gap: the lens's samples are not evenly apart all over its disk
    const d = gap * (W / FW);
    const min = d >= 1 ? prefilterLevel(1.5 * d, s.tw / Math.max(1, shownPx)) : 0;
    const max = min > 0 ? 1000 : shownPx / s.tw > 0.5 ? 0 : 1000;
    const key = `${min.toFixed(2)}/${max}`;
    if (key === s.lod) return;
    gl.bindTexture(gl.TEXTURE_2D, s.glTex);
    gl.texParameterf(gl.TEXTURE_2D, gl.TEXTURE_MIN_LOD, min);
    gl.texParameterf(gl.TEXTURE_2D, gl.TEXTURE_MAX_LOD, max);
    renderer.resetState();
    s.lod = key;
  }

  // --- the backdrop and what passes the lens ---
  /** @param {any} texture @param {{ scene?: string, z?: number, width?: number, height?: number }} [bo] */
  function backdrop(texture, bo = {}) {
    const m = new T.Mesh(new T.PlaneGeometry(bo.width ?? 9600, bo.height ?? 5400), new T.MeshBasicMaterial({ map: texture, toneMapped: false }));
    m.position.z = bo.z ?? 0;
    layer("backdrop", bo.scene ?? "main").add(m);
    return m;
  }

  /** @type {{ mesh: any, start: number, dur: number, from: [number, number], to: [number, number], dist: number, turn: number, scene: string }[]} */
  const passes = [];
  /**
   * Something passing near the lens — a pane of frosted glass, a card — placed
   * from the lens each sample, `dist` in front of it, crossing from `from` to
   * `to` (frame-relative units: −1 left/bottom edge … 1 right/top) over [start, start+dur].
   * Pre-blurred so a large blur does not break into copies.
   * @param {{ start: number, dur: number, from?: [number, number], to?: [number, number], dist?: number,
   *   width?: number, height?: number, blur?: number, fill?: string, texture?: any, scene?: string, turn?: number }} po
   */
  function nearLens(po) {
    const card = po.texture ? null : softCard(po.width ?? 560, po.height ?? 360, po.blur ?? 26, po.fill ?? "rgba(255,255,255,0.5)", 40);
    const tex = po.texture ?? card?.texture;
    const mesh = new T.Mesh(new T.PlaneGeometry(card?.width ?? po.width ?? 560, card?.height ?? po.height ?? 360),
      new T.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false, toneMapped: false }));
    mesh.visible = false;
    scene(po.scene ?? "main");
    /** @type {Scene} */ (scenes[po.scene ?? "main"]).three.add(mesh);
    passes.push({ mesh, start: po.start, dur: po.dur, from: po.from ?? [-1.6, -0.2], to: po.to ?? [1.6, 0], dist: po.dist ?? 520, turn: po.turn ?? 20, scene: po.scene ?? "main" });
    return mesh;
  }

  // --- the lens ---
  const rigOpts = { fps: () => fps(), height: FH };
  let lens = rig([], rigOpts);
  /** @param {Shot[]} list */
  function shots(list) { lens = rig(list, rigOpts); return lens; }

  /** a scene's own things as they are at ts: its slabs from home, then what its objects'
   *  ticks and its `update` say — the lens not aimed
   *  @param {Scene} sc @param {number} ts @param {LensAt} p */
  function settle(sc, ts, p) {
    for (const s of slabs) {
      if (s.scene !== sc.name) continue;
      // from home every sample: the same t, the same place, whatever was drawn before
      s.group.position.copy(s.home);
      s.group.rotation.copy(s.homeRot);
      s.group.scale.setScalar(1);
      let op = 1;
      if (s.move) {
        const m = s.move(ts) ?? {};
        s.group.position.x += m.x ?? 0; s.group.position.y += m.y ?? 0; s.group.position.z += m.z ?? 0;
        s.group.rotation.x += (m.rx ?? 0) * DEG; s.group.rotation.y += (m.ry ?? 0) * DEG; s.group.rotation.z += (m.rz ?? 0) * DEG;
        s.group.scale.setScalar(m.scale ?? 1);
        op = m.opacity ?? 1;
      }
      s.mesh.material.opacity = op;
      if (s.shadow) s.shadow.material.opacity = op;
      s.group.visible = op > 0.001;
    }
    if (sc.ticks.length) {
      const at = { clear: clearOf(sc, ts), pose: p };
      for (const f of sc.ticks) f(ts, at);
    }
    sc.update?.(ts, p);
  }

  /** everything in the scene at sample time ts, the lens unjittered
   *  @param {number} ts @returns {{ p: LensAt, sc: Scene }} */
  function place(ts) {
    const p = lens.pose(ts);
    const sc = /** @type {Scene} */ (scenes[p.scene] ?? scenes.main);
    settle(sc, ts, p);
    aim(p);
    for (const ps of passes) {
      const u = (ts - ps.start) / ps.dur;
      ps.mesh.visible = ps.scene === sc.name && u > -0.05 && u < 1.05;
      if (!ps.mesh.visible) continue;
      const e = eases.smooth?.(u) ?? u;
      const hh = ps.dist * Math.tan((p.fov * DEG) / 2), ww = hh * aspect;
      const fx = ps.from[0] + (ps.to[0] - ps.from[0]) * e, fy = ps.from[1] + (ps.to[1] - ps.from[1]) * u;
      const fwd = new T.Vector3(); cam.getWorldDirection(fwd);
      const right = new T.Vector3().setFromMatrixColumn(cam.matrixWorld, 0), up = new T.Vector3().setFromMatrixColumn(cam.matrixWorld, 1);
      ps.mesh.position.copy(cam.position).addScaledVector(fwd, ps.dist).addScaledVector(right, fx * ww).addScaledVector(up, fy * hh);
      ps.mesh.quaternion.copy(cam.quaternion); ps.mesh.rotateY(ps.turn * DEG); ps.mesh.rotateZ(-0.08);
    }
    sc.three.updateMatrixWorld();
    return { p, sc };
  }

  const fps = () => /** @type {any} */ (window).__filmFps || (dpr < 1 ? 30 : 60);
  const sampleCount = () => {
    const sm = o.samples;
    if (typeof sm === "number") return sm;
    return dpr < 1 ? (sm?.draft ?? 8) : (sm?.master ?? 32);
  };

  /** each shown slab's gap between its copies across `times` (sampleGap), and its size
   *  in device px at t, for levels()
   *  @param {number} t @param {number[]} times @returns {Map<Slab, [number, number]>} */
  function gaps(t, times) {
    const N = times.length;
    const first = Math.min(...times), last = Math.max(...times);
    /** @param {number} ts */
    const at = (ts) => { const { p, sc } = place(ts); return { p, sc, seen: new Map(slabs.filter((s) => s.scene === sc.name && s.group.visible).map((s) => [s, seen(s)])) }; };
    const a = first < last ? at(first) : null, b = first < last ? at(last) : null;
    const mid = at(t);
    /** @type {Map<Slab, [number, number]>} */
    const out = new Map();
    for (const [s, v] of mid.seen) {
      // the lens's disk at the slab's depth, frame px (a thin lens: a point at depth d
      // moves (1 − F/d) of the lens's offset on the plane in focus)
      const p = mid.p;
      const coc = (p.aperture * Math.abs(v.depth - p.focus) / v.depth) * (FH / (2 * p.focus * Math.tan((p.fov * DEG) / 2)));
      let travel = 0;
      const va = a?.seen.get(s), vb = b?.seen.get(s);
      if (va && vb) va.pts.forEach((x, k) => { const y = vb.pts[k]; if (x && y) travel = Math.max(travel, Math.hypot(x[0] - y[0], x[1] - y[1])); });
      out.set(s, [sampleGap(coc, travel, N), v.shownPx]);
    }
    return out;
  }

  // When `film render` spreads a frame's samples over the shutter itself (the
  // DOM outside the canvas moves), each draw is one of them and exposes the
  // share of the shutter the render says it stands for (window.__filmShare),
  // so the stage's samples and the render's tile the shutter without gaps.
  const share = () => {
    const s = /** @type {any} */ (window).__filmShare;
    return typeof s === "number" && s > 0 && s <= 1 ? s : 1;
  };

  /** the frame at t @param {number} t */
  async function draw(t) {
    ensureSize();
    if (fresh) await fresh;
    await refresh();
    const N = sampleCount();
    const [lo, hi] = runOf(t, lens.cuts);
    const times = shutterTimes(t, N, (shutterShare / fps()) * share(), lo, hi);
    const spin = (t * 7.31) % (Math.PI * 2);
    const gap = gaps(t, times);
    renderer.setRenderTarget(accRT); renderer.setClearColor(0x000000, 0); renderer.clear(true, false, false);
    /** @type {Scene | null} */ let shown = null;
    for (let i = 0; i < N; i++) {
      const { p, sc } = place(/** @type {number} */ (times[i]));
      shown = sc;
      for (const s of slabs) if (s.scene === sc.name) { const g = gap.get(s); if (g) levels(s, g[0], g[1]); }
      const r = Math.sqrt((i + 0.5) / N), th = i * 2.399963 + spin; // a Vogel spiral on the lens, turned each frame
      aim(p, r * Math.cos(th), r * Math.sin(th), halton(i + 1, 2) - 0.5, halton(i + 1, 3) - 0.5);
      renderer.setRenderTarget(sampleRT); renderer.setClearColor(clearOf(sc, /** @type {number} */ (times[i])), 1); renderer.clear(true, true, false);
      renderer.render(sc.three, cam);
      accMat.uniforms.map.value = sampleRT.texture; accMat.uniforms.weight.value = 1 / N;
      renderer.setRenderTarget(accRT); renderer.render(accScene, ortho);
    }
    if (shown?.finish) {
      shown.finish.size?.(W, H);
      shown.finish.apply(accRT.texture, t);
    } else {
      renderer.setRenderTarget(null);
      outMat.uniforms.map.value = accRT.texture;
      renderer.render(outScene, ortho);
    }
  }

  /** a point of the space at t in the frame, px (top-left origin); null behind the lens
   *  @param {V3} pt @param {number} t @returns {[number, number] | null} */
  function toFrame(pt, t) {
    ensureSize();
    const { p } = place(t);
    aim(p);
    const v = new T.Vector3(...pt).project(cam);
    if (v.z > 1 || v.z < -1) return null;
    return [((v.x + 1) / 2) * FW, ((1 - v.y) / 2) * FH];
  }

  /** world points followed at t, each under its own key: each shown slab's corners and
   *  middle, watched objects' boxes, and where the frame's corners meet the backdrop
   *  @param {number} t @returns {{ scene: string, world: Map<string, any>, ground: any[] }} */
  function follow(t) {
    const { p, sc } = place(t);
    aim(p);
    /** @type {Map<string, any>} */
    const world = new Map();
    slabs.forEach((s, i) => {
      if (s.scene !== sc.name || !s.group.visible) return;
      [[-0.5, -0.5], [0.5, -0.5], [0.5, 0.5], [-0.5, 0.5], [0, 0]].forEach(([x, y], k) => {
        world.set(`s${i}.${k}`, new T.Vector3((x ?? 0) * s.w, (y ?? 0) * s.h, 0).applyMatrix4(s.mesh.matrixWorld));
      });
    });
    sc.watch.forEach((obj, i) => {
      const b = new T.Box3().setFromObject(obj);
      if (b.isEmpty()) return;
      for (let k = 0; k < 8; k++) world.set(`w${i}.${k}`, new T.Vector3(k & 1 ? b.max.x : b.min.x, k & 2 ? b.max.y : b.min.y, k & 4 ? b.max.z : b.min.z));
    });
    /** @type {any[]} */
    const ground = [];
    const bd = sc.layers.backdrop;
    if (bd?.children.length) {
      const z = new T.Vector3(); bd.getWorldPosition(z);
      const d = Math.abs(cam.position.z - z.z);
      for (const [x, y] of [[-0.8, -0.8], [0.8, -0.8], [0.8, 0.8], [-0.8, 0.8]])
        ground.push(new T.Vector3(x, y, 1).unproject(cam).sub(cam.position).normalize().multiplyScalar(d).add(cam.position));
    }
    return { scene: sc.name, world, ground };
  }

  /** @param {any} v the lens as it is now @returns {[number, number] | null} */
  const onFrame = (v) => {
    const q = v.clone().project(cam);
    if (q.z > 1 || q.z < -1 || Math.abs(q.x) > 1.5 || Math.abs(q.y) > 1.5) return null;
    return [((q.x + 1) / 2) * FW, ((1 - q.y) / 2) * FH];
  };

  /** how far the picture moves across [t−half, t+half], frame px: the 90th
   *  percentile of the followed points' moves (things on their own paths,
   *  the backdrop under the lens's own), each point matched to itself and
   *  counted where it is shown at both ends. No shutter crosses a cut: where
   *  the span touches one, the part inside t's run is measured and scaled to
   *  the whole span (the speed there, over the shutter)
   *  @param {number} t @param {number} half */
  function travel(t, half) {
    const [lo, hi] = runOf(t, lens.cuts);
    const t0 = Math.max(t - half, lo), t1 = Math.min(t + half, hi - 1e-6);
    if (!(t1 > t0)) return 0;
    const mid = follow((t0 + t1) / 2).ground;
    const a = follow(t0);
    const pa = new Map([...a.world, ...mid.map((g, k) => [`g${k}`, g])].map(([key, v]) => [key, onFrame(v)]));
    const b = follow(t1);
    const pb = new Map([...b.world, ...mid.map((g, k) => [`g${k}`, g])].map(([key, v]) => [key, onFrame(v)]));
    if (a.scene !== b.scene) return 0;
    /** @type {number[]} */
    const d = [];
    for (const [key, x] of pa) { const y = pb.get(key); if (x && y) d.push(Math.hypot(x[0] - y[0], x[1] - y[1])); }
    if (!d.length) return 0;
    d.sort((x, y) => x - y);
    return /** @type {number} */ (d[Math.min(d.length - 1, Math.floor(d.length * 0.9))]) * ((2 * half) / (t1 - t0));
  }

  /** the lens's cuts, for the events file: a hard cut, a momentum cut, and a jump's cut
   *  hidden in its push @returns {{ t: number, kind: string, label: string }[]} */
  function events() {
    return lens.marks().map((m) => ({ t: m.t, kind: m.kind,
      label: m.kind === "cut" ? "space: a cut between shots" : "space: the jump inside a push" }));
  }

  /** @param {{ duration: number, ready?: Promise<unknown>, events?: () => any[], width?: number, height?: number, [k: string]: any }} fo */
  function film(fo) {
    const { ready: theirs, events: theirEvents, ...rest } = fo;
    const ready = (async () => {
      await theirs;
      await Promise.resolve();
      ensureSize();
      fresh = refresh();
      await fresh;
      fresh = null;
    })();
    return {
      width: FW, height: FH, ...rest,
      ready,
      // The stage blurs itself across its own shutter, so the render need not
      // for the canvas; the DOM over it the render measures itself (see `share`).
      motion: (/** @type {number} */ t, /** @type {number} */ half) =>
        shutterShare > 0 ? 0 : travel(t, half),
      events: () => [...(theirEvents ? theirEvents() : []), ...events()].sort((x, y) => x.t - y.t),
    };
  }

  return {
    three: T, renderer, camera: cam, canvas, hic,
    scene, layer, slab, backdrop, nearLens, softCard, shots, draw, toFrame, travel, events, film,
    /** the lens at t (no jitter) */
    pose: (/** @type {number} */ t) => lens.pose(t),
  };
}
