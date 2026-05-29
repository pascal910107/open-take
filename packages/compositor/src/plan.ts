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
  type FramingConfig,
  type Pt,
  type TakeComposition,
} from "./types";

export type PlanOpts = {
  output?: { width?: number; height?: number; fps?: number };
  framing?: Partial<FramingConfig>;
  cursor?: Partial<CursorConfig>;
  /** element should fill this fraction of the frame when zoomed (default 0.6) */
  fillFrac?: number;
  /** hard cap on zoom (default 2.0) */
  maxScale?: number;
  /** require fit-scale to exceed rest*this to bother zooming (default 1.3) */
  zoomRatio?: number;
  /** never zoom the first (orienting) action by default (Finding 1) */
  zoomFirst?: boolean;
};

export function planComposition(log: CaptureLog, opts: PlanOpts = {}): TakeComposition {
  const vW = log.video.width, vH = log.video.height;
  const oW = opts.output?.width ?? vW;
  const oH = opts.output?.height ?? vH;
  const fps = opts.output?.fps ?? 30;
  const fillFrac = opts.fillFrac ?? 0.6;
  const maxScale = opts.maxScale ?? 2.0;
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

  const events: CompEvent[] = log.clicks.map((c, i) => {
    const point = mapPt({ x: c.x, y: c.y });
    const bbox = c.box ? mapBox(c.box) : undefined;
    const isFirst = i === 0;

    let enabled = false;
    let scale = rest;
    let reason: string;
    const center = bbox ? { x: bbox.x + bbox.w / 2, y: bbox.y + bbox.h / 2 } : point;
    const fit = bbox ? bboxFitScale(bbox, oW, oH, fillFrac, maxScale, rest) : maxScale;
    const intent = c.zoom ?? "auto";

    if (intent === "never") {
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
      if (isFirst && !zoomFirst) {
        enabled = false;
        reason = `first/orienting action — skipped by default (fit ${fit.toFixed(2)}x available)`;
      } else if (!meaningful) {
        enabled = false;
        reason = `element fills the frame already (fit ${fit.toFixed(2)}x ≈ rest ${rest.toFixed(2)}x) — gentle/no zoom`;
      } else {
        enabled = true;
        reason = `bbox-fit ${fit.toFixed(2)}x (capped ${maxScale}x), element framed with ${Math.round(fillFrac * 100)}% fill`;
      }
    }

    return {
      kind: "click",
      tMs: c.tMs,
      point,
      bbox,
      label: c.sel ?? c.note,
      zoom: { enabled, scale, center, inAtMs: Math.max(0, c.tMs - cursor.travelMs), reason },
    };
  });

  const start = log.start ? mapPt(log.start) : { x: vW * 0.25, y: vH * 0.9 };
  const lastT = log.clicks.length ? log.clicks[log.clicks.length - 1]!.tMs : 0;
  const durationMs = Math.max(log.tEndMs ?? 0, lastT + cursor.holdMs + cursor.zoomOutMs + 400);

  return {
    output: { width: oW, height: oH, fps },
    source: { videoUrl: "/capture.mp4", videoWidth: vW, videoHeight: vH, viewport: log.viewport },
    framing,
    cursor,
    start,
    events,
    durationMs,
  };
}
