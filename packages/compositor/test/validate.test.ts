// validateComposition — the non-mutating structural check that guards the
// refine loop (edit composition.json → re-render). Pure function, no browser.
// Pins: a clean plan is clean; bad zoom/timing edits flag with the right
// severity; the capture-lock catches a drifted action tMs.

import assert from "node:assert/strict";
import { test } from "node:test";
import { planComposition } from "../src/plan.js";
import type { CaptureLog, TakeComposition } from "../src/types.js";
import { validateComposition } from "../src/validate.js";

const VW = 1920,
  VH = 1080;

function log(events: CaptureLog["events"]): CaptureLog {
  return {
    video: { width: VW, height: VH, fps: 60 },
    viewport: { w: VW, h: VH },
    start: { x: 200, y: 900 },
    events,
  };
}

// a small two-beat composition with one zoom-enabled beat
function comp(): { c: TakeComposition; l: CaptureLog } {
  const l = log([
    {
      kind: "click",
      x: 200,
      y: 200,
      box: { x: 180, y: 180, w: 60, h: 60 },
      tMs: 1000,
      zoom: "always",
    },
    {
      kind: "click",
      x: 1000,
      y: 600,
      box: { x: 980, y: 580, w: 60, h: 60 },
      tMs: 3000,
      zoom: "always",
    },
  ]);
  return { c: planComposition(l, { output: { fps: 60 } }), l };
}

const errs = (c: TakeComposition, opts = {}) =>
  validateComposition(c, opts).filter((i) => i.severity === "error");
const warns = (c: TakeComposition, opts = {}) =>
  validateComposition(c, opts).filter((i) => i.severity === "warn");

test("a freshly planned composition validates clean", () => {
  const { c } = comp();
  assert.deepEqual(validateComposition(c), [], "planner output has no issues");
});

test("scale below rest errors (zooms out past the frame → dead space)", () => {
  const { c } = comp();
  const e = c.events.find((x) => x.zoom.enabled)!;
  e.zoom.scale = 0.5; // rest on 1920x1080 ≈ 0.92
  const es = errs(c);
  assert.ok(
    es.some((i) => i.path.endsWith(".zoom.scale")),
    "flags the sub-rest scale",
  );
});

test("scale ≈ rest while enabled warns (zoom does nothing)", () => {
  const { c } = comp();
  const e = c.events.find((x) => x.zoom.enabled)!;
  e.zoom.scale = 0.92; // ~rest
  assert.ok(
    warns(c).some((i) => i.path.endsWith(".zoom.scale")),
    "warns the no-op zoom",
  );
});

test("inAtMs after the action errors", () => {
  const { c } = comp();
  const e = c.events[0]!;
  e.zoom.inAtMs = e.tMs + 500;
  assert.ok(
    errs(c).some((i) => i.path.endsWith(".zoom.inAtMs")),
    "zoom-in must precede the action",
  );
});

test("press reveal timing: inAtMs at the keypress is clean, a pre-zoom warns", () => {
  const l = log([
    {
      kind: "click",
      x: 200,
      y: 200,
      box: { x: 180, y: 180, w: 60, h: 60 },
      tMs: 1000,
      zoom: "always",
    },
    // ⌘K palette: the reveal exists only after the keypress
    // durationMs keeps the punch past minHoldMs so the director doesn't drop it
    {
      kind: "press",
      x: 960,
      y: 400,
      keys: "Meta+k",
      box: { x: 760, y: 300, w: 400, h: 200 },
      tMs: 3000,
      durationMs: 1400,
    },
  ]);
  const c = planComposition(l, { output: { fps: 60 } });
  const press = c.events.find((e) => e.kind === "press")!;
  assert.equal(press.zoom.inAtMs, press.tMs, "planner pins the press departure at tMs");
  assert.deepEqual(validateComposition(c), [], "reveal-timed press validates clean");
  // a legacy/hand edit that departs early punches into empty space → warn
  press.zoom.inAtMs = press.tMs - 730;
  assert.ok(
    warns(c).some((i) => i.path.endsWith(".zoom.inAtMs")),
    "pre-keypress zoom departure warns",
  );
  assert.equal(errs(c).length, 0, "the early departure is a warn, not an error");
});

test("out-of-order action tMs errors", () => {
  const { c } = comp();
  c.events[1]!.tMs = 500; // earlier than events[0] at 1000
  assert.ok(
    errs(c).some((i) => i.path === "events[1].tMs"),
    "events must stay temporal",
  );
});

test("durationMs shorter than the last action errors", () => {
  const { c } = comp();
  c.durationMs = 100;
  assert.ok(
    errs(c).some((i) => i.path === "durationMs"),
    "composition must outlast the last beat",
  );
});

