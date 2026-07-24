// camera.ts — the auto-camera DIRECTOR.
//
// Zoom is DECIDED here, deterministically, from the ground-truth event log — NOT
// by the authoring agent (which decides pre-capture, blind, and every model has
// its own bias), and NOT per-event in isolation. The director runs over the
// WHOLE beat sequence so it can do the three things a per-event heuristic can't:
//
//   1. shape the region-of-interest PER KIND — a `type`'s payoff grows DOWN out
//      of the thin field, so the ROI (and thus the scale) is result-sized, not
//      strip-sized;
//   2. COALESCE a burst of nearby small interactions into ONE sustained frame
//      (a thumbnail rail / toolbar), instead of punch-pull flicker per beat;
//   3. PULL OUT for a global repaint (nav / restyle) — read off the capture's
//      changed-area, not guessed from a bbox that looks identical to a popover's.
//
// Output stays in the editable representation: one framing decision per beat
// (enabled / scale / center + a human-readable reason). A "cluster" is just
// every beat in it sharing the SAME scale+center — buildStageKeyframes then
// holds the camera across them for free (no new schema, no new keyframe code).
//
// Pure & synchronous: it reads only fields already on the beats, including the
// capture-derived effectBox / changeCoverage seam. The frame-diff (or, later,
// mutation) pass that POPULATES those fields lives in the runtime (node) layer;
// the director itself never does I/O, so it stays snapshot-testable.

import { bboxFitScale } from "./math";
import type { BBox, CameraConfig, Pt, ZoomIntent } from "./types";

/** One action, already mapped into video-px, handed to the director. */
export type Beat = {
  kind: "click" | "type" | "drag" | "scroll" | "hover" | "press";
  tMs: number;
  durationMs: number;
  /** element bbox (for a drag: the path's bbox), video-px — or undefined for a
   *  bare press (no located element). */
  box?: BBox;
  /** the region that actually changed after the action (frame-diff seam),
   *  video-px. Framed over `box` when present. */
  effectBox?: BBox;
  /** fraction of the frame that changed after the action, 0..1. */
  changeCoverage?: number;
  /** anchor / cursor rest point, video-px (for the reason only). */
  point: Pt;
  /** plan override; absent ⇒ "auto" (the director decides). */
  intent: ZoomIntent;
  /** short label (sel / note) for the cluster tag in the reason. */
  label?: string;
  /** press only: the key chord (for the Escape-dismissal rule). */
  keys?: string;
};

/** The director's per-beat verdict. plan.ts adds `inAtMs` to make a full
 *  ZoomDecision. */
export type Framing = {
  enabled: boolean;
  scale: number;
  center: Pt;
  reason: string;
};

const centerOf = (b: BBox): Pt => ({ x: b.x + b.w / 2, y: b.y + b.h / 2 });
const dist = (a: Pt, b: Pt): number => Math.hypot(a.x - b.x, a.y - b.y);
const union = (a: BBox, b: BBox): BBox => {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y };
};

// A `type` field is a thin strip; its payoff (search results, an AI answer)
// grows DOWNWARD out of it. Framing the strip alone puts dead header above and
// crops the result below. Grow the ROI down (never up) so the frame sits over
// field + result: a taller ROI ⇒ lower scale AND a centre that drops below the
// field — both correct. This is the BLIND guess; when the frame-diff pass gives
// a real effectBox, that wins over this (roiForBeat prefers effectBox).
function growDown(box: BBox, video: { w: number; h: number }): BBox {
  const grownH = Math.max(box.h, Math.min(video.h * 0.42, box.w * 0.55));
  const h = Math.min(grownH, video.h - box.y); // never spill past the video edge
  return { x: box.x, y: box.y, w: box.w, h };
}

/** The region a beat is "about" — what the camera should frame. Prefers the
 *  captured effect region; else shapes one from the element bbox by kind. */
