// A launch film's shutter: how fast things move (so a still frame renders
// once and a fast one as often as a smooth smear needs), which scene time each
// render shows, the default, and what a composition may ask for.

import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_LAUNCH_MOTION_BLUR,
  launchMotionBlur,
  RENDER_OVERSAMPLE,
  renderedMotionBlur,
  sceneSampleS,
  shutterClock,
} from "../src/launch-evaluate";
import { launchTemplate } from "../src/launch-template";
import type { LaunchComposition } from "../src/launch-types";
import { validateLaunchComposition } from "../src/launch-validate";
import { SHUTTER_SPACING_PX, shutterSchedule, shutterTravelPx } from "../src/motion-speed";

const close = (a: number, b: number) => Math.abs(a - b) < 1e-12;

test("the clock spreads a frame's samples symmetrically across the shutter", () => {
  const clock = shutterClock([1, 4, 1, 2], 60, 0.5, 4);
  assert.equal(clock.renderFrames, 8);
  assert.equal(clock.renderFps, 60 * RENDER_OVERSAMPLE);
  // frame 0: one sample, on the frame
  assert.deepEqual(clock.at(0), { atS: 0, frameS: 0 });
  // frame 1: four samples at ±1/16 and ±3/16 of a frame
  const offsets = [1, 2, 3, 4].map((j) => clock.at(j).atS * 60 - 1);
  for (const [i, want] of [-0.1875, -0.0625, 0.0625, 0.1875].entries())
    assert.ok(close(offsets[i]!, want), `sample ${i}: ${offsets[i]}`);
  for (const j of [1, 2, 3, 4]) assert.ok(close(clock.at(j).frameS, 1 / 60), "footage stays put");
  assert.ok(close(clock.at(5).atS, 2 / 60));
  // frame 3: two samples at ±1/8
  assert.ok(close(clock.at(6).atS * 60 - 3, -0.125) && close(clock.at(7).atS * 60 - 3, 0.125));
  // never before the film starts
  assert.equal(shutterClock([4], 60, 0.5, 1).at(0).atS, 0);
});

test("without a schedule every render frame is an output frame", () => {
  const clock = shutterClock([], 60, 0.5, 90);
  assert.equal(clock.renderFrames, 90);
  assert.equal(clock.renderFps, 60);
  for (const j of [0, 1, 59, 89]) {
    const s = clock.at(j);
    assert.ok(close(s.atS, j / 60) && close(s.frameS, j / 60));
  }
});

const film = (layers: unknown[]): LaunchComposition =>
  ({
    ...launchTemplate(),
    output: { width: 1920, height: 1080, fps: 60 },
    scenes: [{ id: "m", type: "motion", durationS: 2, layers }],
  }) as LaunchComposition;

test("a still frame renders once; a fast one gets enough samples for a smooth smear", () => {
  // a card that holds, slides 960 px in 0.5 s, then holds again
  const comp = film([
    {
      id: "card",
      type: "rect",
      width: 200,
      height: 200,
      animations: [
        {
          property: "x",
          keyframes: [
            { atS: 0, value: -480 },
            { atS: 0.5, value: -480 },
            { atS: 1, value: 480, easing: "glide" },
          ],
        },
      ],
    },
  ]);
  const travel = shutterTravelPx(comp, 0.5);
  const schedule = shutterSchedule(comp, { samples: 16, shutter: 0.5 });
  assert.equal(schedule.length, 120);
  assert.equal(schedule[10], 1, "holding still");
  assert.equal(schedule[110], 1, "landed");
  // mid-slide the card crosses ~30 px per frame: 15 px of it inside a 180° shutter
  assert.ok(travel[45]! > 10, String(travel[45]));
  assert.equal(schedule[45], Math.min(16, Math.ceil(travel[45]! / SHUTTER_SPACING_PX)));
  assert.ok(schedule.reduce((a, b) => a + b, 0) < 120 * 4, "cheaper than a fixed four");
});

test("text units moving inside a still box count as motion", () => {
  const comp = film([
    {
      id: "t",
      type: "text",
      text: "Make ideas visible",
      width: 1600,
      height: 200,
      fontSize: 120,
      units: { by: "word", moves: [{ move: "rise", atS: 0.5 }] },
    },
  ]);
  const schedule = shutterSchedule(comp, { samples: 16, shutter: 0.5 });
  assert.equal(schedule[20], 1, "before the rise nothing moves");
  // a 144 px rise on snap moves ≤ ~17 px a frame: a few samples, not one
  assert.ok(schedule[31]! >= 3, `a word snapping up: ${schedule[31]}`);
  assert.equal(schedule[119], 1, "landed");
});

