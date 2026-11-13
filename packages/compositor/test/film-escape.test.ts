// Leaving the kit: a film that uses kit/ for most of it and draws one passage
// entirely with its own WebGL (test/fixtures/escape-film). Rendered as a
// master, with motion blur and a soundtrack, then a range of it across the cut
// into the WebGL passage rendered again into it: every frame is where its time says, the cuts into and out of the
// WebGL passage are clean, the sound lands where it was put, the events file
// carries what the page declared, and the re-rendered range changes only
// itself. Chrome for Testing; skipped without it.

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { promisify } from "node:util";
import { camera } from "../kit/camera.js";
import { rise, spring } from "../kit/motion.js";
import { resolveFfmpeg, resolveFfprobe } from "../src/ffmpeg";
import { initFilm } from "../src/film/kit";
import { type FilmEvents, patchFilm, renderFilm } from "../src/film/render";
import { findChrome } from "./fixtures/find-chrome";

const exec = promisify(execFile);
const chrome = findChrome();
const skip = chrome ? false : "no Chrome for Testing";
const W = 320;
const H = 180;
const FPS = 30;

let dir = "";
let film = "";
before(async () => {
  dir = await mkdtemp(join(tmpdir(), "open-take-escape-test-"));
  film = join(dir, "film");
  await cp(join(import.meta.dirname, "fixtures", "escape-film"), film, { recursive: true });
  // the kit goes in beside the page, as `film init` puts it; the page is kept
  const init = await initFilm({ dir: film, starter: false });
  assert.ok(!init.written.some((f) => f.endsWith("index.html")), "the film's own page is kept");
  // a 1 kHz click every half second from 0.5 s: where the sound is, exactly
  await exec(await resolveFfmpeg(), [
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "aevalsrc='if(gte(t,0.45)*lt(mod(t,0.5),0.03),0.6*sin(2*PI*1000*t),0)':s=48000:d=3",
    "-y",
    join(film, "score.wav"),
  ]);
});
after(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** frame n as RGB rows */
async function frame(file: string, n: number): Promise<Buffer> {
  const { stdout } = await exec(
    await resolveFfmpeg(),
    [
      "-v",
      "error",
      "-i",
      file,
      "-vf",
      `select=eq(n\\,${n}),format=rgb24`,
      "-frames:v",
      "1",
      "-f",
      "rawvideo",
      "-pix_fmt",
      "rgb24",
      "-",
    ],
    { encoding: "buffer", maxBuffer: 64 << 20 },
  );
  assert.equal((stdout as Buffer).length, W * H * 3, `frame ${n} decoded`);
  return stdout as Buffer;
}

type Rgb = [number, number, number];
const at = (f: Buffer, x: number, y: number): Rgb => {
  const i = (y * W + x) * 3;
  return [f[i]!, f[i + 1]!, f[i + 2]!];
};
const red = ([r, g, b]: Rgb) => r > 150 && g < 90 && b < 90;
const blue = ([r, g, b]: Rgb) => r < 90 && g < 90 && b > 150;
const yellow = ([r, g, b]: Rgb) => r > 170 && g > 170 && b < 90;
const magenta = ([r, g, b]: Rgb) => r > 170 && g < 90 && b > 170;

/** where the pixels `is` picks are, weighted by how many: null when none */
function centroid(f: Buffer, is: (c: Rgb) => boolean): { x: number; y: number; n: number } | null {
  let sx = 0;
  let sy = 0;
  let n = 0;
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++)
      if (is(at(f, x, y))) {
        sx += x + 0.5;
        sy += y + 0.5;
        n++;
      }
  return n ? { x: sx / n, y: sy / n, n } : null;
}

const near = (a: number[], b: number[], tol: number, what: string) =>
  assert.ok(
    a.every((v, i) => Math.abs(v - b[i]!) <= tol),
    `${what}: ${a.map((v) => v.toFixed(2)).join(",")} vs ${b.map((v) => v.toFixed(2)).join(",")} (±${tol})`,
  );

