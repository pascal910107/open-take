// Read a film's mono mix on the picture clock. The spectrum gives the
// level under the picture, sections and hits. A longer window finds held
// changes in the sub band, then a short envelope places each edge in time.
// A shuffled shot order puts cut-to-sound distances beside what chance
// would give. The mix gives no separate readings for voice, music or effects.

import {
  bandOnsetStrength,
  estimateMeter,
  chromagram,
  findDrops,
  makeFft,
  median,
} from "./beats";
import { soundChanges } from "./changes";
import {
  chanceWithin,
  estimateTempo,
  findSections,
  LISTEN_RATE,
  nearestOffset,
  onsetStrength,
  pickOnsets,
  spectrum,
} from "./listen";

export const SOUND_KINDS = ["onset", "hit", "sub_entry", "sub_exit", "drop"] as const;
export type SoundKind = (typeof SOUND_KINDS)[number];
type SoundEvent = { kind: SoundKind; time: number; changeDb?: number; against?: "sub" | "mix" };
type BandPoint = { time: number; db: number; mixDb?: number };
const HOP = 0.05; // the 50 ms sub-presence ruler used on launch reels
const SILENCE_DB = -50; // RMS silence floor used to read the mix in those reels
const DIP_DB = 20; // the level below the surrounding second that reads as a gap
const GAP_S = 0.15; // the duration of a silence or dropout in the sound grid
const SUB_HZ = 60; // below the bass line in the reference energy measurements
const SUB_DELTA = 10; // reveals showed sustained sub steps of +28 and −22 dB
const SUB_SIDE = 0.45; // a short held sound on either side of an entrance
const SUB_SEARCH = 0.3; // a slow build can lead the audible edge by a quarter second
// Sub is heard within 25 dB of the whole mix: on the launch reels it sat
// 1–10 dB under it. A bass note above SUB_HZ leaks into the band through
// the window's side lobes 30 dB and more under itself, and is left out.
const SUB_UNDER_MIX = 25;
// A sub under -80 dBFS is not heard in a mix (16-bit dither sits near -90):
// steps are measured from there, not from digital zero.
const SUB_FLOOR_DB = -80;

export function percentile(xs: readonly number[], p: number): number | null {
  if (!xs.length) return null;
  const sorted = [...xs].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)]!;
}

export function findSubSteps(points: readonly BandPoint[], hopS = HOP) {
  const n = Math.ceil(SUB_SIDE / hopS);
  const possible: {
    kind: "sub_entry" | "sub_exit";
    time: number;
    changeDb: number;
    against?: "mix";
    strength: number;
  }[] = [];
  for (let i = n; i + n <= points.length; i++) {
    const before = points.slice(i - n, i).map((p) => p.db);
    const after = points.slice(i, i + n).map((p) => p.db);
    const changeDb = median(after) - median(before);
    if (Math.abs(changeDb) < SUB_DELTA) continue;
    // Check that the two sides stay apart, and put the event at the
    // strongest step rather than at the edge of a sliding window.
    const high = changeDb > 0 ? after : before;
    const low = changeDb > 0 ? before : after;
    if (percentile(high, 0.3)! - percentile(low, 0.7)! < SUB_DELTA * 0.65) continue;
    const edge = (j: number) => (points[j]!.db - points[j - 1]!.db) * Math.sign(changeDb);
    let at = i;
    for (let j = Math.max(1, i - 2); j <= Math.min(points.length - 1, i + 2); j++)
      if (edge(j) > edge(at)) at = j;
    if (edge(at) < SUB_DELTA / 3) continue;
    // With no sub on the quiet side (at the floor) the step against the floor
    // is no change anyone hears: it is read against the mix on that side, the
    // level before an entry or after an exit.
    const quiet = changeDb > 0 ? points.slice(i - n, i) : points.slice(i, i + n);
    const mix = quiet.flatMap((p) => (p.mixDb == null ? [] : [p.mixDb]));
    const absent = median(low) <= SUB_FLOOR_DB + 0.5 && mix.length > 0;
    possible.push({
      kind: changeDb > 0 ? "sub_entry" : "sub_exit",
      time: points[at]!.time,
      changeDb: absent ? Math.sign(changeDb) * (median(high) - median(mix)) : changeDb,
      ...(absent ? { against: "mix" as const } : {}),
      strength: Math.abs(changeDb),
    });
  }
  const out: typeof possible = [];
  for (const p of possible.sort((a, b) => b.strength - a.strength)) {
    if (!out.some((q) => q.kind === p.kind && Math.abs(q.time - p.time) < SUB_SIDE)) out.push(p);
  }
  return out
    .sort((a, b) => a.time - b.time)
    .map(({ strength: _, ...p }) => p);
}

