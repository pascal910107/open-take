// Measure signals with known contents, and place the sounds against silence
// where an edge or a misplaced attack cannot hide in the mix.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  biquad, buffer, diagnose, dropOut, fade, filterClose, filterOpen, hitOf, mix as mixInto, onsetOf,
  peakOf, play, rng, slice, subIn,
} from "../kit/audio.mjs";
import { bed, build, drop, hit, hits, measure, REELS, score, whoosh } from "../starter/lib/palette.mjs";

const rate = 48000;
const sine = (hz: number, t: number) => Math.sin(2 * Math.PI * hz * t);
const near = (value: number, expected: number, within: number) =>
  assert.ok(Math.abs(value - expected) <= within, `${value} vs ${expected} (±${within})`);

function tone(seconds: number, make: (t: number) => number) {
  const out = buffer(seconds, { channels: 1 });
  const ch = out[0]!;
  for (let i = 0; i < ch.length; i++) ch[i] = make(i / rate);
  return fade(out, { in: 0.02, out: 0.02 });
}

function rms(ch: Float32Array | Float64Array) {
  return Math.sqrt(ch.reduce((sum, v) => sum + v * v, 0) / ch.length);
}

function bandLevel(bus: ReturnType<typeof buffer>, from: number, to: number, band: "lowpass" | "highpass") {
  const stem = slice(bus, from - 0.1, to);
  biquad("measure", band, { freq: band === "lowpass" ? 140 : 1500 }).run(stem);
  return rms(stem[0]!.subarray(4800));
}

test("measure a pure tone, with fixed bandwidth and mono correlation", () => {
  const x = tone(2, (t) => 0.3 * sine(750, t));
  const before = slice(x, 0);
  const f = measure(x);
  assert.deepEqual(x, before);
  near(f.centroid, 750, 1);
  near(f.mid, 0, 0.03);
  assert.ok(f.sub < -40 && f.low < -40 && f.presence < -40 && f.air < -40);
  assert.ok(f.flatness < 0.001);
  near(f.correlation, 1, 1e-12);
  near(f.subCorrelation, 1, 1e-12);
  near(f.levelSpread, 0, 0.1);
  assert.ok(f.onsets < 1.1);
});

test("white noise has high flatness and independent channels have little correlation", () => {
  const x = buffer(4);
  const left = rng(18), right = rng(29);
  x[0]!.set(x[0]!.map(() => left() - 0.5));
  x[1]!.set(x[1]!.map(() => right() - 0.5));
  const f = measure(x);
  assert.ok(f.flatness > 0.48 && f.flatness < 0.7, String(f.flatness));
  near(f.centroid, 12000, 500);
  near(f.correlation, 0, 0.02);
  near(f.subCorrelation, 0, 0.13);
  near(f.sideMid, 0, 0.15);
});

test("50 ms sub windows count a gated sine and report its crest", () => {
  const x = tone(4, (t) => (t >= 1 && t < 2 ? 0.3 : 0.006) * sine(40, t));
  const f = measure(x);
  near(f.subActive, 0.25, 0.045);
  near(f.subCrest, 20 * Math.log10(50), 1);
  near(f.sub, 0, 0.5);
});

test("spectral flux counts a five-per-second click train and stays quiet on silence", () => {
  const bus = buffer(3);
  for (let i = 0; i < 15; i++) {
    const at = Math.round((0.08 + i / 5) * rate);
    bus[0]![at] = 0.65;
    bus[1]![at] = 0.65;
  }
  near(measure(bus).onsets, 5, 0.001);
  const silent = measure(buffer(0.2));
  assert.equal(silent.lufs, -Infinity);
  assert.equal(silent.onsets, 0);
  assert.equal(silent.subActive, 0);
});

