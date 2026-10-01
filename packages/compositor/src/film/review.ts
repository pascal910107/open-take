// `open-take film review`: what to look at and listen to, gathered in one
// folder — for a reviewer (a person, or a model that can see images) who
// cannot sit through every frame.
//
// It picks moments — the times asked for, every defect `film check` measured,
// every layout problem read from the page (text over text, text into a badge,
// text off the frame), and the longest stretches where nothing cuts or moves
// fast — and for each one writes the real-speed clip with its sound, the WAV,
// and a strip of consecutive frames. review.md indexes them, says why each
// moment was picked, and says what was NOT measured. Nothing here judges taste.

import { spawn } from "node:child_process";
import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { resolveFfmpeg } from "../ffmpeg";
import { launchHtmlBrowser } from "../html/cdp";
import { serveDirectory } from "../html/server";
import {
  audioRhythm,
  checkFilm,
  type FilmCheck,
  formatFilmCheck,
  frameDiffs,
  pcm,
  quietStretches,
} from "./check";
import { filmClockSource } from "./clock";
import { type LayoutFinding, layoutProbeSource } from "./layout";
import { resolveFilmPage } from "./render";
import { filmSheet } from "./sheet";

export type FilmReviewOptions = {
  /** the finished film */
  film: string;
  chromePath: string;
  /** the folder to write (default: <film>.review/) */
  out?: string;
  /** the film's page: its layout is checked too */
  page?: string;
  root?: string;
  /** extra moments to include (seconds) */
  at?: readonly number[];
  /** seconds of real-speed clip around each moment (default 2) */
  clip?: number;
  /** seconds the frame strip spans (default 0.5) and how many frames (default 8) */
  span?: number;
  frames?: number;
  /** seconds between layout samples (default 0.25) */
  every?: number;
};

export type LayoutSpan = LayoutFinding & { from: number; to: number };

export type ReviewMoment = {
  t: number;
  why: string[];
  clip: string;
  wav: string;
  strip: string;
};

export type FilmReview = {
  dir: string;
  index: string;
  moments: ReviewMoment[];
  layout: LayoutSpan[] | null;
  check: FilmCheck;
};

const MAX_MOMENTS = 14;

