// planComposition: capture event log -> default editable TakeComposition.
//
// Coordinate mapping (capture viewport px -> video px) and the per-beat
// scaffolding live here; the ZOOM decision is delegated to the camera DIRECTOR
// (camera.ts), which runs over the whole beat sequence with the real bbox /
// timing / changed-area from the ground-truth log. Every decision it makes is
// still written per-beat into the composition (enabled/scale/center + reason)
// so a human/agent can read and tune it.

import { type Beat, directCamera } from "./camera";
import { restStageScale } from "./math";
import {
  type BBox,
  type CameraConfig,
  type CaptureLog,
  type CompEvent,
  type CursorConfig,
  DEFAULT_CAMERA,
  DEFAULT_CURSOR,
  DEFAULT_FRAMING,
  DEFAULT_MOTION_BLUR,
  type FramingConfig,
  type Pt,
  type TakeComposition,
  type ZoomDecision,
} from "./types";

export type PlanOpts = {
  output?: { width?: number; height?: number; fps?: number };
  framing?: Partial<FramingConfig>;
  cursor?: Partial<CursorConfig>;
  /** auto-camera director tuning (default DEFAULT_CAMERA — ON). The director
   *  decides zoom from the ground-truth log; these are its feel knobs. Set
   *  `camera.enabled = false` for the manual escape hatch (only explicit
   *  event `zoom: "always"/"never"` produce zoom then). */
  camera?: Partial<CameraConfig>;
};

export function planComposition(log: CaptureLog, opts: PlanOpts = {}): TakeComposition {
  const vW = log.video.width,
    vH = log.video.height;
  const oW = opts.output?.width ?? vW;
  const oH = opts.output?.height ?? vH;
  const fps = opts.output?.fps ?? 30;

  const framing: FramingConfig = { ...DEFAULT_FRAMING, ...opts.framing };
  const cursor: CursorConfig = { ...DEFAULT_CURSOR, ...opts.cursor };
  const camera: CameraConfig = { ...DEFAULT_CAMERA, ...opts.camera };

  // viewport CSS px -> video px
  const sx = vW / log.viewport.w;
  const sy = vH / log.viewport.h;
  const mapPt = (p: Pt): Pt => ({ x: p.x * sx, y: p.y * sy });
  const mapBox = (b: BBox): BBox => ({ x: b.x * sx, y: b.y * sy, w: b.w * sx, h: b.h * sy });

  const rest = restStageScale(vW, vH, oW, oH, framing.insetFrac);

  // Axis-aligned bbox of a polyline (video-px), so a drag frames the WHOLE
  // stroke (a path, not a point): a big cross-canvas drag fits ≈ rest → no zoom.
  const pathBBox = (pts: Pt[]): BBox => {
    const xs = pts.map((p) => p.x),
      ys = pts.map((p) => p.y);
    const x = Math.min(...xs),
      y = Math.min(...ys);
    return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
  };

  // --- map every event into video-px scaffolding (kind-agnostic zoom yet) -----
  type Scaffold = {
    beat: Beat;
    ev: Omit<CompEvent, "zoom">;
  };

  const scaffolds: Scaffold[] = log.events.map((c) => {
    const kind = c.kind ?? "click";
    const point = mapPt({ x: c.x, y: c.y });
    const intent = c.zoom ?? "auto";
    const durationMs = "durationMs" in c ? c.durationMs : 0;

    // drag: cursor path + the region we frame is the path's bbox
    const to = kind === "drag" ? mapPt((c as { to: Pt }).to) : undefined;
    const rawPath =
      kind === "drag"
        ? ((c as { path?: Pt[] }).path ?? [{ x: c.x, y: c.y }, (c as { to: Pt }).to])
        : undefined;
    const path = rawPath?.map(mapPt);
    const ease = kind === "drag" ? (c as { ease?: "linear" | "smooth" }).ease : undefined;

    // the element bbox (ground truth): drag → path bbox, else the captured box
    const bbox = kind === "drag" && path ? pathBBox(path) : c.box ? mapBox(c.box) : undefined;
    const effectBox = c.effectBox ? mapBox(c.effectBox) : undefined;
    const label = c.sel ?? c.note;

    const beat: Beat = {
      kind,
      tMs: c.tMs,
      durationMs,
      box: bbox,
      effectBox,
      changeCoverage: c.changeCoverage,
      point,
      intent,
      label,
    };

    const ev: Omit<CompEvent, "zoom"> = {
      kind,
      tMs: c.tMs,
      point,
      bbox,
      label,
      ...(durationMs ? { durationMs } : {}),
      ...(kind === "type" ? { text: (c as { text: string }).text } : {}),
      ...(kind === "press" ? { keys: (c as { keys: string }).keys } : {}),
      ...(to ? { to } : {}),
      ...(path ? { path } : {}),
      ...(ease ? { ease } : {}),
    };
    return { beat, ev };
  });

  const beats = scaffolds.map((s) => s.beat);

  // horizon for the min-hold check on the final segment
  const last = log.events.length ? log.events[log.events.length - 1]! : undefined;
  const lastEnd = last ? last.tMs + ("durationMs" in last ? last.durationMs : 0) : 0;
  const endMs = Math.max(log.tEndMs ?? 0, lastEnd + cursor.holdMs);

  // --- decide framing --------------------------------------------------------
  // director ON (default): decide from the log. OFF: the manual escape hatch —
  // only explicit always/never produce zoom, auto/absent hold full view.
  const framings = camera.enabled
    ? directCamera(beats, { w: vW, h: vH }, { w: oW, h: oH }, camera, rest, endMs)
    : beats.map((b) => manualFraming(b, rest));

  const events: CompEvent[] = scaffolds.map((s, i) => {
    const f = framings[i]!;
    const zoom: ZoomDecision = {
      enabled: f.enabled,
      scale: f.scale,
      center: f.center,
      // zoom-in ramp starts zoomInMs before the action (decoupled from cursor
      // travelMs so the zoom can be slower/gentler — a more cinematic feel).
      inAtMs: Math.max(0, s.beat.tMs - cursor.zoomInMs),
      reason: f.reason,
    };
    return { ...s.ev, zoom };
  });

  const start = log.start ? mapPt(log.start) : { x: vW * 0.25, y: vH * 0.9 };
  const durationMs = Math.max(log.tEndMs ?? 0, lastEnd + cursor.holdMs + cursor.zoomOutMs + 400);

  return {
    output: { width: oW, height: oH, fps },
    source: { videoUrl: "/capture.mp4", videoWidth: vW, videoHeight: vH, viewport: log.viewport },
    framing,
    cursor,
    motionBlur: DEFAULT_MOTION_BLUR,
    start,
    events,
    durationMs,
  };
}

// Manual mode (camera.enabled === false): the director does not run. Only an
// explicit plan intent produces zoom — "always" frames the element bbox, every-
// thing else holds full view. Deliberately dumb: this is the fully-hand-driven
// escape hatch, not a second heuristic.
function manualFraming(b: Beat, rest: number): {
  enabled: boolean;
  scale: number;
  center: Pt;
  reason: string;
} {
  if (b.intent === "always" && b.box) {
    return {
      enabled: true,
      scale: rest, // manual mode leaves scale for the human to raise; frame the bbox
      center: { x: b.box.x + b.box.w / 2, y: b.box.y + b.box.h / 2 },
      reason: "camera off · plan: zoom=always (raise scale by hand)",
    };
  }
  return { enabled: false, scale: rest, center: b.point, reason: "camera off · full view (no explicit zoom)" };
}
