// Pure, isomorphic math — imported by both the node-side planner and the
// revideo scene (compiled fresh by vite at render time). No node/browser
// APIs in here.

import type { BBox, Pt, TakeComposition } from "./types";

// smootherstep 6t^5-15t^4+10t^3
export function smoother(t: number): number {
  t = Math.max(0, Math.min(1, t));
  return t * t * t * (t * (t * 6 - 15) + 10);
}

type KF<T> = [number, T];

export function keyvalN(t: number, kfs: KF<number>[]): number {
  if (t <= kfs[0]![0]) return kfs[0]![1];
  if (t >= kfs[kfs.length - 1]![0]) return kfs[kfs.length - 1]![1];
  for (let i = 0; i < kfs.length - 1; i++) {
    const [t0, v0] = kfs[i]!;
    const [t1, v1] = kfs[i + 1]!;
    if (t0 <= t && t <= t1) return v0 + (v1 - v0) * smoother((t - t0) / (t1 - t0));
  }
  return kfs[kfs.length - 1]![1];
}

export function keyvalP(t: number, kfs: KF<Pt>[]): Pt {
  if (t <= kfs[0]![0]) return kfs[0]![1];
  if (t >= kfs[kfs.length - 1]![0]) return kfs[kfs.length - 1]![1];
  for (let i = 0; i < kfs.length - 1; i++) {
    const [t0, v0] = kfs[i]!;
    const [t1, v1] = kfs[i + 1]!;
    if (t0 <= t && t <= t1) {
      const p = smoother((t - t0) / (t1 - t0));
      return { x: v0.x + (v1.x - v0.x) * p, y: v0.y + (v1.y - v0.y) * p };
    }
  }
  return kfs[kfs.length - 1]![1];
}

// --- bbox-fit zoom (Finding 1) -----------------------------------------

/**
 * Scale (absolute, video-px → output-px) that fits `bbox` into `fillFrac`
 * of the output frame, capped at `maxScale` and floored at `restScale`.
 * Wide/long elements naturally get a gentler scale because the limiting
 * dimension dominates min().
 */
export function bboxFitScale(
  bbox: BBox,
  outW: number,
  outH: number,
  fillFrac: number,
  maxScale: number,
  restScale: number,
): number {
  const fitW = (outW * fillFrac) / Math.max(1, bbox.w);
  const fitH = (outH * fillFrac) / Math.max(1, bbox.h);
  return Math.min(maxScale, Math.max(restScale, Math.min(fitW, fitH)));
}

/** Stage scale at rest: video inset into the frame (leaves backdrop margin). */
export function restStageScale(
  videoW: number,
  videoH: number,
  outW: number,
  outH: number,
  insetFrac: number,
): number {
  return insetFrac * Math.min(outW / videoW, outH / videoH);
}

/**
 * Clamp a desired video-px center so the scaled video still covers the
 * output frame (no backdrop leak) when zoomed in. When the content does
 * not cover an axis (zoomed out / inset), centre that axis.
 */
export function clampCenter(
  center: Pt,
  scale: number,
  videoW: number,
  videoH: number,
  outW: number,
  outH: number,
): Pt {
  const halfW = outW / (2 * scale);
  const halfH = outH / (2 * scale);
  const cx = videoW * scale >= outW ? Math.min(Math.max(center.x, halfW), videoW - halfW) : videoW / 2;
  const cy = videoH * scale >= outH ? Math.min(Math.max(center.y, halfH), videoH - halfH) : videoH / 2;
  return { x: cx, y: cy };
}

// --- stage (zoom/pan) keyframes from the composition -------------------

export type StageKeyframes = {
  z: KF<number>[]; // absolute stage scale over time (seconds)
  c: KF<Pt>[]; // raw video-px center over time (clamp at eval)
  T: number; // total duration (s)
};

export function buildStageKeyframes(comp: TakeComposition): StageKeyframes {
  const { videoWidth: vW, videoHeight: vH } = comp.source;
  const { width: oW, height: oH } = comp.output;
  const rest = restStageScale(vW, vH, oW, oH, comp.framing.insetFrac);
  const restC: Pt = { x: vW / 2, y: vH / 2 };
  const HOLD = comp.cursor.holdMs / 1000;
  const ZOUT = comp.cursor.zoomOutMs / 1000;

  const enabled = comp.events.filter((e) => e.zoom.enabled);
  const frames: { t: number; s: number; c: Pt }[] = [{ t: 0, s: rest, c: restC }];
  const push = (t: number, s: number, c: Pt) => {
    const last = frames[frames.length - 1]!;
    frames.push({ t: Math.max(t, last.t + 1e-3), s, c });
  };

  let cur = { s: rest, c: restC };
  enabled.forEach((e, i) => {
    const rampStart = e.zoom.inAtMs / 1000;
    const clickT = e.tMs / 1000;
    push(rampStart, cur.s, cur.c); // hold current until ramp begins
    push(clickT, e.zoom.scale, e.zoom.center); // ramp to target by click
    cur = { s: e.zoom.scale, c: e.zoom.center };
    const next = enabled[i + 1];
    if (next) {
      // hold target until the next zoom begins ramping (then it pans)
      push(next.zoom.inAtMs / 1000, cur.s, cur.c);
    } else {
      const holdEnd = clickT + HOLD;
      push(holdEnd, cur.s, cur.c);
      push(holdEnd + ZOUT, rest, restC); // zoom back out
      cur = { s: rest, c: restC };
    }
  });

  const T = Math.max(comp.durationMs / 1000, frames[frames.length - 1]!.t) + 0.3;
  push(T, rest, restC);

  return { z: frames.map((f) => [f.t, f.s]), c: frames.map((f) => [f.t, f.c]), T };
}

// --- cursor path (eased, with gentle arc) ------------------------------

type Leg = { t0: number; t1: number; a: Pt; b: Pt };

export function buildLegs(comp: TakeComposition): Leg[] {
  const wp: Pt[] = [comp.start, ...comp.events.map((e) => e.point)];
  return comp.events.map((e, i) => ({
    t0: (e.tMs - comp.cursor.travelMs) / 1000,
    t1: e.tMs / 1000,
    a: wp[i]!,
    b: wp[i + 1]!,
  }));
}

export function cursorPos(t: number, legs: Leg[], comp: TakeComposition): Pt {
  for (const lg of legs) {
    if (lg.t0 <= t && t <= lg.t1) {
      const p = smoother((t - lg.t0) / (lg.t1 - lg.t0));
      const base = { x: lg.a.x + (lg.b.x - lg.a.x) * p, y: lg.a.y + (lg.b.y - lg.a.y) * p };
      const dx = lg.b.x - lg.a.x, dy = lg.b.y - lg.a.y;
      const L = Math.hypot(dx, dy) || 1;
      const arc = Math.min(comp.cursor.arcFrac * L, comp.cursor.arcMax) * Math.sin(Math.PI * p);
      return { x: base.x + (-dy / L) * arc, y: base.y + (dx / L) * arc };
    }
  }
  if (legs.length === 0 || t < legs[0]!.t0) return comp.start;
  for (let i = 0; i < legs.length - 1; i++)
    if (legs[i]!.t1 < t && t < legs[i + 1]!.t0) return legs[i]!.b;
  return legs[legs.length - 1]!.b;
}
