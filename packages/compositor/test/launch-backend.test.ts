import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { link, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { promisify } from "node:util";
import { resolveFfmpeg, resolveFfprobe } from "../src/ffmpeg";
import {
  assertLaunchOutputSafe,
  deliverLaunchMedia,
  prepareLaunchVideo,
  publishLaunchMedia,
  renderLaunch,
  validateLaunchAssets,
} from "../src/launch-render";
import { launchTemplate } from "../src/launch-template";
import type { LaunchComposition } from "../src/launch-types";
import { validateLaunchComposition } from "../src/launch-validate";

const exec = promisify(execFile);
let dir: string, ffmpeg: string, ffprobe: string;
function comp(durationS = 2): LaunchComposition {
  return {
    ...launchTemplate(),
    output: { width: 160, height: 90, fps: 30 },
    scenes: [{ id: "title", type: "title", durationS, lines: ["Launch"], motion: "off" }],
  };
}
before(async () => {
  dir = await mkdtemp(join(tmpdir(), "launch backend with spaces "));
  ffmpeg = await resolveFfmpeg();
  ffprobe = await resolveFfprobe();
  await exec(ffmpeg, [
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "color=c=red:s=160x90:r=30:d=2",
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    join(dir, "video.mp4"),
  ]);
  await exec(ffmpeg, [
    "-v",
    "error",
    "-i",
    join(dir, "video.mp4"),
    "-t",
    "1",
    "-c:v",
    "libx264",
    join(dir, "one-second.mp4"),
  ]);
  await exec(ffmpeg, [
    "-v",
    "error",
    "-i",
    join(dir, "video.mp4"),
    "-frames:v",
    "59",
    "-c:v",
    "libx264",
    join(dir, "one-frame-short.mp4"),
  ]);
  await exec(ffmpeg, [
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=440:sample_rate=48000:duration=0.25",
    join(dir, "tone.wav"),
  ]);
  await writeFile(join(dir, "broken.mp4"), "This is not an MP4 file.");
});
after(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});

test("untrusted JSON reports nested paths for malformed containers and scalar fields", () => {
  for (const value of [null, 3, true, "x", [], {}, { scenes: null, audio: [null] }])
    assert.doesNotThrow(() => validateLaunchComposition(value));
  const invalid = {
    ...comp(),
    theme: { fontFamily: 8 },
    scenes: [
      null,
      {
        id: 7,
        type: "ui-morph",
        states: [null, 3, { label: 4, prompt: {}, icon: "spark" }],
        panel: false,
      },
    ],
    audio: [{ id: 4, kind: "music", asset: {}, afterSceneId: 3 }],
  };
  const issues = validateLaunchComposition(invalid);
  for (const path of [
    "theme.fontFamily",
    "scenes[0]",
    "scenes[1].id",
    "scenes[1].states[0]",
    "scenes[1].states[2].prompt",
    "scenes[1].panel",
    "audio[0].asset",
    "audio[0].afterSceneId",
  ])
    assert(
      issues.some((x) => x.path === path),
      path,
    );
  for (const audio of [null, 4, {}, "wrong"])
    assert(validateLaunchComposition({ ...comp(), audio }).some((x) => x.path === "audio"));
});

test("invalid colors, impossible geometry, and unreadable copy fail before rendering", () => {
  const c = launchTemplate(),
    ui = c.scenes.find((x) => x.type === "ui-morph")!;
  ui.colors = { accent: "rgba(256,0,0,1)", canvas: "rgb(0,0,0,0.5)" };
  ui.states[1]!.panelWidth = 99999;
  ui.states[2]!.label = "標籤".repeat(10);
  ui.states[3]!.prompt = "巨".repeat(90);
  const issues = validateLaunchComposition(c);
  for (const path of [
    "scenes[2].colors.accent",
    "scenes[2].colors.canvas",
    "scenes[2].states[1].panelWidth",
    "scenes[2].states[2].label",
    "scenes[2].states[3].prompt",
  ])
    assert(
      issues.some((x) => x.path === path),
      path,
    );
  assert.deepEqual(validateLaunchComposition(launchTemplate()), []);
});

test("audio windows include implicit duration, fades, booleans, offsets and IDs", () => {
  const c = comp();
  c.audio = [
    { id: "same", kind: "music", asset: "tone.wav", atS: 1.8, fadeOutS: 0.4 },
    { id: "same", kind: "sfx", asset: "tone.wav", atS: 2, durationS: 0, loop: true },
    { id: "offset", kind: "sfx", asset: "tone.wav", atS: 0, offsetS: 0.5, gain: Infinity },
  ];
  const issues = validateLaunchComposition(c);
  for (const path of [
    "audio[0].fadeOutS",
    "audio[1].id",
    "audio[1].atS",
    "audio[1].durationS",
    "audio[1].loop",
    "audio[2].offsetS",
    "audio[2].gain",
  ])
    assert(
      issues.some((x) => x.path === path),
      path,
    );
  assert.doesNotThrow(() => validateLaunchComposition({ ...c, scenes: [null] }));
});

