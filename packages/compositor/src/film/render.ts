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
// joined without re-encoding, each placed at its first frame's own time (not
// where its container says the one before ends), and the soundtrack is muxed on.
//
// Beside the film goes <film>.events.json (see FilmEvents): what the page says
// happens when (window.__film.events), its curves sampled once per frame in
// the render loop itself (window.__film.curves), and the cuts — for the score,
// which places its sounds from it.

import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { cpus, tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { resolveFfmpeg, resolveFfprobe, runTool, SRGB_TAG_ARGS, SRGB_TAGS } from "../ffmpeg";
import { type HtmlBrowser, launchHtmlBrowser } from "../html/cdp";
import { serveDirectory } from "../html/server";
import { jpegDimensions, matroskaCluster, matroskaHead } from "../mjpeg-matroska";
import { type FilmMark, type FilmPageInfo, filmClockSource, filmMarks } from "./clock";
import { frameStore, type VideoFrames } from "./frames";

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
  /** the first frame rendered, and the whole film's length in frames */
  startFrame: number;
  filmFrames: number;
  wallMs: number;
  warnings: string[];
  /** the film's events file (<out without its extension>.events.json), when one was written */
  events?: string;
};

/** One thing that happens in the film, as the page declares it: in seconds of
 *  page time, with where on the stage (CSS px) and how hard (0..1) if it says. */
export type FilmEvent = {
  t: number;
  /** what it is: "click", "key", "land", "cut", "mark", or any word of the page's */
  kind: string;
  x?: number;
  y?: number;
  force?: number;
  label?: string;
};

/** One stretch of the film as the page means it (kit/time.js `segment`): in
 *  seconds of page time, every other field the page's own free words;
 *  `handoff` is how it hands over to what comes next, at `to`. */
export type FilmSegment = {
  from: number;
  to: number;
  label?: string;
  hold?: boolean;
  handoff?: string;
  /** a CSS selector, or a subject's name in the curves */
  subject?: string;
  sound?: string;
};

/** Something the film uses that someone else made, and on what terms
 *  (kit/time.js `credit`, or window.__film.credits): every field the page's
 *  own free words, for the record only — nothing checks or acts on it. */
export type FilmCredit = {
  what?: string;
  by?: string;
  licence?: string;
  url?: string;
  /** the attribution line as it should appear, if one must */
  text?: string;
};

/** Where something on screen comes from (kit/time.js `source`, or
 *  window.__film.sources): a part of components.json, the live page it shows
 *  on, or a note ("demo", "illustrative") — the page's own word, for the
 *  record; `film probe` sets it beside the film's text, nothing checks it. */
export type FilmSource = {
  /** what on screen it covers: the text as shown, or words for it */
  label: string;
  /** a part of components.json, "<state>:<element id>" */
  ref?: string;
  /** which of the part's values */
  field?: string;
  /** the components.json it was read from, as the page fetched it */
  file?: string;
  url?: string;
  note?: string;
  /** the strings on screen it covers, beside the label */
  text?: string[];
  /** the film's elements whose text it covers (CSS) */
  selector?: string;
};

/** <film>.events.json: what the score reads to put its sounds where the
 *  picture is. Times are page time (s). */
export type FilmEvents = {
  version: 1;
  /** the whole film (s), whatever range was rendered */
  duration: number;
  fps: number;
  /** [from, to) s when only part of the film was rendered */
  range?: [number, number];
  /** window.__film.events(), in time order; [] when the page has none */
  events: FilmEvent[];
  /** every hard cut: declared ∪ detected, merged when less than half a frame apart */
  cuts: number[];
  /** the page's events of kind "cut" */
  declaredCuts: number[];
  /** the first frame of a new picture, where the blur probe found one half of a
   *  frame's shutter changed and the other did not — a jump of the picture, which
   *  is most often a cut. Found only inside a shutter (half of each frame's
   *  time), and not at all in a render without blur (a draft) */
  detectedCuts: number[];
  /** window.__film.curves(t) once per output frame: rows[i][j] is names[j] at
   *  t0 + i·dt; null where the page gave no number */
  curves: { names: string[]; t0: number; dt: number; rows: (number | null)[][] };
  /** window.__film.segments(), by `from` — the page's beat sheet; [] when it has none */
  segments: FilmSegment[];
  /** window.__film.credits (a list, or a function that gives one), as the page
   *  gave it; [] when it has none. Information only */
  credits: FilmCredit[];
  /** window.__film.sources (a list, or a function that gives one), as the
   *  page gave it; [] when it has none. Information only */
  sources: FilmSource[];
};

