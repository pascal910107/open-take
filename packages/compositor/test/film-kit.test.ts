// The film kit (kit/*.js): the camera and cursor are ports of the take
// camera and cursor, so they are checked against them; then what the kit adds
// for films — authors' own timing, cuts, other picture shapes — and the
// mistakes it exists to prevent.

import assert from "node:assert/strict";
import { test } from "node:test";
import { camera, settleDecay as kitDecay, linear } from "../kit/camera.js";
import { cursor } from "../kit/cursor.js";
import { stillCache } from "../kit/media.js";
import { timeline } from "../kit/time.js";
import { type CamRect, type KF, settleDecay, settleRectAt } from "../src/math";

const near = (a: number, b: number, tol: number, what: string) =>
  assert.ok(Math.abs(a - b) <= tol, `${what}: ${a} vs ${b} (±${tol})`);

test("the kit camera settles exactly as the take camera does", () => {
  const a = kitDecay(0.04);
  const b = settleDecay(0.04);
  for (let u = 0; u <= 3; u += 0.01) near(a(u), b(u), 1e-12, `decay at ${u}`);

  // three moves; each starts while the one before is still settling
  const rest: CamRect = { cx: 960, cy: 540, w: 1920 };
  const A: CamRect = { cx: 600, cy: 300, w: 960 };
  const B: CamRect = { cx: 1400, cy: 700, w: 640 };
  const cam = camera({ content: { width: 1920, height: 1080 } });
  cam.frame(A, { start: 1, dur: 0.73 });
  cam.frame(B, { start: 2, dur: 0.73 });
  cam.rest({ start: 3, dur: 1.34 });
  const kfs: KF<CamRect>[] = [
    [0, rest],
    [1, rest],
    [1.73, A],
    [2, A],
    [2.73, B],
    [3, B],
    [4.34, rest],
  ];
  const decay = settleDecay(0.04);
  for (let t = 0; t <= 6; t += 0.01) {
    const k = cam.at(t);
    const r = settleRectAt(kfs, decay, t);
    near(k.cx, r.cx, 1e-9, `cx at ${t}`);
    near(k.cy, r.cy, 1e-9, `cy at ${t}`);
    near(k.w, r.w, 1e-9, `w at ${t}`);
  }
});

test("a pull-out next to the edge never stops short and swings back (a film's camera did)", () => {
  // the moves of an exploration film's 18.5–22 s shot, as views (w = 1920 / zoom):
  // its own camera clamped the centre every frame and reversed mid-move at 19.95 s
  const cam = camera({ content: { width: 1920, height: 1080 } });
  cam.cut({ cx: 690, cy: 840, w: 1920 / 1.55 }, 18.5);
  cam.frame({ cx: 690, cy: 830, w: 1920 / 1.62 }, { arrive: 19.5, dur: 1 });
  cam.frame({ cx: 900, cy: 330, w: 1920 / 1.15 }, { arrive: 20.2, dur: 0.7 });
  let prev = cam.at(19.5).cy;
  for (let t = 19.5; t < 22; t += 1 / 240) {
    const v = cam.at(t);
    assert.ok(
      v.cy <= prev + 1e-9,
      `the view only rises (at ${t.toFixed(3)} s: ${v.cy} after ${prev})`,
    );
    const h = v.w / (16 / 9);
    assert.ok(
      v.cy - h / 2 >= -1e-6 && v.cy + h / 2 <= 1080 + 1e-6,
      `inside the content at ${t.toFixed(3)} s`,
    );
    prev = v.cy;
  }
  assert.match(
    cam.warnings().join("\n"),
    /stops \d+ px short/,
    "the camera says why it cannot centre it",
  );
});

test("what is framed heads for its place in a straight line, whatever the zoom", () => {
  // a 1× → 2.4× push whose centre also travels: with the centre and the zoom
  // moved separately, content off the target swings out and back
  const cam = camera({ content: { width: 1920, height: 1080 } });
  cam.frame({ cx: 300, cy: 200, w: 800 }, { start: 0, dur: 1 });
  const watch = [
    { x: 100, y: 100 },
    { x: 960, y: 540 },
    { x: 1800, y: 1000 },
  ];
  for (const p of watch) {
    const at = (t: number) => cam.toView(p.x, p.y, t);
    const [x0 = 0, y0 = 0] = at(0);
    const [x1 = 0, y1 = 0] = at(3);
    let last = 0;
    for (let t = 0; t <= 3; t += 1 / 120) {
      const [x = 0, y = 0] = at(t);
      // progress along the straight line from start to end, and the distance off it
      const dx = x1 - x0;
      const dy = y1 - y0;
      const L = Math.hypot(dx, dy) || 1;
      const along = ((x - x0) * dx + (y - y0) * dy) / (L * L);
      const off = Math.abs((x - x0) * dy - (y - y0) * dx) / L;
      assert.ok(
        off < 1e-6,
        `(${p.x}, ${p.y}) stays on its line (${off} px off at ${t.toFixed(3)} s)`,
      );
      assert.ok(along >= last - 1e-9, `(${p.x}, ${p.y}) never goes back (at ${t.toFixed(3)} s)`);
      last = along;
    }
  }
});

