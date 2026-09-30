// The master: measure loudness the way broadcast and the platforms do (ITU-R
// BS.1770-4: K-weighting, 400 ms blocks, absolute and relative gates), find
// true peaks by oversampling, and bring a mix to a loudness target under a
// true-peak ceiling with a smooth limiter.
//
// This is the one place a mix's level is decided, so no single cue gain — and
// no agent — can make a film clip or come out whisper-quiet.

import type { Pcm } from "./wav";

// K-weighting at 48 kHz (BS.1770-4 table 1 and 2)
const SHELF = {
  b: [1.53512485958697, -2.69169618940638, 1.19839281085285],
  a: [-1.69065929318241, 0.73248077421585],
};
const RLB = { b: [1.0, -2.0, 1.0], a: [-1.99004745483398, 0.99007225036621] };

function biquad(x: Float32Array, c: { b: number[]; a: number[] }): Float64Array {
  const y = new Float64Array(x.length);
  let x1 = 0,
    x2 = 0,
    y1 = 0,
    y2 = 0;
  const [b0, b1, b2] = c.b as [number, number, number];
  const [a1, a2] = c.a as [number, number];
  for (let i = 0; i < x.length; i++) {
    const xi = x[i]!;
    const yi = b0 * xi + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
    x2 = x1;
    x1 = xi;
    y2 = y1;
    y1 = yi;
    y[i] = yi;
  }
  return y;
}

function kWeightedSquares(pcm: Pcm): Float64Array[] {
  if (pcm.sampleRate !== 48000) throw new Error("loudness: 48 kHz input required");
  return pcm.channels.map((ch) => {
    const s = biquad(ch, SHELF);
    const f32 = new Float32Array(s.length);
    for (let i = 0; i < s.length; i++) f32[i] = s[i]!;
    const k = biquad(f32, RLB);
    for (let i = 0; i < k.length; i++) k[i] = k[i]! * k[i]!;
    return k;
  });
}

/** Mean-square power per block (summed over channels, G = 1 for L/R). */
function blockPowers(sq: Float64Array[], blockS: number, hopS: number, sr: number): number[] {
  const len = sq[0]?.length ?? 0;
  const block = Math.round(blockS * sr);
  const hop = Math.round(hopS * sr);
  // prefix sums for O(1) windows
  const pre = sq.map((c) => {
    const p = new Float64Array(c.length + 1);
    for (let i = 0; i < c.length; i++) p[i + 1] = p[i]! + c[i]!;
    return p;
  });
  const out: number[] = [];
  for (let s = 0; s + block <= len; s += hop) {
    let z = 0;
    for (const p of pre) z += (p[s + block]! - p[s]!) / block;
    out.push(z);
  }
  return out;
}

const lufs = (z: number) => -0.691 + 10 * Math.log10(z);

export type Loudness = {
  /** integrated loudness, LUFS (BS.1770-4 gated) */
  integrated: number;
  /** loudness range, LU (EBU Tech 3342) */
  range: number;
  /** maximum short-term (3 s) loudness */
  shortTermMax: number;
  /** maximum momentary (400 ms) loudness */
  momentaryMax: number;
  /** true peak, dBTP (4× oversampled) */
  truePeak: number;
  /** sample peak, dBFS */
  samplePeak: number;
};

export function measureLoudness(pcm: Pcm): Loudness {
  const sq = kWeightedSquares(pcm);
  const sr = pcm.sampleRate;
  const mom = blockPowers(sq, 0.4, 0.1, sr);
  const abs = mom.filter((z) => lufs(z) > -70);
  let integrated = Number.NEGATIVE_INFINITY;
  if (abs.length) {
    const rel = lufs(abs.reduce((a, b) => a + b, 0) / abs.length) - 10;
    const gated = abs.filter((z) => lufs(z) > rel);
    if (gated.length) integrated = lufs(gated.reduce((a, b) => a + b, 0) / gated.length);
  }
  const st = blockPowers(sq, 3, 0.1, sr).map(lufs);
  const stAbs = st.filter((l) => l > -70);
  let range = 0;
  if (stAbs.length) {
    const power = stAbs.map((l) => 10 ** ((l + 0.691) / 10));
    const relGate = lufs(power.reduce((a, b) => a + b, 0) / power.length) - 20;
    const g = stAbs.filter((l) => l > relGate).sort((a, b) => a - b);
    if (g.length) {
      const q = (p: number) =>
        g[Math.min(g.length - 1, Math.max(0, Math.round(p * (g.length - 1))))]!;
      range = q(0.95) - q(0.1);
    }
  }
  return {
    integrated,
    range,
    shortTermMax: st.length ? Math.max(...st) : Number.NEGATIVE_INFINITY,
    momentaryMax: mom.length ? Math.max(...mom.map(lufs)) : Number.NEGATIVE_INFINITY,
    truePeak: truePeakDb(pcm),
    samplePeak: 20 * Math.log10(Math.max(1e-12, ...pcm.channels.map(absMax))),
  };
}

