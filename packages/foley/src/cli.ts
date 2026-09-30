#!/usr/bin/env node
// open-foley CLI.
//
//   open-foley spot events.json [--out cues.json] [--style cinematic] [--seed 1]
//   open-foley mix cues.json --out foley.wav [--library lib/library.json] [--offset 0]
//   open-foley render events.json --out foley.wav [--style] [--seed] [--library]
//   open-foley score events.json --video in.mp4 --out out.mp4 [--style] [--library]
//   open-foley audition [--out dir] [--library]

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
  type CueSheet,
  type EventSheet,
  FOLEY_ROLES,
  formatSheetIssues,
  validateCueSheet,
  validateEventSheet,
} from "./cues";
import { type Library, loadLibrary, voiceFor } from "./library";
import { mixCues, peakDb, summarize } from "./mix";
import { describePalette } from "./palette";
import { spot } from "./spot";
import { STYLES } from "./style";
import { encodeWav } from "./wav";

const USAGE = `open-foley — foley for agents. It reads the script, not the pixels.

Usage:
  open-foley spot <events.json> [--out cues.json] [--style ${Object.keys(STYLES).join("|")}] [--seed N]
  open-foley mix <cues.json> --out foley.wav [--library library.json] [--offset S]
  open-foley render <events.json> --out foley.wav [--style S] [--seed N] [--library library.json]
  open-foley score <events.json> --video in.mp4 --out out.mp4 [--style S] [--seed N] [--library library.json]
  open-foley audition [--out dir] [--library library.json]
  open-foley palette

An event sheet says what happened on a timeline; spotting turns it into a cue
sheet (which sound, when, how loud); mixing turns the cue sheet into a WAV.
'score' does all three and muxes the stem onto a video (ffmpeg on PATH, or
FOLEY_FFMPEG). 'audition' renders every role's voice so you can hear the
library before scoring anything. 'palette' lists the vetted sound options per
role (what each feels like, which is the default) for choosing a film's sound.`;

const argv = process.argv.slice(2);
const cmd = argv[0];
const positional: string[] = [];
const flags: Record<string, string> = {};
for (let i = 1; i < argv.length; i++) {
  const a = argv[i]!;
  if (a.startsWith("--")) {
    const v = argv[i + 1];
    if (v == null || v.startsWith("--")) die(`${a} requires a value`);
    flags[a] = v;
    i++;
  } else positional.push(a);
}
const flag = (name: string) => flags[name];

function die(msg: string): never {
  process.stderr.write(`open-foley: ${msg}\n`);
  process.exit(1);
}

function readJson(path: string): unknown {
  if (!existsSync(path)) die(`${path} does not exist`);
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    return die(`${path} is not valid JSON: ${(e as Error).message}`);
  }
}

function readEvents(path: string): EventSheet {
  const raw = readJson(path);
  const issues = validateEventSheet(raw);
  if (issues.length) die(`${path} is not an event sheet:\n${formatSheetIssues(issues)}`);
  return raw as EventSheet;
}

function readCues(path: string): CueSheet {
  const raw = readJson(path);
  const issues = validateCueSheet(raw);
  if (issues.length) die(`${path} is not a cue sheet:\n${formatSheetIssues(issues)}`);
  return raw as CueSheet;
}

function library(): Library | undefined {
  const p = flag("--library");
  return p ? loadLibrary(p) : undefined;
}

function seed(): number | undefined {
  const s = flag("--seed");
  if (s == null) return undefined;
  const n = Number(s);
  if (!Number.isInteger(n) || n < 0) die("--seed must be a non-negative integer");
  return n;
}

function writeOut(path: string, data: Buffer | string): void {
  mkdirSync(dirname(resolve(path)), { recursive: true });
  writeFileSync(path, data);
}

function report(sheet: CueSheet): void {
  const rows = summarize(sheet);
  process.stderr.write(
    `${sheet.cues.length} cues over ${sheet.durationS.toFixed(2)}s (style ${sheet.style}, seed ${sheet.seed})\n` +
      rows
        .map(
          (r) =>
            `  ${r.role.padEnd(7)} ×${String(r.count).padStart(3)}  peak ${r.peakDb.toFixed(1)} dBFS`,
        )
        .join("\n") +
      "\n",
  );
}

function ffmpegBin(): string {
  return process.env.FOLEY_FFMPEG || "ffmpeg";
}

if (!cmd || cmd === "--help" || cmd === "-h" || cmd === "help") {
  process.stdout.write(`${USAGE}\n`);
  process.exit(0);
}

