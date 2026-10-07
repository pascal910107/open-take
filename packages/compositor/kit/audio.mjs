// @ts-check
// Sound for a film — open-take's film kit, for the score's Node script (no
// dependencies). The music is yours: there are no melodies, chords,
// instruments, presets or samples here. What is here is the plumbing that
// eleven of twelve films wrote again for themselves — buffers and a mix, an
// envelope, filters, a reverb, a sidechain, seeded numbers, a WAV writer —
// without the ways theirs went wrong:
//
//   - loudness measured the way ITU-R BS.1770-4 (EBU R128) measures it, and
//     `normalize`, which lands the mix on −16 LUFS with its true peak under
//     −1 dBTP. Guessing from the sample peak or the RMS shipped films at
//     −12.2 LUFS (true peak −0.4) and −17.8 LUFS;
//   - an envelope that releases from the level it reached. One that releases
//     from the sustain level jumps when a note ends mid-decay, and the jump
//     is a click;
//   - a filter that is held below Nyquist, and that stops, naming its track,
//     once its state is no longer a number. A film's filter blew up at a high
//     cutoff and was found by ear, as two pops;
//   - `diagnose`, which checks one stem at a time for what a mix hides: NaN,
//     clipping, clicks (a note cut short, a release from the wrong level,
//     saws started in phase), DC.
//
// Sound is Float32Array channels, −1..1 full scale, 48 kHz unless you say
// otherwise. A bus is a buffer you mix into. Times are seconds.
//
//   import { buffer, mix, envelope, normalize, diagnose, writeWav } from "./kit/audio.mjs";
//   const music = buffer(30);                       // 30 s of stereo silence
//   mix(music, note, tl.t("search"), 0.4);          // a sound at a moment, at 0.4
//   const stems = { music, sfx };
//   for (const [name, s] of Object.entries(stems)) console.log(diagnose(name, s));
//   writeWav("score.wav", normalize(master));       // −16 LUFS, true peak ≤ −1 dBTP

import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** the sample rate when nothing says otherwise: the film's soundtrack is 48 kHz */
const RATE = 48000;

/** @typedef {Float32Array | Float64Array} Signal  one channel of samples */
/** @typedef {Signal[] & { sampleRate?: number }} Channels  one Signal per channel; buffer() records its rate on it */

/** @param {Channels | Signal} x @returns {Signal[]} */
const chans = (x) => (ArrayBuffer.isView(x) ? [/** @type {Signal} */ (x)] : x);
/** @param {Channels | Signal} x */
const rateOf = (x) => /** @type {{ sampleRate?: number }} */ (x).sampleRate ?? RATE;
/** @param {Signal[]} chs @param {number} sampleRate @returns {Channels} */
const withRate = (chs, sampleRate) => Object.assign(chs, { sampleRate });
/** @param {number} db */
const gainOf = (db) => 10 ** (db / 20);
/** @param {number} g */
const dbOf = (g) => 20 * Math.log10(g);
/** @param {number} t */
const secs = (t) => Math.round(t * 1000) / 1000;

/** @param {string} who @param {Signal[]} chs */
function sameLength(who, chs) {
  const n = chs[0]?.length ?? 0;
  if (chs.some((c) => c.length !== n))
    throw new Error(`${who}: its channels differ in length (${chs.map((c) => c.length)})`);
  return n;
}

// ---------------------------------------------------------------- buffers

/**
 * Silence to mix into: `seconds` long, one Float32Array per channel. A bus is
 * one of these — mix sounds into it, process it, mix it into the master.
 * @param {number} seconds
 * @param {{ channels?: number, sampleRate?: number }} [o]
 * @returns {Channels}
 */
export function buffer(seconds, { channels = 2, sampleRate = RATE } = {}) {
  if (!(seconds >= 0) || !Number.isFinite(seconds))
    throw new Error(`buffer: ${seconds} is not a length in seconds`);
  const n = Math.round(seconds * sampleRate);
  return withRate(
    Array.from({ length: channels }, () => new Float32Array(n)),
    sampleRate,
  );
}

/**
 * Add `from` into `into` from `at` seconds on, scaled by `gain`: one number,
 * or one per channel of `into` (a pan, by hand). A mono sound goes into every
 * channel. Whatever falls outside `into` is left out. Returns `into`.
 * @param {Channels} into
 * @param {Channels | Signal} from
 * @param {number} [at]
 * @param {number | number[]} [gain]
 */
export function mix(into, from, at = 0, gain = 1) {
  const src = chans(from);
  const a = into.sampleRate;
  const b = /** @type {{ sampleRate?: number }} */ (from).sampleRate;
  if (a && b && a !== b) throw new Error(`mix: ${b} Hz into ${a} Hz — resample it first`);
  if (!Number.isFinite(at)) throw new Error(`mix: ${at} is not a time in seconds`);
  if (src.length !== 1 && src.length !== into.length)
    throw new Error(`mix: ${src.length} channels into ${into.length} — give it mono, or as many`);
  if (Array.isArray(gain) && gain.length !== into.length)
    throw new Error(`mix: ${gain.length} gains for ${into.length} channels`);
  const start = Math.round(at * (a ?? b ?? RATE));
  into.forEach((dst, c) => {
    const s = /** @type {Signal} */ (src.length === 1 ? src[0] : src[c]);
    const g = Array.isArray(gain) ? (gain[c] ?? 0) : gain;
    const i1 = Math.min(s.length, dst.length - start);
    for (let i = Math.max(0, -start); i < i1; i++)
      dst[start + i] = (dst[start + i] ?? 0) + (s[i] ?? 0) * g;
  });
  return into;
}

/**
 * Numbers that look random but are the same every run (mulberry32): a score
 * built on Math.random() changes each time it is rendered.
 * @param {number} seed
 * @returns {() => number} the next number in [0, 1)
 */
export function rng(seed) {
  let a = seed | 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), a | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------- shaping

/**
 * An envelope: attack, decay, sustain, release. `env(t, held)` is its level
 * t s after the note starts, for a note held `held` s (default: held for
 * good). Let go early — mid-attack, mid-decay — and it releases from the level
 * it had reached, so the level never jumps. The defaults are a plain gate that
 * cannot click (5 ms in, 20 ms out); the shape of a sound is yours.
 *
 *   const env = envelope({ attack: 0.002, decay: 0.4, sustain: 0.3, release: 0.25 });
 *   const n = Math.ceil(env.end(0.5) * 48000);       // the note sounds this long
 *   for (let i = 0; i < n; i++) note[i] = Math.sin(w * i) * env(i / 48000, 0.5);
 *
 * @param {object} [o]
 * @param {number} [o.attack] s from 0 to the top (1, or the sustain level when there is no decay)
 * @param {number} [o.decay] s from 1 down to the sustain level
 * @param {number} [o.sustain] the level while held, 0..1
 * @param {number} [o.release] s from wherever it was let go down to 0
 * @param {number} [o.curve] 0 is a straight line; higher bends the decay and release toward an exponential fall
 * @returns {((t: number, held?: number) => number) & { end: (held: number) => number }}
 */
export function envelope({
  attack = 0.005,
  decay = 0,
  sustain = 1,
  release = 0.02,
  curve = 0,
} = {}) {
  for (const [k, v] of Object.entries({ attack, decay, sustain, release, curve }))
    if (!(v >= 0) || !Number.isFinite(v))
      throw new Error(`envelope: ${k} must be a number ≥ 0 (got ${v})`);
  const top = decay > 0 ? 1 : sustain;
  /** progress 0..1 through a fall, bent by `curve` @param {number} u */
  const bend = (u) => (curve === 0 ? u : (1 - Math.exp(-curve * u)) / (1 - Math.exp(-curve)));
  /** the level of a note still held @param {number} t */
  const level = (t) => {
    if (t < 0) return 0;
    if (t < attack) return (top * t) / attack;
    if (t < attack + decay) return 1 - (1 - sustain) * bend((t - attack) / decay);
    return sustain;
  };
  /** @param {number} t @param {number} [held] */
  const env = (t, held = Number.POSITIVE_INFINITY) => {
    if (t < held) return level(t);
    if (t >= held + release) return 0;
    return level(held) * (1 - bend((t - held) / release));
  };
  /** when a note held `held` s falls silent @param {number} held */
  const end = (held) => held + release;
  return Object.assign(env, { end });
}

/**
 * A filter from Robert Bristow-Johnson's cookbook, keeping its state between
 * calls: one per track, and one state per channel (`ch`). `f(x)` filters one
 * sample, `f.run(sound)` a whole buffer in place, `f.set({ freq })` moves it as
 * it runs (a sweep) and keeps the state.
 *
 * Its frequency is held under Nyquist — above it these filters run away, the
 * way a film's did at a high cutoff. If its state still stops being a number
 * (a NaN coming in, a sweep it cannot follow), it throws, naming the track.
 *
 * @param {string} name the track, for the error
 * @param {"lowpass" | "highpass" | "bandpass" | "peaking" | "lowshelf" | "highshelf"} type
 * @param {{ freq: number, q?: number, gain?: number }} params Hz; q defaults to 0.707; gain in dB, for peaking and the shelves
 * @param {number} [sampleRate]
 */
