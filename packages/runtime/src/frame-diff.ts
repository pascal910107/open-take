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
// Failure-tolerant BY CONTRACT: annotation must never fail a take. Any ffmpeg
// error / short read / degenerate window skips that event (fields stay absent
// — the director falls back to its bbox heuristics, exactly the pre-tier-2
// behaviour) and `annotateCaptureLog` never throws.

import { spawn } from "node:child_process";
import { resolveFfmpeg } from "@open-take/compositor";
import type { BBox, CaptureLog } from "@open-take/compositor";

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
/** a box-less event (bare press) only gets an effectBox when the change is at
 *  least this big — a blinking terminal cursor must not become a phantom
 *  punch target on an event that used to mean "full view". */
const MIN_NO_BOX_COVERAGE = 0.015;

export type FrameDiffResult = {
  /** fraction of the frame's cells that changed (0..1) */
  coverage: number;
  /** bbox of the changed region in ANALYSIS-raster px, or undefined when
   *  nothing beyond isolated specks changed */
  box?: BBox;
};

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
 */
export function diffFrames(
  before: Uint8Array,
  after: Uint8Array,
  w: number,
  h: number,
  ambient?: Uint8Array,
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

  let kept = 0;
  let x0 = cw;
  let y0 = ch;
  let x1 = -1;
  let y1 = -1;
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
      kept++;
      if (cx < x0) x0 = cx;
      if (cy < y0) y0 = cy;
      if (cx > x1) x1 = cx;
      if (cy > y1) y1 = cy;
    }
  }
  if (kept === 0) return { coverage: 0 };
  return {
    coverage: kept / (cw * ch),
    box: {
      x: x0 * CELL,
      y: y0 * CELL,
      w: Math.min((x1 + 1) * CELL, w) - x0 * CELL,
      h: Math.min((y1 + 1) * CELL, h) - y0 * CELL,
    },
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
      const d = diffFrames(fa, fb, aw, ah, fc);
      // a box-less event (bare press) only gets an effectBox for a substantial
      // change — else a blinking cursor becomes a phantom punch target
      const hasBox = "box" in e && e.box != null;
      const attachBox = d.box && (hasBox || d.coverage >= MIN_NO_BOX_COVERAGE);
      events[i] = {
        ...e,
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
        process.stderr.write(
          `frame-diff [${i}] ${e.kind ?? "click"}@${e.tMs}ms coverage=${events[i]!.changeCoverage}${
            eb ? ` effect=(${eb.x},${eb.y} ${eb.w}x${eb.h})` : ""
          }\n`,
        );
      }
    }
    return { ...log, events };
  } catch {
    return log; // annotation must never fail a take
  }
}
