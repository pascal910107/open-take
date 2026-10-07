// The film kit camera's optional moves — lead, handheld, shake, depth, log
// zoom, a view left free of the content. All of them are off until asked
// for, so the first check is that a camera asked for none of them is the
// camera it was, to the byte.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { camera, linear, noise } from "../kit/camera.js";

const near = (a: number, b: number, tol: number, what: string) =>
  assert.ok(Math.abs(a - b) <= tol, `${what}: ${a} vs ${b} (±${tol})`);

type Cam = ReturnType<typeof camera>;
type Opts = Partial<Parameters<typeof camera>[0]>;

// two films' worth of asking: in, out, a cut, a curve of one's own, a pull
// out; a tall content seen through an upright picture, pinned to its edges
const scenes: Record<string, (o: Opts) => Cam> = {
  moves: (o) => {
    const c = camera({ content: { width: 1920, height: 1080 }, ...o });
    c.frame({ x: 200, y: 150, width: 400, height: 200 }, { arrive: 1.5 });
    c.frame({ cx: 1400, cy: 700, w: 640 }, { start: 2.2 });
    c.cut({ x: 1500, y: 100, width: 300, height: 600 }, 3.4, { fit: "width" });
    c.frame(
      { x: 100, y: 800, width: 900, height: 200 },
      { start: 4, dur: 0.4, ease: (p) => p * p },
    );
    c.rest({ arrive: 6.5 });
    return c;
  },
  edge: (o) => {
    const c = camera({
      content: { width: 1920, height: 3000 },
      view: { width: 1080, height: 1920 },
      ...o,
    });
    c.frame({ x: 0, y: 0, width: 200, height: 200 }, { arrive: 1 });
    c.frame({ x: 1800, y: 2900, width: 120, height: 100 }, { arrive: 3, fill: 0.4 });
    c.frame(
      { x: 600, y: 1200, width: 500, height: 500 },
      { start: 4, ease: (p) => p + Math.sin(Math.PI * p) * 0.6 },
    );
    return c;
  },
};

/** every output of every scene at 60 fps, hashed */
const fingerprint = (o: Opts) => {
  const h = createHash("sha256");
  for (const mk of Object.values(scenes)) {
    const c = mk(o);
    const lines: string[] = [];
    for (let i = 0; i <= 8 * 60; i++) {
      const t = i / 60;
      lines.push(
        c.transform(t),
        c.toView(333, 444, t).join(","),
        c.toContent(500, 300, t).join(","),
        JSON.stringify(c.at(t)),
      );
    }
    lines.push(
      JSON.stringify(c.warnings()),
      JSON.stringify(c.moves().map((m) => ({ ...m, ease: !!m.ease }))),
    );
    h.update(lines.join("\n"));
  }
  return h.digest("hex");
};

// taken from kit/camera.js as it was before these options existed
const BEFORE = "5da75e9321f6b34b5fea448478d0e0083f419fb87162f16bf9edb2bb5285bbf4";

test("a camera asked for nothing new is the camera it was, to the byte", () => {
  assert.equal(fingerprint({}), BEFORE);
  // the defaults said out loud change nothing either
  assert.equal(fingerprint({ lead: 0, keepInside: true, zoom: "linear" }), BEFORE);
  const m = scenes.moves?.({});
  assert.equal(
    m?.transform(1.2),
    "translate(-120.00985545715844px, -112.50923949108608px) scale(2.175096501351343)",
  );
  assert.equal(m?.transform(5), "translate(0px, -302.4px) scale(1.28)");
  assert.deepEqual(m?.warnings(), [
    "frame at 4s: the content ends there — the view stops 314 px short of centring it",
  ]);
  assert.deepEqual(m?.jitter(3), { x: 0, y: 0, rot: 0 });
});

test("lead: the camera leaves and lands early by that much; a cut stays put", () => {
  const box = { x: 200, y: 150, width: 400, height: 200 };
  const ask = (c: Cam) => {
    c.frame(box, { arrive: 3 });
    c.cut({ cx: 1400, cy: 700, w: 640 }, 5);
    c.frame({ cx: 300, cy: 300, w: 900 }, { start: 6, dur: 0.5 });
    return c;
  };
  const plain = ask(camera({ content: { width: 1920, height: 1080 } }));
  const early = ask(camera({ content: { width: 1920, height: 1080 }, lead: 0.15 }));
  const [m0, cut, m2] = early.moves();
  near(m0?.t1 ?? 0, 2.85, 1e-9, "the frame lands");
  assert.equal(cut?.t0, 5);
  near(m2?.t0 ?? 0, 5.85, 1e-9, "the next move leaves");
  // the same path, only sooner, up to the cut (after it the move's start differs only by the shift too)
  for (let t = 0; t < 4.8; t += 0.01) {
    const a = early.at(t);
    const b = plain.at(t + 0.15);
    near(a.cx, b.cx, 1e-9, `cx at ${t}`);
    near(a.w, b.w, 1e-9, `w at ${t}`);
  }
  // one move can choose its own, including none
  const own = camera({ content: { width: 1920, height: 1080 }, lead: 0.2 });
  own.frame(box, { arrive: 3, lead: 0 });
  own.frame({ cx: 900, cy: 500, w: 1200 }, { arrive: 6, lead: 0.05 });
  near(own.moves()[0]?.t1 ?? 0, 3, 1e-9, "lead 0");
  near(own.moves()[1]?.t1 ?? 0, 5.95, 1e-9, "lead 0.05");
  assert.throws(() => own.frame(box, { arrive: 8, lead: Number.NaN }), /lead/);
});

