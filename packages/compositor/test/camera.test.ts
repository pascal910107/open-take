// The auto-camera acceptance: a capture log with NO `zoom` field on any event
// must still come out with sensible framing — type framed (not the thin strip),
// a cluster held as one frame, nav/scroll pulled to full view, no flicker.
// These are the "換個 agent 就漏 zoom" cases, decided by the tool from the log.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { planComposition } from "../src/plan.js";
import { restStageScale } from "../src/math.js";
import type { CaptureLog } from "../src/types.js";

const fixture = (name: string): CaptureLog =>
  JSON.parse(
    readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)), "utf8"),
  ) as CaptureLog;

test("nav-with-type: a zoom-less plan auto-frames sensibly (the flatten case)", () => {
  const log = fixture("nav-with-type.capture.json");
  // sanity: the fixture really specifies no zoom intent anywhere
  assert.ok(
    log.events.every((e) => e.zoom == null),
    "fixture must carry NO zoom intent — the director decides everything",
  );

  const comp = planComposition(log, { output: { fps: 60 } });
  const e = comp.events;
  const rest = restStageScale(1920, 1080, 1920, 1080, comp.framing.insetFrac);
  const byNote = (frag: string) => e.find((ev) => (ev.label ?? "").includes(frag))!;

  // it must NOT come out flat — several beats zoom
  assert.ok(e.filter((ev) => ev.zoom.enabled).length >= 4, "the demo is not flat");

  // E1 Features (nav, first) — full view (orienting + global repaint)
  assert.equal(byNote("Features").zoom.enabled, false, "nav beat 1 holds full view");

  // E2 Pricing (nav, coverage 0.78) — full view via changeCoverage, NOT a punch
  const pricing = byNote("Pricing");
  assert.equal(pricing.zoom.enabled, false, "nav beat 2 pulls out (global repaint)");
  assert.match(pricing.zoom.reason, /coverage/i, "E2 reason cites the changed-area signal");

  // E3 type — framed, medium scale, centre BELOW the thin field (ROI grew down)
  const type = e.find((ev) => ev.kind === "type")!;
  assert.equal(type.zoom.enabled, true, "type is framed");
  assert.ok(type.zoom.scale > 1.4 && type.zoom.scale < 2.0, `type is medium (${type.zoom.scale.toFixed(2)}×)`);
  const fieldCenterY = type.bbox!.y + type.bbox!.h / 2;
  assert.ok(type.zoom.center.y > fieldCenterY + 80, "type frame sits below the field (result region)");

  // E4 Enter — coalesces with the type (same shared frame, camera holds)
  const enter = e.find((ev) => ev.kind === "press")!;
  assert.equal(enter.zoom.enabled, true, "Enter shares the type's frame");
  assert.ok(Math.abs(enter.zoom.scale - type.zoom.scale) < 1e-6, "Enter holds the type's scale");
  assert.deepEqual(enter.zoom.center, type.zoom.center, "Enter holds the type's centre");
  assert.match(enter.zoom.reason, /cluster/i, "Enter reason marks the cluster");

  // E5–E7 rail — one sustained TIGHT frame across three quick icon hits
  const rail = e.filter((ev) => (ev.label ?? "").startsWith("thumb"));
  assert.equal(rail.length, 3, "three rail beats");
  assert.ok(rail.every((r) => r.zoom.enabled), "all rail beats zoom");
  assert.ok(rail.every((r) => r.zoom.scale > 2.0), `rail is tight (${rail[0]!.zoom.scale.toFixed(2)}×)`);
  assert.ok(
    rail.every(
      (r) => Math.abs(r.zoom.scale - rail[0]!.zoom.scale) < 1e-6 && r.zoom.center.x === rail[0]!.zoom.center.x,
    ),
    "the rail is ONE shared frame (no per-beat re-punch)",
  );
  assert.match(rail[1]!.zoom.reason, /cluster/i, "rail beats marked as a cluster");

  // E8 scroll — full view (hard break)
  const scroll = e.find((ev) => ev.kind === "scroll")!;
  assert.equal(scroll.zoom.enabled, false, "scroll pulls out to full view");
  assert.ok(Math.abs(scroll.zoom.scale - rest) < 1e-6, "scroll scale is rest");
});

test("type with a tall open-ended effectBox still punches (not flattened to ~1×)", () => {
  // A real search: a thin field whose result list grows DOWN and fills most of
  // the viewport, so the frame-diff effectBox is ~640px tall. Fitting ALL of it
  // into 60% of the frame is ~1.01× — imperceptible. The director must cap the
  // type's ROI to the field-anchored result window so the punch stays visible.
  // (This is the case the acceptance fixture's 340px effectBox does NOT reach.)
  const log: CaptureLog = {
    video: { width: 1920, height: 1080, fps: "60/1" },
    viewport: { w: 1920, h: 1080 },
    start: { x: 520, y: 480 },
    events: [
      {
        kind: "type",
        x: 960,
        y: 183,
        box: { x: 641, y: 163, w: 638, h: 39 },
        effectBox: { x: 640, y: 160, w: 672, h: 640 }, // open-ended result list
        tMs: 2000,
        text: "Interrupt",
        durationMs: 700,
        zoom: "always",
        changeCoverage: 0.19,
      },
    ],
    tEndMs: 5000,
  };
  const type = planComposition(log, { output: { fps: 60 } }).events[0]!;
  assert.equal(type.zoom.enabled, true, "the always-type is framed");
  // the raw-effectBox fit would be ~1.01× (648/640) — the cap must keep it a
  // real, visible punch centred below the field.
  assert.ok(
    type.zoom.scale > 1.4 && type.zoom.scale < 2.0,
    `tall-effectBox type stays a visible punch, not ~1× (got ${type.zoom.scale.toFixed(3)}×)`,
  );
  assert.ok(type.zoom.center.y > 163 + 39 + 80, "the frame sits below the field (result region)");
});

test("camera.enabled=false: the manual escape hatch ignores the director", () => {
  const log = fixture("nav-with-type.capture.json");
  const comp = planComposition(log, { output: { fps: 60 }, camera: { enabled: false } });
  // no event has an explicit intent → nothing zooms
  assert.ok(comp.events.every((ev) => !ev.zoom.enabled), "camera off + no intent ⇒ all full view");
  assert.ok(comp.events.every((ev) => /camera off/.test(ev.zoom.reason)), "reasons say camera off");
});
