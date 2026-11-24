// The starter's 3D stage and solids (starter/lib/space.js, solid.js), the
// parts that are plain functions and need neither three nor a browser:
//   - the lens through shots: from/to along a path, eased, held between
//     shots, the focus a distance along the lens's axis, a pull between two
//     points, cuts where a shot says so or the scene changes;
//   - the shutter's sample times inside the run of picture a frame belongs
//     to, never across a cut;
//   - a distance function turned into a closed mesh whose vertices lie on its
//     surface; a turned part's rings and ribs; seeded randomness repeating.
// And, in Chrome, the stage itself: a slab's colour composited once, a
// change made before an await still uploaded, a slab placed from its home
// every time, what the render is told about motion.

import assert from "node:assert/strict";
import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { launchHtmlBrowser } from "../src/html/cdp";
import { serveDirectory } from "../src/html/server";
// @ts-expect-error — a plain ES module of the starter, typed by its JSDoc
import * as O from "../starter/lib/solid.js";
// @ts-expect-error — a plain ES module of the starter, typed by its JSDoc
import * as S from "../starter/lib/space.js";
import { findChrome } from "./fixtures/find-chrome";

type V3 = [number, number, number];
const near = (a: number, b: number, eps = 1e-6) => assert.ok(Math.abs(a - b) <= eps, `${a} ≉ ${b}`);

test("eases: named ones run 0 → 1 and the fly lands late and fast", () => {
  for (const [name, e] of Object.entries(S.eases) as [string, (u: number) => number][]) {
    near(e(0), 0, 1e-6);
    near(e(1), 1, 1e-6);
    assert.ok(e(0.5) > 0 && e(0.5) < 1, name);
  }
  // cubic-bezier(.55,0,.12,1): little done by a fifth, nearly all of it by two thirds
  assert.ok(S.eases.fly(0.2) < 0.1);
  assert.ok(S.eases.fly(0.66) > 0.9);
});

test("pathAt: through every point, ends included; two points a line", () => {
  const pts: V3[] = [[0, 0, 0], [100, 50, 0], [200, 0, -100]];
  assert.deepEqual(S.pathAt(pts, 0), [0, 0, 0]);
  const mid = S.pathAt(pts, 0.5) as V3;
  mid.forEach((v, i) => {
    near(v, pts[1]![i]!, 1e-6);
  });
  const end = S.pathAt(pts, 1) as V3;
  end.forEach((v, i) => {
    near(v, pts[2]![i]!, 1e-6);
  });
  const line = S.pathAt([[0, 0, 0], [10, 20, 30]], 0.25) as V3;
  assert.deepEqual(line, [2.5, 5, 7.5]);
  // between the points it curves: off both straight stretches
  const q = S.pathAt(pts, 0.25) as V3;
  const offLine = (p: V3, a: V3, b: V3) => {
    const d = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], v = [p[0] - a[0], p[1] - a[1], p[2] - a[2]];
    const c = [d[1]! * v[2]! - d[2]! * v[1]!, d[2]! * v[0]! - d[0]! * v[2]!, d[0]! * v[1]! - d[1]! * v[0]!];
    return Math.hypot(c[0]!, c[1]!, c[2]!) / Math.hypot(d[0]!, d[1]!, d[2]!);
  };
  assert.ok(offLine(q, pts[0]!, pts[1]!) > 1, `${q}`);
  // a little past the end (an ease that overshoots) carries on along the last stretch
  assert.deepEqual(S.pathAt([[0, 0, 0], [10, 0, 0]], 1.1), [11, 0, 0]);
});

test("rig: the shot's progress is held to 0..1 before its ease, an overshoot moves aim and position alike", () => {
  const r = S.rig([
    { start: 0, dur: 1, from: { pos: [0, 0, 1000], at: [0, 0, 0] }, to: { pos: [0, 0, 1000] } },
    { start: 1, dur: 1, to: { pos: [10, 0, 1000], at: [10, 0, 0] }, ease: (u: number) => u },
  ]);
  // after the last shot, held where it ended — a function ease too
  near(r.pose(3).pos[0], 10);
  near(r.pose(3).at[0], 10);
  const o = S.rig([
    { start: 0, dur: 1, from: { pos: [0, 0, 1000], at: [0, 0, 0] }, to: { pos: [100, 0, 1000], at: [100, 0, 0] }, ease: "back.out(1.7)" },
  ]);
  const p = o.pose(0.6);
  assert.ok(p.pos[0] > 100, `${p.pos[0]}`);
  near(p.at[0], p.pos[0], 1e-9);
  // an ease that does not exist throws when the shots are set, not mid-render
  assert.throws(() => S.rig([{ start: 0, dur: 1, to: { pos: [0, 0, 1] }, ease: "nope" }]), /no ease named/);
});

