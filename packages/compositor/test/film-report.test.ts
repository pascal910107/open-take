// What `film render` prints when it is done: the jump reader and the slow
// text reader on cases built here with known answers, the lines on a report
// made here, then the whole report on films rendered from pages made here
// (Chrome) — one of them naming parts of a synthetic shoot through
// product().

import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { resolveFfmpeg, runTool } from "../src/ffmpeg";
import { gatherComponents, readComponentSource, writeComponents } from "../src/film/components";
import { initFilm } from "../src/film/kit";
import { type GreyFrames, jumpMove } from "../src/film/probe";
import { renderFilm } from "../src/film/render";
import {
  type FilmReport,
  filmReport,
  formatFilmReport,
  inFrameOf,
  partUses,
  pastPixels,
  slowTextSpans,
} from "../src/film/report";
import { findChrome } from "./fixtures/find-chrome";
import { writePartsShoot } from "./fixtures/parts-shoot";

const W = 192;
const H = 108;

function texture(w: number, h: number, seed: number): Uint8Array {
  let s = seed >>> 0 || 1;
  const rnd = () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
  const cw = Math.ceil(w / 6) + 1;
  const grid = Array.from({ length: cw * (Math.ceil(h / 6) + 1) }, () => 30 + rnd() * 200);
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const x0 = Math.floor(x / 6);
      const y0 = Math.floor(y / 6);
      const fx = x / 6 - x0;
      const fy = y / 6 - y0;
      const v = (i: number, j: number) => grid[(y0 + j) * cw + x0 + i]!;
      out[y * w + x] =
        v(0, 0) * (1 - fx) * (1 - fy) +
        v(1, 0) * fx * (1 - fy) +
        v(0, 1) * (1 - fx) * fy +
        v(1, 1) * fx * fy;
    }
  return out;
}

/** a flat frame with a textured card at (x, y) */
function card(x: number, y: number, seed: number): Uint8Array {
  const f = new Uint8Array(W * H).fill(235);
  const t = texture(56, 40, seed);
  for (let r = 0; r < 40; r++) for (let c = 0; c < 56; c++) f[(y + r) * W + x + c] = t[r * 56 + c]!;
  return f;
}

const two = (a: Uint8Array, b: Uint8Array): GreyFrames => {
  const data = new Uint8Array(2 * W * H);
  data.set(a, 0);
  data.set(b, W * H);
  return { w: W, h: H, fps: 30, count: 2, data };
};

test("a card that jumps is found moved by how far it went; one swapped in place is not", () => {
  const moved = jumpMove(two(card(40, 30, 3), card(47, 26, 3)), 1);
  assert.ok(moved.shift, JSON.stringify(moved));
  assert.ok(
    Math.abs(moved.shift.x - 7) < 0.6 && Math.abs(moved.shift.y + 4) < 0.6,
    JSON.stringify(moved),
  );
  assert.ok(moved.changed > 0);
  const swapped = jumpMove(two(card(40, 30, 3), card(40, 30, 8)), 1);
  assert.equal(swapped.shift, null, JSON.stringify(swapped));
  assert.ok(swapped.changed > 0);
});

