// planComposition / buildLegs over the full action vocabulary
// (click · type · drag · scroll · hover · press). These are pure functions —
// no browser — so they pin the editorial contract cheaply: scroll/press hold
// the cursor and don't ripple; hover behaves like a click; press frames a
// reveal; durations flow into the timeline.

import { test } from "node:test";
import assert from "node:assert/strict";
import { planComposition } from "../src/plan.js";
import { buildLegs, buildStageKeyframes, cursorPos, keyvalN, restStageScale } from "../src/math.js";
import type { CaptureLog } from "../src/types.js";

const VW = 1920,
  VH = 1080;

function log(events: CaptureLog["events"], tEndMs = 8000): CaptureLog {
  return {
    video: { width: VW, height: VH, fps: 60 },
    viewport: { w: VW, h: VH },
    start: { x: 200, y: 900 },
    events,
    tEndMs,
  };
}

test("scroll: never zooms and emits a scroll CompEvent", () => {
  const comp = planComposition(
    log([
      { kind: "click", x: 100, y: 100, box: { x: 80, y: 80, w: 40, h: 40 }, tMs: 1000 },
      { kind: "scroll", x: 960, y: 540, dy: 800, tMs: 2500, durationMs: 1000 },
    ]),
  );
  const scroll = comp.events.find((e) => e.kind === "scroll");
  assert.ok(scroll, "scroll event present");
  assert.equal(scroll!.zoom.enabled, false, "scroll never zooms");
  assert.equal(scroll!.durationMs, 1000, "scroll duration carried through");
});

test("travel is distance-aware: speed held ~constant, clamped to [min,max]", () => {
  // Default cursor: 0.30 widths/s on a 1920-wide stage → 0.576 px/ms; floor
  // 300ms (<173px), cap 1400ms (>806px). Three clicks exercise floor / cap /
  // linear, spaced far enough apart that the anti-overlap clamp never trips.
  const comp = planComposition(
    log([
      { kind: "click", x: 260, y: 940, box: { x: 240, y: 920, w: 40, h: 40 }, tMs: 2000 }, // 72px hop → floor
      { kind: "click", x: 1400, y: 200, box: { x: 1380, y: 180, w: 40, h: 40 }, tMs: 4000 }, // 1359px → cap
      { kind: "click", x: 900, y: 600, box: { x: 880, y: 580, w: 40, h: 40 }, tMs: 6500 }, // 640px → linear
    ]),
  );
  // Pin the cursor model so the test is independent of DEFAULT_CURSOR tuning.
  Object.assign(comp.cursor, { travelWidthsPerSec: 0.3, travelMinMs: 300, travelMaxMs: 1400 });
  const legs = buildLegs(comp);
  const dur = (i: number) => legs[i]!.t1 - legs[i]!.t0;
  assert.ok(Math.abs(dur(0) - 0.3) < 0.02, `short hop floored to min (got ${dur(0).toFixed(3)}s)`);
  assert.ok(Math.abs(dur(1) - 1.4) < 0.02, `long sweep capped to max (got ${dur(1).toFixed(3)}s)`);
  // 640px / 0.576 px/ms ≈ 1.111s — proportional, strictly between the clamps.
  assert.ok(Math.abs(dur(2) - 1.111) < 0.03, `mid travel scales with distance (got ${dur(2).toFixed(3)}s)`);
  assert.ok(dur(0) < dur(2) && dur(2) < dur(1), "duration grows with distance");
});

test("drag easing: 'smooth' replays the baked smootherstep, absent ⇒ linear", () => {
  // A 1000px horizontal stroke. At raw=0.25 the cursor x reveals the easing:
  // linear → 350px (100 + 0.25·1000); smooth → ~203px (smootherstep(0.25)=.104).
  const mk = (ease?: "linear" | "smooth") =>
    planComposition(
      log([
        {
          kind: "drag",
          x: 100,
          y: 500,
          to: { x: 1100, y: 500 },
          path: [
            { x: 100, y: 500 },
            { x: 1100, y: 500 },
          ],
          tMs: 1000,
          durationMs: 1000,
          ...(ease ? { ease } : {}),
        },
      ]),
    );
  const smooth = mk("smooth");
  const linear = mk("linear");
  const absent = mk(undefined);
  for (const c of [smooth, linear, absent]) c.cursor.dragLagMs = 0; // leg = [1.0, 2.0]
  const at = (c: ReturnType<typeof mk>) => cursorPos(1.25, buildLegs(c), c).x; // raw 0.25
  assert.ok(Math.abs(at(linear) - 350) < 1, `linear holds constant speed (got ${at(linear)})`);
  assert.ok(Math.abs(at(absent) - 350) < 1, "absent ease ⇒ linear (legacy)");
  assert.ok(Math.abs(at(smooth) - 203.5) < 3, `smooth eases in (got ${at(smooth)})`);
});

