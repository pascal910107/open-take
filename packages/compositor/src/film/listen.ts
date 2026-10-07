// `open-take film listen`: a film's sound as information the author can read —
// a picture on the film's time (spectrum, loudness, onsets and beat grid,
// texture sections, each stem's activity, the page's events and cuts and
// curves), marked with the same times as `film sheet`, and a text report
// where every line says whether it was measured, is an estimate, or was not
// found. Nothing is graded: no target, no pass line, no "should".
//
// ffmpeg reads what it measures to a standard (ebur128 loudness, true peak,
// silencedetect, the spectrum picture); the rest is plain arithmetic on the
// decoded sound here: a short-time spectrum, onsets from where its bands rise,
// a tempo from how the onset strength repeats, sections from where the
// texture stops resembling what came before, bars that repeat verbatim.

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, extname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { resolveFfmpeg, resolveFfprobe, runTool } from "../ffmpeg";
import { launchHtmlBrowser } from "../html/cdp";

// --- the page's events (the file `film render` writes beside the film) ------------

export type FilmEvent = {
  /** seconds on the film's time */
  t: number;
  /** "click", "key", "land", "cut", "mark", … — whatever the page names */
  kind: string;
  /** stage px */
  x?: number;
  y?: number;
  /** 0..1 */
  force?: number;
  label?: string;
};

export type FilmEvents = {
  version: 1;
  duration: number;
  fps: number;
  /** sorted by t */
  events: FilmEvent[];
  /** hard-cut times the clock detected or the page declared */
  cuts: number[];
  /** rows[i][j] = curve names[j] at time t0 + i·dt */
  curves: { names: string[]; t0: number; dt: number; rows: number[][] };
};

const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** `<film>.events.json` read leniently: what is malformed is left out, never fatal */
export function parseFilmEvents(raw: unknown): FilmEvents {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const events = (Array.isArray(r.events) ? r.events : [])
    .filter((e): e is Record<string, unknown> => !!e && typeof e === "object" && finite(e.t))
    .map((e) => {
      const ev: FilmEvent = {
        t: e.t as number,
        kind: typeof e.kind === "string" ? e.kind : "event",
      };
      if (finite(e.x)) ev.x = e.x;
      if (finite(e.y)) ev.y = e.y;
      if (finite(e.force)) ev.force = e.force;
      if (typeof e.label === "string") ev.label = e.label;
      return ev;
    })
    .sort((a, b) => a.t - b.t);
  const cuts = (Array.isArray(r.cuts) ? r.cuts : []).filter(finite).sort((a, b) => a - b);
  const c = (r.curves && typeof r.curves === "object" ? r.curves : {}) as Record<string, unknown>;
  const names = (Array.isArray(c.names) ? c.names : []).map(String);
  const rows = (Array.isArray(c.rows) ? c.rows : [])
    .filter((row): row is unknown[] => Array.isArray(row))
    .map((row) => names.map((_, j) => (finite(row[j]) ? (row[j] as number) : Number.NaN)));
  const fps = finite(r.fps) && r.fps > 0 ? r.fps : 60;
  return {
    version: 1,
    duration: finite(r.duration) ? r.duration : 0,
    fps,
    events,
    cuts,
    curves: {
      names,
      t0: finite(c.t0) ? c.t0 : 0,
      dt: finite(c.dt) && c.dt > 0 ? c.dt : 1 / fps,
      rows,
    },
  };
}

// --- the spectrum, onsets, tempo ----------------------------------------------------

/** the rate the sound is analysed at: everything a film's rhythm and texture
 *  needs sits below its 11 kHz */
export const LISTEN_RATE = 22_050;
const WIN = 1024; // 46 ms
const HOP = 256; // 11.6 ms
const BANDS = 48;
const LOW_HZ = 40;
const HIGH_HZ = 10_000;
/** below this a frame is silence, not a quiet texture */
const FLOOR_DB = -70;

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
  const env = new Float32Array(s.bands.length);
  for (let f = 1; f < s.bands.length; f++) {
    const cur = s.bands[f]!;
    const a = s.bands[f - 1]!;
    const b = s.bands[Math.max(0, f - 2)]!;
    let rise = 0;
    for (let k = 0; k < BANDS; k++) {
      const floor = Math.max(a[k]!, b[k]!, FLOOR_DB);
      if (cur[k]! > floor) rise += cur[k]! - floor;
    }
    env[f] = rise / BANDS;
  }
  return env;
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
  /** how strongly the onset strength repeats at this period: its
   *  autocorrelation there over at zero lag (0..1) */
  strength: number;
  /** the other periods that repeat almost as strongly (half, double…) */
  alternatives: { bpm: number; strength: number }[];
  /** the beat grid laid at this tempo, at the phase most onsets fall on */
  beats: number[];
  /** the share of beats with an onset within 40 ms */
  gridFit: number;
};

/** the period (60–200 BPM) at which the onset strength repeats most; null
 *  when nothing repeats */
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
  // a pulse repeats at every multiple of its period too, so a slower period
  // only counts as the beat when it repeats clearly more strongly: among the
  // periods within 10% of the strongest that it is a whole multiple of, the
  // shortest is the beat
  const top = peaks
    .filter((p) => {
      const r = peaks[0]!.lag / p.lag;
      return p.v >= peaks[0]!.v * 0.9 && Math.abs(r - Math.round(r)) < 0.04;
    })
    .reduce((a, b) => (b.lag < a.lag ? b : a));
  const bpmOf = (lag: number) => Math.round((60 / (lag * s.hopS)) * 10) / 10;
  const period = top.lag * s.hopS;
  // the phase where the grid collects the most onset strength
  let bestPhase = 0;
  let bestSum = -1;
  const steps = Math.max(1, Math.round(top.lag));
  for (let p = 0; p < steps; p++) {
    let sum = 0;
    for (let f = p; f < n; f += top.lag) sum += env[Math.round(f)] ?? 0;
    if (sum > bestSum) {
      bestSum = sum;
      bestPhase = p;
    }
  }
  const beats: number[] = [];
  for (let t = s.frameTime(bestPhase); t < duration; t += period) beats.push(round3(t));
  // the grid's phase onto the onsets near it (the frame's time is coarse)
  const offs = beats
    .map((b) => nearestOffset(onsets, b))
    .filter((d): d is number => d != null && Math.abs(d) <= 0.06);
  if (offs.length) {
    const shift = median(offs);
    for (let i = 0; i < beats.length; i++) beats[i] = round3(beats[i]! + shift);
    while (beats.length && beats[0]! < 0) beats.shift();
  }
  const fit = beats.filter((b) => {
    const d = nearestOffset(onsets, b);
    return d != null && Math.abs(d) <= 0.04;
  }).length;
  return {
    bpm: bpmOf(top.lag),
    strength: round2(Math.min(1, top.v)),
    alternatives: peaks
      .filter((p) => p !== top && p.v >= peaks[0]!.v * 0.6)
      .slice(0, 3)
      .map((p) => ({ bpm: bpmOf(p.lag), strength: round2(Math.min(1, p.v)) })),
    beats,
    gridFit: beats.length ? round2(fit / beats.length) : 0,
  };
}