const db = (power: number) => 10 * Math.log10(Math.max(1e-12, power));

function subSignal(pcm: Float32Array) {
  const signal = new Float32Array(pcm.length);
  const w = 2 * Math.PI * SUB_HZ / LISTEN_RATE;
  // A Butterworth biquad, run both ways so the filter does not shift the edge.
  const a = Math.sin(w) / Math.SQRT2;
  const c = Math.cos(w);
  const b0 = (1 - c) / (2 * (1 + a));
  const a1 = -2 * c / (1 + a);
  const a2 = (1 - a) / (1 + a);
  const pass = (source: Float32Array, first: number, end: number, step: number) => {
    let u = 0;
    let v = 0;
    for (let i = first; i !== end; i += step) {
      const x = source[i]!;
      const y = b0 * x + u;
      u = 2 * b0 * x - a1 * y + v;
      v = b0 * x - a2 * y;
      signal[i] = y;
    }
  };
  pass(pcm, 0, pcm.length, 1);
  pass(signal, signal.length - 1, -1, -1);
  return signal;
}

function refineSubSteps(steps: ReturnType<typeof findSubSteps>, pcm: Float32Array, t0: number) {
  if (!steps.length) return steps;
  const signal = subSignal(pcm);
  const rmsHalf = 0.005; // ten milliseconds of RMS on the film clock
  const hop = 0.0025; // a quarter of the RMS window to place the edge
  const slopeHalf = 0.0175; // compare over more than one cycle of a 30–60 Hz bass tone
  const envelope = (t: number) => {
    const from = Math.round((t - rmsHalf) * LISTEN_RATE);
    const to = Math.round((t + rmsHalf) * LISTEN_RATE);
    let power = 0;
    for (let i = Math.max(0, from); i < Math.min(signal.length, to); i++) power += signal[i]! ** 2;
    // A compressed RMS slope gives quiet edges a say without letting a
    // near-zero crossing dominate the way a dB difference would.
    return (power / (to - from)) ** 0.15;
  };
  return steps.map((step) => {
    const sign = step.kind === "sub_entry" ? 1 : -1;
    const edge = step.time - t0;
    const lo = Math.ceil(Math.max(rmsHalf + slopeHalf, edge - SUB_SEARCH) / hop);
    const hi = Math.floor(Math.min(signal.length / LISTEN_RATE - rmsHalf - slopeHalf,
      edge + SUB_SEARCH) / hop);
    let best = 0;
    let time = step.time;
    for (let i = lo; i <= hi; i++) {
      const t = i * hop;
      const slope = sign * (envelope(t + slopeHalf) - envelope(t - slopeHalf));
      if (slope > best) {
        best = slope;
        time = t + t0;
      }
    }
    return { ...step, time };
  });
}

