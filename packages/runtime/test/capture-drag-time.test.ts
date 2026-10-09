// A drag's (and a file drop's) time in the capture log is when its button goes
// down — after the pause that lets the screenshot pump drain — as a click's
// is: the page's own clock between a click and a drag matches the log's.
// It was taken 160 ms before, so a cursor replayed from the log led the ink.
// Skips without a Chrome for Testing (needs ffmpeg for the encode as well).

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { resolveChrome } from "../src/cdp";
import { captureTakeCDP } from "../src/cdp-capture";
import type { TakePlan } from "../src/types";

const chrome = process.env.OPEN_TAKE_E2E_CHROME ?? resolveChrome();
const skip = chrome ? false : "no Chrome for Testing";

const PAGE = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>drag</title>
<style>body{margin:0}#b{position:absolute;left:40px;top:40px;padding:10px}#pad{position:absolute;left:40px;top:200px;width:600px;height:200px;background:#eee}</style>
</head><body><button id="b">Go</button><div id="pad"></div>
<pre id="downs"></pre>
<script>const downs = []; addEventListener("pointerdown", () => { downs.push(Date.now()); document.getElementById("downs").textContent = downs.join(","); }, true);</script>
</body></html>`;

async function serve(): Promise<{ server: Server; url: string }> {
  const server = createServer((_req, res) =>
    res.writeHead(200, { "content-type": "text/html" }).end(PAGE),
  );
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  return { server, url: `http://127.0.0.1:${(server.address() as { port: number }).port}/` };
}

test("a drag's time is when its button goes down, as a click's is", {
  skip,
  timeout: 120000,
}, async () => {
  const dir = await mkdtemp(join(tmpdir(), "open-take-drag-time-"));
  const { server, url } = await serve();
  try {
    const plan: TakePlan = {
      url,
      viewport: { width: 800, height: 600 },
      steps: [
        { action: "click", text: "Go", settleMs: 300 },
        { action: "drag", from: { x: 100, y: 300 }, to: { x: 500, y: 300 }, durationMs: 600 },
      ],
    };
    const log = await captureTakeCDP(plan, {
      chromePath: chrome!,
      warmupMs: 300,
      fps: 30,
      captureScale: 1,
      videoPath: join(dir, "capture.mp4"),
      states: true,
    });
    // the page wrote its presses into itself; the state saved after the drag has them
    const last = log.states!.items.at(-1)!;
    const html = readFileSync(join(dir, "states", last.id, "state.html"), "utf8");
    const downs = (html.match(/<pre id="downs"[^>]*>([\d,]*)<\/pre>/)?.[1] ?? "")
      .split(",")
      .filter(Boolean)
      .map(Number);
    const click = log.events.find((e) => e.kind === "click");
    const drag = log.events.find((e) => e.kind === "drag");
    assert.ok(click && drag, JSON.stringify(log.events.map((e) => e.kind)));
    assert.equal(downs.length, 2, `the page saw ${downs.length} presses`);
    const page = downs[1]! - downs[0]!;
    const logged = drag.tMs - click.tMs;
    assert.ok(Math.abs(logged - page) <= 60, `log ${logged} ms between them, the page ${page} ms`);
  } finally {
    server.close();
    await rm(dir, { recursive: true, force: true });
  }
});
