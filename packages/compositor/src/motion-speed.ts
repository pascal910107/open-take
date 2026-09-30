// How fast things move on screen, frame by frame — what motion blur needs to
// know. A fixed number of shutter samples leaves a fast move as a stack of
// distinct ghosts (four copies of a headline during a quick zoom) and wastes
// renders on the 3/4 of a film that holds still; asking each frame how far
// its fastest visible corner travels across the shutter lets a still frame
// render once and a fast one render as many times as a smooth smear needs.
//
// Pure: evaluates the composition, never renders.

import { launchDurationS, launchSceneWindows } from "./launch-evaluate";
import type { LaunchComposition, LaunchMotionBlur } from "./launch-types";
import {
  CURSOR_UNIT,
  DEFAULT_PERSPECTIVE,
  evaluateHits,
  evaluateMotionScene,
  evaluateTextUnit,
  motionTextUnits,
  wipeShape,
} from "./motion-evaluate";
import type { EvaluatedMotionLayer, MotionLayer, MotionScene } from "./motion-types";

/** A 3D affine transform, row-major 3×4: [a b c tx, d e f ty, g h i tz]. */
type Matrix = [
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
];
type Point = [number, number];
type Point3 = [number, number, number];

/** Ghost spacing a smear reads as continuous at: the shutter's samples of a
 *  moving edge land at most this many output pixels apart. */
export const SHUTTER_SPACING_PX = 2;

const IDENTITY: Matrix = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0];
const multiply = (a: Matrix, b: Matrix): Matrix => [
  a[0] * b[0] + a[1] * b[4] + a[2] * b[8],
  a[0] * b[1] + a[1] * b[5] + a[2] * b[9],
  a[0] * b[2] + a[1] * b[6] + a[2] * b[10],
  a[0] * b[3] + a[1] * b[7] + a[2] * b[11] + a[3],
  a[4] * b[0] + a[5] * b[4] + a[6] * b[8],
  a[4] * b[1] + a[5] * b[5] + a[6] * b[9],
  a[4] * b[2] + a[5] * b[6] + a[6] * b[10],
  a[4] * b[3] + a[5] * b[7] + a[6] * b[11] + a[7],
  a[8] * b[0] + a[9] * b[4] + a[10] * b[8],
  a[8] * b[1] + a[9] * b[5] + a[10] * b[9],
  a[8] * b[2] + a[9] * b[6] + a[10] * b[10],
  a[8] * b[3] + a[9] * b[7] + a[10] * b[11] + a[11],
];
/** translate3d(x, y, z) rotateX rotateY rotate scale — the CSS order both
 *  renderers use. */
function local(l: {
  x: number;
  y: number;
  z: number;
  rotateX: number;
  rotateY: number;
  rotation: number;
  scaleX: number;
  scaleY: number;
}): Matrix {
  const rad = Math.PI / 180;
  const [cx, sx] = [Math.cos(l.rotateX * rad), Math.sin(l.rotateX * rad)];
  const [cy, sy] = [Math.cos(l.rotateY * rad), Math.sin(l.rotateY * rad)];
  const [cz, sz] = [Math.cos(l.rotation * rad), Math.sin(l.rotation * rad)];
  const t: Matrix = [1, 0, 0, l.x, 0, 1, 0, l.y, 0, 0, 1, l.z];
  const rx: Matrix = [1, 0, 0, 0, 0, cx, -sx, 0, 0, sx, cx, 0];
  const ry: Matrix = [cy, 0, sy, 0, 0, 1, 0, 0, -sy, 0, cy, 0];
  const rz: Matrix = [cz, -sz, 0, 0, sz, cz, 0, 0, 0, 0, 1, 0];
  const sc: Matrix = [l.scaleX, 0, 0, 0, 0, l.scaleY, 0, 0, 0, 0, 1, 0];
  return multiply(multiply(multiply(multiply(t, rx), ry), rz), sc);
}
const apply3 = (m: Matrix, x: number, y: number): Point3 => [
  m[0] * x + m[1] * y + m[3],
  m[4] * x + m[5] * y + m[7],
  m[8] * x + m[9] * y + m[11],
];

