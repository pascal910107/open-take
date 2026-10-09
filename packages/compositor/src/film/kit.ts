// `open-take film init`: the film kit (kit/*.js beside this package's dist/)
// copied into a film's folder, where the film's author reads, changes or
// drops it — it is the film's own code from then on, not a dependency. A
// page to start from is written only where there is none, and a kit file the
// author has changed is kept unless asked to replace it. With `--url` the
// CLI first keeps the product's landing page as a saved screen in
// states/home/ (and its look in look/); the page to start from then names
// them in a comment — listed, like the kit, not used.

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
 *  of the kit is listed, not imported, so nothing in the page suggests which
 *  blocks a film is made of. */
export function starterPage(
  kit: { name: string; role: string }[],
  /** what the folder already holds of the product: a saved screen
   *  (states/home/state.html) and its look (look/look.json) */
  has: { home?: string; look?: string } = {},
): string {
  const w = Math.max(...kit.map((k) => k.name.length)) + 6;
  const list = kit.map((k) => `  //   ${`kit/${k.name}`.padEnd(w)}${k.role}`.trimEnd()).join("\n");
  const product = [
    ...(has.home
      ? [
          `  // ${has.home}: the product's page as a saved screen — the real interface, live DOM:`,
          `  //   const home = screen(iframe, "${has.home}");   // kit/media.js; size the iframe to its viewport`,
          `  //   lift(home, "<selector>") one part as a layer of its own · isolate(home, [...]) the rest faded`,
          `  //   const P = await product("${has.home.replace(/[^/]*$/, "")}");   // kit/media.js: its parts (components.json) as references`,
          '  //   P.part("<ref>") → cam.frame(part, …) · cur.click(part, t) · lift(home, part) · part.at(t) where it shows now',
        ]
      : []),
    ...(has.look
      ? [`  // ${has.look}: the product's colours, type and fonts (npx open-take film look)`]
      : []),
  ];
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
  // open-take renders this page frame by frame: npx open-take film render .
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

export async function initFilm(opts: { dir: string; force?: boolean }): Promise<FilmInitResult> {
  const dir = resolve(opts.dir);
  const kit = filmKitDir();
  const written: string[] = [];
  const kept: string[] = [];
  await mkdir(join(dir, "kit"), { recursive: true });
  const roles: { name: string; role: string }[] = [];
  for (const name of (await readdir(kit)).filter((f) => /\.m?js$/.test(f)).sort()) {
    const role = kitRole(await readFile(join(kit, name), "utf8"));
    roles.push({ name, role: name.endsWith(".mjs") ? `${role}, for a Node script` : role });
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
    const home = "states/home/state.html";
    const look = "look/look.json";
    await writeFile(
      page,
      starterPage(roles, {
        ...(existsSync(join(dir, home)) ? { home } : {}),
        ...(existsSync(join(dir, look)) ? { look } : {}),
      }),
    );
    written.push(page);
  }
  return { written, kept };
}
