// What the measuring code calls a cut, a jump or a still, against what it
// cannot tell from it: a shutter split where only a word changed is not a cut
// of the picture; a word rewritten in place whose neighbours reflow is not
// content that moved; a slow push is not a still. Each with the true case
// beside it. No browser.

import assert from "node:assert/strict";
import { test } from "node:test";
import { type FilmCheck, judgeFilm, motionFindings } from "../src/film/check";
import { findCuts, findStills, frameEnergy, type GreyFrames, jumpMove } from "../src/film/probe";
import { confirmCuts, filmEvents, patchEvents } from "../src/film/render";

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

/** a flat frame with textured pieces: [x, y, w, h, seed] */
function frame(...pieces: [number, number, number, number, number][]): Uint8Array {
  const f = new Uint8Array(W * H).fill(235);
  for (const [x, y, w, h, seed] of pieces) {
    const t = texture(w, h, seed);
    for (let r = 0; r < h; r++)
      for (let c = 0; c < w; c++)
        if (y + r < H && x + c < W) f[(y + r) * W + x + c] = t[r * w + c]!;
  }
  return f;
}

const grey = (list: Uint8Array[], fps = 30): GreyFrames => {
  const data = new Uint8Array(list.length * W * H);
  for (const [i, f] of list.entries()) data.set(f, i * W * H);
  return { w: W, h: H, fps, count: list.length, data };
};

// --- (a) the events file: a split is a cut where the picture jumps as one ---------------

test("a shutter split is a cut where the picture jumps as a cut does, else a switch", () => {
  const film = { fps: 10, f0: 0, f1: 10, total: 10 };
  // splits at frames 2 (a cut), 5 (a word swapped) and 8 (inside a fast push)
  const ev = filmEvents(film, [{ t: 0.9, kind: "cut" }], [0, 0, 1, 0, 0, 1, 0, 0, 1, 0], [], true);
  assert.deepEqual(ev.detectedCuts, [0.2, 0.5, 0.8]);
  const c = confirmCuts(ev, [0.2]);
  assert.deepEqual(c.detectedCuts, [0.2]);
  assert.deepEqual(c.switches, [0.5, 0.8]);
  assert.deepEqual(c.cuts, [0.2, 0.9], "the declared cut stays a cut");
  // within 1.5 frames of the picture's cut is the same cut
  assert.deepEqual(confirmCuts(ev, [0.31]).detectedCuts, [0.2]);
  assert.deepEqual(confirmCuts(ev, [1]).detectedCuts, []);
  // a range's first frame has nothing before it in the file: kept as it was
  const part = filmEvents({ fps: 10, f0: 5, f1: 8, total: 10 }, [], [1, 0, 0], [], true);
  assert.deepEqual(confirmCuts(part, [], 0.5).detectedCuts, [0.5]);
  // a range put into a master: the switches merged like the cuts
  const master = confirmCuts(filmEvents(film, [], [0, 0, 0, 1, 0, 0, 0, 1, 0, 0], [], true), [0.3]);
  assert.deepEqual(master.switches, [0.7]);
  const range = confirmCuts(
    filmEvents({ fps: 10, f0: 6, f1: 9, total: 10 }, [], [0, 1, 0], [], true),
    [],
  );
  const p = patchEvents(master, range)!;
  assert.deepEqual(p.switches, [0.7], "the master's 0.7 is in the range; the range's own is 0.7");
  assert.deepEqual(p.detectedCuts, [0.3]);
});

test("the picture: a whole-frame change is a cut; a word swapped, or a fast push, is not", () => {
  const a = texture(W, H, 1);
  const b = texture(W, H, 2);
  // a cut
  const cut = grey([...Array(10).fill(a), ...Array(10).fill(b)]);
  assert.deepEqual(findCuts(cut, frameEnergy(cut)), [10]);
  // one word swapped where it stood: 2 % of the frame
  const word = grey([
    ...Array(10).fill(frame([60, 40, 24, 16, 3])),
    ...Array(10).fill(frame([60, 40, 24, 16, 4])),
  ]);
  assert.deepEqual(findCuts(word, frameEnergy(word)), []);
  // a fast push: the picture moves 12 px a frame, and halfway one part of it
  // switches — every frame changes as much, none stands out
  const wide = texture(W * 4, H, 7);
  const push: Uint8Array[] = [];
  for (let i = 0; i < 20; i++) {
    const f = new Uint8Array(W * H);
    for (let y = 0; y < H; y++)
      f.set(wide.subarray(y * W * 4 + i * 12, y * W * 4 + i * 12 + W), y * W);
    if (i >= 10) for (let y = 20; y < 40; y++) f.fill(20, y * W + 30, y * W + 60);
    push.push(f);
  }
  const pg = grey(push);
  assert.deepEqual(findCuts(pg, frameEnergy(pg)), []);
});

