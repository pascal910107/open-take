// @ts-nocheck
// node lib/measure.mjs <film.mp4> [more.mp4 …] [--json out.json]
//
// A film as two curves, one value a frame at 30 a second, and what they say — for holding a draft beside a
// film you admire, on the same ruler. Run it on the reference and on the draft; read the rows side by side.
//
// Picture: the share of pixels that change from one frame to the next (320×180, grey, a change of a tenth of
// the range counts). From that curve: how much of the film stands still, how many moves a minute, how many
// frames a move takes to build and to fall, whether the picture comes to rest between moves or keeps a floor
// of motion, how many cuts and whether they are made while the picture is moving, and how soon the film first
// changes.
//
// Sound: level, the balance of five bands, how pure or textured the tone is (spectral flatness, 200 Hz–8 kHz),
// how wide the stereo is (side against mid), how far the level swings from second to second, onsets a second.
//
// It measures distance from a reference, not quality: a score inside every range can still be the wrong
// music, and films with a still picture have been liked. What it catches is the plainly different — a picture
// that stops dead between every move, a score with no low end, no top, no width.
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { findFfmpeg } from "../kit/audio.mjs";

const FF = findFfmpeg();
const FPS = 30, W = 320, H = 180, SR = 48000, HOP = SR / FPS, N = 4096;
const q = (a, p) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.min(s.length - 1, Math.floor(s.length * p))] : NaN; };
const med = (a) => q(a, 0.5);
const dB = (x) => 10 * Math.log10(x + 1e-12);
const run = (args) => spawnSync(FF, args, { maxBuffer: 2 ** 31 - 1 });

/** The picture's activity curve: for each frame after the first, the share of pixels that changed. */
export function activity(video) {
  const out = run(["-v", "error", "-i", video, "-an", "-vf", `fps=${FPS},scale=${W}:${H},format=gray`, "-f", "rawvideo", "-"]).stdout;
  const size = W * H, frames = Math.floor(out.length / size), a = [];
  for (let f = 1; f < frames; f++) {
    let c = 0;
    for (let i = 0; i < size; i++) if (Math.abs(out[f * size + i] - out[(f - 1) * size + i]) > 25) c++;
    a.push(c / size);
  }
  return a;
}

/** What the activity curve says. Thresholds: under 0.002 a frame is dead, under 0.01 still; a cut is one frame
 *  where 45% of the picture changes and its neighbours do not; a move is a peak of the 3-frame median above
 *  max(0.04, 2.5 × the film's median), eight frames clear of a higher one. */
export function readPicture(a) {
  const n = a.length, m = med(a);
  const cuts = [];
  for (let i = 1; i < n - 1; i++) if (a[i] >= 0.45 && a[i - 1] < a[i] * 0.6 && a[i + 1] < a[i] * 0.6) cuts.push(i);
  const isCut = new Set(cuts);
  const b = a.map((v, i) => (isCut.has(i) ? (a[i - 1] + a[i + 1]) / 2 : v));
  const sm = b.map((_, i) => med(b.slice(Math.max(0, i - 1), i + 2)));
  const thr = Math.max(0.04, 2.5 * m), peaks = [];
  for (let i = 2; i < n - 2; i++) {
    if (sm[i] < thr) continue;
    let top = true;
    for (let k = -8; k <= 8; k++) if (k && sm[i + k] !== undefined && (sm[i + k] > sm[i] || (sm[i + k] === sm[i] && k < 0))) top = false;
    if (top) peaks.push(i);
  }
  const rise = [], fall = [], floors = [];
  peaks.forEach((p, k) => {
    let i = p; while (i > 0 && sm[i] > sm[p] * 0.25) i--; rise.push(p - i);
    let j = p; while (j < n - 1 && sm[j] > sm[p] * 0.25) j++; fall.push(j - p);
    if (k < peaks.length - 1) floors.push(Math.min(...sm.slice(p, peaks[k + 1] + 1)) / ((sm[p] + sm[peaks[k + 1]]) / 2));
  });
  const p75 = q(a, 0.75);
  let dead = 0, longest = 0;
  for (const v of a) { if (v < 0.002) longest = Math.max(longest, ++dead); else dead = 0; }
  const first = Math.min(cuts[0] ?? Infinity, peaks[0] ?? Infinity);
  const minutes = n / FPS / 60;
  return {
    seconds: +(n / FPS).toFixed(1),
    deadPct: +(100 * a.filter((v) => v < 0.002).length / n).toFixed(1),
    stillPct: +(100 * a.filter((v) => v < 0.01).length / n).toFixed(1),
    median: +m.toFixed(4),
    longestDeadFrames: longest,
    movesPerMin: +(peaks.length / minutes).toFixed(1),
    riseFrames: med(rise), fallFrames: med(fall),
    restBetweenMovesPct: floors.length ? Math.round(100 * floors.filter((v) => v < 0.02).length / floors.length) : null,
    floor: floors.length ? +med(floors).toFixed(2) : null,
    cutsPerMin: +(cuts.length / minutes).toFixed(1),
    cutsWhileMovingPct: cuts.length ? Math.round(100 * cuts.filter((c) => med(b.slice(Math.max(0, c - 4), c)) >= p75).length / cuts.length) : null,
    firstChangeS: Number.isFinite(first) ? +(first / FPS).toFixed(2) : null,
  };
}