export function biquad(name, type, params, sampleRate = RATE) {
  let b0 = 1;
  let b1 = 0;
  let b2 = 0;
  let a1 = 0;
  let a2 = 0;
  let p = { q: Math.SQRT1_2, gain: 0, ...params };
  /** @param {{ freq?: number, q?: number, gain?: number }} next */
  const set = (next) => {
    p = { ...p, ...next };
    if (!(p.freq > 0) || !(p.q > 0) || !Number.isFinite(p.gain))
      throw new Error(
        `biquad "${name}": it needs freq > 0, q > 0 and a gain in dB (got ${p.freq} Hz, q ${p.q}, ${p.gain} dB)`,
      );
    const w = (2 * Math.PI * Math.min(p.freq, 0.49 * sampleRate)) / sampleRate;
    const cos = Math.cos(w);
    const alpha = Math.sin(w) / (2 * p.q);
    const A = 10 ** (p.gain / 40);
    const sq = 2 * Math.sqrt(A) * alpha;
    /** @type {[number, number, number, number, number, number]} b0 b1 b2 a0 a1 a2 */
    let c;
    if (type === "lowpass")
      c = [(1 - cos) / 2, 1 - cos, (1 - cos) / 2, 1 + alpha, -2 * cos, 1 - alpha];
    else if (type === "highpass")
      c = [(1 + cos) / 2, -(1 + cos), (1 + cos) / 2, 1 + alpha, -2 * cos, 1 - alpha];
    else if (type === "bandpass") c = [alpha, 0, -alpha, 1 + alpha, -2 * cos, 1 - alpha];
    else if (type === "peaking")
      c = [1 + alpha * A, -2 * cos, 1 - alpha * A, 1 + alpha / A, -2 * cos, 1 - alpha / A];
    else if (type === "lowshelf")
      c = [
        A * (A + 1 - (A - 1) * cos + sq),
        2 * A * (A - 1 - (A + 1) * cos),
        A * (A + 1 - (A - 1) * cos - sq),
        A + 1 + (A - 1) * cos + sq,
        -2 * (A - 1 + (A + 1) * cos),
        A + 1 + (A - 1) * cos - sq,
      ];
    else if (type === "highshelf")
      c = [
        A * (A + 1 + (A - 1) * cos + sq),
        -2 * A * (A - 1 + (A + 1) * cos),
        A * (A + 1 + (A - 1) * cos - sq),
        A + 1 - (A - 1) * cos + sq,
        2 * (A - 1 - (A + 1) * cos),
        A + 1 - (A - 1) * cos - sq,
      ];
    else throw new Error(`biquad "${name}": no filter type "${type}"`);
    const [n0, n1, n2, d0, d1, d2] = c;
    b0 = n0 / d0;
    b1 = n1 / d0;
    b2 = n2 / d0;
    a1 = d1 / d0;
    a2 = d2 / d0;
  };
  set({});
  /** per channel: the last two inputs and outputs, and how many samples it has seen */
  /** @type {{ x1: number, x2: number, y1: number, y2: number, n: number }[]} */
  const state = [];
  /** @param {number} ch */
  const stateOf = (ch) => {
    let s = state[ch];
    if (!s) {
      s = { x1: 0, x2: 0, y1: 0, y2: 0, n: 0 };
      state[ch] = s;
    }
    return s;
  };
  /** @param {number} y @param {number} x @param {number} ch @param {number} n */
  const blewUp = (y, x, ch, n) =>
    new Error(
      `biquad "${name}" (${type}, ${Math.round(p.freq)} Hz): its state became ${y} ` +
        `${secs(n / sampleRate)} s into channel ${ch} — ` +
        (Number.isFinite(x) ? "the filter ran away" : `its input was ${x}`),
    );
  /** filter one sample @param {number} x @param {number} [ch] */
  const f = (x, ch = 0) => {
    const s = stateOf(ch);
    const y = b0 * x + b1 * s.x1 + b2 * s.x2 - a1 * s.y1 - a2 * s.y2;
    if (!Number.isFinite(y)) throw blewUp(y, x, ch, s.n);
    s.x2 = s.x1;
    s.x1 = x;
    s.y2 = s.y1;
    s.y1 = y;
    s.n++;
    return y;
  };
  /** filter a whole sound in place, each channel with its own state; returns it
   *  @template {Channels | Signal} T @param {T} sound @returns {T} */
  const run = (sound) => {
    chans(sound).forEach((sig, ch) => {
      const s = stateOf(ch);
      let { x1, x2, y1, y2 } = s;
      for (let i = 0; i < sig.length; i++) {
        const x = sig[i] ?? 0;
        const y = b0 * x + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
        if (!Number.isFinite(y)) throw blewUp(y, x, ch, s.n + i);
        sig[i] = y;
        x2 = x1;
        x1 = x;
        y2 = y1;
        y1 = y;
      }
      Object.assign(s, { x1, x2, y1, y2, n: s.n + sig.length });
    });
    return sound;
  };
  return Object.assign(f, { run, set });
}

const COMBS = [1116, 1188, 1277, 1356, 1422, 1491, 1557, 1617];
const ALLPASSES = [556, 441, 341, 225];

/**
 * A reverb: Jezar's Freeverb — eight damped combs side by side, then four
 * all-passes, for each side (the right one's delays 23 samples longer).
 * Returns the reverb alone, in stereo, as long as the sound plus its tail:
 * mix it in at the level you want it.
 * @param {Channels | Signal} sound
 * @param {number} [sampleRate]
 * @param {{ size?: number, damp?: number, width?: number, tail?: number }} [o]
 *   size 0..1, the room (a longer tail); damp 0..1, how much sooner the highs
 *   die; width 0..1, 0 is mono; tail, s kept after the sound (default: until
 *   it is 60 dB down)
 * @returns {Channels}
 */
export function reverb(
  sound,
  sampleRate = rateOf(sound),
  { size = 0.5, damp = 0.5, width = 1, tail } = {},
) {
  const src = chans(sound);
  const len = sameLength("reverb", src);
  const k = sampleRate / 44100; // the tunings are samples at 44.1 kHz
  const feedback = size * 0.28 + 0.7;
  const damp1 = damp * 0.4;
  const damp2 = 1 - damp1;
  // the longest comb loses (1 − feedback) of its level per pass: 60 dB takes this long
  const longest = Math.round((1617 + 23) * k);
  const t60 = (longest * Math.log(1000)) / (-Math.log(feedback) * sampleRate);
  const n = len + Math.round((tail ?? t60) * sampleRate);
  /** @param {number} d */
  const line = (d) => ({ buf: new Float64Array(Math.max(1, Math.round(d * k))), i: 0, store: 0 });
  const sides = [0, 23].map((spread) => ({
    combs: COMBS.map((d) => line(d + spread)),
    passes: ALLPASSES.map((d) => line(d + spread)),
    out: new Float32Array(n),
  }));
  // Freeverb takes (L + R) × 0.015; the mean × 0.03 is that, and the same for mono
  const gain = 0.03 / src.length;
  for (let i = 0; i < n; i++) {
    let input = 0;
    if (i < len) for (const s of src) input += s[i] ?? 0;
    input *= gain;
    for (const side of sides) {
      let acc = 0;
      for (const c of side.combs) {
        const y = c.buf[c.i] ?? 0;
        c.store = y * damp2 + c.store * damp1;
        c.buf[c.i] = input + c.store * feedback;
        if (++c.i === c.buf.length) c.i = 0;
        acc += y;
      }
      for (const a of side.passes) {
        const b = a.buf[a.i] ?? 0;
        a.buf[a.i] = acc + b * 0.5;
        if (++a.i === a.buf.length) a.i = 0;
        acc = b - acc;
      }
      side.out[i] = acc;
    }
  }
  const [l, r] = /** @type {[Float32Array, Float32Array]} */ (sides.map((s) => s.out));
  const wet1 = width / 2 + 0.5;
  const wet2 = (1 - width) / 2;
  for (let i = 0; i < n; i++) {
    const a = l[i] ?? 0;
    const b = r[i] ?? 0;
    l[i] = a * wet1 + b * wet2;
    r[i] = b * wet1 + a * wet2;
  }
  return withRate([l, r], sampleRate);
}

/**
 * Sidechain: `sound` dips while `key` plays — the music under a voice, under a
 * hit. The key at its loudest takes the sound down by `amount` dB; quieter, it
 * takes it down less (half as loud, half as far). `attack` and `release` are
 * how fast the dip follows the key (time constants, s). Returns the ducked
 * sound as new channels.
 * @param {Channels | Signal} sound
 * @param {Channels | Signal} key
 * @param {number} [sampleRate]
 * @param {{ amount?: number, attack?: number, release?: number }} [o]
 * @returns {Channels}
 */
export function duck(
  sound,
  key,
  sampleRate = rateOf(sound),
  { amount = 6, attack = 0.01, release = 0.25 } = {},
) {
  const src = chans(sound);
  const keys = chans(key);
  const n = sameLength("duck", src);
  const up = Math.exp(-1 / (Math.max(attack, 1e-6) * sampleRate));
  const down = Math.exp(-1 / (Math.max(release, 1e-6) * sampleRate));
  // the key's level is its peak over the last 10 ms, so a tone's dips between
  // peaks do not count; the dip follows that level, rising at `attack` and
  // falling at `release`
  const hold = Math.max(1, Math.round(0.01 * sampleRate));
  const abs = new Float32Array(n);
  const q = new Int32Array(n); // a window maximum: indices whose |key| falls from head to tail
  let head = 0;
  let tail = 0;
  const env = new Float32Array(n);
  let e = 0;
  let loudest = 0;
  for (let i = 0; i < n; i++) {
    let x = 0;
    for (const k of keys) x = Math.max(x, Math.abs(k[i] ?? 0));
    abs[i] = x;
    while (tail > head && (abs[q[tail - 1] ?? 0] ?? 0) <= x) tail--;
    q[tail++] = i;
    while ((q[head] ?? 0) <= i - hold) head++;
    const level = abs[q[head] ?? 0] ?? 0;
    e = level > e ? up * e + (1 - up) * level : down * e + (1 - down) * level;
    env[i] = e;
    if (e > loudest) loudest = e;
  }
  const out = src.map((s) => Float32Array.from(s));
  if (loudest > 0)
    for (let i = 0; i < n; i++) {
      const g = gainOf((-amount * (env[i] ?? 0)) / loudest);
      for (const o of out) o[i] = (o[i] ?? 0) * g;
    }
  return withRate(out, sampleRate);
}

// ---------------------------------------------------------------- loudness

/** @typedef {[number, number, number, number, number]} Stage  b0, b1, b2, a1, a2 */

/** K-weighting, BS.1770-4's two stages (a high shelf for the head, then a
 *  high-pass), as coefficients for any sample rate — the derivation libebur128
 *  and ffmpeg use; at 48 kHz it gives the standard's own numbers
 *  @param {number} fs @returns {{ shelf: Stage, highpass: Stage }} */
function kWeighting(fs) {
  let K = Math.tan((Math.PI * 1681.974450955533) / fs);
  let Q = 0.7071752369554196;
  const Vh = 10 ** (3.999843853973347 / 20);
  const Vb = Vh ** 0.4996667741545416;
  let a0 = 1 + K / Q + K * K;
  /** @type {Stage} */
  const shelf = [
    (Vh + (Vb * K) / Q + K * K) / a0,
    (2 * (K * K - Vh)) / a0,
    (Vh - (Vb * K) / Q + K * K) / a0,
    (2 * (K * K - 1)) / a0,
    (1 - K / Q + K * K) / a0,
  ];
  K = Math.tan((Math.PI * 38.13547087602444) / fs);
  Q = 0.5003270373238773;
  a0 = 1 + K / Q + K * K;
  /** @type {Stage} */
  const highpass = [1, -2, 1, (2 * (K * K - 1)) / a0, (1 - K / Q + K * K) / a0];
  return { shelf, highpass };
}

/** the mean square of each 400 ms block (a new one every 100 ms), K-weighted
 *  and summed over the channels, each weighted 1 (mono, stereo: no surrounds)
 *  @param {Signal[]} chs @param {number} fs */
