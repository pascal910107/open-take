// `open-take film probe`: a finished film's picture as information the author
// can read — how much the picture changes each frame, where it holds still,
// where it cuts and how long each shot runs, how the cut density moves over
// the film, what each big change of picture carries across (a region that
// stays or moves on, only the background, nothing), how far each cut sits
// from the nearest sound onset next to what chance would give, and, when the
// page declared where its subjects are, when one leaves the frame. Laid out
// on the same ruler as `film sheet` and `film listen`. Every line says
// whether it was measured, is an estimate, or was not found. Nothing is
// graded: no score, no target, no pass line.
//
// The picture is read once, as a small grey copy (192 px wide, every frame),
// and everything is plain arithmetic on it here; the sound's onsets are
// `film listen`'s.

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { resolveFfmpeg, resolveFfprobe, runTool } from "../ffmpeg";
import { launchHtmlBrowser } from "../html/cdp";
import {
  chanceWithin,
  LISTEN_RATE,
  nearestOffset,
  onsetStrength,
  parseFilmEvents,
  pickOnsets,
  spectrum,
} from "./listen";
import {
  type Box,
  type FrameText,
  gridCover,
  type PageTextSample,
  PHONE_W,
  readFrameText,
  readPageText,
} from "./probe-text";
import { FILM_TAG } from "./render";

// --- the picture as grey frames --------------------------------------------------------

/** every frame of a film as 8-bit grey, `w`×`h`, one after another */
export type GreyFrames = {
  w: number;
  h: number;
  fps: number;
  count: number;
  data: Uint8Array;
  /** the film time (s) of frame 0 — a stream can start after the sound does */
  t0?: number;
};

/** the film time (s) of frame i */
export const frameTime = (g: Pick<GreyFrames, "fps" | "t0">, i: number) => (g.t0 ?? 0) + i / g.fps;

export const PROBE_W = 192;
const BLOCK = 8;
/** a block whose grey varies less than this (std, 0..255) is flat: background */
const FLAT_STD = 5;
/** a block whose mean difference is under this (0..255) has not changed */
const SAME_BLOCK = 8;

const frameAt = (g: GreyFrames, i: number) => g.data.subarray(i * g.w * g.h, (i + 1) * g.w * g.h);

/** how much the picture changes into each frame: the mean absolute grey
 *  difference from the frame before, 0..1 (frame 0 is 0) */
export function frameEnergy(g: GreyFrames): Float32Array {
  const n = g.w * g.h;
  const e = new Float32Array(g.count);
  for (let i = 1; i < g.count; i++) {
    const a = frameAt(g, i - 1);
    const b = frameAt(g, i);
    let s = 0;
    for (let k = 0; k < n; k++) s += Math.abs(a[k]! - b[k]!);
    e[i] = s / n / 255;
  }
  return e;
}

type Blocks = { bx: number; by: number };
const blocksOf = (g: GreyFrames): Blocks => ({
  bx: Math.floor(g.w / BLOCK),
  by: Math.floor(g.h / BLOCK),
});

/** per block: mean and standard deviation of the grey */
function blockStats(g: GreyFrames, f: Uint8Array): { mean: Float32Array; std: Float32Array } {
  const { bx, by } = blocksOf(g);
  const mean = new Float32Array(bx * by);
  const std = new Float32Array(bx * by);
  for (let y = 0; y < by; y++)
    for (let x = 0; x < bx; x++) {
      let s = 0;
      let sq = 0;
      for (let r = 0; r < BLOCK; r++) {
        const row = (y * BLOCK + r) * g.w + x * BLOCK;
        for (let c = 0; c < BLOCK; c++) {
          const v = f[row + c]!;
          s += v;
          sq += v * v;
        }
      }
      const m = s / (BLOCK * BLOCK);
      mean[y * bx + x] = m;
      std[y * bx + x] = Math.sqrt(Math.max(0, sq / (BLOCK * BLOCK) - m * m));
    }
  return { mean, std };
}

/** per block: the mean absolute grey difference between two frames (0..255) */
function blockDiff(g: GreyFrames, a: Uint8Array, b: Uint8Array): Float32Array {
  const { bx, by } = blocksOf(g);
  const d = new Float32Array(bx * by);
  for (let y = 0; y < by; y++)
    for (let x = 0; x < bx; x++) {
      let s = 0;
      for (let r = 0; r < BLOCK; r++) {
        const row = (y * BLOCK + r) * g.w + x * BLOCK;
        for (let c = 0; c < BLOCK; c++) s += Math.abs(a[row + c]! - b[row + c]!);
      }
      d[y * bx + x] = s / (BLOCK * BLOCK);
    }
  return d;
}

/** the share of blocks that changed between two frames */
function changedShare(g: GreyFrames, a: Uint8Array, b: Uint8Array, over = 12): number {
  const d = blockDiff(g, a, b);
  let n = 0;
  for (const v of d) if (v > over) n++;
  return n / d.length;
}

// --- cuts, stills -----------------------------------------------------------------------

/** frame indices where the picture jumps in one frame: a frame whose change
 *  stands far over the change around it (2.5× the second-largest of the four
 *  frames on each side, so a one-frame flash still shows as its two cuts) and
 *  that changes a fair share of the picture (≥ 12 % of its blocks) */
export function findCuts(g: GreyFrames, energy: Float32Array): number[] {
  const out: number[] = [];
  for (let i = 1; i < g.count; i++) {
    const e = energy[i]!;
    if (e < 0.01) continue;
    const near: number[] = [];
    for (let k = i - 4; k <= i + 4; k++)
      if (k !== i && k >= 1 && k < g.count) near.push(energy[k]!);
    near.sort((a, b) => b - a);
    const ref = near[1] ?? 0;
    if (e < 2.5 * ref) continue;
    if (changedShare(g, frameAt(g, i - 1), frameAt(g, i)) < 0.12) continue;
    out.push(i);
  }
  return out;
}

/** one-frame jumps too small for a cut: a frame whose change stands as far
 *  over the change around it as a cut's does, but that changes only 2–12 % of
 *  the frame's blocks — a word, a number or a panel swapped inside a picture
 *  that holds. `cuts` are left out. */
export function findSmallSwaps(
  g: GreyFrames,
  energy: Float32Array,
  cuts: readonly number[],
): { frame: number; changed: number }[] {
  const out: { frame: number; changed: number }[] = [];
  const isCut = new Set(cuts);
  for (let i = 1; i < g.count; i++) {
    if (isCut.has(i)) continue;
    const e = energy[i]!;
    if (e < 0.002) continue;
    const near: number[] = [];
    for (let k = i - 4; k <= i + 4; k++)
      if (k !== i && k >= 1 && k < g.count) near.push(energy[k]!);
    near.sort((a, b) => b - a);
    if (e < 2.5 * (near[1] ?? 0)) continue;
    const share = changedShare(g, frameAt(g, i - 1), frameAt(g, i));
    if (share < 0.02 || share >= 0.12) continue;
    out.push({ frame: i, changed: share });
  }
  return out;
}

/** stretches where the picture does not change (every frame's change under
 *  `under`, 0..1) for at least `minS` seconds, as frame ranges [a, b) */
export function findStills(
  energy: Float32Array,
  fps: number,
  minS = 0.5,
  under = 0.0015,
): { a: number; b: number }[] {
  const out: { a: number; b: number }[] = [];
  let a: number | null = null;
  for (let i = 1; i <= energy.length; i++) {
    const still = i < energy.length && energy[i]! < under;
    if (still && a == null) a = i - 1;
    else if (!still && a != null) {
      if ((i - a) / fps >= minS) out.push({ a, b: i });
      a = null;
    }
  }
  return out;
}

/** cuts per bin of `binS` seconds over the film */
export function cutDensity(cuts: readonly number[], duration: number, binS = 5): number[] {
  const bins = new Array<number>(Math.max(1, Math.ceil(duration / binS - 1e-9))).fill(0);
  for (const t of cuts) bins[Math.min(bins.length - 1, Math.floor(t / binS))]!++;
  return bins;
}

// --- big changes of picture and what they carry across ----------------------------------

export type CarryKind = "carried" | "background only" | "nothing carried";
export type ChangeKind = "hard cut" | CarryKind;

export type PictureChange = {
  /** the frame the new picture is complete at (a cut: its first frame) */
  frame: number;
  t: number;
  kind: ChangeKind;
  /** what crosses the change, cut or not */
  across: CarryKind;
  /** the frames compared: the last before the change, the first after it */
  before: number;
  after: number;
  /** share of the frame's blocks that changed between before and after */
  changed: number;
  /** share of the frame (blocks) with texture that stays in place */
  stays: number;
  /** share of the frame with texture that is followed from before to after,
   *  in place or moving (each step a small search; a cut: one wider search) */
  carried: number;
  /** share of the frame that is flat in both and keeps its grey: background */
  background: number;
  /** where the carried blocks went on average, in % of the frame's width/height */
  shift: { x: number; y: number } | null;
};

/** what this tool calls a cut to a new picture: half the frame changes */
const NEW_PICTURE = 0.5;
/** what this tool calls a large carried region: a tenth of the frame */
const CARRIED_SHARE = 0.1;
/** what it calls a kept background: a quarter of the frame */
const BACKGROUND_SHARE = 0.25;

/** the grey's standard deviation in the block at (x, y) */
function patchStd(g: GreyFrames, f: Uint8Array, x: number, y: number): number {
  let s = 0;
  let sq = 0;
  for (let r = 0; r < BLOCK; r++)
    for (let c = 0; c < BLOCK; c++) {
      const v = f[(y + r) * g.w + x + c]!;
      s += v;
      sq += v * v;
    }
  const m = s / (BLOCK * BLOCK);
  return Math.sqrt(Math.max(0, sq / (BLOCK * BLOCK) - m * m));
}

/** the frame shrunk by `f` in each direction (box average) */
function shrink(
  g: GreyFrames,
  fr: Uint8Array,
  f: number,
): { w: number; h: number; px: Float32Array } {
  const w = Math.floor(g.w / f);
  const h = Math.floor(g.h / f);
  const px = new Float32Array(w * h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      let s = 0;
      for (let r = 0; r < f; r++)
        for (let c = 0; c < f; c++) s += fr[(y * f + r) * g.w + x * f + c]!;
      px[y * w + x] = s / (f * f);
    }
  return { w, h, px };
}

/** how the whole picture moved from frame `a` to frame `b`: a scale about the
 *  frame's centre and a shift (px of the grey copy), p' = c + s·(p − c) + t,
 *  searched on a quarter-size copy (scales 0.88–1.13, shifts up to a quarter
 *  of the width, around `around` when given); a still picture, or two that
 *  no motion lays together (fitting under 70 % of the difference left with
 *  none), is { s: 1, x: 0, y: 0 } */
export function globalMotion(
  g: GreyFrames,
  a: Uint8Array,
  b: Uint8Array,
  around: { x: number; y: number } = { x: 0, y: 0 },
): { s: number; x: number; y: number } {
  const F = 4;
  const A = shrink(g, a, F);
  const B = shrink(g, b, F);
  const R = Math.max(2, Math.round(A.w / 4));
  const cx = A.w / 2;
  const cy = A.h / 2;
  let best = Number.POSITIVE_INFINITY;
  let out = { s: 1, x: 0, y: 0 };
  const minN = A.w * A.h * 0.35;
  let still = 0;
  for (let k = 0; k < A.px.length; k++) still += Math.abs(A.px[k]! - B.px[k]!);
  still /= A.px.length;
  const ox = Math.round(around.x / F);
  const oy = Math.round(around.y / F);
  for (const sc of [1, 0.96, 1.04, 0.92, 1.08, 0.88, 1.13]) {
    for (let dy = oy - R; dy <= oy + R; dy++)
      for (let dx = ox - R; dx <= ox + R; dx++) {
        let sum = 0;
        let n = 0;
        for (let y = 0; y < A.h; y++) {
          const yb = Math.round(cy + sc * (y + 0.5 - cy) + dy - 0.5);
          if (yb < 0 || yb >= B.h) continue;
          for (let x = 0; x < A.w; x++) {
            const xb = Math.round(cx + sc * (x + 0.5 - cx) + dx - 0.5);
            if (xb < 0 || xb >= B.w) continue;
            sum += Math.abs(A.px[y * A.w + x]! - B.px[yb * B.w + xb]!);
            n++;
          }
        }
        if (n < minN) continue;
        // a small preference for no motion, so a still picture reads still
        const v = sum / n + 0.02 * (Math.abs(dx) + Math.abs(dy)) + 2 * Math.abs(sc - 1);
        if (v < best) {
          best = v;
          out = { s: sc, x: dx * F, y: dy * F };
        }
      }
  }
  // a motion that lays the frames together no better than none is no motion:
  // two unrelated pictures always have some best fit
  return best <= 0.7 * still ? out : { s: 1, x: 0, y: 0 };
}

/** the best place in `next` for the block at (x, y) of `prev`: searched
 *  `r` around each of `centres` (offsets from (x, y)); the summed absolute
 *  difference there */
function searchBlock(
  g: GreyFrames,
  prev: Uint8Array,
  next: Uint8Array,
  x: number,
  y: number,
  centres: readonly (readonly [number, number])[],
  r: number,
): { best: number; x: number; y: number } {
  let best = Number.POSITIVE_INFINITY;
  let bxp = x;
  let byp = y;
  for (const [cx, cy] of centres)
    for (let dy = cy - r; dy <= cy + r; dy++) {
      const ny = y + dy;
      if (ny < 0 || ny + BLOCK > g.h) continue;
      for (let dx = cx - r; dx <= cx + r; dx++) {
        const nx = x + dx;
        if (nx < 0 || nx + BLOCK > g.w) continue;
        let s = 0;
        for (let rr = 0; rr < BLOCK && s < best; rr++) {
          const pa = (y + rr) * g.w + x;
          const pb = (ny + rr) * g.w + nx;
          for (let c = 0; c < BLOCK; c++) s += Math.abs(prev[pa + c]! - next[pb + c]!);
        }
        if (s < best) {
          best = s;
          bxp = nx;
          byp = ny;
        }
      }
    }
  return { best, x: bxp, y: byp };
}

/** where a motion p' = c + s·(p − c) + t takes the block at (x, y), as an
 *  offset from (x, y) */
function motionOffset(
  g: GreyFrames,
  m: { s: number; x: number; y: number },
  x: number,
  y: number,
): [number, number] {
  const gcx = g.w / 2;
  const gcy = g.h / 2;
  const px = gcx + m.s * (x + BLOCK / 2 - gcx) + m.x - BLOCK / 2;
  const py = gcy + m.s * (y + BLOCK / 2 - gcy) + m.y - BLOCK / 2;
  return [Math.round(px - x), Math.round(py - y)];
}

/** follow the textured blocks of frame `a` to `b` two ways, and count a block
 *  followed by either: frame by frame (each step a small search around where
 *  the block was and around where the whole picture moved, so a fast pan is
 *  followed; the template renewed each step, so a zoom or turn is followed),
 *  and in one search from `a` straight to `b` around where the picture's
 *  summed motion takes it (so a pan whose middle frames are blurred past
 *  matching is still followed between its sharp ends). Returns the share of
 *  the frame followed to `b` with texture, and the mean shift. With a == b-1
 *  (a cut) it is one search of `radius` around the block's place and the
 *  picture's shift. */
