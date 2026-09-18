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
  mkdir,
  mkdtemp,
  readdir,
  readFile,
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
import { isCaptureUndecodable } from "./decode-guard";
import { ffmpegHasEncoder, repairBundledMediaPermissions, resolveFfmpeg } from "./ffmpeg";
import { type PlanOpts, planComposition } from "./plan";
import {
  type CaptureLog,
  type MotionBlurConfig,
  motionBlurActive,
  type TakeComposition,
} from "./types";
import { type CompositionIssue, formatIssues, validateComposition } from "./validate";
import { withRenderLock } from "./render-lock";

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
  /** write the editable composition (default true). Review copies and A/B reels
   *  are disposable — they skip it. */
  writeCompositionSibling?: boolean;
  /** where to write it. Default `<out>.composition.json`; the runtime passes the
   *  take's working dir instead. WHERE a take keeps its files is a take-layout
   *  question — the compositor just writes where it is told. */
  compositionPath?: string;
};

export type RenderTakeResult = {
  mp4Path: string;
  compositionPath: string;
  /** non-fatal validator findings for this composition. The render went ahead,
   *  but each one is something the author has to look at — a zoom that punches
   *  into empty space, a press whose zoom departs before the keypress, a tail
   *  that delivers a frozen screen. Empty when `skipValidate` is set. */
  warnings: CompositionIssue[];
  /** the composition this render actually used — callers that judge the
   *  output (post-shoot gates) must judge THIS object, not a re-read of
   *  composition.json, which a concurrent editor save may have moved on. */
  composition: TakeComposition;
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
 *  render grid must match — a 30-grid would throw away the extra frames).
 *
 *  `codec` is normally h264; "vp9" is the retry arm for render browsers
 *  WITHOUT H.264 decoding (Playwright-style Chromium builds ship no
 *  proprietary codecs). The scene's decode guard rejects in seconds when the
 *  capture can't decode there (see src/decode-guard.ts); renderTakeExclusive
 *  catches that rejection and re-encodes the scratch capture with this arm
 *  before one retry. The VP9 fallback must keep the .mp4 container AND the
 *  capture.mp4 name: revideo routes video decoding by file extension, so a
 *  .webm would take a different (and broken) decode path — VP9-in-MP4 (vp09
 *  track) is the shape that works. */
async function toMp4(
  videoPath: string,
  outMp4: string,
  fps: number,
  codec: "h264" | "vp9",
): Promise<void> {
  await mkdir(dirname(outMp4), { recursive: true });
  const codecArgs =
    codec === "vp9"
      ? ["-c:v", "libvpx-vp9", "-b:v", "0", "-crf", "24", "-row-mt", "1", "-cpu-used", "4"]
      : ["-c:v", "libx264", "-crf", "18"];
  await run(await resolveFfmpeg(), [
    "-y",
    "-loglevel",
    "error",
    "-i",
    resolve(videoPath),
    ...codecArgs,
    "-pix_fmt",
    "yuv420p",
    "-r",
    String(fps),
    "-an",
    outMp4,
  ]);
}

/** Delivery encode: the visually-lossless ProRes intermediate -> the postable
 *  H.264. The ONLY lossy generation in the pipeline, so its CRF is the
 *  master's quality — overlay text (captions/title card) used to look soft
 *  because it took TWO generations before this fix: revideo's default wasm
 *  exporter (WebCodecs H.264 at the browser's default bitrate, no knob, at
 *  fps·samples) and then this re-encode on top.
 *
 *  Motion blur folds in here (temporal supersampling: the scene was rendered
 *  at fps·samples, project.ts): `tmix=frames=M` averages M consecutive
 *  sub-frames; `fps=baseFps` then decimates ≈every `samples`-th, so each
 *  output frame = the mean of the last M sub-frames of its interval (a
 *  trailing shutter).
 *
 *  The scale step is a REAL conversion, not a re-tag: the ProRes encode
 *  converts the scene's RGB frames with swscale's default bt601 matrix, so
 *  the intermediate is 601-coded. Convert to bt709 and tag it — verified by
 *  round-tripping primaries (601-coded red merely tagged 709 decodes to
 *  rgb(255,24,0); converted it decodes to rgb(252,0,0)). */
