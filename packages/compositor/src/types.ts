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
  /** selective-zoom intent from the plan. Absent/"auto" ⇒ the camera director
   *  decides from the ground-truth log; "always"/"never" hard-override it (and
   *  cut the beat out of any cluster — an override is a segment boundary). */
  zoom?: ZoomIntent;
  /** CAPTURE-DERIVED (frame-diff / mutation pass — the `effectBox` seam): the
   *  region that actually CHANGED after the action, viewport CSS px. The
   *  director frames THIS over `box` when present — a `type`'s result region, or
   *  a payoff that lands somewhere other than where you clicked. Absent ⇒ the
   *  director shapes an ROI from `box`/kind instead. */
  effectBox?: BBox;
  /** CAPTURE-DERIVED (same pass): fraction of the frame that changed after the
   *  action, 0..1. ≥ camera.pullOutCoverage ⇒ the action repainted most of the
   *  frame (nav / global restyle) ⇒ pull out to full view. Absent ⇒ the pull-out
   *  branch is skipped (the director can't tell nav from popover on bbox alone —
   *  it says so in the beat's `reason`). */
  changeCoverage?: number;
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

/** A file drag-and-drop (OS-level, synthesized via CDP Input.dispatchDragEvent
 *  with real file paths): the cursor carries the file(s) from the anchor
 *  (`x,y`) along `path` to `to`, where the drop lands and the page receives
 *  actual Files. The compositor draws a "file ghost card" riding the cursor
 *  for this beat — the recording itself shows only the page's reaction. */
export type CaptureDropFiles = CaptureEventBase & {
  kind: "dropFiles";
  /** drop point, viewport CSS px */
  to: { x: number; y: number };
  /** full polyline incl. ends, viewport CSS px */
  path?: { x: number; y: number }[];
  /** ms the carry occupies on screen (ground-truth wall time) */
  durationMs: number;
  /** carry pacing baked into the dispatched dragOver march (see CaptureDrag) */
  ease?: "linear" | "smooth";
  /** dropped files' display metadata (basename + bytes) for the ghost card */
  files: { name: string; size?: number }[];
};

export type CaptureEvent =
  | CaptureClick
  | CaptureType
  | CaptureDrag
  | CaptureScroll
  | CaptureHover
  | CapturePress
  | CaptureDropFiles;

