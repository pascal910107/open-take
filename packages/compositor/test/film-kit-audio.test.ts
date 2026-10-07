// The film kit's sound (kit/audio.mjs): the plumbing films each wrote again
// for their scores. Loudness is checked against ffmpeg's ebur128 — what `film
// check` reports — and `diagnose` against the clicks films shipped: a release
// that jumped from the sustain level, a filter that blew up, saws started in
// phase. Clean material has to come back clean, or the findings get ignored.

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { promisify } from "node:util";
import {
  biquad,
  buffer,
  buses,
  crossfade,
  curveOf,
  diagnose,
  duck,
  envelope,
  fade as fadeEdges,
  load,
  loudness,
  mix,
  normalize,
  onsetOf,
  panFor,
  peakOf,
  play,
  readEvents,
  reverb,
  rng,
  slice,
  space,
  varispeed,
  writeWav,
} from "../kit/audio.mjs";
import { resolveFfmpeg } from "../src/ffmpeg";

const exec = promisify(execFile);
const SR = 48000;

let dir = "";
let files = 0;
before(async () => {
  dir = await mkdtemp(join(tmpdir(), "open-take-audio-test-"));
});
after(async () => {
  await rm(dir, { recursive: true, force: true });
});

const near = (a: number, b: number, tol: number, what: string) =>
  assert.ok(Math.abs(a - b) <= tol, `${what}: ${a} vs ${b} (±${tol})`);
const db = (x: number) => 20 * Math.log10(x);
const saw = (f: number, t: number) => 2 * ((f * t) % 1) - 1;
const mtof = (m: number) => 440 * 2 ** ((m - 69) / 12);
const seconds = (s: number) => new Float32Array(Math.round(s * SR));
const rmsOf = (x: Float32Array, a: number, b: number) => {
  let s = 0;
  for (let i = a; i < b; i++) s += x[i]! ** 2;
  return Math.sqrt(s / (b - a));
};
/** in and out over 10 ms, so neither meter starts on an edge */
const fade = (i: number, n: number) => Math.min(1, i / 480, (n - 1 - i) / 480);
/** a buffer filled sample by sample */
function fill(secs: number, fn: (i: number, c: number, n: number) => number, channels = 2) {
  const b = buffer(secs, { channels });
  b.forEach((ch, c) => {
    for (let i = 0; i < ch.length; i++) ch[i] = fn(i, c, ch.length);
  });
  return b;
}

/** what ffmpeg's ebur128 reads (its frame metadata, 3 decimals) */
async function ebur128(chs: Float32Array[], rate = SR) {
  const n = chs[0]!.length;
  const inter = new Float32Array(n * chs.length);
  for (let i = 0; i < n; i++)
    for (let c = 0; c < chs.length; c++) inter[i * chs.length + c] = chs[c]![i]!;
  const file = join(dir, `m${files++}.f32`);
  await writeFile(file, new Uint8Array(inter.buffer));
  const { stderr } = await exec(
    await resolveFfmpeg(),
    [
      "-hide_banner",
      "-nostats",
      "-f",
      "f32le",
      "-ar",
      String(rate),
      "-ac",
      String(chs.length),
      "-i",
      file,
      "-af",
      "ebur128=peak=true:metadata=1,ametadata=mode=print",
      "-f",
      "null",
      "-",
    ],
    { maxBuffer: 1 << 26 },
  );
  const last = (key: string) => {
    const all = [...stderr.matchAll(new RegExp(`lavfi\\.r128\\.${key}=(-?[\\d.]+)`, "g"))];
    return Number(all[all.length - 1]![1]);
  };
  return { lufs: last("I"), truePeak: db(last("true_peak")) };
}

test("loudness and true peak read what ffmpeg's ebur128 reads", async (t) => {
  const r = rng(1);
  let b0 = 0;
  let b1 = 0;
  let b2 = 0;
  const pink = new Float32Array(5 * 44100).map((_, i, a) => {
    const w = 2 * r() - 1;
    b0 = 0.99765 * b0 + w * 0.099046;
    b1 = 0.963 * b1 + w * 0.2965164;
    b2 = 0.57 * b2 + w * 1.0526913;
    return 0.1 * (b0 + b1 + b2 + w * 0.1848) * Math.min(1, i / 441, (a.length - 1 - i) / 441);
  });
  // notes, a noise burst, 3 s of silence and a quiet stretch: the gates matter
  const piece = buffer(20);
  const env = envelope({ attack: 0.01, decay: 0.3, sustain: 0.4, release: 0.3 });
  for (let k = 0; k < 16; k++) {
    const f = 110 * 2 ** (((k * 5) % 24) / 12);
    const note = seconds(env.end(0.35)).map(
      (_, i) => Math.sin((2 * Math.PI * f * i) / SR) * env(i / SR, 0.35),
    );
    mix(piece, note, k * 0.5, [0.5, 0.35]);
  }
  mix(
    piece,
    seconds(1).map((_, i) => (2 * r() - 1) * 0.6 * Math.exp(-i / SR / 0.15) * Math.min(1, i / 480)),
    9,
  );
  for (let i = 14 * SR; i < 18 * SR; i++)
    for (const ch of piece) ch[i] = (ch[i] ?? 0) + 0.01 * Math.sin((2 * Math.PI * 440 * i) / SR);
  const signals: [string, Float32Array[], number][] = [
    // 997 Hz at −20 dBFS in both channels: −20.0 LUFS (the standard's own
    // example: 0 dBFS in one channel reads −3.01)
    ["tone", fill(6, (i, _, n) => 0.1 * Math.sin((2 * Math.PI * 997 * i) / SR) * fade(i, n)), SR],
    ["noise", fill(6, (i, _, n) => 0.3 * (2 * r() - 1) * fade(i, n)), SR],
    ["pink, 44.1 kHz", [pink], 44100],
    ["a piece with gaps", piece, SR],
    // a quarter of the rate at 45°: the samples sit at 0.71 of the peak between them
    [
      "peaks between samples",
      fill(5, (i, _, n) => 0.5 * Math.sin((Math.PI / 2) * i + Math.PI / 4) * fade(i, n)),
      SR,
    ],
  ];
  for (const [name, chs, rate] of signals) {
    const mine = loudness(chs, rate);
    const theirs = await ebur128(chs, rate);
    t.diagnostic(
      `${name}: ${mine.lufs.toFixed(3)} LUFS vs ffmpeg ${theirs.lufs.toFixed(3)} (Δ ${(mine.lufs - theirs.lufs).toFixed(3)}); ` +
        `${mine.truePeak.toFixed(3)} dBTP vs ${theirs.truePeak.toFixed(3)} (Δ ${(mine.truePeak - theirs.truePeak).toFixed(3)})`,
    );
    near(mine.lufs, theirs.lufs, 0.2, `${name}: integrated loudness`);
    near(mine.truePeak, theirs.truePeak, 0.2, `${name}: true peak`);
    if (name === "tone") near(mine.lufs, -20, 0.02, "the standard's 997 Hz example");
    if (name === "peaks between samples") {
      near(mine.truePeak, db(0.5), 0.05, "the peak between the samples");
      near(mine.peak, db(0.5 * Math.SQRT1_2), 0.01, "the samples themselves");
    }
  }
  // before the first sample and after the last is silence: a tone that starts
  // and stops at full tilt reads as it does with silence around it (ffmpeg's
  // resampler mirrors the first samples instead, and reads such a start higher)
  const tone = (i: number) => 0.5 * Math.sin((Math.PI / 2) * i + Math.PI / 4);
  const abrupt = fill(3, tone);
  const padded = fill(4, (i) => (i < SR / 2 || i >= 3.5 * SR ? 0 : tone(i - SR / 2)));
  near(loudness(abrupt).truePeak, (await ebur128(padded)).truePeak, 0.02, "an abrupt start");
});

