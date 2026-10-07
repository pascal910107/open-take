// The film kit's real-material handoff (kit/media.js): a take's actions as
// film events through a clip's time map (the input, and apart from it when
// its result showed), the seam from recording to saved state, and one real
// part of a saved screen lifted out as a layer of its own — at rest exactly
// where it sat, carried anywhere at any size, the page kept or cleared, or
// everything else faded. Chrome for Testing; the browser tests skip without it.

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { promisify } from "node:util";
// @ts-expect-error — the kit is plain JS, checked by its own tsconfig
import { clip, clipEvents, fitTransform, fromLog, seam } from "../kit/media.js";
import { resolveFfmpeg } from "../src/ffmpeg";
import { initFilm } from "../src/film/kit";
import { filmStills } from "../src/film/render";
import { findChrome } from "./fixtures/find-chrome";

const exec = promisify(execFile);
const chrome = findChrome();
const skip = chrome ? false : "no Chrome for Testing";

// --- a capture log shaped like a real one (findgym.tw's fee calculator: the
// recalculated number showed 1.58 s after the click) ---------------------------

const LOG = {
  video: { width: 3840, height: 2160, fps: "60/1", durationS: 27.45 },
  viewport: { w: 1920, h: 1080 },
  tEndMs: 26107,
  events: [
    {
      kind: "click",
      x: 421,
      y: 650,
      box: { x: 377, y: 628, w: 89, h: 44 },
      tMs: 7089,
      sel: "NT$888",
      state: "s2",
      result: { atMs: 8550, doneMs: 8550, box: { x: 992, y: 384, w: 544, h: 320 } },
    },
    {
      kind: "click",
      x: 744,
      y: 650,
      box: { x: 693, y: 628, w: 102, h: 44 },
      tMs: 12285,
      sel: "NT$1,588",
      state: "s3",
      result: { atMs: 13867, doneMs: 13867, box: { x: 992, y: 384, w: 512, h: 320 } },
      settledMs: 13400,
    },
    { kind: "type", x: 600, y: 590, tMs: 15000, text: "36", durationMs: 400, state: "s4" },
    { kind: "click", x: 639, y: 796, tMs: 16871, sel: "36", settledMs: 17300 },
  ],
  states: {
    dir: "states",
    items: [
      { id: "s2", tMs: 9918, step: 1, fidelity: { psnr: 37.6, diffFrac: 0.0005, ok: true } },
      {
        id: "s3",
        tMs: 14454,
        step: 2,
        fidelity: { psnr: 37.3, diffFrac: 0.0005, ok: true },
        seam: { dx: -0.02, dy: -0.11, meanDiff: 4.18, diffFrac: 0.0076 },
      },
      { id: "s4", tMs: 16000, step: 3 },
      { id: "s5", tMs: 18000, step: 4, moving: true },
    ],
  },
};

const near = (a: number, b: number, eps = 1e-6) => Math.abs(a - b) <= eps;

test("a clip maps film time onto the recording: a start and a speed, keys, an open end, a cut file", () => {
  const c = clip({ at: 7, from: 12, to: 15.5 });
  assert.equal(c.start, 7);
  assert.equal(c.end, 10.5);
  assert.ok(near(c.toCapture(8), 13));
  assert.ok(near(c.toFilm(13.867)!, 8.867));
  assert.equal(c.toFilm(11.9), null, "before the clip: never shown");
  assert.equal(c.toFilm(16), null, "after its end: never shown");
  assert.equal(c.toCapture(20), 15.5, "held on its last frame after the end");

  const fast = clip({ at: 0, from: 10, speed: 2 });
  assert.equal(fast.end, Number.POSITIVE_INFINITY);
  assert.ok(near(fast.toCapture(3), 16), "open-ended, it runs on at its speed");
  assert.ok(near(fast.toFilm(16)!, 3));

  // slow round the click at 12.285, hurry through the waiting before it
  const k = clip({
    keys: [
      [0, 9],
      [1, 12],
      [3, 13],
      [3.5, 15],
    ],
    fileStart: 9,
  });
  assert.ok(near(k.toFilm(12.285)!, 1.57), "slowed: 0.285 s of the recording over 0.57 s");
  assert.ok(near(k.videoTime(1), 3), "a time in the cut file");
  assert.throws(
    () =>
      clip({
        keys: [
          [0, 5],
          [1, 4],
        ],
      }),
    /move forward/,
  );
  assert.throws(() => clip({ at: 0, from: 5, speed: 0 }), /above 0/);
});

