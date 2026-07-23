// renderTake: composition (or capture log) + captured video -> polished
// mp4 + the editable composition written alongside it.
//
// Runs revideo headless (vite + chromium + ffmpeg). The renderer resolves
// everything relative to process.cwd(), and injects `projectFile` verbatim
// as an import specifier — so the render runs from a directory laid out like
// the package (src/ + public/) with the vite-root-absolute
// "/src/scene/project.ts" (a bare specifier hangs the renderer forever; see
// spike-revideo/VERDICT.md).
//
// That directory is a per-render SCRATCH COPY in the tmp dir, never the
// installed package: a render used to write capture.mp4, .composition.json and
// out-render/ into node_modules, which breaks read-only installs outright and
// lets two renders read each other's composition. See prepareScratch.

import { spawn } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { renderVideo } from "@open-take/revideo-renderer";
import { repairBundledMediaPermissions, resolveFfmpeg } from "./ffmpeg";
import { type PlanOpts, planComposition } from "./plan";
import { type CaptureLog, type TakeComposition, motionBlurActive } from "./types";
import { type CompositionIssue, formatIssues, validateComposition } from "./validate";

// dist/index.js -> package root
const PKG_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const RENDER_OUT = "out-render"; // relative to cwd (= the scratch dir at render time)

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
   *  the capture path uses so a single browser serves both stages. The
   *  higher-level runtime resolves and supplies this to puppeteer-core. */
  chromePath: string;
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
    c.stderr.on("data", (d) => {
      err += d;
    });
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

// --- per-render scratch dir --------------------------------------------------

/** The nearest node_modules above the installed package. Symlinked into the
 *  scratch dir so the copied scene can still resolve `@revideo/*` — pnpm keeps
 *  a node_modules beside the package, npm/yarn hoist it to the project root, so
 *  walk up rather than assume either. */
function hostNodeModules(): string | null {
  let dir = PKG_ROOT;
  for (;;) {
    const candidate = join(dir, "node_modules");
    if (existsSync(candidate)) return candidate;
    const up = dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
}

/** The whole dependency tree in one directory, for vite's fs.allow. Vite serves
 *  realpaths, and pnpm's are under `<root>/node_modules/.pnpm/…`, so the first
 *  `node_modules` segment of a resolved dependency covers every layout. */
function depsRoot(): string | null {
  try {
    const real = realpathSync(createRequire(import.meta.url).resolve("@revideo/core"));
    const parts = real.split(sep);
    const i = parts.indexOf("node_modules");
    return i === -1 ? null : parts.slice(0, i + 1).join(sep);
  } catch {
    return null;
  }
}

/** Copy a tree WITHOUT inheriting its permission bits. `fs.cp` preserves mode,
 *  so copying out of a read-only install yields a read-only copy we then can't
 *  write the composition into. Re-creating each file gives us the umask
 *  default instead. The scene tree is a handful of small source files. */
async function copyWritable(from: string, to: string): Promise<void> {
  await mkdir(to, { recursive: true });
  for (const e of await readdir(from, { withFileTypes: true })) {
    const src = join(from, e.name);
    const dst = join(to, e.name);
    if (e.isDirectory()) await copyWritable(src, dst);
    else if (e.isFile()) await writeFile(dst, await readFile(src));
  }
}

async function cleanupScratch(dir: string): Promise<void> {
  // Drop the node_modules LINK first and by name: recursive deletion around a
  // link to the real dependency tree deserves an explicit safety boundary.
  await unlink(join(dir, "node_modules")).catch(() => {});
  if (!process.env.OPEN_TAKE_KEEP_SCRATCH) {
    await rm(dir, { recursive: true, force: true });
  } else {
    process.stderr.write(`render scratch kept: ${dir}\n`);
  }
}

/** Build the throwaway directory this render runs in: the package's `src/`
 *  (the scene and everything it imports), this render's composition, the
 *  normalised capture as vite's public asset, and a node_modules link. */
async function prepareScratch(composition: TakeComposition, videoPath: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "open-take-render-"));
  try {
    await copyWritable(join(PKG_ROOT, "src"), join(dir, "src"));
    await writeFile(
      join(dir, "src", "scene", ".composition.json"),
      JSON.stringify(composition, null, 2),
    );
    const nm = hostNodeModules();
    if (!nm) throw new Error("render: could not locate node_modules for the scene's imports");
    // "junction" is the Windows directory link that doesn't need admin rights;
    // ignored on POSIX.
    await symlink(nm, join(dir, "node_modules"), "junction");
    // fps follows the composition: the render grid must match the source, or a
    // hi-fps capture is decimated before the scene ever sees it.
    await toMp4(videoPath, join(dir, "public", "capture.mp4"), composition.output.fps);
    return dir;
  } catch (error) {
    await cleanupScratch(dir);
    throw error;
  }
}

// process.chdir is process-global, so two renders in one process cannot run
// concurrently no matter how isolated their directories are — the scratch dirs
// remove the shared STATE, this removes the interleaving. (True parallelism
// needs the renderer off cwd, or one child process per render.)
let renderQueue: Promise<unknown> = Promise.resolve();

export async function renderTake(
  opts: RenderTakeOpts,
): Promise<{ mp4Path: string; compositionPath: string }> {
  const run = renderQueue.then(
    () => renderTakeExclusive(opts),
    () => renderTakeExclusive(opts),
  );
  renderQueue = run.catch(() => {});
  return run;
}

async function renderTakeExclusive(
  opts: RenderTakeOpts,
): Promise<{ mp4Path: string; compositionPath: string }> {
  if (!opts.chromePath) {
    throw new Error(
      "renderTake: `chromePath` is required; use @open-take/runtime to resolve managed Chrome automatically",
    );
  }
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

  // Revideo spawns its bundled ffprobe directly. Repair installer permissions
  // here so published consumers are protected even though they do not run the
  // monorepo root's postinstall script.
  await repairBundledMediaPermissions();

  // 1. lay out this render's own directory (scene + composition + capture)
  const scratch = await prepareScratch(composition, opts.videoPath);
  const deps = depsRoot();
  try {
    // 2. render headless, with cwd pinned to the scratch dir.
    // revideo's @revideo/telemetry phones home to PostHog by default; this is an
    // all-local tool, so default it OFF (an explicit user-set value still wins).
    if (process.env.DISABLE_TELEMETRY === undefined) process.env.DISABLE_TELEMETRY = "true";
    const prevCwd = process.cwd();
    process.chdir(scratch);
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
            ? {
                progressCallback: (_worker: number, progress: number) => opts.onProgress!(progress),
              }
            : {}),
          // vite's dev server refuses to serve outside its root, and its root is
          // now a tmp dir — so allow the dependency tree the scene imports
          // through the node_modules link (vite resolves it to the realpath).
          viteConfig: {
            server: { fs: { allow: [scratch, ...(deps ? [deps] : [])] } },
          },
          // Reuse the capture-managed Chrome-for-Testing for both stages.
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
            executablePath: opts.chromePath,
          },
        },
      });
    } finally {
      process.chdir(prevCwd);
    }

    // 3. deliver mp4 (motion-blur down from fps·samples if configured) + the
    //    editable composition. OFF ⇒ a plain copy (byte-identical to before).
    await mkdir(dirname(resolve(opts.outPath)), { recursive: true });
    const producedAbs = resolve(scratch, produced);
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
  } finally {
    await cleanupScratch(scratch);
  }
}