test("zoom-out: an off-centre zoom lands the centre on rest before the scale", () => {
  // First click orients (no zoom); the second is a small off-centre target → it
  // zooms in, then the final zoom-out must settle the CENTRE to rest before the
  // scale finishes, else the tightening centre clamp catches it (a two-stage
  // stutter). The fix adds one centre-only keyframe at the fill-threshold cross.
  const comp = planComposition(
    log([
      { kind: "click", x: 960, y: 540, box: { x: 940, y: 520, w: 40, h: 40 }, tMs: 1000 },
      { kind: "click", x: 300, y: 200, box: { x: 290, y: 190, w: 20, h: 20 }, tMs: 3000 },
    ]),
  );
  const stage = buildStageKeyframes(comp);
  const zoomed = comp.events.some((e) => e.kind === "click" && e.zoom.enabled && e.tMs === 3000);
  assert.ok(zoomed, "second click zooms (off-centre target)");
  // the fix adds exactly one centre-only keyframe (centre settles early); scale
  // keeps its single smooth zoom-out segment.
  assert.equal(stage.c.length, stage.z.length + 1, "one extra centre-only keyframe");
  // by the time the scale reaches rest (zoom-out end), the centre is ALREADY on
  // video-centre — so the clamp never catches a still-panning centre.
  const [cx, cy] = [comp.source.videoWidth / 2, comp.source.videoHeight / 2];
  const scaleRestT = stage.z[stage.z.length - 2]![0]; // zoom-out end (before padding)
  const before = stage.c.filter(([t]) => t < scaleRestT - 1e-6);
  const landed = before[before.length - 1]![1];
  assert.ok(
    Math.abs(landed.x - cx) < 1 && Math.abs(landed.y - cy) < 1,
    `centre is on rest (${landed.x},${landed.y}) before the scale finishes`,
  );
});

test("zoom easing: keyvalN applies the supplied curve (default smootherstep)", () => {
  const kfs: [number, number][] = [
    [0, 0],
    [1, 100],
  ];
  const dflt = keyvalN(0.25, kfs); // smootherstep(0.25)=0.104 → ~10.4
  const lin = keyvalN(0.25, kfs, (u) => u); // linear → 25
  assert.ok(Math.abs(dflt - 10.35) < 0.5, `default is smootherstep (got ${dflt})`);
  assert.ok(Math.abs(lin - 25) < 0.01, `custom ease is applied (got ${lin})`);
  assert.ok(dflt < lin, "smootherstep eases in (slower than linear early)");
});

test("scroll: cursor holds — no travel leg, parks at the prior anchor", () => {
  const comp = planComposition(
    log([
      { kind: "click", x: 300, y: 300, box: { x: 280, y: 280, w: 40, h: 40 }, tMs: 1000 },
      { kind: "scroll", x: 960, y: 540, dy: 600, tMs: 2500, durationMs: 1000 },
      { kind: "click", x: 500, y: 500, box: { x: 480, y: 480, w: 40, h: 40 }, tMs: 4500 },
    ]),
  );
  const legs = buildLegs(comp);
  // 2 clicks → 2 travel legs; the scroll adds none.
  assert.equal(legs.length, 2, "scroll contributes no leg");
});

test("press: cursor holds and keys are preserved for editability", () => {
  const comp = planComposition(
    log([
      {
        kind: "type",
        x: 400,
        y: 200,
        box: { x: 380, y: 180, w: 200, h: 40 },
        tMs: 1000,
        text: "hello",
        durationMs: 800,
      },
      { kind: "press", x: 960, y: 540, keys: "Enter", tMs: 2200, durationMs: 1000 },
    ]),
  );
  const press = comp.events.find((e) => e.kind === "press");
  assert.ok(press);
  assert.equal(press!.keys, "Enter");
  // type → 1 travel leg; press → none.
  assert.equal(buildLegs(comp).length, 1, "press contributes no leg");
});

