// Read picture changes and motion on a small grey copy at native cadence.
// The probe's wide change windows give places to look. The pair at each
// proposed boundary supplies the evidence for a cut, with nearby frames
// showing how motion approached and left. Verdict thresholds were set on
// two launch reels with UI footage at 24 and 30 fps. The fit leaves some
// 3D camera moves, blur hand-offs, dissolves and morphs unresolved or misses
// them entirely.

import {
  type CameraPath,
  type CarryKind,
  findChanges,
  findCuts,
  findSmallSwaps,
  follow,
  frameEnergy,
  frameTime,
  type GreyFrames,
  globalMotion,
  pictureMotion,
} from "./probe";
import { median } from "./beats";

export type StudyFrames = GreyFrames & { times?: readonly number[] };
type Move = { s: number; x: number; y: number };
type Fit = Move & { error: number; ratio: number; support: number };
type CutKind = "hard_cut" | "scale_jump" | "match_cut";
export type Verdict =
  | CutKind
  | "fast_move"
  | "in_picture_change"
  | "flash_or_fade"
  | "unresolved";
type Source = "cuts" | "small_swaps" | "changes" | "energy_peak";
type MotionState = "travel" | "drift" | "hold";
type Nomination = { source: Source; frame: number; from: number; to: number };
export type Step = { motion: Move | null; localPx: number | null; energy: number };

export const studyTime = (g: StudyFrames, i: number) => g.times?.[i] ?? frameTime(g, i);
const frame = (g: GreyFrames, i: number) =>
  g.data.subarray(i * g.w * g.h, (i + 1) * g.w * g.h);

const STILL = 0.0015; // film probe's grey-change floor, above small encode noise
// A fast step, for the verdicts at a boundary and the camera's runs: 2 px a
// frame on the 640 px ruler, 0.004 of |ln s|, 3 px of local motion. The
// verdicts were tuned with these on the two launch reels (24 and 30 fps),
// where they stay per frame; a step shorter than a thirtieth of a second is
// held to its share of them, so a 60 fps master reads as its 30 fps copy.
const FAST_PX = 2;
const FAST_SCALE = 0.004;
const FAST_LOCAL = 3;
const FAST_SECONDS = 1 / 30;
// Travel, drift and hold are per second, so one film read at 24, 30 or 60
// fps gives one set of shares. The 24 fps travel24.py table flags 2 native
// px of a 1276 px-wide picture, |ln s| 0.004, or 3 native px of median flow
// per frame. Scale the pixel thresholds to the 640 px ruler.
const TRAVEL_RATE = 2 * 640 / 1276 * 24;
const TRAVEL_SCALE_RATE = 0.004 * 24;
const TRAVEL_LOCAL_RATE = 3 * 640 / 1276 * 24;
// The probe's grey-change floor and the quarter pixel a frame of a slow
// drift, timed at the 24 fps table's cadence.
const DRIFT_ENERGY_RATE = STILL * 24;
const DRIFT_RATE = 0.25 * 24;
// The travel24.py table closes with k = 1 at 24 fps.
const CLOSE_SECONDS = 1 / 24;
const SCALE_JUMP = 1.3; // fast pushes reach 1.28×; jumps inside ramps start around 1.45×
const CAMERA_SIDE = 3; // read the approach and departure over a few native frames

const translation = (m: Move, w: number) => Math.hypot(m.x, m.y) * 640 / w;
const speed = (m: Move, w: number) => Math.hypot(m.x, m.y, Math.log(m.s) * w / 4) * 640 / w;

/** a step that took `seconds` fast enough to be the camera travelling:
 *  judged per frame at 30 fps and slower, per second above */
function fast(step: Step, w: number, seconds: number): boolean {
  const m = step.motion;
  const k = seconds > 0 ? Math.min(1, seconds / FAST_SECONDS) : 1;
  return !!(m && (translation(m, w) >= k * FAST_PX || Math.abs(Math.log(m.s)) >= k * FAST_SCALE)) ||
    (step.localPx ?? 0) >= k * FAST_LOCAL;
}

/** what a step that took `seconds` does: the camera travels, the picture
 *  drifts, or it holds */
function state(step: Step, w: number, seconds: number): MotionState {
  const m = step.motion;
  const dt = seconds > 0 ? seconds : 1 / 30;
  if (
    (m && (translation(m, w) / dt >= TRAVEL_RATE || Math.abs(Math.log(m.s)) / dt >= TRAVEL_SCALE_RATE)) ||
    (step.localPx ?? 0) / dt >= TRAVEL_LOCAL_RATE
  )
    return "travel";
  return step.energy / dt >= DRIFT_ENERGY_RATE || (m && speed(m, w) / dt >= DRIFT_RATE) ? "drift" : "hold";
}

