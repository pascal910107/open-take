import { spawn } from "node:child_process";
import { existsSync, realpathSync, statSync } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { basename, dirname, extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { renderVideo } from "@open-take/revideo-renderer";
import { repairBundledMediaPermissions, resolveFfmpeg, resolveFfprobe } from "./ffmpeg";
import { launchAudioAtS, launchDurationS } from "./launch-evaluate";
import type { LaunchAudioTrack, LaunchComposition, LaunchIssue } from "./launch-types";
import { formatLaunchIssues, validateLaunchComposition } from "./launch-validate";
import { walkMotionLayers } from "./motion-evaluate";
import type { MotionImageLayer, MotionLayer, MotionScene, MotionVideoLayer } from "./motion-types";
import { withRenderLock } from "./render-lock";

const PKG_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export type RenderLaunchOpts = {
  composition: LaunchComposition;
  compositionPath: string;
  outPath: string;
  chromePath: string;
  draft?: boolean;
  logProgress?: boolean;
  onProgress?: (progress: number) => void;
};
export type RenderLaunchResult = { mp4Path: string; durationS: number; warnings: LaunchIssue[] };

/** Media subprocesses must not hang or retain unbounded corrupt-file diagnostics. */
async function run(
  bin: string,
  args: string[],
  capture = false,
  timeoutMs = 120_000,
): Promise<string> {
  return new Promise((ok, fail) => {
    const child = spawn(bin, args, { stdio: ["ignore", capture ? "pipe" : "ignore", "pipe"] });
    let out = "",
      err = "",
      settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) fail(error);
      else ok(out);
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(new Error(`${basename(bin)} exceeded the ${timeoutMs / 1000}s media-operation limit`));
    }, timeoutMs);
    child.stdout?.on("data", (data: Buffer) => {
      out += data.toString();
      if (out.length > 1_000_000) {
        child.kill("SIGKILL");
        finish(new Error(`${basename(bin)} exceeded the media-output limit`));
      }
    });
    child.stderr?.on("data", (data: Buffer) => {
      err = (err + data.toString()).slice(-12000);
    });
    child.on("error", (error) => finish(error));
    child.on("close", (code) =>
      finish(code === 0 ? undefined : new Error(`${basename(bin)} exited ${code}: ${err.trim()}`)),
    );
  });
}

