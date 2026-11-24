// The starter's devices and handoffs (starter/lib/devices.js, handoff.js), as
// `film init` puts them in a film's folder beside the kit they import:
//   - a laptop whose lid is a pose — shut, it faces away and lies over the
//     keyboard half; open, its screen faces the lens — the same pose giving
//     the same numbers in any order, its parts drawn in the order the lens
//     sees them; a phone and a box computer; the 2D camera;
//   - carry, whip, panel and through as functions of t: where each side is
//     before, during and after, the thing carried leaving and landing;
//   - in Chrome: the faces drawn where at() says (a point of the screen where
//     toFrame puts it), the live element on the screen the one under its
//     middle when the lid is open, the lid's back when it is shut.
// Chrome for Testing for the last; skipped without it.

import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { pathToFileURL } from "node:url";
import { initFilm } from "../src/film/kit";
import { launchHtmlBrowser } from "../src/html/cdp";
import { serveDirectory } from "../src/html/server";
import { findChrome } from "./fixtures/find-chrome";

const chrome = findChrome();
const skip = chrome ? false : "no Chrome for Testing";

type Pt = { x: number; y: number };
type At = {
  bounds: { x: number; y: number; w: number; h: number };
  quad: Pt[];
  toFrame: (x: number, y: number) => [number, number];
  facing: boolean;
  depth: number;
  soft: string[];
  faces: { name: string; facing: boolean; quad: Pt[]; z: number }[];
};
type Device = {
  el: HTMLElement | null;
  at: (p?: object, cam?: object) => At;
  draw: (p?: object) => At;
};
type Side = {
  visible: boolean;
  x: number;
  y: number;
  scale: number;
  opacity: number;
  transform: string;
  origin?: string;
  clip?: string;
};
type Carried = Side & { w: number; h: number; p: number };

let dir = "";
let film = "";
let D: {
  laptop: (host: null, o: object) => Device;
  phone: (host: null, o: object) => Device;
  computer: (host: null, o?: object) => Device;
};
let H: {
  carry: (t: number, s: number, e: number, a: object, b: object, o?: object) => Carried;
  whip: (
    t: number,
    at: number,
    o?: object,
  ) => { a: Side; b: Side; carry: Carried | null; p: number };
  panel: (t: number, at: number, o?: object) => { panel: Side; under: Side; p: number };
  through: (
    t: number,
    s: number,
    e: number,
    r: object,
    o?: object,
  ) => { a: Side; b: Side; window: { x: number; y: number; w: number; h: number }; p: number };
};
before(async () => {
  dir = await mkdtemp(join(tmpdir(), "open-take-film-devices-test-"));
  film = join(dir, "film");
  await initFilm({ dir: film });
  // the folder as a page sees it: its .js are modules (tsx would take them as
  // CommonJS in a folder that does not say so)
  await writeFile(join(film, "package.json"), '{ "type": "module" }\n');
  D = await import(pathToFileURL(join(film, "lib", "devices.js")).href);
  H = await import(pathToFileURL(join(film, "lib", "handoff.js")).href);
});
after(async () => {
  await rm(dir, { recursive: true, force: true });
});

const near = (a: number, b: number, tol: number, what: string) =>
  assert.ok(Math.abs(a - b) <= tol, `${what}: ${a} vs ${b} (±${tol})`);
const face = (a: At, name: string) => {
  const f = a.faces.find((x) => x.name === name);
  assert.ok(f, `a face "${name}"`);
  return f;
};