export function follow(
  g: GreyFrames,
  a: number,
  b: number,
  radius: number,
): { share: number; shift: { x: number; y: number } | null } {
  const { bx, by } = blocksOf(g);
  const st = blockStats(g, frameAt(g, a));
  const step = Math.max(1, Math.round(g.fps / 30));
  const frames: number[] = [];
  for (let j = a + step; j < b; j += step) frames.push(j);
  frames.push(b);
  const N = BLOCK * BLOCK;
  // the picture's motion at each step, and summed over all of them
  const shifts: { s: number; x: number; y: number }[] = [];
  let total = { s: 1, x: 0, y: 0 };
  {
    let prev = a;
    for (const j of frames) {
      const m = globalMotion(g, frameAt(g, prev), frameAt(g, j));
      shifts.push(m);
      total = { s: m.s * total.s, x: m.s * total.x + m.x, y: m.s * total.y + m.y };
      prev = j;
    }
  }
  const r = frames.length === 1 ? radius : 4;
  // the steps miss what they could not read (a blurred or ghosted frame
  // reads as no motion): the motion from a straight to b, searched around
  // their sum, or the sum itself when nothing lays the two ends together
  if (frames.length > 1) {
    const direct = globalMotion(g, frameAt(g, a), frameAt(g, b), total);
    if (direct.s !== 1 || direct.x || direct.y) total = direct;
  }
  const rDirect = Math.min(12, Math.max(4, Math.round(0.1 * Math.hypot(total.x, total.y))));
  const close = (best: number, sd: number) => sd >= FLAT_STD && best / N <= Math.min(14, 0.35 * sd);
  const fa = frameAt(g, a);
  const fb = frameAt(g, b);
  let kept = 0;
  let sx = 0;
  let sy = 0;
  for (let k = 0; k < bx * by; k++) {
    if (st.std[k]! < FLAT_STD) continue;
    const x0 = (k % bx) * BLOCK;
    const y0 = Math.floor(k / bx) * BLOCK;
    let x = x0;
    let y = y0;
    let prev = fa;
    let alive = true;
    for (const [si, j] of frames.entries()) {
      const next = frameAt(g, j);
      const [mx, my] = motionOffset(g, shifts[si]!, x, y);
      const centres: [number, number][] =
        mx || my
          ? [
              [0, 0],
              [mx, my],
            ]
          : [[0, 0]];
      const m = searchBlock(g, prev, next, x, y, centres, r);
      // a match is a close one for this patch's own contrast, so smooth
      // ground does not pass for the same thing
      if (!close(m.best, patchStd(g, prev, x, y))) {
        alive = false;
        break;
      }
      x = m.x;
      y = m.y;
      prev = next;
    }
    // still texture where it ended, not a match on flat ground
    if (!alive || patchStd(g, fb, x, y) < FLAT_STD) {
      alive = false;
      if (frames.length > 1) {
        const [mx, my] = motionOffset(g, total, x0, y0);
        const m = searchBlock(g, fa, fb, x0, y0, [[mx, my]], rDirect);
        if (close(m.best, st.std[k]!) && patchStd(g, fb, m.x, m.y) >= FLAT_STD) {
          alive = true;
          x = m.x;
          y = m.y;
        }
      }
    }
    if (!alive) continue;
    kept++;
    sx += x - x0;
    sy += y - y0;
  }
  return {
    share: kept / (bx * by),
    shift: kept ? { x: (sx / kept / g.w) * 100, y: (sy / kept / g.h) * 100 } : null,
  };
}

function compare(g: GreyFrames, a: number, b: number, cut: boolean) {
  const fa = frameAt(g, a);
  const fb = frameAt(g, b);
  const sa = blockStats(g, fa);
  const sb = blockStats(g, fb);
  const d = blockDiff(g, fa, fb);
  let changed = 0;
  let stays = 0;
  let background = 0;
  for (let k = 0; k < d.length; k++) {
    if (d[k]! > 12) changed++;
    if (sa.std[k]! >= FLAT_STD && d[k]! < SAME_BLOCK) stays++;
    if (
      sa.std[k]! < FLAT_STD &&
      sb.std[k]! < FLAT_STD &&
      Math.abs(sa.mean[k]! - sb.mean[k]!) < SAME_BLOCK
    )
      background++;
  }
  const n = d.length;
  // across a cut there is no motion to follow: one search a little wider
  const f = follow(g, a, b, cut ? 6 : 4);
  const carried = Math.max(f.share, stays / n);
  const across: CarryKind =
    carried >= CARRIED_SHARE
      ? "carried"
      : background / n >= BACKGROUND_SHARE
        ? "background only"
        : "nothing carried";
  return {
    changed: changed / n,
    stays: stays / n,
    carried,
    background: background / n,
    shift: f.shift,
    across,
  };
}

/** the big changes of picture: every cut, and every moment where at least
 *  40 % of the frame's blocks differ between a quarter second before and a
 *  quarter second after (the local peak, at least half a second from the next
 *  one); each compared before/after for what it carries across */
export function findChanges(
  g: GreyFrames,
  energy: Float32Array,
  cuts: readonly number[],
): PictureChange[] {
  const k = Math.max(1, Math.round(g.fps * 0.25));
  const C = new Float32Array(g.count);
  for (let i = k; i + k < g.count; i++)
    C[i] = changedShare(g, frameAt(g, i - k), frameAt(g, i + k));
  const sep = Math.round(g.fps * 0.5);
  const peaks: number[] = [];
  for (let i = k; i + k < g.count; i++) {
    if (C[i]! < 0.4) continue;
    let top = true;
    for (let j = Math.max(0, i - sep); j <= Math.min(g.count - 1, i + sep) && top; j++)
      if (C[j]! > C[i]! || (C[j] === C[i] && j < i)) top = false;
    if (top) peaks.push(i);
  }
  const out: PictureChange[] = [];
  for (const c of cuts) {
    const r = compare(g, c - 1, c, true);
    out.push({
      frame: c,
      t: frameTime(g, c),
      kind: "hard cut",
      before: c - 1,
      after: c,
      ...r,
    });
  }
  const moving = 0.003;
  const maxSpan = Math.round(g.fps * 0.75);
  for (const p of peaks) {
    // a cut inside this window is this change
    if (cuts.some((c) => Math.abs(c - p) <= k + 1)) continue;
    let a = p - k;
    while (a > 1 && p - a < maxSpan && energy[a]! >= moving) a--;
    let b = p + k;
    while (b < g.count - 1 && b - p < maxSpan && energy[b + 1]! >= moving) b++;
    a = Math.max(0, a);
    // the window can start before the motion and end after it: the change
    // runs from the last frame before the picture moves to the first after
    while (b - 1 > a && energy[b]! < moving) b--;
    while (a + 1 < b && energy[a + 1]! < moving) a++;
    const r = compare(g, a, b, false);
    out.push({ frame: b, t: frameTime(g, b), kind: r.across, before: a, after: b, ...r });
  }
  return out.sort((x, y) => x.frame - y.frame);
}

// --- the whole picture's scale and shift over time ----------------------------------------

/** the picture's motion from one read frame to the next: a scale about the
 *  frame's centre and a shift, fitted by gradient steps (sub-pixel) on the
 *  grey copy, coarse to fine; pixels that move otherwise (a caption fading,
 *  a cursor) are left out of the fit after its first step */
function fitSimilarity(
  A: Float32Array,
  B: Float32Array,
  w: number,
  h: number,
  init: { s: number; x: number; y: number },
): { s: number; x: number; y: number; res: number } {
  const cx = w / 2;
  const cy = h / 2;
  const gx = new Float32Array(w * h);
  const gy = new Float32Array(w * h);
  for (let y = 1; y < h - 1; y++)
    for (let x = 1; x < w - 1; x++) {
      const k = y * w + x;
      gx[k] = (A[k + 1]! - A[k - 1]!) / 2;
      gy[k] = (A[k + w]! - A[k - w]!) / 2;
    }
  let { s, x: tx, y: ty } = init;
  let res = Number.POSITIVE_INFINITY;
  let thr = Number.POSITIVE_INFINITY;
  for (let it = 0; it < 12; it++) {
    let h00 = 0;
    let h01 = 0;
    let h02 = 0;
    let h11 = 0;
    let h12 = 0;
    let h22 = 0;
    let b0 = 0;
    let b1 = 0;
    let b2 = 0;
    let sumAbs = 0;
    let n = 0;
    const absR: number[] = [];
    for (let y = 1; y < h - 1; y++)
      for (let x = 1; x < w - 1; x++) {
        const qx = cx + s * (x - cx) + tx;
        const qy = cy + s * (y - cy) + ty;
        if (qx < 0 || qy < 0 || qx >= w - 1 || qy >= h - 1) continue;
        const x0 = Math.floor(qx);
        const y0 = Math.floor(qy);
        const fx = qx - x0;
        const fy = qy - y0;
        const k0 = y0 * w + x0;
        const bv =
          B[k0]! * (1 - fx) * (1 - fy) +
          B[k0 + 1]! * fx * (1 - fy) +
          B[k0 + w]! * (1 - fx) * fy +
          B[k0 + w + 1]! * fx * fy;
        const k = y * w + x;
        const r = bv - A[k]!;
        const ar = Math.abs(r);
        if ((it & 3) === 0) absR.push(ar);
        if (ar > thr) continue;
        sumAbs += ar;
        n++;
        const j0 = gx[k]! * (x - cx) + gy[k]! * (y - cy);
        const j1 = gx[k]!;
        const j2 = gy[k]!;
        h00 += j0 * j0;
        h01 += j0 * j1;
        h02 += j0 * j2;
        h11 += j1 * j1;
        h12 += j1 * j2;
        h22 += j2 * j2;
        b0 += j0 * r;
        b1 += j1 * r;
        b2 += j2 * r;
      }
    if (n < 0.2 * w * h) return { s, x: tx, y: ty, res: Number.POSITIVE_INFINITY };
    res = sumAbs / n;
    if (absR.length) {
      absR.sort((a, b) => a - b);
      thr = Math.max(6, 3 * absR[absR.length >> 1]!);
    }
    // solve the 3×3 normal equations
    const det =
      h00 * (h11 * h22 - h12 * h12) - h01 * (h01 * h22 - h12 * h02) + h02 * (h01 * h12 - h11 * h02);
    if (!(Math.abs(det) > 1e-9)) break;
    const i00 = (h11 * h22 - h12 * h12) / det;
    const i01 = (h02 * h12 - h01 * h22) / det;
    const i02 = (h01 * h12 - h02 * h11) / det;
    const i11 = (h00 * h22 - h02 * h02) / det;
    const i12 = (h01 * h02 - h00 * h12) / det;
    const i22 = (h00 * h11 - h01 * h01) / det;
    const ds = i00 * b0 + i01 * b1 + i02 * b2;
    const dx = i01 * b0 + i11 * b1 + i12 * b2;
    const dy = i02 * b0 + i12 * b1 + i22 * b2;
    // the step is taken on A's side: compose with its inverse
    const sd = 1 + ds;
    if (!(sd > 0.5)) break;
    s /= sd;
    tx -= s * dx;
    ty -= s * dy;
    if (Math.abs(ds) < 1e-5 && Math.abs(dx) < 0.003 && Math.abs(dy) < 0.003) break;
  }
  return { s, x: tx, y: ty, res };
}

const halve = (A: Float32Array, w: number, h: number) => {
  const W2 = Math.floor(w / 2);
  const H2 = Math.floor(h / 2);
  const o = new Float32Array(W2 * H2);
  for (let y = 0; y < H2; y++)
    for (let x = 0; x < W2; x++) {
      const k = 2 * y * w + 2 * x;
      o[y * W2 + x] = (A[k]! + A[k + 1]! + A[k + w]! + A[k + w + 1]!) / 4;
    }
  return { px: o, w: W2, h: H2 };
};

/** the whole picture's motion between frames a and b of the grey copy: scale
 *  and shift (px of the copy, about its centre); null where no single motion
 *  lays the two together (new content, a flat frame) */
export function pictureMotion(
  g: GreyFrames,
  a: number,
  b: number,
): { s: number; x: number; y: number } | null {
  const fa = frameAt(g, a);
  const fb = frameAt(g, b);
  const A = Float32Array.from(fa);
  const B = Float32Array.from(fb);
  let r0 = 0;
  let textured = 0;
  for (let y = 1; y < g.h - 1; y++)
    for (let x = 1; x < g.w - 1; x++) {
      const k = y * g.w + x;
      r0 += Math.abs(A[k]! - B[k]!);
      if (Math.abs(A[k + 1]! - A[k - 1]!) + Math.abs(A[k + g.w]! - A[k - g.w]!) > 8) textured++;
    }
  const inner = (g.w - 2) * (g.h - 2);
  r0 /= inner;
  if (r0 < 0.35) return { s: 1, x: 0, y: 0 };
  if (textured < 0.02 * inner) return null;
  const try1 = (init: { s: number; x: number; y: number }) => {
    const ha = halve(A, g.w, g.h);
    const hb = halve(B, g.w, g.h);
    const c = fitSimilarity(ha.px, hb.px, ha.w, ha.h, { s: init.s, x: init.x / 2, y: init.y / 2 });
    const start =
      Number.isFinite(c.res) && Math.abs(c.s - 1) < 0.3 ? { s: c.s, x: c.x * 2, y: c.y * 2 } : init;
    return fitSimilarity(A, B, g.w, g.h, start);
  };
  let f = try1({ s: 1, x: 0, y: 0 });
  if (!(f.res <= 0.6 * r0)) {
    const coarse = globalMotion(g, fa, fb);
    if (coarse.s !== 1 || coarse.x || coarse.y) {
      const f2 = try1(coarse);
      if (f2.res < f.res) f = f2;
    }
  }
  // a motion no better than none is none: something else changed
  if (!(f.res <= 0.6 * r0) || Math.abs(f.s - 1) > 0.25) return null;
  return { s: f.s, x: f.x, y: f.y };
}

export type CameraPath = {
  /** the frames compared: every `step`-th, so the curve is read at about 30 Hz */
  step: number;
  /** per step: its end time (s); the picture's scale change as a log (ln s),
   *  and its shift as a share of the frame's width / height; null where no
   *  single motion lays the frames together or a cut lies between them */
  t: number[];
  logScale: (number | null)[];
  dx: (number | null)[];
  dy: (number | null)[];
};

/** the whole picture's scale and shift, step by step over the film; a cut
 *  (or a small swap) between two read frames leaves that step out */
export function cameraPath(g: GreyFrames, breaks: readonly number[]): CameraPath {
  const step = Math.max(1, Math.round(g.fps / 30));
  const br = [...breaks].sort((a, b) => a - b);
  const out: CameraPath = { step, t: [], logScale: [], dx: [], dy: [] };
  for (let b = step; b < g.count; b += step) {
    const a = b - step;
    out.t.push(frameTime(g, b));
    if (br.some((c) => c > a && c <= b)) {
      out.logScale.push(null);
      out.dx.push(null);
      out.dy.push(null);
      continue;
    }
    const m = pictureMotion(g, a, b);
    out.logScale.push(m ? Math.log(m.s) : null);
    // the shift of the frame's centre, as a share of the frame
    out.dx.push(m ? m.x / g.w : null);
    out.dy.push(m ? m.y / g.h : null);
  }
  return out;
}

export type CameraRun = {
  what: "zoom" | "pan x" | "pan y";
  /** zoom: "in" (the picture grows) / "out"; pan: the way the picture moves */
  dir: "in" | "out" | "left" | "right" | "up" | "down";
  start: number;
  end: number;
  /** zoom: the scale over the run (×); pan: the shift, share of the frame */
  amount: number;
};

/** stretches where the picture keeps zooming or moving one way: the motion
 *  smoothed over about a sixth of a second, at least `minRate` a second
 *  (zoom: in ln units; pan: share of the frame), adding up to at least
 *  `minTotal`; a cut or an unread step ends one */
export function cameraRuns(
  path: CameraPath,
  fps: number,
  o: { zoomRate?: number; zoomTotal?: number; panRate?: number; panTotal?: number } = {},
): CameraRun[] {
  const dt = path.step / fps;
  const out: CameraRun[] = [];
  const series: [
    CameraRun["what"],
    (number | null)[],
    number,
    number,
    [CameraRun["dir"], CameraRun["dir"]],
  ][] = [
    ["zoom", path.logScale, o.zoomRate ?? 0.01, o.zoomTotal ?? Math.log(1.012), ["in", "out"]],
    ["pan x", path.dx, o.panRate ?? 0.02, o.panTotal ?? 0.03, ["right", "left"]],
    ["pan y", path.dy, o.panRate ?? 0.02, o.panTotal ?? 0.03, ["down", "up"]],
  ];
  for (const [what, v, minRate, minTotal, [pos, neg]] of series) {
    const n = v.length;
    // smoothed rate per second; an unread step breaks the smoothing
    const rate = new Array<number | null>(n).fill(null);
    for (let i = 0; i < n; i++) {
      if (v[i] == null) continue;
      let s = 0;
      let k = 0;
      for (let j = i - 2; j <= i + 2; j++) {
        if (j < 0 || j >= n) continue;
        if (v[j] == null) {
          if (Math.abs(j - i) <= 1) {
            k = 0;
            break;
          }
          continue;
        }
        s += v[j]!;
        k++;
      }
      rate[i] = k ? s / k / dt : v[i]! / dt;
    }
    let i = 0;
    while (i < n) {
      const r = rate[i];
      if (r == null || Math.abs(r) < minRate) {
        i++;
        continue;
      }
      const sign = Math.sign(r);
      let j = i;
      let total = 0;
      let quiet = 0;
      let last = i;
      while (j < n && rate[j] != null) {
        const rj = rate[j]!;
        if (Math.sign(rj) === sign && Math.abs(rj) >= minRate) {
          quiet = 0;
          last = j;
        } else if (Math.sign(rj) !== sign && Math.abs(rj) >= minRate) break;
        else if (++quiet > 2) break;
        j++;
      }
      for (let k = i; k <= last; k++) total += v[k] ?? 0;
      if (Math.abs(total) >= minTotal)
        out.push({
          what,
          dir: sign > 0 ? pos : neg,
          start: round3(path.t[i]! - dt),
          end: round3(path.t[last]!),
          amount: what === "zoom" ? round3(Math.exp(total)) : round3(total),
        });
      i = last + 1;
    }
  }
  return out.sort((a, b) => a.start - b.start);
}

