// DSP building blocks for the music layer: band-limited oscillators, a
// modulation-safe state-variable filter, envelopes, a feedback-delay-network
// reverb, a ping-pong delay and a sidechain curve.
//
// Everything is pure and seeded: the same arguments always give the same
// samples, bit for bit — the property the whole package is built on.

import { rng } from "./synth";

export const SR = 48000;

export const midiHz = (n: number) => 440 * 2 ** ((n - 69) / 12);
export const dbToLin = (db: number) => 10 ** (db / 20);
export const linToDb = (v: number) => (v > 0 ? 20 * Math.log10(v) : Number.NEGATIVE_INFINITY);

// --- oscillators ---------------------------------------------------------

/** PolyBLEP residual: removes the aliasing a naive saw/square edge makes. */
function blep(t: number, dt: number): number {
  if (t < dt) {
    const x = t / dt;
    return x + x - x * x - 1;
  }
  if (t > 1 - dt) {
    const x = (t - 1) / dt;
    return x * x + x + x + 1;
  }
  return 0;
}

export type Wave = "saw" | "square" | "sine";

/** One band-limited oscillator into `out` (added), frequency may glide.
 *  `phase0` in cycles (0..1). Returns the phase it ended on. */
export function oscillate(
  out: Float32Array,
  start: number,
  n: number,
  freq: (i: number) => number,
  wave: Wave,
  gain: (i: number) => number,
  phase0 = 0,
  sr = SR,
): number {
  let ph = phase0 - Math.floor(phase0);
  for (let i = 0; i < n; i++) {
    const j = start + i;
    const dt = Math.min(0.49, freq(i) / sr);
    let v: number;
    switch (wave) {
      case "saw":
        v = 2 * ph - 1 - blep(ph, dt);
        break;
      case "square":
        v = (ph < 0.5 ? 1 : -1) + blep(ph, dt) - blep((ph + 0.5) % 1, dt);
        break;
      default:
        v = Math.sin(2 * Math.PI * ph);
    }
    if (j >= 0 && j < out.length) out[j]! += v * gain(i);
    ph += dt;
    if (ph >= 1) ph -= 1;
  }
  return ph;
}

// --- filters -------------------------------------------------------------

/** Topology-preserving state-variable filter (Zavalishin / Cytomic). Stable
 *  under fast cutoff modulation, which a pad's filter sweep needs. */
export class Svf {
  private ic1 = 0;
  private ic2 = 0;
  constructor(private readonly sr = SR) {}
  /** Process one sample; returns [low, band, high]. */
  tick(x: number, cutoff: number, q: number): [number, number, number] {
    const g = Math.tan((Math.PI * Math.min(cutoff, this.sr * 0.45)) / this.sr);
    const k = 1 / q;
    const a1 = 1 / (1 + g * (g + k));
    const a2 = g * a1;
    const a3 = g * a2;
    const v3 = x - this.ic2;
    const v1 = a1 * this.ic1 + a2 * v3;
    const v2 = this.ic2 + a2 * this.ic1 + a3 * v3;
    this.ic1 = 2 * v1 - this.ic1;
    this.ic2 = 2 * v2 - this.ic2;
    return [v2, v1, x - k * v1 - v2];
  }
}

export type SvfMode = "low" | "band" | "high";

/** Filter a buffer in place with a (possibly moving) cutoff. */
export function svf(
  x: Float32Array,
  mode: SvfMode,
  cutoff: (i: number) => number,
  q = Math.SQRT1_2,
  sr = SR,
): Float32Array {
  const f = new Svf(sr);
  const idx = mode === "low" ? 0 : mode === "band" ? 1 : 2;
  for (let i = 0; i < x.length; i++) x[i] = f.tick(x[i]!, cutoff(i), q)[idx]!;
  return x;
}

/** One-pole low-pass (for damping inside feedback loops). */
class OnePole {
  private z = 0;
  constructor(private readonly a: number) {}
  tick(x: number): number {
    this.z += this.a * (x - this.z);
    return this.z;
  }
}

