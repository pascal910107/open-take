// frames — beat-aware verification sheets: one tiled contact sheet whose
// sample times come from the REAL camera schedule (cameraRampSchedule), so a
// verifier looks at the HOLD of each beat — never accidentally inside a ramp
// or settle tail and misreads motion as a framing bug. Rows tell the story:
// an intro row (dead-opening check), one row per beat (travel + 4 hold
// samples), a tail row (lingering-ending check). `--beat N` densifies one
// beat into a 10-cell strip with per-cell phase labels instead.
//
// Pure planning (buildFramePlan) is separated from the ffmpeg I/O
// (renderFrames) so the schedule math stays snapshot-testable.

import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  type TakeComposition,
  math,
  resolveFfmpeg,
  resolveFfprobe,
} from "@open-take/compositor";
import { beatLabel } from "./review";
import { type TakePaths, requireTakeFiles } from "./take";

export type FramePhase = "intro" | "travel" | "hold" | "tail";
export type FrameCell = {
  /** sample time on the COMPOSITION timeline, ms (the `beats` vocabulary). */
  tMs: number;
  phase: FramePhase;
};
export type FrameRow = { label: string; cells: FrameCell[] };
export type FramePlan = { rows: FrameRow[]; cols: number; notes: string[] };

const COLS = 5;

/** Per-beat camera windows on the composition timeline, buildBadges-style:
 *  monotone starts (the ramp departure toward the beat), the actual landing,
 *  and where the framing is released (the next beat's departure, or the own
 *  hold's end). */
function beatWindows(comp: TakeComposition): {
  startMs: number;
  arrivedMs: number;
  releaseMs: number;
}[] {
  const ramps = math.cameraRampSchedule(comp);
  let prevStart = 0;
  const starts = comp.events.map((e, i) => {
    const s = Math.max(ramps[i]?.startMs ?? e.zoom.inAtMs, prevStart + 1);
    prevStart = s;
    return s;
  });
  return comp.events.map((e, i) => {
    const arrived = Math.max(e.tMs, ramps[i]?.landMs ?? e.tMs);
    const endOwn = arrived + (e.durationMs ?? 0) + comp.cursor.holdMs;
    const release =
      i < comp.events.length - 1 ? starts[i + 1]! : Math.min(endOwn, comp.durationMs);
    return { startMs: starts[i]!, arrivedMs: arrived, releaseMs: release };
  });
}

const spread = (from: number, to: number, n: number): number[] =>
  Array.from({ length: n }, (_, k) => (n === 1 ? from : from + ((to - from) * k) / (n - 1)));

export function buildFramePlan(comp: TakeComposition, opts: { beat?: number } = {}): FramePlan {
  const wins = beatWindows(comp);
  const notes: string[] = [];
  const endCap = comp.durationMs - 60;

  if (opts.beat != null) {
    const i = opts.beat - 1;
    const e = comp.events[i];
    const w = wins[i];
    if (!e || !w)
      throw new Error(`frames: --beat ${opts.beat} out of range (1-${comp.events.length})`);
    const from = Math.max(comp.startMs ?? 0, w.startMs - 400);
    const to = Math.min(endCap, w.releaseMs + 400);
    const phase = (t: number): FramePhase =>
      t < w.arrivedMs ? "travel" : t <= w.releaseMs ? "hold" : "tail";
    const cells = spread(from, to, COLS * 2).map((t) => ({ tMs: t, phase: phase(t) }));
    const label = `beat ${opts.beat} · ${beatLabel(e)}`;
    return {
      rows: [
        { label: `${label} 1/2`, cells: cells.slice(0, COLS) },
        { label: `${label} 2/2`, cells: cells.slice(COLS) },
      ],
      cols: COLS,
      notes,
    };
  }

  const rows: FrameRow[] = [];
  const trim = comp.startMs ?? 0;
  const introEnd = wins.length ? wins[0]!.startMs - 100 : endCap;
  if (introEnd - trim > 800) {
    rows.push({
      label: "in",
      cells: spread(trim, introEnd, COLS).map((tMs) => ({ tMs, phase: "intro" as const })),
    });
  }
  comp.events.forEach((e, i) => {
    const w = wins[i]!;
    // beats already trimmed off by startMs can't be sampled from the delivered
    // file — say so instead of tiling frame 0 five times.
    if (w.releaseMs <= trim) {
      notes.push(`beat ${i + 1} ends before the startMs head trim — not sampled`);
      return;
    }
    const holdFrom = Math.max(trim, Math.min(w.arrivedMs + 80, endCap));
    const holdTo = Math.max(holdFrom, Math.min(w.releaseMs - 120, endCap));
    const cells: FrameCell[] = [];
    if (w.arrivedMs - w.startMs > 200 && w.startMs >= trim) {
      cells.push({ tMs: (w.startMs + w.arrivedMs) / 2, phase: "travel" });
    }
    const holdN = COLS - cells.length;
    for (const tMs of spread(holdFrom, holdTo, holdN)) cells.push({ tMs, phase: "hold" });
    rows.push({ label: `beat ${i + 1} · ${beatLabel(e)}`, cells });
  });
  const lastRelease = wins.length ? wins[wins.length - 1]!.releaseMs : trim;
  if (comp.durationMs - lastRelease > 800) {
    rows.push({
      label: "out",
      cells: spread(Math.max(trim, lastRelease), endCap, COLS).map((tMs) => ({
        tMs,
        phase: "tail" as const,
      })),
    });
  }
  return { rows, cols: COLS, notes };
}