test("a laptop's lid is its pose: shut it faces away over the keys, open its screen faces the lens", () => {
  const lap = D.laptop(null, { w: 1440, h: 900 });
  const view = { x: 960, y: 800, rx: -20, ry: -25, scale: 0.5 };
  const shut = lap.at({ ...view, open: 0 });
  assert.equal(shut.facing, false, "shut: the screen faces down");
  assert.equal(face(shut, "lid top").facing, true, "the lid's back is what the lens sees");
  assert.equal(face(shut, "keys").facing, true, "the keys face up (and are drawn under the lid)");
  assert.ok(
    face(shut, "lid top").z > face(shut, "keys").z,
    "seen from above, the lid over the keys",
  );
  // the lid's back covers most of the keyboard half's top
  const top = (a: At, n: string) => {
    const q = face(a, n).quad;
    return Math.min(...q.map((p) => p.y));
  };
  near(
    top(shut, "lid top"),
    top(shut, "base top"),
    0.03 * 1440 * 0.5,
    "the shut lid's far edge over the keyboard half's",
  );
  const open = lap.at({ ...view, open: 105 });
  assert.equal(open.facing, true);
  assert.ok(open.bounds.h > shut.bounds.h * 1.5, "open, it stands taller");
  assert.ok(open.quad[0]!.y < shut.bounds.y, "the screen's top above where the shut laptop was");
  // between, the screen's top edge rises as the lid opens
  let last = Number.POSITIVE_INFINITY;
  for (const a of [30, 60, 90]) {
    const y = lap.at({ ...view, open: a }).toFrame(720, 0)[1];
    assert.ok(y < last, `the lid's far edge rises as it opens (${a}°: ${y})`);
    last = y;
  }
  // open past upright, it tilts back and its top comes down again
  assert.ok(lap.at({ ...view, open: 170 }).toFrame(720, 0)[1] > last);
  // seen from below the keyboard half's plane, the lid is drawn first
  const below = lap.at({ ...view, rx: 25, open: 0 });
  assert.ok(
    face(below, "base bottom").z > face(below, "lid top").z,
    "from below, the base over the lid",
  );
  // the lid is held between shut and flat
  assert.deepEqual(lap.at({ ...view, open: -40 }).quad, shut.quad);
  assert.throws(() => lap.at({ ...view, open: Number.NaN }), /pose\.open must be a number/);
});

test("a device is the same for the same pose, asked in any order; its screen maps through toFrame", () => {
  const lap = D.laptop(null, { w: 1440, h: 900 });
  const pose = (t: number) => ({
    x: 960,
    y: 820,
    rx: -16,
    ry: -24,
    scale: 0.55,
    open: 108 * Math.min(1, t),
  });
  const a = JSON.stringify(lap.at(pose(0.6)));
  lap.at(pose(0.1));
  lap.at(pose(0.9));
  assert.equal(JSON.stringify(lap.at(pose(0.6))), a, "the same pose, the same numbers");
  const at = lap.at(pose(1));
  const corners = [
    at.toFrame(0, 0),
    at.toFrame(1440, 0),
    at.toFrame(1440, 900),
    at.toFrame(0, 900),
  ];
  corners.forEach(([x, y], i) => {
    near(x, at.quad[i]!.x, 1e-6, `corner ${i} x`);
    near(y, at.quad[i]!.y, 1e-6, `corner ${i} y`);
  });
  for (const p of at.quad) {
    assert.ok(
      p.x >= at.bounds.x - 1e-6 && p.x <= at.bounds.x + at.bounds.w + 1e-6,
      "the screen inside its bounds",
    );
  }
});

test("a phone square on: its screen at its own px times the scale, about its middle; turned away it does not face", () => {
  const ph = D.phone(null, { w: 390, h: 844 });
  const a = ph.at({ x: 960, y: 540, scale: 1 });
  assert.equal(a.facing, true);
  // square on, the screen sits at z 0: no perspective scale
  near(a.quad[0]!.x, 960 - 195, 1e-6, "left");
  near(a.quad[0]!.y, 540 - 422, 1e-6, "top");
  near(a.quad[2]!.x, 960 + 195, 1e-6, "right");
  near(a.quad[2]!.y, 540 + 422, 1e-6, "bottom");
  assert.ok(
    a.bounds.w > 390 && a.bounds.w < 390 * 1.15,
    `its body round the screen (${a.bounds.w})`,
  );
  assert.equal(ph.at({ x: 960, y: 540, ry: 180 }).facing, false);
  // the 2D camera: twice the size about the frame's middle
  const z = ph.at({ x: 960, y: 540 }, { x: 960, y: 540, s: 2 });
  near(z.quad[0]!.x, 960 - 390, 1e-6, "zoomed left");
  near(z.quad[0]!.y, 540 - 844, 1e-6, "zoomed top");
});

