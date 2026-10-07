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
      "stream=codec_type,width,height,r_frame_rate,start_time:format=duration,start_time",
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
    format?: { duration?: string; start_time?: string };
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
  const tracks = rawEvents ? subjectTracks(rawEvents) : [];
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
    `${JSON.stringify({ ...probe, energyPerFrame: Array.from(energy, round4) })}\n`,
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
  L.push("## Still stretches");
  L.push(
    p.stills.list.length
      ? `[measured] ${p.stills.list.length} stretch(es) of ≥ ${p.stills.minS} s with no frame changing (each frame under ${p.stills.under}), ${pct(p.stills.share)} of the film: ${p.stills.list.map((s) => `${fmtT(s.start)}–${fmtT(s.end)}`).join(", ")}`
      : `[not detected] no stretch of ≥ ${p.stills.minS} s without change`,
  );
  L.push("");
  L.push("## Cuts and shots");
  if (p.cuts.list.length) {
    const np = p.cuts.list.filter((c) => c.changed >= p.cuts.newPictureShare).length;
    L.push(
      `[measured] ${p.cuts.list.length} hard cuts (a one-frame jump of the picture), ${p.cuts.perMin} per minute: ${p.cuts.list.map((c) => fmtT(c.t)).join(" ")}`,
    );
    L.push(
      `[measured] ${np} of them change ≥ ${pct(p.cuts.newPictureShare)} of the frame (called a new picture here); ${p.cuts.list.length - np} change less — a word, a colour or a panel swapped inside a picture that holds, or a reframing over flat ground (see each one's thumbnails below)`,
    );
    L.push(`[measured] cuts per ${p.cuts.densityBinS} s, all: ${p.cuts.density.join(" ")}`);
    L.push(
      `[measured] cuts per ${p.cuts.densityBinS} s, new picture only: ${p.cuts.densityNewPicture.join(" ")}`,
    );
  } else L.push("[not detected] no hard cut — the picture never jumps in one frame");
  const shotLine = (what: string, s: ShotStats) =>
    `[measured] ${s.lengths.length} ${what}; length median ${s.median} s, shortest ${s.shortest} s, longest ${s.longest} s${s.cv != null ? `, spread (sd/mean) ${s.cv}` : ""}`;
  L.push(shotLine("stretch(es) between any two hard cuts", p.shots));
  L.push(`Lengths (s): ${p.shots.lengths.join(" ")}`);
  if (p.shots.newPicture.lengths.length !== p.shots.lengths.length) {
    L.push(shotLine("shot(s) between new-picture cuts only", p.shots.newPicture));
    L.push(`Lengths (s): ${p.shots.newPicture.lengths.join(" ")}`);
  }
  if (p.declaredCuts.how !== "not measured") {
    L.push(
      p.declaredCuts.list.length
        ? `[measured] the events file declares ${p.declaredCuts.list.length} cut(s); not seen in the picture (±1.5 frames): ${p.declaredCuts.unseen.map(fmtT).join(" ") || "none"}; seen but not declared: ${p.declaredCuts.undeclared.map(fmtT).join(" ") || "none"}`
        : "[not detected] the events file declares no cuts",
    );
  }
  L.push("");
  L.push("## Big changes of picture");
  L.push(
    "[estimated] every cut, and every moment where ≥ 40 % of the frame differs between ¼ s before and ¼ s after. What crosses each: carried = textured regions covering ≥ 10 % of the frame stay in place or are followed frame to frame into the new picture; background only = less than that, but ≥ 25 % of the frame is flat and keeps its grey; nothing carried = neither. The share numbers are the frame's blocks (8×8 on the grey copy). Thumbnails: changes/NNN-before.jpg, -after.jpg.",
  );
  if (!p.changes.list.length) L.push("[not detected] no big change of picture");
  const counts = new Map<string, number>();
  for (const c of p.changes.list) counts.set(c.kind, (counts.get(c.kind) ?? 0) + 1);
  if (p.changes.list.length)
    L.push(`Counts: ${[...counts].map(([k, n]) => `${k} ${n}`).join(", ")}`);
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
  L.push("");
  L.push("## Cuts against the sound");
  if (p.sound.how === "not measured") L.push("[not measured] the film has no sound");
  else if (!p.sound.onsets) L.push("[not detected] no onsets in the sound");
  else if (!p.cuts.list.length)
    L.push(
      `[measured] ${p.sound.onsets} onsets (${p.sound.onsetsPerS}/s); no cuts to set against them`,
    );
  else {
    L.push(
      `[measured] ${p.sound.onsets} onsets (${p.sound.onsetsPerS}/s, as \`film listen\` finds them). Cuts with an onset within 40 ms: ${pct(p.sound.within40)} (a cut at a random time: ${pct(p.sound.chance40)}); within 80 ms: ${pct(p.sound.within80)} (random: ${pct(p.sound.chance80)}); median distance ${ms(p.sound.medianAbsOffset)}.`,
    );
    L.push(
      `Offset of each cut to its nearest onset (− = the onset comes first): ${p.cuts.list.map((c) => `${fmtT(c.t)} ${ms(c.nearestOnset)}`).join(", ")}`,
    );
  }
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
        `- [measured] ${fmtT(m.t)} ${m.label || "(unnamed)"}: picture ${m.still ? "still" : "moving"}${m.nearestCut != null ? `, nearest cut ${ms(m.nearestCut)}` : ""}`,
      );
  }
  return L.join("\n");
}

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
    label: `shots<br><small>any cut: ${p.shots.lengths.length}<br>new pic.: ${p.shots.newPicture.lengths.length}</small>`,
    h: 46,
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
      return (
        lower +
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
  // onsets and the cuts' offsets
  if (p.sound.how !== "not measured") {
    const H = 44;
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
      label: `cuts × onsets<br><small>${pct(p.sound.within40)} ≤40ms (chance ${pct(p.sound.chance40)})</small>`,
      h: H,
      svg: cuts + ticks,
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
