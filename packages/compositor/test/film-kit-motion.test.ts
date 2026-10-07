// The film kit's motion (kit/motion.js): the spring is checked against a
// numerical integration of its equation, every block against what its
// comment promises — where it starts, where it lands, and the shape between.

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  dampingFor,
  drop,
  dropOut,
  gather,
  hop,
  impact,
  inset,
  iris,
  maskOut,
  maskRise,
  morphRect,
  pop,
  popOut,
  press,
  rectClip,
  rise,
  riseOut,
  settle,
  spring,
  springSettle,
  springVel,
  type,
  typeTimes,
  untype,
  zoomThrough,
} from "../kit/motion.js";
import { initFilm } from "../src/film/kit";

const near = (a: number, b: number, tol: number, what: string) =>
  assert.ok(Math.abs(a - b) <= tol, `${what}: ${a} vs ${b} (±${tol})`);

/** x'' = −2ζω0x' − ω0²(x − to), integrated with RK4 */
function integrate(
  o: { from: number; to: number; v0: number; w0: number; zeta: number },
  T: number,
): [number, number] {
  const dt = 1e-4;
  let x = o.from;
  let v = o.v0;
  const acc = (x: number, v: number) => -2 * o.zeta * o.w0 * v - o.w0 * o.w0 * (x - o.to);
  for (let t = 0; t < T - 1e-12; t += dt) {
    const k1x = v;
    const k1v = acc(x, v);
    const k2x = v + (dt / 2) * k1v;
    const k2v = acc(x + (dt / 2) * k1x, v + (dt / 2) * k1v);
    const k3x = v + (dt / 2) * k2v;
    const k3v = acc(x + (dt / 2) * k2x, v + (dt / 2) * k2v);
    const k4x = v + dt * k3v;
    const k4v = acc(x + dt * k3x, v + dt * k3v);
    x += (dt / 6) * (k1x + 2 * k2x + 2 * k3x + k4x);
    v += (dt / 6) * (k1v + 2 * k2v + 2 * k3v + k4v);
  }
  return [x, v];
}

test("the spring is the solution of its equation: under, critically and over damped, with a starting speed", () => {
  for (const zeta of [0, 0.3, 0.7, 1, 1.6]) {
    for (const velocity of [0, 40]) {
      const freq = 2;
      const o = { from: 100, to: 20, start: 1, freq, damping: zeta, velocity };
      for (const tau of [0.05, 0.2, 0.5, 1.1]) {
        const [x, v] = integrate(
          { from: 100, to: 20, v0: velocity, w0: 2 * Math.PI * freq, zeta },
          tau,
        );
        near(spring(1 + tau, o), x, 1e-4, `x ζ${zeta} v${velocity} τ${tau}`);
        near(springVel(1 + tau, o), v, 1e-3, `v ζ${zeta} v${velocity} τ${tau}`);
      }
      assert.equal(spring(0.5, o), 100, "before it is let go it is where it starts");
      assert.equal(springVel(0.5, o), 0);
    }
  }
});

test("stiffness, friction and overshoot are other ways to say the same spring", () => {
  const a = { freq: 1.5, damping: 0.4 };
  const w0 = 2 * Math.PI * 1.5;
  const b = { stiffness: w0 * w0, friction: 0.4 * 2 * w0 };
  for (let t = 0; t < 2; t += 0.07) near(spring(t, a), spring(t, b), 1e-9, `at ${t}`);

  // the first swing goes past the rest by exactly the asked share
  for (const os of [0.02, 0.1, 0.3]) {
    let peak = 0;
    for (let t = 0; t < 3; t += 1e-4) peak = Math.max(peak, spring(t, { overshoot: os }));
    near(peak - 1, os, 1e-4, `overshoot ${os}`);
  }
  assert.equal(dampingFor(0), 1);
  // critically damped and overdamped never pass the rest
  for (const damping of [1, 2])
    for (let t = 0; t < 4; t += 0.01) assert.ok(spring(t, { damping }) <= 1 + 1e-12);
});

