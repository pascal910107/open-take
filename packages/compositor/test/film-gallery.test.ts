// `film gallery`: the numbers under each setting, the subject it picks out
// of a saved screen, the kit it reads (the film's own when given), the PNGs
// and index it writes — and `film init`'s page, which holds only wiring.
// The drawing tests need Chrome for Testing and skip without it.

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { promisify } from "node:util";
import { impact, spring } from "../kit/motion.js";
import { resolveFfmpeg } from "../src/ffmpeg";
import {
  filmGallery,
  formatStats,
  galleryBlockNames,
  galleryKitDir,
  measureRow,
  pickOther,
  pickSubject,
} from "../src/film/gallery";
import { filmKitDir, initFilm, starterPage } from "../src/film/kit";
import { renderFilm } from "../src/film/render";
import type { StateElement } from "../src/state-index";
import { findChrome } from "./fixtures/find-chrome";

const exec = promisify(execFile);
const chrome = findChrome();
const skip = chrome ? false : "no Chrome for Testing";

let dir = "";
before(async () => {
  dir = await mkdtemp(join(tmpdir(), "open-take-gallery-test-"));
});
after(async () => {
  await rm(dir, { recursive: true, force: true });
});

const near = (a: number, b: number, tol: number, what: string) =>
  assert.ok(Math.abs(a - b) <= tol, `${what}: ${a} vs ${b} (±${tol})`);

/** a PNG's width and height, from its header */
async function pngSize(file: string): Promise<[number, number]> {
  const b = await readFile(file);
  assert.equal(b.toString("latin1", 1, 4), "PNG", `${file} is a PNG`);
  return [b.readUInt32BE(16), b.readUInt32BE(20)];
}

test("a setting's numbers are measured on the function: settle, swing past its rest, top speed", () => {
  // the kit's default spring: ζ 0.7 swings exp(−ζπ/√(1−ζ²)) ≈ 4.6 % past its rest
  const s = measureRow((t) => spring(t), 0, 1);
  const zeta = 0.7;
  near(s.swing!, Math.exp((-zeta * Math.PI) / Math.sqrt(1 - zeta * zeta)), 0.002, "first swing");
  assert.equal(s.from, 0);
  near(s.to, 1, 1e-6, "rest");
  // its envelope e^(−ζω0·t) / √(1−ζ²) is under 1 % from ≈ 0.70 s; the swing itself sooner
  assert.ok(s.settle! > 0.5 && s.settle! < 0.75, `settles at ${s.settle}`);
  assert.equal(s.peak, null, "a move that goes somewhere has no peak from rest");
  // a kick comes back: its peak, not a swing
  const k = measureRow((t) => impact(t, 0).y, 0, 0.4);
  assert.equal(k.swing, null);
  near(k.peak!, 10, 0.05, "the 10 px first swing");
  near(k.peakSpeedAt, 0, 0.01, "fastest at the hit");
  // something that never comes to rest is said so
  const w = measureRow((t) => Math.sin(t * 7), 0, 1);
  assert.equal(w.settle, null);
  assert.match(formatStats(w), /settles: not detected in 4\.0 s/);
  assert.match(formatStats(s), /settles \(1 %\) at 0\.\d{3} s · swings 4\.6 % past its rest/);
  // a step function's speed is a rate over the window asked for
  const typed = measureRow((t) => Math.max(0, Math.min(10, Math.floor(t * 16) + 1)), 0, 1, 0.25);
  near(typed.peakSpeed, 16, 0.5, "16 characters a second");
  // … over four of its steps when they come closer: 6 characters at 40 a
  // second are done in 0.125 s, and are still 40 a second, not 6 / 0.25
  const fast = measureRow((t) => Math.max(0, Math.min(6, Math.floor(t * 40) + 1)), 0, 0.6, 0.25);
  near(fast.speedOver, 0.1, 0.002, "four steps' window");
  near(fast.peakSpeed, 40, 1, "40 characters a second");
  // … and over the steps there are, for a word of three characters
  const word = measureRow((t) => Math.max(0, Math.min(3, Math.floor(t * 40) + 1)), 0, 0.6, 0.25);
  near(word.peakSpeed, 40, 3, "still 40 a second");
  // a hand's wander is not a jump
  assert.equal(measureRow((t) => 6 * Math.sin(t * 9) + 0.01 * t, 0, 3).jump, null);
  // a kick that rings long still comes back, its tail a hair off 0 at the
  // window's end: a peak and a settle, not a swing of millions of percent
  const ring = measureRow((t) => impact(t, 0, { amount: 30, freq: 3, damping: 0.2 }).y, 0, 0.4);
  assert.equal(ring.swing, null);
  near(ring.peak!, 30, 1, "its first swing");
  assert.ok(ring.settle! > 0.5 && ring.settle! < 3, `settles at ${ring.settle}`);
  // a wander has no rest: no swing past it, no peak from it
  const wander = measureRow((t) => Math.sin(t * 7) + 0.3 * t, 0, 1);
  assert.equal(wander.settle, null);
  assert.equal(wander.swing, null);
  assert.equal(wander.peak, null);
  assert.doesNotMatch(formatStats(wander), /swing|peak/);
  // a cut is a jump, not a speed
  const cut = measureRow((t) => (t < 0.5 ? 1 : 3), 0, 1);
  near(cut.jump!, 0.5, 0.002, "the cut");
  assert.match(formatStats(cut), /jumps at 0\.50\d s \(a cut: no speed\)/);
  assert.equal(s.jump, null, "a spring does not jump");
});