function subBand(pcm: Float32Array, duration: number, t0: number) {
  // About 186 ms at the listen rate, so the FFT can separate 60 Hz from
  // the band above it. A Hann window reduces spill from that band.
  const size = 4096;
  const fft = makeFft(size);
  const re = new Float64Array(size);
  const im = new Float64Array(size);
  const taper = re.map((_, i) => 0.5 - 0.5 * Math.cos(2 * Math.PI * i / size));
  const weight = taper.reduce((s, v) => s + v, 0);
  const norm = size * taper.reduce((s, v) => s + v * v, 0);
  const points: (BandPoint & { mixDb: number; power: number; length: number })[] = [];
  for (let bin = 0; bin * HOP < duration; bin++) {
    const time = bin * HOP;
    const length = Math.min(HOP, duration - time);
    const centre = Math.round((time + length / 2 - t0) * LISTEN_RATE);
    const inStream = centre >= 0 && centre < pcm.length;
    // At the stream's ends use the nearest full window when it fits.
    // Padding a clean tone there with zeros creates a broadband edge.
    const a = inStream && pcm.length >= size
      ? Math.max(0, Math.min(pcm.length - size, centre - size / 2)) : centre - size / 2;
    let mean = 0;
    for (let i = 0; i < size; i++) mean += taper[i]! * (pcm[a + i] ?? 0);
    mean /= weight;
    for (let i = 0; i < size; i++) re[i] = taper[i]! * ((pcm[a + i] ?? 0) - mean);
    im.fill(0);
    fft(re, im);
    // Resolve a peak straddling 60 Hz before assigning its Hann main
    // lobe (two bins each way). Otherwise some of a 65 Hz note reads as
    // sub and nearly all of a 59 Hz note is left out.
    const binHz = LISTEN_RATE / size;
    const edge = SUB_HZ / binHz;
    const powerAt = (k: number) => re[k]! ** 2 + im[k]! ** 2;
    let power = 0;
    let mix = 0;
    for (let k = 1; k < size / 2; k++) {
      const p = powerAt(k);
      mix += p;
      if (k + 2 < edge) power += p;
      else if (k - 2 < edge) {
        let peak = k;
        for (let j = k - 2; j <= k + 2; j++)
          if (powerAt(j) > powerAt(peak)) peak = j;
        const mid = powerAt(peak);
        const lo = powerAt(peak - 1), hi = powerAt(peak + 1);
        let centre = peak;
        if (mid > lo && mid > hi && lo > 0 && hi > 0)
          centre += Math.log(hi / lo) / (2 * Math.log(mid ** 2 / (lo * hi)));
        if (centre < edge) power += p;
      }
    }
    power *= 2 / norm;
    mix *= 2 / norm;
    points.push({
      time: time + length / 2,
      db: Math.max(SUB_FLOOR_DB, db(power)),
      mixDb: db(mix),
      power,
      length,
    });
  }
  return points;
}

function levels(pcm: Float32Array, duration: number, t0: number) {
  const rows: { time: number; length: number; power: number; db: number }[] = [];
  // The sound grid reads short gaps on a 10 ms RMS ruler.
  const hop = 0.01;
  for (let i = 0; i * hop < duration; i++) {
    const time = i * hop;
    const length = Math.min(hop, duration - time);
    const a = Math.round((time - t0) * LISTEN_RATE);
    const b = Math.round((time + length - t0) * LISTEN_RATE);
    let sum = 0;
    for (let j = Math.max(0, a); j < Math.min(pcm.length, b); j++) sum += pcm[j]! ** 2;
    const power = sum / Math.max(1, b - a);
    rows.push({ time, length, power, db: db(power) });
  }
  return rows;
}

function soundGaps(rows: ReturnType<typeof levels>) {
  const gaps: { kind: "silence" | "relative_dip"; start: number; end: number; deepestDb: number }[] = [];
  let gap: (typeof gaps)[number] | null = null;
  for (const [i, r] of rows.entries()) {
    // The surrounding second, leaving the measurement itself out.
    const side = 50;
    const reference = median(rows.slice(Math.max(0, i - side), i)
      .concat(rows.slice(i + 1, i + side + 1)).map((p) => p.db));
    const depth = reference - r.db;
    const kind = r.db < SILENCE_DB ? "silence" : depth >= DIP_DB ? "relative_dip" : null;
    if (gap && gap.kind !== kind) {
      if (gap.end - gap.start + 1e-9 >= GAP_S) gaps.push(gap);
      gap = null;
    }
    if (!kind) continue;
    const deepestDb: number = kind === "silence" ? r.db : -depth;
    gap ??= { kind, start: r.time, end: r.time, deepestDb };
    gap.end = r.time + r.length;
    gap.deepestDb = Math.min(gap.deepestDb, deepestDb);
  }
  if (gap && gap.end - gap.start + 1e-9 >= GAP_S) gaps.push(gap);
  return gaps;
}