test("the default spring settles in about 0.57 s with a barely-seen swing, as its comment says", () => {
  near(springSettle({}, 0.02), 0.57, 0.08, "2 % settle");
  let peak = 0;
  for (let t = 0; t < 2; t += 1e-3) peak = Math.max(peak, spring(t));
  near(peak - 1, 0.046, 0.002, "first swing");
});

test("settle lands exactly at the end of its window and swings only when asked", () => {
  assert.equal(settle(0), 0);
  assert.equal(settle(1), 1);
  let prev = 0;
  for (let p = 0; p <= 1; p += 0.01) {
    const v = settle(p);
    assert.ok(v >= prev - 1e-12 && v <= 1 + 1e-12, `monotone at ${p}`);
    prev = v;
  }
  let peak = 0;
  for (let p = 0; p <= 1; p += 0.001) peak = Math.max(peak, settle(p, { overshoot: 0.1 }));
  near(peak, 1.1, 0.01, "an asked swing");
});

test("settle stays bounded and ends without a speed to snap off, at any damping", () => {
  const slope = (o: { damping: number }, p: number) => (settle(p, o) - settle(p - 1e-4, o)) / 1e-4;
  for (const damping of [0, 0.02, 0.3, 0.7, 1, 2, 5]) {
    let lo = 0;
    let hi = 0;
    let peak = 0;
    for (let p = 0; p <= 1; p += 0.001) {
      lo = Math.min(lo, settle(p, { damping }));
      hi = Math.max(hi, settle(p, { damping }));
      if (p > 0) peak = Math.max(peak, Math.abs(slope({ damping }, p)));
    }
    assert.ok(lo >= -1e-9 && hi < 2.1, `ζ ${damping}: within [${lo}, ${hi}]`);
    assert.ok(Math.abs(slope({ damping }, 1 - 1e-6)) < 0.03 * peak, `ζ ${damping}: lands at rest`);
  }
});

test("springSettle looks as far as the spring needs, and says an undamped one never settles", () => {
  assert.equal(springSettle({ damping: 0 }), Infinity);
  const slow = { freq: 0.02 };
  const T = springSettle(slow);
  assert.ok(T > 30, `a 0.02 Hz spring takes longer than 30 s (${T})`);
  for (let t = T; t < T + 20; t += 0.5)
    assert.ok(Math.abs(spring(t, slow) - 1) <= 0.01 + 1e-6, `quiet at ${t}`);
  const w0 = 2 * Math.PI * 0.02;
  const off = Math.max(
    Math.abs(spring(T - 0.5, slow) - 1),
    Math.abs(springVel(T - 0.5, slow)) / w0,
  );
  assert.ok(off > 0.009, `not quiet just before (${off})`);
});

test("a window's progress holds outside it, whatever the ease", () => {
  const linear = (p: number) => p;
  const a = { x: 0, y: 0, w: 10, h: 10 };
  const b = { x: 100, y: 0, w: 100, h: 100 };
  assert.deepEqual(morphRect(0, 1, 2, a, b, { ease: linear }), { ...rectOfTest(a), p: 0 });
  assert.equal(morphRect(5, 1, 2, a, b, { ease: linear }).w, 100);
  assert.equal(iris(9, 1, 2, { x: 0, y: 0 }, { width: 3, height: 4 }, { ease: linear }).r, 5);
  assert.equal(hop(-3, 0, 1, { x: 0, y: 0 }, { x: 10, y: 0 }, { ease: linear }).x, 0);
  const [g] = gather(5, 0, [{ x: 0, y: 0 }], { x: 10, y: 0 }, { ease: linear });
  assert.equal(g?.x, 10);
});
const rectOfTest = (b: { x: number; y: number; w: number; h: number }) => ({ ...b, r: 0 });

