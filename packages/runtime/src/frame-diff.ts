// Tier-2 capture annotation: AFTER a capture, diff the recording's frames
// around each action to record what the action actually CHANGED on screen —
// `effectBox` (the changed region, viewport px) and `changeCoverage` (fraction
// of the frame affected). The camera director (compositor/src/camera.ts)
// consumes these to (a) frame the PAYOFF instead of the clicked control when
// the result lands somewhere else, and (b) tell a global repaint (nav /
// restyle → pull out to full view) from a local popover — a bbox alone can't.
//
// This is the pass camera.ts's header defers to "the runtime (node) layer":
// pixels, not DOM. Frame-diff over the kept capture needs no browser hooks,
// works for canvas apps a MutationObserver can't see, and is deterministic
// over the recording (re-runnable on old takes).
//
// Two more readings ride on the same pass, for a film page: WHEN each
// action's result showed (`result` — the input time is not when the payoff
// appears), and how each saved state lines up with the recording at its
// moment (`states.items[].seam`), so a film can cut from video to state
// without a jump.
//
// Failure-tolerant BY CONTRACT: annotation must never fail a take. Any ffmpeg
// error / short read / degenerate window skips that event (fields stay absent
// — the director falls back to its bbox heuristics, exactly the pre-tier-2
// behaviour) and `annotateCaptureLog` never throws.

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import type { BBox, CaptureLog } from "@open-take/compositor";
import { resolveFfmpeg } from "@open-take/compositor";

// Analysis raster: frames are decoded grayscale at ~ANALYSIS_W wide. 16px cells
// on that raster (≈32px at 1080p) are the change unit — coarse enough that
// h264 noise and a blinking caret vanish, fine enough to frame a suggestion
// panel. Bumping ANALYSIS_W raises precision and cost together.
const ANALYSIS_W = 960;
const CELL = 16;
/** min |gray delta| for a pixel to count as changed (h264 noise is ~2–6) */
const PIXEL_DELTA = 16;
/** a cell is "changed" when > this fraction of its pixels changed */
const CELL_FRAC = 0.08;

/** sample the "before" state this long before the action (ms). Kept TIGHT so
 *  everything that happens on the approach — the capture's own
 *  scrollIntoView, hover styles, the previous action's tail — is already
 *  painted and therefore NOT attributed to this action; a click's own effect
 *  can't land within one 60fps frame of the input, so this still precedes it.
 *  (Also < NEXT_CLEARANCE_MS, so adjacent events' windows can never overlap —
 *  no double attribution.) */
const BEFORE_MS = 30;
/** sample the "after" state this long after the action (+durationMs) settles —
 *  catches popover/reveal animations (ms; the capture itself sleeps ~1s
 *  between actions, so there is normally room). */
const SETTLE_MS = 500;
/** third sample this long after the "after" frame: cells STILL changing
 *  between the two are ambient motion (hero video, carousel, streaming text)
 *  — masked out of the action's diff so they can't poison effectBox (ms). */
const AMBIENT_MS = 250;
/** keep this much clearance before the NEXT action so its changes are never
 *  attributed to this one (ms). */
const NEXT_CLEARANCE_MS = 60;
/** changed regions whose boxes sit within this many cells of each other are
 *  one region (a field and the results that open a margin below it); regions
 *  further apart are distinct, so a toolbar button's highlight at the top of
 *  the page and a hint line at the bottom are never boxed together — the
 *  union's centre points at nothing. */
const MERGE_GAP_CELLS = 2;
/** a box-less event (bare press) only gets an effectBox when the change is at
 *  least this big — a blinking terminal cursor must not become a phantom
 *  punch target on an event that used to mean "full view". */
const MIN_NO_BOX_COVERAGE = 0.015;

export type FrameDiffResult = {
  /** fraction of the frame's cells that changed (0..1) — ALL regions */
  coverage: number;
  /** bbox of the DOMINANT changed region (most changed cells; nearest the
   *  anchor on a tie) in ANALYSIS-raster px, or undefined when nothing
   *  beyond isolated specks changed */
  box?: BBox;
  /** every distinct changed region, largest first (raster px), each with its
   *  own share of the frame's cells */
  regions: { box: BBox; coverage: number }[];
};