test("loudness gates as BS.1770-4 does: silence and quiet stretches do not drag it down", () => {
  const tone = (amp: number) => (i: number) => amp * Math.sin((2 * Math.PI * 997 * i) / SR);
  const loud = loudness(fill(5, tone(0.1))).lufs;
  // 10 s of silence: under −70 LUFS, gated out (counted, it would take 4.8 dB
  // off; the three blocks straddling the edge count, and take 0.13)
  const withSilence = fill(15, (i) => (i < 5 * SR ? tone(0.1)(i) : 0));
  near(loudness(withSilence).lufs, loud - 0.13, 0.01, "silence is not counted");
  // a stretch 30 dB down: more than 10 LU under the rest, gated out
  const withQuiet = fill(15, (i) => (i < 5 * SR ? tone(0.1)(i) : tone(0.00316)(i)));
  near(loudness(withQuiet).lufs, loud - 0.13, 0.01, "a stretch 30 dB down is not counted");
  // one 5 dB down is, and lowers the integrated loudness
  const withSofter = fill(15, (i) => (i < 5 * SR ? tone(0.1)(i) : tone(0.0562)(i)));
  assert.ok(loudness(withSofter).lufs < loud - 2, "a stretch 5 dB down counts");
  assert.equal(loudness(fill(5, () => 0)).lufs, Number.NEGATIVE_INFINITY, "silence has none");
  assert.equal(
    loudness(fill(0.3, tone(0.1))).lufs,
    Number.NEGATIVE_INFINITY,
    "under one 400 ms block",
  );
});

test("normalize lands on −16 LUFS with the true peak at or under −1 dBTP — by its meter and ffmpeg's", async (t) => {
  const r = rng(99);
  const bed = (amp: number) =>
    fill(12, (i, c, n) => {
      const tt = i / SR;
      return (
        (amp * Math.sin(2 * Math.PI * (c ? 247 : 196) * tt) + (amp / 3) * (2 * r() - 1)) *
        Math.min(1, tt / 0.5, (n - i) / SR)
      );
    });
  /** a bed with short hits far louder than it on top: the bed sets the loudness, the hits the peak */
  const withHits = (amp: number, hitGain: number, bright: boolean) => {
    const b = bed(amp);
    const hit = envelope({ attack: 0.0005, decay: 0.03, sustain: 0, release: 0.005 });
    for (let k = 0; k < 11; k++) {
      const note = seconds(hit.end(0.03)).map(
        (_, i) =>
          (bright
            ? (i & 1 ? 1 : -1) * (0.5 + 0.5 * r())
            : Math.sin((2 * Math.PI * 80 * i) / SR) + 0.3 * (2 * r() - 1)) * hit(i / SR, 0.03),
      );
      mix(b, note, 0.6 + k * 0.97, hitGain);
    }
    return b;
  };
  const cases: [string, Float32Array[], boolean][] = [
    ["a quiet bed: one gain up", bed(0.003), false],
    ["a hot bed: one gain down", bed(0.5), false],
    ["hits 17 dB over the bed", withHits(0.03, 0.25, false), true],
    ["hits 25 dB over the bed", withHits(0.03, 0.9, false), true],
    ["bright hits (peaks between samples)", withHits(0.03, 0.5, true), true],
  ];
  for (const [name, chs, limits] of cases) {
    const out = normalize(chs);
    const mine = loudness(out);
    const theirs = await ebur128(out);
    t.diagnostic(
      `${name}: ${mine.lufs.toFixed(3)} LUFS / ${mine.truePeak.toFixed(3)} dBTP; ` +
        `ffmpeg ${theirs.lufs.toFixed(3)} / ${theirs.truePeak.toFixed(3)}; ${JSON.stringify(out.report)}`,
    );
    near(mine.lufs, -16, 0.3, `${name}: loudness`);
    near(theirs.lufs, -16, 0.3, `${name}: loudness by ffmpeg`);
    assert.ok(mine.truePeak <= -1, `${name}: true peak ${mine.truePeak}`);
    assert.ok(theirs.truePeak <= -1 + 0.01, `${name}: true peak by ffmpeg ${theirs.truePeak}`);
    assert.equal(
      out.report.limited !== null,
      limits,
      `${name}: the limiter ${limits ? "works" : "rests"}`,
    );
  }
  // with nothing to hold down it is one gain: the waveform keeps its shape
  const quiet = bed(0.003);
  const out = normalize(quiet);
  const top = quiet[0]!.reduce((m, v, i) => (Math.abs(v) > Math.abs(quiet[0]![m]!) ? i : m), 0);
  const g = out[0]![top]! / quiet[0]![top]!;
  for (let i = SR; i < 2 * SR; i += 997) near(out[1]![i]!, quiet[1]![i]! * g, 1e-6, "one gain");
  near(db(g), out.report.gain, 0.01, "the gain it reports");
  assert.notEqual(out[0], quiet[0], "new channels; the mix it was given is untouched");
  // what it cannot do, it says
  const broken = bed(0.1);
  broken[1]![SR * 3] = Number.NaN;
  assert.throws(() => normalize(broken), /channel 1 is NaN at 3 s/);
  assert.throws(() => normalize(fill(3, () => 0)), /silent/);
});

