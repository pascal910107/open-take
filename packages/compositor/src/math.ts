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
// (no overshoot — a soft, physical ease-out); higher = more overshoot/snap.
//
// bounce 0 over the default zoom durations IS the measured reference zoom
// feel: frame-tracking a reference export gave a critically-damped spring on the
// camera rect, ω≈9.4 rad/s in / ω≈5.2 out (which also matches the spring
// preset numbers from the reference teardown) —
// i.e. this exact curve over ~730ms in / ~1340ms out.
//
// Under time-normalisation the curve depends ONLY on the damping ratio ζ=1−bounce
// (the natural frequency cancels), so a single `bounce` knob is the whole shape —
// the segment DURATION stays whatever the keyframes say (zoomInMs/zoomOutMs).
// The response is normalised by its end value so the segment lands on exactly 1
// (no end-of-segment snap from the finite settle band).
export function springEase(bounce: number): (p: number) => number {
  const zeta = Math.max(0.4, Math.min(1, 1 - bounce));
  const Ts = -Math.log(1e-3) / zeta; // settling time to the 0.1% band (ω0 = 1)
  const step = (t: number): number => {
    if (zeta >= 1) return 1 - Math.exp(-t) * (1 + t); // critically damped
    const wd = Math.sqrt(1 - zeta * zeta); // damped natural frequency (ω0 = 1)
    return 1 - Math.exp(-zeta * t) * (Math.cos(wd * t) + (zeta / wd) * Math.sin(wd * t));
  };
  const end = step(Ts);
  return (p: number) => {
    if (p <= 0) return 0;
    if (p >= 1) return 1;
    return step(p * Ts) / end;
  };
}

