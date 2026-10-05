// A video's frames, decoded once per render and served as images.
//
// The film clock shows a film-timed <video> as its frame at film time — the
// frame's image as the element's CSS `content` — instead of seeking the
// element: a video element composited under a slow push shimmers (its text
// moved 1.49 px from frame to frame at the 90th percentile, 0.15 px as
// images), and seeking it for every frame and for every motion probe was most
// of a recorded film's render (70 s against 8.4 s for 4 s of film).
//
// Each video the page serves is decoded once, every frame in presentation
// order with its own timestamp (a screen recording's frame rate varies), into
// a temporary folder the page's server mounts. Workers share it.

import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveFfmpeg } from "../ffmpeg";
import { fileFor, type StaticServer } from "../html/server";

/** where a video's frames are served, and when each one starts (seconds from
 *  its first frame) */
export type VideoFrames = { base: string; times: number[]; ext: "jpg" | "png" };

export type FrameStore = {
  /** the frames of the video the page loads from `src` (a URL on the page's
   *  own server); rejects for one it does not serve or ffmpeg cannot read */
  frames(src: string): Promise<VideoFrames>;
  /** remove every folder of frames */
  clean(): Promise<void>;
};

export function frameStore(opts: { root: string; server: StaticServer }): FrameStore {
  let work: Promise<string> | null = null;
  const made = new Map<string, Promise<VideoFrames>>();
  return {
    frames(src) {
      let url: URL;
      try {
        url = new URL(src);
      } catch {
        return Promise.reject(new Error(`not a URL: ${src}`));
      }
      if (url.origin !== new URL(opts.server.url).origin)
        return Promise.reject(new Error(`not served by the film's server: ${src}`));
      const file = fileFor(opts.root, url.pathname);
      if (!file) return Promise.reject(new Error(`not a file the film serves: ${src}`));
      let p = made.get(file);
      if (!p) {
        const k = made.size;
        p = (async () => {
          work ??= mkdtemp(join(tmpdir(), "open-take-frames-"));
          const out = join(await work, String(k));
          await mkdir(out);
          const { times, ext } = await decodeFrames(file, out);
          const base = `/__open-take/frames/${k}/`;
          opts.server.mount(base, out);
          return { base, times, ext };
        })();
        made.set(file, p);
      }
      return p;
    },
    async clean() {
      if (work) await rm(await work, { recursive: true, force: true }).catch(() => {});
    },
  };
}

/** Every frame of `file`'s first video stream, in presentation order, as
 *  `000000.jpg`… in `out` (PNG for a video with an alpha channel), and when
 *  each one starts. */
export async function decodeFrames(
  file: string,
  out: string,
): Promise<{ times: number[]; ext: "jpg" | "png" }> {
  const ffmpeg = await resolveFfmpeg();
  const described = await describeInput(ffmpeg, file);
  // a WebM's alpha travels beside the picture, and ffmpeg's own decoder drops
  // it: such a video is shown by seeking it, transparent as the page made it
  if (/alpha_mode\s*:\s*1/.test(described))
    throw new Error("its alpha channel would be lost as frames");
  const pixels = /Video: [^,\n]+, ([a-z0-9]+)/.exec(described)?.[1] ?? "";
  const alpha = /^(yuva|rgba|argb|abgr|bgra|gbrap|ya)/.test(pixels);
  const ext = alpha ? "png" : "jpg";
  const stderr = await run(ffmpeg, [
    "-hide_banner",
    "-nostdin",
    "-i",
    file,
    "-map",
    "0:v:0",
    "-an",
    "-sn",
    "-dn",
    "-fps_mode",
    "passthrough",
    "-vf",
    // square pixels, as the page draws the video: its frame image has the
    // video's own width and height
    "scale=iw*sar:ih,setsar=1,showinfo",
    ...(alpha ? [] : ["-q:v", "2"]),
    "-start_number",
    "0",
    join(out, `%06d.${ext}`),
  ]);
  const pts: number[] = [];
  for (const m of stderr.matchAll(/Parsed_showinfo[^\n]*?\bpts_time:\s*(-?[\d.]+)/g))
    pts.push(Number(m[1]));
  if (!pts.length) throw new Error(`ffmpeg found no frames in ${file}`);
  const first = pts[0]!;
  return { times: pts.map((t) => Math.max(0, t - first)), ext };
}

/** ffmpeg's description of the input: its streams, pixel formats, tags */
function describeInput(ffmpeg: string, file: string): Promise<string> {
  return run(ffmpeg, ["-hide_banner", "-nostdin", "-i", file], true);
}

/** run ffmpeg, resolving with what it wrote to stderr; `probe` accepts the
 *  exit status of an input-only call, which ffmpeg ends with an error */
function run(bin: string, args: string[], probe = false): Promise<string> {
  return new Promise((ok, fail) => {
    const p = spawn(bin, args, { stdio: ["ignore", "ignore", "pipe"] });
    let err = "";
    p.stderr.on("data", (d: Buffer) => {
      err += d.toString();
    });
    p.on("error", fail);
    p.on("close", (code) => {
      if (code === 0 || probe) ok(err);
      else
        fail(new Error(`ffmpeg failed (${code}): ${err.trim().split("\n").slice(-3).join(" ")}`));
    });
  });
}