test("a box computer: its front toward the lens, its sides and top seen from above and to one side", () => {
  const pc = D.computer(null, { w: 300, h: 110, d: 300 });
  const a = pc.at({ x: 960, y: 700, rx: -20, ry: 25, on: 1 });
  assert.equal(a.facing, true);
  const seen = a.faces.filter((f) => f.facing).map((f) => f.name);
  for (const n of ["body top", "body front", "body left"]) assert.ok(seen.includes(n), `${n} seen`);
  for (const n of ["body bottom", "body back", "body right"])
    assert.ok(!seen.includes(n), `${n} not seen`);
  assert.ok(
    seen.some((n) => /corner 90/.test(n)),
    "the front-left rounded corner seen",
  );
  assert.deepEqual(a.soft, []);
});

test("a screen past the frame: drawn with no perspective once it outgrows it, its middle kept; without that, named soft", () => {
  const lap = D.laptop(null, { w: 1280, h: 800 });
  const plain = D.laptop(null, { w: 1280, h: 800, flatten: false });
  // square on and filling the frame: a plain 2D transform either way
  assert.deepEqual(plain.at({ x: 960, y: 1450, scale: 1.9, open: 90 }).soft, []);
  // the verification film's opening: turned, tipped, as big as the frame
  const tilted = { x: 760, y: 1500, rx: -8, ry: -10, scale: 1.8, open: 104 };
  assert.ok(
    plain.at(tilted).soft.includes("screen"),
    "with the lens as it is, Chrome would stretch it",
  );
  assert.deepEqual(lap.at(tilted).soft, [], "flattened by itself: not soft");
  // a small laptop is left as the lens draws it
  const small = { x: 960, y: 880, rx: -14, ry: -18, scale: 0.55, open: 104 };
  assert.deepEqual(lap.at(small).quad, plain.at(small).quad, "small: no flattening");
  // flattening keeps the screen's middle where it was, and as big
  const a = plain.at(tilted);
  const f = plain.at({ ...tilted, flatten: 1 });
  near(f.toFrame(640, 400)[0], a.toFrame(640, 400)[0], 0.5, "middle x");
  near(f.toFrame(640, 400)[1], a.toFrame(640, 400)[1], 0.5, "middle y");
  const px = (q: At) =>
    Math.hypot(
      q.toFrame(641, 400)[0] - q.toFrame(640, 400)[0],
      q.toFrame(641, 400)[1] - q.toFrame(640, 400)[1],
    );
  near(px(f), px(a), 0.01, "a px at its middle as big");
  assert.deepEqual(f.soft, []);
  assert.deepEqual(
    plain.at({ ...tilted, flatten: 0 }).quad,
    a.quad,
    "flatten 0 is the lens as it was",
  );
});

test("carry: from its place here to its place there, in an arc, its width in log space", () => {
  const from = { x: 100, y: 500, w: 40, h: 40 };
  const to = { x: 1100, y: 500, w: 160, h: 160 };
  const before = H.carry(0, 1, 2, from, to);
  near(before.x, 100, 1e-9, "at from before start");
  near(before.w, 40, 1e-9, "its size there");
  assert.match(before.transform, /scale\(0\.25\)/);
  const mid = H.carry(1.5, 1, 2, from, to);
  near(mid.w, 80, 1e-6, "half way: the geometric mean of the widths");
  // the middles run from (120, 520) to (1180, 580): half way 550 on the line,
  // bowed up by a sixth of the distance
  near(mid.y + mid.h / 2, 550 - Math.hypot(1060, 60) / 6, 1e-6, "bowed upward at half way");
  const end = H.carry(2, 1, 2, from, to);
  assert.equal(end.transform, "none", "at its place it is untransformed");
  near(end.x, 1100, 1e-9, "x");
  assert.throws(() => H.carry(1, 1, 2, { x: 0, y: 0, w: 0, h: 10 }, to), /rect/);
});