type Region = { cells: number; x0: number; y0: number; x1: number; y1: number };

/** empty cells between two regions' boxes along the axis they are furthest
 *  apart on (0 when they touch or overlap) */
function regionGap(a: Region, b: Region): number {
  const dx = Math.max(a.x0 - b.x1 - 1, b.x0 - a.x1 - 1, 0);
  const dy = Math.max(a.y0 - b.y1 - 1, b.y0 - a.y1 - 1, 0);
  return Math.max(dx, dy);
}

/** Group kept cells into regions: 8-connected components, then components
 *  whose boxes lie within MERGE_GAP_CELLS of one another are one region. */
function regionsOf(kept: Uint8Array, cw: number, ch: number): Region[] {
  const seen = new Uint8Array(kept.length);
  const regions: Region[] = [];
  for (let start = 0; start < kept.length; start++) {
    if (!kept[start] || seen[start]) continue;
    const region: Region = { cells: 0, x0: cw, y0: ch, x1: -1, y1: -1 };
    const stack = [start];
    seen[start] = 1;
    while (stack.length) {
      const i = stack.pop()!;
      const cx = i % cw;
      const cy = (i - cx) / cw;
      region.cells++;
      if (cx < region.x0) region.x0 = cx;
      if (cy < region.y0) region.y0 = cy;
      if (cx > region.x1) region.x1 = cx;
      if (cy > region.y1) region.y1 = cy;
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          const nx = cx + dx;
          const ny = cy + dy;
          if (nx < 0 || ny < 0 || nx >= cw || ny >= ch) continue;
          const n = ny * cw + nx;
          if (kept[n] && !seen[n]) {
            seen[n] = 1;
            stack.push(n);
          }
        }
    }
    regions.push(region);
  }
  // merge near neighbours until nothing is within reach of anything else
  for (let merged = true; merged; ) {
    merged = false;
    for (let a = 0; a < regions.length && !merged; a++)
      for (let b = a + 1; b < regions.length; b++) {
        const ra = regions[a]!;
        const rb = regions[b]!;
        if (regionGap(ra, rb) > MERGE_GAP_CELLS) continue;
        regions[a] = {
          cells: ra.cells + rb.cells,
          x0: Math.min(ra.x0, rb.x0),
          y0: Math.min(ra.y0, rb.y0),
          x1: Math.max(ra.x1, rb.x1),
          y1: Math.max(ra.y1, rb.y1),
        };
        regions.splice(b, 1);
        merged = true;
        break;
      }
  }
  return regions;
}

/** per-cell changed-pixel counts of |before−after| > PIXEL_DELTA (symmetric —
 *  appearing light-on-dark content matters as much as dark-on-light). */
function cellCounts(a: Uint8Array, b: Uint8Array, w: number, h: number): Uint16Array {
  const cw = Math.ceil(w / CELL);
  const counts = new Uint16Array(cw * Math.ceil(h / CELL));
  for (let y = 0; y < h; y++) {
    const row = y * w;
    const crow = Math.floor(y / CELL) * cw;
    for (let x = 0; x < w; x++) {
      const d = a[row + x]! - b[row + x]!;
      if (d > PIXEL_DELTA || d < -PIXEL_DELTA) counts[crow + Math.floor(x / CELL)]!++;
    }
  }
  return counts;
}

/**
 * Pure diff of two grayscale frames (same w×h). Cell-based: a cell counts as
 * changed when enough of its pixels moved. An isolated changed cell (no
 * changed 8-neighbour) is kept only when it changed OVERWHELMINGLY (≥ half its
 * pixels — a real single-cell payoff like a cart badge), else it's a speck
 * (caret blink, cursor sliver) and is dropped.
 *
 * `ambient` (optional) is a THIRD frame sampled shortly after `after`: any
 * cell still changing between `after` and `ambient` is ambient motion (hero
 * video, carousel, streaming text) and is excluded — without this, one
 * animating region would poison every event's effectBox with its union.
 *
 * `coverage` is the changed-CELL area fraction — the region the action
 * affected — deliberately not the changed-PIXEL fraction: a nav swap between
 * two white-ish pages repaints most of the frame while leaving most PIXELS
 * white-on-white, and it's the affected region the director's pull-out
 * threshold reasons about.
 *
 * `box` is the DOMINANT region, not the union of everything that changed: an
 * action often touches two places at once (the control's own active state
 * plus a hint line or status readout far away), and the union of a top
 * toolbar and a bottom hint is a tall box whose centre sits on empty canvas.
 * The region with the most changed cells is what the action was about; on a
 * tie the one nearest `anchor` (the acted-on element, raster px) wins.
 */