test("blur is on by default, off on request, and only prepare() applies the default", () => {
  const output = { width: 1920, height: 1080, fps: 60 };
  assert.deepEqual(launchMotionBlur(output), DEFAULT_LAUNCH_MOTION_BLUR);
  assert.deepEqual(DEFAULT_LAUNCH_MOTION_BLUR, { samples: 16, shutter: 0.5 });
  assert.equal(launchMotionBlur({ ...output, motionBlur: false }), undefined);
  assert.deepEqual(launchMotionBlur({ ...output, motionBlur: { samples: 6, shutter: 0.7 } }), {
    samples: 6,
    shutter: 0.7,
  });
  assert.equal(renderedMotionBlur(output), undefined);
  assert.equal(renderedMotionBlur({ ...output, motionBlur: false }), undefined);
});

test("the composition may cap samples at 2–16 and set a shutter in (0, 1]", () => {
  const withBlur = (motionBlur: unknown): LaunchComposition =>
    ({
      ...launchTemplate(),
      output: { width: 1920, height: 1080, fps: 60, motionBlur },
    }) as LaunchComposition;
  const issues = (v: unknown) =>
    validateLaunchComposition(withBlur(v)).filter((x) => x.path.startsWith("output.motionBlur"));
  assert.deepEqual(issues({ samples: 4, shutter: 0.5 }), []);
  assert.deepEqual(issues(false), []);
  assert.ok(issues({ samples: 1, shutter: 0.5 }).length);
  assert.ok(issues({ samples: 4.5, shutter: 0.5 }).length);
  assert.ok(issues({ samples: 17, shutter: 0.5 }).length);
  assert.ok(issues({ samples: 4, shutter: 0 }).length);
  assert.ok(issues({ samples: 4, shutter: 1.5 }).length);
  assert.ok(issues({ samples: 4, shutter: 0.5, look: "soft" }).length);
  assert.ok(issues("on").length);
});

test("a shutter sample never crosses a cut: it is held inside its frame's scene", () => {
  const windows = [
    { startS: 0, endS: 2 },
    { startS: 2, endS: 4 },
  ];
  // the first frame of scene 2 (t = 2.0): samples just before 2.0 stay in scene 2
  assert.equal(sceneSampleS(windows, 1.9964, 2), 2);
  assert.equal(sceneSampleS(windows, 2.003, 2), 2.003);
  // the last frame of scene 1: samples past 2.0 stay in scene 1
  assert.ok(sceneSampleS(windows, 2.004, 119 / 60) < 2);
  // inside a scene nothing changes
  assert.equal(sceneSampleS(windows, 1.2, 1.2), 1.2);
});

test("pops, growing type and lines drawing on count as motion", () => {
  const pop = film([
    {
      id: "t",
      type: "text",
      text: "Launch day",
      width: 1600,
      height: 200,
      fontSize: 120,
      units: { by: "word", moves: [{ move: "pop", atS: 0.5 }] },
    },
  ]);
  // a word settling from 1.18× moves its corners a couple of pixels a frame:
  // registered, though one sample is already smooth at that speed
  assert.ok(shutterTravelPx(pop, 0.5)[31]! > 1, "a word settling from 1.18×");
  const grow = film([
    {
      id: "t",
      type: "text",
      text: "Big",
      width: 1600,
      height: 400,
      fontSize: 80,
      animations: [
        {
          property: "fontSize",
          keyframes: [
            { atS: 0, value: 80 },
            { atS: 0.3, value: 160, easing: "linear" },
          ],
        },
      ],
    },
  ]);
  assert.ok(shutterSchedule(grow, { samples: 16, shutter: 0.5 })[9]! > 1, "type growing");
  const draw = film([
    {
      id: "l",
      type: "line",
      points: [
        [-800, 0],
        [800, 0],
      ],
      animations: [
        {
          property: "end",
          keyframes: [
            { atS: 0, value: 0 },
            { atS: 0.5, value: 1, easing: "linear" },
          ],
        },
      ],
    },
  ]);
  assert.ok(
    shutterSchedule(draw, { samples: 16, shutter: 0.5 })[15]! > 4,
    "a line's tip racing across",
  );
});
