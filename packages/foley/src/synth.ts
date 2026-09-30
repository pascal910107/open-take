// The procedural voices — one per role, rendered on demand from a seed.
//
// Why synthesize instead of shipping samples: a cue sheet asks for a tap at a
// pitch, a length and a seed, and gets a tap that is THAT tap — twenty avatar
// landings become twenty slightly different taps, the way a foley artist's
// hands never repeat exactly, with no sample library to license and no two
// projects sounding like the same pack. Files can still override any role
// (library.ts) once ears have picked something better; the synth is the
// floor every install has.
//
// Everything is pure: same (role, params) → same samples, bit for bit.

import type { FoleyRole } from "./cues";

export type VoiceParams = {
  sampleRate: number;
  /** seconds; the voice fits itself to this (a whoosh stretches, a tap ignores
   *  most of it and just decays) */
  durationS: number;
  /** semitones from the role's base */
  pitch: number;
  seed: number;
};

// --- seeded noise ------------------------------------------------------

/** mulberry32: small, fast, deterministic. */
export function rng(seed: number): () => number {
  let a = seed >>> 0 || 0x9e3779b9;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// --- filters (RBJ biquads) --------------------------------------------

type Biquad = { b0: number; b1: number; b2: number; a1: number; a2: number };

function bandpass(fc: number, q: number, sr: number): Biquad {
  const w = (2 * Math.PI * Math.min(fc, sr * 0.45)) / sr;
  const alpha = Math.sin(w) / (2 * q);
  const a0 = 1 + alpha;
  // constant 0 dB peak gain
  return {
    b0: alpha / a0,
    b1: 0,
    b2: -alpha / a0,
    a1: (-2 * Math.cos(w)) / a0,
    a2: (1 - alpha) / a0,
  };
}

function lowpass(fc: number, q: number, sr: number): Biquad {
  const w = (2 * Math.PI * Math.min(fc, sr * 0.45)) / sr;
  const c = Math.cos(w);
  const alpha = Math.sin(w) / (2 * q);
  const a0 = 1 + alpha;
  return {
    b0: (1 - c) / 2 / a0,
    b1: (1 - c) / a0,
    b2: (1 - c) / 2 / a0,
    a1: (-2 * c) / a0,
    a2: (1 - alpha) / a0,
  };
}

function highpass(fc: number, q: number, sr: number): Biquad {
  const w = (2 * Math.PI * Math.min(fc, sr * 0.45)) / sr;
  const c = Math.cos(w);
  const alpha = Math.sin(w) / (2 * q);
  const a0 = 1 + alpha;
  return {
    b0: (1 + c) / 2 / a0,
    b1: -(1 + c) / a0,
    b2: (1 + c) / 2 / a0,
    a1: (-2 * c) / a0,
    a2: (1 - alpha) / a0,
  };
}

/** Run a (possibly time-varying) biquad over `x`. `coef(i)` is re-evaluated
 *  every `block` samples so a sweeping filter stays cheap. */
function filter(x: Float32Array, coef: (i: number) => Biquad, block = 32): Float32Array {
  const y = new Float32Array(x.length);
  let x1 = 0,
    x2 = 0,
    y1 = 0,
    y2 = 0;
  let c = coef(0);
  for (let i = 0; i < x.length; i++) {
    if (i % block === 0) c = coef(i);
    const xi = x[i]!;
    const yi = c.b0 * xi + c.b1 * x1 + c.b2 * x2 - c.a1 * y1 - c.a2 * y2;
    x2 = x1;
    x1 = xi;
    y2 = y1;
    y1 = yi;
    y[i] = yi;
  }
  return y;
}

// --- building blocks ---------------------------------------------------

const semis = (n: number) => 2 ** (n / 12);

function noise(n: number, r: () => number): Float32Array {
  const y = new Float32Array(n);
  for (let i = 0; i < n; i++) y[i] = r() * 2 - 1;
  return y;
}

/** A sine whose frequency follows `freq(t)` (Hz), phase-accumulated so a
 *  sweep never clicks. */
function tone(n: number, sr: number, freq: (t: number) => number, phase0 = 0): Float32Array {
  const y = new Float32Array(n);
  let ph = phase0;
  for (let i = 0; i < n; i++) {
    y[i] = Math.sin(ph);
    ph += (2 * Math.PI * freq(i / sr)) / sr;
  }
  return y;
}

const expDecay = (tau: number) => (t: number) => Math.exp(-t / tau);

function shape(x: Float32Array, sr: number, env: (t: number) => number): Float32Array {
  const y = new Float32Array(x.length);
  for (let i = 0; i < x.length; i++) y[i] = x[i]! * env(i / sr);
  return y;
}

function mixInto(dst: Float32Array, src: Float32Array, gain = 1, offset = 0): void {
  const n = Math.min(src.length, dst.length - offset);
  for (let i = 0; i < n; i++) dst[i + offset]! += src[i]! * gain;
}

/** Attack ramp so nothing starts with a click. */
function attack(x: Float32Array, sr: number, s: number): Float32Array {
  const n = Math.max(1, Math.round(s * sr));
  for (let i = 0; i < n && i < x.length; i++) x[i]! *= i / n;
  return x;
}

function release(x: Float32Array, sr: number, s: number): Float32Array {
  const n = Math.max(1, Math.round(s * sr));
  for (let i = 0; i < n && i < x.length; i++) x[x.length - 1 - i]! *= i / n;
  return x;
}

function normalize(x: Float32Array, peak = 1): Float32Array {
  let m = 0;
  for (let i = 0; i < x.length; i++) m = Math.max(m, Math.abs(x[i]!));
  if (m > 0) for (let i = 0; i < x.length; i++) x[i]! *= peak / m;
  return x;
}

/** Soft saturation: a touch of body on hits. */
function saturate(x: Float32Array, drive: number): Float32Array {
  const k = Math.tanh(drive);
  for (let i = 0; i < x.length; i++) x[i] = Math.tanh(x[i]! * drive) / k;
  return x;
}

/** Bell envelope peaking at `peakAt` (fraction of duration): sin² rise, sin² fall. */
const bell = (dur: number, peakAt: number) => (t: number) => {
  const u = t / dur;
  if (u <= 0 || u >= 1) return 0;
  if (u < peakAt) return Math.sin((Math.PI / 2) * (u / peakAt)) ** 2;
  return Math.cos((Math.PI / 2) * ((u - peakAt) / (1 - peakAt))) ** 2;
};

// --- the voices ----------------------------------------------------------

type Voice = (p: VoiceParams) => Float32Array;

/** A soft "tock": a short high sine that drops in pitch as it decays, with a
 *  2 ms breath of noise on the front. The avatar-landing sound. */
const tap: Voice = ({ sampleRate: sr, pitch, seed }) => {
  const r = rng(seed);
  const n = Math.round(0.09 * sr);
  const f0 = 1500 * semis(pitch) * (0.97 + r() * 0.06);
  const body = shape(
    tone(n, sr, (t) => f0 * (1 - 0.18 * Math.min(1, t / 0.012))),
    sr,
    expDecay(0.016 + r() * 0.004),
  );
  const click = shape(
    filter(noise(n, r), () => bandpass(3500, 1.2, sr)),
    sr,
    expDecay(0.0015),
  );
  const out = new Float32Array(n);
  mixInto(out, body, 1);
  mixInto(out, click, 0.5);
  return normalize(
    attack(
      filter(out, () => lowpass(6500, 0.7, sr)),
      sr,
      0.0005,
    ),
  );
};

/** A keystroke: a noise burst through a mid band plus a low "thock", and a
 *  quieter release click 45 ms later — keys go down AND up. */
const key: Voice = ({ sampleRate: sr, pitch, seed }) => {
  const r = rng(seed);
  const n = Math.round(0.11 * sr);
  const press = shape(
    filter(noise(n, r), () => bandpass(1500 * semis(pitch) * (0.9 + r() * 0.2), 0.8, sr)),
    sr,
    expDecay(0.006),
  );
  const thock = shape(
    tone(n, sr, () => 190 * semis(pitch)),
    sr,
    expDecay(0.012),
  );
  const rel = shape(
    filter(noise(n, r), () => bandpass(2300 * semis(pitch), 1.1, sr)),
    sr,
    expDecay(0.004),
  );
  const out = new Float32Array(n);
  mixInto(out, press, 1);
  mixInto(out, thock, 0.7);
  mixInto(out, rel, 0.35, Math.round((0.042 + r() * 0.012) * sr));
  return normalize(
    attack(
      filter(out, () => lowpass(6500, 0.7, sr)),
      sr,
      0.0003,
    ),
  );
};

/** A mouse click: sharper and brighter than a key, with its release 70 ms on. */
const click: Voice = ({ sampleRate: sr, pitch, seed }) => {
  const r = rng(seed);
  const n = Math.round(0.12 * sr);
  const down = shape(
    filter(noise(n, r), () => bandpass(4200 * semis(pitch), 1.4, sr)),
    sr,
    expDecay(0.003),
  );
  const body = shape(
    tone(n, sr, () => 900 * semis(pitch)),
    sr,
    expDecay(0.007),
  );
  const up = shape(
    filter(noise(n, r), () => bandpass(5200 * semis(pitch), 1.6, sr)),
    sr,
    expDecay(0.0025),
  );
  const out = new Float32Array(n);
  mixInto(out, down, 1);
  mixInto(out, body, 0.5);
  mixInto(out, up, 0.55, Math.round((0.065 + r() * 0.015) * sr));
  return normalize(attack(out, sr, 0.0003));
};

/** A bubble pop: a sine that falls an octave and a half in 50 ms — the
 *  water-drop shape — with its second harmonic for the "digital" gloss. */
const pop: Voice = ({ sampleRate: sr, pitch, seed }) => {
  const r = rng(seed);
  const n = Math.round(0.16 * sr);
  const f0 = 520 * semis(pitch) * (0.95 + r() * 0.1);
  const sweep = (t: number) => f0 * (1.9 - 1.3 * Math.min(1, t / 0.05));
  const fund = shape(tone(n, sr, sweep), sr, expDecay(0.035));
  const harm = shape(
    tone(n, sr, (t) => 2 * sweep(t)),
    sr,
    expDecay(0.02),
  );
  const tick = shape(
    filter(noise(n, r), () => highpass(3000, 0.7, sr)),
    sr,
    expDecay(0.001),
  );
  const out = new Float32Array(n);
  mixInto(out, fund, 1);
  mixInto(out, harm, 0.35);
  mixInto(out, tick, 0.4);
  return normalize(attack(out, sr, 0.0005));
};

/** Noise through a band whose centre sweeps low → high → mid under a bell
 *  envelope. `peakAt` is where the whoosh is loudest — an arrival sound peaks
 *  late, a departure early. */
function whooshLike(
  p: VoiceParams,
  opts: { lo: number; hi: number; end: number; q: number; peakAt: number; hp: number; lp: number },
): Float32Array {
  const { sampleRate: sr, pitch, seed } = p;
  const dur = Math.max(0.15, p.durationS);
  const n = Math.round(dur * sr);
  const r = rng(seed);
  const k = semis(pitch);
  const fc = (t: number) => {
    const u = t / dur;
    if (u < opts.peakAt) return (opts.lo + (opts.hi - opts.lo) * (u / opts.peakAt) ** 1.4) * k;
    return (opts.hi + (opts.end - opts.hi) * ((u - opts.peakAt) / (1 - opts.peakAt)) ** 0.8) * k;
  };
  let y = filter(noise(n, r), (i) => bandpass(fc(i / sr), opts.q, sr), 16);
  y = filter(y, () => highpass(opts.hp, 0.7, sr));
  y = filter(y, () => lowpass(opts.lp, 0.7, sr));
  y = shape(y, sr, bell(dur, opts.peakAt));
  return normalize(release(y, sr, 0.01));
}

/** The small whoosh: a thing moving across the frame. */
const whoosh: Voice = (p) =>
  whooshLike(p, { lo: 260, hi: 1900, end: 650, q: 2.2, peakAt: 0.42, hp: 120, lp: 5500 });

/** The airy whoosh: higher, softer, wider — a transition, a pull-out. */
const air: Voice = (p) =>
  whooshLike(p, { lo: 900, hi: 3800, end: 1700, q: 1.0, peakAt: 0.5, hp: 500, lp: 9000 });

/** Noise climbing an exponential band over the whole duration, louder as it
 *  climbs, plus a faint tone rising an octave underneath. It stops — the hit
 *  that follows is what it was for. */
const riser: Voice = ({ sampleRate: sr, durationS, pitch, seed }) => {
  const dur = Math.max(0.4, durationS);
  const n = Math.round(dur * sr);
  const r = rng(seed);
  const k = semis(pitch);
  // two passes: the skirts of one biquad leave too much hiss under the sweep
  const sweep = (i: number) =>
    bandpass(220 * k * (3800 / 220) ** Math.min(1, i / sr / dur), 2.0, sr);
  const band = filter(filter(noise(n, r), sweep, 16), sweep, 16);
  const ramp = (t: number) => Math.min(1, t / dur) ** 1.3;
  const out = shape(band, sr, ramp);
  const under = shape(
    tone(n, sr, (t) => 110 * k * 2 ** Math.min(1, t / dur)),
    sr,
    (t) => 0.35 * ramp(t),
  );
  mixInto(out, under, 1);
  return normalize(release(attack(out, sr, 0.02), sr, 0.03));
};

/** A cinematic impact: a lowpassed noise slap and a sine that falls from 160
 *  to 45 Hz, saturated for body. */
const impact: Voice = ({ sampleRate: sr, pitch, seed }) => {
  const r = rng(seed);
  const n = Math.round(0.7 * sr);
  const k = semis(pitch);
  const slap = shape(
    filter(noise(n, r), () => lowpass(3800, 0.8, sr)),
    sr,
    expDecay(0.03),
  );
  const body = shape(
    tone(n, sr, (t) => k * (45 + 115 * Math.exp(-t / 0.07))),
    sr,
    expDecay(0.19),
  );
  const out = new Float32Array(n);
  mixInto(out, slap, 0.8);
  mixInto(out, body, 1);
  return normalize(release(attack(saturate(out, 1.8), sr, 0.001), sr, 0.05));
};

/** A soft boom: sub sine sliding 52 → 34 Hz with a long tail. Felt more than
 *  heard — it is what makes the impact land. */
const boom: Voice = ({ sampleRate: sr, durationS, pitch, seed }) => {
  const r = rng(seed);
  const dur = Math.max(1.2, durationS);
  const n = Math.round(dur * sr);
  const k = semis(pitch);
  const f = (t: number) => k * (34 + 18 * Math.exp(-t / 0.25));
  const sub = shape(tone(n, sr, f, r() * 0.1), sr, expDecay(dur * 0.35));
  const second = shape(
    tone(n, sr, (t) => 2 * f(t)),
    sr,
    expDecay(dur * 0.12),
  );
  const out = new Float32Array(n);
  mixInto(out, sub, 1);
  mixInto(out, second, 0.25);
  return normalize(
    release(
      attack(
        filter(out, () => lowpass(140, 0.7, sr)),
        sr,
        0.004,
      ),
      sr,
      0.1,
    ),
  );
};

/** A light chime: four inharmonic-ish partials, each with its own decay, a
 *  hair detuned so it shimmers. */
const chime: Voice = ({ sampleRate: sr, durationS, pitch, seed }) => {
  const r = rng(seed);
  const dur = Math.max(0.8, durationS);
  const n = Math.round(dur * sr);
  const f0 = 1046.5 * semis(pitch);
  const partials: [number, number, number][] = [
    [1, 1, 0.55 * dur],
    [2.0, 0.5, 0.35 * dur],
    [3.01, 0.28, 0.22 * dur],
    [4.2, 0.14, 0.15 * dur],
  ];
  const out = new Float32Array(n);
  for (const [ratio, amp, tau] of partials) {
    const det = 1 + (r() - 0.5) * 0.004;
    mixInto(
      out,
      shape(
        tone(n, sr, () => f0 * ratio * det, r() * 6.28),
        sr,
        expDecay(tau),
      ),
      amp,
    );
  }
  const strike = shape(
    filter(noise(n, r), () => bandpass(f0 * 2, 2, sr)),
    sr,
    expDecay(0.004),
  );
  mixInto(out, strike, 0.5);
  return normalize(release(attack(out, sr, 0.002), sr, 0.05));
};

/** A UI blip: two soft tones, the second a fifth up. */
const ui: Voice = ({ sampleRate: sr, pitch, seed }) => {
  const r = rng(seed);
  const n = Math.round(0.16 * sr);
  const k = semis(pitch) * (0.98 + r() * 0.04);
  const a = shape(
    tone(n, sr, () => 620 * k),
    sr,
    (t) => (t < 0.045 ? 1 : Math.exp(-(t - 0.045) / 0.01)),
  );
  const b = shape(
    tone(n, sr, () => 930 * k),
    sr,
    (t) => (t < 0.06 ? 1 : Math.exp(-(t - 0.06) / 0.025)),
  );
  const out = new Float32Array(n);
  mixInto(out, attack(a, sr, 0.004), 0.8);
  mixInto(out, attack(b, sr, 0.004), 1, Math.round(0.05 * sr));
  return normalize(filter(out, () => lowpass(4000, 0.7, sr)));
};

/** A notification: E5 then A5, sine with a faint octave. Warm, not alarming. */
const notify: Voice = ({ sampleRate: sr, pitch, seed }) => {
  const r = rng(seed);
  const n = Math.round(0.5 * sr);
  const k = semis(pitch);
  const note = (f: number, tau: number) => {
    const m = Math.round(0.3 * sr);
    const y = shape(
      tone(m, sr, () => f, r() * 6.28),
      sr,
      expDecay(tau),
    );
    mixInto(
      y,
      shape(
        tone(m, sr, () => 2 * f),
        sr,
        expDecay(tau * 0.6),
      ),
      0.2,
    );
    return attack(y, sr, 0.003);
  };
  const out = new Float32Array(n);
  mixInto(out, note(659.3 * k, 0.11), 0.85);
  mixInto(out, note(880 * k, 0.16), 1, Math.round(0.13 * sr));
  return normalize(out);
};

/** The smallest sound: a 3 ms bright tick. */
const tick: Voice = ({ sampleRate: sr, pitch, seed }) => {
  const r = rng(seed);
  const n = Math.round(0.03 * sr);
  const y = shape(
    filter(noise(n, r), () => bandpass(5500 * semis(pitch), 2, sr)),
    sr,
    expDecay(0.0012),
  );
  mixInto(
    y,
    shape(
      tone(n, sr, () => 2100 * semis(pitch)),
      sr,
      expDecay(0.003),
    ),
    0.4,
  );
  return normalize(attack(y, sr, 0.0002));
};

export const VOICES: Record<FoleyRole, Voice> = {
  tap,
  key,
  click,
  pop,
  whoosh,
  air,
  riser,
  impact,
  boom,
  chime,
  ui,
  notify,
  tick,
};

/** Render one role's voice, peak-normalised to 1.0, mono. */
export function synthesize(role: FoleyRole, params: VoiceParams): Float32Array {
  return VOICES[role](params);
}