export function diffFrames(
  before: Uint8Array,
  after: Uint8Array,
  w: number,
  h: number,
  ambient?: Uint8Array,
  anchor?: { x: number; y: number },
): FrameDiffResult {
  const cw = Math.ceil(w / CELL);
  const ch = Math.ceil(h / CELL);
  const counts = cellCounts(before, after, w, h);
  const minCount = Math.max(1, Math.floor(CELL * CELL * CELL_FRAC));
  const strongCount = Math.floor(CELL * CELL * 0.5);
  const ambientCounts = ambient ? cellCounts(after, ambient, w, h) : undefined;
  const changed = (cx: number, cy: number): boolean =>
    cx >= 0 &&
    cy >= 0 &&
    cx < cw &&
    cy < ch &&
    counts[cy * cw + cx]! >= minCount &&
    (!ambientCounts || ambientCounts[cy * cw + cx]! < minCount);

  const kept = new Uint8Array(cw * ch);
  let keptCount = 0;
  for (let cy = 0; cy < ch; cy++) {
    for (let cx = 0; cx < cw; cx++) {
      if (!changed(cx, cy)) continue;
      let neighbour = counts[cy * cw + cx]! >= strongCount; // strong cells stand alone
      for (let dy = -1; dy <= 1 && !neighbour; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dy === 0) continue;
          if (changed(cx + dx, cy + dy)) {
            neighbour = true;
            break;
          }
        }
      if (!neighbour) continue; // isolated speck
      kept[cy * cw + cx] = 1;
      keptCount++;
    }
  }
  if (keptCount === 0) return { coverage: 0, regions: [] };

  const toBox = (r: Region): BBox => ({
    x: r.x0 * CELL,
    y: r.y0 * CELL,
    w: Math.min((r.x1 + 1) * CELL, w) - r.x0 * CELL,
    h: Math.min((r.y1 + 1) * CELL, h) - r.y0 * CELL,
  });
  const distToAnchor = (r: Region): number => {
    if (!anchor) return 0;
    const b = toBox(r);
    return Math.hypot(b.x + b.w / 2 - anchor.x, b.y + b.h / 2 - anchor.y);
  };
  const regions = regionsOf(kept, cw, ch).sort(
    (a, b) => b.cells - a.cells || distToAnchor(a) - distToAnchor(b),
  );
  return {
    coverage: keptCount / (cw * ch),
    box: toBox(regions[0]!),
    regions: regions.map((r) => ({ box: toBox(r), coverage: r.cells / (cw * ch) })),
  };
}

/** Decode ONE grayscale frame at time `tSec` from `videoPath`, scaled to
 *  aw×ah. Resolves undefined on any failure (missing frame near EOF, etc.). */
function grabFrame(
  bin: string,
  videoPath: string,
  tSec: number,
  aw: number,
  ah: number,
): Promise<Uint8Array | undefined> {
  return new Promise((res) => {
    const args = [
      "-v",
      "error",
      "-ss",
      tSec.toFixed(3),
      "-i",
      videoPath,
      "-frames:v",
      "1",
      "-vf",
      `scale=${aw}:${ah}`,
      "-f",
      "rawvideo",
      "-pix_fmt",
      "gray",
      "-",
    ];
    const c = spawn(bin, args, { stdio: ["ignore", "pipe", "ignore"] });
    const chunks: Buffer[] = [];
    c.stdout.on("data", (b: Buffer) => chunks.push(b));
    c.on("error", () => res(undefined));
    c.on("close", () => {
      const buf = Buffer.concat(chunks);
      res(buf.length === aw * ah ? new Uint8Array(buf) : undefined);
    });
  });
}