test("real media checks detect missing streams, short implicit audio and corrupt inputs", async () => {
  const c = comp(),
    json = join(dir, "launch.json");
  c.scenes = [{ id: "bad", type: "footage", durationS: 0.2, asset: "tone.wav" }];
  assert(
    (await validateLaunchAssets(c, json)).some(
      (x) => x.path === "scenes[0].asset" && x.message.includes("no video stream"),
    ),
  );
  c.scenes = comp().scenes;
  c.audio = [{ id: "short", kind: "music", atS: 0, asset: "tone.wav" }];
  assert(
    (await validateLaunchAssets(c, json)).some(
      (x) => x.path === "audio[0].asset" && x.message.includes("needs 2.000s"),
    ),
  );
  c.audio[0]!.loop = true;
  assert.deepEqual(await validateLaunchAssets(c, json), []);
  c.audio[0]!.trimStartS = 0.3;
  assert((await validateLaunchAssets(c, json)).some((x) => x.path === "audio[0].asset"));
  c.audio = [{ id: "wrong", kind: "music", atS: 0, durationS: 0.5, asset: "video.mp4" }];
  assert((await validateLaunchAssets(c, json)).some((x) => x.message.includes("no audio stream")));
  c.audio = [];
  c.scenes = [{ id: "corrupt", type: "footage", durationS: 0.2, asset: "broken.mp4" }];
  assert((await validateLaunchAssets(c, json)).some((x) => x.message.includes("could not probe")));
});

test("footage density warning respects contain versus cover and stays nonfatal", async () => {
  const c = comp();
  c.output = { width: 320, height: 90, fps: 30 };
  c.scenes = [
    {
      id: "f",
      type: "footage",
      asset: "video.mp4",
      durationS: 1,
      frame: { inset: 0, radius: 0 },
      fit: "contain",
    },
  ];
  assert.deepEqual(await validateLaunchAssets(c, join(dir, "launch.json")), []);
  c.scenes[0]!.fit = "cover";
  const issues = await validateLaunchAssets(c, join(dir, "launch.json"));
  assert(
    issues.some(
      (x) => x.severity === "warn" && x.path === "scenes[0].asset" && x.message.includes("2.00x"),
    ),
  );
  assert(!issues.some((x) => x.severity === "error"));
});

test("lossless launch preparation preserves decoded fitted pixels and strips source audio", async () => {
  const source = join(dir, "detail-source.mkv"),
    prepared = join(dir, "detail-prepared.webm");
  await exec(ffmpeg, [
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "testsrc2=s=160x90:r=30:d=1",
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=440:duration=1",
    "-c:v",
    "ffv1",
    "-c:a",
    "pcm_s16le",
    source,
  ]);
  await prepareLaunchVideo(source, prepared, {
    trimStartS: 0.2,
    durationS: 0.5,
    fps: 30,
    frame: { width: 320, height: 180, fit: "contain" },
  });
  const filter =
    "scale=320:180:force_original_aspect_ratio=decrease:flags=lanczos:out_range=tv:out_color_matrix=bt709,pad=320:180:(ow-iw)/2:(oh-ih)/2:color=#0b1714,setsar=1,format=yuv420p,setparams=range=tv:colorspace=bt709:color_primaries=bt709:color_trc=bt709";
  const expected = await exec(
    ffmpeg,
    [
      "-v",
      "error",
      "-ss",
      "0.2",
      "-i",
      source,
      "-vf",
      filter,
      "-frames:v",
      "1",
      "-f",
      "rawvideo",
      "-pix_fmt",
      "yuv420p",
      "pipe:1",
    ],
    { encoding: "buffer" },
  );
  const actual = await exec(
    ffmpeg,
    [
      "-v",
      "error",
      "-i",
      prepared,
      "-frames:v",
      "1",
      "-f",
      "rawvideo",
      "-pix_fmt",
      "yuv420p",
      "pipe:1",
    ],
    { encoding: "buffer" },
  );
  assert.deepEqual(
    actual.stdout,
    expected.stdout,
    "VP9 preparation must add zero pixel error after the authored fit/color transform",
  );
  const probe = JSON.parse(
    (
      await exec(ffprobe, [
        "-v",
        "error",
        "-show_entries",
        "stream=codec_name,codec_type,width,height,color_space",
        "-of",
        "json",
        prepared,
      ])
    ).stdout,
  );
  assert.deepEqual(probe.streams, [
    { codec_name: "vp9", codec_type: "video", width: 320, height: 180, color_space: "bt709" },
  ]);
});

