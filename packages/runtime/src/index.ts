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
  type CompositionIssue,
  type PlanOpts,
  type TakeComposition,
  planComposition,
  renderTake,
} from "@open-take/compositor";
import { type CaptureOpts, captureTake } from "./capture";
import { ensureChrome } from "./cdp";
import { annotateCaptureLog } from "./frame-diff";
import { toDraft } from "./review";
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
export { resolveNavigateUrl, type NavigateTarget } from "./nav";
export { authProfile, profileDir, type AuthOpts, type AuthResult } from "./auth";
export {
  annotateCaptureLog,
  diffFrames,
  type AnnotateOpts,
  type FrameDiffResult,
} from "./frame-diff";
export { ensureChrome, resolveChrome } from "./cdp";
export { startEditServer, type EditServerOpts } from "./edit-server";
export {
  requireTakeFiles,
  resolveTakePaths,
  stagePrev,
  type StagedPrev,
  type TakePaths,
} from "./take";
export {
  formatNotes,
  readNotes,
  waitForNotes,
  type NotesRead,
  type ReadNotesOpts,
  type WaitNotesOpts,
  type WaitNotesResult,
} from "./notes";
export {
  buildBeatSheet,
  buildBadges,
  beatLabel,
  renderReview,
  renderDraft,
  renderAbReel,
  renderBeforeAfter,
  toDraft,
  openPath,
  revealPath,
  SAY_IT_CARD,
  type AbOpts,
  type ReviewOpts,
} from "./review";
export {
  buildFramePlan,
  buildFrameSheet,
  renderFrames,
  type FramePlan,
  type FrameRow,
  type FrameCell,
  type FramePhase,
  type FramesOpts,
} from "./frames";
export { validateComposition, formatIssues, type CompositionIssue } from "@open-take/compositor";

export type MakeTakeOpts = {
  /** output polished mp4 path */
  outPath: string;
  /** tune the default composition (zoom fill/cap, framing, cursor) */
  planOpts?: PlanOpts;
  capture?: Omit<CaptureOpts, "videoPath">;
  /** frame-diff the capture to annotate each event with what it actually
   *  changed on screen (effectBox/changeCoverage — the camera director's
   *  nav-vs-popover + payoff-framing inputs). Default true; annotation
   *  failures never fail the take. */
  frameDiff?: boolean;
  logProgress?: boolean;
  /** print per-event diagnostics (the frame-diff lines). Default false — they
   *  are useful when debugging framing, but on a normal run they bury the
   *  warnings an author must act on (a skipped step). */
  verbose?: boolean;
  /** render the INITIAL mp4 at draft quality (30fps cap + motion blur off,
   *  ~6-12× faster) for the iterate loop; the capture still records at the
   *  full fps and the composition sibling keeps the full-quality settings, so
   *  the closing `render` produces the real master from the same take. */
  draft?: boolean;
  /** called the moment the raw capture lands beside the output — BEFORE the
   *  frame-diff + render minutes. The progressive-reveal hook: the CLI prints
   *  and auto-opens the raw footage so the user watches it while the polish
   *  renders. A throwing callback never fails the take. */
  onCaptureReady?: (capturePath: string) => void;
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
  /** steps the capture dropped (target not found) — surface these in the
   *  end-of-run summary; `--strict` turns them into a non-zero exit. */
  skipped: NonNullable<CaptureLog["skipped"]>;
  /** beats whose `settleMs` ran out before the PAGE was done. The capture
   *  waited (see runtime/src/settle.ts) so the take is still correct, but the
   *  plan is now known to under-budget those beats — the summary prints the
   *  number to write into `settleMs`, which is the whole point: it stops being
   *  a guess after the first run. */
  settleWaits: NonNullable<CaptureLog["settleWaits"]>;
  /** set when a `<canvas>`/`<video>` dominated the frame — the settle probe
   *  is blind inside one, so a quiet run proves nothing about those beats. */
  paintedFrac?: number;
  /** non-fatal validator findings on the rendered composition. Printed at the
   *  render boundary too, but that line is minutes deep in the progress output
   *  by the time the run ends — surface these in the end-of-run summary the
   *  same way `skipped` is, or they get scrolled past and ship. */
  warnings: CompositionIssue[];
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
  // to both capture and render. One browser serves the whole pipeline; the
  // renderer uses puppeteer-core and never downloads another one.
  const chromePath = await ensureChrome(opts.capture?.chromePath);

  const raw = await captureTake(plan, { ...opts.capture, chromePath, videoPath: tmpVideo });

  // KEEP the capture beside the output the moment it exists — BEFORE the
  // frame-diff + render minutes — so the caller can reveal the raw footage
  // while the polish is still cooking (perceived latency: the user sees
  // nothing for ~10 minutes otherwise). Refinement re-renders over this copy
  // without re-driving the app (the refine loop's whole point).
  const capturePath = capturePathFor(opts.outPath);
  const captureLogPath = captureLogPathFor(capturePath);
  await mkdir(dirname(capturePath), { recursive: true });
  await copyFile(tmpVideo, capturePath);
  try {
    opts.onCaptureReady?.(capturePath);
  } catch {
    // a reveal hook must never fail the take
  }

  // Tier-2 annotation: diff the recording around each action so the log
  // carries what each action actually changed (effectBox/changeCoverage) —
  // the director's ground truth for payoff-framing and nav pull-outs. The
  // annotated log is what gets KEPT, so later re-plans keep the signal.
  const log =
    opts.frameDiff === false
      ? raw
      : await annotateCaptureLog(raw, tmpVideo, { logProgress: opts.verbose === true });

  // Keep the LOG too — it's the ground-truth action timing the capture-lock
  // check needs in the refine loop (the composition is editable; the log is not).
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
  const { mp4Path, compositionPath, warnings } = await renderTake({
    // A draft take renders fast (30fps cap + no blur) but PLANS at full
    // quality: the sibling written below keeps the real settings, so the
    // closing `render` masters this same take without a re-make.
    composition: opts.draft ? toDraft(composition) : composition,
    videoPath: capturePath,
    outPath: resolve(opts.outPath),
    logProgress: opts.logProgress ?? false,
    chromePath,
    captureLog: log,
    ...(opts.draft ? { writeCompositionSibling: false } : {}),
  });
  if (opts.draft) await writeFile(compositionPath, JSON.stringify(composition, null, 2));

  return {
    mp4Path,
    compositionPath,
    capturePath,
    captureLogPath,
    composition,
    skipped: log.skipped ?? [],
    settleWaits: log.settleWaits ?? [],
    ...(log.paintedFrac != null ? { paintedFrac: log.paintedFrac } : {}),
    warnings,
  };
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
  /** render progress (0..1), forwarded from revideo — for a progress UI. */
  onProgress?: (progress: number) => void;
  /** Write the editable `<out>.composition.json` sibling (default true).
   *  Callers that already persisted the composition under their own
   *  concurrency guard can disable the second, unguarded write. */
  writeCompositionSibling?: boolean;
};