type View = {
  perspective: number;
  fit: number;
  cx: number;
  cy: number;
  shake: { dx: number; dy: number; rotation: number };
};
/** Scene space → output pixels: perspective about the frame centre, the
 *  hit shake, then the design → output fit. */
function project(v: View, [x, y, z]: Point3): Point {
  const w = Math.max(0.05, 1 - z / v.perspective);
  const px = x / w,
    py = y / w;
  const r = (v.shake.rotation * Math.PI) / 180,
    c = Math.cos(r),
    s = Math.sin(r);
  const qx = c * px - s * py + v.shake.dx,
    qy = s * px + c * py + v.shake.dy;
  return [v.cx + v.fit * qx, v.cy + v.fit * qy];
}

/** Output-pixel positions of everything visible in a motion scene at `localS`:
 *  each layer's box corners (a line's points and tip), each moving text
 *  unit, and a wipe's front. */
function probes(
  scene: MotionScene,
  authored: Map<string, MotionLayer>,
  localS: number,
  view: Omit<View, "shake">,
): Map<string, Point[]> {
  const out = new Map<string, Point[]>();
  const v: View = { ...view, shake: evaluateHits(scene.hits, localS) };
  const design = scene.designSize ?? { width: 1920, height: 1080 };
  const visit = (layers: EvaluatedMotionLayer[], parent: Matrix, opacity: number) => {
    for (const l of layers) {
      const m = multiply(parent, local(l)),
        o = opacity * l.opacity;
      if (l.type === "group") {
        visit(l.children, m, o);
        continue;
      }
      if (o < 0.01) continue;
      const at = (x: number, y: number) => project(v, apply3(m, x, y));
      if (l.type === "wipe") {
        if (l.cover <= 0 && l.sweep <= 0) continue;
        const shape = wipeShape(l, l.sweep, design.width, design.height);
        out.set(
          l.id,
          shape.cover.map(([x, y]) => at(x, y)),
        );
        continue;
      }
      if (l.type === "line") {
        out.set(
          l.id,
          [...l.points, lineTip(l.points, l.end)].map(([x, y]) => at(x, y)),
        );
        continue;
      }
      if (l.type === "cursor") {
        // the arrow's box, tip at the origin
        const w = 12 * CURSOR_UNIT,
          h = 19.5 * CURSOR_UNIT;
        out.set(l.id, [at(0, 0), at(w, 0), at(w, h), at(0, h)]);
        continue;
      }
      const src = authored.get(l.id);
      // growing type grows its glyphs, not its box
      const grow =
        l.type === "text" && src?.type === "text" && src.fontSize > 0
          ? l.fontSize / src.fontSize
          : 1;
      const w = (l.width / 2) * grow,
        h = (l.height / 2) * grow;
      out.set(l.id, [at(-w, -h), at(w, -h), at(w, h), at(-w, h)]);
      if (l.type === "text" && src?.type === "text" && src.units) {
        // a unit's slot cancels between two instants; its offset, scale and
        // tip around its own centre (≈ a font-size square) are what move
        const count = motionTextUnits(src.text, src.units.by).flat().length;
        const r = l.fontSize / 2;
        for (let i = 0; i < count; i++) {
          const u = evaluateTextUnit(src.units, i, localS, l);
          if (u.opacity < 0.01) continue;
          const a = (u.rotation * Math.PI) / 180,
            c = Math.cos(a) * r * u.scale,
            s = Math.sin(a) * r * u.scale;
          out.set(`${l.id}#${i}`, [
            at(u.dx - c + s, u.dy - s - c),
            at(u.dx + c + s, u.dy + s - c),
            at(u.dx + c - s, u.dy + s + c),
            at(u.dx - c - s, u.dy - s + c),
          ]);
        }
      }
    }
  };
  visit(evaluateMotionScene(scene, localS).layers, IDENTITY, 1);
  return out;
}