export type CameraBackForth = {
  what: CameraRun["what"];
  start: number;
  end: number;
  /** the runs, each the other way to the one before */
  runs: number;
};

/** runs of the same kind that turn back within `gap` s of each other, at
 *  least `min` in a row — a zoom in, out, in…, a pan back and forth */
export function backAndForth(runs: readonly CameraRun[], gap = 1, min = 3): CameraBackForth[] {
  const out: CameraBackForth[] = [];
  for (const what of ["zoom", "pan x", "pan y"] as const) {
    const rs = runs.filter((r) => r.what === what);
    let a = 0;
    for (let i = 1; i <= rs.length; i++) {
      const turns =
        i < rs.length && rs[i]!.dir !== rs[i - 1]!.dir && rs[i]!.start - rs[i - 1]!.end <= gap;
      if (turns) continue;
      if (i - a >= min) out.push({ what, start: rs[a]!.start, end: rs[i - 1]!.end, runs: i - a });
      a = i;
    }
  }
  return out.sort((x, y) => x.start - y.start);
}

export type CameraRepeat = {
  what: CameraRun["what"];
  dir: CameraRun["dir"];
  start: number;
  end: number;
  runs: number;
  /** the median time from one run's start to the next */
  every: number;
};

/** the same short move made again and again: runs of one kind and way, each
 *  after a pause (at least 0.1 s with no such run), starting within `gap` s
 *  of the one before, of about the same size (within 2×), at least `min` in a
 *  row — a pulse on every beat, a push that resets each time */
export function repeatedRuns(runs: readonly CameraRun[], gap = 1.5, min = 3): CameraRepeat[] {
  const out: CameraRepeat[] = [];
  for (const what of ["zoom", "pan x", "pan y"] as const) {
    const rs = runs.filter((r) => r.what === what);
    const size = (r: CameraRun) =>
      what === "zoom" ? Math.abs(Math.log(r.amount)) : Math.abs(r.amount);
    let a = 0;
    for (let i = 1; i <= rs.length; i++) {
      const p = rs[i - 1]!;
      const q = rs[i];
      const goesOn =
        !!q &&
        q.dir === p.dir &&
        q.start - p.end >= 0.1 &&
        q.start - p.start <= gap &&
        Math.max(size(p), size(q)) <= 2 * Math.min(size(p), size(q));
      if (goesOn) continue;
      if (i - a >= min) {
        const starts = rs.slice(a, i).map((r) => r.start);
        out.push({
          what,
          dir: p.dir,
          start: rs[a]!.start,
          end: p.end,
          runs: i - a,
          every: round3(median(starts.slice(1).map((t, k) => t - starts[k]!))),
        });
      }
      a = i;
    }
  }
  return out.sort((x, y) => x.start - y.start);
}

/** every turn back: a run the other way to the run of its kind before it,
 *  starting within `gap` s of its end */
export function reversals(
  runs: readonly CameraRun[],
  gap = 1,
): { t: number; what: CameraRun["what"] }[] {
  const out: { t: number; what: CameraRun["what"] }[] = [];
  for (const what of ["zoom", "pan x", "pan y"] as const) {
    const rs = runs.filter((r) => r.what === what);
    for (let i = 1; i < rs.length; i++)
      if (rs[i]!.dir !== rs[i - 1]!.dir && rs[i]!.start - rs[i - 1]!.end <= gap)
        out.push({ t: rs[i]!.start, what });
  }
  return out.sort((a, b) => a.t - b.t);
}

// --- subjects the page declared ---------------------------------------------------------

export type SubjectTrack = {
  name: string;
  /** where the positions came from */
  source: "curves" | "events";
  samples: { t: number; x: number; y: number; w?: number; h?: number }[];
};

export type SubjectExit = {
  name: string;
  start: number;
  end: number;
  /** out entirely, or only partly (a box crossing the frame's edge) */
  how: "out" | "partly out";
  edge: "left" | "right" | "top" | "bottom";
};

/** subjects' positions from an events file: curve pairs `<name>.x`/`<name>.y`
 *  (with `<name>.w`/`<name>.h` for a box), and events of kind "subject" with
 *  x, y and a label naming the subject */
export function subjectTracks(raw: unknown): SubjectTrack[] {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const out: SubjectTrack[] = [];
  const c = (r.curves && typeof r.curves === "object" ? r.curves : {}) as Record<string, unknown>;
  const names = (Array.isArray(c.names) ? c.names : []).map(String);
  const rows = (Array.isArray(c.rows) ? c.rows : []).filter(Array.isArray) as unknown[][];
  const t0 = typeof c.t0 === "number" ? c.t0 : 0;
  const dt = typeof c.dt === "number" && c.dt > 0 ? c.dt : 1 / 60;
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
  for (const [j, name] of names.entries()) {
    if (!name.endsWith(".x")) continue;
    const base = name.slice(0, -2);
    const jy = names.indexOf(`${base}.y`);
    if (jy < 0) continue;
    const jw = names.indexOf(`${base}.w`);
    const jh = names.indexOf(`${base}.h`);
    const samples: SubjectTrack["samples"] = [];
    rows.forEach((row, i) => {
      const x = num(row[j]);
      const y = num(row[jy]);
      if (x == null || y == null) return;
      const s: SubjectTrack["samples"][number] = { t: t0 + i * dt, x, y };
      const w = jw >= 0 ? num(row[jw]) : null;
      const h = jh >= 0 ? num(row[jh]) : null;
      if (w != null && h != null) {
        s.w = w;
        s.h = h;
      }
      samples.push(s);
    });
    if (samples.length) out.push({ name: base, source: "curves", samples });
  }
  const evs = (Array.isArray(r.events) ? r.events : []) as Record<string, unknown>[];
  const byName = new Map<string, SubjectTrack["samples"]>();
  for (const e of evs) {
    if (e?.kind !== "subject") continue;
    const t = num(e.t);
    const x = num(e.x);
    const y = num(e.y);
    if (t == null || x == null || y == null) continue;
    const name = typeof e.label === "string" && e.label ? e.label : "subject";
    const s: SubjectTrack["samples"][number] = { t, x, y };
    const w = num(e.w);
    const h = num(e.h);
    if (w != null && h != null) {
      s.w = w;
      s.h = h;
    }
    byName.set(name, [...(byName.get(name) ?? []), s]);
  }
  for (const [name, samples] of byName)
    out.push({ name, source: "events", samples: samples.sort((a, b) => a.t - b.t) });
  return out;
}

/** when each subject is outside a w×h frame: a point (x, y) is its centre; a
 *  box (w, h) centred there is "partly out" when it crosses the edge and "out"
 *  when nothing of it is inside. Between samples it holds the last state. */
export function subjectExits(
  tracks: readonly SubjectTrack[],
  w: number,
  h: number,
  duration: number,
): SubjectExit[] {
  const out: SubjectExit[] = [];
  for (const tr of tracks) {
    let open: { start: number; how: SubjectExit["how"]; edge: SubjectExit["edge"] } | null = null;
    const state = (s: SubjectTrack["samples"][number]) => {
      const hw = (s.w ?? 0) / 2;
      const hh = (s.h ?? 0) / 2;
      const edges: [SubjectExit["edge"], number][] = [
        ["left", -(s.x + hw)],
        ["right", s.x - hw - w],
        ["top", -(s.y + hh)],
        ["bottom", s.y - hh - h],
      ];
      // fully out past an edge
      const out = edges.filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1])[0];
      if (out) return { how: "out" as const, edge: out[0] };
      if (hw || hh) {
        const part: [SubjectExit["edge"], number][] = [
          ["left", hw - s.x],
          ["right", s.x + hw - w],
          ["top", hh - s.y],
          ["bottom", s.y + hh - h],
        ];
        const p = part.filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1])[0];
        if (p) return { how: "partly out" as const, edge: p[0] };
      }
      return null;
    };
    for (const s of tr.samples) {
      const st = state(s);
      if (open && (!st || st.how !== open.how || st.edge !== open.edge)) {
        out.push({
          name: tr.name,
          start: round3(open.start),
          end: round3(s.t),
          how: open.how,
          edge: open.edge,
        });
        open = null;
      }
      if (st && !open) open = { start: s.t, ...st };
    }
    if (open)
      out.push({
        name: tr.name,
        start: round3(open.start),
        end: round3(Math.max(open.start, duration)),
        how: open.how,
        edge: open.edge,
      });
  }
  return out.sort((a, b) => a.start - b.start);
}

// --- the beat sheet against what happened -------------------------------------------------

/** a segment of the page's beat sheet (kit/time.js `segment`), in film time */
export type SheetSegment = {
  from: number;
  to: number;
  label?: string;
  hold?: boolean;
  handoff?: string;
  subject?: string;
  sound?: string;
};

/** a beat sheet as an events file or a page gives it: kept where it has two
 *  times in order, by `from` */
export function sheetSegments(raw: unknown): SheetSegment[] {
  if (!Array.isArray(raw)) return [];
  const out: SheetSegment[] = [];
  for (const e of raw as Record<string, unknown>[]) {
    if (!e || typeof e.from !== "number" || typeof e.to !== "number") continue;
    if (!Number.isFinite(e.from) || !Number.isFinite(e.to) || !(e.to > e.from)) continue;
    const s: SheetSegment = { from: e.from, to: e.to };
    for (const k of ["label", "handoff", "subject", "sound"] as const)
      if (typeof e[k] === "string" && e[k]) s[k] = e[k] as string;
    if (typeof e.hold === "boolean") s.hold = e.hold;
    out.push(s);
  }
  return out.sort((a, b) => a.from - b.from);
}

export type SegmentReading = SheetSegment & {
  /** share of the segment's frames whose picture changes (≥ the still line) */
  moving: number;
  /** where it moves, stretches of at least 0.1 s */
  movingSpans: { start: number; end: number }[];
  cuts: number[];
  swaps: number[];
  /** the whole picture's motion summed over the segment's read steps: scale
   *  (×) and shift (share of the frame); null when no step could be read */
  camera: { zoom: number; x: number; y: number; read: number } | null;
  runs: CameraRun[];
  /** the declared subject, when the segment names one */
  subjectSeen?: {
    how: "measured" | "estimated" | "not detected" | "not measured";
    /** page: a selector found on the page; curves/events: a declared track by name */
    source: "page" | "curves" | "events" | null;
    out: { start: number; end: number; how: "out" | "partly out" | "not visible"; edge?: string }[];
  };
  /** what the picture does at the segment's end, where its handoff is */
  handoffSeen?: {
    how: "measured" | "estimated";
    kind:
      | "hard cut"
      | "small swap"
      | "gradual: carried"
      | "gradual: background only"
      | "gradual: nothing carried"
      | "continuous, camera moving"
      | "continuous, no change"
      | "film ends";
    at: number | null;
    /** a hard cut: what crosses it */
    across?: CarryKind;
    nearestOnset: number | null;
  };
};

/** set each segment beside what the picture did over it */
export function readSegments(
  segments: readonly SheetSegment[],
  c: {
    duration: number;
    fps: number;
    t0: number;
    energy: Float32Array;
    stillUnder: number;
    cuts: readonly number[];
    swaps: readonly number[];
    changes: readonly PictureChange[];
    path: CameraPath;
    runs: readonly CameraRun[];
    tracks: readonly SubjectTrack[];
    width: number;
    height: number;
    /** where the page drew each subject selector, sample by sample (box null:
     *  not visible); null when no element on the page ever matches it */
    pageSubjects?: (
      sel: string,
    ) => { t: number; box: [number, number, number, number] | null }[] | null;
    onsets: readonly number[] | null;
  },
): SegmentReading[] {
  const win = Math.max(0.35, 3 / c.fps);
  return segments.map((s) => {
    const a = Math.max(0, Math.round((s.from - c.t0) * c.fps));
    const b = Math.min(c.energy.length, Math.round((s.to - c.t0) * c.fps));
    let moving = 0;
    const spans: { start: number; end: number }[] = [];
    let open: number | null = null;
    for (let i = a; i < b; i++) {
      const m = i > 0 && c.energy[i]! >= c.stillUnder;
      if (m) moving++;
      if (m && open == null) open = i;
      if ((!m || i === b - 1) && open != null) {
        const end = m ? i + 1 : i;
        if ((end - open) / c.fps >= 0.1)
          spans.push({ start: round3(c.t0 + open / c.fps), end: round3(c.t0 + end / c.fps) });
        open = null;
      }
    }
    let ls = 0;
    let x = 0;
    let y = 0;
    let read = 0;
    c.path.t.forEach((t, k) => {
      if (t <= s.from + 1e-9 || t > s.to + 1e-9) return;
      const v = c.path.logScale[k];
      if (v == null) return;
      ls += v;
      x += c.path.dx[k] ?? 0;
      y += c.path.dy[k] ?? 0;
      read++;
    });
    const r: SegmentReading = {
      ...s,
      moving: round2(b > a ? moving / (b - a) : 0),
      movingSpans: spans,
      cuts: c.cuts.filter((t) => t > s.from + 1e-9 && t < s.to - 1e-9),
      swaps: c.swaps.filter((t) => t > s.from + 1e-9 && t < s.to - 1e-9),
      camera: read ? { zoom: round3(Math.exp(ls)), x: round3(x), y: round3(y), read } : null,
      runs: c.runs.filter((u) => u.end > s.from && u.start < s.to),
    };
    if (s.subject) {
      const page = c.pageSubjects?.(s.subject) ?? null;
      const track = c.tracks.find((t) => t.name === s.subject);
      // the page's samples inside the segment (none: the segment falls between two)
      const inSeg = (page ?? []).filter((p) => p.t >= s.from - 1e-9 && p.t < s.to - 1e-9);
      if (inSeg.length) {
        const out: NonNullable<SegmentReading["subjectSeen"]>["out"] = [];
        // a stretch per state: not visible, or out / partly out by edge
        let cur: {
          start: number;
          how: "out" | "partly out" | "not visible";
          edge?: string;
        } | null = null;
        const close = (t: number) => {
          if (cur) out.push({ ...cur, end: round3(t) });
          cur = null;
        };
        for (const p of inSeg) {
          let st: { how: "out" | "partly out" | "not visible"; edge?: string } | null = null;
          if (!p.box) st = { how: "not visible" };
          else {
            const [bx, by, bw, bh] = p.box;
            const ex = subjectExits(
              [
                {
                  name: "",
                  source: "events",
                  samples: [{ t: 0, x: bx + bw / 2, y: by + bh / 2, w: bw, h: bh }],
                },
              ],
              c.width,
              c.height,
              0,
            )[0];
            if (ex) st = { how: ex.how, edge: ex.edge };
          }
          const same = (q: typeof cur) => !!q && !!st && q.how === st.how && q.edge === st.edge;
          if (cur && !same(cur)) close(p.t);
          if (st && !cur) cur = { start: round3(p.t), ...st };
        }
        close(s.to);
        r.subjectSeen = { how: out.length ? "measured" : "not detected", source: "page", out };
      } else if (track) {
        const ex = subjectExits([track], c.width, c.height, c.duration).filter(
          (e) => e.end > s.from && e.start < s.to,
        );
        r.subjectSeen = {
          how: ex.length ? "estimated" : "not detected",
          source: track.source,
          out: ex.map((e) => ({
            start: round3(Math.max(e.start, s.from)),
            end: round3(Math.min(e.end, s.to)),
            how: e.how,
            edge: e.edge,
          })),
        };
      } else r.subjectSeen = { how: "not measured", source: null, out: [] };
    }
    if (s.handoff) {
      const at = s.to;
      const nearestOnset = c.onsets?.length ? nearestOffset([...c.onsets], at) : null;
      const near = (t: number) => Math.abs(t - at) <= win;
      const cut = c.cuts.filter(near).sort((p, q) => Math.abs(p - at) - Math.abs(q - at))[0];
      const grad = c.changes.find(
        (ch) =>
          ch.kind !== "hard cut" &&
          c.t0 + ch.before / c.fps <= at + win &&
          c.t0 + ch.after / c.fps >= at - win,
      );
      const swap = c.swaps.filter(near)[0];
      const camMoves = c.runs.some((u) => u.start <= at + 0.05 && u.end >= at - 0.05);
      if (at >= c.duration - 1.5 / c.fps)
        r.handoffSeen = { how: "measured", kind: "film ends", at: null, nearestOnset };
      else if (cut != null) {
        const ch = c.changes.find(
          (x) => x.kind === "hard cut" && Math.abs(x.t - cut) < 0.5 / c.fps,
        );
        r.handoffSeen = {
          how: "measured",
          kind: "hard cut",
          at: round3(cut),
          ...(ch ? { across: ch.across } : {}),
          nearestOnset,
        };
      } else if (grad)
        r.handoffSeen = {
          how: "estimated",
          kind: `gradual: ${grad.kind as CarryKind}`,
          at: round3(grad.t),
          nearestOnset,
        };
      else if (swap != null)
        r.handoffSeen = { how: "measured", kind: "small swap", at: round3(swap), nearestOnset };
      else
        r.handoffSeen = {
          how: "estimated",
          kind: camMoves ? "continuous, camera moving" : "continuous, no change",
          at: null,
          nearestOnset,
        };
    }
    return r;
  });
}

