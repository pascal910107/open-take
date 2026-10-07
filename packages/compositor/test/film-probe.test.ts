// `film probe`: the picture analysis on frames built here with known answers,
// then the whole command on a film made here (ffmpeg; the picture only with
// Chrome).

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { resolveFfmpeg, runTool } from "../src/ffmpeg";
import {
  backAndForth,
  cameraPath,
  cameraRuns,
  cutDensity,
  filmProbe,
  findChanges,
  findCuts,
  findSmallSwaps,
  findStills,
  frameEnergy,
  type GreyFrames,
  globalMotion,
  readSegments,
  repeatedRuns,
  reversals,
  sheetSegments,
  subjectExits,
  subjectTracks,
  textPerSecond,
  textTimeline,
} from "../src/film/probe";
import {
  edgeShare,
  type FrameText,
  type PageTextSample,
  readPageText,
} from "../src/film/probe-text";
import { renderFilm } from "../src/film/render";
import { findChrome } from "./fixtures/find-chrome";

const W = 192;
const H = 108;

/** a seeded texture: blobs of grey, smooth enough to survive an encoder */
function texture(w: number, h: number, seed: number): Uint8Array {
  let s = seed >>> 0 || 1;
  const rnd = () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
  const cw = Math.ceil(w / 6) + 1;
  const ch = Math.ceil(h / 6) + 1;
  const grid = Array.from({ length: cw * ch }, () => 30 + rnd() * 200);
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const gx = x / 6;
      const gy = y / 6;
      const x0 = Math.floor(gx);
      const y0 = Math.floor(gy);
      const fx = gx - x0;
      const fy = gy - y0;
      const v = (i: number, j: number) => grid[(y0 + j) * cw + x0 + i]!;
      out[y * w + x] =
        v(0, 0) * (1 - fx) * (1 - fy) +
        v(1, 0) * fx * (1 - fy) +
        v(0, 1) * (1 - fx) * fy +
        v(1, 1) * fx * fy;
    }
  return out;
}

function frames(list: Uint8Array[], fps = 30): GreyFrames {
  const data = new Uint8Array(list.length * W * H);
  list.forEach((f, i) => {
    data.set(f, i * W * H);
  });
  return { w: W, h: H, fps, count: list.length, data };
}

/** a flat grey frame with a textured card at (x, y) */
function card(x: number, y: number, seed: number, grey = 235): Uint8Array {
  const f = new Uint8Array(W * H).fill(grey);
  const t = texture(56, 40, seed);
  for (let r = 0; r < 40; r++)
    for (let c = 0; c < 56; c++)
      if (y + r < H && x + c < W) f[(y + r) * W + x + c] = t[r * 56 + c]!;
  return f;
}

test("a still, a hard cut, a still: one cut, two still stretches, nothing carried", () => {
  const a = texture(W, H, 1);
  const b = texture(W, H, 2);
  const g = frames([...Array(30).fill(a), ...Array(30).fill(b)]);
  const e = frameEnergy(g);
  assert.deepEqual(findCuts(g, e), [30]);
  const stills = findStills(e, 30, 0.5);
  assert.deepEqual(stills, [
    { a: 0, b: 30 },
    { a: 30, b: 60 },
  ]);
  const ch = findChanges(g, e, [30]);
  assert.equal(ch.length, 1);
  assert.equal(ch[0]!.kind, "hard cut");
  assert.equal(ch[0]!.across, "nothing carried", JSON.stringify(ch[0]));
  assert.ok(ch[0]!.changed > 0.9);
});

test("a pan across a texture is no cut, and what changes is carried across", () => {
  const wide = texture(W * 3, H, 7);
  const list: Uint8Array[] = [];
  for (let i = 0; i < 60; i++) {
    const off = Math.min(150, Math.max(0, (i - 10) * 4));
    const f = new Uint8Array(W * H);
    for (let y = 0; y < H; y++) f.set(wide.subarray(y * W * 3 + off, y * W * 3 + off + W), y * W);
    list.push(f);
  }
  const g = frames(list);
  const e = frameEnergy(g);
  assert.deepEqual(findCuts(g, e), []);
  const ch = findChanges(g, e, []);
  assert.ok(ch.length >= 1, "a big change");
  for (const c of ch) assert.equal(c.kind, "carried", JSON.stringify(c));
  // the picture moves left, so what is carried moves left
  assert.ok(ch[0]!.shift && ch[0]!.shift.x < 0, JSON.stringify(ch[0]!.shift));
  // the whole picture's motion between two frames 4 px apart
  const m = globalMotion(g, list[20]!, list[21]!);
  assert.equal(m.s, 1);
  assert.ok(Math.abs(m.x + 4) <= 4 && m.y === 0, JSON.stringify(m));
});

