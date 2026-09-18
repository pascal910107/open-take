import assert from "node:assert/strict";
import { test } from "node:test";
import { frameCentreS, quantizeToFrame } from "../src/launch-evaluate.js";

test("quantizeToFrame snaps an accumulated clock back onto the frame it names", () => {
  let accumulated = 0;
  for (let frame = 1; frame <= 3600; frame++) {
    accumulated += 1 / 60;
    assert.equal(quantizeToFrame(accumulated, 60), Math.round(frame) / 60);
  }
  assert.equal(quantizeToFrame(9.599999999999998, 60), 9.6);
  assert.equal(quantizeToFrame(15.499999999999996, 60), 15.5);
});

test("frameCentreS lands inside the intended frame of millisecond-stamped media", () => {
  // WebM/Matroska timestamps are whole milliseconds: frame k sits at round(k*1000/fps) ms.
  for (const fps of [30, 60]) {
    for (let k = 0; k < 4 * fps; k++) {
      const seek = frameCentreS(k / fps, fps);
      const thisPts = Math.round((k * 1000) / fps) / 1000;
      const nextPts = Math.round(((k + 1) * 1000) / fps) / 1000;
      assert.ok(
        seek >= thisPts && seek < nextPts,
        `fps ${fps} frame ${k}: ${seek} not in [${thisPts}, ${nextPts})`,
      );
      // and the naive seek really does miss on this grid, which is why the helper exists
      if (k === 1 && fps === 60) assert.ok(k / fps < thisPts);
    }
  }
});

test("frameCentreS keeps a clamped last sample inside the prepared span", () => {
  const trim = 0,
    durationS = 3.2,
    fps = 60;
  const lastSample = trim + durationS - 1 / fps;
  assert.ok(frameCentreS(lastSample, fps) < durationS);
  assert.ok(frameCentreS(0, fps) > 0);
});
