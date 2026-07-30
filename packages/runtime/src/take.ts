// Take path resolution + prev snapshot — the file conventions behind the
// conversational refine loop. A take is TWO things on disk: the postable
// master at exactly the path its author asked for (`<base>.mp4`), and a
// working directory beside it (`<base>.take/`) that holds everything else.
// Every CLI verb accepts any member of the take (the master, the working
// dir, a file inside it, or a directory holding one take) and resolves the
// rest by convention.
//
// Why the split: five members of the family are themselves .mp4 files (the
// kept capture, the review/draft/ab copies, the previous master). Flat, as
// `<base>.review.mp4` and friends, the ONE postable file was
// indistinguishable at a glance from four disposable ones in an upload
// dialog — and a folder with three takes in it was 36 interleaved files.
// Now each take is two entries: the video you can post, and a folder you
// can ignore, `.gitignore` (`*.take/`), or delete. Deleting it keeps the
// video and loses only refinability (the capture is not regenerable).

import { copyFile, mkdir, readdir, rename, rm, stat } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

/** working-directory suffix: `demo.mp4` → `demo.take/` */
export const TAKE_DIR_SUFFIX = ".take";

export type TakePaths = {
  /** shared prefix, no extension — `<dir>/<name>` */
  base: string;
  name: string;
  /** `<base>.mp4` — the polished, postable master. The ONLY file outside `dir` */
  mp4Path: string;
  /** `<base>.take/` — the take's working directory; every path below is inside it */
  dir: string;
  compositionPath: string;
  capturePath: string;
  captureLogPath: string;
  /** `review.mp4` — draft copy with burned beat badges (disposable) */
  reviewPath: string;
  /** `draft.mp4` — clean draft-quality re-render (disposable; never clobbers
   *  the postable master) */
  draftPath: string;
  /** `ab.mp4` — the A/B variant reel (disposable) */
  abPath: string;
  /** `prev.mp4` — the previous master, kept so "A" can mean revert */
  prevPath: string;
  /** `prev.composition.json` — the composition from before a re-make, kept so
   *  hand-edited overrides survive a re-shoot that re-plans from scratch */
  prevCompositionPath: string;
  /** `frames.png` — the beat-aware contact sheet */
  framesPath: string;
  /** `dossier.md` — the agent's persisted exploration harvest (app thesis,
   *  hero candidates tried/rejected, selector map, content answers, hazards).
   *  Read it before re-exploring; it survives re-makes. */
  dossierPath: string;
  /** `notes.md` — the director's notes, appended one line per note by the
   *  editor's Agent panel. The user→agent channel; see notes.ts. */
  notesPath: string;
  /** `notes.cursor` — byte offset of the last note the agent consumed.
   *  Written ONLY by the reader, so it never races the server's append. */
  notesCursorPath: string;
};

async function isFile(p: string): Promise<boolean> {
  return (await stat(p).catch(() => null))?.isFile() ?? false;
}

const stripDirSuffix = (p: string): string => p.slice(0, -TAKE_DIR_SUFFIX.length);

/** Every member the flat layout used to write beside the master. A path that
 *  matches one AND EXISTS is a pre-`.take/` take (or a path from an old doc):
 *  worth an explanation rather than a resolve to a take called "demo.capture".
 *  Existence is what keeps this from stealing a legitimate name — `--out
 *  foo.draft.mp4` is a fine thing to call a video nobody has written yet. */
const LEGACY_MEMBER =
  /\.(composition\.json|capture\.mp4|capture\.json|review\.mp4|draft\.mp4|ab\.mp4|prev\.mp4|frames(\.beat\d+)?\.png|dossier\.md|notes\.md|notes\.cursor)$/i;

function legacyLayout(base: string): string {
  const name = basename(base);
  const dir = `${name}${TAKE_DIR_SUFFIX}`;
  return (
    `${base}.* is the old flat take layout — a take's working files now live in ${dir}/ beside the mp4.\n` +
    `Migrate it:\n` +
    `  (cd ${JSON.stringify(dirname(base))} && mkdir -p ${JSON.stringify(dir)} && ` +
    `for f in ${JSON.stringify(name)}.*.*; do mv "$f" ${JSON.stringify(dir)}/"\${f#${name}.}"; done)\n` +
    `— or just re-make the take.`
  );
}

function fromBase(base: string): TakePaths {
  const dir = `${base}${TAKE_DIR_SUFFIX}`;
  const inDir = (n: string): string => join(dir, n);
  return {
    base,
    name: basename(base),
    mp4Path: `${base}.mp4`,
    dir,
    compositionPath: inDir("composition.json"),
    capturePath: inDir("capture.mp4"),
    captureLogPath: inDir("capture.json"),
    reviewPath: inDir("review.mp4"),
    draftPath: inDir("draft.mp4"),
    abPath: inDir("ab.mp4"),
    prevPath: inDir("prev.mp4"),
    prevCompositionPath: inDir("prev.composition.json"),
    framesPath: inDir("frames.png"),
    dossierPath: inDir("dossier.md"),
    notesPath: inDir("notes.md"),
    notesCursorPath: inDir("notes.cursor"),
  };
}

