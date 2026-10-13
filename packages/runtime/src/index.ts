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

import { existsSync } from "node:fs";
import { copyFile, cp, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  type CaptureLog,
  type ComponentsFile,
  type CompositionIssue,
  gatherComponents,
  type PartFilesResult,
  type PlanOpts,
  planComposition,
  readComponentSource,
  renderTake,
  type TakeComposition,
  writeComponents,
  writePartFiles,
} from "@open-take/compositor";
import { type CaptureOpts, captureTake } from "./capture";
import { type DragCadence, dragCadence, ensureChrome } from "./cdp";
import { annotateCaptureLog } from "./frame-diff";
import { toDraft } from "./review";
import { ensureTakeDir, resolveTakePaths, type TakePaths, takeFile } from "./take";
import type { TakePlan } from "./types";

export {
  type AuditCursorOpts,
  type AuditRow,
  auditCursor,
  type CaptureLog,
  type ComponentsFile,
  type CompositionIssue,
  changedLine,
  checkFilm,
  componentsLine,
  exampleSource,
  filmBeats,
  filmGallery,
  filmListen,
  filmLook,
  filmPicture,
  filmProbe,
  filmReport,
  filmSheet,
  filmStills,
  followedLine,
  formatComponents,
  formatFilmBeats,
  formatFilmCheck,
  formatFilmListen,
  formatFilmLook,
  formatFilmProbe,
  formatFilmReport,
  formatIssues,
  formatMaterials,
  initFilm,
  type MaterialsFile,
  type MaterialsPage,
  materialsSummary,
  muxFilm,
  type PartFilesResult,
  pageMaterialNote,
  partFilesLine,
  partsLine,
  patchFilm,
  readPageMaterial,
  renderFilm,
  type TakeComposition,
  validateComposition,
} from "@open-take/compositor";
export { type AuthOpts, type AuthResult, authProfile, profileDir } from "./auth";
export {
  type CaptureOpts,
  captureTake,
  type InspectElement,
  type InspectOpts,
  type InspectResult,
  inspectPage,
} from "./capture";
export { type DragCadence, dragCadence, ensureChrome, resolveChrome } from "./cdp";
export { captureTakeCDP } from "./cdp-capture";
export { type CheckTakeOpts, checkTake, type InventoryRule } from "./check-take";
export {
  type AgentArgsOpts,
  type AgentRunResult,
  type AppProcess,
  appBootEnv,
  buildAgentArgs,
  buildCiBrief,
  CI_ALLOWED_TOOLS,
  CI_DISALLOWED_TOOLS,
  type CiBriefOpts,
  type CiMode,
  type CiOpts,
  type CiResult,
  ciAllowedOrigins,
  ciTake,
  emitGithubOutputs,
  emitStepSummary,
  probeDurationS,
  renderTeaserGif,
  runAgent,
  startApp,
  waitForHttp,
} from "./ci";
export { type InventoryOpts, type InventoryResult, inventoryComponents } from "./components";
export {
  asDefects,
  buildDefectReport,
  DEFECTS_CLOSE,
  DEFECTS_OPEN,
  type Defect,
  type DefectGate,
  type DefectReport,
  type GateIssue,
  renderDefectBlock,
  settleDefects,
  skippedDefects,
} from "./defect-report";
export { measureParts, measureStateDirs } from "./dom-state";
export { type EditServerOpts, startEditServer } from "./edit-server";
export {
  type AnnotateOpts,
  alignFrames,
  annotateCaptureLog,
  diffFrames,
  type FrameDiffResult,
  measureStateSeams,
  measureTake,
  resultFrames,
} from "./frame-diff";
export {
  buildFramePlan,
  buildFrameSheet,
  type FrameCell,
  type FramePhase,
  type FramePlan,
  type FrameRow,
  type FramesOpts,
  renderFrames,
} from "./frames";
export { checkLaunchFile, composeLaunchFile, initLaunchProject, renderLaunchFile } from "./launch";
export { lintPlan, type PlanIssue } from "./lint-plan";
export { inventoryMaterials, type MaterialsInventory } from "./materials";
export { type NavigateTarget, resolveNavigateUrl } from "./nav";
export {
  formatNotes,
  type NotesRead,
  type ReadNotesOpts,
  readNotes,
  type WaitNotesOpts,
  type WaitNotesResult,
  waitForNotes,
} from "./notes";
export {
  healingWithheld,
  type PostShootIO,
  type PostShootPass,
  type PostShootResult,
  runPostShootGates,
} from "./post-shoot";
export { type PrecheckIssue, PrecheckRefusal, planTargets, precheckPlan } from "./precheck";
export {
  type AbOpts,
  beatLabel,
  buildBadges,
  buildBeatSheet,
  openPath,
  type ReviewOpts,
  renderAbReel,
  renderBeforeAfter,
  renderDraft,
  renderReview,
  revealPath,
  SAY_IT_CARD,
  toDraft,
} from "./review";
export {
  runShoot,
  type Shoot,
  type ShootAction,
  type ShootActOpts,
  type ShootBox,
  type ShootLog,
  type ShootMoving,
  type ShootOpenOpts,
  type ShootOpts,
  type ShootOutput,
  type ShootScript,
  type ShootSettle,
  type ShootStateItem,
  type ShootSteady,
  type ShootStill,
  type ShootTarget,
  shootHome,
  shootStatesLine,
  shootSteadyLine,
} from "./shoot";
export {
  describeTake,
  type FormatOpts,
  formatTakeStates,
  outlineState,
  type TakeStates,
} from "./states-list";
export {
  ensureTakeDir,
  requireTakeFiles,
  resolveTakePaths,
  type StagedPrev,
  stagePrev,
  TAKE_DIR_SUFFIX,
  type TakePaths,
  takeFile,
} from "./take";
export type { TakePlan, TakeStep } from "./types";

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
  /** false: record only — keep the capture, its log, the saved screens and the
   *  planned composition, and render no master (a film that only needs the
   *  recording as material; `render` masters the take later). Default true. */
  render?: boolean;
};

