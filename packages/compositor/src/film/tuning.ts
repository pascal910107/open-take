// How in tune a film's pitched sound is: in each register, the strongest
// partial of each frame, how far it sits from the nearest semitone of the
// piece's own tuning (fitted on the whole sound, so a piece tuned a little
// off A440 throughout is in tune with itself). A sound whose notes mostly sit
// between semitones, or bend through them, is heard as out of tune even when
// every note was written right. Information only.

import { LISTEN_RATE, makeFft } from "./beats";

export type Register = {
  name: string;
  lo: number;
  hi: number;
  /** frames where a pitched sound led this register */
  frames: number;
  /** the share of those within 15 cents of the piece's tuning */
  inTune: number;
  /** their median distance from it, cents (signed: below is flat) */
  offset: number;
};

export type Tuning = {
  /** the piece's tuning against A440, cents (null: nothing pitched) */
  reference: number | null;
  registers: Register[];
};

const N = 8192; // 0.37 s: 2.7 Hz a bin
const HOP = 1024; // 46 ms
const REGISTERS: [string, number, number][] = [
  ["low", 80, 400],
  ["middle", 400, 1600],
];

/** cents from the nearest semitone of A440, −50..50 */
const dev = (hz: number) => {
  const c = 1200 * Math.log2(hz / 440);
  return ((((c + 50) % 100) + 100) % 100) - 50;
};
const wrap = (c: number) => ((((c + 50) % 100) + 100) % 100) - 50;

export function tuning(pcm: Float32Array, rate = LISTEN_RATE): Tuning {
  const fft = makeFft(N);
  const hann = new Float64Array(N);
  for (let i = 0; i < N; i++) hann[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N);
  const re = new Float64Array(N);
  const im = new Float64Array(N);
  const binHz = rate / N;
  // per register, per frame: the strongest peak's frequency, or null
  const tracks = REGISTERS.map(() => [] as (number | null)[]);
  for (let at = 0; at + N <= pcm.length; at += HOP) {
    let sq = 0;
    for (let i = 0; i < N; i++) {
      const v = pcm[at + i]!;
      re[i] = v * hann[i]!;
      im[i] = 0;
      sq += v * v;
    }
    const quiet = 10 * Math.log10(sq / N + 1e-12) < -45;
    fft(re, im);
    // the two strongest peaks from 40 to 400 Hz, whether or not they stand clear: the
    // notes (a frame can hold the end of one and the start of the next) a higher
    // register's peak may be a harmonic of
    const mag = (k: number) => Math.hypot(re[k]!, im[k]!);
    const lows: number[] = [];
    for (let k = Math.ceil(40 / binHz); k <= Math.floor(400 / binHz); k++)
      if (mag(k) >= mag(k - 1) && mag(k) >= mag(k + 1)) lows.push(k);
    lows.sort((x, y) => mag(y) - mag(x));
    const lowest = quiet ? [] : lows.slice(0, 2).map((k) => k * binHz);
    register: for (const [r, [, lo, hi]] of REGISTERS.entries()) {
      if (quiet) {
        tracks[r]!.push(null);
        continue;
      }
      const k0 = Math.max(2, Math.ceil(lo / binHz));
      const k1 = Math.min(N / 2 - 2, Math.floor(hi / binHz));
      const db = (k: number) => 20 * Math.log10(Math.hypot(re[k]!, im[k]!) + 1e-12);
      let best = -1;
      let bestDb = -Infinity;
      const all: number[] = [];
      for (let k = k0; k <= k1; k++) {
        const d = db(k);
        all.push(d);
        if (d > bestDb && d >= db(k - 1) && d >= db(k + 1)) {
          bestDb = d;
          best = k;
        }
      }
      all.sort((a, b) => a - b);
      // a peak standing well above the register's floor: a pitched sound, not noise
      if (best < 0 || bestDb - all[all.length >> 1]! < 20) {
        tracks[r]!.push(null);
        continue;
      }
      const a = db(best - 1);
      const c = db(best + 1);
      const f = (best + (0.5 * (a - c)) / (a - 2 * bestDb + c || 1)) * binHz;
      // a higher register's strongest peak may be a harmonic of the note below it (a saw
      // bass's 7th sits −31 cents from the scale): that frame says nothing of its tuning
      const below = r > 0 ? lowest : [];
      // (the peak below may itself be the 2nd or 3rd harmonic of a note lower still)
      for (const b of below)
        for (let m = 1; m <= 3; m++) {
          const ratio = (f * m) / b;
          const h = Math.round(ratio);
          if (h >= 2 && h <= 12 && Math.abs(ratio / h - 1) <= 0.015) {
            tracks[r]!.push(null);
            continue register;
          }
        }
      tracks[r]!.push(f);
    }
  }
  // the piece's tuning: the circular mean of every frame's distance from A440's semitones
  let sx = 0;
  let sy = 0;
  for (const t of tracks)
    for (const f of t)
      if (f) {
        const ang = (dev(f) / 100) * 2 * Math.PI;
        sx += Math.cos(ang);
        sy += Math.sin(ang);
      }
  if (!sx && !sy) return { reference: null, registers: [] };
  const reference = Math.round((Math.atan2(sy, sx) / (2 * Math.PI)) * 100);
  const registers = REGISTERS.map(([name, lo, hi], r) => {
    const ds = tracks[r]!.filter((f) => f != null).map((f) => wrap(dev(f) - reference));
    const sorted = [...ds].sort((a, b) => a - b);
    return {
      name,
      lo,
      hi,
      frames: ds.length,
      inTune: ds.length
        ? Math.round((ds.filter((d) => Math.abs(d) <= 15).length / ds.length) * 100) / 100
        : 0,
      offset: sorted.length ? Math.round(sorted[sorted.length >> 1]!) : 0,
    };
  });
  return { reference, registers };
}

export function formatTuning(t: Tuning): string[] {
  if (t.reference == null) return ["- tuning: nothing pitched stood out (not detected)"];
  const L = [
    `- tuning: the piece sits ${t.reference >= 0 ? "+" : ""}${t.reference} cents from A440 (estimated)`,
  ];
  for (const r of t.registers)
    L.push(
      r.frames < 20
        ? `- ${r.name} register (${r.lo}–${r.hi} Hz): too little pitched sound to read (not detected)`
        : `- ${r.name} register (${r.lo}–${r.hi} Hz): ${Math.round(r.inTune * 100)}% of its pitched frames within 15 cents of the piece's tuning (median ${r.offset >= 0 ? "+" : ""}${r.offset}) (estimated)`,
    );
  return L;
}
