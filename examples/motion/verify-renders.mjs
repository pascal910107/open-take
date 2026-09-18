// Metadata/source-integrity acceptance. Visual review is still required.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  launchDurationS,
  resolveFfmpeg,
  resolveFfprobe,
} from "../../packages/compositor/dist/index.js";

const out = resolve(dirname(fileURLToPath(import.meta.url)), "../../out/motion-demo");
const ffprobe = await resolveFfprobe();
const ffmpeg = await resolveFfmpeg();
const hashes = JSON.parse(await readFile(join(out, "source-hashes.json"), "utf8"));
for (const [file, expected] of Object.entries(hashes))
  assert.equal(
    createHash("sha256")
      .update(await readFile(join(out, file)))
      .digest("hex"),
    expected,
    `source changed: ${file}`,
  );

function run(binary, args) {
  const result = spawnSync(binary, args, {
    encoding: "utf8",
    timeout: 60_000,
    maxBuffer: 8 * 1024 * 1024,
  });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  return result.stdout;
}
const proofs = [];
for (const [name, draft] of [
  ["commerce", false],
  ["analytics", false],
  ["board", false],
  ["portrait", false],
  ["motion-off", true],
  ["recipe-landscape", true],
  ["recipe-portrait", true],
  ["recipe-square", true],
]) {
  const comp = JSON.parse(await readFile(join(out, `${name}.json`), "utf8"));
  const file = join(out, `${name}${name.startsWith("recipe-") ? ".draft" : ""}.mp4`);
  const data = JSON.parse(
    run(ffprobe, ["-v", "error", "-show_streams", "-show_format", "-of", "json", file]),
  );
  const video = data.streams.find((s) => s.codec_type === "video");
  const factor = draft ? Math.min(1, 960 / Math.max(comp.output.width, comp.output.height)) : 1;
  const even = (n) => Math.max(2, Math.round(n / 2) * 2);
  assert.equal(video.width, even(comp.output.width * factor), name);
  assert.equal(video.height, even(comp.output.height * factor), name);
  assert.equal(video.codec_name, "h264", name);
  assert.equal(video.pix_fmt, "yuv420p", name);
  assert.equal(video.color_space, "bt709", name);
  assert.equal(
    data.streams.some((s) => s.codec_type === "audio"),
    false,
    `${name} should be silent`,
  );
  const duration = Number(video.duration ?? data.format.duration);
  assert(
    Math.abs(duration - launchDurationS(comp)) <= 1 / comp.output.fps + 0.001,
    `${name}: duration mismatch`,
  );
  const frames = run(ffmpeg, [
    "-v",
    "error",
    "-i",
    file,
    "-vf",
    "fps=2,scale=320:-2",
    "-f",
    "framemd5",
    "-",
  ])
    .split("\n")
    .filter((l) => l && !l.startsWith("#"))
    .map((l) => l.split(",").at(-1).trim());
  const distinct = new Set(frames).size;
  let staticMeanDifference;
  if (name === "motion-off") {
    // Lossy H.264 can differ by a luma unit at a few pixels across GOPs.
    // Compare decoded pixels with a tight tolerance instead of byte hashes.
    const pixels = spawnSync(
      ffmpeg,
      ["-v", "error", "-i", file, "-vf", "fps=2,scale=320:180,format=gray", "-f", "rawvideo", "-"],
      { timeout: 60_000, maxBuffer: 8 * 1024 * 1024 },
    );
    assert.equal(pixels.status, 0, pixels.stderr.toString());
    const size = 320 * 180,
      first = pixels.stdout.subarray(0, size);
    staticMeanDifference = 0;
    let peak = 0;
    for (let offset = size; offset < pixels.stdout.length; offset += size) {
      let total = 0;
      for (let p = 0; p < size; p++) {
        const difference = Math.abs(first[p] - pixels.stdout[offset + p]);
        total += difference;
        peak = Math.max(peak, difference);
      }
      staticMeanDifference = Math.max(staticMeanDifference, total / size);
    }
    assert(staticMeanDifference <= 0.01 && peak <= 2, "motion off shows visible movement");
  } else assert(distinct > 1, `${name}: no visible change detected`);
  proofs.push({
    name,
    file,
    width: video.width,
    height: video.height,
    duration,
    sampledFrames: frames.length,
    distinctFrameHashes: distinct,
    ...(staticMeanDifference !== undefined ? { staticMeanDifference } : {}),
  });
}
const report = { unchangedSourceImages: Object.keys(hashes).length, proofs };
await writeFile(join(out, "verification.json"), JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify(report, null, 2));
