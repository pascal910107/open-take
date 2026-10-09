// The frames a render draws finer on its own: where the page's text moves
// under a device pixel a frame (Chrome puts glyphs on whole pixels, so it
// steps there), reaching to a cut or a fast move to change density where it
// does not show. Chrome for Testing; the browser test skips without it.

import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { fineFrames, renderFilm, turnsBack } from "../src/film/render";
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

test("turnsBack: a move whose framed point goes the wrong way first, or past and back", () => {
  const fps = 60;
  const size = { width: 1920, height: 1080 };
  // a pan right that first drifts left: the point that ends in the middle
  // moves left (screen) 40 px, then right
  const pan = (vx: number) => ({ ds: 0, tx: vx, ty: 0, share: 1, rigid: 0 });
  const view = [
    ...Array(10).fill(null),
    ...Array(12).fill(pan(200)), // the picture moves right: the point goes right… (followed back from the end)
    ...Array(30).fill(pan(-600)),
    ...Array(10).fill(null),
  ];
  const sides = Array(view.length).fill(0);
  const t = turnsBack(view, sides, fps, size);
  assert.equal(t.length, 1, JSON.stringify(t));
  assert.equal(t[0]!.axis, "x");
  assert.equal(t[0]!.kind, "back");
  assert.ok(Math.abs(t[0]!.px - 40) <= 1, JSON.stringify(t));
  // straight: none
  const straight = [...Array(10).fill(null), ...Array(40).fill(pan(-600)), ...Array(10).fill(null)];
  assert.deepEqual(turnsBack(straight, Array(straight.length).fill(0), fps, size), []);
  // two moves one after another, the second the other way, with a slow
  // point between: two moves, neither turning back
  const two = [
    ...Array(20).fill(pan(-600)),
    ...Array(3).fill(pan(-30)),
    ...Array(20).fill(pan(600)),
  ];
  assert.deepEqual(turnsBack(two, Array(two.length).fill(0), fps, size), []);
  // shapes changing on their own (not rigid) or a small element: not a move
  const shapes = view.map((v) => (v ? { ...v, rigid: 0.6 } : v));
  assert.deepEqual(turnsBack(shapes, sides, fps, size), []);
  const small = view.map((v) => (v ? { ...v, share: 0.02 } : v));
  assert.deepEqual(turnsBack(small, sides, fps, size), []);
});
