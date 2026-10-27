// The film kit's marks and light (kit/draw.js), places (kit/map.js) and the
// figures that land (scramble, odometer, flap in kit/motion.js): each block
// against what its comment promises — where it starts, where it lands, and
// that a frame renders the same twice.

import assert from "node:assert/strict";
import { test } from "node:test";
import { flash, leader, lightSweep, scribble, spotlight, stroke, sweep } from "../kit/draw.js";
import { along, fit, pathOf, switchOn } from "../kit/map.js";
import { flap, odometer, scramble } from "../kit/motion.js";

const near = (a: number, b: number, tol: number, what: string) =>
  assert.ok(Math.abs(a - b) <= tol, `${what}: ${a} vs ${b} (±${tol})`);

const box = { x: 400, y: 300, width: 200, height: 60 };

test("scribble: every kind is a path, the same for the same seed, another for another", () => {
  for (const kind of ["circle", "underline", "box", "strike", "arrow"] as const) {
    const d = scribble(box, { kind });
    assert.match(d, /^M[\d.-]+ [\d.-]+ L/, kind);
    assert.equal(d, scribble(box, { kind }), `${kind} is seeded`);
    assert.notEqual(d, scribble(box, { kind, seed: 2 }), `${kind} changes with the seed`);
  }
  assert.throws(() => scribble(box, { kind: "zigzag" as never }), /no kind "zigzag"/);
});