export type MakeTakeResult = {
  /** the master's path — written unless `render: false` asked for none */
  mp4Path: string;
  /** whether the master was rendered */
  rendered: boolean;
  compositionPath: string;
  /** the take's working directory (`<out>.take/`) — everything but the master */
  takeDir: string;
  /** the KEPT raw capture (`<out>.take/capture.mp4`) — feed this back to
   *  renderComposition to refine without re-driving the app. */
  capturePath: string;
  /** the KEPT capture log (`<out>.take/capture.json`) — the ground-truth action
   *  timing. `render` auto-loads it so the capture-lock check (a refine must not
   *  move an action's tMs) is enforced in the real refine loop, not just inside
   *  makeTake. */
  captureLogPath: string;
  composition: TakeComposition;
  /** steps the capture dropped (target not found) — surface these in the
   *  end-of-run summary; by default they turn into a non-zero exit
   *  (`--no-strict` downgrades them to a warning). */
  skipped: NonNullable<CaptureLog["skipped"]>;
  /** pre-capture target-resolution warnings (runtime/src/precheck.ts). Errors
   *  already aborted the capture; what survives here is the suspect-but-legal
   *  tier (ambiguous selectors, late-bound targets) — summary material. */
  precheck: NonNullable<CaptureLog["precheck"]>;
  /** beats whose `settleMs` ran out before the PAGE was done. The capture
   *  waited (see runtime/src/settle.ts) so the take is still correct, but the
   *  plan is now known to under-budget those beats — the summary prints the
   *  number to write into `settleMs`, which is the whole point: it stops being
   *  a guess after the first run. */
  settleWaits: NonNullable<CaptureLog["settleWaits"]>;
  /** set when a `<canvas>`/`<video>` dominated the frame — the settle probe
   *  is blind inside one, so a quiet run proves nothing about those beats. */
  paintedFrac?: number;
  /** the pictures the capture got during each drag (see dragCadence) */
  dragCadence: DragCadence[];
  /** non-fatal validator findings on the rendered composition. Printed at the
   *  render boundary too, but that line is minutes deep in the progress output
   *  by the time the run ends — surface these in the end-of-run summary the
   *  same way `skipped` is, or they get scrolled past and ship. */
  warnings: CompositionIssue[];
  /** the saved states' component inventory (<name>.take/components.json),
   *  when the take kept states */
  components?: { file: ComponentsFile; path: string };
  /** each of those parts as a file of its own (<name>.take/parts/) */
  parts?: PartFilesResult;
};