test("text moving under a device pixel a frame for a second or more is one span; faster or shorter is not", () => {
  const at = (x: number) =>
    [
      [x, 10],
      [x + 50, 40],
      [200, 200],
    ] as [number, number][];
  // steps of half a second at 10 fps: v px a frame moves 5·v px a step
  const step = (from: number, v: number) => ({
    from,
    to: from + 0.5,
    at: at(100),
    next: at(100 + 5 * v),
  });
  // 0.3 px a frame from 1 to 2.5 s (the static third piece is not moving text)
  const steps = [
    step(0, 0),
    step(0.5, 3),
    step(1, 0.3),
    step(1.5, 0.3),
    step(2, 0.2),
    step(2.5, 2),
    step(3, 0.4),
  ];
  assert.deepEqual(slowTextSpans(steps, 1, 10), [{ from: 1, to: 2.5, speed: 0.3, fastest: 0.3 }]);
  // drawn at 4 device px per px, 0.3 px is more than a device pixel a frame
  assert.deepEqual(slowTextSpans(steps, 4, 10), []);
  // one piece alone counts; under 0.02 px a frame is not moving; a gap ends a span
  const lone = (v: number, froms = [0, 0.5, 1]) =>
    froms.map((from) => ({
      from,
      to: from + 0.5,
      at: [[0, 0]] as [number, number][],
      next: [[5 * v, 0]] as [number, number][],
    }));
  assert.deepEqual(slowTextSpans(lone(0.3), 1, 10), [
    { from: 0, to: 1.5, speed: 0.3, fastest: 0.3 },
  ]);
  assert.deepEqual(slowTextSpans(lone(0.001), 1, 10), []);
  assert.deepEqual(slowTextSpans(lone(0.3, [0, 1.5]), 1, 10), []);
});

const REPORT: FilmReport = {
  film: "/x/film.mp4",
  duration: 44.4,
  fps: 60,
  from: 0,
  every: 0.5,
  layout: { width: 1920, height: 1080 },
  density: 1,
  slowFps: 60,
  fine: [],
  fineSupersample: 1,
  turns: {
    how: "measured",
    list: [{ from: 19.32, to: 20.1, at: 19.52, axis: "x", kind: "back", px: 19 }],
  },
  draft: false,
  pastPixels: { how: "measured", list: [] },
  parts: { how: "measured", named: 0, uses: [] },
  productText: {
    how: "measured",
    pictures: { how: "read", files: 2, skipped: 0 },
    spans: [{ from: 7.5, to: 38.5, share: 1, phone: 2.9, at: 14.5 }],
  },
  jumps: {
    how: "measured",
    declared: 7,
    list: [
      { t: 0.35, kind: "swap", changed: 0.07, px: 40, dx: -40, dy: 0 },
      { t: 0.42, kind: "swap", changed: 0.03, px: 14, dx: -14, dy: 1 },
      { t: 16.57, kind: "swap", changed: 0.06, px: 70, dx: -70, dy: 1 },
      { t: 29.48, kind: "cut", changed: 0.19, px: 42, dx: 0, dy: -42 },
      { t: 30.68, kind: "cut", changed: 0.19, px: 42, dx: 0, dy: 42 },
      { t: 31.88, kind: "cut", changed: 0.2, px: 71, dx: 1, dy: -71 },
      { t: 33, kind: "swap", changed: 0.04, px: null, dx: 0, dy: 0 },
    ],
  },
  moving: {
    how: "measured",
    logs: 1,
    matched: 2,
    unrecorded: 0,
    list: [
      {
        src: "shots/calc.png",
        log: "shots/shots.json",
        still: "calc",
        times: [14.4, 14.5],
        texts: [{ before: "2,576", after: "993" }],
        more: 0,
        moved: false,
        animations: 0,
      },
    ],
  },
  slowText: { how: "measured", spans: [{ from: 15.5, to: 19, speed: 0.19, fastest: 0.59 }] },
  ms: 3000,
};