test("a whip pan blurred past matching: no cut, carried between its sharp ends, spanning only the motion", () => {
  const wide = texture(W * 2, H, 11);
  const at = (off: number) => {
    const f = new Uint8Array(W * H);
    const o = Math.round(off);
    for (let y = 0; y < H; y++) f.set(wide.subarray(y * W * 2 + o, y * W * 2 + o + W), y * W);
    return f;
  };
  // still 20 frames, half the width in 8 frames with a 4-frame motion blur, still 20
  const offs = Array.from({ length: 48 }, (_, i) => Math.min(96, Math.max(0, (i - 20) * 12)));
  const list = offs.map((_, i) => {
    const acc = new Float32Array(W * H);
    for (let k = 0; k < 4; k++) {
      const f = at(offs[Math.max(0, i - k)]!);
      for (let p = 0; p < f.length; p++) acc[p]! += f[p]! / 4;
    }
    return Uint8Array.from(acc, (v) => Math.round(v));
  });
  const g = frames(list);
  const e = frameEnergy(g);
  assert.deepEqual(findCuts(g, e), []);
  const ch = findChanges(g, e, []);
  assert.equal(ch.length, 1, JSON.stringify(ch));
  const c = ch[0]!;
  assert.equal(c.kind, "carried", JSON.stringify(c));
  assert.ok(c.shift && c.shift.x < -40, JSON.stringify(c.shift));
  // from the last still frame before the motion to the first still one after
  assert.equal(c.before, 20);
  assert.equal(c.after, 31);
});

test("a card cut for another elsewhere on the same ground: only the background persists", () => {
  const g = frames([...Array(30).fill(card(10, 20, 3)), ...Array(30).fill(card(120, 50, 4))]);
  const e = frameEnergy(g);
  const cuts = findCuts(g, e);
  assert.deepEqual(cuts, [30]);
  const ch = findChanges(g, e, cuts);
  assert.equal(ch[0]!.across, "background only");
  assert.ok(ch[0]!.background > 0.5);
});

test("a picture that holds while a part of it swaps is a cut that carries", () => {
  const base = texture(W, H, 9);
  const swapped = base.slice();
  const patch = texture(W, H, 10);
  // the left 40 % of the frame swaps, the rest holds
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W * 0.4; x++) swapped[y * W + x] = patch[y * W + x]!;
  const g = frames([...Array(20).fill(base), ...Array(20).fill(swapped)]);
  const e = frameEnergy(g);
  const cuts = findCuts(g, e);
  assert.deepEqual(cuts, [20]);
  const c = findChanges(g, e, cuts)[0]!;
  assert.equal(c.across, "carried");
  assert.ok(c.stays > 0.5 && c.changed < 0.5, JSON.stringify(c));
});

test("cut density counts per bin, the last bin taking the end", () => {
  assert.deepEqual(cutDensity([0.5, 1, 6, 9.99, 10], 10, 5), [2, 3]);
  assert.deepEqual(cutDensity([], 12, 5), [0, 0, 0]);
});

test("declared subjects: curves and events, out and partly out, by edge", () => {
  const raw = {
    curves: {
      names: ["hero.x", "hero.y", "hero.w", "hero.h", "other"],
      t0: 0,
      dt: 1,
      rows: [
        [100, 100, 40, 40, 0],
        [-10, 100, 40, 40, 0], // crosses the left edge
        [-30, 100, 40, 40, 0], // gone past it
        [100, 100, 40, 40, 0],
      ],
    },
    events: [
      { t: 0, kind: "subject", label: "dot", x: 50, y: 50 },
      { t: 2, kind: "subject", label: "dot", x: 50, y: 1200 },
      { t: 3, kind: "click", x: 5000, y: 5000 },
    ],
  };
  const tracks = subjectTracks(raw);
  assert.deepEqual(
    tracks.map((t) => [t.name, t.source, t.samples.length]),
    [
      ["hero", "curves", 4],
      ["dot", "events", 2],
    ],
  );
  const exits = subjectExits(tracks, 1920, 1080, 5);
  assert.deepEqual(exits, [
    { name: "hero", start: 1, end: 2, how: "partly out", edge: "left" },
    { name: "hero", start: 2, end: 3, how: "out", edge: "left" },
    { name: "dot", start: 2, end: 5, how: "out", edge: "bottom" },
  ]);
});

