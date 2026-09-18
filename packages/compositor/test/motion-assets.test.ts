import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFile,
  link,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  truncate,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { promisify } from "node:util";
import { resolveFfmpeg, resolveFfprobe } from "../src/ffmpeg";
import {
  assertLaunchOutputSafe,
  prepareMotionImages,
  prepareMotionVideos,
  validateLaunchAssets,
} from "../src/launch-render";
import { launchTemplate } from "../src/launch-template";
import type { LaunchComposition } from "../src/launch-types";
import type { MotionImageLayer, MotionVideoLayer } from "../src/motion-types";

const exec = promisify(execFile);
let dir: string, ffmpeg: string, ffprobe: string;
const image = (asset: string): MotionImageLayer => ({
  id: "image",
  type: "image",
  asset,
  width: 40,
  height: 20,
});
function comp(layer: MotionImageLayer | MotionVideoLayer): LaunchComposition {
  return {
    ...launchTemplate(),
    scenes: [
      {
        id: "motion",
        type: "motion",
        durationS: 2,
        layers: [
          { id: "clip", type: "group", width: 600, height: 400, clip: true, children: [layer] },
        ],
      },
    ],
  };
}
before(async () => {
  dir = await mkdtemp(join(tmpdir(), "motion images with spaces "));
  ffmpeg = await resolveFfmpeg();
  ffprobe = await resolveFfprobe();
  await exec(ffmpeg, [
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "color=c=red:s=20x20",
    "-f",
    "lavfi",
    "-i",
    "color=c=blue:s=20x20",
    "-filter_complex",
    "hstack=inputs=2",
    "-frames:v",
    "1",
    "-update",
    "1",
    join(dir, "source.png"),
  ]);
  for (const ext of ["jpg"])
    await exec(ffmpeg, [
      "-v",
      "error",
      "-i",
      join(dir, "source.png"),
      "-frames:v",
      "1",
      join(dir, `source.${ext}`),
    ]);
  // Owned solid-red 40x20 lossless WebP: decode coverage needs no optional WebP encoder.
  await writeFile(
    join(dir, "source.webp"),
    Buffer.from("UklGRhwAAABXRUJQVlA4TA8AAAAvJ8AEAAcQ/Y/+ByKi/wEA", "base64"),
  );
  await exec(ffmpeg, [
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "color=c=red:s=40x20:d=1",
    "-c:v",
    "libx264",
    join(dir, "video.mp4"),
  ]);
  await copyFile(join(dir, "video.mp4"), join(dir, "disguised.png"));
  await writeFile(
    join(dir, "broken.png"),
    (await readFile(join(dir, "source.png"))).subarray(0, 32),
  );
  await writeFile(join(dir, "too-large.png"), "");
  await truncate(join(dir, "too-large.png"), 64 * 1024 * 1024 + 1);
});
after(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});

test("real PNG/JPEG/WebP sources validate and crop dimensions use source pixels", async () => {
  for (const ext of ["png", "jpg", "webp"])
    assert.deepEqual(
      await validateLaunchAssets(comp(image(`source.${ext}`)), join(dir, "launch.json")),
      [],
    );
  const layer = image("source.png");
  layer.crop = { x: 30, y: 0, width: 20, height: 20 };
  assert(
    (await validateLaunchAssets(comp(layer), join(dir, "launch.json"))).some(
      (x) => x.path === "scenes[0].layers[0].children[0].crop" && x.message.includes("40x20"),
    ),
  );
});

test("wrong-kind, corrupt, oversized and remote images fail before rendering", async () => {
  for (const asset of [
    "disguised.png",
    "broken.png",
    "too-large.png",
    "https://example.com/image.png",
  ]) {
    const issues = await validateLaunchAssets(comp(image(asset)), join(dir, "launch.json"));
    assert(
      issues.some((x) => x.path === "scenes[0].layers[0].children[0].asset"),
      asset,
    );
  }
});

test("real crop preparation normalizes pixels, removes only cloned crop and preserves source bytes", async () => {
  const source = join(dir, "source.png"),
    before = createHash("sha256")
      .update(await readFile(source))
      .digest("hex");
  const layer = image("source.png");
  layer.crop = { x: 20, y: 0, width: 20, height: 20 };
  const authored = comp(layer),
    clone = structuredClone(authored),
    assets = join(dir, "assets");
  await mkdir(assets);
  await prepareMotionImages(clone, join(dir, "launch.json"), assets);
  const scene = clone.scenes[0]!;
  assert(scene.type === "motion");
  const group = scene.layers[0]!;
  assert(group.type === "group");
  const prepared = group.children[0]!;
  assert(prepared.type === "image");
  assert.equal(prepared.asset, "/assets/motion-image-0.png");
  assert.equal(prepared.crop, undefined);
  assert.equal(layer.asset, "source.png");
  assert.deepEqual(layer.crop, { x: 20, y: 0, width: 20, height: 20 });
  const out = join(assets, "motion-image-0.png");
  const { stdout } = await exec(ffprobe, [
    "-v",
    "error",
    "-show_entries",
    "stream=width,height",
    "-of",
    "json",
    out,
  ]);
  assert.deepEqual(JSON.parse(stdout).streams[0], { width: 20, height: 20 });
  const pixels = await exec(
    ffmpeg,
    ["-v", "error", "-i", out, "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"],
    { encoding: "buffer" },
  );
  assert(
    pixels.stdout[2]! > 200 && pixels.stdout[0]! < 20,
    "crop must contain actual blue source pixels",
  );
  assert.equal(
    createHash("sha256")
      .update(await readFile(source))
      .digest("hex"),
    before,
  );
});

