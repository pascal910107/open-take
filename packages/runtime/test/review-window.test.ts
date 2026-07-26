// The refine surfaces must model the REAL camera schedule (issue: A/B windows
// and review badges were derived from inAtMs formulas, which a dwell-delayed
// pull-out — departing after prevEnd + pullOutDwellMs and LANDING after its own
// tMs — makes wrong: a reel would cut the late landing mid-settle, and a badge
// would swap before the camera moved).

import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_CURSOR, DEFAULT_FRAMING, type TakeComposition } from "@open-take/compositor";
import { abWindow, buildBadges } from "../src/review.js";

type Ev = TakeComposition["events"][number];

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

// The demo shape that motivated the dwell: a punch with a type, then a
// squeezed pull-out to a wider frame 910ms after the typing ends.
function squeezedComp(): TakeComposition {
  const events = [
    beat(5698, 2.4, { x: 832, y: 732 }, { kind: "type", text: "x", durationMs: 459 }),
    beat(7067, 1.7, { x: 1230, y: 690 }, { kind: "press", keys: "Meta+Enter", durationMs: 1200 }),
  ];
  return {
    output: { width: 1920, height: 1080, fps: 60 },
    source: {
      videoUrl: "/x.mp4",
      videoWidth: 1920,
      videoHeight: 1080,
      viewport: { w: 1920, h: 1080 },
    },
    framing: DEFAULT_FRAMING,
    cursor: { ...DEFAULT_CURSOR }, // shipped defaults: pullOutDwellMs 800
    start: { x: 200, y: 900 },
    events,
    durationMs: 14000,
  };
}

test("abWindow covers a dwell-late landing instead of cutting it mid-settle", () => {
  const comp = squeezedComp();
  // the pull-out departs at prevEnd(6157) + 800 = 6957 and lands a full
  // zoomOutMs later (8297) — the window on beat 2 must reach past that.
  const win = abWindow([comp], 2, false)!;
  assert.ok(win, "window exists");
  assert.ok(win[0] <= 6957 - 1200 + 1, `lead-in before the actual departure (from=${win[0]})`);
  const landMs = 6957 + comp.cursor.zoomOutMs;
  assert.ok(win[1] >= landMs, `window end ${win[1]} reaches the late landing ${landMs}`);
});

test("badges swap on the ACTUAL camera departure, not the inAtMs formula", () => {
  const comp = squeezedComp();
  const badges = buildBadges(comp);
  const b2 = badges.find((b) => b.text.startsWith("BEAT 2/"))!;
  assert.ok(b2, "beat 2 badge exists");
  // legacy formula would open the badge at inAtMs = 7067 − 730 = 6337, while
  // the camera only departs at 6957 (dwell floor).
  assert.equal(Math.round(b2.fromMs), 6957, "badge opens when the camera moves");
});