export type AnnotateOpts = {
  /** explicit ffmpeg binary; resolved via the compositor's resolver if omitted */
  ffmpegBin?: string;
  logProgress?: boolean;
};

/**
 * Annotate a capture log with per-event `effectBox` + `changeCoverage` by
 * diffing the capture video around each action. Returns a NEW log (input
 * untouched); events whose diff fails or whose sample window is degenerate are
 * returned unchanged. Never throws.
 */
export async function annotateCaptureLog(
  log: CaptureLog,
  videoPath: string,
  opts: AnnotateOpts = {},
): Promise<CaptureLog> {
  try {
    const bin = opts.ffmpegBin ?? (await resolveFfmpeg());
    const vW = log.video.width;
    const vH = log.video.height;
    if (!(vW > 0) || !(vH > 0)) return log;
    const aw = Math.min(ANALYSIS_W, vW);
    const ah = Math.max(CELL, Math.round((vH * aw) / vW));
    // map analysis-raster px → viewport CSS px (what effectBox is declared in)
    const mx = log.viewport.w / aw;
    const my = log.viewport.h / ah;
    const durS = log.video.durationS ?? (log.tEndMs != null ? log.tEndMs / 1000 : undefined);

    const events = [...log.events];
    for (let i = 0; i < events.length; i++) {
      const e = events[i]!;
      // a look DID nothing — any frame diff across its window is the page's
      // own ambient motion (a ticking number, a map animating), and an
      // effectBox made of that noise would out-vote the author's named target
      // in the camera director. The captured box is the whole truth here.
      if (e.kind === "look") continue;
      const durationMs = "durationMs" in e && e.durationMs != null ? e.durationMs : 0;
      const before = Math.max(0, (e.tMs - BEFORE_MS) / 1000);
      let after = (e.tMs + durationMs + SETTLE_MS) / 1000;
      const next = events[i + 1];
      const ceil = Math.min(
        next ? (next.tMs - NEXT_CLEARANCE_MS) / 1000 : Number.POSITIVE_INFINITY,
        // never sample past the recording's end (the last frame would repeat —
        // fine — but a seek past EOF returns nothing)
        durS != null ? Math.max(0, durS - 0.05) : Number.POSITIVE_INFINITY,
      );
      after = Math.min(after, ceil);
      if (after <= before + 0.05) continue; // degenerate window — skip
      // ambient sample: only when it fits before the next action / EOF —
      // without room we go unmasked rather than sample another event's effect
      const ambientT = after + AMBIENT_MS / 1000;
      const wantAmbient = ambientT <= ceil;
      const [fa, fb, fc] = await Promise.all([
        grabFrame(bin, videoPath, before, aw, ah),
        grabFrame(bin, videoPath, after, aw, ah),
        wantAmbient ? grabFrame(bin, videoPath, ambientT, aw, ah) : Promise.resolve(undefined),
      ]);
      if (!fa || !fb) continue;
      const box = "box" in e && e.box != null ? e.box : undefined;
      const anchor = box ? { x: (box.x + box.w / 2) / mx, y: (box.y + box.h / 2) / my } : undefined;
      const d = diffFrames(fa, fb, aw, ah, fc, anchor);
      // a box-less event (bare press) only gets an effectBox for a substantial
      // change — else a blinking cursor becomes a phantom punch target. Judged
      // on the region that would BE the box, not the frame's total: three
      // scattered slivers add up without any one of them being a target.
      const attachBox = d.box && (box || (d.regions[0]?.coverage ?? 0) >= MIN_NO_BOX_COVERAGE);
      // when the result showed: looked for up to the next action, not just
      // the half second the effect box is read at — a slow one lands later
      const result = await measureResult(bin, videoPath, e, ceil * 1000, aw, ah, mx, my, fa);
      events[i] = {
        ...e,
        ...(result ? { result } : {}),
        changeCoverage: Math.round(d.coverage * 1000) / 1000,
        ...(attachBox && d.box
          ? {
              effectBox: {
                x: Math.round(d.box.x * mx),
                y: Math.round(d.box.y * my),
                w: Math.round(d.box.w * mx),
                h: Math.round(d.box.h * my),
              },
            }
          : {}),
      };
      if (opts.logProgress) {
        const eb = events[i]!.effectBox;
        // coverage 0 is sub-THRESHOLD, not proof of a dead beat: a 1px outline
        // or low-opacity highlight diffs below the noise floor and is often
        // visually fine — point the reader at the frames, not the number.
        const subThreshold =
          events[i]!.changeCoverage === 0 && !eb
            ? " (sub-threshold — a subtle effect can score 0; judge by frames)"
            : "";
        process.stderr.write(
          `frame-diff [${i}] ${e.kind ?? "click"}@${e.tMs}ms coverage=${events[i]!.changeCoverage}${
            eb ? ` effect=(${eb.x},${eb.y} ${eb.w}x${eb.h})` : ""
          }${
            eb && d.regions.length > 1
              ? ` (+${d.regions.length - 1} smaller region${d.regions.length > 2 ? "s" : ""} elsewhere)`
              : ""
          }${subThreshold}${
            events[i]!.result
              ? ` result +${events[i]!.result!.atMs - e.tMs}ms (done +${events[i]!.result!.doneMs - e.tMs}ms)`
              : ""
          }\n`,
        );
      }
    }
    const annotated = { ...log, events };
    return log.states
      ? await measureStateSeams(annotated, videoPath, join(dirname(videoPath), log.states.dir), {
          ffmpegBin: bin,
        })
      : annotated;
  } catch {
    return log; // annotation must never fail a take
  }
}

