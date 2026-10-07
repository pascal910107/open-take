// `open-take film beats`: a piece of music (or a film's sound) as a grid to
// cut on — its tempo, the beats, which beat starts each bar, the sections
// where its texture changes, the drops where it lands hard, and every onset —
// written as <name>.beats.json for the page (kit/cut.js grid) and the score
// (kit/audio.mjs cutToBars). Every field says whether it was measured, is an
// estimate, or was not found; a downbeat is always an estimate, with how
// often the bars agreed on it.
//
// The analysis here is shared with `film listen` and `film probe`: a
// short-time spectrum, onsets from where its bands rise, a tempo from how the
// onset strength repeats, fitted to the onsets so the grid still sits on the
// beat minutes later, and sections from where the texture stops resembling
// what came before.

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { resolveFfmpeg } from "../ffmpeg";

// --- the spectrum, onsets, tempo ----------------------------------------------------

/** the rate the sound is analysed at: everything a film's rhythm and texture
 *  needs sits below its 11 kHz */
export const LISTEN_RATE = 22_050;
export const WIN = 1024; // 46 ms
const HOP = 256; // 11.6 ms
export const BANDS = 48;
export const LOW_HZ = 40;
export const HIGH_HZ = 10_000;
/** below this a frame is silence, not a quiet texture */
export const FLOOR_DB = -70;

export type Spectrum = {
  /** seconds between frames */
  hopS: number;
  /** frame i covers [i·hop, i·hop + win) samples; its time is its centre */
  frameTime: (i: number) => number;
  /** per frame, log energy (dB) in BANDS log-spaced bands from 40 Hz to 10 kHz */
  bands: Float32Array[];
  /** per frame, the level (dBFS RMS) */
  level: Float32Array;
};

export function spectrum(pcm: Float32Array, rate = LISTEN_RATE): Spectrum {
  const n = pcm.length < WIN ? 0 : Math.floor((pcm.length - WIN) / HOP) + 1;
  const hann = new Float32Array(WIN);
  for (let i = 0; i < WIN; i++) hann[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / WIN);
  // which FFT bins each band sums; a band narrower than a bin takes the nearest one
  const binHz = rate / WIN;
  const edges = Array.from(
    { length: BANDS + 1 },
    (_, b) => LOW_HZ * (HIGH_HZ / LOW_HZ) ** (b / BANDS),
  );
  const ranges = Array.from({ length: BANDS }, (_, b) => {
    const lo = Math.max(1, Math.round(edges[b]! / binHz));
    const hi = Math.max(lo + 1, Math.round(edges[b + 1]! / binHz));
    return [lo, Math.min(hi, WIN / 2)] as const;
  });
  const fft = makeFft(WIN);
  const re = new Float64Array(WIN);
  const im = new Float64Array(WIN);
  const bands: Float32Array[] = [];
  const level = new Float32Array(n);
  // a full-scale sine's windowed peak bin power, so bands read near dBFS
  const ref = (WIN * 0.5 * 0.5) ** 2;
  for (let f = 0; f < n; f++) {
    let sq = 0;
    for (let i = 0; i < WIN; i++) {
      const x = pcm[f * HOP + i]!;
      sq += x * x;
      re[i] = x * hann[i]!;
      im[i] = 0;
    }
    level[f] = 10 * Math.log10(sq / WIN + 1e-12);
    fft(re, im);
    const row = new Float32Array(BANDS);
    for (let b = 0; b < BANDS; b++) {
      const [lo, hi] = ranges[b]!;
      let e = 0;
      for (let k = lo; k < hi; k++) e += re[k]! * re[k]! + im[k]! * im[k]!;
      row[b] = Math.max(FLOOR_DB - 20, 10 * Math.log10(e / ref + 1e-12));
    }
    bands.push(row);
  }
  const hopS = HOP / rate;
  return { hopS, frameTime: (i) => (i * HOP + WIN / 2) / rate, bands, level };
}

/** in-place radix-2 FFT of a fixed size */
function makeFft(size: number): (re: Float64Array, im: Float64Array) => void {
  const bits = Math.log2(size);
  const rev = new Uint32Array(size);
  for (let i = 0; i < size; i++) {
    let r = 0;
    for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b);
    rev[i] = r;
  }
  const cos = new Float64Array(size / 2);
  const sin = new Float64Array(size / 2);
  for (let i = 0; i < size / 2; i++) {
    cos[i] = Math.cos((2 * Math.PI * i) / size);
    sin[i] = -Math.sin((2 * Math.PI * i) / size);
  }
  return (re, im) => {
    for (let i = 0; i < size; i++) {
      const j = rev[i]!;
      if (j > i) {
        [re[i], re[j]] = [re[j]!, re[i]!];
        [im[i], im[j]] = [im[j]!, im[i]!];
      }
    }
    for (let len = 2; len <= size; len <<= 1) {
      const half = len >> 1;
      const step = size / len;
      for (let i = 0; i < size; i += len)
        for (let k = 0; k < half; k++) {
          const wr = cos[k * step]!;
          const wi = sin[k * step]!;
          const a = i + k;
          const b = a + half;
          const tr = re[b]! * wr - im[b]! * wi;
          const ti = re[b]! * wi + im[b]! * wr;
          re[b] = re[a]! - tr;
          im[b] = im[a]! - ti;
          re[a] = re[a]! + tr;
          im[a] = im[a]! + ti;
        }
    }
  };
}

/** how much new energy each frame brings: the summed rise of every band over
 *  the louder of the two frames before it (a rise, never a fall) */
export function onsetStrength(s: Spectrum): Float32Array {
  return riseIn(s, 0, BANDS);
}

/** the same, over the bands between loHz and hiHz only: the low end (kick,
 *  bass) is where a beat lands when hats fill the gaps between */
export function bandOnsetStrength(s: Spectrum, loHz: number, hiHz: number): Float32Array {
  const band = (hz: number) => (BANDS * Math.log(hz / LOW_HZ)) / Math.log(HIGH_HZ / LOW_HZ);
  const k0 = Math.max(0, Math.floor(band(loHz)));
  const k1 = Math.min(BANDS, Math.max(k0 + 1, Math.ceil(band(hiHz))));
  return riseIn(s, k0, k1);
}

function riseIn(s: Spectrum, k0: number, k1: number): Float32Array {
  const env = new Float32Array(s.bands.length);
  for (let f = 1; f < s.bands.length; f++) {
    const cur = s.bands[f]!;
    const a = s.bands[f - 1]!;
    const b = s.bands[Math.max(0, f - 2)]!;
    let rise = 0;
    for (let k = k0; k < k1; k++) {
      const floor = Math.max(a[k]!, b[k]!, FLOOR_DB);
      if (cur[k]! > floor) rise += cur[k]! - floor;
    }
    env[f] = rise / (k1 - k0);
  }
  return env;
}