test("a rise is solid before it has arrived: the opacity leads the travel", () => {
  assert.deepEqual(rise(0.9, 1), { x: 0, y: 24, opacity: 0, p: 0 });
  let solidAt = Number.NaN;
  for (let t = 1; t < 3; t += 1 / 240) {
    const r = rise(t, 1);
    if (Number.isNaN(solidAt) && r.opacity >= 1) {
      solidAt = t;
      assert.ok(r.y > 24 * 0.3, `still ${r.y} px to go when solid`);
    }
  }
  assert.ok(Number.isFinite(solidAt));
  const end = rise(5, 1);
  near(end.y, 0, 1e-3, "lands");
  near(end.opacity, 1, 1e-9, "solid");
  const side = rise(5, 1, { dx: -40, dy: 0 });
  near(side.x, 0, 1e-3, "slides in from the side");

  // its exit: leaves from rest, accelerating, opacity trailing the position
  const o = (t: number) => riseOut(t, 2);
  near(o(2).y, 0, 0, "from rest");
  assert.equal(o(2).opacity, 1);
  assert.ok(o(2.05).y - o(2.1).y > o(2).y - o(2.05).y, "it speeds up");
  assert.ok(o(2 + 0.32 * 0.3).opacity > 0.99, "still solid early on");
  near(o(2.33).y, -24, 1e-9, "gone up");
  assert.equal(o(2.33).opacity, 0);
});

test("a pop grows past full size and comes back; its exit swells first", () => {
  let peak = 0;
  for (let t = 0; t < 2; t += 1e-3) peak = Math.max(peak, pop(t, 0).scale);
  near(peak, 1 + 0.4 * 0.12, 1e-3, "≈ 5 % past");
  near(pop(3, 0).scale, 1, 1e-4, "rests at 1");
  assert.equal(pop(-1, 0).scale, 0.6);

  let most = 0;
  for (let t = 0; t < 0.1; t += 1e-3) most = Math.max(most, popOut(t, 0).scale);
  near(most, 1.04, 1e-6, "swell");
  near(popOut(1, 0).scale, 0.6, 1e-9, "shrunk");
  assert.equal(popOut(1, 0).opacity, 0);
});

test("a drop stretches with its speed, squashes as it lands, keeps its area and lands", () => {
  let stretched = false;
  let squashed = false;
  for (let t = 0; t < 3; t += 1 / 240) {
    const d = drop(t, 0);
    near(d.sx * d.sy, 1, 1e-9, `area at ${t}`);
    if (d.sy > 1.05) stretched = true;
    if (d.sy < 0.95) squashed = true;
  }
  assert.ok(stretched && squashed);
  // the shape never jumps between frames at 240 fps
  for (let t = 0; t < 2; t += 1 / 240)
    assert.ok(Math.abs(drop(t + 1 / 240, 0).sy - drop(t, 0).sy) < 0.02, `continuous at ${t}`);
  // dropped upward (from below), it squashes on the other side the same way
  for (const t of [0.12, 0.3, 0.5])
    near(drop(t, 0, { height: -120 }).sy, drop(t, 0).sy, 1e-9, `mirrored at ${t}`);
  const fallingFast = drop(0.12, 0);
  assert.ok(fallingFast.sy > 1, "stretched while falling");
  const end = drop(6, 0);
  near(end.y, 0, 1e-3, "lands");
  near(end.sy, 1, 1e-3, "back to shape");
  assert.equal(drop(-0.1, 0).opacity, 0);
  assert.equal(drop(-0.1, 0).y, -120);
  // the same drop, twice the size: the same deformation
  for (const t of [0.1, 0.3, 0.5])
    near(drop(t, 0).sy, drop(t, 0, { height: 240 }).sy, 1e-9, `size-free at ${t}`);

  const out = dropOut(0.4, 0);
  near(out.y, 160, 1e-9, "fallen");
  assert.ok(out.sy > 1);
});

