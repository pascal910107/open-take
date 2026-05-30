// The capture-log seam that makes the capture-lock REAL in the refine loop.
// makeTake persists `<out>.capture.json` beside `<out>.capture.mp4`; `render`
// auto-loads it by convention so validateComposition can check that an edit
// didn't move a capture-locked action tMs. Without this wiring the headline
// check never fires in the CLI path (it only ran inside makeTake's in-memory
// render). These tests pin the convention + loader; the full CLI refusal is
// proven e2e (out/refine-spike).

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { captureLogPathFor, loadCaptureLogSibling } from "../src/index.js";

test("captureLogPathFor: <x>.capture.mp4 → <x>.capture.json (sibling convention)", () => {
  assert.equal(captureLogPathFor("/out/demo.capture.mp4"), "/out/demo.capture.json");
  assert.equal(captureLogPathFor("/out/demo.capture.MP4"), "/out/demo.capture.json"); // case-insensitive
  assert.ok(captureLogPathFor("relative.capture.mp4").endsWith("relative.capture.json")); // absolutised
});

test("loadCaptureLogSibling: loads a present sibling, undefined when absent", async () => {
  const dir = await mkdtemp(join(tmpdir(), "open-take-test-"));
  try {
    const video = join(dir, "demo.capture.mp4");
    const log = { video: { width: 1920, height: 1080 }, viewport: { w: 1920, h: 1080 }, events: [{ tMs: 3000 }] };

    // no sibling yet → undefined (capture-lock skipped, not an error)
    assert.equal(await loadCaptureLogSibling(video), undefined);

    // write the sibling → loaded back as the ground-truth log
    await writeFile(captureLogPathFor(video), JSON.stringify(log));
    const loaded = await loadCaptureLogSibling(video);
    assert.equal(loaded?.events[0]?.tMs, 3000, "sibling log is read back");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
