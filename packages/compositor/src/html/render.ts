// Parallel frame rendering for the seek page: W headless Chromes, each given
// one CONTIGUOUS slice of the frame list (the images a run of frames shares
// stay decoded in that one page), each frame a `__seek` then a screenshot,
// files numbered by their global position so the encoder reads them in order.
//
// The page's contract (its engine is written elsewhere):
//   window.__ready              — a promise: fonts loaded, first images decoded
//   window.__seek(atS, frameS)  — a promise: the DOM shows scene time `atS`
//                                 (one shutter sample) for the output frame at
//                                 `frameS`, every image it needs decoded
// The renderer awaits nothing else — no rAF, no fonts.ready of its own; the
// spike measured the direct seek→capture path as stable and 20 % faster.
//
// Fail fast: the first error (a `__seek` that throws or never settles, a page
// error, a Chrome that dies) names its frame, stops every other worker, and
// every Chrome is killed with its profile removed before the rejection lands.

import { mkdir, writeFile } from "node:fs/promises";
import { cpus } from "node:os";
import { join } from "node:path";
import { type HtmlBrowser, launchHtmlBrowser } from "./cdp";

export type HtmlFrameTime = {
  /** scene time to show — one motion-blur shutter sample */
  atS: number;
  /** the output frame this sample belongs to */
  frameS: number;
};

export type HtmlRenderStats = {
  /** shots rendered (= `times.length`) */
  frames: number;
  /** Chrome processes used */
  workers: number;
  /** launch, ready, every shot and shutdown, wall clock */
  wallMs: number;
  /** `wallMs / frames`: the throughput across all workers, not one worker's shot time */
  msPerShot: number;
};

export type HtmlRenderOpts = {
  url: string;
  chromePath: string;
  width: number;
  height: number;
  /** one entry per render frame, in output order */
  times: readonly HtmlFrameTime[];
  /** receives %07d.png (or .jpg), numbered by position in `times` */
  outDir: string;
  /** default: min(4, max(1, floor(cpus/2))), never more than `times.length` —
   *  the spike found 4 GPU-composited Chromes saturate one machine (8 were slower) */
  workers?: number;
  /** default png; jpeg roughly halves the per-shot cost (PNG encoding in Chrome dominates) */
  format?: "png" | "jpeg";
  /** jpeg only, default 95 */
  quality?: number;
  onProgress?: (done: number, total: number) => void;
  /** Chrome profile directory prefix (tests use their own to count leftovers) */
  profilePrefix?: string;
  /** per `__seek` / screenshot (also launch, load and `__ready`), default 60 s */
  timeoutMs?: number;
};

/** Awaited once per page before its first seek: the contract's `__ready`, and
 *  a `__seek` to call afterwards — a page without them (a 404 page, the wrong
 *  URL, an engine that never installed) fails here, by name, not per frame. */
export const PAGE_READY_EXPRESSION = `(async () => {
  if (!("__ready" in window))
    throw new Error("window.__ready is missing — is this the render page? (" + location.href + ", title " + JSON.stringify(document.title) + ")");
  await window.__ready;
  if (typeof window.__seek !== "function")
    throw new Error("window.__seek is not a function once __ready resolved (" + location.href + ")");
})()`;

/** min(4, max(1, floor(cpus/2))), capped at the frame count. */
export function defaultHtmlWorkers(frames: number, cpuCount = cpus().length): number {
  return Math.max(0, Math.min(frames, 4, Math.max(1, Math.floor(cpuCount / 2))));
}

/** `total` frames cut into `workers` contiguous [start, end) slices, the
 *  first `total % workers` one frame longer, so every worker gets a run of
 *  neighbouring frames and no worker sits idle while another has two frames
 *  more. Fewer slices than workers only when there are fewer frames. */