/** A path inside the take's working dir — the ffmpeg intermediates and the
 *  per-beat frame sheets, which are members by position, not by name. */
export const takeFile = (take: TakePaths, name: string): string => join(take.dir, name);

/** Point at any member and get the whole take. Resolution is a pure string
 *  transform except for a bare directory, which is scanned for `*.take/`.
 *  The master need not exist yet — `make --out` resolves before it writes. */
export async function resolveTakePaths(input: string): Promise<TakePaths> {
  const p = resolve(input);
  const parent = dirname(p);
  // a file inside the working dir: `demo.take/draft.mp4`
  if (parent.endsWith(TAKE_DIR_SUFFIX)) return fromBase(stripDirSuffix(parent));
  // the working dir itself
  if (p.endsWith(TAKE_DIR_SUFFIX)) return fromBase(stripDirSuffix(p));
  if (LEGACY_MEMBER.test(p) && (await isFile(p)))
    throw new Error(legacyLayout(p.replace(LEGACY_MEMBER, "")));
  // the master — or the path that is about to become one
  if (/\.mp4$/i.test(p)) return fromBase(p.replace(/\.mp4$/i, ""));
  const s = await stat(p).catch(() => null);
  if (s?.isDirectory()) return fromBase(await pickTakeIn(p));
  return fromBase(p); // a bare base name (`--out demo`)
}

/** A plain directory means "the take in here" — unambiguous only when it holds
 *  exactly one. Two takes in one folder is now visible (two `*.take/` dirs)
 *  instead of an alphabetical race between compositions. */
async function pickTakeIn(dir: string): Promise<string> {
  const entries = await readdir(dir).catch(() => [] as string[]);
  const takes = entries.filter((e) => e.endsWith(TAKE_DIR_SUFFIX)).sort();
  if (takes.length === 1) return join(dir, stripDirSuffix(takes[0]!));
  if (takes.length > 1)
    throw new Error(
      `${dir} holds ${takes.length} takes (${takes.map(stripDirSuffix).join(", ")}) — name the one you mean, e.g. ${stripDirSuffix(takes[0]!)}.mp4`,
    );
  const flat = entries.find((e) => /\.composition\.json$/i.test(e));
  if (flat) throw new Error(legacyLayout(join(dir, flat.replace(/\.composition\.json$/i, ""))));
  throw new Error(
    `no take in ${dir} — a take is an mp4 with a <name>${TAKE_DIR_SUFFIX}/ working dir beside it`,
  );
}

/** Create the working dir (idempotent). Everything except the master is
 *  written inside it, so any verb that writes calls this first. */
export async function ensureTakeDir(take: TakePaths): Promise<void> {
  const s = await stat(take.dir).catch(() => null);
  if (s && !s.isDirectory())
    throw new Error(
      `${take.dir} exists but is not a directory — that is where this take's working files go; move it aside`,
    );
  await mkdir(take.dir, { recursive: true });
}

/** Friendly preflight: verbs die with a clear message instead of a raw ffmpeg
 *  ENOENT when a take is missing the files they need. Old takes (or cleaned
 *  ones) may have a composition + mp4 but no kept capture — those can be
 *  watched but not re-rendered. */
export async function requireTakeFiles(
  take: TakePaths,
  opts: { capture?: boolean } = {},
): Promise<void> {
  if (!(await isFile(take.compositionPath))) {
    // A flat-layout take resolves fine (the master's name is all it takes) and
    // only shows up here, as a composition that is one directory away.
    if (await isFile(`${take.base}.composition.json`)) throw new Error(legacyLayout(take.base));
    throw new Error(
      `missing ${take.compositionPath} — not a take produced by \`make\` (or the wrong path)`,
    );
  }
  if (opts.capture && !(await isFile(take.capturePath)))
    throw new Error(
      `this take has no kept capture (${take.capturePath}) — re-rendering needs the frozen recording.\n` +
        `Delete the working dir and the master is all that is left; run \`make\` again for a refinable take.`,
    );
}

export type StagedPrev = {
  /** call after the render SUCCEEDS: the staged copy becomes `<base>.prev.mp4` */
  commit: () => Promise<void>;
  /** call when the render fails/refuses: discard the staged copy, keeping the
   *  existing prev intact */
  abort: () => Promise<void>;
};

/** Stage a copy of the current master so it becomes `prev.mp4` only AFTER the
 *  next render succeeds. A refused (validator) or crashed render must NOT
 *  clobber the existing revert point — that would make "keep the old one"
 *  replay the wrong version. No-op when there is no master yet. This is what
 *  makes "A" (keep the old one) a mechanical revert instead of a memory. */
export async function stagePrev(mp4Path: string, prevPath: string): Promise<StagedPrev> {
  if (!(await isFile(mp4Path))) return { commit: async () => {}, abort: async () => {} };
  const pending = `${prevPath}.pending`;
  await mkdir(dirname(pending), { recursive: true });
  await copyFile(mp4Path, pending);
  return {
    commit: () => rename(pending, prevPath),
    abort: () => rm(pending, { force: true }),
  };
}