/** where a film's events file goes: beside it, `film.mp4` → `film.events.json` */
export function eventsPathFor(out: string): string {
  const file = resolve(out);
  const dot = file.lastIndexOf(".");
  return `${dot > Math.max(file.lastIndexOf("/"), file.lastIndexOf("\\")) ? file.slice(0, dot) : file}.events.json`;
}

type Film = {
  width: number;
  height: number;
  fps: number;
  scale: number;
  f0: number;
  f1: number;
  /** the whole film's length in frames, whatever range is rendered */
  total: number;
  audio: string | null;
  blur: boolean;
  marks: FilmMark[];
  warnings: string[];
};

/** The MP4 metadata key a rendered film carries for `film check`. In the file
 *  itself rather than beside it, so it goes wherever the film is copied and a
 *  render that drops a mark cannot leave a stale one behind. */
export const FILM_TAG = "open_take_film";

/** What the film carries under FILM_TAG: where on the page's timeline its
 *  first frame is (a render --from), the size the page was laid out at, and
 *  the page's marks, in page time. */
export type FilmRecord = { from: number; width: number; height: number; marks: FilmMark[] };

const inside = (file: string, dir: string) => {
  const r = relative(dir, file);
  return r !== "" && !r.startsWith("..") && !isAbsolute(r);
};

