// `open-take film viewer`: a round for a first-time viewer — someone who has
// seen nothing of how the film was made watches it and says where they would
// scroll on. The film's author knows what every shot means; a viewer does not,
// and such a viewer has found in minutes what the author's own checks had
// not. This only sets
// the round up: a copy of the film and a brief in <film>.viewer/<n>/. Who
// watches is the author's to start — an agent given that brief and nothing
// else. The brief names no faults to look for: what the viewer notices on its
// own is the point.

import { existsSync } from "node:fs";
import { copyFile, mkdir, readdir, stat, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";

export type ViewerRound = {
  /** the round's folder, <film>.viewer/<n>/ (absolute) */
  dir: string;
  /** 1 for the first round */
  round: number;
  /** the brief to hand to the viewer */
  brief: string;
  /** where the viewer writes what they felt */
  notes: string;
};

export type ViewerRounds = {
  /** rounds with the viewer's notes written, oldest first */
  done: { round: number; notes: string; filmMtimeMs: number }[];
  /** rounds set up whose notes are not there yet */
  open: number[];
};

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
      });
    else out.open.push(round);
  }
  return out;
}

export function viewerBrief(filmCopy: string, notes: string, invoke = "npx open-take"): string {
  return `# Watch this film as a first-time viewer

You came across this film in a social feed. You have never heard of the product.
The film: ${filmCopy}

Watch it closely. You cannot see moving pictures, so take frames with ffmpeg / ffprobe — as dense as you can, denser where the picture moves — lay them out on sheets, read the words on screen, and look at how the sound changes. \`${invoke} film listen <film>\` lays the sound out against time (its beats, sections, loudness, and how far each cut sits from a sound) and \`${invoke} film probe <film>\` the picture (every cut, how much each frame changes, the zoom and travel); both describe, neither judges. Install whatever else you need.

Then write ${notes} for the person who made the film, in the language of the film's own words. Write what you honestly felt watching it: at which second, and why, you would scroll on or keep watching; what you did not understand, what bored you, what felt uncomfortable or forced; what was good. Most important first.

Work only in ${resolve(filmCopy, "..")}. Do not read anything else about how the film was made, and do not look the product up.
`;
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
  await writeFile(brief, viewerBrief(copy, notes, invoke));
  return { dir, round, brief, notes };
}