// --- (b) the report: a word rewritten in place is not content that moved ------------

test("a part that jumps whole is found moved; a word rewritten whose neighbours reflow mostly is not", () => {
  // a card that jumps 7 px right: what changed is found moved
  const card = jumpMove(grey([frame([40, 30, 56, 40, 3]), frame([47, 30, 56, 40, 3])]), 1);
  assert.ok(card.shift && card.textured > 0);
  assert.ok(card.moved / card.textured >= 0.5, JSON.stringify(card));
  // "還剩 14 個月" → "接手 · 14 個月": the first word rewritten wider, the rest
  // of the line pushed 10 px right
  const line = jumpMove(
    grey([
      frame([20, 40, 64, 16, 11], [84, 40, 32, 16, 5]),
      frame([20, 40, 74, 16, 12], [94, 40, 32, 16, 5]),
    ]),
    1,
  );
  assert.ok(line.shift, `the pushed part is found: ${JSON.stringify(line)}`);
  assert.ok(line.moved / line.textured < 0.5, JSON.stringify(line));
});

// the report's wording for these: test/film-report.test.ts

const BASE: FilmCheck = {
  file: "film.mp4",
  durationS: 2,
  video: null,
  audio: null,
  stalls: [],
  cadence: [],
  cuts: [],
  flashes: [],
  blanks: [],
  black: [],
  silences: [],
  clicks: [],
  marks: [],
  page: null,
  layout: null,
  unreadText: null,
  smallestText: null,
  issues: [],
};

// --- (c) a number counting is not a hitch -------------------------------------------------

test("one frame held inside motion is a hitch; a frame held every few frames is a lower rate", () => {
  const moving = Array.from({ length: 120 }, () => 2);
  const hitch = [...moving];
  hitch[60] = 0;
  const h = motionFindings(hitch, 60);
  assert.equal(h.stalls.length, 1);
  assert.deepEqual(h.cadence, []);
  // a number counting 40 a second at 60 fps: every third frame shows the same
  const count = moving.map((v, i) => (i % 3 === 2 ? 0 : v));
  const c = motionFindings(count, 60);
  assert.deepEqual(c.stalls, [], "not 40 hitches");
  assert.equal(c.cadence.length, 1);
  assert.equal(c.cadence[0]!.every, 3);
  assert.ok(c.cadence[0]!.frames >= 110, JSON.stringify(c.cadence));
  // two hitches a second apart are two hitches
  const two = [...moving];
  two[30] = 0;
  two[90] = 0;
  assert.equal(motionFindings(two, 60).stalls.length, 2);
  // the check says what it measured: a warning naming both readings
  const issues = judgeFilm({ ...BASE, ...c }, {});
  const said = issues.find((i) => /held about every 3 frames/.test(i.message));
  assert.ok(said, JSON.stringify(issues));
  assert.equal(said.severity, "warn");
  assert.match(said.message, /a move stepping, or a number or text updated that often/);
  assert.ok(!issues.some((i) => /hitch/.test(i.message)));
});

// --- (d) a slow push is not a still -------------------------------------------------------

test("a held picture is a still; a push too slow to change a frame over the line is not", () => {
  const a = texture(W, H, 5);
  const held = grey(Array(40).fill(a));
  const he = frameEnergy(held);
  assert.deepEqual(findStills(he, 30, 0.5, 0.0015, held), [{ a: 0, b: 40 }]);
  // a slow push: a soft texture drifting 0.06 px a frame — each frame differs
  // from the one before by under the still line — adds up to 1.8 px a second
  const wide = texture(W * 2, H, 9);
  const push: Uint8Array[] = [];
  for (let i = 0; i < 40; i++) {
    const x0 = i * 0.06;
    const f = new Uint8Array(W * H);
    const k = Math.floor(x0);
    const fr = x0 - k;
    for (let y = 0; y < H; y++)
      for (let x = 0; x < W; x++)
        f[y * W + x] = Math.round(
          128 +
            0.3 * (wide[y * W * 2 + x + k]! * (1 - fr) + wide[y * W * 2 + x + k + 1]! * fr - 128),
        );
    push.push(f);
  }
  const pg = grey(push);
  const pe = frameEnergy(pg);
  assert.ok(
    Array.from(pe)
      .slice(1)
      .every((v) => v < 0.0015),
    "every frame's change is under the still line",
  );
  assert.equal(findStills(pe, 30, 0.5).length, 1, "frame to frame alone, it reads as a still");
  assert.deepEqual(findStills(pe, 30, 0.5, 0.0015, pg), [], "against ¼ s back it moves");
});
