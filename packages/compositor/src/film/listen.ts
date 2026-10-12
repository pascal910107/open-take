// `open-take film listen`: a film's sound as information the author can read —
// a picture on the film's time (spectrum, loudness, onsets and beat grid,
// texture sections, each stem's activity, the page's events and cuts and
// curves), marked with the same times as `film sheet`, and a text report
// where every line says whether it was measured, is an estimate, or was not
// found. Nothing is graded: no target, no pass line, no "should".
//
// ffmpeg reads what it measures to a standard (ebur128 loudness, true peak,
// silencedetect, the spectrum picture); the rest is plain arithmetic on the
// decoded sound here: a short-time spectrum, onsets from where its bands rise,
// a tempo from how the onset strength repeats, sections from where the
// texture stops resembling what came before, bars that repeat verbatim.

import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, extname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { resolveFfmpeg, resolveFfprobe, runTool } from "../ffmpeg";
import { launchHtmlBrowser } from "../html/cdp";
import {
  BANDS,
  chanceWithin,
  decodeMono,
  estimateTempo,
  FLOOR_DB,
  findSections,
  LISTEN_RATE,
  nearestOffset,
  onsetStrength,
  pickOnsets,
  type Section,
  type Spectrum,
  spectrum,
  type Tempo,
  WIN,
} from "./beats";
import scoreCorpus from "./data/score-corpus.json";

// the analysis lives in ./beats (shared with `film beats` and `film probe`);
// what this module has always exported is still exported from here
export {
  chanceWithin,
  estimateTempo,
  findSections,
  LISTEN_RATE,
  nearestOffset,
  onsetStrength,
  pickOnsets,
  type Section,
  type Spectrum,
  spectrum,
  type Tempo,
} from "./beats";

// --- the page's events (the file `film render` writes beside the film) ------------

export type FilmEvent = {
  /** seconds on the film's time */
  t: number;
  /** "click", "key", "land", "cut", "mark", … — whatever the page names */
  kind: string;
  /** stage px */
  x?: number;
  y?: number;
  /** 0..1 */
  force?: number;
  label?: string;
};

export type FilmEvents = {
  version: 1;
  duration: number;
  fps: number;
  /** sorted by t */
  events: FilmEvent[];
  /** hard-cut times the clock detected or the page declared */
  cuts: number[];
  /** rows[i][j] = curve names[j] at time t0 + i·dt */
  curves: { names: string[]; t0: number; dt: number; rows: number[][] };
};

const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** `<film>.events.json` read leniently: what is malformed is left out, never fatal */
export function parseFilmEvents(raw: unknown): FilmEvents {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const events = (Array.isArray(r.events) ? r.events : [])
    .filter((e): e is Record<string, unknown> => !!e && typeof e === "object" && finite(e.t))
    .map((e) => {
      const ev: FilmEvent = {
        t: e.t as number,
        kind: typeof e.kind === "string" ? e.kind : "event",
      };
      if (finite(e.x)) ev.x = e.x;
      if (finite(e.y)) ev.y = e.y;
      if (finite(e.force)) ev.force = e.force;
      if (typeof e.label === "string") ev.label = e.label;
      return ev;
    })
    .sort((a, b) => a.t - b.t);
  const cuts = (Array.isArray(r.cuts) ? r.cuts : []).filter(finite).sort((a, b) => a - b);
  const c = (r.curves && typeof r.curves === "object" ? r.curves : {}) as Record<string, unknown>;
  const names = (Array.isArray(c.names) ? c.names : []).map(String);
  const rows = (Array.isArray(c.rows) ? c.rows : [])
    .filter((row): row is unknown[] => Array.isArray(row))
    .map((row) => names.map((_, j) => (finite(row[j]) ? (row[j] as number) : Number.NaN)));
  const fps = finite(r.fps) && r.fps > 0 ? r.fps : 60;
  return {
    version: 1,
    duration: finite(r.duration) ? r.duration : 0,
    fps,
    events,
    cuts,
    curves: {
      names,
      t0: finite(c.t0) ? c.t0 : 0,
      dt: finite(c.dt) && c.dt > 0 ? c.dt : 1 / fps,
      rows,
    },
  };
}

// --- repeats --------------------------------------------------------------------------

export type BarRepeats = {
  beatsPerBar: number;
  bars: number;
  /** bars (1-based) that sound like an earlier bar, each with the first bar it repeats */
  repeats: { bar: number; of: number }[];
  /** the longest stretch of consecutive bars repeating a stretch before it */
  longestRun: { from: number; to: number; of: number } | null;
};

/** bars (4 beats on the estimated grid) that repeat an earlier bar verbatim:
 *  the same band energies, step by step, within 1.5 dB on average and shaped
 *  alike (correlation ≥ 0.95). Silent bars are left out. */
export function repeatedBars(s: Spectrum, beats: readonly number[], beatsPerBar = 4): BarRepeats {
  const STEPS = 16;
  const COARSE = BANDS / 2;
  const bars: (Float64Array | null)[] = [];
  for (let i = 0; i + beatsPerBar < beats.length; i += beatsPerBar) {
    const a = beats[i]!;
    const b = beats[i + beatsPerBar]!;
    const v = new Float64Array(STEPS * COARSE);
    let loud = false;
    for (let st = 0; st < STEPS; st++) {
      const f0 = Math.floor((a + ((b - a) * st) / STEPS) / s.hopS);
      const f1 = Math.max(f0 + 1, Math.floor((a + ((b - a) * (st + 1)) / STEPS) / s.hopS));
      for (let f = f0; f < Math.min(f1, s.bands.length); f++) {
        if (s.level[f]! > FLOOR_DB + 10) loud = true;
        for (let k = 0; k < COARSE; k++)
          v[st * COARSE + k] =
            v[st * COARSE + k]! +
            (Math.max(s.bands[f]![2 * k]!, s.bands[f]![2 * k + 1]!) - FLOOR_DB) / (f1 - f0);
      }
    }
    bars.push(loud ? v : null);
  }
  const same = (p: Float64Array, q: Float64Array) => {
    let diff = 0;
    let mp = 0;
    let mq = 0;
    for (let i = 0; i < p.length; i++) {
      diff += Math.abs(p[i]! - q[i]!);
      mp += p[i]!;
      mq += q[i]!;
    }
    if (diff / p.length > 1.5) return false;
    mp /= p.length;
    mq /= q.length;
    let num = 0;
    let dp = 0;
    let dq = 0;
    for (let i = 0; i < p.length; i++) {
      num += (p[i]! - mp) * (q[i]! - mq);
      dp += (p[i]! - mp) ** 2;
      dq += (q[i]! - mq) ** 2;
    }
    return dp > 0 && dq > 0 && num / Math.sqrt(dp * dq) >= 0.95;
  };
  const repeats: { bar: number; of: number }[] = [];
  const of: (number | null)[] = bars.map(() => null);
  for (let i = 1; i < bars.length; i++) {
    const p = bars[i];
    if (!p) continue;
    for (let j = 0; j < i; j++) {
      const q = bars[j];
      if (q && same(p, q)) {
        of[i] = j;
        repeats.push({ bar: i + 1, of: (of[j] ?? j) + 1 });
        break;
      }
    }
  }
  // the longest run of bars i..i+k each repeating bar j..j+k
  let longestRun: BarRepeats["longestRun"] = null;
  for (let i = 1; i < bars.length; i++)
    for (let j = 0; j < i; j++) {
      let k = 0;
      while (
        i + k < bars.length &&
        j + k < i &&
        bars[i + k] &&
        bars[j + k] &&
        same(bars[i + k]!, bars[j + k]!)
      )
        k++;
      if (k >= 2 && (!longestRun || k > longestRun.to - longestRun.from + 1))
        longestRun = { from: i + 1, to: i + k, of: j + 1 };
    }
  return { beatsPerBar, bars: bars.length, repeats, longestRun };
}

// --- the whole listen ------------------------------------------------------------------

type How = "measured" | "estimated" | "not detected" | "not measured";

export type FilmListen = {
  input: string;
  duration: number;
  sampleRate: number;
  channels: number;
  loudness: {
    how: How;
    integratedLufs: number | null;
    lra: number | null;
    truePeakDb: number | null;
    /** momentary loudness (LUFS, 400 ms) every 100 ms */
    momentary: { t: number; lufs: number }[];
  };
  onsets: { how: How; times: number[]; perS: number };
  tempo: { how: How; value: Tempo | null };
  sections: { how: How; list: Section[] };
  bars: { how: How; value: BarRepeats | null; note?: string };
  silences: { how: How; list: { start: number; end: number }[] };
  dips: { how: How; list: { start: number; end: number; belowLu: number }[] };
  events: {
    how: How;
    file: string | null;
    list: (FilmEvent & { nearestOnset: number | null })[];
    unvoiced: (FilmEvent & { nearestOnset: number | null })[];
    chance40: number;
  };
  cuts: {
    how: How;
    source: "events" | "picture" | "none";
    list: { t: number; nearestOnset: number | null }[];
  };
  stems: {
    how: How;
    dir: string | null;
    list: { name: string; file: string; activeS: number; peakDb: number; lane: boolean[] }[];
    /** seconds per lane cell */
    laneS: number;
    /** per event: the stem that rises at it, and how many dB it sits over the rest */
    eventWindows: { t: number; kind: string; stem: string; overRestDb: number }[];
  };
  curves: FilmEvents["curves"];
  clips: string[];
  /** what the sound is like — instruments, synthesized or recorded — is not measured */
  timbre: { how: "not measured" };
  /** the events file's "credits", as written there (absent: no such field) */
  credits?: string[];
  /** this sound beside a previous version of it (`--vs`) */
  vs?: ListenVs;
};

