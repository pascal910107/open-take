// starter/lib/moves.js and what lib/anim.js gained beside it: each move,
// read back frame by frame, gives the numbers it was taken from (the launch
// reels' measurements in its comments); cuts fall between two frames of the
// film as it is drawn; nothing jumps where it should not.
import assert from "node:assert/strict";
import { copyFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { launchHtmlBrowser } from "../src/html/cdp";
import { serveDirectory } from "../src/html/server";
import * as A from "../starter/lib/anim.js";
import * as M from "../starter/lib/moves.js";
import { findChrome } from "./fixtures/find-chrome";

const near = (a: number, b: number, tol: number, what: string) =>
  assert.ok(Math.abs(a - b) <= tol, `${what}: ${a} is not within ${tol} of ${b}`);
const steps = (xs: number[]) => xs.slice(1).map((x, i) => x - xs[i]!);

test("windowHop: the pull and the lift replay their measured widths; the desk scales at most 1.04", () => {
  const view = { width: 1276, height: 718 };
  const from = { x: 246, y: 128, w: 516, h: 290 };
  const to = { x: 676, y: 72, w: 430, h: 236 };
  const h = (rt: number) => M.windowHop(rt - 31.5, 0, from, to, { view, fill: 2.47 });
  // the hero window's width on screen during the pull (reel px)
  for (const [rt, w] of [[31.5, 1276], [31.733, 1185], [31.833, 680], [32.2, 515]] as const)
    near(516 * h(rt).desk.s, w, 22, `hero window at ${rt}`);
  // the next window's width on screen during the lift: its own scale times the desk's
  for (const [rt, w] of [[32.6, 470], [32.8, 660], [32.933, 780], [33.0, 1135]] as const) {
    const x = h(rt);
    near(430 * x.to.s * x.desk.s, w, 8, `lifting window at ${rt}`);
  }
  for (let rt = 32.53; rt <= 33.3; rt += 0.01) assert.ok(h(rt).desk.s <= 1.04 + 1e-9, "the desk barely scales");
  const end = h(33.3);
  assert.equal(end.phase, "done");
  // at the end the window fills the frame, centred
  const sx = end.desk.x + end.desk.s * (676 + 215 + end.to.x);
  near(sx, 638, 0.5, "the lifted window's centre");
  assert.equal(h(32.35).phase, "hold");
  assert.equal(h(32.35).desk.s, 1, "the desk at rest during the hold");
});

test("pullbackReveal: the plane's width frame by frame as measured, then drifting on", () => {
  const ref: Record<number, number> = { 1: 0.95, 2: 0.892, 3: 0.845, 4: 0.797, 6: 0.722, 8: 0.642, 10: 0.578, 12: 0.527, 14: 0.472 };
  for (const [f, w] of Object.entries(ref)) near(M.pullbackReveal(+f / 24, 0).s, w, 0.004, `frame ${f}`);
  const r = M.pullbackReveal(14 / 24, 0);
  near((r.x + 960) / 1920, 0.68, 0.002, "its centre");
  const after = [16, 18, 20, 24].map((f) => M.pullbackReveal(f / 24, 0).s);
  for (const d of steps(after)) assert.ok(d < 0, "still shrinking after");
  // cam and pose agree: the plane's centre through cam2d
  const cam = A.cam2d(r.cam as { x: number; y: number; s: number });
  near(cam.toScreen(960, 540)[0], r.x + 960, 1e-6, "cam and pose put the plane in one place");
});

test("stations: 5–6 frames to speed up, ×0.73 a frame at first, down to a creep in 11 frames, never stopping between legs", () => {
  const list = [
    { t: 0, at: { x: 400, y: 0, s: 1 } },
    { t: 0.9, at: { x: 800, y: 0, s: 2 } },
  ];
  const xs = Array.from({ length: 60 }, (_, f) => M.stations(f / 24, list, { from: { x: 0, y: 0, s: 1 } }));
  const v = steps(xs.map((c) => c.x));
  const first = v.slice(0, 20);
  const peak = first.indexOf(Math.max(...first)) + 1;
  assert.ok(peak >= 5 && peak <= 7, `peak on frame ${peak}`);
  // slowing: about ×0.73 a frame for its first frames, then faster, so it lands
  for (let i = peak + 1; i < peak + 4; i++) assert.ok(v[i]! / v[i - 1]! > 0.7 && v[i]! / v[i - 1]! < 0.74, `slowing, frame ${i}: ${v[i]! / v[i - 1]!}`);
  for (let i = peak + 1; i < peak + 11; i++) assert.ok(v[i]! / v[i - 1]! <= v[i - 1]! / v[i - 2]! + 1e-9 || i === peak + 1, `slowing more each frame, ${i}`);
  // landed 11 frames after its fastest: a station held at 0.1–0.5 px a frame for the next 8,
  // on the scale of the measured legs (110–187 px a frame at their fastest)
  const one = steps(Array.from({ length: 40 }, (_, f) => M.stations(f / 24, [list[0]!], { from: { x: 0, y: 0, s: 1 } }).x));
  for (const top of [110, 187])
    for (let k = 12; k <= 19; k++) {
      const px = (one[peak - 1 + k]! / one[peak - 1]!) * top;
      assert.ok(px >= 0.08 && px <= 0.5, `held at a creep, ${k} frames after a peak of ${top}: ${px.toFixed(3)} px a frame`);
    }
  // slowing by ×0.73 for ever does not land in that time: 18 frames to 0.5 px a frame
  const ever = steps(Array.from({ length: 40 }, (_, f) => M.stations(f / 24, [list[0]!], { from: { x: 0, y: 0, s: 1 }, settle: Infinity, creep: 0 }).x));
  const top = ever.indexOf(Math.max(...ever));
  for (let i = top + 2; i < top + 10; i++) near(ever[i]! / ever[i - 1]!, 0.73, 0.001, `for ever, frame ${i}`);
  assert.ok((ever[top + 12]! / ever[top]!) * 150 > 2, "still travelling 12 frames on");
  // when each leg lands and how long its station is held
  const times = M.stationTimes(list);
  near(times[0]!.lands, (5.5 + 11) / 24, 1e-9, "a leg lands 16.5 frames after it leaves");
  near(times[0]!.held, 0.9 - 16.5 / 24, 1e-9, "the first station's hold");
  assert.equal(times[1]!.held, Infinity);
  for (const d of v.slice(0, 30)) assert.ok(d > 0, "it never stops before the next leg");
  near(xs[59]!.x, 800, 0.5, "it reaches the last station");
  near(xs[59]!.s, 2, 0.01, "scale in log space");
  assert.equal(xs[30]!.leg, 1);
  // a station frames its rect at 0.635 of the frame's width
  const st = M.station({ x: 100, y: 100, w: 400, h: 300 });
  near(st.s * 400, 0.635 * 1920, 1e-6, "station share");
  // from a moving start that settles: lands exactly where asked
  const moving = (t: number) => M.stations(t, [{ t: 1, at: { x: 700, y: 500, s: 1.6 } }], {
    from: (u: number) => M.pullbackReveal(u, 0).cam,
  });
  near(moving(30).x, 700, 0.01, "lands on its station");
  near(moving(30).s, 1.6, 0.001, "at its scale");
  near(moving(1).x, M.pullbackReveal(1, 0).cam.x!, 1e-9, "leaves from where the drift is");
  // and on the way stays between the two, never thrown far off
  for (let t = 1; t < 3; t += 0.02) {
    const x = moving(t).x, b = M.pullbackReveal(t, 0).cam.x!;
    assert.ok(x >= Math.min(b, 700) - 1 && x <= Math.max(b, 700) + 1, `between at ${t}`);
  }
});

test("momentumCut: 85 px out in 8 frames, cut on the fastest, the next from 57 px slowing; the cut between frames", () => {
  const o = { out: 85, in: 57, fps: 30 };
  const a = Array.from({ length: 10 }, (_, i) => M.momentumCut((i - 9) / 30, 0, o).a.y);
  const ea = steps(a);
  // frames −9 … −1 are drawn; frame 0 is the next shot
  near(a[8]! - a[0]!, -85, 0.01, "the way out, on frames drawn");
  near(ea[7]!, -27, 1, "its last step drawn (px a frame)");
  for (let i = 1; i < 8; i++) assert.ok(ea[i]! < ea[i - 1]!, "faster every frame");
  const b = Array.from({ length: 10 }, (_, i) => M.momentumCut(i / 30, 0, o).b.y);
  near(b[0]!, 57, 1e-9, "the next starts 57 px behind its place");
  near(b[1]! - b[0]!, -17.7, 0.5, "and carries on at 17.7 px a frame");
  near(b[8]!, 0, 1e-9, "settled in 8 frames");
  // both sides of one frame's shutter see the same side
  const m1 = M.momentumCut(1 / 30 - 0.004, 1 / 30, o), m2 = M.momentumCut(1 / 30 + 0.004, 1 / 30, o);
  assert.equal(m1.b.visible, true);
  assert.equal(m2.b.visible, true);
  assert.equal(m1.a.visible, false);
  near(m1.cutAt, 1 / 30, 1e-12, "cutAt on the frame");
});

test("rampJump: the measured scale steps, one frame of 1.445×, 2.07× in 0.83 s", () => {
  const s = Array.from({ length: 22 }, (_, i) => M.rampJump((i - 14) / 24, 0, { fps: 24 }).s);
  const r = s.slice(1).map((x, i) => x / s[i]!);
  near(r[13]!, 1.445, 0.002, "the jump");
  const before = r.slice(3, 12);
  for (const x of before) assert.ok(x < 1.07, "a ramp before it");
  near(r[11]!, 1.059, 0.003, "the ramp's last full frame");
  near(r[14]!, 1.093, 0.02, "settling after");
  near(s[20]!, 2.075, 0.01, "2.07× in all");
  // the focus point stays put
  const j = M.rampJump(0.1, 0, { focus: [300, 200], fps: 24 });
  near(j.x + 300 * j.s, 300, 1e-9, "focus x");
  near(j.y + 200 * j.s, 200, 1e-9, "focus y");
});

test("exitDrift: drifting 40 px/s, then 22, 41, 70 px per eighth of a second into the cut", () => {
  const d = (t: number) => -M.exitDrift(t, 0, 1.325).y;
  near(d(0.5) - d(0.375), 5, 1e-9, "a drift of 40 px/s");
  const last = [1.0, 1.125, 1.25].map((t) => d(t + 0.125) - d(t));
  // the reel: 22, 41, 70 (its last steps; 560 px/s at the cut)
  near(last[1]!, 41, 6, "the second eighth");
  near(last[2]!, 70, 6, "the last eighth");
  assert.equal(M.exitDrift(1.325, 0, 1.325).speed, 560);
});

test("arrivalShake: 3–4 frames of movement at 24 fps, then still; blurBridge: 4 frames out, 6 in, cut on the frame", () => {
  const x = Array.from({ length: 10 }, (_, f) => M.arrivalShake(f / 24, 0).x);
  const moving = steps(x).filter((d) => Math.abs(d) > 2).length;
  assert.ok(moving >= 3 && moving <= 4, `${moving} frames move`);
  assert.equal(M.arrivalShake(-0.1, 0).x, 0);
  const b = (f: number) => M.blurBridge(f / 24, 0, { fps: 24 });
  assert.equal(b(-5).a.blur, 0);
  near(b(-1).a.blur!, 24, 1e-9, "deepest on the last frame drawn");
  assert.equal(b(-1).a.visible, true);
  assert.equal(b(0).a.visible, false, "the frame at the cut is the next shot's");
  near(M.blurBridge(-1 / 24, 0, { fps: 24, out: 1 / 24 }).a.blur!, 24, 1e-9, "a one-frame blur is still seen");
  near(b(0).b.blur!, 24, 1e-9, "the next starts as blurred");
  assert.equal(b(6).b.blur, 0);
});

test("zoomThrough: the scale's step grows 1.02× → 1.39× a frame over 9 frames; the next carries on", () => {
  const rect = { x: 960 - 1920 / 6.1, y: 540 - 1080 / 6.1, w: 1920 / 3.05, h: 1080 / 3.05 };
  // 10 frames drawn (0 … 9), the cut on the 10th
  const s = Array.from({ length: 10 }, (_, f) => M.zoomThrough(f / 30, 0, 10 / 30, rect, { through: 1, fps: 30 }).a.s);
  near(s[9]!, 3.05, 1e-6, "all the way in on the last frame drawn");
  const r = s.slice(1).map((x, i) => x / s[i]!);
  near(r[0]!, 1.02, 0.01, "first step");
  near(r[8]!, 1.39, 0.02, "last step");
  for (let i = 1; i < r.length; i++) assert.ok(r[i]! > r[i - 1]!, "faster every frame");
  const after = M.zoomThrough(10 / 30, 0, 10 / 30, rect, { through: 1, fps: 30 });
  assert.equal(after.a.visible, false);
  near(after.b.s, 1.2, 1e-9, "the next starts large");
  near(M.zoomThrough(0.7, 0, 0.3, rect, { fps: 30 }).b.s, 1, 1e-9, "and settles");
});

test("toThumbnail, implodeTo, develop: the measured timings", () => {
  const full = { x: 0, y: 0, w: 1920, h: 1080 }, thumb = { x: 300, y: 600, w: 240, h: 135 };
  const th = (f: number) => M.toThumbnail(f / 24, 0, full, thumb);
  near(th(6).rect.w, 240, 1e-6, "in its slot after 6 frames");
  near(th(6).rect.x, 300, 1e-6, "at its place");
  near(th(0).flash, 0.85, 1e-9, "the flash at its brightest as the shrink starts");
  assert.equal(th(-4).flash, 0);
  const im = (t: number) => M.implodeTo(t, 0, [{ x: 100, y: 100 }], { x: 900, y: 500, w: 120, h: 80 });
  assert.equal(im(0.29).items[0]!.visible, true);
  assert.equal(im(0.3).items[0]!.visible, false, "gone at 0.3 s");
  near(im(0.15).items[0]!.x, 107.5, 1e-6, "an eighth of the way (860 px) at half time: faster and faster");
  near(im(0.6).into.s, 1, 1e-9, "grown");
  assert.equal(M.develop(0.1, 0).stage, "first");
  assert.equal(M.develop(0.3, 0).stage, "second");
  assert.equal(M.develop(0.42, 0).values, "1 0 0 0 0 0 1 0 0 0 0 0 1 0 0 0 0 0 1 0", "finished: the picture as it is");
  // the first duotone maps black to its dark colour
  const v = M.develop(0, 0, { first: ["#102030", "#ffffff"] }).values.split(" ").map(Number);
  near(v[4]!, 0x10 / 255, 1e-4, "dark red");
  near(v[0]! + v[1]! + v[2]!, 1 - 0x10 / 255, 1e-3, "white maps to light");
  assert.throws(() => M.develop(0, 0, { first: ["red", "#fff"] }), /#rgb/);
});

test("remap and freeze: 9 frames slowing, 14 held, 9 back; on twos", () => {
  const keys = M.freeze(1);
  const tau = Array.from({ length: 50 }, (_, f) => M.remap(f / 24, keys));
  const v = steps(tau).map((d) => d * 24);
  near(v[10]!, 1, 1e-6, "full speed before");
  const held = v.filter((x) => Math.abs(x) < 1e-6).length;
  assert.ok(held >= 14 && held <= 15, `${held} frames held`);
  near(v[48]!, 1, 1e-6, "full speed after");
  // behind film time by hold + (slow + back) / 2
  near(48 / 24 - tau[48]!, 14 / 24 + 9 / 24, 1e-3, "how far behind");
  assert.equal(M.remap(0.5, []), 0.5);
  assert.equal(M.remap(0.5, [[1, 1]]), 0.5, "film time before the first key");
  near(M.remap(3, [[0, 1], [1, 0.5, "linear"]]), 0.75 + 2 * 0.5, 1e-9, "a linear ramp's integral, then the last speed");
  assert.deepEqual([0, 1, 2, 3, 4, 5].map((f) => Math.round(M.onTwos(f / 24) * 24)), [0, 0, 2, 2, 4, 4]);
});

test("anim.js: GSAP names as GSAP computes them; purpose names; unknown names", () => {
  near(A.named("power2.out")(0.5), 0.875, 1e-12, "power2.out is a cubic");
  near(A.named("expo.out")(0.5), 0.9766, 1e-4, "GSAP's expo");
  near(A.named("back.out(1.7)")(0.5), 1 + 2.7 * -0.125 + 1.7 * 0.25, 1e-12, "back with its overshoot");
  near(A.named("power1.inOut")(0.25), 0.125, 1e-12, "power1.inOut");
  near(A.named("sine.inOut")(0.25), (1 - Math.cos(Math.PI / 4)) / 2, 1e-12, "sine.inOut");
  assert.ok(Math.max(...Array.from({ length: 101 }, (_, i) => A.named("elastic.out(1, 0.4)")(i / 100))) > 1.05, "elastic overshoots");
  near(A.named("bounce.out")(1), 1, 1e-12, "bounce lands");
  for (const n of ["arrive", "leave", "resume", "step", "pop", "settle", "drift"]) {
    near(A.named(n)(0), 0, 1e-9, `${n}(0)`);
    near(A.named(n)(1), 1, 1e-9, `${n}(1)`);
  }
  assert.ok(A.ease.arrive(1 / 13) > 0.3, "arrive: a third of the way in its first frame of 13");
  assert.throws(() => A.named("swoosh"), /no ease named "swoosh"/);
  assert.equal(A.gsapEase("swoosh"), null);
  // what was there keeps working: a name it never knew still falls back to inOut3 in keys
  near(A.keys(0.25, [[0, 0], [1, 1, "swoosh"]]) as number, 0.0625, 1e-12, "inOut3 at a quarter");
  near(A.keys(0.25, [[0, 0], [1, 1, "power2.out"]]) as number, 1 - 0.75 ** 3, 1e-12, "and keys take GSAP names");
});

test("anim.js: staggerGrid, accelStagger, springs, anticipate, follow", () => {
  // 5 × 3 from the centre, a spread of 1 s: the centre first, the corners last
  const g = Array.from({ length: 15 }, (_, i) => A.staggerGrid(i, 5, 3, { amount: 1 }));
  assert.equal(g[7], 0);
  near(g[0]!, 1, 1e-9, "a corner last");
  near(A.staggerGrid(1, 4, 4, { from: "start", each: 0.1 }), 0.1, 1e-9, "each is per cell of distance");
  near(A.staggerGrid(5, 4, 4, { from: "edges", amount: 1 }), 1, 1e-9, "edges: the middle last");
  assert.equal(A.staggerGrid(0, 4, 4, { from: "edges", amount: 1 }), 0);
  // 13 layers: gaps 8 frames down to 1
  const s = Array.from({ length: 13 }, (_, i) => A.accelStagger(i, 13) * 24);
  const gaps = steps(s);
  near(gaps[0]!, 8, 1e-9, "first gap");
  near(gaps[11]!, 1, 1e-9, "last gap");
  for (let i = 1; i < gaps.length; i++) assert.ok(gaps[i]! < gaps[i - 1]!, "shrinking");
  assert.equal(A.accelStagger(0, 1), 0);
  // springs: about 2 % past, and a retarget mid-move keeps its speed
  let peak = 0;
  for (let t = 0; t < 3; t += 0.001) peak = Math.max(peak, A.springs(t, [[0, 0], [0.5, 100]]) as number);
  near(peak, 102, 0.1, "2 % past the mark");
  const ch: [number, number][] = [[0, 0], [0.2, 100], [0.4, -50]];
  const v1 = ((A.springs(0.4, ch) as number) - (A.springs(0.4 - 1e-6, ch) as number)) / 1e-6;
  const v2 = ((A.springs(0.4 + 1e-6, ch) as number) - (A.springs(0.4, ch) as number)) / 1e-6;
  near(v2, v1, Math.abs(v1) * 0.02 + 1, "speed carries through a retarget");
  assert.deepEqual(A.springs(5, [[0, { x: 0, y: 0 }], [1, { x: 10, y: 20 }]]), { x: 10, y: 20 });
  // anticipate: nothing jumps at the launch; it lands where asked
  const a0 = A.anticipate(1 - 1e-9, 1, { from: 0, to: 500 }), a1 = A.anticipate(1, 1, { from: 0, to: 500 });
  for (const k of ["x", "sx", "sy", "r"] as const) near(a1[k], a0[k], 1e-6, `continuous ${k}`);
  near(A.anticipate(0.99, 1, { from: 0, to: 500 }).x, -30, 0.1, "wound back 30 px");
  near(A.anticipate(3, 1, { from: 0, to: 500 }).x, 500, 1e-9, "lands");
  near(A.anticipate(3, 1, { from: 0, to: 500 }).sx, 1, 1e-3, "and settles");
  const left = A.anticipate(0.99, 1, { from: [500, 0], to: [0, 0] });
  near(left.x, 530, 0.1, "back is away from where it goes");
  assert.ok(left.r > 0, "and it leans away");
  // follow: the prompt-motion test's tag, ±25.4° / +26.0°, within ±2° by 2.28 s
  const tag = A.follow((t) => A.anticipate(t, 1, { from: 230, to: 1290 }).x, { from: 0, to: 5 });
  let mn = 0, mx = 0, last = 0;
  for (let t = 0; t <= 5; t += 1 / 600) {
    const x = tag(t);
    mn = Math.min(mn, x);
    mx = Math.max(mx, x);
    if (Math.abs(x) > 2) last = t;
  }
  near(mn, -25.4, 0.3, "swing back");
  near(mx, 26.0, 0.3, "swing forward");
  near(last, 2.28, 0.05, "settled");
  // a function of t: read backwards, a fresh table gives what this one gave forwards
  const again = A.follow((t) => A.anticipate(t, 1, { from: 230, to: 1290 }).x, { from: 0, to: 5 });
  const times = [4.2, 1.3, 2.05, 0.4, 1.3];
  const back = [...times].reverse().map((t) => again(t)).reverse();
  assert.deepEqual(back, times.map((t) => tag(t)));
});

test("cuts: the last frame before a cut and the first after are smeared by a move still going", () => {
  const fps = 30, cut = 1;
  const at = (k: number) => cut + k / fps;
  // momentumCut: on frame −1 the card is at `out`, and through the half
  // shutter after it keeps its last step's speed (−0.75 is past −1)
  const a = (k: number) => M.momentumCut(at(k), cut, { fps }).a.y;
  near(a(-1), -128, 1e-9, "at `out` on the last frame drawn");
  const lastStep = a(-1) - a(-2);
  near(a(-0.75) - a(-1), lastStep / 4, Math.abs(lastStep) * 0.02, "the second half of its shutter, at the same speed");
  // the next shot over the half frame before its first: carried back at its first speed
  const b = (k: number) => M.momentumCut(at(k), cut, { fps }).b.y;
  near(b(0), 86, 1e-9, "the next starts 86 px behind");
  assert.ok(b(-0.25) > b(0), "and before its frame time it was further behind, still coming");
  near(b(-0.25) - b(0), (b(0) - b(1)) / 4, 1, "at its first step's speed");
  // zoomThrough: all the way in on frame −1, and still growing after it
  const rect = { x: 600, y: 300, w: 640, h: 360 };
  const z = (k: number) => M.zoomThrough(at(k), 0.5, cut, rect, { fps });
  near(z(-1).a.s, 3.75, 1e-9, "the rect covering the view ×1.25 on the last frame drawn");
  assert.ok(z(-0.75).a.s / z(-1).a.s > z(-1).a.s / z(-1.25).a.s, "faster in the second half of its shutter than the first");
  assert.ok(z(-0.25).b.s > z(0).b.s && z(0).b.s === 1.2, "the next shot still settling before its first frame");
});

test("pullbackReveal: the drift after the pull never passes through nothing", () => {
  for (const to of [0.1, 0.3, 0.47, 0.8]) {
    let last = Infinity;
    for (let t = 0; t <= 30; t += 0.05) {
      const r = M.pullbackReveal(t, 0, { to });
      assert.ok(r.s > 0 && r.s <= last + 1e-12, `to ${to} at ${t}: ${r.s}`);
      assert.ok(Number.isFinite(r.cam.x!) && Number.isFinite(r.x), `to ${to}: a camera and a place (${r.cam.x}, ${r.x})`);
      assert.ok(r.x + 960 > 0 && r.x + 960 < 1920, `to ${to}: its centre stays in the frame (${r.x + 960})`);
      last = r.s;
    }
    near(M.pullbackReveal(30, 0, { to }).s, M.pullbackReveal(0, 0, { to }).rest.s!, 1e-6, "it ends at rest");
  }
  // its first speed after the pull is `drift` (0.017 W a frame at 24 fps)
  const d = M.pullbackReveal(14 / 24, 0).s - M.pullbackReveal(15 / 24, 0).s;
  near(d, 0.017, 0.002, "about 0.017 W a frame");
  near(M.pullbackReveal(0, 0).rest.s!, 0.21, 0.005, "the default rest");
  assert.throws(() => M.pullbackReveal(0, 0, { to: 1 }), /above 0 and below 1/);
});

test("remap: the drawn time never runs back, however steep the ease", () => {
  for (const e of [(u: number) => u ** 100, "expo.in", "expo.out", "power4.inOut", "circ.in", "leave"] as const) {
    for (const ks of [[[0, 1], [1, 0, e]], [[0, 0], [1, 1, e]], [[0, 1], [0.4, 0.05, e], [0.6, 0.05], [1, 1, e]]] as Parameters<typeof M.remap>[1][]) {
      let prev = -Infinity;
      for (let i = 0; i <= 2400; i++) {
        const tau = M.remap(i / 2000, ks);
        assert.ok(tau >= prev - 1e-12, `${String(e)}: ${tau} after ${prev} at ${i / 2000}`);
        prev = tau;
      }
    }
  }
  near(M.remap(1, [[0, 1], [1, 0, (u: number) => u ** 100]]), 1 - 1 / 101, 1e-4, "and the steep one's integral is right");
});

test("moves: inputs that used to give NaN either work or say what is wrong", () => {
  const k0 = M.exitDrift(1.9, 0, 2, { kick: 0 });
  near(k0.y, -76, 1e-9, "kick 0: the hold at 40 px/s, not yet kicked");
  assert.equal(k0.speed, 40);
  near(M.exitDrift(2, 0, 2, { kick: 0 }).y, -80, 1e-9, "kick 0 at the cut");
  assert.ok(Number.isFinite(M.exitDrift(1, 0, 0.5, { kick: 0 }).y), "kick 0 after the cut");
  assert.throws(() => M.stations(1, [{ t: 0, at: { x: 100 } }], { from: { x: 0 }, decay: 1 }), /decay/);
  assert.throws(() => M.stations(1, [{ t: 0, at: { x: 100 }, decay: 0 }], { from: { x: 0 } }), /decay/);
  const full = M.zoomThrough(0.1, 0, 0.3, { x: 0, y: 0, w: 1920, h: 1080 }, { through: 1, fps: 30 });
  assert.equal(full.a.css, "translate(0px, 0px) scale(1)", "a rect that is already the view: no move");
  assert.throws(() => M.zoomThrough(0.1, 0, 0.3, { x: 0, y: 0, w: 0, h: 100 }), /width and height/);
  assert.throws(() => M.windowHop(0.3, 0, { x: 0, y: 0, w: 0, h: 0 }, { x: 0, y: 0, w: 100, h: 100 }), /width and height/);
  assert.equal(M.windowHop(1.2, 0, { x: 0, y: 0, w: 500, h: 300 }, { x: 900, y: 200, w: 400, h: 240 }).lifts, 1.03, "where the lift starts, to declare");
});

test("anim.js: names every object has are not eases; helpers with nothing to work on", () => {
  for (const n of ["toString", "constructor", "hasOwnProperty", "__proto__"])
    assert.throws(() => A.named(n), /no ease named/, n);
  near(A.keys(0.25, [[0, 0], [1, 1, "toString"]]) as number, 0.0625, 1e-12, "keys: falls back to inOut3");
  // a bare GSAP family is its .out, as GSAP reads it
  near(A.keys(0.25, [[0, 0], [1, 1, "sine"]]) as number, A.named("sine.out")(0.25), 1e-12, "sine is sine.out");
  assert.throws(() => A.springs(1, []), /at least one change/);
  assert.throws(() => A.follow((t) => t * 100, { from: 2, to: 1 }), /not before/);
  const zero = Array.from({ length: 5 }, (_, i) => A.accelStagger(i, 5, { first: 0, last: 0.1 }));
  for (const x of zero) assert.ok(Number.isFinite(x));
  near(zero[4]!, 0 + 0.1 / 3 + 0.2 / 3 + 0.1, 1e-12, "a gap of 0: the gaps change evenly");
  near(A.named("elastic.out(1, 0)")(0.5), A.named("elastic.out(1, 0.3)")(0.5), 1e-12, "period 0 is the default, as in GSAP");
});

test("one take: windowHop and pullbackReveal leave a camera still moving at its place and its speed", () => {
  const tour = [{ t: 0, at: { x: 700, y: 400, s: 2.6 } }, { t: 0.8, at: { x: 1100, y: 620, s: 3.1 } }];
  const cam = (t: number) => M.stations(t, tour, { from: { x: 500, y: 500, s: 2.2 } });
  const to = { x: 1010, y: 440, w: 760, h: 427.5 };
  const t0 = 1.05; // 6 frames after the second leg left: the camera at its fastest
  const hop = (t: number) => M.windowHop(t, t0, cam, to);
  // before the pull the desk is the camera's own pose
  for (const t of [0.3, 0.9, t0]) {
    const want = M.camPose(cam(t)), got = hop(t).desk;
    near(got.x, want.x, 1e-9, `desk x at ${t}`);
    near(got.s, want.s, 1e-9, `desk s at ${t}`);
  }
  // no step in speed where the pull begins: the picture's change a frame of 240, either side
  const dt = 1 / 240;
  const vel = (f: (t: number) => { x: number; y: number; s: number }, t: number) => {
    const a = f(t), b = f(t + dt);
    return [b.x - a.x, b.y - a.y, Math.log(b.s / a.s) * 1920];
  };
  const before = vel((t) => hop(t).desk, t0 - dt), after = vel((t) => hop(t).desk, t0);
  assert.ok(Math.hypot(...before) > 5, "the camera is travelling when the pull begins");
  for (let i = 0; i < 3; i++) near(after[i]!, before[i]!, 0.12 * Math.hypot(...before), `speed carried into the pull, axis ${i}`);
  // a window's rect at the same place cannot: the camera's speed is dropped at once
  const c0 = cam(t0);
  const rect = { x: c0.x! - 960 / c0.s!, y: c0.y! - 540 / c0.s!, w: 1920 / c0.s!, h: 1080 / c0.s! };
  const dead = vel((t) => M.windowHop(t, t0, rect, to).desk, t0);
  assert.ok(Math.hypot(...dead) < 0.2 * Math.hypot(...before), "from a rect the picture all but stops");
  // by the lift the desk is at rest, as from a window
  const held = hop(t0 + 0.7 + 0.32).desk;
  near(held.x, 0, 0.5, "desk at rest in the hold");
  near(held.s, 1, 1e-3, "at its own size");
  assert.equal(hop(t0 + 2).phase, "done");
  // a camera at rest, given as itself, pulls as the window it frames does
  const still = { x: 600, y: 400, s: 2 };
  const asRect = { x: 600 - 480, y: 400 - 270, w: 960, h: 540 };
  for (const t of [0.1, 0.3, 0.6]) near(M.windowHop(t, 0, still, to).desk.x, M.windowHop(t, 0, asRect, to).desk.x, 1e-9, `a still camera at ${t}`);
  assert.throws(() => M.windowHop(0, 0, { x: 1, y: 1, s: 0 }, to), /windowHop's camera/);

  // pullbackReveal over a camera: at rest it is the same pull seen through it
  const r0 = M.pullbackReveal(0.3, 0), r1 = M.pullbackReveal(0.3, 0, { from: { x: 960, y: 540, s: 1 } });
  near(r1.cam.x!, r0.cam.x!, 1e-9, "the frame's own camera changes nothing");
  const zoomed = M.pullbackReveal(0.3, 0, { from: still });
  near(zoomed.cam.s!, r0.s * 2, 1e-9, "its scale on top of the camera's");
  // the world point under the plane's centre is the one the camera was on
  const z = A.cam2d(zoomed.cam as { x: number; y: number; s: number });
  near(z.toScreen(600, 400)[0], r0.x + 960, 1e-6, "the camera's centre sits at the plane's");
  // over a moving one: where it is, at its speed
  const pull = (t: number) => M.pullbackReveal(t, t0, { from: cam }).cam as { x: number; y: number; s: number };
  near(pull(t0).x, c0.x!, 1e-9, "starts where the camera is");
  const pb = vel(pull, t0 - dt), pa = vel(pull, t0);
  for (let i = 0; i < 3; i++) near(pa[i]!, pb[i]!, 0.12 * Math.hypot(...pb), `speed carried into the pull-back, axis ${i}`);
  assert.ok(pull(t0 + 1).s < 0.6 * cam(t0 + 1).s!, "and it has pulled back");
});

test("rampJump: its camera is its pose; a further move carries on from it in the same picture; shift in frame px", () => {
  const o = { focus: [572, 172] as [number, number], by: 1.72, shift: [-120, 70] as [number, number], fps: 60 };
  for (const t of [0.2, 0.99, 1.01, 1.4]) {
    const j = M.rampJump(t, 1, o);
    const p = M.camPose(j.cam);
    near(p.x, j.x, 1e-9, `cam x at ${t}`);
    near(p.y, j.y, 1e-9, `cam y at ${t}`);
    near(p.s, j.s, 1e-9, `cam s at ${t}`);
  }
  // settled: the focus has slid by `shift` on screen, whatever the scale
  const end = M.rampJump(3, 1, o);
  near(end.x + 572 * end.s, 572 - 120, 0.01, "the focus, shifted x");
  near(end.y + 172 * end.s, 172 + 70, 0.01, "the focus, shifted y");
  near(end.rest.x!, end.cam.x!, 0.01, "rest is where it settles");
  // on from the jump to a station, one camera for one element
  const rows = { x: 150, y: 80, w: 300, h: 60 };
  const cam = (t: number) => M.stations(t, [{ t: 1.6, at: M.station(rows) }], { from: (u: number) => M.rampJump(u, 1, o).cam });
  near(cam(1.2).x!, M.rampJump(1.2, 1, o).cam.x!, 1e-9, "the jump's own camera until the leg leaves");
  near(cam(6).x!, 300, 0.05, "then on to the station");
  near(cam(6).s!, (0.635 * 1920) / 300, 1e-3, "at its scale");
  // laid over a camera the layer is already under
  const f = { x: 400, y: 300, s: 1.5 };
  const early = M.rampJump(-5, 1, { ...o, from: f });
  near(early.cam.x!, 400, 0.5, "before the push it is that camera");
  near(early.cam.s!, 1.5, 1e-3, "at its scale");
  near(M.rampJump(3, 1, { ...o, from: f }).cam.s!, 1.5 * 1.72, 1e-3, "the push on top of it");
});

test("momentumCut: a scene carried off its place says how far its ground must reach; scale or nothing when asked", () => {
  const o = { fps: 30 };
  const last = M.momentumCut(-1 / 30, 0, o).a;
  near(last.cover!.px, 128 + 2, 1e-6, "as far as it has moved, and 2 px");
  assert.equal(last.s, 1, "at its own size");
  const first = M.momentumCut(0, 0, o).b;
  near(first.cover!.px, 86 + 2, 1e-6, "the next shot, behind its place");
  assert.equal(M.momentumCut(2, 0, o).b.cover!.px, 0, "nothing once it is home");
  assert.equal(M.momentumCut(-2, 0, o).a.cover!.px, 0, "nor before it leaves");
  // a side that is hidden asks for none, so what was painted on the scene the cut left comes off
  assert.equal(M.momentumCut(0, 0, o).a.cover!.px, 0, "the scene left, once the cut has hidden it");
  assert.equal(M.momentumCut(-1 / 30, 0, o).b.cover!.px, 0, "the next scene, before the cut shows it");
  assert.equal(M.momentumCut(0, 0, { ...o, ground: ["#111", "#eee"] }).b.cover!.ground, "#eee");
  // drawn larger instead: just what the move uncovers at one edge
  const big = M.momentumCut(-1 / 30, 0, { ...o, cover: "scale" }).a;
  near(big.s, 1 + (2 * 128) / 1080, 1e-9, "128 px of 1080");
  assert.ok(1080 * big.s / 2 - 128 >= 540 - 1e-6, "its far edge still at the frame's");
  assert.equal(big.cover, undefined);
  near(M.momentumCut(-1 / 30, 0, { ...o, cover: "scale", dir: "left" }).a.s, 1 + (2 * 128) / 1920, 1e-9, "sideways, of the width");
  assert.equal(M.momentumCut(-1 / 30, 0, { ...o, cover: false }).a.cover, undefined);
});

test("in Chrome: apply shows a scene its stylesheet hides, never one inside a hidden parent; split", { skip: findChrome() ? false : "no Chrome for Testing" }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "open-take-moves-test-"));
  const lib = fileURLToPath(new URL("../starter/lib/", import.meta.url));
  await copyFile(join(lib, "anim.js"), join(dir, "anim.js"));
  await copyFile(join(lib, "moves.js"), join(dir, "moves.js"));
  await writeFile(
    join(dir, "index.html"),
    `<!doctype html><style>#b, #c { visibility: hidden } p { width: 300px; font: 40px/1.2 Arial } .g { position: absolute; left: 0; top: 0; width: 800px; height: 600px }</style>
<div id="a"><div id="b"></div></div><div id="c"><div id="d"></div></div>
<p id="w">two words</p><p id="ch">ab cd</p><p id="ln">one two three four five six seven</p>
<div id="flat" class="g" style="background:#0f1420"></div><div id="grad" class="g" style="background:linear-gradient(#111,#333)"></div>
<div id="bare" class="g"></div><div id="card" style="position:absolute;width:300px;height:200px;background:#fff"></div>
<script type="module">
import { apply, camPose, momentumCut } from "./moves.js";
import { split } from "./anim.js";
const $ = (id) => document.getElementById(id);
const vis = (id) => getComputedStyle($(id)).visibility;
window.ground = () => {
  const view = { width: 800, height: 600 };
  const out = momentumCut(1 - 1 / 30, 1, { fps: 30, view }).a, home = momentumCut(-1, 1, { fps: 30, view }).a;
  const got = {};
  for (const id of ["flat", "grad", "bare", "card"]) { apply($(id), out); got[id] = { shadow: $(id).style.boxShadow, transform: $(id).style.transform }; }
  apply($("flat"), home);
  got.home = $("flat").style.boxShadow;
  apply($("grad"), momentumCut(1 - 1 / 30, 1, { fps: 30, view, ground: "#111" }).a);
  got.named = $("grad").style.boxShadow;
  // the scene the cut has left, and a scene given some other pose: neither keeps the paint
  apply($("flat"), out);
  apply($("flat"), momentumCut(1, 1, { fps: 30, view }).a);
  got.left = $("flat").style.boxShadow;
  apply($("flat"), out);
  apply($("flat"), camPose({ x: 400, y: 300, s: 0.7 }, view));
  got.posed = $("flat").style.boxShadow;
  return got;
};
window.run = () => {
  const m = momentumCut(1.2, 1, { fps: 30 });
  apply($("b"), m.b); // after the cut: the next shot, hidden in CSS until now
  apply($("d"), m.b); // the same pose inside a scene that is hidden
  const shown = [vis("b"), vis("d")];
  apply($("b"), momentumCut(0.8, 1, { fps: 30 }).b);
  const words = split($("w")).map((e) => e.textContent);
  const chars = split($("ch"), { by: "chars" }).map((e) => e.textContent);
  const lines = split($("ln"), { by: "lines", mask: true });
  return { shown, before: vis("b"), words, chars, lines: lines.map((e) => e.textContent),
    masked: lines.every((e) => e.parentElement.style.overflow === "hidden"), text: $("w").textContent, again: split($("w")).length };
};
</script>`,
  );
  const server = await serveDirectory(dir);
  const b = await launchHtmlBrowser({ chromePath: findChrome()!, url: `${server.url}/index.html`, width: 800, height: 600 });
  try {
    const r = await b.evaluate<{ shown: string[]; before: string; words: string[]; chars: string[]; lines: string[]; masked: boolean; text: string; again: number }>("window.run()");
    assert.deepEqual(r.shown, ["visible", "hidden"], "shown over its stylesheet, hidden inside a hidden parent");
    assert.equal(r.before, "hidden", "and hidden again before the cut");
    assert.deepEqual(r.words, ["two", "words"]);
    assert.deepEqual(r.chars, ["a", "b", "c", "d"]);
    assert.ok(r.lines.length >= 2, `the text wraps into lines: ${JSON.stringify(r.lines)}`);
    assert.equal(r.lines.join(" "), "one two three four five six seven");
    assert.ok(r.masked, "each line in its mask");
    assert.equal(r.text, "two words", "the spaces stay as text");
    assert.equal(r.again, 2, "split again from the original text");
    type G = { shadow: string; transform: string };
    const g = await b.evaluate<{ flat: G; grad: G; bare: G; card: G; home: string; named: string; left: string; posed: string }>("window.ground()");
    assert.match(g.flat.shadow, /rgb\(15, 20, 32\) 0px 0px 0px 130px/, "a flat scene's own colour, 130 px past its edge");
    assert.doesNotMatch(g.flat.transform, /scale\(1\.\d+\)$/, "and not drawn larger");
    assert.equal(g.grad.shadow, "", "a gradient cannot be carried on as one colour");
    assert.match(g.grad.transform, /scale\(1\) scale\(1\.42667\)$/, "it is drawn larger by what the move uncovers (2 × 128 of 600)");
    assert.equal(g.bare.shadow + g.card.shadow, "", "a scene with no ground of its own, and a card, are left alone");
    assert.doesNotMatch(g.card.transform, /scale\(1\.\d+\)$/);
    assert.equal(g.home, "", "the painted ground is taken off at rest");
    assert.match(g.named, /rgb\(17, 17, 17\) 0px 0px 0px 130px/, "a ground named for it wins");
    assert.equal(g.left, "", "the scene a cut has left is not kept painted while it is hidden");
    assert.equal(g.posed, "", "nor one given a later pose that asks for none — a frame does not depend on the ones before it");
  } finally {
    await b.close();
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
});