test("output aliases reject direct, hardlink, file symlink and directory symlink targets", async () => {
  const json = join(dir, "launch.json"),
    c = comp();
  c.scenes = [{ id: "footage", type: "footage", durationS: 0.5, asset: "video.mp4" }];
  await writeFile(json, JSON.stringify(c));
  await link(join(dir, "video.mp4"), join(dir, "hardlink.mp4"));
  await symlink(join(dir, "video.mp4"), join(dir, "symlink.mp4"));
  await symlink(dir, join(dir, "directory-link"), "junction");
  for (const path of [
    json,
    join(dir, "video.mp4"),
    join(dir, "hardlink.mp4"),
    join(dir, "symlink.mp4"),
    join(dir, "directory-link", "video.mp4"),
  ])
    assert.throws(() => assertLaunchOutputSafe(c, json, path), /must not overwrite/);
  assert.doesNotThrow(() => assertLaunchOutputSafe(c, json, join(dir, "future", "delivery.mp4")));
});

test("validation failure preserves an existing master and creates no staging files", async () => {
  const target = join(dir, "existing.mp4"),
    c = comp();
  await writeFile(target, "existing master");
  c.audio = [{ id: "bad", kind: "music", atS: 0, asset: "broken.mp4" }];
  const beforeFiles = await readdir(dir);
  await assert.rejects(
    renderLaunch({
      composition: c,
      compositionPath: join(dir, "launch.json"),
      outPath: target,
      chromePath: "unused",
    }),
    /could not probe/,
  );
  assert.equal(await readFile(target, "utf8"), "existing master");
  assert.deepEqual(await readdir(dir), beforeFiles);
});

test("encoding failure preserves the master and removes its temporary publication directory", async () => {
  const target = join(dir, "published.mp4"),
    c = comp();
  c.audio = [{ id: "corrupt", kind: "music", asset: "broken.mp4", atS: 0, durationS: 2 }];
  await writeFile(target, "previous good master");
  const beforeFiles = await readdir(dir);
  await assert.rejects(
    publishLaunchMedia(join(dir, "video.mp4"), target, c, join(dir, "launch.json")),
    /ffmpeg.*exited/,
  );
  assert.equal(await readFile(target, "utf8"), "previous good master");
  assert.deepEqual(await readdir(dir), beforeFiles);
});

test("truncated or overlong renderer output cannot replace a master and staging is removed", async () => {
  const target = join(dir, "complete-master.mp4");
  await writeFile(target, "complete existing master");
  const beforeFiles = await readdir(dir);
  await assert.rejects(
    publishLaunchMedia(join(dir, "one-second.mp4"), target, comp(), join(dir, "launch.json")),
    /renderer produced 1\.000000s.*authored 2\.000000s/,
  );
  await assert.rejects(
    publishLaunchMedia(join(dir, "video.mp4"), target, comp(1), join(dir, "launch.json")),
    /renderer produced 2\.000000s.*authored 1\.000000s/,
  );
  assert.equal(await readFile(target, "utf8"), "complete existing master");
  assert.deepEqual(await readdir(dir), beforeFiles);
});

test("a renderer output one frame short is padded only to the authored end", async () => {
  const target = join(dir, "rounded.mp4");
  const raw = await probe(join(dir, "one-frame-short.mp4"));
  assert(Math.abs(Number(raw.format.duration) - 59 / 30) < 0.001);
  await publishLaunchMedia(
    join(dir, "one-frame-short.mp4"),
    target,
    comp(),
    join(dir, "launch.json"),
  );
  assert.equal(Number((await probe(target)).format.duration), 2);
});

test("default entrance timing and overflowing end-card copy are validated", () => {
  const c = comp(0.1);
  delete c.scenes[0]!.motion;
  assert(validateLaunchComposition(c).some((x) => x.path === "scenes[0].durationS"));
  c.scenes = [
    {
      id: "end",
      type: "end-card",
      durationS: 1,
      headline: "漢".repeat(60),
      brand: "Brand",
      cta: "Try it",
    },
  ];
  const issues = validateLaunchComposition(c);
  assert(issues.some((x) => x.path === "scenes[0].durationS"));
  assert(issues.some((x) => x.path === "scenes[0].headline"));
  c.scenes[0]!.motion = "off";
  assert(!validateLaunchComposition(c).some((x) => x.path === "scenes[0].durationS"));
});

