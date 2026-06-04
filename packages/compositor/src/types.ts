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
  /** how the stroke was paced and BAKED into the ink: "smooth" (accel-in /
   *  decel-out — a natural hand-draw) or "linear" (constant speed). The
   *  compositor cursor must replay the SAME easing to stay locked to the ink.
   *  Absent ⇒ linear (legacy captures). */
  ease?: "linear" | "smooth";
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
  /** Optional "glide": a slow camera drift WHILE the zoom is held, as a velocity
   *  in video-px per second {x,y}. The held centre pans from `center` by
   *  `glide · holdSeconds` across the hold window (then the next beat ramps from
   *  there / it zooms out from there). Adds life vs a dead-static hold (Screen
   *  Studio's glide). Absent/0 ⇒ a still hold. Clamped to the video at read time,
   *  so a drift just stops at the edge. Keep it gentle (tens of px/s). */
  glide?: Pt;
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
  /** drag stroke easing baked into the ink (kind=drag): "smooth" or "linear".
   *  The cursor replays it so it stays locked to the ink. Absent ⇒ linear. */
  ease?: "linear" | "smooth";
};

export type FramingConfig = {
  /** video occupies this fraction of the frame at rest (inset for the backdrop) */
  insetFrac: number;
  cornerRadius: number;
  shadow: { color: string; blur: number; offset: Pt };
  /** backdrop behind the framed video. `type` defaults to "gradient" (from→to);
   *  "solid" fills `from` only. `angle` (deg, CSS-like: 0 = upward) rotates the
   *  gradient; absent ⇒ the legacy top-left→bottom-right diagonal (pixel-identical). */
  background: { from: string; to: string; type?: "gradient" | "solid"; angle?: number };
};