/** the frame whose centre is nearest t (may fall outside the spectrum) */
const frameAt = (s: Spectrum, t: number) => Math.round((t - s.frameTime(0)) / s.hopS);

/** an envelope's largest value within ±`near` frames of t */
function peakNear(s: Spectrum, env: Float32Array, t: number, near = 2): number {
  const f = frameAt(s, t);
  let v = 0;
  for (let k = Math.max(0, f - near); k <= Math.min(env.length - 1, f + near); k++)
    v = Math.max(v, env[k]!);
  return v;
}

/** onset times (s): frames whose new energy is a local peak and stands clear
 *  of its neighbourhood (the median of the surrounding 0.6 s plus half the
 *  film's spread), each placed on the sample where the sound itself rises */
export function pickOnsets(
  s: Spectrum,
  env: Float32Array,
  pcm?: Float32Array,
  rate = LISTEN_RATE,
): number[] {
  const n = env.length;
  if (!n) return [];
  let mean = 0;
  for (const v of env) mean += v;
  mean /= n;
  let sd = 0;
  for (const v of env) sd += (v - mean) ** 2;
  sd = Math.sqrt(sd / n);
  const W = Math.round(0.3 / s.hopS);
  const near = 3; // ±35 ms
  const out: number[] = [];
  const window: number[] = [];
  for (let f = 0; f < n; f++) {
    const v = env[f]!;
    if (v <= 0 || s.level[f]! < FLOOR_DB + 10) continue;
    let peak = true;
    for (let k = Math.max(0, f - near); k <= Math.min(n - 1, f + near) && peak; k++)
      if (env[k]! > v || (env[k] === v && k < f)) peak = false;
    if (!peak) continue;
    window.length = 0;
    for (let k = Math.max(0, f - W); k <= Math.min(n - 1, f + W); k++) window.push(env[k]!);
    window.sort((a, b) => a - b);
    const median = window[window.length >> 1]!;
    if (v < median + 0.5 * sd || v < 0.5) continue;
    out.push(pcm ? refineOnset(pcm, rate, s.frameTime(f)) : s.frameTime(f));
  }
  return out;
}

/** within ±one window of a frame's onset, the 2 ms step where the level rises
 *  most — the onset as heard, not as the spectrum's 46 ms window blurs it */
function refineOnset(pcm: Float32Array, rate: number, t: number): number {
  const step = Math.round(rate * 0.002);
  const span = WIN / rate;
  const a = Math.max(0, Math.round((t - span) * rate));
  const b = Math.min(pcm.length - step, Math.round((t + span * 0.5) * rate));
  if (b - a < step * 4) return t;
  const lv: number[] = [];
  for (let i = a; i + step <= b; i += step) {
    let sq = 0;
    for (let k = i; k < i + step; k++) sq += pcm[k]! * pcm[k]!;
    lv.push(10 * Math.log10(sq / step + 1e-12));
  }
  let best = -1;
  let rise = 0;
  for (let i = 2; i < lv.length; i++) {
    const r = lv[i]! - Math.max(lv[i - 1]!, lv[i - 2]!);
    if (r > rise) {
      rise = r;
      best = i;
    }
  }
  // a rise under 6 dB is no edge: leave the frame's time
  return best < 0 || rise < 6 ? t : (a + best * step) / rate;
}

export type Tempo = {
  bpm: number;
  /** seconds a beat, as fitted to the onsets */
  periodS: number;
  /** how strongly the onset strength repeats at this period: its
   *  autocorrelation there over at zero lag (0..1) */
  strength: number;
  /** the other periods that repeat almost as strongly (half, double…) */
  alternatives: { bpm: number; strength: number }[];
  /** the beat grid laid at this tempo, at the phase most onsets fall on */
  beats: number[];
  /** the share of beats with an onset within 40 ms */
  gridFit: number;
  /** the share of the sound within 40 ms of some onset: what gridFit would be
   *  for a grid laid anywhere */
  chance: number;
  /** false when the first half's period and the second half's differ by more
   *  than 0.4%: the beats then follow the onsets instead of one grid */
  steady: boolean;
};

/** the period (60–200 BPM) at which the onset strength repeats most, and a
 *  beat grid at it: fitted to the onsets over the whole sound, on the beat the
 *  low end lands on, and following the onsets where the tempo does not hold;
 *  null when nothing repeats */
