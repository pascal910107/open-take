// A page's will-change hints are dropped while it is rendered: Chrome draws
// such a layer once and scales that picture, so a layer the camera enlarges
// shows soft text. --keep-layers keeps them. Chrome for Testing; the browser
// test skips without it.

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { promisify } from "node:util";
import { resolveFfmpeg } from "../src/ffmpeg";
import { filmStills } from "../src/film/render";
import { findChrome } from "./fixtures/find-chrome";

const exec = promisify(execFile);
const chrome = findChrome();
const skip = chrome ? false : "no Chrome for Testing";
let dir = "";

before(async () => {
  dir = await mkdtemp(join(tmpdir(), "open-take-layers-"));
});
after(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});

/** the colour at the middle of a PNG */
async function middle(file: string): Promise<[number, number, number]> {
  const { stdout } = await exec(
    await resolveFfmpeg(),
    [
      "-v",
      "error",
      "-i",
      file,
      "-vf",
      "crop=1:1:160:90",
      "-f",
      "rawvideo",
      "-pix_fmt",
      "rgb24",
      "-",
    ],
    { encoding: "buffer" },
  );
  return [stdout[0]!, stdout[1]!, stdout[2]!];
}

test("will-change is dropped while rendering, kept with keepLayers", { skip }, async () => {
  const page = join(dir, "page");
  await mkdir(page, { recursive: true });
  // the page paints itself green when its layer's will-change is gone, red
  // when it is still there — set by a stylesheet and by a script, inline
  await writeFile(
    join(page, "index.html"),
    `<!doctype html><html><head><style>body{margin:0;width:320px;height:180px;overflow:hidden}
#l{will-change:transform;width:100px;height:40px;transform:scale(2)}</style></head>
<body><div id="l">layer</div><div id="i" style="will-change:transform">inline</div>
<script>window.__film = { duration: 1, width: 320, height: 180 };
addEventListener("load", () => {
  const gone = ["l", "i"].every((id) => getComputedStyle(document.getElementById(id)).willChange === "auto");
  document.body.style.background = gone ? "rgb(0,255,0)" : "rgb(255,0,0)";
});</script></body></html>`,
  );
  const shot = async (keepLayers: boolean) => {
    const [file] = await filmStills({
      page,
      chromePath: chrome!,
      at: [0.5],
      outDir: join(dir, keepLayers ? "kept" : "dropped"),
      blur: false,
      keepLayers,
    });
    return middle(file!);
  };
  const [r, g] = await shot(false);
  assert.ok(g > 200 && r < 60, `dropped: rgb ${r},${g}`);
  const [r2, g2] = await shot(true);
  assert.ok(r2 > 200 && g2 < 60, `kept: rgb ${r2},${g2}`);
});