/** The point `end` (0–1) of the way along a polyline. */
function lineTip(points: [number, number][], end: number): Point {
  const lengths = points
    .slice(1)
    .map((p, i) => Math.hypot(p[0] - points[i]![0], p[1] - points[i]![1]));
  let left = Math.max(0, Math.min(1, end)) * lengths.reduce((a, b) => a + b, 0);
  for (let i = 0; i < lengths.length; i++) {
    if (left <= lengths[i]! || i === lengths.length - 1) {
      const f = lengths[i]! > 0 ? Math.min(1, left / lengths[i]!) : 0;
      const [a, b] = [points[i]!, points[i + 1]!];
      return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f];
    }
    left -= lengths[i]!;
  }
  return points[0]!;
}

/** Per output frame: the farthest any visible probe travels across the
 *  shutter window around the frame, in output pixels. Scenes other than
 *  motion scenes animate inside the renderer; they get a modest constant. */
export function shutterTravelPx(comp: LaunchComposition, shutter: number): number[] {
  const fps = comp.output.fps;
  const frames = Math.ceil(launchDurationS(comp) * fps - 1e-9);
  const half = shutter / 2 / fps;
  const windows = launchSceneWindows(comp);
  const travel: number[] = new Array(frames).fill(0);
  const authored = new Map<MotionScene, Map<string, MotionLayer>>();
  for (let n = 0; n < frames; n++) {
    const t = n / fps;
    const win = windows.find((w) => t >= w.startS && t < w.endS);
    if (!win) continue;
    const scene = win.scene;
    if (scene.type !== "motion") {
      // these animate inside the renderer: entrances, exits and ui-morph states
      const local = t - win.startS,
        dur = win.endS - win.startS;
      const moving = scene.type === "ui-morph" || local < 1.3 || dur - local < 0.6;
      travel[n] = moving && scene.motion !== "off" ? 4 * SHUTTER_SPACING_PX : 0;
      continue;
    }
    if (scene.motion === "off") continue;
    let byId = authored.get(scene);
    if (!byId) {
      byId = new Map();
      const walk = (layers: MotionLayer[]) => {
        for (const l of layers) {
          byId!.set(l.id, l);
          if (l.type === "group") walk(l.children);
        }
      };
      walk(scene.layers);
      authored.set(scene, byId);
    }
    const design = scene.designSize ?? { width: 1920, height: 1080 };
    const view = {
      perspective: scene.perspective ?? DEFAULT_PERSPECTIVE,
      fit: Math.min(comp.output.width / design.width, comp.output.height / design.height),
      cx: comp.output.width / 2,
      cy: comp.output.height / 2,
    };
    const localS = t - win.startS;
    const a = probes(scene, byId, Math.max(0, localS - half), view),
      b = probes(scene, byId, localS + half, view);
    let max = 0;
    for (const [id, pa] of a) {
      const pb = b.get(id);
      if (!pb || pb.length !== pa.length) continue;
      for (let i = 0; i < pa.length; i++)
        max = Math.max(max, Math.hypot(pa[i]![0] - pb[i]![0], pa[i]![1] - pb[i]![1]));
    }
    travel[n] = max;
  }
  return travel;
}

/** Shutter samples per output frame: enough that a moving edge's samples land
 *  ≤ SHUTTER_SPACING_PX apart, at least 1 (a still frame renders once), at
 *  most `blur.samples`. */
export function shutterSchedule(comp: LaunchComposition, blur: LaunchMotionBlur): number[] {
  return shutterTravelPx(comp, blur.shutter).map((px) =>
    Math.max(1, Math.min(blur.samples, Math.ceil(px / SHUTTER_SPACING_PX))),
  );
}