export function estimateTempo(
  s: Spectrum,
  env: Float32Array,
  onsets: readonly number[],
  duration: number,
): Tempo | null {
  const n = env.length;
  const lagOf = (bpm: number) => 60 / bpm / s.hopS;
  const minLag = Math.floor(lagOf(200));
  const maxLag = Math.ceil(lagOf(60));
  if (n < maxLag * 3) return null;
  let mean = 0;
  for (const v of env) mean += v;
  mean /= n;
  const x = Float64Array.from(env, (v) => v - mean);
  let zero = 0;
  for (const v of x) zero += v * v;
  if (!(zero > 0)) return null;
  const ac = new Float64Array(maxLag + 2);
  for (let lag = minLag - 1; lag <= maxLag + 1; lag++) {
    let sum = 0;
    for (let i = 0; i + lag < n; i++) sum += x[i]! * x[i + lag]!;
    // unbiased: a long lag sums fewer products
    ac[lag] = (sum / (n - lag)) * (n / zero);
  }
  const peaks: { lag: number; v: number }[] = [];
  for (let lag = minLag; lag <= maxLag; lag++)
    if (ac[lag]! > 0 && ac[lag]! >= ac[lag - 1]! && ac[lag]! > ac[lag + 1]!) {
      // the peak between whole frames, from the parabola through its neighbours
      const a = ac[lag - 1]!;
      const b = ac[lag]!;
      const c = ac[lag + 1]!;
      const d = a - 2 * b + c;
      peaks.push({ lag: d < 0 ? lag + (0.5 * (a - c)) / d : lag, v: b });
    }
  if (!peaks.length) return null;
  peaks.sort((p, q) => q.v - p.v);
  // a pulse repeats at every multiple of its period too, and a half-time feel
  // repeats at twice it: among the periods a whole multiple or fraction of the
  // strongest (up to 4) that repeat at least half as strongly, the beat is
  // the one whose strength, weighed by how usual its tempo is (a log-normal
  // around 120 BPM, an octave wide — it only chooses between such multiples),
  // is greatest
  const usual = (lag: number) => Math.exp(-0.5 * Math.log2(60 / (lag * s.hopS) / 120) ** 2);
  const top = peaks
    .filter((p) => {
      const r = peaks[0]!.lag / p.lag;
      const whole = r >= 1 ? r : 1 / r;
      return (
        p.v >= peaks[0]!.v * 0.5 &&
        Math.round(whole) <= 4 &&
        Math.abs(whole - Math.round(whole)) < 0.04
      );
    })
    .reduce((a, b) => (b.v * usual(b.lag) > a.v * usual(a.lag) ? b : a));
  const bpmOf = (lag: number) => Math.round((60 / (lag * s.hopS)) * 10) / 10;
  // the autocorrelation's period is good to a fraction of a frame a beat,
  // which over minutes drifts off the beat by more than the gap between two
  // sixteenths: the period and phase that line the most onset strength up
  // over the whole sound, searched finely around it
  const weight = (t: number) => peakNear(s, env, t);
  const w = onsets.map(weight);
  let { period, t0 } = combFit(onsets, w, top.lag * s.hopS, duration);
  // on the beat or half a beat over: hats between the beats rise in as many
  // bands as the beats do, so where the low end (kick, bass) clearly lands is
  // the beat; without a clear low end, where the most new energy lands is
  const low = bandOnsetStrength(s, 30, 160);
  const comb = (e: Float32Array, from: number) => {
    let sum = 0;
    // ±35 ms: the low end rises later than the click of the attack in a 46 ms window
    for (let t = from; t < duration; t += period) sum += peakNear(s, e, t, 3);
    return sum;
  };
  const [lowOn, lowOff] = [comb(low, t0), comb(low, t0 + period / 2)];
  const off =
    lowOff > lowOn * 1.3 || (lowOn <= lowOff * 1.3 && comb(env, t0 + period / 2) > comb(env, t0));
  if (off) t0 += period / 2;
  // then polished on the onsets nearest each beat
  const fit = fitGrid(onsets, weight, t0, period, duration);
  period = fit.period;
  t0 = fit.t0;
  let beats: number[] = [];
  const k0 = Math.ceil((-t0 - EARLY) / period - 1e-9);
  for (let k = k0; t0 + k * period < duration; k++)
    beats.push(Math.max(0, round3(t0 + k * period)));
  if (!fit.steady) beats = followBeats(onsets, weight, beats[0] ?? t0, period, duration);
  const hits = beats.filter((b) => {
    const d = nearestOffset(onsets, b);
    return d != null && Math.abs(d) <= 0.04;
  }).length;
  return {
    bpm: Math.round((60 / period) * 10) / 10,
    periodS: Math.round(period * 1e6) / 1e6,
    strength: round2(Math.min(1, top.v)),
    alternatives: peaks
      .filter((p) => p !== top && p.v >= peaks[0]!.v * 0.6)
      .slice(0, 3)
      .map((p) => ({ bpm: bpmOf(p.lag), strength: round2(Math.min(1, p.v)) })),
    beats,
    gridFit: beats.length ? round2(hits / beats.length) : 0,
    chance: chanceWithin(onsets, duration),
    steady: fit.steady,
  };
}

/** how far before 0 a fitted beat still counts as the beat at 0 (s) */
const EARLY = 0.03;

/** the period within 1% of `p0` and the phase whose grid lines the onsets'
 *  strength up best: each onset counts by its strength and how near a beat it
 *  falls (a Gaussian, 20 ms wide); periods are stepped so the grid's last
 *  beat moves 4 ms a step, phases 4 ms a step */
function combFit(
  onsets: readonly number[],
  w: readonly number[],
  p0: number,
  duration: number,
): { period: number; t0: number } {
  const beatsIn = Math.max(1, duration / p0);
  const dp = Math.max(1e-6, 0.004 / beatsIn);
  const span = Math.ceil((p0 * 0.01) / dp);
  const k = 1 / (2 * 0.02 ** 2);
  let best = { period: p0, t0: 0, v: -1 };
  for (let i = -span; i <= span; i++) {
    const p = p0 + i * dp;
    const phases = Math.max(1, Math.round(p / 0.004));
    const sums = new Float64Array(phases);
    // each onset adds to the phases near its own place in the beat
    for (let j = 0; j < onsets.length; j++) {
      const o = onsets[j]!;
      const at = ((o % p) + p) % p;
      const c = Math.round((at / p) * phases);
      for (let q = c - 3; q <= c + 3; q++) {
        const qi = ((q % phases) + phases) % phases;
        let d = Math.abs(at - qi * (p / phases));
        d = Math.min(d, p - d);
        sums[qi] = sums[qi]! + w[j]! * Math.exp(-d * d * k);
      }
    }
    for (let q = 0; q < phases; q++)
      if (sums[q]! > best.v) best = { period: p, t0: (q * p) / phases, v: sums[q]! };
  }
  return { period: best.period, t0: best.t0 };
}

/** a constant grid fitted to the onsets: each round pairs every beat with the
 *  onset nearest it, inside a window that narrows round by round, and solves
 *  period and phase by least squares weighted by each onset's strength. The
 *  same fit over each half says whether the tempo holds. */
function fitGrid(
  onsets: readonly number[],
  weight: (t: number) => number,
  t0: number,
  period: number,
  duration: number,
): { t0: number; period: number; steady: boolean } {
  const pairs = (a: number, p: number, win: number) => {
    const out: { k: number; t: number; w: number }[] = [];
    const k0 = Math.ceil(-a / p - 1e-9);
    for (let k = k0; a + k * p < duration; k++) {
      const d = nearestOffset(onsets, a + k * p);
      if (d != null && Math.abs(d) <= win) {
        const t = a + k * p + d;
        out.push({ k, t, w: Math.max(1e-6, weight(t)) });
      }
    }
    return out;
  };
  const solve = (ps: { k: number; t: number; w: number }[]) => {
    let sw = 0;
    let sk = 0;
    let st = 0;
    for (const q of ps) {
      sw += q.w;
      sk += q.w * q.k;
      st += q.w * q.t;
    }
    const mk = sk / sw;
    const mt = st / sw;
    let num = 0;
    let den = 0;
    for (const q of ps) {
      num += q.w * (q.k - mk) * (q.t - mt);
      den += q.w * (q.k - mk) ** 2;
    }
    if (!(den > 0)) return null;
    const p = num / den;
    return { t0: mt - p * mk, period: p };
  };
  let a = t0;
  let p = period;
  for (const win of [Math.min(0.07, p * 0.15), Math.min(0.05, p * 0.1), 0.035]) {
    const ps = pairs(a, p, win);
    if (ps.length < 8) break;
    const r = solve(ps);
    // a fit that moves the period by more than 2% found another pulse
    if (!r || Math.abs(r.period - period) / period > 0.02) break;
    a = r.t0;
    p = r.period;
  }
  // the phase as close to 0 as it goes, so the first beat is the first one
  // heard — one a hair before 0 is the beat at 0 (a sound that starts on its
  // beat has no onset there: nothing came before it to rise over)
  a -= Math.floor((a + EARLY) / p) * p;
  const ps = pairs(a, p, 0.035);
  let steady = true;
  if (ps.length >= 16) {
    const mid = ps[ps.length >> 1]!.k;
    const one = solve(ps.filter((q) => q.k < mid));
    const two = solve(ps.filter((q) => q.k >= mid));
    if (one && two && Math.abs(one.period - two.period) / p > 0.004) steady = false;
  }
  return { t0: a, period: p, steady };
}