// --- text at film scale -----------------------------------------------------------------

export type TextSample = {
  t: number;
  /** share of the frame under text: the page's own, the product's (saved
   *  screens), inside pictures (read off the film); null: not read */
  own: number | null;
  product: number | null;
  picture: number | null;
  /** all of it */
  share: number;
  /** characters visible: the same split */
  ownChars: number | null;
  productChars: number | null;
  pictureChars: number | null;
  chars: number | null;
  /** the smallest and the median (by character) text size, film px; where
   *  each came from */
  smallest: { px: number; from: "page" | "picture"; text: string } | null;
  median: number | null;
  /** the median size (by character, film px) of the product's words alone:
   *  the page's text less the film's own pieces, and text read in pictures;
   *  null: none of it read */
  productMedian?: number | null;
};

export type TextOverlap = {
  from: number;
  to: number;
  /** the page's own text */
  text: string;
  over: string;
};

/** the page's text and the film's read text, sample by sample, put together */
export function textTimeline(
  page: PageTextSample[] | null,
  frames: FrameText[] | null,
  o: {
    width: number;
    height: number;
    segments: readonly SheetSegment[];
    every: number;
  },
): { samples: TextSample[]; overlaps: TextOverlap[] } {
  const area = o.width * o.height;
  // every time either reader has (a page can leave a time out)
  const times = [...new Set([...(page ?? []), ...(frames ?? [])].map((s) => s.t))].sort(
    (a, b) => a - b,
  );
  const byT = (list: { t: number }[] | null, t: number) =>
    list?.find((s) => Math.abs(s.t - t) < 1e-6) ?? null;
  const samples: TextSample[] = [];
  const raw: { t: number; text: string; over: string }[] = [];
  for (const t of times) {
    const p = byT(page, t) as PageTextSample | null;
    const f = byT(frames, t) as FrameText | null;
    // the read lines that are not the page's own text: text in pictures
    // (a line over the product's live text is that text)
    const pictureLines = (f?.lines ?? []).filter((l) => {
      if (l.conf < 0.3 || l.box[3] < 4) return false;
      if (!p) return true;
      if (gridCover(p.grid, o.width, o.height, l.box) >= 0.3) return false;
      // the film's own text read back: mostly on its pieces at about the
      // line's size (a line the recognizer reads across two pieces side by
      // side included)
      const la = l.box[2] * l.box[3];
      const onOwn = p.own
        .filter((x) => l.box[3] >= 0.6 * x.px && l.box[3] <= 1.8 * x.px)
        .reduce((a, x) => a + x.boxes.reduce((s, b) => s + overlapArea(b, l.box), 0), 0);
      return onOwn < 0.5 * la;
    });
    const sizes: { px: number; chars: number; from: "page" | "picture"; text: string }[] = [];
    if (p) {
      for (const [px, chars] of p.sizes) sizes.push({ px, chars, from: "page", text: "" });
      // name the smallest piece of the film's own text, when it is that
      for (const x of p.own) {
        const hit = sizes.find((s) => s.from === "page" && Math.abs(s.px - x.px) < 0.26 && !s.text);
        if (hit) hit.text = x.text;
      }
    }
    for (const l of pictureLines)
      sizes.push({ px: l.box[3], chars: l.chars, from: "picture", text: l.text });
    let pictureShare: number | null = null;
    let pictureChars: number | null = null;
    if (f?.how === "ocr") {
      pictureShare = round3(
        Math.min(1, pictureLines.reduce((a, l) => a + l.box[2] * l.box[3], 0) / area),
      );
      pictureChars = pictureLines.reduce((a, l) => a + l.chars, 0);
    } else if (f?.how === "edges") pictureShare = f.share;
    const own = p ? p.ownShare : null;
    const product = p ? p.productShare : null;
    const share =
      f?.how === "edges"
        ? Math.max(f.share, (own ?? 0) + (product ?? 0))
        : Math.min(1, (own ?? 0) + (product ?? 0) + (pictureShare ?? 0));
    const ownChars = p ? p.own.reduce((a, x) => a + x.chars, 0) : null;
    const productChars = p ? p.product.chars : null;
    const chars =
      ownChars == null && pictureChars == null
        ? null
        : (ownChars ?? 0) + (productChars ?? 0) + (pictureChars ?? 0);
    const sorted = sizes.filter((s) => s.px > 0).sort((a, b) => a.px - b.px);
    const medianOf = (list: readonly { px: number; chars: number }[]): number | null => {
      const total = list.reduce((a, s) => a + s.chars, 0);
      let k = 0;
      for (const s of list) {
        k += s.chars;
        if (total && k >= total / 2) return round1(s.px);
      }
      return null;
    };
    const median = medianOf(sorted);
    // the product's words alone: the page's sizes less the film's own pieces
    // (each taken off the size it was drawn at), and the text in pictures
    const rest = sorted.map((s) => ({ px: s.px, chars: s.chars, from: s.from }));
    for (const x of p?.own ?? []) {
      let left = x.chars;
      for (const s of rest)
        if (left > 0 && s.from === "page" && Math.abs(s.px - x.px) < 0.26) {
          const take = Math.min(left, s.chars);
          s.chars -= take;
          left -= take;
        }
    }
    const productMedian = medianOf(
      rest.filter((s) => s.chars > 0 && (s.from === "page" || f?.how === "ocr")),
    );
    samples.push({
      t,
      own,
      product,
      picture: pictureShare,
      share: round3(share),
      ownChars,
      productChars,
      pictureChars,
      chars,
      smallest: sorted[0]
        ? { px: round1(sorted[0].px), from: sorted[0].from, text: sorted[0].text }
        : null,
      median,
      productMedian,
    });
    // the film's own text over pictures, the product's text, text in
    // pictures, the subject of the segment it is in
    if (p) {
      const subjects = o.segments
        .filter((s) => s.subject && t >= s.from - 1e-9 && t < s.to - 1e-9)
        .map((s) => [s.subject!, p.subjects[s.subject!] ?? null] as const);
      for (const x of p.own) {
        const a = x.boxes.reduce((s, b) => s + b[2] * b[3], 0);
        if (!a) continue;
        // over a picture: a share of the text; over a line or a subject: a
        // share of the smaller of the two
        const cover = (box: Box) => x.boxes.reduce((s, b) => s + overlapArea(b, box), 0) / a;
        const meet = (box: Box) =>
          x.boxes.reduce((s, b) => s + overlapArea(b, box), 0) / Math.min(a, box[2] * box[3]);
        const add = (over: string) => raw.push({ t, text: x.text, over });
        if (x.boxes.some((b) => gridCover(p.grid, o.width, o.height, b) >= 0.2))
          add("the product's text");
        if (pictureLines.some((l) => meet(l.box) >= 0.2)) add("text inside a picture");
        for (const [sel, box] of subjects) if (box && meet(box) >= 0.2) add(`the subject ${sel}`);
        for (const m of p.media)
          if (cover(m.box) >= 0.2 && m.box[2] * m.box[3] < 0.9 * area) add(`a picture: ${m.label}`);
      }
    }
  }
  // samples in a row with the same text over the same thing: one stretch
  const overlaps: TextOverlap[] = [];
  const openO = new Map<string, TextOverlap & { last: number }>();
  for (const t of times) {
    const now = raw.filter((r) => r.t === t);
    const keys = new Set<string>();
    for (const r of now) {
      const k = `${r.text}|${r.over}`;
      keys.add(k);
      const cur = openO.get(k);
      if (cur && t - cur.last <= o.every * 1.5 + 1e-6) {
        cur.last = t;
        cur.to = round3(t + o.every);
      } else {
        if (cur) overlaps.push({ from: cur.from, to: cur.to, text: cur.text, over: cur.over });
        openO.set(k, {
          from: round3(t),
          to: round3(t + o.every),
          text: r.text,
          over: r.over,
          last: t,
        });
      }
    }
    for (const [k, cur] of [...openO])
      if (!keys.has(k) && t - cur.last > o.every * 1.5) {
        overlaps.push({ from: cur.from, to: cur.to, text: cur.text, over: cur.over });
        openO.delete(k);
      }
  }
  for (const cur of openO.values())
    overlaps.push({ from: cur.from, to: cur.to, text: cur.text, over: cur.over });
  return { samples, overlaps: overlaps.sort((a, b) => a.from - b.from) };
}

const overlapArea = (a: Box, b: Box) => {
  const w = Math.min(a[0] + a[2], b[0] + b[2]) - Math.max(a[0], b[0]);
  const h = Math.min(a[1] + a[3], b[1] + b[3]) - Math.max(a[1], b[1]);
  return w > 0 && h > 0 ? w * h : 0;
};

/** the text samples per `binS` second: mean share, most characters at once,
 *  the smallest size, the median of the samples' medians */
export function textPerSecond(samples: readonly TextSample[], duration: number, binS = 1) {
  return Array.from({ length: Math.max(1, Math.ceil(duration / binS - 1e-9)) }, (_, k) => {
    const inBin = samples.filter((s) => s.t >= k * binS - 1e-9 && s.t < (k + 1) * binS - 1e-9);
    const meds = inBin.map((s) => s.median).filter((v): v is number => v != null);
    const smalls = inBin.map((s) => s.smallest?.px).filter((v): v is number => v != null);
    const chars = inBin.map((s) => s.chars).filter((v): v is number => v != null);
    return {
      t: k * binS,
      share: inBin.length ? round3(inBin.reduce((a, s) => a + s.share, 0) / inBin.length) : 0,
      chars: chars.length ? Math.max(...chars) : null,
      smallest: smalls.length ? Math.min(...smalls) : null,
      median: meds.length ? round1(median(meds)) : null,
    };
  });
}

/** under this many px on the phone, a size is named beside the tools that act
 *  on part of a screen: information, not a limit */
export const PHONE_SMALL_PX = 8;

/** fewer characters of the product's than this in a sample read as the
 *  recognizer's stray marks, not words */
const PRODUCT_WORDS_MIN_CHARS = 20;

export type ProductTextSpan = {
  from: number;
  to: number;
  /** the share of the text on screen that is the product's (saved screens)
   *  or in pictures, the most in the span */
  productShare: number;
  /** the product's words' median size, px on the phone: the smallest
   *  sample's in the span */
  phoneMedian: number | null;
};

/** where the product's own words (its saved screens, text read in pictures)
 *  are most of the frame's text, or their median size reads under
 *  PHONE_SMALL_PX on the phone. Samples next to each other run into one
 *  span. `pictures: false` (pictures read by edges, which cannot tell the
 *  film's own text from a picture's) counts the saved screens only.
 *  Information only. */
export function productTextSpans(
  samples: readonly TextSample[],
  phoneScale: number,
  every: number,
  o: { pictures?: boolean } = {},
): ProductTextSpan[] {
  const pictures = o.pictures ?? true;
  const spans: ProductTextSpan[] = [];
  let open: ProductTextSpan | null = null;
  for (const s of samples) {
    const words = (s.product ?? 0) + (pictures ? (s.picture ?? 0) : 0);
    const chars = (s.productChars ?? 0) + (pictures ? (s.pictureChars ?? 0) : 0);
    const share = s.share > 0.002 ? Math.min(1, words / s.share) : 0;
    const phone =
      s.productMedian == null || chars < PRODUCT_WORDS_MIN_CHARS
        ? null
        : round1(s.productMedian * phoneScale);
    const hit = (words > 0 && share >= 0.5) || (phone != null && phone < PHONE_SMALL_PX);
    if (!hit) {
      open = null;
      continue;
    }
    if (open && s.t <= open.to + every * 0.5 + 1e-6) {
      open.to = round3(s.t + every);
      open.productShare = Math.max(open.productShare, round2(share));
      if (phone != null)
        open.phoneMedian = open.phoneMedian == null ? phone : Math.min(open.phoneMedian, phone);
    } else {
      open = {
        from: s.t,
        to: round3(s.t + every),
        productShare: round2(share),
        phoneMedian: phone,
      };
      spans.push(open);
    }
  }
  return spans;
}

// --- the whole probe ---------------------------------------------------------------------

type How = "measured" | "estimated" | "not detected" | "not measured";

export type FilmProbe = {
  input: string;
  duration: number;
  fps: number;
  /** the film time of the first frame */
  t0: number;
  size: { width: number; height: number };
  /** the grey copy everything is read on */
  read: { width: number; height: number; frames: number };
  energy: {
    how: How;
    /** mean of the per-frame change (0..1) in each `binS` bin */
    bins: number[];
    binS: number;
    /** the share of frames with any change at all (≥ 0.0015) */
    movingShare: number;
  };
  stills: {
    how: How;
    under: number;
    minS: number;
    list: { start: number; end: number }[];
    share: number;
  };
  cuts: {
    how: How;
    /** `changed`: the share of the frame's blocks the cut changes */
    list: { t: number; frame: number; changed: number; nearestOnset: number | null }[];
    perMin: number;
    /** cuts per 5 s */
    density: number[];
    /** of them, cuts that change at least NEW_PICTURE of the frame (a new
     *  picture, not a word or a colour swapped inside a held one), per 5 s */
    densityNewPicture: number[];
    newPictureShare: number;
    densityBinS: number;
  };
  /** the stretches between hard cuts, film start and end included: every
   *  one-frame jump ends one (a word swapped on a held picture too) */
  shots: ShotStats & {
    how: How;
    /** the same, ended only by the cuts that change at least NEW_PICTURE of
     *  the frame */
    newPicture: ShotStats;
    /** the same, ended by small swaps too */
    withSwaps: ShotStats;
  };
  changes: { how: How; list: (PictureChange & { thumbs?: { before: string; after: string } })[] };
  sound: {
    how: How;
    onsets: number;
    onsetsPerS: number;
    /** share of the cuts with an onset within 40 / 80 ms */
    within40: number | null;
    within80: number | null;
    /** share of the film within 40 / 80 ms of an onset: what cuts at random times would get */
    chance40: number;
    chance80: number;
    medianAbsOffset: number | null;
  };
  declaredCuts: {
    how: How;
    file: string | null;
    list: number[];
    /** declared cuts with no picture cut within 1.5 frames, and the reverse */
    unseen: number[];
    undeclared: number[];
  };
  subjects: {
    how: How;
    tracks: { name: string; source: string; samples: number }[];
    exits: SubjectExit[];
  };
  marks: {
    how: How;
    list: { t: number; label: string; still: boolean; nearestCut: number | null }[];
  };
  /** one-frame jumps that change 2–12 % of the frame: too small for a cut */
  smallSwaps: { how: How; list: { t: number; changed: number }[]; perMin: number };
  /** the whole picture's scale and shift, read step by step (a camera move,
   *  or anything large enough to carry the picture with it) */
  camera: {
    how: How;
    /** seconds between the frames compared */
    stepS: number;
    /** share of the steps a single motion could be read for */
    read: number;
    /** over the film: every read step's zoom in multiplied together, and
     *  every zoom out (×), and how far the picture travelled (frame widths) */
    zoomIn: number | null;
    zoomOut: number | null;
    travel: number | null;
    runs: CameraRun[];
    reversals: { t: number; what: CameraRun["what"] }[];
    backAndForth: CameraBackForth[];
    repeated: CameraRepeat[];
  };
  /** the page's beat sheet beside what the picture did */
  segments: { how: How; source: "page" | "events file" | null; list: SegmentReading[] };
  /** how much of the frame is text, and how big */
  text: {
    how: How;
    every: number;
    /** the page's text (measured), read on the film clock */
    page: { how: How; file: string | null; note?: string };
    /** text read off the film's frames (estimated) */
    picture: { how: How; reader: "ocr" | "edges" | null };
    /** the width a phone is taken to show the film at (CSS px) */
    phoneWidth: number;
    /** film px × phoneScale = px on that phone */
    phoneScale: number;
    samples: TextSample[];
    perSecond: ReturnType<typeof textPerSecond>;
    overlaps: TextOverlap[];
  };
};

