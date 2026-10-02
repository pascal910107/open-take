// `open-take film render`: any web page → a master MP4.
//
// The film is the author's own page — open-take decides nothing about how it
// looks or sounds. This file only performs it: serves the page, drives the film
// clock (clock.ts) in W headless Chromes, and turns what they draw into a
// 1080p60 H.264 master with the page's own soundtrack.
//
// Motion blur is measured, not guessed: before rendering, every frame's shutter
// (180°, centred on the frame time) is probed for how far anything visible
// travels across it, and the frame gets one sample per SPACING_PX of that
// travel (1 when nothing moves, at most MAX_SAMPLES). The samples are averaged
// in linear light and dithered back to 8 bits, so a moving edge becomes a
// smear rather than a strobe and a still frame passes through untouched.
//
// Pipeline per worker: seek → JPEG screenshot → (MJPEG in Matroska) ffmpeg
// decoder → raw RGB → shutter average → ffmpeg x264 chunk. The chunks are
// joined without re-encoding and the soundtrack is muxed on.

import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { cpus, tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { resolveFfmpeg, runTool } from "../ffmpeg";
import { type HtmlBrowser, launchHtmlBrowser } from "../html/cdp";
import { serveDirectory } from "../html/server";
import { jpegDimensions, matroskaCluster, matroskaHead } from "../mjpeg-matroska";
import { type FilmPageInfo, filmClockSource } from "./clock";

/** the shutter is open for this fraction of the frame interval (180°) */
const SHUTTER_FRACTION = 0.5;
/** one blur sample per this many px an edge travels while the shutter is open */
const SPACING_PX = 3;
const MAX_SAMPLES = 16;
const DEFAULT_SIZE = { width: 1920, height: 1080 } as const;
/** frames per re-renderable piece (3 s at 60 fps) */
const PIECE_FRAMES = 180;
/** a piece is tried again this many times after Chrome dies or hangs */
const PIECE_RETRIES = 2;

/** Chrome died, hung or lost its socket — worth a fresh Chrome. An error the
 *  film itself threw is not: it would throw again. */
const browserTrouble = (e: Error): boolean =>
  !/page error:|page threw:|film clock: cannot go back|asked for files that are not there/.test(
    e.message,
  );

export type FilmProgress = { phase: "probe" | "render"; done: number; total: number };

export type FilmRenderOptions = {
  /** the film: an .html file, or a directory holding index.html */
  page: string;
  /** the MP4 to write */
  out: string;
  chromePath: string;
  /** the directory served to the page (its URLs resolve inside it); default:
   *  the working directory when the page is inside it, else the page's folder */
  root?: string;
  /** CSS px the page lays out at; default the page's __film, else 1920×1080 */
  width?: number;
  height?: number;
  fps?: number;
  /** seconds; default the page's __film.duration (or __duration) */
  duration?: number;
  /** render only [from, to) seconds */
  from?: number;
  to?: number;
  /** a soundtrack file; null for none; default the page's __film.audio */
  audio?: string | null;
  /** measured motion blur; default on (off in drafts) */
  blur?: boolean;
  /** half size, 30 fps, no blur, fast encode — for looking, not for delivery */
  draft?: boolean;
  /** draw every frame at this many times the pixels each way and scale it down
   *  to the film's size. Chrome puts each glyph on a whole device pixel, so text
   *  in a slow zoom or drift steps instead of gliding; finer pixels make the
   *  steps finer. 1 (the default) draws at the film's size; ignored in drafts. */
  supersample?: number;
  workers?: number;
  onProgress?: (p: FilmProgress) => void;
  onConsole?: (level: string, text: string) => void;
};

export type FilmRenderResult = {
  out: string;
  mode: FilmPageInfo["mode"];
  /** output pixel size */
  width: number;
  height: number;
  fps: number;
  frames: number;
  /** screenshots taken (a blurred frame takes several) */
  samples: number;
  durationS: number;
  wallMs: number;
  warnings: string[];
};

type Film = {
  width: number;
  height: number;
  fps: number;
  scale: number;
  f0: number;
  f1: number;
  audio: string | null;
  blur: boolean;
  warnings: string[];
};

const inside = (file: string, dir: string) => {
  const r = relative(dir, file);
  return r !== "" && !r.startsWith("..") && !isAbsolute(r);
};

/** the page file, the directory served, and the page's path in it */
function resolveFilmPage(
  page: string,
  root?: string,
): { root: string; pageFile: string; urlPath: string } {
  let file = resolve(page);
  if (existsSync(file) && statSync(file).isDirectory()) file = join(file, "index.html");
  if (!existsSync(file)) throw new Error(`film: no page at ${file}`);
  const cwd = process.cwd();
  const base = root ? resolve(root) : inside(file, cwd) ? cwd : dirname(file);
  if (!inside(file, base)) throw new Error(`film: the page ${file} is not inside --root ${base}`);
  const urlPath = `/${relative(base, file).split(sep).map(encodeURIComponent).join("/")}`;
  return { root: base, pageFile: file, urlPath };
}

const missingError = (missing: Set<string>, root: string) =>
  new Error(
    `film: the page asked for files that are not there (served from ${root}):\n` +
      [...missing].map((p) => `  ${p}`).join("\n") +
      "\n(a page that reaches outside its own folder needs --root <the folder that holds it all>)",
  );

export const samplesFor = (px: number): number =>
  Math.max(1, Math.min(MAX_SAMPLES, Math.ceil(px / SPACING_PX)));

/** the sample instants (s) of one output frame: n points spread evenly over
 *  the shutter, centred on the frame time — or over one side of it when the
 *  picture cuts in the other (side -1: before the frame time, 1: after); never
 *  before the film starts */
export function sampleTimes(t: number, n: number, fps: number, side = 0): number[] {
  if (n <= 1) return [t];
  const open = SHUTTER_FRACTION / fps;
  const [lo, hi] = side < 0 ? [-0.5, 0] : side > 0 ? [0, 0.5] : [-0.5, 0.5];
  return Array.from({ length: n }, (_, k) =>
    Math.max(0, t + open * (lo + (hi - lo) * ((k + 0.5) / n))),
  );
}

/** frames [0, costs.length) cut into at most `workers` contiguous slices of
 *  about equal total cost */
export function balancedSlices(costs: readonly number[], workers: number): [number, number][] {
  const total = costs.reduce((a, b) => a + b, 0);
  const slices: [number, number][] = [];
  let start = 0;
  let acc = 0;
  for (let i = 0; i < costs.length; i++) {
    acc += costs[i]!;
    const target = (total * (slices.length + 1)) / workers;
    if (acc >= target && slices.length < workers - 1 && i + 1 < costs.length) {
      slices.push([start, i + 1]);
      start = i + 1;
    }
  }
  if (start < costs.length) slices.push([start, costs.length]);
  return slices;
}

export async function renderFilm(opts: FilmRenderOptions): Promise<FilmRenderResult> {
  const t0 = Date.now();
  const draft = !!opts.draft;
  const scale = draft ? 0.5 : 1;
  // every browser that draws frames draws at the same density
  const ss = draft ? 1 : supersampleOf(opts.supersample);
  const page = await servePage(opts, scale * ss);
  const tmp = await mkdtemp(join(tmpdir(), "open-take-film-"));
  try {
    // --- what the page is -----------------------------------------------------
    const { browser: first, info, width, height } = await page.openDeclared(opts);
    page.checkFiles();
    const film = describe(opts, info, { pageFile: page.pageFile, width, height, scale, draft });
    const frames = film.f1 - film.f0;
    const workers = Math.max(1, Math.min(opts.workers ?? defaultWorkers(), frames));

    // --- probe: how many shutter samples each frame needs, and where --------
    let samples = new Array<number>(frames).fill(1);
    let sides = new Array<number>(frames).fill(0);
    let pool: HtmlBrowser[] = [first];
    if (film.blur) {
      // a clock film keeps its own state, so only a render film probes in parallel
      if (info.mode === "render")
        while (pool.length < workers) {
          const b = await page.open(width, height);
          await prepare(b);
          pool.push(b);
        }
      ({ samples, sides } = await probe(pool, film, opts.onProgress));
    }

    // --- render ------------------------------------------------------------------
    if (info.mode === "clock") {
      // a clock film keeps its own state: every worker starts from a fresh page
      for (const b of pool) await page.close(b);
      pool = [];
    }
    // a frame costs its samples plus its own seek and encode — counted, as
    // an estimate, as 0.4 of a screenshot
    const slices = balancedSlices(
      samples.map((n) => n + 0.4),
      workers,
    );
    const ffmpeg = await resolveFfmpeg();
    // each worker renders its slice in pieces of a few seconds, one encoded
    // chunk per piece: when Chrome dies or hangs (memory pressure on a laptop
    // did it), only that piece is rendered again, on a fresh Chrome
    const pieces = slices.map(([a, b]) => {
      const out: [number, number][] = [];
      for (let p = a; p < b; p += PIECE_FRAMES) out.push([p, Math.min(b, p + PIECE_FRAMES)]);
      return out;
    });
    const chunks: string[] = [];
    const chunkOf = pieces.map((ps) =>
      ps.map(() => {
        const file = join(tmp, `chunk-${String(chunks.length).padStart(4, "0")}.mp4`);
        chunks.push(file);
        return file;
      }),
    );
    let done = 0;
    let failed: Error | null = null;
    await Promise.all(
      pieces.map(async (ps, w) => {
        let browser: HtmlBrowser | undefined = pool[w];
        try {
          for (let k = 0; k < ps.length; k++) {
            const [a, b] = ps[k]!;
            for (let attempt = 0; ; attempt++) {
              let piece = 0;
              try {
                if (!browser) {
                  browser = await page.open(width, height);
                  await prepare(browser);
                }
                const sink = new ShutterSink(
                  ffmpeg,
                  samples.slice(a, b),
                  encodeArgs(film, chunkOf[w]![k]!, draft),
                  outSize(film),
                );
                try {
                  for (let i = a; i < b; i++) {
                    if (failed) throw failed;
                    page.checkFiles();
                    const t = (film.f0 + i) / film.fps;
                    for (const ti of sampleTimes(t, samples[i]!, film.fps, sides[i])) {
                      await seek(browser, ti, `frame ${film.f0 + i}`);
                      await sink.push(
                        await browser.screenshot({ format: "jpeg", quality: draft ? 85 : 100 }),
                      );
                    }
                    piece++;
                    done++;
                    opts.onProgress?.({ phase: "render", done, total: frames });
                  }
                  await sink.end();
                } catch (e) {
                  sink.kill();
                  throw e;
                }
                break;
              } catch (e) {
                const err = e as Error;
                if (failed || attempt >= PIECE_RETRIES || !browserTrouble(err)) throw err;
                film.warnings.push(
                  `Chrome failed at frame ${film.f0 + a + piece} (${err.message.split("\n")[0]}) — ` +
                    `frames ${film.f0 + a}–${film.f0 + b - 1} rendered again on a fresh one`,
                );
                done -= piece;
                if (browser) await page.close(browser);
                browser = undefined;
              }
            }
          }
        } catch (e) {
          failed ??= e as Error;
          throw e;
        }
      }),
    ).catch((e) => {
      throw failed ?? e;
    });
    await page.closeAll();
    page.checkFiles();
    await deliver(ffmpeg, chunks, film, opts.out, tmp);
    const { width: w, height: h } = outSize(film);
    return {
      out: resolve(opts.out),
      mode: info.mode,
      // as encoded: an odd side is padded to even
      width: w + (w % 2),
      height: h + (h % 2),
      fps: film.fps,
      frames,
      samples: samples.reduce((x, y) => x + y, 0),
      durationS: frames / film.fps,
      wallMs: Date.now() - t0,
      warnings: film.warnings,
    };
  } finally {
    await page.shut();
    await rm(tmp, { recursive: true, force: true });
  }
}

export type FilmStillsOptions = {
  page: string;
  chromePath: string;
  /** seconds */
  at: readonly number[];
  outDir: string;
  root?: string;
  width?: number;
  height?: number;
  /** with the shutter's motion blur, as in the master (default on) */
  blur?: boolean;
  /** as the master is rendered (see FilmRenderOptions.supersample) */
  supersample?: number;
  onConsole?: (level: string, text: string) => void;
};

/** PNG stills of the film at the given times — `t012.500.png` … — as the
 *  master would show them. */
export async function filmStills(opts: FilmStillsOptions): Promise<string[]> {
  const ss = supersampleOf(opts.supersample);
  const page = await servePage(opts, ss);
  try {
    let { browser, info, width, height } = await page.openDeclared(opts);
    page.checkFiles();
    const film = describe(opts, info, {
      pageFile: page.pageFile,
      width,
      height,
      scale: 1,
      draft: false,
      stills: true,
    });
    const times = [...new Set(opts.at)].sort((a, b) => a - b);
    const half = SHUTTER_FRACTION / film.fps / 2;
    // a clock film keeps its own state and cannot go back: a still whose
    // shutter opens before where the page has been is taken on a fresh one
    let reached = 0;
    const from = async (t: number) => {
      if (info.mode === "clock" && t < reached - 1e-9) {
        await page.close(browser);
        browser = await page.open(width, height);
        await prepare(browser);
      }
    };
    const counts: number[] = [];
    const sides: number[] = [];
    for (const t of times) {
      if (!film.blur) {
        counts.push(1);
        sides.push(0);
      } else {
        await from(Math.max(0, t - half));
        const m = await motionAt(browser, t, half);
        counts.push(samplesFor(m.px));
        sides.push(m.side);
        reached = t + half;
      }
    }
    await mkdir(opts.outDir, { recursive: true });
    const ffmpeg = await resolveFfmpeg();
    const files: string[] = [];
    for (let i = 0; i < times.length; i++) {
      const t = times[i]!;
      const file = join(opts.outDir, `t${t.toFixed(3).padStart(7, "0")}.png`);
      const n = counts[i]!;
      const label = `the still at ${t}s`;
      const at = sampleTimes(t, n, film.fps, sides[i]);
      await from(at[0]!);
      reached = at.at(-1)!;
      if (n === 1 && ss === 1) {
        await seek(browser, t, label);
        await writeFile(file, await browser.screenshot({ format: "png" }));
      } else {
        const sink = new ShutterSink(
          ffmpeg,
          [n],
          [
            "-f",
            "rawvideo",
            "-pix_fmt",
            "rgb24",
            "-s",
            `${width}x${height}`,
            "-r",
            "1",
            "-i",
            "-",
            "-frames:v",
            "1",
            "-update",
            "1",
            "-y",
            file,
          ],
          { width, height },
        );
        try {
          for (const ti of at) {
            await seek(browser, ti, label);
            await sink.push(await browser.screenshot({ format: "jpeg", quality: 100 }));
          }
          await sink.end();
        } catch (e) {
          sink.kill();
          throw e;
        }
      }
      files.push(file);
    }
    page.checkFiles();
    return files;
  } finally {
    await page.shut();
  }
}

/** The film's page, served, and the Chromes that open it — each one with the
 *  film clock installed, drawing `dpr` device pixels per CSS px. */
async function servePage(
  opts: {
    page: string;
    root?: string;
    chromePath: string;
    onConsole?: (level: string, text: string) => void;
  },
  dpr: number,
) {
  const { root, pageFile, urlPath } = resolveFilmPage(opts.page, opts.root);
  const missing = new Set<string>();
  const server = await serveDirectory(root, (p) => {
    if (!p.endsWith("/favicon.ico")) missing.add(decodeURIComponent(p));
  });
  const clock = filmClockSource({ seed: 0x5eed, epochMs: Date.now() });
  const browsers = new Set<HtmlBrowser>();
  const open = async (width: number, height: number) => {
    const b = await launchHtmlBrowser({
      chromePath: opts.chromePath,
      url: `${server.url}${urlPath}`,
      width,
      height,
      deviceScaleFactor: dpr,
      initScript: clock,
      stillAnimations: true,
      onConsole: opts.onConsole,
      timeoutMs: 120_000,
      profilePrefix: "open-take-film-",
    });
    browsers.add(b);
    return b;
  };
  const close = async (b: HtmlBrowser) => {
    browsers.delete(b);
    await b.close();
  };
  return {
    pageFile,
    open,
    close,
    /** open the page and read what it is; a page that declares its own size,
     *  when none was asked for, is opened again at that size */
    async openDeclared(asked: { width?: number; height?: number }) {
      let width = asked.width ?? DEFAULT_SIZE.width;
      let height = asked.height ?? DEFAULT_SIZE.height;
      let browser = await open(width, height);
      let info = await prepare(browser);
      if (
        !asked.width &&
        !asked.height &&
        info.width &&
        info.height &&
        (info.width !== width || info.height !== height)
      ) {
        width = info.width;
        height = info.height;
        await close(browser);
        browser = await open(width, height);
        info = await prepare(browser);
      }
      return { browser, info, width, height };
    },
    /** a file the page asked for that is not there fails the film, by name */
    checkFiles() {
      if (missing.size) throw missingError(missing, root);
    },
    async closeAll() {
      for (const b of [...browsers]) await close(b);
    },
    async shut() {
      await Promise.all([...browsers].map((b) => b.close()));
      await server.close();
    },
  };
}

// --- the page ---------------------------------------------------------------------

async function prepare(b: HtmlBrowser): Promise<FilmPageInfo> {
  const has = await b.evaluate<boolean>(`typeof window.__ot === "object"`);
  if (!has) throw new Error("film: the film clock did not install in the page");
  return b.evaluate<FilmPageInfo>("window.__ot.prepare()", { timeoutMs: 120_000 });
}

async function seek(b: HtmlBrowser, t: number, what: string): Promise<void> {
  try {
    await b.evaluate(`window.__ot.seek(${t})`);
  } catch (e) {
    throw new Error(`film: ${what} (${t.toFixed(3)}s): ${(e as Error).message}`, {
      cause: e,
    });
  }
}

/** what the shutter around t sees: how far anything moves (px), and which
 *  side of it to expose when the picture cuts in the other (see sampleTimes) */
type Exposure = { px: number; side: number };

async function motionAt(b: HtmlBrowser, t: number, half: number): Promise<Exposure> {
  return b.evaluate<Exposure>(`window.__ot.motion(${t}, ${half})`);
}

function describe(
  opts: Pick<FilmRenderOptions, "fps" | "duration" | "from" | "to" | "audio" | "blur">,
  info: FilmPageInfo,
  at: {
    pageFile: string;
    width: number;
    height: number;
    scale: number;
    draft: boolean;
    /** stills: no length needed, and no soundtrack */
    stills?: boolean;
  },
): Film {
  const warnings: string[] = [];
  const fps = opts.fps ?? (at.draft ? 30 : (info.fps ?? 60));
  const durationS = opts.duration ?? info.duration;
  if (!durationS && !at.stills)
    throw new Error(
      "film: how long is the film? Declare it in the page — window.__film = { duration: <seconds> } — or pass --duration",
    );
  const end = Math.min(opts.to ?? durationS ?? 0, durationS ?? Number.POSITIVE_INFINITY);
  const from = opts.from ?? 0;
  const f0 = Math.round(from * fps);
  const f1 = Math.round(end * fps);
  if (!at.stills && !(f1 > f0))
    throw new Error(`film: nothing to render between ${from}s and ${end}s`);
  let audio: string | null = null;
  if (!at.stills) {
    if (typeof opts.audio === "string") audio = resolve(opts.audio);
    else if (opts.audio !== null && info.audio)
      audio = resolve(dirname(at.pageFile), decodeURI(info.audio.split("?")[0]!));
    if (audio && !existsSync(audio))
      throw new Error(`film: the soundtrack ${audio} does not exist`);
    if (!audio)
      warnings.push("no soundtrack — the film is silent (window.__film.audio or --audio)");
  }
  if (info.audioElements)
    warnings.push(
      `the page has ${info.audioElements} <audio> element(s); a render records picture only — ` +
        "declare the soundtrack instead (window.__film.audio or --audio)",
    );
  return {
    width: at.width,
    height: at.height,
    fps,
    scale: at.scale,
    f0,
    f1,
    audio,
    blur: opts.blur ?? !at.draft,
    warnings,
  };
}

/** the supersampling factor asked for: a whole number of pixels each way, 1–4 */
function supersampleOf(v: number | undefined): number {
  if (v === undefined) return 1;
  if (!Number.isFinite(v) || v < 1 || v > 4 || Math.round(v) !== v)
    throw new Error(`film: supersample is a whole number from 1 to 4, not ${v}`);
  return v;
}

function defaultWorkers(): number {
  // measured on a 10-core Mac: 2 → 4 workers gained 6 %, 6 lost 20 % — Chrome's
  // screenshot path is the shared bottleneck, not the CPU — and a 16 GB Mac
  // lost a Chrome to memory pressure at 3
  return Math.max(1, Math.min(2, Math.floor(cpus().length / 2)));
}

/** every frame's shutter samples and the side of the shutter they are spread
 *  over, probed by the pool's browsers in turn */
async function probe(
  pool: HtmlBrowser[],
  film: Film,
  onProgress?: (p: FilmProgress) => void,
): Promise<{ samples: number[]; sides: number[] }> {
  const frames = film.f1 - film.f0;
  const samples = new Array<number>(frames).fill(1);
  const sides = new Array<number>(frames).fill(0);
  const half = SHUTTER_FRACTION / film.fps / 2;
  let next = 0;
  let done = 0;
  await Promise.all(
    pool.map(async (b) => {
      for (;;) {
        const i = next++;
        if (i >= frames) return;
        const m = await motionAt(b, (film.f0 + i) / film.fps, half);
        samples[i] = samplesFor(m.px);
        sides[i] = m.side;
        done++;
        if (done % 30 === 0 || done === frames)
          onProgress?.({ phase: "probe", done, total: frames });
      }
    }),
  );
  return { samples, sides };
}

// --- encoding -------------------------------------------------------------------------

/** the film's frames, in pixels (screenshots are this × the supersampling) */
const outSize = (film: Film) => ({
  width: Math.round(film.width * film.scale),
  height: Math.round(film.height * film.scale),
});

function encodeArgs(film: Film, out: string, draft: boolean): string[] {
  // H.264 wants even sides, so an odd one is padded
  const { width: w, height: h } = outSize(film);
  return [
    "-f",
    "rawvideo",
    "-pix_fmt",
    "rgb24",
    "-s",
    `${w}x${h}`,
    "-r",
    String(film.fps),
    "-i",
    "-",
    "-vf",
    "pad=ceil(iw/2)*2:ceil(ih/2)*2,scale=out_color_matrix=bt709:out_range=tv:flags=accurate_rnd+full_chroma_int,format=yuv420p",
    "-c:v",
    "libx264",
    "-preset",
    draft ? "veryfast" : "medium",
    "-crf",
    draft ? "23" : "14",
    "-x264-params",
    `keyint=${film.fps * 2}:min-keyint=1:aq-mode=3`,
    "-colorspace",
    "bt709",
    "-color_primaries",
    "bt709",
    "-color_trc",
    "bt709",
    "-color_range",
    "tv",
    "-y",
    out,
  ];
}

async function deliver(
  ffmpeg: string,
  chunks: string[],
  film: Film,
  out: string,
  tmp: string,
): Promise<void> {
  const list = join(tmp, "chunks.txt");
  await writeFile(list, chunks.map((c) => `file '${c.replace(/'/g, "'\\''")}'`).join("\n"));
  await mkdir(dirname(resolve(out)), { recursive: true });
  const durationS = (film.f1 - film.f0) / film.fps;
  const args = ["-v", "error", "-y", "-f", "concat", "-safe", "0", "-i", list];
  if (film.audio) args.push("-ss", String(film.f0 / film.fps), "-i", film.audio);
  args.push("-map", "0:v", "-c:v", "copy");
  if (film.audio)
    args.push("-map", "1:a", "-af", "apad", "-c:a", "aac", "-b:a", "256k", "-ar", "48000");
  args.push("-t", durationS.toFixed(6), "-movflags", "+faststart", resolve(out));
  await runTool(ffmpeg, args);
}

// sRGB ↔ linear light, for averaging samples the way light adds up
const TO_LINEAR = new Float32Array(256);
for (let i = 0; i < 256; i++) {
  const c = i / 255;
  TO_LINEAR[i] = c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}
const LUT = 8192;
const TO_SRGB = new Float32Array(LUT + 2);
for (let i = 0; i <= LUT + 1; i++) {
  const c = Math.min(1, i / LUT);
  TO_SRGB[i] = (c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055) * 255;
}

/** Wait for a full pipe to drain — or for the processes behind it to end,
 *  which would leave the wait for "drain" pending forever and the render
 *  stuck where no retry can reach it. */
export function drainOrFail(stream: NodeJS.WritableStream, ended: Promise<unknown>): Promise<void> {
  return new Promise<void>((ok, fail) => {
    const drained = () => ok();
    stream.once("drain", drained);
    ended.then(
      () => {
        stream.removeListener("drain", drained);
        fail(new Error("film: ffmpeg ended before the samples did"));
      },
      (e) => {
        stream.removeListener("drain", drained);
        fail(e);
      },
    );
  });
}

/** Screenshots in, finished frames out: JPEG samples are decoded by one ffmpeg,
 *  each output frame's `schedule[n]` samples are averaged in linear light (with
 *  triangular dither back to 8 bits), and the frames go to an encoding ffmpeg
 *  run with `encodeArgs`. Backpressure flows end to end. */
class ShutterSink {
  private decoder: ChildProcess;
  private encoder: ChildProcess;
  private headWritten = false;
  private sampleIndex = 0;
  private pending: Buffer[] = [];
  private pendingBytes = 0;
  private frameBytes = 0;
  private frame = 0;
  private got = 0;
  private acc: Float32Array | null = null;
  private rng = 0x9e3779b9;
  private readonly finished: Promise<void>;
  private error: Error | null = null;

  constructor(
    ffmpeg: string,
    private readonly schedule: readonly number[],
    encodeArgs: string[],
    /** the film's frame: samples drawn at more pixels are scaled down to it */
    size: { width: number; height: number },
  ) {
    this.frameBytes = size.width * size.height * 3;
    this.decoder = spawn(
      ffmpeg,
      [
        "-v",
        "error",
        "-f",
        "matroska",
        "-i",
        "-",
        "-fps_mode",
        "passthrough",
        "-vf",
        // area averaging: a supersampled frame's 2×2 (3×3…) device pixels become one
        `scale=${size.width}:${size.height}:in_range=pc:in_color_matrix=bt601:flags=area+accurate_rnd+full_chroma_int,format=rgb24`,
        "-f",
        "rawvideo",
        "-",
      ],
      { stdio: ["pipe", "pipe", "pipe"] },
    );
    this.encoder = spawn(ffmpeg, ["-v", "error", ...encodeArgs], {
      stdio: ["pipe", "ignore", "pipe"],
    });
    const watch = (p: ChildProcess, name: string) =>
      new Promise<void>((ok, fail) => {
        let err = "";
        p.stderr?.on("data", (d: Buffer) => {
          err = (err + d.toString()).slice(-4000);
        });
        p.on("error", fail);
        p.on("close", (code, signal) => {
          if (code === 0) ok();
          else {
            const e = new Error(
              `film: ffmpeg ${name} exited ${code ?? signal}: ${err.trim().slice(-600)}`,
            );
            this.error ??= e;
            fail(e);
          }
        });
      });
    const decoded = watch(this.decoder, "decoder");
    const encoded = watch(this.encoder, "encoder");
    // a write after ffmpeg has gone (EPIPE) is not the error worth reporting:
    // its exit code is, through watch() above
    this.decoder.stdin?.on("error", () => {});
    this.encoder.stdin?.on("error", () => {});
    this.decoder.stdout?.on("data", (chunk: Buffer) => this.onData(chunk));
    this.decoder.stdout?.on("end", () => {
      this.encoder.stdin?.end();
    });
    this.finished = Promise.all([decoded, encoded]).then(() => {
      if (this.frame !== this.schedule.length)
        throw new Error(
          `film: ${this.frame} of ${this.schedule.length} frames came out of the shutter`,
        );
    });
    // push() and end() report a failure; a piece given up without end() must
    // not leave it unhandled
    this.finished.catch(() => {});
  }

  /** one sample (a JPEG screenshot), in order */
  async push(jpeg: Buffer): Promise<void> {
    if (this.error) throw this.error;
    const stdin = this.decoder.stdin!;
    if (!this.headWritten) {
      const { width, height } = jpegDimensions(jpeg);
      this.headWritten = true;
      stdin.write(matroskaHead(width, height, 0));
    }
    if (!stdin.write(matroskaCluster(this.sampleIndex++, jpeg)))
      await drainOrFail(stdin, this.finished);
  }

  async end(): Promise<void> {
    this.decoder.stdin?.end();
    await this.finished;
  }

  kill(): void {
    for (const p of [this.decoder, this.encoder])
      try {
        p.kill("SIGKILL");
      } catch {
        /* gone */
      }
  }

  private onData(chunk: Buffer): void {
    this.pending.push(chunk);
    this.pendingBytes += chunk.length;
    while (this.frameBytes && this.pendingBytes >= this.frameBytes) {
      const whole = Buffer.concat(this.pending, this.pendingBytes);
      const sample = whole.subarray(0, this.frameBytes);
      const rest = whole.subarray(this.frameBytes);
      this.pending = rest.length ? [rest] : [];
      this.pendingBytes = rest.length;
      this.onSample(sample);
    }
  }

  private onSample(raw: Buffer): void {
    const n = this.schedule[this.frame] ?? 1;
    if (n === 1) {
      this.emit(Buffer.from(raw));
      return;
    }
    if (!this.acc) this.acc = new Float32Array(raw.length);
    const acc = this.acc;
    for (let k = 0; k < raw.length; k++) acc[k]! += TO_LINEAR[raw[k]!]!;
    if (++this.got < n) return;
    const out = Buffer.allocUnsafe(raw.length);
    const scale = LUT / n;
    let s = this.rng;
    for (let k = 0; k < out.length; k++) {
      const v = acc[k]! * scale;
      const i = v | 0;
      const srgb = TO_SRGB[i]! + (TO_SRGB[i + 1]! - TO_SRGB[i]!) * (v - i);
      // triangular dither, ±0.5 LSB (xorshift32)
      s ^= s << 13;
      s ^= s >>> 17;
      s ^= s << 5;
      const r1 = (s >>> 0) / 4294967296;
      s ^= s << 13;
      s ^= s >>> 17;
      s ^= s << 5;
      const d = srgb + ((s >>> 0) / 4294967296 - r1) * 0.5;
      out[k] = d <= 0 ? 0 : d >= 255 ? 255 : Math.round(d);
    }
    this.rng = s;
    acc.fill(0);
    this.got = 0;
    this.emit(out);
  }

  private emit(frame: Buffer): void {
    this.frame++;
    const stdin = this.encoder.stdin!;
    if (!stdin.write(frame)) {
      this.decoder.stdout?.pause();
      stdin.once("drain", () => this.decoder.stdout?.resume());
    }
  }
}