export function sliceFrames(total: number, workers: number): Array<[number, number]> {
  const n = Math.max(0, Math.min(total, Math.floor(workers)));
  if (n === 0) return [];
  const base = Math.floor(total / n);
  const extra = total % n;
  const slices: Array<[number, number]> = [];
  let start = 0;
  for (let i = 0; i < n; i++) {
    const end = start + base + (i < extra ? 1 : 0);
    slices.push([start, end]);
    start = end;
  }
  return slices;
}

/** The file name of frame `index`: `%07d.<ext>`. */
export const frameFileName = (index: number, format: "png" | "jpeg" = "png"): string =>
  `${String(index).padStart(7, "0")}.${format === "jpeg" ? "jpg" : "png"}`;

export async function renderHtmlFrames(opts: HtmlRenderOpts): Promise<HtmlRenderStats> {
  const t0 = performance.now();
  const { url, chromePath, width, height, times, outDir } = opts;
  const format = opts.format ?? "png";
  const quality = opts.quality ?? 95;
  const timeoutMs = opts.timeoutMs ?? 60_000;
  if (format !== "png" && format !== "jpeg")
    throw new Error(`html render: format must be png or jpeg, got ${String(format)}`);
  if (!(Number.isFinite(quality) && quality >= 0 && quality <= 100))
    throw new Error(`html render: quality must be 0–100, got ${String(opts.quality)}`);
  for (const [i, t] of times.entries()) {
    if (!(Number.isFinite(t?.atS) && Number.isFinite(t?.frameS)))
      throw new Error(`html render: frame ${i} has a non-finite time (${JSON.stringify(t)})`);
  }

  await mkdir(outDir, { recursive: true });
  const total = times.length;
  const slices = sliceFrames(
    total,
    opts.workers != null ? Math.max(1, opts.workers) : defaultHtmlWorkers(total),
  );
  if (slices.length === 0) return { frames: 0, workers: 0, wallMs: 0, msPerShot: 0 };

  let done = 0;
  let failure: Error | null = null;
  const browsers = new Set<HtmlBrowser>();
  // the first failure wins; closing the other workers' browsers rejects
  // whatever they are waiting on, so they stop within one call, not one slice
  const abort = (error: Error) => {
    if (failure) return;
    failure = error;
    for (const b of browsers) void b.close();
  };

  const runSlice = async (worker: number, [start, end]: [number, number]) => {
    let browser: HtmlBrowser;
    try {
      browser = await launchHtmlBrowser({
        chromePath,
        url,
        width,
        height,
        timeoutMs,
        profilePrefix: opts.profilePrefix,
      });
    } catch (e) {
      abort(
        new Error(`html render: worker ${worker} could not start: ${(e as Error).message}`, {
          cause: e,
        }),
      );
      return;
    }
    browsers.add(browser);
    try {
      if (failure) return;
      try {
        await browser.evaluate(PAGE_READY_EXPRESSION, { awaitPromise: true, timeoutMs });
      } catch (e) {
        throw new Error(`html render: ${url} did not become ready: ${(e as Error).message}`, {
          cause: e,
        });
      }
      for (let i = start; i < end && !failure; i++) {
        const t = times[i]!;
        try {
          await browser.evaluate(
            `(async () => { await window.__seek(${t.atS}, ${t.frameS}); })()`,
            {
              awaitPromise: true,
              timeoutMs,
            },
          );
          const bytes = await browser.screenshot({ format, quality });
          await writeFile(join(outDir, frameFileName(i, format)), bytes);
        } catch (e) {
          throw new Error(
            `html render: frame ${i} (atS ${t.atS}, frameS ${t.frameS}) failed: ${(e as Error).message}`,
            { cause: e },
          );
        }
        done++;
        opts.onProgress?.(done, total);
      }
    } catch (e) {
      abort(e as Error);
    } finally {
      browsers.delete(browser);
      await browser.close();
    }
  };

  await Promise.all(slices.map((slice, worker) => runSlice(worker, slice)));
  if (failure) throw failure;
  const wallMs = performance.now() - t0;
  return { frames: total, workers: slices.length, wallMs, msPerShot: wallMs / total };
}
