// planComposition / buildLegs over the full action vocabulary
// (click · type · drag · scroll · hover · press). These are pure functions —
// no browser — so they pin the editorial contract cheaply: scroll/press hold
// the cursor and don't ripple; hover behaves like a click; press frames a
// reveal; durations flow into the timeline.

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildLegs,
  cameraRampSchedule,
  carryWindow,
  cursorPos,
  ghostCardLines,
  isDragging,
  keyvalN,
  stageCamera,
} from "../src/math.js";
import { planComposition } from "../src/plan.js";
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
  // ...and hold the camera at REST so this test covers the DISTANCE law alone.
  // Travel is also zoom-aware (a punched-in camera stretches the same video-px
  // move over more of the delivered frame) — that factor gets its own test below.
  for (const e of comp.events) e.zoom.enabled = false;
  const legs = buildLegs(comp);
  const dur = (i: number) => legs[i]!.t1 - legs[i]!.t0;
  assert.ok(Math.abs(dur(0) - 0.3) < 0.02, `short hop floored to min (got ${dur(0).toFixed(3)}s)`);
  assert.ok(Math.abs(dur(1) - 1.4) < 0.02, `long sweep capped to max (got ${dur(1).toFixed(3)}s)`);
  // 640px / 0.576 px/ms ≈ 1.111s — proportional, strictly between the clamps.
  assert.ok(
    Math.abs(dur(2) - 1.111) < 0.03,
    `mid travel scales with distance (got ${dur(2).toFixed(3)}s)`,
  );
  assert.ok(dur(0) < dur(2) && dur(2) < dur(1), "duration grows with distance");
});

test("travel is zoom-aware: a punched-in camera stretches the same move", () => {
  // "On-screen speed" is what the VIEWER reads, and the viewer reads the
  // DELIVERED frame — not the raw recording. The same hop, twice: camera at
  // rest, then punched in. The invariant is the on-screen DISTANCE, so the two
  // legs must cover the same amount of delivered frame — else a 2x punch-in
  // reads ~2x too fast precisely where the viewer is looking closest.
  const mk = (zoomed: boolean) => {
    const comp = planComposition(
      log([{ kind: "click", x: 200, y: 260, box: { x: 180, y: 240, w: 40, h: 40 }, tMs: 6000 }]),
    );
    // Cap out of the way — this test is about the speed law, not the clamps.
    Object.assign(comp.cursor, { travelWidthsPerSec: 0.3, travelMinMs: 300, travelMaxMs: 5000 });
    const e = comp.events[0]!;
    e.zoom = zoomed
      ? { ...e.zoom, enabled: true, scale: 2, center: { x: 200, y: 260 } }
      : { ...e.zoom, enabled: false };
    return comp;
  };
  const rest = mk(false);
  const zoom = mk(true);
  const leg = (c: ReturnType<typeof mk>) => buildLegs(c)[0]!;
  const dur = (c: ReturnType<typeof mk>) => leg(c).t1 - leg(c).t0;
  const cam = stageCamera(zoom);
  const scaleAtArrival = cam.at(6).scale;
  assert.ok(scaleAtArrival > 1.8, `the camera really is punched in (${scaleAtArrival.toFixed(2)})`);
  assert.ok(dur(zoom) > dur(rest) * 1.2, "a punch-in visibly stretches the move");

  // THE CONTRACT: integrate the camera's magnification (relative to rest) over
  // the leg the model actually produced — that integral IS the delivered-frame
  // distance in rest-equivalent seconds, so it must equal the rest leg's plain
  // duration. Sampling the camera at ONE instant cannot satisfy this whenever
  // the camera moves during the travel.
  const lg = leg(zoom);
  const N = 20000;
  let onScreen = 0;
  for (let i = 0; i < N; i++) {
    const t = lg.t0 + ((i + 0.5) / N) * (lg.t1 - lg.t0);
    onScreen += (cam.rest / cam.at(t).scale) * ((lg.t1 - lg.t0) / N);
  }
  assert.ok(
    Math.abs(onScreen - dur(rest)) < 0.005,
    `the zoomed leg covers the same on-screen distance (${onScreen.toFixed(3)}s-equivalent vs ${dur(rest).toFixed(3)}s at rest)`,
  );

  // …and specifically NOT the arrival-priced duration: the camera is still wide
  // for the first part of this leg (it departs before the zoom-in ramp does),
  // so pricing the whole move at its landing magnification over-slows it.
  const arrivalPriced = dur(rest) / (cam.rest / scaleAtArrival);
  assert.ok(
    dur(zoom) < arrivalPriced * 0.97,
    `not priced at the landing frame alone (got ${dur(zoom).toFixed(3)}s, arrival-priced would be ${arrivalPriced.toFixed(3)}s)`,
  );

  // A composition the camera never leaves rest on is bit-identical to the
  // pre-zoom-aware model — 640px / (0.3·1920) px/ms.
  assert.ok(Math.abs(dur(rest) - 1.111) < 0.01, `rest travel unchanged (got ${dur(rest)})`);
});

