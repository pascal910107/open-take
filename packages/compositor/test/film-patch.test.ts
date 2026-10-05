// Rendering a film's master once: a few seconds rendered again into it
// (patchFilm, `film render --into`) and a new soundtrack put under it
// (muxFilm, `film mux`). Chrome for Testing; the browser tests skip without it.

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { promisify } from "node:util";
import { resolveFfmpeg, resolveFfprobe } from "../src/ffmpeg";
import { muxFilm, patchFilm, renderFilm } from "../src/film/render";
import { findChrome } from "./fixtures/find-chrome";

const exec = promisify(execFile);
const chrome = findChrome();
const skip = chrome ? false : "no Chrome for Testing";

let dir = "";
before(async () => {
  dir = await mkdtemp(join(tmpdir(), "open-take-patch-test-"));
});
after(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** a 2 s page, 64×64 at 30 fps: its colour at t comes from colours.js */
async function colourPage(page: string, middle: string): Promise<void> {
  await exec("mkdir", ["-p", page]);
  await writeFile(
    join(page, "colours.js"),
    `window.colourAt = (t) => (t < 0.5 ? "rgb(255,0,0)" : t < 1 ? "${middle}" : "rgb(0,0,255)");`,
  );
  await writeFile(
    join(page, "index.html"),
    `<!doctype html><html><head><script src="colours.js"></script></head><body style="margin:0">
<script>
window.__film = { duration: 2, width: 64, height: 64, fps: 30 };
window.__render = (t) => { document.body.style.background = window.colourAt(t); };
</script></body></html>`,
  );
}

/** frame n of a film, its centre pixel */
async function frameRgb(file: string, n: number): Promise<number[]> {
  const { stdout } = await exec(
    await resolveFfmpeg(),
    [
      "-v",
      "error",
      "-i",
      file,
      "-vf",
      // RGB before the crop: a 4:2:0 picture cannot be cut to a single pixel
      `select=eq(n\\,${n}),format=rgb24,crop=1:1:32:32`,
      "-frames:v",
      "1",
      "-f",
      "rawvideo",
      "-pix_fmt",
      "rgb24",
      "-",
    ],
    { encoding: "buffer" },
  );
  const b = stdout as Buffer;
  return [b[0]!, b[1]!, b[2]!];
}
const near = (a: number[], b: number[], what: string) =>
  assert.ok(
    a.every((v, i) => Math.abs(v - b[i]!) <= 16),
    `${what}: ${a.join(",")} vs ${b.join(",")}`,
  );

async function probe(file: string) {
  const { stdout } = await exec(await resolveFfprobe(), [
    "-v",
    "error",
    "-show_entries",
    "stream=codec_type,codec_name,nb_frames,sample_rate:format=duration:format_tags",
    "-of",
    "json",
    file,
  ]);
  return JSON.parse(stdout) as {
    streams: { codec_type: string; codec_name: string; nb_frames?: string; sample_rate?: string }[];
    format: { duration: string; tags?: Record<string, string> };
  };
}

test("a few seconds rendered again go into the master in place of their own; the rest stays as it was", {
  skip,
}, async () => {
  const page = join(dir, "patch");
  await colourPage(page, "rgb(0,255,0)");
  const master = join(dir, "master.mp4");
  await renderFilm({ page, out: master, chromePath: chrome!, blur: false, audio: null });
  // the middle second changes: only it is rendered again
  await colourPage(page, "rgb(255,255,255)");
  const r = await patchFilm({
    page,
    out: master,
    into: master,
    from: 0.5,
    to: 1,
    chromePath: chrome!,
    blur: false,
  });
  assert.equal(r.frames, 60, "the whole film, as long as before");
  const p = await probe(master);
  assert.equal(p.streams.find((s) => s.codec_type === "video")?.nb_frames, "60");
  near(await frameRgb(master, 7), [255, 0, 0], "before the range: as it was");
  near(await frameRgb(master, 14), [255, 0, 0], "the last frame before it");
  near(await frameRgb(master, 15), [255, 255, 255], "the range's first frame: new");
  near(await frameRgb(master, 29), [255, 255, 255], "its last frame: new");
  near(await frameRgb(master, 30), [0, 0, 255], "after it: as it was");
  near(await frameRgb(master, 59), [0, 0, 255], "the film's last frame");
  const record = JSON.parse(p.format.tags?.open_take_film ?? "{}") as { from?: number };
  assert.equal(record.from, 0, "still a whole film for `film check`");
  // a master that is not this film's whole length is refused, by name
  const short = join(dir, "short.mp4");
  await renderFilm({ page, out: short, to: 1, chromePath: chrome!, blur: false, audio: null });
  await assert.rejects(
    patchFilm({
      page,
      out: short,
      into: short,
      from: 0.5,
      to: 1,
      chromePath: chrome!,
      blur: false,
    }),
    /not a whole master of this film/,
  );
});

test("a new soundtrack goes under a film without rendering it again; none leaves it silent", {
  skip,
}, async () => {
  const page = join(dir, "mux");
  await colourPage(page, "rgb(0,255,0)");
  const film = join(dir, "silent.mp4");
  await renderFilm({ page, out: film, chromePath: chrome!, blur: false, audio: null });
  const wav = join(dir, "tone.wav");
  await exec(await resolveFfmpeg(), [
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=440:duration=3",
    "-y",
    wav,
  ]);
  const out = join(dir, "sound.mp4");
  await muxFilm({ film, audio: wav, out });
  const picture = async (f: string) =>
    (
      await exec(await resolveFfmpeg(), [
        "-v",
        "error",
        "-i",
        f,
        "-map",
        "0:v",
        "-c",
        "copy",
        "-f",
        "md5",
        "-",
      ])
    ).stdout.trim();
  assert.equal(await picture(out), await picture(film), "the picture is copied as it is");
  const p = await probe(out);
  const a = p.streams.find((s) => s.codec_type === "audio");
  assert.deepEqual([a?.codec_name, a?.sample_rate], ["aac", "48000"]);
  assert.ok(
    Math.abs(Number(p.format.duration) - 2) < 0.05,
    `as long as the film: ${p.format.duration}`,
  );
  const silent = join(dir, "silent-again.mp4");
  await muxFilm({ film: out, audio: null, out: silent });
  assert.equal((await probe(silent)).streams.filter((s) => s.codec_type === "audio").length, 0);
});
