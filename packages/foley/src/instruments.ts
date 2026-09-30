// The band: procedural drums, bass, pads, plucks and bells for the music
// layer. Same contract as the foley voices — no samples, nothing to license,
// every hit rendered from its own seed so a groove never loops identically.
//
// One-shots return a peak-normalised buffer (the arrangement sets levels in
// dB). Tonal parts write straight into a bus so a chord or a bass line can be
// rendered across bar lines without stitching.

import { adsr, midiHz, oscillate, rng, SR, Svf, saturate, svf, whiteNoise } from "./dsp";

const secs = (s: number) => Math.max(1, Math.round(s * SR));

function normalize(x: Float32Array, to = 1): Float32Array {
  let m = 0;
  for (let i = 0; i < x.length; i++) m = Math.max(m, Math.abs(x[i]!));
  if (m > 0) for (let i = 0; i < x.length; i++) x[i]! *= to / m;
  return x;
}

function fadeOut(x: Float32Array, s: number): Float32Array {
  const n = Math.min(x.length, secs(s));
  for (let i = 0; i < n; i++) x[x.length - 1 - i]! *= i / n;
  return x;
}

// --- drums -----------------------------------------------------------------

/** A tuned electronic kick: a sine that drops from ~190 Hz to `endHz` in a
 *  few tens of milliseconds, a click on the front, a little saturation so it
 *  still reads on laptop speakers. `long` gives the hit version more tail. */
export type KickShape = {
  /** body decay (s); default 0.15, the hit version 0.24 */
  tau?: number;
  /** level of the front click, 0..1; default 0.3 */
  click?: number;
  /** saturation drive; default 1.4 */
  drive?: number;
  /** low-pass on the whole kick (Hz), for a rounder one */
  lp?: number;
};

export function kick(seed: number, endHz = 48, long = false, shape: KickShape = {}): Float32Array {
  const r = rng(seed);
  const n = secs(long ? 0.9 : Math.max(0.42, (shape.tau ?? 0.15) * 2.8));
  const y = new Float32Array(n);
  const start = 185 + r() * 10;
  const tau = long ? Math.max(0.24, shape.tau ?? 0) : (shape.tau ?? 0.15);
  oscillate(
    y,
    0,
    n,
    (i) => endHz + (start - endHz) * Math.exp(-i / SR / 0.032),
    "sine",
    (i) => {
      const t = i / SR;
      const a = Math.min(1, t / 0.0012);
      return a * (t < 0.018 ? 1 : Math.exp(-(t - 0.018) / tau));
    },
  );
  const click = whiteNoise(n, seed ^ 0x51f3);
  svf(click, "high", () => 2800, 0.7);
  const c = shape.click ?? 0.3;
  for (let i = 0; i < n; i++) y[i]! += click[i]! * c * Math.exp(-i / SR / 0.0025);
  const out = saturate(y, shape.drive ?? 1.4);
  if (shape.lp) svf(out, "low", () => shape.lp!, 0.7);
  return fadeOut(normalize(out), 0.03);
}

/** A snap: one tight, bright burst — the clap's leaner cousin. */
export function snap(seed: number): Float32Array {
  const n = secs(0.12);
  const x = whiteNoise(n, seed);
  svf(x, "band", () => 2300, 1.4);
  svf(x, "high", () => 900, 0.7);
  for (let i = 0; i < n; i++) x[i]! *= Math.min(1, i / SR / 0.0006) * Math.exp(-i / SR / 0.018);
  return fadeOut(normalize(x), 0.01);
}

/** A rim: a short woody tone with a click — a soft backbeat. */
export function rim(seed: number): Float32Array {
  const n = secs(0.08);
  const y = new Float32Array(n);
  oscillate(
    y,
    0,
    n,
    () => 1650,
    "sine",
    (i) => 0.7 * Math.exp(-i / SR / 0.009),
  );
  oscillate(
    y,
    0,
    n,
    () => 520,
    "sine",
    (i) => 0.5 * Math.exp(-i / SR / 0.014),
  );
  const nz = whiteNoise(n, seed);
  svf(nz, "band", () => 3500, 1);
  for (let i = 0; i < n; i++) y[i]! += nz[i]! * 0.4 * Math.exp(-i / SR / 0.004);
  return fadeOut(normalize(y), 0.01);
}