test("a held frame prices like the frame it holds (no ramp during the leg)", () => {
  // The mirror of the test above: when the camera does NOT move across the
  // travel — a zoomed beat followed by another beat at the SAME framing — the
  // integral degenerates to that one constant magnification, so the leg is
  // exactly restScale/cameraScale slower. The integrated model must not
  // "correct" a leg that has nothing to correct.
  const comp = planComposition(
    log(
      [
        { kind: "click", x: 1500, y: 300, box: { x: 1480, y: 280, w: 40, h: 40 }, tMs: 2000 },
        { kind: "click", x: 1560, y: 420, box: { x: 1540, y: 400, w: 40, h: 40 }, tMs: 6000 },
      ],
      9000,
    ),
  );
  Object.assign(comp.cursor, { travelWidthsPerSec: 0.3, travelMinMs: 300, travelMaxMs: 5000 });
  // Both beats framed identically → one ramp in, then a long hold across leg 1.
  const frame = { enabled: true, scale: 2, center: { x: 1530, y: 360 } };
  comp.events[0]!.zoom = { ...comp.events[0]!.zoom, ...frame };
  comp.events[1]!.zoom = { ...comp.events[1]!.zoom, ...frame };
  const lg = buildLegs(comp)[1]!;
  const cam = stageCamera(comp);
  const held = cam.rest / cam.at(lg.t1).scale;
  const dist = Math.hypot(
    comp.events[1]!.point.x - comp.events[0]!.point.x,
    comp.events[1]!.point.y - comp.events[0]!.point.y,
  );
  const want = dist / (comp.cursor.travelWidthsPerSec * comp.source.videoWidth) / held;
  assert.ok(cam.at(lg.t0).scale > 1.8, "the camera is already punched in when the leg departs");
  assert.ok(
    Math.abs(lg.t1 - lg.t0 - want) < 0.01,
    `a held frame is priced at that frame (got ${(lg.t1 - lg.t0).toFixed(3)}s, want ${want.toFixed(3)}s)`,
  );
});

test("a scroll's pan parks the cursor for its whole duration", () => {
  // A scroll contributes no leg (the content moves, not the pointer) — but its
  // durationMs IS the pan, and a travel departing into it puts two motions on
  // screen at once: content sliding under a cursor crossing it. The pointer
  // waits for the page to stop.
  const comp = planComposition(
    log(
      [
        { kind: "click", x: 200, y: 200, box: { x: 180, y: 180, w: 40, h: 40 }, tMs: 1000 },
        { kind: "scroll", x: 960, y: 540, dy: 900, tMs: 2000, durationMs: 1500 },
        { kind: "click", x: 1700, y: 900, box: { x: 1680, y: 880, w: 40, h: 40 }, tMs: 4000 },
      ],
      9000,
    ),
  );
  Object.assign(comp.cursor, { travelWidthsPerSec: 0.3, travelMinMs: 300, travelMaxMs: 5000 });
  for (const e of comp.events) e.zoom.enabled = false; // isolate the timing law
  const legs = buildLegs(comp);
  assert.equal(legs.length, 2, "the scroll contributes no travel leg");
  // ~1655px of wanted travel ≈ 2.87s → an unclamped departure at ~1.13s, i.e.
  // most of a second INSIDE the pan. Only the scroll's action-end clamp holds it.
  assert.ok(
    Math.abs(legs[1]!.t0 - 3.5) < 1e-6,
    `departure held to the pan's end (got ${legs[1]!.t0.toFixed(3)}s)`,
  );
  const mid = cursorPos(2.75, legs, comp);
  assert.ok(
    Math.abs(mid.x - 200) < 1 && Math.abs(mid.y - 200) < 1,
    `mid-pan the cursor is still parked where it clicked (got ${mid.x.toFixed(0)},${mid.y.toFixed(0)})`,
  );
});