test("keepInside: false — the camera centres what it is asked to, past the edge", () => {
  const corner = { x: 0, y: 0, width: 200, height: 200 };
  const kept = camera({ content: { width: 1920, height: 1080 } });
  kept.frame(corner, { arrive: 1 });
  assert.equal(kept.warnings().length, 1);

  const free = camera({ content: { width: 1920, height: 1080 }, keepInside: false });
  free.frame(corner, { arrive: 1 });
  assert.deepEqual(free.warnings(), []);
  const [x, y] = free.toView(100, 100, 30); // settled
  near(x ?? 0, 960, 1e-6, "the box centre is the picture's");
  near(y ?? 0, 540, 1e-6, "the box centre is the picture's");
  assert.equal(free.moves()[0]?.free, true);

  // one move at a time, too; a free move's curve is not reported for leaving
  const one = camera({ content: { width: 1920, height: 1080 } });
  one.frame(corner, { arrive: 1, keepInside: false, ease: (p) => p + Math.sin(Math.PI * p) * 0.5 });
  one.frame(corner, { arrive: 3 });
  assert.equal(one.at(2).cx, 100);
  assert.deepEqual(one.warnings(), [
    "frame at 3s: the content ends there — the view stops 207 px short of centring it",
  ]);
});

test('zoom: "log" — an even pace in scale, and what stays put on screen stays put', () => {
  const W = 1920;
  const H = 1080;
  const deep = { cx: 1300, cy: 300, w: W / 20 }; // ×20
  const lin = camera({ content: { width: W, height: H } });
  const log = camera({ content: { width: W, height: H }, zoom: "log" });
  for (const c of [lin, log]) c.frame(deep, { start: 1, dur: 2, ease: linear });

  // halfway in time, halfway in scale: ×√20, where px-even width would be ×1.9
  near(log.at(2).scale, Math.sqrt(20), 1e-9, "log halfway");
  near(lin.at(2).scale, W / ((W + W / 20) / 2), 1e-9, "linear halfway");
  // equal ratio per equal time
  const r1 = log.at(1.5).scale / log.at(1).scale;
  const r2 = log.at(3).scale / log.at(2.5).scale;
  near(r1, r2, 1e-9, "ratio per half second");
  // both land in the same place
  assert.equal(log.transform(3.5), lin.transform(3.5));

  // the point that both views put at the same place on screen never moves:
  // (p − c0) / w0 = (p − c1) / w1
  const p = [
    (960 * deep.w - deep.cx * W) / (deep.w - W),
    (540 * deep.w - deep.cy * W) / (deep.w - W),
  ];
  const [px0, py0] = log.toView(p[0] ?? 0, p[1] ?? 0, 0);
  for (let t = 1; t <= 3; t += 0.05) {
    const [px, py] = log.toView(p[0] ?? 0, p[1] ?? 0, t);
    near(px ?? 0, px0 ?? 0, 1e-6, `fixed x at ${t}`);
    near(py ?? 0, py0 ?? 0, 1e-6, `fixed y at ${t}`);
  }

  // a move that does not change scale is the same either way
  const panA = camera({ content: { width: W, height: H } });
  const panB = camera({ content: { width: W, height: H } });
  panA.cut({ cx: 500, cy: 400, w: 960 }, 0);
  panB.cut({ cx: 500, cy: 400, w: 960 }, 0);
  panA.frame({ cx: 1400, cy: 600, w: 960 }, { start: 1 });
  panB.frame({ cx: 1400, cy: 600, w: 960 }, { start: 1, zoom: "log" });
  for (let t = 1; t < 3; t += 0.05) {
    const a = panA.at(t);
    const b = panB.at(t);
    near(a.cx, b.cx, 1e-9, `pan cx at ${t}`);
    near(a.w, b.w, 1e-9, `pan w at ${t}`);
  }
  assert.throws(() => camera({ content: { width: W, height: H }, zoom: "exp" as "log" }), /zoom/);
});

