// The mix: every cue's voice, at its sample offset, at its level, panned —
// summed into a stereo buffer and soft-limited. In-process, sample-accurate,
// deterministic.

import type { Cue, CueSheet } from "./cues";
import { type Library, voiceFor } from "./library";
import { encodeWav, type Pcm } from "./wav";

export type MixOpts = {
  sampleRate?: number;
  library?: Library;
  /** subtract this from every cue time (a delivered head trim); cues that end
   *  before 0 are dropped */
  offsetS?: number;
  /** override the sheet's length (seconds) */
  durationS?: number;
};

const dbToLin = (db: number) => 10 ** (db / 20);

/** Soft knee above 0.8: a hit stack can sum past full scale; this keeps the
 *  peak inside 1.0 without a hard clip's edge. */
function limit(v: number): number {
  const a = Math.abs(v);
  if (a <= 0.8) return v;
  return Math.sign(v) * (0.8 + 0.2 * Math.tanh((a - 0.8) / 0.2));
}

export function mixCues(sheet: CueSheet, opts: MixOpts = {}): Pcm {
  const sr = opts.sampleRate ?? 48000;
  const offset = opts.offsetS ?? 0;
  const total = Math.max(0.01, (opts.durationS ?? sheet.durationS) - offset);
  const n = Math.ceil(total * sr);
  const L = new Float32Array(n);
  const R = new Float32Array(n);
  for (const cue of sheet.cues) {
    const at = cue.atS - offset;
    if (at + cue.durationS <= 0 || at >= total) continue;
    const voice = voiceFor(
      cue.role,
      { sampleRate: sr, durationS: cue.durationS, pitch: cue.pitch, seed: cue.seed },
      opts.library,
    );
    const g = dbToLin(cue.gainDb);
    // constant-power pan
    const th = ((cue.pan + 1) / 2) * (Math.PI / 2);
    const gl = g * Math.cos(th);
    const gr = g * Math.sin(th);
    const start = Math.round(at * sr);
    for (let i = 0; i < voice.length; i++) {
      const j = start + i;
      if (j < 0) continue;
      if (j >= n) break;
      L[j]! += voice[i]! * gl;
      R[j]! += voice[i]! * gr;
    }
  }
  for (let i = 0; i < n; i++) {
    L[i] = limit(L[i]!);
    R[i] = limit(R[i]!);
  }
  return { sampleRate: sr, channels: [L, R] };
}

export function mixToWav(sheet: CueSheet, opts: MixOpts = {}): Buffer {
  return encodeWav(mixCues(sheet, opts));
}

/** Peak (dBFS) of a mix — for reports and tests. */
export function peakDb(pcm: Pcm): number {
  let m = 0;
  for (const ch of pcm.channels)
    for (let i = 0; i < ch.length; i++) m = Math.max(m, Math.abs(ch[i]!));
  return m > 0 ? 20 * Math.log10(m) : Number.NEGATIVE_INFINITY;
}

export type CueSummary = { role: Cue["role"]; count: number; peakDb: number };

export function summarize(sheet: CueSheet): CueSummary[] {
  const by = new Map<Cue["role"], CueSummary>();
  for (const c of sheet.cues) {
    const s = by.get(c.role) ?? { role: c.role, count: 0, peakDb: Number.NEGATIVE_INFINITY };
    s.count++;
    s.peakDb = Math.max(s.peakDb, c.gainDb);
    by.set(c.role, s);
  }
  return [...by.values()].sort((a, b) => b.count - a.count);
}