test("press with a reveal bbox frames it (zoom enabled)", () => {
  const comp = planComposition(
    log([
      { kind: "click", x: 100, y: 100, box: { x: 80, y: 80, w: 40, h: 40 }, tMs: 1000 },
      // a small centred palette revealed by ⌘K
      {
        kind: "press",
        x: 960,
        y: 400,
        keys: "Meta+k",
        box: { x: 760, y: 300, w: 400, h: 200 },
        tMs: 2500,
        durationMs: 1400,
      },
    ]),
    { zoomFirst: false },
  );
  const press = comp.events.find((e) => e.kind === "press")!;
  assert.equal(press.zoom.enabled, true, "reveal bbox → zoom in");
  assert.ok(press.zoom.scale > 1, "scale above rest");
});

test("press with no reveal does not zoom", () => {
  const comp = planComposition(
    log([
      { kind: "click", x: 100, y: 100, box: { x: 80, y: 80, w: 40, h: 40 }, tMs: 1000 },
      { kind: "press", x: 960, y: 540, keys: "Escape", tMs: 2500, durationMs: 900 },
    ]),
  );
  const press = comp.events.find((e) => e.kind === "press")!;
  assert.equal(press.zoom.enabled, false, "bare press holds full view");
});

test("hover: travels like a click and holds its dwell", () => {
  const comp = planComposition(
    log([
      { kind: "click", x: 100, y: 100, box: { x: 80, y: 80, w: 40, h: 40 }, tMs: 1000 },
      // a small control → bbox-fit zoom is meaningful
      {
        kind: "hover",
        x: 900,
        y: 500,
        box: { x: 880, y: 480, w: 40, h: 40 },
        tMs: 3000,
        durationMs: 1200,
        zoom: "always",
      },
    ]),
  );
  const hover = comp.events.find((e) => e.kind === "hover")!;
  assert.equal(hover.durationMs, 1200, "dwell carried through");
  assert.equal(hover.zoom.enabled, true, "hover can zoom (zoom=always honored)");
  // click + hover → 2 travel legs (hover is pointer-driven).
  assert.equal(buildLegs(comp).length, 2, "hover contributes a travel leg");
});

test("stage keyframes hold the press reveal through its dwell", () => {
  const comp = planComposition(
    log([
      { kind: "click", x: 100, y: 100, box: { x: 80, y: 80, w: 40, h: 40 }, tMs: 1000 },
      {
        kind: "press",
        x: 960,
        y: 400,
        keys: "Meta+k",
        box: { x: 760, y: 300, w: 400, h: 200 },
        tMs: 2500,
        durationMs: 1400,
      },
    ]),
  );
  const stage = buildStageKeyframes(comp);
  // the zoom target scale should appear and be held: find the max scale keyframe
  const maxScale = Math.max(...stage.z.map(([, s]) => s));
  assert.ok(maxScale > 1, "stage zooms in for the reveal");
});

test("a zoom followed by a scroll returns to full view through the scroll", () => {
  const comp = planComposition(
    log([
      // small control, zoom=always → meaningful zoom-in
      {
        kind: "click",
        x: 200,
        y: 200,
        box: { x: 190, y: 190, w: 30, h: 30 },
        tMs: 1000,
        zoom: "always",
      },
      { kind: "scroll", x: 960, y: 540, dy: 900, tMs: 3000, durationMs: 1000 },
    ]),
  );
  const stage = buildStageKeyframes(comp);
  const rest = restStageScale(
    VW,
    VH,
    comp.output.width,
    comp.output.height,
    comp.framing.insetFrac,
  );
  const atClick = keyvalN(1.0, stage.z); // zoomed in at the click
  const midScroll = keyvalN(3.5, stage.z); // mid-scroll → must be back at rest
  assert.ok(atClick > rest + 0.05, `expected zoom-in at click (${atClick} vs rest ${rest})`);
  assert.ok(Math.abs(midScroll - rest) < 1e-2, `expected rest mid-scroll, got ${midScroll}`);
});

test("durations flow into total composition length (scroll/hover/press)", () => {
  const comp = planComposition(
    log(
      [
        {
          kind: "hover",
          x: 900,
          y: 500,
          box: { x: 880, y: 480, w: 40, h: 40 },
          tMs: 1000,
          durationMs: 1500,
        },
        { kind: "scroll", x: 960, y: 540, dy: 800, tMs: 3000, durationMs: 1200 },
        { kind: "press", x: 960, y: 540, keys: "Enter", tMs: 5000, durationMs: 1000 },
      ],
      0, // force the duration to be derived from the last action, not tEndMs
    ),
  );
  // last press ends at 6000ms; total must exceed it (+ hold + zoomout + pad).
  assert.ok(comp.durationMs > 6000, `expected > 6000ms, got ${comp.durationMs}`);
});
