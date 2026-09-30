// End to end through captureTakeCDP: a two-step plan against a served page,
// states on → `states/s0..s2` beside the capture, the log carries `states`
// and every event its `state` + `target`; states off → nothing of the sort.
// Skips without a Chrome for Testing (needs ffmpeg for the encode as well).

import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { resolveChrome } from "../src/cdp";
import { captureTakeCDP } from "../src/cdp-capture";
import type { DomStateIndex } from "../src/dom-state";
import type { TakePlan } from "../src/types";

const chrome = process.env.OPEN_TAKE_E2E_CHROME ?? resolveChrome();
const skip = chrome ? false : "no Chrome for Testing";

const PAGE = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>e2e</title>
<style>body{margin:0;font-family:Arial,sans-serif;background:#fafafa}main{padding:40px}button{padding:10px 18px;font-size:16px}#panel{display:none;margin-top:16px;padding:16px;background:#dff}input{font-size:16px;padding:8px;margin-top:12px;display:block}</style>
</head><body><main><h1>Fixture</h1><button id="open">Open panel</button><div id="panel"><p>Panel is open</p></div><input id="q" placeholder="Search"></main>
<script>document.getElementById("open").addEventListener("click", () => { document.getElementById("panel").style.display = "block"; });</script>
</body></html>`;

async function serve(): Promise<{ server: Server; url: string }> {
  const server = createServer((_req, res) =>
    res.writeHead(200, { "content-type": "text/html" }).end(PAGE),
  );
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  return { server, url: `http://127.0.0.1:${(server.address() as { port: number }).port}/` };
}

test("captureTakeCDP: states on → s0..sN with index.json, events stamped; states off → nothing", {
  skip,
  timeout: 180000,
}, async () => {
  const dir = await mkdtemp(join(tmpdir(), "open-take-dom-state-e2e-"));
  const { server, url } = await serve();
  try {
    const plan: TakePlan = {
      url,
      viewport: { width: 800, height: 600 },
      steps: [
        { action: "click", text: "Open panel", settleMs: 300 },
        { action: "type", selector: "#q", value: "hi", perCharMs: 0, settleMs: 300 },
      ],
    };
    const common = { chromePath: chrome!, warmupMs: 300, fps: 30, captureScale: 1 };

    // --- on ---------------------------------------------------------------------
    const onDir = join(dir, "on");
    await mkdir(onDir, { recursive: true });
    const log = await captureTakeCDP(plan, {
      ...common,
      videoPath: join(onDir, "capture.mp4"),
      states: true,
    });
    assert.ok(log.states, "log carries states");
    assert.equal(log.states!.dir, "states");
    assert.deepEqual(
      log.states!.items.map((i) => i.id),
      ["s0", "s1", "s2"],
    );
    assert.deepEqual(
      log.states!.items.map((i) => i.step),
      [undefined, 0, 1],
    );
    for (const item of log.states!.items) {
      const d = join(onDir, "states", item.id);
      assert.deepEqual(
        readdirSync(d).sort(),
        ["index.json", "live.png", "state.html"],
        `${item.id} holds exactly the contract files`,
      );
      const index = JSON.parse(readFileSync(join(d, "index.json"), "utf8")) as DomStateIndex;
      assert.equal(index.id, item.id);
      assert.equal(index.tMs, item.tMs);
      assert.equal(index.step, item.step);
      assert.deepEqual(index.fidelity, item.fidelity);
      assert.ok(index.fidelity?.ok, `${item.id} fidelity ${JSON.stringify(index.fidelity)}`);
      assert.ok(index.elements.length > 3 && index.viewport.w === 800);
    }
    assert.ok(existsSync(join(onDir, "states", "assets")));
    assert.equal(log.events.length, 2);
    const [click, type] = log.events as [(typeof log.events)[number], (typeof log.events)[number]];
    assert.equal(click.state, "s1", "the click is followed by s1");
    assert.equal(type.state, "s2");
    const s0 = JSON.parse(
      readFileSync(join(onDir, "states", "s0", "index.json"), "utf8"),
    ) as DomStateIndex;
    const button = s0.elements.find((e) => e.id === click.target);
    assert.ok(
      button && button.tag === "button",
      `click.target names the button in s0: ${click.target} → ${JSON.stringify(button)}`,
    );
    const s1 = JSON.parse(
      readFileSync(join(onDir, "states", "s1", "index.json"), "utf8"),
    ) as DomStateIndex;
    const field = s1.elements.find((e) => e.id === type.target);
    assert.ok(
      field && field.tag === "input",
      `type.target names the input in s1: ${type.target} → ${JSON.stringify(field)}`,
    );
    assert.ok(
      s0.tMs < s1.tMs && s1.tMs > click.tMs,
      "states sit on the capture timeline after the actions they follow",
    );
    assert.ok(
      !s0.elements.some((e) => e.text === "Panel is open"),
      "s0 predates the panel; s1 shows it",
    );
    assert.ok(s1.elements.some((e) => e.text === "Panel is open"));

    // --- off ------------------------------------------------------------------------
    const offDir = join(dir, "off");
    await mkdir(offDir, { recursive: true });
    const plain = await captureTakeCDP(plan, { ...common, videoPath: join(offDir, "capture.mp4") });
    assert.equal(plain.states, undefined);
    assert.ok(!existsSync(join(offDir, "states")), "no states dir");
    assert.ok(
      plain.events.every((e) => e.state === undefined && e.target === undefined),
      "events untouched",
    );
  } finally {
    server.close();
    await rm(dir, { recursive: true, force: true });
  }
});