/** an envelope that releases from the sustain level, the way films' first scores did */
function releasesFromSustain(t: number, held: number) {
  const [A, D, S, R] = [0.01, 0.5, 0.2, 0.3];
  if (t < held) return t < A ? t / A : t < A + D ? 1 - (1 - S) * ((t - A) / D) : S;
  const u = (t - held) / R;
  return u >= 1 ? 0 : S * (1 - u);
}

test("an envelope let go mid-attack or mid-decay releases from where it was: no jump, no click", () => {
  const env = envelope({ attack: 0.01, decay: 0.5, sustain: 0.2, release: 0.3 });
  for (const held of [0.004, 0.15, 0.8]) {
    near(env(held - 1e-9, held), env(held, held), 1e-6, `continuous when let go at ${held} s`);
    near(env(held + 0.15, held), env(held, held) / 2, 1e-9, "halfway down from where it was");
    assert.equal(env(env.end(held), held), 0, "silent at its end");
  }
  near(env(0.01), 1, 1e-9, "the top of the attack");
  near(env(5), 0.2, 1e-9, "held: the sustain level");
  // with no decay the attack rises to the sustain level (not to 1 and down a cliff)
  const flat = envelope({ attack: 0.01, sustain: 0.5 });
  near(flat(0.01 - 1e-9), 0.5, 1e-6, "the attack meets the sustain level");
  // the defaults: a plain gate that cannot click
  const gate = envelope();
  near(gate(0.0025), 0.5, 1e-9, "5 ms in");
  near(gate.end(1), 1.02, 1e-12, "20 ms out");
  // three notes let go mid-decay, through each envelope
  const notes = (shape: (t: number, held: number) => number) => {
    const stem = seconds(3);
    for (const [t0, held] of [
      [0.2, 0.153],
      [1.2, 0.211],
      [2.1, 0.18],
    ] as const) {
      for (let i = 0; i < Math.round((held + 0.3) * SR); i++)
        stem[Math.round(t0 * SR) + i]! +=
          0.5 * Math.sin((2 * Math.PI * 220 * i) / SR) * shape(i / SR, held);
    }
    return stem;
  };
  assert.deepEqual(diagnose("kit", notes(env)), [], "the kit's envelope: nothing to find");
  const clicks = diagnose("naive", notes(releasesFromSustain)).filter((f) => f.kind === "click");
  assert.deepEqual(
    clicks.map((f) => f.at),
    [0.353, 1.411, 2.28],
    "released from the sustain level: a click as each note is let go",
  );
});

test("diagnose finds the three causes of the films' clicks, and a NaN", () => {
  // 1. a release that jumps from the sustain level — above
  // 2. a filter that blew up: a naive (Chamberlin) state-variable lowpass whose
  //    cutoff sweeps past where it is stable, 1–2 s
  const sweep = (t: number) =>
    800 + 15000 * Math.sin(Math.PI * (t - 1)) ** 2 * (t > 1 && t < 2 ? 1 : 0);
  const pad = seconds(4);
  let low = 0;
  let band = 0;
  for (let i = 0; i < 3 * SR; i++) {
    const tt = i / SR;
    const f = 2 * Math.sin((Math.PI * sweep(tt)) / SR);
    low += f * band;
    band += f * (0.3 * saw(110, tt) * Math.min(1, tt / 0.01) - low - 0.4 * band);
    pad[Math.round(0.5 * SR) + i] = low;
  }
  const blew = diagnose("pad", pad);
  const runaway = blew.find((f) => f.kind === "clip");
  assert.ok(runaway && runaway.at > 1.5 && runaway.at < 2.5, "where it ran away");
  assert.match(runaway!.message, /ran away: a filter or a feedback loop/);
  assert.ok(
    blew.some((f) => f.kind === "nonfinite" && f.at > 1.5),
    "and the NaN it ended in",
  );
  // the kit's cookbook lowpass through the same sweep stays put
  const lp = biquad("pad", "lowpass", { freq: 800, q: 2 });
  const kept = seconds(4);
  for (let i = 0; i < 3 * SR; i++) {
    const tt = i / SR;
    lp.set({ freq: sweep(tt) });
    kept[Math.round(0.5 * SR) + i] = lp(
      0.3 * saw(110, tt) * Math.min(1, tt / 0.01, (3 - tt) / 0.01),
    );
  }
  assert.deepEqual(diagnose("pad", kept), [], "the kit's filter through that sweep: nothing");
  // 3. saws started in phase: chord stabs whose six saws all start on their
  //    edge at once, with no attack — one jump as big as all six together
  const stabs = (phase: (k: number) => number, attack: number) => {
    const stem = seconds(3);
    const chords = [
      [60, 64, 67, 71, 74, 78],
      [62, 65, 69, 72, 76, 79],
      [57, 60, 64, 67, 71, 74],
      [59, 62, 66, 69, 73, 76],
    ];
    chords.forEach((chord, k) => {
      const offsets = chord.map((_, j) => phase(k * 6 + j));
      for (let i = 0; i < 0.55 * SR; i++) {
        const tt = i / SR;
        let v = 0;
        chord.forEach((m, j) => {
          v += saw(mtof(m), tt + offsets[j]! / mtof(m));
        });
        const shape =
          Math.exp(-tt / 0.15) *
          Math.min(1, (0.55 - tt) / 0.01) *
          (attack ? Math.min(1, tt / attack) : 1);
        stem[Math.round((0.3 + k * 0.6) * SR) + i]! += 0.05 * v * shape;
      }
    });
    return diagnose("stabs", stem).filter((f) => f.kind === "click");
  };
  assert.deepEqual(
    stabs(() => 0, 0).map((f) => f.at),
    [0.3, 0.9, 1.5, 2.1],
    "in phase: a click on every stab",
  );
  const r = rng(5);
  const phases = Array.from({ length: 24 }, () => r());
  assert.deepEqual(
    stabs((j) => phases[j]!, 0),
    [],
    "the same stabs in random phases: none",
  );
  assert.deepEqual(
    stabs(() => 0, 0.005),
    [],
    "in phase with a 5 ms attack: none",
  );
  // 4. a NaN
  const nan = fill(2, (i, _, n) => 0.2 * Math.sin((2 * Math.PI * 330 * i) / SR) * fade(i, n));
  for (let i = 0; i < 10; i++) nan[0]![Math.round(1.234 * SR) + i] = Number.NaN;
  const all = diagnose("lead", nan);
  assert.equal(all.length, 1, "the NaN, and no clicks made of its edges");
  const [found] = all;
  assert.equal(found?.kind, "nonfinite");
  assert.equal(found?.at, 1.234);
  assert.deepEqual(found?.channels, [0]);
  assert.match(found!.message, /^lead: 10 samples are NaN or infinite, 1\.234–1\.234 s/);
});