// --- when the result became visible ------------------------------------------
//
// The input time (`tMs`) is when the capture clicked; what a film cuts on is
// when the RESULT showed — a recalculated number can land a second later.
// So, per action: the dominant region that changed between just before the
// input and just before the next action, then every frame of that window,
// cropped to the region, read for how much of the final change it shows.

/** how long after an action (+durationMs) its result is looked for (ms) —
 *  bounded so one beat with a long wait cannot decode the whole recording */
const RESULT_MAX_MS = 4000;
/** "the result shows": this share of the pixels that finally changed has changed */
const RESULT_AT_FRAC = 0.5;
/** "the result is done": from here on this share of them looks as they end up */
const RESULT_DONE_FRAC = 0.9;
/** a pixel counts as part of the result when it changed by more than this
 *  grey level. Well above PIXEL_DELTA on purpose: an encoder refining a
 *  still page (a new keyframe, measured on a real take) moves hundreds of
 *  text-edge pixels by 16–40 levels and almost none past 64, while a real
 *  change moves them by far more. */
const RESULT_DELTA = 48;
/** fewer result pixels than this is not a result */
const RESULT_MIN_PX = 12;

/** two frames whose plain difference is only the pixels that changed by more
 *  than RESULT_DELTA — what diffFrames should group into regions when
 *  compression noise must not count */
function strongPair(a: Uint8Array, b: Uint8Array): [Uint8Array, Uint8Array] {
  const blank = new Uint8Array(a.length);
  const mask = new Uint8Array(a.length);
  for (let i = 0; i < a.length; i++) {
    const d = a[i]! - b[i]!;
    if (d > RESULT_DELTA || d < -RESULT_DELTA) mask[i] = 255;
  }
  return [blank, mask];
}

/**
 * Pure: in frames of one region over time (first = just before the input,
 * last = how it ends up), the first frame showing at least half of the final
 * change (`at`) and the first from which the region stays as it ends up
 * (`done`), as frame indices. Only pixels that changed by more than
 * RESULT_DELTA count. Null when the first and last frames are alike.
 */