/** A shaker: noise with a soft attack — a brush, not a tick. */
export function shaker(seed: number): Float32Array {
  const n = secs(0.09);
  const x = whiteNoise(n, seed);
  svf(x, "band", () => 7800, 0.8);
  svf(x, "high", () => 4500, 0.7);
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    x[i]! *= Math.min(1, t / 0.009) * Math.exp(-Math.max(0, t - 0.009) / 0.03);
  }
  return fadeOut(normalize(x), 0.01);
}

/** A big low drum (taiko-like): the downbeat of a score without a kit. */
export function taiko(seed: number, big = false): Float32Array {
  const n = secs(big ? 1.6 : 1.0);
  const y = new Float32Array(n);
  oscillate(
    y,
    0,
    n,
    (i) => 52 + 58 * Math.exp(-i / SR / 0.045),
    "sine",
    (i) => Math.exp(-i / SR / (big ? 0.42 : 0.28)),
  );
  const skin = whiteNoise(n, seed);
  svf(skin, "low", () => 900, 0.9);
  for (let i = 0; i < n; i++) y[i]! += skin[i]! * 0.55 * Math.exp(-i / SR / 0.05);
  return fadeOut(normalize(saturate(y, 1.5)), 0.1);
}

/** Clap: three noise slaps ten milliseconds apart and a short room tail,
 *  band-limited around 1.5 kHz. Stereo from two seeds. */
export function clap(seed: number): [Float32Array, Float32Array] {
  const n = secs(0.36);
  const side = (s: number) => {
    const x = whiteNoise(n, s);
    svf(x, "band", () => 1450, 1.3);
    svf(x, "high", () => 550, 0.7);
    for (let i = 0; i < n; i++) {
      const t = i / SR;
      let e = 0;
      for (const at of [0, 0.0095, 0.019]) if (t >= at) e += Math.exp(-(t - at) / 0.0042);
      if (t >= 0.027) e += 0.75 * Math.exp(-(t - 0.027) / 0.085);
      x[i]! *= e;
    }
    return x;
  };
  const l = side(seed);
  const rr = side(seed ^ 0x2c1b);
  const m = Math.max(...[l, rr].map((c) => c.reduce((a, v) => Math.max(a, Math.abs(v)), 0)));
  for (const c of [l, rr]) for (let i = 0; i < n; i++) c[i]! /= m || 1;
  return [fadeOut(l, 0.02), fadeOut(rr, 0.02)];
}

/** Metallic source: six square waves at inharmonic ratios (the classic
 *  analogue cymbal recipe) plus air. */
function metal(n: number, seed: number, scale: number): Float32Array {
  const y = new Float32Array(n);
  const r = rng(seed);
  for (const f of [205.3, 304.4, 369.6, 522.7, 540.0, 800.0])
    oscillate(
      y,
      0,
      n,
      () => f * scale,
      "square",
      () => 0.16,
      r(),
    );
  const air = whiteNoise(n, seed ^ 0x77);
  for (let i = 0; i < n; i++) y[i]! += air[i]! * 0.55;
  return y;
}

/** Hi-hat: closed (a tick) or open (a hiss that rings for a fifth of a second). */
export function hat(seed: number, open = false): Float32Array {
  const n = secs(open ? 0.5 : 0.09);
  const y = metal(n, seed, 1.55);
  svf(y, "band", () => 10200, 0.9);
  svf(y, "high", () => 7200, 0.7);
  const tau = open ? 0.16 : 0.022;
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    y[i]! *= Math.min(1, t / 0.0006) * Math.exp(-t / tau);
  }
  return fadeOut(normalize(y), 0.01);
}

