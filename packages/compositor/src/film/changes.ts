// Where a film's sound changes at once, and what changed: at each moment, the
// two seconds after it set against the two before — how often the low, middle
// and high bands are struck, which part of the spectrum gained or lost a
// sound, the harmony, the level — and whether anything led into it (a rise,
// a fill) or it simply switched. A change in one of these is a film moving
// on; several at once with nothing leading in is heard as another piece of
// music starting. Information only: no threshold says a change is wrong.

import {
  BANDS,
  bandOnsetStrength,
  chromagram,
  FLOOR_DB,
  HIGH_HZ,
  LISTEN_RATE,
  LOW_HZ,
  pickOnsets,
  spectrum,
} from "./beats";

export type SoundChange = {
  /** s, on the nearest onset */
  t: number;
  /** against the film's sharpest change (1) */
  size: number;
  /** what changed there, each in words with its numbers */
  parts: string[];
  /** what led into it in the 1.5 s before, or null: nothing did */
  leadIn: string | null;
};

type Win = {
  rates: [number, number, number];
  /** the period the low band's hits repeat at, s (null: no clear one) */
  pulse: number | null;
  bands: Float64Array;
  level: number;
  chroma: Float64Array;
};

const REGIONS: [string, number, number][] = [
  ["low", 40, 200],
  ["middle", 200, 2000],
  ["high", 2000, 10_000],
];
const bandHz = (k: number) => LOW_HZ * (HIGH_HZ / LOW_HZ) ** (k / BANDS);
const dbMean = (xs: number[]) =>
  xs.length ? 10 * Math.log10(xs.reduce((a, v) => a + 10 ** (v / 10), 0) / xs.length) : FLOOR_DB;
const hz = (v: number) => (v >= 1000 ? `${(v / 1000).toFixed(1)} kHz` : `${Math.round(v)} Hz`);

/** the sharpest changes in a sound (mono samples at LISTEN_RATE), largest
 *  first; null when the sound is too short to set `window` s either side of a
 *  moment (2·window + 1 s) — not measured, rather than measured and calm */
