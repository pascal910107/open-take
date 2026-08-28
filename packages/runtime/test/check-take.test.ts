// checkTake — post-shoot deterministic defect report. Pure checks (zoom on a
// global payoff, dead beats, inventory coverage) run on synthetic
// composition + capture-log pairs; the two pixel checks run on tiny lavfi
// clips generated at test time (a blank-then-busy capture → dead-opening
// recovers the blank head; a frozen-tail delivery → static-tail flags; a
// busy control → neither fires).

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { CaptureLog } from "@open-take/compositor";
import { planComposition, resolveFfmpeg } from "@open-take/compositor";
import { checkTake, type InventoryRule } from "../src/check-take";

const VW = 1280,
  VH = 720;

function log(events: CaptureLog["events"], extra: Partial<CaptureLog> = {}): CaptureLog {
  return {
    video: { width: VW, height: VH, fps: 60 },
    viewport: { w: VW, h: VH },
    start: { x: 100, y: 600 },
    events,
    ...extra,
  };
}

const box = (x: number, y: number) => ({ x: x - 30, y: y - 20, w: 60, h: 40 });

test("zoom-on-global-payoff: a zoomed beat repainting 30% of the frame warns; a local one is clean", async () => {
  const l = log([
    {
      kind: "click",
      x: 200,
      y: 200,
      box: box(200, 200),
      tMs: 1000,
      zoom: "always",
      note: "Toggle theme",
      changeCoverage: 0.3,
      effectBox: { x: 0, y: 0, w: VW, h: VH },
    },
    {
      kind: "click",
      x: 900,
      y: 500,
      box: box(900, 500),
      tMs: 3000,
      zoom: "always",
      changeCoverage: 0.05,
      effectBox: { x: 860, y: 460, w: 120, h: 80 },
    },
  ]);
  const c = planComposition(l, { output: { fps: 60 } });
  assert.ok(c.events[0]!.zoom.enabled, "precondition: zoom:'always' keeps the beat zoomed");
  const issues = await checkTake({ composition: c, captureLog: l });
  const z = issues.filter((i) => i.path.endsWith(".zoom.enabled"));
  assert.equal(z.length, 1, "only the global payoff is flagged");
  assert.equal(z[0]!.path, "events[0].zoom.enabled");
  assert.equal(z[0]!.severity, "warn");
  assert.match(z[0]!.message, /30% of the frame/, "quantifies the repaint");
  assert.match(z[0]!.fix ?? "", /events\[0\]\.zoom\.enabled=false/, "computed fix");
});

test("dead-beat: coverage 0 warns, an annotated live beat and an unannotated beat stay quiet", async () => {
  const l = log([
    // annotated, changed nothing → warn (but only warn: a 1px outline can score 0)
    {
      kind: "click",
      x: 200,
      y: 200,
      box: box(200, 200),
      tMs: 1000,
      zoom: "never",
      changeCoverage: 0,
    },
    // annotated with a real payoff → clean
    {
      kind: "click",
      x: 600,
      y: 400,
      box: box(600, 400),
      tMs: 3000,
      zoom: "never",
      changeCoverage: 0.08,
      effectBox: { x: 560, y: 360, w: 120, h: 80 },
    },
    // never annotated → nothing measured, nothing said
    { kind: "click", x: 900, y: 500, box: box(900, 500), tMs: 5000, zoom: "never" },
  ]);
  const c = planComposition(l, { output: { fps: 60 } });
  const issues = await checkTake({ composition: c, captureLog: l });
  const dead = issues.filter((i) => i.path === "events[0]");
  assert.equal(dead.length, 1, "flags the dead beat");
  assert.equal(dead[0]!.severity, "warn", "warn, not error — subtle effects can measure 0");
  assert.match(dead[0]!.message, /no visible payoff/);
  assert.ok(!issues.some((i) => i.path === "events[1]" || i.path === "events[2]"), "no noise");
});

test("paintedFrac > 0.2 disables both coverage checks (canvas apps are diff-blind)", async () => {
  const l = log(
    [
      {
        kind: "click",
        x: 200,
        y: 200,
        box: box(200, 200),
        tMs: 1000,
        zoom: "always",
        changeCoverage: 0.4,
      },
      {
        kind: "click",
        x: 600,
        y: 400,
        box: box(600, 400),
        tMs: 3000,
        zoom: "never",
        changeCoverage: 0,
      },
    ],
    { paintedFrac: 0.5 },
  );
  const c = planComposition(l, { output: { fps: 60 } });
  const issues = await checkTake({ composition: c, captureLog: l });
  assert.equal(
    issues.filter((i) => i.path.startsWith("events[")).length,
    0,
    "coverage means nothing over a paint surface — both checks stand down",
  );
});

