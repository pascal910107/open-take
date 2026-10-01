// `open-take film check`: what a finished film can be measured for without
// eyes or ears — the defects its author cannot perceive, reported with times.
//
// Picture: the format, frames that freeze for one frame while everything around
// them moves (a dropped or repeated frame), runs of alternating still/moving
// frames (a lower-rate cadence showing through), hard cuts, black frames.
// Sound: loudness (integrated, range, true peak), silences, and clicks — single-
// sample jumps the waveform around them does not explain (a cut envelope, a
// splice). Nothing here judges taste; every finding is a time to go and look at.

import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveFfmpeg, resolveFfprobe } from "../ffmpeg";

export type FilmCheckIssue = { severity: "error" | "warn" | "info"; message: string };

export type FilmCheck = {
  file: string;
  durationS: number;
  video: {
    codec: string;
    profile: string | null;
    width: number;
    height: number;
    fps: number;
    pixFmt: string;
    frames: number;
  } | null;
  audio: {
    codec: string;
    sampleRate: number;
    channels: number;
    /** integrated loudness, LUFS */
    lufs: number | null;
    /** loudness range, LU */
    lra: number | null;
    /** true peak, dBFS */
    truePeak: number | null;
  } | null;
  /** seconds where one frame repeats inside motion */
  stalls: number[];
  /** runs of alternating still/moving frames: where they start and how many frames */
  cadence: { at: number; frames: number }[];
  /** seconds of hard cuts */
  cuts: number[];
  black: { start: number; end: number }[];
  silences: { start: number; end: number }[];
  /** seconds of isolated sample jumps */
  clicks: number[];
  issues: FilmCheckIssue[];
};

export type FilmCheckExpect = { width?: number; height?: number; fps?: number; audio?: boolean };