/** Snare for rolls and fills: a falling tone and a bright noise body. */
export function snare(seed: number): Float32Array {
  const n = secs(0.26);
  const y = new Float32Array(n);
  oscillate(
    y,
    0,
    n,
    (i) => 168 + 40 * Math.exp(-i / SR / 0.02),
    "sine",
    (i) => 0.6 * Math.exp(-i / SR / 0.05),
  );
  const nz = whiteNoise(n, seed);
  svf(nz, "band", () => 3200, 0.8);
  svf(nz, "high", () => 900, 0.7);
  for (let i = 0; i < n; i++) y[i]! += nz[i]! * Math.exp(-i / SR / 0.075);
  return fadeOut(normalize(y), 0.02);
}

/** Crash: a long metallic wash with a bright attack. Stereo. */
export function crash(seed: number, durationS = 2.6): [Float32Array, Float32Array] {
  const n = secs(durationS);
  const side = (s: number) => {
    const y = metal(n, s, 2.3);
    const nz = whiteNoise(n, s ^ 0x3d);
    for (let i = 0; i < n; i++) y[i]! = y[i]! * 0.6 + nz[i]! * 0.8;
    svf(y, "high", () => 3200, 0.7);
    svf(y, "low", () => 17000, 0.7);
    for (let i = 0; i < n; i++) {
      const t = i / SR;
      y[i]! *= Math.min(1, t / 0.001) * (0.55 * Math.exp(-t / 0.018) + Math.exp(-t / 0.75));
    }
    return y;
  };
  const l = side(seed);
  const rr = side(seed ^ 0x5eed);
  normalize(l);
  normalize(rr);
  return [fadeOut(l, 0.2), fadeOut(rr, 0.2)];
}

/** A cymbal played backwards: swells for `durationS` and stops dead on the
 *  downbeat it leads into. Stereo. */
export function reverseCymbal(seed: number, durationS: number): [Float32Array, Float32Array] {
  const [l, rr] = crash(seed, durationS + 0.05);
  const flip = (x: Float32Array) => {
    const y = new Float32Array(secs(durationS));
    for (let i = 0; i < y.length; i++) y[i] = x[y.length - 1 - i]!;
    const tail = secs(0.004);
    for (let i = 0; i < tail; i++) y[y.length - 1 - i]! *= i / tail;
    return y;
  };
  return [flip(l), flip(rr)];
}

/** A noise riser for the arrangement: a band sweeping up two decades, louder
 *  as it climbs, ending exactly at `durationS`. Stereo. */
export function sweep(seed: number, durationS: number): [Float32Array, Float32Array] {
  const n = secs(durationS);
  const side = (s: number) => {
    const y = whiteNoise(n, s);
    svf(y, "band", (i) => 280 * (7200 / 280) ** Math.min(1, i / n), 1.6);
    for (let i = 0; i < n; i++) y[i]! *= (i / n) ** 2.2;
    return normalize(y);
  };
  const l = side(seed);
  const rr = side(seed ^ 0x19);
  const tail = secs(0.006);
  for (const c of [l, rr]) for (let i = 0; i < tail; i++) c[n - 1 - i]! *= i / tail;
  return [l, rr];
}

// --- tonal parts (written into a bus) ----------------------------------------

/** Bass note into a mono bus, `midi` = the sub's pitch (octave 1): a sine
 *  there for weight, a saw an octave up for definition whose filter opens on
 *  the attack and closes over 80 ms. */
export type BassKind = "pulse" | "sub" | "reese" | "pluck";

export function bassNote(
  bus: Float32Array,
  at: number,
  durationS: number,
  midi: number,
  gain: number,
  bright = 1,
  kind: BassKind = "pulse",
): void {
  const f = midiHz(midi);
  const n = secs(durationS + 0.05);
  const decay = kind === "pluck" ? 0.16 : 0.25;
  const sustain = kind === "pluck" ? 0.05 : 0.85;
  const env = (i: number) => gain * adsr(i / SR, durationS, 0.003, decay, sustain, 0.05);
  const tmp = new Float32Array(n);
  if (kind === "reese") {
    // two detuned saws an octave up, slowly beating against each other
    oscillate(
      tmp,
      0,
      n,
      () => 2 * f * 2 ** (-14 / 1200),
      "saw",
      (i) => 0.32 * env(i),
    );
    oscillate(
      tmp,
      0,
      n,
      () => 2 * f * 2 ** (14 / 1200),
      "saw",
      (i) => 0.32 * env(i),
      0.37,
    );
  } else if (kind !== "sub")
    oscillate(
      tmp,
      0,
      n,
      () => 2 * f,
      "saw",
      (i) => 0.4 * env(i),
    );
  if (kind !== "sub") {
    const filt = new Svf();
    const base = kind === "reese" ? 520 : 280;
    const sweep = kind === "pluck" ? 1600 : 950;
    const tau = kind === "pluck" ? 0.05 : 0.08;
    for (let i = 0; i < n; i++) {
      const cut = base + sweep * bright * Math.exp(-i / SR / tau);
      tmp[i] = filt.tick(tmp[i]!, cut, 0.9)[0]!;
    }
  }
  oscillate(tmp, 0, n, () => f, "sine", kind === "sub" ? (i) => 1.1 * env(i) : env);
  for (let i = 0; i < n; i++) {
    const j = at + i;
    if (j >= 0 && j < bus.length) bus[j]! += tmp[i]!;
  }
}