function blockPowers(chs, fs) {
  const step = Math.floor(fs / 10);
  const steps = Math.floor((chs[0]?.length ?? 0) / step);
  const sums = new Float64Array(steps);
  const { shelf, highpass } = kWeighting(fs);
  const [s0, s1, s2, s3, s4] = shelf;
  const [h0, h1, h2, h3, h4] = highpass;
  for (const x of chs) {
    let x1 = 0;
    let x2 = 0;
    let y1 = 0;
    let y2 = 0;
    let z1 = 0;
    let z2 = 0;
    let i = 0;
    for (let s = 0; s < steps; s++) {
      let acc = 0;
      for (const end = i + step; i < end; i++) {
        const v = x[i] ?? 0;
        const y = s0 * v + s1 * x1 + s2 * x2 - s3 * y1 - s4 * y2;
        const z = h0 * y + h1 * y1 + h2 * y2 - h3 * z1 - h4 * z2;
        x2 = x1;
        x1 = v;
        y2 = y1;
        y1 = y;
        z2 = z1;
        z1 = z;
        acc += z * z;
      }
      sums[s] = (sums[s] ?? 0) + acc;
    }
  }
  const blocks = new Float64Array(Math.max(0, steps - 3));
  for (let j = 0; j < blocks.length; j++)
    blocks[j] =
      ((sums[j] ?? 0) + (sums[j + 1] ?? 0) + (sums[j + 2] ?? 0) + (sums[j + 3] ?? 0)) / (4 * step);
  return blocks;
}

/** the gated mean of the blocks: those over −70 LUFS, then those within 10 LU
 *  of the loudness of those — LUFS, −Infinity when no block is over −70
 *  @param {Float64Array} blocks */
function integrated(blocks) {
  const floor = 10 ** ((-70 + 0.691) / 10);
  let sum = 0;
  let n = 0;
  for (const z of blocks)
    if (z > floor) {
      sum += z;
      n++;
    }
  if (n === 0) return Number.NEGATIVE_INFINITY;
  const gate = sum / n / 10;
  sum = 0;
  n = 0;
  for (const z of blocks)
    if (z > floor && z > gate) {
      sum += z;
      n++;
    }
  return -0.691 + 10 * Math.log10(sum / n);
}

// True peak: the waveform between the samples, where a converter or an
// encoder's reconstruction overshoots the samples themselves. 4× oversampling
// by a Kaiser-windowed sinc (β 9, 32 taps a phase) — the filter ffmpeg's
// resampler builds for ebur128 — so the two read the same. Before the first
// sample is silence, as in the film (ffmpeg's resampler mirrors the first
// samples instead, so on a sound that starts at full tilt it reads higher).
const TAPS = 32;
const MID = 15; // the tap on the sample itself
const [P1, P2, P3] = /** @type {[Float64Array, Float64Array, Float64Array]} */ (
  (() => {
    /** @param {number} x */
    const bessel0 = (x) => {
      let sum = 1;
      let term = 1;
      for (let k = 1; k < 64 && term > sum * 1e-17; k++) {
        term *= (x / (2 * k)) ** 2;
        sum += term;
      }
      return sum;
    };
    // the three points a quarter, a half and three quarters past a sample
    return [1, 2, 3].map((p) => {
      const h = new Float64Array(TAPS);
      for (let i = 0; i < TAPS; i++) {
        const u = i - MID - p / 4;
        const w = (2 * u) / TAPS;
        h[i] =
          (Math.sin(Math.PI * u) / (Math.PI * u)) * bessel0(9 * Math.sqrt(Math.max(1 - w * w, 0)));
      }
      const sum = h.reduce((a, v) => a + v, 0);
      return h.map((v) => v / sum); // each passes DC at 1
    });
  })()
);
/** no point between samples can be further from 0 than this × the samples around it */
const REACH = Math.max(...[P1, P2, P3].map((h) => h.reduce((a, v) => a + Math.abs(v), 0)));

/** the largest |value| over [i, i + 1): the sample and the three points
 *  between it and the next (silence beyond the ends)
 *  @param {Signal} x @param {number} i */
function spanPeak(x, i) {
  const k0 = i - MID;
  let a = 0;
  let b = 0;
  let c = 0;
  for (let t = Math.max(0, -k0); t < Math.min(TAPS, x.length - k0); t++) {
    const v = x[k0 + t] ?? 0;
    a += (P1[t] ?? 0) * v;
    b += (P2[t] ?? 0) * v;
    c += (P3[t] ?? 0) * v;
  }
  return Math.max(Math.abs(x[i] ?? 0), Math.abs(a), Math.abs(b), Math.abs(c));
}

/** samples are looked at in blocks: a block whose neighbourhood is too quiet
 *  to matter is passed over */
const BLOCK = 64;
/** REACH × the loudest sample any point in block b, or just before it, is made from
 *  @param {Signal[]} chs @param {number} b */
function blockBound(chs, b) {
  let near = 0;
  for (const x of chs) {
    const end = Math.min(x.length, (b + 1) * BLOCK + TAPS - MID);
    for (let k = Math.max(0, b * BLOCK - 1 - MID); k < end; k++)
      near = Math.max(near, Math.abs(x[k] ?? 0));
  }
  return near * REACH;
}

/** the largest |value| of x, at and between its samples
 *  @param {Signal} x */
function truePeakOf(x) {
  let best = 0;
  for (const v of x) if (Math.abs(v) > best) best = Math.abs(v);
  for (let b = 0; b * BLOCK < x.length; b++) {
    if (blockBound([x], b) <= best) continue;
    const end = Math.min(x.length, (b + 1) * BLOCK);
    for (let i = b * BLOCK; i < end; i++) best = Math.max(best, spanPeak(x, i));
  }
  return best;
}

/**
 * How loud a mix is, the way ITU-R BS.1770-4 (EBU R128) measures it — what
 * `film check` and ffmpeg's ebur128 report: integrated loudness (K-weighted,
 * 400 ms blocks every 100 ms, gated at −70 LUFS and at 10 LU under the level
 * of what passed that) and true peak (between the samples too, at 4×). The
 * channels count equally: mono and stereo, not surround.
 * @param {Channels | Signal} channels
 * @param {number} [sampleRate]
 * @returns {{ lufs: number, truePeak: number, peak: number }}
 *   LUFS (−Infinity when silent, or shorter than 0.4 s); true peak dBTP; sample peak dBFS
 */
export function loudness(channels, sampleRate = rateOf(channels)) {
  const chs = chans(channels);
  sameLength("loudness", chs);
  let peak = 0;
  for (const x of chs) for (const v of x) peak = Math.max(peak, Math.abs(v));
  return {
    lufs: integrated(blockPowers(chs, sampleRate)),
    truePeak: dbOf(Math.max(0, ...chs.map(truePeakOf))),
    peak: dbOf(peak),
  };
}

/**
 * @typedef {object} NormalizeReport
 * @property {number} gain dB applied to the whole mix
 * @property {number} lufs the loudness it landed on
 * @property {number} truePeak dBTP after
 * @property {{ db: number, at: number } | null} limited the deepest the limiter
 *   went (dB) and when (s); null when it never had to
 */

/**
 * The mix at a loudness — −16 LUFS, where online video plays — with its true
 * peak at or under −1 dBTP, the headroom the film's AAC encode needs. One gain
 * does it; where that gain would push a peak past the ceiling, a look-ahead
 * limiter takes that peak down (from 5 ms before it, letting go over 100 ms;
 * both channels together, so the image stays put). Returns new channels; their
 * `report` says what it did. A limiter that has to dig deep (several dB) is a
 * mix whose peaks stand far above its body: turn those sounds down instead.
 * @param {Channels | Signal} channels
 * @param {number} [sampleRate]
 * @param {{ lufs?: number, truePeak?: number }} [o]
 * @returns {Channels & { report: NormalizeReport }}
 */
export function normalize(
  channels,
  sampleRate = rateOf(channels),
  { lufs = -16, truePeak = -1 } = {},
) {
  const chs = chans(channels);
  const n = sameLength("normalize", chs);
  chs.forEach((x, c) => {
    const i = x.findIndex((v) => !Number.isFinite(v));
    if (i >= 0)
      throw new Error(
        `normalize: channel ${c} is ${x[i]} at ${secs(i / sampleRate)} s — diagnose the stems to find which one`,
      );
  });
  const before = integrated(blockPowers(chs, sampleRate));
  if (before === Number.NEGATIVE_INFINITY)
    throw new Error(
      "normalize: the mix is silent, or shorter than 0.4 s — it has no loudness to set",
    );
  const ceiling = gainOf(truePeak);
  const peaks = peakField(chs);
  const out = chs.map(() => new Float32Array(n));
  let gain = new Float32Array(0);
  /** the mix at `db`, limited under `limit`; its loudness @param {number} db @param {number} limit */
  const render = (db, limit) => {
    const g0 = gainOf(db);
    gain = limiter(peaks, g0, limit, sampleRate);
    chs.forEach((x, c) => {
      const o = /** @type {Float32Array} */ (out[c]);
      for (let i = 0; i < n; i++) o[i] = (x[i] ?? 0) * g0 * (gain[i] ?? 1);
    });
    return integrated(blockPowers(out, sampleRate));
  };
  // the gain that lands on the target: the limiter takes back a little of
  // whatever it is given, so search (secant steps in dB). It never goes past
  // MORE dB over the plain gain: by then the limiter is taking back nearly all
  // of it (a few short peaks over quiet), and pushing on only wrecks the sound
  const MORE = 24;
  const most = lufs - before + MORE;
  /** @param {number} limit */
  const land = (limit) => {
    let d0 = lufs - before;
    let l0 = render(d0, limit);
    if (Math.abs(l0 - lufs) < 0.01) return d0;
    let d1 = Math.min(d0 + (lufs - l0), most);
    let l1 = render(d1, limit);
    for (let k = 0; k < 12 && Math.abs(l1 - lufs) >= 0.01; k++) {
      const slope = (l1 - l0) / (d1 - d0);
      if (!(slope > 0.05) || d1 >= most) break; // more gain no longer makes it louder
      const d2 = Math.min(d1 + (lufs - l1) / slope, most);
      d0 = d1;
      l0 = l1;
      d1 = d2;
      l1 = render(d1, limit);
    }
    if (Math.abs(l1 - lufs) > 0.5)
      throw new Error(
        `normalize: the mix cannot reach ${lufs < 0 ? "−" : ""}${Math.abs(lufs)} LUFS with its true peak under ${truePeak} dBTP — it gets to ${l1.toFixed(1)} LUFS with ${MORE} dB of limiting (its loud moments are too few and too short); bring up its quieter parts, or aim lower`,
      );
    return d1;
  };
  // aim a hair under the ceiling; if the gain's own movement still lets an
  // in-between peak through, aim lower by what came through
  let limit = ceiling * 0.999;
  let db = 0;
  let tp = 0;
  for (let round = 0; round < 4; round++) {
    db = land(limit);
    tp = Math.max(...out.map(truePeakOf));
    if (tp <= ceiling) break;
    limit *= (ceiling / tp) * 0.999;
  }
  if (tp > ceiling) {
    for (const o of out) for (let i = 0; i < n; i++) o[i] = (o[i] ?? 0) * (ceiling / tp);
    tp = ceiling;
  }
  let least = 1;
  let at = 0;
  for (let i = 0; i < n; i++)
    if ((gain[i] ?? 1) < least) {
      least = gain[i] ?? 1;
      at = i;
    }
  const report = {
    gain: Math.round(db * 100) / 100,
    lufs: Math.round(integrated(blockPowers(out, sampleRate)) * 100) / 100,
    truePeak: Math.round(dbOf(tp) * 100) / 100,
    limited:
      least < 0.9999
        ? { db: Math.round(dbOf(least) * 100) / 100, at: secs(at / sampleRate) }
        : null,
  };
  return Object.assign(withRate(out, sampleRate), { report });
}