test("rig: a focus of 0 is held at 1, never dividing the lens's offset by 0", () => {
  const r = S.rig([{ start: 0, dur: 1, from: { pos: [0, 0, 600], at: [0, 0, 0] }, to: { pos: [0, 0, 600] }, focus: 0, aperture: 10 }]);
  near(r.pose(0.5).focus, 1);
  const f = S.rig([{ start: 0, dur: 1, to: { pos: [0, 0, 600] }, focus: () => 0 }]);
  near(f.pose(0.5).focus, 1);
});

test("rig: shots from/to, held between, starting where the last ended", () => {
  const r = S.rig([
    { start: 0, dur: 2, from: { pos: [0, 0, 1000], at: [0, 0, 0] }, to: { pos: [0, 0, 800] }, ease: "linear" },
    { start: 3, dur: 1, to: { pos: [100, 0, 800], at: [100, 0, 0], fov: 40 }, ease: "linear" },
  ]);
  near(r.pose(1).pos[2], 900);
  near(r.pose(2.5).pos[2], 800); // held after the first shot until the next starts
  near(r.pose(3).pos[0], 0); // the second starts where the first ended
  near(r.pose(3.5).pos[0], 50);
  near(r.pose(3.5).fov, 35);
  near(r.pose(9).pos[0], 100);
  assert.equal(r.pose(-1).shot, 0);
  // same t, same lens
  assert.deepEqual(r.pose(1.234), r.pose(1.234));
});

test("rig: focus along the lens's axis, a point, a pull, and aperture as a function", () => {
  const r = S.rig([
    { start: 0, dur: 1, from: { pos: [0, 0, 1000], at: [0, 0, 0] }, to: { pos: [0, 0, 1000] },
      focus: [300, 0, -200], aperture: (t: number) => 10 + t * 10 },
    { start: 1, dur: 1, to: { pos: [0, 0, 1000] },
      focus: { from: [0, 0, 0], to: [0, 0, -500], start: 1, dur: 1, ease: "linear" } },
  ]);
  near(r.pose(0.5).focus, 1200); // a point off-axis: its depth along the axis
  near(r.pose(0.5).aperture, 15);
  near(r.pose(1).focus, 1000);
  near(r.pose(1.5).focus, 1250);
  near(r.pose(2).focus, 1500);
  // no focus given: the point looked at
  const plain = S.rig([{ start: 0, dur: 1, from: { pos: [0, 0, 600], at: [0, 0, 0] }, to: { pos: [0, 0, 600] } }]);
  near(plain.pose(0.5).focus, 600);
});

test("cutsOf: a shot marked cut, or one in another scene, starts on a cut", () => {
  const shots = [
    { start: 0, dur: 2, to: { pos: [0, 0, 1] } },
    { start: 2, dur: 2, to: { pos: [0, 0, 2] } },
    { start: 4, dur: 2, to: { pos: [0, 0, 3] }, cut: true },
    { start: 7, dur: 3, to: { pos: [0, 0, 4] }, scene: "object" },
  ];
  assert.deepEqual(S.cutsOf(shots), [4, 7]);
  assert.deepEqual(S.rig(shots).cuts, [4, 7]);
});

test("rig: a stations shot leaves quickly, slows for long, and is still moving when the next leg leaves", () => {
  const a = { pos: [0, 0, 1000] as V3, at: [0, 0, 0] as V3 };
  const r = S.rig([
    { start: 0, dur: 1, from: a, to: a },
    { start: 1, stations: [{ t: 1, to: { pos: [400, 0, 1000], at: [400, 0, 0] } }, { t: 2, to: { pos: [400, 300, 600], at: [400, 300, 0] } }] },
    { start: 4, dur: 1, to: { fov: 40 }, ease: "linear" },
  ]);
  const x = (t: number) => r.pose(t).pos[0] as number;
  near(x(1), 0);
  // half of the way inside 0.25 s, though the leg is not done a second later
  const half = [1.05, 1.1, 1.15, 1.2, 1.25, 1.3].find((t) => x(t) > 200)!;
  assert.ok(half <= 1.25, `half way by ${half}`);
  assert.ok(x(2) < 400 && x(2) > 396, `still short of its station when the next leaves: ${x(2)}`);
  assert.ok(x(2) - x(2 - 1 / 60) > 0, "and still moving");
  // the lens's aim rides with it: a station is a place and what is looked at
  near(r.pose(1.2).at[0], x(1.2), 1e-9);
  // the same numbers lib/moves.js gives a 2D camera
  // (accel 5.5/24 s, ×0.73 every 1/24 s)
  assert.ok(Math.abs(x(1 + 5.5 / 24) / 400 - 0.4) < 0.15, `${x(1 + 5.5 / 24)}`);
  // the second leg adds on top of what is left of the first
  assert.ok(r.pose(3.9).pos[1] > 299 && r.pose(3.9).pos[2] < 601);
  // the shot after starts from where the lens was then, without a jolt
  const before = r.pose(4 - 1e-6), after = r.pose(4);
  near(before.pos[1], after.pos[1], 1e-3);
  near(before.pos[2], after.pos[2], 1e-3);
  assert.throws(() => S.rig([{ start: 0, stations: [] }]), /at least one/);
  assert.throws(() => S.rig([{ start: 0, dur: 1 }]), /needs `to`/);
});