test("score includes the range edges and reports each direction and distance", () => {
  const reel = REELS.reels.Dfj2vYxC1pE!;
  assert.ok(Object.entries(score(reel)).every(([key, entry]) => entry.inside === (key === "lufs" ? null : true)));
  const [lo, hi] = REELS.range.sub;
  const below = score({ ...reel, sub: lo - 4 }).sub;
  near(below.distance!, 4, 1e-12);
  assert.equal(below.direction, "below");
  assert.equal(below.inside, false);
  assert.match(below.reading, /4\.0 dB below/);
  const above = score({ ...reel, sub: hi + 1 }).sub;
  assert.equal(above.direction, "above");
  assert.equal(above.distance, 1);
  for (const sub of [lo, hi]) {
    const result = score({ ...reel, sub }).sub;
    assert.equal(result.inside, true);
    assert.equal(result.distance, 0);
    assert.equal(result.direction, null);
  }
  const custom = score({ ...reel, sub: -12 }, { range: { ...REELS.range, sub: [-14, -10] } });
  assert.equal(custom.sub.inside, true);
});

test("score refuses a figure that is not a number", () => {
  const reel = REELS.reels.Dfj2vYxC1pE!;
  assert.throws(() => score({ ...reel, sub: NaN }), /score: sub is NaN, not a number/);
  assert.equal(score({ ...reel, levelSpread: Infinity }).levelSpread.direction, "above");
});

test("the card spans six films and holds each of them", () => {
  const films = Object.keys(REELS.reels);
  assert.equal(films.length, 6);
  for (const film of films)
    assert.ok(Object.values(score(REELS.reels[film]!)).every((entry) => entry.inside !== false), film);
});

test("silence before or after a sound leaves the spread, centroid and flatness as they were", () => {
  const sound = (seconds: number, silentFrom: number) => {
    const x = buffer(seconds);
    for (let i = 0; i < x[0]!.length; i++) {
      const t = i / rate;
      const v = t < silentFrom ? (0.3 + 0.15 * Math.sin(2 * Math.PI * 0.4 * t)) * sine(750, t) : 0;
      x[0]![i] = v;
      x[1]![i] = v;
    }
    return x;
  };
  const whole = measure(sound(5, 5));
  for (const tail of [measure(sound(10, 5)), measure(sound(20, 5))]) {
    near(tail.levelSpread, whole.levelSpread, 0.5);
    near(tail.centroid, whole.centroid, 2);
    near(tail.flatness, whole.flatness, 1e-4);
  }
  assert.equal(measure(Object.assign([Float32Array.of(1)], { sampleRate: rate })).centroid, rate / 4);
});

test("a sound read backwards gives the same sub", () => {
  for (const seconds of [0.1, 2]) {
    const x = new Float32Array(seconds * rate);
    for (let i = x.length / 2; i < x.length; i++) x[i] = 0.5 * Math.sin(2 * Math.PI * 750 * (i - x.length / 2) / rate);
    const forwards = measure(Object.assign([x], { sampleRate: rate })).sub;
    const backwards = measure(Object.assign([Float32Array.from(x).reverse()], { sampleRate: rate })).sub;
    near(forwards, backwards, 0.05);
  }
  const ending = new Float32Array(2 * rate).map((_, i) => 0.5 * Math.cos(2 * Math.PI * 750 * i / rate));
  assert.ok(measure(Object.assign([ending], { sampleRate: rate })).sub < -60);
});

test("loudness is informational and the card can open a bound above", () => {
  const reel = REELS.reels.Dfj2vYxC1pE!;
  const [minimum] = REELS.range.subCorrelation;
  const results = score({ ...reel, lufs: -16, subCorrelation: 1, subActive: 1, levelSpread: 30 });
  assert.equal(results.lufs.inside, null);
  assert.equal(results.lufs.distance, null);
  assert.equal(results.lufs.direction, null);
  assert.match(results.lufs.reading, /mastered to −16 LUFS/);
  assert.equal(results.subCorrelation.inside, true);
  assert.equal(results.subCorrelation.openAbove, true);
  assert.equal(results.subCorrelation.distance, 0);
  assert.equal(results.subActive.direction, "above");
  assert.equal(results.levelSpread.direction, "above");
  const wide = score({ ...reel, subCorrelation: minimum - 0.1 }).subCorrelation;
  assert.equal(wide.inside, false);
  assert.equal(wide.direction, "below");
  near(wide.distance!, 0.1, 1e-12);
  const closed = score({ ...reel, subCorrelation: 1 }, { range: REELS.range });
  assert.equal(closed.subCorrelation.direction, "above");
});

