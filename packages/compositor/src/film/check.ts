// `open-take film check`: what a finished film can be measured for without
// eyes or ears — the defects its author cannot perceive, reported with times.
//
// Picture: the format, frames that freeze for one frame while everything around
// them moves (a dropped or repeated frame), runs of alternating still/moving
// frames (a lower-rate cadence showing through), hard cuts, black frames,
// flashes — a few frames unlike the frames on both sides (a clip cut on its
// transition frame) — and shots that start on near-blank frames (the cut came
// before the shot's content).
// Sound: loudness (integrated, range, true peak), silences, and clicks — single-
// sample jumps the waveform around them does not explain (a cut envelope, a
// splice).
// With the film's page: text over text, text into a small painted element and
// text cut by the frame's edge, read from the page over the film's time, and
// the smallest text on screen (layout.ts).
// A film may flash on purpose: what the page marks as intended
// (window.__film.marks, carried in the film by `film render`) is listed as
// marked, not as a defect.
// Nothing here judges taste; every finding is a time to go and look at. The
// report ends by saying what it measured and what it does not (motion between
// frames, how text looks while it moves), so an empty list reads as no more
// than that.

import { spawn } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { resolveFfmpeg, resolveFfprobe, runTool } from "../ffmpeg";
import { type FilmMark, filmMarks } from "./clock";
import { type LayoutSpan, readPageLayout } from "./layout";
import { FILM_TAG, type FilmRecord, resolveFilmPage } from "./render";

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
  /** runs of alternating still/moving frames: where they start and how many
   *  frames; with `every`, a frame held about every that many frames (held
   *  frames a few apart, four or more, rather than alternating) */
  cadence: { at: number; frames: number; every?: number }[];
  /** seconds of hard cuts */
  cuts: number[];
  /** frames unlike the frames on both sides: where they start and how many */
  flashes: { at: number; frames: number }[];
  /** near-blank frames a shot starts on (or the film does): where, how many */
  blanks: { at: number; frames: number }[];
  black: { start: number; end: number }[];
  silences: { start: number; end: number }[];
  /** seconds of isolated sample jumps */
  clicks: number[];
  /** what the page marks as intended, in the film's own time (its first frame is 0) */
  marks: FilmMark[];
  /** the page read for its layout (the size it was laid out at), when given */
  page: { file: string; width: number; height: number; every: number } | null;
  /** text that collides or leaves the frame, from when to when; null without the page */
  layout: LayoutSpan[] | null;
  /** text drawn turned, skewed or mirrored: named, not read; null without the page */
  unreadText: string[] | null;
  /** the smallest text drawn — information, not a verdict; null without the page */
  smallestText: { px: number; at: number; text: string } | null;
  /** the shoot logs and saved screens in the folder served to the page —
   *  information; null without the page */
  material?: PageMaterial | null;
  /** what this check measured and what it does not: plain lines, no grade */
  scope?: FilmCheckScope;
  issues: FilmCheckIssue[];
};

export type FilmCheckScope = { measured: string; notMeasured: string };

export type FilmCheckExpect = { width?: number; height?: number; fps?: number };

/** the film's page, to read its layout over the film's time */
export type FilmCheckPage = {
  /** an .html file, or a directory holding index.html */
  page: string;
  /** the directory served to it (as for `film render`) */
  root?: string;
  chromePath: string;
  /** seconds between layout samples (default 0.25) */
  every?: number;
  onConsole?: (level: string, text: string) => void;
};