export function resultFrames(frames: Uint8Array[]): { at: number; done: number } | null {
  if (frames.length < 2) return null;
  const first = frames[0]!;
  const last = frames[frames.length - 1]!;
  const changed: number[] = [];
  for (let i = 0; i < first.length; i++) {
    const d = first[i]! - last[i]!;
    if (d > RESULT_DELTA || d < -RESULT_DELTA) changed.push(i);
  }
  if (changed.length < RESULT_MIN_PX) return null;
  const half = RESULT_DELTA / 2;
  let at = -1;
  const settled: boolean[] = [];
  for (const f of frames) {
    let shown = 0;
    let alike = 0;
    for (const i of changed) {
      const fromFirst = f[i]! - first[i]!;
      const fromLast = f[i]! - last[i]!;
      if (fromFirst > half || fromFirst < -half) shown++;
      if (fromLast <= half && fromLast >= -half) alike++;
    }
    if (at < 0 && shown / changed.length >= RESULT_AT_FRAC) at = settled.length;
    settled.push(alike / changed.length >= RESULT_DONE_FRAC);
  }
  let done = frames.length - 1;
  for (let k = frames.length - 1; k >= 0 && settled[k]; k--) done = k;
  if (at < 0) at = frames.length - 1;
  return { at, done: Math.max(at, done) };
}

/** Every frame of [fromS, toS) of `videoPath`, scaled to aw×ah and cropped to
 *  `crop` (raster px), grayscale, with each frame's time (s). Undefined on any
 *  failure. */
function decodeWindow(
  bin: string,
  videoPath: string,
  fromS: number,
  toS: number,
  aw: number,
  ah: number,
  crop: BBox,
): Promise<{ frames: Uint8Array[]; times: number[] } | undefined> {
  return new Promise((res) => {
    const size = crop.w * crop.h;
    const args = [
      "-hide_banner",
      "-nostats",
      "-loglevel",
      "info",
      "-ss",
      fromS.toFixed(3),
      "-t",
      Math.max(0.001, toS - fromS).toFixed(3),
      "-i",
      videoPath,
      "-vf",
      `scale=${aw}:${ah},crop=${crop.w}:${crop.h}:${crop.x}:${crop.y},showinfo`,
      "-fps_mode",
      "passthrough",
      "-f",
      "rawvideo",
      "-pix_fmt",
      "gray",
      "-",
    ];
    const c = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
    const chunks: Buffer[] = [];
    let err = "";
    c.stdout.on("data", (b: Buffer) => chunks.push(b));
    c.stderr.on("data", (b: Buffer) => {
      err += b.toString();
    });
    c.on("error", () => res(undefined));
    c.on("close", (code) => {
      if (code !== 0) return res(undefined);
      const buf = Buffer.concat(chunks);
      // showinfo's pts_time counts from the seek point
      const times = [...err.matchAll(/pts_time:\s*([-\d.e]+)/g)].map((m) => fromS + Number(m[1]));
      const count = Math.floor(buf.length / size);
      if (!count || times.length < count) return res(undefined);
      const frames: Uint8Array[] = [];
      for (let k = 0; k < count; k++)
        frames.push(new Uint8Array(buf.subarray(k * size, (k + 1) * size)));
      res({ frames, times: times.slice(0, count) });
    });
  });
}

