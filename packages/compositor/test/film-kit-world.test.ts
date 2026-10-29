// The film kit's world (kit/world.js): stage.js's slabs and moves drawn in
// WebGL. Here, the parts that are numbers: every slab needs a source; poses
// move as on the stage; at(t) gives the stage's quads; the lens handed to
// three puts each slab's corners exactly where at(t) says; the devices' shapes
// and bounds; every frame the same in any order. (The drawing itself needs
// Chrome: the gallery draws its blocks; a render was checked by hand.) And
// `film init` puts three.js beside the kit.

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { camera } from "../kit/camera.js";
import { stage } from "../kit/stage.js";
import { checkSource, deviceShape, explode, world } from "../kit/world.js";
import { filmGallery, galleryBlockNames } from "../src/film/gallery";
import { initFilm, THREE_FILES, threeBuildDir } from "../src/film/kit";
import { findChrome } from "./fixtures/find-chrome";

const chrome = findChrome();
const skip = chrome ? false : "no Chrome for Testing";
const dir = await mkdtemp(join(tmpdir(), "open-take-world-"));
after(() => rm(dir, { recursive: true, force: true }));

const near = (a: number, b: number, tol: number, what: string) =>
  assert.ok(Math.abs(a - b) <= tol, `${what}: ${a} vs ${b} (±${tol})`);

const card = { x: 600, y: 300, width: 700, height: 300 };
const src = { state: "home", selector: "#card" };

/** a 4×4 column-major matrix times a point */
function mul4(m: number[], p: [number, number, number, number]) {
  return [0, 1, 2, 3].map(
    (r) => m[r]! * p[0] + m[4 + r]! * p[1] + m[8 + r]! * p[2] + m[12 + r]! * p[3],
  ) as [number, number, number, number];
}

/** where three draws a corner of a slab (its own px, y down) in the picture */
function drawn(
  f: { projection: number[]; eye: [number, number, number]; slabs: { matrix: number[] }[] },
  i: number,
  x: number,
  y: number,
  W = 1920,
  H = 1080,
) {
  const local: [number, number, number, number] = [x, -y, 0, 1]; // three's y is up
  const w = mul4(f.slabs[i]!.matrix, local);
  const v: [number, number, number, number] = [
    w[0] - f.eye[0],
    w[1] - f.eye[1],
    w[2] - f.eye[2],
    1,
  ];
  const c = mul4(f.projection, v);
  const nx = c[0] / c[3];
  const ny = c[1] / c[3];
  return { x: ((nx + 1) / 2) * W, y: ((1 - ny) / 2) * H, z: c[2] / c[3] };
}

test("every slab says where its picture came from, or it is refused", () => {
  const w = world();
  assert.throws(() => w.slab("a.png", { box: card } as never), /needs a source/);
  assert.throws(() => w.slab("a.png", { box: card, source: { state: "" } }), /needs a source/);
  assert.throws(() => w.slab("a.png", { box: card, source: {} as never }), /needs a source/);
  assert.throws(
    () => w.slab("a.png", { box: card, source: { state: "home", selector: 3 } as never }),
    /needs a source/,
  );
  w.slab("states/home/picture@2x.png", { box: card, source: src, name: "card" });
  w.slab("media/run.mp4", { source: { file: "media/run.mp4" } });
  assert.deepEqual(w.sources(), [
    { name: "card", source: src, src: "states/home/picture@2x.png", device: null },
    { name: "slab 2", source: { file: "media/run.mp4" }, src: "media/run.mp4", device: null },
  ]);
  assert.deepEqual(checkSource({ file: "a.png" }, "x"), { file: "a.png" });
  // with no box and no crop it covers the whole stage
  assert.deepEqual(
    w.at(0)[1]!.quad.map((q) => [Math.round(q.x), Math.round(q.y)]),
    [
      [0, 0],
      [1920, 0],
      [1920, 1080],
      [0, 1080],
    ],
  );
});