test("a mask rise shows only what is inside the element's own box", () => {
  const m = maskRise(0, 0, { height: 50 });
  assert.equal(m.y, 50);
  assert.equal(m.clip, "inset(0px 0px 50.00px 0px)");
  const mid = maskRise(0.15, 0, { height: 50 });
  assert.ok(mid.y > 0 && mid.y < 50);
  assert.equal(mid.clip, `inset(0px 0px ${mid.y.toFixed(2)}px 0px)`);
  const end = maskRise(4, 0, { height: 50 });
  near(end.y, 0, 1e-3, "in");
  assert.equal(maskOut(1, 0, { height: 50 }).clip, "inset(0px 0px 50.00px 0px)");
  const up = maskOut(1, 0, { height: 50, up: true });
  assert.equal(up.y, -50);
  assert.equal(up.clip, "inset(50.00px 0px 0px 0px)");
});

test("typing keeps its rate, a human cadence varies the gaps but not the average, and is repeatable", () => {
  const text = "find every invoice from March, please.";
  const even = typeTimes(text, 2);
  assert.equal(even.length, text.length);
  near(even[0] as number, 2, 1e-9, "first key at start");
  near((even.at(-1) as number) - 2, (text.length - 1) / 16, 1e-9, "16 cps");

  const human = typeTimes(text, 2, { human: true, seed: 7 });
  near(human.at(-1) as number, even.at(-1) as number, 1e-9, "same total");
  const gaps = human.slice(1).map((t, i) => t - (human[i] as number));
  assert.ok(Math.max(...gaps) / Math.min(...gaps) > 2, "uneven");
  const afterComma = text.indexOf(",") + 1;
  const mean = gaps.reduce((s, g) => s + g, 0) / gaps.length;
  assert.ok((gaps[afterComma - 1] as number) > mean, "a pause after the comma");
  assert.deepEqual(typeTimes(text, 2, { human: true, seed: 7 }), human, "repeatable");
  assert.notDeepEqual(typeTimes(text, 2, { human: true, seed: 8 }), human, "a seed changes it");

  assert.equal(type(1.9, 2, text).text, "");
  assert.equal(type(2, 2, text).text, "f");
  const half = type(2 + 9.5 / 16, 2, text);
  assert.equal(half.text, text.slice(0, 10));
  assert.equal(half.done, false);
  assert.equal(type(10, 2, text).done, true);
  assert.equal(type(10, 2, "日本語").count, 3, "characters, not UTF-16 units");

  assert.equal(untype(0, 1, "abc").text, "abc");
  assert.equal(untype(1, 1, "abc").text, "ab");
  assert.equal(untype(2, 1, "abc").text, "");
  assert.equal(untype(2, 1, "abc").done, true);
});

test("morphRect grows one box into another, sizes in log space, landing exactly", () => {
  const a = { x: 900, y: 500, width: 120, height: 40, r: 20 };
  const b = { x: 0, y: 0, w: 1920, h: 1080, r: 0 };
  const s = morphRect(0, 1, 2, a, b);
  assert.deepEqual(s, { x: 900, y: 500, w: 120, h: 40, r: 20, p: 0 });
  const e = morphRect(2, 1, 2, a, b);
  assert.deepEqual(e, { x: 0, y: 0, w: 1920, h: 1080, r: 0, p: 1 });
  // halfway through the progress, the width is the geometric mean
  const m = morphRect(1.5, 1, 2, a, b, { ease: (p) => p });
  near(m.w, Math.sqrt(120 * 1920), 1e-9, "geometric mean");
  near(m.x + m.w / 2, (960 + 960) / 2, 1e-9, "centre");
  near(m.r, 10, 1e-9, "radius");
  const lin = morphRect(1.5, 1, 2, a, b, { ease: (p) => p, log: false });
  near(lin.w, (120 + 1920) / 2, 1e-9, "linear when asked");
});