export async function checkFilm(file: string, expect: FilmCheckExpect = {}): Promise<FilmCheck> {
  const [ffmpeg, ffprobe] = await Promise.all([resolveFfmpeg(), resolveFfprobe()]);
  const probe = JSON.parse(
    await capture(ffprobe, ["-v", "error", "-show_streams", "-show_format", "-of", "json", file]),
  ) as {
    streams?: Record<string, string | number | undefined>[];
    format?: { duration?: string };
  };
  const vs = probe.streams?.find((s) => s.codec_type === "video");
  const as = probe.streams?.find((s) => s.codec_type === "audio");
  const durationS = Number(probe.format?.duration ?? 0);
  const rate = (r: unknown) => {
    const [n, d] = String(r ?? "0/1")
      .split("/")
      .map(Number);
    return d ? n! / d : 0;
  };
  const video = vs
    ? {
        codec: String(vs.codec_name),
        profile: vs.profile ? String(vs.profile) : null,
        width: Number(vs.width),
        height: Number(vs.height),
        fps: Math.round(rate(vs.avg_frame_rate) * 1000) / 1000,
        pixFmt: String(vs.pix_fmt),
        frames: Number(vs.nb_frames ?? 0),
      }
    : null;

  const tmp = await mkdtemp(join(tmpdir(), "open-take-check-"));
  try {
    const result: FilmCheck = {
      file,
      durationS,
      video,
      audio: null,
      stalls: [],
      cadence: [],
      cuts: [],
      black: [],
      silences: [],
      clicks: [],
      issues: [],
    };
    if (video) {
      const diffFile = join(tmp, "diff.txt");
      const log = await capture(
        ffmpeg,
        [
          "-nostats",
          "-v",
          "info",
          "-i",
          file,
          // one decode, two readings: frame-to-frame change (small, grey) and black frames
          "-filter_complex",
          `[0:v]split[m][b];[m]scale=320:-2,format=gray,tblend=all_mode=difference,signalstats,metadata=print:key=lavfi.signalstats.YAVG:file=${diffFile.replace(/[\\:']/g, "\\$&")}[mo];[b]blackdetect=d=0.1:pix_th=0.06[bo]`,
          "-map",
          "[mo]",
          "-f",
          "null",
          "-",
          "-map",
          "[bo]",
          "-f",
          "null",
          "-",
        ],
        true,
      );
      const diffs = [
        ...(await readFile(diffFile, "utf8")).matchAll(/YAVG=([-+]?[\d.]+(?:[eE][-+]?\d+)?)/g),
      ].map((m) => Number(m[1]));
      Object.assign(result, motionFindings(diffs, video.fps || 60));
      for (const m of log.matchAll(/black_start:([\d.]+) black_end:([\d.]+)/g))
        result.black.push({ start: Number(m[1]), end: Number(m[2]) });
    }
    if (as) {
      const log = await capture(
        ffmpeg,
        [
          "-nostats",
          "-v",
          "info",
          "-i",
          file,
          "-vn",
          "-af",
          "ebur128=peak=true,silencedetect=n=-45dB:d=0.4",
          "-f",
          "null",
          "-",
        ],
        true,
      );
      const summary = log.slice(log.lastIndexOf("Summary:"));
      const num = (re: RegExp) => {
        const m = re.exec(summary);
        return m ? Number(m[1]) : null;
      };
      result.audio = {
        codec: String(as.codec_name),
        sampleRate: Number(as.sample_rate),
        channels: Number(as.channels),
        lufs: num(/I:\s+(-?[\d.]+) LUFS/),
        lra: num(/LRA:\s+(-?[\d.]+) LU/),
        truePeak: num(/Peak:\s+(-?[\d.]+) dBFS/),
      };
      let start: number | null = null;
      for (const m of log.matchAll(/silence_(start|end): (-?[\d.]+)/g)) {
        if (m[1] === "start") start = Number(m[2]);
        else if (start != null) {
          result.silences.push({ start, end: Number(m[2]) });
          start = null;
        }
      }
      if (start != null) result.silences.push({ start, end: durationS });
      result.clicks = findClicks(await pcm(ffmpeg, file), 48_000);
    }
    result.issues = judge(result, expect);
    return result;
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

/** Per-frame mean difference (0–255) between consecutive frames → the picture
 *  findings. `diffs[i]` compares frames i and i+1. */
export function motionFindings(
  diffs: readonly number[],
  fps: number,
): Pick<FilmCheck, "stalls" | "cadence" | "cuts"> {
  const at = (i: number) => Math.round(((i + 1) / fps) * 1000) / 1000;
  const still = (v: number) => v < 0.02;
  const stalls: number[] = [];
  for (let i = 2; i < diffs.length - 2; i++)
    if (still(diffs[i]!) && diffs[i - 1]! > 0.4 && diffs[i + 1]! > 0.4) stalls.push(at(i));
  const cuts: number[] = [];
  for (let i = 1; i < diffs.length - 1; i++) {
    const v = diffs[i]!;
    if (v > 30 && v > 3 * Math.max(diffs[i - 1]!, diffs[i + 1]!, 0.5)) cuts.push(at(i));
  }
  const cadence: { at: number; frames: number }[] = [];
  let run = 0;
  for (let i = 1; i <= diffs.length; i++) {
    const flips =
      i < diffs.length &&
      still(diffs[i]!) !== still(diffs[i - 1]!) &&
      Math.max(diffs[i]!, diffs[i - 1]!) > 0.3;
    if (flips) run++;
    else {
      if (run >= 8) cadence.push({ at: at(i - run - 1), frames: run });
      run = 0;
    }
  }
  return { stalls, cadence, cuts };
}

/** Isolated single-sample jumps: a step between two samples far larger than
 *  anything the waveform does in the 5 ms on EITHER side of it. The onset of a
 *  noisy sound (a hat, a whoosh) is busy right after its first sample, so it is
 *  not a click; a tone that starts or stops mid-cycle is smooth on both sides. */
export function findClicks(x: Float32Array, rate: number): number[] {
  const out: number[] = [];
  const half = Math.round(rate * 0.005);
  // running sum of squared first differences: sq[k] = Σ_{m<k} (x[m] - x[m-1])²
  const sq = new Float64Array(x.length + 1);
  for (let n = 1; n < x.length; n++) {
    const d = x[n]! - x[n - 1]!;
    sq[n + 1] = sq[n]! + d * d;
  }
  const rms = (a: number, b: number) => Math.sqrt((sq[b + 1]! - sq[a]!) / (b - a + 1));
  let last = -1;
  for (let n = half + 3; n < x.length - half - 3; n++) {
    const d = Math.abs(x[n]! - x[n - 1]!);
    if (d < 0.08) continue;
    const around = Math.max(rms(n - half, n - 3), rms(n + 3, n + half));
    if (d > 8 * around) {
      const t = n / rate;
      if (last < 0 || t - last > 0.05) out.push(Math.round(t * 1000) / 1000);
      last = t;
      if (out.length >= 30) break;
    }
  }
  return out;
}

function judge(c: FilmCheck, expect: FilmCheckExpect): FilmCheckIssue[] {
  const issues: FilmCheckIssue[] = [];
  const v = c.video;
  if (!v) issues.push({ severity: "error", message: "no video stream" });
  else {
    if (expect.width && expect.height && (v.width !== expect.width || v.height !== expect.height))
      issues.push({
        severity: "error",
        message: `size ${v.width}×${v.height}, expected ${expect.width}×${expect.height}`,
      });
    if (expect.fps && Math.abs(v.fps - expect.fps) > 0.01)
      issues.push({ severity: "error", message: `${v.fps} fps, expected ${expect.fps}` });
    if (v.codec !== "h264")
      issues.push({ severity: "warn", message: `video codec ${v.codec}, not H.264` });
    if (v.pixFmt !== "yuv420p")
      issues.push({
        severity: "warn",
        message: `pixel format ${v.pixFmt} — players expect yuv420p`,
      });
  }
  if (c.stalls.length)
    issues.push({
      severity: "error",
      message: `a frame repeats inside motion (a hitch) at ${list(c.stalls)}s`,
    });
  for (const r of c.cadence)
    issues.push({
      severity: "error",
      message: `still/moving frames alternate for ${r.frames} frames from ${r.at}s — motion is updating at a lower rate than the film`,
    });
  const edge = 0.05;
  for (const b of c.black)
    if (b.start > edge && b.end < c.durationS - edge)
      issues.push({
        severity: "warn",
        message: `black frames ${b.start}–${b.end}s inside the film`,
      });
  if (!c.audio) {
    if (expect.audio !== false)
      issues.push({ severity: "warn", message: "no audio stream — the film is silent" });
  } else {
    const a = c.audio;
    if (a.truePeak != null && a.truePeak > -1)
      issues.push({
        severity: "warn",
        message: `true peak ${a.truePeak} dBFS — above -1 dBFS it can clip after lossy encoding`,
      });
    if (a.lufs != null && (a.lufs < -20 || a.lufs > -12))
      issues.push({
        severity: "info",
        message: `integrated loudness ${a.lufs} LUFS — online video usually sits around -14 to -16`,
      });
    for (const s of c.silences)
      if (s.start > edge && s.end < c.durationS - edge)
        issues.push({
          severity: "info",
          message: `silence ${s.start.toFixed(2)}–${s.end.toFixed(2)}s`,
        });
    if (c.clicks.length)
      issues.push({
        severity: "warn",
        message: `possible clicks (a sudden jump in the waveform) at ${list(c.clicks)}s`,
      });
  }
  return issues;
}

const list = (xs: readonly number[]) =>
  xs.length > 8 ? `${xs.slice(0, 8).join(", ")} … (${xs.length})` : xs.join(", ");

export function formatFilmCheck(c: FilmCheck): string {
  const lines: string[] = [];
  const v = c.video;
  lines.push(
    v
      ? `picture: ${v.width}×${v.height} ${v.fps} fps ${v.codec}${v.profile ? ` ${v.profile}` : ""} ${v.pixFmt}, ${c.durationS.toFixed(2)}s`
      : "picture: none",
  );
  const a = c.audio;
  lines.push(
    a
      ? `sound: ${a.codec} ${a.sampleRate / 1000} kHz ${a.channels === 2 ? "stereo" : `${a.channels} ch`}, ${a.lufs ?? "?"} LUFS, range ${a.lra ?? "?"} LU, true peak ${a.truePeak ?? "?"} dBFS`
      : "sound: none",
  );
  lines.push(`cuts: ${c.cuts.length ? `${list(c.cuts)}s` : "none"}`);
  if (!c.issues.length) lines.push("no issues found");
  for (const i of c.issues)
    lines.push(`${i.severity === "info" ? "note" : i.severity}: ${i.message}`);
  return lines.join("\n");
}

function capture(bin: string, args: string[], stderr = false): Promise<string> {
  return new Promise((ok, fail) => {
    const p = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    p.stdout.on("data", (d: Buffer) => {
      out += d.toString();
    });
    p.stderr.on("data", (d: Buffer) => {
      err += d.toString();
    });
    p.on("error", fail);
    p.on("close", (code) =>
      code === 0
        ? ok(stderr ? err : out)
        : fail(new Error(`${bin} exited ${code}: ${err.slice(-600)}`)),
    );
  });
}

/** a film's sound as mono 48 kHz samples */
export function pcm(ffmpeg: string, file: string): Promise<Float32Array> {
  return new Promise((ok, fail) => {
    const p = spawn(
      ffmpeg,
      ["-v", "error", "-i", file, "-vn", "-ac", "1", "-ar", "48000", "-f", "f32le", "-"],
      {
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    const chunks: Buffer[] = [];
    p.stdout.on("data", (d: Buffer) => chunks.push(d));
    p.on("error", fail);
    p.on("close", (code) => {
      if (code !== 0) return fail(new Error(`ffmpeg exited ${code} decoding the sound`));
      const all = Buffer.concat(chunks);
      const f = new Float32Array(all.length >> 2);
      for (let i = 0; i < f.length; i++) f[i] = all.readFloatLE(i * 4);
      ok(f);
    });
  });
}

/** Per-frame mean change (0–255) between consecutive frames, small and grey:
 *  `diffs[i]` compares frames i and i+1. */
export async function frameDiffs(ffmpeg: string, file: string): Promise<number[]> {
  const tmp = await mkdtemp(join(tmpdir(), "open-take-diffs-"));
  try {
    const out = join(tmp, "diff.txt");
    await capture(
      ffmpeg,
      [
        "-nostats",
        "-v",
        "error",
        "-i",
        file,
        "-an",
        "-vf",
        `scale=320:-2,format=gray,tblend=all_mode=difference,signalstats,metadata=print:key=lavfi.signalstats.YAVG:file=${out.replace(/[\\:']/g, "\\$&")}`,
        "-f",
        "null",
        "-",
      ],
      true,
    );
    return [...(await readFile(out, "utf8")).matchAll(/YAVG=([-+]?[\d.]+(?:[eE][-+]?\d+)?)/g)].map(
      (m) => Number(m[1]),
    );
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

/** The longest stretches with no hard cut and no frame change above `level`
 *  (a slow push, a hold, a dissolve all count as quiet) — longest first. */
export function quietStretches(
  diffs: readonly number[],
  fps: number,
  level = 1.5,
): { start: number; end: number }[] {
  const n = diffs.length;
  const sm = diffs.map(
    (_, i) => (diffs[Math.max(0, i - 1)]! + diffs[i]! + diffs[Math.min(n - 1, i + 1)]!) / 3,
  );
  const cut = new Set(motionFindings(diffs, fps).cuts.map((t) => Math.round(t * fps) - 1));
  const out: { start: number; end: number }[] = [];
  let from = -1;
  for (let i = 0; i <= n; i++) {
    const quiet = i < n && sm[i]! < level && !cut.has(i);
    if (quiet && from < 0) from = i;
    if (!quiet && from >= 0) {
      out.push({
        start: Math.round((from / fps) * 100) / 100,
        end: Math.round((i / fps) * 100) / 100,
      });
      from = -1;
    }
  }
  return out.sort((a, b) => b.end - b.start - (a.end - a.start));
}

/** The sound's onsets (attacks: a hit, a pluck, a key) and how clearly it
 *  repeats a beat (autocorrelation of the onset envelope over 60–180 BPM,
 *  0 none … 1 a metronome). A measurement of pulse, not of whether the music
 *  serves the film. */
export function audioRhythm(
  x: Float32Array,
  sr: number,
): { onsets: number[]; onsetsPerSec: number; pulseBpm: number; pulseClarity: number } {
  const hop = Math.round(sr * 0.01);
  const win = hop * 2;
  const env: number[] = [];
  let prev = 0;
  for (let i = 0; i + win < x.length; i += hop) {
    let e = 0;
    for (let k = i + 1; k < i + win; k++) {
      const d = x[k]! - x[k - 1]!;
      e += d * d;
    }
    const l = Math.log10(e / win + 1e-10);
    env.push(Math.max(0, l - prev));
    prev = l;
  }
  const median = (a: number[]) => [...a].sort((p, q) => p - q)[Math.floor(a.length / 2)] ?? 0;
  const onsets: number[] = [];
  for (let i = 1; i < env.length - 1; i++) {
    const local = env.slice(Math.max(0, i - 50), Math.min(env.length, i + 50));
    const m = median(local);
    const mad = median(local.map((v) => Math.abs(v - m)));
    if (env[i]! > env[i - 1]! && env[i]! >= env[i + 1]! && env[i]! > m + 4 * mad + 0.15) {
      const t = (i * hop) / sr;
      if (!onsets.length || t - onsets[onsets.length - 1]! > 0.08)
        onsets.push(Math.round(t * 1000) / 1000);
    }
  }
  const mean = env.reduce((a, b) => a + b, 0) / (env.length || 1);
  const e = env.map((v) => v - mean);
  const r0 = e.reduce((a, v) => a + v * v, 0) || 1;
  let clarity = 0;
  let bpm = 0;
  for (let b = 60; b <= 180; b += 0.5) {
    const lag = Math.round((60 / b) * (sr / hop));
    let r = 0;
    for (let i = 0; i + lag < e.length; i++) r += e[i]! * e[i + lag]!;
    if (r / r0 > clarity) {
      clarity = r / r0;
      bpm = b;
    }
  }
  const dur = x.length / sr;
  return {
    onsets,
    onsetsPerSec: dur ? Math.round((onsets.length / dur) * 10) / 10 : 0,
    pulseBpm: bpm,
    pulseClarity: Math.round(Math.max(0, clarity) * 100) / 100,
  };
}