function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) { let b = n >> 1; for (; j & b; b >>= 1) j ^= b; j ^= b; if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; } }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len, wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const x = i + k + len / 2, vr = re[x] * cr - im[x] * ci, vi = re[x] * ci + im[x] * cr;
        re[x] = re[i + k] - vr; im[x] = im[i + k] - vi; re[i + k] += vr; im[i + k] += vi;
        const t = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = t;
      }
    }
  }
}
const BANDS = [["sub", 20, 60], ["low", 60, 250], ["mid", 250, 2000], ["high", 2000, 8000], ["air", 8000, 20000]];
const WIN = Float32Array.from({ length: N }, (_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N));

/** What the soundtrack measures as. Bands are dB against the whole; width is side against mid, dB. */
export function readSound(video) {
  const raw = run(["-v", "error", "-i", video, "-vn", "-ac", "2", "-ar", String(SR), "-f", "f32le", "-"]).stdout;
  if (!raw || raw.length < N * 8) return null;
  const x = new Float32Array(raw.buffer, raw.byteOffset, raw.byteLength >> 2), len = x.length >> 1;
  const sum = (run(["-hide_banner", "-nostats", "-i", video, "-vn", "-af", "ebur128", "-f", "null", "-"]).stderr?.toString() ?? "").split("Summary:")[1] ?? "";
  const lufs = /I:\s+(-?[\d.]+) LUFS/.exec(sum);
  const F = Math.floor((len - N) / HOP), band = BANDS.map(() => 0), flat = [], flux = [], lvl = [];
  let mid = 0, side = 0, tot = 0, prev = null;
  for (let f = 0; f < F; f++) {
    const re = new Float32Array(N), im = new Float32Array(N); let e = 0;
    for (let i = 0; i < N; i++) { const l = x[2 * (f * HOP + i)], r = x[2 * (f * HOP + i) + 1], mm = (l + r) / 2, s = (l - r) / 2; mid += mm * mm; side += s * s; re[i] = mm * WIN[i]; e += mm * mm; }
    fft(re, im);
    const mag = new Float32Array(N / 2);
    for (let k = 0; k < N / 2; k++) mag[k] = re[k] * re[k] + im[k] * im[k];
    BANDS.forEach(([, lo, hi], bi) => { let s = 0; for (let k = Math.ceil((lo * N) / SR); k < (hi * N) / SR; k++) s += mag[k]; band[bi] += s; tot += s; });
    let gl = 0, ar = 0, c = 0;
    for (let k = Math.ceil((200 * N) / SR); k < (8000 * N) / SR; k++) { gl += Math.log(mag[k] + 1e-20); ar += mag[k]; c++; }
    flat.push(Math.exp(gl / c) / (ar / c + 1e-20));
    let fl = 0;
    if (prev) for (let k = 2; k < N / 2; k++) { const d = Math.log1p(1000 * Math.sqrt(mag[k])) - Math.log1p(1000 * Math.sqrt(prev[k])); if (d > 0) fl += d; }
    flux.push(fl); prev = mag; lvl.push(dB(e / N));
  }
  let onsets = 0;
  const fm = med(flux);
  for (let f = 3; f < F - 3; f++) {
    const loc = med(flux.slice(Math.max(0, f - 15), f + 15));
    if (flux[f] > loc * 1.6 + fm * 0.3 && flux[f] >= flux[f - 1] && flux[f] > flux[f + 1] && flux[f] >= flux[f - 2] && flux[f] > flux[f + 2]) onsets++;
  }
  const sec = [];
  for (let f = 0; f + FPS <= F; f += FPS) sec.push(dB(lvl.slice(f, f + FPS).reduce((s, v) => s + 10 ** (v / 10), 0) / FPS));
  const r = { lufs: lufs ? +lufs[1] : null, swingDb: +(q(sec, 0.95) - q(sec, 0.1)).toFixed(1) };
  BANDS.forEach(([name], bi) => {
    r[name] = +dB(band[bi] / tot).toFixed(1);
  });
  return { ...r, flatness: +med(flat).toFixed(4), widthDb: +dB(side / (mid + 1e-12)).toFixed(1), onsetsPerS: +(onsets / (F / FPS)).toFixed(1) };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2), ji = args.indexOf("--json"), json = ji >= 0 ? args.splice(ji, 2)[1] : null;
  if (!args.length) { console.error("node lib/measure.mjs <film.mp4> [more.mp4 …] [--json out.json]"); process.exit(1); }
  const rows = args.map((video) => ({ film: video, picture: readPicture(activity(video)), sound: readSound(video) }));
  for (const part of ["picture", "sound"]) {
    const keys = Object.keys(rows.find((r) => r[part])?.[part] ?? {});
    if (!keys.length) continue;
    console.log(`\n${part}`);
    console.log(["film", ...keys].join("\t"));
    for (const r of rows) console.log([r.film, ...keys.map((k) => r[part]?.[k] ?? "")].join("\t"));
  }
  if (json) writeFileSync(json, JSON.stringify(rows, null, 1));
}
