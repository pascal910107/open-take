// Drawn-cursor audit — the pixel-INDEPENDENT parts, tested without any mp4
// (videos are never committed): the template+NCC search is exercised by
// compositing the rasterised template into a synthetic gray frame at a known
// position, the geometry path by predicting tips for a tiny synthetic
// composition, and the issue voice by fabricating measured rows. Real-frame
// extraction (ffmpeg → raw gray pipe) is the one unexercised seam; it is
// factored into a single private function auditCursor alone calls.

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  type AuditRow,
  auditIssues,
  findCursor,
  type GrayFrame,
  makeCursorTemplate,
  predictCursorTips,
} from "../src/audit-cursor.js";
import { buildLegs } from "../src/math.js";
import type { TakeComposition } from "../src/types.js";
import { DEFAULT_CURSOR, DEFAULT_FRAMING } from "../src/types.js";

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

/** Uniform mid-gray frame — page content the sprite must stand out from. */
function grayFrame(width: number, height: number, value = 0.55): GrayFrame {
  const data = new Float32Array(width * height).fill(value);
  return { data, width, height };
}

/** Stamp the rasterised template into a frame with its TIP at (tipX, tipY) —
 *  exactly what the renderer would have drawn, minus antialias noise. */
function stampCursor(frame: GrayFrame, scale: number, tipX: number, tipY: number): void {
  const tpl = makeCursorTemplate(scale);
  const x0 = Math.round(tipX - tpl.tip.x);
  const y0 = Math.round(tipY - tpl.tip.y);
  for (let ty = 0; ty < tpl.height; ty++) {
    for (let tx = 0; tx < tpl.width; tx++) {
      const j = ty * tpl.width + tx;
      if (tpl.mask[j]! > 0.15) frame.data[(y0 + ty) * frame.width + x0 + tx] = tpl.pixels[j]!;
    }
  }
}

test("template: tip anchor, sprite pixels, and scale-following extents", () => {
  const a = makeCursorTemplate(2.0);
  assert.deepEqual(a.tip, { x: 1.5, y: 1.5 });
  assert.equal(a.width, Math.ceil(12 * 2) + 9);
  assert.equal(a.height, Math.ceil(19.5 * 2) + 9);
  let masked = 0;
  for (let i = 0; i < a.mask.length; i++) if (a.mask[i]! > 0.15) masked++;
  assert.ok(masked > 100, `sprite has real coverage (${masked} px)`);
  // both tones present: the dark body AND the white outline are what NCC keys on
  const vals = Array.from(a.pixels).filter((_, i) => a.mask[i]! > 0.5);
  assert.ok(Math.min(...vals) < 0.2 && Math.max(...vals) > 0.8, "dark body + white outline");
  const b = makeCursorTemplate(4.0);
  assert.ok(b.width > a.width && b.height > a.height, "the template grows with on-screen scale");
});

test("NCC search: an exactly-placed cursor is found within 1px, near-perfect score", () => {
  const scale = 2.0;
  // tip at (201.5, 151.5): tip offset 1.5 makes the stamp land on integer pixels
  const frame = grayFrame(400, 300);
  stampCursor(frame, scale, 201.5, 151.5);
  const { ncc, found } = findCursor(frame, { x: 201.5, y: 151.5 }, scale);
  assert.ok(found, "a match position is returned");
  const err = Math.hypot(found.x - 201.5, found.y - 151.5);
  assert.ok(err <= 1, `exact placement found within 1px (err ${err.toFixed(2)})`);
  assert.ok(ncc > 0.99, `stamped sprite correlates ~1 (ncc ${ncc.toFixed(3)})`);
});

test("NCC search: a cursor drawn 8px from its intent reports err ≈ 8", () => {
  const scale = 2.0;
  const frame = grayFrame(400, 300);
  stampCursor(frame, scale, 209.5, 151.5); // 8px right of where it should be
  const { ncc, found } = findCursor(frame, { x: 201.5, y: 151.5 }, scale);
  assert.ok(found, "a match position is returned");
  const err = Math.hypot(found.x - 201.5, found.y - 151.5);
  assert.ok(Math.abs(err - 8) <= 1, `offset measured (err ${err.toFixed(2)} ≈ 8)`);
  assert.ok(ncc > 0.99, "still a clean match — offset, not unmatched");
});

test("NCC search: pure noise never matches (low ncc)", () => {
  const frame = grayFrame(300, 220);
  let seed = 42; // deterministic LCG — the test must not flake
  for (let i = 0; i < frame.data.length; i++) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    frame.data[i] = (seed % 1000) / 1000;
  }
  const { ncc } = findCursor(frame, { x: 150, y: 110 }, 2.0);
  assert.ok(ncc < 0.5, `noise stays under the match floor (ncc ${ncc.toFixed(3)})`);
});

test("geometry: a centered target predicts a finite tip inside the output, near center", () => {
  const c = comp([beat(3000, 2.0, { x: 960, y: 540 })]);
  const preds = predictCursorTips(c);
  assert.equal(preds.length, 1);
  const p = preds[0]!;
  assert.ok(Number.isFinite(p.expect.x) && Number.isFinite(p.expect.y), "finite tip");
  assert.ok(!p.offscreen, "a centered target stays in frame");
  assert.ok(p.expect.x >= 0 && p.expect.x < VW && p.expect.y >= 0 && p.expect.y < VH);
  // pointer == zoom center ⇒ the tip maps to (near) frame center at any scale
  assert.ok(Math.abs(p.expect.x - VW / 2) < 30 && Math.abs(p.expect.y - VH / 2) < 30);
  assert.ok(p.camScale > 1, "sampled while punched in");
  assert.ok(p.sampleMs >= 3000 && p.sampleMs <= 3500, "samples inside the hold after landing");
});

