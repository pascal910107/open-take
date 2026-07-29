// Curated preset vocabulary — the presets move (named levels, not raw
// numbers) applied to the conversational refine loop. The composition schema
// stays raw numbers; presets are a dictionary the CLI/agent speak: the agent
// writes numbers into composition.json, and `beats`/`ab` reverse-map numbers
// back to names for display. A value matching no preset displays as "custom"
// and must never be silently rounded to a named level (bbox-derived precision
// is ground truth).

import { DEFAULT_MOTION_BLUR } from "./types";
import type { CursorConfig, FramingConfig, MotionBlurConfig } from "./types";

// --- zoom levels (absolute stage scale; rest ≈ 0.92 at same-size output) ----
// medium matches the planner's default cap (1.5), so agent-planned zooms land
// on a named level; close stays under the validator's 2.5 soft cap.
export const ZOOM_LEVELS = {
  light: 1.25,
  medium: 1.5,
  tight: 1.8,
  close: 2.2,
} as const;
export type ZoomLevelName = keyof typeof ZOOM_LEVELS;

/** Name a scale if it sits within tolerance of a preset; else null (custom). */
export function zoomLevelName(scale: number, tol = 0.07): ZoomLevelName | null {
  let best: ZoomLevelName | null = null;
  let bestD = tol;
  for (const [name, v] of Object.entries(ZOOM_LEVELS) as [ZoomLevelName, number][]) {
    const d = Math.abs(scale - v);
    if (d <= bestD) {
      best = name;
      bestD = d;
    }
  }
  return best;
}

// --- motion (pace) bundles ---------------------------------------------------
// One name moves the whole feel together: cursor speed + hold + zoom ramps.
// "natural" IS the shipped default (DEFAULT_CURSOR) — naming it makes the
// default state speakable.
export type MotionPreset = Pick<
  CursorConfig,
  | "travelWidthsPerSec"
  | "travelMinMs"
  | "travelMaxMs"
  | "holdMs"
  | "zoomInMs"
  | "zoomOutMs"
  | "pullOutDwellMs"
> & { zoomEase?: undefined };
// zoomIn/zoomOut anchored to the measured reference springs (730/1340 —
// see DEFAULT_CURSOR); calm/brisk scale both while keeping out ≈ 1.8× in.
// pullOutDwellMs (the minimum stay on a payoff before a squeezed pull-out may
// flee) scales with the same feel: a calm cut breathes longer, a brisk one
// tolerates a shorter beat. Each preset also CLEARS a legacy zoomEase (spread
// leaves the key undefined; JSON drops it) so applying a pace migrates an old
// composition onto the default measured-SS spring curve instead of silently
// keeping the old bezier.
//
// The TRAVEL CLAMPS ride along too, and they have to. They are applied AFTER
// travelWidthsPerSec, so a preset that moved only the speed left every clamped
// leg exactly where it was: below ~202px and above ~571px of a 1920 frame,
// "calm" and "brisk" rendered IDENTICALLY and nothing said so. Each clamp
// scales by the pace's own speed ratio against natural (300·0.35/0.28 = 375,
// 850·0.35/0.45 = 661…), so a leg on a clamp keeps the same relationship to
// the legs that aren't.
export const MOTION: Record<"calm" | "natural" | "brisk", MotionPreset> = {
  calm: {
    travelWidthsPerSec: 0.28,
    travelMinMs: 375,
    travelMaxMs: 1060,
    holdMs: 1500,
    zoomInMs: 900,
    zoomOutMs: 1650,
    pullOutDwellMs: 1000,
    zoomEase: undefined,
  },
  natural: {
    travelWidthsPerSec: 0.35,
    travelMinMs: 300,
    travelMaxMs: 850,
    holdMs: 1100,
    zoomInMs: 730,
    zoomOutMs: 1340,
    pullOutDwellMs: 800,
    zoomEase: undefined,
  },
  brisk: {
    travelWidthsPerSec: 0.45,
    travelMinMs: 235,
    travelMaxMs: 660,
    holdMs: 750,
    zoomInMs: 550,
    zoomOutMs: 1000,
    pullOutDwellMs: 600,
    zoomEase: undefined,
  },
};
export type MotionName = keyof typeof MOTION;

/** A clamp matches its preset — or the LEGACY value every composition carried
 *  before the clamps joined the presets. Without that second door, applying
 *  "brisk" to an old take and re-reading it would report "custom" purely
 *  because the take predates clamp-aware presets. Same escape hatch
 *  pullOutDwellMs already has. */
