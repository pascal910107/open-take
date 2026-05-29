// The editable take composition — the source of truth. The agent (or a
// human) edits THIS, and the revideo scene renders it deterministically.
// All spatial fields are in VIDEO-pixel space (capture coords mapped
// through viewport→video scaling), so the scene works in one coordinate
// system.

export type Pt = { x: number; y: number };
export type BBox = { x: number; y: number; w: number; h: number };

// --- capture input (the ground-truth event log) -----------------------

/** Editorial zoom intent for an action (set by the planner/agent). */
export type ZoomIntent = "auto" | "never" | "always";

/** Fields common to every captured action. `x,y` is the anchor / start
 *  point (cursor target), viewport CSS px. */
export type CaptureEventBase = {
  /** anchor point (click target / field / drag start), viewport CSS px */
  x: number;
  y: number;
  /** element bounding box, viewport CSS px — the ground-truth edge */
  box?: BBox;
  /** ms from recording start (when the cursor arrives / action begins) */
  tMs: number;
  /** selector / note, kept for editability */
  sel?: string;
  note?: string;
  /** selective-zoom intent from the plan (default auto = heuristic) */
  zoom?: ZoomIntent;
};

/** A click (or a type's focus-click): an instantaneous action at a point. */
export type CaptureClick = CaptureEventBase & { kind?: "click" };

/** Typing into a focused field: the cursor parks and the zoom holds for
 *  `durationMs` while the text appears in the recording. */
export type CaptureType = CaptureEventBase & {
  kind: "type";
  /** what was typed (editability) */
  text: string;
  /** ms the typing occupies on screen (ground-truth wall time) */
  durationMs: number;
};

/** A drag: a path from the anchor (`x,y`) to `to`, optionally via `path`,
 *  with the button held for `durationMs`. */
export type CaptureDrag = CaptureEventBase & {
  kind: "drag";
  /** drag end point, viewport CSS px */
  to: { x: number; y: number };
  /** full polyline incl. ends, viewport CSS px (freehand strokes) */
  path?: { x: number; y: number }[];
  /** ms the drag occupies on screen (ground-truth wall time) */
  durationMs: number;
};

export type CaptureEvent = CaptureClick | CaptureType | CaptureDrag;

export type CaptureLog = {
  video: { width: number; height: number; fps?: number | string; durationS?: number };
  viewport: { w: number; h: number };
  start?: { x: number; y: number };
  /** the ordered ground-truth actions (click / type / drag) */
  events: CaptureEvent[];
  tEndMs?: number;
};

// --- the composition (editable) ----------------------------------------

export type ZoomDecision = {
  /** selective: not every action zooms. Edit this to tune/remove. */
  enabled: boolean;
  /** absolute stage scale to reach (bbox-fit, capped) */
  scale: number;
  /** video-px point to frame (bbox center), pre-clamp */
  center: Pt;
  /** when the zoom-in begins (ms) */
  inAtMs: number;
  /** why this decision (for the human/agent reading the composition) */
  reason: string;
};

export type CompEvent = {
  kind: "click" | "type" | "drag";
  tMs: number;
  /** anchor point (click / focus / drag start) in video-px */
  point: Pt;
  /** element bbox in video-px (if known) */
  bbox?: BBox;
  label?: string;
  zoom: ZoomDecision;
  /** how long the action plays out after `tMs` (type/drag); 0 for a click.
   *  The cursor parks and the zoom holds for this long. */
  durationMs?: number;
  /** typed text (kind=type), for editability */
  text?: string;
  /** drag end point, video-px (kind=drag) */
  to?: Pt;
  /** drag polyline incl. ends, video-px (kind=drag) — the cursor path */
  path?: Pt[];
};

export type FramingConfig = {
  /** video occupies this fraction of the frame at rest (inset for the backdrop) */
  insetFrac: number;
  cornerRadius: number;
  shadow: { color: string; blur: number; offset: Pt };
  background: { from: string; to: string };
};

export type CursorConfig = {
  travelMs: number;
  scale: number;
  arcFrac: number;
  arcMax: number;
  rippleMs: number;
  /** seconds to hold a zoom after a click, and to zoom back out */
  holdMs: number;
  zoomOutMs: number;
};

export type TakeComposition = {
  output: { width: number; height: number; fps: number };
  source: {
    videoUrl: string;
    videoWidth: number;
    videoHeight: number;
    viewport: { w: number; h: number };
  };
  framing: FramingConfig;
  cursor: CursorConfig;
  /** cursor start, video-px */
  start: Pt;
  events: CompEvent[];
  durationMs: number;
};

export const DEFAULT_FRAMING: FramingConfig = {
  insetFrac: 0.92,
  cornerRadius: 28,
  shadow: { color: "rgba(0,0,0,0.55)", blur: 60, offset: { x: 0, y: 28 } },
  background: { from: "#1e1b3a", to: "#0a0e1c" },
};

export const DEFAULT_CURSOR: CursorConfig = {
  travelMs: 600,
  scale: 2.0,
  arcFrac: 0.14,
  arcMax: 90,
  rippleMs: 450,
  holdMs: 900,
  zoomOutMs: 600,
};