function absMax(x: Float32Array): number {
  let m = 0;
  for (let i = 0; i < x.length; i++) m = Math.max(m, Math.abs(x[i]!));
  return m;
}

// 4× oversampling with a 48-tap-per-phase windowed sinc, evaluated only where
// a sample is within 6 dB of the sample peak (inter-sample overs live there).
const TAPS = 24;
const PHASES = [0.25, 0.5, 0.75].map((frac) => {
  const k: number[] = [];
  for (let j = -TAPS + 1; j <= TAPS; j++) {
    const x = j - frac;
    const sinc = x === 0 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x);
    const w = 0.5 + 0.5 * Math.cos((Math.PI * x) / (TAPS + 1));
    k.push(sinc * w);
  }
  return k;
});

export function truePeakDb(pcm: Pcm): number {
  let peak = 0;
  for (const ch of pcm.channels) {
    const sp = absMax(ch);
    peak = Math.max(peak, sp);
    const floor = sp * 0.5;
    for (let i = 0; i < ch.length; i++) {
      if (Math.abs(ch[i]!) < floor && Math.abs(ch[i + 1] ?? 0) < floor) continue;
      for (const k of PHASES) {
        let v = 0;
        for (let j = -TAPS + 1; j <= TAPS; j++) {
          const s = ch[i + j];
          if (s !== undefined) v += s * k[j + TAPS - 1]!;
        }
        peak = Math.max(peak, Math.abs(v));
      }
    }
  }
  return 20 * Math.log10(Math.max(1e-12, peak));
}

/** A look-ahead peak limiter without latency: the required gain is computed
 *  per sample, a backward pass ramps it down linearly over `attackS` before
 *  every over, a forward pass lets it recover exponentially over `releaseS`.
 *  The result never exceeds `ceilingDb` at sample level. With `truePeak`, the
 *  requirement also covers the 4× inter-sample points around each sample,
 *  which keeps heavy limiting from flat-topping a waveform into large
 *  inter-sample overs; a residual of a few hundredths of a dB (more under
 *  extreme drive) remains, which `master()` trims. About 40× the cost of the
 *  sample-peak path. */
export function limit(
  pcm: Pcm,
  ceilingDb: number,
  attackS = 0.005,
  releaseS = 0.12,
  truePeak = false,
): Pcm {
  const n = pcm.channels[0]?.length ?? 0;
  const ceil = 10 ** (ceilingDb / 20);
  const g = new Float64Array(n).fill(1);
  for (const ch of pcm.channels)
    for (let i = 0; i < n; i++) {
      const a = Math.abs(ch[i]!);
      if (a > ceil) g[i] = Math.min(g[i]!, ceil / a);
      if (!truePeak) continue;
      const b = Math.abs(ch[i + 1] ?? 0);
      if (a < ceil * 0.5 && b < ceil * 0.5) continue;
      // the inter-sample points between i and i+1 bind both neighbours
      let m = 0;
      for (const k of PHASES) {
        let v = 0;
        for (let j = -TAPS + 1; j <= TAPS; j++) {
          const x = ch[i + j];
          if (x !== undefined) v += x * k[j + TAPS - 1]!;
        }
        m = Math.max(m, Math.abs(v));
      }
      if (m > ceil) {
        g[i] = Math.min(g[i]!, ceil / m);
        if (i + 1 < n) g[i + 1] = Math.min(g[i + 1]!, ceil / m);
      }
    }
  const att = Math.max(1, Math.round(attackS * pcm.sampleRate));
  for (let i = n - 2; i >= 0; i--) g[i] = Math.min(g[i]!, g[i + 1]! + 1 / att);
  const rel = 1 - Math.exp(-1 / (releaseS * pcm.sampleRate));
  for (let i = 1; i < n; i++) {
    const up = g[i - 1]! + (1 - g[i - 1]!) * rel;
    g[i] = Math.min(g[i]!, up);
  }
  return {
    sampleRate: pcm.sampleRate,
    channels: pcm.channels.map((ch) => {
      const y = new Float32Array(n);
      for (let i = 0; i < n; i++) y[i] = ch[i]! * g[i]!;
      return y;
    }),
  };
}

export function gain(pcm: Pcm, db: number): Pcm {
  const k = 10 ** (db / 20);
  return {
    sampleRate: pcm.sampleRate,
    channels: pcm.channels.map((ch) => {
      const y = new Float32Array(ch.length);
      for (let i = 0; i < ch.length; i++) y[i] = ch[i]! * k;
      return y;
    }),
  };
}

export type MasterOpts = {
  /** integrated loudness target, LUFS (default −15: the reference launch film's) */
  lufs?: number;
  /** true-peak ceiling, dBTP (default −1) */
  truePeak?: number;
};

export type Mastered = {
  pcm: Pcm;
  before: Loudness;
  after: Loudness;
  gainDb: number;
  /** false when the target was out of reach under the ceiling (or the input
   *  was silent); `after` then says what was achieved */
  converged: boolean;
};