/** beats that follow the onsets where the tempo moves: from each beat the next
 *  is a period on, pulled half way to an onset within 12% of a period, and the
 *  period itself eased a tenth of the way toward what the pull says */
function followBeats(
  onsets: readonly number[],
  weight: (t: number) => number,
  first: number,
  period: number,
  duration: number,
): number[] {
  const out: number[] = [];
  let t = first;
  let p = period;
  while (t < duration) {
    const d = nearestOffset(onsets, t);
    if (d != null && Math.abs(d) <= p * 0.12 && weight(t + d) > 0) {
      t += d * 0.5;
      p += d * 0.1;
    }
    if (t >= 0) out.push(round3(t));
    t += p;
  }
  return out;
}

/** the share of the sound within ±w of some onset: how often a time picked at
 *  random would already sit that close to a sound */
export function chanceWithin(onsets: readonly number[], duration: number, w = 0.04): number {
  if (!(duration > 0) || !onsets.length) return 0;
  let covered = 0;
  let end = -Infinity;
  for (const t of onsets) {
    const a = Math.max(0, t - w, end);
    const b = Math.min(duration, t + w);
    if (b > a) covered += b - a;
    end = Math.max(end, b);
  }
  return round2(covered / duration);
}

// --- sections -------------------------------------------------------------------------

export type Section = {
  start: number;
  end: number;
  /** how sharply the texture changes at its start (0 for the first) */
  change: number;
  /** level (dBFS RMS, mean over the section's sounding frames) */
  levelDb: number;
  onsetsPerS: number;
  /** spectral centre of mass (Hz) */
  centroidHz: number;
};

const BLOCK_S = 0.5;

/** where the texture changes: half-second blocks of band energy, compared
 *  with each other (cosine), and the boundaries where the blocks before stop
 *  resembling the blocks after (a checkerboard over the similarity matrix) */
export function findSections(s: Spectrum, onsets: readonly number[], duration: number): Section[] {
  const per = Math.max(1, Math.round(BLOCK_S / s.hopS));
  const blocks: Float64Array[] = [];
  for (let f = 0; f < s.bands.length; f += per) {
    const v = new Float64Array(BANDS);
    let k = 0;
    for (let g = f; g < Math.min(f + per, s.bands.length); g++, k++)
      for (let b = 0; b < BANDS; b++) v[b] = v[b]! + s.bands[g]![b]!;
    for (let b = 0; b < BANDS; b++) v[b] = v[b]! / Math.max(1, k);
    blocks.push(v);
  }
  const m = blocks.length;
  if (m < 4) return [describe(s, onsets, 0, duration, 0)];
  // centred on the film's mean texture, so similarity is about what differs
  const mean = new Float64Array(BANDS);
  for (const v of blocks) for (let b = 0; b < BANDS; b++) mean[b] = mean[b]! + v[b]! / m;
  const unit = blocks.map((v) => {
    const u = Float64Array.from(v, (x, b) => x - mean[b]!);
    const norm = Math.hypot(...u) || 1;
    return u.map((x) => x / norm);
  });
  const sim = (i: number, j: number) => {
    let d = 0;
    for (let b = 0; b < BANDS; b++) d += unit[i]![b]! * unit[j]![b]!;
    return d;
  };
  const L = Math.min(6, Math.floor(m / 2)); // 3 s each side
  const novelty = new Float64Array(m);
  for (let c = 1; c < m; c++) {
    let sum = 0;
    let w = 0;
    for (let i = -L; i < L; i++)
      for (let j = -L; j < L; j++) {
        const a = c + i;
        const b = c + j;
        if (a < 0 || b < 0 || a >= m || b >= m) continue;
        // a taper so the blocks next to the boundary count most
        const g = Math.exp(-(((i + 0.5) / L) ** 2 + ((j + 0.5) / L) ** 2) * 2);
        sum += (i < 0 === j < 0 ? 1 : -1) * g * sim(a, b);
        w += g;
      }
    novelty[c] = w ? Math.max(0, sum / w) : 0;
  }
  let nm = 0;
  for (const v of novelty) nm += v / m;
  let nsd = 0;
  for (const v of novelty) nsd += (v - nm) ** 2 / m;
  nsd = Math.sqrt(nsd);
  const minGap = Math.round(2 / BLOCK_S);
  const cand: { at: number; v: number }[] = [];
  for (let c = 1; c < m; c++) {
    const v = novelty[c]!;
    if (v < nm + nsd || v < 0.05) continue;
    let peak = true;
    for (let k = Math.max(1, c - minGap); k <= Math.min(m - 1, c + minGap); k++)
      if (novelty[k]! > v || (novelty[k] === v && k < c)) peak = false;
    if (peak) cand.push({ at: c, v });
  }
  const top = Math.max(...cand.map((c) => c.v), 1e-9);
  const bounds = cand
    .map((c) => ({ t: c.at * per * s.hopS, v: c.v / top }))
    .filter((b) => b.t >= 2 && b.t <= duration - 2);
  const out: Section[] = [];
  let start = 0;
  let change = 0;
  for (const b of bounds) {
    out.push(describe(s, onsets, start, b.t, change));
    start = b.t;
    change = b.v;
  }
  out.push(describe(s, onsets, start, duration, change));
  return out;
}

function describe(
  s: Spectrum,
  onsets: readonly number[],
  start: number,
  end: number,
  change: number,
): Section {
  const a = Math.max(0, Math.floor(start / s.hopS));
  const b = Math.min(s.bands.length, Math.ceil(end / s.hopS));
  let lv = 0;
  let lvN = 0;
  let wsum = 0;
  let csum = 0;
  for (let f = a; f < b; f++) {
    if (s.level[f]! > FLOOR_DB) {
      lv += 10 ** (s.level[f]! / 10);
      lvN++;
    }
    for (let k = 0; k < BANDS; k++) {
      const e = 10 ** (s.bands[f]![k]! / 10);
      const hz = Math.sqrt(
        LOW_HZ *
          (HIGH_HZ / LOW_HZ) ** (k / BANDS) *
          LOW_HZ *
          (HIGH_HZ / LOW_HZ) ** ((k + 1) / BANDS),
      );
      wsum += e;
      csum += e * hz;
    }
  }
  const len = Math.max(1e-6, end - start);
  return {
    start: round2(start),
    end: round2(end),
    change: round2(change),
    levelDb: lvN ? round1(10 * Math.log10(lv / lvN)) : -120,
    onsetsPerS: round1(onsets.filter((t) => t >= start && t < end).length / len),
    centroidHz: lvN && wsum > 0 ? Math.round(csum / wsum) : 0,
  };
}