export type ShotStats = {
  /** seconds of each shot */
  lengths: number[];
  median: number | null;
  shortest: number | null;
  longest: number | null;
  /** spread of the shot lengths (standard deviation / mean) */
  cv: number | null;
};

function shotStats(cuts: readonly number[], duration: number): ShotStats {
  const bounds = [0, ...cuts, duration];
  const lengths = bounds.slice(1).map((b, i) => round3(b - bounds[i]!));
  const mean = lengths.reduce((a, b) => a + b, 0) / lengths.length;
  const sd = Math.sqrt(lengths.reduce((a, b) => a + (b - mean) ** 2, 0) / lengths.length);
  return {
    lengths,
    median: round3(median(lengths)),
    shortest: round3(Math.min(...lengths)),
    longest: round3(Math.max(...lengths)),
    cv: lengths.length > 1 && mean > 0 ? round2(sd / mean) : null,
  };
}

export type FilmProbeOptions = {
  input: string;
  /** default: `<input without extension>.probe/` */
  out?: string;
  /** default: `<input without extension>.events.json` when it exists */
  events?: string;
  /** draws probe.png; without it only the text, data and thumbnails */
  chromePath?: string;
  /** the seconds between `film sheet`'s frames, to mark the same times */
  every?: number;
  /** the film's page (an .html file or its folder): its text is read on the
   *  film clock (needs chromePath) and its beat sheet taken from it */
  page?: string;
  /** the directory the page is served from (as for `film render`) */
  root?: string;
  /** read the film's frames for text (default true): the system's text
   *  recognizer on macOS, else an edge count */
  text?: boolean;
  /** seconds between text samples (default 0.5) */
  textEvery?: number;
  onConsole?: (level: string, text: string) => void;
};

export async function filmProbe(opts: FilmProbeOptions): Promise<{
  /** the ruler and the first changes' thumbnails */
  png: string | null;
  /** probe.png and, when the changes run past one picture, probe-2.png… */
  pages: string[];
  md: string;
  json: string;
  probe: FilmProbe;
}> {
  const input = resolve(opts.input);
  if (!existsSync(input)) throw new Error(`film probe: no file at ${input}`);
  const stem = input.replace(/\.[^./]+$/, "");
  const outDir = resolve(opts.out ?? `${stem}.probe`);
  const [ffmpeg, ffprobe] = await Promise.all([resolveFfmpeg(), resolveFfprobe()]);
  const info = JSON.parse(
    await runTool(ffprobe, [
      "-v",
      "error",
      "-show_entries",
      "stream=codec_type,width,height,r_frame_rate,start_time:format=duration,start_time:format_tags",
      "-of",
      "json",
      input,
    ]),
  ) as {
    streams?: {
      codec_type?: string;
      width?: number;
      height?: number;
      r_frame_rate?: string;
      start_time?: string;
    }[];
    format?: { duration?: string; start_time?: string; tags?: Record<string, string> };
  };
  const video = info.streams?.find((s) => s.codec_type === "video");
  const audio = info.streams?.find((s) => s.codec_type === "audio");
  if (!video?.width || !video.height) throw new Error(`film probe: ${input} has no picture`);
  const duration = Number(info.format?.duration ?? 0);
  if (!(duration > 0)) throw new Error(`film probe: ${input} has no duration`);
  const fps = frameRate(video.r_frame_rate);
  // frame 0's time on the film's clock (the sound's clock): a stream may start late
  const t0 = Math.max(0, Number(video.start_time ?? 0) - Number(info.format?.start_time ?? 0)) || 0;

  const eventsPath = opts.events
    ? resolve(opts.events)
    : existsSync(`${stem}.events.json`)
      ? `${stem}.events.json`
      : null;
  if (opts.events && !existsSync(eventsPath!))
    throw new Error(`film probe: no events file at ${eventsPath}`);
  const rawEvents: unknown = eventsPath ? JSON.parse(await readFile(eventsPath, "utf8")) : null;

  const gh = Math.max(BLOCK, Math.round((PROBE_W * video.height) / video.width / 2) * 2);
  const [grey, pcm] = await Promise.all([
    decodeGrey(ffmpeg, input, PROBE_W, gh, fps).then((g) => ({ ...g, t0 })),
    audio ? decodeSound(ffmpeg, input) : Promise.resolve(null),
  ]);

  const energy = frameEnergy(grey);
  const cutFrames = findCuts(grey, energy);
  const stillUnder = 0.0015;
  const stillMin = 0.5;
  const stillRanges = findStills(energy, fps, stillMin, stillUnder);
  const changes = findChanges(grey, energy, cutFrames);
  const swaps = findSmallSwaps(grey, energy, cutFrames);
  const swapTimes = swaps.map((w) => round3(frameTime(grey, w.frame)));
  const path = cameraPath(grey, [...cutFrames, ...swaps.map((w) => w.frame)]);
  const runs = cameraRuns(path, fps);
  // what `film render` wrote into the film: where it starts on the page's
  // timeline and the size it was laid out at
  const record = filmRecordOf(info.format?.tags?.[FILM_TAG]);

  // the sound's onsets, as `film listen` finds them
  let onsets: number[] = [];
  if (pcm) {
    const s = spectrum(pcm);
    onsets = pickOnsets(s, onsetStrength(s), pcm).map(round3);
  }
  const cutTimes = cutFrames.map((f) => round3(frameTime(grey, f)));
  const changedAt = new Map(
    changes.filter((c) => c.kind === "hard cut").map((c) => [c.frame, c.changed]),
  );
  const cutList = cutTimes.map((t, i) => ({
    t,
    frame: cutFrames[i]!,
    changed: round2(changedAt.get(cutFrames[i]!) ?? 0),
    nearestOnset: pcm ? nearestOffset(onsets, t) : null,
  }));
  const offs = cutList.map((c) => c.nearestOnset).filter((v): v is number => v != null);
  const share = (w: number) =>
    offs.length ? round2(offs.filter((o) => Math.abs(o) <= w + 1e-9).length / offs.length) : null;

  const newPictureTimes = cutList.filter((c) => c.changed >= NEW_PICTURE).map((c) => c.t);

  const binS = 1;
  const eBins = Array.from({ length: Math.ceil(duration / binS - 1e-9) }, (_, b) => {
    const a = Math.max(0, Math.floor((b * binS - t0) * fps));
    const z = Math.min(grey.count, Math.floor(((b + 1) * binS - t0) * fps));
    let s = 0;
    for (let i = a; i < z; i++) s += energy[i]!;
    return z > a ? round4(s / (z - a)) : 0;
  });
  let moving = 0;
  for (let i = 1; i < grey.count; i++) if (energy[i]! >= stillUnder) moving++;
  const stillFrames = stillRanges.reduce((a, r) => a + (r.b - r.a), 0);

  // what the events file says
  const ev = rawEvents ? parseFilmEvents(rawEvents) : null;
  const rawObj = (rawEvents && typeof rawEvents === "object" ? rawEvents : {}) as Record<
    string,
    unknown
  >;
  const declared = (Array.isArray(rawObj.declaredCuts) ? rawObj.declaredCuts : (ev?.cuts ?? []))
    .filter((v): v is number => typeof v === "number" && Number.isFinite(v))
    .sort((a, b) => a - b);
  const tol = 1.5 / fps;
  // the events file is on the page's clock; the film starts at `from` on it
  const tracks = (rawEvents ? subjectTracks(rawEvents) : []).map((tr) => ({
    ...tr,
    samples: tr.samples.map((x) => ({ ...x, t: x.t - (record?.from ?? 0) })),
  }));
  const exits = subjectExits(tracks, video.width, video.height, duration);
  const marks = (ev?.events ?? [])
    .filter((e) => e.kind === "mark")
    .map((e) => {
      const f = Math.round((e.t - t0) * fps);
      return {
        t: round3(e.t),
        label: e.label ?? "",
        still: stillRanges.some((r) => f >= r.a && f < r.b),
        nearestCut: cutTimes.length ? nearestOffset(cutTimes, e.t) : null,
      };
    });

  // the camera over the film: its zoom against the start, its travel
  const vw = video.width;
  const vh = video.height;
  let zin = 0;
  let zout = 0;
  let travel = 0;
  let readSteps = 0;
  path.logScale.forEach((v, k) => {
    if (v == null) return;
    readSteps++;
    if (v > 0) zin += v;
    else zout += v;
    travel += Math.hypot(path.dx[k] ?? 0, ((path.dy[k] ?? 0) * vh) / vw);
  });

  // the page: its text over the film's time, its beat sheet as it is now
  const textEvery = opts.textEvery ?? 0.5;
  const sampleTimes: number[] = [];
  for (let k = 0; k * textEvery < duration - 0.5 / fps; k++)
    sampleTimes.push(round3(k * textEvery));
  const from = record?.from ?? 0;
  let pageRead: Awaited<ReturnType<typeof readPageText>> | null = null;
  let pageNote: string | undefined;
  if (opts.page && !opts.chromePath) pageNote = "no Chrome to play the page in";
  else if (opts.page)
    pageRead = await readPageText({
      page: opts.page,
      root: opts.root,
      chromePath: opts.chromePath!,
      from,
      times: sampleTimes,
      width: record?.width || undefined,
      height: record?.height || undefined,
      fallback: { width: video.width, height: video.height },
      onConsole: opts.onConsole,
    }).catch((e: Error) => {
      // the rest of the probe does not need the page
      pageNote = `the page could not be played: ${e.message.split("\n")[0]}`;
      return null;
    });
  if (pageRead?.failed.length)
    pageNote = `the page threw at ${pageRead.failed.length} of ${sampleTimes.length} sample time(s), left out (first at ${pageRead.failed[0]!.t} s: ${pageRead.failed[0]!.error})`;
  // the page's CSS px as the film's px
  const k = pageRead ? video.width / pageRead.width : 1;
  const pageSamples = pageRead?.samples.map((x) => scalePageSample(x, k)) ?? null;
  const sheetRaw =
    pageRead && Array.isArray(pageRead.segments) ? pageRead.segments : rawObj.segments;
  // on the film's clock; a segment wholly outside a film of part of the page is left out
  const sheet = sheetSegments(sheetRaw)
    .map((x) => ({ ...x, from: x.from - from, to: x.to - from }))
    .filter((x) => x.to > 0 && x.from < duration);
  const frameText =
    opts.text === false
      ? null
      : await readFrameText({
          ffmpeg,
          input,
          times: sampleTimes,
          width: video.width,
          height: video.height,
        });
  const text = textTimeline(pageSamples, frameText?.frames ?? null, {
    width: video.width,
    height: video.height,
    segments: sheet,
    every: textEvery,
  });
  const segReadings = readSegments(sheet, {
    duration,
    fps,
    t0,
    energy,
    stillUnder,
    cuts: cutTimes,
    swaps: swapTimes,
    changes,
    path,
    runs,
    tracks,
    width: video.width,
    height: video.height,
    pageSubjects: pageSamples
      ? (sel) =>
          pageSamples.some((x) => sel in x.subjects)
            ? pageSamples.map((x) => ({ t: x.t, box: x.subjects[sel] ?? null }))
            : null
      : undefined,
    onsets: pcm ? onsets : null,
  });

  const probe: FilmProbe = {
    input,
    duration: round3(duration),
    fps: round2(fps),
    t0: round3(t0),
    size: { width: video.width, height: video.height },
    read: { width: grey.w, height: grey.h, frames: grey.count },
    energy: {
      how: grey.count > 1 ? "measured" : "not measured",
      bins: eBins,
      binS,
      movingShare: round2(moving / Math.max(1, grey.count - 1)),
    },
    stills: {
      how: stillRanges.length ? "measured" : "not detected",
      under: stillUnder,
      minS: stillMin,
      list: stillRanges.map((r) => ({
        start: round3(frameTime(grey, r.a)),
        end: round3(frameTime(grey, r.b)),
      })),
      share: round2(stillFrames / Math.max(1, grey.count)),
    },
    cuts: {
      how: cutList.length ? "measured" : "not detected",
      list: cutList,
      perMin: round1((cutList.length / duration) * 60),
      density: cutDensity(cutTimes, duration, 5),
      densityNewPicture: cutDensity(newPictureTimes, duration, 5),
      newPictureShare: NEW_PICTURE,
      densityBinS: 5,
    },
    shots: {
      how: "measured",
      ...shotStats(cutTimes, duration),
      newPicture: shotStats(newPictureTimes, duration),
      withSwaps: shotStats(
        [...cutTimes, ...swapTimes].sort((a, b) => a - b),
        duration,
      ),
    },
    changes: { how: changes.length ? "estimated" : "not detected", list: changes.map(roundChange) },
    sound: {
      how: !pcm ? "not measured" : onsets.length ? "measured" : "not detected",
      onsets: onsets.length,
      onsetsPerS: round1(onsets.length / duration),
      within40: share(0.04),
      within80: share(0.08),
      chance40: chanceWithin(onsets, duration, 0.04),
      chance80: chanceWithin(onsets, duration, 0.08),
      medianAbsOffset: offs.length ? round3(median(offs.map(Math.abs))) : null,
    },
    declaredCuts: {
      how: !rawEvents ? "not measured" : declared.length ? "measured" : "not detected",
      file: eventsPath,
      list: declared.map(round3),
      unseen: declared.filter((d) => !cutTimes.some((c) => Math.abs(c - d) <= tol)).map(round3),
      undeclared: rawEvents
        ? cutTimes.filter((c) => !declared.some((d) => Math.abs(c - d) <= tol))
        : [],
    },
    subjects: {
      how: !tracks.length ? "not measured" : exits.length ? "estimated" : "not detected",
      tracks: tracks.map((t) => ({ name: t.name, source: t.source, samples: t.samples.length })),
      exits,
    },
    marks: {
      how: !rawEvents ? "not measured" : marks.length ? "measured" : "not detected",
      list: marks,
    },
    smallSwaps: {
      how: swaps.length ? "measured" : "not detected",
      list: swaps.map((w, i) => ({ t: swapTimes[i]!, changed: round2(w.changed) })),
      perMin: round1((swaps.length / duration) * 60),
    },
    camera: {
      how: !path.t.length ? "not measured" : readSteps ? "estimated" : "not detected",
      stepS: round3(path.step / fps),
      read: round2(path.t.length ? readSteps / path.t.length : 0),
      zoomIn: readSteps ? round3(Math.exp(zin)) : null,
      zoomOut: readSteps ? round3(Math.exp(zout)) : null,
      travel: readSteps ? round2(travel) : null,
      runs,
      reversals: reversals(runs),
      backAndForth: backAndForth(runs),
      repeated: repeatedRuns(runs),
    },
    segments: {
      how: sheet.length ? "measured" : pageRead || rawEvents ? "not detected" : "not measured",
      source: sheet.length
        ? pageRead && Array.isArray(pageRead.segments)
          ? "page"
          : "events file"
        : null,
      list: segReadings,
    },
    text: {
      how: pageSamples ? "measured" : frameText ? "estimated" : "not measured",
      every: textEvery,
      page: {
        how: pageSamples ? "measured" : "not measured",
        file: opts.page ? resolve(opts.page) : null,
        ...(pageNote ? { note: pageNote } : {}),
      },
      picture: { how: frameText ? "estimated" : "not measured", reader: frameText?.how ?? null },
      phoneWidth: PHONE_W,
      phoneScale: round4(PHONE_W / video.width),
      samples: text.samples,
      perSecond: textPerSecond(text.samples, duration),
      overlaps: text.overlaps,
    },
  };

  await mkdir(outDir, { recursive: true });
  // before/after thumbnails of each change
  const thumbDir = join(outDir, "changes");
  await mkdir(thumbDir, { recursive: true });
  await writeThumbs(ffmpeg, input, fps, probe, thumbDir);

  const md = join(outDir, "probe.md");
  const json = join(outDir, "probe.json");
  await writeFile(md, `${formatFilmProbe(probe)}\n`);
  await writeFile(
    json,
    `${JSON.stringify({
      ...probe,
      energyPerFrame: Array.from(energy, round4),
      cameraPerStep: {
        t: path.t.map(round3),
        logScale: path.logScale.map((v) => (v == null ? null : round6(v))),
        dx: path.dx.map((v) => (v == null ? null : round6(v))),
        dy: path.dy.map((v) => (v == null ? null : round6(v))),
      },
    })}\n`,
  );
  let png: string | null = null;
  let pages: string[] = [];
  if (opts.chromePath) {
    png = join(outDir, "probe.png");
    pages = await drawProbe(probe, {
      chromePath: opts.chromePath,
      out: png,
      energy,
      onsets,
      path,
      every: opts.every ?? defaultSheetEvery(duration),
      outDir,
    });
  }
  return { png, pages, md, json, probe };
}