test("rig: a momentum cut — out faster every frame, the cut between two frames, the next shot slowing into place", () => {
  const shots = [
    { start: 0, dur: 2, from: { pos: [0, 0, 1000] as V3, at: [0, 0, 0] as V3, fov: 30 }, to: { pos: [0, 0, 1000] as V3 } },
    { start: 2, dur: 2, momentum: "up", from: { pos: [0, 5000, 1000] as V3, at: [0, 5000, 0] as V3 }, to: { pos: [0, 5000, 1000] as V3 } },
  ];
  const r = S.rig(shots, { fps: 60, height: 1080 });
  const y = (t: number) => r.pose(t).pos[1] as number;
  // a frame px at the depth looked at, in the space's units
  const px = (2 * 1000 * Math.tan((30 * Math.PI) / 360)) / 1080;
  near(y(1), 0);
  // the picture runs off upward: the lens goes down, 128 px by the last frame before the cut
  const steps = [5, 4, 3, 2, 1].map((k) => y(2 - k / 60));
  near(steps[4]!, -128 * px, 1e-6);
  for (let i = 2; i < steps.length; i++)
    assert.ok(steps[i - 1]! - steps[i]! > steps[i - 2]! - steps[i - 1]!, "each step out larger than the last");
  // the cut is half a frame before the frame at 2: no shutter crosses it
  assert.equal(r.pose(2 - 0.4 / 60).shot, 1);
  assert.equal(r.pose(2 - 0.6 / 60).shot, 0);
  assert.deepEqual(r.marks(), [{ t: 2, edge: 2 - 0.5 / 60, kind: "cut" }]);
  assert.deepEqual(r.cuts, [2 - 0.5 / 60]);
  assert.deepEqual(S.cutsOf(shots), [2]);
  // the next shot starts 86 px short of its place, the same way on, and lands
  near(y(2), 5000 + 86 * px, 1e-6);
  assert.ok(y(2 + 1 / 60) < y(2) && y(2 + 1 / 60) > 5000);
  near(y(2 + 8 / 30), 5000, 1e-6);
  near(r.pose(2).at[1], y(2), 1e-9);
  // a cut that is not on a frame is moved to the nearest one, at the rate the film is drawn
  const off = S.rig([shots[0], { ...shots[1], start: 2.004 }], { fps: 30 });
  assert.equal(off.marks()[0].t, 2);
  // a direction in the space is the way the lens goes; `out` and `in` in frame px
  const side = S.rig([shots[0], { ...shots[1], momentum: { dir: [1, 0, 0], out: 200, in: 100 } }], { fps: 60 });
  near(side.pose(2 - 1 / 60).pos[0], 200 * px, 1e-6);
  near(side.pose(2).pos[0], -100 * px, 1e-6);
});

test("rig: a jump shot — a push that speeds up, jumps in one frame and settles, the distance in log space", () => {
  const r = S.rig([
    { start: 0, dur: 1, from: { pos: [0, 0, 2000] as V3, at: [0, 0, 0] as V3 }, to: { pos: [0, 0, 2000] as V3 } },
    { jump: 3, to: { pos: [0, 0, 1000] as V3 } },
  ], { fps: 60 });
  const z = (t: number) => r.pose(t).pos[2] as number;
  assert.equal(r.shots[1].start, 3 - 14 / 24);
  near(z(3 - 14 / 24), 2000, 1e-6);
  // slow to leave: after half of the way in, under a tenth of the push
  assert.ok(z(3 - 7 / 24) > 1960, `${z(3 - 7 / 24)}`);
  // one frame takes more of the push than all the frames before it
  const before = z(3 - 1 / 60), after = z(3);
  assert.ok(Math.log(before / after) > 0.4 * Math.log(2), `${before} → ${after}`);
  assert.ok(Math.log(2000 / before) < Math.log(before / after));
  // then it settles on where it was going
  assert.ok(z(3 + 1 / 24) < after && z(3 + 1 / 24) > 1000);
  near(z(3 + 6 / 24), 1000, 1e-6);
  near(z(9), 1000, 1e-6);
  // the jump is a cut hidden in the move, between two frames
  assert.deepEqual(r.marks(), [{ t: 3, edge: 3 - 0.5 / 60, kind: "hidden-cut" }]);
});