/** signed seconds from t to the nearest onset (an onset before t is negative);
 *  null without onsets. `onsets` is sorted. */
export function nearestOffset(onsets: readonly number[], t: number): number | null {
  if (!onsets.length) return null;
  let lo = 0;
  let hi = onsets.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (onsets[mid]! < t) lo = mid + 1;
    else hi = mid;
  }
  let best = onsets[lo]! - t;
  if (lo > 0 && Math.abs(onsets[lo - 1]! - t) <= Math.abs(best)) best = onsets[lo - 1]! - t;
  return round3(best);
}

/** any sound ffmpeg reads (the sound of a video too), as mono float samples at LISTEN_RATE */
export function decodeMono(ffmpeg: string, file: string): Promise<Float32Array> {
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

// --- pitch classes and key ------------------------------------------------------------

const CHROMA_N = 8192; // 0.37 s: 2.7 Hz a bin, finer than a semitone from 50 Hz up
const CHROMA_HOP = 2048; // 93 ms

export type Chroma = {
  hopS: number;
  /** frame i is centred at (i·hop + n/2) / rate */
  frameTime: (i: number) => number;
  /** per frame, the energy of each of the 12 pitch classes (C = 0), summing to 1 */
  frames: Float32Array[];
};

/** how much of each pitch class sounds in each frame: the spectrum from 55 Hz
 *  to 2 kHz, each bin's magnitude (log-compressed) given to its nearest note */
export function chromagram(pcm: Float32Array, rate = LISTEN_RATE): Chroma {
  const n = pcm.length < CHROMA_N ? 0 : Math.floor((pcm.length - CHROMA_N) / CHROMA_HOP) + 1;
  const fft = makeFft(CHROMA_N);
  const hann = new Float64Array(CHROMA_N);
  for (let i = 0; i < CHROMA_N; i++) hann[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / CHROMA_N);
  const k0 = Math.ceil((55 * CHROMA_N) / rate);
  const k1 = Math.floor((2000 * CHROMA_N) / rate);
  const pc = new Int8Array(k1 + 1);
  for (let k = k0; k <= k1; k++) {
    const midi = 69 + 12 * Math.log2((k * rate) / CHROMA_N / 440);
    pc[k] = ((Math.round(midi) % 12) + 12) % 12;
  }
  const re = new Float64Array(CHROMA_N);
  const im = new Float64Array(CHROMA_N);
  const frames: Float32Array[] = [];
  for (let f = 0; f < n; f++) {
    for (let i = 0; i < CHROMA_N; i++) {
      re[i] = pcm[f * CHROMA_HOP + i]! * hann[i]!;
      im[i] = 0;
    }
    fft(re, im);
    const row = new Float32Array(12);
    let sum = 0;
    for (let k = k0; k <= k1; k++) {
      const v = Math.log1p(100 * (Math.hypot(re[k]!, im[k]!) / CHROMA_N));
      row[pc[k]!] = row[pc[k]!]! + v;
      sum += v;
    }
    if (sum > 0) for (let c = 0; c < 12; c++) row[c] = row[c]! / sum;
    frames.push(row);
  }
  return {
    hopS: CHROMA_HOP / rate,
    frameTime: (i) => (i * CHROMA_HOP + CHROMA_N / 2) / rate,
    frames,
  };
}

const NOTE = ["C", "C#", "D", "Eb", "E", "F", "F#", "G", "Ab", "A", "Bb", "B"];
// Krumhansl and Kessler's probe-tone ratings: how well each pitch class fits a key
const MAJOR = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const MINOR = [6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];

export type Key = {
  /** e.g. "A minor" */
  name: string;
  tonic: number;
  mode: "major" | "minor";
  /** the correlation of the sound's pitch classes with the key's profile (−1..1) */
  correlation: number;
  /** the next best key and its correlation; a relative major/minor is often close */
  runnerUp: { name: string; correlation: number };
};

/** the key whose profile the whole sound's pitch classes correlate with best;
 *  null when nothing pitched sounds */
export function estimateKey(ch: Chroma): Key | null {
  const total = new Float64Array(12);
  for (const row of ch.frames) for (let c = 0; c < 12; c++) total[c] = total[c]! + row[c]!;
  if (!(total.reduce((a, b) => a + b, 0) > 0)) return null;
  const corr = (a: ArrayLike<number>, b: ArrayLike<number>) => {
    let ma = 0;
    let mb = 0;
    for (let i = 0; i < 12; i++) {
      ma += a[i]! / 12;
      mb += b[i]! / 12;
    }
    let num = 0;
    let da = 0;
    let db = 0;
    for (let i = 0; i < 12; i++) {
      num += (a[i]! - ma) * (b[i]! - mb);
      da += (a[i]! - ma) ** 2;
      db += (b[i]! - mb) ** 2;
    }
    return da > 0 && db > 0 ? num / Math.sqrt(da * db) : 0;
  };
  const all: { tonic: number; mode: "major" | "minor"; r: number }[] = [];
  for (let tonic = 0; tonic < 12; tonic++)
    for (const [mode, prof] of [
      ["major", MAJOR],
      ["minor", MINOR],
    ] as const) {
      const rot = Array.from({ length: 12 }, (_, i) => prof[(i - tonic + 12) % 12]!);
      all.push({ tonic, mode, r: corr(total, rot) });
    }
  all.sort((a, b) => b.r - a.r);
  const [a, b] = [all[0]!, all[1]!];
  const name = (k: { tonic: number; mode: string }) => `${NOTE[k.tonic]} ${k.mode}`;
  return {
    name: name(a),
    tonic: a.tonic,
    mode: a.mode,
    correlation: round2(a.r),
    runnerUp: { name: name(b), correlation: round2(b.r) },
  };
}

// --- bars, drops ----------------------------------------------------------------------

export type Meter = {
  beatsPerBar: number;
  /** index into the beats of the first downbeat (0..beatsPerBar−1) */
  first: number;
  /** the share of bars whose own strongest beat is the chosen downbeat */
  agreement: number;
  /** what agreement would be by chance: 1 / beatsPerBar */
  chance: number;
  /** how alike each beat is to the beat 2, 3 and 4 later (mean cosine) */
  likeness: { 2: number; 3: number; 4: number };
};

/** which beat starts each bar, and how many beats a bar holds. A bar starts
 *  where things change — the chord (pitch classes before against after), the
 *  texture (band energies), the low end landing (a kick) — so each beat is
 *  scored by those three, and the beat in the bar that scores highest most
 *  often is the downbeat. Three beats a bar only when bars of three agree on
 *  their downbeat clearly more often, over chance, than bars of four do. */
export function estimateMeter(s: Spectrum, ch: Chroma, beats: readonly number[]): Meter | null {
  const nb = beats.length - 1;
  if (nb < 16) return null;
  const low = bandOnsetStrength(s, 30, 160);
  // per beat: the mean band energies and pitch classes over [beat, next beat)
  const tex: Float64Array[] = [];
  const pcs: Float64Array[] = [];
  for (let k = 0; k < nb; k++) {
    const [a, b] = [beats[k]!, beats[k + 1]!];
    const v = new Float64Array(BANDS);
    const f0 = Math.max(0, frameAt(s, a));
    const f1 = Math.min(s.bands.length, Math.max(f0 + 1, frameAt(s, b)));
    for (let f = f0; f < f1; f++) for (let j = 0; j < BANDS; j++) v[j] = v[j]! + s.bands[f]![j]!;
    for (let j = 0; j < BANDS; j++) v[j] = v[j]! / Math.max(1, f1 - f0);
    tex.push(v);
    const c = new Float64Array(12);
    const g0 = Math.max(0, Math.round((a - ch.frameTime(0)) / ch.hopS));
    const g1 = Math.min(
      ch.frames.length,
      Math.max(g0 + 1, Math.round((b - ch.frameTime(0)) / ch.hopS)),
    );
    for (let g = g0; g < g1; g++) for (let j = 0; j < 12; j++) c[j] = c[j]! + ch.frames[g]![j]!;
    pcs.push(c);
  }
  const centred = (xs: Float64Array[]) => {
    const dim = xs[0]?.length ?? 0;
    const mean = new Float64Array(dim);
    for (const x of xs) for (let j = 0; j < dim; j++) mean[j] = mean[j]! + x[j]! / xs.length;
    return xs.map((x) => {
      const u = Float64Array.from(x, (v, j) => v - mean[j]!);
      const norm = Math.hypot(...u) || 1;
      return u.map((v) => v / norm);
    });
  };
  const ut = centred(tex);
  const uc = centred(pcs);
  const cos = (a: Float64Array, b: Float64Array) => {
    let d = 0;
    for (let j = 0; j < a.length; j++) d += a[j]! * b[j]!;
    return d;
  };
  const likeAt = (lag: number) => {
    let sum = 0;
    let m = 0;
    for (let k = 0; k + lag < nb; k++) {
      sum += (cos(ut[k]!, ut[k + lag]!) + cos(uc[k]!, uc[k + lag]!)) / 2;
      m++;
    }
    return m ? sum / m : 0;
  };
  const likeness = { 2: round2(likeAt(2)), 3: round2(likeAt(3)), 4: round2(likeAt(4)) };
  // change at beat k: the two beats before against the two from it on
  const change = (u: Float64Array[], k: number) => {
    if (k < 2 || k + 2 > nb) return 0;
    const dim = u[0]!.length;
    const p = new Float64Array(dim);
    const q = new Float64Array(dim);
    for (let j = 0; j < dim; j++) {
      p[j] = u[k - 2]![j]! + u[k - 1]![j]!;
      q[j] = u[k]![j]! + u[k + 1]![j]!;
    }
    const np = Math.hypot(...p) || 1;
    const nq = Math.hypot(...q) || 1;
    return 1 - cos(p, q) / (np * nq);
  };
  const z = (xs: number[]) => {
    const m = xs.reduce((a, b) => a + b, 0) / xs.length;
    const sd = Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / xs.length) || 1;
    return xs.map((x) => (x - m) / sd);
  };
  const ks = Array.from({ length: nb }, (_, k) => k);
  const zc = z(ks.map((k) => change(uc, k)));
  const zt = z(ks.map((k) => change(ut, k)));
  const zl = z(ks.map((k) => peakNear(s, low, beats[k]!, 3)));
  const score = ks.map((k) => zc[k]! + zt[k]! + zl[k]!);
  const barsOf = (B: number) => {
    // per bar of B beats (counted from beat 0), which position scores highest
    const wins = new Array<number>(B).fill(0);
    let bars = 0;
    for (let k = 0; k + B <= nb; k += B) {
      let best = 0;
      for (let j = 1; j < B; j++) if (score[k + j]! > score[k + best]!) best = j;
      wins[best]!++;
      bars++;
    }
    const mean = Array.from({ length: B }, (_, j) => {
      let sum = 0;
      let m = 0;
      for (let k = j; k < nb; k += B) {
        sum += score[k]!;
        m++;
      }
      return m ? sum / m : -Infinity;
    });
    const first = mean.indexOf(Math.max(...mean));
    const agreement = bars ? wins[first]! / bars : 0;
    return { B, first, agreement, over: (agreement - 1 / B) / (1 - 1 / B) };
  };
  const [three, four] = [barsOf(3), barsOf(4)];
  const m = three.over > four.over + 0.2 ? three : four;
  return {
    beatsPerBar: m.B,
    first: m.first,
    agreement: round2(m.agreement),
    chance: round2(1 / m.B),
    likeness,
  };
}