/** A pad chord into a stereo bus: three detuned saws per note per side, slow
 *  attack, long release. The bus is filtered afterwards as a whole so the
 *  cutoff can move across chord changes without steps. */
export type PadKind = "pulse" | "airy" | "warm";

export function padChord(
  busL: Float32Array,
  busR: Float32Array,
  at: number,
  durationS: number,
  notes: number[],
  gain: number,
  seed: number,
  attackS = 0.35,
  releaseS = 0.7,
  kind: PadKind = "pulse",
): void {
  const r = rng(seed);
  const rel = kind === "airy" ? releaseS * 1.6 : releaseS;
  const att = kind === "airy" ? Math.max(attackS, 0.6) : attackS;
  const n = secs(durationS + rel);
  const env = (i: number) => gain * adsr(i / SR, durationS, att, 0.6, 0.85, rel);
  const detunes =
    kind === "airy"
      ? [
          [-16, -4, 7, 15],
          [-13, 3, 10, 18],
        ]
      : [
          [-11, 2, 9],
          [-8, -2, 12],
        ];
  const voices = kind === "airy" ? notes.map((m) => m + 12).concat(notes) : notes;
  for (const m of voices) {
    const f = midiHz(m);
    [busL, busR].forEach((bus, side) => {
      if (kind === "warm") {
        // rounder: a sine with one soft saw beside it
        const a = f * 2 ** ((side ? 4 : -4) / 1200);
        const b = f * 2 ** ((side ? -3 : 3) / 1200);
        oscillate(
          bus,
          at,
          n,
          () => a,
          "sine",
          (i) => 0.8 * env(i),
          r(),
        );
        oscillate(
          bus,
          at,
          n,
          () => b,
          "saw",
          (i) => 0.18 * env(i),
          r(),
        );
        return;
      }
      for (const cents of detunes[side]!) {
        const fr = f * 2 ** (cents / 1200);
        oscillate(
          bus,
          at,
          n,
          () => fr,
          "saw",
          (i) => env(i) / (kind === "airy" ? 5 : 3),
          r(),
        );
      }
    });
  }
}

/** An electric-piano stab (FM tine): chords played, not held. */
export function keysChord(
  busL: Float32Array,
  busR: Float32Array,
  at: number,
  notes: number[],
  gain: number,
  seed: number,
  durationS = 0.9,
): void {
  const r = rng(seed);
  const n = secs(durationS);
  notes.forEach((m, j) => {
    const f = midiHz(m);
    const pan = (j / Math.max(1, notes.length - 1)) * 0.6 - 0.3;
    const th = ((pan + 1) / 2) * (Math.PI / 2);
    const ph = r() * 6.28;
    for (let i = 0; i < n; i++) {
      const t = i / SR;
      const index = 1.4 * Math.exp(-t / 0.12) + 0.25;
      const v =
        Math.sin(2 * Math.PI * f * t + ph + index * Math.sin(2 * Math.PI * f * t)) *
        Math.min(1, t / 0.003) *
        Math.exp(-t / 0.55) *
        (gain / notes.length);
      const k = at + i;
      if (k < 0 || k >= busL.length) continue;
      busL[k]! += v * Math.cos(th) * Math.SQRT2;
      busR[k]! += v * Math.sin(th) * Math.SQRT2;
    }
  });
}