export async function filmReview(opts: FilmReviewOptions): Promise<FilmReview> {
  const film = resolve(opts.film);
  const dir = resolve(opts.out ?? film.replace(/\.[^./]+$/, "") + ".review");
  await mkdir(dir, { recursive: true });
  // a previous review's files (only ours) go first: moments are numbered by time
  for (const f of await readdir(dir))
    if (
      /^m\d+-[\d.]+s(-frames\.png|\.mp4|\.wav)$/.test(f) ||
      f === "review.md" ||
      f === "sheet.png"
    )
      await rm(join(dir, f), { force: true });
  const ffmpeg = await resolveFfmpeg();
  const clip = opts.clip ?? 2;
  const span = opts.span ?? 0.5;
  const frames = opts.frames ?? 8;

  const check = await checkFilm(film);
  const fps = check.video?.fps || 60;
  const quiet = quietStretches(await frameDiffs(ffmpeg, film), fps).slice(0, 2);
  const rhythm = check.audio ? audioRhythm(await pcm(ffmpeg, film), 48_000) : null;
  const layout = opts.page ? await pageLayout(opts, check.durationS) : null;

  // the moments, each with every reason it was picked
  const picked = new Map<number, string[]>();
  const add = (t: number, why: string) => {
    const key =
      Math.round(Math.min(Math.max(0, t), Math.max(0, check.durationS - 0.05)) * 100) / 100;
    const near = [...picked.keys()].find((k) => Math.abs(k - key) < clip / 2);
    if (near !== undefined) picked.get(near)!.push(why);
    else picked.set(key, [why]);
  };
  for (const t of opts.at ?? []) add(t, "asked for");
  for (const t of check.stalls) add(t, "a frame repeats inside motion (measured)");
  for (const c of check.cadence)
    add(c.at, `still/moving frames alternate for ${c.frames} frames (measured)`);
  for (const b of check.black)
    if (b.start > 0.05 && b.end < check.durationS - 0.05)
      add(b.start, "black frames inside the film (measured)");
  for (const t of check.clicks) add(t, "a possible click in the sound (measured)");
  for (const l of layout ?? []) add((l.from + l.to) / 2, `layout: ${l.a}`);
  for (const q of quiet)
    add(
      q.start + Math.min(1, (q.end - q.start) / 2),
      `${(q.end - q.start).toFixed(1)} s with no hard cut and no fast motion (${q.start}–${q.end} s)`,
    );
  const moments: ReviewMoment[] = [];
  const { kept: times, left } = packMoments(picked, MAX_MOMENTS);
  let k = 0;
  for (const t of times) {
    k++;
    const stem = join(dir, `m${String(k).padStart(2, "0")}-${t.toFixed(2)}s`);
    const from = Math.max(0, t - clip / 2);
    await run(ffmpeg, [
      "-v",
      "error",
      "-y",
      "-ss",
      String(from),
      "-t",
      String(clip),
      "-i",
      film,
      "-c:v",
      "libx264",
      "-preset",
      "veryfast",
      "-crf",
      "18",
      "-pix_fmt",
      "yuv420p",
      "-c:a",
      "aac",
      "-b:a",
      "192k",
      `${stem}.mp4`,
    ]);
    await run(ffmpeg, [
      "-v",
      "error",
      "-y",
      "-ss",
      String(from),
      "-t",
      String(clip),
      "-i",
      film,
      "-vn",
      "-ac",
      "2",
      "-ar",
      "48000",
      "-c:a",
      "pcm_s16le",
      `${stem}.wav`,
    ]).catch(() => {});
    await run(ffmpeg, [
      "-v",
      "error",
      "-y",
      "-ss",
      String(Math.max(0, t - span / 2)),
      "-t",
      String(span),
      "-i",
      film,
      "-vf",
      `fps=${frames / span},scale=480:-2,tile=${frames}x1:padding=4:color=white`,
      "-frames:v",
      "1",
      `${stem}-frames.png`,
    ]);
    moments.push({
      t,
      why: picked.get(t)!,
      clip: `${stem}.mp4`,
      wav: `${stem}.wav`,
      strip: `${stem}-frames.png`,
    });
  }
  const sheet = await filmSheet({
    input: film,
    out: join(dir, "sheet.png"),
    chromePath: opts.chromePath,
  }).catch(() => null);

  const md = [
    `# Review: ${basename(film)}`,
    "",
    "What to look at and listen to. Nothing here judges taste: every moment below was picked by a measurement or by the page's layout, and says which.",
    "",
    "## The film",
    "",
    "```",
    formatFilmCheck(check),
    "```",
    sheet ? `\nWhole film on one sheet: ${basename(sheet.out)}` : "",
    "",
    "## Moments",
    "",
    "| time | why | clip (real speed, with sound) | sound | frames |",
    "| --- | --- | --- | --- | --- |",
    ...moments.map(
      (m) =>
        `| ${m.t.toFixed(2)} s | ${compactWhy(m.why).join("; ")} | ${basename(m.clip)} | ${basename(m.wav)} | ${basename(m.strip)} (${frames} frames over ${span} s) |`,
    ),
    left.length
      ? `\n${left.length} more moment${left.length === 1 ? "" : "s"} did not fit in the pack (it holds ${MAX_MOMENTS}): ${left.map((t) => `${t.toFixed(2)} s (${compactWhy(picked.get(t)!).join("; ")})`).join(", ")} — ask for any of them with --at.`
      : "",
    "",
    "## Layout",
    "",
    layout === null
      ? "Not checked — pass the film's page (`--page`) to read its layout."
      : layout.length
        ? groupLayout(layout).join("\n")
        : `No text over text, text into a badge or text off the frame, sampled every ${opts.every ?? 0.25} s.`,
    "",
    "## Measurements (to explain, not to judge)",
    "",
    `- hard cuts: ${check.cuts.length ? check.cuts.join(", ") + " s" : "none"} — dissolves and other soft transitions are not counted`,
    `- longest stretches with no hard cut and no fast motion: ${quiet.map((q) => `${q.start}–${q.end} s (${(q.end - q.start).toFixed(1)} s)`).join(", ") || "none"} — a slow push or a dissolve counts as quiet; whether it reads as calm or as nothing happening is a judgement`,
    rhythm
      ? `- sound: ${rhythm.onsetsPerSec} onsets per second (attacks: hits, plucks, keys); pulse ${rhythm.pulseBpm} BPM, clarity ${rhythm.pulseClarity} (0 none … 1 a metronome) — a measure of beat, not of whether the music serves the film`
      : "- sound: none",
    "",
    "## Not measured",
    "",
    "- How the sound sounds: only loudness, peaks, clicks and pulse were measured. Listen to the WAVs.",
    "- Whether motion reads well: the measurements count change, not intention. Watch the clips.",
    "- Layout beyond overlaps and the frame edge: contrast, crowding, legibility and alignment are not checked.",
    "- Text inside a canvas or a video (it is pixels, not text).",
    "",
  ].join("\n");
  const index = join(dir, "review.md");
  await writeFile(index, md);
  return { dir, index, moments, layout, check };
}

/** Which moments go into a pack that holds `max`: what was asked for first,
 *  then measured defects, then the (at most two) longest quiet stretches —
 *  where a film goes flat, which no other measure points at — then layout
 *  problems. A kind that does not fit spreads over the whole film rather than
 *  taking its earliest moments. Returns both, in time order. */
export function packMoments(
  picked: Map<number, string[]>,
  max: number,
): { kept: number[]; left: number[] } {
  const rank = (why: string[]) =>
    Math.min(
      ...why.map((w) =>
        w === "asked for" ? 0 : / with no hard cut /.test(w) ? 2 : w.startsWith("layout:") ? 3 : 1,
      ),
    );
  const all = [...picked.keys()].sort((a, b) => a - b);
  const kept: number[] = [];
  for (let r = 0; r <= 3 && kept.length < max; r++) {
    const tier = all.filter((t) => rank(picked.get(t)!) === r);
    const room = max - kept.length;
    if (tier.length <= room) kept.push(...tier);
    else
      for (let i = 0; i < room; i++)
        kept.push(tier[Math.round((i * (tier.length - 1)) / Math.max(1, room - 1))]!);
  }
  kept.sort((a, b) => a - b);
  return { kept, left: all.filter((t) => !kept.includes(t)) };
}