// With unmarked padding, closing fills holes of up to two radii between
// marked steps. A held frame on a variable-rate film can span a whole hole.
function close(mask: boolean[], seconds: readonly number[]): boolean[] {
  let prev = -1;
  let gap = 0;
  for (let i = 0; i < mask.length; i++) {
    if (mask[i]) {
      // Seconds from the frame clock may be rounded by floating point.
      if (prev >= 0 && gap <= 2 * CLOSE_SECONDS + 1e-9) mask.fill(true, prev + 1, i);
      prev = i;
      gap = 0;
    } else gap += seconds[i]!;
  }
  return mask;
}

/** Each step of a shot as travel, drift or hold. `seconds[i]` is the time
 *  step i took (the interval between the two frames it compares); without
 *  it, 30 fps. */
export function motionStates(
  steps: readonly Step[], w: number, seconds: readonly number[] = [], spans = seconds,
): MotionState[] {
  const dts = steps.map((_, i) => seconds[i] ?? 1 / 30);
  const raw = steps.map((s, i) => state(s, w, spans[i] ?? dts[i]!));
  const moving = close(raw.map((s) => s !== "hold"), dts);
  const travelling = close(raw.map((s) => s === "travel"), dts);
  return raw.map((_, i) => (travelling[i] ? "travel" : moving[i] ? "drift" : "hold"));
}

/** How the picture moved from frame a to frame b. */
function stepBetween(g: StudyFrames, a: number, b: number, e: number): Step {
  let motion: Move | null = null;
  if (e > 0) {
    const m = pictureMotion(g, a, b);
    if (m && (speed(m, g.w) < 0.25 || trusted(fitEvidence(g, frame(g, a), frame(g, b), m)))) motion = m;
  }
  const step: Step = { motion, localPx: null, energy: e };
  if (e >= STILL && !fast(step, g.w, studyTime(g, b) - studyTime(g, a))) step.localPx = localMotion(g, frame(g, a), frame(g, b));
  return step;
}

// On the 96 px grey copy a step of a 60 fps film moves too little to
// measure (half a pixel on the 640 ruler is 0.08 px there), so a step for
// travel, drift and hold spans at least a thirtieth of a second, as the
// launch reels' tables were read: every frame of a faster film is compared
// with the one that far back in its shot.
const STATE_SPAN = 1 / 30;

/** The steps of shot [from, to) for motionStates, frames from + 1 to
 *  to − 1, and the seconds each spans. On a film at 30 fps or slower they
 *  are the adjacent steps. */
export function stateSteps(
  g: StudyFrames, steps: readonly Step[], from: number, to: number, frameSeconds: number,
): { steps: Step[]; seconds: number[] } {
  const k = Math.max(1, Math.round(STATE_SPAN / frameSeconds - 0.25));
  const out: Step[] = [];
  const seconds: number[] = [];
  for (let i = from + 1; i < to; i++) {
    let a = i - 1;
    while (a > Math.max(from, i - k) && studyTime(g, i) - studyTime(g, a - 1) <=
      STATE_SPAN + frameSeconds / 2) a--;
    seconds.push(studyTime(g, i) - studyTime(g, a));
    if (a === i - 1) {
      out.push(steps[i]!);
      continue;
    }
    const fa = frame(g, a);
    const fb = frame(g, i);
    let sum = 0;
    for (let j = 0; j < fa.length; j++) sum += Math.abs(fa[j]! - fb[j]!);
    out.push(stepBetween(g, a, i, sum / fa.length / 255));
  }
  return { steps: out, seconds };
}

export function motionShares(states: readonly MotionState[], seconds: readonly number[]) {
  const sum = { travel: 0, drift: 0, hold: 0 };
  states.forEach((s, i) => { sum[s] += seconds[i]!; });
  const total = sum.travel + sum.drift + sum.hold;
  return total
    ? { travel: sum.travel / total, drift: sum.drift / total, hold: sum.hold / total, seconds: total }
    : null;
}

function sample(a: Uint8Array, w: number, x: number, y: number): number {
  const i = Math.floor(x);
  const j = Math.floor(y);
  const u = x - i;
  const v = y - j;
  const k = j * w + i;
  return (1 - v) * ((1 - u) * a[k]! + u * a[k + 1]!) +
    v * ((1 - u) * a[k + w]! + u * a[k + w + 1]!);
}