test("a take's actions become film events: the input, and apart from it when its result showed", () => {
  const c = clip({ at: 7, from: 12, to: 17.5 });
  const declared: { t: number; kind: string; o: Record<string, unknown> }[] = [];
  const tl = {
    event: (t: number, kind: string, o: Record<string, unknown> = {}) => {
      declared.push({ t, kind, o });
      return t;
    },
  };
  const ev = clipEvents(fromLog(LOG, "http://x/calc.take/capture.json"), c, { tl, keys: true });
  const kinds = ev.map((e: { kind: string }) => e.kind);
  assert.ok(!ev.some((e: { action: string }) => e.action === "a1"), "a1 is before the clip");
  const click = ev.find(
    (e: { action: string; kind: string }) => e.action === "a2" && e.kind === "click",
  );
  assert.ok(near(click.t, 7.285), "the click at the film time the clip shows it");
  assert.equal(click.basis, "measured");
  assert.ok(near(click.resultAt, 8.867), "its result 1.58 s later");
  assert.deepEqual(click.box, { x: 693, y: 628, width: 102, height: 44 });
  const result = ev.find((e: { kind: string }) => e.kind === "result");
  assert.ok(near(result.t, 8.867));
  assert.deepEqual(
    [result.x, result.y],
    [992 + 256, 384 + 160],
    "where it showed: the region's centre",
  );
  assert.ok(
    !kinds.includes("resultDone"),
    "a result that showed in one frame has no separate done",
  );
  const settled = ev.find(
    (e: { kind: string; action: string }) => e.kind === "settled" && e.action === "a2",
  );
  assert.equal(settled.basis, "estimated");
  const keys = ev.filter((e: { kind: string }) => e.kind === "key");
  assert.equal(keys.length, 2, "one key a character, spread over the typing");
  assert.ok(keys.every((e: { basis: string }) => e.basis === "estimated"));
  assert.ok(near(keys[0].t, 7 + 3 + 0.1) && near(keys[1].t, 7 + 3 + 0.3));
  const a4 = ev.find(
    (e: { action: string; kind: string }) => e.action === "a4" && e.kind === "click",
  );
  assert.equal(a4.resultAt, "not detected", "no measured result is said so, not guessed");
  const cutShort = clipEvents(LOG, clip({ at: 0, from: 12, to: 13 }));
  assert.equal(
    cutShort.find((e: { action: string }) => e.action === "a2").resultAt,
    "outside the clip",
    "measured, but the clip ends before it showed: not 'not detected'",
  );
  for (let i = 1; i < ev.length; i++) assert.ok(ev[i].t >= ev[i - 1].t, "in time order");
  assert.equal(declared.length, ev.length, "each one declared on the timeline");
  assert.equal(declared.find((d) => d.kind === "click")!.o.label, "a2 NT$1,588");

  // only some kinds, mapped onto the stage
  const only = clipEvents(LOG, c, {
    kinds: ["result"],
    map: (x: number, y: number) => [x / 2, y / 2],
  });
  assert.equal(only.length, 1);
  assert.deepEqual([only[0].x, only[0].y], [624, 272]);
});

