// The HTML renderer, Node side: stage a page for a launch film (engine,
// composition, images, footage frames), render it in Chrome sample by sample
// along the shutter schedule, average each frame's samples, and hand the film
// to the same delivery encode (sound, colour, container) as the 2D renderer.
//
// Used for films made only of motion scenes — the modern authoring path, and
// the only one that can carry 3D. OPEN_TAKE_LAUNCH_RENDERER=revideo forces the
// 2D renderer for comparison.

import { spawn } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveFfmpeg } from "../ffmpeg";
import { launchDurationS, shutterClock } from "../launch-evaluate";
import type { LaunchComposition } from "../launch-types";
import { walkMotionLayers } from "../motion-evaluate";
import { shutterSchedule } from "../motion-speed";
import type { MotionVideoLayer } from "../motion-types";
import { accumulateShutter } from "../shutter";
import { readStateIndex } from "../state-index";
import { type HtmlMedia, mediaKey } from "./media";
import { renderHtmlFrames } from "./render";
import { serveDirectory } from "./server";

/** This package's root (package.json, dist-browser/): the nearest directory
 *  up from this module holding a package.json — src/html/ in a checkout,
 *  dist/ in a build or an npm install, where the path depth differs. */
export const PKG_ROOT = (() => {
  let dir = dirname(fileURLToPath(import.meta.url));
  while (!existsSync(join(dir, "package.json"))) {
    const up = dirname(dir);
    if (up === dir) return resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
    dir = up;
  }
  return dir;
})();

/** A film the HTML renderer can draw: motion scenes only. */
export function htmlRenderable(comp: LaunchComposition): boolean {
  return (
    process.env.OPEN_TAKE_LAUNCH_RENDERER !== "revideo" &&
    comp.scenes.length > 0 &&
    comp.scenes.every((s) => s.type === "motion")
  );
}

/** The browser bundle of the page engine (tsdown → dist-browser/). In a
 *  source checkout it is rebuilt when any file it bundles is newer. */
async function engineBundle(): Promise<string> {
  const bundle = join(PKG_ROOT, "dist-browser", "html-engine.js");
  const sources = [
    "html/engine.ts",
    "html/media.ts",
    "motion-evaluate.ts",
    "launch-evaluate.ts",
  ].map((f) => join(PKG_ROOT, "src", f));
  const stale =
    !existsSync(bundle) ||
    sources.some((f) => existsSync(f) && statSync(f).mtimeMs > statSync(bundle).mtimeMs);
  const tsdown = join(PKG_ROOT, "node_modules", ".bin", "tsdown");
  if (stale && existsSync(tsdown)) await run(tsdown, [], PKG_ROOT);
  if (!existsSync(bundle))
    throw new Error(
      "launch render: the HTML renderer's page engine is missing (dist-browser/html-engine.js); rebuild @open-take/compositor",
    );
  return bundle;
}

function run(bin: string, args: string[], cwd?: string): Promise<void> {
  return new Promise((ok, fail) => {
    const child = spawn(bin, args, { cwd, stdio: ["ignore", "ignore", "pipe"] });
    let err = "";
    child.stderr.on("data", (d) => {
      err += d;
    });
    child.on("error", fail);
    child.on("close", (code) =>
      code === 0 ? ok() : fail(new Error(`${bin} exited ${code}: ${err.slice(-1500)}`)),
    );
  });
}

/** Every recorded clip a motion layer shows, extracted at the film's rate:
 *  one JPEG per output frame of the clip's span. Clips shown by several layers
 *  (a detail inset of the same take) are extracted once. */
async function extractFootage(
  comp: LaunchComposition,
  base: string,
  dir: string,
): Promise<HtmlMedia> {
  const ffmpeg = await resolveFfmpeg();
  const fps = comp.output.fps;
  const media: HtmlMedia = { videos: {} };
  // one extraction per distinct clip span, shared by every layer showing it
  const clips = new Map<
    string,
    { layers: string[]; source: string; trim: number; durationS: number }
  >();
  for (const scene of comp.scenes) {
    if (scene.type !== "motion") continue;
    for (const layer of walkMotionLayers(scene.layers)) {
      if (layer.type !== "video") continue;
      const v = layer as MotionVideoLayer;
      const source = resolve(base, v.asset);
      const key = JSON.stringify([source, v.trimStartS ?? 0, v.durationS]);
      const clip = clips.get(key) ?? {
        layers: [],
        source,
        trim: v.trimStartS ?? 0,
        durationS: v.durationS,
      };
      clip.layers.push(mediaKey(scene.id, v.id));
      clips.set(key, clip);
    }
  }
  // a few clips at a time: each ffmpeg decodes on its own threads too
  const queue = [...clips.values()].map((clip, n) => ({ clip, name: `clip-${n}` }));
  const extract = async ({ clip, name }: (typeof queue)[number]) => {
    const out = join(dir, "frames", name);
    await mkdir(out, { recursive: true });
    await run(ffmpeg, [
      "-v",
      "error",
      "-ss",
      String(clip.trim),
      "-i",
      clip.source,
      "-t",
      String(clip.durationS + 1 / fps),
      "-vf",
      `fps=${fps}`,
      "-q:v",
      "2",
      join(out, "%06d.jpg"),
    ]);
    const count = (await readdir(out)).filter((f) => f.endsWith(".jpg")).length;
    if (count === 0) throw new Error(`launch render: no frames from ${clip.source}`);
    for (const id of clip.layers) media.videos[id] = { base: `/frames/${name}/`, count, fps };
  };
  const workers = Array.from({ length: Math.min(4, queue.length) }, async () => {
    for (let next = queue.shift(); next; next = queue.shift()) await extract(next);
  });
  await Promise.all(workers);
  return media;
}