export function soundChanges(
  pcm: Float32Array,
  { window = 3, max = 5 }: { window?: number; max?: number } = {},
): SoundChange[] | null {
  const duration = pcm.length / LISTEN_RATE;
  if (duration < 2 * window + 1) return null;
  const s = spectrum(pcm);
  const lowEnv = bandOnsetStrength(s, 40, 200);
  const ch = chromagram(pcm);
  const onsets = REGIONS.map(([, lo, hi]) => pickOnsets(s, bandOnsetStrength(s, lo, hi)));
  const all = pickOnsets(s, bandOnsetStrength(s, LOW_HZ, HIGH_HZ));
  const frames = (a: number, b: number) => {
    const out: number[] = [];
    for (let f = Math.max(0, Math.ceil(a / s.hopS)); f < Math.min(s.level.length, b / s.hopS); f++)
      out.push(f);
    return out;
  };
  const measure = (a: number, b: number): Win => {
    const fs = frames(a, b);
    const bands = new Float64Array(BANDS);
    for (let k = 0; k < BANDS; k++) bands[k] = dbMean(fs.map((f) => s.bands[f]![k]!));
    const chroma = new Float64Array(12);
    for (let f = 0; f < ch.frames.length; f++) {
      const t = ch.frameTime(f);
      if (t >= a && t < b) for (let c = 0; c < 12; c++) chroma[c] = chroma[c]! + ch.frames[f]![c]!;
    }
    const len = Math.max(0.25, b - a);
    return {
      pulse: pulseOf(lowEnv, fs, s.hopS),
      rates: onsets.map((xs) => xs.filter((t) => t >= a && t < b).length / len) as [
        number,
        number,
        number,
      ],
      bands,
      level: dbMean(fs.map((f) => s.level[f]!)),
      chroma,
    };
  };
  const step = 0.25;
  type Cand = {
    t: number;
    d: number[];
    before: Win;
    after: Win;
  };
  const cands: Cand[] = [];
  // only where both windows are whole: the film's first and last seconds are its music starting and ending
  // each window serves as one moment's "after" and a later one's "before": measured once
  const wins: Map<number, Win> = new Map();
  const once = (a: number) => {
    const k = Math.round(a / step);
    let w = wins.get(k);
    if (!w) {
      w = measure(a, a + window);
      wins.set(k, w);
    }
    return w;
  };
  for (let t = window; t <= duration - window; t += step) {
    const before = once(t - window);
    const after = once(t);
    if (before.level <= FLOOR_DB + 10 && after.level <= FLOOR_DB + 10) continue;
    const rate = (i: number) =>
      Math.abs(Math.log2((after.rates[i]! + 0.25) / (before.rates[i]! + 0.25)));
    // the spectrum's shape, the level taken out: which part gained or lost a sound
    let mean = 0;
    let n = 0;
    for (let k = 0; k < BANDS; k++)
      if (after.bands[k]! > FLOOR_DB || before.bands[k]! > FLOOR_DB) {
        mean += after.bands[k]! - before.bands[k]!;
        n++;
      }
    mean = n ? mean / n : 0;
    let shape = 0;
    for (let k = 0; k < BANDS; k++)
      if (after.bands[k]! > FLOOR_DB || before.bands[k]! > FLOOR_DB)
        shape += Math.abs(after.bands[k]! - before.bands[k]! - mean);
    shape = n ? shape / n : 0;
    let xy = 0;
    let xx = 0;
    let yy = 0;
    for (let c = 0; c < 12; c++) {
      xy += after.chroma[c]! * before.chroma[c]!;
      xx += after.chroma[c]! ** 2;
      yy += before.chroma[c]! ** 2;
    }
    const harmony = xx > 0 && yy > 0 ? 1 - xy / Math.sqrt(xx * yy) : 0;
    // only a clear halving or doubling of the low pulse: half-time, double-time
    const ratio = before.pulse && after.pulse ? after.pulse / before.pulse : 1;
    const pulse = Math.abs(ratio - 2) < 0.25 || Math.abs(ratio - 0.5) < 0.07 ? 1 : 0;
    cands.push({
      t,
      d: [rate(0), rate(1), rate(2), shape, harmony, Math.abs(after.level - before.level), pulse],
      before,
      after,
    });
  }
  if (!cands.length) return [];
  // each measure against how much it usually moves in this film, and a floor below which it is not a change
  const FLOOR = [0.58, 0.58, 0.58, 3, 0.12, 3, 1];
  const p90 = FLOOR.map((_, i) => {
    const xs = cands.map((c) => c.d[i]!).sort((a, b) => a - b);
    return Math.max(1e-6, xs[Math.floor(xs.length * 0.9)]!);
  });
  const changed = (c: Cand, i: number) => c.d[i]! >= FLOOR[i]! && c.d[i]! >= p90[i]!;
  const score = (c: Cand) =>
    c.d.reduce((a, v, i) => a + (changed(c, i) ? Math.min(3, v / p90[i]!) : 0), 0);
  const scored = cands.map((c) => ({ c, v: score(c) })).filter((x) => x.v > 0);
  // the strongest within ±1.5 s of each other count once
  scored.sort((a, b) => b.v - a.v);
  const kept: typeof scored = [];
  for (const x of scored) if (!kept.some((k) => Math.abs(k.c.t - x.c.t) < 1.5)) kept.push(x);
  // a switch keeps its measures past their usual for a while either side of
  // it; the moment itself is where the measures that move smoothly (the
  // spectrum's shape, the harmony, the level) set the two sides furthest apart
  const loc = (c: Cand) => c.d[3]! / p90[3]! + c.d[4]! / p90[4]! + c.d[5]! / p90[5]!;
  // moved only onto a moment that itself scored nearly as high, so what it says changed is what scored
  const placed = kept.map((k) => {
    let at = k.c;
    for (const x of scored)
      if (Math.abs(x.c.t - k.c.t) <= 1 && x.v >= k.v * 0.8 && loc(x.c) > loc(at)) at = x.c;
    return { c: at, v: k.v };
  });
  const top: typeof placed = [];
  for (const x of placed)
    if (top.length < max && !top.some((k) => Math.abs(k.c.t - x.c.t) < 1.5)) top.push(x);
  const best = top[0]?.v ?? 1;
  const out = top.map(({ c, v }) => {
    const parts: string[] = [];
    REGIONS.forEach(([name], i) => {
      if (!changed(c, i)) return;
      const [b, a] = [c.before.rates[i]!, c.after.rates[i]!];
      parts.push(`${name} hits ${b.toFixed(1)} → ${a.toFixed(1)} a second`);
    });
    if (changed(c, 3)) {
      // the band region that gained (or lost) most against the level change
      const lift = Array.from(
        { length: BANDS },
        (_, k) => c.after.bands[k]! - c.before.bands[k]! - (c.after.level - c.before.level),
      );
      // the stretch of 2–12 bands whose mean moved most that way (weighted to favour a wider stretch)
      const run = (sign: 1 | -1) => {
        let best: { lo: number; hi: number; db: number; w: number } | null = null;
        for (let k0 = 0; k0 < BANDS; k0++) {
          let sum = 0;
          for (let k1 = k0 + 1; k1 <= Math.min(BANDS, k0 + 12); k1++) {
            sum += sign * lift[k1 - 1]!;
            const width = k1 - k0;
            if (width < 2) continue;
            const db = sum / width;
            const w = db * Math.sqrt(width);
            if (db > 0 && (!best || w > best.w)) best = { lo: k0, hi: k1, db, w };
          }
        }
        return best;
      };
      const gain = run(1);
      const loss = run(-1);
      if (gain && gain.db >= 4)
        parts.push(
          `a sound comes in around ${hz(bandHz(gain.lo))}–${hz(bandHz(gain.hi))} (+${gain.db.toFixed(0)} dB there)`,
        );
      if (loss && loss.db >= 4)
        parts.push(
          `the sound around ${hz(bandHz(loss.lo))}–${hz(bandHz(loss.hi))} goes (−${loss.db.toFixed(0)} dB)`,
        );
    }
    if (changed(c, 6)) {
      const [b, a] = [c.before.pulse!, c.after.pulse!];
      parts.push(
        `the low pulse goes ${a > b ? "half-time" : "double-time"}: a hit every ${b.toFixed(2)} s → every ${a.toFixed(2)} s`,
      );
    }
    if (changed(c, 4))
      parts.push(`the harmony changes (pitch classes ${c.d[4]!.toFixed(2)} apart)`);
    if (changed(c, 5)) {
      const dl = c.after.level - c.before.level;
      parts.push(`level ${dl > 0 ? "+" : "−"}${Math.abs(dl).toFixed(0)} dB`);
    }
    // on the onset nearest, when one is within 0.3 s
    let t = c.t;
    let near = 0.3;
    for (const o of all)
      if (Math.abs(o - c.t) < near) {
        near = Math.abs(o - c.t);
        t = o;
      }
    return {
      t: Math.round(t * 100) / 100,
      size: Math.round((v / best) * 100) / 100,
      parts,
      leadIn: leadIn(s, onsets[2]!, t),
    };
  });
  return out.filter((c) => c.parts.length);
}

