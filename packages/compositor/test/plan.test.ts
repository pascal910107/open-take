// planComposition / buildLegs over the full action vocabulary
// (click · type · drag · scroll · hover · press). These are pure functions —
// no browser — so they pin the editorial contract cheaply: scroll/press hold
// the cursor and don't ripple; hover behaves like a click; press frames a
// reveal; durations flow into the timeline.

import { test } from "node:test";
import assert from "node:assert/strict";
import { planComposition } from "../src/plan.js";
import { buildLegs, buildStageKeyframes, keyvalN, restStageScale } from "../src/math.js";
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
