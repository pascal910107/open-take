// The named curves carry a meaning, measured off a reference launch film:
// arrivals snap, objects swift, cameras glide, landings spring. These pin the
// shapes that make them read that way.

import assert from "node:assert/strict";
import test from "node:test";
import { evaluateMotionTrack, motionEase } from "../src/motion-evaluate";
import type { MotionEasing, MotionScene } from "../src/motion-types";
import { MOTION_EASINGS } from "../src/motion-types";
import { validateMotionScene } from "../src/motion-validate";

const samples = (e: MotionEasing, n = 400) =>
  Array.from({ length: n + 1 }, (_, i) => motionEase(i / n, e));

test("every curve starts at 0, lands exactly on 1 and holds outside the segment", () => {
  for (const e of MOTION_EASINGS) {
    assert.equal(motionEase(0, e), 0, e);
    assert.equal(motionEase(1, e), 1, e);
    assert.equal(motionEase(-0.5, e), 0, e);
    assert.equal(motionEase(1.5, e), 1, e);
  }
});

test("snap front-loads an arrival: ~90 % of the travel in the first third", () => {
  assert.ok(motionEase(1 / 3, "snap") > 0.88, String(motionEase(1 / 3, "snap")));
  // ...and is further along than the cubic ease-out it replaces
  assert.ok(motionEase(0.2, "snap") > motionEase(0.2, "ease-out") + 0.15);
  const s = samples("snap");
  for (let i = 1; i < s.length; i++) assert.ok(s[i]! >= s[i - 1]! - 1e-12, "monotonic");
});

test("glide is a symmetric in-out that never leaves [0, 1]", () => {
  for (let i = 0; i <= 50; i++) {
    const t = i / 50;
    assert.ok(Math.abs(motionEase(t, "glide") + motionEase(1 - t, "glide") - 1) < 1e-6);
  }
  const s = samples("glide");
  assert.ok(Math.min(...s) >= 0 && Math.max(...s) <= 1);
  // slow start: a camera eases off its rest
  assert.ok(motionEase(0.1, "glide") < 0.02);
});

test("swift is monotonic and ahead of glide the whole way", () => {
  const s = samples("swift");
  for (let i = 1; i < s.length; i++) assert.ok(s[i]! >= s[i - 1]! - 1e-12);
  for (let t = 0.05; t < 1; t += 0.05) assert.ok(motionEase(t, "swift") > motionEase(t, "glide"));
});

test("spring lands like the reference tile: ~9.5 % over near 0.38, ~1 % back, settled", () => {
  const s = samples("spring");
  const peak = Math.max(...s);
  const at = s.indexOf(peak) / 400;
  assert.ok(peak > 1.08 && peak < 1.11, `peak ${peak}`);
  assert.ok(at > 0.33 && at < 0.43, `peak at ${at}`);
  const after = s.slice(Math.round(at * 400));
  const dip = Math.min(...after);
  assert.ok(dip < 1 && dip > 0.98, `undershoot ${dip}`);
  // settled over the last tenth
  for (const v of s.slice(360)) assert.ok(Math.abs(v - 1) < 0.004, String(v));
});

test("back pops about 10 % past the target once", () => {
  const peak = Math.max(...samples("back"));
  assert.ok(peak > 1.08 && peak < 1.12, String(peak));
});

test("an overshooting curve moves numbers past the target but keeps colours in gamut", () => {
  const scale = evaluateMotionTrack(
    {
      property: "scaleX",
      keyframes: [
        { atS: 0, value: 0.4 },
        { atS: 0.6, value: 1, easing: "spring" },
      ],
    },
    0.23,
  ) as number;
  assert.ok(scale > 1.03, String(scale));
  const fill = evaluateMotionTrack(
    {
      property: "fill",
      keyframes: [
        { atS: 0, value: "#000000" },
        { atS: 1, value: "#ffffff", easing: "back" },
      ],
    },
    0.7,
  ) as string;
  const channels = fill.match(/[\d.]+/g)!.map(Number);
  assert.ok(
    channels.slice(0, 3).every((c) => c >= 0 && c <= 255),
    fill,
  );
});

test("the validator accepts every named curve and rejects unknown ones", () => {
  const scene = (easing: string): MotionScene =>
    ({
      id: "s",
      type: "motion",
      durationS: 2,
      layers: [
        {
          id: "r",
          type: "rect",
          width: 10,
          height: 10,
          animations: [
            {
              property: "x",
              keyframes: [
                { atS: 0, value: 0 },
                { atS: 1, value: 100, easing },
              ],
            },
          ],
        },
      ],
    }) as unknown as MotionScene;
  for (const e of MOTION_EASINGS) assert.deepEqual(validateMotionScene(scene(e), "s"), [], e);
  assert.ok(validateMotionScene(scene("bouncy"), "s").some((x) => x.path.endsWith("easing")));
});