const roundChange = (c: PictureChange): PictureChange => ({
  ...c,
  t: round3(c.t),
  changed: round2(c.changed),
  stays: round2(c.stays),
  carried: round2(c.carried),
  background: round2(c.background),
  shift: c.shift ? { x: round1(c.shift.x), y: round1(c.shift.y) } : null,
});

async function writeThumbs(
  ffmpeg: string,
  input: string,
  fps: number,
  probe: FilmProbe,
  dir: string,
): Promise<void> {
  const jobs: { frame: number; file: string }[] = [];
  probe.changes.list.forEach((c, i) => {
    const n = String(i + 1).padStart(3, "0");
    const before = join(dir, `${n}-before.jpg`);
    const after = join(dir, `${n}-after.jpg`);
    c.thumbs = { before: `changes/${basename(before)}`, after: `changes/${basename(after)}` };
    jobs.push({ frame: c.before, file: before }, { frame: c.after, file: after });
  });
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(6, jobs.length) }, async () => {
      while (next < jobs.length) {
        const j = jobs[next++]!;
        // the first frame at or after a quarter frame before this one's time: this one
        await runTool(ffmpeg, [
          "-v",
          "error",
          "-ss",
          String(Math.max(0, probe.t0 + (j.frame - 0.25) / fps)),
          "-i",
          input,
          "-frames:v",
          "1",
          "-vf",
          "scale=480:-2",
          "-q:v",
          "4",
          "-y",
          j.file,
        ]).catch(() => {});
      }
    }),
  );
  for (const c of probe.changes.list)
    if (c.thumbs && !existsSync(join(dir, basename(c.thumbs.before)))) delete c.thumbs;
}