// --- beside earlier films ---------------------------------------------------------------

export type ScoreCorpusFilm = {
  id: string;
  group: string;
  music: string;
  declaredBpm: number | null;
  bpm: number | null;
  tempoConfidence: number;
  key: string | null;
  keyCorrelation: number | null;
  lowPattern: string | null;
  duration: number;
};

export type Inertia = {
  how: How;
  /** the earlier films compared with (this film left out if it is one of them) */
  of: number;
  /** a corpus film this input is (by its path), left out of the counts */
  self: string | null;
  tempo: {
    value: number | null;
    /** earlier films with a clear beat grid (confidence ≥ 0.2) within 1.5% of it */
    same: number;
    withGrid: number;
    /** how many earlier films sit at each tempo (rounded), most first */
    spread: { bpm: number; films: number }[];
  };
  key: {
    value: string | null;
    correlation: number | null;
    same: number;
    /** the same key or its relative major/minor */
    sameOrRelative: number;
    spread: { key: string; films: number }[];
  };
  lowPattern: { value: string | null; same: number; spread: { pattern: string; films: number }[] };
};

const RELATIVE: Record<string, string> = {};
{
  const notes = ["C", "C#", "D", "Eb", "E", "F", "F#", "G", "Ab", "A", "Bb", "B"];
  notes.forEach((n, i) => {
    const major = `${notes[(i + 3) % 12]} major`;
    RELATIVE[`${n} minor`] = major;
    RELATIVE[major] = `${n} minor`;
  });
}

const spreadOf = <T extends string | number>(xs: T[]) =>
  [...xs.reduce((m, x) => m.set(x, (m.get(x) ?? 0) + 1), new Map<T, number>())].sort(
    (a, b) => b[1] - a[1],
  );

/** this film's tempo, key and low-end pattern counted against the corpus:
 *  how many earlier films share each — information, never a judgement */
export function inertiaOf(
  input: string,
  tempo: number | null,
  key: { name: string; correlation: number } | null,
  pattern: string | null,
  corpus: ScoreCorpusFilm[] = (scoreCorpus as { films: ScoreCorpusFilm[] }).films,
): Inertia {
  const path = input.replaceAll("\\", "/");
  const self = corpus.find((f) => path.endsWith(`/${f.id}/film.mp4`))?.id ?? null;
  const films = corpus.filter((f) => f.id !== self);
  const grid = films.filter((f) => f.bpm != null && f.tempoConfidence >= 0.2);
  return {
    how: films.length ? "estimated" : "not measured",
    of: films.length,
    self,
    tempo: {
      value: tempo,
      same:
        tempo == null ? 0 : grid.filter((f) => Math.abs(f.bpm! - tempo) <= tempo * 0.015).length,
      withGrid: grid.length,
      spread: spreadOf(grid.map((f) => Math.round(f.bpm!))).map(([bpm, n]) => ({ bpm, films: n })),
    },
    key: {
      value: key?.name ?? null,
      correlation: key?.correlation ?? null,
      same: key ? films.filter((f) => f.key === key.name).length : 0,
      sameOrRelative: key
        ? films.filter((f) => f.key === key.name || f.key === RELATIVE[key.name]).length
        : 0,
      spread: spreadOf(films.flatMap((f) => (f.key ? [f.key] : []))).map(([k, n]) => ({
        key: k,
        films: n,
      })),
    },
    lowPattern: {
      value: pattern,
      same: pattern ? films.filter((f) => f.lowPattern === pattern).length : 0,
      spread: spreadOf(films.flatMap((f) => (f.lowPattern ? [f.lowPattern] : []))).map(
        ([p, n]) => ({ pattern: p, films: n }),
      ),
    },
  };
}

export type FilmListenOptions = {
  /** the film (an mp4) or the score alone (a wav, or any sound) */
  input: string;
  /** the folder to write listen.png / listen.md / listen.json into;
   *  default: `<input without extension>.listen/` */
  out?: string;
  /** default: `<input without extension>.events.json` when it exists */
  events?: string;
  /** a folder of stems (one sound file each, the score's parts) */
  stems?: string;
  /** solo/<stem>.m4a and mute/<stem>.m4a beside the report */
  clips?: boolean;
  /** draws listen.png; without it only the text and data are written */
  chromePath?: string;
  /** the seconds between `film sheet`'s frames, to mark the same times
   *  (default: the sheet's own default for this length) */
  every?: number;
  /** a previous version of the film or its sound (any file ffmpeg reads):
   *  what changed, on the same film time, and A/B clips of where it changed most */
  vs?: string;
};

const SOUND_EXT = new Set([
  ".wav",
  ".mp3",
  ".flac",
  ".ogg",
  ".m4a",
  ".aac",
  ".aif",
  ".aiff",
  ".opus",
]);

