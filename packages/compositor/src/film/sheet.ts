// `open-take film sheet`: a film (or any video) as one image — frames on a
// grid, each captioned with its time — for looking at a whole cut at once.

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { resolveFfmpeg, resolveFfprobe } from "../ffmpeg";
import { launchHtmlBrowser } from "../html/cdp";

export type FilmSheetOptions = {
  /** the video */
  input: string;
  /** the PNG to write */
  out: string;
  chromePath: string;
  /** seconds between frames; default: about 48 frames over the film */
  every?: number;
  /** exact times instead (seconds) */
  at?: readonly number[];
  columns?: number;
  /** px per frame across */
  tileWidth?: number;
};

export async function filmSheet(opts: FilmSheetOptions): Promise<{ out: string; times: number[] }> {
  const [ffmpeg, ffprobe] = await Promise.all([resolveFfmpeg(), resolveFfprobe()]);
  const info = JSON.parse(
    await run(ffprobe, [
      "-v",
      "error",
      "-select_streams",
      "v:0",
      "-show_entries",
      "stream=width,height,r_frame_rate:format=duration",
      "-of",
      "json",
      opts.input,
    ]),
  ) as {
    streams?: { width: number; height: number; r_frame_rate?: string }[];
    format?: { duration?: string };
  };
  const duration = Number(info.format?.duration ?? 0);
  const [rn, rd] = String(info.streams?.[0]?.r_frame_rate ?? "60/1")
    .split("/")
    .map(Number);
  const fps = rn && rd ? rn / rd : 60;
  const vw = info.streams?.[0]?.width ?? 16;
  const vh = info.streams?.[0]?.height ?? 9;
  if (!(duration > 0)) throw new Error(`film sheet: ${opts.input} has no duration`);
  const every = opts.every ?? Math.max(0.25, Math.round((duration / 48) * 4) / 4);
  // inside the last frame (a 30 fps draft's last frame starts 1/30 s before the end)
  const last = Math.max(0, duration - 1.5 / fps);
  const times = opts.at?.length
    ? [...opts.at].filter((t) => t >= 0 && t <= duration).sort((a, b) => a - b)
    : Array.from(
        { length: Math.floor(last / every) + 1 },
        (_, i) => Math.round(i * every * 1000) / 1000,
      );
  if (!opts.at?.length && last - times[times.length - 1]! > every / 2)
    times.push(Math.round(last * 1000) / 1000);
  const columns = opts.columns ?? (vw >= vh ? 6 : 10);
  const tileW = opts.tileWidth ?? (vw >= vh ? 480 : 216);
  const tileH = Math.round((tileW * vh) / vw);

  const tmp = await mkdtemp(join(tmpdir(), "open-take-sheet-"));
  try {
    // a time no frame can be read at (past the end, a damaged stretch) is
    // tried a frame earlier, then left out — it never costs the whole sheet
    const got = new Set<number>();
    await Promise.all(
      chunked(times, 6).map(async (group) => {
        for (const t of group) {
          const i = times.indexOf(t);
          const file = join(tmp, `f${String(i).padStart(4, "0")}.jpg`);
          for (const at of [t, Math.max(0, t - 1 / fps)]) {
            await run(ffmpeg, [
              "-v",
              "error",
              "-ss",
              String(at),
              "-i",
              resolve(opts.input),
              "-frames:v",
              "1",
              "-vf",
              `scale=${tileW * 2}:-2`,
              "-q:v",
              "3",
              "-y",
              file,
            ]).catch(() => {});
            if (existsSync(file)) {
              got.add(i);
              break;
            }
          }
        }
      }),
    );
    const kept = times.filter((_, i) => got.has(i));
    if (!kept.length) throw new Error(`film sheet: no frame of ${opts.input} could be read`);
    const rows = Math.ceil(kept.length / columns);
    const gap = 6;
    const caption = 22;
    const width = columns * tileW + (columns + 1) * gap;
    const height = rows * (tileH + caption + gap) + gap;
    const cells = times
      .map((t, i) =>
        got.has(i)
          ? `<figure><img src="f${String(i).padStart(4, "0")}.jpg"><figcaption>${fmt(t)}</figcaption></figure>`
          : "",
      )
      .join("");
    await writeFile(
      join(tmp, "sheet.html"),
      `<!doctype html><meta charset="utf-8"><style>
html,body{margin:0;background:#fff}
body{display:grid;grid-template-columns:repeat(${columns},${tileW}px);gap:${gap}px;padding:${gap}px}
figure{margin:0}img{display:block;width:${tileW}px;height:${tileH}px;object-fit:cover;background:#000}
figcaption{height:${caption}px;font:600 13px/22px ui-monospace,Menlo,monospace;color:#111}
</style>${cells}`,
    );
    const browser = await launchHtmlBrowser({
      chromePath: opts.chromePath,
      url: pathToFileURL(join(tmp, "sheet.html")).href,
      width,
      height,
      profilePrefix: "open-take-sheet-",
    });
    try {
      await browser.evaluate(
        "Promise.all([...document.images].map((i) => i.decode().catch(() => {})))",
      );
      await writeFile(resolve(opts.out), await browser.screenshot({ format: "png" }));
    } finally {
      await browser.close();
    }
    return { out: resolve(opts.out), times: kept };
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

const fmt = (t: number) => {
  const m = Math.floor(t / 60);
  const s = (t - m * 60).toFixed(2).padStart(5, "0");
  return m ? `${m}:${s}` : `${s}s`;
};

function chunked<T>(xs: readonly T[], n: number): T[][] {
  const out: T[][] = Array.from({ length: n }, () => []);
  xs.forEach((x, i) => {
    out[i % n]!.push(x);
  });
  return out.filter((g) => g.length);
}

function run(bin: string, args: string[]): Promise<string> {
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
      code === 0 ? ok(out) : fail(new Error(`${bin} exited ${code}: ${err.slice(-400)}`)),
    );
  });
}