test("diagnose keeps its old call and exempts only intended clicks", () => {
  const x = buffer(2, { channels: 1 });
  const ch = x[0]!;
  ch.fill(0.025);
  ch[Math.round(0.403 * rate)] += 0.5;
  ch[rate] += 1.25;
  ch[Math.round(1.8 * rate)] = NaN;
  const legacy = diagnose("keys", x, rate);
  assert.deepEqual(legacy, diagnose("keys", x));
  for (const kind of ["click", "nonfinite", "clip", "dc"])
    assert.ok(legacy.some((f) => f.kind === kind), kind);
  const intentional = diagnose("keys", x, rate, { transients: true });
  assert.deepEqual(intentional, legacy.filter((f) => f.kind !== "click"));
  const timed = diagnose("keys", x, { at: [0.4, 1.8] });
  assert.equal(timed.some((f) => f.kind === "click" && f.at === 0.403), false);
  assert.ok(timed.some((f) => f.kind === "click" && f.at === 1));
  assert.ok(timed.some((f) => f.kind === "nonfinite"));
});

test("the attack of a recording is not a click on its bus or in the mix; a jump elsewhere still is", () => {
  // a struck bar: the sound starts at its full level, as a recorded strike does
  const strike = new Float32Array(Math.round(0.3 * rate));
  for (let i = 0; i < strike.length; i++)
    strike[i] = 0.3 * Math.cos((2 * Math.PI * 440 * i) / rate) * Math.exp(-i / (0.05 * rate));
  const clicks = (x: ReturnType<typeof buffer>) =>
    diagnose("bus", x).filter((f) => f.kind === "click").map((f) => f.at);
  const plain = buffer(2, { channels: 1 });
  play(plain, strike, 0.5);
  assert.deepEqual(clicks(plain), [0.5], "played as any sound, its start is a click");
  const bus = buffer(2, { channels: 1 });
  play(bus, strike, 0.5, { recorded: true });
  bus[0]![rate] += 0.5; // a fault a second in
  assert.deepEqual(clicks(bus), [1], "the recording's attack is left out, the fault is not");
  const master = buffer(3, { channels: 1 });
  mixInto(master, bus, 0.25);
  assert.deepEqual(clicks(master), [1.25], "and the mix remembers which attack was recorded");
});

test("play reports the distance from an early onset to the hit and can align the hit", (t) => {
  // a quiet lead-in, then a step at exactly 0.36 s: the hit is that sample
  const step = Math.round(0.36 * rate);
  const x = buffer(0.75, { channels: 1 });
  x[0]!.forEach((_, i) => { x[0]![i] = (i < step ? 0.08 : 0.48) * Math.cos(2 * Math.PI * 300 * (i - step) / rate); });
  fade(x, { in: 0.02, out: 0.02 });
  assert.equal(hitOf(x), step / rate);
  const on = onsetOf(x)!;
  const warned = t.mock.method(console, "warn", () => {});
  const bus = buffer(2);
  const onset = play(bus, x, 0.65, { align: "onset" });
  near(onset.start + on, 0.65, 1e-12);
  const expected = `play: the hit is ${Math.round(1000 * (0.36 - on))} ms after the onset at 0.65 s; ` +
    `use align: "hit" or a time in seconds`;
  assert.equal(onset.warning, expected);
  assert.deepEqual(warned.mock.calls.map((c) => c.arguments), [[expected]]);
  const landed = buffer(2);
  assert.equal(play(landed, x, 0.65, { align: "hit" }).warning, undefined);
  assert.equal(warned.mock.callCount(), 1);
  // the step lands on the sample of 0.65 s, read from the samples, not from hitOf
  const at = Math.round(0.65 * rate);
  assert.ok(Math.abs(landed[0]![at - 1]!) < 0.09 && Math.abs(landed[0]![at]!) > 0.4);
});

