// `film render` / `film still`: a page the author wrote, played on film time.
// Chrome for Testing; the browser tests skip without it.

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { promisify } from "node:util";
import { resolveFfmpeg, resolveFfprobe } from "../src/ffmpeg";
import { findClicks, motionFindings } from "../src/film/check";
import { filmClockSource } from "../src/film/clock";
import {
  balancedSlices,
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

test("frames are cut into contiguous slices of about equal cost", () => {
  const costs = [1, 1, 1, 1, 8, 8, 1, 1, 1, 1];
  const slices = balancedSlices(costs, 3);
  assert.equal(slices[0]![0], 0);
  assert.equal(slices.at(-1)![1], costs.length);
  for (let i = 1; i < slices.length; i++) assert.equal(slices[i]![0], slices[i - 1]![1]);
  assert.ok(slices.length <= 3);
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
  assert.equal(leftEdge(one, 1920, 500, blue), 850, "rAF canvas at 1.0 s");
  assert.equal(leftEdge(one, 1920, 750, green), 0, "the transition starts at 1.0 s");
  const later = await at(1);
  assert.equal(leftEdge(later, 1920, 200, red), 1200);
  assert.equal(leftEdge(later, 1920, 500, blue), 1275);
  assert.equal(
    leftEdge(later, 1920, 750, green),
    500,
    "a transition a timer started at 1.0 s, half way",
  );
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
window.__render = (t) => { document.body.style.background = 'rgb(' + Math.round(t * 50) + ',40,80)'; };
</script></body></html>`,
  );
  // the render's Chrome: the browser process itself (it carries the debug port
  // flag), looked up as soon as rendering starts so the kill itself is
  // immediate — a slow lookup on a busy machine let the film finish first
  let pid: Promise<number | undefined> | undefined;
  const findChrome = async () => {
    const { stdout } = await exec("ps", ["-axo", "pid=,command="], { maxBuffer: 1 << 24 });
    const line = stdout
      .split("\n")
      .find((l) => l.includes("open-take-film-") && l.includes("--remote-debugging-port=0"));
    return line ? Number(line.trim().split(/\s+/)[0]) : undefined;
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
      pid ??= findChrome();
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
