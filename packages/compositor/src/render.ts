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
import { type PlanOpts, planComposition } from "./plan";
import type { CaptureLog, TakeComposition } from "./types";

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
  await run("ffmpeg", [
    "-y", "-loglevel", "error", "-i", resolve(videoPath),
    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "18", "-r", String(fps), "-an", outMp4,
  ]);
}

export async function renderTake(opts: RenderTakeOpts): Promise<{ mp4Path: string; compositionPath: string }> {
  const composition: TakeComposition =
    opts.composition ??
    planComposition(
      opts.log ?? (() => { throw new Error("renderTake: provide `log` or `composition`"); })(),
      opts.planOpts,
    );

  // 1. serve the capture as /capture.mp4 (vite public dir under PKG_ROOT)
  await toMp4(opts.videoPath, PUBLIC_MP4, composition.output.fps);

  // 2. hand the composition to the scene (static import, rewritten per render)
  await mkdir(dirname(COMP_JSON), { recursive: true });
  await writeFile(COMP_JSON, JSON.stringify(composition, null, 2));

  // 3. render headless, with cwd pinned to the package root
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
        logProgress: opts.logProgress ?? false,
        puppeteer: { args: ["--no-sandbox", "--disable-setuid-sandbox"] },
      },
    });
  } finally {
    process.chdir(prevCwd);
  }

  // 4. deliver mp4 + the editable composition
  await mkdir(dirname(resolve(opts.outPath)), { recursive: true });
  await copyFile(resolve(PKG_ROOT, produced), resolve(opts.outPath));
  const compositionPath = resolve(opts.outPath).replace(/\.mp4$/i, "") + ".composition.json";
  await writeFile(compositionPath, JSON.stringify(composition, null, 2));

  return { mp4Path: resolve(opts.outPath), compositionPath };
}