test("a press's reveal parks the cursor for its whole duration", () => {
  // Same contract for a keypress: durationMs is the reveal animating in (a
  // palette, a result list), usually with the camera riding it. A cursor
  // gliding across that window competes with the payoff.
  const comp = planComposition(
    log(
      [
        { kind: "click", x: 200, y: 200, box: { x: 180, y: 180, w: 40, h: 40 }, tMs: 1000 },
        { kind: "press", keys: "Meta+k", x: 960, y: 540, tMs: 2000, durationMs: 1400 },
        { kind: "click", x: 1700, y: 900, box: { x: 1680, y: 880, w: 40, h: 40 }, tMs: 4000 },
      ],
      9000,
    ),
  );
  Object.assign(comp.cursor, { travelWidthsPerSec: 0.3, travelMinMs: 300, travelMaxMs: 5000 });
  for (const e of comp.events) e.zoom.enabled = false;
  const legs = buildLegs(comp);
  assert.equal(legs.length, 2, "the press contributes no travel leg");
  assert.ok(
    Math.abs(legs[1]!.t0 - 3.4) < 1e-6,
    `departure held to the reveal's end (got ${legs[1]!.t0.toFixed(3)}s)`,
  );
});

test("a beat landing exactly on the previous action's end still has a cursor", () => {
  // The action-end barrier can coincide EXACTLY with the next arrival — a type
  // that runs to 3000ms and a click captured at 3000ms is an ordinary
  // recording — which builds a zero-span leg. The ease then divides 0/0, and a
  // NaN position blanks the cursor for that frame (and every drawing that
  // reads it). The parking fallback must take over instead.
  const comp = planComposition(
    log([
      {
        kind: "type",
        x: 300,
        y: 300,
        box: { x: 200, y: 280, w: 200, h: 40 },
        tMs: 1000,
        text: "hi",
        durationMs: 2000, // typing runs 1.0s → 3.0s
      },
      { kind: "click", x: 1700, y: 800, box: { x: 1680, y: 780, w: 40, h: 40 }, tMs: 3000 },
    ]),
  );
  const legs = buildLegs(comp);
  const last = legs[legs.length - 1]!;
  assert.equal(last.t0, last.t1, "the barrier and the arrival coincide — a zero-span leg");
  for (const t of [2.999, 3.0, 3.001]) {
    const p = cursorPos(t, legs, comp);
    assert.ok(
      Number.isFinite(p.x) && Number.isFinite(p.y),
      `cursorPos(${t}) is a real point (got ${p.x},${p.y})`,
    );
  }
  const at = cursorPos(3.0, legs, comp);
  assert.ok(Math.abs(at.x - 1700) < 1 && Math.abs(at.y - 800) < 1, "a zero-span leg has landed");
});