test("rectClip and inset put a rect into an element's own box", () => {
  const frame = { width: 1920, height: 1080 };
  assert.deepEqual(inset({ x: 100, y: 50, w: 800, h: 600, r: 12 }, frame), {
    top: 50,
    right: 1020,
    bottom: 430,
    left: 100,
    r: 12,
  });
  assert.equal(
    rectClip({ x: 100, y: 50, w: 800, h: 600, r: 12 }, frame),
    "inset(50.00px 1020.00px 430.00px 100.00px round 12.00px)",
  );
  assert.equal(
    rectClip({ x: 0, y: 0, w: 1920, h: 1080, r: 0 }, frame),
    "inset(0.00px 0.00px 0.00px 0.00px)",
  );
  // a frame that sits elsewhere in the rect's coordinates
  assert.equal(
    inset({ x: 150, y: 100, w: 50, h: 50, r: 0 }, { x: 100, y: 100, width: 200, height: 100 }).left,
    50,
  );
});

test("iris opens from a point until the farthest corner is covered", () => {
  const frame = { width: 1920, height: 1080 };
  const at = { x: 300, y: 200 };
  assert.equal(iris(0, 0, 1, at, frame).r, 0);
  near(iris(1, 0, 1, at, frame).r, Math.hypot(1620, 880), 1e-9, "covers");
  near(iris(1, 0, 1, at, frame, { close: true }).r, 0, 1e-9, "closes");
  assert.equal(iris(0.5, 0, 1, at, frame, { from: 10, to: 30 }).r, 20);
  assert.match(iris(0.5, 0, 1, at, frame).clip, /^circle\([\d.]+px at 300\.00px 200\.00px\)$/);
});

test("zoomThrough is one scale about a fixed point, even in log space, ending on the rect", () => {
  const view = { width: 1920, height: 1080 };
  const rect = { x: 1200, y: 600, w: 192, h: 108, r: 0 };
  const z = (t: number, o = {}) =>
    zoomThrough(t, 0, 1, rect, view, { ease: (p: number) => p, ...o });
  assert.equal(z(0).scale, 1);
  near(z(0).x, 0, 1e-9, "no shift at the start");
  const e = z(1);
  near(e.scale, 10, 1e-9, "fills the view");
  // the rect's corners land on the view's corners
  near(rect.x * e.scale + e.x, 0, 1e-6, "left");
  near((rect.y + rect.h) * e.scale + e.y, 1080, 1e-6, "bottom");
  // log space: equal time, equal ratio
  near(z(0.5).scale, Math.sqrt(10), 1e-9, "half way");
  near(z(0.25).scale / z(0).scale, z(1).scale / z(0.75).scale, 1e-9, "steady");
  // the fixed point does not move
  for (const t of [0.2, 0.6]) {
    const k = z(t);
    near(k.origin.x * k.scale + k.x, k.origin.x, 1e-6, `fixed x at ${t}`);
    near(k.origin.y * k.scale + k.y, k.origin.y, 1e-6, `fixed y at ${t}`);
  }
  // contain vs cover with a rect of another shape
  const tall = { x: 0, y: 0, w: 100, h: 200, r: 0 };
  near(zoomThrough(1, 0, 1, tall, view).scale, 19.2, 1e-9, "cover");
  near(zoomThrough(1, 0, 1, tall, view, { fit: "contain" }).scale, 5.4, 1e-9, "contain");
  near(z(1, { through: 2 }).scale, 20, 1e-9, "through");
  // a rect the size of the view: a slide, no zoom
  const slide = zoomThrough(1, 0, 1, { x: 100, y: 0, w: 1920, h: 1080, r: 0 }, view);
  near(slide.scale, 1, 1e-12, "no zoom");
  near(slide.x, -100, 1e-9, "slid");
  assert.match(e.transform, /^translate\(.+px, .+px\) scale\(10\.00000\)$/);
});

