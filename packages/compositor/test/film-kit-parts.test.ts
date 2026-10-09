// The product's parts as references (kit/media.js product()): one part
// followed through the saved screens it is on, where it shows through the
// screens played, where they are drawn and the camera; the camera and the
// cursor taking a part as they take a box; a drag in step with the stills
// saved along it. On a small synthetic shoot gathered as components.json —
// no browser.

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { camera } from "../kit/camera.js";
import { cursor } from "../kit/cursor.js";
import { clip, productFrom, smootherstep, throughCamera } from "../kit/media.js";
import { type ComponentsFile, gatherComponents, readComponentSource } from "../src/film/components";
import { writePartsShoot } from "./fixtures/parts-shoot";

let dir = "";
let components: ComponentsFile;
// biome-ignore lint/suspicious/noExplicitAny: the logs as JSON
let log: any;
// biome-ignore lint/suspicious/noExplicitAny: the logs as JSON
const indexes: Record<string, any> = {};
before(() => {
  dir = mkdtempSync(join(tmpdir(), "open-take-parts-test-"));
  writePartsShoot(dir);
  components = gatherComponents(readComponentSource(dir));
  log = JSON.parse(readFileSync(join(dir, "shots.json"), "utf8"));
  for (const s of components.states)
    indexes[s.id] = JSON.parse(readFileSync(join(dir, "states", s.id, "index.json"), "utf8"));
});
after(() => {
  rmSync(dir, { recursive: true, force: true });
});

const P = (o = {}) => productFrom({ components, log, indexes, ...o });
const near = (a: number, b: number, tol: number, what: string) =>
  assert.ok(Math.abs(a - b) <= tol, `${what}: ${a} vs ${b} (±${tol})`);
const box = (x: number, y: number, width: number, height: number) => ({ x, y, width, height });

test("a part by ref, by track and by its text — followed through every screen it is on", () => {
  const p = P();
  const heading = p.part("home:e2");
  assert.equal(heading.ref, "home:e2");
  assert.equal(heading.kind, "heading");
  // it moved down on add-1 and stayed: linked by the element before it
  assert.equal(heading.in("add-1"), "add-1:e2");
  assert.equal(heading.in("n-4"), "n-4:e2");
  assert.deepEqual(heading.box("add-1"), box(40, 60, 200, 30));
  assert.equal(heading.states.length, 7);

  const n = p.part("t1");
  assert.equal(n.track, "t1");
  assert.equal(n.ref, "home:e4");
  assert.equal(n.in("n-2"), "n-2:e4");
  assert.deepEqual(
    n.states.map((s) => s.value),
    [3, 4, 5, 6, 7, 8, 9],
  );
  // the same part again: the same reference — and a step's ref is its track
  assert.equal(p.part("t1"), n);
  assert.equal(p.part(n), n);
  assert.equal(p.part("n-2:e4"), n);

  assert.equal(p.part({ text: "Counter" }).ref, "home:e2");
  // { up } walks out by index.json's paths; an element no part names is a
  // part too, by index.json alone
  const body = p.part({ text: "Add", up: 1 });
  assert.equal(body.ref, "home:e1");
  // found on another screen by the same text there; by its ref alone, not
  assert.equal(body.in("add-2"), "add-2:e1");
  assert.equal(p.part("home:e1").in("add-2"), null);
});

test("in(): the track first, then the element before, then repeats", () => {
  // without the links components.json now writes, a part that moved is lost
  // and one that stayed in place is still found by its repeat
  const bare = structuredClone(components);
  for (const e of bare.components) delete e.before;
  const p = productFrom({ components: bare, log, indexes });
  assert.equal(p.part("home:e2").in("add-1"), null);
  assert.equal(p.part("home:e3").in("add-1"), "add-1:e3");
  // a part named on a later screen is followed back
  assert.equal(P().part("n-3:e2").in("home"), "home:e2");

  // where they disagree on one screen, the track wins over the element
  // before, and the element before over a repeat
  const odd = structuredClone(components);
  const entry = (ref: string) => odd.components.find((e) => e.ref === ref)!;
  // the track says the number is the heading on add-1; the link before
  // still says e4
  odd.tracks[0]!.steps[1]!.ref = "add-1:e2";
  assert.equal(entry("add-1:e4").before, "home:e4");
  assert.equal(productFrom({ components: odd, log, indexes }).part("t1").in("add-1"), "add-1:e2");
  // the button moved on add-2, linked by the element before; the heading
  // there called a repeat of it as well
  const button = structuredClone(components);
  const b = button.components.find((e) => e.ref === "add-2:e2")!;
  b.repeats = "add-1:e3";
  assert.equal(
    productFrom({ components: button, log, indexes }).part("add-1:e3").in("add-2"),
    "add-2:e3",
  );
});

