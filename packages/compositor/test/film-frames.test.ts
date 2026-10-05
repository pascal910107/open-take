// A film-timed <video> shown as its decoded frames (film/frames.ts and the
// film clock): the frame at film time, wherever it is drawn. Chrome for
// Testing; the browser tests skip without it.

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { promisify } from "node:util";
import { resolveFfmpeg } from "../src/ffmpeg";
import { filmClockSource } from "../src/film/clock";
import { decodeFrames, frameStore, type VideoFrames } from "../src/film/frames";
import { filmStills } from "../src/film/render";
import { launchHtmlBrowser } from "../src/html/cdp";
import { serveDirectory } from "../src/html/server";
import { findChrome } from "./fixtures/find-chrome";

const exec = promisify(execFile);
const chrome = findChrome();
const skip = chrome ? false : "no Chrome for Testing";

let dir = "";
before(async () => {
  dir = await mkdtemp(join(tmpdir(), "open-take-frames-test-"));
});
after(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** 2 s at 10 fps, frame N a flat colour: red N×12, green 255−N×12, blue 128 */
async function numberedClip(file: string): Promise<void> {
  await exec(await resolveFfmpeg(), [
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "color=c=black:s=64x64:r=10:d=2,format=rgb24,geq=r='N*12':g='255-N*12':b='128'",
    "-c:v",
    "libx264",
    "-g",
    "30",
    "-pix_fmt",
    "yuv420p",
    "-y",
    file,
  ]);
}
const colourOf = (n: number) => [n * 12, 255 - n * 12, 128];

/** the RGB at (x, y) of a PNG `w` px wide */
async function pixel(file: string, w: number, h: number, x: number, y: number) {
  const { stdout } = await exec(
    await resolveFfmpeg(),
    ["-v", "error", "-i", file, "-f", "rawvideo", "-pix_fmt", "rgb24", "-"],
    { encoding: "buffer", maxBuffer: 1 << 24 },
  );
  const b = stdout as Buffer;
  assert.equal(b.length, w * h * 3);
  const i = (y * w + x) * 3;
  return [b[i]!, b[i + 1]!, b[i + 2]!];
}
const near = (a: number[], b: number[], what: string) =>
  assert.ok(
    a.every((v, i) => Math.abs(v - b[i]!) <= 12),
    `${what}: ${a.join(",")} vs ${b.join(",")}`,
  );

test("a video's frames come out in presentation order, each with its own time, a varying rate included", async () => {
  const out = join(dir, "vfr");
  await exec("mkdir", ["-p", join(out, "frames")]);
  // frame N at N²/100 s: 0, 0.01, 0.04 … 0.81
  await exec(await resolveFfmpeg(), [
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "color=c=red:s=32x32:r=10:d=1",
    "-vf",
    // in milliseconds all the way: a coarser time base would round them away
    "settb=1/1000,setpts=N*N*10",
    "-fps_mode",
    "passthrough",
    "-enc_time_base",
    "1:1000",
    "-video_track_timescale",
    "1000",
    "-c:v",
    "libx264",
    "-y",
    join(out, "vfr.mp4"),
  ]);
  const { times, ext } = await decodeFrames(join(out, "vfr.mp4"), join(out, "frames"));
  assert.equal(ext, "jpg");
  assert.equal(times.length, 10);
  for (const [n, t] of times.entries())
    assert.ok(Math.abs(t - (n * n) / 100) < 0.002, `frame ${n} at ${t}, not ${(n * n) / 100}`);
  assert.equal((await readdir(join(out, "frames"))).length, 10);
});

test("a film-timed video shows the frame at film time — sought by the page, played by itself, or drawn into a canvas", {
  skip,
}, async () => {
  const page = join(dir, "shown");
  await exec("mkdir", ["-p", page]);
  await numberedClip(join(page, "clip.mp4"));
  // left: a video the page sets to t and waits for; middle: a canvas the
  // page draws that video into once it is there; right: a video playing by
  // itself on film time. A strip under each says how it was shown: green
  // for its frame image, red for the element sought
  await writeFile(
    join(page, "index.html"),
    `<!doctype html><html><head><style>body{margin:0;width:192px;height:80px;background:#000}
video,canvas{position:absolute;top:0;width:64px;height:64px}
.flag{position:absolute;top:66px;width:64px;height:14px}</style></head><body>
<video id="a" src="clip.mp4" muted style="left:0"></video>
<canvas id="c" width="64" height="64" style="left:64px"></canvas>
<video id="p" src="clip.mp4" muted autoplay style="left:128px"></video>
<div class="flag" id="fa" style="left:0"></div><div class="flag" id="fp" style="left:128px"></div>
<script>
window.__film = { duration: 2, width: 192, height: 80 };
const a = document.getElementById("a"), p = document.getElementById("p");
const c = document.getElementById("c").getContext("2d");
const framed = (v) => getComputedStyle(v).content.includes("/__open-take/frames/");
window.__render = async (t) => {
  if (a.readyState < 1) await new Promise((r) => a.addEventListener("loadedmetadata", r, { once: true }));
  await new Promise((r) => { a.addEventListener("seeked", r, { once: true }); a.currentTime = t; });
  c.drawImage(a, 0, 0, 64, 64);
  document.getElementById("fa").style.background = framed(a) ? "#0f0" : "#f00";
  document.getElementById("fp").style.background = framed(p) ? "#0f0" : "#f00";
};
</script></body></html>`,
  );
  const out = join(page, "stills");
  const files = await filmStills({
    page,
    outDir: out,
    at: [0.25, 0.95, 1.55],
    chromePath: chrome!,
  });
  for (const [k, t] of [0.25, 0.95, 1.55].entries()) {
    const f = files[k]!;
    const n = Math.floor(t * 10 + 1e-6);
    near(await pixel(f, 192, 80, 32, 32), colourOf(n), `the page's video at ${t}s`);
    near(await pixel(f, 192, 80, 96, 32), colourOf(n), `the canvas at ${t}s`);
    near(await pixel(f, 192, 80, 160, 32), colourOf(n), `the playing video at ${t}s`);
    if (k > 0) {
      near(await pixel(f, 192, 80, 32, 72), [0, 255, 0], `the page's video framed at ${t}s`);
      near(await pixel(f, 192, 80, 160, 72), [0, 255, 0], `the playing video framed at ${t}s`);
    }
  }
});

test("a video the page reads frame by frame itself, and any video with no renderer to ask, is sought as before", {
  skip,
}, async () => {
  const page = join(dir, "sought");
  await exec("mkdir", ["-p", page]);
  await numberedClip(join(page, "clip.mp4"));
  await writeFile(
    join(page, "index.html"),
    `<!doctype html><html><body style="margin:0">
<video id="r" src="clip.mp4" muted autoplay></video><video id="v" src="clip.mp4" muted autoplay></video>
<script>
window.__film = { duration: 2 };
const r = document.getElementById("r");
r.requestVideoFrameCallback(() => {});
window.framed = () => ["r", "v"].map((id) =>
  getComputedStyle(document.getElementById(id)).content.includes("/__open-take/frames/")).join();
window.at = () => ["r", "v"].map((id) => Math.round(document.getElementById(id).currentTime * 1000)).join();
</script></body></html>`,
  );
  const server = await serveDirectory(page);
  const store = frameStore({ root: page, server });
  const open = async (withRenderer: boolean) => {
    let b: Awaited<ReturnType<typeof launchHtmlBrowser>> | null = null;
    b = await launchHtmlBrowser({
      chromePath: chrome!,
      url: `${server.url}/index.html`,
      width: 128,
      height: 64,
      initScript: filmClockSource({ seed: 1, epochMs: 0 }),
      stillAnimations: true,
      ...(withRenderer
        ? {
            bindings: {
              __otFrames: (payload: string) => {
                const { src } = JSON.parse(payload) as { src: string };
                const reply = (f: VideoFrames | null) =>
                  b?.evaluate(
                    `window.__ot.framesReady(${JSON.stringify(src)}, ${JSON.stringify(f)})`,
                  );
                store.frames(src).then(reply, () => reply(null));
              },
            },
          }
        : {}),
    });
    return b;
  };
  try {
    for (const withRenderer of [true, false]) {
      const b = await open(withRenderer);
      try {
        await b.evaluate("window.__ot.prepare()");
        for (let i = 0; i < 300; i++) {
          if (await b.evaluate<boolean>("document.getElementById('v').readyState >= 2")) break;
          await new Promise((ok) => setTimeout(ok, 10));
        }
        await b.evaluate("window.__ot.seek(1.25)");
        assert.equal(
          await b.evaluate<string>("window.framed()"),
          withRenderer ? "false,true" : "false,false",
          withRenderer
            ? "the video read frame by frame is sought; the other framed"
            : "no renderer: both sought",
        );
        assert.equal(await b.evaluate<string>("window.at()"), "1250,1250", "both at film time");
      } finally {
        await b.close();
      }
    }
  } finally {
    await store.clean();
    await server.close();
  }
});