/** the peaks the limiter keeps down: for each sample, the largest |value| over
 *  the channels in the sample periods either side of it (between samples
 *  included), which one gain at that sample has to keep under the ceiling.
 *  Worked out exactly only in blocks loud enough to need it, once.
 *  @param {Signal[]} chs */
function peakField(chs) {
  const n = chs[0]?.length ?? 0;
  const blocks = Math.ceil(n / BLOCK);
  const bound = Float32Array.from({ length: blocks }, (_, b) => blockBound(chs, b));
  const span = new Float32Array(n); // the peak over [i, i + 1)
  const done = new Uint8Array(blocks);
  return {
    n,
    blocks,
    bound,
    /** the peak a gain at sample i has to answer for (block b worked out first)
     *  @param {number} b */
    exact(b) {
      if (!done[b]) {
        for (const x of chs)
          for (let i = b * BLOCK; i < Math.min(n, (b + 1) * BLOCK); i++)
            span[i] = Math.max(span[i] ?? 0, spanPeak(x, i));
        done[b] = 1;
      }
      // a sample in a block left alone is under any limit this block's bound is over
      return /** @param {number} i */ (i) => Math.max(span[i] ?? 0, i > 0 ? (span[i - 1] ?? 0) : 0);
    },
  };
}

/** the gain curve that keeps the peaks × `gain` under `limit`: each sample gets
 *  the lowest gain anything in the next 5 ms needs, eased back toward 1 over
 *  100 ms, then smoothed twice over 2.5 ms — which never lifts it over what any
 *  sample needs, because each smoothing window lies inside the 5 ms looked at
 *  @param {ReturnType<typeof peakField>} peaks @param {number} gain @param {number} limit @param {number} fs */
function limiter(peaks, gain, limit, fs) {
  const n = peaks.n;
  const half = Math.max(1, Math.round(0.0025 * fs));
  const reach = 2 * half - 1;
  const need = new Float32Array(n).fill(1);
  for (let b = 0; b < peaks.blocks; b++) {
    if ((peaks.bound[b] ?? 0) * gain <= limit) continue; // nothing here can reach it
    const around = peaks.exact(b);
    for (let i = b * BLOCK; i < Math.min(n, (b + 1) * BLOCK); i++)
      need[i] = Math.min(1, limit / (gain * around(i)));
  }
  // the smallest need in [i, i + reach): a window minimum, walking backwards
  const g = new Float32Array(n);
  const q = new Int32Array(n);
  let head = 0;
  let tail = 0;
  for (let i = n - 1; i >= 0; i--) {
    const v = need[i] ?? 1;
    while (tail > head && (need[q[tail - 1] ?? 0] ?? 1) >= v) tail--;
    q[tail++] = i;
    while ((q[head] ?? 0) > i + reach - 1) head++;
    g[i] = need[q[head] ?? 0] ?? 1;
  }
  const back = Math.exp(-1 / (0.1 * fs));
  let r = 1;
  for (let i = 0; i < n; i++) {
    r = Math.min(g[i] ?? 1, 1 - (1 - r) * back);
    g[i] = r;
  }
  for (let pass = 0; pass < 2; pass++) {
    const src = Float32Array.from(g);
    let sum = 0;
    for (let i = 0; i < n; i++) {
      sum += src[i] ?? 0;
      if (i >= half) sum -= src[i - half] ?? 0;
      g[i] = sum / Math.min(i + 1, half);
    }
  }
  return g;
}

// ---------------------------------------------------------------- checking

/**
 * @typedef {object} Finding
 * @property {string} stem the name it was given
 * @property {"nonfinite" | "clip" | "click" | "dc"} kind
 * @property {number[]} channels where it was found
 * @property {number} at s
 * @property {number} [end] s, for what lasts
 * @property {string} message what it is, and what usually causes it
 */

/**
 * What a mix hides, one stem at a time, each with its time: samples that are
 * not numbers; clipping; clicks; DC. A click is a jump in the waveform — its
 * second difference far above the RMS around it and above the jumps the sound
 * itself makes nearby (a saw's own edges repeat, so they do not count). It
 * comes from an envelope that jumps (a note cut short, a release from the
 * wrong level), a sound starting mid-cycle, oscillators started in phase so
 * their edges land together, or a filter that blew up. Run it on each bus or
 * stem as well as the master: in the mix, other sounds mask what it looks for.
 * @param {string} name
 * @param {Channels | Signal} channels
 * @param {number} [sampleRate]
 * @returns {Finding[]}
 */
export function diagnose(name, channels, sampleRate = rateOf(channels)) {
  const chs = chans(channels);
  /** @type {Finding[]} */
  const found = [];
  chs.forEach((x, c) => {
    /** @param {Omit<Finding, "stem" | "channels">} f */
    const add = (f) => found.push({ stem: name, channels: [c], ...f });
    nonfinite(name, x, sampleRate, add);
    clipping(name, x, sampleRate, add);
    clicks(name, x, sampleRate, add);
    offset(name, x, sampleRate, add);
  });
  // the same thing at the same moment in several channels is one finding
  /** @type {Finding[]} */
  const merged = [];
  for (const f of found) {
    const same = merged.find(
      (m) =>
        m.kind === f.kind &&
        Math.abs(m.at - f.at) < 0.002 &&
        !m.channels.includes(/** @type {number} */ (f.channels[0])),
    );
    if (same) same.channels.push(...f.channels);
    else merged.push(f);
  }
  return merged.sort((a, b) => a.at - b.at);
}

/** @typedef {(f: Omit<Finding, "stem" | "channels">) => void} Add */

/** @param {string} name @param {Signal} x @param {number} fs @param {Add} add */
function nonfinite(name, x, fs, add) {
  let first = -1;
  let last = -1;
  let count = 0;
  x.forEach((v, i) => {
    if (Number.isFinite(v)) return;
    if (first < 0) first = i;
    last = i;
    count++;
  });
  if (count)
    add({
      kind: "nonfinite",
      at: secs(first / fs),
      end: secs(last / fs),
      message:
        `${name}: ${count} sample${count > 1 ? "s are" : " is"} NaN or infinite, ` +
        `${secs(first / fs)}–${secs(last / fs)} s — a filter or feedback loop blew up, ` +
        "or a NaN came in (0/0, a missing value)",
    });
}

/** samples past full scale, or flat on it (the same sample twice: a peak
 *  that only touches 1.0 is not clipped), joined when under 10 ms apart
 *  @param {string} name @param {Signal} x @param {number} fs @param {Add} add */
function clipping(name, x, fs, add) {
  const join = Math.round(0.01 * fs);
  /** @type {{ a: number, b: number, peak: number, flat: boolean }[]} */
  const all = [];
  let prev = 0;
  x.forEach((v, i) => {
    const m = Math.abs(v);
    const flat = v === prev;
    prev = v;
    if (!(m >= 1) || !Number.isFinite(m)) return;
    const r = all[all.length - 1];
    if (r && i - r.b <= join) {
      r.b = i;
      r.peak = Math.max(r.peak, m);
      r.flat ||= flat;
    } else all.push({ a: i, b: i, peak: m, flat });
  });
  const runs = all.filter((r) => r.peak > 1 || r.flat);
  for (const r of runs.slice(0, 20)) {
    const at = secs(r.a / fs);
    const end = secs((r.b + 1) / fs);
    const db = Math.round(dbOf(r.peak) * 10) / 10;
    add({
      kind: "clip",
      at,
      end,
      message:
        r.peak >= 16
          ? `${name}: far over full scale ${at}–${end} s (peak +${db} dBFS) — something ran away: a filter or a feedback loop`
          : r.peak > 1
            ? `${name}: over full scale ${at}–${end} s (peak +${db} dBFS) — it clips when written; bring it down (normalize does, on the master)`
            : `${name}: flat at full scale ${at}–${end} s — already clipped`,
    });
  }
  if (runs.length > 20)
    add({
      kind: "clip",
      at: secs((runs[20]?.a ?? 0) / fs),
      message: `${name}: ${runs.length - 20} more runs at full scale after these`,
    });
}

/** jumps: a second difference over 8× its RMS in the 5 ms either side (past
 *  1 ms, the width of a click), and over the jumps the sound itself makes out
 *  to 25 ms: 2.5× the typical one when a side is quiet (a start, a cut), 4×
 *  when both are busy (in a chord of plain saws, a few edges that fall
 *  together by chance are part of its buzz)
 *  @param {string} name @param {Signal} x @param {number} fs @param {Add} add */
function clicks(name, x, fs, add) {
  const n = x.length;
  const guard = Math.round(0.001 * fs);
  const wide = Math.round(0.005 * fs);
  const far = Math.round(0.025 * fs);
  // the second difference, the signal taken as 0 outside it (a stem that
  // starts or stops on a non-zero sample starts or stops with a jump). Where
  // a sample is not a number, none; past 4, which only samples past full
  // scale can reach, 4 — those have findings of their own
  /** @param {number} i */
  const at = (i) => (i >= 0 && i < n ? (x[i] ?? 0) : 0);
  const d = new Float32Array(n + 2); // d[k] is the second difference at sample k − 1
  for (let k = 0; k < n + 2; k++) {
    const v = Math.abs(at(k) - 2 * at(k - 1) + at(k - 2));
    d[k] = Number.isFinite(v) ? Math.min(v, 4) : 0;
  }
  const sq = new Float64Array(n + 3);
  for (let k = 0; k < n + 2; k++) sq[k + 1] = (sq[k] ?? 0) + (d[k] ?? 0) ** 2;
  /** @param {number} a @param {number} b */
  const rms = (a, b) => {
    const lo = Math.max(0, a);
    const hi = Math.min(n + 2, b);
    return hi > lo ? Math.sqrt(((sq[hi] ?? 0) - (sq[lo] ?? 0)) / (hi - lo)) : 0;
  };
  /** the typical jump in [a, b): the median of the peaks of d at least
   *  `floor` high (a resonant filter's ringing is lower, and left out); 0
   *  when there are none — that side is quiet
   *  @param {number} a @param {number} b @param {number} floor */
  const typical = (a, b, floor) => {
    const peaks = [];
    for (let k = Math.max(1, a); k < Math.min(n + 2, b); k++) {
      const v = d[k] ?? 0;
      if (v >= floor && v >= (d[k - 1] ?? 0) && v > (d[k + 1] ?? 0)) peaks.push(v);
    }
    peaks.sort((p, q) => p - q);
    return peaks[peaks.length >> 1] ?? 0;
  };
  let count = 0;
  let more = 0;
  for (let k = 0; k < n + 2; k++) {
    const v = d[k] ?? 0;
    if (v < 0.003) continue;
    const around = Math.max(
      rms(k - guard - wide, k - guard),
      rms(k + guard + 1, k + guard + 1 + wide),
    );
    if (v < 8 * around) continue;
    const before = typical(k - far, k - guard, v / 4);
    const after = typical(k + guard + 1, k + far + 1, v / 4);
    if (before && after ? v < 4 * Math.max(before, after) : v < 2.5 * (before || after)) continue;
    const t = secs(Math.max(0, k - 1) / fs);
    if (++count === 21) more = t;
    if (count <= 20)
      add({
        kind: "click",
        at: t,
        message:
          `${name}: a click at ${t} s — a jump ${around > 0 ? `${Math.round(v / around)}×` : "far above"} ` +
          "the sound around it: a note cut short, a release from the wrong level, a sound " +
          "starting mid-cycle, oscillators started in phase, or a filter that blew up",
      });
    k += guard; // one click, not its neighbours
  }
  if (count > 20)
    add({ kind: "click", at: more, message: `${name}: ${count - 20} more clicks from ${more} s` });
}