// A landing page whose WebGL canvas never stops (a spinning globe) is otherwise
// still: its states are saved, not skipped as moving; the canvas — which reads
// back empty from WebGL — is filled from the screenshot taken with it; and the
// fidelity check judges the rest of the page, not the frozen canvas.
const LIVING = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>globe</title>
<style>body{margin:0;font-family:Arial,sans-serif;background:#fafafa}main{padding:40px}canvas{position:absolute;right:40px;top:40px;width:300px;height:300px}button{padding:10px 18px;font-size:16px}#panel{display:none;margin-top:16px;padding:16px;background:#dff}</style>
</head><body><main><h1>Find a gym</h1><button id="open">Next</button><div id="panel"><p>Step two</p></div></main>
<canvas id="g" width="300" height="300"></canvas>
<script>
const gl = document.getElementById("g").getContext("webgl", { preserveDrawingBuffer: false });
(function spin(t) { gl.clearColor(0.2 + 0.2 * Math.sin(t / 150), 0.6, 0.4, 1); gl.clear(gl.COLOR_BUFFER_BIT); requestAnimationFrame(spin); })(0);
document.getElementById("open").addEventListener("click", () => { document.getElementById("panel").style.display = "block"; });
</script></body></html>`;

test("a page with an always-moving canvas: states saved, the canvas filled, the rest judged", {
  skip,
  timeout: 180000,
}, async () => {
  const dir = await mkdtemp(join(tmpdir(), "open-take-dom-state-living-"));
  const server = createServer((_req, res) =>
    res.writeHead(200, { "content-type": "text/html" }).end(LIVING),
  );
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/`;
  try {
    const plan: TakePlan = {
      url,
      viewport: { width: 800, height: 600 },
      steps: [{ action: "click", text: "Next", settleMs: 300 }],
    };
    const log = await captureTakeCDP(plan, {
      chromePath: chrome!,
      warmupMs: 300,
      fps: 30,
      captureScale: 1,
      videoPath: join(dir, "capture.mp4"),
      states: true,
    });
    const items = log.states?.items ?? [];
    assert.ok(items.length >= 2, `states saved (${items.length})`);
    assert.ok(
      items.every((i) => !i.moving),
      `no state skipped as moving: ${JSON.stringify(items.map((i) => ({ id: i.id, moving: i.moving })))}`,
    );
    for (const i of items) {
      assert.ok(i.fidelity?.ok, `${i.id}: fidelity ${JSON.stringify(i.fidelity)}`);
      const html = readFileSync(join(dir, "states", i.id, "state.html"), "utf8");
      assert.match(html, /data:image\/png;base64,/, `${i.id}: the canvas carries an image`);
    }
  } finally {
    server.close();
    await rm(dir, { recursive: true, force: true });
  }
});
