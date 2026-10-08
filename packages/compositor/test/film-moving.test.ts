// `film probe` on product material taken while it was still changing: the
// shoot writes `moving` into shots.json, the probe finds the pictures the
// film's page shows (a still, a derived crop of one, a saved screen) in the
// shoots' logs and lists the ones taken on their way — information only.

import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { formatMovingMaterial, readMovingMaterial, stillFor } from "../src/film/moving";
import { filmProbe } from "../src/film/probe";
import { servedPath } from "../src/film/probe-text";
import { renderFilm } from "../src/film/render";
import { findChrome } from "./fixtures/find-chrome";

const chrome = findChrome();
let dir = "";

// a 1×1 PNG: the probe matches pictures by file, not by what they show
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

const still = (file: string, extra: object = {}) => ({
  file,
  name: file.replace(/^\d+-|\.png$/g, ""),
  t: 0,
  cursor: { x: 0, y: 0 },
  scroll: { x: 0, y: 0 },
  boxes: {},
  ...extra,
});
const counting = {
  moving: { texts: [{ x: 100, y: 40, before: "993", after: "1,130" }], animations: 0 },
};

/** a film folder: a shoot with two drag steps (one caught counting) and a
 *  saved screen kept with a still that was, a crop folder of JPEG copies,
 *  and an older shoot whose log does not record it */
async function fixture(root: string) {
  const shots = join(root, "shots", "calc");
  await mkdir(join(shots, "states", "calc"), { recursive: true });
  await mkdir(join(root, "shots", "calc-crop"), { recursive: true });
  await mkdir(join(root, "shots", "old"), { recursive: true });
  await writeFile(
    join(shots, "shots.json"),
    JSON.stringify({
      viewport: { w: 800, h: 600 },
      scale: 2,
      steady: true,
      stills: [
        still("000-m-1.png", counting),
        still("001-m-2.png", { steadyMs: 1500 }),
        still("002-calc.png", { ...counting, state: "calc" }),
      ],
    }),
  );
  await writeFile(
    join(root, "shots", "old", "shots.json"),
    JSON.stringify({ viewport: { w: 800, h: 600 }, scale: 2, stills: [still("000-home.png")] }),
  );
  for (const f of ["000-m-1.png", "001-m-2.png", "002-calc.png"])
    await writeFile(join(shots, f), PNG);
  await writeFile(join(root, "shots", "calc-crop", "000-m-1.jpg"), PNG);
  await writeFile(join(root, "shots", "old", "000-home.png"), PNG);
  await writeFile(
    join(shots, "states", "calc", "state.html"),
    `<!doctype html><html><body style="margin:0;background:#eee"><p id="total">1,130</p></body></html>`,
  );
}

before(async () => {
  dir = await mkdtemp(join(tmpdir(), "open-take-moving-"));
});
after(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});

test("servedPath: a served URL as a path from the root; anything else as it was", () => {
  assert.equal(
    servedPath("http://127.0.0.1:5000/shots/a%20b/001-x.png?v=2", "http://127.0.0.1:5000"),
    "/shots/a b/001-x.png",
  );
  assert.equal(
    servedPath("https://cdn.example/x.png", "http://127.0.0.1:5000"),
    "https://cdn.example/x.png",
  );
});