/** a big texture seen through the frame at scale s, shifted (x, y) px */
function view(s: number, x: number, y: number, seed = 7): Uint8Array {
  const TW = W * 3;
  const T = texture(TW, H * 3, seed);
  const at = (u: number, v: number) =>
    T[Math.max(0, Math.min(H * 3 - 1, v)) * TW + Math.max(0, Math.min(TW - 1, u))]!;
  const f = new Uint8Array(W * H);
  for (let j = 0; j < H; j++)
    for (let i = 0; i < W; i++) {
      // bilinear: a move of a fraction of a pixel shows
      const px = (i - W / 2 - x) / s + W * 1.5;
      const py = (j - H / 2 - y) / s + H * 1.5;
      const u = Math.floor(px);
      const v = Math.floor(py);
      const fu = px - u;
      const fv = py - v;
      f[j * W + i] = Math.round(
        at(u, v) * (1 - fu) * (1 - fv) +
          at(u + 1, v) * fu * (1 - fv) +
          at(u, v + 1) * (1 - fu) * fv +
          at(u + 1, v + 1) * fu * fv,
      );
    }
  return f;
}

test("a word swapped on a held picture is a small swap, not a cut", () => {
  const a = texture(W, H, 3);
  const b = Uint8Array.from(a);
  const patch = texture(32, 24, 4);
  for (let r = 0; r < 24; r++)
    for (let c = 0; c < 32; c++) b[(40 + r) * W + 80 + c] = 255 - patch[r * 32 + c]!;
  const g = frames([...Array(20).fill(a), ...Array(20).fill(b)]);
  const e = frameEnergy(g);
  const cuts = findCuts(g, e);
  assert.deepEqual(cuts, []);
  const swaps = findSmallSwaps(g, e, cuts);
  assert.deepEqual(
    swaps.map((w) => w.frame),
    [20],
  );
  assert.ok(swaps[0]!.changed >= 0.02 && swaps[0]!.changed < 0.12, `${swaps[0]!.changed}`);
});

test("the camera: zoom in and out read to a fraction of a pixel, its runs, its turns back", () => {
  // 3 s at 30 fps: in for half a second, out for half a second, three times
  const list: Uint8Array[] = [];
  for (let i = 0; i < 90; i++) {
    const ph = (i / 30) % 1;
    list.push(view(1 + 0.06 * (ph < 0.5 ? ph * 2 : 2 - ph * 2), 0, 0));
  }
  const g = frames(list);
  const path = cameraPath(g, []);
  assert.equal(path.step, 1);
  const read = path.logScale.filter((v) => v != null).length;
  assert.ok(read >= 85, `read ${read}`);
  const runs = cameraRuns(path, 30);
  const zooms = runs.filter((r) => r.what === "zoom");
  assert.deepEqual(
    zooms.map((r) => r.dir),
    ["in", "out", "in", "out", "in", "out"],
  );
  assert.ok(Math.abs(zooms[0]!.amount - 1.06) < 0.01, `${zooms[0]!.amount}`);
  assert.equal(
    runs.filter((r) => r.what !== "zoom").length,
    0,
    "no pan in a zoom about the centre",
  );
  assert.equal(reversals(runs).length, 5);
  assert.deepEqual(
    backAndForth(runs).map((b) => [b.what, b.runs]),
    [["zoom", 6]],
  );
  // a short zoom out on every half second, the picture jumping back between
  const pulse: Uint8Array[] = [];
  for (let i = 0; i < 90; i++) {
    const ph = (i % 15) / 15;
    pulse.push(view(1 - 0.03 * Math.min(1, ph * 5), 0, 0));
  }
  const pg = frames(pulse);
  const pe = frameEnergy(pg);
  const pruns = cameraRuns(cameraPath(pg, findCuts(pg, pe)), 30);
  assert.deepEqual(reversals(pruns), [], "never turns back: it jumps back");
  assert.deepEqual(
    repeatedRuns(pruns).map((r) => [r.what, r.dir, r.runs, r.every]),
    [["zoom", "out", 6, 0.5]],
  );
  // a slow pan: 0.3 px a frame, under the change line, still read
  const pan = frames(Array.from({ length: 60 }, (_, i) => view(1, 0.3 * i, 0)));
  const pr = cameraRuns(cameraPath(pan, []), 30);
  assert.deepEqual(
    pr.map((r) => [r.what, r.dir]),
    [["pan x", "right"]],
  );
  assert.ok(Math.abs(pr[0]!.amount - (0.3 * 59) / W) < 0.02, `${pr[0]!.amount}`);
  // across a cut: the step is left out
  const cut = frames([...Array(10).fill(view(1, 0, 0)), ...Array(10).fill(texture(W, H, 99))]);
  const cp = cameraPath(cut, [10]);
  assert.equal(cp.logScale[9], null);
});