test("no match throws, naming what there is", () => {
  const p = P();
  assert.throws(
    () => p.part("t9"),
    /product: no part t9 — it has 21 part\(s\).*tracks t1, screens home, add-1/,
  );
  assert.throws(() => p.part({ text: "Nothing" }), /no part \{ text: "Nothing" \}/);
  assert.throws(() => p.part("home:e99"), /no part home:e99/);
  assert.throws(() => P({ states: ["nope"] }), /no screen nope/);
  assert.throws(() => p.part("home:e1").box("add-2"), /not on the screen add-2 — it is on home/);
});

test("screens left out by { states }: a part is read on the first screen it is on; one on none is refused", () => {
  const p = P({ states: ["n-1", "n-2"] });
  const heading = p.part("home:e2");
  assert.equal(heading.at(1).state, "n-1");
  assert.deepEqual(heading.box(), box(40, 60, 200, 30));
  const cam = camera({ content: { width: 640, height: 360 } });
  cam.frame(heading, { arrive: 2 });
  assert.equal(cam.moves().length, 1);
  assert.throws(() => p.part("home:e1"), /home:e1 is on none of the screens read \(n-1, n-2\)/);
});

test("where the screen is drawn: a seam, a box, { x, y, scale }, a function of t", () => {
  const b = box(40, 20, 200, 30);
  const cases: [unknown, { x: number; y: number; width: number; height: number }][] = [
    [undefined, b],
    [{ scale: 2, offset: { x: 10, y: 20 } }, box(90, 60, 400, 60)],
    [box(100, 50, 1280, 720), box(180, 90, 400, 60)],
    [{ x: 5, y: 6, scale: 0.5 }, box(25, 16, 100, 15)],
    [() => ({ x: 1, y: 2, scale: 1 }), box(41, 22, 200, 30)],
  ];
  for (const [place, want] of cases) {
    const p = P();
    // biome-ignore lint/suspicious/noExplicitAny: each kind of place
    if (place) p.view({ place: place as any });
    assert.deepEqual(p.part("home:e2").boxAt(0), want, JSON.stringify(place));
  }
});

test("at(t): screen → stage → picture through the camera; the frame; what draws it", () => {
  const p = P();
  const cam = camera({ content: { width: 1280, height: 720 } });
  cam.frame(box(300, 200, 80, 40), { arrive: 2 });
  p.view({ place: { x: 0, y: 0, scale: 2 }, cam });
  const n = p.part("t1");
  for (const t of [0, 1.5, 2, 3]) {
    const a = n.at(t);
    assert.deepEqual(a.picture, throughCamera(a.stage, cam, t));
    assert.deepEqual(a.stage, box(600, 400, 160, 80));
  }
  assert.equal(n.at(0).inFrame, 1);
  // framed at 60 % of the picture: inside it; a box half past the edge is half in
  const q = P().view({ frame: { width: 640, height: 360 } });
  assert.equal(q.part("t1").at(0).inFrame, 1);
  q.view({ place: { x: 300, y: 0, scale: 1 } });
  near(q.part("t1").at(0).inFrame, 0.5, 1e-9, "half off the right edge");
  // a still drawn at its own 2× px: one picture px per still px
  const s = P()
    .view({ place: { x: 0, y: 0, scale: 2 } })
    .play([[0, { still: 3 }]]);
  const at = s.part("t1").at(0);
  assert.equal(at.drawn, "still");
  assert.equal(at.state, "n-1");
  assert.equal(at.sourcePx, 1);
  // a saved screen is the page itself: no px of its own to count
  assert.equal(
    P()
      .play([[0, "home"]])
      .part("t1")
      .at(0).sourcePx,
    undefined,
  );
});

test("play(): the screen shown at t; a part not on it is read on the nearest one, said so", () => {
  const p = P().play([
    [0, "home"],
    [5, "add-1"],
    [10, { still: 2 }],
  ]);
  assert.equal(p.state(4.99), "home");
  assert.equal(p.state(5), "add-1");
  assert.equal(p.state(12), "add-2");
  assert.equal(p.still(12), 2);
  const heading = p.part("home:e2");
  assert.deepEqual(heading.boxAt(1), box(40, 20, 200, 30));
  assert.deepEqual(heading.boxAt(6), box(40, 60, 200, 30), "where it is on the screen shown");
  const body = p.part("home:e1");
  const a = body.at(6);
  assert.equal(a.shown, false);
  assert.equal(a.state, "home");
  assert.equal(a.showing, "add-1", "and the screen shown then");
  assert.equal(body.at(1).shown, true);
  // and a function of t, and screens it does not have
  assert.equal(
    P()
      .play((t: number) => (t < 1 ? "home" : "n-4"))
      .state(2),
    "n-4",
  );
  assert.throws(() => P().play([[0, "nowhere"]]), /does not have/);
});

