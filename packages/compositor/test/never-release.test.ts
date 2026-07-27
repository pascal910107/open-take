// A disabled beat means FULL VIEW — the director only ever disables a beat to
// show it wide (a `zoom:"never"` global payoff, a dropped punch). The schedule
// used to rest-anchor only scroll + disabled press; a disabled CLICK after a
// zoomed beat silently HELD the zoom, cropping the exact payoff the author
// asked to show wide (2026-07-27 interlinear field run, beat 4). These pin the
// fix — and pin that an already-resting camera stays anchor-free, so legacy
// compositions without the pattern keep their exact schedule (badges, A/B
// windows, rendered pixels).

import assert from "node:assert/strict";
import { test } from "node:test";
import { buildStageKeyframes, cameraRampSchedule } from "../src/math.js";
import type { TakeComposition } from "../src/types.js";
import { DEFAULT_CURSOR, DEFAULT_FRAMING } from "../src/types.js";

const VW = 1920,
  VH = 1080;

type Ev = TakeComposition["events"][number];

function comp(events: Ev[]): TakeComposition {
  const durationMs =
    Math.max(...events.map((e) => e.tMs + (e.durationMs ?? 0))) +
    DEFAULT_CURSOR.holdMs +
    DEFAULT_CURSOR.zoomOutMs +
    3000;
  return {
    output: { width: VW, height: VH, fps: 60 },
    source: { videoUrl: "/x.mp4", videoWidth: VW, videoHeight: VH, viewport: { w: VW, h: VH } },
    framing: DEFAULT_FRAMING,
    cursor: { ...DEFAULT_CURSOR },
    start: { x: 200, y: 900 },
    events,
    durationMs,
  };
}

function beat(
  tMs: number,
  scale: number,
  center: { x: number; y: number },
  extra: Partial<Ev> = {},
): Ev {
  return {
    kind: "click",
    tMs,
    point: center,
    zoom: {
      enabled: scale > 1,
      scale,
      center,
      inAtMs: Math.max(0, tMs - DEFAULT_CURSOR.zoomInMs),
      reason: "test",
    },
    ...extra,
  } as Ev;
}

// scale 1 in beat() ⇒ enabled:false — a "never" beat.
const zoomThenNeverClick = () => [
  beat(4000, 1.8, { x: 700, y: 400 }, { durationMs: 300 }),
  beat(8000, 1, { x: 1200, y: 700 }, { durationMs: 300 }),
];

test("a never-click after a zoomed beat pulls the camera back to rest", () => {
  const c = comp(zoomThenNeverClick());
  const ramps = cameraRampSchedule(c);
  assert.ok(ramps[1], "the disabled click is a camera anchor (it releases the zoom)");
  // the released framing IS rest: some keyframe in the ramp window carries the
  // exact opening rect (kfs[0] is restR by construction).
  const { r } = buildStageKeyframes(c);
  const rest = r[0]![1];
  const land = ramps[1]!.landMs / 1000;
  const atLand = r.find((k) => Math.abs(k[0] - land) < 0.02);
  assert.ok(atLand, "a keyframe lands the release");
  assert.ok(
    Math.abs(atLand![1].w - rest.w) < 1e-6 &&
      Math.abs(atLand![1].cx - rest.cx) < 1e-6 &&
      Math.abs(atLand![1].cy - rest.cy) < 1e-6,
    `the landing rect is the rest rect (got w=${atLand![1].w} vs rest ${rest.w})`,
  );
  // and it paces as a pull-out: departure no later than tMs (never a post-hoc snap)
  assert.ok(ramps[1]!.startMs <= c.events[1]!.tMs, "release departs by the beat's action");
});

test("a never-click over an already-resting camera stays anchor-free (legacy byte-compat)", () => {
  const c = comp([
    beat(4000, 1, { x: 700, y: 400 }, { durationMs: 300 }),
    beat(8000, 1, { x: 1200, y: 700 }, { durationMs: 300 }),
  ]);
  const ramps = cameraRampSchedule(c);
  assert.equal(ramps[0], null, "no anchor for a rest-over-rest click");
  assert.equal(ramps[1], null, "no anchor for a rest-over-rest click");
});

test("a disabled press still anchors to rest even from rest (existing behavior pinned)", () => {
  const c = comp([
    beat(4000, 1, { x: 700, y: 400 }, { kind: "press", keys: "Escape", durationMs: 200 }),
  ]);
  const ramps = cameraRampSchedule(c);
  assert.ok(ramps[0], "disabled press keeps its rest anchor");
});