/** the lag (0.2–1.5 s) at which the low band's onset strength repeats best
 *  over these frames — the shortest of those within 85% of the best, so a
 *  steady beat is not read at twice its period — or null when nothing repeats
 *  clearly (correlation under 0.35) */
function pulseOf(env: Float32Array, fs: number[], hopS: number): number | null {
  if (fs.length < 8) return null;
  const x = fs.map((f) => env[f] ?? 0);
  const mean = x.reduce((a, v) => a + v, 0) / x.length;
  const y = x.map((v) => v - mean);
  const zero = y.reduce((a, v) => a + v * v, 0);
  if (!(zero > 0)) return null;
  const lags: { lag: number; r: number }[] = [];
  for (let L = Math.round(0.2 / hopS); L <= Math.min(Math.round(1.5 / hopS), y.length >> 1); L++) {
    let r = 0;
    for (let i = L; i < y.length; i++) r += y[i]! * y[i - L]!;
    lags.push({ lag: L * hopS, r: r / zero });
  }
  // local maxima only
  const peaks = lags.filter(
    (p, i) => i > 0 && i < lags.length - 1 && p.r >= lags[i - 1]!.r && p.r >= lags[i + 1]!.r,
  );
  const best = Math.max(0, ...peaks.map((p) => p.r));
  if (best < 0.35) return null;
  return peaks.find((p) => p.r >= best * 0.85)?.lag ?? null;
}

