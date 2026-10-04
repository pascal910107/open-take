// `open-take film init`: the film kit (kit/*.js beside this package's dist/)
// copied into a film's folder, where the film's author reads, changes or
// drops it — it is the film's own code from then on, not a dependency. A
// page to start from is written only where there is none, and a kit file the
// author has changed is kept unless asked to replace it.

import { existsSync } from "node:fs";
import { copyFile, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PKG_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** where the kit this package ships is */
export function filmKitDir(): string {
  // from dist/ or from src/film/ (tests run the sources)
  for (const dir of [join(PKG_ROOT, "kit"), join(PKG_ROOT, "..", "kit")])
    if (existsSync(join(dir, "camera.js"))) return dir;
  throw new Error("film init: the film kit is missing from @open-take/compositor — reinstall it");
}

export type FilmInitResult = {
  /** files written (absolute) */
  written: string[];
  /** kit files left alone because the film's copy differs (changed by its author) */
  kept: string[];
};

const PAGE = `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<style>
  html, body { margin: 0; width: 1920px; height: 1080px; overflow: hidden; }
</style>
</head>
<body>
<script type="module">
  // open-take renders this page frame by frame: npx open-take film render .
  // kit/ is yours: the camera, the cursor, one timeline, the real interface
  // as material, and (kit/audio.mjs, for a Node script) the sound's plumbing.
  // Read it; change or drop any of it as the film needs.
  import { camera } from "./kit/camera.js";
  import { cursor } from "./kit/cursor.js";
  import { timeline } from "./kit/time.js";
  import { screen, stills } from "./kit/media.js";

  window.__film = { duration: 10, width: 1920, height: 1080 };
  window.__render = (t) => {
    // the film at t seconds
  };
</script>
</body>
</html>
`;

export async function initFilm(opts: { dir: string; force?: boolean }): Promise<FilmInitResult> {
  const dir = resolve(opts.dir);
  const kit = filmKitDir();
  const written: string[] = [];
  const kept: string[] = [];
  await mkdir(join(dir, "kit"), { recursive: true });
  for (const name of (await readdir(kit)).filter((f) => /\.m?js$/.test(f)).sort()) {
    const to = join(dir, "kit", name);
    if (existsSync(to) && !opts.force) {
      const [mine, theirs] = await Promise.all([readFile(join(kit, name)), readFile(to)]);
      if (!mine.equals(theirs)) {
        kept.push(to);
        continue;
      }
    }
    await copyFile(join(kit, name), to);
    written.push(to);
  }
  const page = join(dir, "index.html");
  if (!existsSync(page)) {
    await writeFile(page, PAGE);
    written.push(page);
  }
  return { written, kept };
}