const el = (
  id: string,
  tag: string,
  box: [number, number, number, number],
  more: Partial<StateElement> = {},
): StateElement => ({ id, path: [], tag, box, ...more });
const screen = {
  viewport: { w: 1280, h: 720, dpr: 1 },
  elements: [
    el("e0", "html", [0, 0, 1280, 720]),
    el("e1", "div", [0, 0, 1280, 300], { text: "Search the docs and more" }),
    el("e2", "p", [40, 40, 300, 30], { text: "Search the docs" }),
    el("e3", "a", [40, 100, 120, 32], { role: "link", name: "Pricing", interactive: true }),
    el("e4", "button", [600, 400, 140, 44], { role: "button", name: "Deploy", interactive: true }),
    el("e5", "button", [600, 2000, 140, 44], { role: "button", name: "Below", interactive: true }),
  ],
};

test("the subject is the element asked for — by id, by its text, by a box — or one chosen and said", () => {
  assert.deepEqual(pickSubject(screen, "e3").box, { x: 40, y: 100, width: 120, height: 32 });
  // the smallest element carrying the text is the one, not its container
  const byText = pickSubject(screen, "Search the docs");
  assert.match(byText.label, /^e2 <p>/);
  assert.equal(byText.text, "Search the docs");
  assert.deepEqual(pickSubject(screen, "10,20,30,40").box, { x: 10, y: 20, width: 30, height: 40 });
  assert.throws(() => pickSubject(screen, "nowhere"), /no element of the saved screen/);
  assert.throws(() => pickSubject(screen, "1,2,0,4"), /needs a width and a height/);
  // chosen: a button on screen before a link; one below the fold is not on screen
  const auto = pickSubject(screen);
  assert.match(auto.label, /^e4 <button role=button> "Deploy"/);
  assert.match(auto.how, /chosen automatically.*--subject/);
  const none = pickSubject({ viewport: screen.viewport, elements: [] });
  assert.deepEqual(none.box, { x: 1280 / 3, y: 240, width: 1280 / 3, height: 240 });
  assert.match(none.how, /middle/);
});

test("a match cut lands on a second element, unlike the subject in place and shape", () => {
  const s = { x: 600, y: 400, width: 140, height: 44 };
  const o = pickOther(screen, s);
  // the link is a control apart from the button, but the same shape: the paragraph is not
  assert.match(o.label, /^e2 <p>/);
  const none = pickOther({ viewport: screen.viewport, elements: [] }, s);
  assert.equal(none.width, 280);
  assert.match(none.label, /mirror/);
});