// Check the fit on the overlapping picture, including the texture that
// the robust solver may have left out. Flat margins give no support.
function fitEvidence(g: GreyFrames, a: Uint8Array, b: Uint8Array, m: Move): Fit {
  let error = 0;
  let raw = 0;
  let supported = 0;
  let n = 0;
  for (let y = 2; y < g.h - 2; y += 2) {
    for (let x = 2; x < g.w - 2; x += 2) {
      const k = y * g.w + x;
      const detail = Math.abs(a[k + 1]! - a[k - 1]!) + Math.abs(a[k + g.w]! - a[k - g.w]!);
      if (detail < 10) continue; // probe's texture gate, on the small grey copy
      const qx = g.w / 2 + m.s * (x - g.w / 2) + m.x;
      const qy = g.h / 2 + m.s * (y - g.h / 2) + m.y;
      if (qx < 0 || qx >= g.w - 1 || qy < 0 || qy >= g.h - 1) continue;
      const d = Math.abs(a[k]! - sample(b, g.w, qx, qy));
      error += d;
      raw += Math.abs(a[k]! - b[k]!);
      if (d <= 8 + detail * 0.2) supported++; // edges of downscaled, compressed pictures
      n++;
    }
  }
  const enough = n >= Math.max(10, g.w * g.h * 0.008);
  return {
    ...m,
    error: enough ? error / n : Infinity,
    ratio: enough ? error / Math.max(1, raw) : Infinity,
    support: enough ? supported / n : 0,
  };
}

const trusted = (f: Fit) => f.support >= 0.55 && f.ratio <= 0.76;
const identity: Move = { s: 1, x: 0, y: 0 };

function textureCentre(g: GreyFrames, f: Uint8Array) {
  let total = 0;
  let sx = 0;
  let sy = 0;
  for (let y = 2; y < g.h - 2; y += 2) {
    for (let x = 2; x < g.w - 2; x += 2) {
      const k = y * g.w + x;
      const detail = Math.max(0, Math.abs(f[k + 1]! - f[k - 1]!) +
        Math.abs(f[k + g.w]! - f[k - g.w]!) - 10);
      sx += x * detail;
      sy += y * detail;
      total += detail;
    }
  }
  return total ? { x: sx / total - g.w / 2, y: sy / total - g.h / 2 } : { x: 0, y: 0 };
}

function widenScale(g: GreyFrames, a: Uint8Array, b: Uint8Array): Fit | null {
  // Large one-frame punches in UI footage run from about 1.3× to 4×.
  // Pre-scale the smaller view, then use probe's existing scale/shift
  // search. Compose the transforms and check them on the original pair.
  const scales = [1.23, 1.38, 1.55, 1.8, 2.1, 2.45, 2.85, 3.35, 4];
  const w = Math.max(16, Math.floor(g.w / 8) * 4);
  const h = Math.max(8, Math.floor(g.h / 8) * 4);
  const small = { ...g, w, h };
  const resize = (src: Uint8Array, sc: number, dx = 0, dy = 0) => {
    const clamp = (v: number, size: number) => Math.max(0, Math.min(size - 1.001, v));
    const out = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const sx = clamp(g.w / 2 + dx + (x - w / 2) * g.w / w / sc, g.w);
        const sy = clamp(g.h / 2 + dy + (y - h / 2) * g.h / h / sc, g.h);
        out[y * w + x] = Math.round(sample(src, g.w, sx, sy));
      }
    }
    return out;
  };
  let best: Fit | null = null;
  let bestScore = Infinity;
  for (const [from, to, reverse] of [[a, b, false], [b, a, true]] as const) {
    const dst = resize(to, 1);
    const ca = textureCentre(g, from);
    const cb = textureCentre(g, to);
    const check = (s: number, x: number, y: number) => {
      const src = resize(from, s, x, y);
      const m = globalMotion(small, src, dst);
      const smallFit = fitEvidence(small, src, dst, m);
      if (smallFit.error > 24) return; // downscaled texture no longer matches
      const data = new Uint8Array(2 * w * h);
      data.set(src);
      data.set(dst, w * h);
      const fine = pictureMotion({ ...small, count: 2, data }, 0, 1) ?? m;
      const scale = s * fine.s;
      if (scale < SCALE_JUMP - 0.01) return;
      const move = { s: scale, x: fine.x * g.w / w - x * scale, y: fine.y * g.h / h - y * scale };
      const f = fitEvidence(g, from, to, move);
      const score = f.error / Math.max(0.1, f.support);
      // Even a close patch can be the wrong part of an interface.
      if (f.support >= 0.65 && f.ratio <= 0.55 && f.error <= 13 && score < bestScore) {
        bestScore = score;
        best = reverse ? { ...f, s: 1 / f.s, x: -f.x / f.s, y: -f.y / f.s } : f;
      }
    };
    for (const s of scales) {
      check(s, 0, 0);
      // A punch can land off-centre, as on a button at the edge of a panel.
      // Seed the same search on the texture rather than on the frame centre.
      const x = ca.x - cb.x / s;
      const y = ca.y - cb.y / s;
      if (s >= 1.55 && bestScore > 4 && Math.hypot(x, y) > g.w / 12) check(s, x, y);
    }
  }
  return best;
}