/** When the result of `e` showed (see CaptureEventBase.result), or undefined. */
async function measureResult(
  bin: string,
  videoPath: string,
  e: CaptureLog["events"][number],
  untilMs: number,
  aw: number,
  ah: number,
  mx: number,
  my: number,
  before: Uint8Array,
): Promise<CaptureLog["events"][number]["result"]> {
  const durationMs = "durationMs" in e && e.durationMs != null ? e.durationMs : 0;
  const fromS = Math.max(0, (e.tMs - BEFORE_MS) / 1000);
  const toS = Math.min(untilMs, e.tMs + durationMs + RESULT_MAX_MS) / 1000;
  if (toS <= fromS + 0.05) return undefined;
  const end = await grabFrame(bin, videoPath, toS, aw, ah);
  if (!end) return undefined;
  const box = "box" in e && e.box != null ? e.box : undefined;
  const anchor = box ? { x: (box.x + box.w / 2) / mx, y: (box.y + box.h / 2) / my } : undefined;
  const [blank, strong] = strongPair(before, end);
  const d = diffFrames(blank, strong, aw, ah, undefined, anchor);
  if (!d.box) return undefined;
  if (!box && (d.regions[0]?.coverage ?? 0) < MIN_NO_BOX_COVERAGE) return undefined;
  // The capture puts the pointer on the control WITH the press and leaves it
  // parked there until the next action, so the control's own hover / pressed
  // look changes at the input and stays — feedback, not the payoff (measured
  // on a fixture: a dark hover read as a "result" at +2 ms while the number
  // landed 1.2 s later). A change elsewhere comes first; the control's own
  // only when nothing else changed (a toggle, a checkbox, typed text).
  const ctl = box && { x: box.x / mx, y: box.y / my, w: box.w / mx, h: box.h / my };
  const apart = (b: BBox) =>
    !ctl ||
    b.x >= ctl.x + ctl.w ||
    ctl.x >= b.x + b.w ||
    b.y >= ctl.y + ctl.h ||
    ctl.y >= b.y + b.h;
  const region = d.regions.find((g) => apart(g.box))?.box ?? d.box;
  // the window runs one frame past `toS` so its last frame is the one diffed
  const win = await decodeWindow(bin, videoPath, fromS, toS + 0.02, aw, ah, region);
  if (!win) return undefined;
  const r = resultFrames(win.frames);
  if (!r) return undefined;
  const atMs = Math.round(win.times[r.at]! * 1000);
  // a change already under way before the input is not its result
  if (atMs < e.tMs) return undefined;
  return {
    atMs,
    doneMs: Math.round(win.times[r.done]! * 1000),
    box: {
      x: Math.round(region.x * mx),
      y: Math.round(region.y * my),
      w: Math.round(region.w * mx),
      h: Math.round(region.h * my),
    },
  };
}

// --- recording ↔ saved state ---------------------------------------------------
//
// A film that cuts from the recording to a saved state of the same moment
// (to push in crisp, or lift a part out) needs the two to line up. They
// should — same viewport, same scroll — but that is checked, not assumed: the
// recording's frame at the state's time against the state's reference
// screenshot, the best shift between them and what is left at that shift.

/** how far (CSS px) the search for the best shift reaches */
const SEAM_REACH = 12;

/** mean |a−b| over the part of a w×h frame both cover when b is shifted by
 *  (dx, dy), leaving out `margin` px at every edge */
function meanDiffAt(
  a: Uint8Array,
  b: Uint8Array,
  w: number,
  h: number,
  dx: number,
  dy: number,
  margin: number,
  step = 1,
): number {
  let sum = 0;
  let n = 0;
  for (let y = margin; y < h - margin; y += step) {
    const ya = y * w;
    const yb = (y - dy) * w;
    for (let x = margin; x < w - margin; x += step) {
      const d = a[ya + x]! - b[yb + x - dx]!;
      sum += d < 0 ? -d : d;
      n++;
    }
  }
  return n ? sum / n : 255;
}

/** the minimum of a parabola through three samples at −1, 0, +1, as an offset */
const vertex = (l: number, c: number, r: number) => {
  const den = l - 2 * c + r;
  return den > 0 ? Math.max(-0.5, Math.min(0.5, (l - r) / (2 * den))) : 0;
};

/**
 * Pure: where `state` (a w×h grey frame) sits in `video` (same size): the
 * shift (dx, dy) in px — a state point p shows at p + (dx, dy) — found
 * coarse (every 2 px over ±reach) then fine (±1 px, sub-pixel by a parabola),
 * with the mean difference and the share of pixels still differing by more
 * than RESULT_DELTA at the nearest whole shift.
 */