test("a seam says when a saved state stands for the video, and where to put it", () => {
  const c = clip({ at: 7, from: 12, to: 17.5 });
  const s = seam(LOG, c, "s3", { video: { x: 100, y: 50, width: 960, height: 540 } });
  assert.ok(near(s.at!, 7 + 2.454), "the moment it was saved, in film time");
  // from a2's result being done (measured) to the next input, a3 at 15.0 s
  assert.ok(near(s.window!.from, 7 + 1.867) && near(s.window!.to, 7 + 3));
  assert.deepEqual(s.window!.basis, { from: "measured", to: "measured" });
  assert.equal(s.scale, 0.5);
  assert.ok(near(s.offset.x, 100 - 0.01) && near(s.offset.y, 50 - 0.055));
  assert.match(s.transform, /^translate\(99\.99px, 49\.95px\) scale\(0\.500000\)$/);
  assert.equal(s.residual.basis, "measured");
  assert.equal(s.residual.meanDiff, 4.18);

  const s4 = seam(LOG, c, "s4");
  assert.equal(s4.residual.basis, "not detected", "no seam measured: said so");
  assert.equal(s4.window!.basis.from, "estimated", "a3 has no measured result");
  assert.throws(() => seam(LOG, c, "s5"), /still moving/);
  assert.throws(() => seam(LOG, c, "s9"), /no saved state/);
  assert.throws(() => seam(LOG, c, "s3", { video: { width: 960, height: 600 } }), /shape/);
  assert.equal(seam(LOG, clip({ at: 0, from: 0, to: 5 }), "s3").window, null, "outside the clip");
  // a clip that starts inside the stretch (after the result, before the save)
  const late = seam(LOG, clip({ at: 2, from: 14, to: 17 }), "s3");
  assert.ok(near(late.at!, 2.454), "the save, in the late clip's time");
  assert.ok(late.window, "the clip shows the stretch from its own start");
  assert.ok(near(late.window!.from, 2) && near(late.window!.to, 3));
  assert.equal(
    seam(LOG, clip({ at: 0, from: 15.5, to: 17 }), "s3").window,
    null,
    "a clip that starts after the stretch ends shows none of it",
  );
});

test("fitTransform puts a box onto a rect: contained, covered or stretched", () => {
  const from = { x: 380, y: 60, width: 200, height: 90 };
  const to = { x: 20, y: 20, w: 600, h: 320 };
  const f = fitTransform(from, to);
  assert.equal(f.kx, 3);
  // the box's corner lands at (20, 45): centred in the rect's height
  const corner = (x: number, y: number) => [
    f.x + from.x + (x - from.x) * f.kx,
    f.y + from.y + (y - from.y) * f.ky,
  ];
  assert.deepEqual(
    corner(380, 60).map((v) => Math.round(v * 1000) / 1000),
    [20, 45],
  );
  assert.equal(fitTransform(from, to, "cover").kx, 320 / 90);
  const fill = fitTransform(from, to, "fill");
  assert.deepEqual([fill.kx, fill.ky], [3, 320 / 90]);
});

// --- in the browser ---------------------------------------------------------------

let dir = "";
before(async () => {
  dir = await mkdtemp(join(tmpdir(), "open-take-film-lift-test-"));
  // a saved state of a text-dense calculator page, 640×360: lines of grey
  // text, and the number the app worked out on a dark card (a 1 px rule
  // across it, to see it stay sharp). Like a real state, it names its
  // elements and says when it is ready once its fonts are.
  const s3 = join(dir, "states", "s3");
  await mkdir(s3, { recursive: true });
  const lines = Array.from(
    { length: 14 },
    (_, i) => `<p style="top:${12 + i * 24}px">${"費用試算 解約 轉讓 手續費 ".repeat(2)}${i}</p>`,
  ).join("");
  await writeFile(
    join(s3, "state.html"),
    `<!doctype html><html><head><meta charset="utf-8"><style>
html,body{margin:0;width:640px;height:360px;overflow:hidden;background:#f4f1ea;font:14px sans-serif}
p{position:absolute;left:20px;margin:0;color:#777;width:330px;white-space:nowrap;overflow:hidden}
#card{position:absolute;left:380px;top:60px;width:200px;height:90px;background:#1d4d3c;border-radius:12px}
#card b{position:absolute;left:16px;top:14px;font:bold 34px sans-serif;color:#ff7a3d}
#card i{position:absolute;left:0;top:70px;width:200px;height:1px;background:#fff}
#line{position:absolute;left:380px;top:300px;width:200px;height:24px;font:20px sans-serif;color:#000}
</style></head><body>${lines}
<div id="card"><b>NT$3,176</b><i></i></div><div id="line">Result</div>
<script data-ot-restore>document.fonts.ready.then(function(){document.getElementById("card").setAttribute("data-ot-id","e7");document.documentElement.setAttribute("data-ot-ready","1");});</script>
</body></html>`,
  );
  await writeFile(
    join(s3, "index.json"),
    JSON.stringify({ version: 1, id: "s3", viewport: { w: 640, h: 360, dpr: 1 }, elements: [] }),
  );
});
after(async () => {
  if (!process.env.KEEP_FILM_TEST) await rm(dir, { recursive: true, force: true });
  else console.log(dir);
});