// where the page puts its squares, from the same kit functions
const cam = camera({ content: { width: W, height: H } });
cam.frame({ x: 100, y: 50, width: 120, height: 80 }, { start: 0.1, dur: 0.6 });
cam.cut({ cx: 160, cy: 90, w: 320 }, 2);
const redAt = (t: number) => {
  const w = rise(t, 0.2, { dy: 40 });
  return cam.toView(145 + w.x, 95 + w.y, t);
};
const blueAt = (t: number) => cam.toView(55 + 200 * spring(t, { start: 2.1 }), 135, t);
const quadAt = (t: number) => [40 + 200 * (t - 1) + 15, 90];
const PALETTE: Rgb[] = [
  [64, 0, 0],
  [0, 64, 0],
  [0, 0, 64],
  [64, 64, 0],
  [0, 64, 64],
];

/** where each click of the soundtrack starts in the film's sound (s) */
async function clicks(file: string): Promise<number[]> {
  const { stdout } = await exec(
    await resolveFfmpeg(),
    ["-v", "error", "-i", file, "-map", "0:a", "-ac", "1", "-ar", "48000", "-f", "f32le", "-"],
    { encoding: "buffer", maxBuffer: 64 << 20 },
  );
  const pcm = new Float32Array(
    (stdout as Buffer).buffer,
    (stdout as Buffer).byteOffset,
    (stdout as Buffer).length / 4,
  );
  const out: number[] = [];
  let quiet = 48000; // samples since the last loud one
  for (let i = 0; i < pcm.length; i++) {
    if (Math.abs(pcm[i]!) > 0.05) {
      if (quiet > 0.2 * 48000) out.push(i / 48000);
      quiet = 0;
    } else quiet++;
  }
  return out;
}

const readEvents = async (file: string) => JSON.parse(await readFile(file, "utf8")) as FilmEvents;

