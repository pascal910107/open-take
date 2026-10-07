// A film's colours, delivered: the page's sRGB values kept, and named as what
// they are — limited-range BT.709 with sRGB's curve — so Chrome (and QuickTime)
// show them as the page had them, not through Apple's gamma; a master patched
// with `--into` names one curve throughout, and `film mux` keeps the picture's.
// Chrome for Testing; skipped without it.

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { promisify } from "node:util";
import { resolveFfmpeg, resolveFfprobe } from "../src/ffmpeg";
import { filmClockSource } from "../src/film/clock";
import { muxFilm, patchFilm, renderFilm } from "../src/film/render";
import { launchHtmlBrowser } from "../src/html/cdp";
import { serveDirectory } from "../src/html/server";
import { findChrome } from "./fixtures/find-chrome";

const exec = promisify(execFile);
const chrome = findChrome();
const skip = chrome ? false : "no Chrome for Testing";

let dir = "";
before(async () => {
  dir = await mkdtemp(join(tmpdir(), "open-take-colour-test-"));
});
after(async () => {
  await rm(dir, { recursive: true, force: true });
});

// a paper white, a dark green, grey, an orange, near-black, a dark teal, a blue
// and a light grey: darks and mids are where a wrong curve shows most
const COLOURS = ["f4f1ea", "1d4d3c", "808080", "ff7a3d", "202020", "0b1714", "3a7bd5", "e8e8e8"];
const W = 256;
const H = 128;
const CELL = 64;
const rgbOf = (hex: string) => [0, 2, 4].map((k) => Number.parseInt(hex.slice(k, k + 2), 16));
/** the centre of colour i's cell */
const centre = (i: number): [number, number] => [
  (i % 4) * CELL + CELL / 2,
  Math.floor(i / 4) * CELL + CELL / 2,
];

/** a 1 s film of the colours in a 4×2 grid; `swap` the cells' order at t ≥ 0.5 */
async function gridPage(page: string, swap = false): Promise<void> {
  await mkdir(page, { recursive: true });
  const cells = COLOURS.map((c, i) => {
    const [x, y] = centre(i);
    return `<div style="position:absolute;left:${x - CELL / 2}px;top:${y - CELL / 2}px;width:${CELL}px;height:${CELL}px;background:#${c}"></div>`;
  }).join("");
  await writeFile(
    join(page, "index.html"),
    `<!doctype html><html><body style="margin:0;background:#000">${cells}
<script>
window.__film = { duration: 1, width: ${W}, height: ${H}, fps: 30 };
const C = ${JSON.stringify(COLOURS)}, all = [...document.querySelectorAll("div")];
window.__render = (t) => {${swap ? ` all.forEach((d, i) => { d.style.background = "#" + C[t >= 0.5 ? 7 - i : i]; }); ` : ""}};
</script></body></html>`,
  );
}

async function tags(file: string): Promise<string> {
  const { stdout } = await exec(await resolveFfprobe(), [
    ...["-v", "error", "-select_streams", "v:0", "-of", "csv=p=0"],
    ...["-show_entries", "stream=color_range,color_space,color_transfer,color_primaries", file],
  ]);
  return stdout.trim();
}

/** frame n's colour at each cell's centre, from its own BT.709 limited-range
 *  values — the exact sums, no decoder's rounding in between */
async function stored(file: string, n = 0): Promise<number[][]> {
  const { stdout } = await exec(
    await resolveFfmpeg(),
    [
      ...["-v", "error", "-i", file, "-vf", `select=eq(n\\,${n})`, "-frames:v", "1"],
      ...["-f", "rawvideo", "-pix_fmt", "yuv420p", "-"],
    ],
    { encoding: "buffer", maxBuffer: 1 << 24 },
  );
  const b = stdout as Buffer;
  assert.equal(b.length, (W * H * 3) / 2);
  return COLOURS.map((_, i) => {
    const [x, y] = centre(i);
    const c = (y / 2) * (W / 2) + x / 2;
    const Y = (b[y * W + x]! - 16) / 219;
    const U = (b[W * H + c]! - 128) / 224;
    const V = (b[W * H + (W * H) / 4 + c]! - 128) / 224;
    const [kr, kb] = [0.2126, 0.0722];
    const r = Y + 2 * (1 - kr) * V;
    const bl = Y + 2 * (1 - kb) * U;
    return [r, (Y - kr * r - kb * bl) / (1 - kr - kb), bl].map((v) =>
      Math.min(255, Math.max(0, 255 * v)),
    );
  });
}