// --- sections and repeats -------------------------------------------------------------

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

export type BarRepeats = {
  beatsPerBar: number;
  bars: number;
  /** bars (1-based) that sound like an earlier bar, each with the first bar it repeats */
  repeats: { bar: number; of: number }[];
  /** the longest stretch of consecutive bars repeating a stretch before it */
  longestRun: { from: number; to: number; of: number } | null;
};

/** bars (4 beats on the estimated grid) that repeat an earlier bar verbatim:
 *  the same band energies, step by step, within 1.5 dB on average and shaped
 *  alike (correlation ≥ 0.95). Silent bars are left out. */
export function repeatedBars(s: Spectrum, beats: readonly number[], beatsPerBar = 4): BarRepeats {
  const STEPS = 16;
  const COARSE = BANDS / 2;
  const bars: (Float64Array | null)[] = [];
  for (let i = 0; i + beatsPerBar < beats.length; i += beatsPerBar) {
    const a = beats[i]!;
    const b = beats[i + beatsPerBar]!;
    const v = new Float64Array(STEPS * COARSE);
    let loud = false;
    for (let st = 0; st < STEPS; st++) {
      const f0 = Math.floor((a + ((b - a) * st) / STEPS) / s.hopS);
      const f1 = Math.max(f0 + 1, Math.floor((a + ((b - a) * (st + 1)) / STEPS) / s.hopS));
      for (let f = f0; f < Math.min(f1, s.bands.length); f++) {
        if (s.level[f]! > FLOOR_DB + 10) loud = true;
        for (let k = 0; k < COARSE; k++)
          v[st * COARSE + k] =
            v[st * COARSE + k]! +
            (Math.max(s.bands[f]![2 * k]!, s.bands[f]![2 * k + 1]!) - FLOOR_DB) / (f1 - f0);
      }
    }
    bars.push(loud ? v : null);
  }
  const same = (p: Float64Array, q: Float64Array) => {
    let diff = 0;
    let mp = 0;
    let mq = 0;
    for (let i = 0; i < p.length; i++) {
      diff += Math.abs(p[i]! - q[i]!);
      mp += p[i]!;
      mq += q[i]!;
    }
    if (diff / p.length > 1.5) return false;
    mp /= p.length;
    mq /= q.length;
    let num = 0;
    let dp = 0;
    let dq = 0;
    for (let i = 0; i < p.length; i++) {
      num += (p[i]! - mp) * (q[i]! - mq);
      dp += (p[i]! - mp) ** 2;
      dq += (q[i]! - mq) ** 2;
    }
    return dp > 0 && dq > 0 && num / Math.sqrt(dp * dq) >= 0.95;
  };
  const repeats: { bar: number; of: number }[] = [];
  const of: (number | null)[] = bars.map(() => null);
  for (let i = 1; i < bars.length; i++) {
    const p = bars[i];
    if (!p) continue;
    for (let j = 0; j < i; j++) {
      const q = bars[j];
      if (q && same(p, q)) {
        of[i] = j;
        repeats.push({ bar: i + 1, of: (of[j] ?? j) + 1 });
        break;
      }
    }
  }
  // the longest run of bars i..i+k each repeating bar j..j+k
  let longestRun: BarRepeats["longestRun"] = null;
  for (let i = 1; i < bars.length; i++)
    for (let j = 0; j < i; j++) {
      let k = 0;
      while (
        i + k < bars.length &&
        j + k < i &&
        bars[i + k] &&
        bars[j + k] &&
        same(bars[i + k]!, bars[j + k]!)
      )
        k++;
      if (k >= 2 && (!longestRun || k > longestRun.to - longestRun.from + 1))
        longestRun = { from: i + 1, to: i + k, of: j + 1 };
    }
  return { beatsPerBar, bars: bars.length, repeats, longestRun };
}

// --- events against the sound ---------------------------------------------------------

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

/** the share of the film within ±w of some onset: how often a time picked at
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

// --- the whole listen ------------------------------------------------------------------

type How = "measured" | "estimated" | "not detected" | "not measured";

export type FilmListen = {
  input: string;
  duration: number;
  sampleRate: number;
  channels: number;
  loudness: {
    how: How;
    integratedLufs: number | null;
    lra: number | null;
    truePeakDb: number | null;
    /** momentary loudness (LUFS, 400 ms) every 100 ms */
    momentary: { t: number; lufs: number }[];
  };
  onsets: { how: How; times: number[]; perS: number };
  tempo: { how: How; value: Tempo | null };
  sections: { how: How; list: Section[] };
  bars: { how: How; value: BarRepeats | null; note?: string };
  silences: { how: How; list: { start: number; end: number }[] };
  dips: { how: How; list: { start: number; end: number; belowLu: number }[] };
  events: {
    how: How;
    file: string | null;
    list: (FilmEvent & { nearestOnset: number | null })[];
    unvoiced: (FilmEvent & { nearestOnset: number | null })[];
    chance40: number;
  };
  cuts: {
    how: How;
    source: "events" | "picture" | "none";
    list: { t: number; nearestOnset: number | null }[];
  };
  stems: {
    how: How;
    dir: string | null;
    list: { name: string; file: string; activeS: number; peakDb: number; lane: boolean[] }[];
    /** seconds per lane cell */
    laneS: number;
    /** per event: the stem that rises at it, and how many dB it sits over the rest */
    eventWindows: { t: number; kind: string; stem: string; overRestDb: number }[];
  };
  curves: FilmEvents["curves"];
  clips: string[];
};