test("whip: one strip, then the next at rest; the thing carried leaves with it and lands after", () => {
  const from = { x: 900, y: 300, w: 80, h: 80 };
  const to = { x: 1400, y: 500, w: 120, h: 120 };
  const w = (t: number) => H.whip(t, 6, { dir: "left", dur: 0.5, carry: { from, to } });
  const pre = w(5.7);
  assert.equal(pre.a.visible, true);
  assert.equal(pre.a.transform, "none");
  assert.equal(pre.b.visible, false);
  near(pre.carry!.x, 900, 1e-9, "the carried thing at its place here");
  const mid = w(6);
  assert.equal(mid.a.visible && mid.b.visible, true, "both on the strip at the middle");
  near(mid.b.x - mid.a.x, 1920, 1e-6, "the next docked a frame's width beyond");
  assert.ok(mid.carry!.p > 0 && mid.carry!.p < 1, "the carried thing on its way");
  const landed = w(6.25);
  assert.equal(landed.b.transform, "none", "the next scene at rest when the whip ends");
  assert.ok(landed.carry!.p < 1, "the carried thing lands after the scene");
  assert.equal(w(6.46).carry!.transform, "none", "and is there 0.2 s later");
  const up = H.whip(6, 6, { dir: "up" });
  assert.ok(up.a.y < 0 && up.b.y > 0, "up: this one leaves upward, the next comes from below");
});

test("panel: hidden before, seen from its first frame below its place, fastest at once, landed", () => {
  const p = (t: number) => H.panel(t, 2, { dy: 300, dur: 0.6 });
  assert.equal(p(1.99).panel.visible, false);
  near(p(2).panel.y, 300, 1e-9, "its first frame 300 px below its place");
  const v0 = p(2).panel.y - p(2 + 1 / 60).panel.y;
  const v1 = p(2.3).panel.y - p(2.3 + 1 / 60).panel.y;
  assert.ok(v0 > 4 * v1, `fastest at once (${v0} px a frame, then ${v1})`);
  assert.equal(p(2.6).panel.transform, "none", "landed");
  assert.equal(p(2.6).panel.opacity, 1);
  assert.equal(p(2.3).under.transform, "none", "the scene under it unmoved unless asked");
  assert.ok(H.panel(2.6, 2, { recede: 0.96 }).under.scale < 1, "asked, it steps back");
});