test("shutterTimes: spread over the shutter, held inside the frame's run", () => {
  const ts = S.shutterTimes(1, 8, 1 / 120) as number[];
  assert.equal(ts.length, 8);
  assert.equal(new Set(ts).size, 8);
  for (const x of ts) assert.ok(Math.abs(x - 1) <= 1 / 240 + 1e-9);
  near(ts.reduce((a, b) => a + b, 0) / 8, 1, 1e-9); // centred on t
  // a frame just after a cut at 7: nothing before 7
  const [lo, hi] = S.runOf(7.001, [7]);
  assert.deepEqual([lo, hi], [7, Infinity]);
  for (const x of S.shutterTimes(7.001, 16, 1 / 60, lo, hi) as number[]) assert.ok(x >= 7);
  // just before it: nothing at or after 7
  const [lo2, hi2] = S.runOf(6.999, [7]);
  for (const x of S.shutterTimes(6.999, 16, 1 / 60, lo2, hi2) as number[]) assert.ok(x < 7);
  // every count of samples takes every slot of the shutter once — 7, 14, 28 too
  for (const n of [1, 2, 7, 8, 14, 21, 28, 32, 49, 64]) {
    const ts = S.shutterTimes(0, n, 1) as number[];
    assert.equal(new Set(ts.map((x) => x.toFixed(9))).size, n, `n=${n}`);
  }
});

test("sampleGap and prefilterLevel: copies a few px apart are blurred together, close ones left sharp", () => {
  near(S.sampleGap(0, 0, 32), 0);
  near(S.sampleGap(10, 0, 1), 0); // one sample: nothing to fill
  near(S.sampleGap(0, 64, 32), 2); // a smear: its length over the samples
  near(S.sampleGap(40, 0, 32), 40 * Math.sqrt(Math.PI / 32), 1e-9); // a disk: its area over the samples
  assert.ok(S.sampleGap(40, 64, 32) > S.sampleGap(40, 0, 32));
  near(S.prefilterLevel(0.6, 4), 0); // under a px apart: the full level
  near(S.prefilterLevel(8, 2), 4); // 16 texels: level 4
  near(S.prefilterLevel(4, 0.2), 0); // magnified: still finer than a texel
});

test("handheld: repeatable, small, and two seeds differ", () => {
  const a = S.handheld(0.12, 1, 1), b = S.handheld(0.12, 1, 2);
  assert.deepEqual(a(3.3), a(3.3));
  assert.notDeepEqual(a(3.3), b(3.3));
  for (let t = 0; t < 10; t += 0.37) {
    const h = a(t);
    assert.ok(Math.abs(h.yaw) <= 0.12 + 1e-9 && Math.abs(h.pitch) <= 0.12 + 1e-9 && Math.abs(h.roll) <= 0.06 + 1e-9);
  }
});

test("riseIn and float: offsets as functions of t", () => {
  const r = S.riseIn(3);
  assert.deepEqual(r(2), { y: -40, z: -260, opacity: 0 });
  assert.deepEqual(r(4), { y: -0, z: -0, opacity: 1 });
  // no length: in place at t0, never NaN
  assert.deepEqual(S.riseIn(1, { dur: 0 })(1), { y: -0, z: -0, opacity: 1 });
  assert.deepEqual(S.riseIn(1, { dur: 0 })(0.9), { y: -40, z: -260, opacity: 0 });
  const d = S.float(10, 5, 1);
  const xs = Array.from({ length: 40 }, (_, i) => d(i * 0.25));
  for (const p of xs) assert.ok(Math.abs(p.x) <= 10 && Math.abs(p.y) <= 5);
  // it floats: both axes reach most of their reach
  assert.ok(Math.max(...xs.map((p) => Math.abs(p.x))) > 8 && Math.max(...xs.map((p) => Math.abs(p.y))) > 4);
});

test("halton: base 2 and 3", () => {
  assert.deepEqual([1, 2, 3, 4].map((i) => S.halton(i, 2)), [0.5, 0.25, 0.75, 0.125]);
  near(S.halton(1, 3), 1 / 3);
  near(S.halton(2, 3), 2 / 3);
});

