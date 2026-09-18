import { spawn } from "node:child_process";
import { existsSync, realpathSync, statSync } from "node:fs";
import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
import {
  analyzeLaunchStory,
  analyzeMotionQuality,
  composeMotionStory,
  formatLaunchIssues,
  type LaunchComposition,
  type LaunchIssue,
  launchStarter,
  renderLaunch,
  resolveFfprobe,
  validateLaunchAssets,
} from "@open-take/compositor";
import { ensureChrome } from "./cdp";

function visitLaunchAssets(composition: LaunchComposition, visit: (asset: string) => string): void {
  for (const scene of composition.scenes) {
    if (scene.type === "footage") scene.asset = visit(scene.asset);
    if (scene.type !== "motion") continue;
    const visitLayers = (layers: typeof scene.layers) => {
      for (const layer of layers) {
        if (layer.type === "image" || layer.type === "video") layer.asset = visit(layer.asset);
        if (layer.type === "group") visitLayers(layer.children);
      }
    };
    visitLayers(scene.layers);
  }
  for (const track of composition.audio ?? []) track.asset = visit(track.asset);
}

function canonicalPath(path: string): string {
  if (existsSync(path)) return realpathSync(path);
  const parent = dirname(path);
  return parent === path ? path : join(canonicalPath(parent), basename(path));
}

function sameArtifact(left: string, right: string): boolean {
  if (canonicalPath(left) === canonicalPath(right)) return true;
  if (!existsSync(left) || !existsSync(right)) return false;
  const a = statSync(left),
    b = statSync(right);
  return a.dev === b.dev && a.ino === b.ino;
}

/** ffprobe's `r_frame_rate` is a rational like "60/1" or "30000/1001". */
function parseFrameRate(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const [num, den = "1"] = value.split("/");
  const fps = Number(num) / Number(den);
  return Number.isFinite(fps) && fps > 0 ? fps : undefined;
}

