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

import { writeFileSync } from "node:fs";

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
  // whatever it is given, so search (secant steps in dB)
  /** @param {number} limit */
  const land = (limit) => {
    let d0 = lufs - before;
    let l0 = render(d0, limit);
    if (Math.abs(l0 - lufs) < 0.01) return d0;
    let d1 = d0 + (lufs - l0);
    let l1 = render(d1, limit);
    for (let k = 0; k < 12 && Math.abs(l1 - lufs) >= 0.01; k++) {
      const slope = (l1 - l0) / (d1 - d0);
      const d2 = d1 + (lufs - l1) / (slope > 0.05 ? slope : 1);
      d0 = d1;
      l0 = l1;
      d1 = d2;
      l1 = render(d1, limit);
    }
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
