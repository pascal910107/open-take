// `film render` / `film still`: a page the author wrote, played on film time.
// Chrome for Testing; the browser tests skip without it.

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { promisify } from "node:util";
import { resolveFfmpeg, resolveFfprobe } from "../src/ffmpeg";
import {
  checkFilm,
  type FilmCheck,
  findClicks,
  judgeFilm,
  motionFindings,
  readPicture,
} from "../src/film/check";
import { filmClockSource, filmMarks } from "../src/film/clock";
import { readPageLayout } from "../src/film/layout";
import {
  balancedSlices,
  drainOrFail,
  filmStills,
  renderFilm,
  samplesFor,
  sampleTimes,
} from "../src/film/render";
import { launchHtmlBrowser } from "../src/html/cdp";
import { serveDirectory } from "../src/html/server";
import { findChrome } from "./fixtures/find-chrome";

const exec = promisify(execFile);
const chrome = findChrome();
const skip = chrome ? false : "no Chrome for Testing";

let dir = "";
before(async () => {
  dir = await mkdtemp(join(tmpdir(), "open-take-film-test-"));
});
after(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** a PNG (or a video frame) as raw RGB */
async function rgb(file: string, w: number, h: number, atS?: number): Promise<Buffer> {
  const ffmpeg = await resolveFfmpeg();
  const args = [
    "-v",
    "error",
    ...(atS != null ? ["-ss", String(atS)] : []),
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
  ];
  const { stdout } = await exec(ffmpeg, args, { encoding: "buffer", maxBuffer: 1 << 26 });
  return stdout as Buffer;
}
/** the first x on row y where `hit` holds */
function leftEdge(
  px: Buffer,
  w: number,
  y: number,
  hit: (r: number, g: number, b: number) => boolean,
) {
  for (let x = 0; x < w; x++) {
    const i = (y * w + x) * 3;
    if (hit(px[i]!, px[i + 1]!, px[i + 2]!)) return x;
  }
  return null;
}

test("sample times spread over a 180° shutter centred on the frame, never before 0", () => {
  assert.deepEqual(sampleTimes(1, 1, 60), [1]);
  const s = sampleTimes(1, 4, 60);
  assert.equal(s.length, 4);
  assert.ok(Math.abs(s[3]! - s[0]! - (0.5 / 60) * 0.75) < 1e-12);
  assert.ok(Math.abs((s[0]! + s[3]!) / 2 - 1) < 1e-12);
  assert.ok(sampleTimes(0, 4, 60).every((t) => t >= 0));
  assert.equal(samplesFor(0), 1);
  assert.equal(samplesFor(7), 3);
  assert.equal(samplesFor(1000), 16);
});

test("a shutter that cuts on one side is spread over the other side only", () => {
  const open = 0.5 / 60;
  const after = sampleTimes(1, 4, 60, 1);
  assert.ok(
    after.every((t) => t > 1 && t < 1 + open / 2),
    "after the frame time, within half the shutter",
  );
  const before = sampleTimes(1, 4, 60, -1);
  assert.ok(
    before.every((t) => t < 1 && t > 1 - open / 2),
    "before the frame time, within half the shutter",
  );
  assert.deepEqual(sampleTimes(1, 1, 60, 1), [1], "one sample is the frame time itself");
  assert.deepEqual(sampleTimes(1, 4, 60, 0), sampleTimes(1, 4, 60), "side 0 is the whole shutter");
});

test("a full pipe whose ffmpeg has died fails the wait instead of hanging it", async () => {
  const { PassThrough } = await import("node:stream");
  // a stream that never drains, its process gone with an error
  const stream = new PassThrough();
  let die: (e: Error) => void = () => {};
  const ended = new Promise((_, fail) => {
    die = fail;
  });
  ended.catch(() => {});
  const wait = drainOrFail(stream, ended);
  die(new Error("film: ffmpeg decoder exited 1"));
  await assert.rejects(wait, /decoder exited 1/);
  // one that ended cleanly with samples still to come fails too
  await assert.rejects(drainOrFail(new PassThrough(), Promise.resolve()), /ended before/);
  // and a drain is a drain
  const s = new PassThrough();
  const ok = drainOrFail(s, new Promise(() => {}));
  s.emit("drain");
  await ok;
});

test("frames are cut into contiguous slices of about equal cost", () => {
  const costs = [1, 1, 1, 1, 8, 8, 1, 1, 1, 1];
  const slices = balancedSlices(costs, 3);
  assert.equal(slices[0]![0], 0);
  assert.equal(slices.at(-1)![1], costs.length);
  for (let i = 1; i < slices.length; i++) assert.equal(slices[i]![0], slices[i - 1]![1]);
  assert.equal(slices.length, 3);
  // each slice within one frame's cost of an equal share
  const total = costs.reduce((a, b) => a + b, 0);
  for (const [a, b] of slices) {
    const cost = costs.slice(a, b).reduce((x, y) => x + y, 0);
    assert.ok(Math.abs(cost - total / 3) <= Math.max(...costs), `slice ${a}–${b} costs ${cost}`);
  }
});

test("a page that just animates runs on film time: CSS, requestAnimationFrame, timers", {
  skip,
}, async () => {
  const page = join(dir, "clock");
  await exec("mkdir", ["-p", page]);
  await writeFile(
    join(page, "index.html"),
    `<!doctype html><html><head><meta charset="utf-8"><style>
body{margin:0;background:#111;width:1920px;height:1080px;overflow:hidden}
.box{position:absolute;top:100px;left:0;width:200px;height:200px;background:#e33;animation:slide 2s linear forwards}
@keyframes slide{from{transform:translateX(0)}to{transform:translateX(1600px)}}
#c{position:absolute;top:400px;left:0}
.late{position:absolute;top:700px;left:0;width:100px;height:100px;background:#3e3;transition:transform 1s linear}
</style></head><body><div class="box"></div><canvas id="c" width="1920" height="200"></canvas><div class="late" id="late"></div>
<script>
window.__film = { duration: 2 };
const ctx = document.getElementById('c').getContext('2d');
function loop(t){ ctx.clearRect(0,0,1920,200); ctx.fillStyle='#39f'; ctx.fillRect((t/2000)*1700,50,200,100); requestAnimationFrame(loop); }
requestAnimationFrame(loop);
setTimeout(() => { document.getElementById('late').style.transform = 'translateX(1000px)'; }, 1000);
</script></body></html>`,
  );
  const files = await filmStills({
    page,
    chromePath: chrome!,
    at: [1, 1.5],
    outDir: join(dir, "clock-stills"),
    blur: false,
  });
  const at = async (i: number) => rgb(files[i]!, 1920, 1080);
  const red = (r: number, g: number) => r > 200 && g < 80;
  const blue = (r: number, _g: number, b: number) => b > 200 && r < 100;
  const green = (r: number, g: number) => g > 200 && r < 100;
  const one = await at(0);
  assert.equal(leftEdge(one, 1920, 200, red), 800, "CSS animation at 1.0 s");
  // requestAnimationFrame runs 60 a second, halfway between frames: at 1.0 s
  // the canvas shows its frame at 991.7 ms
  assert.equal(leftEdge(one, 1920, 500, blue), 843, "rAF canvas at 1.0 s");
  assert.equal(leftEdge(one, 1920, 750, green), 0, "the transition starts at 1.0 s");
  const later = await at(1);
  assert.equal(leftEdge(later, 1920, 200, red), 1200);
  assert.equal(leftEdge(later, 1920, 500, blue), 1268);
  assert.equal(
    leftEdge(later, 1920, 750, green),
    500,
    "a transition a timer started at 1.0 s, half way",
  );
});

test("stills of a page that just animates, closer together than a shutter", {
  skip,
}, async () => {
  const page = join(dir, "close-stills");
  await exec("mkdir", ["-p", page]);
  await writeFile(
    join(page, "index.html"),
    `<!doctype html><html><head><style>body{margin:0;background:#000;width:320px;height:180px;overflow:hidden}
.b{position:absolute;top:40px;width:40px;height:100px;background:#fff;animation:m 1s linear forwards}
@keyframes m{to{transform:translateX(280px)}}</style></head><body><div class="b"></div>
<script>window.__film = { duration: 1, width: 320, height: 180 };</script></body></html>`,
  );
  // each one's shutter opens before the one before it closed
  const files = await filmStills({
    page,
    chromePath: chrome!,
    at: [0.5, 0.501, 0.502],
    outDir: join(dir, "close-stills-out"),
  });
  assert.equal(files.length, 3);
});

test("an iframe added mid-film starts its own animation where it was inserted", {
  skip,
}, async () => {
  const page = join(dir, "frames");
  await exec("mkdir", ["-p", page]);
  await writeFile(
    join(page, "inner.html"),
    `<!doctype html><html><head><style>body{margin:0;background:#222;width:800px;height:200px;overflow:hidden}
.b{position:absolute;top:50px;left:0;width:100px;height:100px;background:#fc3;animation:m 2s linear forwards}
@keyframes m{from{transform:translateX(0)}to{transform:translateX(700px)}}</style></head><body><div class="b"></div></body></html>`,
  );
  await writeFile(
    join(page, "index.html"),
    `<!doctype html><html><head><style>body{margin:0;background:#000;width:1920px;height:1080px;overflow:hidden}
iframe{position:absolute;left:0;width:800px;height:200px;border:0}</style></head><body>
<iframe src="inner.html" style="top:100px"></iframe>
<script>window.__film = { duration: 3 };
setTimeout(() => { const f = document.createElement('iframe'); f.src = 'inner.html'; f.style.top = '500px'; document.body.appendChild(f); }, 1000);</script></body></html>`,
  );
  const files = await filmStills({
    page,
    chromePath: chrome!,
    at: [1.5, 2.5],
    outDir: join(dir, "frame-stills"),
    blur: false,
  });
  const yellow = (r: number, g: number, b: number) => r > 200 && g > 150 && b < 100;
  const a = await rgb(files[0]!, 1920, 1080);
  assert.equal(leftEdge(a, 1920, 200, yellow), 525, "the first frame, 1.5 s into its animation");
  assert.equal(leftEdge(a, 1920, 600, yellow), 175, "the inserted frame, 0.5 s into its own");
  const b = await rgb(files[1]!, 1920, 1080);
  assert.equal(leftEdge(b, 1920, 600, yellow), 525);
});

test("a rendered film: format, measured blur on motion, one sharp sample on a cut", {
  skip,
}, async () => {
  const page = join(dir, "render");
  await exec("mkdir", ["-p", page]);
  // a white bar moves right fast until 0.25 s; at 0.25 s the scene cuts and
  // the bar JUMPS (a persisting element) onto a new background
  await writeFile(
    join(page, "index.html"),
    `<!doctype html><html><head><style>body{margin:0;width:320px;height:180px;overflow:hidden;background:#000}
#bar{position:absolute;top:40px;left:0;width:20px;height:100px;background:#fff}</style></head><body><div id="bar"></div>
<script>
window.__film = { duration: 0.5, width: 320, height: 180 };
const bar = document.getElementById('bar');
window.__render = (t) => {
  if (t < 0.25) { document.body.style.background = '#000'; bar.style.transform = 'translateX(' + (t * 1200) + 'px)'; }
  else { document.body.style.background = '#06c'; bar.style.transform = 'translateX(40px)'; }
};
</script></body></html>`,
  );
  const out = join(dir, "render.mp4");
  const r = await renderFilm({ page, out, chromePath: chrome!, workers: 2 });
  assert.equal(r.mode, "render");
  assert.equal(r.frames, 30);
  assert.ok(r.samples > r.frames, "moving frames took several samples");
  const ffprobe = await resolveFfprobe();
  const { stdout } = await exec(ffprobe, [
    "-v",
    "error",
    "-show_entries",
    "stream=codec_name,width,height,r_frame_rate,pix_fmt",
    "-of",
    "json",
    out,
  ]);
  const v = JSON.parse(stdout).streams[0];
  assert.deepEqual(
    [v.codec_name, v.width, v.height, v.r_frame_rate, v.pix_fmt],
    ["h264", 320, 180, "60/1", "yuv420p"],
  );
  // a moving frame: the bar's edges are smeared (grey between white and black)
  const moving = await rgb(out, 320, 180, 0.1);
  let grey = 0;
  for (let x = 0; x < 320; x++) {
    const i = (90 * 320 + x) * 3;
    if (moving[i]! > 40 && moving[i]! < 215) grey++;
  }
  assert.ok(grey >= 4, `a moving bar is blurred (${grey} grey px)`);
  // the cut frame (0.25 s): the new blue background only, no ghost of the black one
  const cut = await rgb(out, 320, 180, 0.25);
  const i = (170 * 320 + 300) * 3;
  assert.ok(
    cut[i + 2]! > 150 && cut[i]! < 40,
    `the cut frame is the new scene, not a blend (${cut[i]},${cut[i + 1]},${cut[i + 2]})`,
  );
});

test("a small switch while something else moves is not doubled, and the motion keeps its blur", {
  skip,
}, async () => {
  const page = join(dir, "small-cut");
  await exec("mkdir", ["-p", page]);
  // a white bar moves fast the whole time; at 0.25 s a small red card gives way
  // to a green one, and a white block of text empties — each far smaller than a
  // quarter of the picture, which is all a scene cut used to be
  await writeFile(
    join(page, "index.html"),
    `<!doctype html><html><head><style>body{margin:0;width:320px;height:180px;overflow:hidden;background:#000}
#bar{position:absolute;top:120px;left:0;width:20px;height:50px;background:#fff}
.card{position:absolute;left:240px;top:20px;width:40px;height:30px}
#txt{position:absolute;left:40px;top:20px;width:60px;height:50px;font:40px/50px monospace;color:#fff}</style></head><body>
<div id="bar"></div><div class="card" id="red" style="background:#f00"></div><div class="card" id="green" style="background:#0c0"></div><div id="txt"></div>
<script>
window.__film = { duration: 0.5, width: 320, height: 180 };
const $ = (id) => document.getElementById(id);
window.__render = (t) => {
  $('bar').style.transform = 'translateX(' + (t * 1200) + 'px)';
  $('red').style.display = t < 0.25 ? 'block' : 'none';
  $('green').style.display = t < 0.25 ? 'none' : 'block';
  $('txt').textContent = t < 0.25 ? '\\u2588\\u2588' : '';
};
</script></body></html>`,
  );
  const out = join(dir, "small-cut.mp4");
  await renderFilm({ page, out, chromePath: chrome!, workers: 1 });
  const cut = await rgb(out, 320, 180, 0.25);
  const at = (x: number, y: number) => {
    const i = (y * 320 + x) * 3;
    return [cut[i]!, cut[i + 1]!, cut[i + 2]!];
  };
  const [r, g] = at(260, 35);
  assert.ok(
    r < 60 && g > 150,
    `the card on the cut frame is the green one, not a blend (${r},${g})`,
  );
  const [tr, tg, tb] = at(55, 45);
  assert.ok(
    tr < 40 && tg < 40 && tb < 40,
    `the emptied text is gone on the cut frame, not half there (${tr},${tg},${tb})`,
  );
  let grey = 0;
  for (let x = 0; x < 320; x++) {
    const [v] = at(x, 145);
    if (v! > 40 && v! < 215) grey++;
  }
  assert.ok(grey >= 2, `the moving bar is still blurred on the cut frame (${grey} grey px)`);
});

test("motion inside a same-origin frame is measured for blur too", { skip }, async () => {
  const page = join(dir, "framed-blur");
  await exec("mkdir", ["-p", page]);
  await writeFile(
    join(page, "inner.html"),
    `<!doctype html><html><head><style>body{margin:0;background:#000;width:320px;height:180px;overflow:hidden}
.b{position:absolute;top:40px;left:0;width:20px;height:100px;background:#fff;animation:m 0.5s linear forwards}
@keyframes m{from{transform:translateX(0)}to{transform:translateX(280px)}}</style></head><body><div class="b"></div></body></html>`,
  );
  await writeFile(
    join(page, "index.html"),
    `<!doctype html><html><head><style>body{margin:0;width:320px;height:180px;overflow:hidden}
iframe{position:absolute;left:0;top:0;width:320px;height:180px;border:0}</style></head><body>
<iframe src="inner.html"></iframe><script>window.__film = { duration: 0.5, width: 320, height: 180 };</script></body></html>`,
  );
  const r = await renderFilm({
    page,
    out: join(dir, "framed-blur.mp4"),
    chromePath: chrome!,
    workers: 1,
  });
  assert.equal(r.mode, "clock");
  // 280 px in 0.5 s is ~4.7 px per 180° shutter at 60 fps: two samples a frame
  assert.ok(
    r.samples >= r.frames * 1.5,
    `frames inside the iframe got blur samples (${r.samples} for ${r.frames})`,
  );
});

test("when Chrome dies mid-render, its piece is rendered again on a fresh one", {
  skip,
}, async () => {
  const page = join(dir, "crash");
  await exec("mkdir", ["-p", page]);
  await writeFile(
    join(page, "index.html"),
    `<!doctype html><html><head><style>body{margin:0;width:320px;height:180px;overflow:hidden;background:#123}</style></head><body>
<script>
window.__film = { duration: 4, width: 320, height: 180 };
window.__render = (t) => {
  // a few ms of work per frame, so the render outlasts the kill on a busy machine
  let x = 0; for (let i = 0; i < 2e6; i++) x += Math.sqrt(i);
  document.body.dataset.x = String(x);
  document.body.style.background = 'rgb(' + Math.round(t * 50) + ',40,80)';
};
</script></body></html>`,
  );
  // the render's Chrome: the browser process this test process started (it
  // carries the debug port flag) — other test files render at the same time,
  // with Chromes of their own — looked up as soon as rendering starts so the
  // kill itself is immediate
  let pid: Promise<number | undefined> | undefined;
  const chromePid = async () => {
    const { stdout } = await exec("ps", ["-axo", "pid=,ppid=,command="], { maxBuffer: 1 << 24 });
    for (const l of stdout.split("\n")) {
      const [p, parent] = l.trim().split(/\s+/).map(Number);
      if (parent === process.pid && l.includes("--remote-debugging-port=0")) return p;
    }
    return undefined;
  };
  let killed = false;
  const kill = () =>
    void pid?.then((p) => {
      if (p) process.kill(p, "SIGKILL");
    });
  const r = await renderFilm({
    page,
    out: join(dir, "crash.mp4"),
    chromePath: chrome!,
    workers: 1,
    blur: false,
    onProgress: (p) => {
      if (p.phase !== "render") return;
      pid ??= chromePid();
      if (p.done >= 30 && !killed) {
        killed = true;
        kill();
      }
    },
  });
  assert.ok(killed);
  assert.equal(r.frames, 240);
  assert.ok(
    r.warnings.some((w) => /rendered again on a fresh one/.test(w)),
    `a warning names the re-rendered frames: ${r.warnings.join(" | ")}`,
  );
  const ffprobe = await resolveFfprobe();
  const { stdout } = await exec(ffprobe, [
    "-v",
    "error",
    "-count_frames",
    "-select_streams",
    "v:0",
    "-show_entries",
    "stream=nb_read_frames",
    "-of",
    "csv=p=0",
    join(dir, "crash.mp4"),
  ]);
  assert.equal(Number(stdout.trim()), 240, "every frame is in the film once");
});

test("a ready promise that waits on a frame inside an iframe does not hang", { skip }, async () => {
  const page = join(dir, "frame-ready");
  await exec("mkdir", ["-p", page]);
  await writeFile(
    join(page, "inner.html"),
    `<!doctype html><html><body style="margin:0;background:#0a0"></body></html>`,
  );
  await writeFile(
    join(page, "index.html"),
    `<!doctype html><html><head><style>body{margin:0;width:160px;height:90px}iframe{width:160px;height:90px;border:0}</style></head><body>
<iframe id="f" src="inner.html"></iframe><script>
const f = document.getElementById('f');
window.__film = { duration: 0.5, width: 160, height: 90,
  ready: new Promise((ok) => f.addEventListener('load', () => f.contentWindow.requestAnimationFrame(() => ok()))) };
window.__render = () => {};
</script></body></html>`,
  );
  const t0 = Date.now();
  const files = await filmStills({
    page,
    chromePath: chrome!,
    at: [0.2],
    outDir: join(dir, "frame-ready-stills"),
    blur: false,
  });
  assert.equal(files.length, 1);
  assert.ok(Date.now() - t0 < 30_000, "well before the 45 s ready timeout");
});

test("an instant is drawn again until the frames it puts anywhere have shown — and not forever", {
  skip,
}, async () => {
  const page = join(dir, "redraw");
  await exec("mkdir", ["-p", page]);
  await writeFile(join(page, "leaf.html"), `<!doctype html><html><body></body></html>`);
  await writeFile(join(page, "mid.html"), `<!doctype html><html><body></body></html>`);
  // a frame put into a frame of the page, and a chain of ten frames, each put
  // there once the one before has loaded; then a page that puts a new frame
  // there every time it draws
  await writeFile(
    join(page, "nested.html"),
    `<!doctype html><html><body><iframe id="mid" src="mid.html"></iframe><script>
window.__film = { duration: 2 };
window.__render = (t) => {
  const d = document.getElementById("mid").contentDocument;
  let g = d.getElementById("g");
  if (!g) { g = d.createElement("iframe"); g.id = "g"; g.src = "leaf.html"; d.body.append(g); }
  g.contentDocument.body.dataset.t = String(t);
};
window.seen = () => document.getElementById("mid").contentDocument.getElementById("g").contentDocument.body.dataset.t;
</script></body></html>`,
  );
  await writeFile(
    join(page, "chain.html"),
    `<!doctype html><html><body><script>
window.__film = { duration: 2 };
window.__render = (t) => {
  for (let i = 0; i < 10; i++) {
    let f = document.getElementById("f" + i);
    if (!f) { f = document.createElement("iframe"); f.id = "f" + i; f.src = "leaf.html"; document.body.append(f); }
    if (!f.contentDocument.URL.endsWith("leaf.html")) return;
  }
  document.getElementById("f9").contentDocument.body.dataset.t = String(t);
};
window.seen = () => document.getElementById("f9").contentDocument.body.dataset.t;
</script></body></html>`,
  );
  await writeFile(
    join(page, "endless.html"),
    `<!doctype html><html><body><script>
window.__film = { duration: 2 };
window.__render = () => { const f = document.createElement("iframe"); f.src = "leaf.html"; document.body.append(f); };
</script></body></html>`,
  );
  const server = await serveDirectory(page);
  const open = (name: string) =>
    launchHtmlBrowser({
      chromePath: chrome!,
      url: `${server.url}/${name}`,
      width: 64,
      height: 64,
      initScript: filmClockSource({ seed: 3, epochMs: 0 }),
      stillAnimations: true,
      timeoutMs: 120_000,
    });
  const seen = async (name: string) => {
    const b = await open(name);
    try {
      await b.evaluate("window.__ot.prepare()");
      await b.evaluate("window.__ot.seek(1)");
      return await b.evaluate<string>("window.seen()");
    } finally {
      await b.close();
    }
  };
  try {
    assert.equal(await seen("nested.html"), "1", "a frame inside a frame");
    assert.equal(await seen("chain.html"), "1", "ten frames, one after the other");
    const b = await open("endless.html");
    try {
      await b.evaluate("window.__ot.prepare()");
      await assert.rejects(
        b.evaluate("window.__ot.seek(1)"),
        /put a new frame on the page 32 times/,
      );
    } finally {
      await b.close();
    }
  } finally {
    await server.close();
  }
});

test("a page reads a video in a frame where it is on film time, however the film is sought", {
  skip,
}, async () => {
  const page = join(dir, "frame-video");
  await exec("mkdir", ["-p", page]);
  const ffmpeg = await resolveFfmpeg();
  await exec(ffmpeg, [
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "testsrc=size=64x64:rate=30:duration=2",
    "-c:v",
    "libvpx",
    "-y",
    join(page, "clip.webm"),
  ]);
  await writeFile(
    join(page, "player.html"),
    `<!doctype html><html><body><video id="v" src="clip.webm" autoplay muted></video></body></html>`,
  );
  const video = `document.getElementById("p").contentDocument.getElementById("v")`;
  await writeFile(
    join(page, "drawn.html"),
    `<!doctype html><html><body><iframe id="p" src="player.html"></iframe><script>
window.__film = { duration: 2 };
window.__render = () => { window.seen = ${video}.currentTime; };
</script></body></html>`,
  );
  await writeFile(
    join(page, "animated.html"),
    `<!doctype html><html><body><iframe id="p" src="player.html"></iframe><script>
window.__film = { duration: 2 };
setTimeout(() => { window.seen = ${video}.currentTime; }, 300);
</script></body></html>`,
  );
  const server = await serveDirectory(page);
  const seen = async (name: string, times: number[]) => {
    const b = await launchHtmlBrowser({
      chromePath: chrome!,
      url: `${server.url}/${name}`,
      width: 64,
      height: 64,
      initScript: filmClockSource({ seed: 3, epochMs: 0 }),
      stillAnimations: true,
    });
    try {
      await b.evaluate("window.__ot.prepare()");
      for (const t of times) await b.evaluate(`window.__ot.seek(${t})`);
      return Math.round((await b.evaluate<number>("window.seen")) * 1000);
    } finally {
      await b.close();
    }
  };
  try {
    assert.equal(await seen("drawn.html", [1]), 1000, "drawn, straight there");
    assert.equal(await seen("drawn.html", [0.5, 1]), 1000, "drawn, in steps");
    assert.equal(await seen("animated.html", [0.5]), 300, "animated, straight there");
    assert.equal(await seen("animated.html", [0.1, 0.2, 0.5]), 300, "animated, in steps");
  } finally {
    await server.close();
  }
});

test("a video the page pauses, plays and sets is where the page left it, however the film is sought", {
  skip,
}, async () => {
  const page = join(dir, "video-control");
  await exec("mkdir", ["-p", page]);
  const ffmpeg = await resolveFfmpeg();
  await exec(ffmpeg, [
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "testsrc=size=64x64:rate=30:duration=4",
    "-c:v",
    "libvpx",
    "-y",
    join(page, "clip.webm"),
  ]);
  await writeFile(
    join(page, "player.html"),
    `<!doctype html><html><body><video id="v" src="clip.webm" autoplay muted></video></body></html>`,
  );
  // a frame's video paused at 0.3 s and played again at 0.4 s; on the page
  // itself, a video set to 1 s as it loads; one played and then set to a time
  // it refuses (its length, before it knows it); one set before its start and
  // played; one set and loaded again; one given a new source at 0.3 s; one
  // played and given a source the element refuses at 0.3 s
  await writeFile(
    join(page, "index.html"),
    `<!doctype html><html><body><iframe id="p" src="player.html"></iframe>
<video id="w" src="clip.webm" autoplay muted></video><video id="x" muted></video>
<video id="y" src="clip.webm" muted></video><video id="z" src="clip.webm" muted></video>
<video id="s" src="clip.webm" autoplay muted></video><video id="q" src="clip.webm" muted></video><script>
window.__film = { duration: 2 };
const v = () => document.getElementById("p").contentDocument.getElementById("v");
const w = document.getElementById("w");
const x = document.getElementById("x");
w.currentTime = 1;
window.first = w.currentTime;
x.play();
try { x.currentTime = x.duration; } catch { window.refused = true; }
x.src = "clip.webm";
const y = document.getElementById("y");
y.currentTime = -1;
window.before0 = y.currentTime;
y.play();
const z = document.getElementById("z");
// once it knows its length (the test waits for that): set, and loaded again
setTimeout(() => {
  z.currentTime = 1;
  z.load();
  window.loaded = z.currentTime;
}, 300);
const sv = document.getElementById("s");
setTimeout(() => { sv.src = "clip.webm?again"; }, 300);
const q = document.getElementById("q");
q.play();
setTimeout(() => {
  try { q.src = { toString() { throw new Error("no source"); } }; } catch {}
}, 300);
window.reads = [];
const read = () => window.reads.push(Math.round(v().currentTime * 1000));
setTimeout(() => { v().pause(); read(); }, 300);
setTimeout(() => { read(); v().play(); }, 400);
setTimeout(read, 500);
const ms = (e) => Math.round(e.currentTime * 1000);
window.seen = () => [window.reads.join(" "), window.first, window.refused, ms(w), ms(x),
  window.before0, ms(y), window.loaded, ms(z), ms(sv), ms(q)].join();
</script></body></html>`,
  );
  // a film that draws itself gives a video a new source the first time it
  // draws 0.5 s or later, and sets it to how far past 0.5 s that is; and a
  // new source to one that had its first in a <source>, and a first one to
  // one that had none — both play by themselves, so in a film that draws
  // itself they play from film time 0
  await writeFile(
    join(page, "drawn.html"),
    `<!doctype html><html><body><video id="v" src="clip.webm" autoplay muted></video>
<video id="u" autoplay muted><source src="clip.webm"></video><video id="e" autoplay muted></video><script>
window.__film = { duration: 2 };
const v = document.getElementById("v");
const u = document.getElementById("u");
window.__render = (t) => {
  if (t >= 0.5 && !v.src.endsWith("?b")) {
    v.src = "clip.webm?b";
    v.currentTime = t - 0.5;
  }
  if (t >= 0.5 && !u.src) u.src = "clip.webm?c";
  if (t >= 0.5 && !e.src) e.src = "clip.webm?d";
  // a name the element converts itself
  v.setAttribute({ toString: () => "data-t" }, String(t));
};
const e = document.getElementById("e");
window.seen = () => [v, u, e].map((x) => Math.round(x.currentTime * 1000)).join();
</script></body></html>`,
  );
  const server = await serveDirectory(page);
  const seen = async (times: number[], name = "index.html") => {
    const b = await launchHtmlBrowser({
      chromePath: chrome!,
      url: `${server.url}/${name}`,
      width: 64,
      height: 64,
      initScript: filmClockSource({ seed: 3, epochMs: 0 }),
      stillAnimations: true,
    });
    try {
      await b.evaluate("window.__ot.prepare()");
      // polled from here: the page's own timers wait on the film clock
      for (let i = 0; i < 300 && name === "index.html"; i++) {
        if (await b.evaluate<boolean>("document.getElementById('z').readyState >= 1")) break;
        await new Promise((ok) => setTimeout(ok, 10));
      }
      for (const t of times) await b.evaluate(`window.__ot.seek(${t})`);
      return await b.evaluate<string>("window.seen()");
    } finally {
      await b.close();
    }
  };
  try {
    const expected = "300 300 400,1,true,1600,600,0,600,0,0,300,600";
    assert.equal(await seen([0.6]), expected, "straight there");
    assert.equal(await seen([0.2, 0.35, 0.45, 0.6]), expected, "in steps");
    assert.equal(await seen([1], "drawn.html"), "500,1000,1000", "new sources: straight there");
    assert.equal(await seen([0.75, 1], "drawn.html"), "500,1000,1000", "and in steps");
  } finally {
    await server.close();
  }
});

test("an animation frame a page asks of a frame runs at the page's time, before the frame shows", {
  skip,
}, async () => {
  const page = join(dir, "asked-time");
  await exec("mkdir", ["-p", page]);
  await writeFile(join(page, "inner.html"), `<!doctype html><html><body></body></html>`);
  await writeFile(
    join(page, "index.html"),
    `<!doctype html><html><body><iframe id="f" src="inner.html"></iframe><script>
const f = document.getElementById("f");
window.__film = {
  duration: 1,
  ready: new Promise((ok) => f.addEventListener("load", () =>
    f.contentWindow.requestAnimationFrame((ts) => { window.got = [ts, performance.now()]; ok(); }))),
};
</script></body></html>`,
  );
  const server = await serveDirectory(page);
  const b = await launchHtmlBrowser({
    chromePath: chrome!,
    url: `${server.url}/index.html`,
    width: 64,
    height: 64,
    initScript: filmClockSource({ seed: 3, epochMs: 0 }),
    stillAnimations: true,
  });
  try {
    await b.evaluate("window.__ot.prepare()");
    const [ts, at] = await b.evaluate<[number, number]>("window.got");
    assert.equal(ts, at, `the page's time (${ts} and ${at})`);
  } finally {
    await b.close();
    await server.close();
  }
});

test("a page whose promises wait on timers still renders: film time starts when it is ready", {
  skip,
}, async () => {
  const page = join(dir, "timers");
  await exec("mkdir", ["-p", page]);
  // ready waits 200 ms on a timer; __render waits 30 ms on a timer before it paints
  await writeFile(
    join(page, "index.html"),
    `<!doctype html><html><head><style>body{margin:0;width:320px;height:180px;background:#000}</style></head><body>
<script>
window.__film = { duration: 1, width: 320, height: 180, ready: new Promise((r) => setTimeout(r, 200)) };
window.__render = async (t) => {
  await new Promise((r) => setTimeout(r, 30));
  document.body.style.background = t < 0.5 ? 'rgb(255,0,0)' : 'rgb(0,0,255)';
};
</script></body></html>`,
  );
  const files = await filmStills({
    page,
    chromePath: chrome!,
    at: [0.25, 0.75],
    outDir: join(dir, "timer-stills"),
    blur: false,
  });
  const a = await rgb(files[0]!, 320, 180);
  const b = await rgb(files[1]!, 320, 180);
  assert.ok(a[0]! > 200 && a[2]! < 50, `0.25 s is red (${a[0]},${a[1]},${a[2]})`);
  assert.ok(b[2]! > 200 && b[0]! < 50, `0.75 s is blue (${b[0]},${b[1]},${b[2]})`);
});

test("a __render page draws each frame with the same random numbers, in any order", {
  skip,
}, async () => {
  const page = join(dir, "random");
  await exec("mkdir", ["-p", page]);
  await writeFile(
    join(page, "index.html"),
    `<!doctype html><html><head><style>body{margin:0;width:320px;height:180px}</style></head><body>
<script>
window.__film = { duration: 2, width: 320, height: 180 };
window.__render = (t) => { const g = Math.round(Math.random() * 255); document.body.style.background = 'rgb(' + g + ',' + g + ',' + g + ')'; };
</script></body></html>`,
  );
  const one = await filmStills({
    page,
    chromePath: chrome!,
    at: [0.5, 1.5],
    outDir: join(dir, "random-a"),
    blur: false,
  });
  // the other way round, with another moment drawn in between
  const two = await filmStills({
    page,
    chromePath: chrome!,
    at: [1.5, 0.9, 0.5],
    outDir: join(dir, "random-b"),
    blur: false,
  });
  const grey = async (f: string) => (await rgb(f, 320, 180))[0]!;
  assert.equal(await grey(one[0]!), await grey(two.find((f) => f.endsWith("t000.500.png"))!));
  assert.equal(await grey(one[1]!), await grey(two.find((f) => f.endsWith("t001.500.png"))!));
});

test("seeking backwards and in any order draws the same frame; CSS and SVG agree after a timed ready", {
  skip,
}, async () => {
  const page = join(dir, "order");
  await exec("mkdir", ["-p", page]);
  // a __render page whose colour comes from Math.random, plus (in a second
  // page) a CSS and an SVG animation started behind a 200 ms ready timer
  await writeFile(
    join(page, "random.html"),
    `<!doctype html><html><head><style>body{margin:0;width:64px;height:64px}</style></head><body><script>
window.__film = { duration: 2 };
window.__render = (t) => { const g = Math.round(Math.random() * 255); document.body.style.background = 'rgb(' + g + ',' + g + ',' + g + ')'; };
</script></body></html>`,
  );
  await writeFile(
    join(page, "sync.html"),
    `<!doctype html><html><head><style>body{margin:0;width:400px;height:100px;background:#000}
#c{position:absolute;top:0;left:0;width:20px;height:40px;background:#f00;animation:m 1s linear forwards}
@keyframes m{from{transform:translateX(0)}to{transform:translateX(300px)}}</style></head><body>
<div id="c"></div>
<svg width="400" height="100" style="position:absolute;top:0;left:0"><rect x="0" y="50" width="20" height="40" fill="#0f0"><animate attributeName="x" from="0" to="300" dur="1s" fill="freeze"/></rect></svg>
<script>window.__film = { duration: 1, ready: new Promise((r) => setTimeout(r, 200)) };</script></body></html>`,
  );
  const server = await serveDirectory(page);
  const open = (name: string, w: number, h: number) =>
    launchHtmlBrowser({
      chromePath: chrome!,
      url: `${server.url}/${name}`,
      width: w,
      height: h,
      initScript: filmClockSource({ seed: 7, epochMs: 0 }),
      stillAnimations: true,
    });
  const pixel = async (b: Awaited<ReturnType<typeof open>>, t: number) => {
    await b.evaluate(`window.__ot.seek(${t})`);
    return b.evaluate<string>(`getComputedStyle(document.body).backgroundColor`);
  };
  const a = await open("random.html", 64, 64);
  const b = await open("random.html", 64, 64);
  const c = await open("sync.html", 400, 100);
  try {
    await a.evaluate("window.__ot.prepare()");
    await b.evaluate("window.__ot.prepare()");
    const late = await pixel(a, 1.5);
    await pixel(a, 0.5);
    assert.equal(await pixel(a, 1.5), late, "the same frame after seeking back and forth");
    assert.equal(await pixel(b, 1.5), late, "and in another browser that never drew anything else");
    await c.evaluate("window.__ot.prepare()");
    await c.evaluate("window.__ot.seek(0.5)");
    const xs = await c.evaluate<number[]>(
      "[document.getElementById('c').getBoundingClientRect().left, document.querySelector('rect').getBoundingClientRect().left]",
    );
    assert.ok(
      Math.abs(xs[0]! - 150) < 2 && Math.abs(xs[1]! - 150) < 2,
      `CSS and SVG both at 150 px at 0.5 s: ${xs}`,
    );
  } finally {
    await Promise.all([a.close(), b.close(), c.close()]);
    await server.close();
  }
});

test("a page that keeps its own state reaches an instant the same way, however the film is sought", {
  skip,
}, async () => {
  const page = join(dir, "same-state");
  await exec("mkdir", ["-p", page]);
  // the renderer reaches an instant in order, around a shutter's samples, or
  // straight from a fresh page (a piece, a retry): a page that counts frames,
  // waits with await, or starts an animation from a timer must not tell
  await writeFile(
    join(page, "index.html"),
    `<!doctype html><html><head><style>
@keyframes go { to { transform: translateX(1000px) } }
#slide { width: 10px; height: 10px; animation: go 1s linear forwards }
</style></head><body><script>
window.__film = { duration: 2 };
window.steps = 0;
const loop = () => { window.steps++; requestAnimationFrame(loop); };
requestAnimationFrame(loop);
window.marks = [];
(async () => {
  for (let i = 0; i < 6; i++) {
    await new Promise((r) => setTimeout(r, 100));
    window.marks.push(Math.round(performance.now()));
  }
  document.body.insertAdjacentHTML("beforeend", '<div id="slide"></div>');
})();
window.state = () => JSON.stringify({
  steps: window.steps,
  marks: window.marks,
  x: Math.round(document.getElementById("slide")?.getBoundingClientRect().left ?? -1),
});
</script></body></html>`,
  );
  const server = await serveDirectory(page);
  const open = () =>
    launchHtmlBrowser({
      chromePath: chrome!,
      url: `${server.url}/index.html`,
      width: 64,
      height: 64,
      initScript: filmClockSource({ seed: 3, epochMs: 0 }),
      stillAnimations: true,
    });
  const a = await open();
  const b = await open();
  try {
    await a.evaluate("window.__ot.prepare()");
    await b.evaluate("window.__ot.prepare()");
    for (let t = 0.3; t < 1; t += 0.0042) await a.evaluate(`window.__ot.seek(${t})`);
    await a.evaluate("window.__ot.seek(1)");
    await b.evaluate("window.__ot.seek(1)");
    const [sa, sb] = [
      await a.evaluate<string>("window.state()"),
      await b.evaluate<string>("window.state()"),
    ];
    assert.equal(sa, sb, "the same state at 1 s");
    const s = JSON.parse(sb) as { steps: number; marks: number[]; x: number };
    assert.ok(Math.abs(s.steps - 60) <= 1, `60 frames a second (${s.steps})`);
    assert.deepEqual(
      s.marks,
      [100, 200, 300, 400, 500, 600],
      "each await resumes when its timer is due",
    );
    assert.ok(Math.abs(s.x - 8 - 400) <= 20, `the animation started at 0.6 s (${s.x})`);
  } finally {
    await Promise.all([a.close(), b.close()]);
    await server.close();
  }
});

test("frames in a film that draws itself show their page as it loaded, and never hold it up", {
  skip,
}, async () => {
  const page = join(dir, "drawn-frames");
  await exec("mkdir", ["-p", page]);
  // a frame with a change of its own at 0.5 s, which a frame inside the film
  // does not make: what moves inside it, the film moves
  await writeFile(
    join(page, "inner.html"),
    `<!doctype html><html><body><script>
setTimeout(() => document.body.classList.add("late"), 500);
</script></body></html>`,
  );
  // beside it, frames the film does not drive: an empty one it writes into,
  // a cross-origin one, and a lazy one far below the picture
  await writeFile(
    join(page, "index.html"),
    `<!doctype html><html><body>
<iframe id="live" src="inner.html"></iframe><iframe id="empty"></iframe><iframe src="data:text/html,elsewhere"></iframe>
<iframe loading="lazy" src="inner.html" style="position:absolute;top:5000px"></iframe>
<script>
window.__film = { duration: 2 };
window.__render = (t) => {
  document.getElementById("empty").contentDocument.body.textContent = String(t);
};
window.seen = () =>
  document.getElementById("live").contentDocument.body.className + "|" +
  document.getElementById("empty").contentDocument.body.textContent;
</script></body></html>`,
  );
  const server = await serveDirectory(page);
  const b = await launchHtmlBrowser({
    chromePath: chrome!,
    url: `${server.url}/index.html`,
    width: 320,
    height: 180,
    initScript: filmClockSource({ seed: 3, epochMs: 0 }),
    stillAnimations: true,
  });
  try {
    const t0 = Date.now();
    await b.evaluate("window.__ot.prepare()");
    await b.evaluate("window.__ot.seek(1)");
    assert.equal(await b.evaluate<string>("window.seen()"), "|1", "its own change does not run");
    await b.evaluate("window.__ot.seek(0.1)");
    assert.equal(await b.evaluate<string>("window.seen()"), "|0.1");
    const ms = Date.now() - t0;
    assert.ok(ms < 8000, `no frame held the film up (${ms} ms)`);
  } finally {
    await b.close();
    await server.close();
  }
});

test("a frame reads the film's time, has its first animation frame where it is put, and draws the same at the same instant", {
  skip,
}, async () => {
  const page = join(dir, "frame-time");
  await exec("mkdir", ["-p", page]);
  await writeFile(
    join(page, "inner.html"),
    `<!doctype html><html><body><canvas id="c" width="4" height="4"></canvas><script>
window.steps = 0;
const ctx = document.getElementById("c").getContext("2d");
const loop = () => { window.steps++; ctx.fillStyle = "#0f0"; ctx.fillRect(0, 0, 4, 4); requestAnimationFrame(loop); };
requestAnimationFrame(loop);
window.now = () => performance.now();
</script></body></html>`,
  );
  await writeFile(
    join(page, "index.html"),
    `<!doctype html><html><body><iframe src="inner.html"></iframe><script>
window.__film = { duration: 2 };
window.__render = () => { window.read = document.querySelector("iframe").contentWindow.now(); };
window.inner = () => document.querySelector("iframe").contentWindow;
</script></body></html>`,
  );
  const server = await serveDirectory(page);
  const b = await launchHtmlBrowser({
    chromePath: chrome!,
    url: `${server.url}/index.html`,
    width: 64,
    height: 64,
    initScript: filmClockSource({ seed: 3, epochMs: 0 }),
    stillAnimations: true,
  });
  try {
    await b.evaluate("window.__ot.prepare()");
    await b.evaluate("window.__ot.seek(0)");
    assert.equal(
      await b.evaluate<number>(
        "window.inner().document.getElementById('c').getContext('2d').getImageData(1, 1, 1, 1).data[1]",
      ),
      255,
      "its first animation frame drew the canvas",
    );
    await b.evaluate("window.__ot.seek(1)");
    assert.equal(
      await b.evaluate<number>("window.read"),
      await b.evaluate<number>("performance.now()"),
      "the frame reads the instant the film draws",
    );
    await b.evaluate("window.__ot.seek(1)");
    assert.equal(await b.evaluate<number>("window.inner().steps"), 1, "and runs it once");
  } finally {
    await b.close();
    await server.close();
  }
});

test("frames within frames: what the film writes and starts in them is at its instant, however it is sought", {
  skip,
}, async () => {
  const page = join(dir, "nested-frames");
  await exec("mkdir", ["-p", page]);
  await writeFile(
    join(page, "leaf.html"),
    `<!doctype html><html><head><style>.late{animation:m 1s linear forwards}@keyframes m{to{transform:translateX(1000px)}}</style></head><body><div id="d"></div><script>
setTimeout(() => document.getElementById("d").dataset.own = "ran", 500);
</script></body></html>`,
  );
  await writeFile(
    join(page, "mid.html"),
    `<!doctype html><html><body><iframe src="leaf.html"></iframe></body></html>`,
  );
  // the film starts the leaf's animation from 0.5 s: in a film that draws
  // itself, an animation runs from film time 0, as the page's own do
  await writeFile(
    join(page, "index.html"),
    `<!doctype html><html><body><iframe src="mid.html"></iframe><script>
window.__film = { duration: 2 };
const leaf = () => document.querySelector("iframe").contentDocument.querySelector("iframe").contentDocument;
window.__render = (t) => {
  leaf().body.dataset.t = String(t);
  leaf().getElementById("d").className = t >= 0.5 ? "late" : "";
};
window.leaf = () => {
  const d = leaf(), a = d.getAnimations()[0];
  return [d.getElementById("d").className, d.body.dataset.t, a ? Math.round(a.currentTime) : -1, d.getElementById("d").dataset.own].join();
};
</script></body></html>`,
  );
  const server = await serveDirectory(page);
  const b = await launchHtmlBrowser({
    chromePath: chrome!,
    url: `${server.url}/index.html`,
    width: 64,
    height: 64,
    initScript: filmClockSource({ seed: 3, epochMs: 0 }),
    stillAnimations: true,
  });
  try {
    await b.evaluate("window.__ot.prepare()");
    await b.evaluate("window.__ot.seek(1)");
    assert.equal(await b.evaluate<string>("window.leaf()"), "late,1,1000,");
    await b.evaluate("window.__ot.seek(0.1)");
    assert.equal(await b.evaluate<string>("window.leaf()"), ",0.1,-1,");
    await b.evaluate("window.__ot.seek(0.6)");
    assert.equal(await b.evaluate<string>("window.leaf()"), "late,0.6,600,");
  } finally {
    await b.close();
    await server.close();
  }
});

test("a frame put on the page loads before the film moves on, however it is sought", {
  skip,
}, async () => {
  const page = join(dir, "frames-load");
  await exec("mkdir", ["-p", page]);
  await writeFile(join(page, "leaf.html"), `<!doctype html><html><body></body></html>`);
  // a film that draws itself puts a frame on the page at 0.5 s and writes
  // into it; one that animates on its own puts one there at 0.1 s and writes
  // into it 50 ms later
  await writeFile(
    join(page, "drawn.html"),
    `<!doctype html><html><body><script>
window.__film = { duration: 2 };
window.__render = (t) => {
  let f = document.getElementById("f");
  if (t >= 0.5 && !f) {
    f = document.createElement("iframe");
    f.id = "f";
    f.src = "leaf.html";
    document.body.append(f);
  }
  if (f) f.contentDocument.body.dataset.t = String(t);
};
window.seen = () => document.getElementById("f").contentDocument.body.dataset.t;
</script></body></html>`,
  );
  await writeFile(
    join(page, "animated.html"),
    `<!doctype html><html><body><script>
window.__film = { duration: 2 };
setTimeout(() => { const f = document.createElement("iframe"); f.id = "f"; f.src = "leaf.html"; document.body.append(f); }, 100);
setTimeout(() => { document.getElementById("f").contentDocument.body.dataset.t = "written"; }, 150);
window.seen = () => document.getElementById("f").contentDocument.body.dataset.t;
</script></body></html>`,
  );
  const server = await serveDirectory(page);
  const open = (name: string) =>
    launchHtmlBrowser({
      chromePath: chrome!,
      url: `${server.url}/${name}`,
      width: 64,
      height: 64,
      initScript: filmClockSource({ seed: 3, epochMs: 0 }),
      stillAnimations: true,
    });
  const seen = async (name: string, times: number[]) => {
    const b = await open(name);
    try {
      await b.evaluate("window.__ot.prepare()");
      for (const t of times) await b.evaluate(`window.__ot.seek(${t})`);
      return await b.evaluate<string>("window.seen()");
    } finally {
      await b.close();
    }
  };
  try {
    assert.equal(await seen("drawn.html", [0.6]), "0.6", "drawn into on its first instant");
    assert.equal(await seen("drawn.html", [0.3, 0.6]), "0.6");
    assert.equal(await seen("animated.html", [1]), "written", "straight there");
    assert.equal(await seen("animated.html", [0.12, 0.2, 1]), "written", "in steps");
  } finally {
    await server.close();
  }
});

test("what a page reads and asks of its frames is at its own time, however the film is sought", {
  skip,
}, async () => {
  const page = join(dir, "frame-reads");
  await exec("mkdir", ["-p", page]);
  await writeFile(join(page, "leaf.html"), `<!doctype html><html><body></body></html>`);
  await writeFile(
    join(page, "frame.html"),
    `<!doctype html><html><head><style>#a{width:4px;height:4px;animation:m 2s linear}@keyframes m{to{transform:translateX(100px)}}</style></head><body><div id="a"></div></body></html>`,
  );
  // a film that draws itself reads a frame's animation as it draws
  await writeFile(
    join(page, "drawn.html"),
    `<!doctype html><html><body><iframe src="frame.html"></iframe><script>
window.__film = { duration: 2 };
window.__render = () => {
  window.seen = Math.round(document.querySelector("iframe").contentDocument.getAnimations()[0].currentTime);
};
</script></body></html>`,
  );
  // one that animates reads it from a timer, and at 0.1 s asks the frame for
  // its next animation frame with a callback that puts another frame on the
  // page — loaded by 0.2 s, as any frame the page puts there
  await writeFile(
    join(page, "animated.html"),
    `<!doctype html><html><body><iframe id="host" src="frame.html"></iframe><script>
window.__film = { duration: 2 };
setTimeout(() => {
  window.read = Math.round(document.getElementById("host").contentDocument.getAnimations()[0].currentTime);
  document.getElementById("host").contentWindow.requestAnimationFrame((ts) => {
    window.asked = Math.round(ts) === Math.round(performance.now());
    const f = document.createElement("iframe"); f.id = "added"; f.src = "leaf.html"; document.body.append(f);
  });
}, 100);
setTimeout(() => { window.there = document.getElementById("added").contentDocument.URL.endsWith("leaf.html"); }, 200);
window.seen = () => [window.read, window.asked, window.there].join();
</script></body></html>`,
  );
  // and one that draws itself after a wait, putting a frame on the page,
  // then — once that has loaded — a second one, which it writes into
  await writeFile(
    join(page, "chain.html"),
    `<!doctype html><html><body><script>
window.__film = { duration: 2 };
const make = (id) => {
  let f = document.getElementById(id);
  if (!f) { f = document.createElement("iframe"); f.id = id; f.src = "leaf.html"; document.body.append(f); }
  return f;
};
window.__render = async (t) => {
  await new Promise((ok) => setTimeout(ok, 30));
  if (make("a").contentDocument.URL.endsWith("leaf.html")) make("b").contentDocument.body.dataset.t = String(t);
};
window.seen = () => document.getElementById("b")?.contentDocument.body.dataset.t;
</script></body></html>`,
  );
  const server = await serveDirectory(page);
  const seen = async (name: string, times: number[], read = "window.seen()") => {
    const b = await launchHtmlBrowser({
      chromePath: chrome!,
      url: `${server.url}/${name}`,
      width: 64,
      height: 64,
      initScript: filmClockSource({ seed: 3, epochMs: 0 }),
      stillAnimations: true,
    });
    try {
      await b.evaluate("window.__ot.prepare()");
      for (const t of times) await b.evaluate(`window.__ot.seek(${t})`);
      return String(await b.evaluate(read));
    } finally {
      await b.close();
    }
  };
  try {
    assert.equal(await seen("drawn.html", [1], "window.seen"), "1000", "drawn, straight there");
    assert.equal(await seen("drawn.html", [0.5, 1], "window.seen"), "1000", "drawn, in steps");
    assert.equal(await seen("animated.html", [0.3]), "100,true,true", "animated, straight there");
    assert.equal(await seen("animated.html", [0.15, 0.3]), "100,true,true", "animated, in steps");
    assert.equal(await seen("chain.html", [1]), "1", "drawn into on the first instant");
  } finally {
    await server.close();
  }
});

test("a timer reads an animation where it is at the timer's time, however the film is sought", {
  skip,
}, async () => {
  const page = join(dir, "timer-reads");
  await exec("mkdir", ["-p", page]);
  await writeFile(
    join(page, "index.html"),
    `<!doctype html><html><head><style>#a{width:4px;height:4px;animation:m 1s linear}@keyframes m{to{transform:translateX(100px)}}</style></head><body><div id="a"></div><script>
window.__film = { duration: 1 };
setTimeout(() => { window.read = Math.round(document.getAnimations()[0].currentTime); }, 100);
</script></body></html>`,
  );
  const server = await serveDirectory(page);
  const open = () =>
    launchHtmlBrowser({
      chromePath: chrome!,
      url: `${server.url}/index.html`,
      width: 64,
      height: 64,
      initScript: filmClockSource({ seed: 3, epochMs: 0 }),
      stillAnimations: true,
    });
  const a = await open();
  const b = await open();
  try {
    await a.evaluate("window.__ot.prepare()");
    await b.evaluate("window.__ot.prepare()");
    for (let t = 0.01; t <= 0.2; t += 0.01) await a.evaluate(`window.__ot.seek(${t})`);
    await b.evaluate("window.__ot.seek(0.2)");
    assert.equal(await a.evaluate<number>("window.read"), 100);
    assert.equal(await b.evaluate<number>("window.read"), 100);
  } finally {
    await Promise.all([a.close(), b.close()]);
    await server.close();
  }
});

test("loading that never ends holds the ready wait for a while, not for good", {
  skip,
  timeout: 60_000,
}, async () => {
  // a request the server never answers, beside a ready that waits on a timer;
  // before it, a request that failed to send and was sent again, which must
  // count as loading once, not less
  const html = `<!doctype html><html><body><script>
const x = new XMLHttpRequest();
try { x.send(); } catch {}
x.open("GET", "/ok");
x.onloadend = () => { fetch("/never"); window.sent = true; };
x.send();
window.__film = { duration: 1, ready: new Promise((ok) => setTimeout(ok, 100)) };
</script></body></html>`;
  const server = createServer((req, res) => {
    if (req.url === "/ok") res.end("ok");
    else if (req.url !== "/never") res.writeHead(200, { "content-type": "text/html" }).end(html);
  });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", () => ok()));
  const { port } = server.address() as { port: number };
  const warnings: string[] = [];
  const b = await launchHtmlBrowser({
    chromePath: chrome!,
    url: `http://127.0.0.1:${port}/`,
    width: 64,
    height: 64,
    initScript: filmClockSource({ seed: 3, epochMs: 0 }),
    stillAnimations: true,
    onConsole: (level, text) => {
      if (level === "warning") warnings.push(text);
    },
  });
  try {
    // polled from here: the page's own timers wait on the film clock
    for (let i = 0; i < 200 && !(await b.evaluate<boolean>("!!window.sent")); i++)
      await new Promise((ok) => setTimeout(ok, 10));
    assert.equal(await b.evaluate<boolean>("window.__ot.busy()"), true, "the request is loading");
    const t0 = Date.now();
    await b.evaluate("window.__ot.prepare()", { timeoutMs: 40_000 });
    const ms = Date.now() - t0;
    assert.ok(ms > 9_000 && ms < 20_000, `ready after the loading patience (${ms} ms)`);
    assert.ok(
      warnings.some((w) => /still loading after 10 s/.test(w)),
      `said so: ${JSON.stringify(warnings)}`,
    );
  } finally {
    await b.close();
    server.closeAllConnections();
    server.close();
  }
});

test("an animation shorter than the page's loading still plays in the film", {
  skip,
}, async () => {
  // the image takes 600 ms, so the page's load does; the animation is 300 ms
  // and keeps nothing when it ends — played in real time it would be gone
  const html = `<!doctype html><html><head><style>body{margin:0}#a{width:4px;height:4px;animation:m .3s linear}@keyframes m{to{transform:translateX(300px)}}</style></head><body><div id="a"></div><img src="/slow.png"><script>
window.__film = { duration: 1 };
window.__render = () => {};
</script></body></html>`;
  const server = createServer((req, res) => {
    if (req.url === "/slow.png") setTimeout(() => res.writeHead(404).end(), 600);
    else res.writeHead(200, { "content-type": "text/html" }).end(html);
  });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", () => ok()));
  const { port } = server.address() as { port: number };
  const b = await launchHtmlBrowser({
    chromePath: chrome!,
    url: `http://127.0.0.1:${port}/`,
    width: 400,
    height: 64,
    initScript: filmClockSource({ seed: 3, epochMs: 0 }),
    stillAnimations: true,
  });
  try {
    await b.evaluate("window.__ot.prepare()");
    await b.evaluate("window.__ot.seek(0.15)");
    assert.equal(
      await b.evaluate<number>(
        "Math.round(document.getElementById('a').getBoundingClientRect().left)",
      ),
      150,
    );
  } finally {
    await b.close();
    server.close();
  }
});

test("a page reaches film time 0 in the same state however long its loading took", {
  skip,
}, async () => {
  // a page that moves a step a frame and becomes ready after two fetches (one
  // body read as a stream) and a wait of its own: how long the fetches take
  // must not change film time 0
  const html = `<!doctype html><html><body><script>
window.steps = 0;
const loop = () => { window.steps++; requestAnimationFrame(loop); };
requestAnimationFrame(loop);
window.__film = {
  duration: 1,
  ready: fetch("/data")
    .then((r) => r.body.getReader().read())
    .then(() => fetch("/data"))
    .then((r) => r.text())
    .then(() => new Promise((ok) => setTimeout(ok, 100))),
};
</script></body></html>`;
  const at = async (delayMs: number) => {
    const server = createServer((req, res) => {
      if (req.url === "/data") {
        // the headers at once, the body late
        res.flushHeaders();
        setTimeout(() => res.end("ok"), delayMs);
      } else res.writeHead(200, { "content-type": "text/html" }).end(html);
    });
    await new Promise<void>((ok) => server.listen(0, "127.0.0.1", () => ok()));
    const { port } = server.address() as { port: number };
    const b = await launchHtmlBrowser({
      chromePath: chrome!,
      url: `http://127.0.0.1:${port}/`,
      width: 64,
      height: 64,
      initScript: filmClockSource({ seed: 3, epochMs: 0 }),
      stillAnimations: true,
    });
    try {
      await b.evaluate("window.__ot.prepare()");
      return await b.evaluate<number>("window.steps");
    } finally {
      await b.close();
      server.close();
    }
  };
  const quick = await at(20);
  const slow = await at(700);
  assert.equal(quick, slow, `the same frames by film time 0 (${quick} and ${slow})`);
  assert.ok(
    quick >= 6 && quick <= 8,
    `the 100 ms wait at 60 a second, and the first frame (${quick})`,
  );
});

test("inside a __render, timers run in due order and the page still reads the instant it draws", {
  skip,
}, async () => {
  const page = join(dir, "nested");
  await exec("mkdir", ["-p", page]);
  // A waits 30 ms and then sets C to wait 30 more (due at 60); B waits 50:
  // the order is A, B, C — and after all that waiting the clock still reads t
  await writeFile(
    join(page, "index.html"),
    `<!doctype html><html><head></head><body><script>
window.__film = { duration: 2 };
window.__render = async (t) => {
  const order = [];
  await Promise.all([
    new Promise((r) => setTimeout(() => { order.push('A'); setTimeout(() => { order.push('C'); r(); }, 30); }, 30)),
    new Promise((r) => setTimeout(() => { order.push('B'); r(); }, 50)),
  ]);
  document.body.dataset.order = order.join('');
  document.body.dataset.read = String(performance.now());
};
</script></body></html>`,
  );
  const server = await serveDirectory(page);
  const b = await launchHtmlBrowser({
    chromePath: chrome!,
    url: `${server.url}/index.html`,
    width: 64,
    height: 64,
    initScript: filmClockSource({ seed: 1, epochMs: 0 }),
    stillAnimations: true,
  });
  try {
    await b.evaluate("window.__ot.prepare()");
    await b.evaluate("window.__ot.seek(1.25)");
    const got = await b.evaluate<{ order: string; read: string }>(
      "({ order: document.body.dataset.order, read: document.body.dataset.read })",
    );
    assert.equal(got.order, "ABC");
    assert.equal(Number(got.read), 1250);
  } finally {
    await b.close();
    await server.close();
  }
});

test("one worker or three: the same film", { skip }, async () => {
  const page = join(dir, "workers");
  await exec("mkdir", ["-p", page]);
  await writeFile(
    join(page, "index.html"),
    `<!doctype html><html><head><style>body{margin:0;width:160px;height:90px}</style></head><body><script>
window.__film = { duration: 1, width: 160, height: 90 };
window.__render = (t) => { const g = Math.round(Math.random() * 255); document.body.style.background = 'rgb(' + g + ',' + (255 - g) + ',90)'; };
</script></body></html>`,
  );
  await renderFilm({
    page,
    out: join(dir, "w1.mp4"),
    chromePath: chrome!,
    workers: 1,
    blur: false,
  });
  await renderFilm({
    page,
    out: join(dir, "w3.mp4"),
    chromePath: chrome!,
    workers: 3,
    blur: false,
  });
  const ffmpeg = await resolveFfmpeg();
  const { stderr } = await exec(ffmpeg, [
    "-v",
    "info",
    "-i",
    join(dir, "w1.mp4"),
    "-i",
    join(dir, "w3.mp4"),
    "-lavfi",
    "psnr",
    "-f",
    "null",
    "-",
  ]);
  const min = Number(/min:([\d.inf]+)/.exec(stderr)?.[1]?.replace("inf", "99") ?? 0);
  assert.ok(min > 35, `every frame matches across worker counts (min PSNR ${min} dB)`);
});

test("supersampling draws more pixels and keeps the film's size, in the master and in stills", {
  skip,
}, async () => {
  const page = join(dir, "supersample");
  await exec("mkdir", ["-p", page]);
  await writeFile(
    join(page, "index.html"),
    `<!doctype html><html><head><style>body{margin:0;width:320px;height:180px;background:#fff;font:700 24px sans-serif}
#t{position:absolute;left:40px;top:60px}</style></head><body><div id="t">台北南京店 1,188</div><script>
window.__film = { duration: 0.25, width: 320, height: 180 };
window.__render = (t) => { document.getElementById('t').style.transform = 'scale(' + (1 + t * 0.2) + ')'; console.log('dpr ' + devicePixelRatio); };
</script></body></html>`,
  );
  // the page itself says how densely it is drawn
  const said = new Set<string>();
  const onConsole = (_level: string, text: string) => said.add(text);
  const r = await renderFilm({
    page,
    out: join(dir, "supersample.mp4"),
    chromePath: chrome!,
    workers: 1,
    supersample: 2,
    onConsole,
  });
  assert.deepEqual([...said], ["dpr 2"], "drawn at twice the pixels each way");
  assert.deepEqual([r.width, r.height], [320, 180]);
  const ffprobe = await resolveFfprobe();
  const { stdout } = await exec(ffprobe, [
    "-v",
    "error",
    "-select_streams",
    "v:0",
    "-show_entries",
    "stream=width,height",
    "-of",
    "csv=p=0",
    join(dir, "supersample.mp4"),
  ]);
  assert.equal(stdout.trim(), "320,180");
  said.clear();
  const [still] = await filmStills({
    page,
    chromePath: chrome!,
    at: [0.1],
    outDir: join(dir, "supersample-stills"),
    supersample: 2,
    onConsole,
  });
  assert.deepEqual([...said], ["dpr 2"], "stills are drawn as the master is");
  const probe = await exec(ffprobe, [
    "-v",
    "error",
    "-show_entries",
    "stream=width,height",
    "-of",
    "csv=p=0",
    still!,
  ]);
  assert.equal(probe.stdout.trim(), "320,180");
  await assert.rejects(
    renderFilm({ page, out: join(dir, "x.mp4"), chromePath: chrome!, supersample: 1.5 }),
    /supersample is a whole number from 1 to 4/,
  );
});

test("a file the page asks for that is not there fails the render by name", { skip }, async () => {
  const page = join(dir, "missing");
  await exec("mkdir", ["-p", page]);
  await writeFile(
    join(page, "index.html"),
    `<!doctype html><html><head><link rel="stylesheet" href="brand.css"></head><body><script>window.__film = { duration: 0.1 };</script></body></html>`,
  );
  await assert.rejects(
    renderFilm({ page, out: join(dir, "missing.mp4"), chromePath: chrome!, blur: false }),
    /brand\.css/,
  );
});

test("the check reads a hitch, a lower-rate cadence and a cut from frame differences", () => {
  const moving = Array.from({ length: 40 }, () => 2);
  const hitch = [...moving];
  hitch[20] = 0;
  assert.equal(motionFindings(hitch, 60).stalls.length, 1);
  const cadence = Array.from({ length: 40 }, (_, i) => (i % 2 ? 0 : 3));
  assert.equal(motionFindings(cadence, 60).cadence.length, 1);
  const cut = [...moving];
  cut[30] = 80;
  assert.deepEqual(motionFindings(cut, 60).cuts, [Math.round((31 / 60) * 1000) / 1000]);
});

test("a click is a jump inside a smooth waveform, not the onset of a noisy sound", () => {
  const sr = 48000;
  const tone = new Float32Array(sr);
  for (let n = sr / 2; n < sr; n++)
    tone[n] = 0.5 * Math.sin((2 * Math.PI * 220 * (n - sr / 2)) / sr + 1.2);
  assert.deepEqual(findClicks(tone, sr), [0.5]);
  let s = 7;
  const noise = new Float32Array(sr);
  for (let n = sr / 2; n < sr; n++) {
    s = (s * 1664525 + 1013904223) >>> 0;
    noise[n] = 0.4 * (s / 2 ** 31 - 1);
  }
  assert.deepEqual(findClicks(noise, sr), []);
});

// --- flashes and blank frames, read from synthetic frames (grey, 64×36) -------

const GW = 64;
const GH = 36;
/** a grey frame, each pixel f(x, y) */
function grey(f: (x: number, y: number) => number): Uint8Array {
  const a = new Uint8Array(GW * GH);
  for (let y = 0; y < GH; y++) for (let x = 0; x < GW; x++) a[y * GW + x] = f(x, y);
  return a;
}
/** a scene: a soft gradient and a light box — a picture, not one colour */
const scene = (shade: number, boxX: number) =>
  grey((x, y) => (x >= boxX && x < boxX + 10 && y >= 12 && y < 24 ? 230 : shade + (x >> 2)));
const flat = (v: number) => grey(() => v);
const mix = (a: Uint8Array, b: Uint8Array, k: number) =>
  a.map((v, i) => Math.round(v + (b[i]! - v) * k));
/** feed frames to a picture reader; n copies of each */
function feed(fps: number, ...shots: [Uint8Array, number?][]) {
  const r = readPicture(GW, GH, fps);
  for (const [f, n = 1] of shots) for (let i = 0; i < n; i++) r.push(f);
  return r.done();
}
const at = (frame: number, fps: number) => Math.round((frame / fps) * 1000) / 1000;

test("a flash is up to 1/15 s of frames unlike the frames on both sides — a cut, a fade, motion, a pan and a ticking number are not", () => {
  const a = scene(40, 8);
  const b = scene(90, 40);
  const c = scene(20, 20);
  const shots: [Uint8Array, number?][] = [
    [a, 10],
    // three frames of something else: bright, a dark band across — then back
    [grey((_, y) => (y > 14 && y < 20 ? 0 : 220)), 3],
    [a, 10],
    [b, 10], // a clean cut
    ...Array.from({ length: 20 }, (_, k): [Uint8Array] => [mix(b, c, (k + 1) / 20)]), // a fade
    // a box moving across
    ...Array.from({ length: 20 }, (_, k): [Uint8Array] => [scene(20, 2 * k)]),
    // a pan: stripes over the whole picture, moving 3 px a frame
    ...Array.from({ length: 20 }, (_, k): [Uint8Array] => [
      grey((x) => ((x + 3 * k) & 8 ? 200 : 30)),
    ]),
    [c, 10],
    // a number ticking over: a tenth of the picture changes for one frame
    [grey((x, y) => (x >= 20 && x < 40 && y >= 12 && y < 24 ? 250 : c[y * GW + x]!)), 1],
    [c, 10],
  ];
  const p = feed(60, ...shots);
  assert.deepEqual(p.flashes, [{ at: at(10, 60), frames: 3 }]);
  assert.deepEqual(p.blanks, []);
  // the same picture at 30 fps: three frames are 1/10 s — a shot, not a flash;
  // two frames still flash
  const slow = feed(30, [a, 10], [shots[1]![0], 3], [a, 10], [shots[1]![0], 2], [a, 10]);
  assert.deepEqual(slow.flashes, [{ at: at(23, 30), frames: 2 }]);
});

test("the frame differences are exact: identical frames differ by nothing", () => {
  const p = feed(60, [scene(40, 8), 4], [scene(40, 12), 1], [scene(40, 12), 3]);
  assert.equal(p.diffs.length, 7, "one difference between each pair of frames");
  assert.deepEqual(
    p.diffs.map((d) => d > 0),
    [false, false, false, true, false, false, false],
  );
});

test("a cut that lands on near-blank frames before the shot's content is found — not a fade through black, a held black or the end", () => {
  const a = scene(40, 8);
  const b = scene(90, 40);
  const p = feed(
    60,
    [flat(20), 1], // the film opens on one blank frame
    [a, 10],
    [flat(98), 2], // a cut to the next shot's background, two frames before its content
    [b, 10],
    // a fade through black and back: no cut into it
    ...Array.from({ length: 15 }, (_, k): [Uint8Array] => [mix(b, flat(0), (k + 1) / 15)]),
    [flat(0), 3],
    ...Array.from({ length: 15 }, (_, k): [Uint8Array] => [mix(flat(0), a, (k + 1) / 15)]),
    [a, 10],
    [flat(0), 30], // a cut to black held half a second: a beat, not a flicker
    [b, 10],
    [flat(0), 5], // the end
  );
  assert.deepEqual(p.blanks, [
    { at: 0, frames: 1 },
    { at: at(11, 60), frames: 2 },
  ]);
  assert.deepEqual(p.flashes, []);
  // white frames unlike the shots on both sides of them are a flash, said once
  const white = feed(60, [a, 10], [flat(250), 2], [b, 10]);
  assert.deepEqual(white.flashes, [{ at: at(10, 60), frames: 2 }]);
  assert.deepEqual(white.blanks, []);
});

test("marks are checked: a time in seconds, an optional end from it on, optional words", () => {
  assert.deepEqual(filmMarks(null), []);
  assert.deepEqual(filmMarks([{ at: 1.5 }, { at: 2, until: 2.5, what: "white flash" }]), [
    { at: 1.5, until: 1.5, what: null },
    { at: 2, until: 2.5, what: "white flash" },
  ]);
  assert.throws(() => filmMarks([{ at: "1.5" }]), /marks\[0\]\.at/);
  assert.throws(() => filmMarks([{ at: 1 }, { at: 2, until: 1 }]), /marks\[1\]\.until/);
  assert.throws(() => filmMarks("[object Object]"), /is a list/);
});

// --- the check on rendered films ---------------------------------------------

/** small scenes on a 320×180 page, 3 s: what the check must find (a flash at
 *  0.5 s, a blank start of a shot at 2.5 s) and what it must pass (a cut at
 *  1 s, a fade from 1.5 s, motion from 2 s) */
const SCENES = `<style>body{margin:0;width:320px;height:180px;overflow:hidden}
#bg,#veil{position:absolute;inset:0}#veil{background:#a2c}
#box,#vbox,#d{position:absolute;top:60px;width:60px;height:60px}#vbox{background:#fff}#d{background:#333;left:130px}
#band{position:absolute;left:0;right:0;top:80px;height:24px;background:#000}</style>
<div id="bg"></div><div id="box"></div><div id="band"></div><div id="veil"><div id="vbox"></div></div><div id="d"></div>
<script>
const $ = (id) => document.getElementById(id);
const show = (id, on) => { $(id).style.display = on ? 'block' : 'none'; };
window.__render = (t) => {
  const flash = t >= 0.5 && t < 0.545; // frames 30–32
  const blank = t >= 2.5 && t < 2.53; // frames 150–151
  let bg = '#234', box = '#fff', x = 40, veil = 0;
  if (t >= 1 && t < 2.5) { bg = '#2a6'; box = '#fd3'; x = 200; veil = Math.min(1, Math.max(0, (t - 1.5) / 0.5)); }
  if (flash) bg = '#e33';
  if (t >= 2.5) bg = '#ddd';
  $('bg').style.background = bg;
  $('box').style.background = box;
  $('box').style.left = x + 'px';
  show('box', !flash && t < 2.5);
  show('band', flash);
  $('veil').style.opacity = String(veil);
  show('veil', veil > 0 && t < 2.5);
  $('vbox').style.left = (20 + Math.max(0, t - 2) * 480) + 'px';
  show('d', t >= 2.53);
};
</script>`;

test("a rendered film: the check finds a 3-frame flash and a blank start of a shot, and passes a cut, a fade and motion", {
  skip,
}, async () => {
  const page = join(dir, "flashes");
  await exec("mkdir", ["-p", page]);
  await writeFile(
    join(page, "index.html"),
    `<!doctype html><html><head><script>window.__film = { duration: 3, width: 320, height: 180 };</script></head><body>${SCENES}</body></html>`,
  );
  const out = join(dir, "flashes.mp4");
  await renderFilm({ page, out, chromePath: chrome!, workers: 2, audio: null });
  const c = await checkFilm(out);
  assert.deepEqual(c.flashes, [{ at: 0.5, frames: 3 }]);
  assert.deepEqual(c.blanks, [{ at: 2.5, frames: 2 }]);
  assert.ok(c.cuts.includes(1), `the cut at 1 s is a cut: ${c.cuts}`);
  const warns = c.issues.filter((i) => i.severity === "warn").map((i) => i.message);
  assert.ok(
    warns.some((m) => /flash/.test(m) && /0\.5s/.test(m)),
    `the flash is a timed finding: ${warns.join(" | ")}`,
  );
  assert.ok(
    warns.some((m) => /blank/.test(m) && /2\.5s/.test(m)),
    `so is the blank start of the shot: ${warns.join(" | ")}`,
  );
  assert.ok(
    !c.issues.some((i) => i.severity === "error"),
    "neither is an error: a flash may be meant",
  );
  assert.deepEqual(c.marks, []);
  assert.equal(c.layout, null, "the page's layout is read only when the page is given");
});

test("a mark covers its own moment, not the whole of a defect that runs through it", () => {
  const film = (over: Partial<FilmCheck>): FilmCheck => ({
    file: "film.mp4",
    durationS: 10,
    video: null,
    audio: null,
    stalls: [],
    cadence: [],
    cuts: [],
    flashes: [],
    blanks: [],
    black: [],
    silences: [],
    clicks: [],
    marks: [],
    page: null,
    layout: null,
    unreadText: null,
    smallestText: null,
    issues: [],
    ...over,
  });
  const mark = (at: number, until = at, what: string | null = null) => ({ at, until, what });
  const said = (c: Partial<FilmCheck>) =>
    judgeFilm(film(c), {})
      .filter((i) => /black|stall|repeats/.test(i.message))
      .map((i) => `${i.severity}: ${i.message}`);
  // unintended black from 5 to 8 s, with one meant black frame marked at 6 s
  const partly = said({ black: [{ start: 5, end: 8 }], marks: [mark(6, 6, "a beat of black")] });
  assert.ok(
    partly.includes("warn: black frames 5–8s inside the film"),
    `still a defect: ${partly.join(" | ")}`,
  );
  assert.ok(
    partly.some((m) => m.startsWith("info:") && /only part/.test(m) && /a beat of black/.test(m)),
    `and the mark is named as covering only part of it: ${partly.join(" | ")}`,
  );
  assert.ok(!partly.some((m) => /marked as intended/.test(m)), partly.join(" | "));
  // what the mark does cover (to the frame, give or take) is meant
  assert.deepEqual(said({ black: [{ start: 5.95, end: 6.05 }], marks: [mark(6)] }), [
    "info: marked as intended: black frames 5.95–6.05s",
  ]);
  assert.deepEqual(said({ stalls: [6.05], marks: [mark(6)] }), [
    "info: marked as intended: a frame repeats inside motion at 6.05s",
  ]);
  // marks that meet cover it together; marks with a gap between them do not
  assert.deepEqual(
    said({ black: [{ start: 5, end: 8 }], marks: [mark(5, 6.5, "fade"), mark(6.5, 8, "hold")] }),
    ['info: marked as intended ("fade", "hold"): black frames 5–8s'],
  );
  assert.ok(
    said({ black: [{ start: 5, end: 8 }], marks: [mark(5, 6), mark(7, 8)] }).includes(
      "warn: black frames 5–8s inside the film",
    ),
  );
  // exactly 0.1 s away counts, however the sums round
  assert.deepEqual(said({ stalls: [0.7], marks: [mark(0.8)] }), [
    "info: marked as intended: a frame repeats inside motion at 0.7s",
  ]);
  assert.deepEqual(
    said({ black: [{ start: 0.5, end: 1 }], marks: [mark(0.5, 0.6), mark(0.8, 1)] }),
    ["info: marked as intended: black frames 0.5–1s"],
  );
});

test("a flash the page marks as intended is listed as marked — also in a film rendered from the middle", {
  skip,
}, async () => {
  const page = join(dir, "marked");
  await exec("mkdir", ["-p", page]);
  await writeFile(
    join(page, "index.html"),
    `<!doctype html><html><head><script>window.__film = { duration: 3, width: 320, height: 180,
  marks: [{ at: 0.5, until: 0.55, what: "a flash on the beat" }] };</script></head><body>${SCENES}</body></html>`,
  );
  // page time 0.25–1.25: the flash is 0.25 s into this film
  const out = join(dir, "marked.mp4");
  await renderFilm({
    page,
    out,
    chromePath: chrome!,
    from: 0.25,
    to: 1.25,
    blur: false,
    audio: null,
  });
  const c = await checkFilm(out);
  assert.deepEqual(c.flashes, [{ at: 0.25, frames: 3 }], "still measured");
  assert.deepEqual(c.marks, [{ at: 0.25, until: 0.3, what: "a flash on the beat" }]);
  assert.ok(
    !c.issues.some((i) => i.severity !== "info" && /flash/.test(i.message)),
    `not a defect: ${c.issues.map((i) => i.message).join(" | ")}`,
  );
  assert.ok(
    c.issues.some(
      (i) =>
        i.severity === "info" && /marked/.test(i.message) && /a flash on the beat/.test(i.message),
    ),
    `listed as marked: ${c.issues.map((i) => i.message).join(" | ")}`,
  );
  // a mistyped mark fails the render before a frame is drawn, by name
  await writeFile(
    join(page, "bad.html"),
    `<!doctype html><html><body><script>window.__film = { duration: 1, marks: [{ at: "0.5" }] };</script></body></html>`,
  );
  await assert.rejects(
    renderFilm({
      page: join(page, "bad.html"),
      out: join(dir, "bad.mp4"),
      chromePath: chrome!,
      audio: null,
    }),
    /marks\[0\]\.at/,
  );
});

test("text inside a bordered or padded iframe is read where it is drawn, at the size it is drawn", {
  skip,
}, async () => {
  const page = join(dir, "framed");
  await exec("mkdir", ["-p", page]);
  await writeFile(
    join(page, "inner.html"),
    `<!doctype html><html><body style="margin:0;background:#fff"><p style="margin:0;font:16px/20px monospace">INNER TEXT HERE</p></body></html>`,
  );
  const film = (body: string) =>
    `<!doctype html><html><head><style>html,body{margin:0;overflow:hidden;background:#fff}</style></head><body>${body}
<script>window.__film = { duration: 1, width: 640, height: 360 };</script></body></html>`;
  // a 20 px border: the interface starts 20 px in, at its own scale; the
  // caption sits on the border above it, clear of its text
  await writeFile(
    join(page, "border.html"),
    film(`<iframe src="inner.html" style="position:absolute;left:100px;top:100px;width:400px;height:100px;border:20px solid #333;padding:0"></iframe>
<div id="cap" style="position:absolute;left:100px;top:92px;font:24px/24px monospace;white-space:nowrap">CAPTION</div>`),
  );
  // a border and padding, the whole frame scaled 1.5×: 16 px text is drawn at 24 px
  await writeFile(
    join(page, "scaled.html"),
    film(
      `<iframe src="inner.html" style="position:absolute;left:0;top:0;width:300px;height:100px;border:10px solid #333;padding:8px;transform-origin:0 0;transform:scale(1.5)"></iframe>`,
    ),
  );
  const read = (file: string) =>
    readPageLayout({
      page: join(page, file),
      chromePath: chrome!,
      from: 0,
      duration: 1,
      every: 0.25,
      fallback: { width: 640, height: 360 },
    });
  const border = await read("border.html");
  assert.deepEqual(
    [border.smallest?.px, border.smallest?.text.includes("INNER")],
    [16, true],
    `16 px text in a frame with a border reads 16 px: ${JSON.stringify(border.smallest)}`,
  );
  assert.deepEqual(border.spans, [], "the caption on the border is not over the interface's text");
  const scaled = await read("scaled.html");
  assert.equal(scaled.smallest?.px, 24, JSON.stringify(scaled.smallest));
  assert.deepEqual(scaled.spans, []);
});

test("text drawn turned or skewed is named, not measured by the box around it", {
  skip,
}, async () => {
  const page = join(dir, "turned");
  await exec("mkdir", ["-p", page]);
  await writeFile(
    join(page, "inner.html"),
    `<!doctype html><html><body style="margin:0;background:#fff"><p style="margin:0;font:16px/20px monospace">INNER TEXT HERE</p></body></html>`,
  );
  // a tall frame turned on its side (the box around it is wide and short: its
  // 16 px text would read as 8 px); a caption at a slant; a turn undone inside
  // another (drawn upright); an upright caption
  await writeFile(
    join(page, "index.html"),
    `<!doctype html><html><head><style>html,body{margin:0;overflow:hidden;background:#fff}</style></head><body>
<iframe src="inner.html" style="position:absolute;left:400px;top:20px;width:100px;height:200px;border:0;transform-origin:0 0;transform:rotate(90deg)"></iframe>
<div id="slant" style="position:absolute;left:20px;top:200px;font:20px sans-serif;white-space:nowrap;transform:rotate(-8deg)">A caption at a slant</div>
<div id="undone" style="position:absolute;left:300px;top:260px;transform:rotate(30deg)"><span style="display:block;white-space:nowrap;transform:rotate(-30deg);font:22px sans-serif">Turned back</span></div>
<div id="flat" style="position:absolute;left:20px;top:300px;font:18px sans-serif">An upright caption</div>
<div id="sticker" style="position:absolute;left:300px;top:320px;font:20px sans-serif;rotate:-3deg">A sticker</div>
<script>window.__film = { duration: 1, width: 640, height: 360 };</script></body></html>`,
  );
  const read = await readPageLayout({
    page: join(page, "index.html"),
    chromePath: chrome!,
    from: 0,
    duration: 1,
    every: 0.25,
    fallback: { width: 640, height: 360 },
  });
  const unread = read.unread ?? [];
  assert.ok(
    unread.some((u) => u.includes("INNER TEXT")) &&
      unread.some((u) => u.includes("#slant")) &&
      unread.some((u) => u.includes("#sticker")),
    `the turned frame's text, the slanted caption and the sticker turned by \`rotate\` are named: ${JSON.stringify(unread)}`,
  );
  assert.ok(
    !unread.some((u) => u.includes("Turned back") || u.includes("#flat")),
    `upright text is read: ${JSON.stringify(unread)}`,
  );
  assert.deepEqual(
    [read.smallest?.px, read.smallest?.text.includes("upright")],
    [18, true],
    JSON.stringify(read.smallest),
  );
  // and the check says so
  const c = judgeFilm(
    {
      file: "film.mp4",
      durationS: 1,
      video: null,
      audio: null,
      stalls: [],
      cadence: [],
      cuts: [],
      flashes: [],
      blanks: [],
      black: [],
      silences: [],
      clicks: [],
      marks: [],
      page: null,
      layout: [],
      unreadText: unread,
      smallestText: null,
      issues: [],
    },
    {},
  );
  assert.ok(
    c.some(
      (i) =>
        i.severity === "info" && /turned or skewed/.test(i.message) && i.message.includes("#slant"),
    ),
    c.map((i) => i.message).join(" | "),
  );
});

test("with the page, the check reads text over text and text cut by the frame's edge, with times, and the smallest text", {
  skip,
}, async () => {
  const page = join(dir, "layout");
  await exec("mkdir", ["-p", page]);
  await writeFile(
    join(page, "ui.html"),
    `<!doctype html><html><body style="margin:0;font:16px sans-serif"><nav style="padding:20px 24px">Home · Pricing · Docs · Sign in</nav><p style="padding:0 24px">The real interface, with its own text.</p></body></html>`,
  );
  await writeFile(
    join(page, "rows.html"),
    `<!doctype html><html><body style="margin:0;font:16px sans-serif">${Array.from({ length: 30 }, (_, i) => `<p style="margin:4px 8px">row ${i} of the real interface text</p>`).join("")}</body></html>`,
  );
  // a caption over the interface's own text while it shows (0.25–0.75 s); a
  // title running off the right edge from 1 s, marked as intended; a caption
  // beside a window whose interface text the window hides; a ticker whose
  // line runs past the edge but is cut by its own box first; a big number with
  // its label tucked under it (their line boxes overlap, their glyphs do not);
  // small print drawn at half size. Built as film pages often are: the page
  // hides its overflow and the stage is placed absolutely, so the body has no
  // height
  await writeFile(
    join(page, "index.html"),
    `<!doctype html><html><head><style>
html,body{margin:0;overflow:hidden;background:#fff}
#stage{position:absolute;left:0;top:0;width:640px;height:360px;overflow:hidden;font:700 28px sans-serif}
#ui{position:absolute;left:0;top:0;width:640px;height:120px;border:0}
#cap{position:absolute;left:24px;top:12px;font-size:30px;color:#111;white-space:nowrap}
#edge{position:absolute;left:520px;top:130px;white-space:nowrap}
#win{position:absolute;left:340px;top:170px;width:280px;height:180px;overflow:hidden;background:#fff}
#win iframe{width:640px;height:800px;border:0;transform-origin:0 0;transform:scale(1.4) translate(-120px,-40px)}
#note{position:absolute;left:20px;top:260px;color:#123}
#ticker{position:absolute;left:20px;top:130px;width:180px;overflow:hidden;white-space:nowrap;font:400 20px sans-serif}
#num{position:absolute;left:230px;top:150px;font:700 64px/1 sans-serif}
#yrs{position:absolute;left:230px;top:208px;font:700 14px sans-serif}
#small{position:absolute;left:20px;top:330px;transform-origin:0 0;transform:scale(0.5);font:16px sans-serif}
</style></head><body><div id="stage">
<iframe id="ui" src="ui.html"></iframe><div id="cap">Find your next gym.</div><div id="edge">Runs off the edge</div>
<div id="win"><iframe src="rows.html"></iframe></div><div id="note">Every gym.</div>
<div id="ticker">A ticker that runs on well past the edge of the frame, inside its own box</div>
<div id="num">32</div><div id="yrs">YEARS</div>
<div id="small">small print</div></div>
<script>
window.__film = { duration: 2, width: 640, height: 360,
  marks: [{ at: 1, until: 2, what: "the title runs off on purpose" }] };
window.__render = (t) => {
  document.getElementById('cap').style.opacity = t >= 0.25 && t < 0.75 ? '1' : '0';
  document.getElementById('edge').style.visibility = t >= 1 ? 'visible' : 'hidden';
};
</script></body></html>`,
  );
  // a draft is drawn at half size: the check lays the page out at its own size
  const out = join(dir, "layout.mp4");
  await renderFilm({ page, out, chromePath: chrome!, draft: true, audio: null });
  const c = await checkFilm(out, {}, { page, chromePath: chrome! });
  const layout = c.layout!;
  const over = layout.find((l) => l.kind === "text-over-text" && l.a.includes("#cap"));
  assert.ok(
    over?.b?.includes("iframe"),
    `the caption over the interface's text: ${JSON.stringify(layout)}`,
  );
  assert.deepEqual([over!.from, over!.to], [0.25, 0.5], "while it shows, sampled every 0.25 s");
  const edge = layout.find((l) => l.kind === "text-off-frame");
  assert.ok(edge?.a.includes("#edge"), `the title cut by the edge: ${JSON.stringify(layout)}`);
  assert.deepEqual([edge!.from, edge!.to], [1, 1.75], "from when it shows to the last sample");
  assert.ok(
    !layout.some((l) => l.a.includes("#note") || l.b?.includes("#note")),
    `text the film's own window hides is not a collision: ${JSON.stringify(layout)}`,
  );
  assert.ok(
    !layout.some((l) => l.a.includes("#ticker") || l.b?.includes("#ticker")),
    `text its own box cuts is not cut by the frame: ${JSON.stringify(layout)}`,
  );
  assert.ok(
    !layout.some((l) => l.a.includes("#num") || l.b?.includes("#num")),
    `a label under a number's glyphs is not over them: ${JSON.stringify(layout)}`,
  );
  assert.deepEqual(
    [c.smallestText?.px, /small print/.test(c.smallestText?.text ?? "")],
    [8, true],
    `the smallest text as drawn: ${JSON.stringify(c.smallestText)}`,
  );
  const warns = c.issues.filter((i) => i.severity === "warn").map((i) => i.message);
  assert.ok(
    warns.some((m) => m.includes("#cap")),
    `a warning: ${warns.join(" | ")}`,
  );
  assert.ok(
    !warns.some((m) => m.includes("#edge")),
    `the edge is marked as intended: ${warns.join(" | ")}`,
  );
  assert.ok(
    c.issues.some(
      (i) => i.severity === "info" && /marked/.test(i.message) && i.message.includes("#edge"),
    ),
    c.issues.map((i) => i.message).join(" | "),
  );
});