type MediaInfo = {
  duration: number;
  video: boolean;
  audio: boolean;
  videoDuration: number;
  audioDuration: number;
  width: number;
  height: number;
};
async function probeMedia(path: string): Promise<MediaInfo> {
  try {
    const raw = await run(
      await resolveFfprobe(),
      [
        "-v",
        "error",
        "-show_entries",
        "format=duration:stream=codec_type,duration,width,height",
        "-of",
        "json",
        path,
      ],
      true,
    );
    const data = JSON.parse(raw) as {
      format?: { duration?: string };
      streams?: { codec_type?: string; duration?: string; width?: number; height?: number }[];
    };
    const duration = Number(data.format?.duration);
    if (!Number.isFinite(duration) || duration <= 0)
      throw new Error("media has no finite positive duration");
    const video = data.streams?.find((x) => x.codec_type === "video"),
      audio = data.streams?.find((x) => x.codec_type === "audio");
    const streamDuration = (stream: typeof video) => {
      const n = Number(stream?.duration);
      return Number.isFinite(n) && n > 0 ? n : duration;
    };
    return {
      duration,
      video: !!video,
      audio: !!audio,
      videoDuration: streamDuration(video),
      audioDuration: streamDuration(audio),
      width: video?.width ?? 0,
      height: video?.height ?? 0,
    };
  } catch (error) {
    throw new Error(
      `could not probe ${path}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

type ImageInfo = { width: number; height: number };
const imageInputOptions = [
  "-max_alloc",
  "268435456",
  "-protocol_whitelist",
  "file,pipe",
  "-format_whitelist",
  "image2,png_pipe,jpeg_pipe,webp_pipe",
];
async function probeMotionImage(path: string): Promise<ImageInfo> {
  if (statSync(path).size > 64 * 1024 * 1024)
    throw new Error("image exceeds the 64 MiB source-file limit");
  const raw = await run(
    await resolveFfprobe(),
    [
      "-v",
      "error",
      ...imageInputOptions,
      "-show_entries",
      "stream=codec_name,codec_type,width,height",
      "-of",
      "json",
      path,
    ],
    true,
    30_000,
  );
  const data = JSON.parse(raw) as {
    streams?: { codec_name?: string; codec_type?: string; width?: number; height?: number }[];
  };
  const stream = data.streams?.[0];
  if (
    data.streams?.length !== 1 ||
    stream?.codec_type !== "video" ||
    !["png", "mjpeg", "webp"].includes(stream.codec_name ?? "")
  )
    throw new Error("asset must decode as a single PNG, JPEG or WebP image");
  const width = stream.width ?? 0,
    height = stream.height ?? 0;
  if (
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width < 1 ||
    height < 1 ||
    width > 16384 ||
    height > 16384 ||
    width * height > 32_000_000
  )
    throw new Error(
      "image dimensions must be positive, at most 16384px per side and at most 32 megapixels",
    );
  // Probing headers alone accepts truncated images. Decode a real frame before rendering.
  await run(
    await resolveFfmpeg(),
    [
      "-v",
      "error",
      "-xerror",
      ...imageInputOptions,
      "-i",
      path,
      "-frames:v",
      "1",
      "-f",
      "null",
      "-",
    ],
    false,
    30_000,
  );
  return { width, height };
}
function cropError(layer: MotionImageLayer, image: ImageInfo): string | undefined {
  const crop = layer.crop;
  if (crop && (crop.x + crop.width > image.width || crop.y + crop.height > image.height))
    return `crop must stay inside the ${image.width}x${image.height} source image`;
  return undefined;
}
function motionMedia(comp: LaunchComposition) {
  const media: {
    layer: MotionImageLayer | MotionVideoLayer;
    path: string;
    scene: MotionScene;
    parents: MotionLayer[];
  }[] = [];
  const visit = (
    layers: MotionLayer[],
    prefix: string,
    scene: MotionScene,
    parents: MotionLayer[],
  ) => {
    layers.forEach((layer, i) => {
      const path = `${prefix}[${i}]`;
      if (layer.type === "image" || layer.type === "video")
        media.push({ layer, path, scene, parents });
      else if (layer.type === "group")
        visit(layer.children, `${path}.children`, scene, [...parents, layer]);
    });
  };
  comp.scenes.forEach((scene, i) => {
    if (scene.type === "motion") visit(scene.layers, `scenes[${i}].layers`, scene, []);
  });
  return media;
}

function motionImages(comp: LaunchComposition) {
  return motionMedia(comp).filter(
    (item): item is typeof item & { layer: MotionImageLayer } => item.layer.type === "image",
  );
}

/** Largest pixel stretch. Static matrix products are exact; animated extrema form
 * a conservative bound because each supported easing stays between its keyframes. */
function mediaStretch(
  item: ReturnType<typeof motionMedia>[number],
  output: LaunchComposition["output"],
  source: ImageInfo,
) {
  const { layer, parents, scene } = item;
  const max = (node: MotionLayer, property: string, fallback: number) => {
    const track =
      scene.motion !== "off" ? node.animations?.find((t) => t.property === property) : undefined;
    return track
      ? Math.max(...track.keyframes.map((f) => Number(f.value)))
      : Number((node as unknown as Record<string, unknown>)[property] ?? fallback);
  };
  const chain = [...parents, layer];
  const animated =
    scene.motion !== "off" &&
    chain.some((node) =>
      node.animations?.some((t) =>
        ["scaleX", "scaleY", "rotation", "width", "height"].includes(t.property),
      ),
    );
  let stretch = 1;
  if (animated) {
    for (const node of chain) stretch *= Math.max(max(node, "scaleX", 1), max(node, "scaleY", 1));
  } else {
    let a = 1,
      b = 0,
      c = 0,
      d = 1;
    for (const node of chain) {
      const angle = ((node.rotation ?? 0) * Math.PI) / 180,
        cos = Math.cos(angle),
        sin = Math.sin(angle),
        sx = node.scaleX ?? 1,
        sy = node.scaleY ?? 1;
      [a, b, c, d] = [
        (a * cos + c * sin) * sx,
        (b * cos + d * sin) * sx,
        (-a * sin + c * cos) * sy,
        (-b * sin + d * cos) * sy,
      ];
    }
    const sum = a * a + b * b + c * c + d * d,
      determinant = a * d - b * c;
    stretch = Math.sqrt(
      (sum + Math.sqrt(Math.max(0, sum * sum - 4 * determinant * determinant))) / 2,
    );
  }
  const design = scene.designSize ?? { width: 1920, height: 1080 };
  const fit = layer.fit === "cover" ? Math.max : Math.min;
  const factor =
    fit(
      max(layer, "width", layer.width) / source.width,
      max(layer, "height", layer.height) / source.height,
    ) *
    stretch *
    Math.min(output.width / design.width, output.height / design.height);
  return { factor, animated };
}

function warnEnlargement(
  issues: LaunchIssue[],
  path: string,
  source: ImageInfo,
  factor: number,
  animated = false,
) {
  // Subpixel fitting/rounding below 1% is not a meaningful density loss.
  if (factor <= 1.01 || !Number.isFinite(factor)) return;
  issues.push({
    severity: "warn",
    path,
    message: `Asset enlargement ${factor.toFixed(2)}x: ${source.width}x${source.height} source pixels ${animated ? "may be enlarged under conservative animation bounds" : "are enlarged at the authored size"}. Capture/export a higher-resolution source (at least ${Math.ceil(source.width * factor)}x${Math.ceil(source.height * factor)} for this footprint), reduce the displayed size, or choose a tighter source with enough pixels. Encoding bitrate cannot restore missing detail.`,
  });
}

/** Internal preparation seam: call only on a validated clone, never authored composition data. */
export async function prepareMotionImages(
  comp: LaunchComposition,
  compositionPath: string,
  assetsDir: string,
): Promise<void> {
  const base = dirname(resolve(compositionPath)),
    cache = new Map<string, string>();
  const ffmpeg = await resolveFfmpeg();
  let count = 0;
  for (const { layer } of motionImages(comp)) {
    const source = resolve(base, layer.asset),
      key = JSON.stringify([realpathSync(source), layer.crop]);
    let asset = cache.get(key);
    if (!asset) {
      const info = await probeMotionImage(source),
        invalidCrop = cropError(layer, info);
      if (invalidCrop) throw new Error(invalidCrop);
      const name = `motion-image-${count++}.png`,
        crop = layer.crop;
      const filters = [
        crop ? `crop=w=${crop.width}:h=${crop.height}:x=${crop.x}:y=${crop.y}:exact=1` : "null",
        "format=rgba",
      ];
      await run(
        ffmpeg,
        [
          "-y",
          "-v",
          "error",
          "-xerror",
          ...imageInputOptions,
          "-i",
          source,
          "-vf",
          filters.join(","),
          "-frames:v",
          "1",
          "-update",
          "1",
          join(assetsDir, name),
        ],
        false,
        30_000,
      );
      asset = `/assets/${name}`;
      cache.set(key, asset);
    }
    layer.asset = asset;
    delete layer.crop;
  }
}

export async function validateLaunchAssets(
  value: unknown,
  compositionPath: string,
): Promise<LaunchIssue[]> {
  const base = dirname(resolve(compositionPath));
  const issues = validateLaunchComposition(value, base);
  if (issues.some((x) => x.severity === "error")) return issues;
  const comp = value as LaunchComposition;
  const probes = new Map<string, Promise<MediaInfo>>();
  const inspect = async (
    asset: string,
    path: string,
    kind: "video" | "audio",
    trim: number,
    duration: number,
    loop = false,
  ) => {
    const full = resolve(base, asset);
    let pending = probes.get(full);
    if (!pending) {
      pending = probeMedia(full);
      probes.set(full, pending);
    }
    try {
      const got = await pending;
      if (!got[kind]) {
        issues.push({ severity: "error", path, message: `asset has no ${kind} stream` });
        return;
      }
      const available = kind === "video" ? got.videoDuration : got.audioDuration;
      if (trim >= available || (!loop && trim + duration > available + 0.001))
        issues.push({
          severity: "error",
          path,
          message: `needs ${loop ? `a trim before ${trim.toFixed(3)}s` : `${(trim + duration).toFixed(3)}s`} but ${kind} media is ${available.toFixed(3)}s`,
        });
      return got;
    } catch (error) {
      issues.push({
        severity: "error",
        path,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  };
  for (const [i, scene] of comp.scenes.entries())
    if (scene.type === "footage") {
      const info = await inspect(
        scene.asset,
        `scenes[${i}].asset`,
        "video",
        scene.trimStartS ?? 0,
        scene.durationS,
      );
      if (info?.width && info.height) {
        const inset =
          (scene.frame?.inset ?? 86) *
          Math.min(comp.output.width / 1920, comp.output.height / 1080);
        const fit = scene.fit === "cover" ? Math.max : Math.min;
        warnEnlargement(
          issues,
          `scenes[${i}].asset`,
          info,
          fit(
            (comp.output.width - 2 * inset) / info.width,
            (comp.output.height - 2 * inset) / info.height,
          ),
        );
      }
    }
  for (const [i, track] of (comp.audio ?? []).entries())
    await inspect(
      track.asset,
      `audio[${i}].asset`,
      "audio",
      track.trimStartS ?? 0,
      track.durationS ?? launchDurationS(comp) - launchAudioAtS(comp, track),
      !!track.loop,
    );
  const imageProbes = new Map<string, Promise<ImageInfo>>();
  for (const item of motionMedia(comp)) {
    const { layer, path } = item;
    if (layer.type === "video") {
      const info = await inspect(
        layer.asset,
        `${path}.asset`,
        "video",
        layer.trimStartS ?? 0,
        layer.durationS,
      );
      if (info?.width && info.height) {
        const { factor, animated } = mediaStretch(item, comp.output, info);
        warnEnlargement(issues, `${path}.asset`, info, factor, animated);
      }
      continue;
    }
    const source = resolve(base, layer.asset);
    let pending = imageProbes.get(source);
    if (!pending) {
      pending = probeMotionImage(source);
      imageProbes.set(source, pending);
    }
    try {
      const image = await pending,
        invalid = cropError(layer, image);
      if (invalid) issues.push({ severity: "error", path: `${path}.crop`, message: invalid });
      else {
        const source = layer.crop ?? image;
        const { factor, animated } = mediaStretch(item, comp.output, source);
        warnEnlargement(issues, `${path}.asset`, source, factor, animated);
      }
    } catch (error) {
      issues.push({
        severity: "error",
        path: `${path}.asset`,
        message: `could not decode image: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }
  return issues;
}

/** Internal preparation seam: lossless VP9 is decoded by the scene's explicit
 * HTMLVideoElement (slow) decoder. Color conversion and fitting happen once;
 * the codec adds no quantization before the final delivery encode. */
export async function prepareLaunchVideo(
  source: string,
  target: string,
  opts: {
    trimStartS: number;
    durationS: number;
    fps: number;
    frame?: { width: number; height: number; fit: "contain" | "cover" };
  },
): Promise<void> {
  const { frame } = opts;
  const color = "flags=lanczos:out_range=tv:out_color_matrix=bt709";
  const scale = frame
    ? frame.fit === "cover"
      ? `scale=${frame.width}:${frame.height}:force_original_aspect_ratio=increase:${color},crop=${frame.width}:${frame.height}`
      : `scale=${frame.width}:${frame.height}:force_original_aspect_ratio=decrease:${color},pad=${frame.width}:${frame.height}:(ow-iw)/2:(oh-ih)/2:color=#0b1714`
    : `scale=trunc(iw/2)*2:trunc(ih/2)*2:${color}`;
  // Lossless high-density video preparation can exceed the shorter probe limit
  // on a busy machine. Keep a separate, bounded ten-minute transcode deadline.
  await run(
    await resolveFfmpeg(),
    [
      "-y",
      "-loglevel",
      "error",
      "-ss",
      String(opts.trimStartS),
      "-i",
      source,
      "-t",
      String(opts.durationS + 1 / opts.fps),
      "-map",
      "0:v:0",
      "-vf",
      `${scale},setsar=1,format=yuv420p,setparams=range=tv:colorspace=bt709:color_primaries=bt709:color_trc=bt709,tpad=stop_mode=clone:stop_duration=${1 / opts.fps}`,
      "-c:v",
      "libvpx-vp9",
      "-lossless",
      "1",
      "-b:v",
      "0",
      "-cpu-used",
      "4",
      "-row-mt",
      "1",
      "-g",
      String(Math.ceil(opts.fps)),
      "-pix_fmt",
      "yuv420p",
      "-r",
      String(opts.fps),
      "-an",
      target,
    ],
    false,
    600_000,
  );
}

/** Trim each nested video independently; authored scene timing stays unchanged. */
export async function prepareMotionVideos(
  comp: LaunchComposition,
  compositionPath: string,
  assetsDir: string,
): Promise<void> {
  let count = 0;
  for (const { layer } of motionMedia(comp)) {
    if (layer.type !== "video") continue;
    const name = `motion-video-${count++}.webm`;
    await prepareLaunchVideo(
      resolve(dirname(resolve(compositionPath)), layer.asset),
      join(assetsDir, name),
      {
        trimStartS: layer.trimStartS ?? 0,
        durationS: layer.durationS,
        fps: comp.output.fps,
      },
    );
    layer.asset = `/assets/${name}`;
    layer.trimStartS = 0;
  }
}

function hostNodeModules(): string | null {
  let dir = PKG_ROOT;
  for (;;) {
    const p = join(dir, "node_modules");
    if (existsSync(p)) return p;
    const up = dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
}
function depsRoot(): string | null {
  try {
    const parts = realpathSync(createRequire(import.meta.url).resolve("@revideo/core")).split(sep);
    const i = parts.indexOf("node_modules");
    return i < 0 ? null : parts.slice(0, i + 1).join(sep);
  } catch {
    return null;
  }
}
async function copyWritable(from: string, to: string): Promise<void> {
  await mkdir(to, { recursive: true });
  for (const e of await readdir(from, { withFileTypes: true })) {
    const a = join(from, e.name),
      b = join(to, e.name);
    if (e.isDirectory()) await copyWritable(a, b);
    else if (e.isFile()) await writeFile(b, await readFile(a));
  }
}
async function cleanup(dir: string): Promise<void> {
  await unlink(join(dir, "node_modules")).catch(() => {});
  if (process.env.OPEN_TAKE_KEEP_SCRATCH)
    process.stderr.write(`launch render scratch kept: ${dir}\n`);
  else await rm(dir, { recursive: true, force: true });
}

async function prepare(
  comp: LaunchComposition,
  compositionPath: string,
  draft: boolean,
): Promise<{ dir: string; rendered: LaunchComposition }> {
  const dir = await mkdtemp(join(tmpdir(), "open-take-launch-"));
  const base = dirname(resolve(compositionPath));
  try {
    await copyWritable(join(PKG_ROOT, "src"), join(dir, "src"));
    await mkdir(join(dir, "public", "assets"), { recursive: true });
    const nm = hostNodeModules();
    if (!nm) throw new Error("launch render: could not locate node_modules");
    await symlink(nm, join(dir, "node_modules"), "junction");
    const draftScale = Math.min(1, 960 / Math.max(comp.output.width, comp.output.height));
    const even = (value: number) => Math.max(2, Math.round(value / 2) * 2);
    const output = draft
      ? {
          width: even(comp.output.width * draftScale),
          height: even(comp.output.height * draftScale),
          fps: Math.min(30, comp.output.fps),
        }
      : comp.output;
    const rendered: LaunchComposition = structuredClone(comp);
    rendered.output = output;
    let n = 0;
    for (const scene of rendered.scenes)
      if (scene.type === "footage") {
        // Keep each scene's media span and decoder resource independent.
        // Decode only the authored span, never an hours-long source outside the film.
        const name = `footage-${n++}.webm`;
        const scale = Math.min(output.width / 1920, output.height / 1080);
        const inset = (scene.frame?.inset ?? 86) * scale;
        const width = even(output.width - inset * 2),
          height = even(output.height - inset * 2);
        const fit = scene.fit ?? "contain";
        await prepareLaunchVideo(resolve(base, scene.asset), join(dir, "public", "assets", name), {
          trimStartS: scene.trimStartS ?? 0,
          durationS: scene.durationS,
          fps: output.fps,
          frame: { width, height, fit },
        });
        scene.asset = `/assets/${name}`;
        scene.trimStartS = 0;
      }
    await prepareMotionImages(rendered, compositionPath, join(dir, "public", "assets"));
    await prepareMotionVideos(rendered, compositionPath, join(dir, "public", "assets"));
    await writeFile(
      join(dir, "src", "scene", ".launch-composition.json"),
      JSON.stringify(rendered, null, 2),
    );
    return { dir, rendered };
  } catch (error) {
    await cleanup(dir);
    throw error;
  }
}

function fadeFilter(
  track: LaunchAudioTrack,
  index: number,
  at: number,
  total: number,
  duck: [number, number][],
  loopSamples?: number,
): string {
  const trim = track.trimStartS ?? 0,
    duration = track.durationS ?? Math.max(0, total - at);
  const parts = [
    `[${index + 1}:a]aresample=48000,atrim=start=${trim}:duration=${duration}`,
    "asetpts=PTS-STARTPTS",
  ];
  if (loopSamples !== undefined)
    parts.push(
      `aloop=loop=-1:size=${loopSamples}`,
      `atrim=duration=${duration}`,
      "asetpts=PTS-STARTPTS",
    );
  let volume = String(track.gain ?? 1);
  if (track.kind === "music" && duck.length) {
    const expr = duck
      .filter(([a, b]) => b > at && a < at + duration)
      .map(([a, b]) => `between(t,${Math.max(0, a - at)},${Math.min(duration, b - at)})`)
      .join("+");
    if (expr) volume = `(${volume})*if(${expr},0.34,1)`;
  }
  parts.push(`volume='${volume}':eval=frame`);
  if ((track.fadeInS ?? 0) > 0) parts.push(`afade=t=in:st=0:d=${track.fadeInS}`);
  if ((track.fadeOutS ?? 0) > 0)
    parts.push(
      `afade=t=out:st=${Math.max(0, duration - (track.fadeOutS ?? 0))}:d=${track.fadeOutS}`,
    );
  parts.push(`adelay=${Math.round(at * 48000)}S:all=1`, `apad=whole_dur=${total}`);
  return `${parts.join(",")}[a${index}]`;
}

export async function deliverLaunchMedia(
  raw: string,
  target: string,
  comp: LaunchComposition,
  compositionPath: string,
): Promise<void> {
  const ffmpeg = await resolveFfmpeg(),
    base = dirname(resolve(compositionPath)),
    total = launchDurationS(comp),
    tracks = comp.audio ?? [];
  const rawMedia = await probeMedia(raw);
  if (!rawMedia.video) throw new Error("launch render: renderer output has no video stream");
  const frameDuration = 1 / comp.output.fps;
  // Revideo can round its final frame; a larger discrepancy means lost or extra content.
  if (Math.abs(rawMedia.videoDuration - total) > frameDuration + 0.001) {
    throw new Error(
      `launch render: renderer produced ${rawMedia.videoDuration.toFixed(6)}s of video for an authored ${total.toFixed(6)}s film; only one output frame (${frameDuration.toFixed(6)}s) of rounding is allowed. Re-render the complete composition before delivery.`,
    );
  }
  const videoFilter = `tpad=stop_mode=clone:stop_duration=${frameDuration},scale=in_color_matrix=bt601:out_color_matrix=bt709,format=yuv420p,setparams=range=tv:colorspace=bt709:color_primaries=bt709:color_trc=bt709`;
  const args = ["-y", "-loglevel", "error", "-i", raw];
  const loopSamples: (number | undefined)[] = [];
  for (const track of tracks) {
    const source = resolve(base, track.asset);
    const duration = track.durationS ?? total - launchAudioAtS(comp, track);
    args.push("-t", String((track.trimStartS ?? 0) + duration), "-i", source);
    if (track.loop) {
      const media = await probeMedia(source);
      loopSamples.push(
        Math.max(
          1,
          Math.round(Math.min(duration, media.audioDuration - (track.trimStartS ?? 0)) * 48000),
        ),
      );
    } else loopSamples.push(undefined);
  }
  if (!tracks.length) {
    args.push(
      "-vf",
      videoFilter,
      "-c:v",
      "libx264",
      "-crf",
      "18",
      "-pix_fmt",
      "yuv420p",
      "-movflags",
      "+faststart",
      "-an",
      "-t",
      String(total),
      target,
    );
    await run(ffmpeg, args);
    return;
  }
  const duck = tracks
    .filter((x) => x.kind === "narration" && x.duckMusic)
    .map((x): [number, number] => {
      const at = launchAudioAtS(comp, x);
      return [at, at + (x.durationS ?? Math.max(0, total - at))];
    });
  const filters = tracks.map((x, i) =>
    fadeFilter(x, i, launchAudioAtS(comp, x), total, duck, loopSamples[i]),
  );
  filters.push(
    `${tracks.map((_, i) => `[a${i}]`).join("")}amix=inputs=${tracks.length}:duration=longest:normalize=0,atrim=duration=${total}[mix]`,
  );
  args.push(
    "-filter_complex",
    filters.join(";"),
    "-map",
    "0:v:0",
    "-map",
    "[mix]",
    "-vf",
    videoFilter,
    "-c:v",
    "libx264",
    "-crf",
    "18",
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "aac",
    "-b:a",
    "192k",
    "-movflags",
    "+faststart",
    "-t",
    String(total),
    target,
  );
  await run(ffmpeg, args);
}

/** Stage beside the destination so failed encoding never replaces a good master. */
export async function publishLaunchMedia(
  raw: string,
  target: string,
  comp: LaunchComposition,
  compositionPath: string,
): Promise<void> {
  const stageDir = await mkdtemp(
    join(dirname(target), `.open-take-launch-${basename(target, extname(target))}-`),
  );
  try {
    const staged = join(stageDir, "delivery.mp4");
    await deliverLaunchMedia(raw, staged, comp, compositionPath);
    await rename(staged, target);
  } finally {
    await rm(stageDir, { recursive: true, force: true });
  }
}

/** Internal filesystem preflight, shared by rendering and focused regression tests. */
export function assertLaunchOutputSafe(
  comp: LaunchComposition,
  compositionPath: string,
  outPath: string,
): void {
  const out = resolve(outPath),
    base = dirname(resolve(compositionPath));
  const canonical = (path: string): string => {
    if (existsSync(path)) return realpathSync(path);
    const parent = dirname(path);
    return parent === path ? path : join(canonical(parent), basename(path));
  };
  const forbidden = [
    resolve(compositionPath),
    ...comp.scenes.filter((x) => x.type === "footage").map((x) => resolve(base, x.asset)),
    ...(comp.audio ?? []).map((x) => resolve(base, x.asset)),
    ...comp.scenes.flatMap((scene) =>
      scene.type === "motion"
        ? walkMotionLayers(scene.layers)
            .filter((layer) => layer.type === "image" || layer.type === "video")
            .map((layer) => resolve(base, layer.asset))
        : [],
    ),
  ];
  const target = canonical(out),
    outStat = existsSync(out) ? statSync(out) : undefined;
  for (const source of forbidden) {
    const sourceStat = existsSync(source) ? statSync(source) : undefined;
    if (
      canonical(source) === target ||
      (outStat && sourceStat && outStat.dev === sourceStat.dev && outStat.ino === sourceStat.ino)
    )
      throw new Error("launch render: output must not overwrite the JSON or a required asset");
  }
}

export async function renderLaunch(opts: RenderLaunchOpts): Promise<RenderLaunchResult> {
  return withRenderLock(() => renderExclusive(opts));
}
async function renderExclusive(opts: RenderLaunchOpts): Promise<RenderLaunchResult> {
  if (!opts.chromePath) throw new Error("renderLaunch: chromePath is required");
  const issues = await validateLaunchAssets(opts.composition, opts.compositionPath);
  const errors = issues.filter((x) => x.severity === "error");
  if (errors.length)
    throw new Error(
      `launch composition has ${errors.length} error(s):\n${formatLaunchIssues(errors)}`,
    );
  const out = resolve(opts.outPath);
  await mkdir(dirname(out), { recursive: true });
  assertLaunchOutputSafe(opts.composition, opts.compositionPath, out);
  await repairBundledMediaPermissions();
  const { dir, rendered } = await prepare(opts.composition, opts.compositionPath, !!opts.draft);
  const deps = depsRoot();
  const prev = process.cwd();
  try {
    process.chdir(dir);
    const produced = await renderVideo({
      projectFile: "/src/scene/launch-project.ts",
      settings: {
        outFile: "launch.mov",
        outDir: "out-render",
        workers: 1,
        projectSettings: {
          // Revideo exports both range endpoints; cap the last frame explicitly
          // instead of including its extra scene-completion frames.
          range: [
            0,
            Math.max(
              0,
              (Math.ceil(launchDurationS(rendered) * rendered.output.fps - 1e-9) - 1) /
                rendered.output.fps,
            ),
          ],
          exporter: { name: "@revideo/core/ffmpeg", options: { format: "proRes" } },
        },
        logProgress: opts.logProgress ?? false,
        progressCallback: (_w: number, p: number) => opts.onProgress?.(p),
        viteConfig: { server: { fs: { allow: [dir, ...(deps ? [deps] : [])] } } },
        puppeteer: {
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
    process.chdir(prev);
    await publishLaunchMedia(resolve(dir, produced), out, rendered, opts.compositionPath);
    return {
      mp4Path: out,
      durationS: launchDurationS(rendered),
      warnings: issues.filter((x) => x.severity === "warn"),
    };
  } finally {
    process.chdir(prev);
    await cleanup(dir);
  }
}
