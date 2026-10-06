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
// a temporary folder the page's server mounts. Workers share it. A video with
// too many frames, or whose frames take too much disk or too long to decode,
// is not: the page seeks it, as before.

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, stat, statfs } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveFfmpeg, resolveFfprobe, runTool } from "../ffmpeg";
import { fileFor, type StaticServer } from "../html/server";

/** where a video's frames are served, when each one starts (seconds on the
 *  video's own timeline, as Chrome reads it), and whether they show the
 *  video brighter than it decodes (see colours) */
export type VideoFrames = { base: string; times: number[]; ext: "jpg" | "png"; bright: boolean };

/** What one video's frames may cost before the video is sought instead: how
 *  many there are, the disk they take, and how long decoding them takes. The
 *  page waits for the decoding inside a call the renderer gives 120 s, so it
 *  stops well before that (the page's own wait, in clock.ts, is 75 s). */
export type FrameBudget = { maxFrames?: number; maxBytes?: number; maxMs?: number };
// 18,000 frames: five minutes at 60 fps
const BUDGET = { maxFrames: 18_000, maxBytes: 4e9, maxMs: 60_000 };
/** decoding stops before it leaves less than this free on the disk */
const FREE_BYTES = 2e9;

export type FrameStore = {
  /** the frames of the video the page loads from `src` (a URL on the page's
   *  own server); rejects for one it does not serve, ffmpeg cannot read, or
   *  that is over its budget */
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
          try {
            const { times, ext, bright } = await decodeFrames(file, out);
            const base = `/__open-take/frames/${k}/`;
            opts.server.mount(base, out);
            return { base, times, ext, bright };
          } catch (e) {
            // what a refused video wrote goes now, not when the render ends
            await rm(out, { recursive: true, force: true }).catch(() => {});
            throw e;
          }
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

type Stream = {
  width?: number;
  height?: number;
  pix_fmt?: string;
  color_space?: string;
  color_transfer?: string;
  color_primaries?: string;
  color_range?: string;
  nb_frames?: string;
  avg_frame_rate?: string;
  duration?: string;
  tags?: Record<string, string>;
};

/** Every frame of `file`'s first video stream, in presentation order, as
 *  `000000.jpg`… in `out` (PNG for a video with an alpha channel), and when
 *  each one starts. Rejects, stopping ffmpeg, when the video is over its
 *  budget. */
export async function decodeFrames(
  file: string,
  out: string,
  budget: FrameBudget = {},
): Promise<{ times: number[]; ext: "jpg" | "png"; bright: boolean }> {
  const { maxFrames, maxBytes, maxMs } = { ...BUDGET, ...budget };
  const deadline = Date.now() + maxMs;
  const slow = () => new Error(`its frames take longer than ${maxMs / 1000} seconds to decode`);
  /** what is left of the time to decode in, the probe's included */
  const left = () => {
    const ms = deadline - Date.now();
    if (ms <= 0) throw slow();
    return ms;
  };
  const ffprobe = await resolveFfprobe();
  const probe = JSON.parse(
    await runTool(
      ffprobe,
      [
        "-v",
        "error",
        "-select_streams",
        "v:0",
        "-show_streams",
        "-show_format",
        "-of",
        "json",
        file,
      ],
      { timeoutMs: left() },
    ).catch((e: Error) => {
      throw Date.now() >= deadline ? slow() : e;
    }),
  ) as { streams?: Stream[]; format?: { start_time?: string; duration?: string } };
  const s = probe.streams?.[0];
  if (!s) throw new Error(`ffmpeg found no picture in ${file}`);
  // a WebM's alpha travels beside the picture, and ffmpeg's own decoder drops
  // it: such a video is shown by seeking it, transparent as the page made it
  if (Object.entries(s.tags ?? {}).some(([k, v]) => k.toLowerCase() === "alpha_mode" && v === "1"))
    throw new Error("its alpha channel would be lost as frames");
  const [rn, rd] = (s.avg_frame_rate ?? "").split("/").map(Number);
  const count =
    Number(s.nb_frames) ||
    Math.round(Number(s.duration ?? probe.format?.duration) * (rd ? rn! / rd : 0));
  if (count > maxFrames)
    throw new Error(`it has ${count} frames, more than ${maxFrames} to decode`);
  const alpha = /^(yuva|rgba|argb|abgr|bgra|gbrap|ya)/.test(s.pix_fmt ?? "");
  const ext = alpha ? "png" : "jpg";
  const { vf, bright } = colours(s, alpha);
  // Chrome keeps a picture that starts late where it starts; one that starts
  // before 0 it moves to 0 (ffmpeg's -copyts keeps them as they are)
  const start = Number(probe.format?.start_time);
  const shift = start < 0 ? -start : 0;

  const frame = (i: number) => join(out, `${String(i).padStart(6, "0")}.${ext}`);
  const ffmpeg = await resolveFfmpeg();
  left();
  return new Promise((ok, fail) => {
    const p = spawn(
      ffmpeg,
      [
        "-hide_banner",
        "-nostdin",
        "-nostats",
        "-copyts",
        "-i",
        file,
        "-map",
        "0:v:0",
        "-an",
        "-sn",
        "-dn",
        "-fps_mode",
        "passthrough",
        // each frame's own timestamp is read first (showinfo, in the stream's
        // time base); the files are numbered, so the encoder gets 1 ms apart
        // instead: its default time base (one over the average rate) would
        // give two close frames of a varying rate the same, and refuse them
        "-enc_time_base",
        "1:1000",
        "-vf",
        `showinfo=checksum=0,settb=1/1000,setpts=N,${vf}`,
        ...(alpha ? [] : ["-q:v", "2"]),
        "-start_number",
        "0",
        join(out, `%06d.${ext}`),
      ],
      { stdio: ["ignore", "ignore", "pipe"] },
    );
    let refused: Error | null = null;
    const stop = (e: Error) => {
      refused ??= e;
      p.kill("SIGKILL");
    };
    const timer = setTimeout(() => stop(slow()), deadline - Date.now());

    // showinfo's lines as they come: the time base, then each frame's pts
    let base: [number, number] | null = null;
    const pts: number[] = [];
    const seconds: number[] = [];
    const said: string[] = [];
    let rest = "";
    p.stderr.on("data", (d: Buffer) => {
      const lines = (rest + d.toString()).split("\n");
      rest = lines.pop()!;
      for (const l of lines) {
        if (!l.includes("Parsed_showinfo")) {
          said.push(l);
          if (said.length > 3) said.shift();
          continue;
        }
        const tb = /config in time_base:\s*(\d+)\/(\d+)/.exec(l);
        if (tb) base ??= [Number(tb[1]), Number(tb[2])];
        const f = /\bn:\s*\d+\s+pts:\s*(-?\d+)\s+pts_time:\s*(\S+)/.exec(l);
        if (!f) continue;
        pts.push(Number(f[1]));
        seconds.push(Number(f[2]));
        if (pts.length > maxFrames)
          stop(new Error(`it has more than ${maxFrames} frames to decode`));
      }
    });

    // the disk the frames take, counted as they are written: a frame is
    // whole once the next one is begun
    let bytes = 0;
    let counted = 0;
    const tally = async (all: boolean) => {
      while (existsSync(frame(all ? counted : counted + 1))) {
        bytes += (await stat(frame(counted))).size;
        counted++;
      }
    };
    const tooBig = () => new Error(`its frames would take more than ${size(maxBytes)} of disk`);
    let looking = false;
    const watch = setInterval(async () => {
      if (looking) return;
      looking = true;
      try {
        await tally(false);
        if (bytes > maxBytes) return stop(tooBig());
        const disk = await statfs(out);
        if (disk.bavail * disk.bsize < FREE_BYTES)
          stop(new Error(`its frames would leave less than ${size(FREE_BYTES)} of disk free`));
      } catch {
        // a frame removed under it: the render is over
      } finally {
        looking = false;
      }
    }, 250);

    p.on("error", (e) => {
      clearTimeout(timer);
      clearInterval(watch);
      fail(e);
    });
    p.on("close", (code) => {
      clearTimeout(timer);
      clearInterval(watch);
      (async () => {
        if (refused) throw refused;
        if (code !== 0) throw new Error(`ffmpeg failed (${code}): ${said.join(" ").trim()}`);
        await tally(true);
        if (bytes > maxBytes) throw tooBig();
        if (!pts.length) throw new Error(`ffmpeg found no frames in ${file}`);
        // exact, from the integer timestamps: a 29.97 fps frame starts at
        // 1001/30000 s, which pts_time rounds to 0.0333667
        const times = base
          ? pts.map((t) => (t * base![0]) / base![1] + shift)
          : seconds.map((t) => t + shift);
        if (times.some((t) => !Number.isFinite(t)))
          throw new Error("its frames have no timestamps");
        return { times, ext, bright } as const;
      })().then(ok, fail);
    });
  });
}

const size = (n: number) =>
  n >= 1e9
    ? `${(n / 1e9).toFixed(1)} GB`
    : n >= 1e6
      ? `${Math.round(n / 1e6)} MB`
      : `${Math.ceil(n / 1e3)} KB`;

/** a stream's colour matrix, as swscale names it */
const MATRIX: Record<string, string> = {
  bt709: "bt709",
  smpte170m: "bt601",
  bt470bg: "bt601",
  fcc: "fcc",
  smpte240m: "smpte240m",
  bt2020nc: "bt2020",
  bt2020c: "bt2020",
};
/** the primaries of a picture Chrome shows as it decodes: BT.709's and
 *  BT.601's, or none named. Others (Display P3, DCI-P3, BT.2020, film…) it
 *  maps to the screen itself */
const SHOWN_AS_DECODED = new Set([
  "",
  "unknown",
  "unspecified",
  "reserved",
  "bt709",
  "bt470bg",
  "smpte170m",
  "smpte240m",
]);
/** the curves Chrome on macOS shows through Apple's gamma: BT.709's */
const APPLE_CURVES = new Set(["bt709", "smpte170m", "bt2020-10", "bt2020-12"]);
/** a channel of such a video as Chrome on macOS shows it: through Apple's
 *  gamma (1.961) to light, then the sRGB curve back (clock.ts undoes it) */
const LIGHT = "pow(val/maxval,1.961)";
const APPLE = `if(lte(${LIGHT},0.0031308),12.92*${LIGHT},1.055*pow(val/maxval,1.961/2.4)-0.055)*maxval`;

/** The filters that write a frame as Chrome shows the video; a JPEG decodes
 *  as BT.601 full range, so that is what the frames are written in. Chrome
 *  decodes a picture with the matrix its tags name, BT.709 when they name
 *  none. On macOS (measured on Chrome for Testing: H.264, HEVC, VP9, AV1) it
 *  shows a picture with BT.709's curve, or none named, brighter — through
 *  Apple's gamma onto the sRGB screen — except a recording's: BT.601 named
 *  with no curve, as ffmpeg tags a video of JPEG screenshots, which it shows
 *  as it decodes, taking the matrix for BT.709 from 720 high. Below that
 *  size, and up to 640×480 for a picture that names nothing (which it takes
 *  for BT.601), it also moves the colours from SMPTE-C primaries, by up to 5
 *  of 255: left out. Elsewhere Chrome takes BT.709's curve for sRGB's: the
 *  picture as it decodes. HDR and wide gamut — any primaries but BT.709's
 *  and BT.601's — Chrome maps itself: such a video is sought. */
function colours(s: Stream, alpha: boolean): { vf: string; bright: boolean } {
  const curve = s.color_transfer ?? "";
  if (curve === "smpte2084" || curve === "arib-std-b67")
    throw new Error("its colours are HDR, which Chrome maps itself");
  if (!SHOWN_AS_DECODED.has(s.color_primaries ?? ""))
    throw new Error(`its colours are in ${s.color_primaries} primaries, which Chrome maps itself`);
  const named = !!curve && !["unknown", "unspecified", "reserved"].includes(curve);
  const rgb = /^(a?rgb|a?bgr|gbr|0rgb|0bgr|x2|gray|ya|pal)/.test(s.pix_fmt ?? "");
  let matrix = MATRIX[s.color_space ?? ""] ?? "bt709";
  let bright = false;
  if (process.platform === "darwin" && !rgb) {
    const [w, h] = [s.width ?? 0, s.height ?? 0];
    if (named) bright = APPLE_CURVES.has(curve);
    else if (s.color_space === "bt470bg") matrix = h >= 720 ? "bt709" : "bt601";
    else {
      bright = true;
      if (!MATRIX[s.color_space ?? ""] && w <= 640 && h <= 480) matrix = "bt601";
    }
  }
  const range = s.color_range === "pc" || s.pix_fmt?.startsWith("yuvj") ? "pc" : "tv";
  // square pixels, as the page draws the video: its frame image has the
  // video's own width and height
  const square = "scale=w=iw*sar:h=ih";
  // already what a JPEG decodes to (a recording, on most machines): as it is
  if (!alpha && !bright && matrix === "bt601" && range === "pc")
    return {
      vf: s.pix_fmt?.startsWith("yuvj")
        ? `${square},setsar=1`
        : `${square}:in_range=pc:out_range=pc,setsar=1,format=yuvj420p`,
      bright,
    };
  // through RGB, which every ffmpeg converts to and from with the matrix asked
  const filters = [
    `${square}:in_color_matrix=${matrix}:in_range=${range}`,
    "setsar=1",
    `format=${alpha ? "rgba" : "rgb24"}`,
  ];
  if (bright) filters.push(`lutrgb=r='${APPLE}':g='${APPLE}':b='${APPLE}'`);
  if (!alpha) filters.push("scale=out_color_matrix=bt601:out_range=pc", "format=yuvj420p");
  return { vf: filters.join(","), bright };
}