test("a sound without a rate is timed at the bus's rate, so onset and hit agree", (t) => {
  const warned = t.mock.method(console, "warn", () => {});
  const raw = new Float32Array(9600);
  raw[7200] = 0.7;
  const bus = buffer(1, { sampleRate: 24000 });
  const placed = play(bus, raw, 0.5, { align: "onset" });
  assert.equal(placed.warning, undefined);
  assert.equal(warned.mock.callCount(), 0);
  near(bus[0]![12000]!, 0.7, 1e-7);
  const hitBus = buffer(1, { sampleRate: 24000 });
  play(hitBus, raw, 0.5, { align: "hit" });
  near(hitBus[0]![12000]!, 0.7, 1e-7);
});

test("hitOf puts a sound that dies within one window on its first sample", () => {
  const x = buffer(1, { channels: 1 });
  x[0]![4800] = 1;
  assert.equal(hitOf(x), 0.1);
  const burst = buffer(1, { channels: 1 });
  for (let i = 0; i < 12; i++) burst[0]![9000 + i] = 0.8 * Math.exp(-i / 3);
  near(hitOf(burst)!, 9000 / rate, 1 / rate);
});

test("subIn brings in the low band while leaving the highs", () => {
  const source = () => tone(2, (t) => 0.38 * sine(25, t) + 0.13 * sine(3600, t));
  const a = subIn(source(), 0.8, { db: 16, freq: 115 });
  const b = subIn(source(), 0.8, { db: 16, freq: 115 });
  assert.deepEqual(a, b);
  assert.deepEqual(diagnose("sub in", a), []);
  const jump = (band: "lowpass" | "highpass") =>
    20 * Math.log10(bandLevel(a, 1.1, 1.5, band) / bandLevel(a, 0.35, 0.7, band));
  near(jump("lowpass"), 16, 0.25);
  near(jump("highpass"), 0, 0.03);
});

test("subIn can start its hold partway through the bus and return to the dry signal", () => {
  const dry = tone(2, (t) => 0.38 * sine(25, t) + 0.13 * sine(3600, t));
  const x = subIn(slice(dry, 0), 1.15, { since: 0.35, db: 16, freq: 115, fade: 0.035 });
  assert.deepEqual(slice(x, 0, 0.35), slice(dry, 0, 0.35));
  assert.deepEqual(slice(x, 1.19), slice(dry, 1.19));
  const low = (bus: ReturnType<typeof buffer>) => bandLevel(bus, 0.6, 1, "lowpass");
  near(20 * Math.log10(low(x) / low(dry)), -16, 0.25);
  assert.deepEqual(diagnose("sub in with a lead", x), []);
});

test("subIn and dropOut reach their depth across the band they were read in", () => {
  const level = (x: ReturnType<typeof buffer>, from: number, to: number) => rms(slice(x, from, to)[0]!);
  for (const hz of [25, 33, 41, 49, 62, 80]) {
    const source = () => tone(4, (t) => 0.3 * sine(hz, t));
    const down = dropOut(source(), 1);
    const up = subIn(source(), 2);
    const deep = subIn(source(), 2, { db: 27.9 });
    const within = hz < 80 ? 0.15 : 0.35;
    near(20 * Math.log10(level(down, 1.3, 2.2) / level(down, 0.2, 0.9)), -19.4, within);
    near(20 * Math.log10(level(up, 2.3, 3.5) / level(up, 0.3, 1.7)), 18.3, within);
    near(20 * Math.log10(level(deep, 2.3, 3.5) / level(deep, 0.3, 1.7)), 27.9, hz < 80 ? 0.15 : 0.9);
  }
  const mids = dropOut(tone(4, (t) => 0.3 * sine(400, t)), 1);
  near(20 * Math.log10(level(mids, 1.3, 2.2) / level(mids, 0.2, 0.9)), 0, 0.02);
});