test("the camera takes a part: framed where it is when the move lands", () => {
  const p = P().play([
    [0, "home"],
    [5, "add-1"],
  ]);
  const heading = p.part("home:e2", { name: "title" });
  const a = camera({ content: { width: 640, height: 360 } });
  const b = camera({ content: { width: 640, height: 360 } });
  a.frame(heading, { arrive: 6 });
  b.frame(heading.boxAt(6), { arrive: 6 });
  a.cut(heading, 1);
  b.cut(heading.boxAt(1), 1);
  for (const t of [0, 1, 5.5, 6, 8]) assert.equal(a.transform(t), b.transform(t));
  assert.deepEqual(
    a.moves().map((m) => m.label),
    ["cut title at 1s", "frame title at 6s"],
  );
  // a move given by its start lands after its duration, less its lead
  const c = camera({ content: { width: 640, height: 360 }, lead: 0.2 });
  const d = camera({ content: { width: 640, height: 360 }, lead: 0.2 });
  c.frame(heading, { start: 4.5, dur: 1 });
  d.frame(heading.boxAt(5.3), { start: 4.5, dur: 1 });
  assert.equal(c.transform(6), d.transform(6));
  assert.deepEqual(
    heading.uses.map((u) => [u.use, u.t]),
    [
      ["frame", 6],
      ["cut", 1],
      ["frame", 5.3],
    ],
  );
  // by its start alone, a move pulling out wider than the view before it
  // takes the camera's longer duration: the part is read where that lands
  const q = P().play([
    [0, "home"],
    [5.9, "add-1"],
  ]);
  const h2 = q.part("home:e2");
  const f = camera({ content: { width: 640, height: 360 } });
  f.frame(box(40, 20, 20, 10), { arrive: 1 });
  f.frame(h2, { start: 5 });
  const m = f.moves()[1]!;
  assert.ok(m.t1 > 6, `pulls out past 6 s (${m.t1})`);
  assert.equal(h2.uses.at(-1)!.t, m.t1);
  const g = camera({ content: { width: 640, height: 360 } });
  g.frame(box(40, 20, 20, 10), { arrive: 1 });
  g.frame(h2.boxAt(m.t1), { start: 5, dur: m.t1 - m.t0 });
  for (const t of [5, 5.9, 6.5, 8]) assert.equal(f.transform(t), g.transform(t));
  // plain boxes and views are as they were
  const e = camera({ content: { width: 640, height: 360 } });
  e.frame(box(10, 10, 100, 50), { arrive: 1 });
  assert.equal(e.moves()[0]!.label, "frame at 1s");
  assert.throws(() => e.frame(heading, {}), /needs \{ arrive \} or \{ start \}/);
});

test("the cursor takes a part: on the point the capture acted on, carried to where it is now", () => {
  const p = P().play([
    [0, "home"],
    [5, "add-1"],
    [10, "add-2"],
  ]);
  const add = p.part("home:e3");
  // at 4 s the click that led out of home: the shoot's cursor, 30, 10 into
  // the button as home showed it
  assert.deepEqual(add.pointAt(4), { x: 70, y: 110 });
  // at 12 s, on add-2: its last click, 35, 15 into the button as add-1
  // showed it — carried to where add-2 moved it
  assert.deepEqual(add.pointAt(12), { x: 75, y: 155 });
  // through where the screen is drawn
  p.view({ place: { x: 100, y: 0, scale: 2 } });
  assert.deepEqual(add.pointAt(12), { x: 250, y: 310 });
  p.view({ place: undefined });
  // a part no action touched: its centre
  assert.deepEqual(p.part("home:e2").pointAt(1), { x: 140, y: 35 });

  const cur = cursor({ content: { width: 640, height: 360 } });
  cur.click(add, 12);
  const c = cur.at(12);
  assert.deepEqual([c.x, c.y], [75, 155]);
  assert.deepEqual(add.uses.at(-1)?.use, "click");
});