export async function filmListen(opts: FilmListenOptions): Promise<{
  png: string | null;
  md: string;
  json: string;
  listen: FilmListen;
}> {
  const input = resolve(opts.input);
  if (!existsSync(input)) throw new Error(`film listen: no file at ${input}`);
  const stem = input.replace(/\.[^./]+$/, "");
  const outDir = resolve(opts.out ?? `${stem}.listen`);
  const [ffmpeg, ffprobe] = await Promise.all([resolveFfmpeg(), resolveFfprobe()]);
  const info = JSON.parse(
    await runTool(ffprobe, [
      "-v",
      "error",
      "-show_entries",
      "stream=codec_type,width,height,r_frame_rate,sample_rate,channels:format=duration",
      "-of",
      "json",
      input,
    ]),
  ) as {
    streams?: {
      codec_type?: string;
      width?: number;
      height?: number;
      r_frame_rate?: string;
      sample_rate?: string;
      channels?: number;
    }[];
    format?: { duration?: string };
  };
  const audio = info.streams?.find((s) => s.codec_type === "audio");
  const video = info.streams?.find((s) => s.codec_type === "video");
  if (!audio) throw new Error(`film listen: ${input} has no sound to listen to`);
  const duration = Number(info.format?.duration ?? 0);
  if (!(duration > 0)) throw new Error(`film listen: ${input} has no duration`);

  const eventsPath = opts.events
    ? resolve(opts.events)
    : existsSync(`${stem}.events.json`)
      ? `${stem}.events.json`
      : null;
  if (opts.events && !existsSync(eventsPath!))
    throw new Error(`film listen: no events file at ${eventsPath}`);
  const evRaw: unknown = eventsPath ? JSON.parse(await readFile(eventsPath, "utf8")) : null;
  const ev = eventsPath ? parseFilmEvents(evRaw) : null;
  const vsPath = opts.vs ? resolve(opts.vs) : null;
  if (vsPath && !existsSync(vsPath)) throw new Error(`film listen: no file at ${vsPath} (--vs)`);

  const stemFiles = opts.stems
    ? (await readdir(resolve(opts.stems)))
        .filter((f) => SOUND_EXT.has(extname(f).toLowerCase()))
        .sort()
        .map((f) => join(resolve(opts.stems!), f))
    : [];
  if (opts.stems && !stemFiles.length)
    throw new Error(`film listen: no sound files in ${resolve(opts.stems)}`);

  // the passes that only read run side by side
  const width = sheetWidth(video?.width, video?.height);
  const plotW = width - GUTTER - PAD;
  // a sound that ends before the picture does is read as silence to the film's
  // end, so every row (the spectrum picture included) spans the same time
  const pad = `apad=whole_dur=${duration}`;
  const tmp = await mkdtemp(join(tmpdir(), "open-take-listen-"));
  try {
    const wantCuts = !ev?.cuts.length && !!video;
    const [loudLog, pcm, stemPcm, pictureCuts] = await Promise.all([
      runTool(
        ffmpeg,
        [
          "-nostats",
          "-v",
          "info",
          "-i",
          input,
          "-vn",
          "-af",
          `${pad},ebur128=peak=true,silencedetect=n=-50dB:d=0.3`,
          "-f",
          "null",
          "-",
        ],
        { stderr: true },
      ),
      decodeMono(ffmpeg, input).then((x) => padTo(x, duration)),
      Promise.all(stemFiles.map((f) => decodeMono(ffmpeg, f))),
      wantCuts ? detectCuts(ffmpeg, input) : Promise.resolve([] as number[]),
      opts.chromePath
        ? runTool(ffmpeg, [
            "-v",
            "error",
            "-i",
            input,
            "-vn",
            "-ac",
            "1",
            "-lavfi",
            `${pad},showspectrumpic=s=${plotW}x${SPEC_H}:legend=0:fscale=log:scale=log:start=30:stop=11000:color=intensity`,
            "-y",
            join(tmp, "spectrum.png"),
          ])
        : Promise.resolve(""),
    ]);

    // loudness, silences
    const summary = loudLog.slice(loudLog.lastIndexOf("Summary:"));
    const num = (re: RegExp) => {
      const m = re.exec(summary);
      return m ? Number(m[1]) : null;
    };
    const momentary: { t: number; lufs: number }[] = [];
    for (const m of loudLog.matchAll(/t:\s*([\d.]+)\s+TARGET:\S+ LUFS\s+M:\s*(-?[\d.]+|-?inf)/g))
      momentary.push({
        t: Number(m[1]),
        lufs: Number.isFinite(Number(m[2])) ? Number(m[2]) : -120,
      });
    const silences: { start: number; end: number }[] = [];
    let open: number | null = null;
    for (const m of loudLog.matchAll(/silence_(start|end): (-?[\d.]+)/g)) {
      if (m[1] === "start") open = Math.max(0, Number(m[2]));
      else if (open != null) {
        silences.push({ start: round2(open), end: round2(Math.min(duration, Number(m[2]))) });
        open = null;
      }
    }
    if (open != null) silences.push({ start: round2(open), end: round2(duration) });
    const dips = quietDips(momentary);

    // the analysis
    const s = spectrum(pcm);
    const env = onsetStrength(s);
    const onsets = pickOnsets(s, env, pcm).map(round3);
    const tempo = estimateTempo(s, env, onsets, duration);
    const sections = findSections(s, onsets, duration);
    const bars = tempo && tempo.beats.length >= 8 ? repeatedBars(s, tempo.beats) : null;

    const events = (ev?.events ?? []).map((e) => ({
      ...e,
      nearestOnset: nearestOffset(onsets, e.t),
    }));
    const cutTimes = ev?.cuts.length ? ev.cuts : pictureCuts;
    const cuts = cutTimes.map((t) => ({ t, nearestOnset: nearestOffset(onsets, t) }));

    // stems
    const laneS = 0.05;
    const stems = stemFiles.map((file, i) => stemActivity(file, stemPcm[i]!, laneS, duration));
    const eventWindows =
      stems.length >= 2
        ? (ev?.events ?? []).flatMap((e) => {
            const w = eventWindow(stemPcm, e.t);
            return w
              ? [{ t: e.t, kind: e.kind, stem: stems[w.stem]!.name, overRestDb: w.overRestDb }]
              : [];
          })
        : [];

    const listen: FilmListen = {
      input,
      duration: round3(duration),
      sampleRate: Number(audio.sample_rate ?? 0),
      channels: Number(audio.channels ?? 0),
      loudness: {
        // ebur128 reports −70 when nothing sounds above its gate
        how: (num(/I:\s+(-?[\d.]+) LUFS/) ?? -70) > -70 ? "measured" : "not detected",
        integratedLufs: num(/I:\s+(-?[\d.]+) LUFS/),
        lra: num(/LRA:\s+(-?[\d.]+) LU/),
        truePeakDb: num(/Peak:\s+(-?[\d.]+) dBFS/),
        momentary,
      },
      onsets: {
        how: onsets.length ? "measured" : "not detected",
        times: onsets,
        perS: round1(onsets.length / duration),
      },
      tempo: { how: tempo ? "estimated" : "not detected", value: tempo },
      sections: { how: "estimated", list: sections },
      bars: bars
        ? { how: "estimated", value: bars }
        : { how: "not measured", value: null, note: "no beat grid to count bars on" },
      silences: { how: "measured", list: silences },
      dips: { how: "measured", list: dips },
      events: {
        how: !ev ? "not measured" : events.length ? "measured" : "not detected",
        file: eventsPath,
        list: events,
        unvoiced: events.filter((e) => e.nearestOnset == null || Math.abs(e.nearestOnset) > 0.04),
        chance40: chanceWithin(onsets, duration),
      },
      cuts: {
        how: cuts.length ? "measured" : ev || video ? "not detected" : "not measured",
        source: ev?.cuts.length ? "events" : pictureCuts.length ? "picture" : "none",
        list: cuts,
      },
      stems: {
        how: stems.length ? "measured" : "not measured",
        dir: opts.stems ? resolve(opts.stems) : null,
        list: stems,
        laneS,
        eventWindows,
      },
      curves: ev?.curves ?? { names: [], t0: 0, dt: 1 / 60, rows: [] },
      clips: [],
      timbre: { how: "not measured" },
    };

    const credits = creditLines(evRaw);
    if (credits) listen.credits = credits;

    await mkdir(outDir, { recursive: true });
    if (opts.clips && stemFiles.length) listen.clips = await writeClips(ffmpeg, stemFiles, outDir);
    if (vsPath)
      listen.vs = await listenVs({
        ffmpeg,
        ffprobe,
        input,
        previous: vsPath,
        outDir,
        listen,
        pcm,
        s,
        env,
      });
    const md = join(outDir, "listen.md");
    const json = join(outDir, "listen.json");
    await writeFile(md, `${formatFilmListen(listen)}\n`);
    await writeFile(json, `${JSON.stringify(listen)}\n`);
    let png: string | null = null;
    if (opts.chromePath) {
      png = join(outDir, "listen.png");
      await drawListen(listen, {
        chromePath: opts.chromePath,
        tmp,
        out: png,
        width,
        plotW,
        env,
        hopS: s.hopS,
        every: opts.every ?? defaultSheetEvery(duration),
        fps: frameRate(video?.r_frame_rate),
      });
    }
    return { png, md, json, listen };
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

/** silence after the sound's end, up to the film's length */
function padTo(pcm: Float32Array, duration: number): Float32Array {
  const n = Math.round(duration * LISTEN_RATE);
  if (pcm.length >= n) return pcm;
  const out = new Float32Array(n);
  out.set(pcm);
  return out;
}

/** hard cuts read from the picture (scene change ≥ 0.3 on a small grey copy),
 *  for a film with no events file saying where they are */
async function detectCuts(ffmpeg: string, file: string): Promise<number[]> {
  const log = await runTool(
    ffmpeg,
    [
      "-v",
      "info",
      "-nostats",
      "-i",
      file,
      "-an",
      "-vf",
      "scale=160:-2,format=gray,select='gt(scene,0.3)',showinfo",
      "-f",
      "null",
      "-",
    ],
    { stderr: true },
  ).catch(() => "");
  return [...log.matchAll(/pts_time:\s*([\d.]+)/g)].map((m) => round3(Number(m[1])));
}

/** stretches of at least 0.3 s whose momentary loudness sits 15 LU or more
 *  under the film's median (a breath in the sound, not silence) */
function quietDips(
  m: { t: number; lufs: number }[],
): { start: number; end: number; belowLu: number }[] {
  const sounding = m.filter((p) => p.lufs > -70).map((p) => p.lufs);
  if (!sounding.length) return [];
  const mid = median(sounding);
  const out: { start: number; end: number; belowLu: number }[] = [];
  let start: number | null = null;
  let low = 0;
  for (const p of [...m, { t: Number.POSITIVE_INFINITY, lufs: mid }]) {
    // silence is reported as silence, not as a dip
    const quiet = p.lufs <= mid - 15 && p.lufs > -70;
    if (quiet && start == null) {
      start = p.t;
      low = p.lufs;
    } else if (quiet) low = Math.min(low, p.lufs);
    else if (start != null) {
      const end = Number.isFinite(p.t) ? p.t : m[m.length - 1]!.t;
      // ebur128 stamps the end of each 400 ms window
      if (end - start >= 0.3)
        out.push({
          start: round2(Math.max(0, start - 0.4)),
          end: round2(end - 0.4),
          belowLu: round1(mid - low),
        });
      start = null;
    }
  }
  return out;
}

function stemActivity(file: string, pcm: Float32Array, laneS: number, duration: number) {
  const step = Math.round(LISTEN_RATE * laneS);
  const cells = Math.ceil(duration / laneS);
  const db = new Float32Array(cells).fill(-120);
  let peak = -120;
  for (let c = 0; c < cells; c++) {
    let sq = 0;
    const a = c * step;
    const b = Math.min(pcm.length, a + step);
    for (let i = a; i < b; i++) sq += pcm[i]! * pcm[i]!;
    if (b > a) db[c] = 10 * Math.log10(sq / (b - a) + 1e-12);
    peak = Math.max(peak, db[c]!);
  }
  const gate = Math.max(-60, peak - 40);
  const lane = Array.from(db, (v) => v > gate);
  return {
    name: basename(file).replace(/\.[^.]+$/, ""),
    file,
    activeS: round1(lane.filter(Boolean).length * laneS),
    peakDb: round1(peak),
    lane,
  };
}

/** around an event (20 ms before to 150 ms after), the stem whose level rises
 *  most over the 150 ms before, and how many dB it sits over all the others */
function eventWindow(
  stems: Float32Array[],
  t: number,
): { stem: number; overRestDb: number } | null {
  const rms = (x: Float32Array, a: number, b: number) => {
    const i0 = Math.max(0, Math.round(a * LISTEN_RATE));
    const i1 = Math.min(x.length, Math.round(b * LISTEN_RATE));
    let sq = 0;
    for (let i = i0; i < i1; i++) sq += x[i]! * x[i]!;
    return i1 > i0 ? sq / (i1 - i0) : 0;
  };
  const at = stems.map((x) => rms(x, t - 0.02, t + 0.15));
  const before = stems.map((x) => rms(x, t - 0.17, t - 0.02));
  let best = -1;
  let rise = 3; // dB: less is no sound for this event
  stems.forEach((_, i) => {
    const r = 10 * Math.log10((at[i]! + 1e-12) / (before[i]! + 1e-12));
    if (at[i]! > 1e-9 && r > rise) {
      rise = r;
      best = i;
    }
  });
  if (best < 0) return null;
  const rest = at.reduce((sum, p, i) => (i === best ? sum : sum + p), 0);
  return { stem: best, overRestDb: round1(10 * Math.log10((at[best]! + 1e-12) / (rest + 1e-12))) };
}

async function writeClips(ffmpeg: string, stems: string[], outDir: string): Promise<string[]> {
  await mkdir(join(outDir, "solo"), { recursive: true });
  const written: string[] = [];
  const name = (f: string) => basename(f).replace(/\.[^.]+$/, "");
  await Promise.all(
    stems.map(async (f) => {
      const out = join(outDir, "solo", `${name(f)}.m4a`);
      await runTool(ffmpeg, ["-v", "error", "-i", f, "-c:a", "aac", "-b:a", "160k", "-y", out]);
      written.push(out);
    }),
  );
  if (stems.length >= 2) {
    await mkdir(join(outDir, "mute"), { recursive: true });
    await Promise.all(
      stems.map(async (f) => {
        const others = stems.filter((g) => g !== f);
        const out = join(outDir, "mute", `${name(f)}.m4a`);
        await runTool(ffmpeg, [
          "-v",
          "error",
          ...others.flatMap((g) => ["-i", g]),
          "-filter_complex",
          `amix=inputs=${others.length}:normalize=0:duration=longest`,
          "-c:a",
          "aac",
          "-b:a",
          "160k",
          "-y",
          out,
        ]);
        written.push(out);
      }),
    );
  }
  return written.sort();
}

// --- beside a previous version (--vs) ------------------------------------------------

type Loud = { integratedLufs: number | null; lra: number | null; truePeakDb: number | null };

export type ListenVsMoment = {
  start: number;
  end: number;
  /** spectrumDiff's frame differences, averaged over the stretch (dB) */
  diffDb: number;
  /** dBFS RMS over the stretch */
  levelDb: { this: number; previous: number };
  /** onsets in the stretch with none within 40 ms in the other */
  onlyThis: number;
  onlyPrevious: number;
};

export type ListenVs = {
  previous: string;
  durations: { this: number; previous: number };
  /** the time compared: the longer of the two, the shorter silent after its end */
  duration: number;
  /** where the previous one's onset strength lines up best with this one's, ±2 s
   *  (both are still compared on the same film time) */
  offset: { how: How; seconds: number | null };
  loudness: { how: How; this: Loud; previous: Loud };
  tempo: { how: How; this: number | null; previous: number | null };
  onsets: {
    how: How;
    this: number;
    previous: number;
    /** onset times with none within 40 ms in the other */
    onlyThis: number[];
    onlyPrevious: number[];
  };
  sections: {
    how: How;
    this: number[];
    previous: number[];
    /** boundaries with none within 0.5 s in the other */
    onlyThis: number[];
    onlyPrevious: number[];
  };
  /** the events file's events: an onset within 40 ms in this one and not the previous (gained), or the reverse */
  events: {
    how: How;
    gained: { t: number; kind: string; label?: string }[];
    lost: { t: number; kind: string; label?: string }[];
  };
  /** the 1 s stretches whose spectra differ most (1 dB or more), most first;
   *  typicalDb: the median 1 s stretch's difference, to read them against */
  moments: { how: How; list: ListenVsMoment[]; typicalDb: number };
  /** <out>/vs/: moment-N.this.m4a and moment-N.previous.m4a (the same film time,
   *  1 s either side), aba.m4a (this, previous, this at the first moment) */
  clips: string[];
};

async function loudnessOf(ffmpeg: string, file: string): Promise<Loud> {
  const log = await runTool(
    ffmpeg,
    ["-nostats", "-v", "info", "-i", file, "-vn", "-af", "ebur128=peak=true", "-f", "null", "-"],
    { stderr: true },
  );
  const summary = log.slice(log.lastIndexOf("Summary:"));
  const num = (re: RegExp) => {
    const m = re.exec(summary);
    return m ? Number(m[1]) : null;
  };
  return {
    integratedLufs: num(/I:\s+(-?[\d.]+) LUFS/),
    lra: num(/LRA:\s+(-?[\d.]+) LU/),
    truePeakDb: num(/Peak:\s+(-?[\d.]+) dBFS/),
  };
}

/** the lag (s, positive = the previous one comes later) at which two onset
 *  strengths correlate best within ±maxS, or null when either is flat */
export function bestLag(a: Float32Array, b: Float32Array, hopS: number, maxS = 2): number | null {
  const n = Math.min(a.length, b.length);
  const norm = (x: Float32Array) => {
    let m = 0;
    for (let i = 0; i < n; i++) m += x[i]!;
    m /= n || 1;
    const y = new Float32Array(n);
    let e = 0;
    for (let i = 0; i < n; i++) {
      y[i] = x[i]! - m;
      e += y[i]! * y[i]!;
    }
    return e > 1e-12 ? y : null;
  };
  const p = norm(a);
  const q = norm(b);
  if (!p || !q) return null;
  const maxLag = Math.round(maxS / hopS);
  let best = 0;
  let bestV = Number.NEGATIVE_INFINITY;
  for (let lag = -maxLag; lag <= maxLag; lag++) {
    let v = 0;
    for (let i = Math.max(0, -lag); i < Math.min(n, n - lag); i++) v += p[i]! * q[i + lag]!;
    if (v > bestV || (v === bestV && Math.abs(lag) < Math.abs(best))) {
      bestV = v;
      best = lag;
    }
  }
  return round3(best * hopS);
}

/** per frame, how far two spectra's band energies differ (dB, each floored at
 *  FLOOR_DB): the mean of the largest quarter of the band differences, so a
 *  sound in a few bands counts as much as a broad one; frames past either
 *  one's end count as silence */
export function spectrumDiff(a: Spectrum, b: Spectrum): Float32Array {
  const n = Math.max(a.bands.length, b.bands.length);
  const out = new Float32Array(n);
  const top = Math.max(1, Math.round(BANDS / 4));
  const d = new Float64Array(BANDS);
  for (let f = 0; f < n; f++) {
    for (let k = 0; k < BANDS; k++)
      d[k] = Math.abs(
        Math.max(FLOOR_DB, a.bands[f]?.[k] ?? FLOOR_DB) -
          Math.max(FLOOR_DB, b.bands[f]?.[k] ?? FLOOR_DB),
      );
    d.sort();
    let sum = 0;
    for (let k = BANDS - top; k < BANDS; k++) sum += d[k]!;
    out[f] = sum / top;
  }
  return out;
}

/** every `windowS` stretch, `stepS` apart, with its mean frame difference (dB) */
function stretchDiffs(
  diff: Float32Array,
  hopS: number,
  duration: number,
  windowS: number,
  stepS: number,
): { start: number; end: number; diffDb: number }[] {
  const out: { start: number; end: number; diffDb: number }[] = [];
  const last = Math.max(0, duration - windowS);
  for (let a = 0; a <= last + 1e-9; a += stepS) {
    const b = Math.min(duration, a + windowS);
    const f0 = Math.floor(a / hopS);
    const f1 = Math.min(diff.length, Math.max(f0 + 1, Math.floor(b / hopS)));
    let sum = 0;
    for (let f = f0; f < f1; f++) sum += diff[f]!;
    out.push({ start: round2(a), end: round2(b), diffDb: round1(f1 > f0 ? sum / (f1 - f0) : 0) });
  }
  return out;
}

/** the median of every 1 s stretch's difference: what the two differ by
 *  anywhere, e.g. from encoding twice, to read the moments against */
export function typicalDiff(diff: Float32Array, hopS: number, duration: number): number {
  const xs = stretchDiffs(diff, hopS, duration, 1, 0.25)
    .map((x) => x.diffDb)
    .sort((a, b) => a - b);
  if (!xs.length) return 0;
  const m = xs.length >> 1;
  return round1(xs.length % 2 ? xs[m]! : (xs[m - 1]! + xs[m]!) / 2);
}

/** the stretches of `windowS` whose mean frame difference is largest, at least
 *  `minDb`, none overlapping, most first */
export function changedMoments(
  diff: Float32Array,
  hopS: number,
  duration: number,
  { windowS = 1, stepS = 0.25, minDb = 1, max = 3 } = {},
): { start: number; end: number; diffDb: number }[] {
  const cands = stretchDiffs(diff, hopS, duration, windowS, stepS).filter((c) => c.diffDb >= minDb);
  cands.sort((x, y) => y.diffDb - x.diffDb || x.start - y.start);
  const out: typeof cands = [];
  for (const c of cands) {
    if (out.length >= max) break;
    if (out.every((o) => c.end <= o.start || c.start >= o.end)) out.push(c);
  }
  return out;
}

const rmsDb = (pcm: Float32Array, a: number, b: number) => {
  const i0 = Math.max(0, Math.round(a * LISTEN_RATE));
  const i1 = Math.min(pcm.length, Math.round(b * LISTEN_RATE));
  let sq = 0;
  for (let i = i0; i < i1; i++) sq += pcm[i]! * pcm[i]!;
  return round1(i1 > i0 ? Math.max(-120, 10 * Math.log10(sq / (i1 - i0) + 1e-12)) : -120);
};

const onlyIn = (xs: readonly number[], other: readonly number[], w: number) =>
  xs.filter((t) => {
    const d = nearestOffset(other, t);
    return d == null || Math.abs(d) > w;
  });

async function listenVs(o: {
  ffmpeg: string;
  ffprobe: string;
  input: string;
  previous: string;
  outDir: string;
  listen: FilmListen;
  pcm: Float32Array;
  s: Spectrum;
  env: Float32Array;
}): Promise<ListenVs> {
  const { ffmpeg, listen: l } = o;
  const probed = JSON.parse(
    await runTool(o.ffprobe, [
      "-v",
      "error",
      "-show_entries",
      "stream=codec_type:format=duration",
      "-of",
      "json",
      o.previous,
    ]),
  ) as { streams?: { codec_type?: string }[]; format?: { duration?: string } };
  if (!probed.streams?.some((x) => x.codec_type === "audio"))
    throw new Error(`film listen: ${o.previous} (--vs) has no sound to compare with`);
  const [pcmPrevRaw, loudPrev] = await Promise.all([
    decodeMono(ffmpeg, o.previous),
    loudnessOf(ffmpeg, o.previous),
  ]);
  const durPrev = Number(probed.format?.duration) || pcmPrevRaw.length / LISTEN_RATE;
  const D = Math.max(l.duration, durPrev);
  const pcmThis = padTo(o.pcm, D);
  const pcmPrev = padTo(pcmPrevRaw, D);
  const sThis = pcmThis === o.pcm ? o.s : spectrum(pcmThis);
  const envThis = sThis === o.s ? o.env : onsetStrength(sThis);
  const sPrev = spectrum(pcmPrev);
  const envPrev = onsetStrength(sPrev);
  const onsPrev = pickOnsets(sPrev, envPrev, pcmPrev).map(round3);
  const tempoPrev = estimateTempo(sPrev, envPrev, onsPrev, D);
  const secPrev = findSections(sPrev, onsPrev, D);
  const onsThis = l.onsets.times;
  const W = 0.04;
  const onlyThis = onlyIn(onsThis, onsPrev, W);
  const onlyPrevious = onlyIn(onsPrev, onsThis, W);
  const bThis = l.sections.list.slice(1).map((x) => x.start);
  const bPrev = secPrev.slice(1).map((x) => x.start);
  // a lag read off a handful of onsets is noise, not an offset
  const lag =
    onsThis.length >= 4 && onsPrev.length >= 4 ? bestLag(envThis, envPrev, sThis.hopS) : null;
  const diff = spectrumDiff(sThis, sPrev);
  const typicalDb = typicalDiff(diff, sThis.hopS, D);
  const moments = changedMoments(diff, sThis.hopS, D).map((m) => ({
    ...m,
    levelDb: { this: rmsDb(pcmThis, m.start, m.end), previous: rmsDb(pcmPrev, m.start, m.end) },
    onlyThis: onlyThis.filter((t) => t >= m.start && t < m.end).length,
    onlyPrevious: onlyPrevious.filter((t) => t >= m.start && t < m.end).length,
  }));
  const ev = (e: FilmEvent) =>
    e.label ? { t: e.t, kind: e.kind, label: e.label } : { t: e.t, kind: e.kind };
  const sounded = (d: number | null) => d != null && Math.abs(d) <= W;
  const gained = l.events.list.filter(
    (e) => sounded(e.nearestOnset) && !sounded(nearestOffset(onsPrev, e.t)),
  );
  const lost = l.events.list.filter(
    (e) => !sounded(e.nearestOnset) && sounded(nearestOffset(onsPrev, e.t)),
  );
  const prevSounds = loudPrev.integratedLufs != null && loudPrev.integratedLufs > -70;

  // the clips: the same film time from each, 1 s either side of the stretch
  const clips: string[] = [];
  if (moments.length) {
    const dir = join(o.outDir, "vs");
    await mkdir(dir, { recursive: true });
    const span = (m: { start: number; end: number }) => {
      const a = round2(Math.max(0, m.start - 1));
      return { a, b: round2(Math.min(D, m.end + 1)) };
    };
    const cut = (a: number, b: number) =>
      `apad=whole_dur=${b},atrim=start=${a}:end=${b},asetpts=PTS-STARTPTS`;
    const jobs = moments.flatMap((m, i) => {
      const { a, b } = span(m);
      return [
        [o.input, join(dir, `moment-${i + 1}.this.m4a`), a, b] as const,
        [o.previous, join(dir, `moment-${i + 1}.previous.m4a`), a, b] as const,
      ];
    });
    await Promise.all(
      jobs.map(([src, out, a, b]) =>
        runTool(ffmpeg, [
          "-v",
          "error",
          "-i",
          src,
          "-vn",
          "-af",
          cut(a, b),
          "-c:a",
          "aac",
          "-b:a",
          "192k",
          "-y",
          out,
        ]),
      ),
    );
    clips.push(...jobs.map((j) => j[1]));
    const { a, b } = span(moments[0]!);
    const fmt = "aformat=sample_rates=48000:channel_layouts=stereo";
    const aba = join(dir, "aba.m4a");
    await runTool(ffmpeg, [
      "-v",
      "error",
      "-i",
      o.input,
      "-i",
      o.previous,
      "-filter_complex",
      `[0:a]${cut(a, b)},${fmt},asplit=2[a1][a2];[1:a]${cut(a, b)},${fmt}[b];` +
        `anullsrc=r=48000:cl=stereo,atrim=duration=0.4,asplit=2[g1][g2];` +
        `[a1][g1][b][g2][a2]concat=n=5:v=0:a=1[o]`,
      "-map",
      "[o]",
      "-c:a",
      "aac",
      "-b:a",
      "192k",
      "-y",
      aba,
    ]);
    clips.push(aba);
  }

  return {
    previous: o.previous,
    durations: { this: l.duration, previous: round3(durPrev) },
    duration: round3(D),
    offset: { how: lag == null ? "not detected" : "estimated", seconds: lag },
    loudness: {
      how: l.loudness.how === "measured" || prevSounds ? "measured" : "not detected",
      this: {
        integratedLufs: l.loudness.integratedLufs,
        lra: l.loudness.lra,
        truePeakDb: l.loudness.truePeakDb,
      },
      previous: loudPrev,
    },
    tempo: {
      how: l.tempo.value || tempoPrev ? "estimated" : "not detected",
      this: l.tempo.value?.bpm ?? null,
      previous: tempoPrev?.bpm ?? null,
    },
    onsets: {
      how: onsThis.length || onsPrev.length ? "measured" : "not detected",
      this: onsThis.length,
      previous: onsPrev.length,
      onlyThis,
      onlyPrevious,
    },
    sections: {
      how: "estimated",
      this: bThis,
      previous: bPrev,
      onlyThis: onlyIn(bThis, bPrev, 0.5),
      onlyPrevious: onlyIn(bPrev, bThis, 0.5),
    },
    events: {
      how: !l.events.file ? "not measured" : l.events.list.length ? "measured" : "not detected",
      gained: gained.map(ev),
      lost: lost.map(ev),
    },
    moments: { how: moments.length ? "measured" : "not detected", list: moments, typicalDb },
    clips,
  };
}

function formatListenVs(v: ListenVs): string[] {
  const L: string[] = [];
  const tag = (h: How) => `(${h})`;
  const fmtS = (t: number) => `${t.toFixed(2)}s`;
  const list = (xs: number[], max = 12) =>
    xs.length > max
      ? `${xs.slice(0, max).map(fmtS).join(", ")}, … (${xs.length})`
      : xs.map(fmtS).join(", ");
  const lu = (a: number | null, b: number | null, unit: string) =>
    a == null || b == null
      ? `this ${a ?? "?"}, previous ${b ?? "?"} ${unit}`
      : `this ${a}, previous ${b} ${unit} (${a - b >= 0 ? "+" : ""}${round1(a - b)})`;
  const lvl = (db: number) => (db <= -120 ? "silent" : `${db} dBFS`);
  L.push(`## Beside the previous version — ${basename(v.previous)}`, "");
  L.push(
    `- lengths: this ${fmtS(v.durations.this)}, previous ${fmtS(v.durations.previous)}; compared on the same film time over ${fmtS(v.duration)}, the shorter one silent after its end ${tag("measured")}`,
  );
  L.push(
    v.offset.seconds == null
      ? `- alignment: too few onsets (under 4 in one of the two) to line them up ${tag(v.offset.how)}`
      : v.offset.seconds === 0
        ? `- alignment: the onsets line up best with no shift (searched ±2 s) ${tag(v.offset.how)}`
        : `- alignment: the onsets line up best with the previous one's sound ${Math.round(Math.abs(v.offset.seconds) * 1000)} ms ${v.offset.seconds > 0 ? "later" : "earlier"} than this one's (searched ±2 s); everything below still compares the same film time ${tag(v.offset.how)}`,
  );
  const a = v.loudness.this;
  const b = v.loudness.previous;
  L.push(
    `- loudness: integrated ${lu(a.integratedLufs, b.integratedLufs, "LUFS")}; range ${lu(a.lra, b.lra, "LU")}; true peak ${lu(a.truePeakDb, b.truePeakDb, "dBFS")} ${tag(v.loudness.how)}`,
  );
  L.push(
    v.tempo.this == null && v.tempo.previous == null
      ? `- tempo: neither has a repeating period between 60 and 200 BPM ${tag(v.tempo.how)}`
      : `- tempo: this ${v.tempo.this != null ? `≈ ${v.tempo.this} BPM` : "no grid"}, previous ${v.tempo.previous != null ? `≈ ${v.tempo.previous} BPM` : "no grid"} ${tag(v.tempo.how)}`,
  );
  L.push(
    `- onsets: this ${v.onsets.this}, previous ${v.onsets.previous}; ${v.onsets.onlyThis.length} only in this, ${v.onsets.onlyPrevious.length} only in the previous (none in the other within 40 ms) ${tag(v.onsets.how)}`,
  );
  if (v.onsets.onlyThis.length)
    L.push(`  - only in this: ${list(v.onsets.onlyThis)} ${tag(v.onsets.how)}`);
  if (v.onsets.onlyPrevious.length)
    L.push(`  - only in the previous: ${list(v.onsets.onlyPrevious)} ${tag(v.onsets.how)}`);
  L.push(
    `- section boundaries: this ${v.sections.this.length ? list(v.sections.this) : "none"}; previous ${v.sections.previous.length ? list(v.sections.previous) : "none"}; new (none in the previous within 0.5 s): ${v.sections.onlyThis.length ? list(v.sections.onlyThis) : "none"}; gone: ${v.sections.onlyPrevious.length ? list(v.sections.onlyPrevious) : "none"} ${tag(v.sections.how)}`,
  );
  const evs = (xs: ListenVs["events"]["gained"]) =>
    xs.map((x) => `${fmtS(x.t)} ${x.kind}${x.label ? ` "${x.label}"` : ""}`).join(", ");
  if (v.events.how === "not measured")
    L.push(`- events that gained or lost a sound: no events file ${tag(v.events.how)}`);
  else if (v.events.how === "not detected")
    L.push(`- events: the events file lists none ${tag(v.events.how)}`);
  else {
    L.push(
      `- events that gained a sound (an onset within 40 ms in this, none in the previous): ${v.events.gained.length ? evs(v.events.gained) : "none"} ${tag(v.events.how)}`,
    );
    L.push(
      `- events that lost one (an onset within 40 ms in the previous, none in this): ${v.events.lost.length ? evs(v.events.lost) : "none"} ${tag(v.events.how)}`,
    );
  }
  if (!v.moments.list.length)
    L.push(
      `- where they differ most: no 1 s stretch whose spectra differ by 1 dB or more (per frame the mean of the largest quarter of the 48 band-energy differences) ${tag(v.moments.how)}`,
    );
  else {
    L.push(
      `- where they differ most (1 s stretches; per frame the mean of the largest quarter of the 48 band-energy differences, averaged over the stretch; the median stretch differs by ${v.moments.typicalDb} dB, so a moment near that differs about as much as the two do everywhere, e.g. from encoding):`,
    );
    for (const [i, m] of v.moments.list.entries())
      L.push(
        `  ${i + 1}. ${fmtS(m.start)}–${fmtS(m.end)}: ${m.diffDb} dB; level this ${lvl(m.levelDb.this)}, previous ${lvl(m.levelDb.previous)}; ${m.onlyThis} onset${m.onlyThis === 1 ? "" : "s"} only in this, ${m.onlyPrevious} only in the previous ${tag(v.moments.how)}`,
      );
  }
  if (v.clips.length)
    L.push(
      "",
      "Clips (each moment from both, the same film time, 1 s either side; aba.m4a plays this, the previous, this at the first one; levels as they are, not matched):",
      "",
      ...v.clips.map((f) => `- ${f}`),
    );
  return L;
}

/** the events file's "credits" field as lines. `film render` writes a list of
 *  { what?, by?, licence?, url?, text? } (render.ts FilmCredit); read leniently
 *  besides: a string, a list of strings, other names for the same fields
 *  (title/name/file, author/artist, license, source), or an object of
 *  name → credit; null when there is no such field */
export function creditLines(raw: unknown): string[] | null {
  if (!raw || typeof raw !== "object" || !("credits" in raw)) return null;
  const c = (raw as { credits: unknown }).credits;
  const str = (x: unknown) =>
    typeof x === "string" || typeof x === "number" ? String(x).trim() : "";
  const one = (x: unknown): string => {
    if (typeof x !== "object" || !x) return str(x);
    const o = x as Record<string, unknown>;
    const by = str(o.by) || str(o.author) || str(o.artist);
    const parts = [
      str(o.what) || str(o.title) || str(o.name) || str(o.file),
      by ? `by ${by}` : "",
      str(o.licence) || str(o.license),
      str(o.url) || str(o.source),
    ].filter(Boolean);
    const text = str(o.text);
    // the attribution line as the page wants it shown, after what it credits
    if (text) return parts.length ? `${parts.join(", ")} — "${text}"` : text;
    return parts.length ? parts.join(", ") : JSON.stringify(x);
  };
  const lines = Array.isArray(c)
    ? c.map(one)
    : c && typeof c === "object"
      ? Object.entries(c as Record<string, unknown>).map(([k, x]) => `${k}: ${one(x)}`)
      : [one(c)];
  return lines.filter(Boolean);
}

// --- the text --------------------------------------------------------------------------

/** this grid as the page can have it: kit/cut.js `grid({ bpm, offset })`
 *  (offset: the time of beat 0), with the period as fitted. A tempo that is
 *  not steady has beats that follow the onsets, which an even pulse does not.
 *  Information. */
export function gridOnPage(
  t: Pick<Tempo, "periodS" | "bpm" | "beats"> & { steady?: boolean },
): string {
  const bpm = t.periodS > 0 ? Math.round((60 / t.periodS) * 1000) / 1000 : t.bpm;
  const offset = Math.round((t.beats[0] ?? 0) * 1000) / 1000;
  const what =
    t.steady === false
      ? "gives an even pulse at this tempo from the first beat (these beats follow the onsets where the tempo moves; a beats file keeps them)"
      : "gives this grid (bar, snap, between; its beat 0 is the first beat found, which need not be a bar's first)";
  return `on the page: \`grid({ bpm: ${bpm}, offset: ${offset} })\` in kit/cut.js ${what}; \`film beats\` writes a music file's grid, downbeats included, as a beats file grid() also takes — information, not a limit`;
}

export function formatFilmListen(l: FilmListen): string {
  const L: string[] = [];
  const tag = (h: How) => `(${h})`;
  const fmtS = (t: number) => `${t.toFixed(2)}s`;
  const ms = (d: number | null) =>
    d == null ? "no onset" : `${d >= 0 ? "+" : ""}${Math.round(d * 1000)} ms`;
  L.push(`# film listen — ${basename(l.input)}`, "");
  L.push(
    `duration ${fmtS(l.duration)}, ${l.sampleRate} Hz, ${l.channels} channel${l.channels === 1 ? "" : "s"}`,
    "",
    "Information only: what was measured, what is estimated, what was not found. Nothing here is a target.",
    "",
  );
  L.push("## Loudness", "");
  const lo = l.loudness;
  if (lo.how === "not detected")
    L.push(`- loudness: nothing sounds above ebur128's −70 LUFS gate ${tag(lo.how)}`);
  else
    L.push(
      `- integrated ${lo.integratedLufs ?? "?"} LUFS, loudness range ${lo.lra ?? "?"} LU, true peak ${lo.truePeakDb ?? "?"} dBFS ${tag(lo.how)}`,
    );
  const sounding = lo.momentary.filter((p) => p.lufs > -70);
  if (sounding.length) {
    const vals = sounding.map((p) => p.lufs).sort((a, b) => a - b);
    L.push(
      `- momentary (400 ms): 10th percentile ${round1(vals[Math.floor(vals.length * 0.1)]!)} LUFS, median ${round1(median(vals))}, 90th ${round1(vals[Math.floor(vals.length * 0.9)]!)} ${tag("measured")}`,
    );
  }
  L.push("", "## Rhythm", "");
  L.push(`- onsets: ${l.onsets.times.length} (${l.onsets.perS}/s) ${tag(l.onsets.how)}`);
  const t = l.tempo.value;
  if (t) {
    L.push(
      `- tempo ≈ ${t.bpm} BPM, periodicity strength ${t.strength} (autocorrelation of onset strength at that period over zero lag) ${tag("estimated")}`,
    );
    if (t.alternatives.length)
      L.push(
        `- also repeating at: ${t.alternatives.map((a) => `${a.bpm} BPM (${a.strength})`).join(", ")} ${tag("estimated")}`,
      );
    L.push(
      `- beat grid: ${t.beats.length} beats from ${fmtS(t.beats[0] ?? 0)}; ${Math.round(t.gridFit * 100)}% of beats have an onset within 40 ms ${tag("estimated")}`,
    );
    L.push(`- ${gridOnPage(t)}`);
  } else L.push(`- tempo: no repeating period between 60 and 200 BPM ${tag("not detected")}`);
  const b = l.bars.value;
  if (b) {
    L.push(
      `- bars of ${b.beatsPerBar} beats on that grid: ${b.bars}; ${b.repeats.length} repeat an earlier bar verbatim (same band energies within 1.5 dB, correlation ≥ 0.95) ${tag("estimated")}`,
    );
    if (b.longestRun)
      L.push(
        `- longest repeated stretch: bars ${b.longestRun.from}–${b.longestRun.to} repeat bars ${b.longestRun.of}–${b.longestRun.of + b.longestRun.to - b.longestRun.from} ${tag("estimated")}`,
      );
    if (b.repeats.length) {
      const groups = new Map<number, number[]>();
      for (const r of b.repeats) groups.set(r.of, [...(groups.get(r.of) ?? []), r.bar]);
      L.push(
        `- which: ${[...groups].map(([of, bars]) => `bar ${of} again at ${bars.join(", ")}`).join("; ")} ${tag("estimated")}`,
      );
    }
  } else L.push(`- repeated bars: ${l.bars.note ?? ""} ${tag(l.bars.how)}`);
  L.push("", "## Sections (where the texture changes)", "");
  for (const [i, s] of l.sections.list.entries())
    L.push(
      `- ${i + 1}. ${fmtS(s.start)}–${fmtS(s.end)}: ${s.levelDb > -120 ? `level ${s.levelDb} dBFS, ${s.onsetsPerS} onsets/s, centroid ${s.centroidHz} Hz` : "silent"}${i ? `, change at start ${s.change} (1 = the sharpest in this film)` : ""} ${tag(l.sections.how)}`,
    );
  L.push("", "## Pauses", "");
  if (l.silences.list.length)
    L.push(
      `- silences (under −50 dBFS for 0.3 s or more): ${l.silences.list.map((s) => `${fmtS(s.start)}–${fmtS(s.end)}`).join(", ")} ${tag("measured")}`,
    );
  else L.push(`- silences (under −50 dBFS for 0.3 s or more): none ${tag("not detected")}`);
  if (l.dips.list.length)
    L.push(
      `- quiet dips (15 LU or more under the median momentary loudness): ${l.dips.list.map((d) => `${fmtS(d.start)}–${fmtS(d.end)} (−${d.belowLu} LU)`).join(", ")} ${tag("measured")}`,
    );
  else
    L.push(
      `- quiet dips (15 LU or more under the median momentary loudness): none ${tag("not detected")}`,
    );

  L.push("", "## Picture events against the sound", "");
  const e = l.events;
  if (!e.file)
    L.push(`- no events file — the page's events were not compared ${tag("not measured")}`);
  else if (!e.list.length) L.push(`- ${basename(e.file)} lists no events ${tag("not detected")}`);
  else {
    const near = e.list.length - e.unvoiced.length;
    L.push(
      `- ${near} of ${e.list.length} events have a sound onset within 40 ms; by chance ${Math.round(e.chance40 * 100)}% would (the share of the film within 40 ms of an onset) ${tag("measured")}`,
    );
    const kinds = [...new Set(e.list.map((x) => x.kind))];
    if (kinds.length > 1)
      for (const k of kinds) {
        const all = e.list.filter((x) => x.kind === k);
        const un = e.unvoiced.filter((x) => x.kind === k).length;
        L.push(`  - ${k}: ${all.length - un} of ${all.length} ${tag("measured")}`);
      }
    if (e.unvoiced.length)
      L.push(
        `- no onset within 40 ms: ${e.unvoiced
          .map(
            (x) =>
              `${fmtS(x.t)} ${x.kind}${x.label ? ` "${x.label}"` : ""} (nearest ${ms(x.nearestOnset)})`,
          )
          .join(", ")} ${tag("measured")}`,
      );
  }
  const st = l.stems;
  if (!st.list.length)
    L.push(
      `- how loud each event's sound sits against the music: needs --stems ${tag("not measured")}`,
    );
  else if (st.list.length < 2)
    L.push(
      `- how loud each event's sound sits against the music: needs two or more stems ${tag("not measured")}`,
    );
  else if (!e.list.length)
    L.push(`- event windows: no events to measure at ${tag("not measured")}`);
  else {
    const missing = e.list.length - st.eventWindows.length;
    const byStem = new Map<string, number[]>();
    for (const w of st.eventWindows)
      byStem.set(w.stem, [...(byStem.get(w.stem) ?? []), w.overRestDb]);
    for (const [name, v] of byStem)
      L.push(
        `- events whose sound is in "${name}": ${v.length}; it sits ${fmtDb(median(v))} over the other stems (median; range ${fmtDb(Math.min(...v))} to ${fmtDb(Math.max(...v))}) in the 20 ms before to 150 ms after ${tag("measured")}`,
      );
    if (missing)
      L.push(
        `- ${missing} event${missing === 1 ? "" : "s"} where no stem rises by 3 dB or more ${tag("measured")}`,
      );
    L.push(
      `- per event: ${st.eventWindows.map((w) => `${fmtS(w.t)} ${w.kind} ${w.stem} ${fmtDb(w.overRestDb)}`).join(", ")} ${tag("measured")}`,
    );
  }

  L.push("", "## Cuts against the sound", "");
  const c = l.cuts;
  if (!c.list.length)
    L.push(
      `- no cuts ${c.how === "not measured" ? "known (no picture, no events file)" : "found"} ${tag(c.how)}`,
    );
  else {
    const offs = c.list.map((x) => x.nearestOnset).filter((d): d is number => d != null);
    const within = offs.filter((d) => Math.abs(d) <= 0.04).length;
    L.push(
      `- ${c.list.length} cuts (${c.source === "events" ? "from the events file" : "read from the picture: scene change ≥ 0.3"}); ${within} within 40 ms of an onset, chance ${Math.round(e.chance40 * 100)}% ${tag("measured")}`,
    );
    if (offs.length)
      L.push(
        `- offset to the nearest onset (negative = the sound comes first): median ${ms(median(offs))}, median distance ${Math.round(median(offs.map(Math.abs)) * 1000)} ms ${tag("measured")}`,
      );
    L.push(
      `- each: ${c.list.map((x) => `${fmtS(x.t)} ${ms(x.nearestOnset)}`).join(", ")} ${tag("measured")}`,
    );
  }
  if (st.list.length) {
    L.push("", "## Stems", "");
    for (const s of st.list)
      L.push(
        `- ${s.name}: sounding ${s.activeS}s of ${l.duration.toFixed(1)}s, peak ${s.peakDb} dBFS RMS (50 ms) ${tag("measured")}`,
      );
  }
  if (l.curves.names.length)
    L.push(
      "",
      "## Curves from the page",
      "",
      `- ${l.curves.names.join(", ")} — drawn in listen.png`,
    );
  L.push(
    "",
    "## What it sounds like",
    "",
    `- its instruments, whether it sounds synthesized or recorded, whether the action sounds resemble the product's own: nothing here hears timbre ${tag(l.timbre.how)}`,
  );
  if (l.clips.length) L.push("", "## Clips", "", ...l.clips.map((f) => `- ${f}`));
  if (l.vs) L.push("", ...formatListenVs(l.vs));
  if (l.credits) {
    L.push("", "## Credits (as the events file lists them)", "");
    if (l.credits.length) L.push(...l.credits.map((c) => `- ${c}`));
    else L.push(`- the "credits" field is empty ${tag("not detected")}`);
  }
  return L.join("\n");
}

const fmtDb = (v: number) => `${v >= 0 ? "+" : ""}${v.toFixed(1)} dB`;

// --- the picture -------------------------------------------------------------------------

const GUTTER = 120;
const PAD = 6;
const SPEC_H = 280;

/** `film sheet`'s width for a film of this shape, so the two lie one above the other */
function sheetWidth(w?: number, h?: number): number {
  const landscape = !(w && h) || w >= h;
  const columns = landscape ? 6 : 10;
  const tileW = landscape ? 480 : 216;
  return columns * tileW + (columns + 1) * 6;
}

/** the times `film sheet` shows frames at: every `every` s, and the last frame
 *  when it falls more than half a step after the last of them */
function sheetFrameTimes(duration: number, every: number, fps: number): number[] {
  const last = Math.max(0, duration - 1.5 / fps);
  const times = Array.from(
    { length: Math.floor(last / every) + 1 },
    (_, i) => Math.round(i * every * 1000) / 1000,
  );
  if (last - times[times.length - 1]! > every / 2) times.push(Math.round(last * 1000) / 1000);
  return times;
}

const frameRate = (r?: string) => {
  const [n, d] = String(r ?? "60/1")
    .split("/")
    .map(Number);
  return n && d ? n / d : 60;
};

/** `film sheet`'s default seconds between frames */
const defaultSheetEvery = (duration: number) => Math.max(0.25, Math.round((duration / 48) * 4) / 4);

const KIND_COLORS = [
  "#d9480f",
  "#1971c2",
  "#2f9e44",
  "#ae3ec9",
  "#f08c00",
  "#0c8599",
  "#e03131",
  "#5c7cfa",
];

async function drawListen(
  l: FilmListen,
  o: {
    chromePath: string;
    tmp: string;
    out: string;
    width: number;
    plotW: number;
    env: Float32Array;
    hopS: number;
    every: number;
    fps: number;
  },
): Promise<void> {
  const D = l.duration;
  const W = o.plotW;
  const x = (t: number) => round1((Math.max(0, Math.min(D, t)) / D) * W);
  const rows: { label: string; h: number; svg: string }[] = [];
  const esc = (s: string) => s.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);

  // the sheet's frame times
  const sheetTimes = sheetFrameTimes(D, o.every, o.fps);
  const labelEvery = Math.max(1, Math.ceil((sheetTimes.length * 46) / W));
  rows.push({
    label: "sheet times",
    h: 26,
    svg: sheetTimes
      .map(
        (t, i) =>
          `<line x1="${x(t)}" x2="${x(t)}" y1="${i % labelEvery ? 18 : 12}" y2="26" stroke="#555"/>` +
          (i % labelEvery
            ? ""
            : `<text x="${x(t) + 2}" y="10" class="s">${t < 60 ? `${t.toFixed(t % 1 ? 2 : 0)}s` : `${Math.floor(t / 60)}:${(t % 60).toFixed(1).padStart(4, "0")}`}</text>`),
      )
      .join(""),
  });
  rows.push({
    label: "spectrum<br><small>30 Hz–11 kHz, log</small>",
    h: SPEC_H,
    svg: `<image href="spectrum.png" x="0" y="0" width="${W}" height="${SPEC_H}" preserveAspectRatio="none"/>`,
  });
  // momentary loudness, −60..0 LUFS
  {
    const H = 130;
    const y = (v: number) => round1(H - ((Math.max(-60, Math.min(0, v)) + 60) / 60) * H);
    const grid = [-10, -20, -30, -40, -50]
      .map(
        (v) =>
          `<line x1="0" x2="${W}" y1="${y(v)}" y2="${y(v)}" stroke="#e5e5e5"/><text x="2" y="${y(v) - 2}" class="s">${v}</text>`,
      )
      .join("");
    const pts = l.loudness.momentary
      .map((p) => `${x(Math.max(0, p.t - 0.2))},${y(p.lufs)}`)
      .join(" ");
    const I = l.loudness.integratedLufs;
    rows.push({
      label: `loudness<br><small>momentary LUFS${I != null ? `<br>I ${I}` : ""}</small>`,
      h: H,
      svg:
        grid +
        (I != null
          ? `<line x1="0" x2="${W}" y1="${y(I)}" y2="${y(I)}" stroke="#d9480f" stroke-dasharray="6 4"/>`
          : "") +
        `<polyline points="${pts}" fill="none" stroke="#222" stroke-width="1.5"/>`,
    });
  }
  // onset strength, onsets, beat grid
  {
    const H = 70;
    const max = Math.max(1e-6, ...o.env);
    const step = Math.max(1, Math.floor(o.env.length / (W * 2)));
    let path = "";
    for (let f = 0; f < o.env.length; f += step) {
      let v = 0;
      for (let k = f; k < Math.min(o.env.length, f + step); k++) v = Math.max(v, o.env[k]!);
      path += `${x(f * o.hopS + WIN / 2 / LISTEN_RATE)},${round1(H - (v / max) * (H - 14))} `;
    }
    const beats = (l.tempo.value?.beats ?? [])
      .map(
        (b, i) =>
          `<line x1="${x(b)}" x2="${x(b)}" y1="0" y2="${i % 4 ? 6 : 12}" stroke="#1971c2"/>`,
      )
      .join("");
    const ticks = l.onsets.times
      .map((t) => `<line x1="${x(t)}" x2="${x(t)}" y1="${H - 5}" y2="${H}" stroke="#d9480f"/>`)
      .join("");
    rows.push({
      label: `onsets<br><small>${l.tempo.value ? `grid ${l.tempo.value.bpm} BPM` : "no grid"}</small>`,
      h: H,
      svg: `<polyline points="${path}" fill="none" stroke="#888"/>${beats}${ticks}`,
    });
  }
  // sections
  rows.push({
    label: "sections",
    h: 26,
    svg: l.sections.list
      .map(
        (s, i) =>
          `<rect x="${x(s.start)}" y="2" width="${Math.max(1, x(s.end) - x(s.start) - 1)}" height="22" fill="${i % 2 ? "#dbe4ff" : "#fff3bf"}"/><text x="${x(s.start) + 4}" y="17" class="m">${i + 1}</text>`,
      )
      .join(""),
  });
  // stems
  for (const s of l.stems.list) {
    let svg = "";
    let run: number | null = null;
    s.lane.forEach((on, i) => {
      if (on && run == null) run = i;
      if ((!on || i === s.lane.length - 1) && run != null) {
        const end = on ? i + 1 : i;
        svg += `<rect x="${x(run * l.stems.laneS)}" y="3" width="${Math.max(1, x(end * l.stems.laneS) - x(run * l.stems.laneS))}" height="14" fill="#495057"/>`;
        run = null;
      }
    });
    rows.push({ label: `<small>${esc(s.name)}</small>`, h: 20, svg });
  }
  // events by kind, cuts
  const kinds = [...new Set(l.events.list.map((e) => e.kind))];
  const color = (k: string) => KIND_COLORS[kinds.indexOf(k) % KIND_COLORS.length]!;
  if (l.events.list.length) {
    const H = 18 * Math.max(1, kinds.length);
    rows.push({
      label: `events<br><small>${kinds.map((k) => `<span style="color:${color(k)}">${esc(k)}</span>`).join(" ")}</small>`,
      h: H,
      svg: l.events.list
        .map((e) => {
          const r = kinds.indexOf(e.kind);
          const miss = e.nearestOnset == null || Math.abs(e.nearestOnset) > 0.04;
          return `<line x1="${x(e.t)}" x2="${x(e.t)}" y1="${r * 18 + 2}" y2="${r * 18 + 16}" stroke="${color(e.kind)}" stroke-width="${miss ? 1 : 2.5}"${miss ? ' stroke-dasharray="2 2"' : ""}/>`;
        })
        .join(""),
    });
  }
  // curves, each scaled to its own range
  const cv = l.curves;
  for (const [j, name] of cv.names.entries()) {
    const vals = cv.rows.map((r) => r[j]!).filter(Number.isFinite);
    if (!vals.length) continue;
    const lo = Math.min(...vals);
    const hi = Math.max(...vals);
    const H = 44;
    const step = Math.max(1, Math.floor(cv.rows.length / (W * 2)));
    let pts = "";
    for (let i = 0; i < cv.rows.length; i += step) {
      const v = cv.rows[i]![j]!;
      if (!Number.isFinite(v)) continue;
      pts += `${x(cv.t0 + i * cv.dt)},${round1(H - 3 - ((v - lo) / (hi - lo || 1)) * (H - 6))} `;
    }
    rows.push({
      label: `<small>${esc(name)}<br>${fmtNum(lo)}–${fmtNum(hi)}</small>`,
      h: H,
      svg: `<polyline points="${pts}" fill="none" stroke="#7048e8" stroke-width="1.5"/>`,
    });
  }

  const gap = 4;
  let top = PAD;
  const body = rows
    .map((r) => {
      const html = `<div class="row" style="top:${top}px;height:${r.h}px"><div class="lab">${r.label}</div><svg width="${W}" height="${r.h}" style="left:${GUTTER}px">${r.svg}</svg></div>`;
      top += r.h + gap;
      return html;
    })
    .join("");
  const height = top + PAD + 18;
  // cuts and silences across every row
  const over = `<svg class="over" width="${W}" height="${height - PAD * 2 - 18}" style="left:${GUTTER}px;top:${PAD}px">${l.silences.list
    .map(
      (s) =>
        `<rect x="${x(s.start)}" y="0" width="${Math.max(1, x(s.end) - x(s.start))}" height="100%" fill="#868e96" opacity="0.18"/>`,
    )
    .join("")}${l.cuts.list
    .map(
      (c) =>
        `<line x1="${x(c.t)}" x2="${x(c.t)}" y1="0" y2="100%" stroke="#e03131" stroke-width="1" opacity="0.55"/>`,
    )
    .join("")}</svg>`;
  const legend = `<div class="legend" style="top:${top}px">red lines: cuts (${l.cuts.source === "events" ? "events file" : l.cuts.source === "picture" ? "read from the picture" : "none"}) · grey: silence · onsets: orange ticks, beat grid blue (tall = every 4th) · events: solid = an onset within 40 ms, dashed = none · ${esc(basename(l.input))} ${l.duration.toFixed(2)}s</div>`;
  await writeFile(
    join(o.tmp, "listen.html"),
    `<!doctype html><meta charset="utf-8"><style>
html,body{margin:0;background:#fff}
body{position:relative;width:${o.width}px;height:${height}px;font:12px/1.25 ui-monospace,Menlo,monospace;color:#111}
.row{position:absolute;left:0;width:${o.width}px}
.row svg,.over{position:absolute;top:0}
.row svg{background:#fafafa}
.over{pointer-events:none}
.lab{position:absolute;left:${PAD}px;width:${GUTTER - PAD * 2}px;top:2px;font-weight:600}
small{font-weight:400;color:#555}
.s{font-size:10px;fill:#333}.m{font-size:12px;font-weight:600;fill:#333}
.legend{position:absolute;left:${GUTTER}px;font-size:11px;color:#444}
</style>${body}${over}${legend}`,
  );
  const browser = await launchHtmlBrowser({
    chromePath: o.chromePath,
    url: pathToFileURL(join(o.tmp, "listen.html")).href,
    width: o.width,
    height,
    profilePrefix: "open-take-listen-",
  });
  try {
    // the spectrum decoded, then two frames painted: a screenshot taken sooner
    // came out with the lower rows still showing tiles of the top ones
    await browser.evaluate(
      "new Promise((ok) => { const i = new Image(); i.onload = i.onerror = () => i.decode().catch(() => {}).then(() => requestAnimationFrame(() => requestAnimationFrame(() => ok(0)))); i.src = 'spectrum.png'; })",
    );
    await writeFile(o.out, await browser.screenshot({ format: "png" }));
  } finally {
    await browser.close();
  }
}

const fmtNum = (v: number) => (Math.abs(v) >= 100 ? String(Math.round(v)) : String(round2(v)));

// --- small arithmetic -----------------------------------------------------------------

function median(xs: readonly number[]): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}
const round1 = (v: number) => Math.round(v * 10) / 10;
const round2 = (v: number) => Math.round(v * 100) / 100;
const round3 = (v: number) => Math.round(v * 1000) / 1000;