test("through: what was clicked opens into the view; the scene grows with it; the view at rest after", () => {
  const row = { x: 800, y: 400, w: 400, h: 60, r: 12 };
  const g = (t: number) => H.through(t, 8, 8.6, row);
  const pre = g(7.9);
  assert.equal(pre.a.visible, true);
  assert.equal(pre.b.visible, false);
  const s = g(8);
  near(s.window.w, 400, 1e-6, "the window starts as the row");
  near(s.window.x, 800, 1e-6, "where the row is");
  assert.equal(s.b.opacity, 0, "the view fades in from nothing");
  const m = g(8.3);
  // the scene's row stays under the window: its middle at the window's, its width the window's
  const cx = m.a.x + m.a.scale * (row.x + row.w / 2);
  near(cx, m.window.x + m.window.w / 2, 1e-6, "the clicked row's middle under the window's");
  near(m.a.scale * row.w, m.window.w, 1e-6, "its width the window's");
  // the view covers the window and is clipped to it
  assert.ok(
    m.b.scale * 1920 >= m.window.w - 1e-6 && m.b.scale * 1080 >= m.window.h - 1e-6,
    "the view covers the window",
  );
  assert.match(m.b.clip ?? "", /^inset\(/);
  assert.equal(m.b.origin, "0 0");
  const end = g(8.6);
  assert.equal(end.a.visible, false, "the scene hidden once the view fills the frame");
  assert.equal(end.b.transform, "none");
  assert.equal(end.b.clip, "");
  assert.equal(end.b.opacity, 1);
});

test("in Chrome, a laptop's faces are drawn where at() says; its live screen is under its middle open, its lid shut", {
  skip,
}, async () => {
  await writeFile(
    join(film, "devices.html"),
    `<!doctype html><html><head><meta charset="utf-8"><style>
html, body { margin: 0; width: 1920px; height: 1080px; overflow: hidden; background: #eee; }
#host { position: absolute; inset: 0; isolation: isolate; }
#app { width: 1440px; height: 900px; background: #fff; }
.m { position: absolute; width: 4px; height: 4px; margin: -2px 0 0 -2px; background: red; }
#hit { position: absolute; left: 520px; top: 250px; width: 400px; height: 400px; background: #3a6; }
</style></head><body><div id="host"></div>
<div id="app"><div class="m" id="m1" style="left:200px;top:150px"></div><div class="m" id="m2" style="left:1300px;top:820px"></div><div id="hit"></div></div>
<script type="module">
import { laptop } from "./lib/devices.js";
const lap = laptop(document.getElementById("host"), { screen: document.getElementById("app") });
window.check = (open) => {
  const at = lap.draw({ x: 960, y: 820, rx: -16, ry: -22, scale: 0.55, open });
  const mid = (el) => { const r = el.getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; };
  const [cx, cy] = at.toFrame(720, 450);
  const hit = document.elementFromPoint(cx, cy);
  const lid = at.faces.find((f) => f.name === "lid top").quad;
  const lx = lid.reduce((s, p) => s + p.x, 0) / 4, ly = lid.reduce((s, p) => s + p.y, 0) / 4;
  const onLid = document.elementFromPoint(lx, ly);
  return JSON.stringify({
    m1: mid(document.getElementById("m1")), m1at: at.toFrame(200, 150),
    m2: mid(document.getElementById("m2")), m2at: at.toFrame(1300, 820),
    hit: hit && (hit.id || hit.dataset.otFace || hit.tagName),
    onLid: onLid && (onLid.id || onLid.dataset.otFace || onLid.tagName),
  });
};
window.cut = () => {
  // the screen far past the frame: its face cut to what shows
  lap.draw({ x: 960, y: 2000, scale: 3.2, open: 90, rx: -4, ry: -6 });
  const f = document.querySelector('[data-ot-face="screen"]');
  return [f.offsetWidth, f.offsetHeight];
};
window.hide = () => {
  lap.el.style.visibility = "hidden";
  lap.draw({ x: 960, y: 820, open: 105 });
  const kept = getComputedStyle(lap.el).visibility;
  lap.draw({ x: 960, y: 820, open: 105, opacity: 0 });
  lap.draw({ x: 960, y: 820, open: 105, opacity: 1 });
  const after = getComputedStyle(lap.el).visibility;
  lap.el.style.visibility = "";
  return [kept, after];
};
window.ready = true;
</script></body></html>`,
  );
  const server = await serveDirectory(film);
  const b = await launchHtmlBrowser({
    chromePath: chrome!,
    url: `${server.url}/devices.html`,
    width: 1920,
    height: 1080,
  });
  try {
    for (let i = 0; i < 300 && !(await b.evaluate<boolean>("window.ready === true")); i++)
      await new Promise((ok) => setTimeout(ok, 10));
    const open = JSON.parse(await b.evaluate<string>("window.check(105)"));
    for (const k of ["m1", "m2"]) {
      near(open[k][0], open[`${k}at`][0], 1.5, `${k} x where toFrame says`);
      near(open[k][1], open[`${k}at`][1], 1.5, `${k} y where toFrame says`);
    }
    assert.equal(open.hit, "hit", "open: the screen's own element under its middle");
    const shut = JSON.parse(await b.evaluate<string>("window.check(0)"));
    assert.equal(shut.onLid, "lid top", "shut: the lid's back over everything under it");
    assert.notEqual(shut.hit, "hit", "shut: the screen is not what is seen");
    const [cw, ch] = JSON.parse(await b.evaluate<string>("JSON.stringify(window.cut())"));
    assert.ok(
      cw < 1440 && ch < 900,
      `a screen far past the frame is cut to what shows (${cw}×${ch})`,
    );
    assert.deepEqual(
      JSON.parse(await b.evaluate<string>("JSON.stringify(window.hide())")),
      ["hidden", "hidden"],
      "the page's visibility: hidden holds through draw, and through an opacity 0 and back",
    );
  } finally {
    await b.close();
    await server.close();
  }
});

test("in Chrome, a face turned from the lens is not drawn: a computer's top is its top, a phone and a laptop keep their faces and shadows", {
  skip,
}, async () => {
  await writeFile(
    join(film, "faces.html"),
    `<!doctype html><html><head><meta charset="utf-8"><style>
html, body { margin: 0; width: 1920px; height: 1080px; overflow: hidden; background: #eee; }
.host { position: absolute; inset: 0; isolation: isolate; }
#app, #ios { background: #fff; }
#app { width: 1440px; height: 900px; } #ios { width: 390px; height: 844px; }
</style></head><body><div class="host" id="h1"></div><div class="host" id="h2"></div><div class="host" id="h3"></div>
<div id="app"></div><div id="ios"></div>
<script type="module">
import { computer, laptop, phone } from "./lib/devices.js";
const made = {
  pc: computer(document.getElementById("h1"), { w: 300, h: 110, d: 300 }),
  lap: laptop(document.getElementById("h2"), { screen: document.getElementById("app") }),
  phone: phone(document.getElementById("h3"), { screen: document.getElementById("ios") }),
};
window.faces = (which, pose) => {
  for (const k of Object.keys(made)) made[k].el.style.display = k === which ? "" : "none";
  const d = made[which];
  const at = d.draw(pose);
  const out = {};
  for (const f of at.faces) {
    const el = d.el.querySelector('[data-ot-face="' + f.name + '"]');
    const cx = f.quad.reduce((s, p) => s + p.x, 0) / 4, cy = f.quad.reduce((s, p) => s + p.y, 0) / 4;
    const top = document.elementsFromPoint(cx, cy).find((e) => e.dataset && e.dataset.otFace);
    out[f.name] = { facing: f.facing, shown: getComputedStyle(el).visibility === "visible", over: top ? top.dataset.otFace : null };
  }
  return JSON.stringify(out);
};
window.ready = true;
</script></body></html>`,
  );
  const server = await serveDirectory(film);
  const b = await launchHtmlBrowser({
    chromePath: chrome!,
    url: `${server.url}/faces.html`,
    width: 1920,
    height: 1080,
  });
  type Seen = Record<string, { facing: boolean; shown: boolean; over: string | null }>;
  const faces = async (which: string, pose: object): Promise<Seen> =>
    JSON.parse(await b.evaluate<string>(`window.faces(${JSON.stringify(which)}, ${JSON.stringify(pose)})`));
  try {
    for (let i = 0; i < 300 && !(await b.evaluate<boolean>("window.ready === true")); i++)
      await new Promise((ok) => setTimeout(ok, 10));
    const poses: [string, object][] = [
      // a side showing: its far wall and far corners were drawn over its top
      ["pc", { x: 960, y: 700, rx: -20, ry: 25, on: 1, scale: 2 }],
      ["pc", { x: 960, y: 700, rx: -30, ry: -40, on: 0.5, scale: 2 }],
      ["pc", { x: 960, y: 700, rx: -20, ry: 0, scale: 2 }],
      ["lap", { x: 960, y: 820, rx: -16, ry: -22, scale: 0.55, open: 105 }],
      ["lap", { x: 960, y: 820, rx: -16, ry: 30, scale: 0.55, open: 0 }],
      ["phone", { x: 960, y: 540, rx: -8, ry: 28 }],
      ["phone", { x: 960, y: 540 }],
    ];
    for (const [which, pose] of poses) {
      const seen = await faces(which, pose);
      const what = `${which} ${JSON.stringify(pose)}`;
      for (const [name, f] of Object.entries(seen)) {
        // (a computer's glow is its own to hide while its light is off)
        if (!f.facing || name !== "glow")
          assert.equal(f.shown, f.facing, `${what}: "${name}" is drawn only when it faces the lens`);
        if (f.over) assert.equal(seen[f.over]?.facing, true, `${what}: over "${name}" a face toward the lens ("${f.over}")`);
      }
    }
    const pc = await faces("pc", { x: 960, y: 700, rx: -20, ry: 25, on: 1, scale: 2 });
    assert.match(String(pc["body top"]!.over), /^(body top|top mark)$/, "the computer's top is what is seen on its top");
    assert.equal(pc.shadow!.shown, true, "its shadow on the table is still drawn");
    assert.equal(pc.glow!.shown, true, "and its glow");
    const lap = await faces("lap", { x: 960, y: 820, rx: -16, ry: -22, scale: 0.55, open: 105 });
    for (const n of ["screen", "keys", "shadow"]) assert.equal(lap[n]!.shown, true, `an open laptop's ${n} is drawn`);
    const ph = await faces("phone", { x: 960, y: 540, rx: -8, ry: 28 });
    assert.equal(ph.screen!.shown, true, "a turned phone's screen is drawn");
  } finally {
    await b.close();
    await server.close();
  }
});