/** A marimba-like mallet (FM, 1 : 4), short and woody. */
export function malletNote(
  busL: Float32Array,
  busR: Float32Array,
  at: number,
  midi: number,
  gain: number,
  pan: number,
): void {
  const f = midiHz(midi);
  const n = secs(0.5);
  const th = ((pan + 1) / 2) * (Math.PI / 2);
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    const index = 2.2 * Math.exp(-t / 0.03);
    const v =
      Math.sin(2 * Math.PI * f * t + index * Math.sin(2 * Math.PI * 4 * f * t)) *
      Math.min(1, t / 0.001) *
      Math.exp(-t / 0.16) *
      gain;
    const k = at + i;
    if (k < 0 || k >= busL.length) continue;
    busL[k]! += v * Math.cos(th) * Math.SQRT2;
    busR[k]! += v * Math.sin(th) * Math.SQRT2;
  }
}

/** A pitched riser: a saw chord gliding up an octave into the downbeat. */
export function pitchRise(
  seed: number,
  durationS: number,
  notes: number[],
): [Float32Array, Float32Array] {
  const n = secs(durationS);
  const r = rng(seed);
  const side = (off: number) => {
    const y = new Float32Array(n);
    for (const m of notes) {
      const f = midiHz(m) * 2 ** (off / 1200);
      oscillate(
        y,
        0,
        n,
        (i) => f * 2 ** ((i / n) ** 1.6),
        "saw",
        (i) => (i / n) ** 1.8 / notes.length,
        r(),
      );
    }
    svf(y, "low", (i) => 900 + 7000 * (i / n) ** 2, 0.9);
    const tail = secs(0.006);
    for (let i = 0; i < tail; i++) y[n - 1 - i]! *= i / tail;
    return normalize(y);
  };
  return [side(-7), side(7)];
}

/** A pluck into a stereo bus: saw + square through a filter that snaps shut. */
export function pluck(
  busL: Float32Array,
  busR: Float32Array,
  at: number,
  midi: number,
  gain: number,
  pan: number,
  seed: number,
): void {
  const r = rng(seed);
  const f = midiHz(midi);
  const n = secs(0.34);
  const tmp = new Float32Array(n);
  oscillate(
    tmp,
    0,
    n,
    () => f,
    "saw",
    () => 0.6,
    r(),
  );
  oscillate(
    tmp,
    0,
    n,
    () => f * 1.003,
    "square",
    () => 0.35,
    r(),
  );
  const filt = new Svf();
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    const cut = 320 + 5200 * Math.exp(-t / 0.065);
    tmp[i] = filt.tick(tmp[i]!, cut, 1.1)[0]! * Math.min(1, t / 0.002) * Math.exp(-t / 0.16);
  }
  const th = ((pan + 1) / 2) * (Math.PI / 2);
  const gl = gain * Math.cos(th);
  const gr = gain * Math.sin(th);
  for (let i = 0; i < n; i++) {
    const j = at + i;
    if (j < 0 || j >= busL.length) continue;
    busL[j]! += tmp[i]! * gl;
    busR[j]! += tmp[i]! * gr;
  }
}

/** An FM bell (1 : 3.5), the resolution colour. Into a stereo bus. */
export function bellNote(
  busL: Float32Array,
  busR: Float32Array,
  at: number,
  midi: number,
  gain: number,
  pan: number,
  durationS = 2.4,
): void {
  const f = midiHz(midi);
  const n = secs(durationS);
  const th = ((pan + 1) / 2) * (Math.PI / 2);
  const gl = gain * Math.cos(th);
  const gr = gain * Math.sin(th);
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    const index = 2.2 * Math.exp(-t / 0.3);
    const v =
      Math.sin(2 * Math.PI * f * t + index * Math.sin(2 * Math.PI * 3.5 * f * t)) *
      Math.min(1, t / 0.002) *
      Math.exp(-t / 0.9);
    const j = at + i;
    if (j < 0 || j >= busL.length) continue;
    busL[j]! += v * gl;
    busR[j]! += v * gr;
  }
}
