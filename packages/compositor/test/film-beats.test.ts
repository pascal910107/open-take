// `film beats`: the grid built here on sound with known answers — a track
// whose hats between the beats are louder up top than the beats (the grid
// half a beat late is the trap), chords that change on the bar, a riser into
// a drop — then the whole command on a file, the real tracks it was checked
// on when they are on this machine, and `film listen`'s lines beside earlier
// films.

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { resolveFfmpeg, runTool } from "../src/ffmpeg";
import {
  analyzeBeats,
  chromagram,
  decodeMono,
  estimateKey,
  type FilmBeats,
  filmBeats,
  formatFilmBeats,
  LISTEN_RATE,
} from "../src/film/beats";
import { formatFilmListen } from "../src/film/listen";

const R = LISTEN_RATE;

/** a seeded noise source, so every run is the same sound */
function noise(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 2 ** 31 - 1;
  };
}

/** a kick at t: a sine falling from 150 Hz to 50 Hz, 150 ms */
function kick(x: Float32Array, t: number, amp = 0.8) {
  const a = Math.round(t * R);
  let ph = 0;
  for (let i = 0; i < R * 0.15 && a + i < x.length; i++) {
    const hz = 50 + 100 * Math.exp(-i / (R * 0.02));
    ph += (2 * Math.PI * hz) / R;
    x[a + i] = x[a + i]! + amp * Math.exp(-i / (R * 0.05)) * Math.sin(ph);
  }
}

/** a hat at t: noise through a crude high-pass (a difference), 40 ms */
function hat(x: Float32Array, t: number, amp: number, rnd: () => number) {
  const a = Math.round(t * R);
  let prev = 0;
  for (let i = 0; i < R * 0.04 && a + i < x.length; i++) {
    const n = rnd();
    x[a + i] = x[a + i]! + amp * Math.exp(-i / (R * 0.01)) * (n - prev);
    prev = n;
  }
}

/** a snare at t: noise and a 180 Hz body, 120 ms, mostly in the mids */
function snare(x: Float32Array, t: number, amp: number, rnd: () => number) {
  const a = Math.round(t * R);
  let lp = 0;
  for (let i = 0; i < R * 0.12 && a + i < x.length; i++) {
    lp += 0.3 * (rnd() - lp);
    const env = Math.exp(-i / (R * 0.03));
    x[a + i] = x[a + i]! + amp * env * (0.6 * lp + 0.4 * Math.sin((2 * Math.PI * 180 * i) / R));
  }
}

/** a chord held over [a, b): three sines */
function chord(x: Float32Array, a: number, b: number, hz: number[], amp: number) {
  for (let i = Math.round(a * R); i < Math.min(x.length, Math.round(b * R)); i++) {
    const u = i / R - a;
    const env = Math.min(1, u / 0.01, (b - i / R) / 0.01);
    for (const f of hz)
      x[i] = x[i]! + (amp / hz.length) * env * Math.sin(2 * Math.PI * f * (i / R));
  }
}

const A_MINOR = [220, 261.63, 329.63];
const F_MAJOR = [174.61, 220, 261.63];
const C_MAJOR = [261.63, 329.63, 392];
const G_MAJOR = [196, 246.94, 293.66];

/** `bars` bars at `bpm` from `t0`: a kick on 1 and 3, a snare on 2 and 4,
 *  loud open hats on every "and", a chord that changes each bar (Am F C G);
 *  returns the true beats */
function groove(bpm: number, t0: number, bars: number, seconds: number) {
  const pcm = new Float32Array(Math.round(seconds * R));
  const rnd = noise(7);
  const beat = 60 / bpm;
  const beats: number[] = [];
  const downbeats: number[] = [];
  const chords = [A_MINOR, F_MAJOR, C_MAJOR, G_MAJOR];
  for (let bar = 0; bar < bars; bar++) {
    const b0 = t0 + bar * 4 * beat;
    downbeats.push(b0);
    chord(pcm, b0, b0 + 4 * beat, chords[bar % 4]!, 0.12);
    for (let k = 0; k < 4; k++) {
      const t = b0 + k * beat;
      beats.push(t);
      if (k % 2 === 0) kick(pcm, t);
      else snare(pcm, t, 0.5, rnd);
      // the hats between the beats: louder than anything up top on the beat
      hat(pcm, t + beat / 2, 0.9, rnd);
    }
  }
  return { pcm, beats, downbeats };
}

const within = (got: number[], want: number[], tol: number) =>
  want.filter((t) => got.some((g) => Math.abs(g - t) <= tol)).length / want.length;

