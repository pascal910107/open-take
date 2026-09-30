// A style is every number spotting needs, in one editable object. The
// defaults were measured off a reference motion-design piece (an After Effects
// "followed you → thank you" animation with hand-laid sound): the bed of taps
// sat ~14 dB under the payoff hit, the payoff was a STACK (transient + body +
// sub + tonal tail), whooshes rode the moves and a riser filled the build.
// Those are the physics; which sounds a kind gets is the taste, and that is
// what the presets differ on. Tuned by Pascal's ear on the v3 launch film
// (2026-09-29): recorded keystrokes sat ~21 dB under the music ("打字太小聲")
// and a whoosh on every move was too loud and too many ("咻咻咻") — keys up
// 8 dB, whooshes down 5 dB and at most one per 3 s, which puts a keystroke
// and a whoosh at about the same loudness, as in the reference film.

import type { FoleyRole } from "./cues";

export type Style = {
  name: string;
  /** peak level per role, dBFS, at intensity 0.5 */
  levelDb: Record<FoleyRole, number>;
  /** dB swing across intensity 0..1 (level ± swing/2) */
  intensitySwingDb: number;
  /** what an `enter` plays */
  enter: "tick" | "tap" | "pop" | "none";
  /** keystrokes are audible */
  keys: boolean;
  /** clicks are audible */
  clicks: boolean;
  /** a `build` window gets a riser */
  riser: boolean;
  /** camera zooms/pans get whooshes */
  camera: boolean;
  /** a `move` whooshes only when it crosses at least this much of the frame */
  moveWhooshExtent: number;
  /** what a `transition` plays */
  transition: FoleyRole[];
  /** what a `reveal` plays — the payoff stack */
  reveal: FoleyRole[];
  /** what a `drop` plays */
  drop: FoleyRole[];
  /** same-role cues closer than this collapse into the louder one (seconds) */
  minGapS: Partial<Record<FoleyRole, number>>;
  /** micro cues (tap/key/click/tick) per second before the quietest are dropped */
  maxMicroPerSecond: number;
  /** how far an event's pan reaches the speakers (0 = mono, 1 = full) */
  panWidth: number;
  /** seeded per-cue pitch variation, semitones */
  pitchJitter: Partial<Record<FoleyRole, number>>;
  /** seeded per-cue level variation, dB */
  gainJitterDb: number;
};

const LEVELS: Record<FoleyRole, number> = {
  tap: -26,
  key: -19,
  click: -24,
  pop: -17,
  whoosh: -25,
  air: -23,
  riser: -18,
  impact: -14,
  boom: -15,
  chime: -18,
  ui: -22,
  notify: -20,
  tick: -30,
};

const JITTER: Partial<Record<FoleyRole, number>> = {
  tap: 2,
  key: 1.5,
  click: 1,
  pop: 3,
  whoosh: 1.5,
  air: 1.5,
  tick: 2,
  chime: 0.3,
};

const GAPS: Partial<Record<FoleyRole, number>> = {
  tap: 0.04,
  key: 0.03,
  click: 0.06,
  tick: 0.03,
  pop: 0.08,
  whoosh: 3,
  air: 0.25,
  ui: 0.15,
  riser: 0.5,
  impact: 0.4,
  boom: 0.6,
  chime: 0.3,
  notify: 0.5,
};

/** The reference language: everything the motion designer laid by hand. */
export const CINEMATIC: Style = {
  name: "cinematic",
  levelDb: LEVELS,
  intensitySwingDb: 10,
  enter: "tap",
  keys: true,
  clicks: true,
  riser: true,
  camera: true,
  moveWhooshExtent: 0.12,
  transition: ["air", "ui"],
  reveal: ["pop", "impact", "boom", "chime"],
  drop: ["pop"],
  minGapS: GAPS,
  maxMicroPerSecond: 14,
  panWidth: 0.5,
  pitchJitter: JITTER,
  gainJitterDb: 1,
};

/** Interface sounds only — taps, keys, clicks, a breath on transitions, a
 *  small chime for the payoff. No sub, no riser: for a product demo that
 *  should not sound like a trailer. */
export const MINIMAL: Style = {
  ...CINEMATIC,
  name: "minimal",
  levelDb: { ...LEVELS, pop: -20, chime: -22, air: -26, ui: -25 },
  enter: "tick",
  riser: false,
  camera: false,
  moveWhooshExtent: 0.3,
  transition: ["air"],
  reveal: ["pop", "chime"],
  maxMicroPerSecond: 10,
  panWidth: 0.35,
};

/** Pops and bubbles: every arrival is a small pop, the payoff is bright. */
export const PLAYFUL: Style = {
  ...CINEMATIC,
  name: "playful",
  levelDb: { ...LEVELS, pop: -18, impact: -14, boom: -18 },
  enter: "pop",
  moveWhooshExtent: 0.08,
  transition: ["whoosh", "pop"],
  reveal: ["pop", "impact", "chime", "ui"],
  drop: ["pop", "tick"],
  pitchJitter: { ...JITTER, pop: 4 },
};

export const STYLES: Record<string, Style> = {
  cinematic: CINEMATIC,
  minimal: MINIMAL,
  playful: PLAYFUL,
};

export function resolveStyle(style: string | Style | undefined): Style {
  if (!style) return CINEMATIC;
  if (typeof style !== "string") return style;
  const found = STYLES[style];
  if (!found)
    throw new Error(
      `unknown style ${JSON.stringify(style)} — one of ${Object.keys(STYLES).join(", ")}`,
    );
  return found;
}