test("the beat sheet beside the picture: a hold that moves, a handoff at a cut, a subject that leaves", () => {
  assert.deepEqual(sheetSegments([{ from: 1, to: 0 }, { from: 0, to: 1, hold: true, x: 1 }, "x"]), [
    { from: 0, to: 1, hold: true },
  ]);
  // 0–1 s held still, 1–2 s a slow pan, a cut at 2 s, 2–3 s held
  const fps = 30;
  const list: Uint8Array[] = [];
  for (let i = 0; i < 90; i++)
    list.push(i < 30 ? view(1, 0, 0) : i < 60 ? view(1, (i - 30) * 0.8, 0) : texture(W, H, 50));
  const g = frames(list, fps);
  const energy = frameEnergy(g);
  const cuts = findCuts(g, energy);
  assert.deepEqual(cuts, [60]);
  const path = cameraPath(g, cuts);
  const runs = cameraRuns(path, fps);
  const changes = findChanges(g, energy, cuts);
  const segs = readSegments(
    [
      { from: 0, to: 1, hold: true, label: "still" },
      { from: 1, to: 2, hold: true, handoff: "matchcut", subject: "hero" },
      { from: 2, to: 3, handoff: "carry", subject: "#nowhere" },
    ],
    {
      duration: 3,
      fps,
      t0: 0,
      energy,
      stillUnder: 0.0015,
      cuts: cuts.map((c) => c / fps),
      swaps: [],
      changes,
      path,
      runs,
      tracks: [
        {
          name: "hero",
          source: "curves",
          samples: [
            { t: 1, x: 100, y: 50 },
            { t: 1.5, x: 300, y: 50 },
          ],
        },
      ],
      width: W,
      height: H,
      onsets: [2.01],
    },
  );
  assert.equal(segs[0]!.moving, 0);
  assert.ok(
    segs[0]!.camera && Math.abs(segs[0]!.camera.x) < 0.003,
    "the still segment does not move",
  );
  assert.ok(segs[1]!.moving > 0.5, `moving ${segs[1]!.moving}`);
  assert.ok(segs[1]!.camera!.x > 0.08, `pan ${segs[1]!.camera!.x}`);
  assert.deepEqual(
    segs[1]!.runs.map((r) => [r.what, r.dir]),
    [["pan x", "right"]],
  );
  assert.equal(segs[1]!.handoffSeen!.kind, "hard cut");
  assert.equal(segs[1]!.handoffSeen!.at, 2);
  assert.equal(segs[1]!.handoffSeen!.across, "nothing carried");
  assert.equal(segs[1]!.handoffSeen!.nearestOnset, 0.01);
  assert.deepEqual(segs[1]!.subjectSeen, {
    how: "estimated",
    source: "curves",
    out: [{ start: 1.5, end: 2, how: "out", edge: "right" }],
  });
  assert.equal(segs[2]!.handoffSeen!.kind, "film ends");
  assert.deepEqual(segs[2]!.subjectSeen, { how: "not measured", source: null, out: [] });
  // the same sheet with the page's subject found by its selector
  const page = readSegments([{ from: 0, to: 1, subject: "#card" }], {
    duration: 3,
    fps,
    t0: 0,
    energy,
    stillUnder: 0.0015,
    cuts: [],
    swaps: [],
    changes: [],
    path,
    runs: [],
    tracks: [],
    width: W,
    height: H,
    pageSubjects: () => [
      { t: 0, box: [10, 10, 20, 20] },
      { t: 0.5, box: [180, 10, 40, 20] },
      { t: 0.75, box: null },
    ],
    onsets: null,
  });
  assert.deepEqual(page[0]!.subjectSeen, {
    how: "measured",
    source: "page",
    out: [
      { start: 0.5, end: 0.75, how: "partly out", edge: "right" },
      { start: 0.75, end: 1, how: "not visible" },
    ],
  });
  // a segment between two page samples is not read off the page; a name no
  // element matches (null) is looked for among the declared tracks
  const between = readSegments(
    [
      { from: 0.1, to: 0.4, subject: "#card" },
      { from: 1, to: 2, subject: "hero" },
    ],
    {
      duration: 3,
      fps,
      t0: 0,
      energy,
      stillUnder: 0.0015,
      cuts: [],
      swaps: [],
      changes: [],
      path,
      runs: [],
      tracks: [{ name: "hero", source: "curves", samples: [{ t: 1, x: 300, y: 50 }] }],
      width: W,
      height: H,
      pageSubjects: (sel) => (sel === "#card" ? [{ t: 0, box: [10, 10, 20, 20] }] : null),
      onsets: null,
    },
  );
  assert.deepEqual(between[0]!.subjectSeen, { how: "not measured", source: null, out: [] });
  assert.equal(between[1]!.subjectSeen!.source, "curves");
  assert.equal(between[1]!.subjectSeen!.out[0]!.edge, "right");
});

