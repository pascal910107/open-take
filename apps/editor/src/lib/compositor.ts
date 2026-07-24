// Single bridge to the compositor's SOURCE (via the @compositor Vite alias).
// Everything spatial/temporal in the preview comes through here, so the editor
// can never quietly fork the renderer's math. If math.ts changes, the preview
// changes with it — no port to keep in sync.
export {
  smoother,
  cubicBezier,
  springEase,
  stageEasing,
  keyvalN,
  keyvalR,
  restStageScale,
  clampCenter,
  buildStageKeyframes,
  stageCamera,
  buildLegs,
  cursorPos,
  isDragging,
  gradientEndpoints,
} from "@compositor/math";

export { validateComposition, formatIssues } from "@compositor/validate";

export {
  LOOKS,
  MOTION,
  ZOOM_LEVELS,
  lookName,
  motionName,
  zoomLevelName,
  finishName,
} from "@compositor/presets";

export { DEFAULT_MOTION_BLUR } from "@compositor/types";

export type {
  TakeComposition,
  CompEvent,
  CaptureLog,
  Pt,
  BBox,
  FramingConfig,
  CursorConfig,
  MotionBlurConfig,
  ZoomDecision,
} from "@compositor/types";

export type { CompositionIssue } from "@compositor/validate";
