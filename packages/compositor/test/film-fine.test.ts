// The frames a render draws finer on its own: where the page's text moves
// under a device pixel a frame (Chrome puts glyphs on whole pixels, so it
// steps there), reaching to a cut or a fast move to change density where it
// does not show. Chrome for Testing; the browser test skips without it.

import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { fineFrames, renderFilm } from "../src/film/render";
import { findChrome } from "./fixtures/find-chrome";

const chrome = findChrome();
const skip = chrome ? false : "no Chrome for Testing";

const runs = (fine: boolean[]) => {
  const out: [number, number][] = [];
  fine.forEach((f, i) => {
    if (!f) return;
    const last = out.at(-1);
    if (last && last[1] === i) last[1] = i + 1;
    else out.push([i, i + 1]);
  });
  return out;
};

test("fineFrames: slow text, the settle after it, and nothing else", () => {
  const fps = 60;
  // px a second: still, fast, slow, a long settle, still
  const text = [
    ...Array(30).fill(0),
    ...Array(30).fill(300), // 5 px a frame
    ...Array(30).fill(30), // 0.5 px a frame
    ...Array(30).fill(0.3), // 0.005 px a frame
    ...Array(30).fill(0),
  ];
  const sides = Array(text.length).fill(0);
  // the slow part and the settle, reaching on to the end of the shot (no
  // cut before it) — back to the fast move, which hides the change
  assert.deepEqual(runs(fineFrames(text, sides, fps, 1)), [[60, 150]]);
  // a cut at frame 130: the run stops at the picture before it
  const cut = sides.slice();
  cut[130] = 1;
  assert.deepEqual(runs(fineFrames(text, cut, fps, 1)), [[60, 130]]);
  // drawn at twice the density, 0.5 page px is a device pixel a frame
  assert.deepEqual(runs(fineFrames(text, sides, fps, 2)), [[90, 150]]);
});

test("fineFrames: short runs are left out, short gaps joined", () => {
  const fps = 60;
  const blip = [...Array(20).fill(0), ...Array(4).fill(30), ...Array(20).fill(300)];
  assert.deepEqual(runs(fineFrames(blip, Array(blip.length).fill(0), fps, 1)), []);
  const gappy = [
    ...Array(10).fill(300),
    ...Array(10).fill(30),
    ...Array(10).fill(0),
    ...Array(10).fill(30),
    ...Array(10).fill(300),
  ];
  assert.deepEqual(runs(fineFrames(gappy, Array(gappy.length).fill(0), fps, 1)), [[10, 40]]);
});

let dir = "";
before(async () => {
  dir = await mkdtemp(join(tmpdir(), "open-take-fine-test-"));
});
after(async () => {
  await rm(dir, { recursive: true, force: true });
});

test("a render draws the slow drift of a line of text finer, and --supersample 1 does not", {
  skip,
}, async () => {
  // 1 s still, 1 s fast (a cut-free move of 300 px), 1 s drifting 12 px
  await writeFile(
    join(dir, "index.html"),
    `<!doctype html><html><body style="margin:0;background:#fff">
<p id="t" style="position:absolute;left:20px;top:40px;font:16px sans-serif;margin:0">a line of text</p>
<script>
window.__film = { duration: 3, width: 640, height: 120, fps: 30 };
window.__render = (t) => {
  const x = t < 1 ? 0 : t < 2 ? (t - 1) * 300 : 300 + (t - 2) * 12;
  document.getElementById("t").style.transform = "translateX(" + x + "px)";
};
</script></body></html>`,
  );
  const r = await renderFilm({
    page: join(dir, "index.html"),
    out: join(dir, "a.mp4"),
    chromePath: chrome!,
    audio: null,
    blur: false,
  });
  assert.equal(r.fineSupersample, 3);
  assert.equal(r.fine.length, 1, JSON.stringify(r.fine));
  // from the end of the fast move to the end of the film
  assert.ok(Math.abs(r.fine[0]!.from - 2) <= 0.1, JSON.stringify(r.fine));
  assert.ok(Math.abs(r.fine[0]!.to - 3) <= 0.05, JSON.stringify(r.fine));
  const plain = await renderFilm({
    page: join(dir, "index.html"),
    out: join(dir, "b.mp4"),
    chromePath: chrome!,
    audio: null,
    blur: false,
    supersample: 1,
  });
  assert.deepEqual(plain.fine, []);
});