/** The saved screens the film's state layers show. Each folder of states
 *  (`<take>.take/states/`, whose pages share its assets/) is served as it is
 *  under /states/<n>/ — mounted, not copied. */
function stageStates(
  comp: LaunchComposition,
  base: string,
): { states: NonNullable<HtmlMedia["states"]>; mounts: Record<string, string> } {
  const states: NonNullable<HtmlMedia["states"]> = {};
  const roots = new Map<string, string>();
  for (const scene of comp.scenes) {
    if (scene.type !== "motion") continue;
    for (const layer of walkMotionLayers(scene.layers)) {
      if (layer.type !== "state") continue;
      const folder = resolve(base, layer.state);
      const index = readStateIndex(folder);
      if (typeof index === "string") throw new Error(`launch render: ${index}`);
      const root = dirname(folder);
      if (!roots.has(root)) roots.set(root, `/states/${roots.size}`);
      const prefix = roots.get(root)!;
      states[mediaKey(scene.id, layer.id)] = {
        url: `${prefix}/${encodeURIComponent(basename(folder))}/state.html`,
        width: index.viewport.w,
        height: index.viewport.h,
      };
    }
  }
  return { states, mounts: Object.fromEntries([...roots].map(([root, p]) => [p, root])) };
}

export type HtmlRenderResult = {
  raw: string;
  dir: string;
  stats: { frames: number; renders: number; wallMs: number };
};

/** Render a prepared composition (images staged, output resolved) to an
 *  averaged ProRes film at the output rate, ready for delivery. The caller
 *  removes `dir`. */
export async function renderHtmlFilm(opts: {
  rendered: LaunchComposition;
  compositionPath: string;
  chromePath: string;
  dir: string;
  onProgress?: (p: number) => void;
}): Promise<HtmlRenderResult> {
  const { rendered, dir } = opts;
  const base = dirname(resolve(opts.compositionPath));
  const t0 = performance.now();
  const phase = (name: string, since: number) => {
    if (process.env.OPEN_TAKE_HTML_TIMINGS)
      process.stderr.write(
        `html render: ${name} ${((performance.now() - since) / 1000).toFixed(1)}s\n`,
      );
    return performance.now();
  };
  let mark = t0;
  const media = await extractFootage(rendered, base, dir);
  mark = phase("footage", mark);
  const { states, mounts } = stageStates(rendered, base);
  media.states = states;
  await copyFile(await engineBundle(), join(dir, "engine.js"));
  await writeFile(join(dir, "film.json"), JSON.stringify(rendered));
  await writeFile(join(dir, "media.json"), JSON.stringify(media));
  await writeFile(
    join(dir, "index.html"),
    '<!doctype html><html><head><meta charset="utf-8"></head><body><script type="module" src="./engine.js"></script></body></html>',
  );

  const { fps, width, height } = rendered.output;
  const frames = Math.ceil(launchDurationS(rendered) * fps - 1e-9);
  const blur = rendered.output.motionBlur || undefined;
  const schedule = blur ? shutterSchedule(rendered, blur) : new Array<number>(frames).fill(1);
  const clock = shutterClock(schedule, fps, blur?.shutter ?? 0.5, frames);
  const times = Array.from({ length: clock.renderFrames }, (_, j) => clock.at(j));

  const shots = join(dir, "shots");
  await mkdir(shots, { recursive: true });
  const server = await serveDirectory(dir, mounts);
  try {
    await renderHtmlFrames({
      url: `${server.url}/index.html`,
      chromePath: opts.chromePath,
      width,
      height,
      times,
      outDir: shots,
      // JPEG-95: 1.3–2.5× faster to capture than PNG at 1080p (measured), and
      // invisible after averaging and the delivery encode
      format: "jpeg",
      quality: 95,
      onProgress: (done, total) => opts.onProgress?.(done / total),
    });
  } finally {
    await server.close();
  }
  mark = phase(`frames (${clock.renderFrames} renders for ${frames} frames)`, mark);
  const raw = join(dir, "shutter.mov");
  await accumulateShutter(
    ["-framerate", String(fps * 4), "-i", join(shots, "%07d.jpg")],
    raw,
    schedule,
    rendered.output,
    { fullRange: true },
  );
  phase("shutter", mark);
  await rm(shots, { recursive: true, force: true });
  return {
    raw,
    dir,
    stats: { frames, renders: clock.renderFrames, wallMs: performance.now() - t0 },
  };
}

/** A fresh staging directory for an HTML render. */
export async function htmlStagingDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "open-take-launch-html-"));
}
