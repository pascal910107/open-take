import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { canvasAxisSize, canvasDisplacement, canvasGrey, filmClockSource } from "../src/film/clock";
import { launchHtmlBrowser } from "../src/html/cdp";
import { serveDirectory } from "../src/html/server";
import { findChrome } from "./fixtures/find-chrome";

const W = 192;
const H = 108;
const grey = (at: (x: number, y: number) => number) =>
  Uint8Array.from({ length: W * H }, (_, i) => at(i % W, Math.floor(i / W)));
const disc = (cx: number, cy: number) => grey((x, y) => {
  const edge = Math.min(1, Math.max(0, 8.5 - Math.hypot(x - cx, y - cy)));
  return 24 + 210 * edge;
});
const measure = (a: Uint8Array, b: Uint8Array) => canvasDisplacement(a, b, W, H, 960, 540);

test("a turned canvas keeps its own axis lengths, including CSS zoom", () => {
  assert.deepEqual(canvasAxisSize(320, 180, { a: 0, b: 1, c: -1, d: 0 }, 1), [320, 180]);
  assert.deepEqual(canvasAxisSize(320, 180, { a: 0, b: 1, c: -1, d: 0 }, 2), [640, 360]);
});

test("an opaque black square moves against transparency", () => {
  const square = (left: number) => grey((x, y) =>
    canvasGrey(0, 0, 0, x >= left && x < left + 12 && y >= 30 && y < 42 ? 255 : 0));
  assert.ok(Math.abs(measure(square(40), square(48)) - 40) <= 5);
});

test("canvas displacement measures a disc over still background in CSS pixels", () => {
  const a = disc(65, 49);
  assert.equal(measure(a, a.slice()), 0);
  for (const [dx, dy] of [[7.5, 0], [18, 10], [-42, 19], [77, 0], [150, -17]] as const) {
    const got = measure(a, disc(65 + dx / 5, 49 + dy / 5));
    const want = Math.hypot(dx, dy);
    // One thumbnail pixel is five CSS pixels at this viewport.
    assert.ok(Math.abs(got - want) <= 5, `${got} px vs ${want} px`);
  }
});

test("canvas displacement follows a pan with separate scales on the two axes", () => {
  const texture = (x: number, y: number) =>
    128 + 50 * Math.sin(x * 0.37 + y * 0.11) + 44 * Math.cos(x * 0.13 - y * 0.51)
      + 28 * Math.sin((x + y) * 0.24);
  const a = grey(texture);
  const b = grey((x, y) => texture(x - 14, y + 9));
  const got = canvasDisplacement(a, b, W, H, 768, 648);
  assert.ok(Math.abs(got - Math.hypot(14 * 4, 9 * 6)) <= 6, `${got} CSS px`);
});

test("a flash and a replacement with no matching features get the 12 px fallback", () => {
  const a = disc(65, 49);
  assert.equal(measure(a, grey(() => 255)), 12);
  assert.equal(measure(a, grey((x, y) => x > 65 && y > 49 ? 180 : 0)), 12);
});

// A textured disc of radius 25 thumbnail px, turned, grown and moved.
const part = (
  dx: number, turn: number, grow = 1, detail = 1, surround = (_x: number) => 30,
) => grey((x, y) => {
  const u = (x - 96 - dx) / grow, v = (y - 54) / grow;
  if (Math.hypot(u, v) > 25) return surround(x);
  const c = Math.cos(turn), s = Math.sin(turn);
  const p = c * u - s * v + 100, q = s * u + c * v + 100;
  return Math.max(0, Math.min(255, Math.round(128 + 60 * Math.sin(p * 0.28 * detail) *
    Math.cos(q * 0.36 * detail) + 50 * Math.sin((p + 2 * q) * 0.13 * detail))));
});

test("a repeating texture does not send a turning patch to another repeat", () => {
  const still = part(0, 0, 1, 2.5);
  for (const [dx, turn, scale, lo, hi] of [
    [0, 20, 1, 35, 55], [0, 45, 1, 80, 110], [0, 0, 1.3, 30, 45],
    [8, 10, 1, 40, 70], [0.4, 0, 1, 0.5, 3.5],
  ] as const) {
    const got = measure(still, part(dx, turn * deg, scale, 2.5));
    assert.ok(got >= lo && got <= hi, `${dx} px, ${turn}°, ${scale}×: ${got} CSS px`);
  }
});