// --- rendering (ffmpeg I/O) --------------------------------------------------

function run(cmd: string, args: string[]): Promise<string> {
  return new Promise((res, rej) => {
    const c = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    c.stdout.on("data", (d) => {
      out += d;
    });
    c.stderr.on("data", (d) => {
      err += d;
    });
    c.on("error", rej);
    c.on("close", (code) => (code === 0 ? res(out) : rej(new Error(`${cmd} exited ${code}: ${err}`))));
  });
}

async function mp4Duration(path: string): Promise<number> {
  const out = await run(await resolveFfprobe(), [
    "-v",
    "error",
    "-show_entries",
    "format=duration",
    "-of",
    "csv=p=0",
    resolve(path),
  ]);
  const s = Number.parseFloat(out.trim());
  if (!Number.isFinite(s) || s <= 0) throw new Error(`frames: could not read duration of ${path}`);
  return s * 1000;
}

const fmtS = (ms: number): string => `${(ms / 1000).toFixed(1)}s`;

export function buildFrameSheet(
  plan: FramePlan,
  framesPath: string,
  trimMs: number,
  tileW?: number,
): string {
  const lines = [
    `frames: ${framesPath} · ${plan.cols} cols × ${plan.rows.length} rows${tileW ? ` · ${tileW}px tiles` : ""} · times on the composition timeline${trimMs ? ` (head −${(trimMs / 1000).toFixed(1)}s already cut from the mp4)` : ""}`,
  ];
  plan.rows.forEach((r, i) => {
    const cells = r.cells
      .map((c) => (c.phase === "hold" || c.phase === "intro" ? fmtS(c.tMs) : `${fmtS(c.tMs)}(${c.phase})`))
      .join(" · ");
    lines.push(`  row ${i + 1}  ${r.label.padEnd(34, " ")} ${cells}`);
  });
  for (const n of plan.notes) lines.push(`  ⚠ ${n}`);
  lines.push(
    `judge framing/payoff on HOLD cells only — travel cells are mid-motion by design (ramps + blur live there).`,
  );
  return lines.join("\n");
}

export type FramesOpts = {
  /** densify one beat (1-based) into a 10-cell strip */
  beat?: number;
  /** which delivered file to sample (default the master mp4) */
  sourcePath?: string;
  /** tile width in px. Defaults: 480 for the overview, 720 for a --beat strip
   *  (diagnosis wants detail — a 480px tile of a Retina capture is a 1/8-scale
   *  thumbnail: enough to suspect a framing bug, not enough to confirm it). */
  tileWidth?: number;
};

/** Extract the plan's frames from a delivered take mp4 and tile them into
 *  `<base>.frames[.beatN].png`. No Chrome, no render — a handful of ffmpeg
 *  seeks; seconds, not minutes. */
export async function renderFrames(
  take: TakePaths,
  opts: FramesOpts = {},
): Promise<{ framesPath: string; sheet: string; plan: FramePlan }> {
  await requireTakeFiles(take);
  const comp = JSON.parse(await readFile(take.compositionPath, "utf8")) as TakeComposition;
  const src = resolve(opts.sourcePath ?? take.mp4Path);
  if (!(await stat(src).catch(() => null))?.isFile())
    throw new Error(`frames: ${src} not found — render the take first`);
  const plan = buildFramePlan(comp, { beat: opts.beat });
  if (plan.rows.length === 0) throw new Error("frames: nothing to sample (no beats, no intro/tail)");

  const trim = comp.startMs ?? 0;
  const durMs = await mp4Duration(src);
  const ffmpeg = await resolveFfmpeg();
  const framesPath = opts.beat != null ? `${take.base}.frames.beat${opts.beat}.png` : `${take.base}.frames.png`;
  const tileW = Math.round(opts.tileWidth ?? (opts.beat != null ? 720 : 480));
  if (!Number.isFinite(tileW) || tileW < 120 || tileW > 1920)
    throw new Error(`frames: tile width ${tileW} out of range (120-1920)`);
  const tileH = Math.round((tileW * comp.output.height) / comp.output.width);

  const work = await mkdtemp(join(tmpdir(), "open-take-frames-"));
  try {
    const cells = plan.rows.flatMap((r) => r.cells);
    for (let i = 0; i < cells.length; i++) {
      // composition time → delivered-file time; clamp inside the real file so
      // encoder rounding at the tail can't yield an empty extraction.
      const fileMs = Math.min(Math.max(cells[i]!.tMs - trim, 0), durMs - 50);
      await run(ffmpeg, [
        "-y",
        "-loglevel",
        "error",
        "-ss",
        String(fileMs / 1000),
        "-i",
        src,
        "-frames:v",
        "1",
        "-vf",
        `scale=${tileW}:${tileH}`,
        join(work, `f${String(i).padStart(3, "0")}.png`),
      ]);
    }
    await run(ffmpeg, [
      "-y",
      "-loglevel",
      "error",
      "-framerate",
      "1",
      "-i",
      join(work, "f%03d.png"),
      "-frames:v",
      "1",
      "-vf",
      `tile=${plan.cols}x${plan.rows.length}`,
      framesPath,
    ]);
  } finally {
    await rm(work, { recursive: true, force: true });
  }
  return { framesPath, sheet: buildFrameSheet(plan, framesPath, trim, tileW), plan };
}