test("gather staggers the items in the asked order and brings them all in", () => {
  const from = [
    { x: 0, y: 0 },
    { x: 1200, y: 0 },
    { x: 100, y: 0 },
  ];
  const to = { x: 500, y: 500 };
  const at = gather(2, 0, from, to);
  for (const g of at) assert.deepEqual([g.x, g.y, g.p], [500, 500, 1]);
  const early = gather(0.06, 0, from, to);
  assert.ok((early[0] as { p: number }).p > (early[1] as { p: number }).p, "index order");
  assert.equal((early[2] as { p: number }).p, 0, "third has not left yet");
  const far = gather(0.06, 0, from, to, { order: "far" });
  assert.ok((far[1] as { p: number }).p > (far[0] as { p: number }).p, "farthest first");
  assert.equal(gather(2, 0, from, to, { scale: 0.5 })[0]?.scale, 0.5);
});

test("hop arcs between two points, height above the line at its middle", () => {
  const h = hop(0.5, 0, 1, { x: 0, y: 100 }, { x: 200, y: 100 }, { ease: (p) => p });
  assert.deepEqual([h.x, h.y], [100, 20]);
  assert.deepEqual(hop(1, 0, 1, { x: 0, y: 100 }, { x: 200, y: 300 }).y, 300);
});

test("press sinks fast, holds, and springs back with a small swing", () => {
  assert.deepEqual(press(0.9, 1), { scale: 1, y: 0, down: 0 });
  const bottom = press(1.1, 1);
  near(bottom.scale, 0.94, 1e-9, "fully down");
  near(bottom.y, 2, 1e-9, "dropped");
  let over = 1;
  for (let t = 1.12; t < 2; t += 1e-3) over = Math.max(over, press(t, 1).scale);
  assert.ok(over > 1 && over < 1.03, `a small swing past rest: ${over}`);
  near(press(3, 1).scale, 1, 1e-4, "at rest");
});

test("impact kicks out to exactly its amount, then rings down within ≈ 0.23 s", () => {
  assert.deepEqual(impact(0.99, 1), { x: 0, y: 0, scale: 1, k: 0 });
  let peak = 0;
  let peakAt = 0;
  for (let t = 1; t < 1.1; t += 1e-5) {
    const y = impact(t, 1).y;
    if (y > peak) {
      peak = y;
      peakAt = t - 1;
    }
  }
  near(peak, 10, 1e-4, "first swing");
  near(peakAt, 0.029, 0.002, "peaks after ≈ 30 ms");
  let late = 0;
  for (let t = 1.23; t < 2; t += 1e-3) late = Math.max(late, Math.abs(impact(t, 1).y));
  assert.ok(late < 0.5, `rung down: ${late}`);
  near(impact(1.029, 1, { angle: 0 }).x, 10, 0.01, "along the angle");
  near(impact(1.029, 1).scale, 1.03, 1e-3, "scale bump");
});

test("every block is a pure function of time: the same t gives the same answer, in any order", () => {
  const frames = [3, 0.5, 2, 0.5, 3];
  const sample = (t: number) =>
    JSON.stringify([
      rise(t, 0.4),
      pop(t, 0.4),
      drop(t, 0.4),
      type(t, 0.4, "hello", { human: true }),
      press(t, 1),
      impact(t, 1),
      zoomThrough(t, 1, 2, { x: 10, y: 10, w: 100, h: 100, r: 0 }, { width: 1920, height: 1080 }),
    ]);
  const first = frames.map(sample);
  assert.equal(first[1], first[3]);
  assert.equal(first[0], first[4]);
});

test("film init copies motion.js into the film and the starting page imports it", async () => {
  const dir = await mkdtemp(join(tmpdir(), "film-motion-"));
  try {
    await initFilm({ dir });
    assert.ok(existsSync(join(dir, "kit", "motion.js")));
    assert.match(await readFile(join(dir, "index.html"), "utf8"), /from "\.\/kit\/motion\.js"/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