test("sd: signs and distances of the pieces", () => {
  near(O.sd.sphere(0, 0, 0, 5), -5);
  near(O.sd.sphere(8, 0, 0, 5), 3);
  near(O.sd.box(3, 0, 0, 1, 1, 1), 2);
  near(O.sd.roundBox(0, 0, 0, 2, 1, 1, 0.2), -1);
  near(O.sd.cylY(4, 0, 0, 2, 1), 2);
  near(O.sd.cylY(0, 3, 0, 2, 1), 2);
  near(O.sd.torus(5, 0, 0, 4, 0.5), 0.5);
  near(O.sd.capsule(0, 2, 0, -1, 0, 0, 1, 0, 0, 0.5), 1.5);
  // the degenerate ones: a capsule of one point is a sphere; no blend is the plain min/max
  near(O.sd.capsule(0, 3, 0, 1, 1, 1, 1, 1, 1, 0.5), Math.hypot(1, 2, 1) - 0.5);
  near(O.sd.smin(1, 2, 0), 1);
  near(O.sd.smax(1, 2, 0), 2);
  // smooth union no more than the min, smooth max no less than the max
  assert.ok(O.sd.smin(1, 1.2, 0.5) < 1);
  assert.ok(O.sd.smax(1, 1.2, 0.5) > 1.2);
  near(O.sd.smin(0, 5, 0.5), 0); // far apart: the plain min
  near(O.sd.repeat(0.27, 0.1), -0.03, 1e-9);
});

test("sdfMesh: a sphere comes out closed, on its surface, normals outward", () => {
  const R = 10;
  const m = O.sdfMesh((x: number, y: number, z: number) => O.sd.sphere(x, y, z, R), [-R, -R, -R, R, R, R], 1);
  const nv = m.position.length / 3;
  assert.ok(nv > 500, `${nv} vertices`);
  assert.ok(m.triangles > nv); // a closed surface: about two triangles a vertex
  let worst = 0, notOut = 0;
  for (let i = 0; i < nv; i++) {
    const x = m.position[i * 3]!, y = m.position[i * 3 + 1]!, z = m.position[i * 3 + 2]!;
    const r = Math.hypot(x, y, z);
    worst = Math.max(worst, Math.abs(r - R));
    // unit normals along the radius, outward
    const nx = m.normal[i * 3]!, ny = m.normal[i * 3 + 1]!, nz = m.normal[i * 3 + 2]!;
    if (Math.abs(Math.hypot(nx, ny, nz) - 1) > 1e-3 || (x * nx + y * ny + z * nz) / r < 0.95) notOut++;
  }
  assert.ok(worst < 0.35, `off the surface by up to ${worst}`);
  assert.equal(notOut, 0);
  // triangles wound counter-clockwise seen from outside (three's front face)
  let wrongWay = 0;
  for (let i = 0; i < m.index.length; i += 3) {
    const p = [0, 1, 2].map((k) => [0, 1, 2].map((c) => m.position[m.index[i + k]! * 3 + c]!)) as V3[];
    const [a, b, c] = p as [V3, V3, V3];
    const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    const n = [u[1]! * v[2]! - u[2]! * v[1]!, u[2]! * v[0]! - u[0]! * v[2]!, u[0]! * v[1]! - u[1]! * v[0]!];
    if (n[0]! * (a[0] + b[0] + c[0]) + n[1]! * (a[1] + b[1] + c[1]) + n[2]! * (a[2] + b[2] + c[2]) <= 0) wrongWay++;
  }
  assert.equal(wrongWay, 0);
  // every edge shared by exactly two triangles: watertight
  const edges = new Map<string, number>();
  for (let i = 0; i < m.index.length; i += 3) {
    const t = [m.index[i]!, m.index[i + 1]!, m.index[i + 2]!];
    for (let k = 0; k < 3; k++) {
      const a = t[k]!, b = t[(k + 1) % 3]!;
      const key = a < b ? `${a},${b}` : `${b},${a}`;
      edges.set(key, (edges.get(key) ?? 0) + 1);
    }
  }
  assert.ok([...edges.values()].every((n) => n === 2));
});

test("sdfMesh: a pocket cut by smax lowers the top inside it only", () => {
  const f = (x: number, y: number, z: number) =>
    O.sd.smax(O.sd.box(x, y, z, 20, 4, 20), -O.sd.box(x, y - 4, z, 10, 2, 10), 0.5);
  const m = O.sdfMesh(f, [-21, -5, -21, 21, 5, 21], 0.5);
  let topIn = -Infinity, topOut = -Infinity;
  for (let i = 0; i < m.position.length; i += 3) {
    const x = m.position[i]!, y = m.position[i + 1]!, z = m.position[i + 2]!;
    if (Math.abs(x) < 6 && Math.abs(z) < 6) topIn = Math.max(topIn, y);
    if (Math.abs(x) > 14 && Math.abs(x) < 18 && Math.abs(z) < 6) topOut = Math.max(topOut, y);
  }
  near(topOut, 4, 0.3);
  near(topIn, 2, 0.3);
});