export type FilmListenOptions = {
  /** the film (an mp4) or the score alone (a wav, or any sound) */
  input: string;
  /** the folder to write listen.png / listen.md / listen.json into;
   *  default: `<input without extension>.listen/` */
  out?: string;
  /** default: `<input without extension>.events.json` when it exists */
  events?: string;
  /** a folder of stems (one sound file each, the score's parts) */
  stems?: string;
  /** solo/<stem>.m4a and mute/<stem>.m4a beside the report */
  clips?: boolean;
  /** draws listen.png; without it only the text and data are written */
  chromePath?: string;
  /** the seconds between `film sheet`'s frames, to mark the same times
   *  (default: the sheet's own default for this length) */
  every?: number;
};

const SOUND_EXT = new Set([
  ".wav",
  ".mp3",
  ".flac",
  ".ogg",
  ".m4a",
  ".aac",
  ".aif",
  ".aiff",
  ".opus",
]);

export async function filmListen(opts: FilmListenOptions): Promise<{
  png: string | null;
  md: string;
  json: string;
  listen: FilmListen;
}> {
  const input = resolve(opts.input);
  if (!existsSync(input)) throw new Error(`film listen: no file at ${input}`);
  const stem = input.replace(/\.[^./]+$/, "");
  const outDir = resolve(opts.out ?? `${stem}.listen`);
  const [ffmpeg, ffprobe] = await Promise.all([resolveFfmpeg(), resolveFfprobe()]);
  const info = JSON.parse(
    await runTool(ffprobe, [
      "-v",
      "error",
      "-show_entries",
      "stream=codec_type,width,height,r_frame_rate,sample_rate,channels:format=duration",
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
      sample_rate?: string;
      channels?: number;
    }[];
    format?: { duration?: string };
  };
  const audio = info.streams?.find((s) => s.codec_type === "audio");
  const video = info.streams?.find((s) => s.codec_type === "video");
  if (!audio) throw new Error(`film listen: ${input} has no sound to listen to`);
  const duration = Number(info.format?.duration ?? 0);
  if (!(duration > 0)) throw new Error(`film listen: ${input} has no duration`);

  const eventsPath = opts.events
    ? resolve(opts.events)
    : existsSync(`${stem}.events.json`)
      ? `${stem}.events.json`
      : null;
  if (opts.events && !existsSync(eventsPath!))
    throw new Error(`film listen: no events file at ${eventsPath}`);
  const ev = eventsPath ? parseFilmEvents(JSON.parse(await readFile(eventsPath, "utf8"))) : null;

  const stemFiles = opts.stems
    ? (await readdir(resolve(opts.stems)))
        .filter((f) => SOUND_EXT.has(extname(f).toLowerCase()))
        .sort()
        .map((f) => join(resolve(opts.stems!), f))
    : [];
  if (opts.stems && !stemFiles.length)
    throw new Error(`film listen: no sound files in ${resolve(opts.stems)}`);

  // the passes that only read run side by side
  const width = sheetWidth(video?.width, video?.height);
  const plotW = width - GUTTER - PAD;
  // a sound that ends before the picture does is read as silence to the film's
  // end, so every row (the spectrum picture included) spans the same time
  const pad = `apad=whole_dur=${duration}`;
  const tmp = await mkdtemp(join(tmpdir(), "open-take-listen-"));
  try {
    const wantCuts = !ev?.cuts.length && !!video;
    const [loudLog, pcm, stemPcm, pictureCuts] = await Promise.all([
      runTool(
        ffmpeg,
        [
          "-nostats",
          "-v",
          "info",
          "-i",
          input,
          "-vn",
          "-af",
          `${pad},ebur128=peak=true,silencedetect=n=-50dB:d=0.3`,
          "-f",
          "null",
          "-",
        ],
        { stderr: true },
      ),
      decode(ffmpeg, input).then((x) => padTo(x, duration)),
      Promise.all(stemFiles.map((f) => decode(ffmpeg, f))),
      wantCuts ? detectCuts(ffmpeg, input) : Promise.resolve([] as number[]),
      opts.chromePath
        ? runTool(ffmpeg, [
            "-v",
            "error",
            "-i",
            input,
            "-vn",
            "-ac",
            "1",
            "-lavfi",
            `${pad},showspectrumpic=s=${plotW}x${SPEC_H}:legend=0:fscale=log:scale=log:start=30:stop=11000:color=intensity`,
            "-y",
            join(tmp, "spectrum.png"),
          ])
        : Promise.resolve(""),
    ]);

    // loudness, silences
    const summary = loudLog.slice(loudLog.lastIndexOf("Summary:"));
    const num = (re: RegExp) => {
      const m = re.exec(summary);
      return m ? Number(m[1]) : null;
    };
    const momentary: { t: number; lufs: number }[] = [];
    for (const m of loudLog.matchAll(/t:\s*([\d.]+)\s+TARGET:\S+ LUFS\s+M:\s*(-?[\d.]+|-?inf)/g))
      momentary.push({
        t: Number(m[1]),
        lufs: Number.isFinite(Number(m[2])) ? Number(m[2]) : -120,
      });
    const silences: { start: number; end: number }[] = [];
    let open: number | null = null;
    for (const m of loudLog.matchAll(/silence_(start|end): (-?[\d.]+)/g)) {
      if (m[1] === "start") open = Math.max(0, Number(m[2]));
      else if (open != null) {
        silences.push({ start: round2(open), end: round2(Math.min(duration, Number(m[2]))) });
        open = null;
      }
    }
    if (open != null) silences.push({ start: round2(open), end: round2(duration) });
    const dips = quietDips(momentary);

    // the analysis
    const s = spectrum(pcm);
    const env = onsetStrength(s);
    const onsets = pickOnsets(s, env, pcm).map(round3);
    const tempo = estimateTempo(s, env, onsets, duration);
    const sections = findSections(s, onsets, duration);
    const bars = tempo && tempo.beats.length >= 8 ? repeatedBars(s, tempo.beats) : null;

    const events = (ev?.events ?? []).map((e) => ({
      ...e,
      nearestOnset: nearestOffset(onsets, e.t),
    }));
    const cutTimes = ev?.cuts.length ? ev.cuts : pictureCuts;
    const cuts = cutTimes.map((t) => ({ t, nearestOnset: nearestOffset(onsets, t) }));

    // stems
    const laneS = 0.05;
    const stems = stemFiles.map((file, i) => stemActivity(file, stemPcm[i]!, laneS, duration));
    const eventWindows =
      stems.length >= 2
        ? (ev?.events ?? []).flatMap((e) => {
            const w = eventWindow(stemPcm, e.t);
            return w
              ? [{ t: e.t, kind: e.kind, stem: stems[w.stem]!.name, overRestDb: w.overRestDb }]
              : [];
          })
        : [];

    const listen: FilmListen = {
      input,
      duration: round3(duration),
      sampleRate: Number(audio.sample_rate ?? 0),
      channels: Number(audio.channels ?? 0),
      loudness: {
        // ebur128 reports −70 when nothing sounds above its gate
        how: (num(/I:\s+(-?[\d.]+) LUFS/) ?? -70) > -70 ? "measured" : "not detected",
        integratedLufs: num(/I:\s+(-?[\d.]+) LUFS/),
        lra: num(/LRA:\s+(-?[\d.]+) LU/),
        truePeakDb: num(/Peak:\s+(-?[\d.]+) dBFS/),
        momentary,
      },
      onsets: {
        how: onsets.length ? "measured" : "not detected",
        times: onsets,
        perS: round1(onsets.length / duration),
      },
      tempo: { how: tempo ? "estimated" : "not detected", value: tempo },
      sections: { how: "estimated", list: sections },
      bars: bars
        ? { how: "estimated", value: bars }
        : { how: "not measured", value: null, note: "no beat grid to count bars on" },
      silences: { how: "measured", list: silences },
      dips: { how: "measured", list: dips },
      events: {
        how: !ev ? "not measured" : events.length ? "measured" : "not detected",
        file: eventsPath,
        list: events,
        unvoiced: events.filter((e) => e.nearestOnset == null || Math.abs(e.nearestOnset) > 0.04),
        chance40: chanceWithin(onsets, duration),
      },
      cuts: {
        how: cuts.length ? "measured" : ev || video ? "not detected" : "not measured",
        source: ev?.cuts.length ? "events" : pictureCuts.length ? "picture" : "none",
        list: cuts,
      },
      stems: {
        how: stems.length ? "measured" : "not measured",
        dir: opts.stems ? resolve(opts.stems) : null,
        list: stems,
        laneS,
        eventWindows,
      },
      curves: ev?.curves ?? { names: [], t0: 0, dt: 1 / 60, rows: [] },
      clips: [],
    };

    await mkdir(outDir, { recursive: true });
    if (opts.clips && stemFiles.length) listen.clips = await writeClips(ffmpeg, stemFiles, outDir);
    const md = join(outDir, "listen.md");
    const json = join(outDir, "listen.json");
    await writeFile(md, `${formatFilmListen(listen)}\n`);
    await writeFile(json, `${JSON.stringify(listen)}\n`);
    let png: string | null = null;
    if (opts.chromePath) {
      png = join(outDir, "listen.png");
      await drawListen(listen, {
        chromePath: opts.chromePath,
        tmp,
        out: png,
        width,
        plotW,
        env,
        hopS: s.hopS,
        every: opts.every ?? defaultSheetEvery(duration),
        fps: frameRate(video?.r_frame_rate),
      });
    }
    return { png, md, json, listen };
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

/** silence after the sound's end, up to the film's length */
function padTo(pcm: Float32Array, duration: number): Float32Array {
  const n = Math.round(duration * LISTEN_RATE);
  if (pcm.length >= n) return pcm;
  const out = new Float32Array(n);
  out.set(pcm);
  return out;
}

function decode(ffmpeg: string, file: string): Promise<Float32Array> {
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

/** hard cuts read from the picture (scene change ≥ 0.3 on a small grey copy),
 *  for a film with no events file saying where they are */
async function detectCuts(ffmpeg: string, file: string): Promise<number[]> {
  const log = await runTool(
    ffmpeg,
    [
      "-v",
      "info",
      "-nostats",
      "-i",
      file,
      "-an",
      "-vf",
      "scale=160:-2,format=gray,select='gt(scene,0.3)',showinfo",
      "-f",
      "null",
      "-",
    ],
    { stderr: true },
  ).catch(() => "");
  return [...log.matchAll(/pts_time:\s*([\d.]+)/g)].map((m) => round3(Number(m[1])));
}

/** stretches of at least 0.3 s whose momentary loudness sits 15 LU or more
 *  under the film's median (a breath in the sound, not silence) */
function quietDips(
  m: { t: number; lufs: number }[],
): { start: number; end: number; belowLu: number }[] {
  const sounding = m.filter((p) => p.lufs > -70).map((p) => p.lufs);
  if (!sounding.length) return [];
  const mid = median(sounding);
  const out: { start: number; end: number; belowLu: number }[] = [];
  let start: number | null = null;
  let low = 0;
  for (const p of [...m, { t: Number.POSITIVE_INFINITY, lufs: mid }]) {
    // silence is reported as silence, not as a dip
    const quiet = p.lufs <= mid - 15 && p.lufs > -70;
    if (quiet && start == null) {
      start = p.t;
      low = p.lufs;
    } else if (quiet) low = Math.min(low, p.lufs);
    else if (start != null) {
      const end = Number.isFinite(p.t) ? p.t : m[m.length - 1]!.t;
      // ebur128 stamps the end of each 400 ms window
      if (end - start >= 0.3)
        out.push({
          start: round2(Math.max(0, start - 0.4)),
          end: round2(end - 0.4),
          belowLu: round1(mid - low),
        });
      start = null;
    }
  }
  return out;
}

function stemActivity(file: string, pcm: Float32Array, laneS: number, duration: number) {
  const step = Math.round(LISTEN_RATE * laneS);
  const cells = Math.ceil(duration / laneS);
  const db = new Float32Array(cells).fill(-120);
  let peak = -120;
  for (let c = 0; c < cells; c++) {
    let sq = 0;
    const a = c * step;
    const b = Math.min(pcm.length, a + step);
    for (let i = a; i < b; i++) sq += pcm[i]! * pcm[i]!;
    if (b > a) db[c] = 10 * Math.log10(sq / (b - a) + 1e-12);
    peak = Math.max(peak, db[c]!);
  }
  const gate = Math.max(-60, peak - 40);
  const lane = Array.from(db, (v) => v > gate);
  return {
    name: basename(file).replace(/\.[^.]+$/, ""),
    file,
    activeS: round1(lane.filter(Boolean).length * laneS),
    peakDb: round1(peak),
    lane,
  };
}

/** around an event (20 ms before to 150 ms after), the stem whose level rises
 *  most over the 150 ms before, and how many dB it sits over all the others */
function eventWindow(
  stems: Float32Array[],
  t: number,
): { stem: number; overRestDb: number } | null {
  const rms = (x: Float32Array, a: number, b: number) => {
    const i0 = Math.max(0, Math.round(a * LISTEN_RATE));
    const i1 = Math.min(x.length, Math.round(b * LISTEN_RATE));
    let sq = 0;
    for (let i = i0; i < i1; i++) sq += x[i]! * x[i]!;
    return i1 > i0 ? sq / (i1 - i0) : 0;
  };
  const at = stems.map((x) => rms(x, t - 0.02, t + 0.15));
  const before = stems.map((x) => rms(x, t - 0.17, t - 0.02));
  let best = -1;
  let rise = 3; // dB: less is no sound for this event
  stems.forEach((_, i) => {
    const r = 10 * Math.log10((at[i]! + 1e-12) / (before[i]! + 1e-12));
    if (at[i]! > 1e-9 && r > rise) {
      rise = r;
      best = i;
    }
  });
  if (best < 0) return null;
  const rest = at.reduce((sum, p, i) => (i === best ? sum : sum + p), 0);
  return { stem: best, overRestDb: round1(10 * Math.log10((at[best]! + 1e-12) / (rest + 1e-12))) };
}

async function writeClips(ffmpeg: string, stems: string[], outDir: string): Promise<string[]> {
  await mkdir(join(outDir, "solo"), { recursive: true });
  const written: string[] = [];
  const name = (f: string) => basename(f).replace(/\.[^.]+$/, "");
  await Promise.all(
    stems.map(async (f) => {
      const out = join(outDir, "solo", `${name(f)}.m4a`);
      await runTool(ffmpeg, ["-v", "error", "-i", f, "-c:a", "aac", "-b:a", "160k", "-y", out]);
      written.push(out);
    }),
  );
  if (stems.length >= 2) {
    await mkdir(join(outDir, "mute"), { recursive: true });
    await Promise.all(
      stems.map(async (f) => {
        const others = stems.filter((g) => g !== f);
        const out = join(outDir, "mute", `${name(f)}.m4a`);
        await runTool(ffmpeg, [
          "-v",
          "error",
          ...others.flatMap((g) => ["-i", g]),
          "-filter_complex",
          `amix=inputs=${others.length}:normalize=0:duration=longest`,
          "-c:a",
          "aac",
          "-b:a",
          "160k",
          "-y",
          out,
        ]);
        written.push(out);
      }),
    );
  }
  return written.sort();
}

// --- the text --------------------------------------------------------------------------

export function formatFilmListen(l: FilmListen): string {
  const L: string[] = [];
  const tag = (h: How) => `(${h})`;
  const fmtS = (t: number) => `${t.toFixed(2)}s`;
  const ms = (d: number | null) =>
    d == null ? "no onset" : `${d >= 0 ? "+" : ""}${Math.round(d * 1000)} ms`;
  L.push(`# film listen — ${basename(l.input)}`, "");
  L.push(
    `duration ${fmtS(l.duration)}, ${l.sampleRate} Hz, ${l.channels} channel${l.channels === 1 ? "" : "s"}`,
    "",
    "Information only: what was measured, what is estimated, what was not found. Nothing here is a target.",
    "",
  );
  L.push("## Loudness", "");
  const lo = l.loudness;
  if (lo.how === "not detected")
    L.push(`- loudness: nothing sounds above ebur128's −70 LUFS gate ${tag(lo.how)}`);
  else
    L.push(
      `- integrated ${lo.integratedLufs ?? "?"} LUFS, loudness range ${lo.lra ?? "?"} LU, true peak ${lo.truePeakDb ?? "?"} dBFS ${tag(lo.how)}`,
    );
  const sounding = lo.momentary.filter((p) => p.lufs > -70);
  if (sounding.length) {
    const vals = sounding.map((p) => p.lufs).sort((a, b) => a - b);
    L.push(
      `- momentary (400 ms): 10th percentile ${round1(vals[Math.floor(vals.length * 0.1)]!)} LUFS, median ${round1(median(vals))}, 90th ${round1(vals[Math.floor(vals.length * 0.9)]!)} ${tag("measured")}`,
    );
  }
  L.push("", "## Rhythm", "");
  L.push(`- onsets: ${l.onsets.times.length} (${l.onsets.perS}/s) ${tag(l.onsets.how)}`);
  const t = l.tempo.value;
  if (t) {
    L.push(
      `- tempo ≈ ${t.bpm} BPM, periodicity strength ${t.strength} (autocorrelation of onset strength at that period over zero lag) ${tag("estimated")}`,
    );
    if (t.alternatives.length)
      L.push(
        `- also repeating at: ${t.alternatives.map((a) => `${a.bpm} BPM (${a.strength})`).join(", ")} ${tag("estimated")}`,
      );
    L.push(
      `- beat grid: ${t.beats.length} beats from ${fmtS(t.beats[0] ?? 0)}; ${Math.round(t.gridFit * 100)}% of beats have an onset within 40 ms ${tag("estimated")}`,
    );
  } else L.push(`- tempo: no repeating period between 60 and 200 BPM ${tag("not detected")}`);
  const b = l.bars.value;
  if (b) {
    L.push(
      `- bars of ${b.beatsPerBar} beats on that grid: ${b.bars}; ${b.repeats.length} repeat an earlier bar verbatim (same band energies within 1.5 dB, correlation ≥ 0.95) ${tag("estimated")}`,
    );
    if (b.longestRun)
      L.push(
        `- longest repeated stretch: bars ${b.longestRun.from}–${b.longestRun.to} repeat bars ${b.longestRun.of}–${b.longestRun.of + b.longestRun.to - b.longestRun.from} ${tag("estimated")}`,
      );
    if (b.repeats.length) {
      const groups = new Map<number, number[]>();
      for (const r of b.repeats) groups.set(r.of, [...(groups.get(r.of) ?? []), r.bar]);
      L.push(
        `- which: ${[...groups].map(([of, bars]) => `bar ${of} again at ${bars.join(", ")}`).join("; ")} ${tag("estimated")}`,
      );
    }
  } else L.push(`- repeated bars: ${l.bars.note ?? ""} ${tag(l.bars.how)}`);
  L.push("", "## Sections (where the texture changes)", "");
  for (const [i, s] of l.sections.list.entries())
    L.push(
      `- ${i + 1}. ${fmtS(s.start)}–${fmtS(s.end)}: ${s.levelDb > -120 ? `level ${s.levelDb} dBFS, ${s.onsetsPerS} onsets/s, centroid ${s.centroidHz} Hz` : "silent"}${i ? `, change at start ${s.change} (1 = the sharpest in this film)` : ""} ${tag(l.sections.how)}`,
    );
  L.push("", "## Pauses", "");
  if (l.silences.list.length)
    L.push(
      `- silences (under −50 dBFS for 0.3 s or more): ${l.silences.list.map((s) => `${fmtS(s.start)}–${fmtS(s.end)}`).join(", ")} ${tag("measured")}`,
    );
  else L.push(`- silences (under −50 dBFS for 0.3 s or more): none ${tag("not detected")}`);
  if (l.dips.list.length)
    L.push(
      `- quiet dips (15 LU or more under the median momentary loudness): ${l.dips.list.map((d) => `${fmtS(d.start)}–${fmtS(d.end)} (−${d.belowLu} LU)`).join(", ")} ${tag("measured")}`,
    );
  else
    L.push(
      `- quiet dips (15 LU or more under the median momentary loudness): none ${tag("not detected")}`,
    );

  L.push("", "## Picture events against the sound", "");
  const e = l.events;
  if (!e.file)
    L.push(`- no events file — the page's events were not compared ${tag("not measured")}`);
  else if (!e.list.length) L.push(`- ${basename(e.file)} lists no events ${tag("not detected")}`);
  else {
    const near = e.list.length - e.unvoiced.length;
    L.push(
      `- ${near} of ${e.list.length} events have a sound onset within 40 ms; by chance ${Math.round(e.chance40 * 100)}% would (the share of the film within 40 ms of an onset) ${tag("measured")}`,
    );
    const kinds = [...new Set(e.list.map((x) => x.kind))];
    if (kinds.length > 1)
      for (const k of kinds) {
        const all = e.list.filter((x) => x.kind === k);
        const un = e.unvoiced.filter((x) => x.kind === k).length;
        L.push(`  - ${k}: ${all.length - un} of ${all.length} ${tag("measured")}`);
      }
    if (e.unvoiced.length)
      L.push(
        `- no onset within 40 ms: ${e.unvoiced
          .map(
            (x) =>
              `${fmtS(x.t)} ${x.kind}${x.label ? ` "${x.label}"` : ""} (nearest ${ms(x.nearestOnset)})`,
          )
          .join(", ")} ${tag("measured")}`,
      );
  }
  const st = l.stems;
  if (!st.list.length)
    L.push(
      `- how loud each event's sound sits against the music: needs --stems ${tag("not measured")}`,
    );
  else if (st.list.length < 2)
    L.push(
      `- how loud each event's sound sits against the music: needs two or more stems ${tag("not measured")}`,
    );
  else if (!e.list.length)
    L.push(`- event windows: no events to measure at ${tag("not measured")}`);
  else {
    const missing = e.list.length - st.eventWindows.length;
    const byStem = new Map<string, number[]>();
    for (const w of st.eventWindows)
      byStem.set(w.stem, [...(byStem.get(w.stem) ?? []), w.overRestDb]);
    for (const [name, v] of byStem)
      L.push(
        `- events whose sound is in "${name}": ${v.length}; it sits ${fmtDb(median(v))} over the other stems (median; range ${fmtDb(Math.min(...v))} to ${fmtDb(Math.max(...v))}) in the 20 ms before to 150 ms after ${tag("measured")}`,
      );
    if (missing)
      L.push(
        `- ${missing} event${missing === 1 ? "" : "s"} where no stem rises by 3 dB or more ${tag("measured")}`,
      );
    L.push(
      `- per event: ${st.eventWindows.map((w) => `${fmtS(w.t)} ${w.kind} ${w.stem} ${fmtDb(w.overRestDb)}`).join(", ")} ${tag("measured")}`,
    );
  }

  L.push("", "## Cuts against the sound", "");
  const c = l.cuts;
  if (!c.list.length)
    L.push(
      `- no cuts ${c.how === "not measured" ? "known (no picture, no events file)" : "found"} ${tag(c.how)}`,
    );
  else {
    const offs = c.list.map((x) => x.nearestOnset).filter((d): d is number => d != null);
    const within = offs.filter((d) => Math.abs(d) <= 0.04).length;
    L.push(
      `- ${c.list.length} cuts (${c.source === "events" ? "from the events file" : "read from the picture: scene change ≥ 0.3"}); ${within} within 40 ms of an onset, chance ${Math.round(e.chance40 * 100)}% ${tag("measured")}`,
    );
    if (offs.length)
      L.push(
        `- offset to the nearest onset (negative = the sound comes first): median ${ms(median(offs))}, median distance ${Math.round(median(offs.map(Math.abs)) * 1000)} ms ${tag("measured")}`,
      );
    L.push(
      `- each: ${c.list.map((x) => `${fmtS(x.t)} ${ms(x.nearestOnset)}`).join(", ")} ${tag("measured")}`,
    );
  }
  if (st.list.length) {
    L.push("", "## Stems", "");
    for (const s of st.list)
      L.push(
        `- ${s.name}: sounding ${s.activeS}s of ${l.duration.toFixed(1)}s, peak ${s.peakDb} dBFS RMS (50 ms) ${tag("measured")}`,
      );
  }
  if (l.curves.names.length)
    L.push(
      "",
      "## Curves from the page",
      "",
      `- ${l.curves.names.join(", ")} — drawn in listen.png`,
    );
  if (l.clips.length) L.push("", "## Clips", "", ...l.clips.map((f) => `- ${f}`));
  return L.join("\n");
}

const fmtDb = (v: number) => `${v >= 0 ? "+" : ""}${v.toFixed(1)} dB`;

// --- the picture -------------------------------------------------------------------------

const GUTTER = 120;
const PAD = 6;
const SPEC_H = 280;

/** `film sheet`'s width for a film of this shape, so the two lie one above the other */
function sheetWidth(w?: number, h?: number): number {
  const landscape = !(w && h) || w >= h;
  const columns = landscape ? 6 : 10;
  const tileW = landscape ? 480 : 216;
  return columns * tileW + (columns + 1) * 6;
}

/** the times `film sheet` shows frames at: every `every` s, and the last frame
 *  when it falls more than half a step after the last of them */
function sheetFrameTimes(duration: number, every: number, fps: number): number[] {
  const last = Math.max(0, duration - 1.5 / fps);
  const times = Array.from(
    { length: Math.floor(last / every) + 1 },
    (_, i) => Math.round(i * every * 1000) / 1000,
  );
  if (last - times[times.length - 1]! > every / 2) times.push(Math.round(last * 1000) / 1000);
  return times;
}

const frameRate = (r?: string) => {
  const [n, d] = String(r ?? "60/1")
    .split("/")
    .map(Number);
  return n && d ? n / d : 60;
};

/** `film sheet`'s default seconds between frames */
const defaultSheetEvery = (duration: number) => Math.max(0.25, Math.round((duration / 48) * 4) / 4);

const KIND_COLORS = [
  "#d9480f",
  "#1971c2",
  "#2f9e44",
  "#ae3ec9",
  "#f08c00",
  "#0c8599",
  "#e03131",
  "#5c7cfa",
];

async function drawListen(
  l: FilmListen,
  o: {
    chromePath: string;
    tmp: string;
    out: string;
    width: number;
    plotW: number;
    env: Float32Array;
    hopS: number;
    every: number;
    fps: number;
  },
): Promise<void> {
  const D = l.duration;
  const W = o.plotW;
  const x = (t: number) => round1((Math.max(0, Math.min(D, t)) / D) * W);
  const rows: { label: string; h: number; svg: string }[] = [];
  const esc = (s: string) => s.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);

  // the sheet's frame times
  const sheetTimes = sheetFrameTimes(D, o.every, o.fps);
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
  rows.push({
    label: "spectrum<br><small>30 Hz–11 kHz, log</small>",
    h: SPEC_H,
    svg: `<image href="spectrum.png" x="0" y="0" width="${W}" height="${SPEC_H}" preserveAspectRatio="none"/>`,
  });
  // momentary loudness, −60..0 LUFS
  {
    const H = 130;
    const y = (v: number) => round1(H - ((Math.max(-60, Math.min(0, v)) + 60) / 60) * H);
    const grid = [-10, -20, -30, -40, -50]
      .map(
        (v) =>
          `<line x1="0" x2="${W}" y1="${y(v)}" y2="${y(v)}" stroke="#e5e5e5"/><text x="2" y="${y(v) - 2}" class="s">${v}</text>`,
      )
      .join("");
    const pts = l.loudness.momentary
      .map((p) => `${x(Math.max(0, p.t - 0.2))},${y(p.lufs)}`)
      .join(" ");
    const I = l.loudness.integratedLufs;
    rows.push({
      label: `loudness<br><small>momentary LUFS${I != null ? `<br>I ${I}` : ""}</small>`,
      h: H,
      svg:
        grid +
        (I != null
          ? `<line x1="0" x2="${W}" y1="${y(I)}" y2="${y(I)}" stroke="#d9480f" stroke-dasharray="6 4"/>`
          : "") +
        `<polyline points="${pts}" fill="none" stroke="#222" stroke-width="1.5"/>`,
    });
  }
  // onset strength, onsets, beat grid
  {
    const H = 70;
    const max = Math.max(1e-6, ...o.env);
    const step = Math.max(1, Math.floor(o.env.length / (W * 2)));
    let path = "";
    for (let f = 0; f < o.env.length; f += step) {
      let v = 0;
      for (let k = f; k < Math.min(o.env.length, f + step); k++) v = Math.max(v, o.env[k]!);
      path += `${x(f * o.hopS + WIN / 2 / LISTEN_RATE)},${round1(H - (v / max) * (H - 14))} `;
    }
    const beats = (l.tempo.value?.beats ?? [])
      .map(
        (b, i) =>
          `<line x1="${x(b)}" x2="${x(b)}" y1="0" y2="${i % 4 ? 6 : 12}" stroke="#1971c2"/>`,
      )
      .join("");
    const ticks = l.onsets.times
      .map((t) => `<line x1="${x(t)}" x2="${x(t)}" y1="${H - 5}" y2="${H}" stroke="#d9480f"/>`)
      .join("");
    rows.push({
      label: `onsets<br><small>${l.tempo.value ? `grid ${l.tempo.value.bpm} BPM` : "no grid"}</small>`,
      h: H,
      svg: `<polyline points="${path}" fill="none" stroke="#888"/>${beats}${ticks}`,
    });
  }
  // sections
  rows.push({
    label: "sections",
    h: 26,
    svg: l.sections.list
      .map(
        (s, i) =>
          `<rect x="${x(s.start)}" y="2" width="${Math.max(1, x(s.end) - x(s.start) - 1)}" height="22" fill="${i % 2 ? "#dbe4ff" : "#fff3bf"}"/><text x="${x(s.start) + 4}" y="17" class="m">${i + 1}</text>`,
      )
      .join(""),
  });
  // stems
  for (const s of l.stems.list) {
    let svg = "";
    let run: number | null = null;
    s.lane.forEach((on, i) => {
      if (on && run == null) run = i;
      if ((!on || i === s.lane.length - 1) && run != null) {
        const end = on ? i + 1 : i;
        svg += `<rect x="${x(run * l.stems.laneS)}" y="3" width="${Math.max(1, x(end * l.stems.laneS) - x(run * l.stems.laneS))}" height="14" fill="#495057"/>`;
        run = null;
      }
    });
    rows.push({ label: `<small>${esc(s.name)}</small>`, h: 20, svg });
  }
  // events by kind, cuts
  const kinds = [...new Set(l.events.list.map((e) => e.kind))];
  const color = (k: string) => KIND_COLORS[kinds.indexOf(k) % KIND_COLORS.length]!;
  if (l.events.list.length) {
    const H = 18 * Math.max(1, kinds.length);
    rows.push({
      label: `events<br><small>${kinds.map((k) => `<span style="color:${color(k)}">${esc(k)}</span>`).join(" ")}</small>`,
      h: H,
      svg: l.events.list
        .map((e) => {
          const r = kinds.indexOf(e.kind);
          const miss = e.nearestOnset == null || Math.abs(e.nearestOnset) > 0.04;
          return `<line x1="${x(e.t)}" x2="${x(e.t)}" y1="${r * 18 + 2}" y2="${r * 18 + 16}" stroke="${color(e.kind)}" stroke-width="${miss ? 1 : 2.5}"${miss ? ' stroke-dasharray="2 2"' : ""}/>`;
        })
        .join(""),
    });
  }
  // curves, each scaled to its own range
  const cv = l.curves;
  for (const [j, name] of cv.names.entries()) {
    const vals = cv.rows.map((r) => r[j]!).filter(Number.isFinite);
    if (!vals.length) continue;
    const lo = Math.min(...vals);
    const hi = Math.max(...vals);
    const H = 44;
    const step = Math.max(1, Math.floor(cv.rows.length / (W * 2)));
    let pts = "";
    for (let i = 0; i < cv.rows.length; i += step) {
      const v = cv.rows[i]![j]!;
      if (!Number.isFinite(v)) continue;
      pts += `${x(cv.t0 + i * cv.dt)},${round1(H - 3 - ((v - lo) / (hi - lo || 1)) * (H - 6))} `;
    }
    rows.push({
      label: `<small>${esc(name)}<br>${fmtNum(lo)}–${fmtNum(hi)}</small>`,
      h: H,
      svg: `<polyline points="${pts}" fill="none" stroke="#7048e8" stroke-width="1.5"/>`,
    });
  }

  const gap = 4;
  let top = PAD;
  const body = rows
    .map((r) => {
      const html = `<div class="row" style="top:${top}px;height:${r.h}px"><div class="lab">${r.label}</div><svg width="${W}" height="${r.h}" style="left:${GUTTER}px">${r.svg}</svg></div>`;
      top += r.h + gap;
      return html;
    })
    .join("");
  const height = top + PAD + 18;
  // cuts and silences across every row
  const over = `<svg class="over" width="${W}" height="${height - PAD * 2 - 18}" style="left:${GUTTER}px;top:${PAD}px">${l.silences.list
    .map(
      (s) =>
        `<rect x="${x(s.start)}" y="0" width="${Math.max(1, x(s.end) - x(s.start))}" height="100%" fill="#868e96" opacity="0.18"/>`,
    )
    .join("")}${l.cuts.list
    .map(
      (c) =>
        `<line x1="${x(c.t)}" x2="${x(c.t)}" y1="0" y2="100%" stroke="#e03131" stroke-width="1" opacity="0.55"/>`,
    )
    .join("")}</svg>`;
  const legend = `<div class="legend" style="top:${top}px">red lines: cuts (${l.cuts.source === "events" ? "events file" : l.cuts.source === "picture" ? "read from the picture" : "none"}) · grey: silence · onsets: orange ticks, beat grid blue (tall = every 4th) · events: solid = an onset within 40 ms, dashed = none · ${esc(basename(l.input))} ${l.duration.toFixed(2)}s</div>`;
  await writeFile(
    join(o.tmp, "listen.html"),
    `<!doctype html><meta charset="utf-8"><style>
html,body{margin:0;background:#fff}
body{position:relative;width:${o.width}px;height:${height}px;font:12px/1.25 ui-monospace,Menlo,monospace;color:#111}
.row{position:absolute;left:0;width:${o.width}px}
.row svg,.over{position:absolute;top:0}
.row svg{background:#fafafa}
.over{pointer-events:none}
.lab{position:absolute;left:${PAD}px;width:${GUTTER - PAD * 2}px;top:2px;font-weight:600}
small{font-weight:400;color:#555}
.s{font-size:10px;fill:#333}.m{font-size:12px;font-weight:600;fill:#333}
.legend{position:absolute;left:${GUTTER}px;font-size:11px;color:#444}
</style>${body}${over}${legend}`,
  );
  const browser = await launchHtmlBrowser({
    chromePath: o.chromePath,
    url: pathToFileURL(join(o.tmp, "listen.html")).href,
    width: o.width,
    height,
    profilePrefix: "open-take-listen-",
  });
  try {
    // the spectrum decoded, then two frames painted: a screenshot taken sooner
    // came out with the lower rows still showing tiles of the top ones
    await browser.evaluate(
      "new Promise((ok) => { const i = new Image(); i.onload = i.onerror = () => i.decode().catch(() => {}).then(() => requestAnimationFrame(() => requestAnimationFrame(() => ok(0)))); i.src = 'spectrum.png'; })",
    );
    await writeFile(o.out, await browser.screenshot({ format: "png" }));
  } finally {
    await browser.close();
  }
}

const fmtNum = (v: number) => (Math.abs(v) >= 100 ? String(Math.round(v)) : String(round2(v)));

// --- small arithmetic -----------------------------------------------------------------

function median(xs: readonly number[]): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}
const round1 = (v: number) => Math.round(v * 10) / 10;
const round2 = (v: number) => Math.round(v * 100) / 100;
const round3 = (v: number) => Math.round(v * 1000) / 1000;