test("text at film scale: the page's text apart from text in pictures, sizes, what the film's text sits over", () => {
  const grid = Array.from({ length: 54 }, (_, y) =>
    Array.from({ length: 96 }, (_, x) => (x >= 48 && y >= 27 ? "1" : "0")).join(""),
  );
  const page: PageTextSample[] = [0, 0.5].map((t) => ({
    t,
    own: [{ text: 'div "Caption"', chars: 7, px: 48, boxes: [[100, 100, 300, 60]] }],
    product: { chars: 300, pieces: 20 },
    sizes: [
      [14, 300],
      [48, 7],
    ],
    ownShare: 0.01,
    productShare: 0.2,
    grid,
    media: [{ label: "img", box: [50, 50, 600, 400] }],
    subjects: { "#hero": [120, 110, 50, 30] },
  }));
  const ocr: FrameText[] = [0, 0.5].map((t) => ({
    t,
    how: "ocr",
    share: 0,
    lines: [
      // the caption itself, read off the frame
      { box: [102, 104, 290, 52], chars: 7, conf: 1, text: "Caption" },
      // the product's live text
      { box: [1000, 600, 200, 14], chars: 20, conf: 1, text: "product" },
      // text inside a screenshot, under the caption
      { box: [110, 120, 200, 10], chars: 30, conf: 0.9, text: "in a picture" },
      // noise the recognizer is not sure of
      { box: [10, 10, 5, 3], chars: 1, conf: 0.1, text: "x" },
    ],
  }));
  const { samples, overlaps } = textTimeline(page, ocr, {
    width: 1920,
    height: 1080,
    segments: [{ from: 0, to: 1, subject: "#hero" }],
    every: 0.5,
  });
  const s = samples[0]!;
  assert.equal(s.pictureChars, 30);
  assert.equal(s.chars, 7 + 300 + 30);
  assert.equal(s.picture, Math.round(((200 * 10) / (1920 * 1080)) * 1000) / 1000);
  assert.equal(s.smallest!.px, 10);
  assert.equal(s.smallest!.from, "picture");
  assert.equal(s.median, 14, "by character: the product's small text");
  assert.deepEqual(
    overlaps.map((o) => [o.over, o.from, o.to]),
    [
      ["text inside a picture", 0, 1],
      ["the subject #hero", 0, 1],
      ["a picture: img", 0, 1],
    ],
  );
  // two pieces of the film's own text side by side, read back as one line
  const pair = textTimeline(
    [
      {
        ...page[0]!,
        own: [
          { text: 'div "One"', chars: 3, px: 100, boxes: [[200, 300, 300, 120]] },
          { text: 'div "Two"', chars: 3, px: 100, boxes: [[600, 300, 300, 120]] },
        ],
        media: [],
        subjects: {},
      },
    ],
    [
      {
        t: 0,
        how: "ocr",
        share: 0,
        lines: [{ box: [210, 290, 680, 130], chars: 6, conf: 1, text: "One Two" }],
      },
    ],
    { width: 1920, height: 1080, segments: [], every: 0.5 },
  );
  assert.equal(pair.samples[0]!.pictureChars, 0);
  assert.deepEqual(pair.overlaps, []);
  // without the page: every line read counts, as text in pictures
  const alone = textTimeline(null, ocr, { width: 1920, height: 1080, segments: [], every: 0.5 });
  assert.equal(alone.samples[0]!.pictureChars, 57);
  assert.equal(alone.samples[0]!.own, null);
  const per = textPerSecond(samples, 1.2);
  assert.equal(per.length, 2);
  assert.equal(per[0]!.chars, 337);
  assert.equal(per[1]!.chars, null);
});