export const CLAMP_TOL_MS = 20;
const clampMatches = (v: number | undefined, want: number, legacy: number): boolean =>
  v == null || Math.abs(v - want) < CLAMP_TOL_MS || Math.abs(v - legacy) < 1;

export function motionName(cursor: CursorConfig): MotionName | null {
  for (const [name, m] of Object.entries(MOTION) as [MotionName, MotionPreset][]) {
    if (
      Math.abs(cursor.travelWidthsPerSec - m.travelWidthsPerSec) < 0.015 &&
      Math.abs(cursor.holdMs - m.holdMs) < 60 &&
      Math.abs(cursor.zoomInMs - m.zoomInMs) < 60 &&
      Math.abs(cursor.zoomOutMs - m.zoomOutMs) < 60 &&
      clampMatches(cursor.travelMinMs, m.travelMinMs, MOTION.natural.travelMinMs) &&
      clampMatches(cursor.travelMaxMs, m.travelMaxMs, MOTION.natural.travelMaxMs) &&
      // absent = a pre-dwell composition — still nameable by its four legacy
      // knobs; only an explicit different value makes the pace "custom".
      (cursor.pullOutDwellMs == null ||
        Math.abs(cursor.pullOutDwellMs - (m.pullOutDwellMs ?? 0)) < 60)
    )
      return name;
  }
  return null;
}

// --- looks (backdrop bundles) ------------------------------------------------
// A look is the WHOLE backdrop treatment as one coherent bundle — background
// gradient + corner radius + shadow — so "paper" doesn't produce a light
// backdrop with dark-tuned corners/shadow.
export type LookPreset = Pick<FramingConfig, "background" | "cornerRadius" | "shadow">;
const DARK_SHADOW: LookPreset["shadow"] = {
  color: "rgba(0,0,0,0.55)",
  blur: 60,
  offset: { x: 0, y: 28 },
};
export const LOOKS: Record<string, LookPreset> = {
  midnight: {
    background: { from: "#1e1b3a", to: "#0a0e1c" },
    cornerRadius: 28,
    shadow: DARK_SHADOW,
  },
  ink: {
    background: { from: "#16181d", to: "#07080a" },
    cornerRadius: 28,
    shadow: DARK_SHADOW,
  },
  slate: {
    background: { from: "#232733", to: "#0e1116" },
    cornerRadius: 28,
    shadow: DARK_SHADOW,
  },
  ocean: {
    background: { from: "#0c2b36", to: "#071019" },
    cornerRadius: 28,
    shadow: DARK_SHADOW,
  },
  plum: {
    background: { from: "#2a1e3a", to: "#140a1c" },
    cornerRadius: 28,
    shadow: DARK_SHADOW,
  },
  ember: {
    background: { from: "#38231d", to: "#1a0d09" },
    cornerRadius: 28,
    shadow: DARK_SHADOW,
  },
  paper: {
    background: { from: "#f6f4ef", to: "#ddd8cd" },
    cornerRadius: 22,
    shadow: { color: "rgba(31,27,20,0.30)", blur: 45, offset: { x: 0, y: 20 } },
  },
  plain: {
    background: { from: "#101014", to: "#101014", type: "solid" },
    cornerRadius: 28,
    shadow: DARK_SHADOW,
  },
};
export type LookName = keyof typeof LOOKS;

export function lookName(framing: FramingConfig): string | null {
  const bg = framing.background;
  for (const [name, l] of Object.entries(LOOKS)) {
    if (
      l.background.from.toLowerCase() === bg.from.toLowerCase() &&
      l.background.to.toLowerCase() === bg.to.toLowerCase() &&
      (l.background.type ?? "gradient") === (bg.type ?? "gradient")
    )
      return name;
  }
  return null;
}

// --- finish (motion blur) ----------------------------------------------------
export const FINISH: Record<"smooth" | "crisp" | "heavy", MotionBlurConfig | undefined> = {
  smooth: DEFAULT_MOTION_BLUR, // {samples: 6, shutter: 0.7}
  crisp: undefined, // blur off — exports ~6× faster
  heavy: { samples: 8, shutter: 0.85 },
};
export type FinishName = keyof typeof FINISH;

export function finishName(mb: MotionBlurConfig | undefined): FinishName | null {
  const active = !!mb && mb.samples > 1 && mb.shutter > 0;
  if (!active) return "crisp";
  for (const [name, f] of Object.entries(FINISH) as [FinishName, MotionBlurConfig | undefined][]) {
    if (f && mb && f.samples === mb.samples && Math.abs(f.shutter - mb.shutter) < 0.03) return name;
  }
  return null;
}