test("poses and quads are the stage's: the same moves give the same corners", () => {
  const cam = camera({ content: { width: 1920, height: 1080 } });
  cam.frame({ x: 500, y: 250, width: 900, height: 400 }, { arrive: 2 });
  const st = stage({ camera: cam });
  const w = world({ camera: cam });
  const a = st.slab(null, { box: card });
  const b = w.slab("p.png", { box: card, source: src });
  for (const s of [a, b]) {
    s.to({ rx: 20, ry: -28, z: 80 }, { start: 0.5 });
    s.to({ scale: 1.3 }, { start: 1, spring: { overshoot: 0.2 } });
  }
  st.turn({ rx: 30 }, { start: 1.5, dur: 1 });
  w.turn({ rx: 30 }, { start: 1.5, dur: 1 });
  st.dolly(400, { arrive: 3 });
  w.dolly(400, { arrive: 3 });
  for (const t of [0, 0.7, 1.2, 2, 2.6, 4]) {
    const s = st.at(t)[0]!;
    const v = w.at(t)[0]!;
    assert.deepEqual(v.pose, s.pose, `pose at ${t}`);
    assert.deepEqual(v.quad, s.quad, `quad at ${t}`);
    assert.equal(v.area, s.area);
    assert.equal(v.flat, s.flat);
    assert.deepEqual(v.source, src);
  }
  assert.deepEqual(w.world(2), st.world(2));
});

test("the lens handed to three draws each corner where at(t) says it is", () => {
  const cam = camera({ content: { width: 1920, height: 1080 }, handheld: { amp: 6, rot: 1 } });
  cam.frame({ x: 300, y: 200, width: 1000, height: 500 }, { arrive: 1.5 });
  const w = world({ camera: cam });
  const s = w.slab("p.png", { box: card, source: src, origin: [0.2, 0.8] });
  const back = w.slab("q.png", { box: { x: 100, y: 100, w: 400, h: 300 }, source: src });
  s.to({ rx: 25, ry: -35, rz: 6, z: 200, scale: 0.8 }, { start: 0 });
  back.set({ z: -900 }, Number.NEGATIVE_INFINITY);
  w.turn({ ry: 18 }, { start: 0.3, dur: 1 });
  w.dolly(300, { start: 1, dur: 1 });
  for (const t of [0, 0.4, 1.1, 1.7, 3]) {
    const f = w.frame(t);
    const states = w.at(t);
    states.forEach((st, i) => {
      const b = i === 0 ? card : { width: 400, height: 300 };
      const corners = [
        [0, 0],
        [b.width, 0],
        [b.width, b.height],
        [0, b.height],
      ];
      corners.forEach(([x, y], k) => {
        const p = drawn(f, i, x!, y!);
        near(p.x, st.quad[k]!.x, 1e-6, `slab ${i} corner ${k} x at ${t}`);
        near(p.y, st.quad[k]!.y, 1e-6, `slab ${i} corner ${k} y at ${t}`);
        assert.ok(p.z > -1 && p.z < 1, `inside the depth range at ${t}: ${p.z}`);
      });
    });
    // what is nearer the lens is nearer in the depth buffer
    const zf = drawn(f, 0, card.width / 2, card.height / 2).z;
    const zb = drawn(f, 1, 200, 150).z;
    assert.ok(zf < zb, `the near slab in front at ${t}`);
  }
});

test("a frame is the same asked twice, in any order", () => {
  const w = world();
  const s = w.slab("p.png", { box: card, source: src });
  s.to({ ry: 40 }, { start: 0, dur: 1.5 });
  w.dolly(500, { start: 0.5 });
  const once = [0.2, 0.9, 1.4].map((t) => JSON.stringify(w.frame(t)));
  const again = [1.4, 0.2, 0.9].map((t) => JSON.stringify(w.frame(t)));
  assert.deepEqual(once, [again[1], again[2], again[0]]);
});

test("stage's moves made of moves work on the world's slabs", () => {
  const w = world();
  const list = [0, 1, 2].map((i) =>
    w.slab("p.png", { box: { x: i * 300, y: 0, w: 280, h: 200 }, source: src }),
  );
  explode(list, { start: 0, gap: 100 });
  near(list[2]!.pose(5).z, 200, 1e-6, "the top layer 200 px up");
  near(w.at(5)[1]!.depth, 100, 1e-6, "the middle one's depth");
});