function roiForBeat(b: Beat, video: { w: number; h: number }): BBox | undefined {
  if (b.effectBox) return b.effectBox;
  if (!b.box) return undefined;
  if (b.kind === "type") return growDown(b.box, video);
  return b.box;
}

function clusterLabel(beats: Beat[], idx: number[]): string {
  const raw = beats[idx[0]!]?.label ?? "";
  const cleaned = raw.replace(/\s+/g, " ").trim().slice(0, 18);
  return cleaned || "region";
}

type Node = {
  roi?: BBox;
  scale: number; // fit of its OWN roi (rest if none)
  forceFull: boolean; // must show full view (scroll / never / global repaint / no-roi / orienting)
  forcePunch: boolean; // its own isolated punch (intent === "always")
  boundary: boolean; // starts a new segment regardless of similarity
  reason: string;
};

type Seg = {
  idx: number[];
  kind: "rest" | "punch";
  roi?: BBox;
  scale: number;
  center: Pt;
  dropped?: boolean; // a punch demoted to rest by min-hold
};

/**
 * Decide framing for every beat. `endMs` is when the last frame can hold until
 * (for the min-hold check on the final segment). `rest` is the stage scale at
 * full view.
 */
export function directCamera(
  beats: Beat[],
  video: { w: number; h: number },
  out: { w: number; h: number },
  cam: CameraConfig,
  rest: number,
  endMs: number,
): Framing[] {
  const restC: Pt = { x: video.w / 2, y: video.h / 2 };
  const fit = (roi: BBox) => bboxFitScale(roi, out.w, out.h, cam.fillFrac, cam.maxScale, rest);

  // --- phase 1: per-beat ROI + hard-break classification ---------------------
  const nodes: Node[] = beats.map((b, i) => {
    const roi = roiForBeat(b, video);
    const scale = roi ? fit(roi) : rest;
    const gapBreak =
      i > 0 && b.tMs - (beats[i - 1]!.tMs + beats[i - 1]!.durationMs) > cam.coalesceWindowMs;

    // explicit overrides win, and are segment boundaries (Q2 / point 3).
    if (b.intent === "never")
      return {
        roi,
        scale,
        forceFull: true,
        forcePunch: false,
        boundary: true,
        reason: "plan: zoom=never → full view",
      };
    if (b.intent === "always")
      return {
        roi,
        scale,
        forceFull: false,
        forcePunch: true,
        boundary: true,
        reason: roi
          ? `plan: zoom=always → ${scale.toFixed(2)}× (framing from ROI)`
          : "plan: zoom=always but no bbox to frame → full view",
      };

    // a scroll is a pan beat: content moves, the frame stays full-view.
    if (b.kind === "scroll")
      return {
        roi: undefined,
        scale: rest,
        forceFull: true,
        forcePunch: false,
        boundary: true,
        reason: "scroll — full view (content pans)",
      };

    // Escape DISMISSES: its visual change is something VANISHING, so the
    // frame-diff effectBox is the vacated region — framing it would punch into
    // blank space. The editorial payoff of a dismissal is the restored page.
    if (b.kind === "press" && b.keys && /(^|\+)esc(ape)?$/i.test(b.keys.trim()))
      return {
        roi: undefined,
        scale: rest,
        forceFull: true,
        forcePunch: false,
        boundary: true,
        reason: "Escape (dismissal) — full view",
      };

    // global repaint (nav / restyle): the payoff is the whole page → pull out.
    // Needs the frame-diff annotation; without it this branch is skipped (the
    // director can't tell nav from popover on a bbox alone — say so).
    if (b.changeCoverage != null && b.changeCoverage >= cam.pullOutCoverage)
      return {
        roi,
        scale,
        forceFull: true,
        forcePunch: false,
        boundary: true,
        reason: `changeCoverage ${b.changeCoverage.toFixed(2)} ≥ ${cam.pullOutCoverage} (global repaint) → full view`,
      };

    // the opening beat orients: open on the whole app (Q3 — falls out of "the
    // camera opens full", no zoomFirst flag). A cold-open uses zoom=always.
    if (i === 0)
      return {
        roi,
        scale,
        forceFull: true,
        forcePunch: false,
        boundary: true,
        reason: "opening beat — full view (orienting)",
      };

    // nothing locatable to frame (a bare Escape/Enter with no reveal).
    if (!roi)
      return {
        roi,
        scale,
        forceFull: true,
        forcePunch: false,
        boundary: true,
        reason: "no bbox to frame → full view",
      };

    // not tight enough to earn a distinct frame (a big element fills it already).
    if (scale < cam.minZoomScale)
      return {
        roi,
        scale,
        forceFull: true,
        forcePunch: false,
        boundary: gapBreak,
        reason: `ROI fills the frame already (fit ${scale.toFixed(2)}× < ${cam.minZoomScale}×) — full view`,
      };

    // an ordinary punchable beat — eligible to coalesce with its neighbours.
    return {
      roi,
      scale,
      forceFull: false,
      forcePunch: false,
      boundary: gapBreak,
      reason: `punch ${scale.toFixed(2)}× (ROI-fit)`,
    };
  });

  // --- phase 2: coalesce adjacent punchable beats into shared-frame clusters --
  const segs: Seg[] = [];
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i]!;
    if (n.forceFull) {
      segs.push({ idx: [i], kind: "rest", scale: rest, center: restC });
      continue;
    }
    const last = segs[segs.length - 1];
    const lastLastIdx = last ? last.idx[last.idx.length - 1]! : -1;
    const canExtend =
      !!last &&
      last.kind === "punch" &&
      !!last.roi &&
      !n.forcePunch &&
      !nodes[lastLastIdx]!.forcePunch &&
      !n.boundary &&
      !!n.roi &&
      dist(centerOf(n.roi), centerOf(last.roi)) < cam.travelThreshold * video.w &&
      fit(union(last.roi, n.roi)) >= cam.minZoomScale; // union must stay tight enough

    if (canExtend && last && last.roi && n.roi) {
      const roi = union(last.roi, n.roi);
      last.idx.push(i);
      last.roi = roi;
      last.scale = fit(roi);
      last.center = centerOf(roi);
    } else {
      segs.push({
        idx: [i],
        kind: "punch",
        roi: n.roi,
        scale: n.scale,
        center: n.roi ? centerOf(n.roi) : restC,
      });
    }
  }

  // --- phase 3: min-hold — extend into the gap before the next break; a punch
  // that still can't clear minHoldMs is a flinch → drop it to full view. NEVER
  // merges across a break (order: hard break → coalesce → min-hold).
  segs.forEach((s, si) => {
    if (s.kind !== "punch") return;
    const firstT = beats[s.idx[0]!]!.tMs;
    const next = segs[si + 1];
    const heldUntil = next ? beats[next.idx[0]!]!.tMs : endMs;
    if (heldUntil - firstT < cam.minHoldMs) {
      s.kind = "rest";
      s.scale = rest;
      s.center = restC;
      s.dropped = true;
    }
  });

  // --- assemble per-beat framing --------------------------------------------
  const framings: Framing[] = new Array(beats.length);
  for (const s of segs) {
    if (s.kind === "rest") {
      for (const i of s.idx)
        framings[i] = {
          enabled: false,
          scale: rest,
          center: restC,
          reason: s.dropped
            ? `punch dropped — held < ${cam.minHoldMs}ms (would flinch) → full view`
            : nodes[i]!.reason,
        };
      continue;
    }
    const N = s.idx.length;
    const tag = N > 1 ? `cluster[${clusterLabel(beats, s.idx)}]` : null;
    s.idx.forEach((i, k) => {
      framings[i] = {
        enabled: true,
        scale: s.scale,
        center: s.center,
        reason: tag
          ? `${tag} ${k + 1}/${N} · hold shared framing (union of ${N}) → ${s.scale.toFixed(2)}×`
          : nodes[i]!.reason,
      };
    });
  }
  return framings;
}
