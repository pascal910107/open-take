// frames — the verification sheet must sample the camera's HOLD, never a ramp
// or settle tail (the field-report failure: a single frame sampled inside a
// pull-out read as "the zoom fix didn't apply" and cost a 3-minute re-scan).

import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { DEFAULT_CURSOR, DEFAULT_FRAMING, type TakeComposition, math } from "@open-take/compositor";
import { buildFramePlan, buildFrameSheet } from "../src/frames.js";
import { resolveTakePaths } from "../src/take.js";

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

function comp(events: Ev[], over: Partial<TakeComposition> = {}): TakeComposition {
  return {
    output: { width: 1920, height: 1080, fps: 60 },
    source: {
      videoUrl: "/x.mp4",
      videoWidth: 1920,
      videoHeight: 1080,
      viewport: { w: 1920, h: 1080 },
    },
    framing: DEFAULT_FRAMING,
    cursor: { ...DEFAULT_CURSOR },
    start: { x: 200, y: 900 },
    events,
    durationMs: 16000,
    ...over,
  };
}

// two punches with a wide gap: intro before beat 1, tail after beat 2.
function twoBeatComp(over: Partial<TakeComposition> = {}): TakeComposition {
  return comp(
    [
      beat(4000, 1.8, { x: 800, y: 500 }, { durationMs: 400 }),
      beat(9000, 2.2, { x: 1200, y: 700 }, { durationMs: 400 }),
    ],
    over,
  );
}

test("overview rows: intro, one per beat, tail — hold cells inside the real hold window", () => {
  const c = twoBeatComp();
  const plan = buildFramePlan(c);
  assert.equal(plan.rows.length, 4, "in + 2 beats + out");
  assert.equal(plan.rows[0]!.label, "in");
  assert.equal(plan.rows[3]!.label, "out");
  for (const row of plan.rows) assert.equal(row.cells.length, plan.cols);

  const ramps = math.cameraRampSchedule(c);
  c.events.forEach((e, i) => {
    const row = plan.rows[i + 1]!;
    const arrived = Math.max(e.tMs, ramps[i]?.landMs ?? e.tMs);
    const holds = row.cells.filter((cell) => cell.phase === "hold");
    assert.ok(holds.length >= 4, `beat ${i + 1} has ≥4 hold samples`);
    for (const cell of holds)
      assert.ok(
        cell.tMs >= arrived,
        `beat ${i + 1} hold sample ${cell.tMs} is after the landing ${arrived} — never mid-ramp`,
      );
    const travel = row.cells.find((cell) => cell.phase === "travel");
    assert.ok(travel && travel.tMs < arrived, "travel cell sits before the landing");
  });
});

test("hold samples stop before the framing is released toward the next beat", () => {
  const c = twoBeatComp();
  const plan = buildFramePlan(c);
  const ramps = math.cameraRampSchedule(c);
  const nextDeparture = ramps[1]!.startMs;
  for (const cell of plan.rows[1]!.cells.filter((x) => x.phase === "hold"))
    assert.ok(
      cell.tMs <= nextDeparture,
      `beat 1 hold sample ${cell.tMs} predates the next departure ${nextDeparture} — never in the pull-out`,
    );
});

test("startMs head trim: fully-trimmed beats are dropped with a note, no cell before the trim", () => {
  // beat 1's framing releases at beat 2's departure (~8270); a trim past that
  // leaves nothing of beat 1 in the delivered file.
  const c = twoBeatComp({ startMs: 9000 });
  const plan = buildFramePlan(c);
  assert.ok(
    plan.notes.some((n) => n.includes("beat 1")),
    "beat 1 (ends before the trim) is reported, not silently tiled",
  );
  assert.ok(!plan.rows.some((r) => r.label.startsWith("beat 1")));
  for (const row of plan.rows)
    for (const cell of row.cells)
      assert.ok(cell.tMs >= 9000, `cell ${cell.tMs} is inside the delivered range`);
});

test("--beat mode: a 10-cell strip whose phases run travel → hold", () => {
  const c = twoBeatComp();
  const plan = buildFramePlan(c, { beat: 2 });
  const cells = plan.rows.flatMap((r) => r.cells);
  assert.equal(cells.length, 10);
  const phases = cells.map((x) => x.phase);
  assert.ok(phases.includes("travel") && phases.includes("hold"));
  const firstHold = phases.indexOf("hold");
  assert.ok(
    phases.slice(0, firstHold).every((p) => p === "travel"),
    "no hold cell before the landing",
  );
  assert.throws(() => buildFramePlan(c, { beat: 3 }), /out of range/);
});

test("sheet labels non-hold cells and carries the head-trim note", () => {
  const c = twoBeatComp({ startMs: 1000 });
  const plan = buildFramePlan(c);
  const sheet = buildFrameSheet(plan, "/tmp/demo.frames.png", 1000);
  assert.ok(sheet.includes("head −1.0s"));
  assert.ok(sheet.includes("(travel)"), "mid-motion cells are labeled");
  assert.ok(sheet.includes("HOLD cells"), "the judging rule is printed");
});

test("take family: the working dir's draft.mp4 resolves to the same take", async () => {
  // built with the platform's own separators/drive so this holds on Windows too
  const dir = resolve("nowhere");
  const take = await resolveTakePaths(join(dir, "demo.take", "draft.mp4"));
  assert.equal(take.name, "demo");
  assert.equal(take.base, join(dir, "demo"));
  assert.equal(take.mp4Path, join(dir, "demo.mp4"));
  assert.equal(take.draftPath, join(dir, "demo.take", "draft.mp4"));
});