export type CursorConfig = {
  /** Fallback travel duration (ms) when `travelWidthsPerSec` is unset/0. A FIXED
   *  duration makes cursor speed scale with distance (short=slow, long=fast),
   *  which reads inconsistent; prefer the distance-aware speed below. */
  travelMs: number;
  /** Distance-aware travel speed, as a fraction of the source video WIDTH per
   *  second (resolution-independent). A travel leg's duration is
   *  `clamp(distance / (widthsPerSec·videoWidth), travelMinMs, travelMaxMs)`, so
   *  the cursor holds a roughly CONSTANT on-screen speed regardless of distance —
   *  the premium-recorder feel (measured ~0.30 widths/s on the reference). Set 0
   *  to fall back to the fixed `travelMs`. */
  travelWidthsPerSec: number;
  /** Floor for a distance-aware travel (ms) so short hops aren't an instant snap. */
  travelMinMs: number;
  /** Ceiling for a distance-aware travel (ms) so a full-width jump stays a glide,
   *  not a multi-second crawl. */
  travelMaxMs: number;
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
  /** Easing for the zoom/pan stage ramps (scale + center together), as
   *  cubic-bezier control points. Absent ⇒ symmetric smootherstep — whose broad
   *  near-constant-velocity middle reads a bit linear, esp. on the zoom-OUT
   *  settle. A decel-biased curve gives a softer landing into rest. */
  zoomEase?: [number, number, number, number];
  /** Spring easing for the zoom/pan stage ramps, as a `bounce` amount ∈ [0,~0.6):
   *  0 = critically damped (a soft physical ease-out), higher = more overshoot/
   *  snap (the "silky" settle a premium screen-recorder has; ~0.06 for zoom). When
   *  set, this WINS over `zoomEase` (see math.ts stageEasing). Absent ⇒ use
   *  `zoomEase`/smootherstep. The segment duration stays zoomInMs/zoomOutMs;
   *  bounce only shapes the curve. NB: large bounce can undershoot rest on the
   *  zoom-OUT (momentary backdrop dead-space) — keep it small for zoom. */
  zoomSpring?: number;
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

/** Camera motion blur (temporal supersampling — what a real shutter does). The
 *  renderer samples the composition camera at `samples` sub-times within each
 *  output frame and averages them, so a fast zoom/pan/cursor smears in the
 *  motion direction (a camera/shutter motion blur). It smears the
 *  backdrop-reveal on a zoom-OUT into a soft gradient instead of a hard
 *  single-frame pop. The captured video's frames repeat across sub-samples, so
 *  the recording's own content is NOT blurred — only the camera move + cursor. */
export type MotionBlurConfig = {
  /** sub-frames sampled per output frame. 1 ⇒ OFF (no supersampling, no cost). */
  samples: number;
  /** fraction of the frame interval the shutter is open (0..1). Blur strength;
   *  0 ⇒ OFF. ~0.5 = a 180° shutter, 1 = 360°. */
  shutter: number;
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
  /** camera motion blur; absent ⇒ off (renders exactly as before). */
  motionBlur?: MotionBlurConfig;
  /** cursor start, video-px */
  start: Pt;
  events: CompEvent[];
  durationMs: number;
};

/** True when motion blur is configured to actually do something (so the OFF
 *  path stays byte-identical to the pre-motion-blur renderer). */
export function motionBlurActive(mb: MotionBlurConfig | undefined): mb is MotionBlurConfig {
  return !!mb && mb.samples > 1 && mb.shutter > 0;
}

export const DEFAULT_FRAMING: FramingConfig = {
  insetFrac: 0.92,
  cornerRadius: 28,
  shadow: { color: "rgba(0,0,0,0.55)", blur: 60, offset: { x: 0, y: 28 } },
  background: { from: "#1e1b3a", to: "#0a0e1c" },
};

// Camera motion blur, ON by default — it smooths the zoom
// motion and softens the zoom-OUT backdrop reveal (the model-C hitch). 6
// sub-frames is a good smoothness/speed balance; ~0.7 shutter is a strong-ish
// blur without ghosting. EXPORT render cost scales with `samples` (renders at
// fps·samples then averages), so `samples` is the quality⇄speed knob — drop it
// to render faster, raise (≤~12) for silkier fast pans.
export const DEFAULT_MOTION_BLUR: MotionBlurConfig = {
  samples: 6,
  shutter: 0.7,
};

export const DEFAULT_CURSOR: CursorConfig = {
  travelMs: 560,
  // Distance-aware cursor speed — the dominant "silky" lever. A fixed duration
  // makes velocity scale with distance (short=slow, long=fast); holding a roughly
  // constant on-screen speed reads consistent/premium. ~0.35 widths/s with the
  // big-move cap (travelMaxMs 850) was tuned by eye to a notch slower than a
  // premium reference recording (svgl.mp4) on this app's long toolbar→canvas
  // moves. Tune up for snappier, down for slower/grander.
  // NOTE on the cap (subtle): travel ENDS at the action's instant, so a LONGER
  // duration starts EARLIER, not later. With the front-loaded ease (below) a
  // longer move therefore reaches the target SOONER — i.e. raising travelMaxMs
  // can read as *faster*. Judge speed by how fast the cursor SWEEPS, not by when
  // it arrives; lower the cap for a more deliberate sweep.
  travelWidthsPerSec: 0.35,
  travelMinMs: 300,
  travelMaxMs: 850,
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
  // Zoom/pan stage easing. Same decel-biased curve as the cursor — symmetric
  // smootherstep (the fallback) has a broad near-constant-velocity middle that
  // reads a touch linear, especially as the zoom-OUT settles back to rest; this
  // gives a soft landing into rest. Applied to scale + center together.
  zoomEase: [0.3, 0.0, 0.2, 1.0],
  // The captured ink trails the pen by the screencast/encode pipeline latency τ;
  // delay the cursor by τ so its tip rides the ink front. Set to τ EXACTLY and
  // the cursor locks to the ink at ALL stroke speeds (both are the same time-
  // delay of the same path), which is what makes a SMOOTH (eased) drag work —
  // its fast mid-section amplifies any τ mismatch into a visible lead. Measured
  // τ≈190ms on this pipeline (swept dragLagMs, picked where the tip sits on the
  // ink front mid-stroke); the old 110ms left even linear strokes ~40px ahead.
  // Re-tune if a different machine's encode latency differs.
  dragLagMs: 190,
  // Soft launch + soft landing (gentle accel from rest, peak ~t0.24, decelerate
  // into the target). Chosen over a symmetric ease-in-out (which felt less silky)
  // and over a pure ease-out [.33,1,.68,1] (instant-max launch + a 46%-of-duration
  // creep tail that makes the speed knob lie — see travelMaxMs). This keeps the
  // soft landing (the silk) while trimming the tail to 38% and removing the abrupt
  // launch. Tune toward [0.42,0,0.58,1] for a more uniform sweep.
  travelEase: [0.3, 0.0, 0.2, 1.0],
};
