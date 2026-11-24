// starter/lib/handoff.js as numbers, loaded as a film's folder holds it
// (lib/ beside kit/): one thing carried through a list of places, each still
// or moving, sitting on each to the pixel between trips; a push through
// what was clicked that never shows the ground round the scene, whatever
// rect it is given.
import assert from "node:assert/strict";
import { cp, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

type Rect = { x: number; y: number; w: number; h: number; r?: number };
type Side = { visible: boolean; x: number; y: number; scale: number; opacity: number; transform: string; clip?: string };
type Carried = { x: number; y: number; w: number; h: number; scale: number; p: number; visible: boolean; transform: string; place: number; moving: boolean };
type Handoff = {
  carry: (t: number, a: number, b: number, from: Rect, to: Rect, o?: object) => Carried;
  carryAlong: (t: number, places: object[], o?: object) => Carried;
  through: (t: number, a: number, b: number, rect: Rect, o?: object) => { a: Side; b: Side; window: Rect; p: number };
};

let dir = "";
let H: Handoff;
before(async () => {
  dir = await mkdtemp(join(tmpdir(), "open-take-handoff-test-"));
  await cp(fileURLToPath(new URL("../kit/", import.meta.url)), join(dir, "kit"), { recursive: true });
  await cp(fileURLToPath(new URL("../starter/lib/", import.meta.url)), join(dir, "lib"), { recursive: true });
  // the folder is outside any package: say its .js files are modules, as a film's page loads them
  await writeFile(join(dir, "package.json"), '{ "type": "module" }\n');
  H = (await import(pathToFileURL(join(dir, "lib", "handoff.js")).href)) as Handoff;
});
after(async () => {
  await rm(dir, { recursive: true, force: true });
});

const near = (a: number, b: number, tol: number, what: string) =>
  assert.ok(Math.abs(a - b) <= tol, `${what}: ${a} is not within ${tol} of ${b}`);

test("carryAlong: one thing through many places, on each to the pixel, travelling when its time comes", () => {
  const slot = (t: number) => ({ x: 300 + 40 * t, y: 500, w: 60, h: 60 }); // a place on something the camera moves
  const places = [
    { at: { x: 100, y: 100, w: 30, h: 30 } },
    { from: 2, to: 2.8, at: slot },
    { from: 5, at: { x: 1500, y: 200, w: 120, h: 120 } }, // lands 0.6 s later
    { from: 8, to: 8.5, at: (t: number) => (t < 8.2 ? null : { x: 900, y: 900, w: 80, h: 80 }) },
  ];
  const laid = { x: 0, y: 0, w: 160, h: 160 };
  const at = (t: number) => H.carryAlong(t, places, { laid });
  // on the first place, written for an element laid out once at 0, 0, 160 px
  const first = at(1);
  assert.deepEqual([first.x, first.y, first.w, first.place, first.moving], [100, 100, 30, 0, false]);
  assert.equal(first.transform, "translate(100px, 100px) scale(0.1875)");
  // the trip is carry's own, between the two places as they are now
  const mid = at(2.4), same = H.carry(2.4, 2, 2.8, places[0]!.at as Rect, slot(2.4));
  near(mid.x, same.x, 1e-9, "x on the way");
  near(mid.y, same.y, 1e-9, "y on the way (the arc)");
  near(mid.w, same.w, 1e-9, "its size on the way");
  assert.deepEqual([mid.place, mid.moving], [1, true]);
  // landed on a place that moves: it rides it
  for (const t of [2.8, 3.5, 4.9]) {
    const c = at(t);
    assert.deepEqual([c.x, c.y, c.w, c.moving], [slot(t).x, 500, 60, false], `on the moving place at ${t}`);
  }
  // it leaves the moving place from where that is now, with no jump
  near(at(5.001).x, at(4.999).x, 0.2, "no jump as it leaves");
  assert.deepEqual([at(5.6).x, at(5.6).w, at(5.6).moving], [1500, 120, false], "a trip with no `to` lands 0.6 s on");
  // a place that cannot be seen yet hides it; once it can, it is on its way there
  assert.equal(at(8.1).visible, false);
  assert.equal(at(8.3).visible, true);
  assert.deepEqual([at(9).x, at(9).y, at(9).place], [900, 900, 3]);
  // no layout given: laid out at 0, 0 the size of the first place
  assert.equal(H.carryAlong(1, places).transform, "translate(100px, 100px) scale(1)");
  // twelve places are twelve lines
  const twelve = Array.from({ length: 12 }, (_, i) => ({ from: i * 2, to: i * 2 + 0.5, at: { x: 100 * i, y: 50 * i, w: 40 + 4 * i, h: 40 + 4 * i } }));
  for (let i = 0; i < 12; i++) assert.deepEqual([H.carryAlong(i * 2 + 1, twelve).x, H.carryAlong(i * 2 + 1, twelve).place], [100 * i, i]);
  assert.deepEqual(at(3.3), at(3.3), "the same t, the same answer");
  assert.throws(() => H.carryAlong(0, []), /needs places/);
  assert.throws(() => H.carryAlong(0, [{ at: laid }, { at: laid }]), /needs `from`/);
});

test("through: the scene always covers the frame — a rect past the frame's edge, wider than it, or in a corner", () => {
  const W = 1920, H0 = 1080;
  const rects: Rect[] = [
    { x: 700, y: 480, w: 520, h: 120, r: 16 }, // a row in the middle
    { x: 1500, y: 500, w: 900, h: 110 }, // running off the right edge
    { x: -200, y: 300, w: 2600, h: 140 }, // wider than the frame
    { x: 0, y: 0, w: 200, h: 80 }, // in the corner: the window travels faster than the scene grows
    { x: 1700, y: 980, w: 220, h: 100 },
    { x: 900, y: -50, w: 100, h: 1300 }, // taller than the frame
  ];
  for (const rect of rects)
    for (let u = 0; u <= 1.0001; u += 0.02) {
      const g = H.through(u, 0, 1, rect);
      if (!g.a.visible) continue;
      assert.ok(g.a.scale >= 1 - 1e-9, `the scene is never drawn smaller: ${g.a.scale} at ${u} for ${JSON.stringify(rect)}`);
      assert.ok(g.a.x <= 1e-6 && g.a.y <= 1e-6, `its top-left at or past the frame's at ${u} for ${JSON.stringify(rect)}: ${g.a.x}, ${g.a.y}`);
      assert.ok(g.a.x + g.a.scale * W >= W - 1e-6 && g.a.y + g.a.scale * H0 >= H0 - 1e-6, `its far edges too at ${u} for ${JSON.stringify(rect)}`);
    }
  // the push starts from the part of the rect that can be seen
  const off = H.through(0, 0, 1, rects[1]!);
  assert.deepEqual([off.window.x, off.window.w], [1500, 420]);
  // a rect inside the frame, away from its edges, is as it was: what was clicked stays under the window
  const g = H.through(0.5, 0, 1, rects[0]!);
  near(g.a.x + g.a.scale * (700 + 260), g.window.x + g.window.w / 2, 1e-6, "the row's middle under the window's");
  assert.equal(H.through(1, 0, 1, rects[0]!).a.visible, false);
  assert.throws(() => H.through(0.5, 0, 1, { x: 2000, y: 100, w: 300, h: 100 }), /outside the 1920 × 1080 frame/);
});