export async function checkFilm(
  file: string,
  expect: FilmCheckExpect = {},
  page?: FilmCheckPage,
): Promise<FilmCheck> {
  const [ffmpeg, ffprobe] = await Promise.all([resolveFfmpeg(), resolveFfprobe()]);
  const probe = JSON.parse(
    await runTool(ffprobe, ["-v", "error", "-show_streams", "-show_format", "-of", "json", file]),
  ) as {
    streams?: Record<string, string | number | undefined>[];
    format?: { duration?: string; tags?: Record<string, string> };
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
  const record = filmRecord(probe.format?.tags?.[FILM_TAG]);

  const result: FilmCheck = {
    file,
    durationS,
    video,
    audio: null,
    stalls: [],
    cadence: [],
    cuts: [],
    flashes: [],
    blanks: [],
    black: [],
    silences: [],
    clicks: [],
    marks: [],
    page: null,
    layout: null,
    unreadText: null,
    smallestText: null,
    issues: [],
  };
  if (video) {
    const fps = video.fps || 60;
    const { picture, log } = await readFilmPicture(ffmpeg, file, video.width, video.height, fps);
    Object.assign(result, motionFindings(picture.diffs, fps));
    result.flashes = picture.flashes;
    result.blanks = picture.blanks;
    // a frame held between the cut into a flash or a blank start and the cut
    // out of it is that finding, not a frame repeating inside motion
    const held = [...picture.flashes, ...picture.blanks];
    result.stalls = result.stalls.filter(
      (t) => !held.some((r) => t > r.at - 1e-6 && t < r.at + r.frames / fps - 1e-6),
    );
    for (const m of log.matchAll(/black_start:([\d.]+) black_end:([\d.]+)/g))
      result.black.push({ start: Number(m[1]), end: Number(m[2]) });
  }
  if (as) {
    const log = await runTool(
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
      { stderr: true },
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
  // where the film starts on the page's timeline (a render from the middle)
  const from = record?.from ?? 0;
  let marks = record?.marks ?? [];
  if (page) {
    const every = page.every ?? 0.25;
    const read = await readPageLayout({
      page: page.page,
      root: page.root,
      chromePath: page.chromePath,
      from,
      duration: durationS,
      every,
      // the size the film was laid out at; without it, the page's own size
      width: record?.width || undefined,
      height: record?.height || undefined,
      fallback: { width: video?.width ?? 1920, height: video?.height ?? 1080 },
      onConsole: page.onConsole,
    });
    result.page = { file: page.page, width: read.width, height: read.height, every };
    result.layout = read.spans;
    result.unreadText = read.unread;
    result.smallestText = read.smallest;
    result.material = await readPageMaterial(page.page, page.root).catch(() => null);
    // the page as it is now says what is meant: a mark added since the
    // render counts without rendering again
    marks = filmMarks(read.marks);
  }
  result.marks = marks
    .map((m) => ({ at: ms(m.at - from), until: ms(m.until - from), what: m.what }))
    .filter((m) => m.until >= -MARK_SLACK && m.at <= durationS + MARK_SLACK);
  result.issues = judgeFilm(result, expect);
  result.scope = filmCheckScope(result);
  return result;
}

/** what a check covered, from what it read: the streams it had and whether
 *  the page was played — so an empty list of findings is not read as more
 *  than it is. Motion between frames is `film probe`'s; how text looks while
 *  it moves no tool here reads. */
export function filmCheckScope(c: FilmCheck): FilmCheckScope {
  const parts = ["the format"];
  if (c.video)
    parts.push(
      "frames repeating inside motion, a lower-rate cadence, cuts, black, flash and blank frames",
    );
  if (c.audio) parts.push("loudness, silences and clicks");
  if (c.page)
    parts.push(
      `text over text, into painted elements and off the frame's edge, and the smallest text (the page read every ${c.page.every}s)`,
    );
  return {
    measured: parts.join("; "),
    notMeasured: `${c.page ? "" : "the text's layout (it reads the page with --page); "}how far things move from one frame to the next (a part of the picture jumping, a push and its speed) — \`film probe\` reads one-frame jumps and the picture's zoom and travel; how text looks while it moves (on a live page under a slow push it can step a pixel at a time) — \`film still\` at times one frame apart shows it`,
  };
}

const ms = (s: number) => Math.round(s * 1000) / 1000;

/** what `film render` wrote into the film about its page (FILM_TAG); null for
 *  a film from anywhere else. A size it does not have is 0. */
function filmRecord(raw: string | undefined): FilmRecord | null {
  if (!raw) return null;
  try {
    const r = JSON.parse(raw) as Partial<FilmRecord>;
    const positive = (v: unknown) => (typeof v === "number" && v > 0 ? v : 0);
    return {
      from: positive(r.from),
      width: positive(r.width),
      height: positive(r.height),
      marks: filmMarks(r.marks),
    };
  } catch {
    return null;
  }
}

// --- the picture ------------------------------------------------------------------

/** the picture is read in grey at this width, as tall as the film keeps it */
const READ_WIDTH = 320;
/** a flash's spread is counted on a grid of this many cells */
const GRID_X = 16;
const GRID_Y = 9;

// A flash: up to FLASH_MAX_S of frames unlike the frames on both sides — a clip
// cut on its transition frame, a frame from another scene, a white frame. Read
// from the twelve exploration films, every version (60 fps masters, 30 fps
// drafts): the two flashes a judge saw (a game's flat transition frame, 2 and 4
// frames long at 60 fps) against the moments that came closest to them —
//   - they arrive with a change 3.3–12× the change before them and inside them,
//     where the near misses this leaves out arrive at 2.1–2.7×;
//   - it moves a cell of a 16×9 grid by 8 of 255 or more in 85–92 % of the
//     picture, where a number ticking over in a count-up moves 12–19 %;
//   - they leave by 11–14 of 255, 1.6–2.8× the change after them, where a
//     white flash that fades out leaves at 1.4×;
//   - arriving and leaving add up to 2.0–2.8× the change from the frame before
//     them to the frame after (the picture comes back, or goes on to something
//     like it), where a cut followed by a fade or motion adds up to 1.3–1.55×
//     and a lower-rate clip stepping through a growing shape 1.3–1.65×.
// Nothing else in the twelve films meets all four.
const FLASH_MAX_S = 1 / 15; // 4 frames at 60 fps, 2 at 30
const FLASH_ARRIVE = 3;
const FLASH_SPREAD = 0.5;
const SPREAD_LEVEL = 8;
const FLASH_LEAVE = 8;
const FLASH_DEPART = 1.5;
const FLASH_DETOUR = 1.8;

// A shot that starts blank: a cut onto near-blank frames, before the shot's
// content arrives. In the twelve films — and in versions from before their
// authors fixed it — those frames measure 0–1.9 of 255 in standard deviation,
// and the first one with the shot's content fading in 2 and up (a vignette with
// nothing on it, 3.5); they last 1–4 frames (up to 0.13 s), where a black or
// white beat held on purpose lasts 0.22 s and more; and the change into them is
// a cut, 6–236 of 255 at least 3× the change before it, where a fade to black
// steps by 0–4 like the steps around it. The film's first frame counts as a
// shot's start: it is the film's poster.
const BLANK_SD = 2;
const BLANK_MAX_S = 0.2;
const BLANK_CUT = 3;

/** what the picture measured to */
export type Picture = {
  /** mean change (0–255) between consecutive frames: `diffs[i]` compares
   *  frames i and i+1 */
  diffs: number[];
  flashes: { at: number; frames: number }[];
  blanks: { at: number; frames: number }[];
};

/** Grey frames in, one at a time (width × height bytes each, in order): how
 *  much the picture changes from frame to frame, its flashes and its blank
 *  shot starts. A flash is judged against frames a few apart, so the last
 *  few are kept — a film of any length reads in little memory. */
export function readPicture(width: number, height: number, fps: number) {
  const size = width * height;
  const longest = Math.max(1, Math.round(fps * FLASH_MAX_S));
  // the grid cell each pixel falls in, and how many pixels each cell holds
  const cellOf = new Uint16Array(size);
  const cellSize = new Float64Array(GRID_X * GRID_Y);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const c =
        Math.min(GRID_Y - 1, Math.floor((y * GRID_Y) / height)) * GRID_X +
        Math.min(GRID_X - 1, Math.floor((x * GRID_X) / width));
      cellOf[y * width + x] = c;
      cellSize[c]!++;
    }
  /** change[k]: mean |difference| between frames k−1 and k (change[0] = 0) */
  const change: number[] = [];
  /** spread[k]: the share of grid cells whose brightness moved from k−1 to k */
  const spread: number[] = [];
  /** each frame's standard deviation: how near it is to one colour */
  const deviation: number[] = [];
  /** for a frame entered by a change a flash could leave by: how far it is
   *  from each of the frames 2 … longest+1 before it */
  const apart = new Map<number, number[]>();
  const recent: Uint8Array[] = [];
  let lastCells: Float64Array | null = null;
  const differ = (a: Uint8Array, b: Uint8Array) => {
    let s = 0;
    for (let k = 0; k < size; k++) s += Math.abs(a[k]! - b[k]!);
    return s / size;
  };
  return {
    push(frame: Uint8Array): void {
      let sum = 0;
      let squares = 0;
      const cells = new Float64Array(GRID_X * GRID_Y);
      for (let k = 0; k < size; k++) {
        const v = frame[k]!;
        sum += v;
        squares += v * v;
        cells[cellOf[k]!]! += v;
      }
      for (let c = 0; c < cells.length; c++) cells[c]! /= cellSize[c]!;
      const mean = sum / size;
      deviation.push(Math.sqrt(Math.max(0, squares / size - mean * mean)));
      const last = recent.at(-1);
      if (last && lastCells) {
        const d = differ(last, frame);
        change.push(d);
        let moved = 0;
        for (let c = 0; c < cells.length; c++)
          if (Math.abs(cells[c]! - lastCells[c]!) >= SPREAD_LEVEL) moved++;
        spread.push(moved / cells.length);
        if (d >= FLASH_LEAVE) {
          const far: number[] = [];
          for (let m = 2; m <= Math.min(longest + 1, recent.length); m++)
            far.push(differ(recent[recent.length - m]!, frame));
          apart.set(change.length - 1, far);
        }
      } else {
        change.push(0);
        spread.push(0);
      }
      recent.push(frame);
      if (recent.length > longest + 1) recent.shift();
      lastCells = cells;
    },
    done(): Picture {
      const n = change.length;
      const at = (k: number) => ms(k / fps);
      // frames [i, i + len): what arrives at i and leaves at i + len
      const runs: [number, number][] = [];
      for (let i = 1; i < n - 1; i++)
        for (let len = 1; len <= longest && i + len < n; len++) {
          const enter = change[i]!;
          const leave = change[i + len]!;
          const across = apart.get(i + len)?.[len - 1];
          if (leave < FLASH_LEAVE || across === undefined || spread[i]! < FLASH_SPREAD) continue;
          let inside = 0;
          for (let k = i + 1; k < i + len; k++) inside = Math.max(inside, change[k]!);
          const before = change[i - 1]!;
          const after = change[i + len + 1] ?? 0;
          if (
            enter >= FLASH_ARRIVE * Math.max(before, inside, 0.5) &&
            leave >= FLASH_DEPART * Math.max(after, inside, 0.5) &&
            enter + leave >= FLASH_DETOUR * Math.max(across, 0.5)
          )
            runs.push([i, i + len]);
        }
      // one flash may read as runs of more than one length: one finding
      const merged: [number, number][] = [];
      for (const r of runs.sort((a, b) => a[0] - b[0] || a[1] - b[1])) {
        const last = merged.at(-1);
        if (last && r[0] < last[1]) last[1] = Math.max(last[1], r[1]);
        else merged.push([r[0], r[1]]);
      }
      const blanks: Picture["blanks"] = [];
      for (let k = 0; k < n; ) {
        if (deviation[k]! >= BLANK_SD) {
          k++;
          continue;
        }
        let j = k;
        while (j < n && deviation[j]! < BLANK_SD) j++;
        const cut =
          k === 0 ||
          (change[k]! >= BLANK_CUT && change[k]! >= FLASH_ARRIVE * Math.max(change[k - 1]!, 0.5));
        // content follows, soon: a longer blank is a beat; one inside a flash is the flash
        if (
          cut &&
          j < n &&
          (j - k) / fps < BLANK_MAX_S &&
          !merged.some(([a, b]) => a <= k && j <= b)
        )
          blanks.push({ at: at(k), frames: j - k });
        k = j;
      }
      return {
        diffs: change.slice(1),
        flashes: merged.map(([a, b]) => ({ at: at(a), frames: b - a })),
        blanks,
      };
    },
  };
}

/** One decode for the picture: grey frames at READ_WIDTH into readPicture,
 *  and black frames found by ffmpeg in the full picture. */
function readFilmPicture(
  ffmpeg: string,
  file: string,
  width: number,
  height: number,
  fps: number,
): Promise<{ picture: Picture; log: string }> {
  const w = READ_WIDTH;
  // as tall as the film keeps it, even — what scale=320:-2 picks
  const h = Math.max(2, Math.round((height * w) / width / 2) * 2);
  const size = w * h;
  const reader = readPicture(w, h, fps);
  return new Promise((ok, fail) => {
    const p = spawn(
      ffmpeg,
      [
        "-nostats",
        "-v",
        "info",
        "-i",
        file,
        "-filter_complex",
        `[0:v]split[s][b];[s]scale=${w}:${h},format=gray[g];[b]blackdetect=d=0.1:pix_th=0.06[bo]`,
        "-map",
        "[g]",
        // every decoded frame once: a constant-rate output may add or drop one
        "-fps_mode",
        "passthrough",
        "-f",
        "rawvideo",
        "-",
        "-map",
        "[bo]",
        "-f",
        "null",
        "-",
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let pending: Buffer | null = null;
    let log = "";
    p.stdout.on("data", (d: Buffer) => {
      const buf = pending ? Buffer.concat([pending, d]) : d;
      let off = 0;
      for (; buf.length - off >= size; off += size)
        reader.push(new Uint8Array(buf.subarray(off, off + size)));
      pending = off < buf.length ? buf.subarray(off) : null;
    });
    p.stderr.on("data", (d: Buffer) => {
      log += d.toString();
    });
    p.on("error", fail);
    p.on("close", (code) =>
      code === 0
        ? ok({ picture: reader.done(), log })
        : fail(new Error(`ffmpeg exited ${code} reading the picture: ${log.trim().slice(-600)}`)),
    );
  });
}

/** Per-frame mean difference (0–255) between consecutive frames → the picture
 *  findings. `diffs[i]` compares frames i and i+1. */
export function motionFindings(
  diffs: readonly number[],
  fps: number,
): Pick<FilmCheck, "stalls" | "cadence" | "cuts"> {
  const at = (i: number) => Math.round(((i + 1) / fps) * 1000) / 1000;
  // the differences are means over a small grey copy (0–255): below 0.02 two
  // frames are the same picture (encoder noise aside), above 0.4 something
  // visibly moved
  const still = (v: number) => v < 0.02;
  const cadence: { at: number; frames: number; every?: number }[] = [];
  // moving and still frames taking turns for 8 frames and more: what changes
  // updates at a lower rate than the film, not one repeated frame
  const alternating: [number, number][] = [];
  let run = 0;
  for (let i = 1; i <= diffs.length; i++) {
    const flips =
      i < diffs.length &&
      still(diffs[i]!) !== still(diffs[i - 1]!) &&
      Math.max(diffs[i]!, diffs[i - 1]!) > 0.3;
    if (flips) run++;
    else {
      if (run >= 8) {
        cadence.push({ at: at(i - run - 1), frames: run });
        alternating.push([i - run - 1, i]);
      }
      run = 0;
    }
  }
  const held: number[] = [];
  for (let i = 2; i < diffs.length - 2; i++)
    if (
      still(diffs[i]!) &&
      diffs[i - 1]! > 0.4 &&
      diffs[i + 1]! > 0.4 &&
      !alternating.some(([a, b]) => i >= a && i <= b)
    )
      held.push(i);
  // a held frame on its own inside motion is a hitch; held frames that keep
  // coming back a few frames apart are the picture changing at a lower rate
  // than the film — a number counting 40 a second holds every third frame —
  // and are told as a cadence, not as so many hitches (the frame differences
  // cannot tell motion from a number or a word changing)
  const stalls: number[] = [];
  for (let k = 0; k < held.length; ) {
    let e = k;
    while (e + 1 < held.length && held[e + 1]! - held[e]! <= 4) e++;
    if (e - k + 1 >= 4) {
      const gaps = held.slice(k + 1, e + 1).map((h, j) => h - held[k + j]!);
      gaps.sort((a, b) => a - b);
      cadence.push({
        at: at(held[k]! - 1),
        frames: held[e]! - held[k]! + 2,
        every: gaps[Math.floor(gaps.length / 2)]!,
      });
    } else for (let j = k; j <= e; j++) stalls.push(at(held[j]!));
    k = e + 1;
  }
  // a cut: most of the picture changes at once (a mean change of 30 of 255),
  // three times more than the frames on either side of it
  const cuts: number[] = [];
  for (let i = 1; i < diffs.length - 1; i++) {
    const v = diffs[i]!;
    if (v > 30 && v > 3 * Math.max(diffs[i - 1]!, diffs[i + 1]!, 0.5)) cuts.push(at(i));
  }
  cadence.sort((a, b) => a.at - b.at);
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
    // a step of 8 % of full scale or more, 8 times what the waveform does
    // around it (by its rms step), is a click; below that it is the sound
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

// --- judging --------------------------------------------------------------------

/** a mark covers its moment, or its stretch, and this much either side: the
 *  check reads times to the frame, an author writes them by hand */
const MARK_SLACK = 0.1;
/** times are read to the millisecond: closer than this is the same time */
const SAME_TIME = 1e-6;

const LAYOUT_SAYS: Record<LayoutSpan["kind"], string> = {
  "text-over-text": "text over text",
  "text-over-badge": "text into a small painted element",
  "text-off-frame": "text cut by the frame's edge",
};

export function judgeFilm(c: FilmCheck, expect: FilmCheckExpect): FilmCheckIssue[] {
  const issues: FilmCheckIssue[] = [];
  const v = c.video;
  const fps = v?.fps || 60;
  /** the findings the marks do not cover from end to end; the others are
   *  listed as marked as intended, and a mark that covers a finding only in
   *  part is named beside it */
  const unmarked = <T>(xs: readonly T[], span: (x: T) => [number, number], say: (x: T) => string) =>
    xs.filter((x) => {
      const [from, to] = span(x);
      const touching = c.marks
        .filter(
          (m) => from <= m.until + MARK_SLACK + SAME_TIME && to >= m.at - MARK_SLACK - SAME_TIME,
        )
        .sort((a, b) => a.at - b.at);
      if (!touching.length) return true;
      let reach = from;
      for (const m of touching) {
        if (m.at - MARK_SLACK > reach + SAME_TIME) break;
        reach = Math.max(reach, m.until + MARK_SLACK);
      }
      const whole = reach + SAME_TIME >= to;
      const whats = touching.flatMap((m) => (m.what ? [`"${m.what}"`] : []));
      const named = touching.map((m) =>
        m.what ? `"${m.what}"` : `${m.at === m.until ? m.at : `${m.at}–${m.until}`}s`,
      );
      issues.push({
        severity: "info",
        message: whole
          ? `marked as intended${whats.length ? ` (${whats.join(", ")})` : ""}: ${say(x)}`
          : `a mark covers only part of it (${named.join(", ")}): ${say(x)}`,
      });
      return !whole;
    });
  const frames = (n: number) => `${n} frame${n === 1 ? "" : "s"}`;
  const runOf = (r: { at: number; frames: number }): [number, number] => [
    r.at,
    r.at + r.frames / fps,
  ];
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
  const stalls = unmarked(
    c.stalls,
    (t) => [t, t],
    (t) => `a frame repeats inside motion at ${t}s`,
  );
  if (stalls.length)
    issues.push({
      severity: "error",
      message: `a frame repeats inside motion (a hitch) at ${list(stalls)}s`,
    });
  const cadence = unmarked(c.cadence, runOf, (r) =>
    r.every
      ? `a frame held about every ${r.every} frames for ${r.frames} frames from ${r.at}s`
      : `still/moving frames alternate for ${r.frames} frames from ${r.at}s`,
  );
  for (const r of cadence)
    issues.push(
      r.every
        ? {
            // the frame differences cannot tell what changes: a count of 40 a
            // second holds one frame in 3 as a 40 fps move does
            severity: "warn",
            message: `a frame held about every ${r.every} frames for ${r.frames} frames from ${r.at}s — what changes there changes at a lower rate than the film: a move stepping, or a number or text updated that often (a count of 40 a second holds one frame in 3)`,
          }
        : {
            severity: "error",
            message: `still/moving frames alternate for ${r.frames} frames from ${r.at}s — what changes there (a move, or a number or text) is updating at a lower rate than the film`,
          },
    );
  const flashes = unmarked(c.flashes, runOf, (f) => `a flash at ${f.at}s (${frames(f.frames)})`);
  if (flashes.length)
    issues.push({
      severity: "warn",
      message: `a flash — frames unlike the frames on both sides — at ${flashes.map((f) => `${f.at}s (${frames(f.frames)})`).join(", ")}: a clip cut on its transition frame, or a flash meant to be there (say so in window.__film.marks)`,
    });
  const blanks = unmarked(
    c.blanks,
    runOf,
    (b) => `a shot starts on near-blank frames at ${b.at}s (${frames(b.frames)})`,
  );
  if (blanks.length)
    issues.push({
      severity: "warn",
      message: `a shot starts on near-blank frames at ${blanks.map((b) => `${b.at}s (${frames(b.frames)})`).join(", ")}: its content arrives after the cut${blanks[0]!.at === 0 ? " — and a blank first frame is the film's poster" : ""}`,
    });
  const edge = 0.05;
  const black = unmarked(
    c.black.filter((b) => b.start > edge && b.end < c.durationS - edge),
    (b) => [b.start, b.end],
    (b) => `black frames ${b.start}–${b.end}s`,
  );
  for (const b of black)
    issues.push({
      severity: "warn",
      message: `black frames ${b.start}–${b.end}s inside the film`,
    });
  const layout = unmarked(
    groupLayout(c.layout ?? []),
    (g) => [g.from, g.to],
    (g) => g.message,
  );
  for (const g of layout) issues.push({ severity: "warn", message: g.message });
  const unread = c.unreadText ?? [];
  if (unread.length)
    issues.push({
      severity: "info",
      message: `text drawn turned, skewed, mirrored or in a frame tilted in perspective is not read for collisions or size — look at it yourself: ${unread.slice(0, 6).join(", ")}${unread.length > 6 ? ` and ${unread.length - 6} more` : ""}`,
    });
  if (!c.audio) {
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
    const silences = unmarked(
      c.silences.filter((s) => s.start > edge && s.end < c.durationS - edge),
      (s) => [s.start, s.end],
      (s) => `silence ${s.start.toFixed(2)}–${s.end.toFixed(2)}s`,
    );
    for (const s of silences)
      issues.push({
        severity: "info",
        message: `silence ${s.start.toFixed(2)}–${s.end.toFixed(2)}s`,
      });
    const clicks = unmarked(
      c.clicks,
      (t) => [t, t],
      (t) => `a possible click at ${t}s`,
    );
    if (clicks.length)
      issues.push({
        severity: "warn",
        message: `possible clicks (a sudden jump in the waveform) at ${list(clicks)}s`,
      });
  }
  return issues;
}

/** One finding per piece of text, kind and stretch of time, naming what it
 *  runs into. */
function groupLayout(
  spans: readonly LayoutSpan[],
): { from: number; to: number; message: string }[] {
  const groups: {
    kind: LayoutSpan["kind"];
    a: string;
    from: number;
    to: number;
    hits: Set<string>;
  }[] = [];
  for (const s of [...spans].sort((x, y) => x.from - y.from)) {
    const g = groups.find(
      (x) => x.kind === s.kind && x.a === s.a && s.from <= x.to + 0.3 && s.to >= x.from - 0.3,
    );
    if (g) {
      g.from = Math.min(g.from, s.from);
      g.to = Math.max(g.to, s.to);
      if (s.b) g.hits.add(s.b);
    } else
      groups.push({
        kind: s.kind,
        a: s.a,
        from: s.from,
        to: s.to,
        hits: new Set(s.b ? [s.b] : []),
      });
  }
  return groups.map((g) => {
    const hits = [...g.hits];
    const into = hits.length
      ? ` × ${hits.slice(0, 4).join("; ")}${hits.length > 4 ? `; and ${hits.length - 4} more` : ""}`
      : "";
    return {
      from: g.from,
      to: g.to,
      message: `${LAYOUT_SAYS[g.kind]} ${g.from}–${g.to}s: ${g.a}${into}`,
    };
  });
}

// --- the page's material ------------------------------------------------------------

export type PageMaterial = {
  /** the folder served to the page, where the search started */
  root: string;
  /** `open-take shoot` logs (shots.json) under it: path from root, PNG
   *  stills, and how many of those name a saved screen */
  logs: { file: string; stills: number; withState: number }[];
  /** saved screens under it (a `state.html` each) */
  states: number;
};

/** folders the material search does not enter */
const MATERIAL_SKIP = new Set(["node_modules", "kit"]);
const MATERIAL_DEPTH = 5;
const MATERIAL_ENTRIES = 20_000;

/** the shoot logs and saved screens in the folder served to the page (as
 *  `film render` serves it): read off the files, the page not run. */
export async function readPageMaterial(page: string, root?: string): Promise<PageMaterial> {
  const base = resolveFilmPage(page, root).root;
  const out: PageMaterial = { root: base, logs: [], states: 0 };
  let seen = 0;
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > MATERIAL_DEPTH || seen > MATERIAL_ENTRIES) return;
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const e of entries) {
      if (++seen > MATERIAL_ENTRIES) return;
      const at = join(dir, e.name);
      if (e.isDirectory()) {
        if (!e.name.startsWith(".") && !MATERIAL_SKIP.has(e.name)) await walk(at, depth + 1);
      } else if (e.name === "state.html") out.states++;
      else if (e.name === "shots.json") {
        try {
          const log = JSON.parse(await readFile(at, "utf8")) as { stills?: unknown };
          if (!Array.isArray(log.stills)) continue;
          const stills = log.stills.filter(
            (x): x is { file: string; state?: unknown } =>
              !!x &&
              typeof x === "object" &&
              /\.png$/i.test(String((x as { file?: unknown }).file)),
          );
          if (stills.length)
            out.logs.push({
              file: relative(base, at),
              stills: stills.length,
              withState: stills.filter((x) => x.state != null && x.state !== false).length,
            });
        } catch {
          // not a shoot log
        }
      }
    }
  };
  await walk(base, 0);
  out.logs.sort((a, b) => a.file.localeCompare(b.file));
  return out;
}

/** one line when the page's folder holds PNG stills from a shoot and no
 *  saved screen: what else a still can keep. null otherwise. Information. */
export function pageMaterialNote(m: PageMaterial): string | null {
  if (!m.logs.length || m.states > 0 || m.logs.some((l) => l.withState > 0)) return null;
  const stills = m.logs.reduce((a, l) => a + l.stills, 0);
  const where =
    m.logs.length === 1
      ? m.logs[0]!.file
      : `${m.logs.length} shoot logs (${m.logs
          .slice(0, 3)
          .map((l) => l.file)
          .join(", ")}${m.logs.length > 3 ? ", …" : ""})`;
  return `${stills} PNG still${stills === 1 ? "" : "s"} from ${where}, and no saved screen in the folder served to the page. A still can also keep the interface itself (\`s.still(name, { state: true })\` in a shoot script, or \`open-take shoot … --states\`): live page parts that \`lift\` / \`isolate\` (kit/media.js) act on and stay sharp at any zoom — \`skill film material\`. Information, not a step.`;
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
  if (c.marks.length)
    lines.push(
      `marked as intended: ${c.marks.map((m) => `${m.at === m.until ? m.at : `${m.at}–${m.until}`}s${m.what ? ` "${m.what}"` : ""}`).join(", ")}`,
    );
  if (c.page) {
    lines.push(
      `page: ${c.page.file}, laid out at ${c.page.width}×${c.page.height}, read every ${c.page.every}s`,
    );
    const s = c.smallestText;
    lines.push(
      s
        ? `text: the smallest on screen is ${s.px}px (its font size as drawn on the ${c.page.width}×${c.page.height} frame) at ${s.at}s — ${s.text}`
        : "text: none on screen",
    );
  }
  const note = c.material ? pageMaterialNote(c.material) : null;
  if (note) lines.push(`material: ${note}`);
  const scope = c.scope ?? filmCheckScope(c);
  lines.push(`measured: ${scope.measured}`);
  lines.push(`not measured: ${scope.notMeasured}`);
  if (!c.issues.length) lines.push("found: nothing in what was measured");
  for (const i of c.issues)
    lines.push(`${i.severity === "info" ? "note" : i.severity}: ${i.message}`);
  return lines.join("\n");
}

function pcm(ffmpeg: string, file: string): Promise<Float32Array> {
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
