import assert from "node:assert/strict";
import { execFile, spawnSync } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import test from "node:test";
import { promisify } from "node:util";
import { resolveFfmpeg, resolveFfprobe, resolveManagedFfmpeg } from "@open-take/compositor";
import { encodeFrames, type Frame, frameTimeline } from "../src/cdp";
import { jpegDimensions, matroskaHead, mjpegMatroska } from "../src/mjpeg-matroska";

const exec = promisify(execFile);

/** `count` 16×16 JPEG frames of rising flat gray, made by ffmpeg from raw
 *  pixels so the test needs no JPEG encoder of its own. Frame i is gray
 *  8+4i, a step large enough to survive JPEG, h264 and full→limited range. */
async function grayJpegs(dir: string, count: number, ffmpeg: string): Promise<string[]> {
  const raw = Buffer.concat(
    Array.from({ length: count }, (_, i) => Buffer.alloc(16 * 16, 8 + i * 4)),
  );
  const r = spawnSync(
    ffmpeg,
    [
      "-v",
      "error",
      "-f",
      "rawvideo",
      "-pix_fmt",
      "gray",
      "-s",
      "16x16",
      "-i",
      "pipe:0",
      "-q:v",
      "1",
      "-pix_fmt",
      "yuvj420p", // what Chrome's screencast encoder emits
      join(dir, "f-%03d.jpg"),
    ],
    { input: raw },
  );
  assert.equal(r.status, 0, r.stderr?.toString());
  return Array.from({ length: count }, (_, i) =>
    join(dir, `f-${String(i + 1).padStart(3, "0")}.jpg`),
  );
}

/** Every ffmpeg the runtime may end up driving: whatever resolveFfmpeg picks
 *  (the developer's system binary, usually newer) AND the managed build a
 *  zero-config install runs — the leg whose absence let 0.5.0 ship. */
async function everyFfmpeg(): Promise<[string, string][]> {
  const bins: [string, string][] = [["resolved", await resolveFfmpeg()]];
  const managed = await resolveManagedFfmpeg();
  if (managed !== bins[0]![1]) bins.push(["managed", managed]);
  return bins;
}

test("jpegDimensions reads the frame header of baseline and progressive JPEGs", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "jpeg-dims-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const [file] = await grayJpegs(dir, 1, await resolveFfmpeg());
  const { readFile } = await import("node:fs/promises");
  assert.deepEqual(jpegDimensions(await readFile(file!)), { width: 16, height: 16 });

  // Hand-built: SOI, an APP1 segment (as a camera or Skia would write), then
  // a progressive SOF2 for 1280×657. Nothing after it matters to the parser.
  const app1 = Buffer.concat([Buffer.from([0xff, 0xe1, 0x00, 0x08]), Buffer.from("Exif\0\0")]);
  const sof2 = Buffer.from([
    0xff,
    0xc2,
    0x00,
    0x0b,
    0x08,
    657 >> 8,
    657 & 0xff,
    1280 >> 8,
    1280 & 0xff,
    0x01,
    0x01,
    0x11,
    0x00,
  ]);
  const progressive = Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    app1,
    sof2,
    Buffer.from([0xff, 0xda]),
  ]);
  assert.deepEqual(jpegDimensions(progressive), { width: 1280, height: 657 });

  assert.throws(() => jpegDimensions(Buffer.from("P6\n16 16\n255\n")), /not a JPEG/);
  assert.throws(
    () => jpegDimensions(Buffer.from([0xff, 0xd8, 0xff, 0xda, 0x00, 0x02])),
    /no SOF marker/,
  );
});

test("frameTimeline pins the first frame to 0, keeps later offsets, and separates collisions", () => {
  const frames: Frame[] = [
    { file: "c", offMs: 50.4 },
    { file: "a", offMs: 12.9 },
    { file: "b", offMs: 16.7 },
    { file: "d", offMs: 50.6 },
  ];
  assert.deepEqual(frameTimeline(frames, 40, 60), [
    { file: "a", tMs: 0 },
    { file: "b", tMs: 17 },
    { file: "c", tMs: 50 },
    { file: "d", tMs: 51 },
    // endMs (40) is already behind the last frame: it still gets one 60 fps
    // period (16.7 ms after 50.6 → 67) of screen time.
    { file: "d", tMs: 67 },
  ]);
  assert.deepEqual(frameTimeline([{ file: "only", offMs: 30 }], 1000, 30), [
    { file: "only", tMs: 0 },
    { file: "only", tMs: 1000 },
  ]);
});

test("the Matroska stream carries each frame's millisecond exactly, for every ffmpeg", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "mjpeg-mkv-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const files = await grayJpegs(dir, 4, await resolveFfmpeg());
  const timeline = [
    { file: files[0]!, tMs: 0 },
    { file: files[1]!, tMs: 17 },
    { file: files[2]!, tMs: 50 },
    { file: files[3]!, tMs: 62 },
    { file: files[3]!, tMs: 112 },
  ];
  const mkv = join(dir, "frames.mkv");
  await pipeline(mjpegMatroska(timeline), createWriteStream(mkv));

  const ffprobe = await resolveFfprobe();
  const { stdout } = await exec(ffprobe, [
    "-v",
    "error",
    "-f",
    "matroska",
    "-i",
    mkv,
    "-show_entries",
    "packet=pts_time",
    "-of",
    "csv=p=0",
  ]);
  assert.deepEqual(
    stdout.trim().split("\n").map(Number),
    timeline.map((f) => f.tMs / 1000),
    "demuxed pts must be the timeline, not a 1/25 s image-clock rounding of it",
  );
  const stream = await exec(ffprobe, [
    "-v",
    "error",
    "-i",
    mkv,
    "-show_entries",
    "stream=codec_name,width,height,pix_fmt,color_range",
    "-of",
    "csv=p=0",
  ]);
  // The same decoder image2 would have reached, so the colour pipeline
  // downstream (full-range 601 → limited 709) sees what it always saw.
  assert.equal(stream.stdout.trim(), "mjpeg,16,16,yuvj420p,pc");

  for (const [name, ffmpeg] of await everyFfmpeg()) {
    const decoded = await exec(
      ffmpeg,
      [
        "-v",
        "error",
        "-f",
        "matroska",
        "-i",
        mkv,
        "-fps_mode",
        "passthrough",
        "-f",
        "rawvideo",
        "-pix_fmt",
        "gray",
        "-",
      ],
      { encoding: "buffer" },
    );
    assert.equal(decoded.stdout.length, 5 * 256, `${name} ffmpeg decodes all five blocks`);
  }
});

