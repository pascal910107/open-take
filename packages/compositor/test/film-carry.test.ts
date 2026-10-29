// What crossed each boundary of the beat sheet: a segment's `carry` (kit/time.js)
// is followed by the render as curves, and src/film/carry.ts says what it did.
// The browser test needs Chrome for Testing and skips without it.

import assert from "node:assert/strict";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { carryCurve as kitCarryCurve, timeline } from "../kit/time.js";
import {
  boundaryCarries,
  type CarrySample,
  carryChange,
  carryCurve,
  classifyCarry,
} from "../src/film/carry";
import { type FilmEvents, renderFilm } from "../src/film/render";
import { findChrome } from "./fixtures/find-chrome";

const chrome = findChrome();
const skip = chrome ? false : "no Chrome for Testing";
const F = { w: 100, h: 100 };
const dt = 0.1;

let dir = "";
before(async () => {
  dir = await mkdtemp(join(tmpdir(), "open-take-carry-test-"));
});
after(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** samples every 0.1 s from 1 s before `at` to 0.4 s after, from a box of t */
const along = (at: number, box: (t: number) => Omit<CarrySample, "t">) =>
  Array.from({ length: 15 }, (_, i) => {
    const t = +(at - 1 + i * dt).toFixed(3);
    return { t, ...box(t) };
  });

test("the kit and the reader name a carry's curves the same way", () => {
  assert.equal(carryCurve(7.05, "x"), "carry@7.05:x");
  assert.equal(kitCarryCurve(7.05, "x"), carryCurve(7.05, "x"));
  assert.equal(carryCurve(1 / 3, "o"), "carry@0.333:o");
});

test("a thing that grows to fill the frame on the way to the boundary is carried", () => {
  const s = along(5, (t) => {
    const p = Math.max(0, Math.min(1, (t - 4.1) / 0.8));
    const w = 10 + 90 * p;
    return { x: 45 - 45 * p, y: 45 - 45 * p, w, h: w, o: t < 5 ? 1 : 0 };
  });
  const c = classifyCarry(s, 5, F, dt);
  assert.equal(c.kind, "carried");
  assert.ok(c.scale > 9 && c.fill === 1);
});

test("a scene that slides away while it fades is anchored, not carried, though it moved and filled the frame", () => {
  const s = along(5, (t) => {
    const p = Math.max(0, Math.min(1, (t - 5) / 0.5));
    return { x: -26 * p, y: 0, w: 100, h: 100, o: 1 - p };
  });
  const c = classifyCarry(s, 5, F, dt);
  assert.equal(c.kind, "anchored");
  assert.match(c.note!, /fading out/);
});

test("a thing that stays put across is anchored; one that moves on and stays is carried", () => {
  assert.equal(
    classifyCarry(
      along(5, () => ({ x: 10, y: 10, w: 20, h: 20, o: 1 })),
      5,
      F,
      dt,
    ).kind,
    "anchored",
  );
  const moving = along(5, (t) => ({
    x: 10 + 20 * Math.max(0, t - 4.5),
    y: 10,
    w: 20,
    h: 20,
    o: 1,
  }));
  assert.equal(classifyCarry(moving, 5, F, dt).kind, "carried");
});

test("a thing never on screen, or first on screen after the boundary, is bare", () => {
  assert.equal(
    classifyCarry(
      along(5, () => ({ x: 0, y: 0, w: 0, h: 0, o: 0 })),
      5,
      F,
      dt,
    ).kind,
    "bare",
  );
  const late = along(5, (t) => ({ x: 10, y: 10, w: 20, h: 20, o: t >= 5 ? 1 : 0 }));
  const c = classifyCarry(late, 5, F, dt);
  assert.equal(c.kind, "bare");
  assert.match(c.note!, /only after/);
});

test("every boundary inside the film is listed: followed, a cut on purpose, words, or nothing", () => {
  const at = 2;
  const names = ["x", "y", "w", "h", "o", "fw", "fh"].map((f) => carryCurve(at, f));
  const rows = Array.from({ length: 40 }, (_, i) => {
    const t = i * 0.1;
    if (t < at - 1 - 1e-9 || t > at + 0.4 + 1e-9) return names.map(() => null);
    const p = Math.max(0, Math.min(1, (t - 1.2) / 0.8));
    const w = 10 + 90 * p;
    return [45 - 45 * p, 45 - 45 * p, w, w, 1, 100, 100];
  });
  const ev = {
    duration: 4,
    fps: 10,
    curves: { names, t0: 0, dt: 0.1, rows },
    segments: [
      { from: 0, to: 2, handoff: "the dot opens into the next scene", carry: "#dot" },
      { from: 2, to: 2.5, handoff: "cut" },
      { from: 2.5, to: 3 },
      { from: 3, to: 3.5, handoff: "the panel slides away" },
      { from: 3.5, to: 4, handoff: "whatever ends the film" },
    ],
  } as unknown as FilmEvents;
  const list = boundaryCarries(ev);
  assert.deepEqual(
    list.map((b) => [b.at, b.how.kind]),
    [
      [2, "carried"],
      [2.5, "cut"],
      [3, "unwritten"],
      [3.5, "words"],
    ],
  );
  assert.equal(carryChange(list[0]!), "grew ×10.0, filled the frame");
  // a second segment ending on the same boundary with only a handoff keeps the first one's carry
  const both = boundaryCarries({
    ...ev,
    segments: [
      { from: 0, to: 2, carry: "#dot" },
      { from: 1, to: 2, handoff: "the dot opens into the next scene" },
    ],
  } as unknown as FilmEvents);
  assert.deepEqual(
    both.map((b) => [b.at, b.carry, b.handoff, b.how.kind]),
    [[2, "#dot", "the dot opens into the next scene", "carried"]],
  );
});

test("a segment keeps what it carries: a selector as given, a function as words", () => {
  const tl = timeline({ at: { a: 0, b: 2 } });
  tl.segment("a", "b", { handoff: "the card turns over", carry: " #card " });
  tl.segment(2, 3, { carry: () => ({ x: 0, y: 0, width: 10, height: 10 }) });
  assert.deepEqual(
    tl.segments().map((s) => s.carry),
    ["#card", "(a function)"],
  );
  // @ts-expect-error a carry is a selector or a function
  assert.throws(() => tl.segment(3, 4, { carry: 5 }), /CSS selector, or a function/);
  // outside a page nothing is measured: the score's Node script imports the same module
  assert.deepEqual(tl.curves(1.5), {});
});

test("a render follows a carry across its boundary and the reader says it was carried", {
  skip,
}, async () => {
  const page = join(dir, "grow");
  await mkdir(join(page, "kit"), { recursive: true });
  await copyFile(join(import.meta.dirname, "..", "kit", "time.js"), join(page, "kit", "time.js"));
  await writeFile(
    join(page, "index.html"),
    `<!doctype html><html><head><style>body{margin:0;width:64px;height:64px;overflow:hidden;background:#000}
#dot{position:absolute;background:#0f0}#next{position:absolute;inset:0;background:#00f;visibility:hidden}
#wipe{position:absolute;inset:0;background:#f00;clip-path:inset(32px 32px 32px 32px)}</style></head><body>
<div id="dot"></div><div id="next"></div><div id="wipe"></div>
<script type="module">
import { timeline } from "./kit/time.js";
const tl = timeline({ at: { open: 0.5, end: 1.5 } });
// the dot grows to fill the frame and the next scene is shown in its place;
// a clip-path opens the red layer from its middle, then the red goes away at once
tl.segment(0, "open", { handoff: "the dot opens into the next scene", carry: "#dot" });
tl.segment("open", 1, { handoff: "the red opens from the middle", carry: "#wipe" });
tl.segment(1, "end");
window.__film = { duration: 1.5, width: 64, height: 64, fps: 30, ...tl.hooks() };
const dot = document.getElementById("dot");
window.__render = (t) => {
  const p = Math.max(0, Math.min(1, (t - 0.1) / 0.4));
  const w = 6 + 58 * p;
  Object.assign(dot.style, { left: (32 - w / 2) + "px", top: (32 - w / 2) + "px", width: w + "px", height: w + "px", display: t < 0.5 ? "block" : "none" });
  document.getElementById("next").style.visibility = t >= 0.5 ? "visible" : "hidden";
  const q = Math.max(0, Math.min(1, (t - 0.5) / 0.4));
  const i = 32 * (1 - q);
  const wipe = document.getElementById("wipe");
  wipe.style.clipPath = "inset(" + i + "px " + i + "px " + i + "px " + i + "px)";
  wipe.style.display = t < 1 ? "block" : "none";
};
</script></body></html>`,
  );
  const out = join(dir, "grow.mp4");
  const r = await renderFilm({ page, out, chromePath: chrome!, workers: 1, audio: null });
  const ev = JSON.parse(await readFile(r.events!, "utf8")) as FilmEvents;
  assert.equal(ev.segments[0]!.carry, "#dot");
  const list = boundaryCarries(ev);
  assert.deepEqual(
    list.map((b) => [b.at, b.how.kind]),
    [
      [0.5, "carried"],
      [1, "carried"],
    ],
  );
  const wipe = list[1]!.how;
  assert.ok(wipe.measured && wipe.fill === 1 && wipe.scale > 5, JSON.stringify(wipe));
});
