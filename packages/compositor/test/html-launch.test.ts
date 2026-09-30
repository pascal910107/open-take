// A film made only of motion scenes renders through the HTML renderer end to
// end: page staged, frames sampled along the shutter, averaged, delivered.
// Pixels prove the timeline arrived: a card that slides, and a wipe that
// covers the frame when it should. Needs Chrome for Testing; skips without it.

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { promisify } from "node:util";
import { resolveFfmpeg } from "../src/ffmpeg";
import { renderLaunch } from "../src/launch-render";
import type { LaunchComposition } from "../src/launch-types";
import { findChrome } from "./fixtures/find-chrome";

const exec = promisify(execFile);
const chrome = findChrome();
let dir: string;
before(async () => {
  dir = await mkdtemp(join(tmpdir(), "html launch "));
});
after(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});

const W = 320,
  H = 180;
const film = (motionBlur: false | undefined): LaunchComposition => ({
  version: 1,
  output: { width: W, height: H, fps: 30, ...(motionBlur === false ? { motionBlur } : {}) },
  theme: {
    canvas: "#f6f3ec",
    ink: "#101112",
    surface: "#f6f3ec",
    accent: "#de3b3d",
    dark: "#101112",
    fontFamily: "Helvetica Neue, sans-serif",
  },
  scenes: [
    {
      id: "m",
      type: "motion",
      durationS: 1,
      layers: [
        { id: "paper", type: "rect", width: 1920, height: 1080, fill: "#f6f3ec" },
        {
          id: "card",
          type: "rect",
          width: 300,
          height: 300,
          fill: "#de3b3d",
          animations: [
            {
              property: "x",
              keyframes: [
                { atS: 0, value: -600 },
                { atS: 0.4, value: 600, easing: "glide" },
              ],
            },
          ],
        },
        {
          id: "words",
          type: "text",
          text: "Moves word by word",
          y: -380,
          width: 1600,
          height: 200,
          fontSize: 90,
          units: { by: "word", moves: [{ move: "rise", atS: 0 }] },
        },
        { id: "wipe", type: "wipe", atS: 0.55, durationS: 0.2, holdS: 0.1, revealS: 0.1 },
      ],
    },
  ],
});

async function frames(path: string): Promise<Buffer[]> {
  const { stdout } = await exec(
    await resolveFfmpeg(),
    ["-v", "error", "-i", path, "-f", "rawvideo", "-pix_fmt", "rgb24", "-"],
    { encoding: "buffer", maxBuffer: 256 * 1024 * 1024 },
  );
  const size = W * H * 3;
  const buf = stdout as Buffer;
  return Array.from({ length: buf.length / size }, (_, i) =>
    buf.subarray(i * size, (i + 1) * size),
  );
}
const pixel = (f: Buffer, x: number, y: number) => {
  const i = (Math.round(y) * W + Math.round(x)) * 3;
  return [f[i]!, f[i + 1]!, f[i + 2]!];
};
const red = ([r, g, b]: number[]) => r! > 180 && g! < 110 && b! < 110;
const dark = ([r, g, b]: number[]) => r! < 60 && g! < 60 && b! < 60;

for (const motionBlur of [false, undefined] as const)
  test(`a motion-only film renders through the HTML renderer (${motionBlur === false ? "no blur" : "motion blur"})`, {
    skip: chrome ? false : "no Chrome for Testing",
    timeout: 180_000,
  }, async () => {
    const composition = film(motionBlur);
    const compositionPath = join(dir, `film-${motionBlur ?? "blur"}.json`);
    await writeFile(compositionPath, JSON.stringify(composition));
    const out = join(dir, `film-${motionBlur ?? "blur"}.mp4`);
    const result = await renderLaunch({
      composition,
      compositionPath,
      outPath: out,
      chromePath: chrome!,
    });
    assert.equal(result.durationS, 1);
    const fs = await frames(out);
    assert.equal(fs.length, 30);
    // design px → output px: 320/1920 = 1/6, centred
    const at = (x: number, y: number) => [W / 2 + x / 6, H / 2 + y / 6] as const;
    // colours survive the trip: the paper stays cream (#f6f3ec), not white —
    // full-range screenshots read as limited range would lift it to ~254
    const paper = pixel(fs[0]!, ...at(0, 420));
    for (const [i, want] of [246, 243, 236].entries())
      assert.ok(Math.abs(paper[i]! - want) <= 8, `paper ${paper} ≈ 246,243,236`);
    assert.ok(red(pixel(fs[0]!, ...at(-600, 0))), "the card starts on the left");
    assert.ok(!red(pixel(fs[0]!, ...at(600, 0))));
    assert.ok(red(pixel(fs[15]!, ...at(600, 0))), "it has landed on the right by 0.5 s");
    // the wipe covers the frame between 0.75 s and 0.85 s
    assert.ok(
      dark(pixel(fs[24]!, ...at(0, 0))) && dark(pixel(fs[24]!, ...at(-800, -400))),
      "covered",
    );
    assert.ok(!dark(pixel(fs[29]!, ...at(0, 0))), "and cleared again");
  });