test("scribble circle: goes round the box, outside it, and past its start", () => {
  const nums = scribble(box, { kind: "circle", wobble: 0 })
    .replace(/[ML]/g, " ")
    .trim()
    .split(/\s+/)
    .map(Number);
  const pts = [];
  for (let i = 0; i < nums.length; i += 2) pts.push({ x: nums[i]!, y: nums[i + 1]! });
  const xs = pts.map((p) => p.x);
  const ys = pts.map((p) => p.y);
  assert.ok(Math.min(...xs) < box.x && Math.max(...xs) > box.x + box.width, "wider than the box");
  assert.ok(Math.min(...ys) < box.y && Math.max(...ys) > box.y + box.height, "taller than the box");
  // 1.1 turns: the last point is past the first, round the ellipse
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  const a = (p: { x: number; y: number }) => Math.atan2(p.y - cy, p.x - cx);
  const turn = a(pts.at(-1)!) - a(pts[0]!);
  near(((turn % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI), 0.1 * 2 * Math.PI, 0.25, "overlap");
});

test("stroke: draws on, holds, draws off from its start", () => {
  assert.equal(stroke(0.9, 1).dashoffset, 1);
  assert.equal(stroke(0.9, 1).visible, false);
  near(stroke(1.2, 1).dashoffset, 0.5, 1e-9, "halfway on");
  assert.equal(stroke(1.4, 1).dashoffset, 0);
  assert.equal(stroke(2, 1, { off: 3 }).dashoffset, 0, "held");
  near(stroke(3.15, 1, { off: 3 }).dashoffset, -0.5, 1e-9, "halfway off");
  assert.equal(stroke(3.3, 1, { off: 3 }).visible, false);
  near(stroke(3.15, 1, { off: 3 }).p, 1.5, 1e-9, "p past 1 while it draws off");
});

test("leader: a diagonal then level, its text past the end on its side", () => {
  const l = leader({ x: 100, y: 200 }, { x: 300, y: 120 });
  assert.equal(l.d, "M100 200 L170 120 L300 120");
  assert.deepEqual(l.text, { x: 312, y: 120 });
  assert.equal(l.side, "right");
  assert.equal(leader({ x: 300, y: 200 }, { x: 100, y: 120 }).side, "left");
});

test("spotlight: comes on, holds, goes off; clear at the part, dark outside", () => {
  assert.equal(spotlight(0.9, 1, box).k, 0);
  assert.equal(spotlight(1.3, 1, box).k, 1);
  assert.equal(spotlight(1.2, 1, box, { release: 1.25, out: 0.5 }).k > 0, true);
  assert.equal(spotlight(2, 1, box, { release: 1.25, out: 0.5 }).k, 0);
  const bg = spotlight(5, 1, box).background;
  assert.match(bg, /at 500px 330px/);
  assert.match(bg, /rgba\(0,0,0,0\) 60%, rgba\(0,0,0,0\.55\) 100%/);
});

test("sweep: the after layer uncovered behind the line, every direction", () => {
  const f = { width: 1920, height: 1080 };
  assert.equal(sweep(0, 0, 1, f).clip, "inset(0 100.000% 0 0)");
  assert.equal(sweep(1, 0, 1, f).clip, "inset(0 0.000% 0 0)");
  assert.equal(sweep(0.5, 0, 1, f).at, 960);
  assert.equal(sweep(0.5, 0, 1, f, { dir: "left" }).at, 960);
  assert.equal(sweep(0.5, 0, 1, f, { dir: "down" }).at, 540);
  assert.equal(sweep(0.5, 0, 1, f).moving, true);
  assert.equal(sweep(1, 0, 1, f, { dir: "up" }).clip, "inset(0.000% 0 0 0)");
});

test("lightSweep: nothing lit before, all lit after", () => {
  const f = { width: 1600, height: 1000 };
  const front = (m: string) => Number(m.match(/transparent ([\d.-]+)px/)![1]);
  const lit = (m: string) => Number(m.match(/#000 ([\d.-]+)px/)![1]);
  assert.ok(front(lightSweep(0, 0, 1, f).mask) <= 0, "the front starts before the frame");
  const L =
    Math.abs(1600 * Math.sin((115 * Math.PI) / 180)) +
    Math.abs(1000 * Math.cos((115 * Math.PI) / 180));
  assert.ok(lit(lightSweep(1, 0, 1, f).mask) >= L - 0.01, "fully lit past the far corner");
  assert.equal(lightSweep(1, 0, 1, f, { glint: 0 }).glint, "none");
});

test("flash: up in the attack, peak on the beat, gone after the decay", () => {
  assert.equal(flash(0.9, 1).opacity, 0);
  near(flash(0.98, 1).opacity, 0.275, 1e-3, "half the attack");
  assert.equal(flash(1, 1).opacity, 0.55);
  assert.ok(flash(1.15, 1).opacity < 0.55 && flash(1.15, 1).opacity > 0);
  assert.equal(flash(1.31, 1).opacity, 0);
});

test("scramble: nothing before, glyphs while it runs, the line after; the same twice", () => {
  assert.equal(scramble(0.9, 1, "NT$990").text, "");
  const mid = scramble(1.27, 1, "NT$990");
  assert.equal(mid.text.length, 6);
  assert.equal(mid.locked, 2);
  assert.equal(mid.text.slice(0, 2), "NT");
  assert.equal(mid.text, scramble(1.27, 1, "NT$990").text, "seeded");
  const end = scramble(1.6, 1, "NT$990");
  assert.equal(end.text, "NT$990");
  assert.equal(end.done, true);
  assert.equal(scramble(1.21, 1, "a b").text[1], " ", "spaces stay");
  assert.equal(scramble(1.21, 1, "NT$990", { from: "right" }).text.at(-1), "0");
});

test("odometer: lands on the value in its format, columns in order, rolling at speed", () => {
  const end = odometer(2, 0, "1,240", { from: "980" });
  assert.equal(end.text, "1,240");
  assert.equal(end.done, true);
  assert.deepEqual(
    end.columns.map((c) => c.digit),
    [true, false, true, true, true],
  );
  // the first column has landed while the last has not started
  const mid = odometer(0.6, 0, "1,240", { from: "980" });
  assert.equal(mid.columns[0]!.value, 1);
  assert.equal(
    odometer(0.4, 0, "1,240", { from: "980" }).columns[4]!.pos,
    0,
    "the last column waits its turn",
  );
  assert.ok(odometer(0.2, 0, "1,240").columns[0]!.speed > 0, "rolling");
  near(end.columns[2]!.pos, 9 + 3 + 10, 1e-9, "9 → 2 is 3 steps on, plus a lap");
});

test("flap: the old top folds down, then the new bottom folds open; tiles in turn", () => {
  const a = flap(0, 0, "450", "390");
  assert.deepEqual(
    a.tiles.map((x) => [x.old, x.now]),
    [
      ["4", "3"],
      ["5", "9"],
      ["0", "0"],
    ],
  );
  assert.equal(a.tiles[2]!.p, 1, "an unchanged tile does not turn");
  const b = flap(0.13, 0, "450", "390");
  assert.equal(b.tiles[0]!.top, 0);
  assert.equal(b.tiles[0]!.bottom, 0);
  assert.equal(b.tiles[1]!.top, 1, "the next tile has not started");
  assert.equal(flap(0.7, 0, "450", "390").done, true);
  assert.equal(flap(0, 0, "99", "100").tiles[0]!.old, " ", "padded on the left");
});

test("fit: every place inside the box with its pad, and back again", () => {
  const taipei: [number, number][] = [
    [121.5654, 25.033],
    [121.4637, 25.0119],
    [121.5168, 25.0478],
    [121.6044, 25.0614],
  ];
  const b = { x: 100, y: 50, width: 1600, height: 900 };
  const m = fit(taipei, b, { pad: 40 });
  const pts = taipei.map((p) => m.project(p));
  for (const p of pts) {
    assert.ok(p.x >= b.x + 40 - 1e-6 && p.x <= b.x + b.width - 40 + 1e-6, `x ${p.x}`);
    assert.ok(p.y >= b.y + 40 - 1e-6 && p.y <= b.y + b.height - 40 + 1e-6, `y ${p.y}`);
  }
  // north is up
  assert.ok(m.project([121.5, 25.1]).y < m.project([121.5, 25.0]).y);
  const back = m.unproject(pts[1]!);
  near(back[0], 121.4637, 1e-9, "lng");
  near(back[1], 25.0119, 1e-9, "lat");
  assert.ok(m.zoom > 10 && m.zoom < 14, `zoom ${m.zoom}`);
  assert.equal(fit([{ lng: 121.5, lat: 25 }], b).zoom, 16, "one place: capped");
});

test("switchOn: in order, gaps shrinking with accel, lit counting the ones fully on", () => {
  const s = switchOn(0, 1, 5, { over: 4, accel: 2 });
  const at = s.items.map((x) => x.at);
  assert.equal(at[0], 1);
  assert.equal(at[4], 5);
  for (let i = 1; i < 4; i++) assert.ok(at[i + 1]! - at[i]! < at[i]! - at[i - 1]!, "gaps shrink");
  const even = switchOn(0, 1, 5, { over: 4, accel: 1 }).items.map((x) => x.at);
  assert.deepEqual(even, [1, 2, 3, 4, 5]);
  const mid = switchOn(2.5, 1, 5, { over: 4, accel: 1 });
  assert.equal(mid.lit, 2);
  assert.ok(mid.items[0]!.flash === 0 && mid.items[1]!.flash === 0);
  assert.ok(
    switchOn(2.05, 1, 5, { over: 4, accel: 1 }).items[1]!.flash > 0.3,
    "a flash as it comes on",
  );
  assert.equal(switchOn(9, 1, 5).done, true);
});

test("along: the tip runs the polyline, its length and angle with it", () => {
  const pts = [
    { x: 0, y: 0 },
    { x: 300, y: 0 },
    { x: 300, y: 400 },
  ];
  assert.equal(pathOf(pts), "M0 0 L300 0 L300 400");
  const lin = { ease: (p: number) => p };
  assert.deepEqual(along(0, 0, 1, pts, lin).tip, { x: 0, y: 0 });
  const half = along(0.5, 0, 1, pts, lin);
  assert.equal(half.total, 700);
  assert.equal(half.length, 350);
  assert.deepEqual(half.tip, { x: 300, y: 50 });
  near(half.angle, Math.PI / 2, 1e-9, "heading down the second leg");
  assert.deepEqual(along(2, 0, 1, pts).tip, { x: 300, y: 400 });
  assert.throws(() => along(0, 0, 1, [pts[0]!]), /two points/);
});