test("the edge count finds text-like cells in lines of glyphs, not in flat ground or soft gradients", () => {
  const w = 160;
  const h = 64;
  const flat = new Uint8Array(w * h).fill(240);
  assert.equal(edgeShare(flat, w, h), 0);
  const grad = Uint8Array.from({ length: w * h }, (_, i) => (i % w) * 1.5);
  assert.equal(edgeShare(grad, w, h), 0);
  const glyphs = Uint8Array.from(flat);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) if (y % 16 < 10 && (x * 7 + y * 3) % 11 < 4) glyphs[y * w + x] = 20;
  assert.ok(edgeShare(glyphs, w, h) >= 0.4, `${edgeShare(glyphs, w, h)}`);
});

// --- the whole command on a film -------------------------------------------------------

let dir = "";
let film = "";
const CUTS = [1.5, 3]; // s

before(async () => {
  dir = await mkdtemp(join(tmpdir(), "open-take-probe-test-"));
  film = join(dir, "film.mp4");
  const fps = 30;
  const n = fps * 4;
  const a = texture(W, H, 21);
  const b = card(40, 30, 22, 200);
  const c = texture(W, H, 23);
  const raw = Buffer.alloc(n * W * H);
  for (let i = 0; i < n; i++) {
    const t = i / fps;
    raw.set(t < CUTS[0]! ? a : t < CUTS[1]! ? b : c, i * W * H);
  }
  // a knock on each cut and one between them, on silence
  const R = 44_100;
  const pcm = new Int16Array(R * 4);
  for (const t of [...CUTS, 2.25]) {
    const s0 = Math.round(t * R);
    for (let k = 0; k < R * 0.15; k++)
      pcm[s0 + k] = Math.round(
        20000 *
          Math.min(1, k / (R * 0.001)) *
          Math.exp(-k / (R * 0.04)) *
          Math.sin((2 * Math.PI * 330 * k) / R),
      );
  }
  const wav = join(dir, "knocks.wav");
  const hdr = Buffer.alloc(44);
  hdr.write("RIFF", 0);
  hdr.writeUInt32LE(36 + pcm.byteLength, 4);
  hdr.write("WAVEfmt ", 8);
  hdr.writeUInt32LE(16, 16);
  hdr.writeUInt16LE(1, 20);
  hdr.writeUInt16LE(1, 22);
  hdr.writeUInt32LE(R, 24);
  hdr.writeUInt32LE(R * 2, 28);
  hdr.writeUInt16LE(2, 32);
  hdr.writeUInt16LE(16, 34);
  hdr.write("data", 36);
  hdr.writeUInt32LE(pcm.byteLength, 40);
  await writeFile(wav, Buffer.concat([hdr, Buffer.from(pcm.buffer)]));
  const ffmpeg = await resolveFfmpeg();
  await new Promise<void>((ok, fail) => {
    const p = spawn(
      ffmpeg,
      [
        "-v",
        "error",
        "-f",
        "rawvideo",
        "-pix_fmt",
        "gray",
        "-s",
        `${W}x${H}`,
        "-r",
        String(fps),
        "-i",
        "-",
        "-i",
        wav,
        "-vf",
        "scale=384:216,format=yuv420p",
        "-c:v",
        "libx264",
        "-crf",
        "10",
        "-c:a",
        "aac",
        "-shortest",
        "-y",
        film,
      ],
      { stdio: ["pipe", "ignore", "pipe"] },
    );
    let err = "";
    p.stderr.on("data", (d: Buffer) => {
      err += d.toString();
    });
    p.on("error", fail);
    p.on("close", (code) => (code === 0 ? ok() : fail(new Error(err))));
    p.stdin.end(raw);
  });
  // what `film render` would write beside it, with a declared subject
  await writeFile(
    join(dir, "film.events.json"),
    JSON.stringify({
      version: 1,
      duration: 4,
      fps,
      events: [
        { t: 1, kind: "mark", label: "hold" },
        { t: 0.5, kind: "subject", label: "logo", x: 190, y: 108 },
        { t: 2.5, kind: "subject", label: "logo", x: 500, y: 108 },
      ],
      cuts: [1.5],
      declaredCuts: [1.5],
      detectedCuts: [],
      curves: { names: [], t0: 0, dt: 1 / 30, rows: [] },
      segments: [{ from: 0, to: 1.5, hold: true, handoff: "cut", subject: "logo" }],
    }),
  );
  await runTool(ffmpeg, ["-version"]);
});