/** RBJ-cookbook biquad in place. */
function biquadInPlace(
  x: Float32Array,
  b0: number,
  b1: number,
  b2: number,
  a0: number,
  a1: number,
  a2: number,
): Float32Array {
  let x1 = 0,
    x2 = 0,
    y1 = 0,
    y2 = 0;
  for (let i = 0; i < x.length; i++) {
    const xi = x[i]!;
    const yi = (b0 * xi + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2) / a0;
    x2 = x1;
    x1 = xi;
    y2 = y1;
    y1 = yi;
    x[i] = yi;
  }
  return x;
}

/** High shelf (slope 1): +gainDb above `fc`. */
export function highShelf(x: Float32Array, fc: number, gainDb: number, sr = SR): Float32Array {
  const A = 10 ** (gainDb / 40);
  const w = (2 * Math.PI * fc) / sr;
  const c = Math.cos(w);
  const alpha = (Math.sin(w) / 2) * Math.SQRT2;
  const k = 2 * Math.sqrt(A) * alpha;
  return biquadInPlace(
    x,
    A * (A + 1 + (A - 1) * c + k),
    -2 * A * (A - 1 + (A + 1) * c),
    A * (A + 1 + (A - 1) * c - k),
    A + 1 - (A - 1) * c + k,
    2 * (A - 1 - (A + 1) * c),
    A + 1 - (A - 1) * c - k,
  );
}

/** Peaking EQ: gainDb at `fc` with width `q`. */
export function peakEq(
  x: Float32Array,
  fc: number,
  gainDb: number,
  q: number,
  sr = SR,
): Float32Array {
  const A = 10 ** (gainDb / 40);
  const w = (2 * Math.PI * fc) / sr;
  const alpha = Math.sin(w) / (2 * q);
  const c = Math.cos(w);
  return biquadInPlace(
    x,
    1 + alpha * A,
    -2 * c,
    1 - alpha * A,
    1 + alpha / A,
    -2 * c,
    1 - alpha / A,
  );
}

// --- noise & envelopes -----------------------------------------------------

export function whiteNoise(n: number, seed: number): Float32Array {
  const r = rng(seed);
  const y = new Float32Array(n);
  for (let i = 0; i < n; i++) y[i] = r() * 2 - 1;
  return y;
}

/** Attack / decay / sustain / release in seconds, evaluated at t (seconds
 *  since note-on) for a note held `hold` seconds. Exponential segments. */
export function adsr(t: number, hold: number, a: number, d: number, s: number, r: number): number {
  if (t < 0) return 0;
  const u = t < hold ? t : hold;
  const level = u < a ? (a > 0 ? u / a : 1) : s + (1 - s) * Math.exp(-(u - a) / Math.max(1e-4, d));
  if (t < hold) return level;
  return level * Math.exp(-(t - hold) / Math.max(1e-4, r / 5));
}

// --- effects ---------------------------------------------------------------

/** A small stereo reverb: 8 delay lines mixed through a Householder matrix,
 *  damped per line, decay set from RT60. Returns the wet signal only. */