test("clean material comes back clean: noise drums, plain saws, resonance, reverb, a whoosh", () => {
  const r = rng(9);
  const stems: [string, Float32Array][] = [];
  const add = (name: string, secs: number, write: (stem: Float32Array) => void) => {
    const stem = seconds(secs);
    write(stem);
    stems.push([name, stem]);
  };
  const at = (stem: Float32Array, t0: number, i: number, v: number) => {
    stem[Math.round(t0 * SR) + i]! += v;
  };
  add("hats", 2, (s) => {
    const hp = biquad("hats", "highpass", { freq: 8000, q: 0.8 });
    for (let k = 0; k < 8; k++)
      for (let i = 0; i < 0.06 * SR; i++)
        at(s, 0.1 + k * 0.23, i, 0.4 * hp(2 * r() - 1) * Math.exp(-i / SR / 0.014));
  });
  add("claps", 2, (s) => {
    const bp = biquad("claps", "bandpass", { freq: 1500, q: 1.2 });
    for (let k = 0; k < 4; k++)
      for (let i = 0; i < 0.3 * SR; i++) {
        const t = i / SR;
        const e =
          (t < 0.01 ? 1 : t < 0.02 ? 0.6 : t < 0.03 ? 0.8 : 0) * Math.exp(-(t % 0.01) / 0.004) +
          (t > 0.03 ? Math.exp(-(t - 0.03) / 0.09) : 0);
        at(s, 0.2 + k * 0.45, i, bp(2 * r() - 1) * e * 1.6);
      }
  });
  add("kick with its beater click", 2, (s) => {
    for (const t0 of [0.2, 0.7, 1.2]) {
      let ph = 0;
      const n = 0.42 * SR;
      for (let i = 0; i < n; i++) {
        const t = i / SR;
        ph += (2 * Math.PI * (45 + 95 * Math.exp(-t / 0.03))) / SR;
        const v = 0.8 * Math.sin(ph) * Math.exp(-t / 0.16) + (t < 0.004 ? 0.2 * (2 * r() - 1) : 0);
        at(s, t0, i, v * Math.min(1, (n - 1 - i) / 240));
      }
    }
  });
  add("plain saw bass, 55 Hz", 2, (s) => {
    const env = envelope({ attack: 0.005, release: 0.05 });
    for (let i = 0; i < env.end(1.5) * SR; i++)
      at(s, 0.25, i, 0.4 * saw(55, i / SR) * env(i / SR, 1.5));
  });
  add("plain saws through a resonant lowpass", 3, (s) => {
    const env = envelope({ attack: 0.01, release: 0.05 });
    const lp = biquad("bass", "lowpass", { freq: 2000, q: 5 });
    // run the filter past the envelope's end: its ringing is part of the note
    for (let i = 0; i < (env.end(2) + 0.2) * SR; i++)
      at(s, 0.3, i, lp(0.3 * saw(55, i / SR) * env(i / SR, 2)));
  });
  add("a chord of plain saws, random phases", 3, (s) => {
    const voices = [48, 52, 55, 59, 62].map(mtof);
    const ph = voices.map(() => r());
    for (let i = 0; i < 2.5 * SR; i++) {
      const t = i / SR;
      let v = 0;
      voices.forEach((f, j) => {
        v += saw(f, t + ph[j]! / f);
      });
      at(s, 0.25, i, 0.06 * v * Math.min(1, t / 0.01, (2.5 - t) / 0.01));
    }
  });
  add("bells", 3, (s) => {
    const env = envelope({ attack: 0.002, decay: 0.8, sustain: 0, release: 0.05, curve: 5 });
    for (const [t0, f] of [
      [0.2, 660],
      [0.8, 880],
      [1.4, 990],
    ] as const)
      for (let i = 0; i < env.end(0.9) * SR; i++) {
        const t = i / SR;
        at(
          s,
          t0,
          i,
          0.3 *
            Math.sin(2 * Math.PI * f * t + 2 * env(t, 0.9) * Math.sin(2 * Math.PI * f * 3.5 * t)) *
            env(t, 0.9),
        );
      }
  });
  add("a whoosh", 2, (s) => {
    let a = 0;
    let b = 0;
    const n = 1.2 * SR;
    for (let i = 0; i < n; i++) {
      const u = i / n;
      const k = 1 - Math.exp((-2 * Math.PI * 200 * 30 ** u) / SR);
      a += k * (2 * r() - 1 - a);
      b += k * (a - b);
      at(s, 0.3, i, (a - b) * Math.sin(Math.PI * u) * 0.9);
    }
  });
  const pluck = seconds(1);
  for (let i = 0; i < 0.2 * SR; i++)
    pluck[Math.round(0.1 * SR) + i] =
      0.5 *
      Math.sin((2 * Math.PI * 440 * i) / SR) *
      Math.exp(-i / SR / 0.05) *
      Math.min(1, i / 100);
  stems.push(["a reverb tail", reverb(pluck, SR, { size: 0.8 })[0]!]);
  for (const [name, stem] of stems) assert.deepEqual(diagnose(name, stem), [], name);
});

