// @ts-check
// palette.mjs — a score's low foundation, sounds that land on picture, and a
// card to compare its balance, movement and stereo width. The card comes
// from six films' soundtracks, read with measure(); its ranges are the span
// those six covered (see REELS), not a target to mix into.
//
//   bed(seconds, o)             Channels to mix into a bus yourself: a sub on
//                               the roots (MIDI note numbers, one per bar)
//   hit(o)                      a small or big impact as Channels
//   hit(bus, at, o)             an impact with its fastest rise on at, lifted
//                               4.8 dB over what the bus already holds there
//                               (mix the bed first); `over: [buses]` names what
//                               to stand above instead, `over: []` plays `gain`
//                               as given
//   hits(bus, moves, o)         small hits at camera starts and landings, lifted
//                               the same way; a move is { start, end } or
//                               { t0, t1 } in seconds
//   build(bus, from, to, o)     a rising tone and noise leading into to
//   drop(bus, at, o)            the hit on a reveal and a sub glide beneath it
//   whoosh(o)                   a swept sound; place its loudest moment with
//                               play(bus, sound, at, { align: "peak", pan })
//   measure(channels)           the figures for a mono or stereo mix
//   score(figures, card?)       each figure beside the card's range
//   REELS                       the six soundtracks' figures and their ranges
//   node lib/palette.mjs [--json] score.wav [other.wav …]
//
// The kit's subIn(bus, at) holds the low band (under 80 Hz) down from the
// start of the bus until at and brings it in 18.3 dB; give it `since` to hold
// it down only from then. dropOut(bus, at) takes it 19.4 dB down for 1.4 s
// (`full: true`: the whole bus, 22 dB).
import { existsSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

// The fallback finds the kit when Node reads lib/ in place under starter/.
const localKit = new URL("../kit/audio.mjs", import.meta.url);
const { biquad, buffer, fade, filterOpen, hitOf, load, loudness, mix, osc, play, rng } =
  /** @type {typeof import("../kit/audio.mjs")} */ (await import(
    existsSync(localKit) ? localKit.href : new URL("../../kit/audio.mjs", import.meta.url).href
  ));

/** @typedef {import("../kit/audio.mjs").Channels} Channels */
/** @typedef {import("../kit/audio.mjs").Signal} Signal */

const RATE = 48000;
/** @param {number} u */
const clamp = (u) => Math.max(0, Math.min(1, u));
/** @param {number} u */
const ease = (u) => (1 - Math.cos(Math.PI * clamp(u))) / 2;

/**
 * Sub on MIDI roots, one per bar, repeated. The same rounded sine goes to both
 * sides. `texture` is a faint grain on top of the sub and `harmonic` adds a
 * soft overtone. Leave the mix's grit to the instruments and effects.
 * In DdT1-vziRp3, 0–59.561 s, sub is 4.5 dB below the total, active in 79%
 * of 50 ms windows, with L/R correlation 0.976. Returns stereo Channels of
 * `seconds`; mix them into a bus: mix(bus, bed(seconds)).
 * @param {number} seconds
 * @param {{ roots?: readonly number[], bar?: number, sub?: number, texture?: number,
 *   harmonic?: number, width?: number, sampleRate?: number, seed?: number }} [o]
 */
export function bed(seconds, { roots = [28, 24, 31, 35], bar = 2, sub = 0.12, texture = 0.004,
  harmonic = 0.015, width = 0.65, sampleRate = RATE, seed = 1 } = {}) {
  if (!roots.length || !(bar > 0) || !Number.isFinite(bar)) throw new Error("bed: give it roots and a positive bar length");
  const out = buffer(seconds, { sampleRate });
  const random = rng(seed);
  const grain = biquad("bed grain", "bandpass", { freq: 2200, q: 0.6 }, sampleRate);
  const [left, right] = /** @type {[Signal, Signal]} */ (out);
  const blend = Math.min(0.05, bar / 4);
  for (let b = 0; b * bar < seconds; b++) {
    const at = b * bar;
    const length = Math.min(bar + blend, seconds - at);
    const root = /** @type {number} */ (roots[b % roots.length]);
    const pitch = 440 * 2 ** ((root - 69) / 12);
    const wave = osc("sine", pitch, length, { sampleRate });
    const start = Math.round(at * sampleRate);
    for (let i = 0; i < wave.length && start + i < left.length; i++) {
      const t = i / sampleRate;
      const edge = ease(t / blend) * (1 - ease((t - bar) / blend));
      const sine = wave[i] ?? 0;
      const tone = edge * (sub * Math.tanh(1.25 * sine) + harmonic * (4 * sine ** 3 - 3 * sine));
      left[start + i] = (left[start + i] ?? 0) + tone;
      right[start + i] = (right[start + i] ?? 0) + tone;
    }
  }
  if (texture) {
    for (let i = 0; i < left.length; i++) {
      const shared = texture * grain(2 * random() - 1);
      left[i] = (left[i] ?? 0) + shared + texture * width * grain(2 * random() - 1, 1);
      right[i] = (right[i] ?? 0) + shared + texture * width * grain(2 * random() - 1, 2);
    }
  }
  return fade(out, { in: 0.03, out: 0.12 });
}

/** @typedef {{ size?: "small" | "big", gain?: number, body?: number, sampleRate?: number, seed?: number,
 *   over?: Channels | readonly Channels[] | null, lift?: number }} HitOptions */

/** what a hit into `bus` stands above: the buses named, nothing for `[]` or
 *  null, or — not said — what the bus itself holds before it is struck
 *  @param {Channels} bus @param {Channels | readonly Channels[] | null | undefined} over
 *  @returns {Channels | readonly Channels[]} */
const above = (bus, over) => (over === undefined ? [bus] : over === null ? [] : over);

/**
 * The gain that lifts the first 10 ms after a hit point `lift` dB over what
 * the buses in `over` hold at `at` (their mid, from 50 ms before to 50 ms
 * after), both across the band and above 1.5 kHz, where its edge is heard;
 * never below `gain`.
 * @param {Channels} sound @param {number} at @param {Channels | readonly Channels[]} over
 * @param {number} lift @param {number} gain
 */
function liftedGain(sound, at, over, lift, gain) {
  const sampleRate = sound.sampleRate ?? RATE;
  const point = Math.round((hitOf(sound) ?? 0) * sampleRate);
  const own = levels(/** @type {Signal} */ (sound[0]), point, point + Math.round(0.01 * sampleRate), sampleRate);
  const buses = /** @type {readonly Channels[]} */ (Array.isArray(over[0]) || over.length === 0 ? over : [over]);
  const under = [0, 0];
  for (const bus of buses) {
    const fs = bus.sampleRate ?? RATE;
    if (fs !== sampleRate) throw new Error(`hit: over is at ${fs} Hz and the hit at ${sampleRate} Hz`);
    const mid = new Float64Array(bus[0]?.length ?? 0);
    for (const ch of bus) for (let i = 0; i < mid.length; i++) mid[i] = (mid[i] ?? 0) + (ch[i] ?? 0) / bus.length;
    const [full, high] = levels(mid, Math.round((at - 0.05) * fs), Math.round((at + 0.05) * fs), fs);
    under[0] = (under[0] ?? 0) + full;
    under[1] = (under[1] ?? 0) + high;
  }
  // in power, the hit and what is under it add: own·g² + under = under · 10^(lift/10)
  const needed = own.map((mine, i) => (mine > 0 ? Math.sqrt(((under[i] ?? 0) * (10 ** (lift / 10) - 1)) / mine) : 0));
  return Math.max(gain, ...needed);
}

/**
 * The mean square of `from`–`to`, whole and above 1.5 kHz (a highpass that
 * starts 20 ms early to settle).
 * @param {Signal} x @param {number} from @param {number} to @param {number} fs
 * @returns {[number, number]}
 */
function levels(x, from, to, fs) {
  const a = Math.max(0, from), b = Math.min(x.length, to);
  if (b <= a) return [0, 0];
  const early = Math.max(0, a - Math.round(0.02 * fs));
  const high = biquad("hit lift", "highpass", { freq: 1500 }, fs).run(Float64Array.from(x.subarray(early, b)));
  return [power(x, a, b), power(high, a - early, b - early)];
}

/**
 * A falling low thump, a struck body and a noise edge, with the attack in
 * the first samples. DdT1-vziRp3 at 11.042 s: a +4.8 dB full-band impact;
 * at 4.958 s: a +14.5 dB impact with the low end coming in. A sound on its
 * own is mono, with its hit point at kit hitOf(sound). `gain` is linear and
 * absolute: 1 peaks near −9 dBFS small and −4 dBFS big, before the master
 * is normalized.
 * @overload
 * @param {HitOptions} [o]
 * @returns {Channels}
 */
/**
 * Mix the impact into a bus, lining up its hit point at `at` (seconds).
 * Its gain rises until its first 10 ms stand `lift` dB over what is under
 * it there, across the band and above 1.5 kHz; `gain` is then the least it
 * plays at. What is under it is what the bus already holds (mix the bed and
 * the music in first), or the buses given as `over` when the hit has a bus
 * of its own; `over: []` (or null) plays `gain` as given, absolute. The
 * 4.8 dB default is the smaller of DdT1-vziRp3's impacts at 11.042 s (10 ms
 * windows against the 100 ms before; the one at 47.625 s stands 13 dB out).
 * @overload
 * @param {Channels} bus @param {number} at @param {HitOptions} [o]
 * @returns {ReturnType<typeof play>}
 */
/**
 * @param {Channels | HitOptions} [busOrOptions]
 * @param {number} [at] @param {HitOptions} [o]
 */
export function hit(busOrOptions = {}, at, o = {}) {
  const bus = Array.isArray(busOrOptions) ? busOrOptions : undefined;
  const options = Array.isArray(busOrOptions) ? o : busOrOptions;
  const { size = "small", body = 1, gain = 1, seed = 2 } = options;
  const sampleRate = bus?.sampleRate ?? options.sampleRate ?? RATE;
  const big = size === "big";
  const length = big ? 0.45 : 0.19;
  const wave = osc("sine", (t) => (big ? 37 : 56) + 90 * Math.exp(-t / 0.028), length, { sampleRate });
  const ring = osc("sine", big ? 165 : 240, length, { sampleRate });
  const random = rng(seed);
  const noise = biquad("hit edge", "bandpass", { freq: big ? 2600 : 3700, q: 0.7 }, sampleRate);
  for (let i = 0; i < wave.length; i++) {
    const t = i / sampleRate;
    const thump = (wave[i] ?? 0) * (big ? 0.43 : 0.2) * Math.exp(-t / (big ? 0.095 : 0.042));
    const strike = body * (ring[i] ?? 0) * (big ? 0.18 : 0.12) * Math.exp(-t / 0.025);
    const edge = noise(2 * random() - 1) * (big ? 0.23 : 0.15) * Math.exp(-t / 0.008);
    wave[i] = gain * (thump + strike + edge);
  }
  const sound = Object.assign([wave], { sampleRate });
  const soft = fade(sound, { in: 0.001, out: 0.03 });
  if (!bus) return soft;
  if (at === undefined || !Number.isFinite(at)) throw new Error("hit: give a bus a time in seconds: hit(bus, at, o)");
  const lifted = liftedGain(soft, at, above(bus, options.over), options.lift ?? 4.8, 1);
  return play(bus, soft, at, { align: "hit", gain: lifted });
}

/** @typedef {{ start: number, end: number } | { t0: number, t1: number }} Move */

/**
 * Strike the start and landing of each move: `{ start, end }` or
 * `{ t0, t1 }` in seconds, as the moves helpers give them. Landings take the
 * space first when events are closer than `spacing` seconds; a time outside
 * the bus is left out and takes no space. Returns the times struck, in order.
 * DdT1-vziRp3 at 47.625 and 47.750 s: two impacts with a whoosh under the
 * move, 125 ms apart. Each landing stands `lift` dB over what is under it
 * (see hit: the bus as it was before these hits, or `over`) and each start
 * `startGain / endGain` of that, never below the gains themselves; with
 * `over: []` (or null) the gains are absolute.
 * @param {Channels} bus @param {readonly Move[]} moves
 * @param {{ starts?: boolean, startGain?: number, endGain?: number, spacing?: number, seed?: number,
 *   over?: Channels | readonly Channels[] | null, lift?: number }} [o]
 */
export function hits(bus, moves, { starts = true, startGain = 0.32, endGain = 0.48, spacing = 0.1, seed = 3, over, lift = 4.8 } = {}) {
  const ends = endGain === 0 ? [] : moves.map((m) => ({ at: "end" in m ? m.end : m.t1, kind: /** @type {const} */ ("end") }));
  const beginnings = starts && startGain !== 0 ? moves.map((m) => ({ at: "start" in m ? m.start : m.t0, kind: /** @type {const} */ ("start") })) : [];
  /** @param {{ at: number }} a @param {{ at: number }} b */
  const byTime = (a, b) => a.at - b.at;
  /** @type {(typeof ends[number] | typeof beginnings[number])[]} */
  const placed = [];
  const length = (bus[0]?.length ?? 0) / (bus.sampleRate ?? RATE);
  for (const e of [...ends.sort(byTime), ...beginnings.sort(byTime)]) {
    if (!Number.isFinite(e.at)) throw new Error("hits: every move needs a start and end in seconds");
    if (e.at < 0 || e.at >= length) continue;
    if (!placed.some((p) => p.at === e.at || Math.abs(p.at - e.at) + 1e-9 < spacing)) placed.push(e);
  }
  // the bus as it is before any of these hits: one hit's tail is not what
  // the next must stand above
  const under = above(over === undefined ? Object.assign(bus.map((ch) => Float32Array.from(ch)), { sampleRate: bus.sampleRate }) : bus, over);
  placed.sort(byTime).forEach(({ at, kind }, i) => {
    const gain = kind === "start" ? startGain : endGain;
    // the lift a landing here would need, given to a start in proportion
    const unit = hit({ seed: seed + i, sampleRate: bus.sampleRate });
    const lifted = endGain > 0 ? liftedGain(unit, at, under, lift, endGain) * gain / endGain : gain;
    play(bus, unit, at, { align: "hit", gain: lifted });
  });
  return placed;
}

/**
 * Rising filtered noise and a rising saw, growing as time to the power of
 * 2.2 and releasing into `to`. A `filterBus` stays dry until `from`, closes
 * briefly and then opens toward its high cutoff at `to`. DdT1-vziRp3 at
 * 9.375 s has an upsweep into a boom and Df-JzBcCrDo at
 * 1.7 s: the high end opens. The shared cue at 6–10 s rises three octaves.
 * @param {Channels} bus @param {number} from @param {number} to
 * @param {{ gain?: number, seed?: number, filterBus?: Channels }} [o]
 */
export function build(bus, from, to, { gain = 0.45, seed = 4, filterBus } = {}) {
  const duration = to - from;
  if (!(duration > 0) || !Number.isFinite(duration)) throw new Error("build: to must be after from");
  const sampleRate = bus.sampleRate ?? RATE;
  const wave = osc("saw", (t) => 110 * 8 ** (t / duration), duration, { sampleRate });
  const random = rng(seed);
  const tone = biquad("build tone", "lowpass", { freq: 400 }, sampleRate);
  const noise = biquad("build noise", "bandpass", { freq: 300, q: 2.5 }, sampleRate);
  for (let i = 0; i < wave.length; i++) {
    const u = i / wave.length;
    if (i % 32 === 0) {
      tone.set({ freq: 400 * 17.5 ** u });
      noise.set({ freq: 300 * 30 ** u });
    }
    wave[i] = (0.12 * tone(wave[i] ?? 0) + 0.55 * noise(2 * random() - 1)) * u ** 2.2;
  }
  const sound = Object.assign([wave], { sampleRate });
  if (filterBus) {
    const close = Math.min(0.04, duration / 2);
    filterOpen(filterBus, from + close, to, { since: from, fade: close });
  }
  return play(bus, fade(sound, { in: 0, out: 0.012 }), from, { gain });
}

/**
 * The hit at a reveal, plus a falling sine under it. DdT1-vziRp3 at 4.958 s:
 * +14.5 dB across the mix and +27.9 dB below 80 Hz. The shared cue at 16 s
 * lets the low sine fall from 95 to 27 Hz over 1.6 s. `gain` is the hit's,
 * absolute: it is not lifted over what the bus holds.
 * @param {Channels} bus @param {number} at
 * @param {{ gain?: number, sub?: number, duration?: number, seed?: number }} [o]
 */
export function drop(bus, at, { gain = 0.8, sub = 0.18, duration = 1.6, seed = 5 } = {}) {
  const sampleRate = bus.sampleRate ?? RATE;
  const wave = osc("sine", (t) => 95 * (27 / 95) ** (t / duration), duration, { sampleRate });
  for (let i = 0; i < wave.length; i++)
    wave[i] = sub * Math.tanh(1.25 * (wave[i] ?? 0)) * Math.exp(-3 * i / wave.length);
  mix(bus, fade(Object.assign([wave], { sampleRate }), { in: 0.008, out: 0.08 }), at);
  // the reveal's hit lands on the build and the sub under it: its gain is
  // the level, not a lift over them
  return hit(bus, at, { size: "big", gain, seed, over: null });
}

/**
 * A mono sweep from low to high and back, about a second wide. DdT1-vziRp3
 * at 14.875 s: a whoosh and +8.6 dB below 80 Hz. Place its strongest sample
 * with play(bus, sound, at, { align: "peak", pan }) and make `pan` follow
 * the move in film time.
 * @param {{ duration?: number, gain?: number, seed?: number, sampleRate?: number }} [o]
 */
export function whoosh({ duration = 0.85, gain = 0.42, seed = 6, sampleRate = RATE } = {}) {
  const sound = buffer(duration, { channels: 1, sampleRate });
  const wave = /** @type {Signal} */ (sound[0]);
  const random = rng(seed);
  const filter = biquad("whoosh", "bandpass", { freq: 420, q: 0.78 }, sampleRate);
  for (let i = 0; i < wave.length; i++) {
    const arc = Math.sin(Math.PI * i / Math.max(1, wave.length - 1));
    if (i % 32 === 0) filter.set({ freq: 420 * 11 ** arc });
    wave[i] = gain * arc ** 3 * filter(2 * random() - 1);
  }
  return sound;
}

/** @typedef {[b0: number, b1: number, b2: number, a1: number, a2: number]} Section */

/**
 * The two conjugate pole pairs of a fourth-order Butterworth. For a band,
 * turn each lowpass pole into two bandpass poles before the bilinear transform.
 * @param {number} lo @param {number} hi @param {number} fs @returns {Section[]}
 */
function butterworth(lo, hi, fs) {
  const low = Math.tan(Math.PI * lo / fs);
  const high = Math.tan(Math.PI * hi / fs);
  const center = Math.sqrt(low * high);
  /** @type {Section[]} */
  const sections = [];
  for (const angle of [Math.PI / 8, 3 * Math.PI / 8]) {
    if (lo === 0 || hi === fs / 2) {
      const cutoff = lo === 0 ? high : low;
      const norm = 1 / (1 + 2 * Math.sin(angle) * cutoff + cutoff ** 2);
      const b = norm * (lo === 0 ? cutoff ** 2 : 1);
      sections.push([b, (lo === 0 ? 2 : -2) * b, b,
        2 * (cutoff ** 2 - 1) * norm, (1 - 2 * Math.sin(angle) * cutoff + cutoff ** 2) * norm]);
      continue;
    }
    const width = high - low;
    const re = -Math.sin(angle) * width;
    const im = Math.cos(angle) * width;
    const x = re ** 2 - im ** 2 - 4 * center ** 2;
    const y = 2 * re * im;
    const magnitude = Math.hypot(x, y);
    const rootRe = Math.sqrt(Math.max(0, (magnitude + x) / 2));
    const rootIm = -Math.sqrt((magnitude - x) / 2);
    const omega = 2 * Math.atan(center);
    for (const sign of [-1, 1]) {
      const u = (re + sign * rootRe) / 2;
      const v = (im + sign * rootIm) / 2;
      const d = (1 - u) ** 2 + v ** 2;
      const a1 = -2 * (1 - u ** 2 - v ** 2) / d;
      const a2 = ((1 + u) ** 2 + v ** 2) / d;
      const b = Math.hypot((1 + a2) * Math.cos(omega) + a1, (1 - a2) * Math.sin(omega)) /
        (2 * Math.sin(omega));
      sections.push([b, 0, -b, a1, a2]);
    }
  }
  return sections;
}

/**
 * Run a band forwards and backwards with the sound mirrored at its ends.
 * The second pass removes the phase shift so window levels stay in time.
 * The mirror is eight periods of the lowest cutoff long, so the filter has
 * settled before it reaches the sound, and a mirror (not a reflection about
 * the end sample) adds no offset when a sound ends mid-cycle: read
 * backwards, a sound gives the same figures.
 * @param {Signal} source @param {number} lo @param {number} hi @param {number} fs
 */
function band(source, lo, hi, fs) {
  const n = source.length;
  if (lo >= fs / 2 || n === 0) return new Float64Array(n);
  if (lo === 0 && hi >= fs / 2) return source;
  const sections = butterworth(lo, Math.min(hi, fs / 2), fs);
  const pad = Math.min(n - 1, Math.ceil((8 * fs) / (lo > 0 ? lo : hi)));
  const x = new Float64Array(n + 2 * pad);
  x.set(source, pad);
  for (let i = 1; i <= pad; i++) {
    x[pad - i] = source[i] ?? 0;
    x[pad + n - 1 + i] = source[n - 1 - i] ?? 0;
  }
  for (let pass = 0; pass < 2; pass++) {
    for (const [b0, b1, b2, a1, a2] of sections) {
      let x1 = x[0] ?? 0, x2 = x1;
      let y1 = x1 * (b0 + b1 + b2) / (1 + a1 + a2), y2 = y1;
      for (let i = 0; i < x.length; i++) {
        const v = x[i] ?? 0;
        const y = b0 * v + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
        x[i] = y;
        x2 = x1;
        x1 = v;
        y2 = y1;
        y1 = y;
      }
    }
    x.reverse();
  }
  return x.subarray(pad, pad + n);
}

/** @param {number} p */
const powerDb = (p) => 10 * Math.log10(Math.max(p, 1e-20));
/** Mean square below this (−70 dB, the absolute gate of BS.1770) is silence: a
 *  window or frame of it is left out of the level spread, centroid and flatness. */
const SILENT = 1e-7;
/** @param {Signal} x @param {number} [from] @param {number} [to] */
function power(x, from = 0, to = x.length) {
  let sum = 0;
  for (let i = from; i < to; i++) sum += (x[i] ?? 0) ** 2;
  return sum / Math.max(1, to - from);
}

/** @param {Signal} left @param {Signal} right */
function correlation(left, right) {
  let cross = 0, l2 = 0, r2 = 0;
  for (let i = 0; i < left.length; i++) {
    const l = left[i] ?? 0, r = right[i] ?? 0;
    cross += l * r;
    l2 += l * l;
    r2 += r * r;
  }
  return l2 && r2 ? Math.max(-1, Math.min(1, cross / Math.sqrt(l2 * r2))) : 0;
}

/** @param {number[]} sorted ascending @param {number} q */
function percentile(sorted, q) {
  if (!sorted.length) return 0;
  const j = (sorted.length - 1) * q;
  const i = Math.floor(j);
  const below = sorted[i] ?? 0;
  return below + (j - i) * ((sorted[Math.ceil(j)] ?? below) - below);
}

/**
 * A Hann window and a radix-2 FFT of real samples, centred at the named
 * sample and zero-padded past the ends. Reuse the work arrays for each hop.
 * @param {Signal} signal @param {number} n
 */
function spectrum(signal, n) {
  const order = new Uint16Array(n);
  const window = new Float64Array(n);
  const re = new Float64Array(n), im = new Float64Array(n);
  const cos = new Float64Array(n / 2), sin = new Float64Array(n / 2);
  const powers = new Float64Array(n / 2 + 1);
  for (let i = 0; i < n; i++) {
    order[i] = ((order[i >> 1] ?? 0) >> 1) | ((i & 1) * (n / 2));
    window[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / n);
  }
  for (let k = 0; k < n / 2; k++) {
    cos[k] = Math.cos(-2 * Math.PI * k / n);
    sin[k] = Math.sin(-2 * Math.PI * k / n);
  }
  /** @param {number} center */
  return (center) => {
    const first = center - n / 2;
    for (let i = 0; i < n; i++) re[order[i] ?? 0] = (signal[first + i] ?? 0) * (window[i] ?? 0);
    im.fill(0);
    for (let span = 2; span <= n; span *= 2) {
      const half = span / 2, stride = n / span;
      for (let from = 0; from < n; from += span) {
        for (let j = 0; j < half; j++) {
          const a = from + j, b = a + half, k = j * stride;
          const rb = re[b] ?? 0, ib = im[b] ?? 0;
          const ra = re[a] ?? 0, ia = im[a] ?? 0;
          const c = cos[k] ?? 0, s = sin[k] ?? 0;
          const r = c * rb - s * ib;
          const v = s * rb + c * ib;
          re[b] = ra - r;
          im[b] = ia - v;
          re[a] = ra + r;
          im[a] = ia + v;
        }
      }
    }
    for (let k = 0; k < powers.length; k++) powers[k] = ((re[k] ?? 0) ** 2 + (im[k] ?? 0) ** 2) * (2 / n) ** 2;
    return powers;
  };
}

/** @param {Signal} mid @param {number} fs @returns {[number, number]} */
function brightness(mid, fs) {
  const n = 4096, hop = 2048;
  const read = spectrum(mid, n);
  // the frame's mean square as the window weighs it (3/8 is the mean of a Hann window squared)
  /** @param {number} center */
  const weighed = (center) => {
    let sum = 0;
    for (let j = Math.max(0, center - n / 2); j < Math.min(mid.length, center + n / 2); j++)
      sum += ((mid[j] ?? 0) * (0.5 - 0.5 * Math.cos((2 * Math.PI * (j - center + n / 2)) / n))) ** 2;
    return sum / (n * 3 / 8);
  };
  const lo = Math.ceil(200 * n / fs), hi = Math.min(n / 2, Math.floor(8000 * n / fs));
  /** @type {number[]} */
  const centroids = [], flatness = [];
  for (let i = 0; i < Math.ceil(mid.length / hop) * hop + 1; i += hop) {
    if (weighed(i) < SILENT) continue;
    const p = read(i);
    let total = 0, weighted = 0, sum = 0, logs = 0;
    for (let k = 0; k < p.length; k++) {
      const energy = p[k] ?? 0;
      total += energy;
      weighted += k * energy;
      if (k >= lo && k <= hi) {
        const bin = energy + 1e-20;
        sum += bin;
        logs += Math.log(bin);
      }
    }
    centroids.push((fs / n) * weighted / (total + 1e-20));
    const bins = hi - lo + 1;
    if (bins > 0) flatness.push(Math.exp(logs / bins) / (sum / bins));
  }
  return [percentile(centroids.sort((a, b) => a - b), 0.5),
    percentile(flatness.sort((a, b) => a - b), 0.5)];
}

/**
 * Positive spectral flux on log-compressed magnitudes (1024 Hann, 256 hop
 * at 48 kHz). Keep peaks above their local mean plus half a standard
 * deviation and a small floor, with at least 45 ms between peaks. The
 * compression is relative to the track RMS, so gain alone leaves the count.
 * @param {Signal} mid @param {number} fs @param {number} energy
 */
function onsetRate(mid, fs, energy) {
  if (!energy) return 0;
  const n = Math.max(16, Math.min(32768, 2 ** Math.round(Math.log2(fs * 1024 / RATE))));
  const hop = n / 4;
  const read = spectrum(mid, n);
  const previous = new Float64Array(n / 2 + 1);
  const flux = new Float64Array(Math.ceil(mid.length / hop));
  const scale = 12 / Math.sqrt(energy);
  for (let i = 0; i < flux.length; i++) {
    const p = read(i * hop);
    let rise = 0;
    for (let k = 1; k < p.length; k++) {
      const value = Math.log1p(scale * Math.sqrt(p[k] ?? 0));
      rise += Math.max(0, value - (previous[k] ?? 0));
      previous[k] = value;
    }
    flux[i] = rise / (p.length - 1);
  }
  const radius = Math.max(1, Math.round(0.12 * fs / hop));
  const gap = Math.ceil(0.045 * fs / hop);
  let count = 0, last = -gap;
  for (let i = 0; i < flux.length; i++) {
    const value = flux[i] ?? 0;
    if (i - last < gap || value <= (flux[i - 1] ?? 0) || value < (flux[i + 1] ?? 0)) continue;
    let sum = 0, squares = 0, size = 0;
    for (let j = Math.max(0, i - radius); j <= Math.min(flux.length - 1, i + radius); j++) {
      const other = flux[j] ?? 0;
      sum += other;
      squares += other ** 2;
      size++;
    }
    const mean = sum / size;
    if (value > mean + 0.5 * Math.sqrt(Math.max(0, squares / size - mean ** 2)) + 0.003) {
      count++;
      last = i;
    }
  }
  return count * fs / mid.length;
}

const figures = /** @type {const} */ ([
  ["lufs", "Integrated", "LUFS", 1],
  ["levelSpread", "1 s p95−p10", "dB", 1],
  ["sub", "Sub <60 Hz", "dB", 1],
  ["low", "Low 60–250 Hz", "dB", 1],
  ["mid", "Mid 250 Hz–2 kHz", "dB", 1],
  ["presence", "Presence 2–6 kHz", "dB", 1],
  ["air", "Air 6–16 kHz", "dB", 1],
  ["subActive", "Sub active share", "%", 1],
  ["subCrest", "Sub crest", "dB", 1],
  ["centroid", "Median centroid", "Hz", 0],
  ["flatness", "Median flatness", "", 4],
  ["onsets", "Onsets", "/s", 2],
  ["correlation", "L/R correlation", "", 3],
  ["subCorrelation", "Sub L/R correlation", "", 3],
  ["sideMid", "Side − mid", "dB", 1],
]);

/** @typedef {typeof figures[number][0]} Figure */
/** @typedef {Record<Figure, number>} Figures */
/** @typedef {Record<Figure, readonly [number, number]>} Ranges */
/** @typedef {{ range: Ranges, openAbove?: readonly Figure[] }} Card */

/**
 * Mono or stereo, measured at its own rate (48 kHz if absent). Energy and
 * spectra are of the stereo mid, (L+R)/2; band balance is against the entire
 * mid. Sub activity and crest use the 20–60 Hz band, in 50 ms windows, and
 * activity counts windows less than 20 dB below p99. The level spread uses
 * 1 s windows with a 0.5 s hop. The spread, centroid and flatness leave out
 * windows and frames quieter than −70 dB, so a silent lead-in or tail does not
 * count as the film's quietest moment or darkest sound. Correlation is the
 * dot product divided by the two lengths. Silence has zero correlation, no
 * active sub, no onsets and zero spread, centroid and flatness; integrated
 * loudness can be −Infinity, as in kit loudness().
 * @param {Channels} channels @returns {Figures}
 */
export function measure(channels) {
  const fs = channels.sampleRate ?? RATE;
  if (!(fs > 0) || !Number.isFinite(fs)) throw new Error("measure: give it a positive sample rate");
  const [left, right = left] = channels;
  if (!left || !right || channels.length > 2) throw new Error("measure: give it mono or stereo");
  if (left.length !== right.length) throw new Error("measure: channels need the same length");
  const mid = new Float64Array(left.length);
  let side = 0;
  for (let i = 0; i < mid.length; i++) {
    const l = left[i] ?? 0, r = right[i] ?? 0;
    if (!Number.isFinite(l) || !Number.isFinite(r)) throw new Error("measure: diagnose the nonfinite samples first");
    mid[i] = (l + r) / 2;
    side += ((l - r) / 2) ** 2;
  }
  const total = power(mid);
  const zeroSub = band(left, 0, 60, fs);
  const subRight = right === left ? zeroSub : band(right, 0, 60, fs);
  const [centroid, flatness] = brightness(mid, fs);
  const sub = band(mid, 20, 60, fs);
  /** @type {number[]} */
  const subLevels = [], levels = [];
  const w = Math.max(1, Math.round(0.05 * fs));
  for (let i = 0; i + w <= sub.length; i += w) subLevels.push(power(sub, i, i + w));
  subLevels.sort((a, b) => a - b);
  const p99 = percentile(subLevels, 0.99);
  const second = Math.max(1, Math.round(fs));
  for (let i = 0; i + second <= mid.length; i += Math.max(1, Math.round(fs / 2))) {
    const level = power(mid, i, i + second);
    if (level >= SILENT) levels.push(powerDb(level));
  }
  levels.sort((a, b) => a - b);
  /** @param {number} lo @param {number} hi */
  const balance = (lo, hi) => powerDb(power(band(mid, lo, hi, fs))) - powerDb(total);
  return {
    lufs: loudness(channels).lufs,
    levelSpread: percentile(levels, 0.95) - percentile(levels, 0.10),
    sub: balance(0, 60),
    low: balance(60, 250),
    mid: balance(250, 2000),
    presence: balance(2000, 6000),
    air: balance(6000, 16000),
    subActive: p99 > 1e-20 ? subLevels.filter((p) => p > p99 / 100).length / subLevels.length : 0,
    subCrest: powerDb(p99) - powerDb(percentile(subLevels, 0.5)),
    centroid,
    flatness,
    onsets: onsetRate(mid, fs, total),
    correlation: correlation(left, right),
    subCorrelation: correlation(zeroSub, subRight),
    sideMid: powerDb(side / Math.max(1, mid.length)) - powerDb(total),
  };
}

// Read with measure() from six Higgsfield films' soundtracks (stereo, 48 kHz,
// decoded from AAC): three reels (Dfj2vYxC1pE, Df-JzBcCrDo, DdT1-vziRp3) and
// three product introductions (dots-creative-crew, mangaka,
// opus55-monster-truck). Python's other onset detector counted 9.39, 5.91
// and 10.98/s on the three reels; its flux and peak picking use different
// windows and thresholds.
const reels = /** @type {Record<string, Figures>} */ ({
  Dfj2vYxC1pE: {
    lufs: -6.911419472941821, levelSpread: 8.902107971431848, sub: -5.9470804487973865,
    low: -6.144053271312181, mid: -4.6122744713375905, presence: -14.228089168761617, air: -21.79291665375893,
    subActive: 0.7100068073519401, subCrest: 14.617564115420896, centroid: 588.8829945194445,
    flatness: 0.023150936108495883, onsets: 6.748982252455818, correlation: 0.6409066269369512,
    subCorrelation: 0.8605066267322765, sideMid: -6.594788540925656,
  },
  "Df-JzBcCrDo": {
    lufs: -5.382372064878215, levelSpread: 2.477016110042035, sub: -10.014264030884277,
    low: -4.523070158472883, mid: -5.180523933938083, presence: -8.97282585885085, air: -15.895319211405248,
    subActive: 0.8957597173144877, subCrest: 10.542656965010497, centroid: 1087.5252037115679,
    flatness: 0.12320052053314569, onsets: 8.384678530895195, correlation: 0.6779534689956599,
    subCorrelation: 0.9028305000529029, sideMid: -7.167748792819349,
  },
  "DdT1-vziRp3": {
    lufs: -14.137213201872706, levelSpread: 6.5363841073814495, sub: -4.529622642647862,
    low: -6.2946024509613885, mid: -8.359582246449023, presence: -14.042793833069247, air: -16.38062662747727,
    subActive: 0.7858942065491183, subCrest: 7.8091155304128, centroid: 549.7500635210537,
    flatness: 0.13933812087766764, onsets: 9.922666303824291, correlation: 0.8711856222678308,
    subCorrelation: 0.9760010660763156, sideMid: -11.620843836607769,
  },
  "dots-creative-crew": {
    lufs: -7.523354104489741, levelSpread: 5.79022036260552, sub: -11.81376256639109, low: -3.914476066636132,
    mid: -5.822247387482848, presence: -11.133487096255285, air: -12.862823817782102,
    subActive: 0.7432885906040269, subCrest: 12.247565388935802, centroid: 1168.4929261377074,
    flatness: 0.19654763330500222, onsets: 9.14020572450805, correlation: 0.6695650280679405,
    subCorrelation: 0.8848033594436251, sideMid: -7.034946005881418,
  },
  mangaka: {
    lufs: -8.521110214624766, levelSpread: 9.646150385092424, sub: -9.627392605539532,
    low: -3.930063788569898, mid: -6.080412268000535, presence: -10.433405372088346, air: -15.950772360425328,
    subActive: 0.3688394276629571, subCrest: 25.44485250340977, centroid: 904.4275548914877,
    flatness: 0.12717058307958895, onsets: 8.040254237288135, correlation: 0.7077655518879712,
    subCorrelation: 0.9487258190680528, sideMid: -7.664509466698389,
  },
  "opus55-monster-truck": {
    lufs: -7.523351805070418, levelSpread: 4.516415065687423, sub: -8.452518659265385,
    low: -3.0484715770723287, mid: -8.495858853159161, presence: -12.777064956443615,
    air: -15.716355317543618, subActive: 0.5169491525423728, subCrest: 19.465556070845786,
    centroid: 629.9628915111149, flatness: 0.1925545468742373, onsets: 8.062693698347108,
    correlation: 0.8746699524965276, subCorrelation: 0.9821821551281439, sideMid: -11.74869178406115,
  },
});
const keys = figures.map(([key]) => key);

/**
 * The six soundtracks, the lowest and highest each figure reached among
 * them (n = 6), and where a higher value fits. A range is only the span six
 * films happened to cover, not a norm: rebuilt from any five, each left-out
 * film has 3 to 8 of its 14 figures outside (Dfj2vYxC1pE 8, DdT1-vziRp3 5,
 * dots-creative-crew and opus55-monster-truck 4, Df-JzBcCrDo and mangaka 3).
 * Inside says a figure is somewhere one of these films went; outside, by a
 * little, is as common among them as inside. Read a score as where to look,
 * then listen; mixing to put every figure inside can make a score worse.
 */
export const REELS = {
  reels,
  range: /** @type {Ranges} */ (Object.fromEntries(keys.map((key) => {
    const values = Object.values(reels).map((reel) => reel[key]);
    return [key, /** @type {const} */ ([Math.min(...values), Math.max(...values)])];
  }))),
  // Bass can be fully mono. Keep sub activity two-sided to show a floor
  // that holds nearly all the time, including through changes in level.
  openAbove: /** @type {readonly Figure[]} */ (["subCorrelation"]),
};

// Keep loudness for comparison because the film master is set to −16 LUFS.
const loudnessNote = "film scores are mastered to −16 LUFS";

/** @param {number} value @param {typeof figures[number]} row */
function number(value, [, , unit, places]) {
  const scaled = unit === "%" ? 100 * value : value;
  return scaled.toFixed(places).replace("-", "−");
}

/**
 * Read each figure against the card. `distance` is zero inside the inclusive
 * bounds, otherwise the distance to the nearest bound in the figure's units
 * (subActive is a share). `openAbove` names figures with no upper scoring
 * limit. Loudness is shown with null for `inside`, `distance` and `direction`.
 * Pass a different card to compare other films.
 * @param {Figures} values @param {Card} [card]
 * @returns {Record<Figure, { value: number, range: readonly [number, number], inside: boolean | null,
 *   openAbove: boolean, distance: number | null, direction: "above" | "below" | null, reading: string }>}
 */
export function score(values, card = REELS) {
  return /** @type {ReturnType<typeof score>} */ (Object.fromEntries(figures.map((row) => {
    const [key, label, unit] = row;
    const value = values[key];
    const range = card.range[key];
    const [lo, hi] = range;
    const suffix = unit === "%" || unit === "/s" ? unit : unit ? " " + unit : "";
    const comparison = `${label}: ${number(value, row)}${suffix}, the six films ${number(lo, row)}…${number(hi, row)}${suffix}`;
    if (key === "lufs") return [key, { value, range, inside: null, openAbove: false,
      distance: null, direction: null, reading: `${comparison} (informational because ${loudnessNote})` }];
    if (Number.isNaN(value) || typeof value !== "number") throw new Error(`score: ${key} is ${value}, not a number`);
    const openAbove = card.openAbove?.includes(key) ?? false;
    const direction = value < lo ? "below" : !openAbove && value > hi ? "above" : null;
    const distance = direction === "below" ? lo - value : direction === "above" ? value - hi : 0;
    const amount = unit === "%" ? `${number(distance, row)} percentage points` : number(distance, row) + suffix;
    const reading = `${comparison}; ` + (direction ? `${amount} ${direction} the range` : "in range") +
      (openAbove ? " (higher values fit)" : "");
    return [key, { value, range, inside: direction === null, openAbove, distance, direction, reading }];
  })));
}

/** @param {string[]} args */
function main(args) {
  const paths = args.filter((arg) => arg !== "--json");
  if (paths.length === 0) {
    console.error("usage: node lib/palette.mjs [--json] score.wav [other.wav …]");
    process.exitCode = 1;
    return;
  }
  const files = paths.map((path) => {
    const measured = measure(load(path));
    return { path, figures: measured, score: score(measured) };
  });
  if (args.includes("--json")) {
    console.log(JSON.stringify({ range: REELS.range, openAbove: REELS.openAbove, files }, (_, value) =>
      typeof value === "number" && !Number.isFinite(value) ? String(value) : value, 2));
    return;
  }
  files.forEach(({ path }, i) => {
    console.log(`[${i + 1}] ${path}`);
  });
  const width = 11;
  console.log("");
  console.log("Figure".padEnd(27) + "Six films".padEnd(21) +
    files.map((_, i) => `[${i + 1}]`.padStart(width)).join(""));
  for (const row of figures) {
    const [key, label, unit] = row;
    const [lo, hi] = REELS.range[key];
    const span = `${number(lo, row)}…${number(hi, row)}${REELS.openAbove.includes(key) ? " ↑" : ""}`;
    console.log((unit ? `${label} (${unit})` : label).padEnd(27) + span.padEnd(21) +
      files.map((file) => {
        const { inside } = file.score[key];
        const status = inside === null ? "info" : inside ? "in" : "out";
        return `${number(file.figures[key], row)} ${status}`.padStart(width);
      }).join(""));
  }
  console.log(`\n↑ Higher values are in range. Integrated loudness is informational because ${loudnessNote}.`);
}

if (process.argv[1] && existsSync(process.argv[1]) &&
  realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)))
  main(process.argv.slice(2));