/** DC: the mean of 1 s windows (every 0.5 s) past 0.01 (−40 dBFS)
 *  @param {string} name @param {Signal} x @param {number} fs @param {Add} add */
function offset(name, x, fs, add) {
  const win = Math.min(x.length, fs);
  if (win === 0) return;
  /** @type {{ a: number, b: number, worst: number } | null} */
  let run = null;
  /** @type {{ a: number, b: number, worst: number }[]} */
  const runs = [];
  for (let a = 0; a + win <= x.length; a += Math.max(1, Math.round(win / 2))) {
    let sum = 0;
    for (let i = a; i < a + win; i++) {
      const v = x[i] ?? 0;
      if (Number.isFinite(v)) sum += v;
    }
    const mean = sum / win;
    if (Math.abs(mean) <= 0.01) run = null;
    else if (run) {
      run.b = a + win;
      if (Math.abs(mean) > Math.abs(run.worst)) run.worst = mean;
    } else {
      run = { a, b: a + win, worst: mean };
      runs.push(run);
    }
  }
  for (const r of runs)
    add({
      kind: "dc",
      at: secs(r.a / fs),
      end: secs(r.b / fs),
      message:
        `${name}: a DC offset of ${r.worst > 0 ? "+" : ""}${Math.round(r.worst * 1000) / 1000} ` +
        `(${Math.round(dbOf(Math.abs(r.worst)))} dBFS), ${secs(r.a / fs)}–${secs(r.b / fs)} s — ` +
        "a wave not centred on 0 (Math.random() for noise instead of 2·random − 1, a one-sided pulse)",
    });
}

// ---------------------------------------------------------------- material

// Sound that is not synthesized: a recording, the product's own sounds, a
// licensed track. `load` decodes any audio file ffmpeg reads; the rest place a
// piece of it in the film — a slice, aligned on its attack or its peak to a
// moment, faster or slower, with its level, pan and send following numbers or
// a curve the picture exported, into a bus or a shared room.
//
//   const ev = readEvents("film.events.json");          // `film render` wrote it
//   const tap = slice(load("taps.wav"), 1.2, 1.5);
//   for (const e of ev.events.filter((e) => e.kind === "key"))
//     play(sfx, tap, e.t, { align: "onset", pan: panFor(e.x ?? 960), gain: 0.5 });
//   const room = space(ev.duration, { size: 0.3 });
//   play(music, load("track.m4a"), 0, { gain: curveOf(ev, "zoom", (z) => 0.6 + 0.2 * z),
//     send: { bus: room.send, amount: 0.15 } });
//   mix(master, room.wet());

/**
 * A number that stays put, or one that follows film time: `(t) => number`, t
 * in seconds of the film. Followed at 750 points a second (every 64 samples
 * at 48 kHz) and smoothed between them.
 * @typedef {number | ((t: number) => number)} Auto
 */

/** automation is read every this many samples, and linear between */
const CTRL = 64;

/** the ffmpeg build `open-take` fetches for this machine, as its release names it */
const managedKey = () =>
  process.platform === "win32" && process.arch === "arm64"
    ? "win32-x64"
    : `${process.platform}-${process.arch}`;

/** @type {string | null} */
let ffmpegFound = null;

/**
 * The ffmpeg `load` decodes with: OPEN_TAKE_FFMPEG when it is set; else one on
 * PATH; else the one open-take keeps in ~/.open-take/ffmpeg (fetched by any
 * `open-take` render).
 * @returns {string}
 */
export function findFfmpeg() {
  ffmpegFound ??= locateFfmpeg();
  return ffmpegFound;
}

/** @returns {string} */
function locateFfmpeg() {
  const exe = process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg";
  /** @param {string} bin */
  const runs = (bin) => spawnSync(bin, ["-version"], { stdio: "ignore" }).status === 0;
  const named = process.env.OPEN_TAKE_FFMPEG;
  if (named) {
    if (!runs(named)) throw new Error(`load: OPEN_TAKE_FFMPEG (${named}) does not run`);
    return named;
  }
  if (runs("ffmpeg")) return "ffmpeg";
  const home = join(homedir(), ".open-take", "ffmpeg");
  const releases = existsSync(home) ? readdirSync(home).sort().reverse() : [];
  for (const r of releases) {
    const bin = join(home, r, managedKey(), exe);
    if (existsSync(bin) && runs(bin)) return bin;
  }
  throw new Error(
    "load: no ffmpeg — set OPEN_TAKE_FFMPEG, install one, or run any `open-take` render once (it fetches one)",
  );
}

/**
 * Any audio file ffmpeg reads (wav, mp3, m4a, ogg, flac, the sound of a
 * video…), decoded to float channels at `sampleRate` (default the film's
 * 48 kHz). `channels` defaults to the file's: mono stays mono (pan places it),
 * anything wider comes as stereo.
 * @param {string} path
 * @param {{ sampleRate?: number, channels?: number }} [o]
 * @returns {Channels}
 */
export function load(path, { sampleRate = RATE, channels } = {}) {
  if (!existsSync(path)) throw new Error(`load: there is no file at ${path}`);
  const ffmpeg = findFfmpeg();
  let n = channels;
  if (n == null) {
    // ffmpeg describes the input, then stops: no output was asked for
    const info = spawnSync(ffmpeg, ["-hide_banner", "-i", path], { encoding: "utf8" });
    const stream = /Stream #\S+.*?Audio: ([^\n]*)/.exec(info.stderr ?? "");
    if (!stream) throw new Error(`load: ${path} has no sound ffmpeg can read`);
    n = /\bmono\b|\b1 channels\b/.test(stream[1] ?? "") ? 1 : 2;
  }
  if (!(n >= 1 && Number.isInteger(n))) throw new Error(`load: ${channels} is not a channel count`);
  const r = spawnSync(
    ffmpeg,
    [
      "-v",
      "error",
      "-i",
      path,
      "-map",
      "0:a:0",
      "-f",
      "f32le",
      "-acodec",
      "pcm_f32le",
      "-ar",
      String(sampleRate),
      "-ac",
      String(n),
      "-",
    ],
    { maxBuffer: 2 ** 31 - 1 },
  );
  if (r.status !== 0)
    throw new Error(
      `load: ffmpeg could not decode ${path}: ${String(r.stderr).trim().slice(-400)}`,
    );
  const raw = /** @type {Buffer} */ (r.stdout);
  const frames = Math.floor(raw.length / 4 / n);
  const all = new Float32Array(raw.buffer.slice(raw.byteOffset, raw.byteOffset + frames * n * 4));
  const out = Array.from({ length: n }, () => new Float32Array(frames));
  for (let i = 0; i < frames; i++)
    for (let c = 0; c < n; c++) /** @type {Float32Array} */ (out[c])[i] = all[i * n + c] ?? 0;
  return withRate(out, sampleRate);
}

/**
 * <film>.events.json, as `film render` writes it beside the film: the page's
 * events (t, kind, x, y, force, label), its cuts, its curves sampled once
 * a frame — for `curveOf` — and the credits the page kept (what it uses that
 * someone else made, and on what licence; [] in a file written before there
 * were credits).
 * @param {string} path
 * @returns {FilmEvents}
 */
export function readEvents(path) {
  /** @type {FilmEvents} */
  let ev;
  try {
    ev = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    throw new Error(`readEvents: ${path}: ${/** @type {Error} */ (e).message}`);
  }
  if (ev?.version !== 1 || !Array.isArray(ev.events) || !ev.curves)
    throw new Error(`readEvents: ${path} is not an events file \`film render\` writes (version 1)`);
  if (!Array.isArray(ev.credits)) ev.credits = [];
  return ev;
}

/**
 * @typedef {object} FilmEvents  <film>.events.json (times in seconds of the page's timeline)
 * @property {1} version
 * @property {number} duration
 * @property {number} fps
 * @property {[number, number]} [range] [from, to) when only part of the film was rendered
 * @property {{ t: number, kind: string, x?: number, y?: number, force?: number, label?: string }[]} events
 * @property {number[]} cuts
 * @property {number[]} [declaredCuts]
 * @property {number[]} [detectedCuts]
 * @property {{ names: string[], t0: number, dt: number, rows: (number | null)[][] }} curves
 * @property {{ what?: string, by?: string, licence?: string, url?: string, text?: string }[]} [credits]
 *   window.__film.credits: information only, nothing checks it
 */

/**
 * One of the film's curves as a function of film time, for an `Auto`: linear
 * between frames — and across frames the page gave no number — held past the ends.
 * `map` turns its value into what you want (a gain, a pan, a send).
 *
 * A hard cut is not a move: the curve is split there, not drawn straight
 * across. Each shot is its own curve — linear inside it, its last value held
 * up to the cut, the next shot's first value from the cut on — so a level
 * that follows the camera steps with the picture instead of gliding into the
 * cut a frame early or spiking over it. The cuts are, by default, the events
 * file's (`declaredCuts` and `detectedCuts`, merged when less than half a
 * frame apart); `{ cuts: [...] }` gives your own (times, or events of kind
 * "cut"), `{ cuts: [] }` draws straight across them all. A cut at c belongs to
 * the shot that starts at c. A shot the page gave no number in (or one
 * shorter than a frame, e.g. a declared cut a frame off the one the picture
 * shows) holds the last number before it, or the first after. A step is a step: smooth it in the
 * score (e.g. a short crossfade) if you want it softer.
 *
 *   gain: curveOf(ev, "camSpeed", (v) => 0.2 + v / 4000)            // split at the film's cuts
 *   gain: curveOf(ev, "camSpeed", { map: (v) => v / 4000, cuts: [] }) // straight across
 *
 * @param {FilmEvents} ev
 * @param {string} name
 * @param {((v: number) => number) | CurveOptions} [mapOrOptions]
 * @param {CurveOptions} [options]
 * @returns {(t: number) => number}
 * @typedef {object} CurveOptions
 * @property {(v: number) => number} [map]
 * @property {readonly (number | { t?: number, t0?: number, kind?: string })[]} [cuts] default the events file's
 */