test("capture-lock: a drifted action tMs errors only when the log is given", () => {
  const { c, l } = comp();
  c.events[1]!.tMs = 3500; // moved 500ms off the captured 3000
  c.durationMs = 8000; // keep it in-bounds so only the lock fires
  assert.deepEqual(errs(c), [], "no log → tMs drift is invisible");
  const es = errs(c, { captureLog: l });
  assert.ok(
    es.some((i) => i.path === "events[1].tMs"),
    "with the log, the capture-lock catches it",
  );
});

test("enabling zoom on a no-bbox beat warns (center/scale are hand-set)", () => {
  const l = log([
    {
      kind: "press",
      x: 960,
      y: 540,
      keys: "Escape",
      tMs: 1000,
      durationMs: 500,
    } as CaptureLog["events"][number],
  ]);
  const c = planComposition(l, { output: { fps: 60 } });
  const e = c.events[0]!;
  e.zoom.enabled = true;
  e.zoom.scale = 1.5;
  assert.ok(
    warns(c).some((i) => i.path === "events[0].zoom"),
    "flags the bbox-less zoom",
  );
});

// --- dead tail: the mirror of "the tail is too short" ----------------------

test("a tail far past the last beat's settle warns (padded dead air)", () => {
  const { c } = comp();
  const lastEnd = Math.max(...c.events.map((e) => e.tMs + (e.durationMs ?? 0)));
  const settled = lastEnd + c.cursor.holdMs + c.cursor.zoomOutMs;
  c.durationMs = settled + 12_000;
  assert.ok(
    warns(c).some((i) => i.path === "durationMs" && /frozen screen/.test(i.message)),
    "flags 12s of nothing after the last payoff",
  );
  c.durationMs = settled + 1_000;
  assert.ok(
    !warns(c).some((i) => i.path === "durationMs"),
    "a modest breath after the last beat is not dead air",
  );
});

// --- crowded release: the camera must be parked when an action fires -------

function crowdedRelease(): TakeComposition {
  // type a name, then click the button 900ms after the typing settles — too
  // tight for pullOutDwellMs + zoomOutMs, so the release lands mid-click.
  return planComposition(
    log([
      {
        kind: "type",
        x: 1120,
        y: 400,
        box: { x: 980, y: 380, w: 292, h: 36 },
        tMs: 1000,
        durationMs: 1200,
        text: "a-name",
        zoom: "always",
      },
      {
        kind: "click",
        x: 960,
        y: 458,
        box: { x: 648, y: 440, w: 624, h: 36 },
        tMs: 3100,
        zoom: "never",
      },
    ]),
    { output: { fps: 60 } },
  );
}

test("a release crowded against the next action warns (the frame slides under it)", () => {
  assert.ok(
    warns(crowdedRelease()).some(
      (i) => i.path === "events[1].zoom" && /slides out from under/.test(i.message),
    ),
    "flags the pull-out that is still moving at the click",
  );
});

test("holding the previous frame clears the crowded-release warn", () => {
  const c = crowdedRelease();
  // the documented fix: don't release — reuse the previous beat's framing so
  // the camera never moves at the action.
  c.events[1]!.zoom = {
    ...c.events[0]!.zoom,
    inAtMs: Math.max(0, c.events[1]!.tMs - c.cursor.zoomInMs),
    reason: "hold the frame through the confirming click",
  };
  assert.ok(
    !warns(c).some((i) => i.path === "events[1].zoom" && /slides out from under/.test(i.message)),
    "a held frame has no move to be late",
  );
});

// --- cursor motion knobs ----------------------------------------------------
// Until these existed, nothing in the schema bounded travelMin/MaxMs, the ramp
// durations or a hand-set inAtMs: the clamps could silently take the pace
// preset out of the loop, and a stretched camera window could put the whole
// take on a crawl, with every other check still passing.

/** a four-click take, so leg-share thresholds have something to measure */
function fourClicks(pts: { x: number; y: number }[]): TakeComposition {
  return planComposition(
    log(
      pts.map((p, i) => ({
        kind: "click" as const,
        x: p.x,
        y: p.y,
        box: { x: p.x - 20, y: p.y - 20, w: 40, h: 40 },
        tMs: 1500 + i * 2500,
        zoom: "never" as const,
      })),
    ),
    { output: { fps: 60 } },
  );
}