async function videoInfo(
  path: string,
): Promise<{ duration: number; video: boolean; fps?: number }> {
  const bin = await resolveFfprobe();
  return new Promise((ok, fail) => {
    const child = spawn(
      bin,
      [
        "-v",
        "error",
        "-select_streams",
        "v:0",
        "-show_entries",
        "format=duration:stream=codec_type,duration,r_frame_rate,avg_frame_rate",
        "-of",
        "json",
        path,
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let out = "",
      err = "",
      settled = false;
    const finish = (error?: Error, value?: { duration: number; video: boolean; fps?: number }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      error ? fail(error) : ok(value!);
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(new Error("launch init: video probe exceeded 15 seconds"));
    }, 15_000);
    child.stdout.on("data", (d) => {
      out += d;
      if (out.length > 65_536) {
        child.kill("SIGKILL");
        finish(new Error("launch init: video probe returned too much data"));
      }
    });
    child.stderr.on("data", (d) => {
      err += d;
      if (err.length > 8192) err = err.slice(-8192);
    });
    child.on("error", (error) => finish(error));
    child.on("close", (code) => {
      try {
        const data = JSON.parse(out) as {
          format?: { duration?: string };
          streams?: {
            codec_type?: string;
            duration?: string;
            r_frame_rate?: string;
            avg_frame_rate?: string;
          }[];
        };
        const video = data.streams?.find((x) => x.codec_type === "video");
        if (code !== 0) throw new Error(err.trim() || `ffprobe exited with code ${code}`);
        if (!video) throw new Error("file has no video stream");
        const streamDuration = Number(video.duration);
        const formatDuration = Number(data.format?.duration);
        const n =
          Number.isFinite(streamDuration) && streamDuration > 0 ? streamDuration : formatDuration;
        if (!Number.isFinite(n) || n <= 0) throw new Error("video duration is unavailable");
        const fps = parseFrameRate(video.avg_frame_rate) ?? parseFrameRate(video.r_frame_rate);
        finish(undefined, { duration: n, video: true, ...(fps ? { fps } : {}) });
      } catch (error) {
        finish(
          new Error(
            `launch init: cannot read video: ${error instanceof Error ? error.message : String(error)}`,
          ),
        );
      }
    });
  });
}

export async function initLaunchProject(
  directory: string,
  videoPath: string,
): Promise<{ compositionPath: string; videoPath: string }> {
  const dir = resolve(directory),
    source = resolve(videoPath);
  const info = await videoInfo(source);
  if (!info.video) throw new Error("launch init: --video must contain a video stream");
  const seconds = info.duration;
  // Keep the recording's own rate (clamped to the composition's accepted range)
  // so a 60fps take is not silently halved; fall back to make's default.
  const fps = Math.min(120, Math.max(1, Math.round(info.fps ?? 60)));
  if (seconds < 1 / fps)
    throw new Error(
      `launch init: source video is ${seconds.toFixed(3)}s; at least one frame at ${fps} fps is required`,
    );
  await mkdir(dirname(dir), { recursive: true });
  try {
    await mkdir(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST")
      throw new Error(`launch init: refusing to overwrite existing directory ${dir}`);
    throw error;
  }
  try {
    await mkdir(join(dir, "assets"));
    const target = join(dir, "assets", basename(source));
    await copyFile(source, target);
    const composition = launchStarter(`assets/${basename(source)}`, seconds, fps);
    const compositionPath = join(dir, "launch.json");
    await writeFile(compositionPath, JSON.stringify(composition, null, 2) + "\n");
    return { compositionPath, videoPath: target };
  } catch (error) {
    await rm(dir, { recursive: true, force: true });
    throw error;
  }
}

export async function composeLaunchFile(
  briefPath: string,
  outputPath: string,
): Promise<{
  compositionPath: string;
  composition: LaunchComposition;
  issues: LaunchIssue[];
}> {
  const brief = resolve(briefPath),
    output = resolve(outputPath),
    briefDir = dirname(brief),
    outputDir = dirname(output);
  let value: unknown;
  try {
    value = JSON.parse(await readFile(brief, "utf8"));
  } catch (error) {
    throw new Error(
      `launch compose: cannot read brief JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const built = composeMotionStory(value);
  const buildErrors = built.issues.filter((issue) => issue.severity === "error");
  if (!built.composition || buildErrors.length) {
    throw new Error(`launch compose failed:\n${formatLaunchIssues(built.issues)}`);
  }

  const composition = built.composition;
  const sourceIssues = await validateLaunchAssets(composition, brief);
  const sourceErrors = sourceIssues.filter((issue) => issue.severity === "error");
  if (sourceErrors.length) {
    throw new Error(`launch compose failed:\n${formatLaunchIssues(sourceIssues)}`);
  }

  const sourceAssets: string[] = [];
  visitLaunchAssets(composition, (asset) => {
    const source = resolve(briefDir, asset);
    sourceAssets.push(source);
    return relative(outputDir, source);
  });
  const protectedInputs = [brief, ...sourceAssets];
  if (protectedInputs.some((source) => sameArtifact(output, source))) {
    throw new Error("launch compose: output must not overwrite the brief or a required asset");
  }

  const rebasedIssues = await validateLaunchAssets(composition, output);
  const rebasedErrors = rebasedIssues.filter((issue) => issue.severity === "error");
  if (rebasedErrors.length) {
    throw new Error(
      `launch compose failed after rebasing assets:\n${formatLaunchIssues(rebasedIssues)}`,
    );
  }

  await mkdir(outputDir, { recursive: true });
  try {
    await writeFile(output, `${JSON.stringify(composition, null, 2)}\n`, { flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error(`launch compose: refusing to overwrite existing output ${output}`);
    }
    throw error;
  }
  return {
    compositionPath: output,
    composition,
    issues: [...built.issues, ...rebasedIssues],
  };
}

export async function checkLaunchFile(
  compositionPath: string,
): Promise<{ composition: LaunchComposition; issues: LaunchIssue[] }> {
  const path = resolve(compositionPath);
  const composition = JSON.parse(await readFile(path, "utf8")) as LaunchComposition;
  const issues = await validateLaunchAssets(composition, path);
  if (!issues.some((issue) => issue.severity === "error")) {
    issues.push(...analyzeMotionQuality(composition), ...analyzeLaunchStory(composition));
  }
  return { composition, issues };
}

export async function renderLaunchFile(opts: {
  compositionPath: string;
  outPath?: string;
  draft?: boolean;
  chromePath?: string;
  logProgress?: boolean;
}) {
  const path = resolve(opts.compositionPath);
  const { composition, issues } = await checkLaunchFile(path);
  const errors = issues.filter((x) => x.severity === "error");
  if (errors.length) throw new Error(`launch check failed:\n${formatLaunchIssues(errors)}`);
  const defaultName = opts.draft ? "launch.draft.mp4" : "launch.mp4";
  const outPath = resolve(opts.outPath ?? join(dirname(path), defaultName));
  const chromePath = await ensureChrome(opts.chromePath);
  const result = await renderLaunch({
    composition,
    compositionPath: path,
    outPath,
    chromePath,
    draft: opts.draft,
    logProgress: opts.logProgress,
  });
  const warnings = [...issues.filter((issue) => issue.severity === "warn"), ...result.warnings];
  return {
    ...result,
    warnings: warnings.filter(
      (issue, index) =>
        warnings.findIndex(
          (other) => other.path === issue.path && other.message === issue.message,
        ) === index,
    ),
  };
}