/** every frame as grey w×h; frames past the stream's end are not invented */
export function decodeGrey(
  ffmpeg: string,
  file: string,
  w: number,
  h: number,
  fps: number,
): Promise<GreyFrames> {
  return new Promise((ok, fail) => {
    const p = spawn(
      ffmpeg,
      [
        "-v",
        "error",
        "-i",
        file,
        "-an",
        "-vf",
        `scale=${w}:${h}:flags=area,format=gray`,
        "-vsync",
        "passthrough",
        "-f",
        "rawvideo",
        "-",
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    const chunks: Buffer[] = [];
    let err = "";
    p.stdout.on("data", (d: Buffer) => chunks.push(d));
    p.stderr.on("data", (d: Buffer) => {
      err += d.toString();
    });
    p.on("error", fail);
    p.on("close", (code) => {
      if (code !== 0)
        return fail(new Error(`ffmpeg could not read ${file}: ${err.trim().slice(-400)}`));
      const all = Buffer.concat(chunks);
      const count = Math.floor(all.length / (w * h));
      ok({ w, h, fps, count, data: new Uint8Array(all.buffer, all.byteOffset, count * w * h) });
    });
  });
}

function decodeSound(ffmpeg: string, file: string): Promise<Float32Array> {
  return new Promise((ok, fail) => {
    const p = spawn(
      ffmpeg,
      [
        "-v",
        "error",
        "-i",
        file,
        "-vn",
        "-ac",
        "1",
        "-ar",
        String(LISTEN_RATE),
        "-f",
        "f32le",
        "-",
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    const chunks: Buffer[] = [];
    let err = "";
    p.stdout.on("data", (d: Buffer) => chunks.push(d));
    p.stderr.on("data", (d: Buffer) => {
      err += d.toString();
    });
    p.on("error", fail);
    p.on("close", (code) => {
      if (code !== 0)
        return fail(new Error(`ffmpeg could not decode ${file}: ${err.trim().slice(-400)}`));
      const all = Buffer.concat(chunks);
      ok(new Float32Array(all.buffer.slice(all.byteOffset, all.byteOffset + (all.length & ~3))));
    });
  });
}

// --- the report ------------------------------------------------------------------------------

const fmtT = (t: number) => {
  if (t < 60) return `${t.toFixed(2)}s`;
  const m = Math.floor(t / 60);
  return `${m}:${(t - m * 60).toFixed(2).padStart(5, "0")}`;
};
const pct = (v: number | null) => (v == null ? "–" : `${Math.round(v * 100)}%`);
const ms = (v: number | null) =>
  v == null ? "–" : `${v >= 0 ? "+" : ""}${Math.round(v * 1000)} ms`;

export function formatFilmProbe(p: FilmProbe): string {
  const L: string[] = [];
  const frameS = 1 / p.fps;
  L.push(`# film probe — ${basename(p.input)}`);
  L.push("");
  L.push(
    `${p.duration.toFixed(2)} s, ${p.size.width}×${p.size.height} at ${p.fps} fps; read as ${p.read.width}×${p.read.height} grey, ${p.read.frames} frames. Each line says how it was found: measured, estimated, not detected, not measured. Nothing here is a grade or a target.`,
  );
  L.push("");
  L.push("## Picture energy");
  L.push(
    `[${p.energy.how}] how much the picture changes each frame (mean grey difference, 0..1). The picture changes in ${pct(p.energy.movingShare)} of frames.`,
  );
  L.push(`Mean per second: ${p.energy.bins.map((v) => v.toFixed(3)).join(" ")}`);
  L.push("");
  L.push("## No change seen at 192 px");
  L.push(
    p.stills.list.length
      ? `[measured] ${p.stills.list.length} stretch(es) of ≥ ${p.stills.minS} s where no frame changes by ${p.stills.under} or more on the ${p.read.width}-px grey copy, ${pct(p.stills.share)} of the film: ${p.stills.list.map((s) => `${fmtT(s.start)}–${fmtT(s.end)}`).join(", ")}. A slow cursor, a slow push or a sub-pixel shake can sit under this line — the camera section reads slow motion that this does not.`
      : `[not detected] no stretch of ≥ ${p.stills.minS} s without a change on the ${p.read.width}-px grey copy`,
  );
  L.push("");
  L.push("## Cuts and shots");
  if (p.cuts.list.length) {
    L.push(
      `[measured] ${p.cuts.list.length} hard cuts (a one-frame jump of the picture), ${p.cuts.perMin} per minute: ${p.cuts.list.map((c) => fmtT(c.t)).join(" ")}`,
    );
  } else L.push("[not detected] no hard cut — the picture never jumps in one frame");
  L.push(
    p.smallSwaps.list.length
      ? `[measured] ${p.smallSwaps.list.length} small swap(s) besides — a one-frame jump of 2–12 % of the frame (a word, a number, a panel swapped while the picture holds), ${p.smallSwaps.perMin} per minute: ${p.smallSwaps.list.map((w) => `${fmtT(w.t)} (${pct(w.changed)})`).join(" ")}`
      : "[not detected] no small swap (a one-frame jump of 2–12 % of the frame)",
  );
  const shotLine = (what: string, s: ShotStats) =>
    `[measured] ${s.lengths.length} ${what}; length median ${s.median} s, shortest ${s.shortest} s, longest ${s.longest} s${s.cv != null ? `, spread (sd/mean) ${s.cv}` : ""}`;
  L.push(shotLine("stretch(es) between any two hard cuts", p.shots));
  L.push(`Lengths (s): ${p.shots.lengths.join(" ")}`);
  if (p.shots.withSwaps.lengths.length !== p.shots.lengths.length) {
    L.push(shotLine("stretch(es) between any jump, small swaps included", p.shots.withSwaps));
    L.push(`Lengths (s): ${p.shots.withSwaps.lengths.join(" ")}`);
  }
  if (p.cuts.list.length) {
    L.push(`[measured] cuts per ${p.cuts.densityBinS} s: ${p.cuts.density.join(" ")}`);
    const np = p.cuts.list.filter((c) => c.changed >= p.cuts.newPictureShare).length;
    L.push(
      `Of the cuts, ${np} change ≥ ${pct(p.cuts.newPictureShare)} of the frame (a new picture); per ${p.cuts.densityBinS} s: ${p.cuts.densityNewPicture.join(" ")}${p.shots.newPicture.lengths.length !== p.shots.lengths.length ? `; shots between them: median ${p.shots.newPicture.median} s, longest ${p.shots.newPicture.longest} s` : ""}`,
    );
    L.push(
      "Cut counts and shot lengths describe pace; on their own they have not gone one way with which films people preferred.",
    );
  }
  if (p.declaredCuts.how !== "not measured") {
    L.push(
      p.declaredCuts.list.length
        ? `[measured] the events file declares ${p.declaredCuts.list.length} cut(s); not seen in the picture (±1.5 frames): ${p.declaredCuts.unseen.map(fmtT).join(" ") || "none"}; seen but not declared: ${p.declaredCuts.undeclared.map(fmtT).join(" ") || "none"}`
        : "[not detected] the events file declares no cuts",
    );
  }
  L.push("");
  L.push("## Camera");
  const cam = p.camera;
  if (cam.how === "estimated") {
    L.push(
      `[estimated] the whole picture's scale and shift, read every ${cam.stepS} s on the grey copy to a fraction of a pixel — a camera move, or anything large enough to carry the picture with it; read for ${pct(cam.read)} of the steps (not across cuts or swaps, nor where the picture changes otherwise). Over the film the zooming in adds up to ×${cam.zoomIn}, the zooming out to ×${cam.zoomOut} (sub-pixel steps included); the picture travels ${cam.travel} frame widths in all.`,
    );
    const runText = (r: CameraRun) =>
      r.what === "zoom"
        ? `zoom ${r.dir} ×${r.amount} ${fmtT(r.start)}–${fmtT(r.end)}`
        : `moves ${r.dir} ${pct(Math.abs(r.amount))} ${fmtT(r.start)}–${fmtT(r.end)}`;
    L.push(
      cam.runs.length
        ? `Runs (zoom ≥ 1 %/s adding up to ≥ 1.2 %; the picture moving ≥ 2 % of the frame a second, adding up to ≥ 3 %): ${cam.runs.map(runText).join(", ")}`
        : "[not detected] no run of zoom or movement",
    );
    if (cam.reversals.length)
      L.push(
        `Turns back (a run the other way within 1 s of the last of its kind), ${cam.reversals.length}: ${cam.reversals.map((r) => `${fmtT(r.t)} ${r.what}`).join(", ")}`,
      );
    for (const r of cam.repeated)
      L.push(
        `- the same ${r.what === "zoom" ? `zoom ${r.dir}` : `move ${r.dir}`} again and again ${fmtT(r.start)}–${fmtT(r.end)}: ${r.runs} times, one every ${r.every} s, each after a pause (information — a pulse on the beat can be meant)`,
      );
    for (const b of cam.backAndForth)
      L.push(
        `- ${b.what === "zoom" ? "zoom in and out" : `${b.what === "pan x" ? "side to side" : "up and down"}`} ${fmtT(b.start)}–${fmtT(b.end)}: ${b.runs} runs in a row, each the other way to the one before (information — it can be meant)`,
      );
  } else
    L.push(
      `[${cam.how}] no motion of the whole picture could be read${cam.how === "not detected" ? " (every step changed in a way no single scale and shift explains)" : ""}`,
    );
  L.push("");
  L.push("## Cuts against the sound");
  if (p.sound.how === "not measured") L.push("[not measured] the film has no sound");
  else if (!p.sound.onsets) L.push("[not detected] no onsets in the sound");
  else if (!p.cuts.list.length)
    L.push(
      `[measured] ${p.sound.onsets} onsets (${p.sound.onsetsPerS}/s); no cuts to set against them`,
    );
  else {
    const off = p.cuts.list.filter(
      (c) => c.nearestOnset != null && Math.abs(c.nearestOnset) > frameS + 1e-6,
    ).length;
    L.push(
      `[measured] median distance from a cut to the nearest onset ${ms(p.sound.medianAbsOffset)}; ${off} of ${p.cuts.list.length} cut(s) sit more than one frame (${Math.round(frameS * 1000)} ms) from any onset (${p.sound.onsets} onsets, ${p.sound.onsetsPerS}/s, as \`film listen\` finds them).`,
    );
    L.push(
      `Offset of each cut to its nearest onset (− = the onset comes first): ${p.cuts.list.map((c) => `${fmtT(c.t)} ${ms(c.nearestOnset)}`).join(", ")}`,
    );
    L.push(
      `Cuts with an onset within 40 ms: ${pct(p.sound.within40)} (a cut at a random time: ${pct(p.sound.chance40)}); within 80 ms: ${pct(p.sound.within80)} (random: ${pct(p.sound.chance80)}). Cutting on onsets is one way to cut; a film can cut across them on purpose.`,
    );
  }
  L.push("");
  L.push("## Beat sheet");
  if (p.segments.how === "not measured")
    L.push(
      "[not measured] no beat sheet: none in an events file and no page given (kit/time.js `tl.segment(from, to, { hold, handoff, subject, sound })`)",
    );
  else if (!p.segments.list.length) L.push("[not detected] the page declares no segments");
  else {
    L.push(
      `[measured] ${p.segments.list.length} segment(s) from the ${p.segments.source}, each set beside what the picture did. The sheet is yours; a difference is information, not an error.`,
    );
    for (const s of p.segments.list) L.push(...formatSegment(s, p));
  }
  L.push("");
  L.push(...formatText(p));
  L.push("");
  L.push("## Declared subjects");
  if (p.subjects.how === "not measured")
    L.push(
      '[not measured] the events file declares no subject positions (curves `<name>.x`/`<name>.y`, optional `.w`/`.h`, or events of kind "subject" with x, y, label)',
    );
  else {
    L.push(
      `[${p.subjects.how}] from the positions the page declared (stage px, taken as the film's ${p.size.width}×${p.size.height}), not seen in the picture: ${p.subjects.tracks.map((t) => `${t.name} (${t.source}, ${t.samples} samples)`).join(", ")}`,
    );
    if (!p.subjects.exits.length) L.push("No declared subject leaves the frame.");
    for (const e of p.subjects.exits)
      L.push(`- ${e.name}: ${e.how} past the ${e.edge} edge ${fmtT(e.start)}–${fmtT(e.end)}`);
  }
  if (p.marks.how !== "not measured") {
    L.push("");
    L.push("## Named moments");
    if (!p.marks.list.length)
      L.push('[not detected] the events file names no moments (kind "mark")');
    for (const m of p.marks.list)
      L.push(
        `- [measured] ${fmtT(m.t)} ${m.label || "(unnamed)"}: ${m.still ? "no change seen at 192 px" : "picture changing"}${m.nearestCut != null ? `, nearest cut ${ms(m.nearestCut)}` : ""}`,
      );
  }
  L.push("");
  L.push("## Big changes of picture");
  L.push(
    "[estimated] every cut, and every moment where ≥ 40 % of the frame differs between ¼ s before and ¼ s after. What crosses each: carried = textured regions covering ≥ 10 % of the frame stay in place or are followed frame to frame into the new picture; background only = less than that, but ≥ 25 % of the frame is flat and keeps its grey; nothing carried = neither. The share numbers are the frame's blocks (8×8 on the grey copy). Thumbnails: changes/NNN-before.jpg, -after.jpg.",
  );
  if (!p.changes.list.length) L.push("[not detected] no big change of picture");
  p.changes.list.forEach((c, i) => {
    const across = c.kind === "hard cut" ? ` — across it: ${c.across}` : "";
    const shift =
      c.shift &&
      c.carried >= CARRIED_SHARE &&
      (Math.abs(c.shift.x) >= 1 || Math.abs(c.shift.y) >= 1)
        ? `, carried part moves ${c.shift.x > 0 ? "+" : ""}${c.shift.x}% x ${c.shift.y > 0 ? "+" : ""}${c.shift.y}% y`
        : "";
    const span =
      c.after - c.before > 1 ? ` (over ${((c.after - c.before) / p.fps).toFixed(2)} s)` : "";
    L.push(
      `${String(i + 1).padStart(3)}. ${fmtT(c.t)} ${c.kind}${across}${span}: changed ${pct(c.changed)}, stays ${pct(c.stays)}, carried ${pct(c.carried)}, background kept ${pct(c.background)}${shift}`,
    );
  });
  if (p.changes.list.length) {
    const counts = new Map<string, number>();
    for (const c of p.changes.list) counts.set(c.kind, (counts.get(c.kind) ?? 0) + 1);
    L.push(`Counts: ${[...counts].map(([k, n]) => `${k} ${n}`).join(", ")}`);
  }
  return L.join("\n");
}

function formatSegment(s: SegmentReading, p: FilmProbe): string[] {
  const L: string[] = [];
  const said = [
    s.label ? `"${s.label}"` : "",
    s.hold ? "hold" : "",
    s.handoff ? `handoff: ${s.handoff}` : "",
    s.subject ? `subject: ${s.subject}` : "",
    s.sound ? `sound: ${s.sound}` : "",
  ].filter(Boolean);
  L.push(`- ${fmtT(s.from)}–${fmtT(s.to)}${said.length ? ` ${said.join(" · ")}` : ""}`);
  const cam = s.camera;
  const camText = cam
    ? Math.abs(cam.zoom - 1) < 0.003 && Math.abs(cam.x) < 0.003 && Math.abs(cam.y) < 0.003
      ? s.runs.length
        ? "the picture ends at the scale and place it started"
        : "no camera motion read (under ×1.003 and 0.3 % of the frame)"
      : `the picture ${Math.abs(cam.zoom - 1) >= 0.003 ? `scales ×${cam.zoom}` : "keeps its scale"}${Math.abs(cam.x) >= 0.003 || Math.abs(cam.y) >= 0.003 ? `, moves ${signed(cam.x)} x ${signed(cam.y)} y of the frame` : ""}`
    : "camera not read";
  const where = s.movingSpans.length
    ? ` (changing ${s.movingSpans
        .slice(0, 6)
        .map((m) => `${fmtT(m.start)}–${fmtT(m.end)}`)
        .join(", ")}${s.movingSpans.length > 6 ? ", …" : ""})`
    : "";
  const jumps = [
    s.cuts.length ? `${s.cuts.length} cut(s) ${s.cuts.map(fmtT).join(" ")}` : "",
    s.swaps.length ? `${s.swaps.length} small swap(s)` : "",
  ]
    .filter(Boolean)
    .join(", ");
  // the runs too: a zoom in and back out sums to no zoom over the segment
  const runs = s.runs.length
    ? ` — runs: ${s.runs.map((r) => (r.what === "zoom" ? `zoom ${r.dir} ×${r.amount}` : `moves ${r.dir}`)).join(", ")}`
    : "";
  if (s.hold) {
    const still = s.moving === 0 && !s.cuts.length && !s.swaps.length;
    const camStill =
      !s.runs.length &&
      (!cam ||
        (Math.abs(cam.zoom - 1) < 0.003 && Math.abs(cam.x) < 0.003 && Math.abs(cam.y) < 0.003));
    L.push(
      `  written to hold${still && camStill ? ":" : " —"} [measured] ${
        still
          ? `no change seen at ${p.read.width} px`
          : `the picture still changes in ${pct(s.moving)} of its frames${where}${jumps ? `; ${jumps}` : ""}`
      }; [estimated] ${camText}${runs}`,
    );
  } else
    L.push(
      `  [measured] the picture changes in ${pct(s.moving)} of its frames${jumps ? `; ${jumps}` : ""}; [estimated] ${camText}${runs}`,
    );
  if (s.subjectSeen) {
    const ss = s.subjectSeen;
    const src =
      ss.source === "page" ? "found on the page" : ss.source ? `declared ${ss.source}` : "";
    L.push(
      ss.how === "not measured"
        ? `  subject ${s.subject}: [not measured] no element on the page and no declared track has that name${p.text.page.how === "not measured" ? " (give the page to look it up)" : ""}`
        : ss.out.length
          ? `  subject ${s.subject} [${ss.how}, ${src}]: ${ss.out.map((o) => `${o.how}${o.edge ? ` past the ${o.edge} edge` : ""} ${fmtT(o.start)}–${fmtT(o.end)}`).join(", ")} (information — leaving can be meant)`
          : `  subject ${s.subject} [${ss.how === "not detected" ? (ss.source === "page" ? "measured" : "estimated") : ss.how}, ${src}]: stays in the frame`,
    );
  }
  if (s.handoff && s.handoffSeen) {
    const h = s.handoffSeen;
    L.push(
      `  handoff written: ${s.handoff} · seen at ${fmtT(s.to)} [${h.how}]: ${h.kind}${h.at != null ? ` at ${fmtT(h.at)}` : ""}${h.across ? `, across it: ${h.across}` : ""}${h.nearestOnset != null ? `; nearest onset ${ms(h.nearestOnset)}` : ""}`,
    );
  }
  return L;
}

function formatText(p: FilmProbe): string[] {
  const L: string[] = [];
  const T = p.text;
  const ph = (px: number | null) =>
    px == null ? "–" : `${round1(px)} (${round1(px * T.phoneScale)})`;
  L.push("## Text at film scale");
  if (T.how === "not measured") {
    L.push(
      "[not measured] no text read: give the page (`film probe <film.mp4> --page film/`) and leave the frames' text reading on",
    );
    return L;
  }
  L.push(
    `[${T.how}] how much of the frame is text and how big it is drawn, every ${T.every} s. Sizes are film px (${p.size.width} wide), and in brackets as on a phone showing the film ${T.phoneWidth} px wide (×${T.phoneScale}; for scale, a phone's body text is about 17 px). Information, not a limit.`,
  );
  L.push(
    T.page.how === "measured"
      ? `Page text [measured]: read on the film clock where its glyphs are drawn, at the size drawn — the film's own text apart from the product's text in saved screens (iframes); its share counts its line boxes.${T.page.note ? ` Note: ${T.page.note}.` : ""}`
      : `Page text [not measured]: ${T.page.note ?? "no page given (--page <film folder>)"}`,
  );
  L.push(
    T.picture.reader === "ocr"
      ? `Text in pictures [estimated]: the frames read by the system's text recognizer${T.page.how === "measured" ? " — lines that are not page text" : " (all text: no page given to tell page text apart)"}; a size is the line's height as read (close to the font size); very small or stylised text can be missed.`
      : T.picture.reader === "edges"
        ? "Text in pictures [estimated]: an edge count of text-like cells — a share only, no size; photos and fine texture count too."
        : "Text in pictures [not measured]: the frames were not read.",
  );
  const S = T.samples;
  const withText = S.filter((s) => s.share > 0.002).length;
  const shares = S.map((s) => s.share);
  const busiest = [...S].sort((a, b) => b.share - a.share)[0];
  const mostChars = [...S].filter((s) => s.chars != null).sort((a, b) => b.chars! - a.chars!)[0];
  const smallest = [...S]
    .filter((s) => s.smallest)
    .sort((a, b) => a.smallest!.px - b.smallest!.px)[0];
  const meds = S.map((s) => s.median).filter((v): v is number => v != null);
  L.push(
    `Over the film: text on screen in ${withText} of ${S.length} samples; share of the frame median ${pct(median(shares))}, most ${pct(busiest?.share ?? 0)} at ${busiest ? fmtT(busiest.t) : "–"}${busiest && busiest.own != null ? ` (the film's own ${pct(busiest.own)}, the product's ${pct(busiest.product)}${busiest.picture != null ? `, in pictures ${pct(busiest.picture)}` : ""})` : busiest?.picture != null ? "" : ""}.`,
  );
  if (mostChars)
    L.push(
      `Most characters on screen at once: ${mostChars.chars} at ${fmtT(mostChars.t)}${mostChars.ownChars != null ? ` (own ${mostChars.ownChars}, product ${mostChars.productChars}${mostChars.pictureChars != null ? `, in pictures ${mostChars.pictureChars}` : ""})` : ""}; median over the samples ${median(S.map((s) => s.chars ?? 0))}.`,
    );
  if (smallest?.smallest)
    L.push(
      `Smallest text: ${ph(smallest.smallest.px)} px at ${fmtT(smallest.t)} (${smallest.smallest.from === "page" ? "page, measured" : "in a picture, estimated"})${smallest.smallest.text ? ` — ${smallest.smallest.text}` : ""}; median size over the samples ${ph(meds.length ? median(meds) : null)} px.`,
    );
  // the product's words are told from the film's own only with the page
  const parts =
    T.page.how === "measured"
      ? productTextSpans(S, T.phoneScale, T.every, { pictures: T.picture.reader === "ocr" })
      : [];
  if (parts.length)
    L.push(
      `Where the product's own words (saved screens${T.picture.reader === "ocr" ? ", text in pictures" : ""}) are most of the frame's text, or their median size reads under ${PHONE_SMALL_PX} px on the phone: ${parts
        .slice(0, 12)
        .map(
          (s) =>
            `${fmtT(s.from)}–${fmtT(s.to)} (up to ${pct(s.productShare)} of the text${s.phoneMedian != null ? `; their median down to ${s.phoneMedian} px on the phone` : ""})`,
        )
        .join(
          ", ",
        )}${parts.length > 12 ? `, … ${parts.length - 12} more` : ""}. What acts on part of a screen: \`lift\` (one part as a layer of its own) and \`isolate\` (the rest faded) in kit/media.js, \`cam.frame\` (the camera on one box) in kit/camera.js — \`skill film material\`. Information, not a target.`,
    );
  const ps = T.perSecond;
  L.push(
    `Per second, share of the frame that is text: ${ps.map((b) => Math.round(b.share * 100)).join(" ")} (%)`,
  );
  if (ps.some((b) => b.chars != null))
    L.push(`Per second, most characters at once: ${ps.map((b) => b.chars ?? "–").join(" ")}`);
  if (ps.some((b) => b.median != null)) {
    L.push(
      `Per second, median text size, film px: ${ps.map((b) => (b.median == null ? "–" : Math.round(b.median))).join(" ")}`,
    );
    L.push(
      `Per second, median text size on the phone, px: ${ps.map((b) => (b.median == null ? "–" : round1(b.median * T.phoneScale))).join(" ")}`,
    );
    L.push(
      `Per second, smallest text, film px: ${ps.map((b) => (b.smallest == null ? "–" : Math.round(b.smallest))).join(" ")}`,
    );
  }
  if (T.page.how === "measured")
    L.push(
      T.overlaps.length
        ? `The film's own text over something else [measured on the page; text in pictures estimated]: ${T.overlaps
            .slice(0, 40)
            .map((o) => `${o.text} over ${o.over} ${fmtT(o.from)}–${fmtT(o.to)}`)
            .join(
              "; ",
            )}${T.overlaps.length > 40 ? `; … ${T.overlaps.length - 40} more in probe.json` : ""}`
        : "[not detected] the film's own text never sits over pictures, the product's text, text in pictures or a segment's subject",
    );
  return L;
}

const signed = (v: number) => `${v >= 0 ? "+" : "−"}${Math.round(Math.abs(v) * 1000) / 10}%`;

// --- the picture -----------------------------------------------------------------------------

// the same ruler as `film sheet` and `film listen`: the sheet's width, a label
// gutter on the left, the film's time across the rest
const GUTTER = 120;
const PAD = 6;
const sheetWidth = (w: number, h: number) => {
  const landscape = w >= h;
  const columns = landscape ? 6 : 10;
  const tileW = landscape ? 480 : 216;
  return columns * tileW + (columns + 1) * 6;
};
const defaultSheetEvery = (duration: number) => Math.max(0.25, Math.round((duration / 48) * 4) / 4);
function sheetFrameTimes(duration: number, every: number, fps: number): number[] {
  const last = Math.max(0, duration - 1.5 / fps);
  const times = Array.from(
    { length: Math.floor(last / every) + 1 },
    (_, i) => Math.round(i * every * 1000) / 1000,
  );
  if (last - times[times.length - 1]! > every / 2) times.push(Math.round(last * 1000) / 1000);
  return times;
}

const KIND_COLOR: Record<ChangeKind, string> = {
  "hard cut": "#e03131",
  carried: "#2f9e44",
  "background only": "#f08c00",
  "nothing carried": "#5c7cfa",
};

async function drawProbe(
  p: FilmProbe,
  o: {
    chromePath: string;
    out: string;
    energy: Float32Array;
    onsets: number[];
    path: CameraPath;
    every: number;
    outDir: string;
  },
): Promise<string[]> {
  const D = p.duration;
  const width = sheetWidth(p.size.width, p.size.height);
  const W = width - GUTTER - PAD;
  const x = (t: number) => round1((Math.max(0, Math.min(D, t)) / D) * W);
  const rows: { label: string; h: number; svg: string }[] = [];
  const esc = (s: string) => s.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);

  const sheetTimes = sheetFrameTimes(D, o.every, p.fps);
  const labelEvery = Math.max(1, Math.ceil((sheetTimes.length * 46) / W));
  rows.push({
    label: "sheet times",
    h: 26,
    svg: sheetTimes
      .map(
        (t, i) =>
          `<line x1="${x(t)}" x2="${x(t)}" y1="${i % labelEvery ? 18 : 12}" y2="26" stroke="#555"/>` +
          (i % labelEvery
            ? ""
            : `<text x="${x(t) + 2}" y="10" class="s">${t < 60 ? `${t.toFixed(t % 1 ? 2 : 0)}s` : `${Math.floor(t / 60)}:${(t % 60).toFixed(1).padStart(4, "0")}`}</text>`),
      )
      .join(""),
  });
  // energy, the max of each column, on a square-root scale so small motion shows
  {
    const H = 110;
    const n = o.energy.length;
    const cols = Math.max(1, Math.floor(W));
    const peak = Math.max(1e-6, ...o.energy);
    let pts = `0,${H} `;
    for (let c = 0; c < cols; c++) {
      const a = Math.floor((c / cols) * n);
      const b = Math.max(a + 1, Math.floor(((c + 1) / cols) * n));
      let v = 0;
      for (let i = a; i < Math.min(n, b); i++) v = Math.max(v, o.energy[i]!);
      pts += `${c},${round1(H - Math.sqrt(v / peak) * (H - 6))} `;
    }
    pts += `${cols},${H}`;
    const stills = p.stills.list
      .map(
        (s) =>
          `<rect x="${x(s.start)}" y="0" width="${Math.max(1, x(s.end) - x(s.start))}" height="${H}" fill="#74c0fc" opacity="0.35"/>`,
      )
      .join("");
    rows.push({
      label: `energy<br><small>change/frame, √<br>blue: still<br>≥ ${p.stills.minS} s</small>`,
      h: H,
      svg: `${stills}<polygon points="${pts}" fill="#495057" opacity="0.85"/>`,
    });
  }
  // shots
  rows.push({
    label: `shots<br><small>any cut: ${p.shots.lengths.length}<br>new pic.: ${p.shots.newPicture.lengths.length}<br><span style="color:#f08c00">| small swap</span></small>`,
    h: 58,
    svg: (() => {
      let t = 0;
      const lower = p.shots.newPicture.lengths
        .map((len, i) => {
          const a = x(t);
          const b = x(t + len);
          t += len;
          return `<rect x="${a}" y="29" width="${Math.max(1, b - a - 1)}" height="11" fill="${i % 2 ? "#adb5bd" : "#ced4da"}"/>`;
        })
        .join("");
      t = 0;
      const swaps = p.smallSwaps.list
        .map(
          (w) =>
            `<line x1="${x(w.t)}" x2="${x(w.t)}" y1="0" y2="27" stroke="#f08c00" stroke-width="1.5"/>`,
        )
        .join("");
      return (
        lower +
        swaps +
        p.shots.lengths
          .map((len, i) => {
            const a = x(t);
            const b = x(t + len);
            t += len;
            return (
              `<rect x="${a}" y="3" width="${Math.max(1, b - a - 1)}" height="22" fill="${i % 2 ? "#dee2e6" : "#f1f3f5"}"/>` +
              (b - a > 30
                ? `<text x="${a + 3}" y="18" class="s">${len.toFixed(len < 10 ? 2 : 1)}</text>`
                : "")
            );
          })
          .join("")
      );
    })(),
  });
  // cut density per 5 s
  {
    const H = 60;
    const max = Math.max(1, ...p.cuts.density);
    const bs = p.cuts.densityBinS;
    rows.push({
      label: `cuts / ${bs} s<br><small>light: all<br>dark: new picture</small>`,
      h: H,
      svg: p.cuts.density
        .map((n, i) => {
          const a = x(i * bs);
          const b = x(Math.min(D, (i + 1) * bs));
          const hh = round1((n / max) * (H - 16));
          const nn = p.cuts.densityNewPicture[i] ?? 0;
          const hn = round1((nn / max) * (H - 16));
          return `<rect x="${a + 1}" y="${H - hh}" width="${Math.max(1, b - a - 2)}" height="${hh}" fill="#e03131" opacity="0.3"/><rect x="${a + 1}" y="${H - hn}" width="${Math.max(1, b - a - 2)}" height="${hn}" fill="#e03131" opacity="0.7"/><text x="${a + 4}" y="${H - hh - 3}" class="s">${n === nn ? n : `${n} (${nn})`}</text>`;
        })
        .join(""),
    });
  }
  // big changes by kind
  {
    const H = 36;
    rows.push({
      label: `changes<br><small style="line-height:1.1">${(Object.keys(KIND_COLOR) as ChangeKind[]).map((k) => `<span style="color:${KIND_COLOR[k]}">${k}</span>`).join("<br>")}</small>`,
      h: Math.max(H, 72),
      svg: p.changes.list
        .map((c, i) => {
          const a = x(p.t0 + c.before / p.fps);
          const b = x(p.t0 + c.after / p.fps);
          return `<rect x="${a}" y="4" width="${Math.max(2, b - a)}" height="18" fill="${KIND_COLOR[c.kind]}"/><text x="${a}" y="36" class="s">${i + 1}</text>`;
        })
        .join(""),
    });
  }
  // the camera: the picture's scale against the start (a log scale), its
  // runs, and where a run turns back
  if (p.camera.how === "estimated") {
    const H = 84;
    const path = o.path;
    let cum = 0;
    const pts: [number, number][] = [];
    path.t.forEach((t, k) => {
      cum += path.logScale[k] ?? 0;
      pts.push([t, cum]);
    });
    const lo = Math.min(0, ...pts.map((q) => q[1]));
    const hi = Math.max(0, ...pts.map((q) => q[1]));
    const span = Math.max(Math.log(1.05), hi - lo);
    const y = (v: number) => round1(H - 8 - ((v - lo) / span) * (H - 16));
    const line = pts.map(([t, v]) => `${x(t)},${y(v)}`).join(" ");
    const runs = p.camera.runs
      .map((r) => {
        const col = r.what === "zoom" ? (r.dir === "in" ? "#2f9e44" : "#9c36b5") : "#868e96";
        const yy = r.what === "zoom" ? 2 : r.what === "pan x" ? H - 6 : H - 3;
        return `<rect x="${x(r.start)}" y="${yy}" width="${Math.max(1, x(r.end) - x(r.start))}" height="3" fill="${col}"/>`;
      })
      .join("");
    const turns = p.camera.reversals
      .map(
        (r) =>
          `<line x1="${x(r.t)}" x2="${x(r.t)}" y1="0" y2="${H}" stroke="#e8590c" stroke-width="1.5" stroke-dasharray="3 2"/>`,
      )
      .join("");
    const rep = p.camera.repeated
      .map(
        (b) =>
          `<rect x="${x(b.start)}" y="0" width="${Math.max(1, x(b.end) - x(b.start))}" height="${H}" fill="#f59f00" opacity="0.15"/>`,
      )
      .join("");
    const bf = p.camera.backAndForth
      .map(
        (b) =>
          `<rect x="${x(b.start)}" y="0" width="${Math.max(1, x(b.end) - x(b.start))}" height="${H}" fill="#e8590c" opacity="0.12"/>`,
      )
      .join("");
    rows.push({
      label: `camera<br><small>summed scale<br><span style="color:#2f9e44">in</span>/<span style="color:#9c36b5">out</span>, grey: moves<br><span style="color:#e8590c">┆turn</span> <span style="color:#f59f00">▒repeat</span></small>`,
      h: H,
      svg: `${rep}${bf}<line x1="0" x2="${W}" y1="${y(0)}" y2="${y(0)}" stroke="#ced4da"/><polyline points="${line}" fill="none" stroke="#1971c2" stroke-width="1.5"/>${runs}${turns}<text x="2" y="10" class="s">×${round3(Math.exp(hi))}</text><text x="2" y="${H - 1}" class="s">×${round3(Math.exp(lo))}</text>`,
    });
  }
  // onsets and the cuts' offsets
  if (p.sound.how !== "not measured") {
    const H = 52;
    const ticks = o.onsets
      .map((t) => `<line x1="${x(t)}" x2="${x(t)}" y1="${H - 8}" y2="${H}" stroke="#d9480f"/>`)
      .join("");
    const cuts = p.cuts.list
      .map((c) => {
        const near = c.nearestOnset != null && Math.abs(c.nearestOnset) <= 0.04;
        return `<line x1="${x(c.t)}" x2="${x(c.t)}" y1="2" y2="${H - 10}" stroke="#e03131" stroke-width="${near ? 2.5 : 1}"${near ? "" : ' stroke-dasharray="2 2"'}/>`;
      })
      .join("");
    rows.push({
      label: `cuts × onsets<br><small>median ${ms(p.sound.medianAbsOffset)}<br>${pct(p.sound.within40)} ≤40ms (chance ${pct(p.sound.chance40)})</small>`,
      h: H,
      svg: cuts + ticks,
    });
  }
  // the beat sheet
  if (p.segments.list.length) {
    const H = 34;
    rows.push({
      label: `segments<br><small>blue: written to hold<br>▸ handoff</small>`,
      h: H,
      svg: p.segments.list
        .map((s, i) => {
          const a = x(s.from);
          const b = x(s.to);
          const moved = s.hold && (s.moving > 0 || s.cuts.length || s.swaps.length);
          return (
            `<rect x="${a}" y="${i % 2 ? 12 : 3}" width="${Math.max(1, b - a - 1)}" height="14" fill="${s.hold ? "#a5d8ff" : "#e9ecef"}" stroke="${moved ? "#e8590c" : "#adb5bd"}"/>` +
            (b - a > 24
              ? `<text x="${a + 3}" y="${i % 2 ? 23 : 14}" class="s">${esc((s.label ?? "").slice(0, Math.floor((b - a) / 6)))}</text>`
              : "") +
            (s.handoff
              ? `<text x="${b - 4}" y="${H - 1}" class="s">▸${esc(s.handoff.slice(0, 8))}</text>`
              : "")
          );
        })
        .join(""),
    });
  }
  // text: the share of the frame, stacked by where it is; the median size on a phone
  if (p.text.samples.length) {
    const H = 100;
    const S = p.text.samples;
    const top = Math.max(0.1, ...S.map((s) => s.share));
    const bw = Math.max(1, (W / p.duration) * p.text.every - 1);
    const hgt = (v: number) => (v / top) * (H - 26);
    const bars = S.map((s) => {
      const own = s.own ?? 0;
      const prod = s.product ?? 0;
      const pic = s.picture ?? (s.own == null ? s.share : 0);
      let yy = H - 12;
      let out = "";
      for (const [v, col] of [
        [own, "#1864ab"],
        [prod, "#74c0fc"],
        [pic, "#ffa94d"],
      ] as const) {
        const hh = hgt(v);
        if (hh > 0.2)
          out += `<rect x="${x(s.t)}" y="${round1(yy - hh)}" width="${round1(bw)}" height="${round1(hh)}" fill="${col}"/>`;
        yy -= hh;
      }
      return out;
    }).join("");
    const medLine = S.filter((s) => s.median != null)
      .map(
        (s) =>
          `${x(s.t + p.text.every / 2)},${round1(H - 12 - Math.min(1, (s.median! * p.text.phoneScale) / 20) * (H - 26))}`,
      )
      .join(" ");
    const every = Math.max(1, Math.ceil((p.text.perSecond.length * 34) / W));
    const labels = p.text.perSecond
      .map((b, i) =>
        i % every || b.median == null
          ? ""
          : `<text x="${x(b.t)}" y="${H - 1}" class="s">${round1(b.median * p.text.phoneScale)}</text>`,
      )
      .join("");
    rows.push({
      label: `text<br><small>share, top ${pct(top)}<br><span style="color:#1864ab">own</span> <span style="color:#4dabf7">product</span> <span style="color:#e8590c">pictures</span><br><span style="color:#c92a2a">median px, phone</span></small>`,
      h: H,
      svg: `${bars}${medLine ? `<polyline points="${medLine}" fill="none" stroke="#c92a2a" stroke-width="1.2"/>` : ""}${labels}`,
    });
    if (p.text.overlaps.length)
      rows.push({
        label: "<small>own text over</small>",
        h: 22,
        svg: p.text.overlaps
          .map(
            (ov) =>
              `<rect x="${x(ov.from)}" y="4" width="${Math.max(1, x(ov.to) - x(ov.from))}" height="14" fill="#c92a2a" opacity="0.35"/>`,
          )
          .join(""),
      });
  }
  // declared subjects
  for (const tr of p.subjects.tracks) {
    rows.push({
      label: `<small>${esc(tr.name)}<br>declared, out of frame</small>`,
      h: 22,
      svg: p.subjects.exits
        .filter((e) => e.name === tr.name)
        .map(
          (e) =>
            `<rect x="${x(e.start)}" y="3" width="${Math.max(1, x(e.end) - x(e.start))}" height="16" fill="${e.how === "out" ? "#862e9c" : "#da77f2"}"/>`,
        )
        .join(""),
    });
  }
  if (p.marks.list.length)
    rows.push({
      label: "marks",
      h: 30,
      svg: p.marks.list
        .map(
          (m) =>
            `<line x1="${x(m.t)}" x2="${x(m.t)}" y1="0" y2="30" stroke="#1971c2"/><text x="${x(m.t) + 2}" y="12" class="s">${esc(m.label)}</text>`,
        )
        .join(""),
    });

  const gap = 4;
  let top = PAD;
  const body = rows
    .map((r) => {
      const html = `<div class="row" style="top:${top}px;height:${r.h}px"><div class="lab">${r.label}</div><svg width="${W}" height="${r.h}" style="left:${GUTTER}px">${r.svg}</svg></div>`;
      top += r.h + gap;
      return html;
    })
    .join("");
  const rulerH = top;
  const over = `<svg class="over" width="${W}" height="${rulerH - PAD}" style="left:${GUTTER}px;top:${PAD}px">${p.cuts.list
    .map(
      (c) =>
        `<line x1="${x(c.t)}" x2="${x(c.t)}" y1="0" y2="100%" stroke="#e03131" stroke-width="1" opacity="0.35"/>`,
    )
    .join("")}</svg>`;
  const legend = `<div class="legend" style="top:${top}px">red lines: hard cuts read from the picture · cuts × onsets: solid = an onset within 40 ms, dashed = none; orange ticks = onsets · ${esc(basename(p.input))} ${p.duration.toFixed(2)}s · measured/estimated: see probe.md</div>`;
  top += 24;
  // the changes as before → after cards
  const cardW = 470;
  const perRow = Math.max(1, Math.floor((width - PAD) / (cardW + PAD)));
  const thumbW = Math.floor((cardW - 8) / 2);
  const thumbH = Math.round((thumbW * p.size.height) / p.size.width);
  const cardH = thumbH + 40;
  const src = (rel: string) => pathToFileURL(join(o.outDir, rel)).href;
  const card = (c: (typeof p.changes.list)[number], i: number, y0: number, slot: number) => {
    const r = Math.floor(slot / perRow);
    const k = slot % perRow;
    const imgs = c.thumbs
      ? `<img src="${src(c.thumbs.before)}" style="left:0"><img src="${src(c.thumbs.after)}" style="left:${thumbW + 8}px">`
      : "";
    return `<div class="card" style="left:${PAD + k * (cardW + PAD)}px;top:${y0 + r * (cardH + PAD)}px;border-color:${KIND_COLOR[c.kind]}">${imgs}<div class="cap"><b style="color:${KIND_COLOR[c.kind]}">${i + 1}. ${fmtT(c.t)} ${c.kind}</b>${c.kind === "hard cut" ? ` · ${c.across}` : ""}<br>stays ${pct(c.stays)} · carried ${pct(c.carried)} · bg ${pct(c.background)} · changed ${pct(c.changed)}</div></div>`;
  };
  // Chrome's screenshot stops at 4096 px: the cards go on over further pages
  const MAX_H = 4000;
  const pages: { html: string; height: number }[] = [];
  const firstRows = Math.max(0, Math.floor((MAX_H - top - PAD) / (cardH + PAD)));
  const laterRows = Math.max(1, Math.floor((MAX_H - PAD * 2) / (cardH + PAD)));
  let i = 0;
  {
    const n = Math.min(p.changes.list.length, firstRows * perRow);
    const cards = p.changes.list
      .slice(0, n)
      .map((c, k) => card(c, k, top, k))
      .join("");
    pages.push({
      html: `${body}${over}${legend}${cards}`,
      height: top + Math.ceil(n / perRow) * (cardH + PAD) + PAD,
    });
    i = n;
  }
  while (i < p.changes.list.length) {
    const n = Math.min(p.changes.list.length - i, laterRows * perRow);
    const cards = p.changes.list
      .slice(i, i + n)
      .map((c, k) => card(c, i + k, PAD, k))
      .join("");
    pages.push({ html: cards, height: Math.ceil(n / perRow) * (cardH + PAD) + PAD * 2 });
    i += n;
  }
  const files: string[] = [];
  const tmp = await mkdtemp(join(tmpdir(), "open-take-probe-"));
  try {
    for (const [k, pg] of pages.entries()) {
      await writeFile(
        join(tmp, `probe-${k}.html`),
        `<!doctype html><meta charset="utf-8"><style>
html,body{margin:0;background:#fff}
body{position:relative;width:${width}px;height:${pg.height}px;font:12px/1.25 ui-monospace,Menlo,monospace;color:#111}
.row{position:absolute;left:0;width:${width}px}
.row svg,.over{position:absolute;top:0}
.row svg{background:#fafafa}
.over{pointer-events:none}
.lab{position:absolute;left:${PAD}px;width:${GUTTER - PAD * 2}px;top:2px;font-weight:600}
small{font-weight:400;color:#555}
.s{font-size:10px;fill:#333}
.legend{position:absolute;left:${GUTTER}px;font-size:11px;color:#444}
.card{position:absolute;width:${cardW}px;height:${cardH}px;border-top:3px solid;box-sizing:border-box}
.card img{position:absolute;top:3px;width:${thumbW}px;height:${thumbH}px;object-fit:cover;background:#000}
.cap{position:absolute;top:${thumbH + 5}px;left:0;font-size:11px}
</style>${pg.html}`,
      );
      const browser = await launchHtmlBrowser({
        chromePath: o.chromePath,
        url: pathToFileURL(join(tmp, `probe-${k}.html`)).href,
        width,
        height: pg.height,
        profilePrefix: "open-take-probe-",
      });
      try {
        await browser.evaluate(
          "Promise.all([...document.images].map((i) => i.decode().catch(() => {}))).then(() => new Promise((ok) => requestAnimationFrame(() => requestAnimationFrame(() => ok(0)))))",
        );
        const file = k ? o.out.replace(/\.png$/, `-${k + 1}.png`) : o.out;
        await writeFile(file, await browser.screenshot({ format: "png" }));
        files.push(file);
      } finally {
        await browser.close();
      }
    }
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
  return files;
}

// --- small arithmetic ----------------------------------------------------------------------

const frameRate = (r?: string) => {
  const [n, d] = String(r ?? "60/1")
    .split("/")
    .map(Number);
  return n && d ? n / d : 60;
};
function median(xs: readonly number[]): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}
const round1 = (v: number) => Math.round(v * 10) / 10;
const round2 = (v: number) => Math.round(v * 100) / 100;
const round3 = (v: number) => Math.round(v * 1000) / 1000;
const round4 = (v: number) => Math.round(v * 10000) / 10000;
const round6 = (v: number) => Math.round(v * 1e6) / 1e6;

/** what `film render` wrote into a film about its page (FILM_TAG); null for
 *  a film from anywhere else */
function filmRecordOf(
  raw: string | undefined,
): { from: number; width: number; height: number } | null {
  if (!raw) return null;
  try {
    const r = JSON.parse(raw) as Record<string, unknown>;
    const pos = (v: unknown) => (typeof v === "number" && v > 0 ? v : 0);
    return { from: pos(r.from), width: pos(r.width), height: pos(r.height) };
  } catch {
    return null;
  }
}

/** a page sample in the film's px: sizes and boxes times k */
function scalePageSample(s: PageTextSample, k: number): PageTextSample {
  if (k === 1) return s;
  const b = (x: Box): Box => [x[0] * k, x[1] * k, x[2] * k, x[3] * k];
  return {
    ...s,
    own: s.own.map((o) => ({ ...o, px: o.px * k, boxes: o.boxes.map(b) })),
    sizes: s.sizes.map(([px, n]) => [px * k, n] as [number, number]),
    media: s.media.map((m) => ({ ...m, box: b(m.box) })),
    subjects: Object.fromEntries(Object.entries(s.subjects).map(([n, x]) => [n, x ? b(x) : null])),
  };
}