export function curveOf(ev, name, mapOrOptions, options = {}) {
  const o =
    typeof mapOrOptions === "function"
      ? { ...options, map: mapOrOptions }
      : { ...(mapOrOptions ?? {}), ...options };
  const map = o.map ?? ((v) => v);
  const j = ev.curves.names.indexOf(name);
  if (j < 0)
    throw new Error(
      `curveOf: the film has no curve "${name}" (it has: ${ev.curves.names.join(", ") || "none"})`,
    );
  const { t0, dt } = ev.curves;
  // the cuts, ascending: the caller's, or the events file's own
  /** @param {readonly (number | { t?: number, t0?: number, kind?: string })[] | undefined} list */
  const times = (list) =>
    (list ?? [])
      .map((c) =>
        typeof c === "number"
          ? c
          : c && c.kind === "cut"
            ? (c.t ?? c.t0 ?? Number.NaN)
            : Number.NaN,
      )
      .filter((t) => Number.isFinite(t));
  const cuts = (
    o.cuts != null
      ? times(o.cuts)
      : times([...(ev.declaredCuts ?? []), ...(ev.detectedCuts ?? []), ...(ev.cuts ?? [])])
  )
    .sort((a, b) => a - b)
    .filter((t, i, all) => i === 0 || t - (all[i - 1] ?? 0) >= dt / 2);
  // which shot a time is in: how many cuts lie at or before it
  const tol = Math.min(1e-6, dt / 1000);
  /** @param {number} t */
  const shotOf = (t) => {
    let k = 0;
    while (k < cuts.length && t >= (cuts[k] ?? 0) - tol) k++;
    return k;
  };
  // the frames the page gave a number for, with the number, and the shot each is in
  /** @type {number[]} */
  const at = [];
  /** @type {number[]} */
  const vs = [];
  /** @type {number[]} */
  const shots = [];
  ev.curves.rows.forEach((row, i) => {
    const v = row[j];
    if (typeof v === "number" && Number.isFinite(v)) {
      at.push(i);
      vs.push(v);
      shots.push(shotOf(t0 + i * dt));
    }
  });
  if (!at.length) throw new Error(`curveOf: the curve "${name}" has no numbers`);
  // each shot's run of frames in `at` (frames are in time order, so shots are runs)
  /** @type {Map<number, [number, number]>} */
  const runs = new Map();
  shots.forEach((k, i) => {
    const r = runs.get(k);
    if (r) r[1] = i + 1;
    else runs.set(k, [i, i + 1]);
  });
  /** linear between the frames lo..hi-1 of `at`, held past them @param {number} f @param {number} first @param {number} end */
  const within = (f, first, end) => {
    const last = end - 1;
    if (f <= (at[first] ?? 0)) return vs[first] ?? 0;
    if (f >= (at[last] ?? 0)) return vs[last] ?? 0;
    let lo = first;
    let hi = last;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if ((at[mid] ?? 0) <= f) lo = mid;
      else hi = mid;
    }
    const a = at[lo] ?? 0;
    const b = at[hi] ?? a + 1;
    const u = (f - a) / (b - a);
    return (vs[lo] ?? 0) * (1 - u) + (vs[hi] ?? 0) * u;
  };
  return (t) => {
    const f = (t - t0) / dt;
    if (!cuts.length) return map(within(f, 0, at.length));
    const k = shotOf(t);
    const run = runs.get(k);
    if (run) return map(within(f, run[0], run[1]));
    // a shot with no numbers (none given there, or shorter than a frame): the
    // nearest number before it held, else the first after — never a glide
    // across a cut
    let i = shots.length - 1;
    while (i >= 0 && (shots[i] ?? 0) > k) i--;
    return map(vs[i >= 0 ? i : shots.findIndex((s) => s > k)] ?? 0);
  };
}

/**
 * Where a point on the stage sits left to right, as a pan: −1 at the left
 * edge, 1 at the right, times `spread` (0.5 keeps it nearer the middle).
 * @param {number} x stage px
 * @param {number} [width] the stage's width (px)
 * @param {number} [spread]
 */
export const panFor = (x, width = 1920, spread = 1) =>
  Math.max(-1, Math.min(1, ((2 * x) / width - 1) * spread));

/**
 * A copy of [from, to) s of a sound (to: its end).
 * @param {Channels | Signal} sound
 * @param {number} from
 * @param {number} [to]
 * @returns {Channels}
 */
export function slice(sound, from, to) {
  const sr = rateOf(sound);
  const src = chans(sound);
  const n = src[0]?.length ?? 0;
  const a = Math.max(0, Math.min(n, Math.round(from * sr)));
  const b = Math.max(a, Math.min(n, Math.round((to ?? n / sr) * sr)));
  return withRate(
    src.map((c) => Float32Array.from(c.subarray(a, b))),
    sr,
  );
}

/**
 * A copy with gentle edges: raised-cosine fades `in` s at the start and `out`
 * s at the end — a slice cut out of a recording starts and ends mid-wave,
 * which is a click.
 * @param {Channels | Signal} sound
 * @param {{ in?: number, out?: number }} [o]
 * @returns {Channels}
 */
export function fade(sound, { in: fin = 0.003, out = 0.01 } = {}) {
  const sr = rateOf(sound);
  const out_ = chans(sound).map((c) => Float32Array.from(c));
  const n = out_[0]?.length ?? 0;
  const a = Math.min(n, Math.round(fin * sr));
  const b = Math.min(n, Math.round(out * sr));
  for (const c of out_) {
    for (let i = 0; i < a; i++) c[i] = (c[i] ?? 0) * 0.5 * (1 - Math.cos((Math.PI * i) / a));
    for (let i = 0; i < b; i++)
      c[n - 1 - i] = (c[n - 1 - i] ?? 0) * 0.5 * (1 - Math.cos((Math.PI * i) / b));
  }
  return withRate(out_, sr);
}

/** |x| at its largest across channels, sample by sample @param {Signal[]} src */
function magnitude(src) {
  const n = src[0]?.length ?? 0;
  const m = new Float32Array(n);
  for (const c of src) for (let i = 0; i < n; i++) m[i] = Math.max(m[i] ?? 0, Math.abs(c[i] ?? 0));
  return m;
}

/**
 * When a sound's attack begins (s into it): where its level — the RMS over
 * `window` s — first reaches `threshold` of its loudest (0.1 is 20 dB down),
 * traced back to the first sample of that rise above a tenth of it. Line a
 * recorded key's attack up with the key, not the silence the recording starts
 * with. null when it is silent.
 * @param {Channels | Signal} sound
 * @param {{ threshold?: number, window?: number }} [o]
 * @returns {number | null}
 */
export function onsetOf(sound, { threshold = 0.1, window = 0.002 } = {}) {
  const sr = rateOf(sound);
  const m = magnitude(chans(sound));
  const w = Math.max(1, Math.round(window * sr));
  const level = new Float32Array(m.length);
  let sum = 0;
  let top = 0;
  for (let i = 0; i < m.length; i++) {
    sum += (m[i] ?? 0) ** 2 - (i >= w ? (m[i - w] ?? 0) ** 2 : 0);
    const v = Math.sqrt(Math.max(0, sum) / w);
    level[i] = v;
    if (v > top) top = v;
  }
  if (top <= 0) return null;
  // the level reaches the threshold at i, over the w samples up to it; the
  // attack began at the first of those that is not still silence (a tenth of
  // the threshold, so the quiet before it does not count)
  const i = level.findIndex((v) => v >= threshold * top);
  let j = Math.max(0, i - w + 1);
  while (j < i && (m[j] ?? 0) < 0.1 * threshold * top) j++;
  return j / sr;
}

/**
 * Where a sound is loudest (s into it): its largest sample. null when silent.
 * @param {Channels | Signal} sound
 * @returns {number | null}
 */
export function peakOf(sound) {
  const m = magnitude(chans(sound));
  let best = 0;
  let at = -1;
  for (let i = 0; i < m.length; i++)
    if ((m[i] ?? 0) > best) {
      best = m[i] ?? 0;
      at = i;
    }
  return at < 0 ? null : at / rateOf(sound);
}

/** I0, the modified Bessel function — for the Kaiser window @param {number} x */
function bessel0(x) {
  let sum = 1;
  let term = 1;
  for (let k = 1; k < 64 && term > sum * 1e-17; k++) {
    term *= (x / (2 * k)) ** 2;
    sum += term;
  }
  return sum;
}

/** the Kaiser window (β 8) at |r| = i / KAISER_N, 0..1, looked up and interpolated */
const KAISER_N = 4096;
/** @type {Float64Array | null} */
let kaiserTable = null;
/** @param {number} r −1..1 */
function kaiser(r) {
  if (!kaiserTable) {
    const t = new Float64Array(KAISER_N + 2);
    const i0 = bessel0(8);
    for (let i = 0; i <= KAISER_N; i++)
      t[i] = bessel0(8 * Math.sqrt(Math.max(0, 1 - (i / KAISER_N) ** 2))) / i0;
    kaiserTable = t;
  }
  const x = Math.abs(r) * KAISER_N;
  const i = Math.floor(x);
  const a = kaiserTable[i] ?? 0;
  return a + ((kaiserTable[i + 1] ?? 0) - a) * (x - i);
}

/**
 * A sound played `rate` times as fast: pitch and length change together, as
 * a tape's do (2 is an octave up and half as long; `2 ** (n / 12)` is n
 * semitones). Windowed-sinc interpolation (Kaiser, β 8, 16 zero crossings a
 * side), its cutoff lowered when it speeds up so nothing folds back.
 * @param {Channels | Signal} sound
 * @param {number} rate
 * @returns {Channels}
 */
export function varispeed(sound, rate) {
  if (!(rate > 0) || !Number.isFinite(rate))
    throw new Error(`varispeed: rate must be a number above 0 (got ${rate})`);
  const sr = rateOf(sound);
  const src = chans(sound);
  if (rate === 1)
    return withRate(
      src.map((c) => Float32Array.from(c)),
      sr,
    );
  const n = src[0]?.length ?? 0;
  const m = Math.floor((n - 1) / rate) + 1;
  const cut = Math.min(1, 1 / rate); // of Nyquist
  const zeros = 16;
  const reach = Math.ceil(zeros / cut);
  const out = src.map(() => new Float32Array(m));
  const acc = new Float64Array(src.length);
  for (let j = 0; j < m; j++) {
    const pos = j * rate;
    const base = Math.floor(pos);
    let wsum = 0;
    acc.fill(0);
    for (let k = base - reach + 1; k <= base + reach; k++) {
      if (k < 0 || k >= n) continue;
      const u = (pos - k) * cut;
      const r = u / zeros;
      if (r <= -1 || r >= 1) continue;
      const sinc = u === 0 ? 1 : Math.sin(Math.PI * u) / (Math.PI * u);
      const w = sinc * kaiser(r);
      wsum += w;
      for (let c = 0; c < src.length; c++) acc[c] = (acc[c] ?? 0) + w * (src[c]?.[k] ?? 0);
    }
    // normalized by the weights: unity at DC, near the edges too
    for (let c = 0; c < src.length; c++)
      /** @type {Float32Array} */ (out[c])[j] = wsum ? (acc[c] ?? 0) / wsum : 0;
  }
  return withRate(out, sr);
}