test("a strong local turn over a still background gets more than the cut distance", () => {
  const background = (x: number) => 30 + Math.floor(x / 5);
  const got = measure(part(0, 0, 1, 5, background), part(0, 75 * deg, 1, 5, background));
  // The rim moves about 152 CSS px. If the texture cannot be followed,
  // the radius of its changed box still keeps shutter samples close.
  assert.ok(got >= 140 && got <= 190, `${got} CSS px`);
});
const deg = Math.PI / 180;

test("canvas displacement follows the fastest edge of a part that turns, grows or travels far", () => {
  // [moved, measured at least, at most] in CSS px; one thumbnail px is 5
  const cases: [string, Uint8Array, number, number][] = [
    ["turned 20° in place (rim 8.7 px)", part(0, 20 * deg), 30, 60],
    ["turned 45° in place (rim 19 px)", part(0, 45 * deg), 60, 120],
    ["grown 1.3× in place (rim 7.5 px)", part(0, 0, 1.3), 30, 55],
    ["grown 1.12× (rim 3 px)", part(0, 0, 1.12), 10, 25],
    ["moved 8 px and turned 10°", part(8, 10 * deg), 40, 70],
    ["moved 40 px", part(40, 0), 190, 210],
    ["moved 0.4 px", part(0.4, 0), 0, 10],
  ];
  const still = part(0, 0);
  for (const [what, moved, lo, hi] of cases) {
    const got = measure(still, moved);
    assert.ok(got >= lo && got <= hi, `${what}: ${got.toFixed(1)} CSS px, wanted ${lo}–${hi}`);
  }
});

test("a canvas that barely changes measures nothing, so the probe's own test decides", () => {
  const a = part(0, 0);
  const b = a.slice();
  b[60 * W + 100]! += 1;
  assert.equal(measure(a, b), 0);
  // a 4×4 square flickering by four grey levels
  const c = a.slice();
  for (let y = 20; y < 24; y++) for (let x = 20; x < 24; x++) c[y * W + x] = a[y * W + x]! + 4;
  assert.equal(measure(a, c), 0);
});

test("grain that changes every frame on a still canvas measures nothing", () => {
  for (const seed of [1, 4, 7, 23, 39]) {
    let s = seed;
    const random = () => {
      s = (s * 16807) % 2147483647;
      return s / 2147483647;
    };
    const grain = (amp: number) => grey(() => Math.round(100 + (random() - 0.5) * amp));
    for (const amp of [10, 20, 40, 80]) assert.equal(measure(grain(amp), grain(amp)), 0, `seed ${seed}, ±${amp / 2}`);
  }
  // the same grain over a disc that moves still follows the disc
  let s = 3;
  const random = () => {
    s = (s * 16807) % 2147483647;
    return s / 2147483647;
  };
  const noisy = (cx: number) => {
    const d = disc(cx, 54);
    return d.map((v) => Math.max(0, Math.min(255, Math.round(v + (random() - 0.5) * 20))));
  };
  const px = measure(noisy(90), noisy(96));
  assert.ok(Math.abs(px - 30) <= 6, `px ${px}`);
});

const chrome = findChrome();