function picturePair(g: GreyFrames, a: Uint8Array, b: Uint8Array) {
  // Same block size and grey gates as probe's changedShare and compare.
  const block = 8;
  let blocks = 0;
  let changed = 0;
  let stillTexture = 0;
  let flat = 0;
  let edgeBlocks = 0;
  let edgeKept = 0;
  for (let y = 0; y + block <= g.h; y += block) {
    for (let x = 0; x + block <= g.w; x += block) {
      let pa = 0;
      let pb = 0;
      let qa = 0;
      let qb = 0;
      let d = 0;
      for (let r = y; r < y + block; r += 2) {
        for (let c = x; c < x + block; c += 2) {
          const k = r * g.w + c;
          const va = a[k]!;
          const vb = b[k]!;
          pa += va;
          pb += vb;
          qa += va * va;
          qb += vb * vb;
          d += Math.abs(va - vb);
        }
      }
      const n = (block / 2) ** 2;
      const textA = qa / n - (pa / n) ** 2 >= 25;
      const textB = qb / n - (pb / n) ** 2 >= 25;
      if (d / n > 12) changed++;
      if (d / n < 8 && textA && textB) stillTexture++;
      if (Math.abs(pa - pb) / n < 8 && !textA && !textB) flat++;
      if (x === 0 || y === 0 || x + 2 * block > g.w || y + 2 * block > g.h) {
        edgeBlocks++;
        if (d / n < 12) edgeKept++;
      }
      blocks++;
    }
  }
  return {
    changed: changed / blocks, stillTexture: stillTexture / blocks, flat: flat / blocks,
    edgeKept: edgeKept / edgeBlocks,
  };
}

// A scrim or a sudden light change may touch the whole frame with the
// same picture underneath. Fit its gain and offset and check the residual.
function sameUnderLight(a: Uint8Array, b: Uint8Array, energy: number) {
  let x = 0;
  let y = 0;
  let xx = 0;
  let xy = 0;
  let n = 0;
  for (let k = 0; k < a.length; k += 3) {
    x += a[k]!;
    y += b[k]!;
    xx += a[k]! ** 2;
    xy += a[k]! * b[k]!;
    n++;
  }
  const spread = xx - x * x / n;
  if (spread / n < 36) return false; // flat pixels cannot confirm the scene
  const gain = (xy - x * y / n) / spread;
  if (gain < 0.48 || gain > 2) return false;
  const offset = (y - gain * x) / n;
  let error = 0;
  for (let k = 0; k < a.length; k += 3)
    error += Math.abs(Math.max(0, Math.min(255, gain * a[k]! + offset)) - b[k]!);
  return error / n <= 0.38 * energy * 255;
}

// The block search in probe's jumpMove, sampled on a grid here. The
// median includes still patches. Each patch needs texture and a close
// match before its displacement can stand in for local flow.
function localMotion(g: GreyFrames, a: Uint8Array, b: Uint8Array): number | null {
  const mags: number[] = [];
  let textured = 0;
  const grid = 8; // probe's patch width on the grey copy
  const radius = 4; // adjacent-frame search in probe's follow
  for (let y = radius; y + grid + radius <= g.h; y += grid) {
    for (let x = radius; x + grid + radius <= g.w; x += grid) {
      const patch: number[] = [];
      for (let r = 0; r < grid; r += 2)
        for (let c = 0; c < grid; c += 2) patch.push(a[(y + r) * g.w + x + c]!);
      const mean = patch.reduce((s, v) => s + v, 0) / patch.length;
      const sd = Math.sqrt(patch.reduce((s, v) => s + (v - mean) ** 2, 0) / patch.length);
      if (sd < 7) continue; // small grey patches with visible edges
      textured++;
      const cost = (dx: number, dy: number) => {
        let d = 0;
        let i = 0;
        for (let r = 0; r < grid; r += 2)
          for (let c = 0; c < grid; c += 2)
            d += Math.abs(patch[i++]! - b[(y + r + dy) * g.w + x + c + dx]!);
        return d / patch.length;
      };
      const still = cost(0, 0);
      let best = still;
      let mx = 0;
      let my = 0;
      if (still > 1.5) { // flat residual at rest from compression
        for (let dy = -radius; dy <= radius; dy++) {
          for (let dx = -radius; dx <= radius; dx++) {
            const d = cost(dx, dy) + 0.1 * Math.hypot(dx, dy);
            if (d < best) {
              best = d;
              mx = dx;
              my = dy;
            }
          }
        }
      }
      // As in jumpMove, the costs around the best integer match can place
      // it between pixels. Check that the fractional step improves the match.
      const vertex = (left: number, centre: number, right: number) => {
        const curve = left - 2 * centre + right;
        return curve > 0 ? Math.max(-0.5, Math.min(0.5, (left - right) / (2 * curve))) : 0;
      };
      const centre = cost(mx, my);
      if (still > 1.5 && centre < sd * 0.5) {
        const dx = Math.abs(mx) < radius ? vertex(cost(mx - 1, my), centre, cost(mx + 1, my)) : 0;
        const dy = Math.abs(my) < radius ? vertex(cost(mx, my - 1), centre, cost(mx, my + 1)) : 0;
        if (dx || dy) {
          let error = 0;
          let i = 0;
          for (let r = 0; r < grid; r += 2)
            for (let c = 0; c < grid; c += 2)
              error += Math.abs(patch[i++]! - sample(b, g.w, x + c + mx + dx, y + r + my + dy));
          if (error / patch.length < best) {
            best = error / patch.length;
            mx += dx;
            my += dy;
          }
        }
      }
      if (best > Math.min(14, sd * 0.35)) continue; // probe's textured-patch match
      mags.push(best < 0.7 * still ? Math.hypot(mx, my) : 0);
    }
  }
  return mags.length >= Math.max(4, textured * 0.45) ? median(mags) * 640 / g.w : null;
}