test("inventory: uncovered rules land in ONE error naming exactly them", async () => {
  const l = log([
    { kind: "click", x: 200, y: 100, box: box(200, 100), tMs: 1000, note: "Save to source" },
    { kind: "press", keys: "Meta+b", x: 600, y: 400, tMs: 3000, durationMs: 400 },
  ]);
  const c = planComposition(l, { output: { fps: 60 } });
  const rules: InventoryRule[] = [
    // covered by the click's label (case-insensitive)
    { name: "save-to-source", match: { action: "click", targetIncludes: ["save"] } },
    // covered by the press's keys
    { name: "bold", match: { targetIncludes: ["bold", "meta+b"] } },
    // uncovered: no matching label anywhere
    { name: "alignment", match: { action: "click", targetIncludes: ["center", "left", "right"] } },
    // uncovered: action-only rule, no drag in the take
    { name: "reorder-by-drag", match: { action: "drag" } },
  ];
  const issues = await checkTake({ composition: c, captureLog: l, inventory: rules });
  const errs = issues.filter((i) => i.severity === "error");
  assert.equal(errs.length, 1, "one error for the whole list");
  assert.equal(errs[0]!.path, "events");
  assert.match(errs[0]!.message, /alignment, reorder-by-drag/, "names the uncovered rules");
  assert.doesNotMatch(errs[0]!.message, /save-to-source|bold/, "covered rules are not listed");
  assert.match(errs[0]!.message, /shown or explicitly waived/);
  // no rules supplied → the check does not run
  const none = await checkTake({ composition: c, captureLog: l });
  assert.equal(none.filter((i) => i.severity === "error").length, 0);
});

test("pixel checks: dead-opening on the capture, static-tail on the delivery, clean control", async (t) => {
  let bin: string;
  try {
    bin = await resolveFfmpeg();
  } catch {
    t.skip("no ffmpeg available");
    return;
  }
  const work = await mkdtemp(join(tmpdir(), "open-take-ct-"));
  const clip = (name: string, filter: string): Promise<string> => {
    const out = join(work, name);
    return new Promise((res, rej) => {
      const c = spawn(
        bin,
        ["-v", "error", "-y", "-f", "lavfi", "-i", filter, "-pix_fmt", "yuv420p", out],
        {
          stdio: ["ignore", "ignore", "inherit"],
        },
      );
      c.on("error", rej);
      c.on("close", (code) => (code === 0 ? res(out) : rej(new Error(`ffmpeg ${code}`))));
    });
  };
  try {
    const busySrc = "testsrc=size=320x180:rate=20:d=4";
    const flat = "drawbox=x=0:y=0:w=iw:h=ih:c=gray:t=fill";
    const [blankHead, frozenTail, busy] = await Promise.all([
      // first 0.8s a flat frame, then busy → dead-opening must recover ≈0.8s
      clip("blank-head.mp4", `${busySrc},${flat}:enable='lt(t,0.8)'`),
      // busy for 0.5s, then frozen to the end → static-tail must flag
      clip("frozen-tail.mp4", `${busySrc},${flat}:enable='gte(t,0.5)'`),
      // busy throughout → neither check fires
      clip("busy.mp4", busySrc),
    ]);
    const l = log([
      { kind: "click", x: 100, y: 100, box: box(100, 100), tMs: 1000, zoom: "never" },
    ]);
    const c = planComposition(l, { output: { fps: 60 } });

    // dead-opening: error with a computed startMs near the true 800ms
    const opening = (
      await checkTake({ composition: c, captureLog: l, captureMp4: blankHead })
    ).filter((i) => i.path === "startMs");
    assert.equal(opening.length, 1, "blank head flagged");
    assert.equal(opening[0]!.severity, "error");
    const ms = Number(/startMs ≈ (\d+)/.exec(opening[0]!.fix ?? "")?.[1]);
    assert.ok(ms >= 650 && ms <= 1000, `recovered startMs ${ms} ≈ 800`);
    // a startMs already trimming past the blank clears it
    const trimmed = { ...c, startMs: 1000 };
    assert.equal(
      (await checkTake({ composition: trimmed, captureLog: l, captureMp4: blankHead })).filter(
        (i) => i.path === "startMs",
      ).length,
      0,
      "an already-trimmed head is not a defect",
    );

    // static-tail: warn on the frozen delivery
    const tail = (
      await checkTake({ composition: c, captureLog: l, deliveredMp4: frozenTail })
    ).filter((i) => i.path === "durationMs");
    assert.equal(tail.length, 1, "frozen tail flagged");
    assert.equal(tail[0]!.severity, "warn");
    assert.match(tail[0]!.message, /frozen screen/);
    assert.match(tail[0]!.fix ?? "", /settleMs/);

    // clean control: a busy clip as both capture and delivery raises nothing
    const clean = await checkTake({
      composition: c,
      captureLog: l,
      captureMp4: busy,
      deliveredMp4: busy,
    });
    assert.equal(clean.filter((i) => i.path === "startMs").length, 0, "no dead-opening");
    assert.equal(clean.filter((i) => i.path === "durationMs").length, 0, "no static-tail");

    // missing videos: pixel checks silently skip, never throw
    const skipped = await checkTake({
      composition: c,
      captureLog: l,
      captureMp4: join(work, "nope.mp4"),
      deliveredMp4: join(work, "nope.mp4"),
    });
    assert.equal(skipped.length, 0, "unreadable videos skip their checks");

    // NO capture log at all (an old or cleaned take): the pixel checks read
    // only the mp4s and MUST still run — a lost capture.json must not turn
    // the pixel gates off (only the coverage checks stand down)
    const noLog = await checkTake({
      composition: c,
      captureMp4: blankHead,
      deliveredMp4: frozenTail,
    });
    assert.equal(
      noLog.filter((i) => i.path === "startMs").length,
      1,
      "dead-opening runs without a log",
    );
    assert.equal(
      noLog.filter((i) => i.path === "durationMs").length,
      1,
      "static-tail runs without a log",
    );
  } finally {
    await rm(work, { recursive: true, force: true });
  }
});
