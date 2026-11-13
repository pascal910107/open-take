// The real-material path end to end (test/fixtures/seam-film): a take the
// runtime recorded of a fixture product — one click, its result showing 0.7 s
// later, saved states — played by a film page through kit/media.js. The
// recording plays the click; inside the seam's window the film swaps to the
// saved state of that moment; the result card is lifted out of the real
// interface and carried with motion.js morphRect to fill the frame. Rendered
// as a master (no blur) by the real renderer and read back frame by frame: nothing
// moves at the swap and what differs there is no more than `make` measured at
// the seam, the lifted card's first frame is the card where the page had it,
// and the result shows on screen at its measured time, not the click's.
// The recording's colours against the state's are checked apart, for the take
// as the runtime records it (sRGB's curve named) and for one it recorded
// before (BT.709's named, which Chrome on macOS shows through Apple's gamma).
// Chrome for Testing; skipped without it. The take is recorded by
// fixtures/seam-film/record.ts; take-bt709 is the same take as the runtime
// recorded it up to 0.5.3, kept as it was.

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { cp, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { promisify } from "node:util";
// @ts-expect-error — the kit is plain JS, checked by its own tsconfig
import { clip, clipEvents, fromLog, seam } from "../kit/media.js";
import { resolveFfmpeg } from "../src/ffmpeg";
import { initFilm } from "../src/film/kit";
import { filmStills, renderFilm } from "../src/film/render";
import { findChrome } from "./fixtures/find-chrome";
// @ts-expect-error — the film's own plain-JS timing, shared with its page
import * as plan from "./fixtures/seam-film/film/plan.js";

const exec = promisify(execFile);
const chrome = findChrome();
const skip = chrome ? false : "no Chrome for Testing";
const FIXTURE = join(import.meta.dirname, "fixtures", "seam-film");
const { FPS, WIDTH: W, HEIGHT: H } = plan as { FPS: number; WIDTH: number; HEIGHT: number };

type Box = { x: number; y: number; width: number; height: number };

let dir = "";
/** the film of the take the runtime recorded before it named sRGB's curve */
let older = "";
before(async () => {
  dir = await mkdtemp(join(tmpdir(), "open-take-seam-e2e-"));
  await cp(FIXTURE, dir, { recursive: true });
  await initFilm({ dir: join(dir, "film"), starter: false });
  older = join(dir, "older");
  await cp(FIXTURE, older, { recursive: true });
  await rm(join(older, "take"), { recursive: true });
  await cp(join(FIXTURE, "take-bt709"), join(older, "take"), { recursive: true });
  await initFilm({ dir: join(older, "film"), starter: false });
});
after(async () => {
  if (!process.env.KEEP_FILM_TEST) await rm(dir, { recursive: true, force: true });
  else console.log(dir);
});

/** every frame of a video as RGB at the film's size */
async function decode(file: string): Promise<Buffer[]> {
  const { stdout } = await exec(
    await resolveFfmpeg(),
    [
      "-v",
      "error",
      "-i",
      file,
      "-vf",
      `scale=${W}:${H}:flags=area,format=rgb24`,
      "-f",
      "rawvideo",
      "-pix_fmt",
      "rgb24",
      "-",
    ],
    { encoding: "buffer", maxBuffer: 1 << 28 },
  );
  const buf = stdout as Buffer;
  const size = W * H * 3;
  return Array.from({ length: buf.length / size }, (_, i) =>
    buf.subarray(i * size, (i + 1) * size),
  );
}

/** mean absolute difference a channel, over a box (default all) */
function meanDiff(a: Buffer, b: Buffer, box: Box = { x: 0, y: 0, width: W, height: H }): number {
  let sum = 0;
  let n = 0;
  for (let y = box.y; y < box.y + box.height; y++)
    for (let x = box.x; x < box.x + box.width; x++)
      for (let c = 0; c < 3; c++) {
        const i = (y * W + x) * 3 + c;
        sum += Math.abs(a[i]! - b[i]!);
        n++;
      }
  return sum / n;
}

/** the card's dark green (#1d4d3c) */
const green = (f: Buffer, i: number) =>
  Math.abs(f[i]! - 0x1d) < 24 && Math.abs(f[i + 1]! - 0x4d) < 24 && Math.abs(f[i + 2]! - 0x3c) < 24;

/** the box the card's green covers inside `area` (rows and columns mostly
 *  green), or null; the product's button is the same green, below y 300 */
function greenBox(
  f: Buffer,
  area: Box = { x: 200, y: 0, width: W - 200, height: 290 },
): Box | null {
  const rows: number[] = [];
  const cols: number[] = [];
  const colCount = new Array(W).fill(0);
  for (let y = area.y; y < area.y + area.height; y++) {
    let n = 0;
    for (let x = area.x; x < area.x + area.width; x++)
      if (green(f, (y * W + x) * 3)) {
        n++;
        colCount[x]++;
      }
    if (n >= 40) rows.push(y);
  }
  for (let x = area.x; x < area.x + area.width; x++) if (colCount[x] >= 40) cols.push(x);
  if (!rows.length || !cols.length) return null;
  const x0 = cols[0]!;
  const y0 = rows[0]!;
  return {
    x: x0,
    y: y0,
    width: cols[cols.length - 1]! - x0 + 1,
    height: rows[rows.length - 1]! - y0 + 1,
  };
}

const log = JSON.parse(await readFile(join(FIXTURE, "take", "capture.json"), "utf8"));
const take = fromLog(log, "http://x/take/capture.json");
const c = clip(plan.CLIP);
const ev = clipEvents(take, c);
const click = ev.find((e: { kind: string }) => e.kind === "click");
const result = ev.find((e: { kind: string }) => e.kind === "result");
const sm = seam(take, c, log.events[0].state, { video: { x: 0, y: 0, width: W, height: H } });
const swap = Math.round(plan.swapAt(sm.window) * FPS);
/** the frame the film of the take in `root` swaps to its saved state on */
const swapOf = async (root: string): Promise<number> => {
  const l = JSON.parse(await readFile(join(root, "take", "capture.json"), "utf8"));
  const s = seam(fromLog(l, "http://x/take/capture.json"), c, l.events[0].state, {
    video: { x: 0, y: 0, width: W, height: H },
  });
  return Math.round(plan.swapAt(s.window) * FPS);
};
const liftAt = Math.round(plan.LIFT_AT * FPS);
/** the result card where the page has it, from the saved state's own index */
const pageBox = async (): Promise<Box> => {
  const index = JSON.parse(
    await readFile(join(FIXTURE, "take", "states", log.events[0].state, "index.json"), "utf8"),
  );
  const html = await readFile(
    join(FIXTURE, "take", "states", log.events[0].state, "state.html"),
    "utf8",
  );
  assert.match(html, /id="total"/, "the saved state holds the result card");
  const el = index.elements.find(
    (e: { tag: string; box: number[] }) => e.tag === "div" && e.box[0] === 380 && e.box[1] === 60,
  );
  assert.ok(el, "the index lists the card");
  const [x, y, width, height] = el.box;
  return { x, y, width, height };
};

test("the take: the result showed after the click, measured, and the click's state has a seam", () => {
  assert.ok(click && result, "the clip shows the click and its result");
  assert.equal(result.basis, "measured");
  assert.ok(
    result.t - click.t > 0.5,
    `the result showed ${(result.t - click.t).toFixed(3)} s after the click (the app waits 0.7 s)`,
  );
  assert.equal(click.resultAt, result.t);
  assert.ok(sm.window, "the clip shows the stretch the state stands for");
  assert.equal(sm.window.basis.from, "measured");
  assert.ok(sm.window.from >= result.t - 1e-9, "the window opens once the result is done");
  assert.ok(swap / FPS < sm.window.to && swap < liftAt, "the swap is inside it, before the lift");
  assert.equal(sm.residual.basis, "measured");
});

// --- rendered once, read by the tests below ------------------------------------

const renderings = new Map<string, Promise<Buffer[]>>();
/** the film rendered as a master at its own 640×360 and 30 fps, decoded — without
 *  motion blur: a blurred first frame of the lift would already show the
 *  shutter's share of the move (the blur has its own tests); the take in
 *  `root`, by default the fixture's */
const rendered = (root = dir) => {
  let rendering = renderings.get(root);
  if (!rendering) {
    rendering = render(root);
    renderings.set(root, rendering);
  }
  return rendering;
};
async function render(root: string): Promise<Buffer[]> {
  const out = join(root, "seam.mp4");
  const r = await renderFilm({
    page: join(root, "film", "index.html"),
    root,
    out,
    chromePath: chrome!,
    workers: 1,
    blur: false,
  });
  assert.equal(r.frames, plan.DURATION * FPS);
  assert.deepEqual([r.width, r.height], [W, H]);
  const f = await decode(out);
  assert.equal(f.length, r.frames);
  return f;
}

/** luma edge profiles across x and down y: where the picture's edges are */
function edges(f: Buffer): { x: number[]; y: number[] } {
  const L = (x: number, y: number) => {
    const i = (y * W + x) * 3;
    return 0.2126 * f[i]! + 0.7152 * f[i + 1]! + 0.0722 * f[i + 2]!;
  };
  const x = new Array(W).fill(0);
  const y = new Array(H).fill(0);
  for (let j = 0; j < H - 1; j++)
    for (let i = 0; i < W - 1; i++) {
      x[i] += Math.abs(L(i + 1, j) - L(i, j));
      y[j] += Math.abs(L(i, j + 1) - L(i, j));
    }
  return { x, y };
}
/** how far profile b sits from a (px, to a quarter): the best of ±12 px (as far
 *  as `make`'s own seam search reaches), refined by a parabola through its
 *  neighbours */
function shiftOf(a: number[], b: number[]): number {
  const cost = (s: number) => {
    let c = 0;
    for (let i = 14; i < a.length - 14; i++) c += Math.abs(a[i]! - b[i + s]!);
    return c;
  };
  let best = 0;
  for (let s = -12; s <= 12; s++) if (cost(s) < cost(best)) best = s;
  const [l, m, r] = [cost(best - 1), cost(best), cost(best + 1)];
  const d = l - 2 * m + r;
  return best + (d > 0 ? (l - r) / (2 * d) : 0);
}
/** the mean colour over a box */
function meanOf(f: Buffer, b: Box): number[] {
  const s = [0, 0, 0];
  for (let y = b.y; y < b.y + b.height; y++)
    for (let x = b.x; x < b.x + b.width; x++)
      for (let c = 0; c < 3; c++) s[c]! += f[(y * W + x) * 3 + c]!;
  return s.map((v) => v / (b.width * b.height));
}

test("the swap from recording to saved state does not jump", { skip }, async () => {
  const frames = await rendered();
  const [rec, st] = [frames[swap - 1]!, frames[swap]!];
  // the recording holds still before the swap and the state after it: frames
  // on either side differ by what the encoder leaves, nothing more
  const before = meanDiff(frames[swap - 2]!, rec);
  const after = meanDiff(st, frames[swap + 1]!);
  assert.ok(before < 0.3 && after < 0.3, `still on both sides (${before}, ${after})`);
  // nothing moves at the swap: the page's edges are where they were
  const a = edges(rec);
  const b = edges(st);
  const dx = shiftOf(a.x, b.x);
  const dy = shiftOf(a.y, b.y);
  assert.ok(
    Math.abs(dx) <= 0.25 && Math.abs(dy) <= 0.25,
    `the page shifts ${dx.toFixed(2)}, ${dy.toFixed(2)} px at the swap`,
  );
  // what differs is no more than `make` measured between the recording's frame
  // and the state's screenshot at the seam (a picture of a 2× recording drawn
  // at 1× against the page drawn at 1×, and the recording's encode)
  const swapDiff = meanDiff(rec, st);
  assert.ok(
    swapDiff <= sm.residual.meanDiff,
    `the swap frame differs from the one before by ${swapDiff.toFixed(2)} a channel; make measured ${sm.residual.meanDiff} at the seam`,
  );
});

// A screenshot is an sRGB picture, and the recording keeps its values: Chrome
// on macOS showed a recording that named BT.709's curve through Apple's gamma
// (src/film/frames.ts copies what Chrome shows), its darks lighter than the
// saved state's — the card's green #1d4d3c as 28,87,65 against 29,76,61. The
// runtime names sRGB's curve now, and a take it recorded before is read so;
// that one's encode also rounded its colours down by up to 4 (the page's
// #f4f1ea came out 241,242,233), which the runtime no longer does.
for (const [label, root, within] of [
  ["as the runtime records it, sRGB's curve named", () => dir, 2],
  ["as it recorded before, BT.709's curve named", () => older, 5],
] as const)
  test(`the recording's colours are the saved state's across the swap: ${label}`, {
    skip,
  }, async () => {
    const frames = await rendered(root());
    const at = await swapOf(root());
    const want = await pageBox();
    const card = { x: want.x + 10, y: want.y + 4, width: 40, height: 10 };
    const page = { x: 600, y: 300, width: 30, height: 40 };
    for (const [name, b] of [
      ["the card", card],
      ["the page", page],
    ] as const) {
      const a = meanOf(frames[at - 1]!, b);
      const s = meanOf(frames[at]!, b);
      assert.ok(
        a.every((v, i) => Math.abs(v - s[i]!) <= within),
        `${name}: ${a.map(Math.round)} in the recording, ${s.map(Math.round)} in the saved state`,
      );
    }
  });

test("the lifted card starts exactly where the page had it, then fills the frame", {
  skip,
}, async () => {
  const frames = await rendered();
  const want = await pageBox();
  const first = greenBox(frames[liftAt]!);
  assert.ok(first, "the lifted card shows on its first frame");
  const inRec = greenBox(frames[swap - 1]!);
  assert.ok(inRec, "the recording shows the card before the swap");
  for (const k of ["x", "y", "width", "height"] as const) {
    assert.ok(
      Math.abs(first[k] - want[k]) <= 1,
      `lift's first frame ${k}: ${first[k]} on the film, ${want[k]} in the page`,
    );
    assert.ok(
      Math.abs(first[k] - inRec[k]) <= 1,
      `and ${inRec[k]} where the recording shows it (${k})`,
    );
  }
  // the real card hidden in the state, its copy in its place: drawn as stills
  // (no encode in between), the frame before the lift and its first frame are
  // the same picture
  const [pre, at] = await filmStills({
    page: join(dir, "film", "index.html"),
    root: dir,
    chromePath: chrome!,
    at: [(liftAt - 1) / FPS, liftAt / FPS],
    outDir: join(dir, "lift-stills"),
    blur: false,
  });
  const [a, b] = [(await decode(pre!))[0]!, (await decode(at!))[0]!];
  let worst = 0;
  for (let i = 0; i < a.length; i++) worst = Math.max(worst, Math.abs(a[i]! - b[i]!));
  assert.ok(
    worst <= 8,
    `the lift's first frame is the page as it was (worst channel off by ${worst})`,
  );
  const moving = greenBox(frames[liftAt + 6]!, { x: 0, y: 0, width: W, height: 290 });
  assert.ok(moving && moving.width > want.width + 20, "then it grows");
  const full = frames[frames.length - 1]!;
  let g = 0;
  for (let i = 0; i < W * H * 3; i += 3) if (green(full, i)) g++;
  assert.ok(
    g > 0.6 * W * H,
    `carried to fill the frame (${((100 * g) / (W * H)).toFixed(0)}% green)`,
  );
});

test("the result shows on screen at its measured time, not the click's", { skip }, async () => {
  const frames = await rendered();
  const want = await pageBox();
  const card = { x: want.x + 8, y: want.y + 8, width: want.width - 16, height: want.height - 16 };
  const greenIn = (f: Buffer) => {
    let n = 0;
    for (let y = card.y; y < card.y + card.height; y++)
      for (let x = card.x; x < card.x + card.width; x++) if (green(f, (y * W + x) * 3)) n++;
    return n / (card.width * card.height);
  };
  const shownAt = frames.findIndex((f) => greenIn(f) > 0.5);
  assert.ok(shownAt > 0, "the card appears in the film");
  assert.ok(
    Math.abs(shownAt / FPS - result.t) <= 1.5 / FPS,
    `it appears at ${(shownAt / FPS).toFixed(3)} s; the result was measured at ${result.t.toFixed(3)} s`,
  );
  assert.ok(
    shownAt / FPS - click.t > 0.5,
    `and not at the click (${click.t.toFixed(3)} s): a cut on the click would miss it`,
  );
  assert.ok(
    greenIn(frames[Math.ceil(click.t * FPS) + 1]!) < 0.05,
    "just after the click: no card yet",
  );
});
