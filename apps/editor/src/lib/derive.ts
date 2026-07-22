// Pure, memoizable derivations shared by the engine (drawing) and the UI
// (timeline). All geometry/timing comes from the compositor's math — this just
// packages it for repeated reads at arbitrary t.
import {
  buildLegs,
  buildStageKeyframes,
  clampCenter,
  keyvalN,
  keyvalP,
  panEasing,
  restStageScale,
  stageEasing,
} from "./compositor";
import type { CompEvent, Pt, TakeComposition } from "./compositor";

export type Derived = {
  comp: TakeComposition;
  /** full timeline length in seconds (incl. the post-action zoom-out tail) */
  T: number;
  /** rest stage scale (video framed inside the backdrop) */
  rest: number;
  /** stage scale at time t (seconds) */
  scaleAt: (t: number) => number;
  /** clamped stage center (video-px) at time t (seconds) */
  centerAt: (t: number) => Pt;
  /** peak scale reached anywhere on the timeline (for curve normalisation) */
  peakScale: number;
};

export function derive(comp: TakeComposition): Derived {
  const vW = comp.source.videoWidth;
  const vH = comp.source.videoHeight;
  const oW = comp.output.width;
  const oH = comp.output.height;
  const stage = buildStageKeyframes(comp);
  const rest = restStageScale(vW, vH, oW, oH, comp.framing.insetFrac);
  const scaleEase = stageEasing(comp.cursor); // zoom-IN: spring → bezier → smoother
  const panEase = panEasing(comp.cursor); // zoom-OUT scale + centre: smooth bezier (no overshoot)

  // spring on the way IN, bezier on the way OUT (smooth settle, never abrupt).
  // Math.max(rest, …) is a belt-and-suspenders floor (bezier-out can't dip anyway).
  const scaleAt = (t: number) => Math.max(rest, keyvalN(t, stage.z, scaleEase, panEase));
  const centerAt = (t: number) =>
    clampCenter(keyvalP(t, stage.c, panEase), scaleAt(t), vW, vH, oW, oH);
  const peakScale = stage.z.reduce((m, [, s]) => Math.max(m, s), rest);

  return { comp, T: stage.T, rest, scaleAt, centerAt, peakScale };
}

/** Sample scale(t) across the whole timeline → points for the area curve. */
export function sampleScaleCurve(d: Derived, samples = 480): { t: number; scale: number }[] {
  const out: { t: number; scale: number }[] = [];
  for (let i = 0; i <= samples; i++) {
    const t = (i / samples) * d.T;
    out.push({ t, scale: d.scaleAt(t) });
  }
  return out;
}

/** True when this beat actually zooms in (vs a full-view scroll/escape beat). */
export function beatZooms(e: CompEvent, rest: number): boolean {
  return e.zoom.enabled && e.zoom.scale > rest + 1e-3;
}

/** Index of the beat currently being framed at time t (seconds): the last
 *  beat whose zoom-in has begun and whose action+hold window hasn't closed.
 *  -1 once the stage has eased back to rest between beats. */
export function activeBeatIndex(comp: TakeComposition, t: number): number {
  const tMs = t * 1000;
  const hold = comp.cursor.holdMs;
  let idx = -1;
  for (let i = 0; i < comp.events.length; i++) {
    const e = comp.events[i]!;
    const end = e.tMs + (e.durationMs ?? 0) + hold;
    if (tMs >= e.zoom.inAtMs && tMs <= end) idx = i;
  }
  return idx;
}

const KIND_GLYPH: Record<CompEvent["kind"], string> = {
  click: "click",
  type: "type",
  drag: "drag",
  scroll: "scroll",
  hover: "hover",
  press: "key",
};

export function beatKindLabel(e: CompEvent): string {
  return KIND_GLYPH[e.kind] ?? e.kind;
}

/** A short human title for a beat (label, else typed text / keys / kind). */
export function beatTitle(e: CompEvent): string {
  if (e.label) return e.label;
  if (e.kind === "type" && e.text) return `type "${e.text}"`;
  if (e.kind === "press" && e.keys) return `press ${e.keys}`;
  return e.kind;
}