// The stage (camera rect) easing, selected from the cursor config. ONE curve
// eases the whole rect — centre and size together (see stageCamera). The single
// source the revideo scene (scene.tsx) AND the editor preview consume — any
// other renderer must use it identically so renderers can never drift.
// Precedence: spring (zoomSpring) → cubic-bezier (zoomEase) → the default
// critically-damped spring (the measured reference curve).
export function stageEasing(cursor: TakeComposition["cursor"]): (u: number) => number {
  if (cursor.zoomSpring != null) return springEase(cursor.zoomSpring);
  if (cursor.zoomEase) return cubicBezier(...cursor.zoomEase);
  return springEase(0);
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

export function keyvalN(
  t: number,
  kfs: KF<number>[],
  ease: (u: number) => number = smoother,
): number {
  if (t <= kfs[0]![0]) return kfs[0]![1];
  if (t >= kfs[kfs.length - 1]![0]) return kfs[kfs.length - 1]![1];
  for (let i = 0; i < kfs.length - 1; i++) {
    const [t0, v0] = kfs[i]!;
    const [t1, v1] = kfs[i + 1]!;
    if (t0 <= t && t <= t1) {
      return v0 + (v1 - v0) * ease((t - t0) / (t1 - t0));
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

// --- stage (camera rect) keyframes from the composition ----------------

/** The camera as a viewport RECT in video-px: centre + full viewport width
 *  (height is implied by the output aspect: h = w·oH/oW). scale = oW / w. */
export type CamRect = { cx: number; cy: number; w: number };

export type StageKeyframes = {
  r: KF<CamRect>[]; // viewport rect over time (seconds)
  T: number; // total duration (s)
};

/** Interpolate the rect track: centre AND size move under the SAME eased
 *  parameter. This is the whole trick (verified
 *  by frame-tracking a reference export: its pan curve overlays its viewport-WIDTH
 *  curve exactly, not its scale curve): lerping the rect keeps every corner on
 *  a straight line, so the screen-space path of the zoom target is strictly
 *  monotone toward frame centre — no wrong-way "bounce" for ANY scale pair,
 *  which scale+centre lerp can't guarantee (it hooks when scale > 2×rest). */
export function keyvalR(t: number, kfs: KF<CamRect>[], ease: (u: number) => number): CamRect {
  if (t <= kfs[0]![0]) return kfs[0]![1];
  if (t >= kfs[kfs.length - 1]![0]) return kfs[kfs.length - 1]![1];
  for (let i = 0; i < kfs.length - 1; i++) {
    const [t0, v0] = kfs[i]!;
    const [t1, v1] = kfs[i + 1]!;
    if (t0 <= t && t <= t1) {
      const p = ease((t - t0) / (t1 - t0));
      // A spring ease (zoomSpring > 0) overshoots p past 1, extrapolating the
      // rect beyond its target — that's the wanted "snap", but on a deep punch
      // with a large bounce the extrapolated width could collapse through 0
      // (scale sign-flip = garbage frames). Floor the width against the
      // segment's own endpoints so overshoot can tighten at most 2× past the
      // tighter one; monotone eases (p ∈ [0,1]) never hit the floor.
      return {
        cx: v0.cx + (v1.cx - v0.cx) * p,
        cy: v0.cy + (v1.cy - v0.cy) * p,
        w: Math.max(v0.w + (v1.w - v0.w) * p, Math.min(v0.w, v1.w) * 0.5),
      };
    }
  }
  return kfs[kfs.length - 1]![1];
}

// The camera schedule shared by buildStageKeyframes (the render path) and
// cameraRampSchedule (the refine surfaces — A/B windows, review badges): which
// events anchor a camera move, when each ramp departs, and when it lands.
// One computation so the badge/window timing can never drift from the render.
type CameraSchedule = {
  anchors: {
    evIdx: number;
    tMs: number;
    durationMs: number;
    inAtMs: number;
    scale: number;
    center: Pt;
    glide?: Pt;
  }[];
  targets: CamRect[];
  restR: CamRect;
  /** per-anchor ramp window, SECONDS */
  ramps: { start: number; end: number }[];
  /** per-anchor landing time, SECONDS (≥ ramp start + a minimal real ramp;
   *  == tMs for every on-time ramp, later for a dwell-delayed pull-out) */
  landTs: number[];
  rectFor: (center: Pt, scale: number) => CamRect;
};

function buildCameraSchedule(comp: TakeComposition): CameraSchedule {
  const { videoWidth: vW, videoHeight: vH } = comp.source;
  const { width: oW, height: oH } = comp.output;
  const rest = restStageScale(vW, vH, oW, oH, comp.framing.insetFrac);
  const restC: Pt = { x: vW / 2, y: vH / 2 };
  const ZOUT_MS = comp.cursor.zoomOutMs;

  // A framing target is clamped ONCE, here at build time (the viewport crop
  // stays inside the recording; an axis it doesn't cover centres). Every
  // keyframe rect is therefore valid — and for a monotone ease (p ∈ [0,1];
  // every default) lerped rect corners stay between the endpoints' corners, so
  // every IN-BETWEEN rect is valid too. No per-frame clamp, so the clamp can
  // never bend a path mid-flight (the old model's per-frame clamp force-
  // centred the pan while the video under-covered the frame, then released it
  // mid-zoom — a visible lurch; and its zoom-out "land the centre early"
  // repair made pull-outs pan-then-zoom two-phase). A zoomSpring bounce > 0
  // deliberately overshoots PAST the target rect (edge-flush targets can
  // flash a sliver of backdrop during the settle — the physical cost of
  // bounce; keyvalR floors only the width collapse).
  const rectFor = (center: Pt, scale: number): CamRect => {
    const c = clampCenter(center, scale, vW, vH, oW, oH);
    return { cx: c.x, cy: c.y, w: oW / scale };
  };
  const restR = rectFor(restC, rest);

  // Framing anchors over time. A zoom-enabled beat ramps to its target; a
  // scroll (content pans) and a zoom-less press (Escape/Enter whose effect is
  // global) ramp back to REST so the frame is full-view through them — without
  // these, a prior zoom would persist across the scroll/keypress. Other
  // disabled beats (a "never" click) keep holding the prior framing, unchanged.
  const anchors: CameraSchedule["anchors"] = [];
  comp.events.forEach((e, evIdx) => {
    const base = { evIdx, tMs: e.tMs, durationMs: e.durationMs ?? 0, inAtMs: e.zoom.inAtMs };
    if (e.kind === "scroll" || (e.kind === "press" && !e.zoom.enabled)) {
      anchors.push({ ...base, scale: rest, center: restC });
    } else if (e.zoom.enabled) {
      anchors.push({ ...base, scale: e.zoom.scale, center: e.zoom.center, glide: e.zoom.glide });
    }
  });

  const targets = anchors.map((e) => rectFor(e.center, e.scale));

  // Effective ramp start per anchor. A PULL-OUT (wider viewport than the rect
  // it leaves) paces with zoomOutMs — measured on the reference export,
  // the pull-out is ~1.8× slower than the punch-in. The stored inAtMs keeps
  // governing punch-ins/same-size travels, and a HAND-SET inAtMs (≠ the
  // planner default tMs − zoomInMs) wins even for a pull-out, so the per-beat
  // timing knob stays live. When the zoomOutMs window would start before the
  // previous action's end, shorten it toward the punch-in window rather than
  // cut the payoff — but NEVER squeeze below min(zoomOutMs, zoomInMs) of real
  // ramp: a pull-out with no window is a jump cut, which is strictly worse
  // than leaving a payoff a little early.
  const ZIN_MS = comp.cursor.zoomInMs;
  const DWELL_MS = comp.cursor.pullOutDwellMs ?? 0;
  const ramps = anchors.map((e, i) => {
    const from = i > 0 ? targets[i - 1]! : restR;
    const pullOut = targets[i]!.w > from.w + 1e-6;
    const isDefaultInAt = Math.abs(e.inAtMs - Math.max(0, e.tMs - ZIN_MS)) < 1;
    if (!pullOut || !isDefaultInAt) return { start: e.inAtMs / 1000, end: e.tMs / 1000 };
    const desired = e.tMs - ZOUT_MS;
    const prevEndMs = i > 0 ? anchors[i - 1]!.tMs + anchors[i - 1]!.durationMs : 0;
    const floor = prevEndMs + DWELL_MS;
    if (desired >= floor) return { start: Math.max(desired, 0) / 1000, end: e.tMs / 1000 };
    if (DWELL_MS > 0) {
      // The dwell floor pushes the departure past the on-time window: keep the
      // full pull-out ramp and LAND LATE (after the action instant) rather than
      // flee a frame the viewer is still reading. The landing is capped at the
      // next anchor's ramp start at push time.
      return { start: floor / 1000, end: (floor + ZOUT_MS) / 1000 };
    }
    const start = Math.min(prevEndMs, e.tMs - Math.min(ZOUT_MS, ZIN_MS));
    return { start: Math.max(start, 0) / 1000, end: e.tMs / 1000 };
  });
  // Second pass: a dwell-floored ramp must still FIT a real ramp before the
  // next anchor departs — otherwise the landT cap would invert it into a
  // 1ms jump cut (push()'s monotone clamp collapses it). Give up dwell time
  // before ramp time: shrink the dwell so at least min(zoomOutMs, zoomInMs)
  // of real ramp survives, and when even zero dwell has no room fall back to
  // the exact legacy squeeze. (Anchor starts never depend on earlier ramps'
  // ends, so one forward pass over pass-1 values is complete.)
  if (DWELL_MS > 0) {
    const minRamp = Math.min(ZOUT_MS, ZIN_MS);
    for (let i = 0; i < ramps.length - 1; i++) {
      const r = ramps[i]!;
      const e = anchors[i]!;
      if (r.end <= e.tMs / 1000 + 1e-9) continue; // on-time ramp — not dwell-late
      const latestStart = ramps[i + 1]!.start - 0.01 - minRamp / 1000;
      if (r.start <= latestStart) continue; // the late landing fits
      const prevEndMs = i > 0 ? anchors[i - 1]!.tMs + anchors[i - 1]!.durationMs : 0;
      if (latestStart * 1000 >= prevEndMs) {
        r.start = latestStart;
        r.end = Math.min(r.start + ZOUT_MS / 1000, ramps[i + 1]!.start - 0.01);
      } else {
        const start = Math.min(prevEndMs, e.tMs - minRamp);
        r.start = Math.max(start, 0) / 1000;
        r.end = e.tMs / 1000;
      }
    }
  }

  // A dwell-delayed pull-out lands after its own action instant; cap the
  // landing so it can never run into the next anchor's ramp (floored at a
  // minimal real ramp — the fits-check in the dwell pass guarantees room).
  // An on-time ramp (end === tMs, every legacy entry) keeps the exact old
  // landing; a pass-2-shrunk ramp may deliberately land BEFORE its tMs.
  const landTs = anchors.map((e, i) => {
    const nextStart = anchors[i + 1] ? ramps[i + 1]!.start : Number.POSITIVE_INFINITY;
    const rampEnd = ramps[i]!.end;
    return rampEnd === e.tMs / 1000
      ? rampEnd
      : Math.max(
          ramps[i]!.start + Math.min(ZOUT_MS, ZIN_MS) / 1000,
          Math.min(rampEnd, nextStart - 0.01),
        );
  });

  return { anchors, targets, restR, ramps, landTs, rectFor };
}

/** Per-EVENT camera ramp timing (ms), for the refine surfaces (A/B windows,
 *  review badges): when the camera actually departs toward a beat and when it
 *  lands. `null` for a beat the camera holds through (no anchor). Derived from
 *  the same schedule the render uses, so a dwell-delayed pull-out (which
 *  departs after the stored inAtMs and can land after its own tMs) is
 *  reflected instead of approximated from inAtMs. */
export function cameraRampSchedule(
  comp: TakeComposition,
): ({ startMs: number; landMs: number } | null)[] {
  const { anchors, ramps, landTs } = buildCameraSchedule(comp);
  const out: ({ startMs: number; landMs: number } | null)[] = comp.events.map(() => null);
  anchors.forEach((a, i) => {
    out[a.evIdx] = { startMs: ramps[i]!.start * 1000, landMs: landTs[i]! * 1000 };
  });
  return out;
}

export function buildStageKeyframes(comp: TakeComposition): StageKeyframes {
  const { anchors, targets, restR, ramps, landTs, rectFor } = buildCameraSchedule(comp);
  const HOLD = comp.cursor.holdMs / 1000;
  const ZOUT_MS = comp.cursor.zoomOutMs;

  const rf: { t: number; r: CamRect }[] = [{ t: 0, r: restR }];
  const push = (t: number, r: CamRect) => {
    rf.push({ t: Math.max(t, rf[rf.length - 1]!.t + 1e-3), r });
  };

  let cur = restR;
  anchors.forEach((e, i) => {
    // the action plays out (typing/drawing/scrolling) for durationMs after tMs
    // — hold the target framing through it (a point click has duration 0).
    const actionEnd = (e.tMs + e.durationMs) / 1000;
    const next = anchors[i + 1];
    const nextStart = next ? ramps[i + 1]!.start : Number.POSITIVE_INFINITY;
    const landT = landTs[i]!;
    const holdEndT = Math.max(next ? nextStart : actionEnd + HOLD, landT);
    push(ramps[i]!.start, cur); // hold current until ramp begins
    push(landT, targets[i]!); // ONE eased rect segment lands at the action
    cur = targets[i]!;
    // glide: drift the held centre across the hold window (velocity px/s ·
    // holdSeconds), so a held zoom slowly pans instead of sitting dead-static.
    // Clamped like any target so the drift can't leave the recording.
    let holdR = cur;
    if (e.glide && (e.glide.x !== 0 || e.glide.y !== 0)) {
      const holdDur = Math.max(0, holdEndT - landT);
      holdR = rectFor(
        { x: e.center.x + e.glide.x * holdDur, y: e.center.y + e.glide.y * holdDur },
        e.scale,
      );
    }
    push(holdEndT, holdR); // hold (or glide) until the next ramp / the tail
    cur = holdR;
    if (!next) {
      push(holdEndT + ZOUT_MS / 1000, restR); // final zoom-out, one rect segment
      cur = restR;
    }
  });

  const lastT = rf[rf.length - 1]!.t;
  const T = Math.max(comp.durationMs / 1000, lastT) + 0.3;
  push(T, restR);

  return { r: rf.map((f) => [f.t, f.r]), T };
}

// --- asymptotic settle (zoomSettleFrac) --------------------------------

/** Residual (1 − progress) of an overdamped spring's unit step response, on
 *  NORMALISED segment time u = (t − t0)/(t1 − t0). ω0 is solved so the
 *  residual at u=1 (the action instant) equals `frac`; past u=1 the same
 *  curve keeps decaying — the tail that replaces the legacy cut. ζ=1.2 gives
 *  the reference-measured shape: a fast main ramp (peak velocity ~14% in)
 *  plus a slow settle pole; at frac 0.04 the tail τ ≈ duration/3.6 (730ms →
 *  ~205ms, 1340ms → ~375ms — the frame-tracked reference tails; a different
 *  frac shifts ω0 and with it τ). */
function settleDecay(frac: number): (u: number) => number {
  const zeta = 1.2;
  const s = Math.sqrt(zeta * zeta - 1);
  const l1 = zeta + s;
  const l2 = zeta - s;
  const resid = (x: number) => (l1 * Math.exp(-l2 * x) - l2 * Math.exp(-l1 * x)) / (l1 - l2);
  let lo = 0.1;
  let hi = 60;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    if (resid(mid) > frac) lo = mid;
    else hi = mid;
  }
  const w0T = (lo + hi) / 2;
  return (u: number) => (u <= 0 ? 1 : resid(w0T * u));
}

/** Evaluate the rect track with moves that settle ASYMPTOTICALLY: each ramp
 *  covers 1−frac of its distance by its keyframe end, then keeps creeping
 *  toward the target through the following hold (never a velocity cliff). A
 *  ramp launches from wherever the previous tail actually is (position-
 *  continuous chaining); every emitted rect is a convex combination of
 *  build-time-clamped rects, and the valid-rect set is convex (linear
 *  half-plane bounds in cx,cy,w), so in-between rects stay valid exactly as
 *  in the lerped path. */
function settleRectAt(kfs: KF<CamRect>[], decay: (u: number) => number, t: number): CamRect {
  let from = kfs[0]![1];
  for (let i = 0; i < kfs.length - 1; i++) {
    const [t0, r0] = kfs[i]!;
    const [t1, r1] = kfs[i + 1]!;
    if (r0.cx === r1.cx && r0.cy === r1.cy && r0.w === r1.w) continue; // hold — the active tail keeps running
    if (t < t0) break;
    // find when the NEXT move begins — this move's tail runs until then
    let handoff = Number.POSITIVE_INFINITY;
    for (let j = i + 1; j < kfs.length - 1; j++) {
      const [ta, ra] = kfs[j]!;
      const [, rb] = kfs[j + 1]!;
      if (ra.cx !== rb.cx || ra.cy !== rb.cy || ra.w !== rb.w) {
        handoff = ta;
        break;
      }
    }
    const evalT = Math.min(t, handoff);
    const d = decay((evalT - t0) / Math.max(t1 - t0, 1e-6));
    from = {
      cx: r1.cx + (from.cx - r1.cx) * d,
      cy: r1.cy + (from.cy - r1.cy) * d,
      w: r1.w + (from.w - r1.w) * d,
    };
    if (t < handoff) return from;
  }
  return from;
}

/** The one camera evaluator — scene.tsx (render) and the editor preview both
 *  consume THIS, so preview and export can never drift. */
export function stageCamera(comp: TakeComposition): {
  T: number;
  rest: number;
  peakScale: number;
  at: (t: number) => { scale: number; center: Pt };
} {
  const stage = buildStageKeyframes(comp);
  const ease = stageEasing(comp.cursor);
  const oW = comp.output.width;
  const rest = restStageScale(
    comp.source.videoWidth,
    comp.source.videoHeight,
    oW,
    comp.output.height,
    comp.framing.insetFrac,
  );
  // zoomSettleFrac swaps the segment-lerped track for the asymptotic-settle
  // evaluator; explicit zoomSpring/zoomEase keep their exact legacy curves.
  const frac = comp.cursor.zoomSettleFrac ?? 0;
  const useSettle = frac > 0 && comp.cursor.zoomSpring == null && !comp.cursor.zoomEase;
  const decay = useSettle ? settleDecay(frac) : undefined;
  const at = (t: number) => {
    const r = decay ? settleRectAt(stage.r, decay, t) : keyvalR(t, stage.r, ease);
    return { scale: oW / r.w, center: { x: r.cx, y: r.cy } };
  };
  // Peak by sampling (not just keyframe extremes): a spring ease overshoots
  // mid-segment, so the true peak can sit above every keyframe.
  let peakScale = stage.r.reduce((m, [, r]) => Math.max(m, oW / r.w), rest);
  for (let i = 0; i <= 720; i++) peakScale = Math.max(peakScale, at((i / 720) * stage.T).scale);
  return { T: stage.T, rest, peakScale, at };
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