test("diagnose names clipping, DC, and one moment in both channels once", () => {
  const over = fill(1, (i) => 1.5 * Math.sin((2 * Math.PI * 100 * i) / SR) * fade(i, SR), 1);
  const [clip] = diagnose("bass", over);
  assert.equal(clip?.kind, "clip");
  assert.match(clip!.message, /over full scale .* \(peak \+3\.5 dBFS\)/);
  const flat = fill(
    1,
    (i) => Math.max(-1, Math.min(1, 1.5 * Math.sin((2 * Math.PI * 100 * i) / SR))),
    1,
  );
  assert.match(diagnose("bass", flat)[0]!.message, /flat at full scale/);
  // a peak that touches 1.0 and turns back is not clipped
  const touch = fill(1, (i) => Math.sin((2 * Math.PI * 1000 * i) / SR) * fade(i, SR), 1);
  assert.ok(touch[0]!.some((v) => v === 1));
  assert.deepEqual(diagnose("bass", touch), []);
  // noise from Math.random()-style numbers, 0..1: centred on 0.5
  const r = rng(3);
  const offCentre = fill(3, (i, _, n) => 0.2 * r() * fade(i, n), 1);
  const [dc] = diagnose("noise", offCentre);
  assert.equal(dc?.kind, "dc");
  assert.match(dc!.message, /a DC offset of \+0\.1 \(-20 dBFS\), 0–3 s/);
  assert.deepEqual(
    diagnose(
      "noise",
      fill(3, (i, _, n) => 0.2 * (2 * r() - 1) * fade(i, n), 1),
    ),
    [],
  );
  // a note cut short in a stereo stem: one finding, both channels
  const cut = fill(1, (i) =>
    i > 0.2 * SR && i < 0.6 * SR
      ? 0.3 * Math.sin((2 * Math.PI * 440 * (i - 0.2 * SR)) / SR + 1)
      : 0,
  );
  const both = diagnose("lead", cut);
  assert.deepEqual(
    both.map((f) => [f.kind, f.at, f.channels]),
    [
      ["click", 0.2, [0, 1]],
      ["click", 0.6, [0, 1]],
    ],
  );
});

test("writeWav round-trips through ffmpeg: 24-bit, 16-bit and float", async () => {
  const r = rng(7);
  const sound = fill(
    0.5,
    (i, c) => (c ? 0.999 : 0.7) * Math.sin((2 * Math.PI * 440 * i) / SR) + 0.0005 * (2 * r() - 1),
  );
  for (const [bits, codec, step] of [
    [24, "pcm_s24le", 2 ** -23],
    [16, "pcm_s16le", 2 ** -15],
    [32, "pcm_f32le", 0],
  ] as const) {
    const file = join(dir, `round-${bits}.wav`);
    const wrote = writeWav(file, sound, SR, bits);
    assert.equal(wrote.clipped, 0);
    near(wrote.seconds, 0.5, 1e-12, "its length");
    const ffmpeg = await resolveFfmpeg();
    const info = await exec(ffmpeg, ["-hide_banner", "-i", file]).catch(
      (e: { stderr: string }) => e,
    );
    assert.match(
      info.stderr,
      new RegExp(`Audio: ${codec}\\b.*, 48000 Hz, stereo`),
      `${bits}-bit reads as ${codec}`,
    );
    const { stdout } = await exec(
      ffmpeg,
      ["-v", "error", "-i", file, "-f", "f32le", "-c:a", "pcm_f32le", "-"],
      {
        encoding: "buffer",
        maxBuffer: 1 << 26,
      },
    );
    const back = new Float32Array(new Uint8Array(stdout).buffer);
    assert.equal(back.length, sound[0]!.length * 2, "every sample of both channels");
    let worst = 0;
    for (let i = 0; i < sound[0]!.length; i++)
      for (let c = 0; c < 2; c++)
        worst = Math.max(worst, Math.abs(back[i * 2 + c]! - sound[c]![i]!));
    assert.ok(worst <= step / 2 + 1e-9, `${bits}-bit: off by ${worst}, at most half a step`);
  }
  // past full scale: clipped and counted; a NaN stops it, saying where
  const hot = fill(0.1, (i) => 1.2 * Math.sin((2 * Math.PI * 100 * i) / SR), 1);
  assert.ok(writeWav(join(dir, "hot.wav"), hot).clipped > 0);
  const mono = await exec(await resolveFfmpeg(), [
    "-hide_banner",
    "-i",
    join(dir, "hot.wav"),
  ]).catch((e: { stderr: string }) => e);
  assert.match(mono.stderr, /Audio: pcm_s24le\b.*, 48000 Hz, mono/, "one channel reads as mono");
  hot[0]![2400] = Number.NaN;
  assert.throws(() => writeWav(join(dir, "nan.wav"), hot), /channel 0 is NaN at 0\.05 s/);
});

test("the reverb rings out and dies away; size, damping and width do what they say", () => {
  const impulse = new Float32Array(SR / 10);
  impulse[0] = 1;
  const levels = (x: Float32Array) => {
    const w = SR / 10;
    const out = [];
    for (let a = 0; a + w <= x.length; a += w) out.push(db(rmsOf(x, a, a + w)));
    return out;
  };
  const tails: number[] = [];
  for (const size of [0.2, 0.5, 0.8]) {
    const [l, r] = reverb(impulse, SR, { size });
    assert.equal(r!.length, l!.length);
    const lv = levels(l!);
    for (let k = 1; k < lv.length; k++)
      assert.ok(lv[k]! < lv[k - 1]!, `size ${size}: it only dies away (${k / 10} s)`);
    assert.ok(lv[lv.length - 1]! < lv[0]! - 50, `size ${size}: the tail it keeps ends 50+ dB down`);
    tails.push(l!.length);
    let corr = 0;
    let el = 0;
    let er = 0;
    for (let i = 0; i < l!.length; i++) {
      corr += l![i]! * r![i]!;
      el += l![i]! ** 2;
      er += r![i]! ** 2;
    }
    assert.ok(Math.abs(corr / Math.sqrt(el * er)) < 0.2, "the two sides differ: it is wide");
  }
  assert.ok(tails[0]! < tails[1]! && tails[1]! < tails[2]!, "a bigger room rings longer");
  const r0 = rng(1);
  const burst = seconds(0.5).map((_, i) => (i < 2400 ? 2 * r0() - 1 : 0));
  const [l, r] = reverb(burst, SR, { width: 0 });
  assert.deepEqual(l, r, "width 0 is mono");
  // damping takes the highs out of the late tail
  const highs = (damp: number) => {
    const late = reverb(burst, SR, { damp, size: 0.7 })[0]!.slice(0.6 * SR, 0.9 * SR);
    const hp = biquad("tail", "highpass", { freq: 4000 });
    return db(rmsOf(hp.run(late), 0, late.length));
  };
  assert.ok(highs(1) < highs(0) - 15, "damped, the highs die sooner");
  const quiet = reverb(seconds(1), SR);
  assert.ok(
    quiet[0]!.every((v) => v === 0),
    "silence in, silence out",
  );
  near(
    quiet[0]!.length / SR,
    1 + 1.47,
    0.02,
    "the tail kept: until the longest comb is 60 dB down",
  );
  near(reverb(burst, SR, { tail: 0.25 })[0]!.length / SR, 0.75, 1e-9, "or as long as asked");
});

