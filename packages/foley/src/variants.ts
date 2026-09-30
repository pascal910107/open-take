// Alternative voices, by design rather than by seed: where the built-in
// voice of a role is one answer, these are the others a listener can pick
// from (a softer key, a deeper whoosh, a tonal swish, a trackpad tap, an FM
// bell, a cinematic hit). A style selects them per role; everything stays
// procedural, pure and seeded, like synth.ts.

import { oscillate, rng, SR, saturate, svf, whiteNoise } from "./dsp";
import type { VoiceParams } from "./synth";

type Voice = (p: VoiceParams) => Float32Array;

const semis = (n: number) => 2 ** (n / 12);

function normalize(x: Float32Array): Float32Array {
  let m = 0;
  for (let i = 0; i < x.length; i++) m = Math.max(m, Math.abs(x[i]!));
  if (m > 0) for (let i = 0; i < x.length; i++) x[i]! /= m;
  return x;
}

function fade(x: Float32Array, sr: number, inS: number, outS: number): Float32Array {
  const a = Math.max(1, Math.round(inS * sr));
  const b = Math.max(1, Math.round(outS * sr));
  for (let i = 0; i < a && i < x.length; i++) x[i]! *= i / a;
  for (let i = 0; i < b && i < x.length; i++) x[x.length - 1 - i]! *= i / b;
  return x;
}

/** A laptop key: short, muted, low — the press is a dull tap, the release a
 *  whisper. For long typing passages that should not tire the ear. */
const keySoft: Voice = ({ sampleRate: sr, pitch, seed }) => {
  const r = rng(seed);
  const n = Math.round(0.09 * sr);
  const y = new Float32Array(n);
  const press = whiteNoise(n, seed);
  svf(press, "band", () => 950 * semis(pitch) * (0.9 + r() * 0.2), 0.7, sr);
  for (let i = 0; i < n; i++) y[i]! += press[i]! * Math.exp(-i / sr / 0.007);
  oscillate(
    y,
    0,
    n,
    () => 150 * semis(pitch),
    "sine",
    (i) => 0.6 * Math.exp(-i / sr / 0.01),
    0,
    sr,
  );
  const rel = whiteNoise(n, seed ^ 0x1f);
  svf(rel, "band", () => 1400 * semis(pitch), 1, sr);
  const at = Math.round((0.038 + r() * 0.01) * sr);
  for (let i = at; i < n; i++) y[i]! += rel[i]! * 0.25 * Math.exp(-(i - at) / sr / 0.004);
  svf(y, "low", () => 3600, 0.7, sr);
  return normalize(fade(y, sr, 0.0004, 0.01));
};

/** A trackpad tap: a soft, rounded thump with the faintest tick on top. */
const clickTrackpad: Voice = ({ sampleRate: sr, pitch, seed }) => {
  const n = Math.round(0.07 * sr);
  const y = new Float32Array(n);
  oscillate(
    y,
    0,
    n,
    (i) => 240 * semis(pitch) * (1 - 0.25 * Math.min(1, i / sr / 0.015)),
    "sine",
    (i) => Math.exp(-i / sr / 0.014),
    0,
    sr,
  );
  const tick = whiteNoise(n, seed);
  svf(tick, "band", () => 2600 * semis(pitch), 1.2, sr);
  for (let i = 0; i < n; i++) y[i]! += tick[i]! * 0.35 * Math.exp(-i / sr / 0.0025);
  svf(y, "low", () => 5000, 0.7, sr);
  return normalize(fade(y, sr, 0.0005, 0.01));
};

/** Band-passed noise under a bell envelope with a moving centre. */
function swish(
  p: VoiceParams,
  o: { lo: number; hi: number; end: number; q: number; peakAt: number; hp: number; lp: number },
): Float32Array {
  const { sampleRate: sr, pitch, seed } = p;
  const dur = Math.max(0.2, p.durationS);
  const n = Math.round(dur * sr);
  const k = semis(pitch);
  const y = whiteNoise(n, seed);
  svf(
    y,
    "band",
    (i) => {
      const u = i / n;
      return (
        (u < o.peakAt
          ? o.lo + (o.hi - o.lo) * (u / o.peakAt) ** 1.3
          : o.hi + (o.end - o.hi) * ((u - o.peakAt) / (1 - o.peakAt))) * k
      );
    },
    o.q,
    sr,
  );
  svf(y, "high", () => o.hp, 0.7, sr);
  svf(y, "low", () => o.lp, 0.7, sr);
  for (let i = 0; i < n; i++) {
    const u = i / n;
    const e =
      u < o.peakAt
        ? Math.sin((Math.PI / 2) * (u / o.peakAt)) ** 2
        : Math.cos((Math.PI / 2) * ((u - o.peakAt) / (1 - o.peakAt))) ** 2;
    y[i]! *= e;
  }
  return y;
}