test("a hand-set camera window far longer than its pace knob warns", () => {
  const { c } = comp();
  c.events[1]!.zoom.inAtMs = 0; // 0 → 3000ms, against a 1340ms release window
  const w = warns(c).filter((i) => i.path === "events[1].zoom.inAtMs");
  assert.equal(w.length, 1, "flags the stretched window");
  // this beat widens the frame, so the window it should be judged against is
  // zoomOutMs — the same pull-out test the schedule itself makes.
  assert.match(w[0]!.message, /2\.2× cursor\.zoomOutMs \(1340ms\)/, "names the multiple and knob");
  assert.match(w[0]!.fix ?? "", /inAtMs = 2270/, "offers the planner default back");
});

test("the planner's own camera windows are never flagged as over-long", () => {
  const { c } = comp();
  assert.equal(
    warns(c).filter((i) => /inAtMs/.test(i.path)).length,
    0,
    "a default window is the pace, not a finding",
  );
});

test("a ramp knob past the slowest shipped pace warns", () => {
  const { c } = comp();
  c.cursor.zoomInMs = 2000; // calm is 900
  c.cursor.zoomOutMs = 4000; // calm is 1650
  const paths = warns(c).map((i) => i.path);
  assert.ok(paths.includes("cursor.zoomInMs"), "flags the punch-in window");
  assert.ok(paths.includes("cursor.zoomOutMs"), "flags the release window");
  const { c: clean } = comp();
  clean.cursor.zoomInMs = 900; // exactly calm — the vocabulary, not a crawl
  clean.cursor.zoomOutMs = 1650;
  assert.ok(
    !warns(clean).some((i) => /cursor\.zoom(In|Out)Ms/.test(i.path)),
    "the slowest shipped pace is not a warning",
  );
});

test("a HAND-SET floor governing most hops warns; the pace's own floor does not", () => {
  // Four targets a few dozen px apart: every hop wants well under travelMinMs,
  // so the floor sets them all.
  const pts = [
    { x: 300, y: 880 },
    { x: 340, y: 900 },
    { x: 300, y: 920 },
    { x: 350, y: 890 },
  ];
  // At the pace's OWN floor there is nothing to report — the clamp is part of
  // the bundle, it was tuned with the rest of it, and re-pacing moves it.
  assert.equal(
    warns(fourClicks(pts)).filter((i) => i.path === "cursor.travelMinMs").length,
    0,
    "the pace's own floor is the pace, not an override",
  );
  // Hand-set it away from the pace and those legs stop answering to the pace.
  const c = fourClicks(pts);
  c.cursor.travelMinMs = 700; // hand-set, but still under the 850ms ceiling
  const w = warns(c).filter((i) => i.path === "cursor.travelMinMs");
  assert.equal(w.length, 1, "flags the hand-set floor");
  assert.match(w[0]!.message, /hand-set cursor\.travelMinMs of 700ms/, "names the clamp");
  assert.match(w[0]!.fix ?? "", /restore cursor\.travelMinMs to 300/, "offers the default back");
  // …and a drift too small to cost the pace its NAME is too small to report:
  // the warning and motionName must never disagree about what "is the pace".
  const nudged = fourClicks(pts);
  nudged.cursor.travelMinMs = 300 + 15;
  assert.equal(
    warns(nudged).filter((i) => i.path === "cursor.travelMinMs").length,
    0,
    "a within-tolerance clamp is still the pace, not an override",
  );
});

test("the SHIPPED ceiling capping long sweeps is not a finding; a tightened one is", () => {
  const pts = [
    { x: 300, y: 200 },
    { x: 1600, y: 900 },
    { x: 300, y: 900 },
    { x: 1600, y: 200 },
  ];
  const shipped = fourClicks(pts); // travelMaxMs 850 — the pace's own ceiling
  assert.equal(
    warns(shipped).filter((i) => i.path === "cursor.travelMaxMs").length,
    0,
    "the pace's own cap is the calibration, not a defect",
  );
  const tightened = fourClicks(pts);
  tightened.cursor.travelMinMs = 100;
  tightened.cursor.travelMaxMs = 200; // hand-tightened → everything darts
  const w = warns(tightened).filter((i) => i.path === "cursor.travelMaxMs");
  assert.equal(w.length, 1, "flags a ceiling that has taken over");
  assert.match(w[0]!.message, /hand-set cursor\.travelMaxMs of 200ms/, "names the clamp");
});

test("a nonsensical clamp band errors (the ceiling would win every leg)", () => {
  const { c } = comp();
  c.cursor.travelMinMs = 900;
  c.cursor.travelMaxMs = 400;
  assert.ok(
    errs(c).some((i) => i.path === "cursor.travelMaxMs" && /below travelMinMs/.test(i.message)),
    "an inverted band is an error, not a taste",
  );
});

