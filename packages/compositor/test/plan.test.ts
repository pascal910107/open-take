// planComposition / buildLegs over the full action vocabulary
// (click · type · drag · scroll · hover · press). These are pure functions —
// no browser — so they pin the editorial contract cheaply: scroll/press hold
// the cursor and don't ripple; hover behaves like a click; press frames a
// reveal; durations flow into the timeline.

import { test } from "node:test";
import assert from "node:assert/strict";
import { planComposition } from "../src/plan.js";
import { buildLegs, cursorPos, keyvalN, stageCamera } from "../src/math.js";
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

test("final zoom-out: one eased rect — centre and viewport travel in lockstep", () => {
  // First click orients (no zoom); the second is a small off-centre target → it
  // zooms in, then the final zoom-out is ONE eased viewport-rect segment:
  // centre and viewport width share the same eased parameter at every instant
  // (single-phase — the old dual-track model produced a pan-then-zoom lurch),
  // and the screen distance of the departed frame's centre shrinks monotonically.
  const comp = planComposition(
    log([
      { kind: "click", x: 960, y: 540, box: { x: 940, y: 520, w: 40, h: 40 }, tMs: 1000 },
      { kind: "click", x: 300, y: 200, box: { x: 290, y: 190, w: 20, h: 20 }, tMs: 3000 },
    ]),
  );
  const zoomed = comp.events.some((e) => e.kind === "click" && e.zoom.enabled && e.tMs === 3000);
  assert.ok(zoomed, "second click zooms (off-centre target)");
  const cam = stageCamera(comp);
  const e = comp.events[1]!;
  const t0 = (e.tMs + comp.cursor.holdMs) / 1000; // hold end = zoom-out start
  const t1 = t0 + comp.cursor.zoomOutMs / 1000; // zoom-out end
  const oW = comp.output.width;
  const a = cam.at(t0);
  const b = cam.at(t1 + 1e-3);
  assert.ok(Math.abs(b.scale - cam.rest) < 1e-6, "scale lands on rest");
  assert.ok(
    Math.abs(b.center.x - VW / 2) < 1e-6 && Math.abs(b.center.y - VH / 2) < 1e-6,
    "centre lands on video-centre WITH the scale (same segment end)",
  );
  const w0 = oW / a.scale;
  const w1 = oW / b.scale;
  // the arriving framing's centre (video-centre) must approach the frame
  // centre MONOTONICALLY on screen — no wrong-way swing, ever (rect-lerp
  // guarantees it; the old dual-track model violated it).
  let prev = Number.POSITIVE_INFINITY;
  for (let k = 1; k <= 20; k++) {
    const { scale, center } = cam.at(t0 + (k / 20) * (t1 - t0));
    const uw = (oW / scale - w0) / (w1 - w0);
    const uc = (center.x - a.center.x) / (b.center.x - a.center.x);
    assert.ok(Math.abs(uw - uc) < 1e-9, `lockstep at k=${k}: u_width ${uw} vs u_centre ${uc}`);
    const d = Math.hypot((VW / 2 - center.x) * scale, (VH / 2 - center.y) * scale);
    assert.ok(d <= prev + 1e-9, `target approaches monotonically at k=${k} (${d} > ${prev})`);
    prev = d;
  }
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
  // the zoom target scale should appear and be held
  assert.ok(stageCamera(comp).peakScale > 1, "stage zooms in for the reveal");
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
  const cam = stageCamera(comp);
  const rest = cam.rest;
  const atClick = cam.at(1.0).scale; // zoomed in at the click
  const midScroll = cam.at(3.5).scale; // mid-scroll → must be back at rest
  assert.ok(atClick > rest + 0.05, `expected zoom-in at click (${atClick} vs rest ${rest})`);
  assert.ok(Math.abs(midScroll - rest) < 1e-2, `expected rest mid-scroll, got ${midScroll}`);
});

