// When an action's result showed in the recording (not when it was input),
// and how a saved state lines up with the recording at its moment: the pure
// readings, then both through annotateCaptureLog on a real ffmpeg clip.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { CaptureLog } from "@open-take/compositor";
import { resolveFfmpeg } from "@open-take/compositor";
import { alignFrames, annotateCaptureLog, resultFrames } from "../src/frame-diff";

const W = 64;
const H = 32;
/** a frame with a 20×10 patch at (10, 10) of grey `v` on a light page */
const patch = (v: number) => {
  const f = new Uint8Array(W * H).fill(230);
  for (let y = 10; y < 20; y++) for (let x = 10; x < 30; x++) f[y * W + x] = v;
  return f;
};

test("resultFrames: the frame the change shows, and the one it is done from", () => {
  const frames = [
    ...Array.from({ length: 5 }, () => patch(230)), // nothing yet
    ...Array.from({ length: 3 }, () => patch(120)), // half way (a fade)
    ...Array.from({ length: 6 }, () => patch(20)), // as it ends up
  ];
  // an encoder refining the still page at the end: small moves only
  const last = frames[frames.length - 1]!;
  for (let i = 0; i < last.length; i += 7) last[i] = Math.min(255, last[i]! + 14);
  assert.deepEqual(resultFrames(frames), { at: 5, done: 8 });
  assert.equal(resultFrames(Array.from({ length: 4 }, () => patch(230))), null, "nothing changed");
  // a change that comes and goes is not done until it stays
  const flicker = [patch(230), patch(20), patch(230), patch(20), patch(20)];
  assert.deepEqual(resultFrames(flicker), { at: 1, done: 3 });
});

test("alignFrames: finds where the state sits in the recording, and what is left", () => {
  const w = 160;
  const h = 90;
  let seed = 7;
  const rnd = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  // blocky texture: shifts are unambiguous
  const state = new Uint8Array(w * h);
  const cells: number[] = Array.from({ length: 200 }, () => Math.floor(rnd() * 255));
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++)
      state[y * w + x] = cells[(Math.floor(y / 6) * 27 + Math.floor(x / 6)) % 200]!;
  // the recording shows the state 3 px right and 2 px up
  const video = new Uint8Array(w * h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const sx = Math.min(w - 1, Math.max(0, x - 3));
      const sy = Math.min(h - 1, Math.max(0, y + 2));
      video[y * w + x] = state[sy * w + sx]!;
    }
  const a = alignFrames(video, state, w, h);
  assert.ok(Math.abs(a.dx - 3) < 0.25 && Math.abs(a.dy + 2) < 0.25, `shift ${a.dx}, ${a.dy}`);
  assert.equal(a.meanDiff, 0);
  assert.equal(a.diffFrac, 0);
  const same = alignFrames(state, state, w, h);
  assert.deepEqual([same.dx, same.dy, same.meanDiff], [0, 0, 0]);
});

const ffmpeg = (bin: string, args: string[]) =>
  new Promise<void>((res, rej) => {
    const c = spawn(bin, ["-v", "error", "-y", ...args], {
      stdio: ["ignore", "ignore", "inherit"],
    });
    c.on("error", rej);
    c.on("close", (code) => (code === 0 ? res() : rej(new Error(`ffmpeg ${code}`))));
  });