after(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});

test("film probe on a film: cuts, shots, onsets, declared cuts, subjects, marks, files", async () => {
  const chrome = findChrome();
  const out = join(dir, "probe");
  const r = await filmProbe({ input: film, out, chromePath: chrome ?? undefined });
  const p = r.probe;
  assert.deepEqual(
    p.cuts.list.map((c) => c.t),
    CUTS,
  );
  assert.deepEqual(p.shots.lengths, [1.5, 1.5, 1]);
  assert.equal(p.cuts.how, "measured");
  // the knocks sit on the cuts
  assert.equal(p.sound.how, "measured");
  assert.equal(p.sound.within40, 1);
  assert.ok(p.sound.chance40 < 0.2, `chance ${p.sound.chance40}`);
  for (const c of p.cuts.list) assert.ok(Math.abs(c.nearestOnset!) <= 0.02, JSON.stringify(c));
  // the film's stills: three, one per shot
  assert.equal(p.stills.list.length, 3);
  // the events file: one cut declared, one not
  assert.deepEqual(p.declaredCuts.unseen, []);
  assert.deepEqual(p.declaredCuts.undeclared, [3]);
  assert.equal(p.subjects.how, "estimated");
  assert.deepEqual(
    p.subjects.exits.map((e) => [e.name, e.start, e.how, e.edge]),
    [["logo", 2.5, "out", "right"]],
  );
  assert.deepEqual(p.marks.list, [{ t: 1, label: "hold", still: true, nearestCut: 0.5 }]);
  // the beat sheet as the events file has it, beside the picture
  assert.equal(p.segments.source, "events file");
  const seg = p.segments.list[0]!;
  assert.equal(seg.moving, 0);
  assert.equal(seg.handoffSeen!.kind, "hard cut");
  assert.equal(seg.handoffSeen!.at, 1.5);
  assert.deepEqual(seg.subjectSeen, { how: "not detected", source: "events", out: [] });
  // every change has its thumbnails
  for (const c of p.changes.list) {
    assert.ok(c.thumbs, "thumbnails");
    assert.ok(existsSync(join(out, c.thumbs.before)) && existsSync(join(out, c.thumbs.after)));
  }
  const md = await readFile(r.md, "utf8");
  assert.match(md, /\[measured\] 2 hard cuts/);
  assert.match(md, /\[estimated\]/);
  assert.doesNotMatch(md, /\bscore\b|\bpass\b|\bgrade:/i);
  const json = JSON.parse(await readFile(r.json, "utf8"));
  assert.equal(json.energyPerFrame.length, 120);
  if (chrome) assert.ok(r.png && existsSync(r.png), "probe.png");
});