async function rgb(file: string, w: number, h: number): Promise<Buffer> {
  const ffmpeg = await resolveFfmpeg();
  const { stdout } = await exec(
    ffmpeg,
    ["-v", "error", "-i", file, "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"],
    { encoding: "buffer", maxBuffer: 1 << 26 },
  );
  assert.equal((stdout as Buffer).length, w * h * 3);
  return stdout as Buffer;
}
const px = (buf: Buffer, w: number, x: number, y: number) => {
  const i = (Math.round(y) * w + Math.round(x)) * 3;
  return [buf[i]!, buf[i + 1]!, buf[i + 2]!] as const;
};
const close = (a: readonly number[], b: readonly number[], tol = 24) =>
  a.every((v, i) => Math.abs(v - b[i]!) <= tol);
const GREEN = [0x1d, 0x4d, 0x3c];
const PAGE = [0xf4, 0xf1, 0xea];
const ORANGE = [0xff, 0x7a, 0x3d];

/** a film page: the saved screen in a positioned layer, and a module script */
const filmPage = (script: string, bg = "#000") => `<!doctype html><html><head><style>
html,body{margin:0;width:640px;height:360px;overflow:hidden;background:${bg}}
#layer{position:relative;width:640px;height:360px;transform-origin:0 0}
#shot{position:absolute;left:0;top:0;width:640px;height:360px;border:0}
#wrong{display:none;position:absolute;left:0;top:0;width:640px;height:360px;background:#f0f}
</style></head><body><div id="layer"><iframe id="shot" src="../states/s3/state.html"></iframe></div><div id="wrong"></div>
<script type="module">
${script}
</script></body></html>`;

test("a lifted part sits exactly where it was until it moves", { skip }, async () => {
  const film = join(dir, "rest");
  await initFilm({ dir: film });
  await writeFile(
    join(film, "plain.html"),
    filmPage(`import { screen } from "./kit/media.js";
const s = screen(document.getElementById("shot"));
window.__film = { duration: 1, width: 640, height: 360, ready: s.ready };
window.__render = () => {};`),
  );
  await writeFile(
    join(film, "lifted.html"),
    filmPage(`import { screen, lift } from "./kit/media.js";
const s = screen(document.getElementById("shot"));
const card = lift(s, "e7");
window.__film = { duration: 1, width: 640, height: 360, ready: card.ready };
window.__render = () => {
  const b = card.box;
  if (b.x !== 380 || b.y !== 60 || b.width !== 200 || b.height !== 90 || card.rect.r !== 12)
    document.getElementById("wrong").style.display = "block";
  // the screen under it gone: what shows is the lifted copy alone
  document.getElementById("shot").style.visibility = "hidden";
};`),
  );
  const [plain] = await filmStills({
    page: join(film, "plain.html"),
    root: dir,
    chromePath: chrome!,
    at: [0.5],
    outDir: join(dir, "rest-plain"),
    blur: false,
  });
  const [lifted] = await filmStills({
    page: join(film, "lifted.html"),
    root: dir,
    chromePath: chrome!,
    at: [0.5],
    outDir: join(dir, "rest-lifted"),
    blur: false,
  });
  const a = await rgb(plain!, 640, 360);
  const b = await rgb(lifted!, 640, 360);
  // inside the card's box (its rounded corners left out) the copy is the screen
  let worst = 0;
  for (let y = 66; y < 144; y++)
    for (let x = 386; x < 574; x++)
      for (let c = 0; c < 3; c++) {
        const i = (y * 640 + x) * 3 + c;
        worst = Math.max(worst, Math.abs(a[i]! - b[i]!));
      }
  assert.ok(
    worst <= 8,
    `the lifted card matches the screen under it (worst channel off by ${worst})`,
  );
  assert.ok(close(px(b, 640, 20, 20), [0, 0, 0], 4), "outside the card nothing was lifted");
  assert.ok(
    !close(px(b, 640, 320, 180), [255, 0, 255], 40),
    "its box is the card's, in the layer's px",
  );
});

