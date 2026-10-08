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
import { resolveFfmpeg, resolveFfprobe, SRGB_TAG_ARGS, SRGB_TAGS } from "../src/ffmpeg";
import { chunkList, framesOffIn, muxFilm, patchFilm, renderFilm } from "../src/film/render";
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
  // and still a master another range goes into
  await patchFilm({
    page,
    out: master,
    into: master,
    from: 1,
    to: 1.5,
    chromePath: chrome!,
    blur: false,
  });
  assert.equal(
    (await probe(master)).streams.find((s) => s.codec_type === "video")?.nb_frames,
    "60",
  );
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

test("a master whose frames are not evenly spaced, moved off 0, or that `film render` did not make, is refused", {
  skip,
}, async () => {
  const page = join(dir, "uneven");
  await colourPage(page, "rgb(0,255,0)");
  const ffmpeg = await resolveFfmpeg();
  const record = JSON.stringify({ from: 0, width: 64, height: 64, marks: [] });
  // 60 frames in 2 s, 30 a second on average — the first 30 over 1.5 s, the
  // rest over 0.5 s — and carrying the record `film render` writes
  const uneven = join(dir, "uneven.mp4");
  await exec(ffmpeg, [
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    // each frame 1/60 s long, so the last one ends the film at 2 s exactly
    "color=c=gray:s=64x64:r=60:d=1",
    "-vf",
    "settb=1/3000,setpts='if(lt(N,30),N*150,4500+(N-30)*50)'",
    "-fps_mode",
    "passthrough",
    "-enc_time_base",
    "1:3000",
    "-video_track_timescale",
    "3000",
    "-bf",
    "0",
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    "-metadata",
    `open_take_film=${record}`,
    "-movflags",
    "+use_metadata_tags",
    "-y",
    uneven,
  ]);
  // evenly spaced, the film's size, rate and length — but made elsewhere
  const elsewhere = join(dir, "elsewhere.mp4");
  await exec(ffmpeg, [
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "color=c=gray:s=64x64:r=30:d=2",
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    "-y",
    elsewhere,
  ]);
  // evenly spaced and carrying the record, but its picture (and sound)
  // moved a second late, as a remux with an offset leaves it
  const even = join(dir, "even.mp4");
  await exec(ffmpeg, [
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "color=c=gray:s=64x64:r=30:d=2",
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=440:duration=2",
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "aac",
    "-metadata",
    `open_take_film=${record}`,
    "-movflags",
    "+use_metadata_tags",
    "-y",
    even,
  ]);
  const late = join(dir, "late.mp4");
  await exec(ffmpeg, [
    "-v",
    "error",
    "-itsoffset",
    "1",
    "-i",
    even,
    "-map",
    "0",
    "-c",
    "copy",
    "-map_metadata",
    "0",
    "-movflags",
    "+use_metadata_tags",
    "-y",
    late,
  ]);
  for (const [into, why] of [
    [uneven, /not evenly spaced/],
    [elsewhere, /`film render` did not make it/],
    [late, /does not start at 0 s/],
  ] as const)
    await assert.rejects(
      patchFilm({
        page,
        out: join(dir, "patched.mp4"),
        into,
        from: 0.5,
        to: 1,
        chromePath: chrome!,
        blur: false,
      }),
      (e: Error) => /not a whole master of this film/.test(e.message) && why.test(e.message),
      into,
    );
});

/** the picture's timestamps, in presentation order */
async function ptsOf(file: string): Promise<number[]> {
  const { stdout } = await exec(await resolveFfprobe(), [
    "-v",
    "error",
    "-select_streams",
    "v:0",
    "-show_entries",
    "packet=pts",
    "-of",
    "csv=p=0",
    file,
  ]);
  return stdout
    .split("\n")
    .filter(Boolean)
    .map(Number)
    .sort((a, b) => a - b);
}

/** `n` grey frames at `fps`, 1/15360 ticks, named as a master names its
 *  colours; with `short`, the container says the last frame ends that many
 *  ticks early, as an MP4 whose edit list is in ms can (no B-frames, so no
 *  edit list of its own) */
async function greyChunk(file: string, n: number, fps: number, short = 0): Promise<void> {
  await exec(await resolveFfmpeg(), [
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    `color=c=gray:s=64x64:r=${fps}`,
    "-frames:v",
    String(n),
    "-vf",
    `format=yuv420p,${SRGB_TAGS}`,
    ...SRGB_TAG_ARGS,
    "-c:v",
    "libx264",
    "-bf",
    "0",
    "-pix_fmt",
    "yuv420p",
    "-bsf:v",
    `setts=time_base=1/15360:prescale=1:duration=if(eq(N\\,${n - 1})\\,DURATION-${short}\\,DURATION)`,
    "-video_track_timescale",
    "15360",
    "-y",
    file,
  ]);
}