test("the beat is where the kick lands, not the louder hats between, and stays on it to the end", () => {
  const { pcm, beats, downbeats } = groove(128, 0.31, 40, 76);
  const b = analyzeBeats(pcm, "groove");
  assert.equal(b.tempo.label, "estimated");
  assert.ok(Math.abs(b.tempo.bpm! - 128) <= 0.1, `tempo ${b.tempo.bpm}`);
  // every true beat has an estimated one within 10 ms — first bar to last
  assert.ok(within(b.beats, beats, 0.01) >= 0.98, "the beats sit on the kicks' grid");
  const lastTrue = beats[beats.length - 1]!;
  const lastNear = b.beats.reduce((a, t) =>
    Math.abs(t - lastTrue) < Math.abs(a - lastTrue) ? t : a,
  );
  assert.ok(Math.abs(lastNear - lastTrue) <= 0.01, `no drift: ${lastNear} vs ${lastTrue}`);
  // none half a beat over (where the hats are)
  const half = beats.map((t) => t + 30 / 128);
  assert.ok(within(b.beats, half, 0.03) === 0, "no beat on the hats");
  assert.ok(b.tempo.confidence > 0.5, `confidence ${b.tempo.confidence}`);
  // the chord changes on the bar: the downbeats are the bar lines
  assert.equal(b.meter.beatsPerBar, 4);
  assert.equal(b.labels.downbeats, "estimated");
  assert.ok(within(b.downbeats, downbeats, 0.01) >= 0.95, `downbeats ${b.downbeats.slice(0, 4)}`);
  assert.ok(b.meter.confidence > 0.5, `downbeat confidence ${b.meter.confidence}`);
  assert.deepEqual(
    b.bars.slice(0, 3).map((x) => x.index),
    [0, 1, 2],
  );
  assert.ok(Math.abs(b.bars[1]!.t - b.downbeats[1]!) < 1e-9);
});

test("a riser into a full groove is a drop, on the bar line; the riser bar itself is not", () => {
  const seconds = 40;
  const pcm = new Float32Array(seconds * R);
  const rnd = noise(3);
  const chords = [A_MINOR, F_MAJOR, C_MAJOR, G_MAJOR];
  // bars 0–7: chords and soft hats; bar 7 a noise riser; bars 8–: kicks and bass
  for (let bar = 0; bar < 20; bar++) {
    const b0 = bar * 2;
    chord(pcm, b0, b0 + 2, chords[bar % 4]!, 0.1);
    for (let k = 0; k < 4; k++) {
      hat(pcm, b0 + k * 0.5, 0.15, rnd);
      if (bar >= 8) {
        kick(pcm, b0 + k * 0.5, 0.9);
        chord(pcm, b0 + k * 0.5, b0 + k * 0.5 + 0.4, [55], 0.35);
      }
    }
    if (bar === 7)
      for (let i = 0; i < 2 * R; i++) {
        const u = i / (2 * R);
        let prev = 0;
        const n = rnd();
        pcm[b0 * R + i] = pcm[b0 * R + i]! + 0.5 * u ** 2 * (n - prev);
        prev = n;
      }
  }
  const b = analyzeBeats(pcm, "drop");
  assert.equal(b.labels.drops, "estimated");
  assert.ok(
    b.drops.some((d) => Math.abs(d - 16) <= 0.05),
    `a drop at 16 s: ${b.drops}`,
  );
  assert.ok(!b.drops.some((d) => Math.abs(d - 14) <= 0.3), "not on the riser");
  const s = b.sections.find((x) => Math.abs(x.t - 16) <= 0.5);
  assert.equal(s?.label, "drop", "the section opening at the drop says so");
  assert.ok(s!.energy > b.sections[0]!.energy, "and has more energy than the start");
});

test("silence: nothing detected, said so", () => {
  const b = analyzeBeats(new Float32Array(R * 8), "silence");
  assert.equal(b.tempo.bpm, null);
  assert.equal(b.tempo.label, "not detected");
  assert.deepEqual(b.beats, []);
  assert.deepEqual(b.downbeats, []);
  assert.deepEqual(b.drops, []);
  assert.equal(b.labels.onsets, "not detected");
  assert.equal(b.labels.downbeats, "not detected");
  assert.equal(b.meter.label, "not detected");
  assert.match(formatFilmBeats(b), /no repeating period.*\(not detected\)/);
});

