// @open-take/compositor — the polish engine (D3). Event log + captured
// frames -> polished mp4 + an editable revideo composition.
//
//   const comp = planComposition(captureLog)   // default editable plan
//   await renderTake({ composition: comp, videoPath, outPath })
//
// Edit `comp` (zoom decisions, framing, cursor) and re-render — the
// composition is the editable source of truth.

export * from "./types";
export { planComposition, type PlanOpts } from "./plan";
export { renderTake, type RenderTakeOpts } from "./render";
export * as math from "./math";
