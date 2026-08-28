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
export { resolveFfmpeg, resolveFfprobe } from "./ffmpeg";
export * as math from "./math";
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
