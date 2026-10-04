// The film kit's material (kit/media.js), `film init` and `film picture`:
// saved screens measured where they are now, shot stills played by time,
// a screen drawn at twice its pixels. Chrome for Testing; the browser tests
// skip without it.

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { promisify } from "node:util";
import { resolveFfmpeg } from "../src/ffmpeg";
import { initFilm } from "../src/film/kit";
import { filmPicture } from "../src/film/picture";
import { filmStills } from "../src/film/render";
import { findChrome } from "./fixtures/find-chrome";

const exec = promisify(execFile);
const chrome = findChrome();
const skip = chrome ? false : "no Chrome for Testing";

let dir = "";
before(async () => {
  dir = await mkdtemp(join(tmpdir(), "open-take-film-kit-test-"));
  // a saved screen: 320×180, a green box at (200, 100) 40×30, and its index
  const s1 = join(dir, "states", "s1");
  await mkdir(s1, { recursive: true });
  await writeFile(
    join(s1, "state.html"),
    `<!doctype html><html><head><style>html,body{margin:0;width:320px;height:180px;background:#fff}
#t{position:absolute;left:200px;top:100px;width:40px;height:30px;background:#0c0}</style></head><body><div id="t"></div></body></html>`,
  );
  await writeFile(
    join(s1, "index.json"),
    JSON.stringify({
      viewport: { w: 320, h: 180, dpr: 2 },
      scroll: { x: 0, y: 0 },
      elements: [
        { id: "e0", tag: "html", box: [0, 0, 320, 180] },
        { id: "e1", tag: "div", box: [200, 100, 40, 30] },
      ],
    }),
  );
});
after(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function rgb(file: string, w: number, h: number): Promise<Buffer> {
  const ffmpeg = await resolveFfmpeg();
  const { stdout } = await exec(
    ffmpeg,
    [
      "-v",
      "error",
      "-i",
      file,
      "-frames:v",
      "1",
      "-vf",
      `scale=${w}:${h}:flags=neighbor`,
      "-f",
      "rawvideo",
      "-pix_fmt",
      "rgb24",
      "-",
    ],
    { encoding: "buffer", maxBuffer: 1 << 26 },
  );
  return stdout as Buffer;
}
const px = (buf: Buffer, w: number, x: number, y: number) => {
  const i = (Math.round(y) * w + Math.round(x)) * 3;
  return [buf[i]!, buf[i + 1]!, buf[i + 2]!] as const;
};
const isRed = ([r, g, b]: readonly number[]) => r! > 180 && g! < 80 && b! < 80;
const isBlue = ([r, g, b]: readonly number[]) => r! < 80 && g! < 80 && b! > 180;
const isGreen = ([r, g, b]: readonly number[]) => r! < 80 && g! > 150 && b! < 80;
const isMagenta = ([r, g, b]: readonly number[]) => r! > 180 && g! < 80 && b! > 180;

test("film init copies the kit and a page to start from, and keeps what the author changed", async () => {
  const film = join(dir, "init");
  const first = await initFilm({ dir: film });
  const names = first.written.map((f) => f.slice(film.length + 1)).sort();
  for (const n of ["index.html", "kit/camera.js", "kit/cursor.js", "kit/media.js", "kit/time.js"])
    assert.ok(names.includes(n), `${n} written`);
  // the author changes the camera and the page
  await writeFile(join(film, "kit", "camera.js"), "// mine\n");
  await writeFile(join(film, "index.html"), "<!-- mine -->");
  const again = await initFilm({ dir: film });
  assert.deepEqual(
    again.kept.map((f) => f.slice(film.length + 1)),
    ["kit/camera.js"],
  );
  assert.equal(
    await readFile(join(film, "index.html"), "utf8"),
    "<!-- mine -->",
    "the page is never replaced",
  );
  const forced = await initFilm({ dir: film, force: true });
  assert.ok(forced.written.some((f) => f.endsWith("kit/camera.js")));
  assert.notEqual(await readFile(join(film, "kit", "camera.js"), "utf8"), "// mine\n");
});

test("a saved screen's parts are where the camera puts them: live by selector, as captured by id", {
  skip,
}, async () => {
  const film = join(dir, "screen");
  await initFilm({ dir: film });
  await writeFile(
    join(film, "index.html"),
    `<!doctype html><html><head><style>html,body{margin:0;width:320px;height:180px;overflow:hidden;background:#000}
#layer{position:absolute;left:0;top:0;width:320px;height:180px;transform-origin:0 0}
#shot{position:absolute;left:0;top:0;width:320px;height:180px;border:0}
.mark{position:absolute;width:6px;height:6px;margin:-3px 0 0 -3px}</style></head><body>
<div id="layer"><iframe id="shot" src="../states/s1/state.html"></iframe></div>
<div class="mark" id="sel" style="background:#f00"></div><div class="mark" id="idx" style="background:#00f"></div>
<script type="module">
import { camera } from "./kit/camera.js";
import { screen } from "./kit/media.js";
const s = screen(document.getElementById("shot"));
const cam = camera({ content: { width: 320, height: 180 } });
const ready = s.ready.then(() => cam.frame(s.box("#t"), { arrive: 1, dur: 0.5 }));
window.__film = { duration: 2, width: 320, height: 180, ready };
window.__render = (t) => {
  document.getElementById("layer").style.transform = cam.transform(t);
  const b = s.box("#t");
  const [x, y] = cam.toView(b.x + b.width / 2, b.y + b.height / 2, t);
  Object.assign(document.getElementById("sel").style, { left: x + "px", top: y + "px" });
  const e = s.box("e1");
  const [x2, y2] = cam.toView(e.x + 4, e.y + 4, t);
  Object.assign(document.getElementById("idx").style, { left: x2 + "px", top: y2 + "px" });
};
</script></body></html>`,
  );
  const [atRest, framed] = await filmStills({
    page: join(film, "index.html"),
    root: dir,
    chromePath: chrome!,
    at: [0, 1.5],
    outDir: join(dir, "screen-stills"),
    blur: false,
  });
  const a = await rgb(atRest!, 320, 180);
  assert.ok(isRed(px(a, 320, 220, 115)), "at full view the mark sits on the box's centre");
  assert.ok(isBlue(px(a, 320, 204, 104)), "the index box is where it was captured");
  const b = await rgb(framed!, 320, 180);
  // framed: the box's centre in the middle of the picture, at 60 % fill (×3.6)
  assert.ok(isRed(px(b, 320, 160, 90)), "framed, the mark follows the box to the picture's centre");
  assert.ok(isGreen(px(b, 320, 160 + 20, 90)), "the box itself is there, magnified");
  assert.ok(
    isBlue(px(b, 320, 160 - 16 * 3.6, 90 - 11 * 3.6)),
    "the index box is magnified with it",
  );
});

test("a screen measured inside a layer: its offset counted, a transform in between refused", {
  skip,
}, async () => {
  const film = join(dir, "inside");
  await initFilm({ dir: film });
  const page = (
    wrap: string,
  ) => `<!doctype html><html><head><style>html,body{margin:0;width:400px;height:240px;overflow:hidden;background:#000}
#layer{position:relative;width:400px;height:240px}
#shot{position:absolute;left:30px;top:20px;width:320px;height:180px;border:0}
.mark{position:absolute;width:6px;height:6px;margin:-3px 0 0 -3px;background:#f00}</style></head><body>
<div id="layer">${wrap}</div><div class="mark" id="m"></div>
<script type="module">
import { screen } from "./kit/media.js";
const s = screen(document.getElementById("shot"));
window.__film = { duration: 1, width: 400, height: 240, ready: s.ready };
window.__render = () => {
  try {
    const b = s.box("#t", { in: document.getElementById("layer") });
    Object.assign(document.getElementById("m").style, { left: b.x + b.width / 2 + "px", top: b.y + b.height / 2 + "px" });
  } catch (e) {
    document.body.style.background = /transformed/.test(String(e)) ? "#f0f" : "#ff0";
  }
};
</script></body></html>`;
  await writeFile(
    join(film, "plain.html"),
    page(`<iframe id="shot" src="../states/s1/state.html"></iframe>`),
  );
  await writeFile(
    join(film, "scaled.html"),
    page(
      `<div style="transform:scale(1.5);transform-origin:0 0"><iframe id="shot" src="../states/s1/state.html"></iframe></div>`,
    ),
  );
  const [plain] = await filmStills({
    page: join(film, "plain.html"),
    root: dir,
    chromePath: chrome!,
    at: [0.5],
    outDir: join(dir, "inside-plain"),
    blur: false,
  });
  assert.ok(
    isRed(px(await rgb(plain!, 400, 240), 400, 30 + 220, 20 + 115)),
    "the frame's offset in the layer is added",
  );
  const [scaled] = await filmStills({
    page: join(film, "scaled.html"),
    root: dir,
    chromePath: chrome!,
    at: [0.5],
    outDir: join(dir, "inside-scaled"),
    blur: false,
  });
  // (the scaled frame covers most of the page: read the body in the corner it leaves)
  assert.ok(
    isMagenta(px(await rgb(scaled!, 400, 240), 400, 5, 5)),
    "a transform in between is refused, not measured wrong",
  );
});

test("shot stills play by film time, decoded before the frame, a bounded few held", {
  skip,
}, async () => {
  const film = join(dir, "stills");
  await initFilm({ dir: film });
  const shots = join(film, "shots");
  await mkdir(shots, { recursive: true });
  const ffmpeg = await resolveFfmpeg();
  const colours = ["red", "lime", "blue"];
  for (const [i, c] of colours.entries())
    await exec(ffmpeg, [
      "-v",
      "error",
      "-y",
      "-f",
      "lavfi",
      "-i",
      `color=c=${c}:s=640x360`,
      "-frames:v",
      "1",
      join(shots, `00${i}.png`),
    ]);
  await writeFile(
    join(shots, "shots.json"),
    JSON.stringify({
      viewport: { w: 320, h: 180 },
      scale: 2,
      stills: colours.map((_, i) => ({
        file: `00${i}.png`,
        t: i * 0.1,
        cursor: { x: 10 * i, y: 105 },
        scroll: { x: 0, y: 100 },
        boxes: { "#a": { x: i, y: 102, width: 3, height: 4 } },
      })),
    }),
  );
  await writeFile(
    join(film, "index.html"),
    `<!doctype html><html><head><style>html,body{margin:0;width:320px;height:180px;overflow:hidden;background:#000}
img{position:absolute;left:0;top:0;width:320px;height:180px}
#wrong{display:none;position:absolute;left:0;top:0;width:320px;height:180px;background:#f0f}</style></head><body><img id="still" alt=""><div id="wrong"></div>
<script type="module">
import { stills } from "./kit/media.js";
const ready = stills("shots/shots.json", document.getElementById("still"), { keep: 1, ahead: 0 });
window.__film = { duration: 3, width: 320, height: 180, ready };
window.__render = async (t) => {
  const st = await ready;
  // the log's page px, less each still's scroll: the still's own px
  const b = st.box(2, "#a"), c = st.cursor(1);
  if (b.x !== 2 || b.y !== 2 || c.x !== 10 || c.y !== 5 || st.count !== 3)
    document.getElementById("wrong").style.display = "block";
  await st.show(st.at(t, { rate: 1 }));
};
</script></body></html>`,
  );
  const files = await filmStills({
    page: join(film, "index.html"),
    chromePath: chrome!,
    at: [2.5, 0.5, 1.5],
    outDir: join(dir, "stills-out"),
    blur: false,
  });
  const seen = await Promise.all(
    files.map((f) => rgb(f, 320, 180).then((b) => px(b, 320, 160, 90))),
  );
  // files come back in time order: 0.5, 1.5, 2.5
  assert.ok(isRed(seen[0]!), "still 0 at 0.5 s");
  assert.ok(isGreen(seen[1]!), "still 1 at 1.5 s");
  assert.ok(isBlue(seen[2]!), "still 2 at 2.5 s");
});

test("film picture draws a saved screen at twice its pixels, where the screen puts things", {
  skip,
}, async () => {
  const out = join(dir, "picture.png");
  const r = await filmPicture({
    state: join(dir, "states", "s1"),
    chromePath: chrome!,
    scale: 2,
    out,
  });
  assert.deepEqual([r.width, r.height], [640, 360]);
  const p = await rgb(out, 640, 360);
  assert.ok(isGreen(px(p, 640, 2 * 220, 2 * 115)), "the box at twice its place");
  const [r0, g0, b0] = px(p, 640, 20, 20);
  assert.ok(r0 > 240 && g0 > 240 && b0 > 240, "the page's white elsewhere");
});
