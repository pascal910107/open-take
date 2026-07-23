// Pure, isomorphic math — imported by both the node-side planner and the
// revideo scene (compiled fresh by vite at render time). No node/browser
// APIs in here.

import type { BBox, Pt, TakeComposition } from "./types";

// smootherstep 6t^5-15t^4+10t^3
export function smoother(t: number): number {
  const clamped = Math.max(0, Math.min(1, t));
  return clamped * clamped * clamped * (clamped * (clamped * 6 - 15) + 10);
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

// Spring-shaped easing y(p) over [0,1]: the unit step response of a damped
// spring, time-normalised so it rises (and, for bounce>0, slightly overshoots)
// then settles within the segment. `bounce` ∈ [0, ~0.6): 0 = critically damped
// (no overshoot — a soft, physical ease-out); higher = more overshoot/snap. The
// "silky" landing comes from a touch of overshoot (a near-critically-damped
// zoom spring, bounce ~0.06; a snappier cursor ~0.13).
//
// Under time-normalisation the curve depends ONLY on the damping ratio ζ=1−bounce
// (the natural frequency cancels), so a single `bounce` knob is the whole shape —
// the segment DURATION stays whatever the keyframes say (zoomInMs/zoomOutMs).
export function springEase(bounce: number): (p: number) => number {
  const zeta = Math.max(0.4, Math.min(1, 1 - bounce));
  const Ts = -Math.log(1e-3) / zeta; // settling time to the 0.1% band (ω0 = 1)
  return (p: number) => {
    if (p <= 0) return 0;
    if (p >= 1) return 1;
    const t = p * Ts;
    if (zeta >= 1) return 1 - Math.exp(-t) * (1 + t); // critically damped
    const wd = Math.sqrt(1 - zeta * zeta); // damped natural frequency (ω0 = 1)
    return 1 - Math.exp(-zeta * t) * (Math.cos(wd * t) + (zeta / wd) * Math.sin(wd * t));
  };
}

// The stage (zoom + pan) easing, selected from the cursor config. The single
// source the revideo scene (scene.tsx) consumes — any other renderer must use
// it identically so renderers can never drift. Precedence:
// spring (zoomSpring) → cubic-bezier (zoomEase) → smootherstep.
export function stageEasing(cursor: TakeComposition["cursor"]): (u: number) => number {
  if (cursor.zoomSpring != null) return springEase(cursor.zoomSpring);
  if (cursor.zoomEase) return cubicBezier(...cursor.zoomEase);
  return smoother;
}

// Easing for the CENTRE pan. Deliberately NEVER the spring: an overshooting
// spring on a pan makes the camera wobble past its target and back (and re-
// accelerates the zoom-out recenter = a stutter). Overshoot is only wanted on
// the scale zoom-IN, so centre stays on the monotone bezier/smoother. For a
// non-spring composition this equals stageEasing, so the default is unchanged.
export function panEasing(cursor: TakeComposition["cursor"]): (u: number) => number {
  if (cursor.zoomEase) return cubicBezier(...cursor.zoomEase);
  return smoother;
}

// Backdrop gradient endpoints in TOP-LEFT origin (0..oW, 0..oH), shared by the
// preview canvas and the revideo scene so the backdrop can't drift. `angle` is
// CSS-like degrees (0 = upward); absent ⇒ the legacy (0,0)→(oW,oH) diagonal, so
// existing compositions render pixel-identically. (Scene maps to centred coords
// by subtracting oW/2, oH/2.)
export function gradientEndpoints(
  angleDeg: number | undefined,
  oW: number,
  oH: number,
): { x0: number; y0: number; x1: number; y1: number } {
  if (angleDeg == null) return { x0: 0, y0: 0, x1: oW, y1: oH };
  const th = (angleDeg * Math.PI) / 180;
  const dx = Math.sin(th);
  const dy = -Math.cos(th);
  const L = Math.abs(oW * dx) + Math.abs(oH * dy); // CSS gradient line length
  const cx = oW / 2;
  const cy = oH / 2;
  return {
    x0: cx - (dx * L) / 2,
    y0: cy - (dy * L) / 2,
    x1: cx + (dx * L) / 2,
    y1: cy + (dy * L) / 2,
  };
}

type KF<T> = [number, T];

// `easeDown` (optional) eases segments where the value FALLS (v1<v0) differently
// from rising ones — used so the scale springs on zoom-IN but settles smoothly
// (bezier, no overshoot/abruptness) on zoom-OUT. Omit it ⇒ one easing for all
// (the default behaviour, unchanged).
export function keyvalN(
  t: number,
  kfs: KF<number>[],
  ease: (u: number) => number = smoother,
  easeDown?: (u: number) => number,
): number {
  if (t <= kfs[0]![0]) return kfs[0]![1];
  if (t >= kfs[kfs.length - 1]![0]) return kfs[kfs.length - 1]![1];
  for (let i = 0; i < kfs.length - 1; i++) {
    const [t0, v0] = kfs[i]!;
    const [t1, v1] = kfs[i + 1]!;
    if (t0 <= t && t <= t1) {
      const e = easeDown && v1 < v0 ? easeDown : ease;
      return v0 + (v1 - v0) * e((t - t0) / (t1 - t0));
    }
  }
  return kfs[kfs.length - 1]![1];
}

export function keyvalP(t: number, kfs: KF<Pt>[], ease: (u: number) => number = smoother): Pt {
  if (t <= kfs[0]![0]) return kfs[0]![1];
  if (t >= kfs[kfs.length - 1]![0]) return kfs[kfs.length - 1]![1];
  for (let i = 0; i < kfs.length - 1; i++) {
    const [t0, v0] = kfs[i]!;
    const [t1, v1] = kfs[i + 1]!;
    if (t0 <= t && t <= t1) {
      const p = ease((t - t0) / (t1 - t0));
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
 * Clamp a desired video-px center so the scaled video still covers the output
 * frame (the viewport crop stays inside the source video) when zoomed in. When
 * the content does not cover an axis (zoomed out / inset), centre that axis.
 *
 * In the composition-camera model the whole composition
 * (backdrop + inset screen) is zoomed by one camera; this keeps the camera crop
 * within the screen so a zoom fills the frame (no backdrop margin) without ever
 * panning past the recording's edge.
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
  type Anchor = {
    tMs: number;
    durationMs: number;
    inAtMs: number;
    scale: number;
    center: Pt;
    glide?: Pt;
  };
  const anchors: Anchor[] = [];
  for (const e of comp.events) {
    const base = { tMs: e.tMs, durationMs: e.durationMs ?? 0, inAtMs: e.zoom.inAtMs };
    if (e.kind === "scroll" || (e.kind === "press" && !e.zoom.enabled)) {
      anchors.push({ ...base, scale: rest, center: restC });
    } else if (e.zoom.enabled) {
      anchors.push({ ...base, scale: e.zoom.scale, center: e.zoom.center, glide: e.zoom.glide });
    }
  }

  // Scale and centre are evaluated independently (keyvalN / keyvalP), so their
  // keyframe TIMES need not line up — `pushC` adds a centre-only keyframe.
  const zf: { t: number; s: number }[] = [{ t: 0, s: rest }];
  const cf: { t: number; c: Pt }[] = [{ t: 0, c: restC }];
  const push = (t: number, s: number, c: Pt) => {
    zf.push({ t: Math.max(t, zf[zf.length - 1]!.t + 1e-3), s });
    cf.push({ t: Math.max(t, cf[cf.length - 1]!.t + 1e-3), c });
  };
  const pushC = (t: number, c: Pt) => {
    cf.push({ t: Math.max(t, cf[cf.length - 1]!.t + 1e-3), c });
  };
  // Invert the zoom-OUT easing to time the centre recenter (the centre reaches
  // rest exactly when the scale re-covers the frame — else the tightening centre-
  // clamp catches the still-panning centre and re-accelerates it = the "two-stage"
  // zoom-out stutter, commit b005cbe). The zoom-OUT scale uses panEasing (the
  // monotone bezier — scale springs only on zoom-IN, settles smoothly on the way
  // out), so invert THAT, by bisection.
  const ze = panEasing(comp.cursor);
  const invEase = (target: number) => {
    let lo = 0;
    let hi = 1;
    for (let i = 0; i < 30; i++) {
      const m = (lo + hi) / 2;
      if (ze(m) < target) lo = m;
      else hi = m;
    }
    return (lo + hi) / 2;
  };
  // Scale at which the video re-covers the frame on both axes; below it the
  // centre is forced to video-centre (clampCenter), so a recenter must FINISH by
  // here or the tightening clamp "catches" the still-panning centre.
  const fillThreshold = Math.max(oW / vW, oH / vH);

  let cur = { s: rest, c: restC };
  anchors.forEach((e, i) => {
    const rampStart = e.inAtMs / 1000;
    const clickT = e.tMs / 1000;
    // the action plays out (typing/drawing/scrolling) for durationMs after tMs
    // — hold the target framing through it (a point click has duration 0).
    const actionEnd = (e.tMs + e.durationMs) / 1000;
    const next = anchors[i + 1];
    const holdEndT = next ? next.inAtMs / 1000 : actionEnd + HOLD;
    // glide: drift the held centre across the hold window (velocity px/s ·
    // holdSeconds), so a held zoom slowly pans instead of sitting dead-static.
    // (Eased with the stage easing like any centre segment; clampCenter keeps it
    // in-bounds at read time. invEase below stays on the monotone bezier.)
    let holdC = e.center;
    if (e.glide && (e.glide.x !== 0 || e.glide.y !== 0)) {
      const holdDur = Math.max(0, holdEndT - clickT);
      holdC = { x: e.center.x + e.glide.x * holdDur, y: e.center.y + e.glide.y * holdDur };
    }
    push(rampStart, cur.s, cur.c); // hold current until ramp begins
    // Zoom-OUT across the fill-threshold INTO a beat (e.g. a rest/full-view beat):
    // land the centre on its target AT the crossing so the tightening centre-clamp
    // doesn't catch the still-panning centre and re-accelerate it. This is the same
    // two-stage stutter b005cbe killed for the FINAL zoom-out — here for the
    // between-beats ones (which went through this ramp and never got the fix).
    if (
      cur.s > fillThreshold &&
      e.scale < fillThreshold &&
      fillThreshold > rest &&
      clickT > rampStart &&
      Math.hypot(e.center.x - cur.c.x, e.center.y - cur.c.y) > 1
    ) {
      const uCross = invEase((fillThreshold - cur.s) / (e.scale - cur.s));
      pushC(rampStart + uCross * (clickT - rampStart), e.center);
    }
    push(clickT, e.scale, e.center); // ramp to target by the action
    cur = { s: e.scale, c: holdC };
    if (next) {
      // hold (or glide) the target until the next anchor begins ramping
      push(holdEndT, cur.s, cur.c);
    } else {
      const holdEnd = holdEndT;
      push(holdEnd, cur.s, cur.c);
      // Final zoom-out. Land the CENTRE on rest at the fill-threshold crossing
      // (the scale keeps its single smooth segment) so the centre clamp — which
      // tightens to a point as the video re-covers the frame — never catches the
      // still-panning centre and re-accelerates it (a two-stage stutter). Only
      // when the zoom actually overfills AND sits off-centre.
      const offset = Math.hypot(cur.c.x - restC.x, cur.c.y - restC.y) > 1;
      if (offset && cur.s > fillThreshold && fillThreshold > rest) {
        const uCross = invEase((fillThreshold - cur.s) / (rest - cur.s));
        pushC(holdEnd + uCross * ZOUT, restC);
      }
      push(holdEnd + ZOUT, rest, restC); // zoom back out
      cur = { s: rest, c: restC };
    }
  });

  const lastT = Math.max(zf[zf.length - 1]!.t, cf[cf.length - 1]!.t);
  const T = Math.max(comp.durationMs / 1000, lastT) + 0.3;
  push(T, rest, restC);

  return { z: zf.map((f) => [f.t, f.s]), c: cf.map((f) => [f.t, f.c]), T };
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
  const speedPxPerMs = ((travelWidthsPerSec || 0) * comp.source.videoWidth) / 1000;
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