test("an author's own timing is kept: a fast push, a curve of their own, a cut", () => {
  const cam = camera({ content: { width: 1920, height: 1080 } });
  const B = { cx: 1200, cy: 600, w: 700 };
  cam.frame(B, { start: 2, dur: 0.25, ease: linear });
  const mid = cam.at(2.125);
  near(mid.cx, (960 + 1200) / 2, 1e-9, "halfway, linearly");
  near(cam.at(2.25).cx, 1200, 1e-9, "landed exactly on time");
  near(cam.at(2.25).w, 700, 1e-9, "landed exactly on time");
  const [first] = cam.moves();
  near(first!.t1 - first!.t0, 0.25, 1e-12, "the duration asked for");
  // a cut shows its view from its instant on, with no move into it
  cam.cut({ cx: 500, cy: 400, w: 1000 }, 5);
  near(cam.at(4.999).cx, 1200, 1e-9, "before the cut");
  near(cam.at(5).cx, 500, 1e-9, "at the cut");
  // a move that starts at the cut's instant leaves from the cut's view
  cam.frame({ cx: 900, cy: 500, w: 900 }, { start: 5, dur: 1, ease: linear });
  near(cam.at(5).cx, 500, 1e-9, "the move leaves from the cut");
  near(cam.at(5.5).cx, 700, 1e-9, "halfway from the cut's view");
  // two cuts at one instant: which wins would be a guess
  cam.cut({ cx: 300, cy: 300, w: 600 }, 8);
  cam.cut({ cx: 1600, cy: 800, w: 600 }, 8);
  assert.throws(() => cam.at(9), /same instant/);
});

test("a move that starts mid-move leaves from where the camera is", () => {
  const cam = camera({ content: { width: 1920, height: 1080 } });
  cam.frame({ cx: 400, cy: 300, w: 900 }, { start: 1 });
  cam.frame({ cx: 1500, cy: 800, w: 600 }, { start: 1.3 });
  const before = cam.at(1.3 - 1e-7);
  const after = cam.at(1.3 + 1e-7);
  near(before.cx, after.cx, 1e-3, "no jump in x");
  near(before.w, after.w, 1e-3, "no jump in width");
});

test("a picture of another shape: a vertical film sees the whole page centred, then frames a part", () => {
  const cam = camera({
    content: { width: 1920, height: 1080 },
    view: { width: 1080, height: 1920 },
  });
  const [x0, y0] = cam.toView(0, 0, 0);
  near(x0!, 0, 1e-9, "the page's left edge on the picture's");
  near(y0!, (1920 - 1080 * (1080 / 1920)) / 2, 1e-9, "the page centred top to bottom");
  cam.frame({ x: 100, y: 100, width: 300, height: 200 }, { arrive: 2 });
  const v = cam.at(4);
  // the box fills 60 % of the picture in its limiting direction (here its width)
  near(300 / v.w, 0.6, 1e-3, "a framed box fills 60 %");
});

test("a curve that overshoots past the content's edge is reported", () => {
  const cam = camera({ content: { width: 1920, height: 1080 } });
  const back = (p: number) => 1 + 2.7 * (p - 1) ** 3 + 1.7 * (p - 1) ** 2;
  // a push in that overshoots only closes in further, inside; a pan toward an
  // edge that overshoots carries the view past it
  cam.frame({ cx: 1500, cy: 800, w: 640 }, { start: 0, dur: 1, ease: back });
  assert.doesNotMatch(cam.warnings().join("\n"), /overshoots/, "closing in further stays inside");
  cam.cut({ cx: 960, cy: 540, w: 960 }, 2);
  cam.frame({ cx: 1400, cy: 540, w: 960 }, { start: 2.5, dur: 1, ease: back });
  assert.match(cam.warnings().join("\n"), /frame at 2\.5s: its curve overshoots/);
});

test("the kit cursor keeps the take cursor's pace: 0.35 content widths a second, 0.30–0.85 s a leg", () => {
  const legOf = (dist: number) => {
    const cur = cursor({ content: { width: 1920, height: 1080 }, start: { x: 100, y: 500 } });
    cur.click({ x: 100 + dist, y: 500 }, 5);
    const [leg] = cur.legs();
    return leg!.t1 - leg!.t0;
  };
  near(legOf(300), 300 / (0.35 * 1920), 1e-9, "a mid-length move at the speed");
  near(legOf(60), 0.3, 1e-9, "a hop takes the shortest leg");
  near(legOf(1500), 0.85, 1e-9, "a crossing is capped");
  const cur = cursor({ content: { width: 1920, height: 1080 }, start: { x: 100, y: 500 } });
  cur.click({ x: 700, y: 500 }, 5);
  const c = cur.at(5);
  near(c.x, 700, 1e-9, "on the target at the click");
  assert.equal(c.ripple, 0);
  near(cur.at(5.45).ripple!, 1, 1e-9, "the ripple spreads over 0.45 s");
  assert.equal(cur.at(5.5).ripple, null);
  // the arc: halfway along, 5 % of the leg off the straight line (24 px at most)
  const [leg] = cur.legs();
  const mid = cur.at((leg!.t0 + leg!.t1) / 2);
  near(Math.abs(mid.y - 500), 24, 1e-6, "a gentle arc");
});