function looksLikeLight(g: StudyFrames, energy: Float32Array, means: Float32Array, i: number) {
  // Brief flashes on the test reels last one or two frames. Compare both
  // ends to see whether the old picture comes back — from i itself when i
  // is the way out of the light, which the film's last frame can only be.
  for (let a = Math.max(0, i - 3); a < i; a++) {
    for (let b = a + 2 <= i ? i : i + 1; b <= Math.min(i + 3, g.count - 1); b++) {
      if (b - a > 4) continue;
      const middle = means.subarray(a + 1, b);
      const light = Math.max(...middle) - Math.max(means[a]!, means[b]!);
      const dark = Math.min(means[a]!, means[b]!) - Math.min(...middle);
      if (Math.max(light, dark) < 0.06) continue;
      const fa = frame(g, a);
      const fb = frame(g, b);
      let distance = 0;
      for (let j = 0; j < fa.length; j++) distance += Math.abs(fa[j]! - fb[j]!);
      if (distance / (255 * fa.length) <= 0.28 * energy[i]!) return true;
    }
  }
  // A luma ramp moves nearly all the pixels one way over several steps.
  const sign = Math.sign(means[i]! - means[i - 1]!);
  if (!sign) return false;
  const ramp = (k: number) => {
    if (k < 1 || k >= g.count) return false;
    const luma = sign * (means[k]! - means[k - 1]!);
    return luma >= 0.012 && luma >= 0.82 * energy[k]! &&
      Math.min(energy[k]!, energy[i]!) >= 0.25 * Math.max(energy[k]!, energy[i]!);
  };
  return ramp(i) && ((ramp(i - 1) && ramp(i + 1)) ||
    (ramp(i - 2) && ramp(i - 1)) || (ramp(i + 1) && ramp(i + 2)));
}

export type PictureCandidate = {
  frame: number;
  nominations: Nomination[];
  verdict: Verdict;
  verified: boolean;
  across: CarryKind | null;
  energy: number;
  nearbyEnergy: number;
  changed: number;
  fit: Fit | null;
};