/** Refine: re-render an EDITED composition over a saved capture — no app
 *  drive. This is the talk-to-edit loop's render step. Deterministic: the
 *  capture is frozen, so only your edits change the output. Validation runs at
 *  the render boundary (renderTake) and throws on a malformed edit — including a
 *  capture-locked tMs drift when `captureLog` is supplied. */
export async function renderComposition(
  opts: RenderCompositionOpts,
): Promise<{ mp4Path: string; compositionPath: string; warnings: CompositionIssue[] }> {
  const chromePath = await ensureChrome(opts.chromePath);
  return renderTake({
    composition: opts.composition,
    videoPath: resolve(opts.capturePath),
    outPath: resolve(opts.outPath),
    logProgress: opts.logProgress ?? false,
    chromePath,
    captureLog: opts.captureLog,
    onProgress: opts.onProgress,
    writeCompositionSibling: opts.writeCompositionSibling,
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
  onProgress?: (progress: number) => void;
}): Promise<{ mp4Path: string; compositionPath: string; warnings: CompositionIssue[] }> {
  const composition = JSON.parse(
    await readFile(resolve(opts.compositionPath), "utf8"),
  ) as TakeComposition;
  const captureLog =
    opts.captureLogPath === null
      ? undefined
      : opts.captureLogPath
        ? (JSON.parse(await readFile(resolve(opts.captureLogPath), "utf8")) as CaptureLog)
        : await loadCaptureLogSibling(opts.capturePath);
  if (opts.logProgress)
    process.stderr.write(
      captureLog
        ? "capture-lock: on (loaded capture log)\n"
        : "capture-lock: off (no capture log)\n",
    );
  return renderComposition({
    composition,
    capturePath: opts.capturePath,
    outPath: opts.outPath,
    captureLog,
    logProgress: opts.logProgress,
    chromePath: opts.chromePath,
    onProgress: opts.onProgress,
  });
}