/** an Auto's value at film time t @param {Auto} v @param {number} t */
const autoAt = (v, t) => (typeof v === "function" ? v(t) : v);

/**
 * Place a sound in a bus at film time `at`: the point of it named by `align`
 * — its start, its attack (`onsetOf`), its loudest sample (`peakOf`), or a
 * time into it (s) — lands on `at`. On the way it can be sped up or slowed
 * (`rate`, `semitones`: pitch and length together), and its gain, pan and send
 * can each be a number or follow film time (an `Auto`, e.g. `curveOf`). A pan
 * places a mono sound between the speakers at equal power (−3 dB each in the
 * middle) and balances a stereo one; without one, every channel gets the gain,
 * as `mix` does. `send` puts the same sound, times `amount`, into a shared
 * room's send bus (`space`) as well. Returns where in the film it sounds (s).
 * @param {Channels} into
 * @param {Channels | Signal} sound
 * @param {number} at
 * @param {object} [o]
 * @param {"start" | "onset" | "peak" | number} [o.align]
 * @param {number} [o.rate]
 * @param {number} [o.semitones]
 * @param {Auto} [o.gain] linear (10 ** (dB / 20))
 * @param {Auto} [o.pan] -1 left to 1 right
 * @param {{ bus: Channels, amount?: Auto }} [o.send]
 * @returns {{ start: number, end: number }}
 */
export function play(
  into,
  sound,
  at,
  { align = "start", rate = 1, semitones = 0, gain = 1, pan, send } = {},
) {
  if (!Number.isFinite(at)) throw new Error(`play: ${at} is not a time in seconds`);
  const sr = into.sampleRate ?? RATE;
  const b = /** @type {{ sampleRate?: number }} */ (sound).sampleRate;
  if (b && b !== sr) throw new Error(`play: ${b} Hz into ${sr} Hz — load it at ${sr}`);
  const speed = rate * 2 ** (semitones / 12);
  const point =
    typeof align === "number"
      ? align
      : align === "onset"
        ? (onsetOf(sound) ?? 0)
        : align === "peak"
          ? (peakOf(sound) ?? 0)
          : 0;
  const src = speed === 1 ? chans(sound) : varispeed(sound, speed);
  const start = at - point / speed;
  const n = src[0]?.length ?? 0;
  const s0 = Math.round(start * sr);
  /** @param {Channels} bus @param {Auto} amount */
  const into1 = (bus, amount) => {
    const stereo = pan !== undefined && bus.length === 2;
    const i0 = Math.max(0, -s0);
    const i1 = Math.min(n, (bus[0]?.length ?? 0) - s0);
    for (let blk = i0; blk < i1; blk += CTRL) {
      const end = Math.min(i1, blk + CTRL);
      // the automation at both ends of the block, and linear between
      /** @param {number} i */
      const gains = (i) => {
        const t = (s0 + i) / sr;
        const g = autoAt(gain, t) * autoAt(amount, t);
        if (!stereo) return [g, g];
        const p = Math.max(-1, Math.min(1, autoAt(/** @type {Auto} */ (pan), t)));
        if (src.length === 1) {
          const th = ((p + 1) * Math.PI) / 4;
          return [g * Math.cos(th), g * Math.sin(th)];
        }
        return [
          g * (p > 0 ? Math.cos((p * Math.PI) / 2) : 1),
          g * (p < 0 ? Math.cos((-p * Math.PI) / 2) : 1),
        ];
      };
      const [la, ra] = /** @type {[number, number]} */ (gains(blk));
      const [lb, rb] = /** @type {[number, number]} */ (gains(end));
      if (![la, ra, lb, rb].every(Number.isFinite))
        throw new Error(`play: a gain, pan or send is not a number at ${secs((s0 + blk) / sr)} s`);
      bus.forEach((dst, c) => {
        const s = /** @type {Signal} */ (
          src.length === 1 ? src[0] : src[Math.min(c, src.length - 1)]
        );
        const g0 = stereo ? (c === 0 ? la : ra) : la;
        const g1 = stereo ? (c === 0 ? lb : rb) : lb;
        const span = end - blk;
        for (let i = blk; i < end; i++) {
          const g = g0 + ((g1 - g0) * (i - blk)) / span;
          dst[s0 + i] = (dst[s0 + i] ?? 0) + (s[i] ?? 0) * g;
        }
      });
    }
  };
  if (src.length !== 1 && src.length !== into.length)
    throw new Error(`play: ${src.length} channels into ${into.length} — give it mono, or as many`);
  if (send) {
    if (send.bus.sampleRate && send.bus.sampleRate !== sr)
      throw new Error(`play: the send bus is ${send.bus.sampleRate} Hz, the bus ${sr} Hz`);
    if (src.length !== 1 && src.length !== send.bus.length)
      throw new Error(
        `play: ${src.length} channels into a send bus of ${send.bus.length} — give it mono, or as many`,
      );
  }
  // checked before anything is mixed, so a refused play leaves the buses as they were
  into1(into, 1);
  if (send) into1(send.bus, send.amount ?? 1);
  return { start, end: start + n / sr };
}

/**
 * Buses by name, each `seconds` of silence: mix into them, process each as a
 * whole (a filter, a duck), then mix them into the master.
 * @template {string} K
 * @param {number} seconds
 * @param {K[]} names
 * @param {{ channels?: number, sampleRate?: number }} [o]
 * @returns {Record<K, Channels>}
 */
export function buses(seconds, names, o = {}) {
  return /** @type {Record<K, Channels>} */ (
    Object.fromEntries(names.map((k) => [k, buffer(seconds, o)]))
  );
}

/**
 * One room the whole film shares: sounds `play` with a `send` go into its send
 * bus, and `wet()` is that bus through one reverb (see `reverb` for size,
 * damp, width), to mix into the master at the level you want. Optional: a
 * film can stay dry, or put a sound in the room alone.
 * @param {number} seconds
 * @param {{ sampleRate?: number, size?: number, damp?: number, width?: number, tail?: number }} [o]
 */
export function space(seconds, { sampleRate = RATE, ...room } = {}) {
  const send = buffer(seconds, { sampleRate });
  return { send, wet: () => reverb(send, sampleRate, room) };
}

/**
 * `a` until `at`, then `b`, crossing over `dur` s from `at` on. Both are on
 * the film's timeline (a sample of each is the same moment). "power" keeps
 * the level even across sounds that differ; "linear" sums to one, for two
 * takes of the same sound.
 * @param {Channels} a
 * @param {Channels} b
 * @param {number} at
 * @param {number} dur
 * @param {{ shape?: "power" | "linear" }} [o]
 * @returns {Channels}
 */
export function crossfade(a, b, at, dur, { shape = "power" } = {}) {
  const sr = rateOf(a);
  if (rateOf(b) !== sr) throw new Error(`crossfade: ${rateOf(b)} Hz and ${sr} Hz`);
  if (a.length !== b.length) throw new Error(`crossfade: ${a.length} channels and ${b.length}`);
  if (!(dur >= 0)) throw new Error(`crossfade: dur must be ≥ 0 (got ${dur})`);
  const n = Math.max(a[0]?.length ?? 0, b[0]?.length ?? 0);
  const s = Math.round(at * sr);
  const d = Math.round(dur * sr);
  const out = a.map((ca, c) => {
    const cb = /** @type {Signal} */ (b[c]);
    const o = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const u = d === 0 ? (i < s ? 0 : 1) : Math.max(0, Math.min(1, (i - s) / d));
      const [ga, gb] =
        shape === "linear"
          ? [1 - u, u]
          : [Math.cos((u * Math.PI) / 2), Math.sin((u * Math.PI) / 2)];
      o[i] = (ca[i] ?? 0) * ga + (cb[i] ?? 0) * gb;
    }
    return o;
  });
  return withRate(out, sr);
}

// ---------------------------------------------------------------- bars

// A licensed or recorded track edited by whole bars, the way an editor cuts
// music under a film: keep some bars, skip others, loop one, each join a
// short crossfade that ends on the bar line, so the incoming bar's downbeat
// lands whole. The bars come from `open-take film beats track.mp3` (an
// estimate — its confidence is in the file; listen to the joins).
//
//   const track = load("track.mp3");
//   const beats = JSON.parse(readFileSync("track.beats.json", "utf8"));
//   // bar 40 (the drop) on the film's 16.0 s, then on through bar 46
//   const edit = cutToBars(track, beats, [...landOn(beats, { bar: 40, at: 16 }), { from: 40, to: 46 }]);
//   play(music, edit.sound, 0);
//   writeFileSync("music.beats.json", JSON.stringify(edit.beats));  // the edit's own grid, for cut.js

/**
 * `<name>.beats.json` as `open-take film beats` writes it (the fields used here).
 * @typedef {object} BeatsFile
 * @property {1} version
 * @property {string} [source]
 * @property {number} duration
 * @property {{ bpm: number | null, periodS?: number }} tempo
 * @property {number[]} beats
 * @property {number[]} downbeats
 * @property {{ t: number, index: number }[]} [bars]
 * @property {{ beatsPerBar: number | null }} [meter]
 * @property {{ t: number, end: number }[]} [sections]
 * @property {number[]} [drops]
 * @property {number[]} [onsets]
 */

/**
 * Source bars [from, to), played `times` over (default once). Bars count from
 * 0 at the first downbeat; `from` may fall mid-bar (a pickup into the first
 * piece), `to` may be "end" — the track's own ending.
 * @typedef {{ from: number, to: number | "end", times?: number }} BarPiece
 */

/** when a bar starts in the source (s): its downbeat, or past the known ones,
 *  a bar's length on; fractional bars fall between @param {BeatsFile} beats */
function barClock(beats) {
  const d = (beats.downbeats ?? []).filter((t) => Number.isFinite(t));
  if (d.length < 2)
    throw new Error(
      "cutToBars: the beats file has no bars (no downbeats were found) — cut by seconds with slice and crossfade",
    );
  const gaps = d
    .slice(1)
    .map((t, i) => t - /** @type {number} */ (d[i]))
    .sort((a, b) => a - b);
  const len = /** @type {number} */ (gaps[gaps.length >> 1]);
  const n = d.length;
  /** @param {number} i */
  return (i) => {
    if (i <= 0) return (d[0] ?? 0) + i * len;
    if (i >= n - 1) return (d[n - 1] ?? 0) + (i - (n - 1)) * len;
    const k = Math.floor(i);
    const a = d[k] ?? 0;
    const b = d[k + 1] ?? a;
    return a + (b - a) * (i - k);
  };
}

/**
 * The pieces that put source bar `bar`'s downbeat on film time `at` when the
 * edit starts playing at film time `start` (default 0): the bars just before
 * it, as many as fit, the first one entered part-way. Add the bars after it
 * yourself. When the track has too little before that bar, it says so.
 * @param {BeatsFile} beats
 * @param {{ bar: number, at: number, start?: number }} o
 * @returns {BarPiece[]}
 */
