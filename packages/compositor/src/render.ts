// renderTake: composition (or capture log) + captured video -> polished
// mp4 + the editable composition written alongside it.
//
// Runs revideo headless (vite + chromium + ffmpeg). The renderer resolves
// everything relative to process.cwd(), and injects `projectFile` verbatim
// as an import specifier — so we chdir to the package root and use the
// vite-root-absolute "/src/scene/project.ts" (a bare specifier hangs the
// renderer forever; see spike-revideo/VERDICT.md).

import { spawn } from "node:child_process";
import { copyFile, mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { renderVideo } from "@revideo/renderer";
import { resolveFfmpeg } from "./ffmpeg";
import { type PlanOpts, planComposition } from "./plan";
import { type CaptureLog, type TakeComposition, motionBlurActive } from "./types";
import { type CompositionIssue, formatIssues, validateComposition } from "./validate";

// dist/index.js -> package root
const PKG_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PUBLIC_MP4 = resolve(PKG_ROOT, "public/capture.mp4");
const COMP_JSON = resolve(PKG_ROOT, "src/scene/.composition.json");
const RENDER_OUT = "out-render"; // relative to cwd (= PKG_ROOT at render time)

export type RenderTakeOpts = {
  /** input capture video (webm or mp4) */
  videoPath: string;
  /** output polished mp4 path */
  outPath: string;
  /** provide a capture log (auto-planned) ... */
  log?: CaptureLog;
  /** ... or a ready-made composition (editable artifact) */
  composition?: TakeComposition;
  planOpts?: PlanOpts;
  logProgress?: boolean;
  /** Chrome binary for the headless render. Pass the same Chrome-for-Testing
   *  the capture path uses so a single browser serves both stages (no second
   *  download). revideo forwards this to puppeteer.launch's executablePath;
   *  if unset, revideo's bundled puppeteer resolves its own. */
  chromePath?: string;
  /** the capture log, for cross-checking that an edited composition didn't
   *  drift an action's capture-locked tMs (see validateComposition). Optional —
   *  the structural checks run regardless. */
  captureLog?: CaptureLog;
  /** skip the pre-render structural validation. Default false — we validate and
   *  refuse to render an errored composition (a render is expensive; catch a bad
   *  hand-edit in milliseconds instead). */
  skipValidate?: boolean;
  /** progress callback (0..1) forwarded from revideo's renderer. */
  onProgress?: (progress: number) => void;
  /** render only this window of the composition timeline, in SECONDS — the
   *  windowed-render path behind A/B variant reels (a 4s window instead of the
   *  whole take). With motion blur OFF, frames are identical to the same span
   *  of a full render (the timeline is deterministic). With blur active the
   *  content matches but not bit-exactly: the tmix shutter windows are phased
   *  from the CLIP start, and the first frame's trailing window is truncated.
   *  Forwarded to revideo's projectSettings.range. */
  rangeSec?: [number, number];
  /** write the editable `<out>.composition.json` sibling (default true). Review
   *  copies and A/B reels are disposable — they skip the sibling. */
  writeCompositionSibling?: boolean;
};

function run(cmd: string, args: string[]): Promise<void> {
  return new Promise((res, rej) => {
    const c = spawn(cmd, args, { stdio: ["ignore", "ignore", "pipe"] });
    let err = "";
    c.stderr.on("data", (d) => (err += d));
    c.on("error", rej);
    c.on("close", (code) => (code === 0 ? res() : rej(new Error(`${cmd} exited ${code}: ${err}`))));
  });
}

/** Normalise the capture to a constant-fps mp4 the web decoder can read.
 *  fps follows the composition so a hi-fps capture can render at 60 (the
 *  render grid must match — a 30-grid would throw away the extra frames). */
async function toMp4(videoPath: string, outMp4: string, fps: number): Promise<void> {
  await mkdir(dirname(outMp4), { recursive: true });
  await run(await resolveFfmpeg(), [
    "-y",
    "-loglevel",
    "error",
    "-i",
    resolve(videoPath),
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    "-crf",
    "18",
    "-r",
    String(fps),
    "-an",
    outMp4,
  ]);
}

/** Temporal-supersampling motion blur: the scene was rendered at fps·samples
 *  (project.ts); average a trailing shutter window of sub-frames back down to the
 *  output fps. `tmix=frames=M` averages M consecutive sub-frames; `fps=baseFps`
 *  then decimates ≈every `samples`-th, so each output frame = the mean of the last
 *  M sub-frames of its interval (a trailing shutter). Re-tags bt709/tv to match
 *  the capture pipeline (the input is already bt709, but tmix→encode must keep it). */
async function motionBlurMp4(
  inMp4: string,
  outMp4: string,
  baseFps: number,
  samples: number,
  shutter: number,
): Promise<void> {
  const M = Math.max(1, Math.min(samples, Math.round(shutter * samples)));
  const vf =
    `tmix=frames=${M},fps=${baseFps},format=yuv420p,` +
    "setparams=range=tv:colorspace=bt709:color_primaries=bt709:color_trc=bt709";
  await run(await resolveFfmpeg(), [
    "-y",
    "-loglevel",
    "error",
    "-i",
    resolve(inMp4),
    "-vf",
    vf,
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    "-crf",
    "18",
    "-r",
    String(baseFps),
    "-an",
    outMp4,
  ]);
}

export async function renderTake(
  opts: RenderTakeOpts,
): Promise<{ mp4Path: string; compositionPath: string }> {
  const composition: TakeComposition =
    opts.composition ??
    planComposition(
      opts.log ??
        (() => {
          throw new Error("renderTake: provide `log` or `composition`");
        })(),
      opts.planOpts,
    );

  // 0. validate BEFORE the expensive render. A hand-edited composition (the
  //    refine loop) can carry a malformed zoom or a capture-locked tMs drift;
  //    catch it in milliseconds rather than after a multi-second render.
  if (!opts.skipValidate) {
    const issues: CompositionIssue[] = validateComposition(composition, {
      captureLog: opts.captureLog ?? opts.log,
    });
    const errors = issues.filter((i) => i.severity === "error");
    const warns = issues.filter((i) => i.severity === "warn");
    if (opts.logProgress && warns.length)
      process.stderr.write(`composition warnings:\n${formatIssues(warns)}\n`);
    if (errors.length)
      throw new Error(
        `composition has ${errors.length} error(s) — refusing to render:\n${formatIssues(errors)}`,
      );
  }

  // 1. serve the capture as /capture.mp4 (vite public dir under PKG_ROOT)
  await toMp4(opts.videoPath, PUBLIC_MP4, composition.output.fps);

  // 2. hand the composition to the scene (static import, rewritten per render)
  await mkdir(dirname(COMP_JSON), { recursive: true });
  await writeFile(COMP_JSON, JSON.stringify(composition, null, 2));

  // 3. render headless, with cwd pinned to the package root.
  // revideo's @revideo/telemetry phones home to PostHog by default; this is an
  // all-local tool, so default it OFF (an explicit user-set value still wins).
  if (process.env.DISABLE_TELEMETRY === undefined) process.env.DISABLE_TELEMETRY = "true";
  const prevCwd = process.cwd();
  process.chdir(PKG_ROOT);
  let produced: string;
  try {
    produced = await renderVideo({
      projectFile: "/src/scene/project.ts",
      settings: {
        outFile: "take.mp4",
        outDir: RENDER_OUT,
        workers: 1,
        ...(opts.rangeSec ? { projectSettings: { range: opts.rangeSec } } : {}),
        logProgress: opts.logProgress ?? false,
        ...(opts.onProgress
          ? { progressCallback: (_worker: number, progress: number) => opts.onProgress!(progress) }
          : {}),
        // Reuse the capture-managed Chrome-for-Testing when given (one browser
        // for both stages); else let revideo's puppeteer resolve its own.
        puppeteer: {
          // --password-store/--use-mock-keychain: never touch the OS keychain, so
          // macOS doesn't pop a "Chrome wants to use Chromium Safe Storage" prompt
          // mid-render (matches the capture launch in runtime/cdp.ts).
          args: [
            "--no-sandbox",
            "--disable-setuid-sandbox",
            "--password-store=basic",
            "--use-mock-keychain",
          ],
          ...(opts.chromePath ? { executablePath: opts.chromePath } : {}),
        },
      },
    });
  } finally {
    process.chdir(prevCwd);
  }

  // 4. deliver mp4 (motion-blur down from fps·samples if configured) + the
  //    editable composition. OFF ⇒ a plain copy (byte-identical to before).
  await mkdir(dirname(resolve(opts.outPath)), { recursive: true });
  const producedAbs = resolve(PKG_ROOT, produced);
  if (motionBlurActive(composition.motionBlur)) {
    await motionBlurMp4(
      producedAbs,
      resolve(opts.outPath),
      composition.output.fps,
      composition.motionBlur.samples,
      composition.motionBlur.shutter,
    );
  } else {
    await copyFile(producedAbs, resolve(opts.outPath));
  }
  const compositionPath = resolve(opts.outPath).replace(/\.mp4$/i, "") + ".composition.json";
  if (opts.writeCompositionSibling !== false) {
    // strip the render-time review decoration — the editable artifact is the
    // clean composition, never the badged/watermarked variant of it.
    const { review: _review, ...persisted } = composition;
    await writeFile(compositionPath, JSON.stringify(persisted, null, 2));
  }

  return { mp4Path: resolve(opts.outPath), compositionPath };
}
