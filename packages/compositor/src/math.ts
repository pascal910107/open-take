// Pure, isomorphic math — imported by both the node-side planner and the
// revideo scene (compiled fresh by vite at render time). No node/browser
// APIs in here.

import type { BBox, Pt, TakeComposition } from "./types";

// smootherstep 6t^5-15t^4+10t^3
export function smoother(t: number): number {
  t = Math.max(0, Math.min(1, t));
  return t * t * t * (t * (t * 6 - 15) + 10);
}

// Cubic-bezier easing y(x) with endpoints (0,0),(1,1) and control points
// (x1,y1),(x2,y2) — the same model CSS easing uses. Solves x(s)=x by
// bisection (cheap, monotone) then returns y(s). Lets the travel cursor use a
// decelerate-biased curve (long, gentle settle) instead of symmetric easing.
export function cubicBezier(x1: number, y1: number, x2: number, y2: number): (x: number) => number {
  const bx = (s: number) => {
    const u = 1 - s;
    return 3 * u * u * s * x1 + 3 * u * s * s * x2 + s * s * s;
  };
  const by = (s: number) => {
    const u = 1 - s;
    return 3 * u * u * s * y1 + 3 * u * s * s * y2 + s * s * s;
  };
  return (x: number) => {
    if (x <= 0) return 0;
    if (x >= 1) return 1;
    let lo = 0,
      hi = 1,
      s = x;
    for (let i = 0; i < 24; i++) {
      const xt = bx(s);
      if (Math.abs(xt - x) < 1e-4) break;
      if (xt < x) lo = s;
      else hi = s;
      s = (lo + hi) / 2;
    }
    return by(s);
  };
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
  const cx =
    videoW * scale >= outW ? Math.min(Math.max(center.x, halfW), videoW - halfW) : videoW / 2;
  const cy =
    videoH * scale >= outH ? Math.min(Math.max(center.y, halfH), videoH - halfH) : videoH / 2;
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

  // Framing anchors over time. A zoom-enabled beat ramps to its target; a
  // scroll (content pans) and a zoom-less press (Escape/Enter whose effect is
  // global) ramp back to REST so the frame is full-view through them — without
  // these, a prior zoom would persist across the scroll/keypress. Other
  // disabled beats (a "never" click) keep holding the prior framing, unchanged.
  type Anchor = { tMs: number; durationMs: number; inAtMs: number; scale: number; center: Pt };
  const anchors: Anchor[] = [];
  for (const e of comp.events) {
    const base = { tMs: e.tMs, durationMs: e.durationMs ?? 0, inAtMs: e.zoom.inAtMs };
    if (e.kind === "scroll" || (e.kind === "press" && !e.zoom.enabled)) {
      anchors.push({ ...base, scale: rest, center: restC });
    } else if (e.zoom.enabled) {
      anchors.push({ ...base, scale: e.zoom.scale, center: e.zoom.center });
    }
  }

  const frames: { t: number; s: number; c: Pt }[] = [{ t: 0, s: rest, c: restC }];
  const push = (t: number, s: number, c: Pt) => {
    const last = frames[frames.length - 1]!;
    frames.push({ t: Math.max(t, last.t + 1e-3), s, c });
  };

  let cur = { s: rest, c: restC };
  anchors.forEach((e, i) => {
    const rampStart = e.inAtMs / 1000;
    const clickT = e.tMs / 1000;
    // the action plays out (typing/drawing/scrolling) for durationMs after tMs
    // — hold the target framing through it (a point click has duration 0).
    const actionEnd = (e.tMs + e.durationMs) / 1000;
    push(rampStart, cur.s, cur.c); // hold current until ramp begins
    push(clickT, e.scale, e.center); // ramp to target by the action
    cur = { s: e.scale, c: e.center };
    const next = anchors[i + 1];
    if (next) {
      // hold target until the next anchor begins ramping (then it pans)
      push(next.inAtMs / 1000, cur.s, cur.c);
    } else {
      const holdEnd = actionEnd + HOLD;
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

// A `drag` leg carries the polyline the cursor follows with the button held
// (no perpendicular arc — it traces the real stroke). A normal travel leg has
// no path and gets the gentle arc.
type Leg = {
  t0: number;
  t1: number;
  a: Pt;
  b: Pt;
  drag?: boolean;
  path?: Pt[];
  ease?: "linear" | "smooth";
};

export function buildLegs(comp: TakeComposition): Leg[] {
  const legs: Leg[] = [];
  let cur: Pt = comp.start;
  // Distance-aware travel: hold a roughly constant on-screen speed (premium
  // feel) instead of a fixed duration (which makes short moves slow + long
  // moves fast). Falls back to the fixed travelMs when speed is unset/0.
  const { travelWidthsPerSec, travelMinMs, travelMaxMs, travelMs } = comp.cursor;
  const speedPxPerMs = (travelWidthsPerSec || 0) * comp.source.videoWidth / 1000;
  const travelDur = (a: Pt, b: Pt): number => {
    if (speedPxPerMs <= 0) return travelMs / 1000;
    const dist = Math.hypot(b.x - a.x, b.y - a.y);
    return Math.min(travelMaxMs, Math.max(travelMinMs, dist / speedPxPerMs)) / 1000;
  };
  for (const e of comp.events) {
    // scroll/press are not pointer-driven — the cursor holds where it was
    // (the content pans / the keyboard acts). No travel leg; `cur` is untouched,
    // so the between-legs parking logic keeps the cursor at its last anchor.
    if (e.kind === "scroll" || e.kind === "press") continue;
    const arrive = e.tMs / 1000;
    // Start travelDur before arrival, but never before the previous leg ended
    // (a long glide into a quick succession would otherwise overlap it — then
    // the move just runs in the available window, a touch faster than target).
    const prevEnd = legs.length ? legs[legs.length - 1]!.t1 : 0;
    const t0 = Math.max(arrive - travelDur(cur, e.point), prevEnd, 0);
    legs.push({ t0, t1: arrive, a: cur, b: e.point }); // travel to anchor
    cur = e.point;
    if (e.kind === "drag" && e.to) {
      // Delay the stroke by dragLagMs so the cursor rides the captured ink front
      // (the ink trails the pen by the capture-pipeline latency). The cursor
      // holds at the start point during the gap [arrive, arrive+lag], then traces
      // — matching when the ink actually appears on screen.
      const lag = comp.cursor.dragLagMs / 1000;
      const start = arrive + lag;
      const dEnd = (e.tMs + (e.durationMs ?? 0)) / 1000 + lag;
      const path = e.path && e.path.length >= 2 ? e.path : [e.point, e.to];
      if (dEnd > start)
        legs.push({ t0: start, t1: dEnd, a: e.point, b: e.to, drag: true, path, ease: e.ease });
      cur = e.to;
    }
  }
  return legs;
}

/** Point a fraction `u` (0..1) along a polyline, parameterised by arc length. */
function alongPath(path: Pt[], u: number): Pt {
  if (path.length === 1) return path[0]!;
  const seg: number[] = [];
  let total = 0;
  for (let i = 0; i < path.length - 1; i++) {
    const d = Math.hypot(path[i + 1]!.x - path[i]!.x, path[i + 1]!.y - path[i]!.y);
    seg.push(d);
    total += d;
  }
  if (total === 0) return path[0]!;
  let target = u * total;
  for (let i = 0; i < seg.length; i++) {
    if (target <= seg[i]! || i === seg.length - 1) {
      const f = seg[i]! > 0 ? target / seg[i]! : 0;
      return {
        x: path[i]!.x + (path[i + 1]!.x - path[i]!.x) * f,
        y: path[i]!.y + (path[i + 1]!.y - path[i]!.y) * f,
      };
    }
    target -= seg[i]!;
  }
  return path[path.length - 1]!;
}

export function cursorPos(t: number, legs: Leg[], comp: TakeComposition): Pt {
  for (const lg of legs) {
    if (lg.t0 <= t && t <= lg.t1) {
      const raw = Math.max(0, Math.min(1, (t - lg.t0) / (lg.t1 - lg.t0)));
      // A drag replays the captured stroke's pacing so the cursor stays locked
      // to the ink: "smooth" (accel-in / decel-out — a natural hand-draw) or
      // "linear" (constant speed). The capture bakes the SAME curve into the ink
      // (cdp-capture.ts) and records it on the event; absent ⇒ linear (legacy).
      // (Held-button moves are fire-and-forget there, so the slow eased ends —
      // sub-pixel, no paint — no longer stall the stroke; cursor and ink are
      // both ~stationary at the ends, so they stay locked.)
      if (lg.drag && lg.path) return alongPath(lg.path, lg.ease === "smooth" ? smoother(raw) : raw);
      const e = comp.cursor.travelEase;
      const p = e ? cubicBezier(e[0], e[1], e[2], e[3])(raw) : smoother(raw);
      const base = { x: lg.a.x + (lg.b.x - lg.a.x) * p, y: lg.a.y + (lg.b.y - lg.a.y) * p };
      const dx = lg.b.x - lg.a.x,
        dy = lg.b.y - lg.a.y;
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

/** True while a drag is mid-stroke (button held) — for the pressed cursor. */
export function isDragging(t: number, legs: Leg[]): boolean {
  return legs.some((lg) => lg.drag === true && lg.t0 <= t && t <= lg.t1);
}