test("the concat list names each chunk's length from the frames before it, so the lengths never drift", () => {
  const list = chunkList(
    [
      { file: "/t/a.mp4", frames: 180 },
      { file: "/t/b's.mp4", frames: 89 },
      { file: "/t/c.mp4", frames: 89 },
    ],
    60,
  );
  assert.equal(
    list,
    [
      "file '/t/a.mp4'",
      "duration 3.000000",
      "file '/t/b'\\''s.mp4'",
      "duration 1.483333",
      "file '/t/c.mp4'",
      // 358 frames end at 5.966667 s: this one takes the µs the last rounded off
      "duration 1.483334",
    ].join("\n"),
  );
});

test("frames a few ticks off n/fps are still frame n; one missing, doubled or half a frame off is not", () => {
  const even = Array.from({ length: 60 }, (_, i) => i * 256);
  assert.equal(framesOffIn(even, 256), null);
  // a master joined before chunks were placed exactly: from frame 30 on, 5 ticks early
  const early = even.map((t, i) => (i >= 30 ? t - 5 : t));
  assert.equal(framesOffIn(early, 256), null);
  assert.equal(framesOffIn([...even].reverse(), 256), null, "in decode order too");
  assert.equal(framesOffIn(early, 0), null, "with no rate named, its first step");
  const off = /not evenly spaced/;
  assert.match(framesOffIn([...even.slice(0, 30), ...even.slice(31)], 256) ?? "", off);
  assert.match(framesOffIn([...even.slice(0, 30), even[29]!, ...even.slice(30)], 256) ?? "", off);
  assert.match(
    framesOffIn(
      even.map((t, i) => (i === 40 ? t + 128 : t)),
      256,
    ) ?? "",
    off,
  );
  assert.match(
    framesOffIn(
      even.map((t) => t + 256),
      256,
    ) ?? "",
    /does not start at 0 s/,
  );
  assert.match(framesOffIn([], 256) ?? "", /no picture/);
});

test("a chunk whose container ends short does not move the frames after it", async () => {
  const ffmpeg = await resolveFfmpeg();
  const a = join(dir, "chunk-a.mp4");
  const b = join(dir, "chunk-b.mp4");
  // 89 frames at 60 fps: 1.48333 s, said as 5 ticks less
  await greyChunk(a, 89, 60, 5);
  await greyChunk(b, 60, 60);
  const join2 = async (listText: string) => {
    const list = join(dir, "chunks.txt");
    const out = join(dir, "joined.mp4");
    await writeFile(list, listText);
    await exec(
      ffmpeg,
      ["-v", "error", "-y", "-f", "concat", "-safe", "0", "-i", list].concat([
        "-map",
        "0:v",
        "-c:v",
        "copy",
        out,
      ]),
    );
    return ptsOf(out);
  };
  // left to itself the demuxer starts chunk b 5 ticks early: the case this guards
  const bare = await join2(`file '${a}'\nfile '${b}'`);
  assert.equal(bare[89]! - bare[88]!, 251, "the chunk's container says it ends short");
  const pts = await join2(
    chunkList(
      [
        { file: a, frames: 89 },
        { file: b, frames: 60 },
      ],
      60,
    ),
  );
  assert.equal(pts.length, 149);
  assert.deepEqual(
    pts,
    pts.map((_, i) => i * 256),
    "frame n at n/60 s",
  );
});

test("a master with frames a few ticks early, as a render joined them before, takes a range and comes out even", {
  skip,
}, async () => {
  const page = join(dir, "early");
  await colourPage(page, "rgb(0,255,0)");
  const ffmpeg = await resolveFfmpeg();
  // 60 frames at 30 fps: the first 29 in a chunk said to end 5 ticks short
  const a = join(dir, "early-a.mp4");
  const b = join(dir, "early-b.mp4");
  await greyChunk(a, 29, 30, 5);
  await greyChunk(b, 31, 30);
  const list = join(dir, "early.txt");
  await writeFile(list, `file '${a}'\nfile '${b}'`);
  const master = join(dir, "early.mp4");
  const record = JSON.stringify({ from: 0, width: 64, height: 64, marks: [] });
  await exec(ffmpeg, [
    "-v",
    "error",
    "-y",
    "-f",
    "concat",
    "-safe",
    "0",
    "-i",
    list,
    "-c:v",
    "copy",
    "-metadata",
    `open_take_film=${record}`,
    "-movflags",
    "+use_metadata_tags",
    master,
  ]);
  const before = await ptsOf(master);
  assert.equal(before[29]! - before[28]!, 507, "the master carries the early frames");
  const out = join(dir, "early-patched.mp4");
  const r = await patchFilm({
    page,
    out,
    into: master,
    from: 0.5,
    to: 1,
    chromePath: chrome!,
    blur: false,
  });
  assert.equal(r.frames, 60);
  const pts = await ptsOf(out);
  const step = pts[1]! - pts[0]!;
  assert.deepEqual(
    pts,
    pts.map((_, i) => i * step),
    "frame n at n/30 s",
  );
  near(await frameRgb(out, 20), [0, 255, 0], "the range: rendered");
  near(await frameRgb(out, 40), [128, 128, 128], "after it: the master's own");
});
