import assert from "node:assert/strict";
import { readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { planComposition } from "../src/plan.js";
import { renderTake } from "../src/render.js";
import type { CaptureLog } from "../src/types.js";

const scratchDirs = async (): Promise<Set<string>> =>
  new Set(
    (await readdir(tmpdir(), { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() && entry.name.startsWith("open-take-render-"))
      .map((entry) => entry.name),
  );

test("a failure while preparing a render removes its scratch directory", async () => {
  const log: CaptureLog = {
    video: { width: 1280, height: 720, fps: 30 },
    viewport: { w: 1280, h: 720 },
    events: [{ kind: "click", x: 640, y: 360, tMs: 300 }],
    tEndMs: 800,
  };
  const before = await scratchDirs();
  const previousKeep = process.env.OPEN_TAKE_KEEP_SCRATCH;
  Reflect.deleteProperty(process.env, "OPEN_TAKE_KEEP_SCRATCH");

  try {
    await assert.rejects(
      renderTake({
        composition: planComposition(log),
        videoPath: join(tmpdir(), `open-take-missing-${process.pid}.mp4`),
        outPath: join(tmpdir(), `open-take-never-written-${process.pid}.mp4`),
      }),
    );
  } finally {
    if (previousKeep === undefined) Reflect.deleteProperty(process.env, "OPEN_TAKE_KEEP_SCRATCH");
    else process.env.OPEN_TAKE_KEEP_SCRATCH = previousKeep;
  }

  const leaked = [...(await scratchDirs())].filter((name) => !before.has(name));
  assert.deepEqual(leaked, []);
});