test("a present-but-broken knob errors; a LEGACY composition still validates", () => {
  const { c } = comp();
  c.cursor.zoomOutMs = 0;
  assert.ok(
    errs(c).some((i) => i.path === "cursor.zoomOutMs"),
    "a zero release window breaks the schedule arithmetic",
  );
  // …but a composition from before the speed law existed (fixed travelMs, no
  // travelWidthsPerSec / clamps / zoomInMs) renders today and must keep doing so.
  const { c: legacy } = comp();
  const cur = legacy.cursor as Partial<typeof legacy.cursor>;
  cur.travelWidthsPerSec = undefined;
  cur.travelMinMs = undefined;
  cur.travelMaxMs = undefined;
  cur.zoomInMs = undefined;
  legacy.cursor.travelMs = 600;
  assert.deepEqual(
    errs(legacy).map((i) => i.path),
    [],
    "absent fields are the legacy shape, not a broken edit",
  );
});

test("a travel squeezed by the beat before it is reported against the CAPTURE", () => {
  // The shipped capture defaults hold a `press` for durationMs and then only
  // settleMs (400ms) before the next action — and the cursor now waits out the
  // whole reveal, so the glide that follows has 400ms to do an 850ms move. No
  // cursor knob can widen that gap; the recording has to.
  const c = planComposition(
    log([
      { kind: "click", x: 300, y: 250, box: { x: 280, y: 230, w: 40, h: 40 }, tMs: 700 },
      { kind: "press", keys: "Meta+k", x: 960, y: 540, tMs: 2000, durationMs: 1000 },
      { kind: "click", x: 1700, y: 900, box: { x: 1680, y: 880, w: 40, h: 40 }, tMs: 3400 },
    ]),
    { output: { fps: 60 } },
  );
  const w = warns(c).filter((i) => i.path === "events[2]");
  assert.equal(w.length, 1, "flags the rushed approach");
  assert.match(w[0]!.message, /400ms of the 850ms/, "quantifies the shortfall");
  assert.match(w[0]!.message, /events\[1\] \(press\)/, "names the beat that ate the gap");
  assert.match(w[0]!.fix ?? "", /settleMs by ≥ 450ms/, "asks the capture for the room");
  // …and a leg that merely runs a little short of target stays quiet: leg 0
  // here gets 700 of its 850ms and is not worth a word.
  assert.equal(warns(c).filter((i) => i.path === "events[0]").length, 0, "no noise on a near-miss");
});

test("a release that has not departed by the action says so instead of a negative %", () => {
  // The pullOutDwellMs floor can push a departure PAST its own action (a hover
  // with the shipped 300ms settle in front of a full-view click does it with no
  // hand edits at all). "% of its move done" then goes negative — a fraction
  // that cannot describe a camera still parked at the previous frame.
  const c = planComposition(
    log([
      {
        kind: "hover",
        x: 400,
        y: 300,
        box: { x: 340, y: 278, w: 120, h: 44 },
        tMs: 2000,
        durationMs: 1200,
      },
      { kind: "click", x: 1200, y: 700, box: { x: 1100, y: 660, w: 200, h: 80 }, tMs: 3508 },
    ]),
    { output: { fps: 60 } },
  );
  const w = warns(c).filter((i) => i.path === "events[1].zoom");
  assert.equal(w.length, 1, "the crowded release still fires");
  assert.doesNotMatch(w[0]!.message, /-\d+%/, "no negative percentage");
  assert.match(w[0]!.message, /has not even departed/, "says the camera is still parked");
  // the ground truth stays in the same sentence either way
  assert.match(w[0]!.message, /departs 4000ms, lands 5340ms, action 3508ms/, "keeps the numbers");
});

test("an inverted clamp band's error describes what the clamps actually do", () => {
  const c = planComposition(
    log([
      { kind: "click", x: 150, y: 150, box: { x: 130, y: 130, w: 40, h: 40 }, tMs: 1500 },
      { kind: "click", x: 1800, y: 1000, box: { x: 1780, y: 980, w: 40, h: 40 }, tMs: 5000 },
    ]),
    { output: { fps: 60 } },
  );
  c.cursor.travelMinMs = 800;
  c.cursor.travelMaxMs = 400;
  const e = errs(c).filter((i) => i.path === "cursor.travelMaxMs");
  assert.equal(e.length, 1, "an inverted band is an error");
  // the clamps run in order (floor, then ceiling), so the FLOOR wins short hops
  // — the opposite of what a single clamp(min,max) call would have done.
  assert.match(e[0]!.message, /SHORT hops \(800ms\) end up slower/, "describes the real ordering");
  assert.doesNotMatch(e[0]!.message, /ceiling wins/, "not the pre-rewrite semantics");
});
