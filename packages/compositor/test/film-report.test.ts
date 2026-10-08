// What `film render` prints when it is done: the jump reader and the slow
// text reader on cases built here with known answers, the lines on a report
// made here, then the whole report on a film rendered from a page made here
// (Chrome).

import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { type GreyFrames, jumpMove } from "../src/film/probe";
import { renderFilm } from "../src/film/render";
import { type FilmReport, filmReport, formatFilmReport, slowTextSpans } from "../src/film/report";
import { findChrome } from "./fixtures/find-chrome";

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
  layout: { width: 1920, height: 1080 },
  density: 1,
  slowFps: 60,
  draft: false,
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
  const L = formatFilmReport(r, { probe: "probe" });
  assert.ok(L.length <= 10);
});
