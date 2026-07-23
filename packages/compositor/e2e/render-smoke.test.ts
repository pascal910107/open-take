import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { resolveFfmpeg, resolveFfprobe } from "../src/ffmpeg.js";
import { planComposition } from "../src/plan.js";
import { renderTake } from "../src/render.js";
import type { CaptureLog } from "../src/types.js";

function run(command: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(`${command} exited ${code}: ${stderr}`));
    });
  });
}

test(
  "a synthetic capture renders into a playable half-second MP4",
  { timeout: 120_000 },
  async () => {
    const chromePath = process.env.OPEN_TAKE_E2E_CHROME;
    assert.ok(chromePath, "OPEN_TAKE_E2E_CHROME must point to a Chrome binary");
    await access(chromePath);

    const work = await mkdtemp(join(tmpdir(), "open-take-render-smoke-"));
    const capturePath = join(work, "capture.mp4");
    const outputPath = join(work, "result.mp4");
    try {
      await run(await resolveFfmpeg(), [
        "-y",
        "-loglevel",
        "error",
        "-f",
        "lavfi",
        "-i",
        "color=c=0x24314f:s=320x180:r=30",
        "-t",
        "1",
        "-c:v",
        "libx264",
        "-pix_fmt",
        "yuv420p",
        capturePath,
      ]);

      const log: CaptureLog = {
        video: { width: 320, height: 180, fps: 30 },
        viewport: { w: 320, h: 180 },
        start: { x: 40, y: 140 },
        events: [{ kind: "click", x: 160, y: 90, tMs: 250 }],
        tEndMs: 900,
      };
      const composition = planComposition(log);
      composition.motionBlur = { samples: 1, shutter: 0 };

      await renderTake({
        composition,
        videoPath: capturePath,
        outPath: outputPath,
        rangeSec: [0, 0.5],
        writeCompositionSibling: false,
        chromePath,
      });

      assert.ok((await stat(outputPath)).size > 500, "rendered MP4 is non-empty");
      const header = await readFile(outputPath);
      assert.equal(header.subarray(4, 8).toString("ascii"), "ftyp", "output has an MP4 header");

      const duration = Number(
        (
          await run(await resolveFfprobe(), [
            "-v",
            "error",
            "-show_entries",
            "format=duration",
            "-of",
            "default=noprint_wrappers=1:nokey=1",
            outputPath,
          ])
        ).trim(),
      );
      assert.ok(duration >= 0.45 && duration <= 0.6, `duration is about 0.5s (got ${duration}s)`);
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  },
);
