// A film-timed <video> shown as its decoded frames (film/frames.ts and the
// film clock): the frame at film time, wherever it is drawn. Chrome for
// Testing; the browser tests skip without it.

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { promisify } from "node:util";
import { resolveFfmpeg } from "../src/ffmpeg";
import { filmClockSource } from "../src/film/clock";
import { decodeFrames, frameStore, type VideoFrames } from "../src/film/frames";
import { filmStills } from "../src/film/render";
import { launchHtmlBrowser } from "../src/html/cdp";
import { serveDirectory } from "../src/html/server";
import { findChrome } from "./fixtures/find-chrome";

const exec = promisify(execFile);
const chrome = findChrome();
const skip = chrome ? false : "no Chrome for Testing";

let dir = "";
before(async () => {
  dir = await mkdtemp(join(tmpdir(), "open-take-frames-test-"));
});
after(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** frame N a flat colour — red N×12, green 255−N×12, blue 128 — tagged so
 *  that Chrome shows its colours as they are (BT.601 full range, the sRGB
 *  curve): 2 s at 10 fps by default; `startAt` puts its picture that late,
 *  with sound from 0 */
async function numberedClip(
  file: string,
  o: { rate?: string; seconds?: number; startAt?: number } = {},
): Promise<void> {
  const rate = o.rate ?? "10";
  const late = o.startAt ? [`setpts=PTS+${o.startAt}/TB`] : [];
  await exec(await resolveFfmpeg(), [
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    `color=c=black:s=64x64:r=${rate}:d=${o.seconds ?? 2},format=rgb24,geq=r='N*12':g='255-N*12':b='128'`,
    ...(o.startAt ? ["-f", "lavfi", "-i", "sine=frequency=440:duration=3"] : []),
    "-vf",
    ["scale=out_color_matrix=bt601:out_range=pc", "format=yuvj420p", ...late].join(","),
    "-c:v",
    "libx264",
    "-g",
    "30",
    "-bsf:v",
    "h264_metadata=colour_primaries=1:transfer_characteristics=13:matrix_coefficients=5:video_full_range_flag=1",
    ...(o.startAt ? ["-c:a", "aac"] : []),
    "-y",
    file,
  ]);
}
const colourOf = (n: number) => [n * 12, 255 - n * 12, 128];

/** the RGB at (x, y) of a PNG `w` px wide */
async function pixel(file: string, w: number, h: number, x: number, y: number) {
  const { stdout } = await exec(
    await resolveFfmpeg(),
    ["-v", "error", "-i", file, "-f", "rawvideo", "-pix_fmt", "rgb24", "-"],
    { encoding: "buffer", maxBuffer: 1 << 24 },
  );
  const b = stdout as Buffer;
  assert.equal(b.length, w * h * 3);
  const i = (y * w + x) * 3;
  return [b[i]!, b[i + 1]!, b[i + 2]!];
}
const near = (a: number[], b: number[], what: string, within = 12) =>
  assert.ok(
    a.every((v, i) => Math.abs(v - b[i]!) <= within),
    `${what}: ${a.join(",")} vs ${b.join(",")}`,
  );

/** what Chrome itself shows of the page at t — its video elements sought, as
 *  every render did before frames — at each (x, y) */
async function shownByChrome(
  page: string,
  file: string,
  w: number,
  h: number,
  t: number,
  at: [number, number][],
): Promise<number[][]> {
  const server = await serveDirectory(page);
  const b = await launchHtmlBrowser({
    chromePath: chrome!,
    url: `${server.url}/${file}`,
    width: w,
    height: h,
    initScript: filmClockSource({ seed: 1, epochMs: 0 }),
    stillAnimations: true,
  });
  try {
    await b.evaluate("window.__ot.prepare()");
    await b.evaluate(`window.__ot.seek(${t})`);
    const png = join(page, `chrome-${t}.png`);
    await writeFile(png, await b.screenshot({ format: "png" }));
    return await Promise.all(at.map(([x, y]) => pixel(png, w, h, x, y)));
  } finally {
    await b.close();
    await server.close();
  }
}

/** a film page: a video of `clip` filling w×h, set to film time by the page */
const videoPage = (clip: string, w: number, h: number) =>
  `<!doctype html><html><body style="margin:0;background:#000">
<video id="v" src="${clip}" muted style="position:absolute;left:0;top:0;width:${w}px;height:${h}px"></video>
<script>
window.__film = { duration: 2, width: ${w}, height: ${h} };
const v = document.getElementById("v");
window.__render = async (t) => {
  if (v.readyState < 2) await new Promise((r) => v.addEventListener("loadeddata", r, { once: true }));
  await new Promise((r) => { v.addEventListener("seeked", r, { once: true }); v.currentTime = t; });
};
</script></body></html>`;

test("a video's frames come out in presentation order, each with its own time, a varying rate included", async () => {
  const out = join(dir, "vfr");
  await exec("mkdir", ["-p", join(out, "frames")]);
  // frame N at N²/100 s: 0, 0.01, 0.04 … 0.81
  await exec(await resolveFfmpeg(), [
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "color=c=red:s=32x32:r=10:d=1",
    "-vf",
    // in milliseconds all the way: a coarser time base would round them away
    "settb=1/1000,setpts=N*N*10",
    "-fps_mode",
    "passthrough",
    "-enc_time_base",
    "1:1000",
    "-video_track_timescale",
    "1000",
    "-c:v",
    "libx264",
    "-y",
    join(out, "vfr.mp4"),
  ]);
  const { times, ext } = await decodeFrames(join(out, "vfr.mp4"), join(out, "frames"));
  assert.equal(ext, "jpg");
  assert.equal(times.length, 10);
  for (const [n, t] of times.entries())
    assert.ok(Math.abs(t - (n * n) / 100) < 0.002, `frame ${n} at ${t}, not ${(n * n) / 100}`);
  assert.equal((await readdir(join(out, "frames"))).length, 10);
});

test("a film-timed video shows the frame at film time — sought by the page, played by itself, or drawn into a canvas", {
  skip,
}, async () => {
  const page = join(dir, "shown");
  await exec("mkdir", ["-p", page]);
  await numberedClip(join(page, "clip.mp4"));
  // left: a video the page sets to t and waits for; middle: a canvas the
  // page draws that video into once it is there; right: a video playing by
  // itself on film time. A strip under each says how it was shown: green
  // for its frame image, red for the element sought
  await writeFile(
    join(page, "index.html"),
    `<!doctype html><html><head><style>body{margin:0;width:192px;height:80px;background:#000}
video,canvas{position:absolute;top:0;width:64px;height:64px}
.flag{position:absolute;top:66px;width:64px;height:14px}</style></head><body>
<video id="a" src="clip.mp4" muted style="left:0"></video>
<canvas id="c" width="64" height="64" style="left:64px"></canvas>
<video id="p" src="clip.mp4" muted autoplay style="left:128px"></video>
<div class="flag" id="fa" style="left:0"></div><div class="flag" id="fp" style="left:128px"></div>
<script>
window.__film = { duration: 2, width: 192, height: 80 };
const a = document.getElementById("a"), p = document.getElementById("p");
const c = document.getElementById("c").getContext("2d");
const framed = (v) => getComputedStyle(v).content.includes("/__open-take/frames/");
window.__render = async (t) => {
  if (a.readyState < 1) await new Promise((r) => a.addEventListener("loadedmetadata", r, { once: true }));
  await new Promise((r) => { a.addEventListener("seeked", r, { once: true }); a.currentTime = t; });
  c.drawImage(a, 0, 0, 64, 64);
  document.getElementById("fa").style.background = framed(a) ? "#0f0" : "#f00";
  document.getElementById("fp").style.background = framed(p) ? "#0f0" : "#f00";
};
</script></body></html>`,
  );
  const out = join(page, "stills");
  const files = await filmStills({
    page,
    outDir: out,
    at: [0.25, 0.95, 1.55],
    chromePath: chrome!,
  });
  for (const [k, t] of [0.25, 0.95, 1.55].entries()) {
    const f = files[k]!;
    const n = Math.floor(t * 10 + 1e-6);
    near(await pixel(f, 192, 80, 32, 32), colourOf(n), `the page's video at ${t}s`);
    near(await pixel(f, 192, 80, 96, 32), colourOf(n), `the canvas at ${t}s`);
    near(await pixel(f, 192, 80, 160, 32), colourOf(n), `the playing video at ${t}s`);
    if (k > 0) {
      near(await pixel(f, 192, 80, 32, 72), [0, 255, 0], `the page's video framed at ${t}s`);
      near(await pixel(f, 192, 80, 160, 72), [0, 255, 0], `the playing video framed at ${t}s`);
    }
  }
});

test("a video the page reads frame by frame itself, and any video with no renderer to ask, is sought as before", {
  skip,
}, async () => {
  const page = join(dir, "sought");
  await exec("mkdir", ["-p", page]);
  await numberedClip(join(page, "clip.mp4"));
  await writeFile(
    join(page, "index.html"),
    `<!doctype html><html><body style="margin:0">
<video id="r" src="clip.mp4" muted autoplay></video><video id="v" src="clip.mp4" muted autoplay></video>
<script>
window.__film = { duration: 2 };
const r = document.getElementById("r");
r.requestVideoFrameCallback(() => {});
window.framed = () => ["r", "v"].map((id) =>
  getComputedStyle(document.getElementById(id)).content.includes("/__open-take/frames/")).join();
window.at = () => ["r", "v"].map((id) => Math.round(document.getElementById(id).currentTime * 1000)).join();
</script></body></html>`,
  );
  const server = await serveDirectory(page);
  const store = frameStore({ root: page, server });
  const open = async (withRenderer: boolean) => {
    let b: Awaited<ReturnType<typeof launchHtmlBrowser>> | null = null;
    b = await launchHtmlBrowser({
      chromePath: chrome!,
      url: `${server.url}/index.html`,
      width: 128,
      height: 64,
      initScript: filmClockSource({ seed: 1, epochMs: 0 }),
      stillAnimations: true,
      ...(withRenderer
        ? {
            bindings: {
              __otFrames: (payload: string) => {
                const { src } = JSON.parse(payload) as { src: string };
                const reply = (f: VideoFrames | null) =>
                  b?.evaluate(
                    `window.__ot.framesReady(${JSON.stringify(src)}, ${JSON.stringify(f)})`,
                  );
                store.frames(src).then(reply, () => reply(null));
              },
            },
          }
        : {}),
    });
    return b;
  };
  try {
    for (const withRenderer of [true, false]) {
      const b = await open(withRenderer);
      try {
        await b.evaluate("window.__ot.prepare()");
        for (let i = 0; i < 300; i++) {
          if (await b.evaluate<boolean>("document.getElementById('v').readyState >= 2")) break;
          await new Promise((ok) => setTimeout(ok, 10));
        }
        await b.evaluate("window.__ot.seek(1.25)");
        assert.equal(
          await b.evaluate<string>("window.framed()"),
          withRenderer ? "false,true" : "false,false",
          withRenderer
            ? "the video read frame by frame is sought; the other framed"
            : "no renderer: both sought",
        );
        assert.equal(await b.evaluate<string>("window.at()"), "1250,1250", "both at film time");
      } finally {
        await b.close();
      }
    }
  } finally {
    await store.clean();
    await server.close();
  }
});

/** a clip of one flat colour, tagged as numberedClip's */
async function flatClip(file: string, colour: string): Promise<void> {
  await exec(await resolveFfmpeg(), [
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    `color=c=${colour}:s=64x64:r=10:d=2`,
    "-vf",
    "scale=out_color_matrix=bt601:out_range=pc,format=yuvj420p",
    "-c:v",
    "libx264",
    "-bsf:v",
    "h264_metadata=colour_primaries=1:transfer_characteristics=13:matrix_coefficients=5:video_full_range_flag=1",
    "-y",
    file,
  ]);
}

test("a video too long, too large or too slow to decode as frames is refused within its limits", async () => {
  const out = join(dir, "budget");
  for (const d of ["frames", "bytes", "time"]) await exec("mkdir", ["-p", join(out, d)]);
  await numberedClip(join(out, "clip.mp4"));
  const clip = join(out, "clip.mp4");
  await assert.rejects(decodeFrames(clip, join(out, "frames"), { maxFrames: 5 }), /20 frames/);
  await assert.rejects(decodeFrames(clip, join(out, "bytes"), { maxBytes: 2000 }), /disk/);
  await assert.rejects(decodeFrames(clip, join(out, "time"), { maxMs: 1 }), /seconds/);
});

test("a video in wide-gamut or HDR colours is not decoded as frames: Chrome maps those itself", async () => {
  const out = join(dir, "gamut");
  await exec("mkdir", ["-p", out]);
  const cases: [string, string, RegExp][] = [
    // Display P3 with sRGB's curve, BT.2020, and PQ: the H.264 colour fields
    [
      "p3",
      "colour_primaries=12:transfer_characteristics=13:matrix_coefficients=1",
      /smpte432 primaries/,
    ],
    [
      "bt2020",
      "colour_primaries=9:transfer_characteristics=1:matrix_coefficients=9",
      /bt2020 primaries/,
    ],
    ["pq", "colour_primaries=9:transfer_characteristics=16:matrix_coefficients=9", /HDR/],
  ];
  for (const [name, fields, why] of cases) {
    const clip = join(out, `${name}.mp4`);
    await exec(await resolveFfmpeg(), [
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      "color=c=orange:s=64x64:r=10:d=1",
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      "-bsf:v",
      `h264_metadata=${fields}`,
      "-y",
      clip,
    ]);
    await exec("mkdir", ["-p", join(out, name)]);
    await assert.rejects(decodeFrames(clip, join(out, name)), why, name);
    assert.deepEqual(await readdir(join(out, name)), [], `${name}: nothing written`);
  }
});

test("a video's frames keep the colours Chrome gives it, on the page and in a canvas — grey and red tagged BT.709, a take's green and a recording's orange", {
  skip,
}, async () => {
  const page = join(dir, "colours");
  await exec("mkdir", ["-p", page]);
  const ffmpeg = await resolveFfmpeg();
  const clips: [string, string, string, string][] = [
    // name, colour, how it is encoded, the stream's colour fields
    [
      "grey709",
      "0x808080",
      "scale=out_color_matrix=bt709:out_range=tv,format=yuv420p",
      "colour_primaries=1:transfer_characteristics=1:matrix_coefficients=1",
    ],
    [
      "red709",
      "red",
      "scale=out_color_matrix=bt709:out_range=tv,format=yuv420p",
      "colour_primaries=1:transfer_characteristics=1:matrix_coefficients=1",
    ],
    // as the runtime records a take: BT.709 limited range, sRGB's curve named
    [
      "recording",
      "0x1d4d3c",
      "scale=out_color_matrix=bt709:out_range=tv,format=yuv420p",
      "colour_primaries=1:transfer_characteristics=13:matrix_coefficients=1",
    ],
    // as ffmpeg makes a video of JPEG screenshots: BT.601 full range, nothing else said
    [
      "orange",
      "0xC86432",
      "scale=out_color_matrix=bt601:out_range=pc,format=yuvj420p,setparams=colorspace=bt470bg:color_primaries=unknown:color_trc=unknown:range=pc",
      "",
    ],
  ];
  for (const [name, colour, encode, fields] of clips) {
    await exec(ffmpeg, [
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      // a recording's size: Chrome guesses what the tags leave out by size
      `color=c=${colour}:s=1280x720:r=10:d=2`,
      "-vf",
      encode,
      "-c:v",
      "libx264",
      ...(fields ? ["-bsf:v", `h264_metadata=${fields}`] : []),
      "-y",
      join(page, `${name}.mp4`),
    ]);
    // the video, and a canvas the page draws it into
    await writeFile(
      join(page, `${name}.html`),
      `<!doctype html><html><body style="margin:0;width:128px;height:64px;background:#000">
<video id="v" src="${name}.mp4" muted style="position:absolute;left:0;top:0;width:64px;height:64px"></video>
<canvas id="c" width="64" height="64" style="position:absolute;left:64px;top:0"></canvas>
<script>
window.__film = { duration: 2, width: 128, height: 64 };
const v = document.getElementById("v"), c = document.getElementById("c").getContext("2d");
window.__render = async (t) => {
  if (v.readyState < 2) await new Promise((r) => v.addEventListener("loadeddata", r, { once: true }));
  await new Promise((r) => { v.addEventListener("seeked", r, { once: true }); v.currentTime = t; });
  c.drawImage(v, 0, 0, 64, 64);
};
</script></body></html>`,
    );
    // at 0.5 s the video is shown as its frames (the first instant drawn shows it so)
    const [, still] = await filmStills({
      page: join(page, `${name}.html`),
      outDir: join(page, `stills-${name}`),
      at: [0.25, 0.5],
      chromePath: chrome!,
      blur: false,
    });
    const [video, canvas] = await shownByChrome(page, `${name}.html`, 128, 64, 0.5, [
      [32, 32],
      [96, 32],
    ]);
    near(await pixel(still!, 128, 64, 32, 32), video!, `${name}: as frames, against Chrome`, 4);
    near(
      await pixel(still!, 128, 64, 96, 32),
      canvas!,
      `${name}: drawn into a canvas, against Chrome`,
      4,
    );
  }
});

test("a video the page sets reads as seeking until its frame is there", { skip }, async () => {
  const page = join(dir, "seeking");
  await exec("mkdir", ["-p", page]);
  await numberedClip(join(page, "clip.mp4"));
  await writeFile(
    join(page, "index.html"),
    `<!doctype html><html><body style="margin:0;width:128px;height:64px;background:#000">
<video id="a" src="clip.mp4" muted style="position:absolute;left:0;top:0;width:64px;height:64px"></video>
<canvas id="c" width="64" height="64" style="position:absolute;left:64px;top:0"></canvas>
<script>
window.__film = { duration: 2, width: 128, height: 64 };
const a = document.getElementById("a"), c = document.getElementById("c").getContext("2d");
window.__render = async (t) => {
  if (a.readyState < 2) await new Promise((r) => a.addEventListener("loadeddata", r, { once: true }));
  a.currentTime = t;
  if (a.seeking) await new Promise((r) => a.addEventListener("seeked", r, { once: true }));
  c.drawImage(a, 0, 0, 64, 64);
};
</script></body></html>`,
  );
  const times = [0.25, 0.95, 1.55];
  const files = await filmStills({
    page,
    outDir: join(page, "stills"),
    at: times,
    chromePath: chrome!,
    blur: false,
  });
  for (const [k, t] of times.entries())
    near(
      await pixel(files[k]!, 128, 64, 96, 32),
      colourOf(Math.floor(t * 10 + 1e-6)),
      `drawn once it says it is there, at ${t}s`,
    );
});

test("a seek made while another is under way ends it: the page draws the frame of the last", {
  skip,
}, async () => {
  const page = join(dir, "seek-twice");
  await exec("mkdir", ["-p", page]);
  await numberedClip(join(page, "clip.mp4"));
  await writeFile(
    join(page, "index.html"),
    `<!doctype html><html><body style="margin:0;width:128px;height:64px;background:#000">
<video id="a" src="clip.mp4" muted style="position:absolute;left:0;top:0;width:64px;height:64px"></video>
<canvas id="c" width="64" height="64" style="position:absolute;left:64px;top:0"></canvas>
<script>
window.__film = { duration: 2, width: 128, height: 64 };
const a = document.getElementById("a"), c = document.getElementById("c").getContext("2d");
window.__render = async (t) => {
  if (a.readyState < 2) await new Promise((r) => a.addEventListener("loadeddata", r, { once: true }));
  if (t < 0.5) {
    await new Promise((r) => { a.addEventListener("seeked", r, { once: true }); a.currentTime = t; });
    return;
  }
  // shown as its frames by now: a far frame (not decoded yet) and, once that
  // seek is under way, straight back to the one it shows (decoded already, so
  // it comes first) — drawn once it no longer reads as seeking
  a.addEventListener("seeking", () => queueMicrotask(() => { a.currentTime = 0.25; }), { once: true });
  a.currentTime = 1.85;
  await new Promise((r) => {
    const on = () => { if (!a.seeking) { a.removeEventListener("seeked", on); r(); } };
    a.addEventListener("seeked", on);
  });
  c.drawImage(a, 0, 0, 64, 64);
};
</script></body></html>`,
  );
  const files = await filmStills({
    page,
    outDir: join(page, "stills"),
    at: [0.25, 0.95],
    chromePath: chrome!,
    blur: false,
  });
  near(await pixel(files[1]!, 128, 64, 32, 32), colourOf(2), "the video, at its last seek");
  near(await pixel(files[1]!, 128, 64, 96, 32), colourOf(2), "drawn once the seeks are done");
});

test("a seek of the element's own, once the page reads the video frame by frame, ends a seek to a frame under way", {
  skip,
}, async () => {
  const page = join(dir, "seek-handoff");
  await exec("mkdir", ["-p", page]);
  await numberedClip(join(page, "clip.mp4"));
  await writeFile(
    join(page, "index.html"),
    `<!doctype html><html><body style="margin:0;width:128px;height:64px;background:#000">
<video id="a" src="clip.mp4" muted style="position:absolute;left:0;top:0;width:64px;height:64px"></video>
<canvas id="c" width="64" height="64" style="position:absolute;left:64px;top:0"></canvas>
<script>
window.__film = { duration: 2, width: 128, height: 64 };
const a = document.getElementById("a"), c = document.getElementById("c").getContext("2d");
window.__render = async (t) => {
  if (a.readyState < 2) await new Promise((r) => a.addEventListener("loadeddata", r, { once: true }));
  if (t < 0.5) {
    await new Promise((r) => { a.addEventListener("seeked", r, { once: true }); a.currentTime = t; });
    return;
  }
  // shown as its frames: a seek to a far frame; then the page reads the video
  // frame by frame (sought from now on) and seeks it back
  a.currentTime = 1.85;
  a.requestVideoFrameCallback(() => {});
  await new Promise((r) => { a.addEventListener("seeked", r, { once: true }); a.currentTime = 0.25; });
  c.drawImage(a, 0, 0, 64, 64);
};
</script></body></html>`,
  );
  const files = await filmStills({
    page,
    outDir: join(page, "stills"),
    at: [0.25, 0.95],
    chromePath: chrome!,
    blur: false,
  });
  near(await pixel(files[1]!, 128, 64, 96, 32), colourOf(2), "drawn once its own seek is done");
  near(await pixel(files[1]!, 128, 64, 32, 32), colourOf(2), "the video, where it was sought last");
});

test("a video whose picture starts late shows each frame from its own time, as Chrome does", {
  skip,
}, async () => {
  const page = join(dir, "late");
  await exec("mkdir", ["-p", page]);
  // its picture from 0.5 s, its sound from 0
  await numberedClip(join(page, "clip.mp4"), { startAt: 0.5 });
  await writeFile(join(page, "index.html"), videoPage("clip.mp4", 64, 64));
  const times = [0.25, 0.65, 1.05];
  const files = await filmStills({
    page,
    outDir: join(page, "stills"),
    at: times,
    chromePath: chrome!,
    blur: false,
  });
  // before its first frame, the first frame; then frame n from 0.5 + n/10
  for (const [k, t] of times.entries())
    near(
      await pixel(files[k]!, 64, 64, 32, 32),
      colourOf(Math.max(0, Math.floor((t - 0.5) * 10 + 1e-6))),
      `at ${t}s`,
    );
});

test("a paused video given a new source shows the new source, not its last frame", {
  skip,
}, async () => {
  const page = join(dir, "resource");
  await exec("mkdir", ["-p", page]);
  await flatClip(join(page, "red.mp4"), "red");
  await flatClip(join(page, "blue.mp4"), "blue");
  await writeFile(
    join(page, "index.html"),
    `<!doctype html><html><body style="margin:0;background:#000">
<video id="a" src="red.mp4" muted style="position:absolute;left:0;top:0;width:64px;height:64px"></video>
<script>
window.__film = { duration: 2, width: 64, height: 64 };
const a = document.getElementById("a");
let blue = false;
window.__render = async (t) => {
  const loaded = () => new Promise((r) => a.addEventListener("loadeddata", r, { once: true }));
  if (a.readyState < 2) await loaded();
  if (t < 0.5) {
    await new Promise((r) => { a.addEventListener("seeked", r, { once: true }); a.currentTime = t; });
  } else if (!blue) {
    blue = true;
    a.src = "blue.mp4";
    a.load();
    await loaded();
  }
};
</script></body></html>`,
  );
  const files = await filmStills({
    page,
    outDir: join(page, "stills"),
    at: [0.25, 1],
    chromePath: chrome!,
    blur: false,
  });
  near(await pixel(files[0]!, 64, 64, 32, 32), [255, 0, 0], "before: red");
  near(await pixel(files[1]!, 64, 64, 32, 32), [0, 0, 255], "after its new source: blue");
});

test("a video given a stream as its source object no longer shows its file's last frame", {
  skip,
}, async () => {
  const page = join(dir, "source-object");
  await exec("mkdir", ["-p", page]);
  await flatClip(join(page, "red.mp4"), "red");
  await writeFile(
    join(page, "index.html"),
    `<!doctype html><html><body style="margin:0;background:#000">
<video id="a" src="red.mp4" muted style="position:absolute;left:0;top:0;width:64px;height:64px"></video>
<script>
window.__film = { duration: 2, width: 64, height: 64 };
const a = document.getElementById("a");
const blue = document.createElement("canvas");
blue.width = blue.height = 64;
let streaming = false;
window.__render = async (t) => {
  const loaded = () => new Promise((r) => a.addEventListener("loadeddata", r, { once: true }));
  if (a.readyState < 2) await loaded();
  if (t < 0.5) {
    await new Promise((r) => { a.addEventListener("seeked", r, { once: true }); a.currentTime = t; });
  } else if (!streaming) {
    streaming = true;
    const g = blue.getContext("2d");
    const stream = blue.captureStream();
    g.fillStyle = "#00f";
    g.fillRect(0, 0, 64, 64);
    a.srcObject = stream;
    await loaded();
  }
};
</script></body></html>`,
  );
  const files = await filmStills({
    page,
    outDir: join(page, "stills"),
    at: [0.25, 1],
    chromePath: chrome!,
    blur: false,
  });
  near(await pixel(files[0]!, 64, 64, 32, 32), [255, 0, 0], "before: red");
  // the stream itself shows as it did before frames (paused by the film
  // clock, it may show nothing): what matters is that the red is gone
  const [r] = await pixel(files[1]!, 64, 64, 32, 32);
  assert.ok(r! < 64, `given the stream, the file's red frame stays: red ${r}`);
});

test("a frame that never comes holds up neither its video's new source nor the render", {
  skip,
}, async () => {
  const page = join(dir, "stalled-frame");
  await exec("mkdir", ["-p", page]);
  await flatClip(join(page, "red.mp4"), "red");
  await writeFile(
    join(page, "index.html"),
    `<!doctype html><html><body style="margin:0;background:#000">
<video id="a" src="red.mp4" muted style="position:absolute;left:0;top:0;width:64px;height:64px"></video>
<script>
window.__film = { duration: 2, width: 64, height: 64 };
const a = document.getElementById("a");
// as a service worker that holds a request would: from now on the frames'
// images never decode
const decode = HTMLImageElement.prototype.decode;
let stall = false, stalled = false;
HTMLImageElement.prototype.decode = function () {
  if (!stall || !this.src.includes("/__open-take/frames/")) return decode.call(this);
  stalled = true;
  return new Promise(() => {});
};
const blue = document.createElement("canvas");
blue.width = blue.height = 64;
let streaming = false;
window.__render = async (t) => {
  const loaded = () => new Promise((r) => a.addEventListener("loadeddata", r, { once: true }));
  if (a.readyState < 2) await loaded();
  if (t < 0.5) {
    await new Promise((r) => { a.addEventListener("seeked", r, { once: true }); a.currentTime = t; });
  } else if (!streaming) {
    streaming = true;
    stall = true;
    a.currentTime = 1.55;
    for (let i = 0; i < 100 && !stalled; i++) await new Promise((r) => setTimeout(r, 1));
    const g = blue.getContext("2d");
    const stream = blue.captureStream();
    g.fillStyle = "#00f";
    g.fillRect(0, 0, 64, 64);
    a.srcObject = stream;
    await loaded();
    a.play();
  }
};
</script></body></html>`,
  );
  const files = await filmStills({
    page,
    outDir: join(page, "stills"),
    at: [0.25, 1],
    chromePath: chrome!,
    blur: false,
  });
  const [r] = await pixel(files[1]!, 64, 64, 32, 32);
  assert.ok(r! < 64, `given the stream, the file's red frame stays: red ${r}`);
});

test("a frame that does not come in time leaves the video to its own seek, and the page draws the video", {
  skip,
}, async () => {
  const page = join(dir, "frame-timeout");
  await exec("mkdir", ["-p", page]);
  await numberedClip(join(page, "clip.mp4"));
  await writeFile(
    join(page, "index.html"),
    `<!doctype html><html><body style="margin:0;width:128px;height:64px;background:#000">
<video id="a" src="clip.mp4" muted style="position:absolute;left:0;top:0;width:64px;height:64px"></video>
<canvas id="c" width="64" height="64" style="position:absolute;left:64px;top:0"></canvas>
<script>
window.__film = { duration: 2, width: 128, height: 64 };
const a = document.getElementById("a"), c = document.getElementById("c").getContext("2d");
// as a service worker that holds a request would, while stall is on
const decode = HTMLImageElement.prototype.decode;
let stall = false;
HTMLImageElement.prototype.decode = function () {
  return stall && this.src.includes("/__open-take/frames/") ? new Promise(() => {}) : decode.call(this);
};
window.__render = async (t) => {
  if (a.readyState < 2) await new Promise((r) => a.addEventListener("loadeddata", r, { once: true }));
  if (t < 0.5) {
    await new Promise((r) => { a.addEventListener("seeked", r, { once: true }); a.currentTime = t; });
    return;
  }
  stall = true;
  await new Promise((r) => { a.addEventListener("seeked", r, { once: true }); a.currentTime = 1.55; });
  stall = false;
  c.drawImage(a, 0, 0, 64, 64);
};
</script></body></html>`,
  );
  const files = await filmStills({
    page,
    outDir: join(page, "stills"),
    at: [0.25, 0.95],
    chromePath: chrome!,
    blur: false,
  });
  near(await pixel(files[1]!, 128, 64, 96, 32), colourOf(15), "drawn once its own seek is done");
  near(await pixel(files[1]!, 128, 64, 32, 32), colourOf(15), "the video");
});

test("a frame asked earlier that comes later does not cover the video sought since", {
  skip,
}, async () => {
  const page = join(dir, "late-frame");
  await exec("mkdir", ["-p", page]);
  await numberedClip(join(page, "clip.mp4"));
  await writeFile(
    join(page, "index.html"),
    `<!doctype html><html><body style="margin:0;width:128px;height:64px;background:#000">
<video id="a" src="clip.mp4" muted style="position:absolute;left:0;top:0;width:64px;height:64px"></video>
<canvas id="c" width="64" height="64" style="position:absolute;left:64px;top:0"></canvas>
<script>
window.__film = { duration: 2, width: 128, height: 64 };
const a = document.getElementById("a"), c = document.getElementById("c").getContext("2d");
// frame 7's image is held until the page lets it go; once fail is on, frames fail
const decode = HTMLImageElement.prototype.decode;
let hold = null, fail = false;
HTMLImageElement.prototype.decode = function () {
  if (this.src.endsWith("/000007.jpg") && !hold)
    return new Promise((r) => { hold = () => decode.call(this).then(r, r); });
  if (fail && this.src.includes("/__open-take/frames/")) return Promise.reject(new Error("refused"));
  return decode.call(this);
};
let done = false;
window.__render = async (t) => {
  if (a.readyState < 2) await new Promise((r) => a.addEventListener("loadeddata", r, { once: true }));
  if (t < 0.5) {
    await new Promise((r) => { a.addEventListener("seeked", r, { once: true }); a.currentTime = t; });
    return;
  }
  if (done) return;
  done = true;
  // a seek to a frame that is slow to come, then one whose frame fails: that
  // one is sought itself; then the slow frame arrives
  a.currentTime = 0.75;
  for (let i = 0; i < 100 && !hold; i++) await new Promise((r) => setTimeout(r, 1));
  fail = true;
  await new Promise((r) => { a.addEventListener("seeked", r, { once: true }); a.currentTime = 1.55; });
  hold();
  for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 1));
  c.drawImage(a, 0, 0, 64, 64);
};
</script></body></html>`,
  );
  const files = await filmStills({
    page,
    outDir: join(page, "stills"),
    at: [0.25, 0.95],
    chromePath: chrome!,
    blur: false,
  });
  near(await pixel(files[1]!, 128, 64, 96, 32), colourOf(15), "drawn after the slow frame came");
});

test("a page whose policy refuses images keeps its video, sought as before", { skip }, async () => {
  const page = join(dir, "no-images");
  await exec("mkdir", ["-p", page]);
  await numberedClip(join(page, "clip.mp4"));
  await writeFile(
    join(page, "index.html"),
    videoPage("clip.mp4", 64, 64).replace(
      "<body",
      `<meta http-equiv="Content-Security-Policy" content="img-src 'none'"><body`,
    ),
  );
  const server = await serveDirectory(page);
  const store = frameStore({ root: page, server });
  let b: Awaited<ReturnType<typeof launchHtmlBrowser>> | null = null;
  try {
    b = await launchHtmlBrowser({
      chromePath: chrome!,
      url: `${server.url}/index.html`,
      width: 64,
      height: 64,
      initScript: filmClockSource({ seed: 1, epochMs: 0 }),
      stillAnimations: true,
      bindings: {
        __otFrames: (payload: string) => {
          const { src } = JSON.parse(payload) as { src: string };
          const reply = (f: VideoFrames | null) =>
            b?.evaluate(`window.__ot.framesReady(${JSON.stringify(src)}, ${JSON.stringify(f)})`);
          store.frames(src).then(reply, () => reply(null));
        },
      },
    });
    await b.evaluate("window.__ot.prepare()");
    // the frames are decoded and offered, but the page may not load them: the
    // video stays itself, at the time it was sought to — not a broken image
    for (const t of [0.25, 0.95, 1.55]) {
      await b.evaluate(`window.__ot.seek(${t})`);
      const v = "document.getElementById('v')";
      assert.equal(
        await b.evaluate<boolean>(
          `getComputedStyle(${v}).content.includes("/__open-take/frames/")`,
        ),
        false,
        `at ${t}s it shows a frame's image the page refuses`,
      );
      assert.equal(await b.evaluate<number>(`Math.round(${v}.currentTime * 1000)`), t * 1000);
    }
  } finally {
    await b?.close();
    await store.clean();
    await server.close();
  }
});

test("a VideoFrame made of a video shown as its frames holds the frame the video shows", {
  skip,
}, async () => {
  const page = join(dir, "videoframe");
  await exec("mkdir", ["-p", page]);
  await numberedClip(join(page, "clip.mp4"));
  await writeFile(
    join(page, "index.html"),
    `<!doctype html><html><body style="margin:0;width:128px;height:64px;background:#000">
<video id="a" src="clip.mp4" muted style="position:absolute;left:0;top:0;width:64px;height:64px"></video>
<canvas id="c" width="64" height="64" style="position:absolute;left:64px;top:0"></canvas>
<script>
window.__film = { duration: 2, width: 128, height: 64 };
const a = document.getElementById("a"), c = document.getElementById("c").getContext("2d");
window.__render = async (t) => {
  if (a.readyState < 2) await new Promise((r) => a.addEventListener("loadeddata", r, { once: true }));
  await new Promise((r) => { a.addEventListener("seeked", r, { once: true }); a.currentTime = t; });
  // only once it is shown as its frames (the first instant drawn shows it so)
  if (t < 0.5) return;
  const f = new VideoFrame(a, { timestamp: Math.round(t * 1e6) });
  c.drawImage(f, 0, 0, 64, 64);
  f.close();
};
</script></body></html>`,
  );
  const times = [0.25, 0.95, 1.55];
  const files = await filmStills({
    page,
    outDir: join(page, "stills"),
    at: times,
    chromePath: chrome!,
    blur: false,
  });
  for (const [k, t] of times.entries()) {
    const n = Math.floor(t * 10 + 1e-6);
    near(await pixel(files[k]!, 128, 64, 32, 32), colourOf(n), `the video at ${t}s`);
    if (t >= 0.5)
      near(await pixel(files[k]!, 128, 64, 96, 32), colourOf(n), `its VideoFrame at ${t}s`);
  }
});

test("a video inside a frame, drawn by the page around it, is drawn at film time", {
  skip,
}, async () => {
  const page = join(dir, "inframe");
  await exec("mkdir", ["-p", page]);
  await numberedClip(join(page, "clip.mp4"));
  await writeFile(
    join(page, "inner.html"),
    `<!doctype html><html><body style="margin:0"><video id="v" src="clip.mp4" muted autoplay style="width:64px;height:64px"></video></body></html>`,
  );
  await writeFile(
    join(page, "index.html"),
    `<!doctype html><html><body style="margin:0;width:128px;height:64px;background:#000">
<iframe id="f" src="inner.html" style="position:absolute;left:0;top:0;width:64px;height:64px;border:0"></iframe>
<canvas id="c" width="64" height="64" style="position:absolute;left:64px;top:0"></canvas>
<script>
window.__film = { duration: 2, width: 128, height: 64 };
const c = document.getElementById("c").getContext("2d");
window.__render = () => {
  const v = document.getElementById("f").contentDocument?.getElementById("v");
  if (v && v.readyState >= 2) c.drawImage(v, 0, 0, 64, 64);
};
</script></body></html>`,
  );
  // each still on its own: no shutter seeks the frame's video close to t first
  const times = [0.25, 0.95, 1.55];
  const files = await filmStills({
    page,
    outDir: join(page, "stills"),
    at: times,
    chromePath: chrome!,
    blur: false,
  });
  for (const [k, t] of times.entries()) {
    const n = Math.floor(t * 10 + 1e-6);
    near(await pixel(files[k]!, 128, 64, 32, 32), colourOf(n), `the frame's video at ${t}s`);
    near(
      await pixel(files[k]!, 128, 64, 96, 32),
      colourOf(n),
      `drawn by the page around it at ${t}s`,
    );
  }
});

test("a 29.97 fps video's frames keep their exact times", async () => {
  const out = join(dir, "ntsc");
  await exec("mkdir", ["-p", join(out, "frames")]);
  await numberedClip(join(out, "clip.mp4"), { rate: "30000/1001", seconds: 0.5 });
  const { times } = await decodeFrames(join(out, "clip.mp4"), join(out, "frames"));
  for (const [n, t] of times.slice(0, 6).entries())
    assert.ok(
      Math.abs(t - (n * 1001) / 30000) < 1e-9,
      `frame ${n} at ${t}, not ${(n * 1001) / 30000}`,
    );
});

test("at 1/30 s a 29.97 fps video still shows its first frame, as Chrome does", {
  skip,
}, async () => {
  const page = join(dir, "ntsc-shown");
  await exec("mkdir", ["-p", page]);
  await numberedClip(join(page, "clip.mp4"), { rate: "30000/1001", seconds: 0.5 });
  await writeFile(join(page, "index.html"), videoPage("clip.mp4", 64, 64));
  const [still] = await filmStills({
    page,
    outDir: join(page, "stills"),
    at: [1 / 30],
    chromePath: chrome!,
    blur: false,
  });
  // the next frame differs by 12 a channel: closer than that
  near(
    await pixel(still!, 64, 64, 32, 32),
    colourOf(0),
    "its first frame, which ends at 1001/30000 s",
    5,
  );
});