test("the lines: what was measured, where, how much — and where the full report is", () => {
  const L = formatFilmReport(REPORT, { probe: "open-take film probe film.mp4 --page film" });
  assert.ok(L.length <= 10, `${L.length} lines`);
  const text = L.join("\n");
  assert.match(
    text,
    /7\.50 s–38\.50 s up to 100% of the text, median down to 2\.9 px on a phone \(14 px here, at 14\.50 s\)/,
  );
  // the largest changes are the ones named; the rest are counted
  assert.match(text, /29\.48 s 42 px up/);
  assert.match(text, /30\.68 s 42 px down/);
  assert.match(text, /31\.88 s 71 px up/);
  assert.match(text, /0\.35 s–0\.42 s 2 jumps of 14–40 px left \(up to 7% of the frame changed\)/);
  assert.match(text, /; 1 more/);
  assert.match(text, /1 changed in place/);
  assert.match(text, /the page declares 7 cut\(s\)/);
  assert.match(text, /shots\/calc\.png on screen 14\.40 s–14\.50 s "2,576" → "993"/);
  assert.match(text, /15\.50 s–19\.00 s 0\.19 px a frame, the fastest piece 0\.59/);
  assert.match(text, /--supersample/);
  assert.match(text, /`film picture`/);
  assert.match(text, /`hold\(\)`/, "the jumps line names the block that keeps a part in place");
  assert.match(text, /can move in steps/);
  assert.match(text, /19\.32 s–20\.10 s the wrong way first, 19 px across \(at 19\.52 s\)/);
  // the stretch the render drew finer is said so
  assert.match(
    formatFilmReport(
      { ...REPORT, fine: [{ from: 15, to: 19.5 }], fineSupersample: 3 },
      { probe: "p" },
    ).join("\n"),
    /0\.19 px a frame, the fastest piece 0\.59 \(at the median, a step about every 1\.8 frames, drawn at 3×\)/,
  );
  assert.match(text, /open-take film probe film\.mp4 --page film/);
  assert.match(text, /--no-report/);
  assert.doesNotMatch(text, /page's timeline/);
  // a film of part of the page says where its clock starts
  assert.match(
    formatFilmReport({ ...REPORT, from: 4 }, { probe: "p" })[0]!,
    /times from the film's start, 4\.00 s on the page's timeline/,
  );
  assert.doesNotMatch(text, /\bscore\b|\bpass\b|\bgrade:|too small|too much|\bshould\b/i);
  // a draft's slow text is counted as a master draws it
  assert.match(
    formatFilmReport({ ...REPORT, draft: true }, { probe: "p" }).join("\n"),
    /under a device pixel a frame \(counted as a master draws it: full size, 60 fps\)/,
  );
  // nothing found is said as such, with what was covered
  const none = formatFilmReport(
    {
      ...REPORT,
      productText: {
        how: "measured",
        pictures: { how: "none on screen", files: 0, skipped: 0 },
        spans: [],
      },
      jumps: { how: "measured", declared: 0, list: [] },
      moving: {
        how: "not measured",
        note: "the page was not played",
        logs: 0,
        matched: 0,
        unrecorded: 0,
        list: [],
      },
      slowText: { how: "measured", spans: [] },
    },
    { probe: "p" },
  ).join("\n");
  assert.match(none, /one-frame jumps not declared as cuts: none \(the page declares no cuts/);
  assert.match(none, /pictures taken mid-change: not measured — the page was not played/);
  assert.match(none, /live text moving under a device pixel a frame for a second or more: none/);
});

test("the parts the film named: each use, where the part was at its times, facts only", () => {
  const seen = {
    t: 13,
    state: "home",
    shown: true,
    on: ["home"],
    picture: [800, 400, 100, 60] as [number, number, number, number],
    inFrame: 1,
    covered: [] as { what: string; share: number }[],
    drawn: "screen" as const,
  };
  const r: FilmReport = {
    ...REPORT,
    pastPixels: {
      how: "measured",
      list: [{ src: "/x.take/capture.mp4", label: "video", from: 3.1, to: 6, ratio: 2.4 }],
    },
    parts: {
      how: "measured",
      named: 4,
      uses: [
        {
          name: '"format menu"',
          ref: "c-1:e77",
          use: "frame",
          t: 9,
          seen: [{ ...seen, t: 9, state: "c-1", shown: false, on: ["c-0", "c-1", "c-2"] }],
        },
        {
          name: "toggle",
          ref: "home:e41",
          use: "click",
          t: 13,
          seen: [{ ...seen, covered: [{ what: "path in #overlay", share: 0.375 }] }],
        },
        {
          name: "t1",
          ref: "n-1:e88",
          use: "drag",
          t: 20.4,
          end: 21.4,
          seen: [
            { ...seen, t: 20.4 },
            { ...seen, t: 21.4, inFrame: 0.88, edge: "right" },
          ],
        },
        {
          name: "n-3:e88",
          ref: "n-3:e88",
          use: "frame",
          t: 21,
          seen: [{ ...seen, t: 21, drawn: "still", sourcePx: 2.2 }],
        },
      ],
    },
  };
  const text = formatFilmReport(r, { probe: "p" }).join("\n");
  assert.match(text, /parts the film named \(through product\(\); times on the film's clock\):/);
  assert.match(
    text,
    /"format menu" c-1:e77 framed 9\.00 s: not on the screen shown then; it is on c-0, c-1, c-2; in frame/,
  );
  assert.match(text, /toggle home:e41 clicked 13\.00 s: in frame; 38% covered by path in #overlay/);
  assert.match(
    text,
    /t1 n-1:e88 dragged 20\.40 s–21\.40 s: off the frame's right edge 12% at 21\.40 s/,
  );
  // a part named by its ref is not named twice
  assert.match(
    text,
    /\n {4}n-3:e88 framed 21\.00 s: in frame; drawn from a still at 2\.2 frame px per still px/,
  );
  assert.match(
    text,
    /pictures drawn past their own pixels \(<img> and <video> on the page, every 0\.50 s\): \/x\.take\/capture\.mp4 3\.10 s–6\.00 s, up to 2\.4 frame px per source px/,
  );
  assert.doesNotMatch(text, /\bscore\b|\bpass\b|\bgrade:|too small|too much|\bshould\b/i);
  // none named, and the page not played, are said as such
  const none = formatFilmReport(REPORT, { probe: "p" }).join("\n");
  assert.match(none, /parts: none named through product\(\)/);
  assert.match(none, /pictures drawn past their own pixels \([^)]*\): none/);
  assert.match(
    formatFilmReport(
      {
        ...REPORT,
        parts: { how: "not measured", note: "the page was not played", named: 0, uses: [] },
      },
      { probe: "p" },
    ).join("\n"),
    /parts named through product\(\): not measured — the page was not played/,
  );
});

test("a part's use read at its times: on the film's clock, each use once, the frame's edges", () => {
  const listed = [
    {
      key: "home:e41",
      name: "toggle",
      ref: "home:e41",
      reads: true,
      uses: [
        { use: "frame", t: 12, ref: "home:e41" },
        // the same move asked again on a later frame
        { use: "frame", t: 12, ref: "home:e41" },
        { use: "drag", t: 14, end: 15 },
        // past the film's end: not read
        { use: "mark", t: 99, label: "the toggle" },
      ],
    },
  ];
  const at = (picture: [number, number, number, number], o = {}) => ({
    key: "home:e41",
    state: "home",
    ref: "home:e41",
    shown: true,
    on: ["home"],
    picture,
    drawn: "screen",
    covered: [],
    ...o,
  });
  const uses = partUses(
    listed,
    [
      { t: 2, parts: [at([100, 100, 50, 50])] },
      { t: 4, parts: [at([-25, 10, 50, 50], { covered: null })] },
      { t: 5, parts: [{ key: "home:e41", error: "boom" }] },
    ],
    { from: 10, duration: 20, layout: { width: 1920, height: 1080 } },
  );
  assert.equal(uses.length, 3);
  assert.deepEqual(
    uses.map((u) => [u.use, u.t, u.end]),
    [
      ["frame", 2, undefined],
      ["drag", 4, 5],
      ["mark", 89, undefined],
    ],
  );
  assert.equal(uses[0]!.seen[0]!.inFrame, 1);
  assert.equal(uses[1]!.ref, "home:e41", "the ref read on the screen when the use had none");
  assert.deepEqual(
    [uses[1]!.seen[0]!.inFrame, uses[1]!.seen[0]!.edge, uses[1]!.seen[0]!.covered],
    [0.5, "left", null],
  );
  assert.match(uses[1]!.note!, /could not be read at 5\.00 s: boom/);
  assert.deepEqual(uses[2]!.seen, []);
  assert.equal(uses[2]!.note, "not read (outside the film)");
  // the ref read again at its time wins over the one given at setup
  const again = partUses(
    [{ ...listed[0]!, uses: [{ use: "click", t: 12, ref: "home:e41" }] }],
    [{ t: 2, parts: [at([100, 100, 50, 50], { state: "add-1", ref: "add-1:e41" })] }],
    { from: 10, duration: 20, layout: { width: 1920, height: 1080 } },
  );
  assert.equal(again[0]!.ref, "add-1:e41");
  // inside the film but not read: said so, not "outside"; a drag no part was
  // pressed for, said as such
  const unread = partUses(
    [
      { ...listed[0]!, uses: [{ use: "frame", t: 13 }] },
      { key: "drag n", name: "n", ref: "", reads: false, uses: [{ use: "drag", t: 12, end: 13 }] },
    ],
    [],
    { from: 10, duration: 20, layout: { width: 1920, height: 1080 } },
  );
  assert.deepEqual(
    unread.map((u) => u.note),
    ["no part of components.json was pressed: where it is not read", "not read at its times"],
  );
  const lines = formatFilmReport(
    { ...REPORT, parts: { how: "measured", named: 0, uses: unread } },
    { probe: "p" },
  ).join("\n");
  assert.match(
    lines,
    /\n {4}n dragged 2\.00 s–3\.00 s: no part of components\.json was pressed: where it is not read/,
  );
  assert.deepEqual(inFrameOf([0, 1000, 100, 100], { width: 1920, height: 1080 }), {
    inFrame: 0.8,
    edge: "bottom",
  });
  assert.deepEqual(inFrameOf([2000, 0, 10, 10], { width: 1920, height: 1080 }), {
    inFrame: 0,
    edge: "right",
  });
});

test("pictures drawn past their own pixels: the stretches each was, and the most px per px", () => {
  const sample = (
    t: number,
    media: { label: string; src?: string; drawn?: number[]; natural?: number[] }[],
  ) => ({ t, media: media.map((m) => ({ box: [0, 0, 10, 10], ...m })) }) as never;
  const list = pastPixels(
    [
      sample(0, [{ label: "video", src: "/a.mp4", drawn: [0, 0, 200, 100], natural: [100, 50] }]),
      sample(0.5, [
        { label: "video", src: "/a.mp4", drawn: [0, 0, 250, 125], natural: [100, 50] },
        // a 2× still drawn at half its pixels, and one without a known size
        { label: "img", src: "/s.png", drawn: [0, 0, 100, 50], natural: [200, 100] },
        { label: "canvas" },
      ]),
      sample(1, []),
      sample(1.5, [{ label: "video", src: "/a.mp4", drawn: [0, 0, 150, 75], natural: [100, 50] }]),
    ],
    0.5,
  );
  assert.deepEqual(list, [
    { src: "/a.mp4", label: "video", from: 0, to: 0.5, ratio: 2.5 },
    { src: "/a.mp4", label: "video", from: 1.5, to: 1.5, ratio: 1.5 },
  ]);
});

let dir = "";
before(async () => {
  dir = await mkdtemp(join(tmpdir(), "film-report-"));
});
after(async () => {
  await rm(dir, { recursive: true, force: true });
});

test("the report on a rendered film: a jump not declared, the product's small words, text that creeps", {
  skip: findChrome() ? false : "no Chrome for Testing",
}, async () => {
  const chrome = findChrome()!;
  const page = join(dir, "page");
  await mkdir(page, { recursive: true });
  const words = Array.from({ length: 60 }, (_, i) => `item ${i}`).join(" ");
  await writeFile(
    join(page, "index.html"),
    `<!doctype html><html><head><style>body{margin:0;width:320px;height:180px;overflow:hidden;background:#fff;font:16px sans-serif}
canvas{position:absolute;left:10px;top:10px;width:120px;height:80px}
iframe{position:absolute;left:150px;top:10px;width:160px;height:120px;border:0}
#cap{position:absolute;left:20px;top:140px;color:#000}</style></head><body>
<canvas id="card" width="120" height="80"></canvas>
<iframe srcdoc="<body style='margin:0;font:5px sans-serif'>${words}</body>"></iframe>
<div id="cap">A caption</div>
<script>
const g = document.getElementById("card").getContext("2d");
for (let i = 0; i < 60; i++) { g.fillStyle = i % 2 ? "#345" : "#9ab"; g.fillRect((i * 37) % 120, (i * 23) % 80, 18, 14); }
window.__film = { duration: 4, width: 320, height: 180, fps: 10 };
window.__render = (t) => {
  // the card jumps 20 px right at 1 s, declared nowhere
  document.getElementById("card").style.left = (t >= 1 ? 30 : 10) + "px";
  // the caption creeps 0.2 px a frame from 1.5 s on
  document.getElementById("cap").style.transform = "translateX(" + Math.max(0, t - 1.5) * 2 + "px)";
};
</script></body></html>`,
  );
  const film = join(dir, "film.mp4");
  await renderFilm({ page, out: film, chromePath: chrome, blur: false, audio: null, workers: 1 });
  const r = await filmReport({ film, page, chromePath: chrome });
  assert.equal(r.layout.width, 320);
  assert.equal(r.jumps.declared, 0);
  const jump = r.jumps.list.find((j) => Math.abs(j.t - 1) < 0.05);
  assert.ok(jump?.px != null, JSON.stringify(r.jumps));
  assert.ok(Math.abs(jump.px - 20) <= 4 && jump.dx > 0, JSON.stringify(jump));
  // the saved screen's 5 px words: most of the text, about 6 px on a phone
  assert.equal(r.productText.how, "measured");
  assert.ok(r.productText.spans.length, JSON.stringify(r.productText));
  assert.ok(r.productText.spans[0]!.phone! < 8, JSON.stringify(r.productText));
  assert.equal(r.slowText.how, "measured");
  assert.ok(
    r.slowText.spans.some((s) => s.from <= 2 && s.to >= 3 && Math.abs(s.speed - 0.2) < 0.03),
    JSON.stringify(r.slowText),
  );
  assert.equal(r.moving.how, "measured");
  assert.deepEqual(r.parts, { how: "measured", named: 0, uses: [] });
  const L = formatFilmReport(r, { probe: "probe" });
  assert.ok(L.length <= 10);
  assert.match(L.join("\n"), /parts: none named through product\(\)/);
});

test("the report on a film naming parts: a part under an overlay, one framed while another screen shows, a 2× still, a video drawn past its pixels", {
  skip: findChrome() ? false : "no Chrome for Testing",
}, async () => {
  const chrome = findChrome()!;
  const shoot = join(dir, "shoot");
  await mkdir(shoot, { recursive: true });
  writePartsShoot(shoot);
  writeComponents(gatherComponents(readComponentSource(shoot)), shoot);
  await initFilm({ dir: join(shoot, "film") });
  // a picture and a video 64×36, both drawn 160×90
  const ffmpeg = await resolveFfmpeg();
  const color = ["-f", "lavfi", "-i", "color=c=0x336699:s=64x36:r=10:d=4"];
  await runTool(ffmpeg, [
    "-v",
    "error",
    ...color,
    "-frames:v",
    "1",
    "-y",
    join(shoot, "film", "pic.png"),
  ]);
  await runTool(ffmpeg, [
    "-v",
    "error",
    ...color,
    "-pix_fmt",
    "yuv420p",
    "-y",
    join(shoot, "film", "clip.mp4"),
  ]);
  const page = join(shoot, "film", "parts.html");
  await writeFile(
    page,
    `<!doctype html><html><head><meta charset="utf-8"><style>
html,body{margin:0;width:640px;height:360px;background:#fff;overflow:hidden}
iframe{position:absolute;left:0;top:0;width:640px;height:360px;border:0}
#over{position:absolute;left:300px;top:200px;width:80px;height:20px;pointer-events:none}
#pic{position:absolute;left:470px;top:260px;width:160px;height:90px}
#clip{position:absolute;left:0;top:260px;width:160px;height:90px}
</style></head><body>
<iframe id="now" src="../states/add-2/state.html"></iframe>
<svg id="over" viewBox="0 0 80 20"><rect width="80" height="20" fill="#e33"/></svg>
<img id="pic" src="pic.png"><video id="clip" src="clip.mp4" muted playsinline></video>
<script>let done; window.__film = { duration: 3, width: 640, height: 360, fps: 10, ready: new Promise((r) => (done = r)) }; window.__render = () => {};</script>
<script type="module">
import { product } from "./kit/media.js";
const P = await product("../");
P.play([[0, "add-2"], [2.5, { still: 1 }]]);
// from 2.5 s the still is drawn 4× (its screen's px)
P.view({ place: (t) => ({ x: 0, y: 0, scale: t >= 2.5 ? 4 : 1 }) });
P.part("t1").used("click", 1);
P.part("home:e1", { name: "page" }).used("frame", 2);
P.part("home:e2", { name: "title" }).used("frame", 2.75);
done();
</script></body></html>`,
  );
  const film = join(dir, "parts.mp4");
  await renderFilm({
    page,
    root: shoot,
    out: film,
    chromePath: chrome,
    blur: false,
    audio: null,
    workers: 1,
  });
  const r = await filmReport({ film, page, root: shoot, chromePath: chrome });
  assert.equal(r.parts.how, "measured", JSON.stringify(r.parts));
  assert.equal(r.parts.named, 3);
  const [click, framed, title] = r.parts.uses;
  assert.deepEqual([click?.use, click?.t, framed?.t, title?.t], ["click", 1, 2, 2.75]);
  // the svg over the number's top half, pointer-events none and all
  assert.deepEqual(click!.seen[0]!.covered, [{ what: "rect in #over", share: 0.5 }]);
  assert.equal(click!.seen[0]!.inFrame, 1);
  assert.deepEqual(
    [framed!.seen[0]!.shown, framed!.seen[0]!.showing, framed!.seen[0]!.on],
    [false, "add-2", ["home"]],
    JSON.stringify(framed),
  );
  const t = title!.seen[0]!;
  assert.deepEqual(
    [t.drawn, t.sourcePx, t.inFrame, t.edge],
    ["still", 2, 0.6, "right"],
    JSON.stringify(t),
  );
  const past = r.pastPixels.list.map((x) => [x.src?.split("/").pop(), x.ratio]);
  assert.deepEqual(
    past
      .filter(([, k]) => k === 2.5)
      .map(([s]) => s)
      .sort(),
    ["clip.mp4", "pic.png"],
    JSON.stringify(r.pastPixels),
  );
  const text = formatFilmReport(r, { probe: "probe" }).join("\n");
  assert.match(text, /t1 add-2:e4 clicked 1\.00 s: in frame; 50% covered by rect in #over/);
  assert.match(
    text,
    /page home:e1 framed 2\.00 s: not on the screen shown then \(add-2\); it is on home/,
  );
  assert.match(
    text,
    /title add-1:e2 framed 2\.75 s: off the frame's right edge 40%.*drawn from a still at 2\.0 frame px per still px/,
  );
  assert.match(text, /clip\.mp4 [\d.]+ s–[\d.]+ s, up to 2\.5 frame px per source px/);
});