test("a drag in step with the saved stills: the real cursor at each step, each screen from when it is reached", () => {
  const p = P();
  const d = p.drag("n", 20, 21);
  assert.equal(d.basis, "shoot stills");
  // the cursor less the page's scroll at each step; no control acted on: no
  // press before the first
  assert.deepEqual(d.path, [
    { x: 300, y: 200 },
    { x: 320, y: 200 },
    { x: 340, y: 200 },
    { x: 400, y: 200 },
  ]);
  assert.equal(d.ease, smootherstep);
  const cur = cursor({ content: { width: 640, height: 360 } });
  cur.drag(d);
  d.steps.forEach(([t, s], k) => {
    const c = cur.at(t);
    near(c.x, d.path[k]!.x, 1e-6, `x at step ${k}`);
    near(c.y, d.path[k]!.y, 1e-6, `y at step ${k}`);
    assert.equal(s, `n-${k + 1}`);
  });
  assert.equal(d.steps[0]![0], 20);
  // the screen changes only at the steps, and never back
  const ts = d.steps.map(([t]) => t);
  let was = d.state(19);
  let changes = 0;
  for (let t = 19; t <= 22; t += 0.001) {
    const s = d.state(t);
    if (s !== was) {
      changes++;
      assert.ok(
        ts.some((x) => Math.abs(x - t) <= 0.0011),
        `changed at ${t}, not at a step`,
      );
      assert.ok(String(s) > String(was), "forward only");
    }
    was = s;
  }
  assert.equal(changes, 3);
  assert.equal(d.part, null, "no part the inventory knows was pressed");
  assert.equal(d.still(21), 6);
  // the same with the cursor's own call
  const a = cursor({ content: { width: 640, height: 360 } });
  const b = cursor({ content: { width: 640, height: 360 } });
  a.drag(d);
  b.drag(d.path, d.at, d.end, { ease: d.ease });
  for (let t = 19.5; t <= 21.5; t += 0.05) assert.deepEqual(a.at(t), b.at(t));

  // a pace of the film's own stays in step
  const lin = (u: number) => Math.max(0, Math.min(1, u)) ** 2;
  const e = p.drag("n", 20, 21, { ease: lin });
  const c2 = cursor({ content: { width: 640, height: 360 } });
  c2.drag(e);
  e.steps.forEach(([t], k) => {
    near(c2.at(t).x, e.path[k]!.x, 1e-6, `eased step ${k}`);
  });

  // a track: the screens the drag took along it (not the clicks before),
  // the same steps — or the screens the film names
  const f = p.drag("t1", 20, 21);
  assert.deepEqual(f.path, d.path);
  assert.deepEqual(f.steps, d.steps);
  const named = p.drag("t1", 20, 21, { states: ["n-1", "n-2", "n-3", "n-4"] });
  assert.deepEqual(named.steps, d.steps);
  // one point to follow and nothing pressed: refused, by the cursor as well
  assert.throws(() => p.drag("t1", 0, 1, { states: ["n-4"] }), /has one point to follow/);
  assert.throws(
    () => cursor({ content: { width: 640, height: 360 } }).drag({ ...d, path: [d.path[0]!] }),
    /at least two points/,
  );
  assert.equal(f.value(20.99), 8);
  assert.ok(f.part?.uses.some((u) => u.use === "drag" && u.end === 21));
  assert.throws(() => p.drag("n", 20), /needs its end/);
  // played in, the screens follow the drag
  const q = P().play([[0, "add-2"], ...d.steps, [23, "home"]]);
  assert.equal(q.state(20.5), d.state(20.5));
});