/** Bring a mix to the loudness target under the true-peak ceiling. Two or
 *  three passes: gain, limit, re-measure (limiting costs a little loudness). */
export function master(pcm: Pcm, opts: MasterOpts = {}): Mastered {
  const target = opts.lufs ?? -15;
  const ceiling = opts.truePeak ?? -1;
  const before = measureLoudness(pcm);
  if (!Number.isFinite(before.integrated))
    return { pcm, before, after: before, gainDb: 0, converged: false };
  // no gain beyond this: a signal that cannot reach the target under the
  // ceiling is reported, not pumped into mush
  const maxGain = 36;
  let g = Math.min(maxGain, target - before.integrated);
  let out = pcm;
  let after = before;
  for (let pass = 0; pass < 5; pass++) {
    out = limit(gain(pcm, g), ceiling - 0.1, 0.005, 0.12, true);
    after = measureLoudness(out);
    const miss = target - after.integrated;
    if (Math.abs(miss) < 0.1) break;
    const next = Math.min(maxGain, g + miss);
    if (Math.abs(next - g) < 1e-6) break;
    g = next;
  }
  // the ceiling is a hard constraint: trim any residual over linearly
  if (after.truePeak > ceiling) {
    out = gain(out, ceiling - after.truePeak - 0.02);
    after = measureLoudness(out);
  }
  const converged = Math.abs(target - after.integrated) < 0.3 && after.truePeak <= ceiling + 1e-9;
  return { pcm: out, before, after, gainDb: g, converged };
}

/** Sum stems (each with its own gain in dB) to one stereo mix of `durationS`. */
export function sumStems(
  stems: { pcm: Pcm; db?: number }[],
  durationS: number,
  sampleRate = 48000,
): Pcm {
  const n = Math.ceil(durationS * sampleRate);
  const L = new Float32Array(n);
  const R = new Float32Array(n);
  for (const { pcm, db } of stems) {
    if (pcm.sampleRate !== sampleRate) throw new Error("sumStems: sample rates differ");
    const k = 10 ** ((db ?? 0) / 20);
    const [l, r] = [pcm.channels[0]!, pcm.channels[1] ?? pcm.channels[0]!];
    const m = Math.min(n, l.length);
    for (let i = 0; i < m; i++) {
      L[i]! += l[i]! * k;
      R[i]! += r[i]! * k;
    }
  }
  return { sampleRate, channels: [L, R] };
}

/** Duck a stem under a list of moments (e.g. the music under foley clicks):
 *  −`depthDb` with a fast attack and an S-shaped recovery. */
export function duck(pcm: Pcm, timesS: number[], depthDb: number, releaseS = 0.14): Pcm {
  const n = pcm.channels[0]?.length ?? 0;
  const sr = pcm.sampleRate;
  const floor = 10 ** (-Math.abs(depthDb) / 20);
  const g = new Float32Array(n).fill(1);
  const att = Math.round(0.006 * sr);
  const rel = Math.round(releaseS * sr);
  for (const t of timesS) {
    const s = Math.round(t * sr);
    for (let i = -att; i < rel; i++) {
      const j = s + i;
      if (j < 0 || j >= n) continue;
      const v =
        i < 0
          ? 1 - (1 - floor) * ((i + att) / att)
          : floor + (1 - floor) * ((i / rel) ** 2 * (3 - (2 * i) / rel));
      if (v < g[j]!) g[j] = v;
    }
  }
  return {
    sampleRate: sr,
    channels: pcm.channels.map((ch) => {
      const y = new Float32Array(n);
      for (let i = 0; i < n; i++) y[i] = ch[i]! * g[i]!;
      return y;
    }),
  };
}

export type FilmMixOpts = {
  /** music level against the foley before mastering (dB); default −3 */
  musicDb?: number;
  /** foley level (dB); default +6 — the interface sounds sit on top */
  foleyDb?: number;
  /** music dip under busy foley (clicks, keys), dB; default 2.5 */
  duckDb?: number;
  /** loudness target; default −15 LUFS */
  lufs?: number;
  /** true-peak ceiling; default −1.5 dBTP (lossy delivery overshoots a little) */
  truePeak?: number;
};

/** A film's soundtrack: music ducked a touch under busy foley, foley on
 *  top, mastered to the delivery target. Either stem may be absent. */
export function mixFilm(
  music: Pcm | undefined,
  foley: Pcm | undefined,
  busyS: number[],
  durationS: number,
  opts: FilmMixOpts = {},
): Mastered {
  const stems: { pcm: Pcm; db?: number }[] = [];
  if (music) stems.push({ pcm: duck(music, busyS, opts.duckDb ?? 2.5), db: opts.musicDb ?? -3 });
  if (foley) stems.push({ pcm: foley, db: opts.foleyDb ?? 6 });
  return master(sumStems(stems, durationS), {
    lufs: opts.lufs ?? -15,
    truePeak: opts.truePeak ?? -1.5,
  });
}
