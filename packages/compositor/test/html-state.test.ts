// Saved screens (`state` layers): a folder the runtime writes while recording
// (`make --states`) — state.html + index.json, pages sharing ../assets — is
// validated against its index and drawn by the HTML renderer as live DOM:
// fitted, cropped, reduced to `only` some elements, or with some hidden.
// The folder here is built by hand to the runtime's contract. Rendering needs
// Chrome for Testing; skips without it.

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { promisify } from "node:util";
import { resolveFfmpeg } from "../src/ffmpeg";
import { serveDirectory } from "../src/html/server";
import { renderLaunch } from "../src/launch-render";
import type { LaunchComposition, LaunchIssue } from "../src/launch-types";
import { validateLaunchComposition } from "../src/launch-validate";
import type { MotionLayer } from "../src/motion-types";
import { findChrome } from "./fixtures/find-chrome";

const exec = promisify(execFile);
const chrome = findChrome();
let dir: string;

// a page the way state.html arrives: the app's scripts inert in place (so
// element paths hold), then the restore script, which tags each indexed
// element by its path and marks the page ready
const page = (body: string, css: string, ids: [string, number[]][]) => `<!doctype html>
<html><head><meta charset="utf-8"><link rel="stylesheet" href="../assets/app.css"><style>${css}</style></head>
<body>${body}<script type="application/x-open-take-inert"></script>
<script>
for (const [id, path] of ${JSON.stringify(ids)}) {
  let n = document.documentElement;
  for (const i of path) n = n.children[i];
  n.dataset.otId = id;
}
document.fonts.ready.then(() => { document.documentElement.dataset.otReady = "1"; });
</script></body></html>`;

const index = (id: string, extra: object = {}) => ({
  version: 1,
  id,
  url: "http://127.0.0.1:5173/",
  title: "App",
  tMs: 1200,
  viewport: { w: 800, h: 500, dpr: 2 },
  scroll: { x: 0, y: 0 },
  elements: [
    { id: "e1", path: [1, 0], tag: "div", box: [0, 0, 800, 60] },
    {
      id: "e2",
      path: [1, 1],
      tag: "button",
      role: "button",
      name: "Go",
      box: [600, 300, 120, 48],
      interactive: true,
    },
    { id: "e3", path: [1, 2], tag: "div", box: [100, 300, 200, 100] },
  ],
  layers: ["e1"],
  ...extra,
});

before(async () => {
  dir = await mkdtemp(join(tmpdir(), "html state "));
  const states = join(dir, "app.take", "states");
  await mkdir(join(states, "assets"), { recursive: true });
  // the shared stylesheet: the page's background comes from ../assets
  await writeFile(join(states, "assets", "app.css"), "body{margin:0;background:#f6f3ec}");
  const ids: [string, number[]][] = [
    ["e1", [1, 0]],
    ["e2", [1, 1]],
    ["e3", [1, 2]],
  ];
  const at = (x: number, y: number, w: number, h: number, bg: string) =>
    `position:absolute;left:${x}px;top:${y}px;width:${w}px;height:${h}px;background:${bg}`;
  for (const [id, css] of [
    ["s1", ""],
    ["s2", "body{background:#22aa55!important}"],
  ] as const) {
    await mkdir(join(states, id));
    await writeFile(
      join(states, id, "state.html"),
      page(
        `<div style="${at(0, 0, 800, 60, "#101112")}"></div><button style="${at(600, 300, 120, 48, "#de3b3d")};border:0"></button><div style="${at(100, 300, 200, 100, "#2f6fde")}"></div>`,
        css,
        ids,
      ),
    );
    await writeFile(join(states, id, "index.json"), JSON.stringify(index(id)));
  }
  await mkdir(join(states, "s3"));
  await writeFile(join(states, "s3", "state.html"), page("", "", []));
  await writeFile(
    join(states, "s3", "index.json"),
    JSON.stringify(index("s3", { fidelity: { psnr: 21.4, diffFrac: 0.31, ok: false } })),
  );
});
after(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});

const W = 640,
  H = 360;
const theme = {
  canvas: "#e8e8e8",
  ink: "#101112",
  surface: "#e8e8e8",
  accent: "#de3b3d",
  dark: "#101112",
  fontFamily: "Helvetica Neue, sans-serif",
};
const film = (scenes: { id: string; layers: MotionLayer[] }[]): LaunchComposition => ({
  version: 1,
  output: { width: W, height: H, fps: 30, motionBlur: false },
  theme,
  scenes: scenes.map((s) => ({ ...s, type: "motion", durationS: 1 })),
});
const paper: MotionLayer = {
  id: "paper",
  type: "rect",
  width: 1920,
  height: 1080,
  fill: "#e8e8e8",
};
const shot = (state: string, extra: object = {}): MotionLayer => ({
  id: "shot",
  type: "state",
  state: `app.take/states/${state}`,
  width: 1000,
  height: 625,
  x: 400,
  ...extra,
});

const problems = (comp: unknown) =>
  validateLaunchComposition(comp, dir).map(
    (i: LaunchIssue) => `${i.severity} ${i.path}: ${i.message}`,
  );

