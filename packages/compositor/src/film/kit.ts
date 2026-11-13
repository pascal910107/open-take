// `open-take film init`: the film kit (kit/*.js beside this package's dist/)
// copied into a film's folder, where the film's author reads, changes or
// drops it — it is the film's own code from then on, not a dependency. Beside
// it the starter (starter/ beside kit/): START.md, the page to read first;
// PLAN.md, the plan to fill; reference/, measurements of one launch film;
// lib/, motion helpers and a sampler; samples/, the sampler's recorded
// instruments. A page to start from is written only where there is none; a
// file the author has changed is kept unless asked to replace it, and PLAN.md,
// once written in, is never replaced. With `--url` the CLI first keeps the
// product's landing page as a saved screen in states/home/ (its parts as
// files in parts/, its look in look/); the page to start from then names
// them in a comment — listed, like the kit, not used.

import { constants, existsSync } from "node:fs";
import { copyFile, mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PKG_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** where the kit this package ships is */
export function filmKitDir(): string {
  // from dist/ or from src/film/ (tests run the sources)
  for (const dir of [join(PKG_ROOT, "kit"), join(PKG_ROOT, "..", "kit")])
    if (existsSync(join(dir, "camera.js"))) return dir;
  throw new Error("film init: the film kit is missing from @open-take/compositor — reinstall it");
}

/** where the starter this package ships is */
export function filmStarterDir(): string {
  // from dist/ or from src/film/ (tests run the sources)
  for (const dir of [join(PKG_ROOT, "starter"), join(PKG_ROOT, "..", "starter")])
    if (existsSync(join(dir, "START.md"))) return dir;
  throw new Error("film init: the starter is missing from @open-take/compositor — reinstall it");
}

/** what the starter puts in a film's folder, at the same paths there:
 *  lib/sampler.mjs imports ../kit/audio.mjs and reads ../samples */
export const STARTER_PARTS = ["START.md", "PLAN.md", "reference", "lib", "samples"] as const;

/** the film's plan: once it differs from the starter's, its author has written in it */
const PLAN = "PLAN.md";

/** three.js's two files a film page imports for kit/world.js (three is a
 *  dependency of this package; its build/ holds them) */
export const THREE_FILES = ["three.module.min.js", "three.core.min.js"] as const;

/** where this package's three.js build is */
export function threeBuildDir(): string {
  // "three" resolves to build/three.cjs (its exports do not list the .min files)
  const dir = dirname(createRequire(import.meta.url).resolve("three"));
  for (const f of THREE_FILES)
    if (!existsSync(join(dir, f)))
      throw new Error(`film init: three.js's ${f} is missing from ${dir} — reinstall open-take`);
  return dir;
}

/** what copying a set of files into the film's folder did, file by file (absolute) */
export type FilmFiles = {
  /** written: there was none, or it was replaced (force) */
  written: string[];
  /** left alone because the film's copy is already the same */
  same: string[];
  /** left alone because the film's copy differs (changed by its author) */
  kept: string[];
};

/** the kit's files and the page at the top level, the starter's apart */
export type FilmInitResult = FilmFiles & {
  /** the film's folder (absolute) */
  dir: string;
  /** the starter's files: START.md, PLAN.md, reference/, lib/, samples/ —
   *  none when it was left out */
  starter: FilmFiles;
  /** START.md in the film's folder, the page to read first, when the starter
   *  wrote it or found it there */
  start: string | null;
};

/** One file into the film's folder: written where there is none, left where
 *  the film's copy is the same, kept where it differs unless `replace`. A
 *  clone where the filesystem can make one, else a copy. */
async function place(from: string, to: string, replace: boolean, into: FilmFiles): Promise<void> {
  const there = await stat(to).catch(() => null);
  if (there) {
    // a folder where the file goes is the author's: never replaced
    if (!there.isFile()) {
      into.kept.push(to);
      return;
    }
    if (
      there.size === (await stat(from)).size &&
      (await readFile(from)).equals(await readFile(to))
    ) {
      into.same.push(to);
      return;
    }
    if (!replace) {
      into.kept.push(to);
      return;
    }
  }
  await copyFile(from, to, constants.COPYFILE_FICLONE);
  into.written.push(to);
}

/** the files of one starter part, relative to the starter, sorted; .DS_Store left out */
async function starterFiles(root: string, part: string): Promise<string[]> {
  const at = join(root, part);
  const s = await stat(at).catch(() => null);
  if (!s)
    throw new Error(
      `film init: the starter's ${part} is missing from ${root} — reinstall open-take`,
    );
  if (!s.isDirectory()) return [part];
  const out: string[] = [];
  for (const name of (await readdir(at)).sort()) {
    if (name === ".DS_Store") continue;
    out.push(...(await starterFiles(root, join(part, name))));
  }
  return out;
}

/** what one kit file is, from its header's first line: "// Motion for a film
 *  page — open-take's film kit. …" → "motion for a film page" */
function kitRole(source: string): string {
  const line = source.split("\n").find((l) => /^\/\/ (?!@ts-)/.test(l)) ?? "";
  const role = line
    .replace(/^\/\/\s*/, "")
    .split(" — ")[0]!
    .trim();
  return role ? role[0]!.toLowerCase() + role.slice(1) : "";
}

/** The page `film init` starts a film from: wiring only. No story, no look,
 *  no length — the duration is a placeholder — and of the kit it imports only
 *  the timeline, whose hooks carry the page's events to the score; the rest
 *  of the kit is listed, not imported. The product's material is named in a
 *  comment, a live part that acts first and the whole screen kept for the
 *  moment it is the proof — where to start, said, not drawn. Where the
 *  starter is in the folder, the comment opens on START.md, the page to read
 *  first, and names lib/ and samples/ beside the kit. */
export function starterPage(
  kit: { name: string; role: string }[],
  /** what the folder already holds of the product: a saved screen
   *  (states/home/state.html), its look (look/look.json) and its parts as
   *  files (parts/index.json); and whether the starter is there (START.md,
   *  lib/, samples/) */
  has: { home?: string; look?: string; parts?: string; starter?: boolean } = {},
): string {
  const w = Math.max(...kit.map((k) => k.name.length)) + 6;
  const list = kit.map((k) => `  //   ${`kit/${k.name}`.padEnd(w)}${k.role}`.trimEnd()).join("\n");
  const dir = has.home ? has.home.replace(/[^/]*$/, "") : null;
  const product = [
    "  // the product, as material — start from one of its parts, live, acting: the cursor does one real",
    "  // thing to it and the result shows in the part (npx open-take skill film material). Screens shown",
    "  // as pictures under a caption read as flat. A film needs not all of these:",
    ...(has.parts
      ? [
          `  //   its parts as files: ${has.parts} — each part's own HTML, its styles inlined, in its fonts, alone at`,
          `  //     any size: an iframe's src, or (await partFiles("${has.parts.replace(/[^/]*$/, "")}")).node("<ref>")   // kit/media.js`,
        ]
      : []),
    ...(has.home
      ? [
          `  //   its interface, live DOM: const home = screen(iframe, "${has.home}");   // kit/media.js`,
          `  //     lifted out: lift(home, "<selector>") — a live layer, moved at any size, its own elements acting in it`,
          `  //     its parts as references: const P = await product("${dir}"); P.part("<ref>") → cam.frame(part, …) · lift(home, part) · cur.click(part, t)`,
        ]
      : []),
    `  //   rebuilt: the film's own HTML at film size, in the product's fonts and colours${has.look ? ` (${has.look}, npx open-take film look)` : " (npx open-take film look)"}, with its real values (readValues)`,
    ...(has.home
      ? [
          "  //   in place: cam.frame(box) · isolate(home, [...]) the rest faded — when the screen round the part matters;",
          "  //     the whole screen, as a screenshot or a recording, for the moment it is the proof",
        ]
      : ["  //   the whole screen, as a screenshot or a recording, for the moment it is the proof"]),
    ...(dir
      ? [
          `  //   what it says: ${dir}materials.json — its headings and copy, its images (saved), the pages it`,
          `  //     links to (its About, docs, repository); npx open-take materials ${dir.replace(/\/$/, "")}`,
        ]
      : []),
    "  //   what it makes: a shoot's s.save(name, target) keeps a drawn shape, a picture, a result, a",
    "  //     download as a file of its own — (await stills(url, img)).output(name) in kit/media.js",
  ];
  const starter = has.starter
    ? "  // START.md in this folder is what to read first. Beside the kit are lib/anim.js (motion\n" +
      "  // helpers) and lib/sampler.mjs with samples/ (recorded instruments for the score).\n"
    : "";
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<style>
  html, body { margin: 0; width: 1920px; height: 1080px; overflow: hidden; }
</style>
</head>
<body>
<script type="module">
${starter}  // open-take renders this page frame by frame: npx open-take film render .
  // It asks only for window.__film and window.__render(t), the film at t
  // seconds — drawn with the kit, without it, or on a canvas or in WebGL of
  // the page's own, any part of it.
  // kit/ is yours to read, change or drop (npx open-take film gallery draws
  // what each of its blocks does):
${list}
${product.length ? `${product.join("\n")}\n` : ""}  import { timeline } from "./kit/time.js";

  // the film's moments and what happens when — <film>.events.json, for the score
  const tl = timeline();

  window.__film = {
    duration: 1, // s — a placeholder: the film is as long as it needs to be
    width: 1920,
    height: 1080,
    ...tl.hooks(),
  };
  window.__render = (t) => {
    // the film at t seconds
  };
</script>
</body>
</html>
`;
}

export async function initFilm(opts: {
  dir: string;
  /** replace the kit's and the starter's files the author has changed — PLAN.md excepted */
  force?: boolean;
  /** the starter beside the kit (default true); false writes the kit and the page only */
  starter?: boolean;
}): Promise<FilmInitResult> {
  const dir = resolve(opts.dir);
  const kit = filmKitDir();
  const force = opts.force === true;
  const res: FilmInitResult = {
    dir,
    written: [],
    same: [],
    kept: [],
    starter: { written: [], same: [], kept: [] },
    start: null,
  };
  await mkdir(join(dir, "kit"), { recursive: true });
  const roles: { name: string; role: string }[] = [];
  for (const name of (await readdir(kit)).filter((f) => /\.m?js$/.test(f)).sort()) {
    const role = kitRole(await readFile(join(kit, name), "utf8"));
    roles.push({ name, role: name.endsWith(".mjs") ? `${role}, for a Node script` : role });
    await place(join(kit, name), join(dir, "kit", name), force, res);
  }
  // three.js (MIT), for kit/world.js: the page imports it from kit/ itself
  const three = threeBuildDir();
  for (const name of THREE_FILES) {
    roles.push({
      name,
      role:
        name === "three.module.min.js"
          ? 'three.js, for kit/world.js — import * as THREE from "./kit/three.module.min.js"'
          : "three.js's core, which three.module.min.js loads",
    });
    await place(join(three, name), join(dir, "kit", name), force, res);
  }
  // the starter, at the same paths in the film's folder as in starter/
  const withStarter = opts.starter !== false;
  if (withStarter) {
    const root = filmStarterDir();
    const made = new Set<string>();
    for (const part of STARTER_PARTS)
      for (const rel of await starterFiles(root, part)) {
        const to = join(dir, rel);
        if (!made.has(dirname(to))) {
          await mkdir(dirname(to), { recursive: true });
          made.add(dirname(to));
        }
        // PLAN.md is the film's own working page: force does not replace it
        await place(join(root, rel), to, force && rel !== PLAN, res.starter);
      }
    const start = join(dir, "START.md");
    if ((await stat(start).catch(() => null))?.isFile()) res.start = start;
  }
  const page = join(dir, "index.html");
  if (!existsSync(page)) {
    const home = "states/home/state.html";
    const look = "look/look.json";
    const parts = "parts/index.json";
    await writeFile(
      page,
      starterPage(roles, {
        ...(existsSync(join(dir, home)) ? { home } : {}),
        ...(existsSync(join(dir, look)) ? { look } : {}),
        ...(existsSync(join(dir, parts)) ? { parts } : {}),
        ...(withStarter ? { starter: true } : {}),
      }),
    );
    res.written.push(page);
  }
  return res;
}

/** a folder of the starter with more files than this is told as one line */
const MANY = 5;

/** what a folder of the starter is, for its one line */
const FOLDER_ABOUT: Record<string, string> = {
  samples: "recorded instruments; NOTICE.txt has their licences",
};

/**
 * The lines `film init` prints: a line a file written or kept, a folder of
 * the starter with many (samples/) as one line with its count, the files
 * already the same as one line, and last, where START.md is, the pointer to
 * it. `show` gives a path as typed from where the command runs.
 */
export function filmInitLines(r: FilmInitResult, show: (p: string) => string): string[] {
  const top = (f: string) => relative(r.dir, f).split(/[\\/]/);
  /** the starter's files by their top folder ("" for a file at the top), in order */
  const byFolder = (files: string[]) => {
    const by = new Map<string, string[]>();
    for (const f of files) {
      const parts = top(f);
      const k = parts.length > 1 ? parts[0]! : "";
      by.set(k, [...(by.get(k) ?? []), f]);
    }
    return by;
  };
  const lines: string[] = [];
  for (const f of r.written) lines.push(`wrote ${show(f)}`);
  for (const [folder, files] of byFolder(r.starter.written)) {
    if (folder && files.length > MANY) {
      const about = FOLDER_ABOUT[folder];
      lines.push(
        `wrote ${show(join(r.dir, folder))}/ (${files.length} files${about ? ` — ${about}` : ""})`,
      );
    } else for (const f of files) lines.push(`wrote ${show(f)}`);
  }
  for (const f of r.kept)
    lines.push(`kept ${show(f)} — yours differs from the kit's (--force replaces it)`);
  for (const [folder, files] of byFolder(r.starter.kept)) {
    if (folder && files.length > MANY) {
      const names = files.slice(0, 3).map((f) => top(f).slice(1).join("/"));
      lines.push(
        `kept ${files.length} files in ${show(join(r.dir, folder))}/ — yours differ from the starter's (--force replaces them): ${names.join(", ")}, …`,
      );
      continue;
    }
    for (const f of files)
      lines.push(
        relative(r.dir, f) === PLAN
          ? `kept ${show(f)} — the film's plan, written in: never replaced, with or without --force`
          : `kept ${show(f)} — yours differs from the starter's (--force replaces it)`,
      );
  }
  // the files already as the kit and the starter have them, by folder, in
  // the film's folder
  const same = byFolder([...r.same, ...r.starter.same]);
  if (same.size) {
    const what = [...same].flatMap(([folder, files]) =>
      folder
        ? [`${folder}/ (${files.length} file${files.length === 1 ? "" : "s"})`]
        : files.map((f) => relative(r.dir, f)),
    );
    lines.push(`already the same in ${show(r.dir)}/: ${what.join(", ")}`);
  }
  if (r.start) lines.push(`Read ${show(r.start)} first.`);
  return lines;
}