test("at rest it sits where it was on an off-pixel, bordered, scrolled screen too (drawn at 2×)", {
  skip,
}, async () => {
  // a taller state its restore scrolls 57 px down; the screen sits 37.5 px
  // in, inside borders and padding, so every offset the box adds is tested
  const s4 = join(dir, "states", "s4");
  await mkdir(s4, { recursive: true });
  await writeFile(
    join(s4, "state.html"),
    `<!doctype html><html><head><meta charset="utf-8"><style>
html,body{margin:0;background:#f4f1ea;font:14px sans-serif}
#tall{position:relative;height:1200px}
#card{position:absolute;left:300px;top:140px;width:200px;height:90px;background:#1d4d3c;border-radius:12px}
#card b{position:absolute;left:16px;top:14px;font:bold 34px sans-serif;color:#ff7a3d}
#card i{position:absolute;left:0;top:70px;width:200px;height:1px;background:#fff}
</style></head><body><div id="tall"><div id="card"><b>NT$3,176</b><i></i></div></div>
<script data-ot-restore>document.fonts.ready.then(function(){scrollTo(0,57);document.documentElement.setAttribute("data-ot-ready","1");});</script>
</body></html>`,
  );
  await writeFile(
    join(s4, "index.json"),
    JSON.stringify({ version: 1, id: "s4", viewport: { w: 520, h: 280, dpr: 1 }, elements: [] }),
  );
  const film = join(dir, "rest2");
  await initFilm({ dir: film });
  const page = (lifted: boolean) => `<!doctype html><html><head><style>
html,body{margin:0;width:640px;height:360px;overflow:hidden;background:#000}
#layer{position:relative;left:3px;top:2px;width:600px;height:330px;border:3px solid #333;padding:5px 4px}
#shot{position:absolute;left:37.5px;top:21.25px;width:520px;height:280px;border:2px solid #444;padding:1px}
</style></head><body><div id="layer"><iframe id="shot" src="../states/s4/state.html"></iframe></div>
<script type="module">
import { screen, lift } from "./kit/media.js";
const s = screen(document.getElementById("shot"));
${lifted ? 'const card = lift(s, "#card");' : ""}
window.__film = { duration: 1, width: 640, height: 360, ready: ${lifted ? "card.ready" : "s.ready"} };
window.__render = () => { ${lifted ? 'document.getElementById("shot").style.visibility = "hidden";' : ""} };
</script></body></html>`;
  await writeFile(join(film, "plain.html"), page(false));
  await writeFile(join(film, "lifted.html"), page(true));
  const shot = async (name: string) => {
    const [f] = await filmStills({
      page: join(film, `${name}.html`),
      root: dir,
      chromePath: chrome!,
      at: [0.5],
      outDir: join(dir, `rest2-${name}`),
      blur: false,
      supersample: 2,
    });
    return rgb(f!, 640, 360);
  };
  const a = await shot("plain");
  const b = await shot("lifted");
  // the card's box on the film (an absolute box starts inside the layer's
  // border, not its padding): 3+3+37.5+2+1+300 across, 2+3+21.25+2+1+140−57 down
  const x0 = 346.5;
  const y0 = 112.25;
  let worst = 0;
  for (let y = Math.ceil(y0) + 6; y < y0 + 84; y++)
    for (let x = Math.ceil(x0) + 6; x < x0 + 194; x++)
      for (let c = 0; c < 3; c++) {
        const i = (y * 640 + x) * 3 + c;
        worst = Math.max(worst, Math.abs(a[i]! - b[i]!));
      }
  assert.ok(
    worst <= 8,
    `the lifted card matches the screen under it (worst channel off by ${worst})`,
  );
  assert.ok(close(px(b, 640, x0 + 180, y0 + 60), GREEN), "the card is where the box says");
  assert.ok(close(px(b, 640, x0 - 8, y0 + 40), [0, 0, 0], 4), "and nothing of the page beside it");
});