export function landOn(beats, { bar, at, start = 0 }) {
  if (![bar, at, start].every(Number.isFinite))
    throw new Error("landOn: bar, at and start are numbers");
  const clock = barClock(beats);
  const lead = at - start;
  if (lead < 0) throw new Error(`landOn: the edit starts at ${start} s, after ${at} s`);
  // the fractional bar `lead` s before it, along the bars as they fall (they
  // need not all be one length)
  const want = clock(bar) - lead;
  let lo = bar - lead / (clock(bar) - clock(bar - 1)) - 2;
  while (clock(lo) > want) lo -= 2;
  let hi = bar;
  for (let k = 0; k < 60; k++) {
    const mid = (lo + hi) / 2;
    if (clock(mid) < want) lo = mid;
    else hi = mid;
  }
  const from = (lo + hi) / 2;
  if (want < 0)
    throw new Error(
      `landOn: bar ${bar} is ${secs(clock(bar))} s into the track — it cannot sound ${secs(lead)} s after the edit starts; start the edit later (start: ${secs(at - clock(bar))}) or loop a bar before it`,
    );
  return lead > 0 ? [{ from, to: bar }] : [];
}

/**
 * A track cut by whole bars: the pieces in order, each `times` over, joined
 * by an equal-power crossfade of `xfade` s (default 30 ms) that ends on the
 * join — the outgoing bar fades under the incoming one's last moment before
 * its bar line, so the downbeat after the join is the incoming bar's own,
 * whole. Pieces that follow on in the source (one's `to` the next one's
 * `from`) play straight through. The first piece fades in over `fadeIn` s
 * (default 5 ms); the last fades out over `fadeOut` s (default 30 ms) unless it
 * runs to the track's "end". Returns the sound; `map`, where each piece sits
 * in the edit and where it came from; `joins`, the edit's seams; and `beats`,
 * the beats file laid onto the edit's own time — every time plus `at` (default
 * 0), where you will place the edit in the film — for cut.js grid().
 * @param {Channels} sound
 * @param {BeatsFile} beats
 * @param {BarPiece[]} plan
 * @param {{ xfade?: number, fadeIn?: number, fadeOut?: number, at?: number }} [o]
 */
export function cutToBars(
  sound,
  beats,
  plan,
  { xfade = 0.03, fadeIn = 0.005, fadeOut = 0.03, at = 0 } = {},
) {
  const sr = rateOf(sound);
  const src = chans(sound);
  const total = (src[0]?.length ?? 0) / sr;
  const clock = barClock(beats);
  if (!Array.isArray(plan) || !plan.length)
    throw new Error("cutToBars: the plan is a list of { from, to } bars");
  if (!(xfade >= 0 && fadeIn >= 0 && fadeOut >= 0)) throw new Error("cutToBars: fades are ≥ 0 s");
  /** @type {{ s0: number, s1: number, from: number, to: number | "end", toEnd: boolean }[]} */
  const runs = [];
  for (const p of plan) {
    const times = p.times ?? 1;
    if (!(Number.isInteger(times) && times >= 1))
      throw new Error(`cutToBars: times is a whole number ≥ 1 (got ${p.times})`);
    if (!Number.isFinite(p.from) || !(p.to === "end" || Number.isFinite(p.to)))
      throw new Error(`cutToBars: a piece is { from, to } bars (got ${JSON.stringify(p)})`);
    const s0 = Math.max(0, clock(p.from));
    const s1 = p.to === "end" ? total : Math.min(total, clock(p.to));
    if (!(s1 > s0))
      throw new Error(`cutToBars: bars ${p.from}–${p.to} hold no sound in this track`);
    for (let k = 0; k < times; k++)
      runs.push({ s0, s1, from: p.from, to: p.to, toEnd: p.to === "end" || s1 >= total });
  }
  // a piece that carries straight on from the last is no join
  /** @type {typeof runs} */
  const pieces = [];
  for (const r of runs) {
    const last = pieces[pieces.length - 1];
    if (last && Math.abs(last.s1 - r.s0) < 1 / sr && last.to !== "end") {
      last.s1 = r.s1;
      last.to = r.to;
      last.toEnd = r.toEnd;
    } else pieces.push({ ...r });
  }
  // in whole samples, piece by piece, as they are laid in below
  const n = pieces.reduce((a, p) => a + Math.round(p.s1 * sr) - Math.round(p.s0 * sr), 0);
  const length = n / sr;
  const out = src.map(() => new Float32Array(n));
  const xf = Math.round(xfade * sr);
  /** @type {{ at: number, end: number, from: number, to: number | "end", source: [number, number] }[]} */
  const map = [];
  /** the same, unrounded: the beats are moved by these, so a mark on a join stays on it
   *  @type {{ at: number, s0: number, s1: number }[]} */
  const exact = [];
  /** @type {number[]} */
  const joins = [];
  let pos = 0; // samples into the edit
  pieces.forEach((p, i) => {
    const a = Math.round(p.s0 * sr);
    const b = Math.round(p.s1 * sr);
    // the incoming piece starts xf before its bar line, under the outgoing one's tail
    const pre = i === 0 ? 0 : Math.min(xf, a, pos);
    for (let c = 0; c < out.length; c++) {
      const o = /** @type {Float32Array} */ (out[c]);
      const s = /** @type {Signal} */ (src[c]);
      for (let j = 0; j < pre; j++) {
        const u = (j + 0.5) / pre;
        const at_ = pos - pre + j;
        o[at_] =
          (o[at_] ?? 0) * Math.cos((u * Math.PI) / 2) +
          (s[a - pre + j] ?? 0) * Math.sin((u * Math.PI) / 2);
      }
      for (let j = 0; j < b - a && pos + j < n; j++) o[pos + j] = s[a + j] ?? 0;
    }
    if (i > 0) joins.push(secs(at + pos / sr));
    map.push({
      at: secs(at + pos / sr),
      end: secs(at + (pos + b - a) / sr),
      from: p.from,
      to: p.to,
      source: [secs(p.s0), secs(p.s1)],
    });
    exact.push({ at: at + pos / sr, s0: p.s0, s1: p.s1 });
    pos += b - a;
  });
  const edges = {
    in: Math.min(n, Math.round(fadeIn * sr)),
    out: pieces[pieces.length - 1]?.toEnd ? 0 : Math.min(n, Math.round(fadeOut * sr)),
  };
  for (const o of out) {
    for (let i = 0; i < edges.in; i++)
      o[i] = (o[i] ?? 0) * Math.sin(((i + 0.5) / edges.in) * (Math.PI / 2));
    for (let i = 0; i < edges.out; i++)
      o[n - 1 - i] = (o[n - 1 - i] ?? 0) * Math.sin(((i + 0.5) / edges.out) * (Math.PI / 2));
  }
  // the beats file on the edit's time: each source time inside a piece, moved with it
  /** @param {number[] | undefined} xs */
  const moved = (xs) =>
    exact.flatMap((m) =>
      (xs ?? [])
        .filter((t) => t >= m.s0 - 1e-6 && t < m.s1 - 1e-6)
        .map((t) => secs(m.at + (t - m.s0))),
    );
  const downbeats = moved(beats.downbeats);
  return {
    sound: withRate(out, sr),
    map,
    joins,
    beats: {
      ...beats,
      source: `${beats.source ?? "a track"}, cut to bars`,
      duration: secs(length),
      beats: moved(beats.beats),
      downbeats,
      bars: downbeats.map((t, index) => ({ t, index })),
      onsets: moved(beats.onsets),
      drops: moved(beats.drops),
      sections: exact.flatMap((m) =>
        (beats.sections ?? [])
          .filter((s) => s.end > m.s0 && s.t < m.s1)
          .map((s) => ({
            ...s,
            t: secs(m.at + Math.max(0, s.t - m.s0)),
            end: secs(m.at + Math.min(m.s1, s.end) - m.s0),
          })),
      ),
    },
  };
}

// ---------------------------------------------------------------- files

/**
 * Write a WAV file: 24-bit by default, or 16-bit, or 32-bit float. A sample
 * that is not a number stops it — that is a bug upstream, and `diagnose` says
 * where. Samples past full scale are clipped (not in float) and counted.
 * @param {string} path
 * @param {Channels | Signal} channels
 * @param {number} [sampleRate]
 * @param {16 | 24 | 32} [bits]
 * @returns {{ path: string, seconds: number, clipped: number }}
 */
export function writeWav(path, channels, sampleRate = rateOf(channels), bits = 24) {
  const chs = chans(channels);
  const n = sameLength("writeWav", chs);
  if (bits !== 16 && bits !== 24 && bits !== 32)
    throw new Error(`writeWav: ${bits}-bit is not one it writes (16, 24, or 32 for float)`);
  const bytes = bits / 8;
  const frame = bytes * chs.length;
  const out = Buffer.alloc(68 + n * frame);
  out.write("RIFF", 0, "ascii");
  out.writeUInt32LE(60 + n * frame, 4);
  out.write("WAVEfmt ", 8, "ascii");
  // WAVE_FORMAT_EXTENSIBLE, which the format asks for past 16 bits: it also
  // names the speakers (a plain header leaves "2 channels" for players to guess)
  out.writeUInt32LE(40, 16);
  out.writeUInt16LE(0xfffe, 20);
  out.writeUInt16LE(chs.length, 22);
  out.writeUInt32LE(sampleRate, 24);
  out.writeUInt32LE(sampleRate * frame, 28);
  out.writeUInt16LE(frame, 32);
  out.writeUInt16LE(bits, 34);
  out.writeUInt16LE(22, 36);
  out.writeUInt16LE(bits, 38);
  out.writeUInt32LE(chs.length === 1 ? 0x4 : 2 ** chs.length - 1, 40); // centre; or left, right, …
  out.writeUInt32LE(bits === 32 ? 3 : 1, 44); // the sample kind: 3 IEEE float, 1 PCM …
  Buffer.from("00001000800000aa00389b71", "hex").copy(out, 48); // … and the rest of its GUID
  out.write("data", 60, "ascii");
  out.writeUInt32LE(n * frame, 64);
  const full = bits === 16 ? 32768 : 8388608;
  let clipped = 0;
  chs.forEach((x, c) => {
    for (let i = 0; i < n; i++) {
      const v = x[i] ?? 0;
      if (!Number.isFinite(v))
        throw new Error(
          `writeWav ${path}: channel ${c} is ${v} at ${secs(i / sampleRate)} s — diagnose the stems to find which one`,
        );
      const o = 68 + i * frame + c * bytes;
      if (bits === 32) {
        out.writeFloatLE(v, o);
        continue;
      }
      if (v > 1 || v < -1) clipped++;
      // +1.0 itself is one step past the largest code: it lands on that code
      const q = Math.max(-full, Math.min(full - 1, Math.round(v * full)));
      out[o] = q & 255;
      out[o + 1] = (q >> 8) & 255;
      if (bits === 24) out[o + 2] = (q >> 16) & 255;
    }
  });
  writeFileSync(path, out);
  return { path, seconds: n / sampleRate, clipped };
}