test("subIn and dropOut refuse edges too close for the fade to reach the depth", () => {
  assert.throws(() => dropOut(buffer(1), 0.1, { full: true, db: 20, fade: 0.1, hold: 0 }),
    /dropOut: 0 s between the edges is shorter than the 0\.1 s fade, so the level would only reach −2\.2 dB of the −20 dB asked/);
  assert.throws(() => subIn(buffer(1), 0.5, { since: 0.48, fade: 0.04 }), /subIn: 0\.02 s between the edges/);
  assert.doesNotThrow(() => dropOut(buffer(1), 0.1, { full: true, db: 20, fade: 0.1, hold: 0.1 }));
  assert.doesNotThrow(() => subIn(buffer(1), 0.5, { since: 0.46, fade: 0.04 }));
});

test("dropOut takes either the sub or the full bus down and returns after hold", () => {
  const source = () => tone(2, (t) => 0.33 * sine(30, t) + 0.12 * sine(4800, t));
  for (const full of [false, true]) {
    const o = { full, freq: 130, db: 18, hold: 0.55, fade: 0.04 };
    const a = dropOut(source(), 0.6, o);
    assert.deepEqual(a, dropOut(source(), 0.6, o));
    assert.deepEqual(diagnose("dropout", a), []);
    for (const band of ["lowpass", "highpass"] as const) {
      const before = bandLevel(a, 0.25, 0.55, band);
      const held = bandLevel(a, 0.8, 1.1, band);
      const after = bandLevel(a, 1.25, 1.55, band);
      near(20 * Math.log10(held / before), full || band === "lowpass" ? -18 : 0, 0.32);
      near(20 * Math.log10(after / before), 0, 0.05);
    }
  }
});

test("filter sweeps grow and shrink the highs smoothly", () => {
  const source = () => tone(2, (t) => 0.22 * sine(140, t) + 0.12 * sine(5500, t));
  for (const gesture of [filterOpen, filterClose]) {
    const o = { low: 1000, high: 20000 };
    const a = gesture(source(), 0.5, 1.4, o);
    assert.deepEqual(a, gesture(source(), 0.5, 1.4, o));
    assert.deepEqual(diagnose("filter sweep", a), []);
    const db = (from: number, to: number) => 20 * Math.log10(bandLevel(a, from, to, "highpass"));
    const middle = db(0.9, 1.0);
    const first = db(0.25, 0.45);
    const last = db(1.55, 1.85);
    const [closed, open] = gesture === filterOpen ? [first, last] : [last, first];
    assert.ok(open - closed > 20 && closed < middle && middle < open);
  }
});

test("filterOpen stays dry before since and filterClose goes dry after its until fade", () => {
  const dry = tone(2, (t) => 0.22 * sine(140, t) + 0.12 * sine(5500, t));
  const level = (bus: ReturnType<typeof buffer>, a: number, b: number) => bandLevel(bus, a, b, "highpass");
  const opened = filterOpen(slice(dry, 0), 0.75, 1.4, { since: 0.35, fade: 0.05 });
  assert.deepEqual(slice(opened, 0, 0.35), slice(dry, 0, 0.35));
  assert.ok(level(opened, 0.55, 0.72) < 0.1 * level(dry, 0.55, 0.72));
  assert.ok(level(opened, 1.48, 1.7) > 0.95 * level(dry, 1.48, 1.7));
  assert.deepEqual(diagnose("filter open with a lead", opened), []);

  const closed = filterClose(slice(dry, 0), 0.4, 0.85, { until: 1.35, fade: 0.06 });
  assert.ok(level(closed, 1, 1.3) < 0.1 * level(dry, 1, 1.3));
  assert.deepEqual(slice(closed, 1.42), slice(dry, 1.42));
  assert.deepEqual(diagnose("filter close with a return", closed), []);
});

test("bed holds its roots through a bar change without a click", () => {
  const o = { roots: [28, 24], bar: 1, texture: 0.012 };
  const x = bed(2, o);
  assert.deepEqual(x, bed(2, o));
  assert.deepEqual(diagnose("bed", x), []);
  const early = measure(slice(x, 0.12, 0.85));
  const late = measure(slice(x, 1.12, 1.85));
  assert.ok(early.sub > -0.6 && late.sub > -0.6);
  assert.ok(early.subCorrelation > 0.99 && late.subCorrelation > 0.99);
  const low = biquad("root", "lowpass", { freq: 80 }).run(slice(x, 0));
  const crossings = (from: number) => low[0]!.subarray(from, from + 24000)
    .reduce((sum, value, i, array) => sum + (value > 0 && array[i - 1]! <= 0 ? 1 : 0), 0);
  near(crossings(9600), 20.5, 1);
  near(crossings(57600), 16.4, 1);
});