async function deliverMp4(
  inMov: string,
  outMp4: string,
  baseFps: number,
  blur: MotionBlurConfig | null,
): Promise<void> {
  const vf: string[] = [];
  if (blur) {
    const M = Math.max(1, Math.min(blur.samples, Math.round(blur.shutter * blur.samples)));
    vf.push(`tmix=frames=${M}`, `fps=${baseFps}`);
  }
  vf.push(
    "scale=in_color_matrix=bt601:out_color_matrix=bt709",
    "format=yuv420p",
    "setparams=range=tv:colorspace=bt709:color_primaries=bt709:color_trc=bt709",
  );
  await run(await resolveFfmpeg(), [
    "-y",
    "-loglevel",
    "error",
    "-i",
    resolve(inMov),
    "-vf",
    vf.join(","),
    "-c:v",
    "libx264",
    "-crf",
    "18",
    "-movflags",
    "+faststart",
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
    // hi-fps capture is decimated before the scene ever sees it. Always H.264
    // here — the happy path — the decode-guard retry re-encodes as VP9 in
    // place when the render browser can't take it.
    await toMp4(videoPath, join(dir, "public", "capture.mp4"), composition.output.fps, "h264");
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
export async function renderTake(opts: RenderTakeOpts): Promise<RenderTakeResult> {
  return withRenderLock(() => renderTakeExclusive(opts));
}

async function renderTakeExclusive(opts: RenderTakeOpts): Promise<RenderTakeResult> {
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
  //    Warnings are RETURNED as well as printed: this stderr line lands minutes
  //    before the render finishes, so on its own it is scrolled past — the
  //    caller re-prints them in the end-of-run summary, exactly as it already
  //    does for skipped capture steps.
  const warnings: CompositionIssue[] = [];
  if (!opts.skipValidate) {
    const issues: CompositionIssue[] = validateComposition(composition, {
      captureLog: opts.captureLog ?? opts.log,
    });
    const errors = issues.filter((i) => i.severity === "error");
    warnings.push(...issues.filter((i) => i.severity === "warn"));
    if (opts.logProgress && warnings.length)
      process.stderr.write(`composition warnings:\n${formatIssues(warnings)}\n`);
    if (errors.length)
      throw new Error(
        `composition has ${errors.length} error(s) — refusing to render:\n${formatIssues(errors)}`,
      );
  }

  // Head trim (composition.startMs): deliver the timeline from startMs on,
  // through the SAME range mechanism the A/B windows use — the composition
  // timeline (tMs, badges, keyframes) is untouched; only the delivered head
  // moves. An explicit rangeSec (an A/B clip window) wins: those windows are
  // authored on the composition timeline and already judged as clips.
  const rangeSec =
    opts.rangeSec ??
    (composition.startMs && composition.startMs > 0
      ? ([composition.startMs / 1000, composition.durationMs / 1000 + 120] as [number, number])
      : undefined);

  // Revideo spawns its bundled ffprobe directly. Repair installer permissions
  // here so published consumers are protected even though they do not run the
  // monorepo root's postinstall script.
  await repairBundledMediaPermissions();

  // 1. lay out this render's own directory (scene + composition + capture).
  //    The intermediate starts as H.264; the decode-guard retry below swaps
  //    it for VP9 when the render browser turns out not to decode it.
  const scratch = await prepareScratch(composition, opts.videoPath);
  const deps = depsRoot();
  // Resolved BEFORE the chdir below: the retry re-encode runs while cwd is
  // the scratch dir, where a relative videoPath would resolve wrongly.
  const videoAbs = resolve(opts.videoPath);
  try {
    // 2. render headless, with cwd pinned to the scratch dir.
    // revideo's @revideo/telemetry phones home to PostHog by default; this is an
    // all-local tool, so default it OFF (an explicit user-set value still wins).
    if (process.env.DISABLE_TELEMETRY === undefined) process.env.DISABLE_TELEMETRY = "true";

    // One attempt = one renderVideo call with its own no-progress hint timer.
    // A stuck render is SILENT: revideo's first progress tick fires only after
    // the first frame fully renders, and legitimate pre-roll can take tens of
    // seconds — so hint (never kill) when no tick has landed after 3 minutes.
    const renderOnce = async (): Promise<string> => {
      let noProgressTimer: ReturnType<typeof setTimeout> | undefined = setTimeout(() => {
        process.stderr.write(
          "open-take: no render progress after 3 minutes — if this never advances, the render browser may be stuck decoding the capture (see OPEN_TAKE_CHROME)\n",
        );
      }, 180_000);
      try {
        return await renderVideo({
          projectFile: "/src/scene/project.ts",
          settings: {
            outFile: "take.mov",
            outDir: RENDER_OUT,
            workers: 1,
            // ProRes 4444 intermediate, NOT revideo's default wasm exporter: the
            // wasm path encodes H.264 in-browser via WebCodecs at the browser's
            // default bitrate (mp4-wasm passes `bitrate: undefined`, and revideo
            // 0.11 exposes no knob) — at fps·samples that visibly softens fine
            // detail, screen-space caption/title text worst of all, before the
            // delivery encode ever runs. The ffmpeg exporter is fed lossless PNG
            // frames and prores_ks 4444 keeps them visually intact (4:4:4, no
            // DCT mush), leaving deliverMp4's CRF 18 as the single lossy
            // generation. Costs scratch disk (GBs at fps·samples for a long
            // take) and slower frame handoff — accepted for the master's text.
            projectSettings: {
              exporter: { name: "@revideo/core/ffmpeg", options: { format: "proRes" } },
              ...(rangeSec ? { range: rangeSec } : {}),
            },
            logProgress: opts.logProgress ?? false,
            // Wrapped even without opts.onProgress: the first tick proves the
            // browser is decoding frames, which disarms the no-progress hint.
            progressCallback: (_worker: number, progress: number) => {
              if (noProgressTimer !== undefined) {
                clearTimeout(noProgressTimer);
                noProgressTimer = undefined;
              }
              opts.onProgress?.(progress);
            },
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
        if (noProgressTimer !== undefined) clearTimeout(noProgressTimer);
      }
    };

    const prevCwd = process.cwd();
    process.chdir(scratch);
    let produced: string;
    try {
      try {
        produced = await renderOnce();
      } catch (error) {
        // The scene's decode guard rejected: this browser cannot decode the
        // H.264 intermediate (Playwright-style Chromium ships no proprietary
        // codecs — before the guard, such a render hung forever; a real user
        // lost ~20 minutes to that silence). Re-encode the scratch capture as
        // VP9-in-MP4 and retry ONCE; without an ffmpeg that can, refuse with
        // the fix. Any other rejection rethrows untouched.
        if (!isCaptureUndecodable(error)) throw error;
        const detail = error instanceof Error ? error.message : String(error);
        if (!(await ffmpegHasEncoder("libvpx-vp9"))) {
          throw new Error(
            `render: the browser at ${opts.chromePath} cannot decode the capture (${detail}) — ` +
              "point OPEN_TAKE_CHROME at a full Chrome/Chrome-for-Testing build, or install an " +
              "ffmpeg with libvpx-vp9 to enable the VP9 fallback",
            { cause: error },
          );
        }
        process.stderr.write(
          "open-take: the render browser cannot decode the H.264 capture — retrying with a VP9 intermediate (output unchanged)\n",
        );
        await toMp4(
          videoAbs,
          join(scratch, "public", "capture.mp4"),
          composition.output.fps,
          "vp9",
        );
        try {
          produced = await renderOnce();
        } catch (retryError) {
          if (!isCaptureUndecodable(retryError)) throw retryError;
          const retryDetail = retryError instanceof Error ? retryError.message : String(retryError);
          throw new Error(
            `render: the browser at ${opts.chromePath} cannot decode the capture even as VP9 ` +
              `(${retryDetail}) — point OPEN_TAKE_CHROME at a full Chrome/Chrome-for-Testing build`,
            { cause: retryError },
          );
        }
      }
    } finally {
      process.chdir(prevCwd);
    }

    // 3. deliver the postable mp4 from the ProRes intermediate + the editable
    //    composition. Motion blur (when configured) and the 601→709 colour
    //    conversion both happen inside this single encode — see deliverMp4.
    await mkdir(dirname(resolve(opts.outPath)), { recursive: true });
    const producedAbs = resolve(scratch, produced);
    await deliverMp4(
      producedAbs,
      resolve(opts.outPath),
      composition.output.fps,
      motionBlurActive(composition.motionBlur) ? composition.motionBlur : null,
    );
    const compositionPath = opts.compositionPath
      ? resolve(opts.compositionPath)
      : `${resolve(opts.outPath).replace(/\.mp4$/i, "")}.composition.json`;
    if (opts.writeCompositionSibling !== false) {
      // strip the render-time review decoration — the editable artifact is the
      // clean composition, never the badged/watermarked variant of it.
      const { review: _review, ...persisted } = composition;
      await mkdir(dirname(compositionPath), { recursive: true });
      await writeFile(compositionPath, JSON.stringify(persisted, null, 2));
    }

    return { mp4Path: resolve(opts.outPath), compositionPath, warnings, composition };
  } finally {
    await cleanupScratch(scratch);
  }
}