/** `<video>.mp4` → `<video>.json` — the capture log sits beside its video
 *  (`capture.mp4` → `capture.json` inside the take's working dir). Deriving it
 *  by convention lets `render` find the ground-truth timing from just the
 *  `--video` path. */
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
  // the raw screencast and its saved states land here first; what is kept is
  // copied into the take, and the rest goes when the take is made
  const work = await mkdtemp(join(tmpdir(), "open-take-"));
  try {
    return await makeTakeIn(work, plan, opts);
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

async function makeTakeIn(
  work: string,
  plan: TakePlan,
  opts: MakeTakeOpts,
): Promise<MakeTakeResult> {
  const tmpVideo = join(work, "capture.mp4"); // CDP screencast → h264 mp4

  // Resolve (and, first run, download) Chrome ONCE, then hand the same binary
  // to both capture and render. One browser serves the whole pipeline; the
  // renderer uses puppeteer-core and never downloads another one.
  const chromePath = await ensureChrome(opts.capture?.chromePath);

  const raw = await captureTake(plan, { ...opts.capture, chromePath, videoPath: tmpVideo });

  // KEEP the capture in the take's working dir the moment it exists — BEFORE
  // the frame-diff + render minutes — so the caller can reveal the raw footage
  // while the polish is still cooking (perceived latency: the user sees
  // nothing for ~10 minutes otherwise). Refinement re-renders over this copy
  // without re-driving the app (the refine loop's whole point).
  const take = await resolveTakePaths(opts.outPath);
  const { capturePath, captureLogPath } = take;
  await mkdir(dirname(take.mp4Path), { recursive: true });
  await ensureTakeDir(take);
  await copyFile(tmpVideo, capturePath);
  // DOM states ride along with the capture they describe: the states dir
  // beside the temp video is copied in beside the kept one (replacing whatever
  // an earlier make left — its tMs belonged to that capture, not this one; a
  // re-make WITHOUT states clears it for the same reason).
  const statesDst = join(take.dir, "states");
  await rm(statesDst, { recursive: true, force: true });
  const statesSrc = join(work, "states");
  if (raw.states && existsSync(statesSrc)) await cp(statesSrc, statesDst, { recursive: true });
  // The product's own sound, same rule: what an earlier make heard belonged to
  // that capture's clock, so it goes even when this one heard nothing.
  for (const name of ["product-audio.wav", "product-sound.json", "product-sounds"]) {
    await rm(join(take.dir, name), { recursive: true, force: true });
    const src = join(work, name);
    if (existsSync(src)) await cp(src, join(take.dir, name), { recursive: true });
  }
  try {
    opts.onCaptureReady?.(capturePath);
  } catch {
    // a reveal hook must never fail the take
  }

  // Tier-2 annotation: diff the recording around each action so the log
  // carries what each action actually changed (effectBox/changeCoverage) —
  // the director's ground truth for payoff-framing and nav pull-outs. The
  // annotated log is what gets KEPT, so later re-plans keep the signal.
  const annotated =
    opts.frameDiff === false
      ? raw
      : await annotateCaptureLog(raw, tmpVideo, { logProgress: opts.verbose === true });
  // Stamp the app this take is OF. Nothing in the render reads it; it is how a
  // take on disk can answer "which app?" — `make` uses it to refuse
  // overwriting a take of a different app at the same --out.
  const log: CaptureLog = { ...annotated, url: plan.url };

  // Keep the LOG too — it's the ground-truth action timing the capture-lock
  // check needs in the refine loop (the composition is editable; the log is not).
  await writeFile(captureLogPath, JSON.stringify(log, null, 2));

  // The parts each saved state holds (measured in the fidelity page), with
  // what the log adds — <name>.take/components.json. No browser; one that
  // cannot be gathered never fails the take. An earlier make's goes either way.
  const componentsPath = join(take.dir, "components.json");
  await rm(componentsPath, { force: true });
  let components: MakeTakeResult["components"];
  let parts: PartFilesResult | undefined;
  if (log.states?.items.length && opts.capture?.components !== false)
    try {
      const source = readComponentSource(take.dir);
      const file = gatherComponents(source);
      components = { file, path: writeComponents(file, take.dir) };
      // and each part as a file of its own, <name>.take/parts/
      try {
        parts = writePartFiles(file, source, join(take.dir, "parts"));
      } catch (e) {
        console.error(`make: no part files (${(e as Error).message})`);
      }
    } catch (e) {
      console.error(`make: no components.json (${(e as Error).message})`);
    }

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
  if (opts.render === false) {
    await writeFile(take.compositionPath, JSON.stringify(composition, null, 2));
    // a master an earlier make rendered belongs to that capture, not this one
    // (the CLI has already kept it as prev.mp4)
    await rm(take.mp4Path, { force: true });
    return {
      mp4Path: take.mp4Path,
      rendered: false,
      compositionPath: take.compositionPath,
      takeDir: take.dir,
      capturePath,
      captureLogPath,
      composition,
      skipped: log.skipped ?? [],
      precheck: log.precheck ?? [],
      settleWaits: log.settleWaits ?? [],
      ...(log.paintedFrac != null ? { paintedFrac: log.paintedFrac } : {}),
      dragCadence: dragCadence(
        log.events,
        log.captureCadence?.frameOffsetsMs ?? [],
        log.captureCadence?.arrivalOffsetsMs,
      ),
      warnings: [],
      ...(components ? { components } : {}),
      ...(parts ? { parts } : {}),
    };
  }
  const { mp4Path, compositionPath, warnings } = await renderTake({
    // A draft take renders fast (30fps cap + no blur) but PLANS at full
    // quality: the sibling written below keeps the real settings, so the
    // closing `render` masters this same take without a re-make.
    composition: opts.draft ? toDraft(composition) : composition,
    videoPath: capturePath,
    outPath: take.mp4Path,
    compositionPath: take.compositionPath,
    logProgress: opts.logProgress ?? false,
    chromePath,
    captureLog: log,
    ...(opts.draft ? { writeCompositionSibling: false } : {}),
  });
  if (opts.draft) await writeFile(compositionPath, JSON.stringify(composition, null, 2));

  return {
    mp4Path,
    rendered: true,
    compositionPath,
    takeDir: take.dir,
    capturePath,
    captureLogPath,
    composition,
    skipped: log.skipped ?? [],
    precheck: log.precheck ?? [],
    settleWaits: log.settleWaits ?? [],
    ...(log.paintedFrac != null ? { paintedFrac: log.paintedFrac } : {}),
    dragCadence: dragCadence(
      log.events,
      log.captureCadence?.frameOffsetsMs ?? [],
      log.captureCadence?.arrivalOffsetsMs,
    ),
    warnings,
    ...(components ? { components } : {}),
    ...(parts ? { parts } : {}),
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
  /** Write the editable composition into the take's working dir (default true).
   *  Callers that already persisted the composition under their own
   *  concurrency guard can disable the second, unguarded write. */
  writeCompositionSibling?: boolean;
};

/** Refine: re-render an EDITED composition over a saved capture — no app
 *  drive. This is the talk-to-edit loop's render step. Deterministic: the
 *  capture is frozen, so only your edits change the output. Validation runs at
 *  the render boundary (renderTake) and throws on a malformed edit — including a
 *  capture-locked tMs drift when `captureLog` is supplied. */
export async function renderComposition(opts: RenderCompositionOpts): Promise<{
  mp4Path: string;
  compositionPath: string;
  warnings: CompositionIssue[];
  composition: TakeComposition;
}> {
  const chromePath = await ensureChrome(opts.chromePath);
  // Where the editable composition belongs is a TAKE-layout question (its
  // working dir), so it is answered here and not in the compositor.
  const take = await resolveTakePaths(opts.outPath);
  if (opts.writeCompositionSibling !== false) await ensureTakeDir(take);
  return renderTake({
    composition: opts.composition,
    videoPath: resolve(opts.capturePath),
    outPath: take.mp4Path,
    compositionPath: take.compositionPath,
    logProgress: opts.logProgress ?? false,
    chromePath,
    captureLog: opts.captureLog,
    onProgress: opts.onProgress,
    writeCompositionSibling: opts.writeCompositionSibling,
  });
}

/** The bounded re-render behind the post-shoot cursor gate: render the SAME
 *  composition over the frozen capture to a scratch name inside the working
 *  dir, then rename over the master only on success — a crashed re-render
 *  must not eat the file the first audit measured. Calls renderTake directly
 *  (not renderComposition, which canonicalizes outPath back to the take's
 *  master — exactly the in-place overwrite this scratch name exists to
 *  avoid). */
export async function reRenderInPlace(
  take: TakePaths,
  composition: TakeComposition,
  captureLog: CaptureLog | undefined,
  opts: { logProgress?: boolean } = {},
): Promise<void> {
  const chromePath = await ensureChrome();
  const pending = takeFile(take, "re-render.pending.mp4");
  try {
    await renderTake({
      composition,
      videoPath: resolve(take.capturePath),
      outPath: pending,
      compositionPath: take.compositionPath,
      logProgress: opts.logProgress ?? true,
      chromePath,
      captureLog,
      writeCompositionSibling: false,
    });
    await rename(pending, take.mp4Path);
  } finally {
    await rm(pending, { force: true });
  }
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
}): Promise<{
  mp4Path: string;
  compositionPath: string;
  warnings: CompositionIssue[];
  composition: TakeComposition;
}> {
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