async function probe(path: string) {
  const { stdout } = await exec(ffprobe, [
    "-v",
    "error",
    "-show_streams",
    "-show_format",
    "-of",
    "json",
    path,
  ]);
  return JSON.parse(stdout) as {
    format: { duration: string };
    streams: {
      codec_type: string;
      codec_name: string;
      pix_fmt?: string;
      color_space?: string;
      width?: number;
      height?: number;
    }[];
  };
}
async function samples(path: string): Promise<Float32Array> {
  const { stdout } = await exec(
    ffmpeg,
    [
      "-v",
      "error",
      "-i",
      path,
      "-map",
      "0:a:0",
      "-f",
      "f32le",
      "-ac",
      "1",
      "-ar",
      "48000",
      "pipe:1",
    ],
    { encoding: "buffer", maxBuffer: 4_000_000 },
  );
  return new Float32Array(
    stdout.buffer.slice(stdout.byteOffset, stdout.byteOffset + stdout.byteLength),
  );
}
function rms(data: Float32Array, from: number, to: number): number {
  const a = Math.round(from * 48000),
    b = Math.round(to * 48000);
  let sum = 0;
  for (let i = a; i < b; i++) sum += (data[i] ?? 0) ** 2;
  return Math.sqrt(sum / (b - a));
}

test("actual FFmpeg delivery retains silent authored duration with H264 709 yuv420p", async () => {
  const c = comp(),
    path = join(dir, "silent.mp4");
  await deliverLaunchMedia(join(dir, "video.mp4"), path, c, join(dir, "launch.json"));
  const got = await probe(path),
    video = got.streams.find((x) => x.codec_type === "video")!;
  assert.equal(Number(got.format.duration), 2);
  assert.equal(video.codec_name, "h264");
  assert.equal(video.pix_fmt, "yuv420p");
  assert.equal(video.color_space, "bt709");
  assert.equal(video.width, 160);
  assert.equal(video.height, 90);
  assert.equal(
    got.streams.some((x) => x.codec_type === "audio"),
    false,
  );
});

test("real mixed AAC loops music, ducks only narration window, fades and stays silent outside span", async () => {
  const c = comp(),
    path = join(dir, "mixed.mp4");
  c.audio = [
    {
      id: "music",
      kind: "music",
      asset: "tone.wav",
      atS: 0.2,
      durationS: 1.6,
      loop: true,
      gain: 0.8,
      fadeInS: 0.2,
      fadeOutS: 0.2,
    },
    {
      id: "voice",
      kind: "narration",
      asset: "tone.wav",
      atS: 0.8,
      durationS: 0.25,
      gain: 0,
      duckMusic: true,
    },
  ];
  await deliverLaunchMedia(join(dir, "video.mp4"), path, c, join(dir, "launch.json"));
  const got = await probe(path),
    pcm = await samples(path);
  assert.equal(Number(got.format.duration), 2);
  assert.equal(got.streams.find((x) => x.codec_type === "audio")!.codec_name, "aac");
  const baseline = rms(pcm, 0.5, 0.65),
    ducked = rms(pcm, 0.88, 0.98),
    recovered = rms(pcm, 1.25, 1.4);
  assert(baseline > 0.05);
  assert(ducked / baseline > 0.2 && ducked / baseline < 0.5, `duck ratio ${ducked / baseline}`);
  assert(Math.abs(recovered / baseline - 1) < 0.08, `loop/recovery ratio ${recovered / baseline}`);
  assert(rms(pcm, 0.22, 0.27) < baseline * 0.4);
  assert(rms(pcm, 1.72, 1.77) < baseline * 0.5);
  assert(rms(pcm, 0.02, 0.15) < 0.001);
  assert(rms(pcm, 1.9, 1.98) < 0.001);
});

test("looping repeats only the source after trimStartS", async () => {
  const source = join(dir, "leading silence.wav");
  await exec(ffmpeg, [
    "-v",
    "error",
    "-i",
    join(dir, "tone.wav"),
    "-af",
    "adelay=120:all=1",
    source,
  ]);
  const c = comp(1);
  c.audio = [
    {
      id: "loop",
      kind: "music",
      asset: "leading silence.wav",
      atS: 0,
      trimStartS: 0.12,
      durationS: 1,
      loop: true,
    },
  ];
  const path = join(dir, "trimmed-loop.mp4");
  await deliverLaunchMedia(join(dir, "one-second.mp4"), path, c, join(dir, "launch.json"));
  const pcm = await samples(path);
  const first = rms(pcm, 0.02, 0.08),
    repeated = rms(pcm, 0.52, 0.58);
  assert(first > 0.08);
  assert(Math.abs(repeated / first - 1) < 0.08, `trimmed loop ratio ${repeated / first}`);
});
