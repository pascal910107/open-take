// `film probe`: the picture analysis on frames built here with known answers,
// then the whole command on a film made here (ffmpeg; the picture only with
// Chrome).

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { resolveFfmpeg, runTool } from "../src/ffmpeg";
import {
  cutDensity,
  filmProbe,
  findChanges,
  findCuts,
  findStills,
  frameEnergy,
  type GreyFrames,
  globalMotion,
  subjectExits,
  subjectTracks,
} from "../src/film/probe";
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