test("latheMesh: rings round y at the profile's radii; ribs only where asked", () => {
  const m = O.latheMesh([[0, 0], [10, 0, 0], [10, 2, 1], [0, 2]], { seg: 64, ribs: 32, ribAmp: 0.1 });
  const cols = 65;
  assert.equal(m.position.length, 4 * cols * 3);
  assert.equal(m.index.length, 3 * 64 * 6);
  const r = (ring: number, s: number) => Math.hypot(m.position[(ring * cols + s) * 3]!, m.position[(ring * cols + s) * 3 + 2]!);
  for (let s = 0; s < 64; s++) near(r(1, s), 10, 1e-4); // no ribs on ring 1
  const ribbed = Array.from({ length: 64 }, (_, s) => r(2, s));
  near(Math.max(...ribbed), 11, 1e-3);
  near(Math.min(...ribbed), 9, 1e-3);
  near(m.position[(2 * cols) * 3 + 1]!, 2);
  // no ribs asked: a ring marked for ribs keeps its radius
  const plain = O.latheMesh([[10, 0, 1], [10, 1, 1]], { seg: 8, ribs: 0, ribAmp: 0.1 });
  for (let s = 0; s < 9; s++) near(Math.hypot(plain.position[s * 3]!, plain.position[s * 3 + 2]!), 10, 1e-4);
});

test("rng, vnoise, fbm: seeded, repeatable, in range", () => {
  const a = O.rng(5), b = O.rng(5);
  const xs = Array.from({ length: 5 }, () => a());
  assert.deepEqual(xs, Array.from({ length: 5 }, () => b()));
  for (const x of xs) assert.ok(x >= 0 && x < 1);
  for (let i = 0; i < 50; i++) {
    const v = O.vnoise(i * 0.37, i * 0.11, 2.5), f = O.fbm(i * 0.37, 1.1, i * 0.05);
    assert.ok(v >= 0 && v <= 1);
    assert.ok(f >= -0.01 && f <= 1.01);
  }
  assert.equal(O.vnoise(1.5, 2.5, 3.5), O.vnoise(1.5, 2.5, 3.5));
  // noise, not a constant: it spreads over most of its range, and varies smoothly
  const vs = Array.from({ length: 400 }, (_, i) => O.vnoise(i * 0.53, i * 0.29, 0.7));
  assert.ok(Math.max(...vs) - Math.min(...vs) > 0.6);
  assert.ok(Math.abs(O.vnoise(2.3, 1.1, 0.4) - O.vnoise(2.3001, 1.1, 0.4)) < 1e-3);
  const fs = Array.from({ length: 400 }, (_, i) => O.fbm(i * 0.53, 1.1, i * 0.05));
  assert.ok(Math.max(...fs) - Math.min(...fs) > 0.3);
});

const chrome = findChrome();