test("the small and big hits start cleanly and their hit points land within 2 ms", () => {
  for (const size of ["small", "big"] as const) {
    const o = { size, seed: 70 };
    const sound = hit(o);
    assert.deepEqual(sound, hit(o));
    assert.deepEqual(diagnose(size, sound), []);
    const bus = buffer(1);
    const placed = hit(bus, 0.25, o);
    near(placed.start + hitOf(sound)!, 0.25, 1 / rate);
    near(hitOf(bus)!, 0.25, 0.002);
    const other = buffer(1);
    hit(other, 0.25, o);
    assert.deepEqual(bus, other);
    assert.deepEqual(diagnose("placed hit", bus), []);
  }
});

test("hit needs a time with a bus, and hits leave out times outside the bus", () => {
  // @ts-expect-error a bus without a time
  assert.throws(() => hit(buffer(1)), /hit: give a bus a time/);
  const bus = buffer(1);
  assert.deepEqual(hits(bus, [{ start: 0.97, end: 1.04 }]), [{ at: 0.97, kind: "start" }]);
  near(hitOf(slice(bus, 0.95, 1))!, 0.02, 0.002);
  assert.deepEqual(hits(buffer(1), [{ start: -0.2, end: 0.5 }]), [{ at: 0.5, kind: "end" }]);
});

test("with over, a landing stands its lift above the music, across the band and above 1.5 kHz", () => {
  const music = buffer(2);
  const random = rng(5);
  for (let i = 0; i < music[0]!.length; i++) {
    const t = i / rate;
    const v = 0.25 * sine(110, t) + 0.12 * sine(165, t) + 0.15 * (random() - 0.5);
    music[0]![i] = v;
    music[1]![i] = v;
  }
  const lift = (fx: ReturnType<typeof buffer>, at: number, high: boolean) => {
    const sum = (bus: ReturnType<typeof buffer>, from: number, to: number) => {
      const both = slice(music, from - 0.02, to);
      if (bus !== music) mixInto(both, slice(bus, from - 0.02, to));
      const mono = Object.assign([both[0]!], { sampleRate: rate });
      if (high) biquad("lift", "highpass", { freq: 1500 }).run(mono);
      return rms(mono[0]!.subarray(960));
    };
    return 20 * Math.log10(sum(fx, at, at + 0.01) / sum(music, at - 0.05, at + 0.05));
  };
  const plain = buffer(2);
  hits(plain, [{ start: 0.5, end: 1.2 }]);
  const lifted = buffer(2);
  const placed = hits(lifted, [{ start: 0.5, end: 1.2 }], { over: music });
  assert.deepEqual(placed, hits(buffer(2), [{ start: 0.5, end: 1.2 }]));
  // the plain gains hide the edge under music this bright; the lifted ones do not
  assert.ok(lift(plain, 1.2, true) < 1, String(lift(plain, 1.2, true)));
  for (const high of [false, true]) assert.ok(lift(lifted, 1.2, high) > 4, `${high}: ${lift(lifted, 1.2, high)}`);
  assert.ok(Math.min(lift(lifted, 1.2, false), lift(lifted, 1.2, true)) < 5.6);
  const single = buffer(2);
  hit(single, 1.2, { over: [music] });
  assert.ok(lift(single, 1.2, true) > 4.3);
  // over silence, the gains stand as given
  const quiet = buffer(2);
  hits(quiet, [{ start: 0.5, end: 1.2 }], { over: buffer(2) });
  for (let i = 0; i < quiet[0]!.length; i++) near(quiet[0]![i]!, plain[0]![i]!, 1e-6);
  // struck into the bus that holds the music, they stand above it unasked;
  // over: [] keeps the gains absolute
  const withMusic = () => Object.assign(music.map((ch) => Float32Array.from(ch)), { sampleRate: rate });
  const own = withMusic();
  hits(own, [{ start: 0.5, end: 1.2 }]);
  const asLifted = withMusic();
  mixInto(asLifted, lifted);
  for (let i = 0; i < own[0]!.length; i++) near(own[0]![i]!, asLifted[0]![i]!, 1e-5);
  const absolute = withMusic();
  hits(absolute, [{ start: 0.5, end: 1.2 }], { over: [] });
  const asPlain = withMusic();
  mixInto(asPlain, plain);
  for (let i = 0; i < absolute[0]!.length; i++) near(absolute[0]![i]!, asPlain[0]![i]!, 1e-5);
  const struck = withMusic();
  hit(struck, 1.2);
  const struckOver = withMusic();
  const alone = buffer(2);
  hit(alone, 1.2, { over: [music] });
  mixInto(struckOver, alone);
  for (let i = 0; i < struck[0]!.length; i++) near(struck[0]![i]!, struckOver[0]![i]!, 1e-5);
});

