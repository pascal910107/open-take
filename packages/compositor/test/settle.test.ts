// zoomSettleFrac (asymptotic settle tail) + pullOutDwellMs (pull-out departure
// floor). Both now SHIP as defaults (DEFAULT_CURSOR: 0.04 / 800 — the A/B "C"
// variant signed off by eye), but a composition WITHOUT the fields (any take
// made before them) must render byte-identical to the legacy schedule — the
// first tests pin that. The rest pin the new behavior: no velocity cliff at a
// ramp's keyframe end, the dwell departure/late-landing schedule, and the
// dense-beat degradation (dwell gives way to the ramp; never a collapsed 1ms
// jump-cut segment).

import assert from "node:assert/strict";
import { test } from "node:test";
import { buildStageKeyframes, cameraRampSchedule, stageCamera } from "../src/math.js";
import { MOTION, motionName } from "../src/presets.js";
import type { CursorConfig, TakeComposition } from "../src/types.js";
import { DEFAULT_CAMERA, DEFAULT_CURSOR, DEFAULT_FRAMING } from "../src/types.js";
import { validateComposition } from "../src/validate.js";

const VW = 1920,
  VH = 1080;

type Ev = TakeComposition["events"][number];

function comp(events: Ev[], cursor: Partial<TakeComposition["cursor"]> = {}): TakeComposition {
  const durationMs =
    Math.max(...events.map((e) => e.tMs + (e.durationMs ?? 0))) +
    DEFAULT_CURSOR.holdMs +
    DEFAULT_CURSOR.zoomOutMs +
    3000;
  return {
    output: { width: VW, height: VH, fps: 60 },
    source: { videoUrl: "/x.mp4", videoWidth: VW, videoHeight: VH, viewport: { w: VW, h: VH } },
    framing: DEFAULT_FRAMING,
    cursor: { ...DEFAULT_CURSOR, ...cursor },
    start: { x: 200, y: 900 },
    events,
    durationMs,
  };
}

/** A composition as an OLD take (made before settle/dwell existed) carries it:
 *  the fields absent entirely — must keep the exact legacy schedule. */