test("space in Chrome: alpha once, late changes uploaded, home every sample, motion told", {
  skip: chrome ? false : "no Chrome for Testing",
}, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "open-take-space-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const lib = join(dirname(fileURLToPath(import.meta.url)), "../starter/lib");
  const three = dirname(createRequire(import.meta.url).resolve("three"));
  await mkdir(join(dir, "lib"));
  for (const f of ["space.js", "anim.js", "moves.js", "solid.js"]) await copyFile(join(lib, f), join(dir, "lib", f));
  for (const f of ["three.module.min.js", "three.core.min.js"]) await copyFile(join(three, f), join(dir, f));
  // 64×64 slabs filling the frame: a white card, half-white glass riding on it
  await writeFile(join(dir, "index.html"), `<!doctype html>
<style>body{margin:0;background:#000}</style>
<canvas id="gl" width="64" height="64" style="width:64px;height:64px"><div id="card" style="width:64px;height:64px;background:#fff"></div>
<div id="glass" style="width:64px;height:64px;background:rgba(255,255,255,.5)"></div><div id="far"></div></canvas>
<script type="module">
import * as THREE from "./three.module.min.js";
import { space, riseIn } from "./lib/space.js";
import { solid } from "./lib/solid.js";
const st = space({ three: THREE, canvas: document.querySelector("#gl"), width: 64, height: 64, samples: 8, shutter: 0, hic: false });
const card = st.slab(document.querySelector("#card"), { size: [64, 64], scale: 1, shadow: false, move: (t) => (t < 1 ? { scale: 2 } : {}) });
st.slab(document.querySelector("#glass"), { parent: card, size: [64, 64], scale: 1, shadow: false, pos: [0, 0, 1] });
const far = st.slab(document.querySelector("#far"), { size: [64, 64], scale: 4, shadow: false, pos: [0, 0, -2000], move: riseIn(5, { dur: 0.2 }) });
st.shots([{ start: 0, dur: 10, from: { pos: [0, 0, 100], at: [0, 0, 0], fov: 60 }, to: { pos: [0, 0, 100] }, focus: 100, aperture: 0 }]);
const gl = st.renderer.getContext();
const centre = () => { const px = new Uint8Array(4); gl.readPixels(32, 32, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px); return px[0]; };
window.run = async () => {
  const out = {};
  await st.draw(2);
  out.glassOverWhite = centre();
  out.fov = st.camera.fov;
  document.querySelector("#card").style.background = "#000";
  await new Promise((r) => setTimeout(r, 0)); // the observer has delivered its records by now
  await st.draw(2);
  out.glassOverBlack = centre();
  await st.draw(0.5);
  await st.draw(2);
  out.scaleAfter = card.group.scale.x;
  const film = st.film({ duration: 10 });
  // a slab fading in while the lens moves: still measured, its points matched
  st.shots([{ start: 0, dur: 10, from: { pos: [-500, 0, 100], at: [-500, 0, 0], fov: 60 }, to: { pos: [500, 0, 100], at: [500, 0, 0] }, ease: "linear", focus: 100, aperture: 0 },
    { start: 5.2, dur: 1, to: { pos: [0, 0, 100] }, cut: true }]);
  // with no shutter of its own the stage asks the render to blur its travel — measured
  // where the card is in the frame (the lens passes over it at 5 s): a point counts only
  // while it is shown
  out.motionNoShutter = film.motion(4.9, 0.01);
  out.travelThen = st.travel(4.9, 0.01);
  out.travelOverNothing = st.travel(2.5, 0.01);
  // a draw the render says stands for part of the shutter still draws
  window.__filmShare = 0.25; await st.draw(2.5); delete window.__filmShare;
  out.travelFading = st.travel(5.05, 0.05);
  out.travelAtCut = st.travel(5.19, 0.02);
  // far behind the plane in focus with a wide lens: read from a blurred level
  st.shots([{ start: 0, dur: 10, from: { pos: [0, 0, 100], at: [0, 0, 0], fov: 60 }, to: { pos: [0, 0, 100] }, focus: 100, aperture: 40 }]);
  await st.draw(6);
  gl.bindTexture(gl.TEXTURE_2D, far.slab.glTex);
  out.farMinLod = gl.getTexParameter(gl.TEXTURE_2D, gl.TEXTURE_MIN_LOD);
  out.cardMinLod = (gl.bindTexture(gl.TEXTURE_2D, card.slab.glTex), gl.getTexParameter(gl.TEXTURE_2D, gl.TEXTURE_MIN_LOD));
  st.scene("object");
  const on = st.slab(document.querySelector("#far"), { scene: "object", size: [8, 8] });
  out.childScene = st.slab(document.querySelector("#far"), { parent: on, size: [8, 8] }).slab.scene;

  // a laptop on a desk in a scene of its own, its screen a slab on the lid
  const S = solid(THREE);
  const room = st.scene("room", { clear: (t) => (t < 1 ? 0xff0000 : new THREE.Color(0, 0, 1)) });
  const desk = room.add(S.desk({ look: (t) => ({ sun: t < 1 ? 1 : 3 }) }));
  const lap = S.laptop({ screen: [64, 40], bezel: 4, base: 3, lid: 2, radius: 3, open: (t) => (t < 1 ? 90 : 0) });
  // the slab is given its parent before the laptop is in any scene
  const scr = st.slab(document.querySelector("#card"), { parent: lap.screen, size: [64, 40], scale: 1, shadow: false });
  out.sceneBefore = scr.slab.scene;
  room.add(lap);
  out.sceneAfter = scr.slab.scene;
  let ticks = 0;
  room.animate(() => { ticks++; });
  const shot = (s) => ({ start: 0, dur: 10, scene: "room", from: s, to: s, focus: 100, aperture: 0 });
  st.shots([shot({ pos: [0, 400, 400], at: [0, 20, 0], fov: 30 })]);
  // before any draw of this scene: a point of the screen in the space, the lid upright at 0.5 s…
  out.topMid = scr.point(32, 0, 0.5);
  out.botMid = scr.point(32, 40, 0.5);
  // …and shut at 2 s, the same point lying over the keys
  out.topShut = scr.point(32, 0, 2);
  out.lidAt = [lap.open, (scr.point(0, 0, 0.5), lap.open)];
  // a lens square on to a part of it, that part 0.5 of the frame's width
  const sq = scr.station({ x: 16, y: 10, w: 32, h: 20 }, { share: 0.5, t: 0.5 });
  st.shots([shot(sq)]);
  out.partLeft = scr.toFrame(16, 20, 0.5);
  out.partRight = scr.toFrame(48, 20, 0.5);
  out.partMid = st.toFrame(scr.point(32, 20, 0.5), 0.5);
  // the ground's colour is the scene's at each time, and the desk's fog and light follow
  st.shots([shot({ pos: [0, 5000, 10], at: [0, 20000, 0], fov: 30 })]); // looking away, at nothing
  const corner = () => { const px = new Uint8Array(4); gl.readPixels(2, 2, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px); return [px[0], px[1], px[2]]; };
  ticks = 0;
  await st.draw(0.5); out.clearEarly = corner(); out.fogEarly = desk.fog.color.getHex(); out.sunEarly = desk.sun.intensity;
  out.ticksADraw = ticks;
  await st.draw(2); out.clearLate = corner(); out.fogLate = desk.fog.color.getHex(); out.sunLate = desk.sun.intensity;
  out.isFog = room.three.fog === desk.fog;
  out.clearAt = room.clearAt(2).getHex();
  return out;
};
window.ready = true;
</script>`);
  const server = await serveDirectory(dir);
  t.after(() => server.close());
  const browser = await launchHtmlBrowser({ chromePath: chrome!, url: `${server.url}/index.html`, width: 400, height: 200 });
  t.after(() => browser.close());
  await browser.evaluate("new Promise((r) => { const w = () => (window.ready ? r(0) : setTimeout(w, 20)); w(); })");
  const r = await browser.evaluate<Record<string, number | string>>("window.run()");
  // half-white glass over white stays white (alpha multiplied in twice made it 202);
  // over black it is half the light, 188 in sRGB
  assert.ok(Number(r.glassOverWhite) >= 250, JSON.stringify(r));
  assert.ok(Math.abs(Number(r.glassOverBlack) - 188) <= 4, JSON.stringify(r));
  assert.equal(r.fov, 60);
  assert.equal(r.scaleAfter, 1);
  assert.ok(Number(r.travelThen) > 1, JSON.stringify(r));
  assert.equal(r.motionNoShutter, r.travelThen);
  assert.equal(r.travelOverNothing, 0);
  assert.ok(Number(r.travelFading) > 1, JSON.stringify(r));
  assert.ok(Number(r.travelAtCut) > 1, JSON.stringify(r));
  assert.ok(Number(r.farMinLod) > 0, JSON.stringify(r));
  assert.equal(r.cardMinLod, 0);
  assert.equal(r.childScene, "object");
  const o = r as unknown as Record<string, number[]> & Record<string, unknown>;
  // a slab on a three object is in whichever scene that object is put in
  assert.equal(o.sceneBefore, "main");
  assert.equal(o.sceneAfter, "room");
  // lid upright (90°), hinge at the back (z −24) on a 3 + 1 high base with a 3 gap: the
  // screen stands 4 in from the lid's edge, its top 44 up the lid, facing the front
  const [topMid, botMid, topShut] = [o.topMid!, o.botMid!, o.topShut!];
  near(topMid[0]!, 0, 1e-6); near(topMid[1]!, 7 + 44, 1e-6); near(topMid[2]!, -24 + 1.6, 1e-6);
  near(botMid[1]!, 7 + 4, 1e-6);
  // shut, the same point lies toward the front, just under the lid
  near(topShut[1]!, 7 - 1.6, 1e-6); near(topShut[2]!, -24 + 44, 1e-6);
  assert.deepEqual(o.lidAt, [0, 90], "asking for a point sets the scene as it is at that time");
  // station: square on, the part's middle in the frame's, the part half the frame wide
  near(o.partMid![0]!, 32, 1e-3); near(o.partMid![1]!, 32, 1e-3);
  near(o.partRight![0]! - o.partLeft![0]!, 32, 1e-3);
  near(o.partLeft![1]!, 32, 1e-3);
  assert.deepEqual(o.clearEarly, [255, 0, 0]);
  assert.deepEqual(o.clearLate, [0, 0, 255]);
  assert.equal(o.fogEarly, 0xff0000);
  assert.equal(o.fogLate, 0x0000ff);
  assert.equal(o.sunEarly, 1);
  assert.equal(o.sunLate, 3);
  assert.equal(o.isFog, true);
  assert.equal(o.clearAt, 0x0000ff);
  // an object's tick runs at every sample's time (8 a frame here), not once a frame
  assert.ok(Number(o.ticksADraw) >= 8, JSON.stringify(o.ticksADraw));
});