test("duck dips the sound by the amount while the key plays, following it at attack and release", () => {
  const music = fill(4, (i) => 0.5 * Math.sin((2 * Math.PI * 330 * i) / SR));
  const before = Float32Array.from(music[0]!);
  const voice = seconds(4).map((_, i) =>
    i >= SR && i < 2 * SR ? 0.8 * Math.sin((2 * Math.PI * 150 * i) / SR) : 0,
  );
  const out = duck(music, voice, SR, { amount: 8, attack: 0.02, release: 0.3 });
  const level = (t0: number, t1: number) =>
    db(
      rmsOf(out[0]!, Math.round(t0 * SR), Math.round(t1 * SR)) /
        rmsOf(music[0]!, Math.round(t0 * SR), Math.round(t1 * SR)),
    );
  near(level(0.2, 0.9), 0, 1e-6, "untouched before the key");
  near(level(1.3, 1.9), -8, 0.05, "down by the amount under it");
  near(level(1.018, 1.022), -8 * (1 - Math.exp(-1)), 0.6, "63 % of the way down one attack in");
  near(level(2.29, 2.31), -8 * Math.exp(-1), 0.3, "37 % of the dip left one release after");
  near(level(3.6, 3.9), 0, 0.05, "back once the key has gone");
  assert.deepEqual(music[0], before, "the sound it was given is untouched");
  // a key half as loud in places takes the sound half as far down there
  const uneven = seconds(4).map(
    (_, i) => (i < 2 * SR ? 0.8 : 0.4) * Math.sin((2 * Math.PI * 150 * i) / SR),
  );
  const half = duck(music, uneven, SR, { amount: 8, attack: 0.02, release: 0.3 });
  const at = (t0: number, t1: number) =>
    db(
      rmsOf(half[0]!, Math.round(t0 * SR), Math.round(t1 * SR)) /
        rmsOf(music[0]!, Math.round(t0 * SR), Math.round(t1 * SR)),
    );
  near(at(1, 1.9), -8, 0.05, "the key at its loudest: the whole amount");
  near(at(3, 3.9), -4, 0.1, "half as loud: half as far");
});

test("biquad: the cookbook's responses, a state per channel, and a stop that names the track", () => {
  /** the level a filter gives a steady sine, once it has settled (dB) */
  const response = (f: (x: number, ch?: number) => number, hz: number) => {
    const x = seconds(0.5).map((_, i) => Math.sin((2 * Math.PI * hz * i) / SR));
    const y = x.map((v) => f(v));
    return db(rmsOf(y, SR / 4, SR / 2) / rmsOf(x, SR / 4, SR / 2));
  };
  near(
    response(biquad("t", "lowpass", { freq: 1000 }), 1000),
    -3.01,
    0.05,
    "a lowpass is 3 dB down at its frequency",
  );
  assert.ok(
    response(biquad("t", "lowpass", { freq: 1000 }), 8000) < -30,
    "and far down an octave pair above",
  );
  near(
    response(biquad("t", "highpass", { freq: 1000 }), 1000),
    -3.01,
    0.05,
    "a highpass, at its frequency",
  );
  near(
    response(biquad("t", "bandpass", { freq: 2000, q: 2 }), 2000),
    0,
    0.05,
    "a bandpass passes its centre",
  );
  near(
    response(biquad("t", "peaking", { freq: 2000, q: 1, gain: 6 }), 2000),
    6,
    0.05,
    "a peak of +6 dB",
  );
  near(
    response(biquad("t", "lowshelf", { freq: 200, gain: -9 }), 30),
    -9,
    0.15,
    "a low shelf at −9 dB",
  );
  near(
    response(biquad("t", "highshelf", { freq: 4000, gain: 4 }), 16000),
    4,
    0.15,
    "a high shelf at +4 dB",
  );
  // stereo: each channel keeps its own state
  const lp = biquad("pad", "lowpass", { freq: 500 });
  const st = fill(0.2, (i, c) => (c ? -1 : 1) * Math.sin((2 * Math.PI * 300 * i) / SR));
  lp.run(st);
  for (let i = 0; i < st[0]!.length; i += 101)
    near(st[0]![i]!, -st[1]![i]!, 1e-12, "each channel on its own");
  // above Nyquist the cookbook's filters run away; held under it, it stays put
  const high = biquad("lead", "highshelf", { freq: 40000, gain: 6 });
  const r = rng(3);
  let peak = 0;
  for (let i = 0; i < SR; i++) peak = Math.max(peak, Math.abs(high(2 * r() - 1)));
  assert.ok(peak < 4, `bounded (${peak})`);
  // a NaN coming in stops it, naming the track and the moment
  const bass = biquad("bass", "lowpass", { freq: 300 });
  const sig = seconds(1);
  sig[1234] = Number.NaN;
  assert.throws(
    () => bass.run(sig),
    /biquad "bass" \(lowpass, 300 Hz\): its state became NaN 0\.026 s into channel 0 — its input was NaN/,
  );
  assert.throws(() => biquad("x", "lowpass", { freq: 0 }), /"x": it needs freq > 0/);
});

test("mix places a sound on the sample, mono into every channel, a gain per channel", () => {
  const bus = buffer(1);
  const click = new Float32Array([1, 0.5]);
  assert.equal(mix(bus, click, 0.5, [0.8, 0.2]), bus);
  near(bus[0]![24000]!, 0.8, 1e-6, "on the sample, at its channel's gain");
  near(bus[1]![24001]!, 0.1, 1e-6, "on the sample, at its channel's gain");
  assert.equal(bus[0]![23999], 0);
  mix(bus, click, 0.5);
  near(bus[0]![24000]!, 1.8, 1e-6, "sounds add");
  mix(bus, click, 1 - 1 / SR); // its second sample falls past the end
  assert.equal(bus[0]![SR - 1], 1);
  mix(bus, click, -1 / SR); // its first sample falls before the start
  assert.equal(bus[0]![0], 0.5);
  assert.throws(() => mix(bus, buffer(1, { sampleRate: 44100 })), /44100 Hz into 48000 Hz/);
  assert.throws(() => mix(bus, buffer(1, { channels: 3 })), /3 channels into 2/);
  assert.throws(() => mix(bus, click, Number.NaN), /not a time/);
});