if (cmd === "spot") {
  const input = positional[0] ?? die("spot needs an event sheet path");
  const cues = spot(readEvents(input), { style: flag("--style"), seed: seed() });
  const out = flag("--out") ?? input.replace(/\.json$/i, "") + ".cues.json";
  writeOut(out, JSON.stringify(cues, null, 2));
  report(cues);
  process.stderr.write(`wrote ${out}\n`);
} else if (cmd === "mix") {
  const input = positional[0] ?? die("mix needs a cue sheet path");
  const out = flag("--out") ?? die("mix needs --out foley.wav");
  const offsetS = flag("--offset") ? Number(flag("--offset")) : 0;
  const pcm = mixCues(readCues(input), { library: library(), offsetS });
  writeOut(out, encodeWav(pcm));
  process.stderr.write(`wrote ${out} (peak ${peakDb(pcm).toFixed(1)} dBFS)\n`);
} else if (cmd === "render" || cmd === "score") {
  const input = positional[0] ?? die(`${cmd} needs an event sheet path`);
  const out = flag("--out") ?? die(`${cmd} needs --out`);
  const cues = spot(readEvents(input), { style: flag("--style"), seed: seed() });
  const cuesPath = flag("--cues") ?? out.replace(/\.(wav|mp4|mov)$/i, "") + ".cues.json";
  writeOut(cuesPath, JSON.stringify(cues, null, 2));
  const pcm = mixCues(cues, { library: library() });
  report(cues);
  if (cmd === "render") {
    writeOut(out, encodeWav(pcm));
    process.stderr.write(`wrote ${cuesPath}\nwrote ${out} (peak ${peakDb(pcm).toFixed(1)} dBFS)\n`);
  } else {
    const video = flag("--video") ?? die("score needs --video in.mp4");
    if (!existsSync(video)) die(`${video} does not exist`);
    const stem = out.replace(/\.(mp4|mov)$/i, "") + ".foley.wav";
    writeOut(stem, encodeWav(pcm));
    const res = spawnSync(
      ffmpegBin(),
      [
        "-y",
        "-loglevel",
        "error",
        "-i",
        video,
        "-i",
        stem,
        "-map",
        "0:v:0",
        "-map",
        "1:a:0",
        "-c:v",
        "copy",
        "-c:a",
        "aac",
        "-b:a",
        "192k",
        "-shortest",
        "-movflags",
        "+faststart",
        out,
      ],
      { stdio: "inherit" },
    );
    if (res.error)
      die(
        `ffmpeg could not be started (${res.error.message}) — install ffmpeg or set FOLEY_FFMPEG`,
      );
    if (res.status !== 0) die(`ffmpeg exited ${res.status}`);
    process.stderr.write(`wrote ${cuesPath}\nwrote ${stem}\nwrote ${out}\n`);
  }
} else if (cmd === "audition") {
  const dir = flag("--out") ?? "foley-audition";
  const lib = library();
  const sr = 48000;
  mkdirSync(dir, { recursive: true });
  const durations: Record<string, number> = {
    whoosh: 0.5,
    air: 0.5,
    riser: 2.5,
    boom: 2.2,
    chime: 1.8,
  };
  const all: Float32Array[] = [];
  const gapS = 0.7;
  const lines: string[] = [];
  let t = 0;
  for (const role of FOLEY_ROLES) {
    const variants: Float32Array[] = [];
    for (let v = 0; v < 3; v++)
      variants.push(
        voiceFor(
          role,
          {
            sampleRate: sr,
            durationS: durations[role] ?? 0.2,
            pitch: (v - 1) * 1.5,
            seed: 100 + v,
          },
          lib,
        ),
      );
    // each role file: three variants, spaced
    const gap = Math.round(gapS * sr);
    const n = variants.reduce((s, x) => s + x.length + gap, 0);
    const y = new Float32Array(n);
    let p = 0;
    for (const x of variants) {
      y.set(
        x.map((s) => s * 0.5),
        p,
      );
      p += x.length + gap;
    }
    writeFileSync(join(dir, `${role}.wav`), encodeWav({ sampleRate: sr, channels: [y, y] }));
    all.push(y);
    lines.push(`${t.toFixed(1).padStart(5)}s  ${role}`);
    t += n / sr + gapS;
  }
  const total = all.reduce((s, x) => s + x.length + Math.round(gapS * sr), 0);
  const seq = new Float32Array(total);
  let p = 0;
  for (const x of all) {
    seq.set(x, p);
    p += x.length + Math.round(gapS * sr);
  }
  writeFileSync(join(dir, "all.wav"), encodeWav({ sampleRate: sr, channels: [seq, seq] }));
  writeFileSync(
    join(dir, "README.md"),
    `# open-foley audition\n\nEvery role, three variants each (pitch −1.5 / 0 / +1.5 semitones, different seeds), at −6 dB.\n\n\`all.wav\` plays them in this order:\n\n\`\`\`\n${lines.join("\n")}\n\`\`\`\n`,
  );
  process.stderr.write(`wrote ${dir}/ (${FOLEY_ROLES.length} roles + all.wav + README.md)\n`);
} else if (cmd === "palette") {
  process.stdout.write(`${describePalette()}\n`);
} else {
  die(`unknown command ${JSON.stringify(cmd)}\n\n${USAGE}`);
}
