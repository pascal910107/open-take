// The film kit's stage (kit/stage.js): slabs where their parts sat until
// moved, each field moving on its own, a slab square on to the lens written
// as a 2D transform, a tilted one with its own perspective, the camera's view
// framing the stage, the warnings for a tilted slab bigger than the frame,
// and the moves made of moves — explode, together, drop, stack, flip, turn,
// dolly. Every frame comes out the same, in any order.

import assert from "node:assert/strict";
import { test } from "node:test";
import { camera } from "../kit/camera.js";
import { drop, explode, flip, stack, stage, together } from "../kit/stage.js";

const near = (a: number, b: number, tol: number, what: string) =>
  assert.ok(Math.abs(a - b) <= tol, `${what}: ${a} vs ${b} (±${tol})`);

const card = { x: 600, y: 300, width: 700, height: 300 };

/** the numbers of a CSS matrix()/matrix3d() */
const nums = (tf: string) =>
  /\(([^)]*)\)/
    .exec(tf)![1]!
    .split(",")
    .map((n) => Number(n));

/** a point of the slab (its own px) through a matrix3d, as CSS maps it */
function through(tf: string, x: number, y: number) {
  const m = nums(tf);
  const w = m[3]! * x + m[7]! * y + m[15]!;
  return { x: (m[0]! * x + m[4]! * y + m[12]!) / w, y: (m[1]! * x + m[5]! * y + m[13]!) / w };
}

test("a slab never moved sits where its part sat: square on, a plain 2D transform", () => {
  const st = stage();
  st.slab(null, { box: card });
  const [s] = st.at(3);
  assert.equal(s!.flat, true);
  assert.equal(s!.style.transform, "matrix(1, 0, 0, 1, 600, 300)");
  assert.deepEqual(
    s!.quad.map((q) => [Math.round(q.x), Math.round(q.y)]),
    [
      [600, 300],
      [1300, 300],
      [1300, 600],
      [600, 600],
    ],
  );
  near(s!.area, 700 * 300, 1e-6, "its area");
  assert.equal(s!.soft, false);
  assert.equal(s!.style.visibility, "visible");
  assert.deepEqual(st.warnings(), []);
});