test("a passage drawn by the page's own WebGL keeps the film's time, cuts, sound and events", {
  skip,
}, async () => {
  const master = join(dir, "escape.mp4");
  const r = await renderFilm({ page: film, out: master, chromePath: chrome!, workers: 1 });
  assert.equal(r.frames, 3 * FPS);
  assert.equal(r.mode, "render");
  assert.ok(r.samples > r.frames, "blur sampled the moving frames (WebGL included)");

  // --- every frame where its time says ----------------------------------------------
  for (const n of [18, 24]) {
    const c = centroid(await frame(master, n), red);
    assert.ok(c, `frame ${n}: the kit's square is there`);
    near([c.x, c.y], redAt(n / FPS), 1.5, `frame ${n} (kit: camera + rise)`);
  }
  assert.equal(centroid(await frame(master, 3), red), null, "frame 3: before the rise, nothing");
  for (const n of [33, 39, 51, 57]) {
    const f = await frame(master, n);
    const c = centroid(f, yellow);
    assert.ok(c, `frame ${n}: the shader's quad is there`);
    near([c.x, c.y], quadAt(n / FPS), 1.5, `frame ${n} (WebGL quad)`);
    near(
      at(f, 5, 5),
      PALETTE[Math.floor((n / FPS - 1) / 0.2 + 1e-9)]!,
      16,
      `frame ${n} background`,
    );
  }
  for (const n of [69, 80]) {
    const c = centroid(await frame(master, n), blue);
    assert.ok(c, `frame ${n}: back in the kit`);
    near([c.x, c.y], blueAt(n / FPS), 1.5, `frame ${n} (kit: spring)`);
  }

  // --- the cuts into and out of it are clean: no frame shows both sides --------
  const last = await frame(master, 29);
  assert.ok(centroid(last, red) && !centroid(last, yellow), "frame 29: the kit only");
  const firstGl = await frame(master, 30);
  assert.ok(!centroid(firstGl, red) && centroid(firstGl, yellow), "frame 30: WebGL only");
  near(at(firstGl, 5, 5), PALETTE[0]!, 16, "frame 30: no trace of the kit's background");
  const lastGl = await frame(master, 59);
  assert.ok(centroid(lastGl, yellow) && !centroid(lastGl, blue), "frame 59: WebGL only");
  const back = await frame(master, 60);
  assert.ok(!centroid(back, yellow) && centroid(back, blue), "frame 60: the kit only");

  // --- the flash at 1.5 s and the click at 1.5 s are together -----------------------
  assert.ok(!centroid(await frame(master, 44), magenta), "frame 44: before the flash");
  for (const n of [46, 47])
    assert.ok(centroid(await frame(master, n), magenta), `frame ${n}: flash`);
  const heard = await clicks(master);
  assert.equal(heard.length, 5, `five clicks: ${heard.join(", ")}`);
  for (const [i, t] of heard.entries()) near([t], [0.5 * (i + 1)], 0.012, `click ${i + 1}`);

  // --- the events file says what the page declared ----------------------------------
  const ev = await readEvents(r.events!);
  assert.deepEqual(ev.declaredCuts, [1, 2]);
  assert.ok(
    ev.cuts.some((t) => Math.abs(t - 1) < 1e-6) && ev.cuts.some((t) => Math.abs(t - 2) < 1e-6),
    `cuts at 1 and 2 s: ${ev.cuts.join(", ")}`,
  );
  // the blur probe found both cuts in the picture itself, the WebGL side
  // included (it also finds the passage's own jumps: its background steps
  // every 0.2 s and its quad changes colour at 1.5 s)
  for (const t of [1, 1.2, 1.4, 1.5, 1.6, 1.8, 2])
    assert.ok(
      ev.detectedCuts.some((d) => Math.abs(d - t) < 1e-6),
      `a jump of the picture found at ${t} s: ${ev.detectedCuts.join(", ")}`,
    );
  const flash = ev.events.find((e) => e.kind === "flash");
  assert.deepEqual(flash, { t: 1.5, kind: "flash", x: 145, y: 90, force: 1 });
  // the beat sheet the page declared, the WebGL passage one segment of it
  const segments = (
    ev as FilmEvents & { segments?: { from: number; to: number; label?: string }[] }
  ).segments;
  assert.deepEqual(
    segments?.map((s) => [s.from, s.to, s.label]),
    [
      [0, 1, "kit"],
      [1, 2, "webgl"],
      [2, 3, "kit again"],
    ],
  );

  // --- a range across the cut into the WebGL passage rendered again: only it changes
  const before = await Promise.all([18, 27, 29, 57, 69].map((n) => frame(master, n)));
  await writeFile(
    join(film, "look.js"),
    "window.PALETTE = [[0.5,0.5,0.5],[0.5,0.5,0.5],[0.5,0.5,0.5],[0.5,0.5,0.5],[0.5,0.5,0.5]];\n",
  );
  const p = await patchFilm({
    page: film,
    out: master,
    into: master,
    from: 0.9,
    to: 1.8,
    chromePath: chrome!,
    workers: 1,
  });
  assert.equal(p.frames, 3 * FPS, "a whole master comes back");
  const { stdout } = await exec(await resolveFfprobe(), [
    "-v",
    "error",
    "-count_frames",
    "-select_streams",
    "v",
    "-show_entries",
    "stream=nb_read_frames",
    "-of",
    "default=nw=1:nk=1",
    master,
  ]);
  assert.equal(stdout.trim(), String(3 * FPS), "the whole film, as long as before");
  for (const n of [30, 39, 45, 51]) {
    const f = await frame(master, n);
    near(at(f, 5, 5), [128, 128, 128], 16, `frame ${n}: the new look`);
    const c = centroid(f, n >= 45 && n < 48 ? magenta : yellow);
    assert.ok(c, `frame ${n}: the quad`);
    near([c.x, c.y], quadAt(n / FPS), 1.5, `frame ${n}: still where its time says`);
  }
  // outside the range the frames are the ones rendered before (re-encoded
  // once), and so are the kit's frames inside it, before the cut (rendered again)
  const after = await Promise.all([18, 27, 29, 57, 69].map((n) => frame(master, n)));
  [18, 27, 29, 57, 69].forEach((n, i) => {
    let diff = 0;
    for (let k = 0; k < after[i]!.length; k++) diff += Math.abs(after[i]![k]! - before[i]![k]!);
    assert.ok(
      diff / after[i]!.length < 3,
      `frame ${n} as it was (mean difference ${diff / after[i]!.length})`,
    );
  });
  assert.ok(!centroid(after[2]!, yellow), "frame 29: still the kit only");
  near(at(await frame(master, 57), 5, 5), PALETTE[4]!, 16, "frame 57: the old look");
  // the sound is the master's, where it was
  const again = await clicks(master);
  assert.equal(again.length, 5);
  for (const [i, t] of again.entries())
    near([t], [0.5 * (i + 1)], 0.012, `click ${i + 1} after the patch`);
  // and the events file still carries the whole film's
  const pe = await readEvents(p.events!);
  assert.deepEqual(pe.declaredCuts, [1, 2]);
  assert.ok(pe.events.some((e) => e.kind === "flash" && e.t === 1.5));
  assert.equal(pe.range, undefined, "a whole film's events, not the range's");
});
