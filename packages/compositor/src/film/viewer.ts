// `open-take film viewer`: a round for a first-time viewer — someone who has
// seen nothing of how the film was made watches it and says where they would
// scroll on. The film's author knows what every shot means; a viewer does not,
// and such a viewer has found in minutes what the author's own checks had
// not. This only sets
// the round up: a copy of the film and a brief in <film>.viewer/<n>/. Who
// watches is the author's to start — an agent given that brief and nothing
// else. The brief names no faults to look for: what the viewer notices on its
// own is the point. Only once that is written does it read what makes films
// look machine-made (`skill film tells`) and say which of those this one has.
//
// A viewer started as a fresh process has its own PATH and its own tool
// permissions. One round ran with no ffmpeg on PATH (open-take keeps its own
// under ~/.open-take, off PATH) and with its shell and file tools refused: it
// took no frame and wrote notes all the same. So the brief names the ffmpeg
// and ffprobe open-take itself uses by their full paths, the round says what
// the viewer must be allowed to do, the frames it looks at stay in the round's
// folder, and a round whose folder holds notes and not one frame is reported
// as a viewer that saw nothing (`film viewer <film> --check`, and the line a
// render prints).

import { existsSync } from "node:fs";
import { copyFile, mkdir, readdir, stat, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { resolveFfmpeg, resolveFfprobe } from "../ffmpeg";

export type ViewerRound = {
  /** the round's folder, <film>.viewer/<n>/ (absolute) */
  dir: string;
  /** 1 for the first round */
  round: number;
  /** the brief to hand to the viewer */
  brief: string;
  /** where the viewer writes what they felt */
  notes: string;
  /** the ffmpeg and ffprobe the brief names: a full path for open-take's own,
   *  the bare name when the one in use is on PATH already */
  ffmpeg: string;
  ffprobe: string;
};

/** What a viewer has to be allowed to do, in Claude Code's tool names: run
 *  ffmpeg and open-take (Bash), look at the frames (Read), write its notes
 *  and sheets (Write, Edit), find its files (Glob, Grep). */
export const VIEWER_TOOLS = ["Bash", "Read", "Write", "Edit", "Glob", "Grep"] as const;

export type ViewerRounds = {
  /** rounds with the viewer's notes written, oldest first; `frames` is how
   *  many pictures are in the round's folder — 0 means it watched nothing */
  done: { round: number; notes: string; filmMtimeMs: number; frames: number }[];
  /** rounds set up whose notes are not there yet */
  open: number[];
};

/** pictures under a folder, to any depth; counting stops at `limit` */
async function countPictures(dir: string, limit = 1000): Promise<number> {
  let n = 0;
  for (const e of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    if (n >= limit) break;
    if (e.isDirectory()) n += await countPictures(join(dir, e.name), limit - n);
    else if (/\.(jpe?g|png|webp|gif|bmp)$/i.test(e.name)) n++;
  }
  return n;
}

const viewerDir = (film: string) => `${resolve(film).replace(/\.[^./]+$/, "")}.viewer`;

/** the rounds already set up beside a film */
export async function viewerRounds(film: string): Promise<ViewerRounds> {
  const root = viewerDir(film);
  const out: ViewerRounds = { done: [], open: [] };
  if (!existsSync(root)) return out;
  const rounds = (await readdir(root))
    .filter((n) => /^\d+$/.test(n))
    .map(Number)
    .sort((a, b) => a - b);
  for (const round of rounds) {
    const notes = join(root, String(round), "VIEWER.md");
    if (existsSync(notes))
      out.done.push({
        round,
        notes,
        filmMtimeMs:
          (await stat(join(root, String(round), "film.mp4")).catch(() => null))?.mtimeMs ?? 0,
        frames: await countPictures(join(root, String(round))),
      });
    else out.open.push(round);
  }
  return out;
}

/** The latest round's state, for `film viewer --check`: `ok` only when its
 *  notes are written and its folder holds at least one frame. */
export async function checkViewer(
  film: string,
): Promise<{ ok: boolean; round: number | null; dir: string | null; message: string }> {
  const { done, open } = await viewerRounds(film);
  const round = Math.max(0, ...done.map((d) => d.round), ...open);
  if (!round)
    return { ok: false, round: null, dir: null, message: "no viewer round has been set up for this film" };
  const dir = join(viewerDir(film), String(round));
  const last = done.find((d) => d.round === round);
  if (!last)
    return { ok: false, round, dir, message: `round ${round} has no VIEWER.md yet: the viewer has not finished, or never started` };
  if (last.frames === 0)
    return {
      ok: false,
      round,
      dir,
      message:
        `THE VIEWER OF ROUND ${round} SAW NOTHING: ${dir} holds VIEWER.md and not one frame of the film. ` +
        "Its notes are not a viewing; do not act on them. It could not run ffmpeg (not on its PATH) or was refused " +
        "its shell or file tools. Start a new round and give the viewer what the command prints: the PATH and the tools.",
    };
  return { ok: true, round, dir, message: `round ${round}: notes written, ${last.frames >= 1000 ? "1000 or more" : last.frames} frame(s) and sheet(s) in ${dir}` };
}

export function viewerBrief(
  filmCopy: string,
  notes: string,
  invoke = "npx open-take",
  tools: { ffmpeg?: string; ffprobe?: string } = {},
): string {
  const dir = resolve(filmCopy, "..");
  // a bare name is one found on PATH: there is no path to give, and none is needed
  const at = [tools.ffmpeg && isAbsolute(tools.ffmpeg) ? `ffmpeg is at \`${tools.ffmpeg}\`` : "",
    tools.ffprobe && isAbsolute(tools.ffprobe) ? `ffprobe at \`${tools.ffprobe}\`` : ""].filter(Boolean);
  const where = at.length
    ? `\n${at.join(" and ").replace(/^ffprobe at/, "ffprobe is at")}. They may not be on your PATH: call them by these paths.\n`
    : "";
  return `# Watch this film as a first-time viewer

You came across this film in a social feed. You have never heard of the product.
The film: ${filmCopy}

Watch it closely. You cannot see moving pictures, so take frames with ffmpeg / ffprobe — as dense as you can, denser where the picture moves — lay them out on sheets, read the words on screen, and look at how the sound changes. \`${invoke} film listen <film>\` lays the sound out against time (its beats, sections, loudness, and how far each cut sits from a sound) and \`${invoke} film probe <film>\` the picture (every cut, how much each frame changes, the zoom and travel); both describe, neither judges. Install whatever else you need. Keep every frame and sheet you look at in ${join(dir, "frames")}.
${where}
If you cannot take a single frame — ffmpeg will not run, or you are refused the shell or the files — stop there: write in ${notes} only what stopped you, and nothing about the film. Notes on a film you did not see are worse than none.

Then write ${notes} for the person who made the film, in the language of the film's own words. Write what you honestly felt watching it: at which second, and why, you would scroll on or keep watching; what you did not understand, what bored you, what felt uncomfortable or forced; what was good. Most important first.

When that is written — not before — run \`${invoke} skill film tells\`: choices that make films look machine-made, each with when it is fine. Add a last section to ${notes}, "Looks machine-made", naming each one this film has, at which second and what is on screen, and whether it has a reason here. Leave out the ones it does not have, and leave what you wrote above as it was.

Work only in ${dir}. Do not read anything else about how the film was made, and do not look the product up.
`;
}

/** The command that starts a viewer as a fresh Claude Code session in the
 *  round's folder: open-take's ffmpeg and ffprobe first on its PATH, and the
 *  tools it needs allowed, so it is not left waiting on a permission no one
 *  is there to give. */
export function viewerCommand(v: Pick<ViewerRound, "dir" | "ffmpeg" | "ffprobe">): string {
  const q = (s: string) => `'${s.replace(/'/g, "'\\''")}'`;
  // only a tool named by its full path has a folder to add; one found on PATH is there already
  const path = [...new Set([v.ffmpeg, v.ffprobe].filter((f) => isAbsolute(f)).map((f) => dirname(f)))].join(":");
  return `cd ${q(v.dir)} && ${path ? `PATH=${q(path)}:"$PATH" ` : ""}claude -p --allowedTools "${VIEWER_TOOLS.join(" ")}" < BRIEF.md`;
}

/** sets up the next round: <film>.viewer/<n>/film.mp4 and BRIEF.md */
export async function prepareViewer(film: string, invoke?: string): Promise<ViewerRound> {
  const src = resolve(film);
  if (!existsSync(src)) throw new Error(`film viewer: ${film} not found`);
  const { done, open } = await viewerRounds(src);
  const round = Math.max(0, ...done.map((d) => d.round), ...open) + 1;
  const dir = join(viewerDir(src), String(round));
  await mkdir(dir, { recursive: true });
  const copy = join(dir, `film${basename(src).match(/\.[^.]+$/)?.[0] ?? ".mp4"}`);
  await copyFile(src, copy);
  const notes = join(dir, "VIEWER.md");
  const brief = join(dir, "BRIEF.md");
  const [ffmpeg, ffprobe] = await Promise.all([resolveFfmpeg(), resolveFfprobe()]);
  await writeFile(brief, viewerBrief(copy, notes, invoke, { ffmpeg, ffprobe }));
  return { dir, round, brief, notes, ffmpeg, ffprobe };
}