/** where the music lands: a bar line (or, without bars, a second) after
 *  which a layer is there that was not — the low end (under 160 Hz) 4 dB or
 *  more up, or the mids or highs 6 dB or more, over the next two bars against
 *  the four before — or any rise at all right after a riser (a bar whose
 *  highs start where the four bars before started, or carry on a riser from
 *  the bar before, climb 3 dB or more from its first quarter to its last, and
 *  end 6 dB or more over where those bars ended). The riser bar itself is not a
 *  landing; neither is music starting after silence, nor a rise into the
 *  quietest quarter of the sound. Within four bars of each other the
 *  larger landing is kept. */
export function findDrops(s: Spectrum, marks: readonly number[], duration: number): number[] {
  const band = (hz: number) =>
    Math.round((BANDS * Math.log(hz / LOW_HZ)) / Math.log(HIGH_HZ / LOW_HZ));
  const [b160, b2k] = [band(160), band(2000)];
  const edges = [...marks.filter((t) => t >= 0 && t < duration), duration];
  const db = (x: number, m: number) => 10 * Math.log10(x / Math.max(1, m) + 1e-12);
  const seg: {
    level: number;
    low: number;
    mid: number;
    hi: number;
    hiFirst: number;
    hiLast: number;
    climb: number;
  }[] = [];
  for (let i = 0; i + 1 < edges.length; i++) {
    const f0 = Math.max(0, frameAt(s, edges[i]!));
    const f1 = Math.min(s.bands.length, Math.max(f0 + 1, frameAt(s, edges[i + 1]!)));
    const q = Math.max(1, Math.floor((f1 - f0) / 4));
    let [lv, lo, mid, hi, hiFirst, hiLast] = [0, 0, 0, 0, 0, 0];
    for (let f = f0; f < f1; f++) {
      lv += 10 ** (s.level[f]! / 10);
      let h = 0;
      for (let k = 0; k < BANDS; k++) {
        const e = 10 ** (s.bands[f]![k]! / 10);
        if (k < b160) lo += e;
        else if (k < b2k) mid += e;
        else h += e;
      }
      hi += h;
      if (f < f0 + q) hiFirst += h;
      if (f >= f1 - q) hiLast += h;
    }
    const m = f1 - f0;
    seg.push({
      level: db(lv, m),
      low: db(lo, m),
      mid: db(mid, m),
      hi: db(hi, m),
      hiFirst: db(hiFirst, q),
      hiLast: db(hiLast, q),
      climb: db(hiLast, q) - db(hiFirst, q),
    });
  }
  if (seg.length < 6) return [];
  const sorted = seg.map((x) => x.level).sort((a, b) => a - b);
  const quiet = sorted[Math.floor(sorted.length * 0.25)]!;
  const pmean = (xs: number[]) =>
    10 * Math.log10(xs.reduce((a, v) => a + 10 ** (v / 10), 0) / xs.length);
  const rise = (i: number, k: "level" | "low" | "mid" | "hi") =>
    pmean(seg.slice(i, i + 2).map((x) => x[k])) - pmean(seg.slice(i - 4, i).map((x) => x[k]));
  // a riser starts from where the highs were at that point of the bar (or
  // carries one on from the bar before), climbs through the bar, and ends
  // well over where they were at bars' ends
  const risers: boolean[] = [];
  seg.forEach((x, i) => {
    const prior = seg.slice(Math.max(0, i - 4), i);
    risers.push(
      i >= 4 &&
        x.climb >= 3 &&
        x.hiLast - pmean(prior.map((y) => y.hiLast)) >= 6 &&
        (x.hiFirst - pmean(prior.map((y) => y.hiFirst)) < 3 || !!risers[i - 1]),
    );
  });
  const riser = (i: number) => !!risers[i];
  const cand: { i: number; v: number }[] = [];
  for (let i = 4; i + 2 <= seg.length; i++) {
    if (riser(i)) continue;
    const before = pmean(seg.slice(i - 4, i).map((x) => x.level));
    const after = pmean(seg.slice(i, i + 2).map((x) => x.level));
    if (before < FLOOR_DB + 10 || after < quiet) continue;
    const low = rise(i, "low");
    const entry = Math.max(rise(i, "mid"), rise(i, "hi"));
    if (riser(i - 1) && (low >= 1 || entry >= 1)) cand.push({ i, v: 6 + low + entry / 2 });
    else if (low >= 4 || entry >= 6) cand.push({ i, v: low + entry / 2 });
  }
  const kept: { i: number; v: number }[] = [];
  for (const c of cand.sort((a, b) => b.v - a.v))
    if (kept.every((k) => Math.abs(k.i - c.i) >= 4)) kept.push(c);
  return kept.map((k) => round3(edges[k.i]!)).sort((a, b) => a - b);
}

