// @open-take/compositor — the polish engine (D3). Event log + captured
// frames -> polished mp4 + an editable revideo composition.
//
//   const comp = planComposition(captureLog)   // default editable plan
//   await renderTake({ composition: comp, videoPath, outPath, chromePath })
//
// Edit `comp` (zoom decisions, framing, cursor) and re-render — the
// composition is the editable source of truth.

export {
  type AuditCursorOpts,
  type AuditRow,
  auditCursor,
  auditIssues,
  predictCursorTips,
} from "./audit-cursor";
export { type Beat, directCamera, type Framing } from "./camera";
export { resolveBundledFfmpeg, resolveFfmpeg, resolveFfprobe } from "./ffmpeg";
export {
  evaluateUiMorph,
  launchAudioAtS,
  launchDurationS,
  launchSceneDurationS,
  launchSceneWindows,
  uiMorphDurationS,
  uiStateDurationS,
} from "./launch-evaluate";
export {
  type RenderLaunchOpts,
  type RenderLaunchResult,
  renderLaunch,
  validateLaunchAssets,
} from "./launch-render";
export { launchStarter } from "./launch-starter";
export { analyzeLaunchStory, validateLaunchStory } from "./launch-story";
export { launchTemplate } from "./launch-template";
export * from "./launch-types";
export { formatLaunchIssues, validateLaunchComposition } from "./launch-validate";
export * as math from "./math";
export { evaluateMotionScene, evaluateMotionTrack, motionGraphemes } from "./motion-evaluate";
export { analyzeMotionQuality } from "./motion-quality";
export {
  type CompareMotionRecipe,
  composeMotionStory,
  type FocusMotionRecipe,
  type MotionRecipe,
  type MotionRecipeImage,
  type MotionRecipeStyle,
  type MotionStoryBrief,
  type MotionStoryResult,
  type StepsMotionRecipe,
} from "./motion-recipes";
export * from "./motion-types";
export { validateMotionScene } from "./motion-validate";
export { type PlanOpts, planComposition } from "./plan";
export * from "./presets";
export { type RenderTakeOpts, type RenderTakeResult, renderTake } from "./render";
export * from "./types";
export {
  type CompositionIssue,
  formatIssues,
  type ValidateOpts,
  validateComposition,
} from "./validate";