test("rng: mulberry32, the same numbers every run", () => {
  // the reference implementation, as published
  const reference = (seed: number) => {
    let a = seed;
    return () => {
      a += 0x6d2b79f5;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  };
  for (const seed of [0, 1, 42, 123456789]) {
    const a = rng(seed);
    const b = reference(seed);
    for (let i = 0; i < 10000; i++) assert.equal(a(), b(), `seed ${seed}, number ${i}`);
  }
  const r = rng(7);
  let sum = 0;
  for (let i = 0; i < 100000; i++) {
    const v = r();
    assert.ok(v >= 0 && v < 1);
    sum += v;
  }
  near(sum / 100000, 0.5, 0.01, "centred on a half");
});

test("normalize says so when the target cannot be reached, rather than run away", () => {
  // one full-scale sample in a second of silence: nothing to raise but a spike
  const x = new Float32Array(48000);
  x[24000] = 1;
  assert.throws(() => normalize([x], 48000), /cannot reach −16 LUFS/);
});

// ---------------------------------------------------------------- material

const sine = (f: number, secs: number, amp = 0.5, rate = SR) =>
  Float32Array.from(
    { length: Math.round(secs * rate) },
    (_, i) => amp * Math.sin((2 * Math.PI * f * i) / rate),
  );
/** the frequency of a steady tone, by its upward zero crossings */
const freqOf = (x: Float32Array, rate = SR) => {
  const ups: number[] = [];
  for (let i = 1; i < x.length; i++) if (x[i - 1]! < 0 && x[i]! >= 0) ups.push(i);
  return ((ups.length - 1) * rate) / (ups.at(-1)! - ups[0]!);
};
/** 0.1 s of silence, then a 5 ms click of a 2 kHz tone, then silence: 0.3 s */
const click = () => {
  const x = new Float32Array(Math.round(0.3 * SR));
  for (let i = 0; i < 240; i++)
    x[4800 + i] = Math.sin((2 * Math.PI * 2000 * i) / SR) * (1 - i / 240);
  return x;
};

test("load decodes any file ffmpeg reads to the film's rate; mono stays mono", async () => {
  const wav = join(dir, "tone44.wav");
  writeWav(wav, [sine(441, 1, 0.5, 44100)], 44100);
  const mono = load(wav);
  assert.equal(mono.length, 1, "a mono file stays mono");
  assert.equal(mono.sampleRate, SR);
  near(mono[0]!.length, SR, 2, "1 s, at 48 kHz");
  near(freqOf(mono[0]!.subarray(2000, 46000)), 441, 0.5, "the same tone after resampling");
  near(rmsOf(mono[0]!, 2000, 46000), 0.5 / Math.SQRT2, 0.005, "the same level");
  // a compressed stereo file, as a product's sound or a licensed track comes
  const m4a = join(dir, "stereo.m4a");
  const pcm = join(dir, "stereo.f32");
  const l = sine(500, 1);
  const r = sine(1000, 1);
  const inter = new Float32Array(l.length * 2);
  for (let i = 0; i < l.length; i++) {
    inter[2 * i] = l[i]!;
    inter[2 * i + 1] = r[i]!;
  }
  await writeFile(pcm, new Uint8Array(inter.buffer));
  await exec(await resolveFfmpeg(), [
    "-v",
    "error",
    "-y",
    "-f",
    "f32le",
    "-ar",
    "48000",
    "-ac",
    "2",
    "-i",
    pcm,
    "-c:a",
    "aac",
    "-b:a",
    "192k",
    m4a,
  ]);
  const st = load(m4a);
  assert.equal(st.length, 2);
  near(freqOf(st[0]!.subarray(4800, 40000)), 500, 1, "left is left");
  near(freqOf(st[1]!.subarray(4800, 40000)), 1000, 1, "right is right");
  assert.equal(load(m4a, { channels: 1 }).length, 1, "or as many channels as asked");
  assert.throws(() => load(join(dir, "nothing.wav")), /no file/);
  const notSound = join(dir, "not-sound.txt");
  await writeFile(notSound, "hello");
  assert.throws(() => load(notSound), /no sound|could not decode/);
});

test("slice, gentle edges, and where a sound's attack and peak are", () => {
  const c = click();
  const s = slice([c], 0.05, 0.2);
  assert.equal(s[0]!.length, Math.round(0.15 * SR));
  near(onsetOf([c])!, 0.1, 0.0005, "the attack, not the silence before it");
  near(onsetOf(s)!, 0.05, 0.0005, "in the slice, 0.05 s in");
  near(peakOf([c])!, 0.1 + 12 / SR, 0.0003, "the loudest sample");
  assert.equal(onsetOf([new Float32Array(100)]), null, "silence has none");
  assert.equal(peakOf([new Float32Array(100)]), null);
  const f = fadeEdges([new Float32Array(4800).fill(1)], { in: 0.01, out: 0.01 });
  assert.equal(f[0]![0], 0, "starts from nothing");
  near(f[0]![4799]!, 0, 0.001, "ends at nothing");
  assert.equal(f[0]![2400], 1, "the middle untouched");
});

test("play lands a sound's attack or peak on the moment, panned, with automation and a send", () => {
  const bus = buffer(2);
  const c = click();
  const r = play(bus, [c], 1, { align: "onset", pan: -1, gain: 0.5 });
  near(r.start, 0.9, 0.0005, "the click's start, 0.1 s before its attack");
  near(onsetOf([bus[0]!])!, 1, 0.0005, "its attack on the moment");
  near(Math.max(...bus[0]!.map(Math.abs)), 0.5 * peakAbs(c), 1e-3, "all of it left, at the gain");
  assert.ok(Math.max(...bus[1]!.map(Math.abs)) < 1e-6, "nothing right");
  const mid = buffer(2);
  play(mid, [c], 1, { align: "peak", pan: 0 });
  near(peakOf([mid[0]!])!, 1, 1 / SR + 1e-9, "the peak on the moment");
  near(
    Math.max(...mid[0]!.map(Math.abs)),
    peakAbs(c) * Math.SQRT1_2,
    1e-3,
    "equal power: −3 dB a side in the middle",
  );
  const plain = buffer(2);
  play(plain, [c], 0.5);
  near(
    Math.max(...plain[1]!.map(Math.abs)),
    peakAbs(c),
    1e-6,
    "no pan: every channel gets it whole, as mix does",
  );
  // automation: a gain that follows a curve from the events file
  const ev = {
    version: 1 as const,
    duration: 2,
    fps: 10,
    events: [],
    cuts: [],
    curves: {
      names: ["zoom"],
      t0: 0,
      dt: 0.1,
      rows: Array.from({ length: 20 }, (_, i) => [i / 19]),
    },
  };
  const ramp = buffer(2, { channels: 1 });
  const room = space(2, { size: 0.3 });
  play(ramp, [new Float32Array(2 * SR).fill(1)], 0, {
    gain: curveOf(ev, "zoom"),
    send: { bus: room.send, amount: 0.25 },
  });
  near(ramp[0]![Math.round(0.95 * SR)]!, 0.5, 0.01, "half way up the curve");
  near(ramp[0]![Math.round(1.9 * SR)]!, 1, 0.001, "at its top");
  near(room.send[1]![Math.round(0.95 * SR)]!, 0.125, 0.005, "the send: the same, times its amount");
  let steps = 0;
  for (let i = 1; i < ramp[0]!.length; i++)
    if (Math.abs(ramp[0]![i]! - ramp[0]![i - 1]!) > 1e-3) steps++;
  assert.equal(steps, 0, "automation glides: no steps");
  const wet = room.wet();
  assert.ok(wet[0]!.length > room.send[0]!.length, "the room rings past the send");
  // a pan that moves: left to right over the second
  const sweep = buffer(1);
  play(sweep, [new Float32Array(SR).fill(1)], 0, { pan: (t) => 2 * t - 1 });
  near(sweep[0]![100]!, 1, 0.01, "starts left");
  near(sweep[1]![SR - 100]!, 1, 0.01, "ends right");
  near(panFor(0), -1, 1e-12, "the stage's left edge");
  near(panFor(1440, 1920, 0.5), 0.25, 1e-12, "three quarters across, half spread");
  assert.throws(() => play(bus, [c], 0, { gain: () => Number.NaN }), /not a number/);
  // a stereo sound sent into a mono room is refused — and leaves its bus as it was
  const kept = buffer(1);
  assert.throws(
    () => play(kept, [c, c], 0.2, { send: { bus: buffer(1, { channels: 1 }) } }),
    /send bus of 1/,
  );
  assert.equal(peakAbs(kept[0]!), 0, "nothing mixed before the refusal");
  assert.throws(
    () => play(buffer(1, { sampleRate: 44100 }), Object.assign([c], { sampleRate: SR }), 0),
    /Hz/,
  );
});

const peakAbs = (x: Float32Array) => x.reduce((m, v) => Math.max(m, Math.abs(v)), 0);

test("varispeed: faster is higher and shorter, as tape is, and nothing folds back", () => {
  const tone = [sine(1000, 0.5)];
  const up = varispeed(tone, 2);
  near(up[0]!.length, 12000, 1, "half as long");
  near(freqOf(up[0]!.subarray(500, 11500)), 2000, 1, "an octave up");
  near(rmsOf(up[0]!, 500, 11500), 0.5 / Math.SQRT2, 0.005, "as loud");
  const down = varispeed(tone, 0.5);
  near(freqOf(down[0]!.subarray(1000, 47000)), 500, 0.5, "an octave down");
  near(rmsOf(down[0]!, 1000, 47000), 0.5 / Math.SQRT2, 0.005, "as loud");
  // 15 kHz twice as fast would be 30 kHz — past Nyquist; it must not come back as 18 kHz
  const high = varispeed([sine(15000, 0.5)], 2);
  assert.ok(
    db(rmsOf(high[0]!, 500, 11500) / (0.5 / Math.SQRT2)) < -40,
    "what is past Nyquist is filtered out",
  );
  // play's semitones are the same thing
  const bus = buffer(1, { channels: 1 });
  play(bus, tone, 0, { semitones: 12 });
  near(freqOf(bus[0]!.subarray(500, 11500)), 2000, 1, "12 semitones up is an octave");
  assert.throws(() => varispeed(tone, 0), /above 0/);
});

test("crossfade: equal power or linear, and buses by name", () => {
  const a = [new Float32Array(SR).fill(1), new Float32Array(SR).fill(1)];
  const b = [new Float32Array(SR).fill(1), new Float32Array(SR).fill(1)];
  Object.assign(a, { sampleRate: SR });
  Object.assign(b, { sampleRate: SR });
  const p = crossfade(a, b, 0.25, 0.5);
  assert.equal(p[0]![1000], 1, "a before");
  near(p[0]![SR / 2]!, Math.SQRT2, 1e-3, "equal power: in the middle each is at −3 dB");
  assert.equal(p[0]![SR - 1], 1, "b after");
  const l = crossfade(a, b, 0.25, 0.5, { shape: "linear" });
  near(l[0]![SR / 2]!, 1, 1e-6, "linear sums to one");
  const { music, sfx } = buses(2, ["music", "sfx"]);
  assert.equal(music.length, 2);
  assert.equal(sfx[0]!.length, 2 * SR);
});

test("readEvents reads what `film render` writes, and says when a file is not that", async () => {
  const good = join(dir, "x.events.json");
  await writeFile(
    good,
    JSON.stringify({
      version: 1,
      duration: 1,
      fps: 30,
      events: [{ t: 0.5, kind: "click" }],
      cuts: [],
      curves: { names: [], t0: 0, dt: 1 / 30, rows: [] },
    }),
  );
  assert.equal(readEvents(good).events[0]!.kind, "click");
  const bad = join(dir, "y.json");
  await writeFile(bad, JSON.stringify({ hello: 1 }));
  assert.throws(() => readEvents(bad), /not an events file/);
  assert.throws(() => readEvents(join(dir, "none.json")), /none\.json/);
});
