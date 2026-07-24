// Tier-2 frame-diff: pure diff units + real-ffmpeg integrations (a lavfi clip
// where a box appears mid-video → the annotator must find it) + the
// never-fail contract's failure paths.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { resolveFfmpeg } from "@open-take/compositor";
import type { CaptureLog } from "@open-take/compositor";
import { annotateCaptureLog, diffFrames } from "../src/frame-diff";

const frame = (w: number, h: number, fill: number): Uint8Array => new Uint8Array(w * h).fill(fill);
const paint = (
  f: Uint8Array,
  w: number,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  v: number,
) => {
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) f[y * w + x] = v;
};

test("diffFrames: a solid changed region → tight box + its cell coverage", () => {
  const w = 320;
  const h = 192;
  const a = frame(w, h, 230);
  const b = frame(w, h, 230);
  paint(b, w, 96, 64, 192, 128, 20);
  const d = diffFrames(a, b, w, h);
  assert.ok(d.box, "region found");
  // cell-quantised (16px): the box may swell one cell outward, never shrink
  assert.ok(d.box!.x <= 96 && d.box!.x >= 96 - 16, `x ${d.box!.x}`);
  assert.ok(d.box!.y <= 64 && d.box!.y >= 64 - 16, `y ${d.box!.y}`);
  assert.ok(d.box!.x + d.box!.w >= 192 && d.box!.x + d.box!.w <= 192 + 16, "right edge");
  assert.ok(d.box!.y + d.box!.h >= 128 && d.box!.y + d.box!.h <= 128 + 16, "bottom edge");
  const cells = (96 / 16) * (64 / 16);
  const total = (w / 16) * (h / 16);
  assert.ok(Math.abs(d.coverage - cells / total) < 0.02, `coverage ${d.coverage}`);
});

test("diffFrames: BRIGHTENING content (dark theme) is detected too", () => {
  const w = 320;
  const h = 192;
  const a = frame(w, h, 25); // dark app
  const b = frame(w, h, 25);
  paint(b, w, 96, 64, 192, 128, 235); // light panel appears
  const d = diffFrames(a, b, w, h);
  assert.ok(d.box, "brightening region found (|Δ| must be symmetric)");
  assert.ok(Math.abs(d.box!.x - 96) <= 16 && Math.abs(d.box!.y - 64) <= 16, "placed right");
});

test("diffFrames: thin isolated specks (caret / cursor sliver) are ignored", () => {
  const w = 320;
  const h = 192;
  const a = frame(w, h, 230);
  const b = frame(w, h, 230);
  // caret-like slivers: enough pixels to make a "changed" cell, far apart,
  // nowhere near half a cell — plus sub-threshold noise everywhere
  paint(b, w, 36, 32, 40, 42, 0); // 4x10 in one cell
  paint(b, w, 290, 162, 294, 172, 0);
  for (let i = 0; i < w * h; i += 7) b[i] = 230 + ((i % 3) - 1) * 6; // |Δ| ≤ 6
  const d = diffFrames(a, b, w, h);
  assert.equal(d.box, undefined, "specks produce no region");
  assert.equal(d.coverage, 0);
});

test("diffFrames: a SINGLE-cell strong payoff (badge counter) is kept", () => {
  const w = 320;
  const h = 192;
  const a = frame(w, h, 230);
  const b = frame(w, h, 230);
  paint(b, w, 33, 33, 47, 47, 10); // 14x14 = 196px ≥ half a cell, inside cell (2,2)
  const d = diffFrames(a, b, w, h);
  assert.ok(d.box, "strong isolated cell kept");
  assert.equal(d.box!.x, 32);
  assert.equal(d.box!.y, 32);
  assert.equal(d.box!.w, 16);
  assert.equal(d.box!.h, 16);
});

test("diffFrames: ambient motion (third frame) is masked out of the diff", () => {
  const w = 320;
  const h = 192;
  const pre = frame(w, h, 230);
  const post = frame(w, h, 230);
  const amb = frame(w, h, 230);
  // hero region keeps animating: differs pre→post AND post→ambient
  paint(post, w, 0, 0, 160, 96, 90);
  paint(amb, w, 0, 0, 160, 96, 170);
  // the real payoff: appears by post, STABLE at ambient
  paint(post, w, 208, 128, 304, 176, 20);
  paint(amb, w, 208, 128, 304, 176, 20);
  const masked = diffFrames(pre, post, w, h, amb);
  assert.ok(masked.box, "payoff found");
  assert.ok(masked.box!.x >= 192, `hero excluded (x ${masked.box!.x})`);
  assert.ok(masked.coverage < 0.1, `coverage only counts the payoff (${masked.coverage})`);
  // without the ambient frame the hero poisons the union — this is the point
  const poisoned = diffFrames(pre, post, w, h);
  assert.ok(poisoned.box!.x === 0, "control: unmasked union includes the hero");
});