test("annotateCaptureLog: a result that shows a quarter second after the click, and a state's seam", async (t) => {
  let bin: string;
  try {
    bin = await resolveFfmpeg();
  } catch {
    t.skip("no ffmpeg available");
    return;
  }
  const work = await mkdtemp(join(tmpdir(), "open-take-result-"));
  try {
    const clip = join(work, "capture.mp4");
    // a textured page (the seam needs something to line up); the click at
    // 1.0 s, its result — a dark box — on screen from 1.25 s
    const page = join(work, "page.png");
    await ffmpeg(bin, [
      "-f",
      "lavfi",
      "-i",
      "testsrc=s=640x360:d=1,hue=s=0",
      "-frames:v",
      "1",
      page,
    ]);
    await ffmpeg(bin, [
      "-loop",
      "1",
      "-framerate",
      "30",
      "-t",
      "3",
      "-i",
      page,
      "-vf",
      "drawbox=x=380:y=60:w=200:h=120:c=black:t=fill:enable='gte(t,1.25)'",
      "-pix_fmt",
      "yuv420p",
      clip,
    ]);
    // the state saved at 2.0 s: its screenshot is that frame, 4 px to the right
    const s1 = join(work, "states", "s1");
    await mkdir(s1, { recursive: true });
    await ffmpeg(bin, [
      "-ss",
      "2",
      "-i",
      clip,
      "-frames:v",
      "1",
      "-vf",
      "crop=636:360:0:0,pad=640:360:4:0",
      join(s1, "live.png"),
    ]);
    const log: CaptureLog = {
      video: { width: 640, height: 360, durationS: 3 },
      viewport: { w: 640, h: 360 },
      events: [{ kind: "click", x: 480, y: 120, box: { x: 440, y: 100, w: 80, h: 40 }, tMs: 1000 }],
      tEndMs: 3000,
      states: { dir: "states", items: [{ id: "s1", tMs: 2000, step: 0 }] },
    };
    const out = await annotateCaptureLog(log, clip, { ffmpegBin: bin });
    const r = out.events[0]!.result;
    assert.ok(r, "the result was found");
    // frames are 1/30 s apart: the first with the box is at 1.267 s
    assert.ok(Math.abs(r!.atMs - 1267) <= 34, `showed at ${r!.atMs} ms, not at the click`);
    assert.ok(r!.doneMs >= r!.atMs && r!.doneMs - r!.atMs <= 34, `done at ${r!.doneMs} ms`);
    assert.ok(Math.abs(r!.box.x - 380) <= 16 && Math.abs(r!.box.w - 200) <= 32, "its region");
    const seam = out.states!.items[0]!.seam;
    assert.ok(seam, "the seam was measured");
    // the state shows the page 4 px right of the recording: its point p is at p − 4 there
    assert.ok(
      Math.abs(seam!.dx + 4) < 0.5 && Math.abs(seam!.dy) < 0.5,
      `seam ${seam!.dx}, ${seam!.dy}`,
    );
    assert.ok(seam!.meanDiff < 4, `little left at that shift (${seam!.meanDiff})`);
    assert.equal(log.events[0]!.result, undefined, "the input log is untouched");
  } finally {
    await rm(work, { recursive: true, force: true });
  }
});

test("annotateCaptureLog: the control's own hover at the press is not the result; a change under way before it is not either", async (t) => {
  let bin: string;
  try {
    bin = await resolveFfmpeg();
  } catch {
    t.skip("no ffmpeg available");
    return;
  }
  const work = await mkdtemp(join(tmpdir(), "open-take-result-hover-"));
  try {
    const clip = join(work, "capture.mp4");
    // the clicked control (440,100 80×40) turns dark with a wide glow the
    // moment the pointer lands on it with the press, at 1.0 s, and stays so
    // (the pointer is parked there); the number the app works out — smaller
    // than that glow — changes at 1.6 s, elsewhere. A second click at 2.5 s
    // whose only change began a frame before it (120 fps: inside the few ms
    // before an input that the window starts at).
    await ffmpeg(bin, [
      "-f",
      "lavfi",
      "-i",
      "color=c=0xf0f0f0:s=640x360:r=120:d=3.4",
      "-vf",
      [
        "drawbox=x=400:y=70:w=160:h=100:c=black:t=fill:enable='gte(t,1.0)'",
        "drawbox=x=60:y=240:w=90:h=40:c=black:t=fill:enable='gte(t,1.6)'",
        "drawbox=x=300:y=260:w=120:h=60:c=black:t=fill:enable='gte(t,2.485)'",
      ].join(","),
      "-pix_fmt",
      "yuv420p",
      clip,
    ]);
    const log: CaptureLog = {
      video: { width: 640, height: 360, durationS: 3.4 },
      viewport: { w: 640, h: 360 },
      events: [
        { kind: "click", x: 480, y: 120, box: { x: 440, y: 100, w: 80, h: 40 }, tMs: 1000 },
        { kind: "click", x: 360, y: 290, box: { x: 340, y: 280, w: 40, h: 20 }, tMs: 2500 },
      ],
      tEndMs: 3400,
    };
    const out = await annotateCaptureLog(log, clip, { ffmpegBin: bin });
    const r = out.events[0]!.result;
    assert.ok(r, "the result was found");
    assert.ok(
      Math.abs(r!.atMs - 1600) <= 17,
      `the number, at ${r!.atMs} ms — not the hover at 1000`,
    );
    assert.ok(Math.abs(r!.box.x - 60) <= 16, `its region (${JSON.stringify(r!.box)})`);
    assert.equal(out.events[1]!.result, undefined, "a change that began before the input");
  } finally {
    await rm(work, { recursive: true, force: true });
  }
});