/** a rise in level or in the high band over the 1.5 s before t, or a fill (the
 *  high hits thickening in the last second) — or null */
function leadIn(s: ReturnType<typeof spectrum>, high: readonly number[], t: number): string | null {
  const a = Math.max(0, t - 1.5);
  if (t - a < 0.75) return null;
  const k0 = Math.floor((BANDS * Math.log(2000 / LOW_HZ)) / Math.log(HIGH_HZ / LOW_HZ));
  const xs: number[] = [];
  const lv: number[] = [];
  const hb: number[] = [];
  for (let f = Math.ceil(a / s.hopS); f < Math.min(s.level.length, t / s.hopS); f++) {
    xs.push(f * s.hopS);
    lv.push(Math.max(FLOOR_DB, s.level[f]!));
    let e = 0;
    for (let k = k0; k < BANDS; k++) e += 10 ** (s.bands[f]![k]! / 10);
    hb.push(10 * Math.log10(e / (BANDS - k0) + 1e-12));
  }
  const slope = (ys: number[]) => {
    const n = ys.length;
    if (n < 4) return 0;
    const mx = xs.reduce((p, v) => p + v, 0) / n;
    const my = ys.reduce((p, v) => p + v, 0) / n;
    let sxy = 0;
    let sxx = 0;
    for (let i = 0; i < n; i++) {
      sxy += (xs[i]! - mx) * (ys[i]! - my);
      sxx += (xs[i]! - mx) ** 2;
    }
    return sxx > 0 ? sxy / sxx : 0;
  };
  const span = t - a;
  const lRise = slope(lv) * span;
  const hRise = slope(hb) * span;
  if (lRise >= 4)
    return `the level rises ${lRise.toFixed(0)} dB over the ${span.toFixed(1)} s before`;
  if (hRise >= 6)
    return `the high band rises ${hRise.toFixed(0)} dB over the ${span.toFixed(1)} s before`;
  const last = high.filter((x) => x >= t - 1 && x < t).length;
  const prev = high.filter((x) => x >= t - 2 && x < t - 1).length;
  if (last >= 4 && last >= prev * 1.5 + 1)
    return `the high hits thicken in the second before (${prev} → ${last})`;
  return null;
}

export function formatSoundChanges(cs: SoundChange[] | null): string[] {
  if (!cs)
    return ["- too short to set 3 s either side of a moment against each other (not measured)"];
  if (!cs.length)
    return ["- no change in the sound stood out from how it usually moves (not detected)"];
  return cs.map(
    (c, i) =>
      `- ${c.t.toFixed(2)}s: ${c.parts.join("; ")} — ${c.leadIn ?? "nothing leads into it"}${i === 0 ? " — the sharpest in this film" : `, size ${c.size}`} (estimated)`,
  );
}
