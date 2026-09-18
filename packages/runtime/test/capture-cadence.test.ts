import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { resolveFfmpeg } from "@open-take/compositor";
import {
  type CDP,
  captureCadence,
  encodeFrames,
  type Frame,
  pumpIdleRaster,
  Screencast,
} from "../src/cdp";

const exec = promisify(execFile);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test("screencast uses swap timestamps rather than JPEG delivery and records fallback", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "capture-cadence-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  let handler: (event: unknown) => void = () => {};
  const calls: string[] = [];
  const cdp = {
    on: (_name: string, fn: typeof handler) => {
      handler = fn;
    },
    send: async (name: string) => {
      calls.push(name);
    },
  } as unknown as CDP;
  const recorder = new Screencast(cdp, dir),
    start = Date.now() - 2000;
  await recorder.start(start, { maxWidth: 16, maxHeight: 16 });
  handler({
    data: Buffer.from("frame one").toString("base64"),
    sessionId: 1,
    metadata: { timestamp: (start + 100) / 1000 },
  });
  handler({
    data: Buffer.from("frame two").toString("base64"),
    sessionId: 2,
    metadata: { timestamp: (start + 50) / 1000 },
  });
  handler({ data: Buffer.from("fallback").toString("base64"), sessionId: 3 });
  await recorder.stop();
  assert.ok(Math.abs(recorder.frames[0]!.offMs - 100) < 0.01);
  assert.ok(recorder.frames[0]!.arrivalMs! >= 2000);
  assert.ok(recorder.frames[2]!.offMs >= 2000);
  assert.equal(await readFile(recorder.frames[0]!.file, "utf8"), "frame one");
  assert.equal(calls.filter((name) => name === "Page.screencastFrameAck").length, 3);
  const cadence = captureCadence(recorder.frames);
  assert.equal(cadence.timestampSource, "mixed");
  assert.equal(cadence.frameCount, 3);
  assert.equal(cadence.outOfOrderFrames, 1);
  assert.ok(cadence.maxArrivalDelayMs >= 1900);
  assert.ok(cadence.frameOffsetsMs[0]! < cadence.frameOffsetsMs[1]!);
  assert.match(cadence.note, /Static pages may send no frames/);
  assert.match(cadence.note, /not unique image content/);
});

test("idle raster pump does not interrupt active frames or queue slow screenshot requests", async () => {
  let active = true,
    paused = false,
    idleForMs = 0,
    calls = 0;
  let release: () => void = () => {};
  const cdp = {
    send: () => {
      calls++;
      return new Promise<void>((resolve) => {
        release = resolve;
      });
    },
  } as unknown as CDP;
  const pump = pumpIdleRaster(
    cdp,
    {
      get idleForMs() {
        return idleForMs;
      },
    },
    () => active,
    () => paused,
  );
  try {
    await sleep(100);
    assert.equal(calls, 0);
    paused = true;
    idleForMs = 500;
    await sleep(100);
    assert.equal(calls, 0);
    paused = false;
    await sleep(100);
    assert.equal(calls, 1);
    await sleep(200);
    assert.equal(calls, 1, "a timed-out screenshot must not spawn a queue of more screenshots");
    idleForMs = 0;
    release();
    await sleep(100);
    assert.equal(calls, 1);
  } finally {
    active = false;
    release();
    await pump;
  }
});

test("timestamped 60fps frames retain their timing through the real concat encoder", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "capture-encode-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const frames: Frame[] = [];
  for (let i = 0; i < 60; i++) {
    const file = join(dir, `frame-${i}.ppm`);
    const pixels = Buffer.alloc(16 * 16 * 3, 24 + i * 3);
    await writeFile(file, Buffer.concat([Buffer.from("P6\n16 16\n255\n"), pixels]));
    frames.push({ file, offMs: (i * 1000) / 60, arrivalMs: (i * 1000) / 60 + (i % 3) * 40 });
  }
  [frames[11], frames[12]] = [frames[12]!, frames[11]!];
  const ffmpeg = await resolveFfmpeg(),
    out = join(dir, "capture.mp4");
  await encodeFrames(frames, 1000, out, 60, ffmpeg);
  const { stdout } = await exec(
    ffmpeg,
    ["-v", "error", "-i", out, "-pix_fmt", "gray", "-f", "rawvideo", "-"],
    { encoding: "buffer" },
  );
  const values = Array.from({ length: stdout.length / 256 }, (_, i) => stdout[i * 256]!);
  assert.ok(
    values.length >= 60 && values.length <= 61,
    `one-second source should occupy60 frames plus at most one rounding frame, got${values.length}`,
  );
  for (let i = 1; i < 60; i++)
    assert.ok(
      values[i]! > values[i - 1]!,
      `source frame${i} must advance, not become a 25fps time-base hold`,
    );
  const concat = await readFile(join(dir, "frames.concat"), "utf8");
  assert.match(concat, /option framerate 1000/);
});