function legacyComp(
  events: Ev[],
  cursor: Partial<TakeComposition["cursor"]> = {},
): TakeComposition {
  const c = comp(events, cursor);
  const { zoomSettleFrac: _s, pullOutDwellMs: _d, ...rest } = c.cursor;
  return { ...c, cursor: rest };
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

// The demo shape that motivated the work: punch 2.4×, a type playing 459ms,
// then a squeezed pull-out to a wider 1.7× frame 910ms later.
function squeezedEvents(): Ev[] {
  return [
    beat(5698, 2.4, { x: 832, y: 732 }, { kind: "type", text: "x", durationMs: 459 }),
    beat(7067, 1.7, { x: 1230, y: 690 }, { kind: "press", keys: "Meta+Enter", durationMs: 1200 }),
  ];
}

test("legacy parity: absent fields and explicit zeros sample identically", () => {
  const base = legacyComp(squeezedEvents());
  const zeros = comp(squeezedEvents(), { zoomSettleFrac: 0, pullOutDwellMs: 0 });
  const a = stageCamera(base);
  const b = stageCamera(zeros);
  assert.equal(a.T, b.T);
  for (let i = 0; i <= 600; i++) {
    const t = (i / 600) * a.T;
    const ra = a.at(t);
    const rb = b.at(t);
    assert.equal(ra.scale, rb.scale, `scale @${t.toFixed(3)}s`);
    assert.equal(ra.center.x, rb.center.x, `cx @${t.toFixed(3)}s`);
    assert.equal(ra.center.y, rb.center.y, `cy @${t.toFixed(3)}s`);
  }
});

test("legacy parity: the squeezed pull-out still departs at the previous action's end", () => {
  // Pinned legacy schedule (pre-dwell behavior): ramp start = prevEnd (6157ms),
  // landing exactly at its own tMs (7067ms).
  const kfs = buildStageKeyframes(legacyComp(squeezedEvents())).r;
  const times = kfs.map(([t]) => Math.round(t * 1000));
  assert.ok(times.includes(6157), `pull-out departs at 6157 (got ${times.join(",")})`);
  assert.ok(times.includes(7067), `pull-out lands at 7067 (got ${times.join(",")})`);
});

test("settle: no velocity cliff at the keyframe end; ~frac residual settles on", () => {
  const c = comp(squeezedEvents(), { zoomSettleFrac: 0.04, pullOutDwellMs: 0 });
  const cam = stageCamera(c);
  // residual at the punch's landing keyframe (tMs = 5698): ~4% of the way out.
  const target = 2.4;
  const from = 0.92;
  const atLand = cam.at(5.698).scale;
  const progress = (1 / from - 1 / atLand) / (1 / from - 1 / target); // width-space progress
  assert.ok(Math.abs(progress - 0.96) < 0.01, `~96% at the action instant (got ${progress})`);
  // no cliff: width-velocity must be CONTINUOUS across the landing keyframe.
  // (The legacy cut clamps to the target at t=tMs — velocity jumps from ~2-3%
  // of peak to exactly 0 in one sample; the settle tail carries it through.)
  const dt = 0.002;
  const widthVel = (c: ReturnType<typeof stageCamera>, t: number) =>
    Math.abs(VW / c.at(t + dt).scale - VW / c.at(t).scale) / dt;
  const peak = Math.max(
    ...Array.from({ length: 300 }, (_, i) => widthVel(cam, 4.9 + (i * 1.2) / 300)),
  );
  const tEnd = 5.698;
  const jumpSettle = Math.abs(widthVel(cam, tEnd) - widthVel(cam, tEnd - dt));
  assert.ok(jumpSettle / peak < 0.005, `settle boundary jump ${jumpSettle} vs peak ${peak}`);
  const legacyCam = stageCamera(legacyComp(squeezedEvents()));
  const jumpLegacy = Math.abs(widthVel(legacyCam, tEnd) - widthVel(legacyCam, tEnd - dt));
  assert.ok(jumpLegacy / peak > 0.01, `the legacy cliff exists (${jumpLegacy} vs peak ${peak})`);
  // and the tail keeps creeping past the keyframe: still measurably moving at +150ms
  const v1 = Math.abs(cam.at(tEnd + 0.15).scale - cam.at(tEnd + 0.154).scale);
  assert.ok(v1 > 0, "tail still settling 150ms past the keyframe");
});

test("settle: explicit zoomSpring/zoomEase win — settle is inert", () => {
  const base = comp(squeezedEvents(), { zoomSpring: 0.2 });
  const withFrac = comp(squeezedEvents(), { zoomSpring: 0.2, zoomSettleFrac: 0.04 });
  const a = stageCamera(base);
  const b = stageCamera(withFrac);
  for (let i = 0; i <= 200; i++) {
    const t = (i / 200) * a.T;
    assert.equal(a.at(t).scale, b.at(t).scale);
  }
});

test("dwell: the squeezed pull-out departs at prevEnd + dwell and lands late (full ramp)", () => {
  const kfs = buildStageKeyframes(comp(squeezedEvents(), { pullOutDwellMs: 800 })).r;
  const times = kfs.map(([t]) => Math.round(t * 1000));
  assert.ok(times.includes(6957), `departs at 6157+800 (got ${times.join(",")})`);
  assert.ok(
    times.includes(6957 + DEFAULT_CURSOR.zoomOutMs),
    `lands a full zoomOutMs later (got ${times.join(",")})`,
  );
});

test("dwell: an unsqueezed pull-out is untouched", () => {
  // Big gap: desired departure (tMs - zoomOutMs) already clears the dwell floor.
  const evs = [
    beat(2000, 2.0, { x: 800, y: 600 }),
    beat(9000, 1.2, { x: 900, y: 500 }, { kind: "press", keys: "Enter" }),
  ];
  const legacy = buildStageKeyframes(legacyComp(evs)).r.map(([t]) => t);
  const dwell = buildStageKeyframes(comp(evs, { pullOutDwellMs: 800 })).r.map(([t]) => t);
  assert.deepEqual(dwell, legacy);
});

test("dwell dense beats: no room at all — the schedule degrades to exactly legacy", () => {
  // Reviewer repro shape: zoomed click, pull-out 500ms later, another zoomed
  // click 100ms after that. Zero dwell fits, so the dwell schedule must equal
  // the legacy squeeze byte-for-byte (never the inverted-ramp jump cut).
  const scrollZoom = {
    enabled: false,
    scale: 0.92,
    center: { x: 960, y: 540 },
    inAtMs: 770,
    reason: "scroll",
  };
  const evs = [
    beat(1000, 2.5, { x: 500, y: 300 }),
    beat(1500, 0.92, { x: 960, y: 540 }, {
      kind: "scroll",
      durationMs: 0,
      zoom: scrollZoom,
    } as Partial<Ev>),
    beat(1600, 3.0, { x: 1600, y: 800 }),
  ];
  const legacy = buildStageKeyframes(legacyComp(evs)).r;
  const dwell = buildStageKeyframes(comp(evs, { pullOutDwellMs: 800 })).r;
  assert.deepEqual(dwell, legacy);
});

test("dwell partial room: the dwell shrinks so a minimal real ramp survives", () => {
  // Pull-out squeezed (desired < prevEnd + dwell) but the next anchor leaves
  // room for min(zoomInMs, zoomOutMs) of ramp if the dwell gives some back.
  const scrollZoom = {
    enabled: false,
    scale: 0.92,
    center: { x: 960, y: 540 },
    inAtMs: 1770,
    reason: "scroll",
  };
  const evs = [
    beat(1000, 2.0, { x: 800, y: 600 }),
    beat(2500, 0.92, { x: 960, y: 540 }, {
      kind: "scroll",
      durationMs: 0,
      zoom: scrollZoom,
    } as Partial<Ev>),
    beat(3200, 2.2, { x: 1200, y: 700 }),
  ];
  const kfs = buildStageKeyframes(comp(evs, { pullOutDwellMs: 800 })).r;
  const minRampS = Math.min(DEFAULT_CURSOR.zoomInMs, DEFAULT_CURSOR.zoomOutMs) / 1000;
  // the pull-out ramp: find the segment that leaves the 2.0× rect
  const w20 = VW / 2.0;
  const seg = kfs.findIndex(
    ([, r], i) => Math.abs(r.w - w20) < 1 && kfs[i + 1] && Math.abs(kfs[i + 1]![1].w - w20) > 1,
  );
  assert.ok(seg >= 0, "pull-out ramp found");
  const t0 = kfs[seg]![0];
  const t1 = kfs[seg + 1]![0];
  // full dwell would depart at 1.8s; the shrunken one departs earlier so a
  // minimal ramp still fits before the next anchor's 2.47s departure.
  assert.ok(t0 > 1.0 && t0 < 1.8, `departure ${t0} sits between prevEnd and the full dwell floor`);
  // push() spaces coincident keyframes by 1e-3s — allow that bite
  assert.ok(t1 - t0 >= minRampS - 2e-3, `ramp ${((t1 - t0) * 1000).toFixed(0)}ms >= minRamp`);
  assert.ok(t1 <= 3200 / 1000 - 0.73 - 0.0099, "lands before the next anchor departs");
});

test("validate: field ranges + inert-settle warn + dwell-late durationMs warn", () => {
  const bad1 = comp(squeezedEvents(), { zoomSettleFrac: 0.5 });
  assert.ok(
    validateComposition(bad1).some(
      (i) => i.severity === "error" && i.path === "cursor.zoomSettleFrac",
    ),
  );
  const bad2 = comp(squeezedEvents(), { pullOutDwellMs: 9000 });
  assert.ok(
    validateComposition(bad2).some(
      (i) => i.severity === "error" && i.path === "cursor.pullOutDwellMs",
    ),
  );
  const inert = comp(squeezedEvents(), { zoomSettleFrac: 0.04, zoomEase: [0.3, 0, 0.2, 1] });
  assert.ok(
    validateComposition(inert).some(
      (i) => i.severity === "warn" && i.path === "cursor.zoomSettleFrac",
    ),
    "warns that zoomEase shadows the settle",
  );
  // dwell-late final landing past durationMs: shrink the composition's tail
  const short = comp(squeezedEvents(), { pullOutDwellMs: 4800 });
  short.durationMs = 7067 + 1200 + 1400; // barely past legacy tail, before the dwell-shifted one
  assert.ok(
    validateComposition(short).some(
      (i) => i.severity === "warn" && i.message.includes("mid-motion at durationMs"),
    ),
    "warns when the dwell-shifted motion outruns durationMs",
  );
});

test("shipped defaults: settle 0.04 + dwell 800 ship; pace presets carry a scaled dwell", () => {
  assert.equal(DEFAULT_CURSOR.zoomSettleFrac, 0.04);
  assert.equal(DEFAULT_CURSOR.pullOutDwellMs, 800);
  // "natural" must keep mirroring DEFAULT_CURSOR (the preset that names the
  // shipped default), and every pace bundles a dwell.
  assert.equal(MOTION.natural.pullOutDwellMs, DEFAULT_CURSOR.pullOutDwellMs);
  assert.ok(MOTION.calm.pullOutDwellMs! > MOTION.brisk.pullOutDwellMs!);
  assert.equal(motionName(DEFAULT_CURSOR), "natural");
  // an OLD composition (no dwell field) still names its pace — only an
  // explicit different value reads as custom.
  const { zoomSettleFrac: _s, pullOutDwellMs: _d, ...legacy } = DEFAULT_CURSOR;
  assert.equal(motionName(legacy as CursorConfig), "natural");
  assert.equal(motionName({ ...DEFAULT_CURSOR, pullOutDwellMs: 0 }), null);
});

test("cameraRampSchedule: real departures/landings per event, incl. dwell-late", () => {
  // dwell schedule: pull-out departs prevEnd+800 and lands a full zoomOutMs on
  const sched = cameraRampSchedule(comp(squeezedEvents(), { pullOutDwellMs: 800 }));
  assert.equal(sched.length, 2);
  assert.equal(Math.round(sched[1]!.startMs), 6957);
  assert.equal(Math.round(sched[1]!.landMs), 6957 + DEFAULT_CURSOR.zoomOutMs);
  // legacy schedule: departs at prevEnd, lands exactly on its tMs
  const legacy = cameraRampSchedule(legacyComp(squeezedEvents()));
  assert.equal(Math.round(legacy[1]!.startMs), 6157);
  assert.equal(Math.round(legacy[1]!.landMs), 7067);
  // a disabled beat AFTER a zoom is a release anchor (it means full view —
  // the old null here pinned the hold-prior-framing defect that cropped a
  // zoom:"never" global payoff); a disabled beat over a resting camera is
  // still held through (null) so legacy schedules stay byte-identical.
  const held = comp([
    beat(2000, 2.0, { x: 800, y: 600 }),
    beat(4000, 0.8, { x: 900, y: 500 }), // enabled=false (scale ≤ 1 in beat())
    beat(6500, 0.8, { x: 400, y: 300 }), // still disabled — camera already at rest
  ]);
  const heldSched = cameraRampSchedule(held);
  assert.ok(heldSched[0], "anchor beat has a ramp");
  assert.ok(heldSched[1], "disabled beat after a zoom releases to rest");
  assert.equal(heldSched[2], null, "disabled beat over a resting camera has none");
});

test("startMs: range-checked; trimming into the first beat warns", () => {
  const ok = comp(squeezedEvents());
  ok.startMs = 900;
  assert.ok(
    validateComposition(ok).every((i) => i.path !== "startMs"),
    "a head trim before the first ramp is clean",
  );
  const neg = comp(squeezedEvents());
  neg.startMs = -5;
  assert.ok(validateComposition(neg).some((i) => i.severity === "error" && i.path === "startMs"));
  const past = comp(squeezedEvents());
  past.startMs = past.durationMs + 1;
  assert.ok(validateComposition(past).some((i) => i.severity === "error" && i.path === "startMs"));
  const intoBeat = comp(squeezedEvents());
  intoBeat.startMs = 5200; // first inAtMs = 5698 − 730 = 4968
  assert.ok(
    validateComposition(intoBeat).some((i) => i.severity === "warn" && i.path === "startMs"),
    "warns when the trim cuts into the first beat's ramp",
  );
});
