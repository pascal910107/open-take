import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { resolveFfmpeg, resolveFfprobe } from "../src/ffmpeg";
import { renderLaunch } from "../src/launch-render";
import { launchTemplate } from "../src/launch-template";
import type { LaunchComposition } from "../src/launch-types";

const exec = promisify(execFile);
test("Chrome renders lossless VP9 footage and nested video first/last holds with correct color", {
  skip: !process.env.OPEN_TAKE_E2E_CHROME,
  timeout: 120_000,
}, async () => {
  const dir = await mkdtemp(join(tmpdir(), "launch-lossless-browser-"));
  try {
    const ffmpeg = await resolveFfmpeg(),
      source = join(dir, "source.mp4");
    await exec(ffmpeg, [
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      "color=red:s=320x180:r=12:d=0.5",
      "-f",
      "lavfi",
      "-i",
      "color=blue:s=320x180:r=12:d=0.5",
      "-filter_complex",
      "[0:v][1:v]concat=n=2:v=1:a=0",
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      source,
    ]);
    const composition: LaunchComposition = {
      ...launchTemplate(),
      output: { width: 320, height: 180, fps: 12 },
      scenes: [
        {
          id: "footage",
          type: "footage",
          asset: "source.mp4",
          durationS: 0.5,
          trimStartS: 0.5,
          frame: { inset: 0, radius: 0 },
          transition: { type: "cut" },
        },
        {
          id: "motion",
          type: "motion",
          durationS: 1.5,
          designSize: { width: 320, height: 180 },
          transition: { type: "cut" },
          layers: [
            {
              id: "group",
              type: "group",
              width: 280,
              height: 150,
              clip: true,
              animations: [
                {
                  property: "x",
                  keyframes: [
                    { atS: 0, value: -10 },
                    { atS: 0.25, value: 0 },
                  ],
                },
              ],
              children: [
                {
                  id: "video",
                  type: "video",
                  asset: "source.mp4",
                  width: 240,
                  height: 135,
                  trimStartS: 0.25,
                  startS: 0.25,
                  durationS: 0.5,
                  fit: "contain",
                },
              ],
            },
          ],
        },
      ],
    };
    const json = join(dir, "launch.json"),
      out = join(dir, "result.mp4");
    await writeFile(json, JSON.stringify(composition));
    await renderLaunch({
      composition,
      compositionPath: json,
      outPath: out,
      chromePath: process.env.OPEN_TAKE_E2E_CHROME!,
    });
    const metadata = JSON.parse(
      (
        await exec(await resolveFfprobe(), [
          "-v",
          "error",
          "-show_entries",
          "stream=codec_name,codec_type,width,height,color_space:format=duration",
          "-of",
          "json",
          out,
        ])
      ).stdout,
    );
    assert.deepEqual(metadata.streams, [
      { codec_name: "h264", codec_type: "video", width: 320, height: 180, color_space: "bt709" },
    ]);
    assert(Math.abs(Number(metadata.format.duration) - 2) < 1 / 12);
    // Footage starts from the blue trim; nested layer holds its trimmed red first frame,
    // plays into blue, then holds that last frame after its authored playback span.
    for (const [at, color] of [
      [0.1, "blue"],
      [0.6, "red"],
      [1.2, "blue"],
      [1.8, "blue"],
    ] as const) {
      const { stdout } = await exec(
        ffmpeg,
        [
          "-v",
          "error",
          "-ss",
          String(at),
          "-i",
          out,
          "-vf",
          "crop=2:2:160:90",
          "-frames:v",
          "1",
          "-f",
          "rawvideo",
          "-pix_fmt",
          "rgb24",
          "pipe:1",
        ],
        { encoding: "buffer" },
      );
      const wanted = color === "red" ? 0 : 2,
        other = color === "red" ? 2 : 0;
      assert(
        stdout[wanted]! > 220 && stdout[other]! < 25 && stdout[1]! < 25,
        `${at}s ${color}: ${[...stdout.subarray(0, 3)]}`,
      );
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