test("a tilted slab carries its own perspective; its quad is where CSS draws its corners", () => {
  const st = stage({ perspective: 2000 });
  const sl = st.slab(null, { box: card });
  sl.to({ rx: 20, ry: 28 }, { start: 1 });
  const s = st.at(5)[0]!;
  assert.equal(s.flat, false);
  assert.match(s.style.transform, /^matrix3d\(/);
  const m = nums(s.style.transform);
  assert.ok(m[11]! < 0, "a perspective in the slab's own transform (m34)");
  // the corners the matrix gives are the quad
  for (const [i, [x, y]] of [
    [0, 0],
    [700, 0],
    [700, 300],
    [0, 300],
  ].entries()) {
    const p = through(s.style.transform, x!, y!);
    near(p.x, s.quad[i]!.x, 1e-3, `corner ${i} x`);
    near(p.y, s.quad[i]!.y, 1e-3, `corner ${i} y`);
  }
  // ry positive turns its right side away: smaller than its left
  const left = s.quad[3]!.y - s.quad[0]!.y;
  const right = s.quad[2]!.y - s.quad[1]!.y;
  assert.ok(right < left, `right edge ${right} shorter than left ${left}`);
  // square on again: 2D once more, where it sat
  sl.to({ rx: 0, ry: 0 }, { start: 6, dur: 0.5, ease: (p) => p });
  const back = st.at(7)[0]!;
  assert.equal(back.flat, true);
  assert.equal(back.style.transform, "matrix(1, 0, 0, 1, 600, 300)");
});

test("each field moves on its own: a later move of one field leaves the others moving", () => {
  const st = stage();
  const sl = st.slab(null, { box: card });
  sl.to({ z: 300 }, { start: 0, dur: 1 });
  sl.to({ opacity: 0.5 }, { start: 0.5, dur: 0.2, ease: (p) => p });
  // the z move is not cut by the opacity move
  const mid = sl.pose(0.6);
  const alone = stage().slab(null, { box: card });
  alone.to({ z: 300 }, { start: 0, dur: 1 });
  near(mid.z, alone.pose(0.6).z, 1e-9, "z as if alone");
  near(mid.opacity, 0.75, 1e-9, "opacity halfway");
  // the camera's settle: 96 % of the way in its time, the rest into the hold
  near(sl.pose(1).z, 0.96 * 300, 1e-6, "96 % at dur");
  near(sl.pose(4).z, 300, 0.5, "settled");
  // a later move of z starts from wherever z is
  sl.to({ z: 0 }, { start: 1.2, dur: 0.3, ease: (p) => p });
  const at = sl.pose(1.2).z;
  near(sl.pose(1.35).z, at / 2, 1e-6, "halfway back from where it was");
  // arrive: lands then
  const a = stage().slab(null, { box: card });
  a.to({ rz: 10 }, { arrive: 2, dur: 0.5, ease: (p) => p });
  near(a.pose(1.5).rz, 0, 1e-12, "not yet left");
  near(a.pose(2).rz, 10, 1e-12, "landed");
  assert.throws(() => a.to({ rz: 1 }, {} as never), /needs \{ arrive \} or \{ start \}/);
  assert.throws(() => a.to({ spin: 1 } as never, { start: 0 }), /no pose field "spin"/);
});

test("the camera frames the stage: its zoom scales a square-on slab in 2D, the vanishing point is its centre", () => {
  const cam = camera({ content: { width: 1920, height: 1080 } });
  cam.cut({ x: 600, y: 300, width: 700, height: 300 }, 0);
  const st = stage({ camera: cam });
  st.slab(null, { box: card });
  const v = cam.at(1);
  const s = st.at(1)[0]!;
  assert.equal(s.flat, true);
  const m = nums(s.style.transform);
  near(m[0]!, v.scale, 1e-6, "the camera's zoom");
  // the card's centre is the view's centre, in the middle of the picture
  const cx = (s.quad[0]!.x + s.quad[2]!.x) / 2;
  const cy = (s.quad[0]!.y + s.quad[2]!.y) / 2;
  near(cx, 960, 1e-6, "centred across");
  near(cy, 540, 1e-6, "centred down");
  // nearer the lens, square on, at the view's centre: bigger, still centred, still 2D
  const st2 = stage({ camera: cam });
  st2.slab(null, { box: card, rest: { z: 500 } });
  const s2 = st2.at(1)[0]!;
  assert.equal(s2.flat, true);
  near(s2.area, s.area * (2000 / 1500) ** 2, 1e-3 * s.area, "d / (d − z) bigger each way");
  near((s2.quad[0]!.x + s2.quad[2]!.x) / 2, 960, 1e-6, "still centred");
});

test("a tilted slab bigger than the frame is named, with when; square on at that size it is not", () => {
  const cam = camera({ content: { width: 1920, height: 1080 } });
  cam.cut({ x: 760, y: 330, width: 400, height: 240 }, 0); // about 2.9×
  const st = stage({ camera: cam });
  const big = st.slab(null, {
    box: { x: 560, y: 250, width: 800, height: 500 },
    name: "screenshot",
  });
  big.to({ ry: 15 }, { start: 1, dur: 0.5, ease: (p) => p });
  big.to({ ry: 0 }, { start: 2, dur: 0.5, ease: (p) => p });
  assert.equal(st.at(0.5)[0]!.soft, false, "square on: drawn at its final scale");
  assert.equal(st.at(1.6)[0]!.soft, true);
  const w = st.warnings();
  assert.equal(w.length, 1);
  assert.match(w[0]!, /^screenshot: tilted and bigger than the frame 1\.0\d–2\.\d\d s/);
  // a part-sized slab under the same camera and tilt is fine
  const st2 = stage({ camera: cam });
  st2.slab(null, { box: { x: 860, y: 400, width: 200, height: 100 } }).to({ ry: 15 }, { start: 1 });
  assert.deepEqual(st2.warnings(), []);
});

test("flip: the front turns away and hides, the back turns in from behind", () => {
  const st = stage();
  const front = st.slab(null, { box: card, name: "front" });
  const back = st.slab(null, { box: card, name: "back" });
  flip(front, back, { start: 1, dur: 0.6, ease: (p) => p });
  const before = st.at(0.9);
  assert.equal(before[0]!.style.visibility, "visible");
  assert.equal(before[1]!.style.visibility, "visible", "the back sits square on until the flip");
  const early = st.at(1.1); // 60° in
  assert.equal(early[0]!.style.visibility, "visible");
  assert.equal(early[1]!.style.visibility, "hidden", "the back faces away");
  const late = st.at(1.5); // 120° in
  assert.equal(late[0]!.style.visibility, "hidden");
  assert.equal(late[1]!.style.visibility, "visible");
  const after = st.at(2);
  assert.equal(after[1]!.flat, true);
  assert.equal(after[1]!.style.transform, "matrix(1, 0, 0, 1, 600, 300)");
  // a slab whose back is to be seen is not hidden
  const st2 = stage();
  st2.slab(null, { box: card, backface: "visible", rest: { ry: 150 } });
  assert.equal(st2.at(0)[0]!.style.visibility, "visible");
});

test("drop: from 1.25× its size, faded in, a 3 % bounce, down where it rests", () => {
  const st = stage();
  const sl = st.slab(null, { box: card, shadow: 1 });
  drop(sl, { start: 1 });
  near(sl.pose(1).z, 400, 1e-9, "starts 400 px up");
  near(sl.pose(1).opacity, 0, 1e-9, "unseen at first");
  assert.equal(sl.pose(1.2).opacity, 1);
  let lowest = 0;
  for (let t = 1; t < 3; t += 0.001) lowest = Math.min(lowest, sl.pose(t).z);
  near(lowest, -0.12 * 400, 1.5, "swings 12 % of its fall past its rest");
  near(sl.pose(3).z, 0, 0.5, "comes to rest");
  // up, its shadow is wide and soft; down, close and sharp
  const up = st.at(1.02)[0]!.style.boxShadow;
  const down = st.at(3)[0]!.style.boxShadow;
  const blurOf = (s: string) => Number(/ ([\d.]+)px rgba/.exec(s)![1]);
  assert.ok(blurOf(up) > blurOf(down) * 2, `${up} vs ${down}`);
  // tilted, it lands square
  const t2 = stage().slab(null, { box: card });
  drop(t2, { start: 0, tilt: { rz: -8 } });
  near(t2.pose(0).rz, -8, 1e-9, "falls tilted");
  near(t2.pose(3).rz, 0, 0.2, "lands square");
});

test("stack: one after another on one place, each a sheet above the last", () => {
  const st = stage();
  const list = [0, 1, 2].map((i) => st.slab(null, { box: card, name: `card ${i}` }));
  stack(list, { start: 0, rz: [-5, 4, -1] });
  near(list[1]!.pose(0.15).opacity, 0, 1e-9, "the second not yet dropped");
  near(list[1]!.pose(0.16).z, 400 + 6, 1e-9, "the second leaves 0.16 s later");
  for (const [i, sl] of list.entries()) {
    near(sl.pose(4).z, i * 6, 0.5, `card ${i} rests ${i * 6} px up`);
    near(sl.pose(4).rz, [-5, 4, -1][i]!, 1e-9, `card ${i} lies at its angle`);
  }
  // the nearest is drawn on top
  const z = st.at(4).map((s) => Number(s.style.zIndex));
  assert.deepEqual(z, [1, 2, 3]);
});

test("explode and together: layers a gap apart, then back where they sat", () => {
  const st = stage();
  const list = [0, 1, 2].map((i) =>
    st.slab(null, { box: { x: 100 + i * 500, y: 200, width: 400, height: 300 } }),
  );
  explode(list, { start: 0, gap: 150, spread: 0.5 });
  for (const [i, sl] of list.entries()) near(sl.pose(3).z, i * 150, 0.5, `layer ${i}`);
  near(list[0]!.pose(3).x, -250, 0.5, "pushed out from their middle");
  near(list[1]!.pose(3).x, 0, 1e-9, "the middle one stays");
  together(list, { start: 4 });
  for (const sl of list) {
    const p = sl.pose(8);
    near(p.z, 0, 0.5, "down");
    near(p.x, 0, 0.5, "in place");
  }
});

test("turn and dolly: the whole stage tilts about its pivot; the lens passes a slab, which fades and is gone", () => {
  const st = stage();
  st.slab(null, { box: { x: 0, y: 0, width: 1920, height: 540 }, name: "top" });
  st.turn({ rx: 40 }, { start: 0 });
  near(st.world(5).rx, 40, 0.01, "turned");
  const s = st.at(5)[0]!;
  assert.equal(s.flat, false);
  // the top half, tipped away about the middle of the stage, reads smaller
  assert.ok(s.area < 1920 * 540, `${s.area}`);
  // the lens travels up to and past a square-on card
  const st2 = stage();
  st2.slab(null, { box: card, name: "card" });
  st2.dolly(2200, { start: 0, dur: 1, ease: (p) => p });
  assert.equal(st2.at(0.3)[0]!.style.opacity, "1");
  assert.equal(st2.at(0.3)[0]!.flat, true, "square on, drawn in 2D however big");
  const fading = Number(st2.at(0.85)[0]!.style.opacity);
  assert.ok(fading > 0 && fading < 1, `fading near the lens: ${fading}`);
  assert.equal(st2.at(1)[0]!.style.visibility, "hidden", "past it, gone");
});

test("a frame is the same twice, in any order, and the stage writes onto its slabs' elements", () => {
  const make = () => {
    const st = stage();
    const a = st.slab(null, { box: card, sheen: 0.5, blur: 4 });
    const b = st.slab(null, { box: { x: 100, y: 100, width: 300, height: 200 } });
    a.to({ ry: 30, z: 200 }, { start: 0.2, spring: { overshoot: 0.2 } });
    explode([b, a], { start: 1 });
    st.turn({ rx: 15 }, { start: 0.5 });
    return st;
  };
  const one = make();
  const two = make();
  const times = [0, 0.4, 1.3, 0.9, 2.5, 0.1];
  const forward = times.map((t) => JSON.stringify(one.at(t)));
  const backward = [...times].reverse().map((t) => JSON.stringify(two.at(t)));
  assert.deepEqual(forward, backward.reverse());
  const s = one.at(1.3)[0]!;
  assert.ok(s.sheen && s.sheen.opacity > 0, "a sheen while it is turned");
  assert.match(s.style.filter, /^blur\(/, "blurred off the focus");
  // with an element to put slabs in (a stand-in for the DOM's): one per slab, styled by apply()
  const made: {
    style: Record<string, string>;
    dataset: Record<string, string>;
    children: unknown[];
  }[] = [];
  const el = (() => ({
    style: {} as Record<string, string>,
    dataset: {} as Record<string, string>,
    children: [] as unknown[],
    appendChild(c: unknown) {
      this.children.push(c);
      return c;
    },
    setAttribute() {},
  })) as () => (typeof made)[number] & { appendChild(c: unknown): unknown };
  const g = globalThis as { document?: unknown };
  const had = g.document;
  g.document = {
    createElement: () => {
      const e = el();
      made.push(e);
      return e;
    },
  };
  try {
    const host = el();
    const st = stage({ el: host as unknown as HTMLElement });
    const sl = st.slab(null, { box: card, name: "card" });
    assert.ok(sl.el, "the slab has an element");
    assert.equal(host.children.length, 1);
    sl.to({ ry: 20 }, { start: 0 });
    st.apply(2);
    assert.match(made[0]!.style.transform!, /^matrix3d\(/);
    assert.equal(made[0]!.style.width, "700px");
    assert.equal(made[0]!.dataset.otSlab, "card");
  } finally {
    g.document = had;
  }
});

test("adopt: an element where it sits — untouched at rest, only its move written", () => {
  const style: Record<string, string> = { visibility: "hidden", zIndex: "3" };
  const el = { style } as unknown as HTMLElement;
  const st = stage();
  const shot = st.adopt(el, { box: { x: 200, y: 100, w: 800, h: 450 } });
  assert.equal(style.transformOrigin, "0 0");
  st.apply(0);
  assert.equal(style.transform, "", "at rest: no transform at all");
  assert.equal(style.opacity, "");
  assert.equal(style.visibility, "hidden", "the page's own visibility (scenes') is left alone");
  assert.equal(style.zIndex, "3", "and its stacking");
  shot.to({ rx: 7, ry: -9 }, { start: 1, dur: 0.7 });
  shot.to({ rx: 0, ry: 0 }, { arrive: 3 });
  st.apply(1.7);
  assert.match(style.transform, /^matrix3d\(/, "tilted: a 3D transform from where it sits");
  // its picture corners: the same quad a slab in the stage's corner space would have
  const s = st.at(1.7)[0]!;
  const ref = stage().slab(null, { box: { x: 200, y: 100, w: 800, h: 450 } });
  ref.to({ rx: 7, ry: -9 }, { start: 1, dur: 0.7 });
  ref.to({ rx: 0, ry: 0 }, { arrive: 3 });
  const q = ref.pose(1.7);
  assert.deepEqual(shot.pose(1.7), q);
  assert.ok(
    Math.abs(s.quad[0]!.x - 200) < 60 && Math.abs(s.quad[0]!.y - 100) < 60,
    "quad in picture space",
  );
  st.apply(5);
  assert.equal(style.transform, "", "square on again: as it was");
  assert.equal(style.visibility, "hidden");
});

test("adopt: an element with no size and no box is refused", () => {
  const el = { style: {}, offsetWidth: 0, offsetHeight: 0 } as unknown as HTMLElement;
  assert.throws(() => stage().adopt(el), /no size where it sits/);
  assert.throws(() => stage().adopt(null as never), /adopt takes an element/);
});