export function analyzeStudyPicture(g: StudyFrames) {
  const energy = frameEnergy(g);
  const means = new Float32Array(g.count);
  for (let i = 0; i < g.count; i++) {
    let sum = 0;
    for (const v of frame(g, i)) sum += v;
    means[i] = sum / (255 * g.w * g.h);
  }
  const cuts = findCuts(g, energy);
  const cutSet = new Set(cuts);
  const changes = findChanges(g, energy, cuts);
  const swaps = findSmallSwaps(g, energy, cuts);
  const carries = new Map(changes.filter((c) => cutSet.has(c.frame)).map((c) => [c.frame, c]));
  const seeds = new Map<number, Nomination[]>();
  const nominate = (at: number, source: Source, f = at, from = f - 1, to = f) => {
    const list = seeds.get(at) ?? [];
    list.push({ source, frame: f, from, to });
    seeds.set(at, list);
  };
  for (const i of cuts) nominate(i, "cuts");
  for (const { frame: i } of swaps) nominate(i, "small_swaps");

  const nearby = (i: number) => {
    const a = Array.from(energy.subarray(Math.max(1, i - 4), i));
    const b = Array.from(energy.subarray(i + 1, i + 5));
    // The second-largest flanking step, as in findCuts, leaves room for
    // a flash's other edge and for footage with duplicate frames.
    return [...a, ...b].sort((x, y) => y - x)[1] ?? 0;
  };
  for (let i = 1; i < g.count; i++) {
    const e = energy[i]!;
    // Include luma-similar swaps and the peaks of fast moves on the grey
    // copy. The nearby floor keeps codec noise on a hold out of the list.
    if (e < 0.009 || (e < 0.045 && e < 1.55 * nearby(i))) continue;
    let peak = true;
    for (let j = Math.max(1, i - 2); j <= Math.min(g.count - 1, i + 2); j++)
      if (energy[j]! > e || (energy[j] === e && j < i)) peak = false;
    if (peak) nominate(i, "energy_peak");
  }
  for (const c of changes) {
    let at = c.before + 1;
    let best = -Infinity;
    for (let i = at; i <= c.after; i++) {
      // A wide-window change may peak early. Use the strongest *adjacent*
      // evidence in its span and keep the source window in the report.
      const score = energy[i]! / Math.sqrt(Math.max(0.008, nearby(i)));
      if (score > best) {
        at = i;
        best = score;
      }
    }
    nominate(at, "changes", c.frame, c.before, c.after);
  }

  const steps: Step[] = [{ motion: null, localPx: null, energy: 0 }];
  for (let i = 1; i < g.count; i++) steps.push(stepBetween(g, i - 1, i, energy[i]!));

  const candidates: PictureCandidate[] = [];
  for (const [i, nominations] of [...seeds].sort(([a], [b]) => a - b)) {
    const a = frame(g, i - 1);
    const b = frame(g, i);
    const e = energy[i]!;
    const ref = nearby(i);
    const pair = picturePair(g, a, b);
    const motion = steps[i]!.motion;
    const took = (j: number) => studyTime(g, j) - studyTime(g, j - 1);
    const dt = took(i);
    const fastAt = (j: number) => fast(steps[j]!, g.w, took(j));
    const sides = [];
    for (let j = Math.max(1, i - CAMERA_SIDE); j < Math.min(steps.length, i + CAMERA_SIDE + 1); j++)
      if (j !== i) sides.push(j);
    const adjacent = sides.map((j) => steps[j]!);
    // the local-motion gate, held to the step's share of a thirtieth of a second
    const fastLocal = FAST_LOCAL * (dt > 0 ? Math.min(1, dt / FAST_SECONDS) : 1);
    const flank = adjacent.flatMap((s) => s.motion ? [s.motion] : []);
    const flankScale = Math.max(0, ...flank.map((m) => Math.abs(Math.log(m.s))));
    const flankSpeed = Math.max(0, ...flank.map((m) => speed(m, g.w)));
    // Abrupt over the flanks — or over the two steps right beside it, when a
    // whip slows into the cut: its energy fills the flanks on one side, but
    // the step before the cut has already dropped (3× the larger neighbour;
    // inside a fast move the steps on both sides run close to the peak).
    const beside = Math.max(energy[i - 1] ?? 0, energy[i + 1] ?? 0);
    const abrupt = e >= Math.max(0.012, 1.75 * ref) || e >= Math.max(0.012, 3 * beside);
    let fit = motion && speed(motion, g.w) >= 0.25 ? fitEvidence(g, a, b, motion) : null;
    let verdict: Verdict = "unresolved";
    let across: CarryKind | null = null;
    if (looksLikeLight(g, energy, means, i) ||
      (e >= 0.035 && Math.abs(means[i]! - means[i - 1]!) > 0.4 * e && sameUnderLight(a, b, e))) {
      verdict = "flash_or_fade";
    } else {
      if (!fit && (abrupt || e > 0.065) && (pair.changed >= 0.12 || e >= 0.026)) {
        fit = widenScale(g, a, b);
      }
      if (fit && trusted(fit)) {
        const log = Math.abs(Math.log(fit.s));
        if (log >= Math.log(SCALE_JUMP - 0.01) && log > 1.65 * flankScale) {
          verdict = "scale_jump";
          across = "carried";
        } else if (e >= 2.5 * ref && log < 0.06 &&
          translation(fit, g.w) >= 35 && speed(fit, g.w) > 3 * flankSpeed) {
          // A shift of this size in one frame with still or slow shoulders
          // is a jump to another framing, as in a panel-to-panel edit.
          verdict = "match_cut";
          across = "carried";
        } else if (abrupt && e >= 2.5 * ref && log >= 0.06 && log > 3 * flankScale &&
          speed(fit, g.w) > 3 * flankSpeed) {
          // A step in scale in one frame between still or slow shoulders is
          // a cut to a nearer or farther framing, not part of a move.
          verdict = "match_cut";
          across = "carried";
        } else if (fast({ motion: fit, localPx: null, energy: e }, g.w, dt)) {
          verdict = "fast_move";
        }
      }
      // On a film faster than 30 fps one frame's move can be too small to fit
      // on the grey copy: a change that is not abrupt is read again over a
      // thirtieth of a second, as stateSteps reads travel.
      if (verdict === "unresolved" && !abrupt && dt > 0 && dt < FAST_SECONDS * 0.75) {
        const from = Math.max(0, i - Math.round(FAST_SECONDS / dt));
        const m = pictureMotion(g, from, i);
        const spanFit = m && speed(m, g.w) >= 0.25 ? fitEvidence(g, frame(g, from), b, m) : null;
        if (spanFit && trusted(spanFit) && Math.abs(Math.log(spanFit.s)) < Math.log(SCALE_JUMP - 0.01) &&
          fast({ motion: spanFit, localPx: null, energy: e }, g.w, studyTime(g, i) - studyTime(g, from)))
          verdict = "fast_move";
      }
      if (verdict === "unresolved") {
        const inPlace = pair.stillTexture + pair.flat;
        const outside = fitEvidence(g, a, b, identity);
        const local = steps[i]!.localPx ?? 0;
        if ((pair.changed < 0.42 && (inPlace > 0.64 ||
          (pair.changed < 0.20 && (inPlace > 0.54 || outside.support > 0.55)))) ||
          (pair.changed < 0.70 && pair.edgeKept >= 0.75 && pair.stillTexture >= 0.13)) {
          verdict = "in_picture_change";
        } else if (local >= fastLocal && !abrupt && sides.some(fastAt)) {
          verdict = "fast_move";
        } else if (abrupt && (pair.changed >= 0.32 || (pair.changed >= 0.19 && e >= 0.035)) &&
          !(local >= fastLocal && inPlace > 0.55)) {
          const carry = carries.get(i);
          const shoulders = Math.max(energy[i - 1] ?? 0, energy[i + 1] ?? 0);
          // A layered push may fail the whole-frame fit. If a moving region
          // survives the pair and either neighbouring step also has a strong
          // change, keep the motion together unless the pair proved a jump.
          const followed = shoulders >= 0.46 * e || !carry
            ? follow(g, i - 1, i, 5) : null;
          if (shoulders >= 0.46 * e && followed && followed.share >= 0.28 && followed.shift &&
            Math.hypot(followed.shift.x, followed.shift.y) >= 1.5) {
            verdict = "fast_move";
          } else {
            across = carry?.across ?? (Math.max(pair.stillTexture, followed?.share ?? 0) >= 0.10 ? "carried"
              : pair.flat >= 0.25 ? "background only" : "nothing carried");
            verdict = across === "carried" ? "match_cut" : "hard_cut";
          }
        }
      }
    }
    const verified = verdict === "hard_cut" || verdict === "scale_jump" || verdict === "match_cut";
    candidates.push({ frame: i, nominations, verdict, verified, across, energy: e, nearbyEnergy: ref,
      changed: pair.changed, fit });
  }
  return { steps, candidates, means };
}