export function analyzeStudySound(pcm: Float32Array, duration: number, t0 = 0) {
  const audioDuration = Math.min(pcm.length / LISTEN_RATE, duration - t0);
  const s = spectrum(pcm);
  const env = onsetStrength(s);
  const times = pickOnsets(s, env, pcm).filter((t) => t >= 0 && t < audioDuration);
  const onsets = times.map((t) => t + t0);
  const tempo = estimateTempo(s, env, times, audioDuration);
  const meter = tempo ? estimateMeter(s, chromagram(pcm), tempo.beats) : null;
  const bars = meter && tempo ? tempo.beats.filter((_, i) => i % meter.beatsPerBar === meter.first) : [];
  // As in film beats, one-second marks stand in when a bar grid cannot be read.
  const marks = bars.length >= 4 ? bars : Array.from({ length: Math.ceil(audioDuration) }, (_, i) => i);
  const drops = findDrops(s, marks, audioDuration).map((t) => t + t0);
  const sections = s.level.length && audioDuration > 0 ? findSections(s, times, audioDuration) : [];
  const low = bandOnsetStrength(s, 40, 200);
  const middle = bandOnsetStrength(s, 200, 2000);
  const high = bandOnsetStrength(s, 2000, 10000);
  const window = Math.round(0.5 / s.hopS); // the surrounding second for a hit
  const search = Math.ceil(0.05 / s.hopS); // allow for beats' onset time refinement
  const hits: number[] = [];
  const strong = percentile(Array.from(env).filter((v) => v > 0), 0.92) ?? Infinity;
  for (const t of times) {
    const f = Math.round((t - s.frameTime(0)) / s.hopS);
    let peak = 0;
    for (let i = Math.max(0, f - search); i <= Math.min(env.length - 1, f + search); i++)
      if (env[i]! > env[peak]!) peak = i;
    if (env[peak]! < strong || Math.min(low[peak]!, middle[peak]!, high[peak]!) < 1) continue;
    const base = Array.from(env.subarray(Math.max(0, peak - window), peak + window + 1));
    const p90 = percentile(base, 0.9) ?? 0;
    // An impact should stand over nearby drums and have attack in every band.
    if (env[peak]! >= 1.6 * p90) hits.push(t + t0);
  }
  const rows = levels(pcm, duration, t0);
  const sub = subBand(pcm, duration, t0);
  const active = rows.filter((r) => r.db >= SILENCE_DB);
  const loudness = active.map((r) => r.db);
  const subFloor = Math.max(-70, (percentile(sub.map((r) => r.db), 0.99) ?? -120) - 20);
  // The launch reel measure counts sub within 20 dB of its upper percentile,
  // and here only where it is part of what is heard (SUB_UNDER_MIX).
  const subTime = sub.filter((r) => r.db >= subFloor && r.db >= r.mixDb - SUB_UNDER_MIX)
    .reduce((sum, r) => sum + r.length, 0);
  const totalPower = rows.reduce((sum, r) => sum + r.power * r.length, 0);
  const subPower = sub.reduce((sum, r) => sum + r.power * r.length, 0);
  // Sound coming back after digital silence, or stopping into it, is the
  // silence's edge (in gaps), not a sub entrance or exit or an impact. A
  // quiet room under the silence floor still counts: a sub can swell out
  // of it.
  const silentAround = (from: number, to: number) => {
    const span = rows.filter((r) => r.time + r.length > from && r.time < to);
    return span.length > 0 && median(span.map((r) => r.db)) < SUB_FLOOR_DB - 10;
  };
  const subSteps = refineSubSteps(findSubSteps(sub), pcm, t0).filter((step) =>
    step.kind === "sub_entry" ? !silentAround(step.time - SUB_SIDE, step.time - HOP)
      : !silentAround(step.time + HOP, step.time + SUB_SIDE));
  const events: SoundEvent[] = [
    ...onsets.map((time): SoundEvent => ({ kind: "onset", time })),
    ...hits.filter((time) => !silentAround(time - 0.1, time - 0.01) && !silentAround(time + 0.01, time + 0.1))
      .map((time): SoundEvent => ({ kind: "hit", time })),
    ...subSteps,
    ...drops.map((time): SoundEvent => ({ kind: "drop", time })),
  ];
  events.sort((a, b) => a.time - b.time);
  return {
    events,
    gaps: soundGaps(rows),
    sections: sections.map((sec) => ({ ...sec, start: sec.start + t0, end: sec.end + t0 })),
    changes: (soundChanges(pcm) ?? []).map((c) => ({ ...c, t: c.t + t0 })),
    bpm: tempo?.bpm ?? null,
    bedShare: active.reduce((sum, r) => sum + r.length, 0) / duration,
    bedSpreadDb: active.length ? percentile(loudness, 0.9)! - percentile(loudness, 0.1)! : null,
    subShare: subTime / duration,
    subRelativeDb: totalPower > 0 && subTime > 0 ? db(subPower / totalPower) : null,
  };
}