test("a take's drag: the capture's own stroke, times and pace", () => {
  const take = {
    video: { width: 1280, height: 720 },
    viewport: { w: 640, h: 360 },
    events: [
      { kind: "click", tMs: 500, x: 10, y: 10, state: "s1" },
      {
        kind: "drag",
        tMs: 2000,
        x: 100,
        y: 100,
        to: { x: 300, y: 100 },
        path: [
          { x: 100, y: 100 },
          { x: 200, y: 120 },
          { x: 300, y: 100 },
        ],
        durationMs: 800,
        ease: "smooth",
        state: "s2",
      },
      { kind: "drag", tMs: 4000, x: 0, y: 0, to: { x: 50, y: 0 }, durationMs: 500, state: "s3" },
    ],
    states: {
      dir: "states",
      items: [
        { id: "s0", tMs: 0 },
        { id: "s1", tMs: 600 },
        { id: "s2", tMs: 2900 },
        { id: "s3", tMs: 4600 },
      ],
    },
  };
  const comp = {
    version: 2,
    source: { kind: "take", log: "capture.json", viewport: { w: 640, h: 360 }, srcRatio: 2 },
    states: ["s0", "s1", "s2", "s3"].map((id) => ({
      id,
      url: `states/${id}/state.html`,
      components: [],
    })),
    components: [],
    tracks: [],
  };
  const p = productFrom({ components: comp, log: take });
  const c = clip({ at: 10, from: 1 });
  // the part dragged: its element on the screen saved before the one it led
  // to, even when the event before it saved none
  const t2 = structuredClone(take);
  delete (t2.events[0] as { state?: string }).state;
  (t2.events[1] as { target?: string }).target = "e5";
  const c2 = structuredClone(comp) as typeof comp & { components: unknown[] };
  c2.components = [{ ref: "s1:e5", kind: "button", box: [90, 90, 20, 20] }];
  assert.equal(
    productFrom({ components: c2, log: t2 }).drag("a2", 0, { clip: c }).part?.ref,
    "s1:e5",
  );
  const d = p.drag("a2", 0, { clip: c });
  assert.equal(d.basis, "take recording");
  assert.deepEqual(d.path, take.events[1]!.path);
  near(d.at, 11, 1e-9, "at");
  near(d.end, 11.8, 1e-9, "end");
  assert.equal(d.ease, smootherstep);
  assert.deepEqual(d.steps, []);
  const lin = p.drag("a3", 0, { clip: c });
  assert.equal(lin.ease(0.25), 0.25, "no pace logged: linear");
  assert.deepEqual(lin.path, [
    { x: 0, y: 0 },
    { x: 50, y: 0 },
  ]);
  assert.throws(() => p.drag("a1", 0, { clip: c }), /a1 is a click, not a drag/);
  assert.throws(() => p.drag("a2", 0), /needs \{ clip \}/);
  // a take played by its clip: the last state saved by then
  p.play(c);
  assert.equal(p.state(9), "s1");
  assert.equal(p.state(10.5), "s1");
  assert.equal(p.state(12), "s2");
});

test("every part made and its uses are in the page's registry; with tl, declared", async () => {
  const events: { t: number; kind: string; o: { x?: number; y?: number; label?: string } }[] = [];
  const curves = new Map<string, (t: number) => number>();
  const tl = {
    event: (t: number, kind: string, o = {}) => {
      events.push({ t, kind, o });
      return t;
    },
    curve: (name: string, fn: (t: number) => number) => {
      curves.set(name, fn);
    },
  };
  const p = P({ tl });
  const n = p.part("t1", { name: "count" });
  const cam = camera({ content: { width: 640, height: 360 } });
  cam.frame(n, { arrive: 2 });
  p.view({ cam }).play([
    [0, "home"],
    [3, "add-1"],
  ]);
  assert.equal(n.mark(3.5, "the count"), 3.5);
  await Promise.resolve();
  const reg = (globalThis as unknown as { __otParts: { name: string }[] }).__otParts;
  assert.ok(reg.includes(n));
  assert.deepEqual(p.parts(), [n]);
  assert.deepEqual(
    n.uses.map((u) => [u.use, u.t, u.ref, u.label]),
    [
      ["frame", 2, "home:e4", undefined],
      ["mark", 3.5, "add-1:e4", "the count"],
    ],
  );
  assert.deepEqual(
    events.map((e) => [e.t, e.kind, e.o.label]),
    [
      [2, "part", "frame home:e4"],
      [3.5, "part", "mark add-1:e4"],
    ],
  );
  const at = n.at(2).picture;
  near(events[0]!.o.x!, at.x + at.width / 2, 1e-9, "declared where it shows");
  assert.deepEqual(
    [...curves.keys()],
    ["part:count.x", "part:count.y", "part:count.w", "part:count.h"],
  );
  near(curves.get("part:count.w")!(2), at.width, 1e-9, "curve in the picture's px");
  assert.throws(() => n.coveredBy(1), /runs in a browser/);

  // named after it was made: its curves under the name it has then
  const q = P({ tl });
  q.part("home:e2");
  q.part("home:e2", { name: "title" }).mark(1);
  await Promise.resolve();
  assert.ok(curves.has("part:title.x"));
  // a lifted copy asked for again (a page asks on every frame) is one part
  const lifted = { box: box(0, 0, 10, 10), source: box(0, 0, 10, 10), map: (b: typeof at) => b };
  const title = q.part("home:e2");
  assert.equal(title.via(lifted), title.via(lifted));
  assert.equal(q.parts().length, 2);
  // a drag no part was pressed for: in the registry once, however often asked
  q.drag("n", 30, 31);
  q.drag("n", 30, 31);
  const drags = (reg as unknown as { key: string; uses: { t: number }[] }[]).filter(
    (x) => x.key === "drag n",
  );
  assert.equal(drags.length, 1);
  assert.equal(drags[0]!.uses.filter((u) => u.t === 30).length, 1);
});
