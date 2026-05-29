// @open-take/runtime — the thin pipeline: agent plan -> capture (event
// log) -> compositor -> polished mp4 + editable composition.
//
//   await makeTake(plan, { outPath: "demo.mp4" })
//
// Keep it thin. The agent does the planning; this just runs the pipeline.

import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { type PlanOpts, planComposition, renderTake, type TakeComposition } from "@open-take/compositor";
import { type CaptureOpts, captureTake } from "./capture";
import type { TakePlan } from "./types";

export type { TakePlan, TakeStep } from "./types";
export {
  captureTake,
  type CaptureOpts,
  inspectPage,
  type InspectOpts,
  type InspectResult,
  type InspectElement,
} from "./capture";
export { captureTakeCDP } from "./cdp-capture";

export type MakeTakeOpts = {
  /** output polished mp4 path */
  outPath: string;
  /** tune the default composition (zoom fill/cap, framing, cursor) */
  planOpts?: PlanOpts;
  capture?: Omit<CaptureOpts, "videoPath">;
  logProgress?: boolean;
};

export type MakeTakeResult = {
  mp4Path: string;
  compositionPath: string;
  composition: TakeComposition;
};

export async function makeTake(plan: TakePlan, opts: MakeTakeOpts): Promise<MakeTakeResult> {
  const work = await mkdtemp(join(tmpdir(), "open-take-"));
  const videoPath = join(work, "capture.mp4"); // CDP screencast → h264 mp4

  const log = await captureTake(plan, { ...opts.capture, videoPath });
  // One knob: the render grid follows the capture fps (default 60, matching
  // premium screen recorders) unless the caller pinned an explicit render fps. (A 30fps
  // render of a 60fps capture would discard half the frames; matching them is
  // what makes 60fps real.)
  const captureFps = opts.capture?.fps ?? 60;
  const planOpts =
    opts.planOpts?.output?.fps == null
      ? { ...opts.planOpts, output: { ...opts.planOpts?.output, fps: captureFps } }
      : opts.planOpts;
  const composition = planComposition(log, planOpts);
  const { mp4Path, compositionPath } = await renderTake({
    composition,
    videoPath,
    outPath: resolve(opts.outPath),
    logProgress: opts.logProgress ?? false,
  });

  return { mp4Path, compositionPath, composition };
}