export type SoundAnalysis = ReturnType<typeof analyzeStudySound>;

export const eventTimes = (sound: SoundAnalysis | null, kind: SoundKind) =>
  sound?.events.filter((e) => e.kind === kind).map((e) => e.time) ?? [];

// Each draw keeps the same lengths. Only the order changes, and the first
// and last edges remain fixed. For a short film, many draws can be identical.
export function shuffledNull(
  lengths: readonly number[],
  events: readonly number[],
  frameS: number,
  { start = 0, seed = 1, shuffles = 1000 }: { start?: number; seed?: number; shuffles?: number } = {},
) {
  if (lengths.length < 2 || !events.length || shuffles < 1 || frameS <= 0) return null;
  const times = [...events].sort((a, b) => a - b);
  const count = (order: readonly number[]) => {
    let t = start;
    let n = 0;
    for (let i = 0; i < order.length - 1; i++) {
      t += order[i]!;
      // nearestOffset is rounded to the millisecond, so use its value
      // only for the report. Check the edge of the null window at full precision.
      let lo = 0;
      let hi = times.length;
      while (lo < hi) {
        const m = (lo + hi) >>> 1;
        if (times[m]! < t - frameS - 1e-9) lo = m + 1;
        else hi = m;
      }
      if (lo < times.length && times[lo]! <= t + frameS + 1e-9) n++;
    }
    return n;
  };
  // Fixed generator and a 1,000-draw budget for a repeatable reference pack.
  let rng = seed >>> 0;
  const random = () => {
    rng = (Math.imul(1664525, rng) + 1013904223) >>> 0;
    return rng / 2 ** 32;
  };
  const observed = count(lengths);
  const total = lengths.length - 1;
  const draws: number[] = [];
  let greater = 0;
  for (let k = 0; k < shuffles; k++) {
    const order = [...lengths];
    for (let i = order.length - 1; i > 0; i--) {
      const j = Math.floor(random() * (i + 1));
      [order[i], order[j]] = [order[j]!, order[i]!];
    }
    const n = count(order);
    draws.push(n / total);
    if (n >= observed) greater++;
  }
  const duration = lengths.reduce((a, b) => a + b, 0);
  return {
    realShare: observed / total,
    nullMean: draws.reduce((a, b) => a + b, 0) / shuffles,
    nullP95: percentile(draws, 0.95)!,
    p: (greater + 1) / (shuffles + 1),
    uniformShare: chanceWithin(times.map((t) => t - start), duration, frameS),
    windowS: frameS,
    shuffles,
    seed,
  };
}

export function soundOffsets(sound: SoundAnalysis | null, t: number) {
  const byKind = Object.fromEntries(SOUND_KINDS.map((kind) =>
    [kind, nearestOffset(eventTimes(sound, kind), t)])) as Record<SoundKind, number | null>;
  // Use full event times to break ties between kinds whose rounded offsets agree.
  let event: SoundEvent | null = null;
  for (const e of sound?.events ?? []) {
    if (!event || Math.abs(e.time - t) < Math.abs(event.time - t) ||
      (e.time === event.time && event.kind === "onset" && e.kind !== "onset")) event = e;
  }
  return { byKind, event, offset: event ? event.time - t : null };
}