test("devices: plain shapes round the screen, their bounds where the parts are", () => {
  const lap = deviceShape("laptop", 1600, 1000);
  near(lap.body.x, -48, 1e-9, "the side bezel, 3 %");
  near(lap.body.y, -72, 1e-9, "the top bezel, 4.5 %");
  near(lap.body.h, 1000 + 72 + 96, 1e-9, "the chin, 6 %");
  assert.equal(lap.deck!.open, 100);
  near(lap.deck!.depth, 0.7 * lap.body.w, 1e-9, "the keyboard half");
  // open 100°: the far edge comes toward the lens and a little down
  near(
    lap.bounds.z + lap.bounds.d,
    lap.deck!.hinge.z + lap.deck!.depth * Math.sin((100 * Math.PI) / 180),
    1e-9,
    "the nearest point is the far edge",
  );
  assert.ok(lap.bounds.y + lap.bounds.h > lap.deck!.hinge.y, "below the hinge");
  const flat = deviceShape("laptop", 1600, 1000, { open: 180 });
  // opened flat: from the screen back to the keyboard half's underside, behind the lid's middle
  near(
    flat.bounds.d,
    flat.body.depth / 2 + flat.deck!.thick,
    1e-6,
    "opened flat: as thin as it is",
  );
  assert.throws(() => deviceShape("laptop", 1600, 1000, { open: 0 }), /open is degrees/);
  const ph = deviceShape("phone", 390, 844);
  near(ph.bounds.w, 390 * 1.09, 1e-9, "a 4.5 % border each side");
  near(ph.screenRadius, 0.12 * 390, 1e-9, "the screen's corners");
  const br = deviceShape("browser", 1920, 1080);
  near(br.bounds.y, -0.042 * 1920, 1e-9, "the bar above the page");
  assert.equal(br.bounds.h, 1080 + 0.042 * 1920);
  assert.throws(() => deviceShape("tablet" as never, 10, 10), /no device "tablet"/);
  // on a world with no three it is numbers, and moves with its slab
  const w = world();
  const s = w.slab("p.png", { box: { x: 100, y: 50, w: 1600, h: 1000 }, source: src });
  const d = w.device("laptop", s);
  assert.deepEqual(d.bounds, {
    x: 100 + lap.bounds.x,
    y: 50 + lap.bounds.y,
    z: lap.bounds.z,
    w: lap.bounds.w,
    h: lap.bounds.h,
    d: lap.bounds.d,
  });
  d.to({ ry: 30 }, { start: 0 });
  near(s.pose(5).ry, 30, 1e-6, "posing the device poses its screen");
  assert.equal(w.at(0)[0]!.device, "laptop");
  assert.throws(() => w.device("phone", s), /already has a laptop/);
  assert.throws(() => world().device("phone", s), /a slab of this world/);
  assert.throws(() => w.draw(w.frame(0)), /needs three/);
});

test("film init puts three.js beside the kit, as the page imports it", async () => {
  const film = join(dir, "init");
  const r = await initFilm({ dir: film });
  for (const f of THREE_FILES) {
    const to = join(film, "kit", f);
    assert.ok(r.written.includes(to), `${f} written`);
    assert.deepEqual(await readFile(to), await readFile(join(threeBuildDir(), f)));
  }
  assert.ok(existsSync(join(film, "kit", "world.js")));
  const page = await readFile(join(film, "index.html"), "utf8");
  assert.match(page, /kit\/three\.module\.min\.js\s+three\.js, for kit\/world\.js/);
});

test("kit/world.js is drawn in the gallery: WebGL cells, the stage's numbers", {
  skip,
}, async () => {
  const names = await galleryBlockNames();
  for (const n of ["tilt", "laptop", "phone", "browser", "dolly"])
    assert.ok(names.includes(`world.${n}`), `world.${n} is drawn`);
  const r = await filmGallery({
    chromePath: chrome!,
    out: join(dir, "gallery"),
    blocks: ["world"],
  });
  assert.deepEqual(
    r.entries.map((e) => e.name),
    ["world.tilt", "world.laptop", "world.phone", "world.browser", "world.dolly"],
  );
  for (const e of r.entries) {
    assert.equal(e.error, undefined, `${e.name}: ${e.error}`);
    assert.ok(e.png && existsSync(e.png), `${e.name} drawn`);
    for (const row of e.rows) assert.ok(row.stats, `${e.name} / ${row.label} measured`);
  }
  near(r.entries[1]!.rows[0]!.stats!.from, 40, 1e-6, "the laptop starts turned 40°");
  near(r.entries[1]!.rows[0]!.stats!.to, 0, 0.05, "and comes square on");
  assert.match(await readFile(r.index, "utf8"), /## kit\/world\.js/);
});