test("timestamped 60fps frames retain their timing through the encoder, on every ffmpeg", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "capture-encode-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const files = await grayJpegs(dir, 60, await resolveFfmpeg());
  const frames: Frame[] = files.map((file, i) => ({
    file,
    offMs: (i * 1000) / 60,
    arrivalMs: (i * 1000) / 60 + (i % 3) * 40,
  }));
  [frames[11], frames[12]] = [frames[12]!, frames[11]!];

  for (const [name, ffmpeg] of await everyFfmpeg()) {
    const out = join(dir, `capture-${name}.mp4`);
    await encodeFrames(frames, 1000, out, 60, ffmpeg);
    const { stdout } = await exec(
      ffmpeg,
      ["-v", "error", "-i", out, "-pix_fmt", "gray", "-f", "rawvideo", "-"],
      { encoding: "buffer" },
    );
    const values = Array.from({ length: stdout.length / 256 }, (_, i) => stdout[i * 256]!);
    assert.ok(
      values.length >= 60 && values.length <= 61,
      `${name}: a one-second source should occupy 60 frames plus at most one rounding frame, got ${values.length}`,
    );
    for (let i = 1; i < 60; i++)
      assert.ok(
        values[i]! > values[i - 1]!,
        `${name}: source frame ${i} must advance, not become a 25fps time-base hold`,
      );
  }
});

test("a truncated first frame is skipped over for the header, not fatal", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "mjpeg-mkv-trunc-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const [good] = await grayJpegs(dir, 1, await resolveFfmpeg());
  const { readFile, writeFile } = await import("node:fs/promises");
  const cut = join(dir, "cut.jpg");
  await writeFile(cut, (await readFile(good!)).subarray(0, 6)); // SOI + the start of APP0
  const chunks: Buffer[] = [];
  for await (const c of mjpegMatroska([
    { file: cut, tMs: 0 },
    { file: good!, tMs: 16 },
    { file: good!, tMs: 32 },
  ]))
    chunks.push(c);
  assert.equal(chunks.length, 4, "head + three clusters");
  assert.deepEqual(chunks[0], matroskaHead(16, 16, 32), "header sized from the readable frame");
});

test("multi-megabyte frames get wide EBML sizes and still decode", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "mjpeg-mkv-big-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const ffmpeg = await resolveFfmpeg();
  const big = join(dir, "big.jpg");
  // random noise defeats JPEG compression: a 2048² frame at q=1 is several MB
  const r = spawnSync(ffmpeg, [
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "nullsrc=s=2048x2048,geq=random(1)*255:128:128",
    "-frames:v",
    "1",
    "-q:v",
    "1",
    big,
  ]);
  assert.equal(r.status, 0, r.stderr?.toString());
  const { stat } = await import("node:fs/promises");
  assert.ok(
    (await stat(big)).size > 2 * 1024 * 1024,
    "fixture exceeds the 2-byte/3-byte vint ranges",
  );
  const mkv = join(dir, "big.mkv");
  await pipeline(
    mjpegMatroska([
      { file: big, tMs: 0 },
      { file: big, tMs: 40 },
    ]),
    createWriteStream(mkv),
  );
  for (const [name, bin] of await everyFfmpeg()) {
    const decoded = await exec(
      bin,
      [
        "-v",
        "error",
        "-f",
        "matroska",
        "-i",
        mkv,
        "-fps_mode",
        "passthrough",
        "-f",
        "rawvideo",
        "-pix_fmt",
        "gray",
        "-",
      ],
      { encoding: "buffer", maxBuffer: 64 * 1024 * 1024 },
    );
    assert.equal(decoded.stdout.length, 2 * 2048 * 2048, `${name} ffmpeg decodes both big blocks`);

    // The same frames through the real encoder over stdin: every cluster is
    // far past the pipe's buffer, so this is the backpressure path production
    // frames take. Then the failure path: ffmpeg cannot open the output, and
    // ITS message must come back — not the pipe's EPIPE from the feeder.
    const frames: Frame[] = Array.from({ length: 6 }, (_, i) => ({ file: big, offMs: i * 40 }));
    await encodeFrames(frames, 240, join(dir, `big-${name}.mp4`), 25, bin);
    await assert.rejects(
      encodeFrames(frames, 240, join(dir, "no", "such", "dir", "out.mp4"), 25, bin),
      (e: Error) => /ffmpeg encode exited/.test(e.message) && !/EPIPE/.test(e.message),
      `${name}: ffmpeg's own error is reported`,
    );
  }
});

test("a frame that cannot be read fails the encode instead of hanging ffmpeg", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "capture-encode-bad-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const [good] = await grayJpegs(dir, 1, await resolveFfmpeg());
  const frames: Frame[] = [
    { file: good!, offMs: 0 },
    { file: join(dir, "missing.jpg"), offMs: 16 },
  ];
  await assert.rejects(encodeFrames(frames, 100, join(dir, "out.mp4"), 60), /ENOENT/);
});
