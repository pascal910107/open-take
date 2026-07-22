// planComposition: capture event log -> default editable TakeComposition.
// The selective bbox-fit zoom heuristic lives here; every decision it
// makes is written into the composition so a human/agent can tune it.

import { bboxFitScale, restStageScale } from "./math";
import {
  type BBox,
  type CaptureLog,
  type CompEvent,
  type CursorConfig,
  DEFAULT_CURSOR,
  DEFAULT_FRAMING,
  DEFAULT_MOTION_BLUR,
  type FramingConfig,
  type Pt,
  type TakeComposition,
} from "./types";

export type PlanOpts = {
  output?: { width?: number; height?: number; fps?: number };
  framing?: Partial<FramingConfig>;
  cursor?: Partial<CursorConfig>;
  /** element should fill this fraction of the frame when zoomed (default 0.55) */
  fillFrac?: number;
  /** hard cap on zoom (default 1.5 — a gentle workhorse; lower than
   *  the old 2.0 reads more premium. Small targets still zoom, just not as hard;
   *  raise per-beat in the composition when a tiny element needs it.) */
  maxScale?: number;
  /** require fit-scale to exceed rest*this to bother zooming (default 1.3) */
  zoomRatio?: number;
  /** never zoom the first (orienting) action by default (Finding 1) */
  zoomFirst?: boolean;
};

export function planComposition(log: CaptureLog, opts: PlanOpts = {}): TakeComposition {
  const vW = log.video.width,
    vH = log.video.height;
  const oW = opts.output?.width ?? vW;
  const oH = opts.output?.height ?? vH;
  const fps = opts.output?.fps ?? 30;
  const fillFrac = opts.fillFrac ?? 0.55;
  const maxScale = opts.maxScale ?? 1.5;
  const zoomRatio = opts.zoomRatio ?? 1.3;
  const zoomFirst = opts.zoomFirst ?? false;

  const framing: FramingConfig = { ...DEFAULT_FRAMING, ...opts.framing };
  const cursor: CursorConfig = { ...DEFAULT_CURSOR, ...opts.cursor };

  // viewport CSS px -> video px
  const sx = vW / log.viewport.w;
  const sy = vH / log.viewport.h;
  const mapPt = (p: Pt): Pt => ({ x: p.x * sx, y: p.y * sy });
  const mapBox = (b: BBox): BBox => ({ x: b.x * sx, y: b.y * sy, w: b.w * sx, h: b.h * sy });

  const rest = restStageScale(vW, vH, oW, oH, framing.insetFrac);

  // Axis-aligned bbox of a polyline (video-px). Used so a drag zooms to fit
  // the WHOLE stroke (a path, not a point): big cross-canvas drags fit ≈ rest
  // → no zoom (correct, global); small localised drags zoom in.
  const pathBBox = (pts: Pt[]): BBox => {
    const xs = pts.map((p) => p.x),
      ys = pts.map((p) => p.y);
    const x = Math.min(...xs),
      y = Math.min(...ys);
    return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
  };

  const events: CompEvent[] = log.events.map((c, i) => {
    const kind = c.kind ?? "click";
    const point = mapPt({ x: c.x, y: c.y });
    const isFirst = i === 0;
    const intent = c.zoom ?? "auto";
    const durationMs = "durationMs" in c ? c.durationMs : 0;

    // drag: cursor path + the bbox we fit-zoom is the path's bbox
    const to = kind === "drag" ? mapPt((c as { to: Pt }).to) : undefined;
    const rawPath =
      kind === "drag"
        ? ((c as { path?: Pt[] }).path ?? [{ x: c.x, y: c.y }, (c as { to: Pt }).to])
        : undefined;
    const path = rawPath?.map(mapPt);
    const ease = kind === "drag" ? (c as { ease?: "linear" | "smooth" }).ease : undefined;

    // The region this action is "about" — what zoom should frame.
    const bbox = kind === "drag" && path ? pathBBox(path) : c.box ? mapBox(c.box) : undefined;

    let enabled = false;
    let scale = rest;
    let reason: string;
    const center = bbox ? { x: bbox.x + bbox.w / 2, y: bbox.y + bbox.h / 2 } : point;
    const fit = bbox ? bboxFitScale(bbox, oW, oH, fillFrac, maxScale, rest) : maxScale;

    if (kind === "scroll") {
      // A scroll is a pan beat: the content moves, the frame stays full-view.
      // Zooming would fight the motion, so a scroll never zooms.
      enabled = false;
      reason = "scroll — full view (content pans, no zoom)";
    } else if (intent === "never") {
      enabled = false;
      reason = "plan: zoom=never (global/navigation payoff — keep full view)";
    } else if (intent === "always") {
      enabled = true;
      scale = fit;
      reason = `plan: zoom=always → ${fit.toFixed(2)}x (capped ${maxScale}x)`;
    } else if (!bbox) {
      reason = "no bbox in event log — cannot bbox-fit, so no zoom (avoids framing dead space)";
    } else {
      scale = fit;
      const meaningful = fit > rest * zoomRatio;
      const region = kind === "drag" ? "drag path" : "element";
      if (isFirst && !zoomFirst) {
        enabled = false;
        reason = `first/orienting action — skipped by default (fit ${fit.toFixed(2)}x available)`;
      } else if (!meaningful) {
        enabled = false;
        reason = `${region} fills the frame already (fit ${fit.toFixed(2)}x ≈ rest ${rest.toFixed(2)}x) — gentle/no zoom`;
      } else {
        enabled = true;
        reason = `bbox-fit ${fit.toFixed(2)}x (capped ${maxScale}x), ${region} framed with ${Math.round(fillFrac * 100)}% fill`;
      }
    }

    return {
      kind,
      tMs: c.tMs,
      point,
      bbox,
      label: c.sel ?? c.note,
      // zoom-in ramp starts zoomInMs before the action (decoupled from cursor
      // travelMs so the zoom can be slower/gentler — a more cinematic feel).
      zoom: { enabled, scale, center, inAtMs: Math.max(0, c.tMs - cursor.zoomInMs), reason },
      ...(durationMs ? { durationMs } : {}),
      ...(kind === "type" ? { text: (c as { text: string }).text } : {}),
      ...(kind === "press" ? { keys: (c as { keys: string }).keys } : {}),
      ...(to ? { to } : {}),
      ...(path ? { path } : {}),
      ...(ease ? { ease } : {}),
    };
  });

  const start = log.start ? mapPt(log.start) : { x: vW * 0.25, y: vH * 0.9 };
  const last = log.events.length ? log.events[log.events.length - 1]! : undefined;
  // the last action ends durationMs after its tMs (typing/drag plays out)
  const lastEnd = last ? last.tMs + ("durationMs" in last ? last.durationMs : 0) : 0;
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