/** The camera's path, one reading a frame. `spans` gives, for a frame, the
 *  step that ends on it spanning a thirtieth of a second or more and the
 *  seconds it took (stateSteps): on a film faster than 30 fps a frame's own
 *  step moves too little to read on the grey copy, so the span's move is
 *  read and shared out over the frames it covers. */
export function cameraReadings(
  g: StudyFrames,
  steps: readonly Step[],
  cuts: ReadonlySet<number>,
  spans: ReadonlyMap<number, { step: Step; seconds: number }> = new Map(),
) {
  const path: CameraPath = { step: 1, t: [], logScale: [], dx: [], dy: [] };
  for (let i = 1; i < g.count; i++) {
    const own = studyTime(g, i) - studyTime(g, i - 1);
    const span = spans.get(i);
    const m = cuts.has(i) ? null : span ? span.step.motion : steps[i]!.motion;
    const k = span && span.seconds > 0 && own > 0 ? own / span.seconds : 1;
    path.t.push(studyTime(g, i));
    path.logScale.push(m ? Math.log(m.s) * k : null);
    path.dx.push(m ? (m.x / g.w) * k : null);
    path.dy.push(m ? (m.y / g.h) * k : null);
  }
  return path;
}

export function motionSide(
  g: StudyFrames, steps: readonly Step[], from: number, to: number,
) {
  const moves = [];
  for (let i = Math.max(1, from); i < to; i++) {
    const m = steps[i]!.motion;
    if (m) moves.push({ m, dt: studyTime(g, i) - studyTime(g, i - 1) });
  }
  if (!moves.length) return null;
  const x = median(moves.map(({ m }) => m.x * 640 / g.w));
  const y = median(moves.map(({ m }) => m.y * 640 / g.w));
  const logScale = median(moves.map(({ m }) => Math.log(m.s)));
  const pxPerFrame = median(moves.map(({ m }) => speed(m, g.w)));
  const pxPerSecond = median(moves.map(({ m, dt }) => speed(m, g.w) / dt));
  const vx = median(moves.map(({ m, dt }) => m.x * 640 / g.w / dt));
  const vy = median(moves.map(({ m, dt }) => m.y * 640 / g.w / dt));
  const zoom = median(moves.map(({ m, dt }) => Math.log(m.s) / dt));
  // The old still gate for a flank was |ln s| of 0.001 per frame at 30 fps.
  const dir = Math.hypot(vx, vy) < DRIFT_RATE && Math.abs(zoom) < 0.001 * 30 ? "still"
    : Math.abs(zoom) * 160 > Math.hypot(vx, vy) ? (zoom > 0 ? "in" : "out")
    : Math.abs(vx) >= Math.abs(vy) ? (vx > 0 ? "right" : "left") : (vy > 0 ? "down" : "up");
  return { dir, x, y, logScale, pxPerFrame, pxPerSecond };
}