test("a track that starts on its beat keeps that beat: bar 0 is at 0", () => {
  const { pcm, beats } = groove(128, 0, 20, 38);
  const b = analyzeBeats(pcm, "from zero");
  assert.equal(b.beats[0], 0);
  assert.equal(b.downbeats[0], 0);
  assert.ok(within(b.beats, beats, 0.01) === 1, "every beat, the first one too");
});

test("a waltz: bars of three, on the bar lines", () => {
  // a kick on 1, a light snare on 2 and 3, hats between, the chord changing each bar
  const bpm = 120;
  const beat = 60 / bpm;
  const pcm = new Float32Array(R * 40);
  const rnd = noise(3);
  const chords = [A_MINOR, F_MAJOR, C_MAJOR, G_MAJOR];
  const downbeats: number[] = [];
  for (let bar = 0; 0.3 + (bar + 1) * 3 * beat <= 40; bar++) {
    const b0 = 0.3 + bar * 3 * beat;
    downbeats.push(b0);
    chord(pcm, b0, b0 + 3 * beat, chords[bar % 4]!, 0.12);
    for (let k = 0; k < 3; k++) {
      const t = b0 + k * beat;
      if (k === 0) kick(pcm, t);
      else snare(pcm, t, 0.25, rnd);
      hat(pcm, t + beat / 2, 0.4, rnd);
    }
  }
  const b = analyzeBeats(pcm, "waltz");
  assert.ok(Math.abs(b.tempo.bpm! - bpm) <= 0.1, `tempo ${b.tempo.bpm}`);
  assert.equal(b.meter.beatsPerBar, 3);
  assert.ok(within(b.downbeats, downbeats, 0.02) >= 0.95, `downbeats ${b.downbeats.slice(0, 4)}`);
  // and the four-beat groove still reads as four
  assert.equal(analyzeBeats(groove(100, 0.2, 16, 40).pcm, "four").meter.beatsPerBar, 4);
});

test("the key of a held A minor triad, and C major", () => {
  const pcm = new Float32Array(R * 6);
  chord(pcm, 0, 6, [110, ...A_MINOR], 0.4);
  assert.match(estimateKey(chromagram(pcm))!.name, /^(A minor|C major)$/);
  const c = new Float32Array(R * 8);
  chord(c, 0, 2, C_MAJOR, 0.4);
  chord(c, 2, 4, F_MAJOR, 0.4);
  chord(c, 4, 6, G_MAJOR, 0.4);
  chord(c, 6, 8, C_MAJOR, 0.4);
  assert.equal(estimateKey(chromagram(c))!.name, "C major");
  assert.equal(estimateKey(chromagram(new Float32Array(R * 2))), null);
});

let dir = "";
before(async () => {
  dir = await mkdtemp(join(tmpdir(), "open-take-beats-"));
});
after(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});

test("film beats on a file: <name>.beats.json in the shared shape", async () => {
  const { pcm } = groove(100, 0.2, 10, 25);
  const raw = join(dir, "click.f32");
  await writeFile(raw, Buffer.from(pcm.buffer));
  const wav = join(dir, "click.wav");
  await runTool(await resolveFfmpeg(), [
    "-v",
    "error",
    "-f",
    "f32le",
    "-ar",
    String(R),
    "-ac",
    "1",
    "-i",
    raw,
    "-ar",
    "48000",
    "-ac",
    "2",
    "-y",
    wav,
  ]);
  const r = await filmBeats({ input: wav });
  assert.equal(r.out, join(dir, "click.beats.json"));
  const j = JSON.parse(await readFile(r.out, "utf8")) as FilmBeats;
  assert.equal(j.version, 1);
  assert.equal(j.source, wav);
  assert.ok(Math.abs(j.duration - 25) < 0.05);
  for (const k of ["bpm", "confidence", "label"]) assert.ok(k in j.tempo, k);
  for (const k of ["beats", "downbeats", "bars", "sections", "drops", "onsets"] as const)
    assert.ok(Array.isArray(j[k]), k);
  for (const s of j.sections) for (const k of ["t", "end", "energy"]) assert.ok(k in s, k);
  for (const k of ["tempo", "beats", "downbeats", "bars", "sections", "drops", "onsets"])
    assert.match(
      String((j.labels as Record<string, string>)[k]),
      /^(measured|estimated|not detected)$/,
    );
  assert.ok(Math.abs(j.tempo.bpm! - 100) <= 0.2, `tempo ${j.tempo.bpm}`);
  await assert.rejects(filmBeats({ input: join(dir, "nope.wav") }), /no file/);
});

// --- the real tracks it was checked on, when this machine has them -----------------------

