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

/** A scroll: the content pans for `durationMs`. The cursor holds (no travel),
 *  full-view (no zoom). `dy` is the signed pixels scrolled (editability). */
export type CaptureScroll = CaptureEventBase & {
  kind: "scroll";
  /** signed pixels scrolled (positive = down) */
  dy: number;
  /** ms the scroll occupies on screen (ground-truth wall time) */
  durationMs: number;
};

/** A hover: the cursor travels to `x,y` and dwells for `durationMs` so a
 *  tooltip / menu / hover-state reveals. Like a click that doesn't click. */
export type CaptureHover = CaptureEventBase & {
  kind: "hover";
  /** ms the dwell occupies on screen (ground-truth wall time) */
  durationMs: number;
};

/** A key press / shortcut: keyboard-driven, so the cursor holds (no travel).
 *  Holds for `durationMs` while the effect plays out; if a reveal element was
 *  located, `box` carries its bbox so the zoom can frame it. */
export type CapturePress = CaptureEventBase & {
  kind: "press";
  /** the chord pressed, e.g. "Enter" / "Meta+k" (editability) */
  keys: string;
  /** ms the hold occupies on screen (ground-truth wall time) */
  durationMs: number;
};

export type CaptureEvent =
  | CaptureClick
  | CaptureType
  | CaptureDrag
  | CaptureScroll
  | CaptureHover
  | CapturePress;

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
  kind: "click" | "type" | "drag" | "scroll" | "hover" | "press";
  tMs: number;
  /** anchor point (click / focus / drag start / hover) in video-px. For a
   *  scroll/press the cursor does not move; this is its resting point. */
  point: Pt;
  /** element bbox in video-px (if known) */
  bbox?: BBox;
  label?: string;
  zoom: ZoomDecision;
  /** how long the action plays out after `tMs` (type/drag/scroll/hover/press);
   *  0 for a click. The cursor parks and the zoom holds for this long. */
  durationMs?: number;
  /** typed text (kind=type), for editability */
  text?: string;
  /** chord pressed (kind=press), for editability */
  keys?: string;
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
  /** ms to hold a zoom after the action settles, before zooming back out */
  holdMs: number;
  /** ms for the zoom-OUT ramp (back to rest) */
  zoomOutMs: number;
  /** ms for the zoom-IN ramp (into a target). Decoupled from travelMs so the
   *  zoom can be slower/gentler than the cursor (a cinematic ~1s zoom). */
  zoomInMs: number;
  /** ms to delay the synthetic cursor along a DRAG stroke, compensating for the
   *  capture pipeline latency: the captured ink appears ~this long after the pen
   *  actually moved, so without the delay the (exact-time) cursor leads the ink.
   *  Tune so the cursor tip sits on the ink front mid-stroke. */
  dragLagMs: number;
  /** easing for a travel move, as cubic-bezier control points [x1,y1,x2,y2].
   *  Default is a symmetric ease-in-out — measured from a reference recording, whose
   *  cursor accelerates and decelerates evenly (a slow start, fast middle, soft
   *  landing). Drag strokes ignore this (they ease the stroke in lockstep with
   *  the captured ink — see math.ts). */
  travelEase: [number, number, number, number];
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
  travelMs: 560,
  scale: 2.0,
  // Near-straight glide. The reference cursor barely bows (measured: a
  // full-width move deviated <2% off the straight line), so the arc is small —
  // just enough to avoid a robotic ruler-straight path, not a visible curve.
  arcFrac: 0.05,
  arcMax: 24,
  rippleMs: 450,
  holdMs: 1100,
  // Gentle, cinematic zoom (a ~1s ramp reads as premium); our
  // old 600ms tied-to-travel zoom felt snappy/mechanical by comparison.
  zoomOutMs: 800,
  zoomInMs: 760,
  // The captured ink trails the pen by the screencast/encode latency; delay the
  // cursor the same so its tip rides the ink front (measured ~110ms here).
  dragLagMs: 110,
  // Symmetric ease-in-out, fit to a reference recording (cubic-bezier
  // (.42,0,.58,1), RMS 0.028 vs the recording — best of every curve tried; the
  // old decelerate-biased [.45,.05,.3,1] was the worst, RMS 0.090). This even
  // accelerate/decelerate is the core of the "silky" feel. Tune toward
  // [0.33,0,0.12,1] for snappier, or [0.6,0,0.4,1] for an even slower settle.
  travelEase: [0.42, 0.0, 0.58, 1.0],
};
