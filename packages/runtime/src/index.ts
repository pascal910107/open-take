// @open-take/runtime — the thin pipeline: agent plan -> capture (event
// log) -> compositor -> polished mp4 + editable composition.
//
//   await makeTake(plan, { outPath: "demo.mp4" })      // capture + render
//   await renderComposition({ composition, capturePath, outPath })  // refine
//
// Keep it thin. The agent does the planning; this just runs the pipeline.
//
// The two entry points mirror the two costs. makeTake DRIVES the app in
// real-time (expensive, the ground-truth recording) and KEEPS the capture
// alongside the output. renderComposition re-renders an EDITED composition
// over that saved capture — no browser drive — which is the refinement loop:
// the agent tweaks the editable composition.json (zoom/pacing/framing) and
// re-renders deterministically. Only the *cinematic* layer is editable this
// way; changing the choreography (what's clicked/typed, beat order) needs a
// fresh makeTake (the video is temporal — see validateComposition).

import { copyFile, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  type CaptureLog,
  type PlanOpts,
  planComposition,
  renderTake,
  type TakeComposition,
} from "@open-take/compositor";
import { type CaptureOpts, captureTake } from "./capture";
import { ensureChrome } from "./cdp";
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
export { ensureChrome, resolveChrome } from "./cdp";
export { validateComposition, formatIssues, type CompositionIssue } from "@open-take/compositor";

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
  /** the KEPT raw capture (next to the mp4) — feed this back to
   *  renderComposition to refine without re-driving the app. */
  capturePath: string;
  /** the KEPT capture log (`<out>.capture.json`) — the ground-truth action
   *  timing. `render` auto-loads it so the capture-lock check (a refine must not
   *  move an action's tMs) is enforced in the real refine loop, not just inside
   *  makeTake. */
  captureLogPath: string;
  composition: TakeComposition;
};

/** `<out>.mp4` → `<out>.capture.mp4` — the raw recording kept beside the
 *  polished output so the composition can be re-rendered (refined) later. */
const capturePathFor = (outPath: string): string =>
  `${resolve(outPath).replace(/\.mp4$/i, "")}.capture.mp4`;

/** `<x>.capture.mp4` → `<x>.capture.json` — the capture log sits beside the
 *  video. Deriving it by convention lets `render` find the ground-truth timing
 *  from just the `--video` path. */
export const captureLogPathFor = (capturePath: string): string =>
  resolve(capturePath).replace(/\.mp4$/i, ".json");

/** Load the capture log that sits beside a capture video, if present. Returns
 *  undefined when there's no sibling (e.g. an old capture, or a hand-supplied
 *  video) — the capture-lock check is then skipped, not an error. */
export async function loadCaptureLogSibling(capturePath: string): Promise<CaptureLog | undefined> {
  const p = captureLogPathFor(capturePath);
  try {
    return JSON.parse(await readFile(p, "utf8")) as CaptureLog;
  } catch {
    return undefined;
  }
}

export async function makeTake(plan: TakePlan, opts: MakeTakeOpts): Promise<MakeTakeResult> {
  const work = await mkdtemp(join(tmpdir(), "open-take-"));
  const tmpVideo = join(work, "capture.mp4"); // CDP screencast → h264 mp4

  // Resolve (and, first run, download) Chrome ONCE, then hand the same binary
  // to both capture and render. One browser serves the whole pipeline — no
  // second download from revideo's bundled puppeteer.
  const chromePath = await ensureChrome(opts.capture?.chromePath);

  const log = await captureTake(plan, { ...opts.capture, chromePath, videoPath: tmpVideo });

  // KEEP the capture beside the output so refinement can re-render over it
  // without re-driving the app (the refine loop's whole point). Keep the LOG
  // too — it's the ground-truth action timing the capture-lock check needs in
  // the refine loop (the composition is editable; the log is not).
  const capturePath = capturePathFor(opts.outPath);
  const captureLogPath = captureLogPathFor(capturePath);
  await mkdir(dirname(capturePath), { recursive: true });
  await copyFile(tmpVideo, capturePath);
  await writeFile(captureLogPath, JSON.stringify(log, null, 2));

  // One knob: the render grid follows the capture fps (default 60) unless the
  // caller pinned an explicit render fps. (A 30fps
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
    videoPath: capturePath,
    outPath: resolve(opts.outPath),
    logProgress: opts.logProgress ?? false,
    chromePath,
    captureLog: log,
  });

  return { mp4Path, compositionPath, capturePath, captureLogPath, composition };
}

export type RenderCompositionOpts = {
  /** the edited composition (or its parsed JSON) */
  composition: TakeComposition;
  /** the kept raw capture from makeTake (`<out>.capture.mp4`) */
  capturePath: string;
  /** output polished mp4 path */
  outPath: string;
  /** the ground-truth capture log, for the capture-lock check (an edit must not
   *  move an action's tMs). Pass it to enforce the lock; omit to skip it. */
  captureLog?: CaptureLog;
  logProgress?: boolean;
  /** Chrome binary; resolved once if omitted */
  chromePath?: string;
};

/** Refine: re-render an EDITED composition over a saved capture — no app
 *  drive. This is the talk-to-edit loop's render step. Deterministic: the
 *  capture is frozen, so only your edits change the output. Validation runs at
 *  the render boundary (renderTake) and throws on a malformed edit — including a
 *  capture-locked tMs drift when `captureLog` is supplied. */
export async function renderComposition(
  opts: RenderCompositionOpts,
): Promise<{ mp4Path: string; compositionPath: string }> {
  const chromePath = await ensureChrome(opts.chromePath);
  return renderTake({
    composition: opts.composition,
    videoPath: resolve(opts.capturePath),
    outPath: resolve(opts.outPath),
    logProgress: opts.logProgress ?? false,
    chromePath,
    captureLog: opts.captureLog,
  });
}

/** Convenience: load a `*.composition.json` and re-render over a saved capture.
 *  Auto-loads the sibling capture log (`<video>`.json) so the capture-lock check
 *  is enforced in the CLI refine loop — pass `captureLogPath` to override, or
 *  set it to `null` to skip. Validation (incl. the lock) runs at the renderTake
 *  boundary, which throws on any error BEFORE the expensive render. */
export async function renderCompositionFile(opts: {
  compositionPath: string;
  capturePath: string;
  outPath: string;
  /** explicit capture-log path; default = the sibling of capturePath; null skips */
  captureLogPath?: string | null;
  logProgress?: boolean;
  chromePath?: string;
}): Promise<{ mp4Path: string; compositionPath: string }> {
  const composition = JSON.parse(await readFile(resolve(opts.compositionPath), "utf8")) as TakeComposition;
  const captureLog =
    opts.captureLogPath === null
      ? undefined
      : opts.captureLogPath
        ? (JSON.parse(await readFile(resolve(opts.captureLogPath), "utf8")) as CaptureLog)
        : await loadCaptureLogSibling(opts.capturePath);
  if (opts.logProgress)
    process.stderr.write(captureLog ? "capture-lock: on (loaded capture log)\n" : "capture-lock: off (no capture log)\n");
  return renderComposition({
    composition,
    capturePath: opts.capturePath,
    outPath: opts.outPath,
    captureLog,
    logProgress: opts.logProgress,
    chromePath: opts.chromePath,
  });
}