/** A deep swoosh: a low band that swells with the move, a sub glide under it. */
const whooshDeep: Voice = (p) => {
  const y = swish(p, { lo: 110, hi: 800, end: 260, q: 1.3, peakAt: 0.5, hp: 50, lp: 2600 });
  const sr = p.sampleRate;
  const n = y.length;
  oscillate(
    y,
    0,
    n,
    (i) => 62 - 22 * (i / n),
    "sine",
    (i) => 0.35 * Math.sin(Math.PI * Math.min(1, i / n)) ** 2,
    0,
    sr,
  );
  return normalize(fade(y, sr, 0.005, 0.02));
};

/** A medium swoosh: the deep one's body without its weight — less sub, a
 *  higher band, a shorter tail. */
const whooshMedium: Voice = (p) => {
  const y = swish(p, { lo: 170, hi: 1200, end: 420, q: 1.3, peakAt: 0.46, hp: 80, lp: 3400 });
  const sr = p.sampleRate;
  const n = y.length;
  oscillate(
    y,
    0,
    n,
    (i) => 78 - 20 * (i / n),
    "sine",
    (i) => 0.16 * Math.sin(Math.PI * Math.min(1, i / n)) ** 2,
    0,
    sr,
  );
  return normalize(fade(y, sr, 0.005, 0.02));
};

/** A tonal swish: bright air with a pitched glide inside it — the modern
 *  interface "slide". */
const whooshTonal: Voice = (p) => {
  const y = swish(p, { lo: 1500, hi: 6200, end: 3000, q: 1.1, peakAt: 0.45, hp: 900, lp: 12000 });
  const sr = p.sampleRate;
  const n = y.length;
  const k = semis(p.pitch);
  oscillate(
    y,
    0,
    n,
    (i) => k * (520 + 700 * (i / n) ** 0.7),
    "sine",
    (i) => 0.22 * Math.sin(Math.PI * Math.min(1, i / n)) ** 2,
    0,
    sr,
  );
  return normalize(fade(y, sr, 0.005, 0.02));
};

/** An FM bell (1 : 3.5) that answers itself a fifth up — a sparkle, not a gong. */
const chimeFm: Voice = ({ sampleRate: sr, durationS, pitch }) => {
  const dur = Math.max(1, durationS);
  const n = Math.round(dur * sr);
  const y = new Float32Array(n);
  const note = (f: number, at: number, amp: number) => {
    for (let i = Math.round(at * sr); i < n; i++) {
      const t = i / sr - at;
      const index = 1.8 * Math.exp(-t / 0.25);
      y[i]! +=
        amp *
        Math.sin(2 * Math.PI * f * t + index * Math.sin(2 * Math.PI * 3.5 * f * t)) *
        Math.min(1, t / 0.002) *
        Math.exp(-t / 0.8);
    }
  };
  const f = 1318.5 * semis(pitch);
  note(f, 0, 1);
  note(f * 1.4983, 0.09, 0.7);
  return normalize(fade(y, sr, 0.001, 0.08));
};

/** A cinematic hit: a low drum body falling in pitch, a noise punch and a
 *  little drive — the trailer downbeat. */
const impactCinematic: Voice = ({ sampleRate: sr, pitch, seed }) => {
  const n = Math.round(1.1 * sr);
  const y = new Float32Array(n);
  const k = semis(pitch);
  oscillate(
    y,
    0,
    n,
    (i) => k * (48 + 70 * Math.exp(-i / sr / 0.05)),
    "sine",
    (i) => Math.exp(-i / sr / 0.32),
    0,
    sr,
  );
  const punch = whiteNoise(n, seed);
  svf(punch, "low", () => 1600, 0.7, sr);
  for (let i = 0; i < n; i++) y[i]! += punch[i]! * 0.7 * Math.exp(-i / sr / 0.035);
  const air = whiteNoise(n, seed ^ 0x77);
  svf(air, "high", () => 3000, 0.7, sr);
  for (let i = 0; i < n; i++) y[i]! += air[i]! * 0.12 * Math.exp(-i / sr / 0.25);
  return normalize(fade(saturate(y, 1.6), sr, 0.0008, 0.08));
};

/** Voices by id, `role.name`. */
export const VARIANT_VOICES: Record<string, Voice> = {
  "key.soft": keySoft,
  "click.trackpad": clickTrackpad,
  "whoosh.deep": whooshDeep,
  "whoosh.medium": whooshMedium,
  "whoosh.tonal": whooshTonal,
  "chime.fm": chimeFm,
  "impact.cinematic": impactCinematic,
};

export function synthesizeVariant(id: string, params: VoiceParams): Float32Array {
  const v = VARIANT_VOICES[id];
  if (!v) throw new Error(`unknown voice variant ${JSON.stringify(id)}`);
  return v(params);
}

export { SR as VARIANT_SAMPLE_RATE };