export function alignFrames(
  video: Uint8Array,
  state: Uint8Array,
  w: number,
  h: number,
  reach = SEAM_REACH,
): { dx: number; dy: number; meanDiff: number; diffFrac: number } {
  const margin = reach + 2;
  let bx = 0;
  let by = 0;
  // coarse: every other shift, every other pixel
  let coarse = meanDiffAt(video, state, w, h, 0, 0, margin, 2);
  for (let dy = -reach; dy <= reach; dy += 2)
    for (let dx = -reach; dx <= reach; dx += 2) {
      const m = meanDiffAt(video, state, w, h, dx, dy, margin, 2);
      if (m < coarse - 1e-9) [coarse, bx, by] = [m, dx, dy];
    }
  let best = meanDiffAt(video, state, w, h, bx, by, margin);
  for (let moved = true; moved; ) {
    moved = false;
    for (const [dx, dy] of [
      [bx - 1, by],
      [bx + 1, by],
      [bx, by - 1],
      [bx, by + 1],
    ] as const) {
      if (Math.abs(dx) > reach + 1 || Math.abs(dy) > reach + 1) continue;
      const m = meanDiffAt(video, state, w, h, dx, dy, margin);
      if (m < best - 1e-9) {
        [best, bx, by] = [m, dx, dy];
        moved = true;
      }
    }
  }
  const at = (dx: number, dy: number) => meanDiffAt(video, state, w, h, dx, dy, margin);
  const sx = vertex(at(bx - 1, by), best, at(bx + 1, by));
  const sy = vertex(at(bx, by - 1), best, at(bx, by + 1));
  // pixels still differing clearly at the whole shift (compression and text
  // antialiasing stay under RESULT_DELTA — see there)
  let differ = 0;
  let total = 0;
  for (let y = margin; y < h - margin; y++)
    for (let x = margin; x < w - margin; x++) {
      const d = video[y * w + x]! - state[(y - by) * w + x - bx]!;
      if (d > RESULT_DELTA || d < -RESULT_DELTA) differ++;
      total++;
    }
  const round = (v: number, k: number) => Math.round(v * k) / k;
  return {
    dx: round(bx + sx, 100),
    dy: round(by + sy, 100),
    meanDiff: round(best, 100),
    diffFrac: round(total ? differ / total : 1, 10000),
  };
}

/** Grey pixels of a still image (the state's live.png), scaled to w×h. */
const grabImage = (bin: string, file: string, w: number, h: number) =>
  grabFrame(bin, file, 0, w, h);

/**
 * Each saved state's `seam` (see CaptureLog.states): the recording's frame at
 * the state's time against the state's `live.png`, at the viewport's CSS
 * size. A state without its screenshot, or a frame that cannot be read, is
 * left as it was. Never throws.
 */
export async function measureStateSeams(
  log: CaptureLog,
  videoPath: string,
  statesDir: string,
  opts: { ffmpegBin?: string } = {},
): Promise<CaptureLog> {
  try {
    if (!log.states?.items.length) return log;
    const bin = opts.ffmpegBin ?? (await resolveFfmpeg());
    const w = log.viewport.w;
    const h = log.viewport.h;
    if (!(w > 0) || !(h > 0)) return log;
    const items = [];
    for (const item of log.states.items) {
      const live = join(statesDir, item.id, "live.png");
      if (item.moving || !existsSync(live)) {
        items.push(item);
        continue;
      }
      const [v, s] = await Promise.all([
        grabFrame(bin, videoPath, item.tMs / 1000, w, h),
        grabImage(bin, live, w, h),
      ]);
      items.push(v && s ? { ...item, seam: alignFrames(v, s, w, h) } : item);
    }
    return { ...log, states: { ...log.states, items } };
  } catch {
    return log;
  }
}

/**
 * Re-read a kept take's recording for the readings above — each action's
 * `result` and each state's `seam` (plus the effect boxes, recomputed the
 * same way) — and write them into its capture.json. For takes made before
 * they were recorded; `settledMs` comes from the live page and cannot be
 * added afterwards. Returns what changed, in counts.
 */
export async function measureTake(
  takeDir: string,
  opts: AnnotateOpts = {},
): Promise<{ results: number; actions: number; seams: number; states: number }> {
  const { readFile, writeFile } = await import("node:fs/promises");
  const logPath = join(takeDir, "capture.json");
  const video = join(takeDir, "capture.mp4");
  if (!existsSync(logPath) || !existsSync(video))
    throw new Error(`no recording at ${takeDir} (capture.json and capture.mp4 are needed)`);
  const log = JSON.parse(await readFile(logPath, "utf8")) as CaptureLog;
  const out = await annotateCaptureLog(log, video, opts);
  await writeFile(logPath, JSON.stringify(out, null, 2));
  const saved = out.states?.items.filter((s) => !s.moving) ?? [];
  return {
    results: out.events.filter((e) => e.result).length,
    actions: out.events.length,
    seams: saved.filter((s) => s.seam).length,
    states: saved.length,
  };
}