export type CaptureLog = {
  video: { width: number; height: number; fps?: number | string; durationS?: number };
  viewport: { w: number; h: number };
  start?: { x: number; y: number };
  /** the ordered ground-truth actions (click / type / drag) */
  events: CaptureEvent[];
  tEndMs?: number;
  /** Steps the capture DROPPED (target not found / endpoint unresolved) — the
   *  take still completes, but a missing beat must reach the end-of-run
   *  summary and (with --strict) the exit code, not just an early stderr line
   *  buried under render progress. `step` is the plan's 0-based step index. */
  skipped?: { step: number; action: string; target?: string; reason: string }[];
  /** Beats whose editorial hold ran out before the PAGE had finished — the
   *  capture kept waiting (see runtime/src/settle.ts) and records how much
   *  longer it needed. This is the measurement that replaces guessing
   *  `settleMs`: `heldMs + waitedMs` is what that beat actually wanted, and
   *  `reason: "budget"` means even the extra wait was not enough. Absent when
   *  every hold was already long enough. */
  settleWaits?: {
    step: number;
    action: string;
    heldMs: number;
    waitedMs: number;
    reason: "idle" | "budget" | "unavailable";
  }[];
  /** Largest share of the frame a `<canvas>`/`<video>` held during the capture.
   *  It matters because the settle probe reads the page's STRUCTURE, and a
   *  paint surface never changes structurally no matter what is drawn inside
   *  it — so on a canvas-driven app "the page settled" is not evidence the
   *  beat's payoff had appeared, and `settleMs` is doing the whole job alone.
   *  Absent on an ordinary DOM app. */
  paintedFrac?: number;
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

/** Ghost-card knobs for a dropFiles beat (editable): the macOS-style file
 *  card riding the cursor during the carry. */
export type GhostCardConfig = {
  enabled: boolean;
  /** card offset from the cursor tip, video-px (default ~{x:26,y:30}) */
  offset?: Pt;
  /** ms of the release pop after the drop (fade + settle; default 280) */
  releaseMs?: number;
};

export type CompEvent = {
  kind: "click" | "type" | "drag" | "scroll" | "hover" | "press" | "dropFiles";
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
  /** dropped files' display metadata (kind=dropFiles), for the ghost card */
  files?: { name: string; size?: number }[];
  /** ghost-card rendering knobs (kind=dropFiles); absent ⇒ enabled defaults */
  ghostCard?: GhostCardConfig;
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
  /** ms for a zoom-OUT / pull-out ramp (to rest OR to any wider framing).
   *  Measured on a reference export: the pull-out is ~1.8× slower than the
   *  punch-in (their zoom-out spring ω≈5.2 rad/s ⇒ ~1340ms of critically-damped
   *  settle) — a slow, soft release reads premium; a fast one reads like a
   *  flinch. */
  zoomOutMs: number;
  /** ms for the zoom-IN ramp (into a target). Decoupled from travelMs so the
   *  zoom can be slower/gentler than the cursor. Measured reference punch-in spring
   *  ω≈9.4 rad/s ⇒ ~730ms. */
  zoomInMs: number;
  /** Optional cubic-bezier easing for the camera-rect ramps (centre + size in
   *  lockstep — see math.ts stageCamera). Absent ⇒ the default critically-
   *  damped spring (the measured reference curve). Set this only to force a
   *  bezier feel; `zoomSpring` wins over it when both are set. */
  zoomEase?: [number, number, number, number];
  /** Spring easing for the camera-rect ramps, as a `bounce` amount ∈ [0,~0.6):
   *  0 = critically damped (the measured reference zoom curve — also the
   *  default when neither zoomSpring nor zoomEase is set), higher = more
   *  overshoot/snap. The segment duration stays zoomInMs/zoomOutMs; bounce only
   *  shapes the curve. Bounce > 0 overshoots the RECT (a touch past the target
   *  frame, then settle) — keep it small. */
  zoomSpring?: number;
  /** Fraction of a camera ramp still UNfinished at its keyframe end (the action
   *  instant), left to settle as an asymptotic overdamped tail that continues
   *  INTO the hold — so a move tapers out like a physical camera instead of
   *  stopping on a velocity cliff at the keyframe. Frame-tracked on the
   *  reference export: its moves keep sub-threshold motion ~0.5s past the
   *  visible end (tail τ ≈ 220ms in / ≈ 370ms out), while the cut spring's
   *  τ = duration/6.9 ends 2-3× harder. ~0.04 (the shipped default) reproduces
   *  the reference tails over the default zoomInMs/zoomOutMs. 0 = legacy
   *  cut+normalized spring (absent falls back to the default on NEW plans; an
   *  old composition without the field renders as it always did). Ignored when
   *  zoomSpring or zoomEase is set (those keep their exact legacy curves). */
  zoomSettleFrac?: number;
  /** Minimum stay (ms) after the previous action's visible end before a
   *  PULL-OUT ramp may begin. When the beat gap is too tight the pull-out now
   *  departs late and LANDS late (after its own action instant) instead of
   *  fleeing a frame the viewer is still reading — the reference recorder's
   *  reactive pattern (payoff plays while the camera is still arriving).
   *  ~800 (the shipped default) reads as a natural beat; pace presets scale it.
   *  0/absent = legacy (a squeezed pull-out departs the instant the previous
   *  action ends and lands exactly on its action). Named pullOut- because
   *  holdMs already covers the ordinary post-action dwell. */
  pullOutDwellMs?: number;
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

/** One caption window on a review copy: the pill reads `text` from `fromMs`
 *  (inclusive) to `toMs` (exclusive) on the composition timeline. */
export type ReviewBadge = { fromMs: number; toMs: number; text: string };

/** Render-time decoration for review copies and A/B variant reels: burned-in
 *  beat badges, a REVIEW watermark, and a per-variant corner label. Drawn by the
 *  scene in SCREEN space (fixed, outside the composition camera) so the text is
 *  legible at any zoom. This is a render input only — it is never written into
 *  the editable `*.composition.json` artifact (render strips it) and the
 *  validator ignores it. Text renders in the headless Chrome, so any script
 *  (incl. CJK) works without ffmpeg font filters. */
export type ReviewDecor = {
  /** top-right watermark, e.g. "REVIEW" — marks a copy as not-for-posting */
  watermark?: string;
  /** bottom-left caption pill, swapping per timeline window */
  badges?: ReviewBadge[];
  /** constant bottom-left variant label for A/B reels, e.g. "B · tight ×1.8" */
  label?: string;
};

/** The auto-camera director's tuning. ON by default (a plan that specifies no
 *  zoom must still come out with sensible framing — the whole point). The
 *  numbers are the FEEL knobs; judge them by eye on a rendered clip, not on
 *  paper. `enabled: false` is the clean escape hatch: the director doesn't run
 *  and ONLY explicit `zoom: "always"/"never"` produce zoom (auto/absent hold
 *  full view). There is no legacy per-event heuristic to fall back to. */
export type CameraConfig = {
  enabled: boolean;
  /** an ROI fills this fraction of the frame when framed (bigger ⇒ tighter). */
  fillFrac: number;
  /** hard ceiling on scale. NOT the main lever — ROI SIZE drives the actual
   *  scale (a big type-ROI lands medium, a tiny icon lands tight); this just
   *  stops a pinpoint ROI zooming past legibility. */
  maxScale: number;
  /** a punch that can't stay on screen this long is dropped to full view (a
   *  sub-second punch reads as a flinch). Enforced AFTER hard breaks — the hold
   *  extends into the gap before the next break, never merges across one. */
  minHoldMs: number;
  /** a scale below this isn't worth a distinct frame: a single beat that fits
   *  under it holds full view, and a coalesced cluster whose UNION falls under
   *  it splits instead (the two are "different regions" → chain/pull, not hold). */
  minZoomScale: number;
  /** gap between two actions greater than this ⇒ they cannot share a frame. */
  coalesceWindowMs: number;
  /** two ROIs whose centres are closer than this (fraction of video width) MAY
   *  coalesce into one shared, held frame — the "cluster" (a thumbnail rail, a
   *  toolbar). Farther apart ⇒ a re-frame (progressive/deeper), not a hold. */
  travelThreshold: number;
  /** changeCoverage ≥ this ⇒ the action repainted most of the frame (nav /
   *  global) ⇒ pull out to full view. The nav-vs-popover divider — the one knob
   *  to tune by eye on real captures (frame-diff pass populates the input). */
  pullOutCoverage: number;
};

// Defaults tuned as a STARTING point — every number here is meant to be judged
// on a rendered clip and A/B'd one at a time, not signed off on paper.
export const DEFAULT_CAMERA: CameraConfig = {
  enabled: true,
  fillFrac: 0.6,
  maxScale: 2.4,
  minHoldMs: 1200,
  minZoomScale: 1.25,
  coalesceWindowMs: 900,
  travelThreshold: 0.18,
  pullOutCoverage: 0.55,
};

export type TakeComposition = {
  output: { width: number; height: number; fps: number };
  source: {
    videoUrl: string;
    /** stage size the source video is DRAWN at (capture viewport CSS px) —
     *  the coordinate space of every event/bbox below. A Retina capture's
     *  file is denser (viewport × captureScale); the scene stretches it to
     *  this size, so the extra pixels only sharpen sampling under zoom. */
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
  /** Head trim (ms of the composition timeline cut from the delivered mp4).
   *  Capture starts at navigation, so the first frames show the app before it
   *  painted (plus any cold-cache font swap) — trim them here instead of
   *  post-processing with ffmpeg, so the refine loop keeps applying to the file
   *  actually shipped. Event tMs values stay on the untrimmed timeline (the
   *  capture is the ground truth); only the delivered head moves. 0/absent =
   *  no trim. */
  startMs?: number;
  /** render-time review decoration (badges/watermark/label); never persisted */
  review?: ReviewDecor;
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
  // Camera ramp durations, measured off a reference export by frame-
  // tracking (see math.ts springEase): punch-in spring ω≈9.4 rad/s ≈ 730ms,
  // pull-out ω≈5.2 ≈ 1340ms. The slow soft release is half the premium feel.
  // No zoomEase/zoomSpring set ⇒ stageEasing falls to springEase(0), the
  // critically-damped spring that IS the measured SS curve over these windows.
  zoomOutMs: 1340,
  zoomInMs: 730,
  // Asymptotic settle + pull-out dwell — the A/B "C variant" Pascal signed off
  // (2026-07-26): each camera move keeps a ~4% residual settling INTO the hold
  // (no velocity cliff at the keyframe — the frame-tracked reference tail), and
  // a squeezed pull-out stays ≥800ms on the payoff, landing late instead of
  // fleeing a frame the viewer is still reading. Old compositions without the
  // fields keep the legacy cut/squeeze schedule byte-identically.
  zoomSettleFrac: 0.04,
  pullOutDwellMs: 800,
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