export function boundaryMotion(
  g: StudyFrames, steps: readonly Step[], c: PictureCandidate, from: number, to: number,
) {
  const i = c.frame;
  const left = Math.max(from + 1, i - CAMERA_SIDE);
  const right = Math.min(to, i + CAMERA_SIDE + 1);
  const before = motionSide(g, steps, left, i);
  const after = motionSide(g, steps, i + 1, right);
  const across = c.fit;
  const around = steps.slice(left, i).concat(steps.slice(i + 1, right));
  const atPeak = across && around.some((s) => s.motion)
    ? around.every((s) => !s.motion || speed(across, g.w) >= speed(s.motion, g.w))
    : null;
  const continues = before && after && before.dir !== "still" && after.dir !== "still"
    ? before.dir === after.dir : null;
  return { before, after, continues, atPeak, scale: across?.s ?? null };
}

/** What the study says crosses a cut: the probe's reading on the grey copy,
 *  or a small part seen staying put on a finer one. */
export type AcrossKind = CarryKind | "small part kept";

/** The width of the copy `keptInPlace` reads: the strips' colour frames. A
 *  thing 100 px across on a 1920 px film is one block of the 96 px grey copy
 *  and two or three across here. */
export const KEPT_WIDTH = 320;
const KEPT_BLOCK = 8;
// A block counts when it has texture before the cut (variance ≥ 100 grey²:
// lettering, a face, an icon — not a flat ground or a soft gradient) and the
// same block after it differs by under 6 grey levels a pixel, which JPEG noise
// stays below and a different picture does not.
const KEPT_TEXTURE = 100;
const KEPT_DIFFERENCE = 6;
// Lone blocks agree by chance across unrelated shots (up to 15 scattered ones
// at a hard cut of the launch reels this was checked on, never four
// touching); a thing that stayed covers several that touch.
const KEPT_TOUCHING = 4;

/** The share of the frame, 0..1, in patches of textured picture that are the
 *  same, in the same place, in the frame before a cut and the frame after it:
 *  a pinned caption, a logo, an avatar that the next scene opens on. Too small
 *  for the grey copy's 10 % "carried", and not nothing. It does not follow a
 *  thing that moves across the cut or lands on a different ground. `a` and
 *  `b` are grey frames of w × h. */
export function keptInPlace(a: Uint8Array, b: Uint8Array, w: number, h: number): number {
  const B = KEPT_BLOCK;
  const cols = Math.floor(w / B);
  const rows = Math.floor(h / B);
  if (cols < 1 || rows < 1) return 0;
  const kept = new Uint8Array(cols * rows);
  const n = B * B;
  for (let by = 0; by < rows; by++) {
    for (let bx = 0; bx < cols; bx++) {
      let sum = 0;
      let squares = 0;
      let d = 0;
      for (let r = by * B; r < by * B + B; r++) {
        for (let c = bx * B; c < bx * B + B; c++) {
          const va = a[r * w + c]!;
          sum += va;
          squares += va * va;
          d += Math.abs(va - b[r * w + c]!);
        }
      }
      if (squares / n - (sum / n) ** 2 >= KEPT_TEXTURE && d / n < KEPT_DIFFERENCE) kept[by * cols + bx] = 1;
    }
  }
  // patches of blocks that touch, corners included
  let total = 0;
  const stack: number[] = [];
  for (let k = 0; k < kept.length; k++) {
    if (kept[k] !== 1) continue;
    let size = 0;
    kept[k] = 2;
    stack.push(k);
    while (stack.length) {
      const at = stack.pop()!;
      size++;
      const x = at % cols;
      const y = (at - x) / cols;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= cols || ny >= rows) continue;
          const j = ny * cols + nx;
          if (kept[j] === 1) {
            kept[j] = 2;
            stack.push(j);
          }
        }
      }
    }
    if (size >= KEPT_TOUCHING) total += size;
  }
  return total / kept.length;
}