/** where the low end (under 160 Hz) lands in a bar, sixteen steps from its
 *  downbeat, averaged over the bars: "x" where it rises in at least half as
 *  many bars as its busiest step, "-" elsewhere; null without bars or a low end */
export function lowPattern(s: Spectrum, downbeats: readonly number[], steps = 16): string | null {
  if (downbeats.length < 3) return null;
  const low = bandOnsetStrength(s, 30, 160);
  const sum = new Float64Array(steps);
  for (let i = 0; i + 1 < downbeats.length; i++) {
    const [a, b] = [downbeats[i]!, downbeats[i + 1]!];
    const row = Array.from({ length: steps }, (_, j) =>
      peakNear(s, low, a + ((b - a) * j) / steps, 2),
    );
    const top = Math.max(...row);
    if (top < 1) continue; // no low end in this bar
    row.forEach((v, j) => {
      sum[j] = sum[j]! + (v >= top * 0.5 ? 1 : 0);
    });
  }
  const max = Math.max(...sum);
  if (!(max > 0)) return null;
  return Array.from(sum, (v) => (v >= max * 0.5 ? "x" : "-")).join("");
}

// --- the beats file ---------------------------------------------------------------------

export type BeatsHow = "measured" | "estimated" | "not detected";

/** `<name>.beats.json`; times in seconds of the sound */
export type FilmBeats = {
  version: 1;
  source: string;
  duration: number;
  tempo: {
    bpm: number | null;
    /** how far the grid sits on onsets above what chance gives: (gridFit −
     *  chance) / (1 − chance), 0..1 */
    confidence: number;
    label: BeatsHow;
    periodS?: number;
    /** the onset strength's autocorrelation at the period over zero lag */
    strength?: number;
    /** the share of beats with an onset within 40 ms */
    gridFit?: number;
    /** that share for a grid laid anywhere */
    chance?: number;
    steady?: boolean;
    alternatives?: { bpm: number; strength: number }[];
  };
  beats: number[];
  downbeats: number[];
  bars: { t: number; index: number }[];
  /** how the downbeats were chosen */
  meter: {
    beatsPerBar: number | null;
    /** (agreement − chance) / (1 − chance), 0..1 */
    confidence: number;
    agreement: number;
    chance: number;
    label: BeatsHow;
  };
  sections: {
    t: number;
    end: number;
    /** the section's level against the quietest (0) and loudest (1) section */
    energy: number;
    /** "drop" when a drop opens it */
    label?: string;
    levelDb: number;
    onsetsPerS: number;
    centroidHz: number;
  }[];
  drops: number[];
  onsets: number[];
  labels: Record<
    "duration" | "tempo" | "beats" | "downbeats" | "bars" | "sections" | "drops" | "onsets",
    BeatsHow
  >;
};