test("carried to fill the frame, it stays sharp; cleared, only the part itself comes along", {
  skip,
}, async () => {
  const film = join(dir, "carry");
  await initFilm({ dir: film });
  await writeFile(
    join(film, "index.html"),
    filmPage(
      `import { screen, lift } from "./kit/media.js";
import { morphRect } from "./kit/motion.js";
const s = screen(document.getElementById("shot"));
const card = lift(s, "#card", { around: "clear" });
const line = lift(s, "#line", { around: "clear" });
const kept = lift(s, "#line");
window.__film = { duration: 2, width: 640, height: 360, ready: Promise.all([card.ready, line.ready, kept.ready]) };
window.__render = (t) => {
  document.getElementById("shot").style.visibility = t > 0.5 ? "hidden" : "visible";
  card.place(morphRect(t, 0.5, 1, card.rect, { x: 20, y: 10, w: 600, h: 270, r: 36 }));
  line.place({ x: 0, y: 290, w: 320, h: 38.4 });
  kept.place({ x: 320, y: 290, w: 320, h: 38.4 });
};`,
      "#e00000",
    ),
  );
  const [still] = await filmStills({
    page: join(film, "index.html"),
    root: dir,
    chromePath: chrome!,
    at: [1.5],
    outDir: join(dir, "carry-out"),
    blur: false,
  });
  const p = await rgb(still!, 640, 360);
  // ×3: the card's corner lands at (20, 10), its rule (70 px down) at y 220
  assert.ok(close(px(p, 640, 560, 250), GREEN), "the card fills the frame");
  assert.ok(
    close(px(p, 640, 22, 12), [0xe0, 0, 0], 30),
    "its rounded corner is cut, the film shows there",
  );
  let orange = 0;
  for (let y = 10; y < 280; y += 2)
    for (let x = 20; x < 620; x += 2) if (close(px(p, 640, x, y), ORANGE, 40)) orange++;
  assert.ok(orange > 1500, `the number came along, three times as big (${orange} samples)`);
  // the 1 px rule, ×3: a solid band of three rows with green right beside it
  for (const y of [220, 221, 222])
    assert.ok(
      px(p, 640, 320, y).every((v) => v > 200),
      `rule row ${y} is solid white`,
    );
  assert.ok(close(px(p, 640, 320, 218), GREEN, 30), "green two rows above the rule: no blur");
  assert.ok(close(px(p, 640, 320, 224), GREEN, 30), "and two rows below");
  // a part with no background of its own: cleared it is see-through, kept the page shows
  assert.ok(
    close(px(p, 640, 300, 300), [0xe0, 0, 0], 30),
    "cleared: the film shows round the text",
  );
  assert.ok(close(px(p, 640, 620, 300), PAGE, 12), "kept: the page round it came along");
});

