// The film clock's motion probe when the page declares its own motion(t, half):
// the page says how far its picture moves, the clock still finds the cut, so
// the shutter never opens across one. Chrome for Testing; skips without it.

import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { filmClockSource } from "../src/film/clock";
import { launchHtmlBrowser } from "../src/html/cdp";
import { serveDirectory } from "../src/html/server";
import { findChrome } from "./fixtures/find-chrome";

const chrome = findChrome();
const skip = chrome ? false : "no Chrome for Testing";

let dir = "";
before(async () => {
  dir = await mkdtemp(join(tmpdir(), "open-take-film-motion-hook-"));
});
after(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** a 180° shutter's half at 60 fps, as the renderer asks for it */
const HALF = 0.5 / 60 / 2;

/** a still picture whose red card gives way to a green one at 0.25 s; with
 *  `hook`, the page says its picture moves 30 px per shutter and logs each ask */
const page = (hook: boolean) => `<!doctype html><html><head><style>
body{margin:0;width:320px;height:180px;overflow:hidden;background:#000}
.card{position:absolute;left:120px;top:60px;width:80px;height:60px}</style></head><body>
<div class="card" id="red" style="background:#f00"></div><div class="card" id="green" style="background:#0c0"></div>
<script>
window.asks = [];
window.__film = { duration: 0.5, width: 320, height: 180${
  hook ? ", motion: (t, half) => { window.asks.push([t, half]); return 30; }" : ""
} };
window.__render = (t) => {
  document.getElementById('red').style.display = t < 0.25 ? 'block' : 'none';
  document.getElementById('green').style.display = t < 0.25 ? 'none' : 'block';
};
</script></body></html>`;

type Exposure = { px: number; side: number };

test("a page's own motion hook supplies the px; the cut side is still the program's", {
  skip,
}, async () => {
  await writeFile(join(dir, "hook.html"), page(true));
  await writeFile(join(dir, "plain.html"), page(false));
  const server = await serveDirectory(dir);
  const probe = async (name: string, times: number[]) => {
    const b = await launchHtmlBrowser({
      chromePath: chrome!,
      url: `${server.url}/${name}`,
      width: 320,
      height: 180,
      initScript: filmClockSource({ seed: 3, epochMs: 0 }),
      stillAnimations: true,
      timeoutMs: 120_000,
    });
    try {
      await b.evaluate("window.__ot.prepare()");
      const out: Exposure[] = [];
      for (const t of times)
        out.push(await b.evaluate<Exposure>(`window.__ot.motion(${t}, ${HALF})`));
      const asks = await b.evaluate<[number, number][]>("window.asks");
      return { out, asks };
    } finally {
      await b.close();
    }
  };
  // 0.1: no cut anywhere near · 0.25: the cut is in the shutter's first half ·
  // 0.248: it is in the second half
  const times = [0.1, 0.25, 0.248];
  try {
    const plain = await probe("plain.html", times);
    assert.deepEqual(
      plain.out.map((e) => e.side),
      [0, 1, -1],
      "without a hook: the cut leaves out the half it is in",
    );
    const hooked = await probe("hook.html", times);
    // before the fix a hook returned side 0 at once: the cut frame was double exposed
    assert.deepEqual(
      hooked.out.map((e) => e.side),
      [0, 1, -1],
      "with a hook: the same sides as without one",
    );
    assert.deepEqual(
      hooked.out.map((e) => e.px),
      [30, 30, 30],
      "the px are the hook's",
    );
    // the hook is asked about the part of the shutter that is exposed
    const q = HALF / 2;
    const expected = [
      [0.1, HALF],
      [0.25 + q, q],
      [0.248 - q, q],
    ];
    assert.equal(hooked.asks.length, expected.length);
    hooked.asks.forEach(([t, half], i) => {
      assert.ok(Math.abs(t - expected[i]![0]!) < 1e-9, `ask ${i}: t ${t}`);
      assert.ok(Math.abs(half - expected[i]![1]!) < 1e-9, `ask ${i}: half ${half}`);
    });
  } finally {
    await server.close();
  }
});