test("a WebGPU probe sees the same fast disc before and after awaiting its queue, and over two submits", {
  skip: chrome ? false : "no Chrome for Testing",
}, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "open-take-gpu-motion-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(join(dir, "index.html"), `<!doctype html>
<style>body{margin:0}canvas{display:block;width:320px;height:180px}</style>
<canvas width="640" height="360"></canvas>
<script>
const wait = location.search === "?wait";
const twice = location.search === "?twice";
const canvas = document.querySelector("canvas");
const ready = (async () => {
  const adapter = await navigator.gpu?.requestAdapter();
  if (!adapter) return;
  const device = await adapter.requestDevice();
  const context = canvas.getContext("webgpu");
  const format = navigator.gpu.getPreferredCanvasFormat();
  context.configure({device, format});
  const center = device.createBuffer({size: 4, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST});
  const module = device.createShaderModule({code: \`
    @group(0) @binding(0) var<uniform> center: f32;
    @vertex fn vertex(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
      let p = array(vec2f(-1,-1), vec2f(3,-1), vec2f(-1,3));
      return vec4f(p[i], 0, 1);
    }
    @fragment fn fragment(@builtin(position) p: vec4f) -> @location(0) vec4f {
      let shade = select(0.08, 0.9, distance(p.xy, vec2f(center, 180)) < 32);
      return vec4f(shade, shade, shade, 1);
    }
  \`});
  const pipeline = device.createRenderPipeline({
    layout: "auto", vertex: {module}, fragment: {module, targets: [{format}]}
  });
  const group = device.createBindGroup({layout: pipeline.getBindGroupLayout(0),
    entries: [{binding: 0, resource: {buffer: center}}]});
  window.hasGPU = true;
  window.__render = (t) => {
    device.queue.writeBuffer(center, 0, new Float32Array([320 + (t - 0.1) * 7200]));
    const view = context.getCurrentTexture().createView();
    if (twice) {
      // a clear on its own, then the scene loaded over it in a second submit
      const clear = device.createCommandEncoder();
      clear.beginRenderPass({colorAttachments: [{view, loadOp: "clear", storeOp: "store"}]}).end();
      device.queue.submit([clear.finish()]);
    }
    const encoder = device.createCommandEncoder();
    const pass = encoder.beginRenderPass({colorAttachments: [{
      view, loadOp: twice ? "load" : "clear", storeOp: "store"
    }]});
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, group);
    pass.draw(3);
    pass.end();
    device.queue.submit([encoder.finish()]);
    if (wait) return device.queue.onSubmittedWorkDone();
  };
})();
window.__film = {duration: 0.2, ready};
</script>`);
  const server = await serveDirectory(dir);
  t.after(() => server.close());
  const run = async (query: string) => {
    const browser = await launchHtmlBrowser({
      chromePath: chrome!,
      url: server.url + query,
      width: 320,
      height: 180,
      initScript: filmClockSource({ seed: 3, epochMs: 0 }),
    });
    try {
      await browser.evaluate("window.__ot.prepare()");
      if (!await browser.evaluate("!!window.hasGPU")) return null;
      return await browser.evaluate<{ px: number; side: number }>("window.__ot.motion(0.1, 1/240)");
    } finally {
      await browser.close();
    }
  };
  const sync = await run("/");
  if (!sync) return t.skip("no WebGPU adapter");
  const async = await run("/?wait");
  assert.ok(async);
  assert.equal(sync.side, 0);
  assert.ok(Math.abs(sync.px - 30) <= 4, JSON.stringify(sync));
  assert.deepEqual(async, sync);
  assert.deepEqual(await run("/?twice"), sync);
});

test("a 2D canvas's motion is measured along its own axes, turned or not, and black on transparent counts", {
  skip: chrome ? false : "no Chrome for Testing",
}, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "open-take-canvas-turn-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  // a 640×360 canvas shown at 320×180; the disc crosses it at 7200 canvas px/s
  await writeFile(join(dir, "index.html"), `<!doctype html>
<style>body{margin:0;background:#fff}canvas{position:absolute;left:70px;top:70px;width:320px;height:180px}</style>
<canvas width="640" height="360"></canvas>
<script>
const q = new URLSearchParams(location.search);
const canvas = document.querySelector("canvas");
if (q.has("turn")) canvas.style.transform = "rotate(90deg)";
const g = canvas.getContext("2d");
window.__render = (t) => {
  g.clearRect(0, 0, 640, 360);
  if (!q.has("clear")) { g.fillStyle = "#141414"; g.fillRect(0, 0, 640, 360); }
  g.fillStyle = q.has("clear") ? "#000" : "#e6e6e6";
  g.beginPath(); g.arc(320 + (t - 0.1) * 7200, 180, 32, 0, 7); g.fill();
};
window.__film = {duration: 0.2};
</script>`);
  const server = await serveDirectory(dir);
  t.after(() => server.close());
  const run = async (query: string) => {
    const browser = await launchHtmlBrowser({
      chromePath: chrome!,
      url: server.url + query,
      width: 460,
      height: 460,
      initScript: filmClockSource({ seed: 3, epochMs: 0 }),
    });
    try {
      await browser.evaluate("window.__ot.prepare()");
      return await browser.evaluate<{ px: number; side: number }>("window.__ot.motion(0.1, 1/240)");
    } finally {
      await browser.close();
    }
  };
  // 7200 canvas px/s over the 1/120 s shutter is 60 canvas px, 30 CSS px
  const flat = await run("/");
  assert.ok(Math.abs(flat.px - 30) <= 4, JSON.stringify(flat));
  const turned = await run("/?turn");
  assert.ok(Math.abs(turned.px - flat.px) <= 1.5, `${JSON.stringify(turned)} vs ${JSON.stringify(flat)}`);
  const clear = await run("/?clear");
  assert.ok(Math.abs(clear.px - 30) <= 4, JSON.stringify(clear));
});