test("geometry: a zoom framing away from the pointer marks the beat offscreen", () => {
  // camera punches 2.4× at the right edge while the pointer sits at x=100 —
  // the tip maps far left of the frame (the validated unverifiable case)
  const ev: Ev = {
    kind: "click",
    tMs: 3000,
    point: { x: 100, y: 540 },
    zoom: { enabled: true, scale: 2.4, center: { x: 1800, y: 540 }, inAtMs: 2270, reason: "test" },
  } as Ev;
  const preds = predictCursorTips(comp([ev]));
  assert.equal(preds.length, 1);
  assert.ok(preds[0]!.offscreen, "tip out of frame ⇒ offscreen, not an error");
  assert.ok(
    preds[0]!.expect.x < 0,
    `tip maps left of the frame (${preds[0]!.expect.x.toFixed(0)})`,
  );
});

test("geometry: a startMs head trim past the sample marks the beat offscreen", () => {
  const c = comp([beat(3000, 1.6, { x: 960, y: 540 }), beat(9000, 1.6, { x: 900, y: 500 })]);
  c.startMs = 4000; // the first beat's sample (~3500ms) is cut from the delivery
  const preds = predictCursorTips(c);
  assert.ok(preds[0]!.tSec < 0 && preds[0]!.offscreen, "trimmed-out sample is unverifiable");
  assert.ok(!preds[1]!.offscreen, "later beats still audit");
});

test("geometry: the sample clamps inside the hold — never into the next travel", () => {
  const c = comp([beat(3000, 1.6, { x: 960, y: 540 }), beat(3900, 1.6, { x: 1700, y: 200 })]);
  const preds = predictCursorTips(c);
  const depart = buildLegs(c).find((l) => l.t0 * 1000 > 3001)!;
  assert.ok(
    preds[0]!.sampleMs <= depart.t0 * 1000,
    `sample ${preds[0]!.sampleMs} stays before the next departure ${depart.t0 * 1000}`,
  );
  assert.ok(preds[0]!.sampleMs < 3500, "the 500ms default was clamped down");
  assert.ok(preds[0]!.sampleMs >= 3000, "never before the landing");
});

test("issues: clean rows produce none; offscreen rows one warn naming the beats", () => {
  const clean: AuditRow[] = [
    {
      beat: 0,
      tSec: 1,
      expect: { x: 100, y: 100 },
      found: { x: 100.5, y: 100 },
      errViewportPx: 0.3,
      ncc: 0.83,
    },
  ];
  assert.deepEqual(auditIssues(clean, 6), []);
  const rows: AuditRow[] = [
    ...clean,
    { beat: 3, tSec: 4, expect: { x: -2448, y: 540 }, offscreen: true },
    { beat: 5, tSec: 6, expect: { x: 2100, y: 300 }, offscreen: true },
  ];
  const issues = auditIssues(rows, 6);
  assert.equal(issues.length, 1);
  assert.equal(issues[0]!.severity, "warn");
  assert.ok(/events\[3\]/.test(issues[0]!.message) && /events\[5\]/.test(issues[0]!.message));
  assert.ok(issues[0]!.fix, "the warn carries a concrete fix");
});

test("issues: one error distinguishing matched-but-offset from never-matched", () => {
  const rows: AuditRow[] = [
    {
      beat: 0,
      tSec: 1,
      expect: { x: 100, y: 100 },
      found: { x: 100.4, y: 100 },
      errViewportPx: 0.2,
      ncc: 0.82,
    },
    // matched (ncc 0.61 ≈ the measured 8% skew) but 8.6 viewport px off
    {
      beat: 1,
      tSec: 2,
      expect: { x: 200, y: 200 },
      found: { x: 217.2, y: 200 },
      errViewportPx: 8.6,
      ncc: 0.61,
    },
    // never matched (ncc 0.42 ≈ the measured 13% skew) — err must read as meaningless
    {
      beat: 2,
      tSec: 3,
      expect: { x: 300, y: 300 },
      found: { x: 301, y: 300 },
      errViewportPx: 0.5,
      ncc: 0.42,
    },
  ];
  const issues = auditIssues(rows, 6);
  assert.equal(issues.length, 1);
  const e = issues[0]!;
  assert.equal(e.severity, "error");
  assert.ok(/events\[1\].*8\.6px.*matched/.test(e.message), "offset beat: err + 'matched'");
  assert.ok(/events\[2\].*never matched.*0\.42/.test(e.message), "unmatched beat: distinct voice");
  assert.ok(/2 of 3/.test(e.message), "counts verifiable beats");
});

test("issues: a shared offset across failing beats computes the skew vector into the fix", () => {
  // two beats offset by the same vector (output px = 2× viewport px here)
  const rows: AuditRow[] = [
    {
      beat: 0,
      tSec: 1,
      expect: { x: 100, y: 100 },
      found: { x: 116, y: 100 },
      errViewportPx: 8,
      ncc: 0.62,
    },
    {
      beat: 1,
      tSec: 2,
      expect: { x: 400, y: 300 },
      found: { x: 415, y: 302 },
      errViewportPx: 7.57,
      ncc: 0.64,
    },
  ];
  const issues = auditIssues(rows, 6);
  assert.equal(issues.length, 1);
  assert.ok(issues[0]!.fix, "error carries a fix");
  assert.ok(
    /shares one offset ≈ \(\+7\.\d, \+0\.\d\)/.test(issues[0]!.fix!),
    `fix carries the computed skew (got: ${issues[0]!.fix})`,
  );
});