test("isolate fades everything but the chosen parts into the page", { skip }, async () => {
  const film = join(dir, "isolate");
  await initFilm({ dir: film });
  await writeFile(
    join(film, "index.html"),
    filmPage(`import { screen, isolate } from "./kit/media.js";
const s = screen(document.getElementById("shot"));
const focus = isolate(s, ["e7"]);
const dim = isolate(s, [{ x: 20, y: 300, width: 100, height: 30 }], { color: "#000", opacity: 0.5 });
window.__film = { duration: 2, width: 640, height: 360, ready: Promise.all([focus.ready, dim.ready]) };
window.__render = (t) => { focus.set(t); dim.set(t > 1.5 ? 1 : 0); };`),
  );
  const [half, full] = await filmStills({
    page: join(film, "index.html"),
    root: dir,
    chromePath: chrome!,
    at: [0.5, 1.75],
    outDir: join(dir, "isolate-out"),
    blur: false,
  });
  const h = await rgb(half!, 640, 360);
  const f = await rgb(full!, 640, 360);
  const halfOf = (c: number[]) => c.map((v) => v / 2);
  assert.ok(
    close(px(f, 640, 560, 140), halfOf(GREEN), 10),
    "the card shows through its hole (dimmed by the second)",
  );
  assert.ok(
    close(px(f, 640, 200, 150), halfOf(PAGE), 10),
    "elsewhere the text has faded into the page, dimmed",
  );
  assert.ok(close(px(f, 640, 40, 312), PAGE, 6), "the dim's own hole: faded, not dimmed");
  assert.ok(
    close(px(f, 640, 381, 61), halfOf(PAGE), 20),
    "the card's hole follows its rounded corner",
  );
  let grey = 0;
  for (let y = 10; y < 350; y++)
    for (let x = 20; x < 350; x++) if (px(h, 640, x, y)[0]! < 0xf4 - 12) grey++;
  assert.ok(grey > 50, "half way, the text is still there, faint");
});

test("the real result becomes the next subject: lifted when it showed, carried to full frame", {
  skip,
}, async () => {
  // The film's beat: the click (a2 in the take) recalculates the fee; the
  // moment the new number SHOWED — measured off the recording, 1.58 s after
  // the click — the card is lifted out of the page and carried to fill the
  // frame, the page fading away round it: the product's own output becomes
  // the next shot's subject. Here the saved state stands in for the video.
  const film = join(dir, "subject");
  await initFilm({ dir: film });
  await writeFile(join(film, "capture.json"), JSON.stringify(LOG));
  await writeFile(
    join(film, "index.html"),
    filmPage(`import { screen, lift, isolate, readTake, clip, clipEvents } from "./kit/media.js";
import { morphRect, smooth } from "./kit/motion.js";
const c = clip({ at: 0, from: 12.0, to: 16.0 });           // film 0 s shows the recording's 12.0 s
const s = screen(document.getElementById("shot"));
const card = lift(s, "e7");
const rest = isolate(s, ["e7"]);
let T = Infinity;                                            // when the new number showed
const took = readTake("capture.json").then((take) => {
  T = clipEvents(take, c).find((e) => e.kind === "result" && e.action === "a2").t;  // 1.867
});
window.__film = { duration: 4, width: 640, height: 360, ready: Promise.all([took, card.ready, rest.ready]) };
window.__render = (t) => {
  rest.set(smooth((t - T) / 0.4));
  card.place(morphRect(t, T, T + 0.6, card.rect, { x: 0, y: 0, w: 640, h: 360, r: 0 }), { fit: "cover" });
};`),
  );
  const [atRest, carried] = await filmStills({
    page: join(film, "index.html"),
    root: dir,
    chromePath: chrome!,
    at: [1.8, 3],
    outDir: join(dir, "subject-out"),
    blur: false,
  });
  const a = await rgb(atRest!, 640, 360);
  assert.ok(
    close(px(a, 640, 560, 140), GREEN, 8),
    "just before the number shows: the page as it was, the card in its place",
  );
  assert.ok(close(px(a, 640, 10, 350), PAGE, 6), "the page round it untouched");
  const b = await rgb(carried!, 640, 360);
  let green = 0;
  for (let y = 0; y < 360; y += 4)
    for (let x = 0; x < 640; x += 4) if (close(px(b, 640, x, y), GREEN, 20)) green++;
  assert.ok(
    green > 0.6 * 160 * 90,
    `the card is the whole shot (${green} of ${160 * 90} samples green)`,
  );
});