test("zoomed in, the cursor is timed by the distance the viewer sees", () => {
  const cam = camera({ content: { width: 1920, height: 1080 } });
  cam.frame({ cx: 960, cy: 540, w: 960 }, { arrive: 1 }); // 2×, settled long before the click
  const cur = cursor({ camera: cam, start: { x: 900, y: 540 } });
  cur.click({ x: 1050, y: 540 }, 5);
  const [leg] = cur.legs();
  // 150 page px at 2× is 300 picture px: twice the unzoomed time (0.223 s → 0.446 s)
  near(leg!.t1 - leg!.t0, (150 / (0.35 * 1920)) * 2, 0.006, "twice as long at twice the zoom");
  const c = cur.at(5);
  const [sx, sy] = cam.toView(1050, 540, 5);
  near(c.sx, sx!, 1e-9, "its place in the picture");
  near(c.sy, sy!, 1e-9, "its place in the picture");
});

test("the cursor waits for typing to end, and holds the button through a drag", () => {
  const cur = cursor({ content: { width: 1920, height: 1080 }, start: { x: 100, y: 100 } });
  cur.type({ x: 400, y: 300, width: 200, height: 40 }, 2, 6);
  cur.click({ x: 1500, y: 800 }, 6.2);
  const legs = cur.legs();
  assert.ok(
    legs[1]!.t0 >= 6,
    `the move to the button leaves after the typing ends (${legs[1]!.t0})`,
  );
  cur.drag(
    [
      { x: 1500, y: 800 },
      { x: 1700, y: 800 },
    ],
    7,
    8,
  );
  assert.equal(cur.at(6.9).down, false);
  assert.equal(cur.at(7.5).down, true);
  near(cur.at(8).x, 1700, 1e-9, "at the end of the stroke");
});

test("one timeline for picture and sound: names, beats, progress", () => {
  const tl = timeline({ bpm: 120, offset: 0.25, at: { search: 2.5, hook: 0, result: 4 } });
  assert.equal(tl.t("search"), 2.5);
  assert.equal(tl.local(2.5, "search", 0.5), 0);
  assert.equal(tl.local(2.75, "search", 0.5), 0.5);
  assert.equal(tl.local(9, "search", 0.5), 1);
  assert.equal(tl.beat(4), 2.25);
  assert.equal(tl.snap(2.4), 2.25);
  assert.equal(tl.beatOf(2.26), 4);
  assert.ok(tl.between(3, "search", "result"));
  assert.deepEqual(
    tl.events().map((e) => e.id),
    ["hook", "search", "result"],
  );
  assert.throws(() => tl.t("nope"), /no moment named/);
  assert.throws(() => timeline({}).beat(1), /no bpm/);
});

test("the still cache bounds what is still loading, not just what it holds", async () => {
  // shown stills decode at once; the ones fetched ahead never finish — the
  // case that used to leave a decode in flight for every still shown
  let cancelled = 0;
  let opened = 0;
  const cache = stillCache({
    keep: 12,
    ahead: 3,
    count: 100,
    open: (i: number) => {
      opened++;
      return {
        ready: i % 2 === 0 ? Promise.resolve(i) : new Promise<number>(() => {}),
        cancel: () => {
          cancelled++;
        },
      };
    },
  });
  let most = 0;
  for (let i = 0; i < 100; i += 2) {
    assert.equal(await cache.take(i), i);
    most = Math.max(most, cache.loading());
    assert.ok(cache.size <= 12, `held ${cache.size}`);
  }
  assert.ok(most <= 4, `at most the wanted still and 3 ahead loading at once (saw ${most})`);
  assert.ok(cancelled > 0, "stills pushed out while loading were cancelled");
  assert.ok(opened < 100, `not every still was fetched (${opened})`);
});

test("many tiny cursor moves add up to where they lead", () => {
  const cur = cursor({ content: { width: 1920, height: 1080 }, start: { x: 100, y: 100 } });
  for (let i = 1; i <= 100; i++) cur.move({ x: 100 + i * 0.4, y: 100 }, i / 60, { dur: 1 / 60 });
  near(cur.at(2).x, 140, 1e-9, "the last of a hundred 0.4 px steps");
  near(cur.at(50 / 60).x, 120, 1e-9, "halfway along");
});
