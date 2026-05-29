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
export { captureTake, type CaptureOpts } from "./capture";

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
  const videoPath = join(work, "capture.webm");

  const log = await captureTake(plan, { ...opts.capture, videoPath });
  const composition = planComposition(log, opts.planOpts);
  const { mp4Path, compositionPath } = await renderTake({
    composition,
    videoPath,
    outPath: resolve(opts.outPath),
    logProgress: opts.logProgress ?? false,
  });

  return { mp4Path, compositionPath, composition };
}