test("diffFrames: box clamps to true frame bounds when w/h aren't cell multiples", () => {
  const w = 330;
  const h = 197;
  const a = frame(w, h, 230);
  const b = frame(w, h, 230);
  paint(b, w, 300, 170, 330, 197, 20); // touches the bottom-right corner
  const d = diffFrames(a, b, w, h);
  assert.ok(d.box, "corner region found");
  assert.equal(d.box!.x + d.box!.w, w, "right edge clamped to the frame");
  assert.equal(d.box!.y + d.box!.h, h, "bottom edge clamped to the frame");
});

const LOG: CaptureLog = {
  video: { width: 640, height: 360, durationS: 3 },
  viewport: { w: 640, h: 360 },
  events: [{ kind: "click", x: 200, y: 140, tMs: 1450 }],
  tEndMs: 3000,
};

test("annotateCaptureLog: never-fail — missing video / broken ffmpeg / zero dims", async () => {
  const missing = await annotateCaptureLog(LOG, "/nonexistent/clip.mp4");
  assert.equal(missing.events[0]!.changeCoverage, undefined, "missing video → unannotated");
  const badBin = await annotateCaptureLog(LOG, "/nonexistent/clip.mp4", {
    ffmpegBin: "/nonexistent/ffmpeg",
  });
  assert.equal(badBin.events[0]!.changeCoverage, undefined, "spawn ENOENT → unannotated");
  const zeroDims = await annotateCaptureLog(
    { ...LOG, video: { width: 0, height: 0 } },
    "/nonexistent/clip.mp4",
  );
  assert.equal(zeroDims.events[0]!.changeCoverage, undefined, "zero dims → unannotated");
});

test("annotateCaptureLog: finds a box appearing mid-video (real ffmpeg)", async (t) => {
  let bin: string;
  try {
    bin = await resolveFfmpeg();
  } catch {
    t.skip("no ffmpeg available");
    return;
  }
  const work = await mkdtemp(join(tmpdir(), "open-take-fd-"));
  const clip = join(work, "clip.mp4");
  try {
    // white 640x360; a black 200x120 box at (100,80) appears at t=1.5s.
    // event tMs=1450: before=1.42s (blank), after=1.95s (box), ambient=2.2s
    // (stable — the box must survive the ambient mask).
    await new Promise<void>((res, rej) => {
      const c = spawn(
        bin,
        [
          "-v",
          "error",
          "-y",
          "-f",
          "lavfi",
          "-i",
          "color=c=white:s=640x360:r=30:d=3,drawbox=x=100:y=80:w=200:h=120:c=black:t=fill:enable='gte(t,1.5)'",
          "-pix_fmt",
          "yuv420p",
          clip,
        ],
        { stdio: ["ignore", "ignore", "inherit"] },
      );
      c.on("error", rej);
      c.on("close", (code) => (code === 0 ? res() : rej(new Error(`ffmpeg ${code}`))));
    });

    const out = await annotateCaptureLog(LOG, clip, { ffmpegBin: bin });
    const e = out.events[0]!;
    assert.ok(e.changeCoverage != null && e.changeCoverage > 0.03, `coverage ${e.changeCoverage}`);
    assert.ok(e.changeCoverage! < 0.3, "local change, not a repaint");
    const b = e.effectBox;
    assert.ok(b, "effectBox found");
    const tol = 24; // cell-quantised
    assert.ok(Math.abs(b!.x - 100) <= tol, `x ${b!.x}`);
    assert.ok(Math.abs(b!.y - 80) <= tol, `y ${b!.y}`);
    assert.ok(Math.abs(b!.w - 200) <= tol * 2, `w ${b!.w}`);
    assert.ok(Math.abs(b!.h - 120) <= tol * 2, `h ${b!.h}`);
    // the input log was not mutated
    assert.equal(LOG.events[0]!.effectBox, undefined, "input untouched");
  } finally {
    await rm(work, { recursive: true, force: true });
  }
});