test("a travel never starts before the previous ACTION ends, only its leg", () => {
  // A travel leg ENDS at its tMs, but a `type` keeps emitting keystrokes for
  // durationMs after that. Clamping the next departure to the previous LEG's
  // arrival would let a long enough glide drag the pointer off the field
  // mid-word — the cursor must stay parked until the typing is done.
  const comp = planComposition(
    log([
      {
        kind: "type",
        x: 300,
        y: 300,
        box: { x: 200, y: 280, w: 200, h: 40 },
        tMs: 2000,
        text: "a-long-project-name",
        durationMs: 2000, // typing runs 2.0s → 4.0s
      },
      { kind: "click", x: 1700, y: 800, box: { x: 1680, y: 780, w: 40, h: 40 }, tMs: 5000 },
    ]),
  );
  Object.assign(comp.cursor, { travelWidthsPerSec: 0.3, travelMinMs: 300, travelMaxMs: 5000 });
  for (const e of comp.events) e.zoom.enabled = false; // isolate the timing law
  const legs = buildLegs(comp);
  assert.equal(legs.length, 2, "type and click each contribute one travel leg");
  // 1486px / 0.576 px/ms ≈ 2.58s of wanted travel → an unclamped departure at
  // 2.42s, i.e. 1.58s INSIDE the typing. The previous leg landed way back at 2.0s,
  // so only the action-end clamp can hold it.
  assert.equal(legs[0]!.t1, 2, "the type's own travel lands at its tMs");
  assert.ok(
    Math.abs(legs[1]!.t0 - 4) < 1e-6,
    `departure held to the typing's end (got ${legs[1]!.t0.toFixed(3)}s)`,
  );
  // The user-visible contract: mid-word, the cursor is still on the field.
  const mid = cursorPos(3, legs, comp);
  assert.ok(
    Math.abs(mid.x - 300) < 1e-6 && Math.abs(mid.y - 300) < 1e-6,
    `cursor parked on the field mid-typing (got ${mid.x},${mid.y})`,
  );
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
  // This test pins the LERPED rect-track geometry (exact keyframe landings).
  // The shipped default settle tail lands asymptotically — its own contract is
  // pinned in settle.test.ts; here it would blur the endpoint equalities.
  comp.cursor = { ...comp.cursor, zoomSettleFrac: 0 };
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

test("press zoom departs AT the keypress and lands after it (reveal timing)", () => {
  // A ⌘K palette exists only AFTER the keypress: the camera must not commit
  // its punch into the reveal's future rect before anything is on screen.
  const comp = planComposition(
    log([
      { kind: "click", x: 100, y: 100, box: { x: 80, y: 80, w: 40, h: 40 }, tMs: 1000 },
      {
        kind: "press",
        x: 960,
        y: 400,
        keys: "Meta+k",
        box: { x: 760, y: 300, w: 400, h: 200 },
        tMs: 3000,
        durationMs: 1400,
      },
    ]),
  );
  const press = comp.events.find((e) => e.kind === "press")!;
  assert.equal(press.zoom.inAtMs, press.tMs, "departure pinned at the keypress, not before");
  const ramp = cameraRampSchedule(comp)[comp.events.indexOf(press)]!;
  assert.ok(Math.abs(ramp.startMs - press.tMs) < 1, "schedule departs at tMs");
  assert.ok(
    Math.abs(ramp.landMs - (press.tMs + comp.cursor.zoomInMs)) < 1,
    `full ramp runs AFTER the departure (landed ${ramp.landMs})`,
  );
  const cam = stageCamera(comp);
  const atKey = cam.at(press.tMs / 1000).scale;
  assert.ok(
    Math.abs(atKey - cam.rest) < 0.02,
    `frame still at rest when the key goes down (got ${atKey} vs rest ${cam.rest})`,
  );
  const landed = cam.at((press.tMs + comp.cursor.zoomInMs + 300) / 1000).scale;
  assert.ok(landed > cam.rest + 0.2, `zoomed once the reveal ramp lands (got ${landed})`);
});

test("crowded reveal ramp shrinks — never departs before the keypress", () => {
  const comp = planComposition(
    log([
      { kind: "click", x: 100, y: 100, box: { x: 80, y: 80, w: 40, h: 40 }, tMs: 1000 },
      {
        kind: "press",
        x: 960,
        y: 400,
        keys: "Meta+k",
        box: { x: 760, y: 300, w: 400, h: 200 },
        tMs: 3000,
      },
      // next punch departs at 4300 − zoomInMs = 3570 — inside the press's full
      // 730ms window, so the press ramp must shrink toward it, not start early.
      {
        kind: "click",
        x: 900,
        y: 380,
        box: { x: 880, y: 360, w: 40, h: 40 },
        tMs: 4300,
        zoom: "always",
      },
    ]),
  );
  const ramps = cameraRampSchedule(comp);
  const i = comp.events.findIndex((e) => e.kind === "press");
  const press = comp.events[i]!;
  const ramp = ramps[i]!;
  const nextStart = ramps[i + 1]!.startMs;
  assert.ok(Math.abs(ramp.startMs - press.tMs) < 1, "departure stays pinned at the keypress");
  assert.ok(
    ramp.landMs <= nextStart,
    `landing ${ramp.landMs} yields to the next departure ${nextStart}`,
  );
  assert.ok(ramp.landMs - ramp.startMs > 200, "still a real ramp, not a jump cut");
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
  const legacy = {
    ...comp,
    cursor: { ...comp.cursor, zoomEase: [0.3, 0, 0.2, 1] as [number, number, number, number] },
  };
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
    events: comp.events.map((e, i) => (i === 1 ? { ...e, zoom: { ...e.zoom, inAtMs: 7600 } } : e)),
  };
  // default: pull-out paces with zoomOutMs (starts ~ tMs−1340); custom: 7600.
  const sDefault = stageCamera(comp).at(7.0).scale;
  const sCustom = stageCamera(custom).at(7.0).scale;
  assert.ok(
    sDefault < stageCamera(comp).peakScale - 0.05,
    "default pull-out already moving at 7.0s",
  );
  assert.ok(
    Math.abs(sCustom - stageCamera(custom).peakScale) < 1e-6,
    `custom inAtMs 7600 ⇒ still holding at 7.0s (got ${sCustom})`,
  );
});

test("press Escape dismisses — full view even with a tempting effectBox", () => {
  // The frame-diff of a dismissal is the VACATED overlay region; framing it
  // would punch into blank space. Escape means "close" — the director must
  // return to full view regardless of the annotation.
  const comp = planComposition(
    log([
      {
        kind: "click",
        x: 300,
        y: 200,
        box: { x: 290, y: 190, w: 20, h: 20 },
        tMs: 1000,
        zoom: "always",
      },
      {
        kind: "press",
        x: 960,
        y: 540,
        keys: "Escape",
        tMs: 3200,
        effectBox: { x: 700, y: 300, w: 400, h: 300 },
        changeCoverage: 0.12,
      },
    ]),
  );
  const esc = comp.events[1]!;
  assert.equal(esc.zoom.enabled, false, "Escape holds full view");
  assert.match(esc.zoom.reason, /dismissal/i);
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

test("dropFiles: to/path/ease/files flow into the CompEvent; carry framed like a drag", () => {
  // A click opens the take so the dropFiles is NOT the opening beat — the
  // full-view assertion below must come from the carry-bbox ≈ rest demotion,
  // not from the director's opening-beat (<2s) rule.
  const comp = planComposition(
    log([
      { kind: "click", x: 300, y: 800, box: { x: 280, y: 780, w: 40, h: 40 }, tMs: 900 },
      {
        kind: "dropFiles",
        x: 1892,
        y: 194,
        to: { x: 960, y: 540 },
        path: [
          { x: 1892, y: 194 },
          { x: 960, y: 540 },
        ],
        tMs: 3200,
        durationMs: 1400,
        ease: "smooth",
        files: [{ name: "index.html", size: 1258291 }],
      },
    ]),
  );
  const drop = comp.events.find((e) => e.kind === "dropFiles");
  assert.ok(drop, "dropFiles event present");
  assert.deepEqual(drop!.to, { x: 960, y: 540 }, "drop point carried through");
  assert.equal(drop!.path?.length, 2, "carry polyline carried through");
  assert.equal(drop!.ease, "smooth", "carry pacing carried through");
  assert.deepEqual(
    drop!.files,
    [{ name: "index.html", size: 1258291 }],
    "files metadata carried through (the ghost card's content)",
  );
  assert.equal(drop!.durationMs, 1400, "carry duration carried through");
  // the beat frames the WHOLE carry (path bbox), exactly like a drag stroke —
  // a cross-screen carry fit-scales ≈ rest, so the director holds full view.
  assert.equal(drop!.zoom.enabled, false, "cross-screen carry holds full view");
  assert.ok(drop!.bbox, "carry bbox present");
  assert.ok(drop!.bbox!.w > 900, `bbox spans the carry (got w=${drop!.bbox!.w})`);
});

test("dropFiles: cursor rides the carry and the NEXT leg launches from the drop point", () => {
  const comp = planComposition(
    log([
      {
        kind: "dropFiles",
        x: 100,
        y: 500,
        to: { x: 1100, y: 500 },
        path: [
          { x: 100, y: 500 },
          { x: 1100, y: 500 },
        ],
        tMs: 1000,
        durationMs: 1000,
        ease: "linear",
        files: [{ name: "demo.zip", size: 2048 }],
      },
      { kind: "click", x: 1100, y: 900, box: { x: 1080, y: 880, w: 40, h: 40 }, tMs: 4000 },
    ]),
  );
  comp.cursor.dragLagMs = 0; // carry leg = [1.0, 2.0]
  const legs = buildLegs(comp);
  // travel → carry → travel: the carry leg replays the path with the button held
  const carry = legs.find((lg) => (lg as { drag?: boolean }).drag);
  assert.ok(carry, "carry leg present");
  const mid = cursorPos(1.5, legs, comp);
  assert.ok(Math.abs(mid.x - 600) < 1, `linear carry at midpoint (got ${mid.x})`);
  assert.ok(isDragging(1.5, legs), "pressed state during the carry");
  // the click's travel leg starts where the drop landed, not at the carry start
  const last = legs[legs.length - 1]!;
  assert.deepEqual(last.a, { x: 1100, y: 500 }, "next travel launches from the drop point");
  // carryWindow mirrors the leg's on-screen window (the ghost card's timing)
  const win = carryWindow(comp.events.find((e) => e.kind === "dropFiles")!, comp);
  assert.equal(win.t0, 1.0);
  assert.equal(win.t1, 2.0);
});

test("ghostCardLines: filename + meta caption", () => {
  assert.deepEqual(ghostCardLines([{ name: "index.html", size: 1258291 }]), {
    title: "index.html",
    meta: "1.2 MB",
  });
  assert.deepEqual(
    ghostCardLines([
      { name: "a.js", size: 512 },
      { name: "b.css", size: 512 },
      { name: "c.html", size: 1024 },
    ]),
    { title: "a.js", meta: "3 files · 2 KB" },
  );
  assert.deepEqual(ghostCardLines([]), { title: "file", meta: "" });
});

test("ghostCardLines: a long filename is ellipsed, not left to outgrow the card", () => {
  // neither render surface clamps the card's width, so the ONLY thing keeping
  // it inside the frame is this budget — a generated name (a build artifact, a
  // download) blows past it easily
  const long = "a-very-long-generated-filename-that-keeps-going.tar.gz";
  const { title } = ghostCardLines([{ name: long, size: 100 }]);
  assert.ok(title.length <= 34, `title is bounded (got ${title.length}: ${title})`);
  assert.ok(title.includes("…"), "shows it was shortened");
  // the tail is what identifies the file — a card reading "…keeps-going" and
  // one reading "…tar.gz" are answering different questions
  assert.ok(title.endsWith("tar.gz"), `keeps the extension (got ${title})`);
  assert.ok(long.startsWith(title.split("…")[0]!), "the head is the real prefix");
  // exactly at the budget is NOT shortened — an off-by-one here would ellipse
  // every ordinary name one character early
  const exact = "b".repeat(34);
  assert.equal(ghostCardLines([{ name: exact }]).title, exact);
  assert.ok(ghostCardLines([{ name: `${exact}c` }]).title.includes("…"));
});

test("ghostCardLines: a sub-kilobyte file reads as 1 KB, never 0 KB", () => {
  // "0 KB" beside a file the page just accepted reads as a failed drop
  assert.equal(ghostCardLines([{ name: "tiny.txt", size: 100 }]).meta, "1 KB");
  // no size at all (metadata the capture could not stat) drops the caption
  // rather than inventing one
  assert.equal(ghostCardLines([{ name: "unknown.bin" }]).meta, "");
});