test("move landings take precedence and every placed hit has room", () => {
  const moves = [{ start: 0.4, end: 0.8 }, { t0: 0.84, t1: 1.3 }, { start: 1.28, end: 1.75 }];
  const bus = buffer(2.5);
  const placed = hits(bus, moves, { spacing: 0.12 });
  assert.deepEqual(placed, [
    { at: 0.4, kind: "start" }, { at: 0.8, kind: "end" },
    { at: 1.3, kind: "end" }, { at: 1.75, kind: "end" },
  ]);
  for (const { at } of placed)
    near(hitOf(slice(bus, at - 0.02, at + 0.12))!, 0.02, 0.002);
  const other = buffer(2.5);
  assert.deepEqual(hits(other, moves, { spacing: 0.12 }), placed);
  assert.deepEqual(bus, other);
  assert.deepEqual(diagnose("moves", bus), []);
  assert.deepEqual(hits(buffer(2.5), moves, { starts: false }).map((p) => p.at), [0.8, 1.3, 1.75]);
});

test("a riser grows into its end and the drop lands there with a sub tail", () => {
  const a = buffer(4);
  const b = buffer(4);
  for (const bus of [a, b]) {
    const rise = build(bus, 0.4, 1.8);
    near(rise.start, 0.4, 1 / rate);
    near(rise.end, 1.8, 1 / rate);
    assert.equal(rms(slice(bus, 1.81, 2.1)[0]!), 0);
    assert.ok(rms(slice(bus, 1.53, 1.75)[0]!) > 6 * rms(slice(bus, 0.52, 0.74)[0]!));
    drop(bus, 1.8);
    near(hitOf(slice(bus, 1.76, 2.2))!, 0.04, 0.002);
    assert.ok(rms(slice(bus, 2.7, 3.1)[0]!) > 0.005);
  }
  assert.deepEqual(a, b);
  assert.deepEqual(diagnose("build and drop", a), []);
});

test("build starts filtering the other bus at the start of the rise", () => {
  const dry = tone(2, (t) => 0.22 * sine(140, t) + 0.12 * sine(5500, t));
  const filtered = slice(dry, 0);
  build(buffer(2), 0.5, 1.6, { filterBus: filtered });
  assert.deepEqual(slice(filtered, 0, 0.5), slice(dry, 0, 0.5));
  assert.ok(bandLevel(filtered, 0.6, 0.7, "highpass") < 0.15 * bandLevel(dry, 0.6, 0.7, "highpass"));
  assert.ok(bandLevel(filtered, 1.68, 1.85, "highpass") > 0.95 * bandLevel(dry, 1.68, 1.85, "highpass"));
  assert.deepEqual(diagnose("build filter bus", filtered), []);
});

test("whoosh has clean edges and places its peak on the picture", () => {
  const x = whoosh();
  assert.deepEqual(x, whoosh());
  assert.deepEqual(diagnose("whoosh", x), []);
  const bus = buffer(2);
  play(bus, x, 0.85, { align: "peak" });
  near(peakOf(bus)!, 0.85, 1 / rate);
  assert.deepEqual(diagnose("placed whoosh", bus), []);
});
