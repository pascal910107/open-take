// `open-take film picture`: a saved screen drawn once at twice its pixels (or
// more), for a film to push into. Text that moves under a slow push steps a
// pixel at a time on a live page; a picture of it, rendered with
// --supersample, does not (measured on a saved screen: 0.49 px of jitter live,
// 0.08 as a 2× picture — see the guide). The screen is shown in a frame
// scaled from its top-left corner, on a page of the picture's size.

import { existsSync, statSync } from "node:fs";
import { copyFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { filmStills } from "./render";

export type FilmPictureOptions = {
  /** a saved screen's state.html, or its folder */
  state: string;
  chromePath: string;
  /** how many picture px per screen px (default 2) */
  scale?: number;
  /** the PNG to write (default picture@<scale>x.png beside state.html) */
  out?: string;
};

export async function filmPicture(
  opts: FilmPictureOptions,
): Promise<{ out: string; width: number; height: number }> {
  const given = resolve(opts.state);
  const state =
    existsSync(given) && statSync(given).isDirectory() ? join(given, "state.html") : given;
  if (!existsSync(state)) throw new Error(`film picture: no saved screen at ${opts.state}`);
  const scale = opts.scale ?? 2;
  if (!(scale >= 1 && scale <= 4)) throw new Error(`film picture: --scale is 1 to 4, not ${scale}`);
  const dir = dirname(state);
  let w = 1920;
  let h = 1080;
  try {
    const index = JSON.parse(await readFile(join(dir, "index.json"), "utf8"));
    if (index?.viewport?.w && index?.viewport?.h) ({ w, h } = index.viewport);
  } catch {
    /* no index: a screen of the default size */
  }
  const width = Math.round(w * scale);
  const height = Math.round(h * scale);
  // the page sits beside the screen so the screen's own relative paths (its
  // shared assets one folder up) resolve; it is served from one level up
  const page = join(dir, `.open-take-picture-${process.pid}.html`);
  await writeFile(
    page,
    `<!doctype html><html><head><meta charset="utf-8"><style>
html,body{margin:0;width:${width}px;height:${height}px;overflow:hidden;background:#fff}
iframe{position:absolute;left:0;top:0;width:${w}px;height:${h}px;border:0;transform-origin:0 0;transform:scale(${scale})}
</style></head><body><iframe src="${encodeURI(basename(state))}"></iframe>
<script>window.__film = { duration: 1, width: ${width}, height: ${height} };</script></body></html>`,
  );
  const tmp = await mkdtemp(join(tmpdir(), "open-take-picture-"));
  try {
    const [file] = await filmStills({
      page,
      root: dirname(dir),
      chromePath: opts.chromePath,
      at: [0],
      outDir: tmp,
      width,
      height,
      blur: false,
    });
    const out = resolve(opts.out ?? join(dir, `picture@${scale}x.png`));
    await copyFile(file!, out); // the temporary folder may be on another volume
    return { out, width, height };
  } finally {
    await rm(page, { force: true });
    await rm(tmp, { recursive: true, force: true });
  }
}