export function reverb(
  inL: Float32Array,
  inR: Float32Array,
  opts: { rt60: number; damp: number; preDelayS: number; tailS?: number },
  sr = SR,
): [Float32Array, Float32Array] {
  const lengths = [1123, 1289, 1447, 1597, 1777, 1949, 2129, 2311].map((l) =>
    Math.round((l * sr) / 44100),
  );
  const pre = Math.round(opts.preDelayS * sr);
  const n = inL.length + Math.round((opts.tailS ?? 0) * sr);
  const outL = new Float32Array(n);
  const outR = new Float32Array(n);
  const lines = lengths.map((l) => new Float32Array(l));
  const pos = lengths.map(() => 0);
  const gains = lengths.map((l) => 10 ** ((-3 * l) / (opts.rt60 * sr)));
  const damp = lengths.map(() => new OnePole(opts.damp));
  const N = lines.length;
  const read = new Float64Array(N);
  for (let i = 0; i < n; i++) {
    const src = i - pre;
    const xl = src >= 0 && src < inL.length ? inL[src]! : 0;
    const xr = src >= 0 && src < inR.length ? inR[src]! : 0;
    let sum = 0;
    for (let k = 0; k < N; k++) {
      read[k] = lines[k]![pos[k]!]!;
      sum += read[k]!;
    }
    const h = (2 / N) * sum;
    let l = 0;
    let r = 0;
    for (let k = 0; k < N; k++) {
      const fb = damp[k]!.tick((read[k]! - h) * gains[k]!);
      const inject = k % 2 === 0 ? xl : xr;
      lines[k]![pos[k]!] = fb + inject * 0.35;
      pos[k] = (pos[k]! + 1) % lines[k]!.length;
      if (k % 2 === 0) l += read[k]!;
      else r += read[k]!;
    }
    outL[i] = l * 0.25;
    outR[i] = r * 0.25;
  }
  return [outL, outR];
}

/** Ping-pong delay: the echo alternates sides, each repeat darker. Wet only. */
export function pingPong(
  inL: Float32Array,
  inR: Float32Array,
  opts: { delayS: number; feedback: number; damp: number; tailS?: number },
  sr = SR,
): [Float32Array, Float32Array] {
  const d = Math.max(1, Math.round(opts.delayS * sr));
  const n = inL.length + Math.round((opts.tailS ?? 0) * sr);
  const outL = new Float32Array(n);
  const outR = new Float32Array(n);
  const bufL = new Float32Array(d);
  const bufR = new Float32Array(d);
  const dl = new OnePole(opts.damp);
  const dr = new OnePole(opts.damp);
  let p = 0;
  for (let i = 0; i < n; i++) {
    const xl = i < inL.length ? inL[i]! : 0;
    const xr = i < inR.length ? inR[i]! : 0;
    const yl = bufL[p]!;
    const yr = bufR[p]!;
    // cross-feed: left's echo feeds the right line and vice versa
    bufL[p] = dl.tick((xl + xr) * 0.5 + yr * opts.feedback);
    bufR[p] = dr.tick(yl * opts.feedback);
    p = (p + 1) % d;
    outL[i] = yl;
    outR[i] = yr;
  }
  return [outL, outR];
}

/** Sidechain gain curve: a dip of `depthDb` at every trigger, recovering over
 *  `releaseS` with an S-shaped curve (the "pump"). */
export function sidechainCurve(
  n: number,
  triggersS: number[],
  depthDb: number,
  releaseS: number,
  sr = SR,
): Float32Array {
  const g = new Float32Array(n).fill(1);
  const floor = dbToLin(-Math.abs(depthDb));
  const attack = Math.round(0.004 * sr);
  const rel = Math.round(releaseS * sr);
  for (const t of triggersS) {
    const s = Math.round(t * sr);
    for (let i = -attack; i < rel; i++) {
      const j = s + i;
      if (j < 0 || j >= n) continue;
      let v: number;
      if (i < 0) v = 1 - (1 - floor) * ((i + attack) / attack);
      else {
        const u = i / rel;
        v = floor + (1 - floor) * (u * u * (3 - 2 * u));
      }
      if (v < g[j]!) g[j] = v;
    }
  }
  return g;
}

/** tanh saturation normalised so small signals pass at unity. */
export function saturate(x: Float32Array, drive: number): Float32Array {
  const k = Math.tanh(drive);
  for (let i = 0; i < x.length; i++) x[i] = Math.tanh(x[i]! * drive) / k;
  return x;
}

export function addInto(dst: Float32Array, src: Float32Array, at: number, gain = 1): void {
  const n = Math.min(src.length, dst.length - at);
  for (let i = Math.max(0, -at); i < n; i++) dst[at + i]! += src[i]! * gain;
}

export function peak(x: Float32Array): number {
  let m = 0;
  for (let i = 0; i < x.length; i++) m = Math.max(m, Math.abs(x[i]!));
  return m;
}

export { rng };