/** what Chrome shows of `file` played in a <video>, at each cell's centre */
async function shownByChrome(file: string, at = 0.1): Promise<number[][]> {
  const page = join(dir, `show-${Math.random().toString(36).slice(2)}`);
  await mkdir(page, { recursive: true });
  await copyFile(file, join(page, "film.mp4"));
  await writeFile(
    join(page, "index.html"),
    `<!doctype html><html><body style="margin:0;background:#000">
<video id="v" src="film.mp4" muted style="position:absolute;left:0;top:0;width:${W}px;height:${H}px"></video>
<script>
window.__film = { duration: 1, width: ${W}, height: ${H} };
const v = document.getElementById("v");
window.__render = async (t) => {
  if (v.readyState < 2) await new Promise((r) => v.addEventListener("loadeddata", r, { once: true }));
  await new Promise((r) => { v.addEventListener("seeked", r, { once: true }); v.currentTime = t; });
};
</script></body></html>`,
  );
  const server = await serveDirectory(page);
  const b = await launchHtmlBrowser({
    chromePath: chrome!,
    url: `${server.url}/index.html`,
    width: W,
    height: H,
    initScript: filmClockSource({ seed: 1, epochMs: 0 }),
    stillAnimations: true,
  });
  try {
    await b.evaluate("window.__ot.prepare()");
    await b.evaluate(`window.__ot.seek(${at})`);
    const png = join(page, "shown.png");
    await writeFile(png, await b.screenshot({ format: "png" }));
    const { stdout } = await exec(
      await resolveFfmpeg(),
      ["-v", "error", "-i", png, "-f", "rawvideo", "-pix_fmt", "rgb24", "-"],
      { encoding: "buffer", maxBuffer: 1 << 24 },
    );
    const px = stdout as Buffer;
    return COLOURS.map((_, i) => {
      const [x, y] = centre(i);
      const o = (y * W + x) * 3;
      return [px[o]!, px[o + 1]!, px[o + 2]!];
    });
  } finally {
    await b.close();
    await server.close();
  }
}

function within(got: number[][], want: number[][], what: string, by = 2): void {
  got.forEach((g, i) => {
    assert.ok(
      g.every((v, k) => Math.abs(v - want[i]![k]!) <= by),
      `${what}, #${COLOURS[i]}: ${g.map(Math.round)} for ${want[i]!.map(Math.round)}`,
    );
  });
}

const SRGB = "tv,bt709,iec61966-2-1,bt709";

test("a film keeps the page's colours and names them sRGB, so Chrome shows them as the page had them", {
  skip,
}, async () => {
  const page = join(dir, "grid");
  await gridPage(page);
  const out = join(dir, "grid.mp4");
  await renderFilm({ page, out, chromePath: chrome!, blur: false, audio: null, workers: 1 });
  assert.equal(await tags(out), SRGB);
  const want = COLOURS.map(rgbOf);
  within(await stored(out), want, "encoded");
  // named BT.709's curve (as up to now), Chrome on macOS showed grey 128 as 139
  within(await shownByChrome(out), want, "shown by Chrome");
});

test("a master named BT.709's curve, patched with --into, names sRGB's throughout and keeps its colours; film mux keeps the name", {
  skip,
}, async () => {
  const page = join(dir, "patch");
  await gridPage(page);
  const master = join(dir, "master.mp4");
  await renderFilm({ page, out: master, chromePath: chrome!, blur: false, audio: null });
  // as `film render` named a master before: BT.709's curve for the same values
  const older = join(dir, "older.mp4");
  await exec(await resolveFfmpeg(), [
    ...["-v", "error", "-i", master, "-map", "0", "-c", "copy", "-map_metadata", "0"],
    ...[
      "-bsf:v",
      "h264_metadata=colour_primaries=1:transfer_characteristics=1:matrix_coefficients=1",
    ],
    // the container's colour box too, which ffprobe and players read first
    ...["-color_primaries", "bt709", "-color_trc", "bt709"],
    ...["-movflags", "+faststart+use_metadata_tags", "-y", older],
  ]);
  assert.equal(await tags(older), "tv,bt709,bt709,bt709");
  const kept = await stored(older, 5);
  // the second half changes: the cells swap places
  await gridPage(page, true);
  const patched = join(dir, "patched.mp4");
  await patchFilm({
    page,
    out: patched,
    into: older,
    from: 0.5,
    chromePath: chrome!,
    blur: false,
  });
  assert.equal(await tags(patched), SRGB, "one name for the whole master");
  within(await stored(patched, 5), kept, "the master's own frames", 1.5);
  within(
    await stored(patched, 20),
    COLOURS.map((_, i) => rgbOf(COLOURS[7 - i]!)),
    "the range's frames",
  );
  // a soundtrack put under it: the picture is copied, its name with it
  const sound = join(dir, "sound.wav");
  await exec(await resolveFfmpeg(), [
    ...["-v", "error", "-f", "lavfi", "-i", "sine=frequency=440:duration=1", "-y", sound],
  ]);
  const muxed = join(dir, "muxed.mp4");
  await muxFilm({ film: patched, audio: sound, out: muxed });
  assert.equal(await tags(muxed), SRGB);
  within(
    await shownByChrome(muxed, 0.7),
    COLOURS.map((_, i) => rgbOf(COLOURS[7 - i]!)),
    "the muxed film, shown by Chrome",
  );
});