/** the whole analysis on mono samples at LISTEN_RATE */
export function analyzeBeats(pcm: Float32Array, source: string): FilmBeats {
  const duration = pcm.length / LISTEN_RATE;
  const s = spectrum(pcm);
  const env = onsetStrength(s);
  const onsets = pickOnsets(s, env, pcm).map(round3);
  const tempo = estimateTempo(s, env, onsets, duration);
  const ch = chromagram(pcm);
  const meter = tempo ? estimateMeter(s, ch, tempo.beats) : null;
  const beats = tempo?.beats ?? [];
  const downbeats = meter ? beats.filter((_, k) => k % meter.beatsPerBar === meter.first) : [];
  const drops = findDrops(
    s,
    downbeats.length >= 4 ? downbeats : Array.from({ length: Math.ceil(duration) }, (_, i) => i),
    duration,
  );
  // a section boundary sits on the bar line nearest it, when one is within half a bar
  const barLen = meter && tempo ? meter.beatsPerBar * tempo.periodS : 0;
  const snap = (t: number) => {
    if (!downbeats.length) return t;
    const d = nearestOffset(downbeats, t);
    return d != null && Math.abs(d) <= barLen / 2 ? round3(t + d) : t;
  };
  const raw = findSections(s, onsets, duration);
  const bounds = [0, ...raw.slice(1).map((x) => snap(x.start)), duration].filter(
    (t, i, a) => i === 0 || t > a[i - 1]! + 1e-6,
  );
  const sections = bounds.slice(0, -1).map((t, i) => describe(s, onsets, t, bounds[i + 1]!, 0));
  const levels = sections.map((x) => x.levelDb).filter((v) => v > -120);
  const [lo, hi] = [Math.min(...levels), Math.max(...levels)];
  const beatLen = tempo?.periodS ?? 0.5;
  const confidence = (fit: number, chance: number) =>
    chance < 1 ? round2(Math.max(0, (fit - chance) / (1 - chance))) : 0;
  return {
    version: 1,
    source,
    duration: round3(duration),
    tempo: tempo
      ? {
          bpm: tempo.bpm,
          confidence: confidence(tempo.gridFit, tempo.chance),
          label: "estimated",
          periodS: tempo.periodS,
          strength: tempo.strength,
          gridFit: tempo.gridFit,
          chance: tempo.chance,
          steady: tempo.steady,
          alternatives: tempo.alternatives,
        }
      : { bpm: null, confidence: 0, label: "not detected" },
    beats,
    downbeats,
    bars: downbeats.map((t, index) => ({ t, index })),
    meter: meter
      ? {
          beatsPerBar: meter.beatsPerBar,
          confidence: confidence(meter.agreement, meter.chance),
          agreement: meter.agreement,
          chance: meter.chance,
          label: "estimated",
        }
      : { beatsPerBar: null, confidence: 0, agreement: 0, chance: 0, label: "not detected" },
    sections: sections.map((x) => {
      const out: FilmBeats["sections"][number] = {
        t: x.start,
        end: x.end,
        energy: x.levelDb <= -120 ? 0 : hi > lo ? round2((x.levelDb - lo) / (hi - lo)) : 1,
        levelDb: x.levelDb,
        onsetsPerS: x.onsetsPerS,
        centroidHz: x.centroidHz,
      };
      if (drops.some((d) => Math.abs(d - x.start) <= beatLen)) out.label = "drop";
      return out;
    }),
    drops,
    onsets,
    labels: {
      duration: "measured",
      tempo: tempo ? "estimated" : "not detected",
      beats: beats.length ? "estimated" : "not detected",
      downbeats: downbeats.length ? "estimated" : "not detected",
      bars: downbeats.length ? "estimated" : "not detected",
      sections: "estimated",
      drops: drops.length ? "estimated" : "not detected",
      onsets: onsets.length ? "measured" : "not detected",
    },
  };
}

export type FilmBeatsOptions = {
  /** any sound, or a film whose sound to read */
  input: string;
  /** default: `<input without extension>.beats.json` */
  out?: string;
};

export async function filmBeats(
  opts: FilmBeatsOptions,
): Promise<{ out: string; beats: FilmBeats }> {
  const input = resolve(opts.input);
  if (!existsSync(input)) throw new Error(`film beats: no file at ${input}`);
  const out = resolve(opts.out ?? `${input.replace(/\.[^./]+$/, "")}.beats.json`);
  const pcm = await decodeMono(await resolveFfmpeg(), input);
  if (!pcm.length) throw new Error(`film beats: ${input} has no sound`);
  const beats = analyzeBeats(pcm, input);
  await writeFile(out, `${JSON.stringify(beats)}\n`);
  return { out, beats };
}

export function formatFilmBeats(b: FilmBeats): string {
  const L: string[] = [];
  const tag = (h: BeatsHow) => `(${h})`;
  const fmtS = (t: number) => `${t.toFixed(2)}s`;
  const list = (xs: number[], max = 24) =>
    xs.length > max
      ? `${xs.slice(0, max).map(fmtS).join(", ")} … (${xs.length - max} more)`
      : xs.map(fmtS).join(", ");
  L.push(
    `# film beats — ${basename(b.source)}`,
    "",
    `duration ${fmtS(b.duration)} ${tag("measured")}`,
  );
  const t = b.tempo;
  if (t.bpm == null) L.push(`- tempo: no repeating period between 60 and 200 BPM ${tag(t.label)}`);
  else {
    L.push(
      `- tempo ≈ ${t.bpm} BPM (a beat ${t.periodS}s)${t.steady === false ? ", not steady: the beats follow the onsets" : ""}; ${Math.round((t.gridFit ?? 0) * 100)}% of beats have an onset within 40 ms, ${Math.round((t.chance ?? 0) * 100)}% would by chance — confidence ${t.confidence} ${tag(t.label)}`,
    );
    if (t.alternatives?.length)
      L.push(
        `- also repeating at: ${t.alternatives.map((a) => `${a.bpm} BPM (${a.strength})`).join(", ")} ${tag("estimated")}`,
      );
    L.push(`- beats: ${b.beats.length}, first at ${fmtS(b.beats[0] ?? 0)} ${tag(b.labels.beats)}`);
  }
  const m = b.meter;
  if (m.beatsPerBar == null) L.push(`- bars: no beat grid to count them on ${tag(m.label)}`);
  else
    L.push(
      `- bars of ${m.beatsPerBar} beats: ${b.bars.length}, first downbeat at ${fmtS(b.downbeats[0] ?? 0)}; in ${Math.round(m.agreement * 100)}% of bars that beat scored highest (chord, texture and low end changing), ${Math.round(m.chance * 100)}% by chance — confidence ${m.confidence} ${tag(m.label)}`,
    );
  L.push(
    b.drops.length
      ? `- drops: ${list(b.drops)} ${tag(b.labels.drops)}`
      : `- drops: none ${tag(b.labels.drops)}`,
  );
  L.push(`- sections ${tag(b.labels.sections)}:`);
  for (const [i, x] of b.sections.entries())
    L.push(
      `  ${i + 1}. ${fmtS(x.t)}–${fmtS(x.end)}: energy ${x.energy} (level ${x.levelDb} dBFS), ${x.onsetsPerS} onsets/s${x.label ? `, ${x.label}` : ""}`,
    );
  L.push(`- onsets: ${b.onsets.length} ${tag(b.labels.onsets)}`);
  return L.join("\n");
}

// --- small arithmetic -----------------------------------------------------------------

export function median(xs: readonly number[]): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}
const round1 = (v: number) => Math.round(v * 10) / 10;
const round2 = (v: number) => Math.round(v * 100) / 100;
const round3 = (v: number) => Math.round(v * 1000) / 1000;