const S2 = "/Users/pascal/projects/open-take/out/direction/step1b/s2";
const VOXEL = `${S2}/n04/Voxel Revolution.mp3`;
const LEMONADE = `${S2}/m01/Digital Lemonade.mp3`;
const FRAMER = "/Users/pascal/film-trials/_ref-framer/framer.mp4";
const read = async (f: string) => analyzeBeats(await decodeMono(await resolveFfmpeg(), f), f);

test("Voxel Revolution: 122 BPM on the kick — not half a beat late on the off-beat hats", {
  skip: !existsSync(VOXEL) && "the track is not on this machine",
}, async () => {
  const b = await read(VOXEL);
  assert.ok(Math.abs(b.tempo.bpm! - 122) <= 0.1, `tempo ${b.tempo.bpm}`);
  // by hand (on a copy slowed to 120 BPM): bar lines at 0.015 + 1.9999·n s —
  // here 0.0148 + 1.96718·n — kicks at 2.017, 16.013, 74.012, 80.010, 122.012
  const bar = 1.9999 * 0.983651;
  for (const kickAt of [2.017, 16.013, 74.012, 80.01, 122.012]) {
    const t = kickAt * 0.983651;
    assert.ok(
      b.beats.some((x) => Math.abs(x - t) <= 0.015),
      `a beat on the kick at ${t.toFixed(3)}`,
    );
  }
  for (let n = 0; n < 60; n += 7) {
    const t = 0.0148 + n * bar;
    assert.ok(
      b.downbeats.some((x) => Math.abs(x - t) <= 0.015),
      `bar line ${n} at ${t.toFixed(3)}`,
    );
  }
  // the build's riser lands on source bars 8 and 40 (16.0 and 80.0 s slowed)
  for (const t of [16 * 0.983651, 80 * 0.983651])
    assert.ok(
      b.drops.some((d) => Math.abs(d - t) <= 0.05),
      `a drop at ${t.toFixed(2)}: ${b.drops}`,
    );
});

test("Digital Lemonade: 120 BPM, bar lines at 0.024 + 2n, the full groove and the landing as drops", {
  skip: !existsSync(LEMONADE) && "the track is not on this machine",
}, async () => {
  const b = await read(LEMONADE);
  assert.ok(Math.abs(b.tempo.bpm! - 120) <= 0.05, `tempo ${b.tempo.bpm}`);
  for (const t of [16.024, 46.024, 140.024, 144.024, 174.024])
    assert.ok(
      b.downbeats.some((x) => Math.abs(x - t) <= 0.015),
      `bar line at ${t}`,
    );
  for (const t of [16.024, 144.024])
    assert.ok(
      b.drops.some((d) => Math.abs(d - t) <= 0.05),
      `a drop at ${t}: ${b.drops}`,
    );
});

test("the Framer launch film's sound: a grid, labelled an estimate", {
  skip: !existsSync(FRAMER) && "the film is not on this machine",
}, async () => {
  const b = await read(FRAMER);
  assert.equal(b.tempo.label, "estimated");
  assert.ok(Math.abs(b.tempo.bpm! - 126) <= 1, `tempo ${b.tempo.bpm}`);
  assert.equal(b.labels.downbeats, "estimated");
});

// --- film listen beside earlier films ----------------------------------------------------

test("listen's text: nothing about earlier films, and that timbre is not measured", () => {
  const md = formatFilmListen({
    input: "/x/new/film.mp4",
    duration: 10,
    sampleRate: 48000,
    channels: 2,
    loudness: {
      how: "not detected",
      integratedLufs: null,
      lra: null,
      truePeakDb: null,
      momentary: [],
    },
    onsets: { how: "not detected", times: [], perS: 0 },
    tempo: { how: "not detected", value: null },
    sections: { how: "estimated", list: [] },
    bars: { how: "not measured", value: null },
    silences: { how: "measured", list: [] },
    dips: { how: "measured", list: [] },
    events: { how: "not measured", file: null, list: [], unvoiced: [], chance40: 0 },
    cuts: { how: "not measured", source: "none", list: [] },
    stems: { how: "not measured", dir: null, list: [], laneS: 0.05, eventWindows: [] },
    curves: { names: [], t0: 0, dt: 1 / 60, rows: [] },
    picture: { how: "not measured", source: "none", energy: null, halves: [], against: null },
    clips: [],
    timbre: { how: "not measured" },
  });
  // how earlier trial films sounded is research-side; a film being made never sees it
  assert.doesNotMatch(md, /earlier/i);
  assert.match(md, /## What it sounds like\n\n- .*nothing here hears timbre \(not measured\)/);
});