test("the gallery reads the film's own kit when given its folder, else the kit this package ships", async () => {
  assert.equal(galleryKitDir(), filmKitDir());
  const film = join(dir, "kit-film");
  await mkdir(join(film, "kit"), { recursive: true });
  await writeFile(join(film, "kit", "motion.js"), "export const rise = () => 0;\n");
  assert.equal(galleryKitDir(film), join(film, "kit"));
  assert.equal(galleryKitDir(join(film, "kit")), join(film, "kit"));
  assert.throws(() => galleryKitDir(dir), /no kit at/);
  const names = await galleryBlockNames();
  for (const n of ["spring", "rise", "morphRect", "zoomThrough", "press", "impact", "camera.frame"])
    assert.ok(names.includes(n), `${n} is drawn`);
  for (const n of ["camera.lead", "camera.handheld", "camera.shake", "camera.depth", "camera.zoom"])
    assert.ok(names.includes(n), `the camera option ${n} is drawn`);
  for (const n of ["tilt", "explode", "drop", "stack", "flip", "turn", "dolly"])
    assert.ok(names.includes(`stage.${n}`), `the stage's ${n} is drawn`);
});

test("kit/stage.js is drawn: every move a PNG, with its numbers, under its own heading", {
  skip,
}, async () => {
  const r = await filmGallery({ chromePath: chrome!, out: join(dir, "stage"), blocks: ["stage"] });
  assert.deepEqual(
    r.entries.map((e) => e.name),
    [
      "stage.tilt",
      "stage.explode",
      "stage.drop",
      "stage.stack",
      "stage.flip",
      "stage.turn",
      "stage.dolly",
    ],
  );
  for (const e of r.entries) {
    assert.ok(e.png, `${e.name} drawn`);
    for (const row of e.rows) assert.ok(row.stats, `${e.name} / ${row.label} measured`);
  }
  // the tilt lands on the angle asked: rx 20, ry −28
  near(r.entries[0]!.rows[0]!.stats!.to, Math.hypot(20, 28), 0.05, "the tilt's angle");
  // the drop starts 400 px up and comes to rest
  const fall = r.entries[2]!.rows[0]!.stats!;
  near(fall.from, 400, 1e-6, "from 400 px");
  assert.ok(fall.swing! > 0.1, "a bounce past its rest");
  const md = await readFile(r.index, "utf8");
  assert.match(md, /## kit\/stage\.js/);
  assert.match(md, /!\[stage\.flip\]\(stage\.flip\.png\)/);
});

test("film gallery draws each block on a stand-in: a PNG per block, index.md and gallery.json", {
  skip,
}, async () => {
  const out = join(dir, "stand-in");
  const r = await filmGallery({ chromePath: chrome!, out, blocks: ["rise", "camera.shake"] });
  assert.deepEqual(
    r.entries.map((e) => e.name),
    ["rise", "camera.shake"],
  );
  assert.equal(r.material.kind, "placeholder");
  for (const e of r.entries) {
    assert.ok(e.png, `${e.name} drawn`);
    const [w, h] = await pngSize(e.png!);
    assert.ok(w > 1500 && h > 1000, `${e.name}: ${w}×${h}`);
    assert.equal(e.rows.length, 4, "the default and three other settings");
    assert.equal(e.rows[0]!.label.startsWith("default"), true);
    for (const row of e.rows) assert.ok(row.stats, `${e.name} / ${row.label} measured`);
  }
  // rise's default lands 24 px away from where it starts, and swings past
  const rise = r.entries[0]!.rows[0]!.stats!;
  near(rise.from, 24, 1e-6, "rise starts 24 px along its travel");
  near(rise.to, 0, 1e-3, "and rests at its place");
  assert.ok(rise.swing! > 0.04, "the default spring swings past");
  // a shake comes back to where it was
  assert.equal(r.entries[1]!.rows[0]!.stats!.swing, null);
  const md = await readFile(r.index, "utf8");
  assert.match(md, /none of them is a target/);
  assert.match(md, /!\[rise\]\(rise\.png\)/);
  assert.match(md, /## kit\/camera\.js/);
  const json = JSON.parse(await readFile(r.json, "utf8"));
  assert.equal(json.version, 1);
  assert.equal(json.entries.length, 2);
  // a group picks every block in it; a name that is not there is refused, with the names that are
  const cams = await filmGallery({
    chromePath: chrome!,
    out: join(dir, "cams"),
    blocks: ["camera"],
  });
  assert.ok(cams.entries.length >= 9 && cams.entries.every((e) => e.group === "camera"));
  await assert.rejects(
    filmGallery({ chromePath: chrome!, out: join(dir, "nope"), blocks: ["wobble"] }),
    /no block named wobble — there are: spring, rise/,
  );
});

test("on a saved screen the blocks move its own element; a block the film's kit broke is said, not fatal", {
  skip,
}, async () => {
  // a saved screen: its index (with the boxes) and its live.png
  const state = join(dir, "take.take", "states", "s1");
  await mkdir(state, { recursive: true });
  await writeFile(join(state, "state.html"), "<!doctype html><p>saved</p>");
  await writeFile(
    join(state, "index.json"),
    JSON.stringify({
      version: 1,
      id: "s1",
      url: "https://example.test/",
      title: "t",
      tMs: 100,
      viewport: { w: 640, h: 360, dpr: 1 },
      scroll: { x: 0, y: 0 },
      elements: [
        el("e7", "button", [400, 200, 120, 40], { role: "button", name: "Go", interactive: true }),
      ],
      layers: [],
    }),
  );
  await exec(await resolveFfmpeg(), [
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "color=c=0x3366aa:s=640x360,drawbox=x=400:y=200:w=120:h=40:color=white:t=fill",
    "-frames:v",
    "1",
    "-y",
    join(state, "live.png"),
  ]);
  // the film's own kit, its rise changed so that it throws
  const film = join(dir, "own-kit");
  await cp(filmKitDir(), join(film, "kit"), { recursive: true });
  const motion = join(film, "kit", "motion.js");
  await writeFile(
    motion,
    (await readFile(motion, "utf8")).replace(
      "export function rise(t, start, opts = {}) {",
      'export function rise(t, start, opts = {}) {\n  throw new Error("my rise is not done");',
    ),
  );
  const r = await filmGallery({
    chromePath: chrome!,
    out: join(dir, "own"),
    kit: film,
    with: join(dir, "take.take"),
    blocks: ["rise", "press", "type"],
  });
  assert.equal(r.kit, join(film, "kit"));
  assert.equal(r.material.kind, "state");
  assert.equal(r.material.width, 640);
  assert.deepEqual(
    [
      r.material.subject.x,
      r.material.subject.y,
      r.material.subject.width,
      r.material.subject.height,
    ],
    [400, 200, 120, 40],
  );
  assert.match(r.material.subject.label, /e7 <button role=button> "Go"/);
  // "Go" is too short to show typing: the stand-in sentence is typed instead
  assert.equal(r.material.text, "typed on the film's time");
  assert.match(r.material.notes.join("\n"), /saved screen s1/);
  const [rise, press, type] = r.entries;
  assert.equal(rise!.png, null);
  assert.match(rise!.error!, /my rise is not done/);
  assert.ok(press!.png && type!.png, "the others are drawn");
  assert.match(await readFile(r.index, "utf8"), /Could not be drawn: my rise is not done/);
  // a subject asked for by its text
  const byText = await filmGallery({
    chromePath: chrome!,
    out: join(dir, "own2"),
    with: state,
    subject: "Go",
    blocks: ["press"],
  });
  assert.match(byText.material.subject.how, /given/);
});

const hasCut = existsSync(join(filmKitDir(), "cut.js"));

test("kit/cut.js is drawn: cut density, the grid, a match cut — on a stand-in pulse or the film's music", {
  skip: skip || (hasCut ? false : "the kit has no cut.js"),
}, async () => {
  const r = await filmGallery({ chromePath: chrome!, out: join(dir, "cuts"), blocks: ["cut"] });
  assert.deepEqual(
    r.entries.map((e) => e.name),
    ["cut.density", "cut.grid", "cut.matchCut"],
  );
  for (const e of r.entries) assert.ok(e.png, `${e.name} drawn`);
  const [density, , match] = r.entries;
  assert.match(density!.note, /stand-in pulse of 100 bpm, for drawing only/);
  // at 100 bpm a 4-bar section is 9.6 s: "burst" cuts every beat, "hold" never after its start
  assert.match(density!.rows[0]!.text, /^1 cut in 9\.60 s/);
  assert.match(density!.rows[2]!.text, /^16 cuts in 9\.60 s/);
  // the match cut keeps the subject's centre where it was in the picture
  for (const row of match!.rows) assert.match(row.text, /centre moves 0\.0 px/);
  // on the film's own music: its beats file's grid
  const beats = join(dir, "music.beats.json");
  const beat = 0.5;
  await writeFile(
    beats,
    JSON.stringify({
      version: 1,
      duration: 20,
      tempo: { bpm: 120 },
      beats: Array.from({ length: 40 }, (_, i) => 0.25 + i * beat),
      downbeats: Array.from({ length: 10 }, (_, i) => 0.25 + i * 4 * beat),
      onsets: [],
    }),
  );
  const m = await filmGallery({
    chromePath: chrome!,
    out: join(dir, "cuts-music"),
    blocks: ["cut.density"],
    beats,
  });
  assert.match(m.entries[0]!.note, /on the film's music/);
  assert.match(m.entries[0]!.rows[2]!.text, /^16 cuts in 8\.00 s/);
});

test("film init's page holds only wiring: no story, no look, no length, only the timeline imported", async () => {
  const page = starterPage([
    { name: "camera.js", role: "a camera for a film page" },
    { name: "time.js", role: "one timeline for the picture and the sound" },
  ]);
  const imports = [...page.matchAll(/^\s*import .* from "(.+)";$/gm)].map((m) => m[1]);
  assert.deepEqual(imports, ["./kit/time.js"], "only the timeline, for the events file");
  assert.match(
    page,
    /kit\/camera\.js\s+a camera for a film page/,
    "the rest is listed, not imported",
  );
  // the only style is the picture's size
  const css = /<style>([\s\S]*?)<\/style>/.exec(page)![1]!.trim();
  assert.equal(css, "html, body { margin: 0; width: 1920px; height: 1080px; overflow: hidden; }");
  assert.match(page, /duration: 1, \/\/ s — a placeholder/);
  assert.match(page, /\.\.\.tl\.hooks\(\)/);
  // init lists every kit file it copies
  const film = join(dir, "starter");
  const r = await initFilm({ dir: film });
  const written = await readFile(join(film, "index.html"), "utf8");
  for (const f of r.written.filter((w) => w.includes("/kit/")))
    assert.ok(written.includes(`kit/${f.split("/").pop()}`), `${f} listed`);
  assert.match(written, /kit\/audio\.mjs\s+sound for a film, for a Node script/);
});

test("film init's page renders as it is, and writes an events file", { skip }, async () => {
  const film = join(dir, "starter-render");
  await initFilm({ dir: film });
  const r = await renderFilm({
    page: film,
    out: join(dir, "starter.mp4"),
    chromePath: chrome!,
    draft: true,
    workers: 1,
    audio: null,
  });
  assert.equal(r.durationS, 1);
  const ev = JSON.parse(await readFile(r.events!, "utf8"));
  assert.deepEqual(ev.events, []);
});

test("kit/seams.js is drawn: every seam a PNG, the cut on the curve one travel through it", {
  skip,
}, async () => {
  const names = await galleryBlockNames();
  for (const n of [
    "curve",
    "waterfall",
    "whip",
    "depth",
    "matchText",
    "morph",
    "parallax",
    "pushCut",
    "dipCut",
  ])
    assert.ok(names.includes(`seams.${n}`), `the seam ${n} is drawn`);
  const r = await filmGallery({
    chromePath: chrome!,
    out: join(dir, "seams"),
    blocks: ["curve", "whip"],
  });
  assert.deepEqual(
    r.entries.map((e) => e.name),
    ["seams.curve", "seams.whip"],
  );
  for (const e of r.entries) assert.ok(e.png, `${e.name} drawn`);
  // the curve's travel runs through the cut without a jump: 0 → −460 px
  const c = r.entries[0]!.rows[0]!.stats!;
  near(c.from, 0, 1e-6, "from its place");
  near(c.to, -460, 1e-6, "both distances travelled");
  const md = await readFile(r.index, "utf8");
  assert.match(md, /## kit\/seams\.js/);
});