test("the pictures on screen whose still was taken changing: by file, by a copy's name, by its saved screen", async () => {
  const root = join(dir, "unit");
  await fixture(root);
  const m = readMovingMaterial(
    [
      { t: 0, media: [{ src: "/shots/old/000-home.png" }] },
      { t: 0.5, media: [{ src: "/shots/calc-crop/000-m-1.jpg" }, { label: "no src" } as never] },
      { t: 1, media: [{ src: "/shots/calc-crop/000-m-1.jpg" }] },
      { t: 1.5, media: [{ src: "/shots/calc/001-m-2.png" }] },
      {
        t: 2,
        media: [{ src: "/shots/calc/states/calc/state.html" }, { src: "https://x.example/a.png" }],
      },
    ],
    root,
  );
  assert.equal(m.how, "measured");
  assert.equal(m.logs, 2);
  assert.equal(m.matched, 4, "the old still, the crop, the settled step, the saved screen");
  assert.equal(m.unrecorded, 1, "the old shoot's still");
  assert.deepEqual(
    m.list.map((e) => [e.src, e.still, e.times, e.texts]),
    [
      [
        join("shots", "calc-crop", "000-m-1.jpg"),
        "m-1",
        [0.5, 1],
        [{ before: "993", after: "1,130" }],
      ],
      [
        join("shots", "calc", "states", "calc", "state.html"),
        "calc",
        [2],
        [{ before: "993", after: "1,130" }],
      ],
    ],
  );
  assert.equal(m.list[0]!.log, join("shots", "calc", "shots.json"));
  const md = formatMovingMaterial(m).join("\n");
  assert.match(
    md,
    /^## Product material taken while it was changing\n\[measured at the shoot\] 2 picture\(s\)/,
  );
  assert.match(
    md,
    /0\.50 s–1\.00 s: shots\/calc-crop\/000-m-1\.jpg \(still "m-1" in shots\/calc\/shots\.json\) — "993" → "1,130"/,
  );
  assert.match(md, /1 of them from a shoot that did not record this/);
  assert.doesNotMatch(md, /should|too (small|many)|issue|fail/i);

  // nothing on its way, and no page at all
  const none = readMovingMaterial([{ t: 0, media: [{ src: "/shots/calc/001-m-2.png" }] }], root);
  assert.equal(none.list.length, 0);
  assert.match(formatMovingMaterial(none).join("\n"), /no picture on screen was taken while/);
  const off = readMovingMaterial(null, null, { note: "no page given (--page)" });
  assert.equal(off.how, "not measured");
  assert.match(formatMovingMaterial(off).join("\n"), /\[not measured\] no page given/);
});

test("stillFor: among shoots with the same file name, the one nearest the picture", async () => {
  const logs = [
    {
      path: "/f/a/shots.json",
      dir: "/f/a",
      records: true,
      stills: [{ file: "000-home.png", name: "a" }],
    },
    {
      path: "/f/b/shots.json",
      dir: "/f/b",
      records: true,
      stills: [{ file: "000-home.png", name: "b" }],
    },
  ];
  assert.equal(stillFor("/f/b/jpg/000-home.jpg", logs)?.still.name, "b");
  assert.equal(stillFor("/f/a/000-home.png", logs)?.still.name, "a");
  assert.equal(stillFor("/f/c/001-other.png", logs), null);
});

test("film probe lists a still on screen that its shoot took mid-count, read off the page as played", {
  skip: chrome ? false : "no Chrome for Testing",
}, async () => {
  const root = join(dir, "e2e");
  await fixture(root);
  const page = join(root, "page");
  await mkdir(page, { recursive: true });
  // the crop of the counting step, then the settled step
  await writeFile(
    join(page, "index.html"),
    `<!doctype html><html><head><style>body{margin:0;width:320px;height:180px;overflow:hidden;background:#fff}
img{position:absolute;left:0;top:0;width:320px;height:180px}</style></head><body>
<img id="a" src="../shots/calc-crop/000-m-1.jpg"><img id="b" src="../shots/calc/001-m-2.png">
<script>
window.__film = { duration: 2, width: 320, height: 180, fps: 10 };
window.__render = (t) => {
  document.getElementById("a").style.display = t < 1 ? "block" : "none";
  document.getElementById("b").style.display = t < 1 ? "none" : "block";
};
</script></body></html>`,
  );
  const out = join(root, "film.mp4");
  await renderFilm({ page, root, out, chromePath: chrome!, blur: false, audio: null, workers: 1 });
  const pr = await filmProbe({
    input: out,
    page,
    root,
    chromePath: chrome!,
    text: false,
    textEvery: 0.5,
    out: join(root, "film.probe"),
  });
  const m = pr.probe.moving;
  assert.equal(m.how, "measured");
  assert.deepEqual(
    m.list.map((e) => [e.src, e.times]),
    [[join("shots", "calc-crop", "000-m-1.jpg"), [0, 0.5]]],
    JSON.stringify(m),
  );
  const md = await readFile(pr.md, "utf8");
  assert.match(
    md,
    /## Product material taken while it was changing\n\[measured at the shoot\] 1 picture/,
  );
});