test("legacy zoomEase (bezier) is still honored over the default spring", () => {
  const comp = planComposition(
    log([
      { kind: "click", x: 960, y: 540, box: { x: 940, y: 520, w: 40, h: 40 }, tMs: 1000 },
      { kind: "click", x: 300, y: 200, box: { x: 290, y: 190, w: 20, h: 20 }, tMs: 3000 },
    ]),
  );
  const legacy = { ...comp, cursor: { ...comp.cursor, zoomEase: [0.3, 0, 0.2, 1] as [number, number, number, number] } };
  // sample mid-ramp of the second beat's punch-in: the two curves must differ
  const e = comp.events[1]!;
  const tm = (e.zoom.inAtMs + (e.tMs - e.zoom.inAtMs) * 0.25) / 1000;
  const sSpring = stageCamera(comp).at(tm).scale;
  const sBezier = stageCamera(legacy).at(tm).scale;
  assert.ok(
    Math.abs(sSpring - sBezier) > 1e-3,
    `zoomEase must change the curve (spring ${sSpring} vs bezier ${sBezier})`,
  );
});

test("pull-out overlapped by the previous action still gets a real ramp (no jump cut)", () => {
  // The type's payoff (durationMs) runs PAST the scroll's zoomOutMs window —
  // the ramp must shorten, never collapse to a 1ms jump cut.
  const comp = planComposition(
    log([
      {
        kind: "type",
        x: 960,
        y: 172,
        box: { x: 641, y: 150, w: 300, h: 44 },
        tMs: 1000,
        text: "abc",
        durationMs: 3000,
        zoom: "always",
      },
      { kind: "scroll", x: 960, y: 540, dy: 600, tMs: 2500, durationMs: 800 },
    ]),
  );
  const cam = stageCamera(comp);
  // max per-30fps-frame scale step through the whole timeline stays gradual
  let maxStep = 0;
  for (let t = 0; t < cam.T; t += 1 / 30) {
    maxStep = Math.max(maxStep, Math.abs(cam.at(t + 1 / 30).scale - cam.at(t).scale));
  }
  assert.ok(
    maxStep < 0.35,
    `no frame-to-frame scale jump (worst step ${maxStep.toFixed(3)}/frame)`,
  );
});

test("spring overshoot cannot collapse the viewport (extreme bounce + deep zoom)", () => {
  const comp = planComposition(
    log([{ kind: "click", x: 960, y: 540, box: { x: 950, y: 530, w: 20, h: 20 }, tMs: 2000 }]),
  );
  const e = comp.events[0]!;
  const wild = {
    ...comp,
    cursor: { ...comp.cursor, zoomSpring: 0.59 },
    events: [{ ...e, zoom: { ...e.zoom, enabled: true, scale: 5, center: { x: 960, y: 540 } } }],
  };
  const cam = stageCamera(wild);
  for (let t = 0; t < cam.T; t += 0.01) {
    const s = cam.at(t).scale;
    assert.ok(s > 0 && s < 12, `scale stays sane at t=${t.toFixed(2)} (got ${s})`);
  }
});

test("a hand-set inAtMs stays live for a pull-out beat", () => {
  const comp = planComposition(
    log([
      {
        kind: "click",
        x: 300,
        y: 200,
        box: { x: 290, y: 190, w: 20, h: 20 },
        tMs: 2000,
        zoom: "always",
      },
      { kind: "scroll", x: 960, y: 540, dy: 600, tMs: 8000, durationMs: 500 },
    ]),
  );
  const custom = {
    ...comp,
    events: comp.events.map((e, i) =>
      i === 1 ? { ...e, zoom: { ...e.zoom, inAtMs: 7600 } } : e,
    ),
  };
  // default: pull-out paces with zoomOutMs (starts ~ tMs−1340); custom: 7600.
  const sDefault = stageCamera(comp).at(7.0).scale;
  const sCustom = stageCamera(custom).at(7.0).scale;
  assert.ok(sDefault < stageCamera(comp).peakScale - 0.05, "default pull-out already moving at 7.0s");
  assert.ok(
    Math.abs(sCustom - stageCamera(custom).peakScale) < 1e-6,
    `custom inAtMs 7600 ⇒ still holding at 7.0s (got ${sCustom})`,
  );
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
