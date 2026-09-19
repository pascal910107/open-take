import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { type CDP, captureCadence, pumpIdleRaster, Screencast } from "../src/cdp";

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
