// validateComposition — the non-mutating structural check that guards the
// refine loop (edit composition.json → re-render). Pure function, no browser.
// Pins: a clean plan is clean; bad zoom/timing edits flag with the right
// severity; the capture-lock catches a drifted action tMs.

import { test } from "node:test";
import assert from "node:assert/strict";
import { planComposition } from "../src/plan.js";
import { validateComposition } from "../src/validate.js";
import type { CaptureLog, TakeComposition } from "../src/types.js";

const VW = 1920,
  VH = 1080;

function log(events: CaptureLog["events"]): CaptureLog {
  return { video: { width: VW, height: VH, fps: 60 }, viewport: { w: VW, h: VH }, start: { x: 200, y: 900 }, events };
}

// a small two-beat composition with one zoom-enabled beat
function comp(): { c: TakeComposition; l: CaptureLog } {
  const l = log([
    { kind: "click", x: 200, y: 200, box: { x: 180, y: 180, w: 60, h: 60 }, tMs: 1000, zoom: "always" },
    { kind: "click", x: 1000, y: 600, box: { x: 980, y: 580, w: 60, h: 60 }, tMs: 3000, zoom: "always" },
  ]);
  return { c: planComposition(l, { output: { fps: 60 } }), l };
}

const errs = (c: TakeComposition, opts = {}) => validateComposition(c, opts).filter((i) => i.severity === "error");
const warns = (c: TakeComposition, opts = {}) => validateComposition(c, opts).filter((i) => i.severity === "warn");

test("a freshly planned composition validates clean", () => {
  const { c } = comp();
  assert.deepEqual(validateComposition(c), [], "planner output has no issues");
});

test("scale below rest errors (zooms out past the frame → dead space)", () => {
  const { c } = comp();
  const e = c.events.find((x) => x.zoom.enabled)!;
  e.zoom.scale = 0.5; // rest on 1920x1080 ≈ 0.92
  const es = errs(c);
  assert.ok(es.some((i) => i.path.endsWith(".zoom.scale")), "flags the sub-rest scale");
});

test("scale ≈ rest while enabled warns (zoom does nothing)", () => {
  const { c } = comp();
  const e = c.events.find((x) => x.zoom.enabled)!;
  e.zoom.scale = 0.92; // ~rest
  assert.ok(warns(c).some((i) => i.path.endsWith(".zoom.scale")), "warns the no-op zoom");
});

test("inAtMs after the action errors", () => {
  const { c } = comp();
  const e = c.events[0]!;
  e.zoom.inAtMs = e.tMs + 500;
  assert.ok(errs(c).some((i) => i.path.endsWith(".zoom.inAtMs")), "zoom-in must precede the action");
});

test("out-of-order action tMs errors", () => {
  const { c } = comp();
  c.events[1]!.tMs = 500; // earlier than events[0] at 1000
  assert.ok(errs(c).some((i) => i.path === "events[1].tMs"), "events must stay temporal");
});

test("durationMs shorter than the last action errors", () => {
  const { c } = comp();
  c.durationMs = 100;
  assert.ok(errs(c).some((i) => i.path === "durationMs"), "composition must outlast the last beat");
});

test("capture-lock: a drifted action tMs errors only when the log is given", () => {
  const { c, l } = comp();
  c.events[1]!.tMs = 3500; // moved 500ms off the captured 3000
  c.durationMs = 8000; // keep it in-bounds so only the lock fires
  assert.deepEqual(errs(c), [], "no log → tMs drift is invisible");
  const es = errs(c, { captureLog: l });
  assert.ok(es.some((i) => i.path === "events[1].tMs"), "with the log, the capture-lock catches it");
});

test("enabling zoom on a no-bbox beat warns (center/scale are hand-set)", () => {
  const l = log([{ kind: "press", x: 960, y: 540, keys: "Escape", tMs: 1000, durationMs: 500 } as CaptureLog["events"][number]]);
  const c = planComposition(l, { output: { fps: 60 } });
  const e = c.events[0]!;
  e.zoom.enabled = true;
  e.zoom.scale = 1.5;
  assert.ok(warns(c).some((i) => i.path === "events[0].zoom"), "flags the bbox-less zoom");
});