/** A moment's reasons, a layout problem named once per piece of text. */
function compactWhy(why: string[]): string[] {
  const out: string[] = [];
  for (const w of why) {
    const text = w.startsWith("layout: ") ? `${w.slice(8)} runs into something (see Layout)` : w;
    if (!out.includes(text)) out.push(text);
  }
  return out;
}

/** One line per piece of text and stretch of time, naming what it collides with. */
function groupLayout(spans: LayoutSpan[]): string[] {
  const groups: { a: string; from: number; to: number; hits: Set<string>; kinds: Set<string> }[] =
    [];
  for (const l of spans) {
    const g = groups.find((x) => x.a === l.a && l.from <= x.to + 0.3 && l.to >= x.from - 0.3);
    const hit = l.kind === "text-off-frame" ? "the frame's edge" : (l.b ?? "");
    if (g) {
      g.from = Math.min(g.from, l.from);
      g.to = Math.max(g.to, l.to);
      g.hits.add(hit);
      g.kinds.add(l.kind);
    } else
      groups.push({
        a: l.a,
        from: l.from,
        to: l.to,
        hits: new Set([hit]),
        kinds: new Set([l.kind]),
      });
  }
  return groups.map((g) => {
    const hits = [...g.hits];
    const shown =
      hits.slice(0, 4).join("; ") + (hits.length > 4 ? `; and ${hits.length - 4} more` : "");
    return `- ${g.from.toFixed(2)}–${g.to.toFixed(2)} s · ${g.a} runs into: ${shown}`;
  });
}

/** Sample the page's layout over the film; a finding that holds for at least
 *  two samples in a row becomes a span (an entrance sliding past an edge for a
 *  moment does not). */
async function pageLayout(opts: FilmReviewOptions, duration: number): Promise<LayoutSpan[]> {
  const { root, urlPath } = resolveFilmPage(opts.page!, opts.root);
  const server = await serveDirectory(root);
  const every = opts.every ?? 0.25;
  try {
    const probe = await launchHtmlBrowser({
      chromePath: opts.chromePath,
      url: `${server.url}${urlPath}`,
      width: 1920,
      height: 1080,
      initScript: filmClockSource({ seed: 0x5eed, epochMs: Date.now() }),
      profilePrefix: "open-take-review-",
      timeoutMs: 120_000,
    });
    let browser = probe;
    try {
      const info = await browser.evaluate<{ width: number | null; height: number | null }>(
        "window.__ot.prepare()",
        {
          timeoutMs: 120_000,
        },
      );
      if (info.width && info.height && (info.width !== 1920 || info.height !== 1080)) {
        await browser.close();
        browser = await launchHtmlBrowser({
          chromePath: opts.chromePath,
          url: `${server.url}${urlPath}`,
          width: info.width,
          height: info.height,
          initScript: filmClockSource({ seed: 0x5eed, epochMs: Date.now() }),
          profilePrefix: "open-take-review-",
          timeoutMs: 120_000,
        });
        await browser.evaluate("window.__ot.prepare()", { timeoutMs: 120_000 });
      }
      const open = new Map<string, LayoutSpan & { last: number; count: number }>();
      const done: LayoutSpan[] = [];
      const close = (key: string) => {
        const s = open.get(key)!;
        open.delete(key);
        if (s.count >= 2)
          done.push({ kind: s.kind, a: s.a, b: s.b, box: s.box, from: s.from, to: s.to });
      };
      for (let t = 0; t < duration; t += every) {
        const at = Math.round(t * 1000) / 1000;
        await browser.evaluate(`window.__ot.seek(${at})`);
        const found = await browser.evaluate<LayoutFinding[]>(layoutProbeSource());
        const now = new Set<string>();
        for (const f of found) {
          const key = `${f.kind}|${f.a}|${f.b ?? ""}`;
          now.add(key);
          const s = open.get(key);
          if (s) {
            s.to = at;
            s.count++;
          } else open.set(key, { ...f, from: at, to: at, last: at, count: 1 });
        }
        for (const key of [...open.keys()]) if (!now.has(key)) close(key);
      }
      for (const key of [...open.keys()]) close(key);
      return done.sort((a, b) => a.from - b.from);
    } finally {
      await browser.close();
      if (browser !== probe) await probe.close();
    }
  } finally {
    await server.close();
  }
}

function run(bin: string, args: string[]): Promise<void> {
  return new Promise((ok, fail) => {
    const p = spawn(bin, args, { stdio: ["ignore", "ignore", "pipe"] });
    let err = "";
    p.stderr.on("data", (d: Buffer) => {
      err += d.toString();
    });
    p.on("error", fail);
    p.on("close", (code) =>
      code === 0 ? ok() : fail(new Error(`${bin} exited ${code}: ${err.slice(-400)}`)),
    );
  });
}
