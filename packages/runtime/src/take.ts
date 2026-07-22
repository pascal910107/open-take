// Take path resolution + prev snapshot — the file conventions behind the
// conversational refine loop. A "take" is the artifact family makeTake writes
// beside `<base>.mp4`; every CLI verb accepts any member of the family (or the
// directory holding one) and resolves the rest by convention.

import { copyFile, readdir, rename, rm, stat } from "node:fs/promises";
import { basename, join, resolve } from "node:path";

export type TakePaths = {
  /** shared path prefix (no extension) */
  base: string;
  name: string;
  /** `<base>.mp4` — the polished, postable master */
  mp4Path: string;
  compositionPath: string;
  capturePath: string;
  captureLogPath: string;
  /** `<base>.review.mp4` — draft copy with burned beat badges (disposable) */
  reviewPath: string;
  /** `<base>.ab.mp4` — the A/B variant reel (disposable) */
  abPath: string;
  /** `<base>.prev.mp4` — the previous master, kept so "A" can mean revert */
  prevPath: string;
};

async function isFile(p: string): Promise<boolean> {
  return (await stat(p).catch(() => null))?.isFile() ?? false;
}

/** Strip any known take suffix to get the shared base, then derive the family.
 *  A directory picks the `*.composition.json` that has a sibling capture. */
export async function resolveTakePaths(input: string): Promise<TakePaths> {
  let p = resolve(input);
  const s = await stat(p).catch(() => null);
  if (s?.isDirectory()) {
    const comps = (await readdir(p)).filter((e) => /\.composition\.json$/i.test(e));
    if (comps.length === 0) throw new Error(`no *.composition.json found in ${p}`);
    let pick = comps[0]!;
    for (const c of comps) {
      const base = join(p, c.replace(/\.composition\.json$/i, ""));
      if (await isFile(`${base}.capture.mp4`)) {
        pick = c;
        break;
      }
    }
    p = join(p, pick);
  }
  const base = p
    .replace(/\.composition\.json$/i, "")
    .replace(/\.capture\.json$/i, "")
    .replace(/\.capture\.mp4$/i, "")
    .replace(/\.review\.mp4$/i, "")
    .replace(/\.ab\.mp4$/i, "")
    .replace(/\.prev\.mp4$/i, "")
    .replace(/\.mp4$/i, "");
  return {
    base,
    name: basename(base),
    mp4Path: `${base}.mp4`,
    compositionPath: `${base}.composition.json`,
    capturePath: `${base}.capture.mp4`,
    captureLogPath: `${base}.capture.json`,
    reviewPath: `${base}.review.mp4`,
    abPath: `${base}.ab.mp4`,
    prevPath: `${base}.prev.mp4`,
  };
}

/** Friendly preflight: verbs die with a clear message instead of a raw ffmpeg
 *  ENOENT when a take is missing the files they need. Old takes (or cleaned
 *  ones) may have a composition + mp4 but no kept capture — those can be
 *  watched but not re-rendered. */
export async function requireTakeFiles(
  take: TakePaths,
  opts: { capture?: boolean } = {},
): Promise<void> {
  if (!(await isFile(take.compositionPath)))
    throw new Error(
      `missing ${take.compositionPath} — not a take produced by \`make\` (or the wrong path)`,
    );
  if (opts.capture && !(await isFile(take.capturePath)))
    throw new Error(
      `this take has no kept capture (${take.capturePath}) — re-rendering needs the frozen recording.\n` +
        `Takes made before capture-keeping (or cleaned up) can't be re-rendered; run \`make\` again for a refinable take.`,
    );
}

export type StagedPrev = {
  /** call after the render SUCCEEDS: the staged copy becomes `<base>.prev.mp4` */
  commit: () => Promise<void>;
  /** call when the render fails/refuses: discard the staged copy, keeping the
   *  existing prev intact */
  abort: () => Promise<void>;
};

/** Stage a copy of the current master so it becomes `<base>.prev.mp4` only
 *  AFTER the next render succeeds. A refused (validator) or crashed render
 *  must NOT clobber the existing revert point — that would make "keep the old
 *  one" replay the wrong version. No-op when there is no master yet. This is
 *  what makes "A" (keep the old one) a mechanical revert instead of a memory. */
export async function stagePrev(mp4Path: string, prevPath: string): Promise<StagedPrev> {
  if (!(await isFile(mp4Path))) return { commit: async () => {}, abort: async () => {} };
  const pending = `${prevPath}.pending`;
  await copyFile(mp4Path, pending);
  return {
    commit: () => rename(pending, prevPath),
    abort: () => rm(pending, { force: true }),
  };
}