test("a state layer is checked against its saved state", () => {
  assert.deepEqual(problems(film([{ id: "a", layers: [paper, shot("s1")] }])), []);
  const missing = problems(film([{ id: "a", layers: [shot("s9")] }]));
  assert.match(
    missing.join("\n"),
    /error .*\.state: no saved state .* record the take with --states/,
  );
  const ids = problems(
    film([{ id: "a", layers: [shot("s1", { only: ["e2", "e99"], hide: ["x"] })] }]),
  );
  assert.match(ids.join("\n"), /only\[1\]: state s1 has no element e99/);
  assert.match(ids.join("\n"), /hide\[0\]: must be an element id like "e42"/);
  const crop = problems(
    film([{ id: "a", layers: [shot("s1", { crop: { x: 700, y: 0, width: 200, height: 50 } })] }]),
  );
  assert.match(crop.join("\n"), /crop: must stay inside the page \(800x500 CSS px\)/);
  // a state that did not re-render like the recording is flagged, not refused
  const unlike = problems(film([{ id: "a", layers: [shot("s3")] }]));
  assert.equal(unlike.length, 1);
  assert.match(
    unlike[0]!,
    /^warn .*\.state: saved state s3 does not re-render like the recording \(PSNR 21\.4 dB, 31% /,
  );
});

test("saved screens need a film made only of motion scenes", () => {
  const comp = film([{ id: "a", layers: [shot("s1")] }]);
  comp.scenes.push({ id: "t", type: "title", durationS: 1, lines: [{ text: "Hi" }] } as never);
  assert.match(
    problems(comp).join("\n"),
    /state layers \(saved screens\) need a film made only of motion scenes/,
  );
});

// raw paths, sent as written: fetch() would normalise `..` away client-side
const rawGet = (base: string, path: string) =>
  new Promise<number>((ok, fail) => {
    const { hostname, port } = new URL(base);
    request({ hostname, port, path }, (res) => {
      res.resume();
      ok(res.statusCode ?? 0);
    })
      .on("error", fail)
      .end();
  });

test("a mounted folder is served under its prefix and nowhere above it", async () => {
  await writeFile(join(dir, "app.take", "secret.txt"), "not for the page");
  const srv = await serveDirectory(join(dir, "app.take"), {
    "/states/0": join(dir, "app.take", "states"),
  });
  try {
    const ok = await fetch(`${srv.url}/states/0/s1/state.html`);
    assert.equal(ok.status, 200);
    assert.match(await ok.text(), /otReady/);
    assert.equal(await rawGet(srv.url, "/states/0/assets/app.css"), 200);
    assert.equal(await rawGet(srv.url, "/secret.txt"), 200, "the root itself is served");
    for (const path of [
      "/states/0/../secret.txt",
      "/states/0/%2e%2e/secret.txt",
      "/states/0/..%2fsecret.txt",
    ])
      assert.equal(await rawGet(srv.url, path), 404, path);
  } finally {
    await srv.close();
  }
});

async function frames(path: string): Promise<Buffer[]> {
  const { stdout } = await exec(
    await resolveFfmpeg(),
    ["-v", "error", "-i", path, "-f", "rawvideo", "-pix_fmt", "rgb24", "-"],
    { encoding: "buffer", maxBuffer: 256 * 1024 * 1024 },
  );
  const size = W * H * 3;
  const buf = stdout as Buffer;
  return Array.from({ length: buf.length / size }, (_, i) =>
    buf.subarray(i * size, (i + 1) * size),
  );
}
// design px → output px (640/1920 = 1/3, centred)
const pixel = (f: Buffer, x: number, y: number) => {
  const i = (Math.round(H / 2 + y / 3) * W + Math.round(W / 2 + x / 3)) * 3;
  return [f[i]!, f[i + 1]!, f[i + 2]!];
};
const near = (got: number[], want: number[], tol = 14) =>
  got.every((v, i) => Math.abs(v - want[i]!) <= tol);

test("the HTML renderer draws saved screens: fitted, hidden, lifted out, per scene", {
  skip: chrome ? false : "no Chrome for Testing",
  timeout: 180_000,
}, async () => {
  const comp = film([
    {
      id: "a",
      layers: [
        paper,
        // the page at 1.25×: page (px, py) → design (-100 + 1.25 px, -312.5 + 1.25 py)
        shot("s1", { hide: ["e3"] }),
        // the button alone at 3×, crop 10 px around it
        {
          id: "lift",
          type: "state",
          state: "app.take/states/s1",
          only: ["e2"],
          crop: { x: 590, y: 290, width: 140, height: 68 },
          width: 420,
          height: 204,
          x: -560,
        },
      ],
    },
    // the same layer id in another scene shows that scene's own state
    { id: "b", layers: [paper, shot("s2")] },
  ]);
  const compositionPath = join(dir, "film.json");
  await writeFile(compositionPath, JSON.stringify(comp));
  const out = join(dir, "film.mp4");
  await renderLaunch({ composition: comp, compositionPath, outPath: out, chromePath: chrome! });
  const fs = await frames(out);
  assert.equal(fs.length, 60);
  const a = fs[10]!,
    b = fs[45]!;
  const cream = [246, 243, 236],
    red = [222, 59, 61],
    dark = [16, 17, 18],
    grey = [232, 232, 232],
    green = [34, 170, 85];
  assert.ok(
    near(pixel(a, 400, 250), cream),
    `page background from ../assets: ${pixel(a, 400, 250)}`,
  );
  assert.ok(near(pixel(a, 400, -275), dark), `the bar: ${pixel(a, 400, -275)}`);
  assert.ok(near(pixel(a, 725, 92), red), `the button in place: ${pixel(a, 725, 92)}`);
  assert.ok(
    near(pixel(a, 150, 125), cream),
    `hidden → the page shows through: ${pixel(a, 150, 125)}`,
  );
  assert.ok(near(pixel(a, -560, 0), red), `the lifted button: ${pixel(a, -560, 0)}`);
  assert.ok(near(pixel(a, -755, -90), grey), `around it the page is gone: ${pixel(a, -755, -90)}`);
  assert.ok(near(pixel(b, 400, 250), green), `scene b shows s2: ${pixel(b, 400, 250)}`);
});