test("nested motion images participate in direct and hardlink output alias protection", async () => {
  const c = comp(image("source.png"));
  await link(join(dir, "source.png"), join(dir, "alias.mp4"));
  for (const name of ["source.png", "alias.mp4"])
    assert.throws(
      () => assertLaunchOutputSafe(c, join(dir, "launch.json"), join(dir, name)),
      /must not overwrite/,
    );
});

test("density warnings account for crop, fit, output scale, exact static parent transforms and motion bounds", async () => {
  const layer = image("source.png");
  const c = comp(layer),
    scene = c.scenes[0]!;
  assert(scene.type === "motion");
  scene.designSize = { width: 960, height: 540 };
  let issues = await validateLaunchAssets(c, join(dir, "launch.json"));
  assert(
    issues.some(
      (x) =>
        x.severity === "warn" &&
        x.path === "scenes[0].layers[0].children[0].asset" &&
        x.message.includes("2.00x"),
    ),
  );
  scene.designSize = { width: 1920, height: 1080 };
  layer.crop = { x: 0, y: 0, width: 20, height: 20 };
  layer.fit = "contain";
  assert.deepEqual(await validateLaunchAssets(c, join(dir, "launch.json")), []);
  layer.fit = "cover";
  assert(
    (await validateLaunchAssets(c, join(dir, "launch.json"))).some((x) =>
      x.message.includes("2.00x"),
    ),
  );
  delete layer.crop;
  const group = scene.layers[0]!;
  group.scaleX = 2;
  group.scaleY = 1;
  layer.scaleX = 0.5;
  assert.deepEqual(
    await validateLaunchAssets(c, join(dir, "launch.json")),
    [],
    "static opposing scales cancel exactly",
  );
  layer.rotation = 90;
  assert(
    (await validateLaunchAssets(c, join(dir, "launch.json"))).some((x) =>
      x.message.includes("2.00x"),
    ),
    "rotated anisotropic scales do not cancel",
  );
  group.scaleX = 1;
  layer.scaleX = 1;
  layer.rotation = 0;
  group.animations = [
    {
      property: "scaleX",
      keyframes: [
        { atS: 0, value: 1 },
        { atS: 1, value: 3 },
      ],
    },
  ];
  issues = await validateLaunchAssets(c, join(dir, "launch.json"));
  assert(issues.some((x) => x.message.includes("3.00x") && x.message.includes("conservative")));
  scene.motion = "off";
  assert.deepEqual(await validateLaunchAssets(c, join(dir, "launch.json")), []);
});

test("nested videos validate source spans, report density, stage independent silent clips and protect aliases", async () => {
  const layer: MotionVideoLayer = {
    id: "video",
    type: "video",
    asset: "video.mp4",
    width: 80,
    height: 40,
    trimStartS: 0.2,
    startS: 0.5,
    durationS: 0.5,
  };
  const c = comp(layer),
    json = join(dir, "launch.json");
  const issues = await validateLaunchAssets(c, json);
  assert(
    issues.some(
      (x) => x.severity === "warn" && x.path.endsWith(".asset") && x.message.includes("2.00x"),
    ),
  );
  assert(!issues.some((x) => x.severity === "error"));
  assert.throws(
    () => assertLaunchOutputSafe(c, json, join(dir, "video.mp4")),
    /must not overwrite/,
  );
  await link(join(dir, "video.mp4"), join(dir, "video-alias.mp4"));
  assert.throws(
    () => assertLaunchOutputSafe(c, json, join(dir, "video-alias.mp4")),
    /must not overwrite/,
  );
  const clone = structuredClone(c),
    assets = join(dir, "video-assets");
  await mkdir(assets);
  await prepareMotionVideos(clone, json, assets);
  const scene = clone.scenes[0]!;
  assert(scene.type === "motion" && scene.layers[0]?.type === "group");
  const staged = scene.layers[0].children[0]!;
  assert(staged.type === "video");
  assert.equal(staged.asset, "/assets/motion-video-0.webm");
  assert.equal(staged.trimStartS, 0);
  assert.equal(staged.startS, 0.5);
  assert.equal(staged.durationS, 0.5);
  assert.equal(layer.trimStartS, 0.2);
  const probe = JSON.parse(
    (
      await exec(ffprobe, [
        "-v",
        "error",
        "-show_entries",
        "stream=codec_name,codec_type,width,height",
        "-of",
        "json",
        join(assets, "motion-video-0.webm"),
      ])
    ).stdout,
  );
  assert.deepEqual(probe.streams, [
    { codec_name: "vp9", codec_type: "video", width: 40, height: 20 },
  ]);
  layer.trimStartS = 0.7;
  assert(
    (await validateLaunchAssets(c, json)).some(
      (x) => x.severity === "error" && x.path.endsWith(".asset") && x.message.includes("needs"),
    ),
  );
  layer.asset = "source.png";
  assert((await validateLaunchAssets(c, json)).some((x) => x.severity === "error"));
});