/** the page file, the directory served, and the page's path in it */
export function resolveFilmPage(
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
    // what the page says happens, asked once; its curves are asked in the render loop
    const declared = await pageEvents(first, film.warnings);
    const segments = await pageSegments(first, film.warnings);
    const credits = await pageCredits(first, film.warnings);
    const sources = await pageSources(first, film.warnings);
    const hasCurves = await first.evaluate<boolean>(`typeof window.__film?.curves === "function"`);
    const curveRows: (Record<string, number | null> | null)[] = new Array(frames).fill(null);

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
    const chunks: FilmChunk[] = [];
    const chunkOf = pieces.map((ps) =>
      ps.map(([a, b]) => {
        const file = join(tmp, `chunk-${String(chunks.length).padStart(4, "0")}.mp4`);
        chunks.push({ file, frames: b - a });
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
                    if (hasCurves) curveRows[i] = await pageCurves(browser, t, film.warnings);
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
    for (const v of page.unframed())
      film.warnings.push(
        `a video was shown by seeking it, not as its frames: ${v} — under a slow push it can shimmer, and it renders slower`,
      );
    await deliver(ffmpeg, chunks, film, opts.out, tmp);
    const events = eventsPathFor(opts.out);
    await writeFile(
      events,
      `${JSON.stringify(filmEvents(film, declared, sides, curveRows, film.blur, segments, credits, sources))}\n`,
    );
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
      startFrame: film.f0,
      filmFrames: film.total,
      wallMs: Date.now() - t0,
      warnings: film.warnings,
      events,
    };
  } finally {
    await page.shut();
    await rm(tmp, { recursive: true, force: true });
  }
}

const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** window.__film.events(), once, as plain values; [] when the page has none.
 *  An entry without a time or a kind is left out, and said so. */
async function pageEvents(b: HtmlBrowser, warnings: string[]): Promise<FilmEvent[]> {
  let raw: unknown;
  try {
    raw = await b.evaluate<unknown>(
      `(async () => {
        const f = window.__film?.events;
        if (f === undefined) return null;
        if (typeof f !== "function") return { notFunction: true };
        return JSON.parse(JSON.stringify((await f()) ?? []));
      })()`,
    );
  } catch (e) {
    // like a curve, the events are information for the score: the film goes on
    warnings.push(
      `window.__film.events threw (${(e as Error).message.split("\n")[0]}) — the events file has none`,
    );
    return [];
  }
  if (raw && typeof raw === "object" && "notFunction" in raw) {
    warnings.push(
      "window.__film.events is not a function — it is asked once, as events(); the events file has none",
    );
    return [];
  }
  return checkEvents(raw, warnings);
}

/** a page's events, checked and in time order (see FilmEvent) */
export function checkEvents(raw: unknown, warnings: string[] = []): FilmEvent[] {
  if (raw == null) return [];
  if (!Array.isArray(raw)) {
    warnings.push("window.__film.events() gave no list — the events file has none");
    return [];
  }
  const out: FilmEvent[] = [];
  let dropped = 0;
  for (const e of raw as Record<string, unknown>[]) {
    if (!e || !finite(e.t) || typeof e.kind !== "string" || !e.kind) {
      dropped++;
      continue;
    }
    const ev: FilmEvent = { t: e.t, kind: e.kind };
    if (finite(e.x)) ev.x = e.x;
    if (finite(e.y)) ev.y = e.y;
    if (finite(e.force)) ev.force = Math.max(0, Math.min(1, e.force));
    if (typeof e.label === "string") ev.label = e.label;
    out.push(ev);
  }
  if (dropped)
    warnings.push(
      `window.__film.events(): ${dropped} event(s) without a time (t, s) or a kind were left out`,
    );
  // stable: events at the same time keep the page's order
  return out
    .map((e, i) => [e, i] as const)
    .sort((a, b) => a[0].t - b[0].t || a[1] - b[1])
    .map(([e]) => e);
}

/** window.__film.segments(), once, as plain values; [] when the page has none */
async function pageSegments(b: HtmlBrowser, warnings: string[]): Promise<FilmSegment[]> {
  let raw: unknown;
  try {
    raw = await b.evaluate<unknown>(
      `(async () => {
        const f = window.__film?.segments;
        if (f === undefined) return null;
        if (typeof f !== "function") return { notFunction: true };
        return JSON.parse(JSON.stringify((await f()) ?? []));
      })()`,
    );
  } catch (e) {
    warnings.push(
      `window.__film.segments threw (${(e as Error).message.split("\n")[0]}) — the events file has none`,
    );
    return [];
  }
  if (raw && typeof raw === "object" && "notFunction" in raw) {
    warnings.push(
      "window.__film.segments is not a function — it is asked once, as segments(); the events file has none",
    );
    return [];
  }
  return checkSegments(raw, warnings);
}

/** a page's beat sheet, checked and by `from` (see FilmSegment): a segment
 *  without two times, or that ends before it starts, is left out and said so */
export function checkSegments(raw: unknown, warnings: string[] = []): FilmSegment[] {
  if (raw == null) return [];
  if (!Array.isArray(raw)) {
    warnings.push("window.__film.segments() gave no list — the events file has none");
    return [];
  }
  const out: FilmSegment[] = [];
  let dropped = 0;
  for (const e of raw as Record<string, unknown>[]) {
    if (!e || !finite(e.from) || !finite(e.to) || !(e.to > e.from)) {
      dropped++;
      continue;
    }
    const seg: FilmSegment = { from: e.from, to: e.to };
    for (const k of ["label", "handoff", "subject", "sound"] as const)
      if (typeof e[k] === "string" && e[k]) seg[k] = e[k] as string;
    if (typeof e.hold === "boolean") seg.hold = e.hold;
    out.push(seg);
  }
  if (dropped)
    warnings.push(
      `window.__film.segments(): ${dropped} segment(s) without a from and a later to (s) were left out`,
    );
  return out
    .map((s, i) => [s, i] as const)
    .sort((a, b) => a[0].from - b[0].from || a[1] - b[1])
    .map(([s]) => s);
}

/** window.__film.credits — a list, or a function that gives one — once, as
 *  plain values; [] when the page has none */
async function pageCredits(b: HtmlBrowser, warnings: string[]): Promise<FilmCredit[]> {
  let raw: unknown;
  try {
    raw = await b.evaluate<unknown>(
      `(async () => {
        let c = window.__film?.credits;
        if (c === undefined) return null;
        if (typeof c === "function") c = await c();
        return JSON.parse(JSON.stringify(c ?? []));
      })()`,
    );
  } catch (e) {
    warnings.push(
      `window.__film.credits threw (${(e as Error).message.split("\n")[0]}) — the events file has none`,
    );
    return [];
  }
  return checkCredits(raw, warnings);
}

/** a page's credits as given, each kept to its known fields as strings
 *  ("license" read as "licence"); one that says nothing is left out and said so */
export function checkCredits(raw: unknown, warnings: string[] = []): FilmCredit[] {
  if (raw == null) return [];
  if (!Array.isArray(raw)) {
    warnings.push("window.__film.credits is not a list — the events file has none");
    return [];
  }
  const out: FilmCredit[] = [];
  let dropped = 0;
  for (const e of raw as Record<string, unknown>[]) {
    const c: FilmCredit = {};
    if (e && typeof e === "object") {
      const src: Record<string, unknown> = { ...e, licence: e.licence ?? e.license };
      for (const k of ["what", "by", "licence", "url", "text"] as const) {
        const v = src[k];
        if ((typeof v === "string" && v) || finite(v)) c[k] = String(v);
      }
    }
    if (Object.keys(c).length) out.push(c);
    else dropped++;
  }
  if (dropped)
    warnings.push(
      `window.__film.credits: ${dropped} credit(s) with no what, by, licence, url or text were left out`,
    );
  return out;
}

/** window.__film.sources — a list, or a function that gives one — once, as
 *  plain values; [] when the page has none */
async function pageSources(b: HtmlBrowser, warnings: string[]): Promise<FilmSource[]> {
  let raw: unknown;
  try {
    raw = await b.evaluate<unknown>(
      `(async () => {
        let s = window.__film?.sources;
        if (s === undefined) return null;
        if (typeof s === "function") s = await s();
        return JSON.parse(JSON.stringify(s ?? []));
      })()`,
    );
  } catch (e) {
    warnings.push(
      `window.__film.sources threw (${(e as Error).message.split("\n")[0]}) — the events file has none`,
    );
    return [];
  }
  return checkSources(raw, warnings);
}

/** a page's sources as given, each kept to its known fields; one without a
 *  label, or that names no ref, url or note, is left out and said so */
export function checkSources(raw: unknown, warnings: string[] = []): FilmSource[] {
  if (raw == null) return [];
  if (!Array.isArray(raw)) {
    warnings.push("window.__film.sources is not a list — the events file has none");
    return [];
  }
  const out: FilmSource[] = [];
  let dropped = 0;
  for (const e of raw as Record<string, unknown>[]) {
    const label = e && typeof e === "object" ? e.label : undefined;
    if (typeof label !== "string" || !label.trim()) {
      dropped++;
      continue;
    }
    const s: FilmSource = { label };
    for (const k of ["ref", "field", "file", "url", "note", "selector"] as const) {
      const v = e[k];
      if ((typeof v === "string" && v) || finite(v)) s[k] = String(v);
    }
    const text = (Array.isArray(e.text) ? e.text : e.text != null ? [e.text] : [])
      .filter((v) => (typeof v === "string" && v) || finite(v))
      .map(String);
    if (text.length) s.text = text;
    if (s.ref || s.url || s.note) out.push(s);
    else dropped++;
  }
  if (dropped)
    warnings.push(
      `window.__film.sources: ${dropped} source(s) without a label and a ref, url or note were left out`,
    );
  return out;
}

/** window.__film.curves(t): every value that is a finite number, the rest null */
async function pageCurves(
  b: HtmlBrowser,
  t: number,
  warnings: string[],
): Promise<Record<string, number | null> | null> {
  try {
    return await b.evaluate<Record<string, number | null> | null>(
      `(async () => {
        const r = await window.__film.curves(${t});
        if (!r || typeof r !== "object") return null;
        const o = {};
        for (const k of Object.keys(r)) { const v = r[k]; o[k] = typeof v === "number" && Number.isFinite(v) ? v : null; }
        return o;
      })()`,
    );
  } catch (e) {
    // a curve is information for the score, never a reason to lose the film
    if (!warnings.some((w) => w.startsWith("window.__film.curves")))
      warnings.push(
        `window.__film.curves threw (${(e as Error).message.split("\n")[0]}) — left out where it did`,
      );
    return null;
  }
}

/** merge times less than `eps` apart into the first of them, in order */
const mergeTimes = (ts: number[], eps: number): number[] =>
  [...ts]
    .sort((a, b) => a - b)
    .reduce<number[]>((acc, t) => {
      if (!acc.length || t - acc[acc.length - 1]! >= eps) acc.push(t);
      return acc;
    }, []);

const secs6 = (t: number) => Math.round(t * 1e6) / 1e6;

/** the events file of a render of frames [f0, f1): `sides` and `rows` are per
 *  rendered frame (see FilmEvents.detectedCuts for what a side says) */
export function filmEvents(
  film: Pick<Film, "fps" | "f0" | "f1" | "total">,
  events: FilmEvent[],
  sides: readonly number[],
  rows: readonly (Record<string, number | null> | null)[],
  probed: boolean,
  segments: FilmSegment[] = [],
  credits: FilmCredit[] = [],
  sources: FilmSource[] = [],
): FilmEvents {
  const { fps, f0, f1, total } = film;
  const detected: number[] = [];
  if (probed)
    sides.forEach((side, i) => {
      // side 1: the first half of the shutter changed, so this frame is the
      // first of the new picture; side -1: the second half did, so the next is
      if (side > 0) detected.push(secs6((f0 + i) / fps));
      else if (side < 0 && f0 + i + 1 < total) detected.push(secs6((f0 + i + 1) / fps));
    });
  const declaredCuts = mergeTimes(
    events.filter((e) => e.kind === "cut").map((e) => e.t),
    1e-9,
  );
  const names: string[] = [];
  const seen = new Set<string>();
  for (const r of rows)
    if (r)
      for (const k of Object.keys(r))
        if (!seen.has(k)) {
          seen.add(k);
          names.push(k);
        }
  return {
    version: 1,
    duration: secs6(total / fps),
    fps,
    ...(f0 > 0 || f1 < total
      ? { range: [secs6(f0 / fps), secs6(f1 / fps)] as [number, number] }
      : {}),
    events,
    cuts: mergeTimes([...declaredCuts, ...mergeTimes(detected, 1e-9)], 0.5 / fps),
    declaredCuts,
    detectedCuts: mergeTimes(detected, 1e-9),
    curves: {
      names,
      t0: secs6(f0 / fps),
      dt: 1 / fps,
      rows: names.length ? rows.map((r) => names.map((k) => r?.[k] ?? null)) : [],
    },
    segments,
    credits,
    sources,
  };
}

/** the events file of a master after `patch` — a render of part of it — went
 *  into it: the page's events as they are now, the curves and the detected
 *  cuts of the range in place of the master's own there */
export function patchEvents(master: FilmEvents, patch: FilmEvents): FilmEvents | null {
  const frames = Math.round(master.duration * master.fps);
  if (
    master.version !== 1 ||
    master.range ||
    Math.abs(master.fps - patch.fps) > 1e-6 ||
    Math.abs(master.duration - patch.duration) > 0.5 / patch.fps ||
    !patch.range
  )
    return null;
  const [from, to] = patch.range;
  const a = Math.round(from * patch.fps);
  const b = Math.round(to * patch.fps);
  const inRange = (t: number) => t >= from - 1e-9 && t < to - 1e-9;
  const detectedCuts = mergeTimes(
    [...master.detectedCuts.filter((t) => !inRange(t)), ...patch.detectedCuts],
    1e-9,
  );
  // the curves: names from both, the master's rows outside the range
  const names = [...master.curves.names];
  for (const n of patch.curves.names) if (!names.includes(n)) names.push(n);
  const col = (c: FilmEvents["curves"], row: (number | null)[] | undefined, n: string) => {
    const j = c.names.indexOf(n);
    return j < 0 ? null : (row?.[j] ?? null);
  };
  const rows =
    names.length === 0
      ? []
      : Array.from({ length: frames }, (_, i) =>
          i >= a && i < b
            ? names.map((n) => col(patch.curves, patch.curves.rows[i - a], n))
            : names.map((n) => col(master.curves, master.curves.rows[i], n)),
        );
  return {
    version: 1,
    duration: master.duration,
    fps: master.fps,
    events: patch.events,
    cuts: mergeTimes([...patch.declaredCuts, ...detectedCuts], 0.5 / master.fps),
    declaredCuts: patch.declaredCuts,
    detectedCuts,
    curves: { names, t0: 0, dt: 1 / master.fps, rows },
    // the beat sheet as the page says it now, like its events
    segments: patch.segments ?? master.segments ?? [],
    // the credits as the page says them now
    credits: patch.credits ?? master.credits ?? [],
    // where its values come from, as the page says it now
    sources: patch.sources ?? master.sources ?? [],
  };
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

/** Render only [from, to) of the film, at master quality, into `into` — a
 *  master of the whole film — in place of its own frames: a change to a few
 *  seconds costs those seconds, not the film. The master's sound is kept (to
 *  change it, muxFilm). Refused when `into` is not a whole master of this
 *  film: one `film render` did not make, one whose frames are not evenly
 *  spaced, another size, frame rate or length, or a range of its own. */
export async function patchFilm(
  opts: FilmRenderOptions & { into: string },
): Promise<FilmRenderResult> {
  const t0 = Date.now();
  if (opts.from === undefined && opts.to === undefined)
    throw new Error("film: --into takes --from and/or --to: the seconds to render again");
  if (opts.draft) throw new Error("film: --into puts master frames into a master — not a --draft");
  const into = resolve(opts.into);
  if (!existsSync(into))
    throw new Error(`film: there is no master at ${into} to put the range into`);
  const ffmpeg = await resolveFfmpeg();
  const master = await probeFilm(into);
  // its frames are swapped by number: frame n must be the one at n/fps, as in
  // a master `film render` made — not in a file whose average rate only
  // matches, nor one whose picture was moved off 0 (the range starts at 0,
  // and the sound is kept where it is)
  const unlike = !master.made ? "`film render` did not make it" : await framesOff(into);
  if (unlike)
    throw new Error(
      `film: ${opts.into} is not a whole master of this film (${unlike}) — render it whole`,
    );
  const tmp = await mkdtemp(join(tmpdir(), "open-take-patch-"));
  try {
    const range = join(tmp, "range.mp4");
    const r = await renderFilm({ ...opts, out: range, audio: null });
    const it = `${master.width}×${master.height} ${master.fps} fps, ${master.frames} frames${master.from ? `, from ${master.from}s` : ""}`;
    const film = `${r.width}×${r.height} ${r.fps} fps, ${r.filmFrames} frames`;
    if (
      master.width !== r.width ||
      master.height !== r.height ||
      Math.abs(master.fps - r.fps) > 0.001 ||
      master.frames !== r.filmFrames ||
      master.from
    )
      throw new Error(
        `film: ${opts.into} is not a whole master of this film (it is ${it}; the film is ${film}) — render it whole`,
      );
    const a = r.startFrame;
    const b = r.startFrame + r.frames;
    const parts: string[] = [];
    let graph = "";
    if (a > 0) {
      graph += `[0:v]trim=end_frame=${a},setpts=PTS-STARTPTS[before];`;
      parts.push("[before]");
    }
    graph += "[1:v]setpts=PTS-STARTPTS[range];";
    parts.push("[range]");
    if (b < master.frames) {
      graph += `[0:v]trim=start_frame=${b},setpts=PTS-STARTPTS[after];`;
      parts.push("[after]");
    }
    // frame n at n/fps exactly, as a render puts it — also when the master
    // had one a few ticks off (see framesOffIn); and named as a master is
    // named, whatever the master said: one `film render` made before named
    // BT.709's curve (or, on ffmpeg 8, none) for the same sRGB values, and a
    // patched master must not name two
    graph += `${parts.join("")}concat=n=${parts.length}:v=1:a=0,setpts=N/(${r.fps}*TB),format=yuv420p,${SRGB_TAGS}[v]`;
    const record = { ...(await probeFilm(range)).record, from: 0 };
    const out = join(tmp, "patched.mp4");
    // the same encoding as a master (see encodeArgs)
    await runTool(ffmpeg, [
      "-v",
      "error",
      "-y",
      "-i",
      into,
      "-i",
      range,
      "-filter_complex",
      graph,
      "-map",
      "[v]",
      "-map",
      "0:a?",
      "-c:a",
      "copy",
      "-c:v",
      "libx264",
      "-preset",
      "medium",
      "-crf",
      "14",
      "-x264-params",
      `keyint=${Math.round(r.fps) * 2}:min-keyint=1:aq-mode=3`,
      ...SRGB_TAG_ARGS,
      "-metadata",
      `${FILM_TAG}=${JSON.stringify(record)}`,
      "-movflags",
      "+faststart+use_metadata_tags",
      out,
    ]);
    await mkdir(dirname(resolve(opts.out)), { recursive: true });
    await moveFile(out, resolve(opts.out));
    const warnings = r.warnings.filter((w) => !w.startsWith("no soundtrack"));
    // the master's events file, with the range's curves and cuts in place of its own
    const events = await patchedEventsFile(into, r.events, resolve(opts.out), warnings);
    return {
      ...r,
      out: resolve(opts.out),
      frames: master.frames,
      durationS: master.frames / r.fps,
      startFrame: 0,
      wallMs: Date.now() - t0,
      warnings,
      events,
    };
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

/** Put a soundtrack under a rendered film without rendering it again: the
 *  picture is copied as it is, the sound encoded as a render encodes it.
 *  `audio` null leaves the film silent. */
export async function muxFilm(opts: {
  film: string;
  audio: string | null;
  out: string;
}): Promise<{ out: string; durationS: number }> {
  const film = resolve(opts.film);
  if (!existsSync(film)) throw new Error(`film: there is no film at ${film}`);
  if (opts.audio && !existsSync(resolve(opts.audio)))
    throw new Error(`film: the soundtrack ${resolve(opts.audio)} does not exist`);
  const ffmpeg = await resolveFfmpeg();
  const info = await probeFilm(film);
  const durationS = info.frames / info.fps;
  const tmp = await mkdtemp(join(tmpdir(), "open-take-mux-"));
  try {
    const out = join(tmp, "muxed.mp4");
    const args = ["-v", "error", "-y", "-i", film];
    // a film rendered from the middle starts its sound there too
    if (opts.audio) args.push("-ss", String(info.from), "-i", resolve(opts.audio));
    args.push("-map", "0:v", "-c:v", "copy");
    if (opts.audio)
      args.push("-map", "1:a", "-af", "apad", "-c:a", "aac", "-b:a", "256k", "-ar", "48000");
    args.push(
      "-map_metadata",
      "0",
      "-t",
      durationS.toFixed(6),
      "-movflags",
      "+faststart+use_metadata_tags",
      out,
    );
    await runTool(ffmpeg, args);
    await mkdir(dirname(resolve(opts.out)), { recursive: true });
    await moveFile(out, resolve(opts.out));
    return { out: resolve(opts.out), durationS };
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

/** write the events file of a patched master (see patchEvents); undefined,
 *  with a warning, when the master has none of its own to patch */
async function patchedEventsFile(
  into: string,
  rangeEvents: string | undefined,
  out: string,
  warnings: string[],
): Promise<string | undefined> {
  const read = async (file: string | undefined): Promise<FilmEvents | null> => {
    if (!file || !existsSync(file)) return null;
    try {
      return JSON.parse(await readFile(file, "utf8")) as FilmEvents;
    } catch {
      return null;
    }
  };
  const [master, patch] = await Promise.all([read(eventsPathFor(into)), read(rangeEvents)]);
  const merged = master && patch ? patchEvents(master, patch) : null;
  if (!merged) {
    warnings.push(
      `${eventsPathFor(into)} is missing or is not this master's — render the film whole for an events file`,
    );
    return undefined;
  }
  const file = eventsPathFor(out);
  await writeFile(file, `${JSON.stringify(merged)}\n`);
  return file;
}

/** move a finished file into place — copied when it is on another disk */
async function moveFile(from: string, to: string): Promise<void> {
  try {
    await rename(from, to);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EXDEV") throw e;
    await copyFile(from, to);
    await rm(from, { force: true });
  }
}

/** an ffprobe rational ("60/1", "1/15360") as a number; 0 when there is none */
function ratio(r: string | undefined): number {
  const [n, d] = String(r ?? "0/1")
    .split("/")
    .map(Number);
  return d && Number.isFinite(n) ? n! / d : 0;
}

/** a rendered film's picture: size, rate, length in frames, and the record
 *  `film render` keeps in it (where it starts on the page's timeline) —
 *  `made` when there is one */
async function probeFilm(file: string): Promise<{
  width: number;
  height: number;
  fps: number;
  frames: number;
  from: number;
  record: Partial<FilmRecord>;
  made: boolean;
}> {
  const ffprobe = await resolveFfprobe();
  const p = JSON.parse(
    await runTool(ffprobe, [
      "-v",
      "error",
      "-select_streams",
      "v:0",
      "-show_entries",
      "stream=width,height,avg_frame_rate,r_frame_rate,nb_frames,duration:format_tags",
      "-of",
      "json",
      file,
    ]),
  ) as {
    streams?: {
      width?: number;
      height?: number;
      avg_frame_rate?: string;
      r_frame_rate?: string;
      nb_frames?: string;
      duration?: string;
    }[];
    format?: { tags?: Record<string, string> };
  };
  const v = p.streams?.[0];
  if (!v?.width || !v.height) throw new Error(`film: ${file} has no picture`);
  // the rate the stream names, when its average differs only as a frame a
  // few ticks off makes it (see framesOffIn: 30.005 for a 2 s film); the
  // average when the stream names none, or one far from it
  const avg = ratio(v.avg_frame_rate);
  const named = ratio(v.r_frame_rate);
  const fps = named > 0 && Math.abs(named - avg) <= avg * 1e-3 ? named : avg;
  const frames = Number(v.nb_frames) || Math.round(Number(v.duration ?? 0) * fps);
  let record: Partial<FilmRecord> = {};
  try {
    record = JSON.parse(p.format?.tags?.[FILM_TAG] ?? "{}") as Partial<FilmRecord>;
  } catch {
    // a film from elsewhere carries none
  }
  return {
    width: v.width,
    height: v.height,
    fps,
    frames,
    from: Number(record.from) || 0,
    record,
    made: typeof record.from === "number",
  };
}

/** why the film's picture is not as `film render` encodes it — its first
 *  frame at 0 s, frame n at n/fps after it (a file of varying rate is not,
 *  whatever its average); null when it is */
async function framesOff(file: string): Promise<string | null> {
  const p = JSON.parse(
    await runTool(await resolveFfprobe(), [
      "-v",
      "error",
      "-select_streams",
      "v:0",
      "-show_entries",
      "stream=time_base,r_frame_rate:packet=pts",
      "-of",
      "json",
      file,
    ]),
  ) as { streams?: { time_base?: string; r_frame_rate?: string }[]; packets?: { pts?: number }[] };
  const tb = ratio(p.streams?.[0]?.time_base);
  const fps = ratio(p.streams?.[0]?.r_frame_rate);
  const pts = (p.packets ?? []).map((k) => Number(k.pts));
  return framesOffIn(pts, tb > 0 && fps > 0 ? 1 / (tb * fps) : 0);
}

/** framesOff on the picture's timestamps, `tick` of them a frame (0 when the
 *  file names no rate: then its first step). Frame n counts as at n/fps when
 *  it is less than half a frame from there — the frames are swapped by
 *  number, and a master made before the chunks were placed exactly carries
 *  one a few ticks early — and a frame missing, doubled or moved by half a
 *  frame or more is not. */
export function framesOffIn(timestamps: readonly number[], tick: number): string | null {
  const pts = timestamps.filter((t) => Number.isFinite(t)).sort((a, b) => a - b);
  if (!pts.length) return "it has no picture";
  if (pts[0] !== 0) return "its picture does not start at 0 s";
  const step = tick > 0 ? tick : (pts[1] ?? 1) - pts[0];
  return step > 0 && pts.every((t, i) => Math.abs(t - i * step) < step / 2)
    ? null
    : "its frames are not evenly spaced";
}

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
  // the videos the page plays, as decoded frames (see frames.ts)
  const frames = frameStore({ root, server });
  const unframed = new Set<string>();
  const browsers = new Set<HtmlBrowser>();
  const open = async (width: number, height: number) => {
    let page: HtmlBrowser | null = null;
    const asked: string[] = [];
    const answer = (payload: string) => {
      if (!page) return void asked.push(payload);
      const b = page;
      let src = "";
      try {
        src = String((JSON.parse(payload) as { src?: unknown }).src ?? "");
      } catch {
        return;
      }
      const reply = (f: VideoFrames | null) =>
        b
          .evaluate(`window.__ot.framesReady(${JSON.stringify(src)}, ${JSON.stringify(f)})`)
          .catch(() => {});
      frames.frames(src).then(reply, (e: Error) => {
        unframed.add(`${decodeURIComponent(new URL(src, server.url).pathname)} (${e.message})`);
        return reply(null);
      });
    };
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
      bindings: { __otFrames: answer },
    });
    page = b;
    for (const p of asked.splice(0)) answer(p);
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
    /** videos shown by seeking the element, because their frames could not
     *  be decoded — each with the reason */
    unframed: () => [...unframed],
    async shut() {
      await Promise.all([...browsers].map((b) => b.close()));
      await server.close();
      await frames.clean();
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
    total: Math.round((durationS ?? 0) * fps),
    audio,
    blur: opts.blur ?? !at.draft,
    // checked here, before a frame is drawn: a mark the author meant to make
    // and mistyped would otherwise only surface as a defect after the render
    marks: filmMarks(info.marks),
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
    // the screenshots' sRGB values as limited-range BT.709, rounded exactly
    // and named sRGB (see SRGB_TAGS)
    `pad=ceil(iw/2)*2:ceil(ih/2)*2,scale=out_color_matrix=bt709:out_range=tv:flags=accurate_rnd+full_chroma_int,format=yuv420p,${SRGB_TAGS}`,
    "-c:v",
    "libx264",
    "-preset",
    draft ? "veryfast" : "medium",
    "-crf",
    draft ? "23" : "14",
    "-x264-params",
    `keyint=${film.fps * 2}:min-keyint=1:aq-mode=3`,
    ...SRGB_TAG_ARGS,
    "-y",
    out,
  ];
}

/** an encoded piece of the film and how many frames it holds */
export type FilmChunk = { file: string; frames: number };

/** The concat list that joins the chunks: each with its length named, from
 *  the frames before it, so chunk k starts at exactly its first frame's time.
 *  Left to itself the concat demuxer starts a chunk where the one before says
 *  it ends — and an MP4 can say a few ticks short (its edit list is in ms: 89
 *  frames at 60 fps end at 1.483 s, not 1.48333), which put one frame of a
 *  whole render 5 ticks early. The lengths are whole µs (what the demuxer
 *  keeps), rounded from the running total, so their sum never drifts. */
export function chunkList(chunks: readonly FilmChunk[], fps: number): string {
  const us = (n: number) => Math.round((n * 1e6) / fps);
  let before = 0;
  return chunks
    .map((c) => {
      const len = us(before + c.frames) - us(before);
      before += c.frames;
      return `file '${c.file.replace(/'/g, "'\\''")}'\nduration ${(len / 1e6).toFixed(6)}`;
    })
    .join("\n");
}

async function deliver(
  ffmpeg: string,
  chunks: readonly FilmChunk[],
  film: Film,
  out: string,
  tmp: string,
): Promise<void> {
  const list = join(tmp, "chunks.txt");
  await writeFile(list, chunkList(chunks, film.fps));
  await mkdir(dirname(resolve(out)), { recursive: true });
  const durationS = (film.f1 - film.f0) / film.fps;
  const args = ["-v", "error", "-y", "-f", "concat", "-safe", "0", "-i", list];
  if (film.audio) args.push("-ss", String(film.f0 / film.fps), "-i", film.audio);
  args.push("-map", "0:v", "-c:v", "copy");
  if (film.audio)
    args.push("-map", "1:a", "-af", "apad", "-c:a", "aac", "-b:a", "256k", "-ar", "48000");
  const record: FilmRecord = {
    from: film.f0 / film.fps,
    width: film.width,
    height: film.height,
    marks: film.marks,
  };
  args.push("-metadata", `${FILM_TAG}=${JSON.stringify(record)}`);
  // a key of our own is written only with use_metadata_tags
  args.push("-t", durationS.toFixed(6), "-movflags", "+faststart+use_metadata_tags", resolve(out));
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