test("handheld: a smooth wander, the same every render, inside its amplitude", () => {
  const make = (seed: number) => {
    const c = camera({
      content: { width: 1920, height: 1080 },
      handheld: { amp: 6, rot: 0.4, period: 2, seed },
    });
    c.frame({ cx: 700, cy: 400, w: 960 }, { arrive: 1 });
    return c;
  };
  const a = make(1);
  const b = make(1);
  const other = make(2);
  const plain = camera({ content: { width: 1920, height: 1080 } });
  plain.frame({ cx: 700, cy: 400, w: 960 }, { arrive: 1 });

  let moved = 0;
  let differs = 0;
  let prev = a.jitter(0);
  for (let i = 0; i <= 600; i++) {
    const t = i / 60;
    const j = a.jitter(t);
    assert.deepEqual(j, b.jitter(t));
    assert.equal(a.transform(t), b.transform(t));
    assert.ok(Math.abs(j.x) <= 6 + 1e-9 && Math.abs(j.y) <= 6 + 1e-9, `inside amp at ${t}`);
    assert.ok(Math.abs(j.rot) <= 0.4 + 1e-9, `inside rot at ${t}`);
    // a hand, not a rattle: well under a pixel a frame
    assert.ok(Math.hypot(j.x - prev.x, j.y - prev.y) < 0.5, `smooth at ${t}`);
    moved = Math.max(moved, Math.hypot(j.x, j.y));
    if (Math.abs(j.x - other.jitter(t).x) > 0.1) differs++;
    // the planned view is untouched; the picture carries the hand
    assert.deepEqual(a.at(t), plain.at(t));
    prev = j;
  }
  assert.ok(moved > 2, `it wanders (${moved} px)`);
  assert.ok(differs > 300, "another seed, another hand");
  assert.match(a.transform(4), /rotate\(/);

  // the picture and the content still map onto each other exactly
  for (const t of [0.3, 2.2, 7.9]) {
    const [x, y] = a.toView(812, 377, t);
    const [cx, cy] = a.toContent(x ?? 0, y ?? 0, t);
    near(cx ?? 0, 812, 1e-9, "round trip x");
    near(cy ?? 0, 377, 1e-9, "round trip y");
    const j = a.jitter(t);
    const [px, py] = plain.toView(812, 377, t);
    // without a tilt the hand is a plain offset
    const flat = camera({
      content: { width: 1920, height: 1080 },
      handheld: { amp: 6, period: 2, seed: 1 },
    });
    flat.frame({ cx: 700, cy: 400, w: 960 }, { arrive: 1 });
    const [fx, fy] = flat.toView(812, 377, t);
    near((fx ?? 0) - (px ?? 0), j.x, 1e-9, "offset x");
    near((fy ?? 0) - (py ?? 0), j.y, 1e-9, "offset y");
  }
});

test("shake: still before, a jolt from rest, dies away, still after; shakes add", () => {
  const c = camera({ content: { width: 1920, height: 1080 } });
  c.shake(2, { amp: 12, rot: 0.5, dur: 0.5 });
  const still = c.transform(1.99);
  assert.equal(still, "translate(0px, 0px) scale(1)");
  assert.deepEqual(c.jitter(2), { x: 0, y: 0, rot: 0 });
  assert.deepEqual(c.jitter(2.5), { x: 0, y: 0, rot: 0 });
  assert.equal(c.transform(3), still);

  // from rest: it grows out of zero (a frame later it may well be at full throw — that is a jolt)
  const first = c.jitter(2.001);
  assert.ok(Math.hypot(first.x, first.y) < 2, "it starts from rest");
  const peak = (t0: number, t1: number) => {
    let m = 0;
    for (let t = t0; t < t1; t += 1 / 240)
      m = Math.max(m, Math.hypot(c.jitter(t).x, c.jitter(t).y));
    return m;
  };
  const early = peak(2, 2.17);
  const late = peak(2.33, 2.5);
  assert.ok(early > 9 && early < 14, `about amp on its first swing (${early} px)`);
  assert.ok(late < early / 4, `and dies away (${early} → ${late})`);
  assert.ok(Math.abs(c.jitter(2.49).x) < 0.01, "almost still at its end");
  assert.ok(c.jitter(2.05).rot !== 0);

  // two at once add up
  const one = camera({ content: { width: 1920, height: 1080 } });
  const two = camera({ content: { width: 1920, height: 1080 } });
  one.shake(1, { seed: 3 });
  two.shake(1, { seed: 3 });
  two.shake(1.1, { seed: 4 });
  const solo = camera({ content: { width: 1920, height: 1080 } });
  solo.shake(1.1, { seed: 4 });
  for (let t = 0.9; t < 1.8; t += 0.01)
    near(two.jitter(t).x, one.jitter(t).x + solo.jitter(t).x, 1e-12, `sum at ${t}`);
  assert.throws(() => c.shake(Number.NaN), /time/);
  assert.throws(() => c.shake(1, { dur: 0 }), /dur/);
});

test("depth: 1 rides with the content, 0 holds still, between moves part of the way", () => {
  const c = camera({ content: { width: 1920, height: 1080 } });
  c.frame({ cx: 1400, cy: 300, w: 480 }, { start: 1, dur: 1 }); // ×4
  const near1 = c.depth(1);
  const still = c.depth(0);
  const far = c.depth(0.5);
  const rest = still.transform(0);
  for (let t = 0; t <= 4; t += 0.05) {
    assert.equal(near1.transform(t), c.transform(t));
    assert.equal(still.transform(t), rest);
  }
  // half the depth: half the zoom in log (×2 of ×4), half the way across
  const s = c.at(4).scale;
  near(s, 4, 1e-3, "settled");
  const [ox, oy] = far.toView(0, 0, 4);
  const [ux] = far.toView(1, 0, 4);
  near((ux ?? 0) - (ox ?? 0), Math.sqrt(s), 1e-9, "scale at k 0.5");
  const [mx, my] = far.toContent(960, 540, 4);
  const v = c.at(4);
  near(mx ?? 0, 960 + (v.cx - 960) * 0.5, 1e-9, "centre x at k 0.5");
  near(my ?? 0, 540 + (v.cy - 540) * 0.5, 1e-9, "centre y at k 0.5");
  void ox;
  void oy;

  // in front moves more than the content; the hand and shakes scale with k
  const fore = c.depth(1.5);
  const [a0] = fore.toView(960, 540, 0);
  const [a1] = fore.toView(960, 540, 4);
  const [b0] = c.toView(960, 540, 0);
  const [b1] = c.toView(960, 540, 4);
  assert.ok(Math.abs((a1 ?? 0) - (a0 ?? 0)) > Math.abs((b1 ?? 0) - (b0 ?? 0)));

  const shaken = camera({ content: { width: 1920, height: 1080 } });
  shaken.shake(1, { amp: 10 });
  const half = shaken.depth(0.5);
  const [hx] = half.toView(960, 540, 1.05);
  const [fx] = shaken.toView(960, 540, 1.05);
  near((hx ?? 0) - 960, ((fx ?? 0) - 960) * 0.5, 1e-9, "shake at k 0.5");
  assert.equal(shaken.depth(0).transform(1.05), "translate(0px, 0px) scale(1)");
  assert.throws(() => c.depth(Number.NaN), /factor/);
});

test("noise: seeded, smooth, rests on every whole number, stays near -1..1", () => {
  let max = 0;
  for (let x = 0; x < 50; x += 0.013) {
    const n = noise(x, 9);
    assert.equal(n, noise(x, 9));
    max = Math.max(max, Math.abs(n));
  }
  assert.ok(max <= 1 + 1e-9 && max > 0.3, `range (${max})`);
  for (let i = -5; i <= 5; i++) near(noise(i, 3), 0, 0, `at ${i}`);
  assert.notEqual(noise(0.5, 1), noise(0.5, 2));
});

test("a curve that leaves from a view past the edge is told apart from one that overshoots", () => {
  const mk = (ease: (p: number) => number, box = { x: 800, y: 400, width: 300, height: 200 }) => {
    const c = camera({ content: { width: 1920, height: 1080 } });
    c.frame({ x: 1800, y: 900, width: 200, height: 100 }, { arrive: 1, keepInside: false });
    c.frame(box, { start: 3, ease });
    return c.warnings().filter((w) => w.includes("overshoots"));
  };
  // heading back inside on a curve that does not overshoot: nothing to say
  assert.deepEqual(mk(linear), []);
  // one that throws the view further out than it started still is
  assert.equal(
    mk((p) => p + Math.sin(Math.PI * p) * 0.8, { x: 0, y: 0, width: 300, height: 200 }).length,
    1,
  );
});

test("handheld: the axes do not come to rest together; a period of 0 is refused", () => {
  const c = camera({ content: { width: 1920, height: 1080 }, handheld: { amp: 6, period: 2 } });
  // the first octave of each axis rests on whole periods; shifted apart, the
  // hand is not back at the centre every period
  const still = [2, 4, 6, 8, 10].filter((t) => {
    const j = c.jitter(t);
    return Math.hypot(j.x, j.y) < 1;
  });
  assert.ok(still.length < 3, `back at the centre at ${still.join(", ")} s`);
  assert.throws(
    () => camera({ content: { width: 1920, height: 1080 }, handheld: { period: 0 } }),
    /period/,
  );
});