test("film probe with the film's page: its beat sheet, its text measured where it is drawn", {
  skip: findChrome() ? false : "no Chrome for Testing",
}, async () => {
  const chrome = findChrome()!;
  const page = join(dir, "page");
  await mkdir(join(page, "kit"), { recursive: true });
  await copyFile(join(import.meta.dirname, "..", "kit", "time.js"), join(page, "kit", "time.js"));
  await writeFile(
    join(page, "index.html"),
    `<!doctype html><html><head><style>body{margin:0;width:320px;height:180px;overflow:hidden;background:#fff;font:24px sans-serif}
canvas{position:absolute;left:20px;top:20px;width:200px;height:120px}
#cap{position:absolute;left:40px;top:60px;color:#000;background:#ffd}
#big{position:absolute;left:10px;top:150px;font-size:12px;line-height:12px;transform:scale(1.5);transform-origin:0 0}
#clip{position:absolute;left:250px;top:0;width:40px;height:20px;overflow:hidden;font-size:12px;white-space:nowrap}
#tight{position:absolute;left:200px;top:150px;width:120px;height:14px;overflow:hidden;font-size:14px;line-height:14px}</style></head><body>
<canvas id="pic" width="200" height="120"></canvas><div id="cap">Hello film</div><div id="big">Big</div>
<div id="clip">0123456789012345678901234567890123456789</div><div id="tight">abcdefghij</div>
<script type="module">
import { timeline } from "./kit/time.js";
const tl = timeline({ at: { move: 0.5, end: 1 } });
tl.segment(0, "move", { label: "still", hold: true, subject: "#cap" });
tl.segment("move", "end", { label: "slides", hold: true, subject: "#cap" });
tl.segment(0, "end", { subject: "the logo" });
const g = document.getElementById("pic").getContext("2d");
for (let i = 0; i < 40; i++) { g.fillStyle = i % 2 ? "#345" : "#9ab"; g.fillRect((i * 37) % 200, (i * 23) % 120, 30, 20); }
window.__film = { duration: 1, width: 320, height: 180, fps: 10, ...tl.hooks() };
window.__render = (t) => {
  document.getElementById("cap").style.transform = \`translateX(\${Math.max(0, t - 0.5) * 800}px)\`;
};
</script></body></html>`,
  );
  const film2 = join(dir, "paged.mp4");
  await renderFilm({ page, out: film2, chromePath: chrome, blur: false, audio: null, workers: 1 });
  const r = await filmProbe({
    input: film2,
    page,
    chromePath: chrome,
    textEvery: 0.1,
    out: join(dir, "paged.probe"),
  });
  const p = r.probe;
  assert.equal(p.segments.source, "page");
  assert.deepEqual(
    p.segments.list.map((s) => [s.label, s.hold]),
    [
      ["still", true],
      [undefined, undefined],
      ["slides", true],
    ],
  );
  // free words no element matches: not looked up as a selector that failed
  assert.deepEqual(p.segments.list[1]!.subjectSeen, { how: "not measured", source: null, out: [] });
  assert.equal(p.segments.list[0]!.moving, 0);
  assert.ok(p.segments.list[2]!.moving > 0.5, `moving ${p.segments.list[2]!.moving}`);
  // the caption is pushed out past the right edge as it slides
  assert.equal(p.segments.list[0]!.subjectSeen!.out.length, 0);
  assert.deepEqual(
    p.segments.list[2]!.subjectSeen!.out.map((o) => [o.how, o.edge]),
    [
      ["partly out", "right"],
      ["out", "right"],
    ],
  );
  assert.equal(p.text.page.how, "measured");
  const s0 = p.text.samples[0]!;
  assert.equal(s0.ownChars, s0.chars! - (s0.pictureChars ?? 0) - (s0.productChars ?? 0));
  // each piece of the page's own text, as read at 0 s
  const read = await readPageText({
    page,
    chromePath: chrome,
    from: 0,
    times: [0],
    fallback: { width: 320, height: 180 },
  });
  const own = (id: string) => read.samples[0]!.own.find((o) => o.text.startsWith(`div#${id}`))!;
  assert.equal(own("cap").chars, 9);
  assert.equal(own("cap").px, 24);
  assert.equal(own("big").px, 18, "drawn at 12 px × 1.5");
  // 40 digits of which the 40-px box shows a few, by width
  assert.ok(own("clip").chars >= 4 && own("clip").chars <= 8, `clip ${own("clip").chars}`);
  // a line box whose empty leading its box cuts off still shows every character
  assert.equal(own("tight").chars, 10);
  assert.ok(s0.own! > 0.01, `own share ${s0.own}`);
  assert.ok(
    p.text.overlaps.some((o) => o.over === "a picture: canvas#pic" && o.from === 0),
    JSON.stringify(p.text.overlaps),
  );
  const md = await readFile(r.md, "utf8");
  assert.match(md, /## Beat sheet\n\[measured\] 3 segment\(s\) from the page/);
  assert.match(md, /written to hold — \[measured\] the picture still changes/);
  assert.match(md, /## Text at film scale\n\[measured\]/);
  assert.doesNotMatch(md, /\bscore\b|\bpass\b|\bgrade:|too small|too much/i);
  // a film of part of the page: the sheet and the subject on the film's clock
  const part = join(dir, "paged-part.mp4");
  await renderFilm({
    page,
    out: part,
    from: 0.5,
    chromePath: chrome,
    blur: false,
    audio: null,
    workers: 1,
  });
  const q = (
    await filmProbe({
      input: part,
      page,
      chromePath: chrome,
      text: false,
      textEvery: 0.1,
      out: join(dir, "part.probe"),
    })
  ).probe;
  assert.deepEqual(
    q.segments.list.map((x) => [x.label, x.from, x.to]),
    [
      [undefined, -0.5, 0.5],
      ["slides", 0, 0.5],
    ],
  );
  assert.equal(q.segments.list[1]!.subjectSeen!.out[0]!.how, "partly out");
});
