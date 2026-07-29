// hold-to-compare's gate. The bug this locks down: the button compared against
// the LAST-SAVED comp, and autosave commits ~700ms after every edit — so
// holding it showed the frame you were already looking at, and the feature read
// as broken. The anchor is now the session origin, and the gate is a VALUE
// comparison so undoing back to the start disables the button instead of
// offering a comparison with nothing in it.

import assert from "node:assert/strict";
import { test } from "node:test";
import type { TakeComposition } from "../src/lib/compositor.js";
import { sameComposition, setBeatZoom, setDuration } from "../src/lib/edit.js";

const comp = (): TakeComposition =>
  ({
    durationMs: 4000,
    output: { width: 1920, height: 1080, fps: 60 },
    source: { videoWidth: 1280, videoHeight: 720, videoPath: "demo.capture.mp4" },
    start: { x: 640, y: 360 },
    framing: { insetFrac: 0.92 },
    cursor: {},
    events: [
      {
        tMs: 800,
        kind: "click",
        point: { x: 300, y: 240 },
        label: "a",
        zoom: { enabled: false, scale: 1.6, center: { x: 300, y: 240 } },
      },
    ],
  }) as unknown as TakeComposition;

test("an untouched draft has nothing to compare", () => {
  const origin = comp();
  assert.equal(sameComposition(origin, origin), true);
  assert.equal(sameComposition(origin, comp()), true, "a fresh copy is still the same cut");
});

test("an edit is comparable", () => {
  const origin = comp();
  assert.equal(sameComposition(origin, setBeatZoom(origin, 0, { enabled: true })), false);
  assert.equal(sameComposition(origin, setDuration(origin, 5000)), false);
});

test("undoing back to the origin goes quiet again", () => {
  const origin = comp();
  const edited = setDuration(origin, 5000);
  const undone = setDuration(edited, 4000); // a NEW object with the origin's values
  assert.notEqual(undone, origin);
  assert.equal(sameComposition(undone, origin), true);
});

test("a missing side is never comparable", () => {
  assert.equal(sameComposition(null, comp()), false);
  assert.equal(sameComposition(comp(), null), false);
  assert.equal(sameComposition(null, null), true);
});
