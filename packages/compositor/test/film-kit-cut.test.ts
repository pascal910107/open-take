// The film kit's cutting blocks (kit/cut.js) and the bar edit (kit/audio.mjs
// cutToBars, landOn): a grid from a pulse or a beats file, a match cut that
// puts the subject back where it left — checked through camera.js itself —
// cuts declared on the timeline, the pacing helper, and a track cut by bars
// whose downbeats land where they were asked to.

import assert from "node:assert/strict";
import { test } from "node:test";
import { buffer, cutToBars, diagnose, landOn, onsetOf, slice } from "../kit/audio.mjs";
import { camera } from "../kit/camera.js";
import { cuts, density, grid, matchCut, PACE } from "../kit/cut.js";
import { timeline } from "../kit/time.js";

const near = (a: number, b: number, tol: number, what: string) =>
  assert.ok(Math.abs(a - b) <= tol, `${what}: ${a} vs ${b} (±${tol})`);

test("a grid from a pulse: beats, bars, snapping, what lies between", () => {
  const g = grid({ bpm: 120, offset: 0.1 });
  assert.equal(g.period, 0.5);
  near(g.beat(0), 0.1, 1e-12, "beat 0");
  near(g.beat(8), 4.1, 1e-12, "beat 8");
  near(g.beat(2.5), 1.35, 1e-12, "the and of beat 2");
  near(g.beat(-2), -0.9, 1e-12, "before beat 0 the grid carries on");
  near(g.bar(3), 6.1, 1e-12, "bar 3");
  near(g.beatOf(1.35), 2.5, 1e-12, "beatOf");
  near(g.barOf(7.1), 3.5, 1e-12, "barOf");
  near(g.snap(3.3), 3.1, 1e-12, "nearest beat");
  near(g.snap(3.3, { to: "half" }), 3.35, 1e-12, "nearest eighth");
  near(g.snap(3.3, { to: "bar" }), 4.1, 1e-12, "nearest bar line");
  near(g.snap(3.3, { within: 0.1 }), 3.3, 1e-12, "no beat that near: left alone");
  assert.equal(g.nearest(3.3, "onset"), null, "a pulse has no onsets");
  assert.equal(g.snap(3.3, { to: "onset" }), 3.3);
  assert.deepEqual(g.between(1, 3), [1.1, 1.6, 2.1, 2.6]);
  assert.deepEqual(g.between(0, 8.2, { to: "bar" }), [0.1, 2.1, 4.1, 6.1, 8.1]);
  assert.equal(g.between(1, 2, { to: "quarter" }).length, 8);
  const w = grid({ bpm: 90, beatsPerBar: 3 });
  near(w.bar(2), 4, 1e-12, "three beats a bar");
  assert.throws(() => grid({ bpm: 0 }), /bpm/);
  assert.throws(() => grid({ bpm: 100, beatsPerBar: 2.5 }), /beatsPerBar/);
  assert.throws(() => g.snap(1, { to: "nope" as never }), /not something to snap to/);
});

test("a grid from a beats file: its own beats and bars, its onsets, sections and drops", () => {
  // a tempo that eases from 0.5 s a beat to 0.52, as a played track can
  const beats = [0.2, 0.7, 1.2, 1.7, 2.21, 2.72, 3.23, 3.74, 4.26, 4.78];
  const g = grid({
    version: 1,
    duration: 6,
    tempo: { bpm: 117, periodS: 0.51 },
    beats,
    downbeats: [0.2, 2.21, 4.26],
    meter: { beatsPerBar: 4 },
    sections: [
      { t: 0, end: 2.21, energy: 0.2 },
      { t: 2.21, end: 6, energy: 1, label: "drop" },
    ],
    drops: [2.21],
    onsets: [0.21, 0.69, 1.33, 2.2],
  });
  near(g.beat(4), 2.21, 1e-12, "a measured beat");
  near(g.beat(4.5), 2.465, 1e-12, "between two measured beats");
  near(g.beat(11), 4.78 + 2 * 0.51, 1e-9, "past the last, at the file's period");
  near(g.bar(1), 2.21, 1e-12, "a downbeat");
  near(g.bar(3), 4.26 + 4 * 0.51, 1e-9, "past the last downbeat, a bar of four on");
  near(g.snap(1.3, { to: "onset" }), 1.33, 1e-12, "nearest onset");
  near(g.snap(1.0, { to: "onset", within: 0.1 }), 1.0, 1e-12, "no onset that near");
  near(g.snap(3, { to: "drop" }), 2.21, 1e-12, "nearest drop");
  assert.deepEqual(g.between(0, 6, { to: "section" }), [0, 2.21]);
  assert.deepEqual(g.between(2, 4, { to: "beat" }), [2.21, 2.72, 3.23, 3.74]);
  assert.throws(
    () => grid({ version: 1, duration: 1, tempo: { bpm: null }, beats: [], downbeats: [] }),
    /no tempo/,
  );
});

test("a match cut puts the subject where and as big as it left — through camera.js", () => {
  const view = { width: 1920, height: 1080 };
  // the outgoing shot: a camera pushed onto a button in an app at 2× zoom
  const a = camera({ content: { width: 1920, height: 1080 } });
  a.frame({ cx: 700, cy: 400, w: 960 }, { arrive: 1 });
  const button = { x: 640, y: 380, width: 120, height: 40 };
  const corners = (cam: ReturnType<typeof camera>, b: typeof button, t: number) => {
    const [x0, y0] = cam.toView(b.x, b.y, t) as [number, number];
    const [x1, y1] = cam.toView(b.x + b.width, b.y + b.height, t) as [number, number];
    return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
  };
  const left = corners(a, button, 2);
  // the incoming shot: another layer where the same button is a card at 3000,2000
  const card = { x: 3000, y: 2000, width: 240, height: 80 };
  const v = matchCut(left, card, view);
  const b = camera({ content: { width: 4000, height: 3000 }, view });
  b.cut(v, 2, { keepInside: false });
  const landed = corners(b, card, 2);
  near(landed.x, left.x, 1e-6, "x");
  near(landed.y, left.y, 1e-6, "y");
  near(landed.width, left.width, 1e-6, "width");
  near(landed.height, left.height, 1e-6, "height");
  // boxes of another shape: centres meet, the size by the fit asked for
  const tall = { x: 0, y: 0, w: 100, h: 400 };
  const from = { x: 860, y: 440, width: 200, height: 200 };
  const s = (fit: "area" | "width" | "height" | "contain" | "cover") =>
    view.width / matchCut(from, tall, view, { fit }).w;
  near(s("width"), 2, 1e-12, "width");
  near(s("height"), 0.5, 1e-12, "height");
  near(s("contain"), 0.5, 1e-12, "contain");
  near(s("cover"), 2, 1e-12, "cover");
  near(s("area"), 1, 1e-12, "area");
  const c = matchCut(from, tall, view, { fit: "contain" });
  near(c.cx, 50, 1e-9, "centre x");
  near(c.cy, 200, 1e-9, "centre y");
  assert.throws(() => matchCut(from, { x: 0, y: 0, width: 0, height: 1 }, view), /size above 0/);
});

test("cuts are declared on the timeline as events `film render` keeps, snapped when asked", () => {
  const tl = timeline({ at: { end: 10 } });
  const g = grid({ bpm: 120 });
  const out = cuts(tl, [2.4, { t: 1.1, label: "result" }], { grid: g, to: "beat" });
  assert.deepEqual(out, [1, 2.5]);
  const ev = tl.events().filter((e) => e.kind === "cut");
  assert.deepEqual(
    ev.map((e) => [e.t, e.label]),
    [
      [1, "result"],
      [2.5, undefined],
    ],
  );
  assert.deepEqual(cuts(timeline(), [3.3]), [3.3], "no grid: as given");
  assert.throws(() => cuts({} as never, [1]), /timeline/);
  assert.throws(() => cuts(timeline(), [Number.NaN]), /not at a time/);
});

test("density: words, numbers or a ramp of beats between cuts, on the grid — only when called", () => {
  const g = grid({ bpm: 120 });
  assert.equal(PACE.burst, 1);
  assert.deepEqual(density(g, [{ from: 0, to: 4, intent: "hold" }]), [0]);
  assert.deepEqual(density(g, [{ from: 0, to: 4, intent: "hold", start: false }]), []);
  assert.deepEqual(density(g, [{ from: 0, to: 2, intent: "burst" }]), [0, 0.5, 1, 1.5]);
  assert.deepEqual(density(g, [{ from: 0, to: 8, intent: "steady" }]), [0, 2, 4, 6]);
  assert.deepEqual(density(g, [{ from: 0, to: 1, intent: "flurry" }]), [0, 0.25, 0.5, 0.75]);
  assert.deepEqual(density(g, [{ from: 0, to: 6, intent: 3 }]), [0, 1.5, 3, 4.5]);
  // sections in a row: each its own pace
  assert.deepEqual(
    density(g, [
      { from: 0, to: 4, intent: "steady" },
      { from: 4, to: 6, intent: "burst" },
    ]),
    [0, 2, 4, 4.5, 5, 5.5],
  );
  // a build: the gaps shrink, every cut on a sixteenth of the grid
  const ramp = density(g, [{ from: 0, to: 8, intent: { every: [4, 0.5] } }]);
  const gaps = ramp.slice(1).map((t, i) => t - ramp[i]!);
  assert.ok(gaps.length >= 5, `${ramp}`);
  assert.ok(gaps[0]! > gaps[gaps.length - 1]! * 2, `faster and faster: ${gaps}`);
  for (const t of ramp) near((t * 8) % 1, 0, 1e-9, `${t} on a sixteenth`);
  // on the music's onsets, when one is within a quarter beat
  const og = grid({ bpm: 120, onsets: [0.53, 1.1, 1.3] });
  assert.deepEqual(
    density(og, [{ from: 0, to: 2, intent: "burst", on: "onset" }]),
    [0, 0.53, 1.1, 1.5],
  );
  assert.throws(() => density(g, [{ from: 0, to: 2, intent: "wild" as never }]), /not one of/);
  assert.throws(() => density(g, [{ from: 2, to: 1, intent: "burst" }]), /later one/);
});

// --- cutting a track by bars ---------------------------------------------------------------

const SR = 48000;
const BAR = 2; // s
/** 12 bars of a track: each bar a click at its downbeat pitched by its number
 *  (bar n at 200 + 50n Hz), a quiet hum between */
function track() {
  const t = buffer(12 * BAR + 0.5, { channels: 1 });
  const x = t[0]!;
  for (let n = 0; n < 12; n++) {
    const a = Math.round((0.1 + n * BAR) * SR);
    for (let i = 0; i < SR * 0.08; i++)
      x[a + i] =
        (x[a + i] ?? 0) +
        0.8 * Math.exp(-i / (SR * 0.01)) * Math.sin((2 * Math.PI * (200 + 50 * n) * i) / SR);
  }
  for (let i = 0; i < x.length; i++)
    x[i] = (x[i] ?? 0) + 0.02 * Math.sin((2 * Math.PI * 110 * i) / SR);
  const downbeats = Array.from({ length: 12 }, (_, n) => 0.1 + n * BAR);
  const beats = downbeats.flatMap((d) => [0, 0.5, 1, 1.5].map((k) => d + k));
  return {
    sound: t,
    beats: {
      version: 1 as const,
      source: "track",
      duration: 24.5,
      tempo: { bpm: 120, periodS: 0.5 },
      beats,
      downbeats,
      bars: downbeats.map((t, index) => ({ t, index })),
      sections: [{ t: 0, end: 24.5, energy: 1 }],
      drops: [12.1],
      onsets: downbeats,
    },
  };
}

/** the pitch of the click starting at t in a sound (zero crossings over 25 ms, before it decays under the hum) */
function pitchAt(sound: Float32Array[], t: number) {
  const x = sound[0]!;
  const a = Math.round(t * SR);
  let z = 0;
  for (let i = a + 1; i < a + SR * 0.025; i++) if (x[i - 1]! < 0 !== x[i]! < 0) z++;
  return z / 2 / 0.025;
}

test("cutToBars: pieces joined on their bar lines, the incoming downbeat whole, the grid carried over", () => {
  const { sound, beats } = track();
  const e = cutToBars(sound, beats, [
    { from: 1, to: 3 },
    { from: 7, to: 8, times: 2 },
    { from: 10, to: "end" },
  ]);
  // bars 1–2, bar 7 twice, bars 10–11 to the track's end
  near(e.sound[0]!.length / SR, 2 * BAR + 2 * BAR + (24.5 - 20.1), 1e-3, "length");
  assert.deepEqual(e.joins, [4, 6, 8]);
  assert.deepEqual(
    e.map.map((m) => [m.at, m.from, m.to]),
    [
      [0, 1, 3],
      [4, 7, 8],
      [6, 7, 8],
      [8, 10, "end"],
    ],
  );
  // each join's first sound is the incoming bar's click, starting on the join
  for (const [t, bar] of [
    [0, 1],
    [2, 2],
    [4, 7],
    [6, 7],
    [8, 10],
  ] as const) {
    near(pitchAt(e.sound, t), 200 + 50 * bar, 30, `bar ${bar} at ${t}s`);
    const on = onsetOf(slice(e.sound, Math.max(0, t - 0.05), t + 0.05), { threshold: 0.3 });
    near((on ?? 0) + Math.max(0, t - 0.05), t, 0.002, `its attack at ${t}s`);
  }
  // the edit's own grid, for cut.js
  assert.deepEqual(e.beats.downbeats, [0, 2, 4, 6, 8, 10]);
  assert.deepEqual(
    e.beats.bars.map((b) => b.index),
    [0, 1, 2, 3, 4, 5],
  );
  assert.equal(e.beats.beats.length, 24);
  assert.deepEqual(e.beats.drops, [], "bar 6's drop is not in the edit");
  const g = grid(e.beats);
  near(g.bar(2), 4, 1e-9, "cut.js reads the edit's grid");
  // at: the edit placed later in the film
  const later = cutToBars(sound, beats, [{ from: 1, to: 2 }], { at: 3 });
  assert.deepEqual(later.beats.downbeats, [3]);
  assert.throws(
    () => cutToBars(sound, { ...beats, downbeats: [] }, [{ from: 0, to: 1 }]),
    /no bars/,
  );
  assert.throws(() => cutToBars(sound, beats, [{ from: 0, to: 1, times: 0 }]), /times/);
});

test("a join is a crossfade: a steady tone cut out of phase does not click; with no fade it does", () => {
  const { beats } = track();
  const tone = buffer(24.5, { channels: 1 });
  for (let i = 0; i < tone[0]!.length; i++)
    tone[0]![i] = 0.5 * Math.sin((2 * Math.PI * 97 * i) / SR);
  const plan = [
    { from: 1, to: 2 },
    { from: 5.37, to: 7 },
  ];
  const clicks = (xfade: number) =>
    diagnose("edit", cutToBars(tone, beats, plan, { xfade }).sound).filter((f) =>
      /click/i.test(f.kind),
    );
  assert.deepEqual(clicks(0.03), []);
  assert.ok(clicks(0).length > 0, "the test can hear a click");
});

test("landOn: the bars before a chosen one, so its downbeat sounds at a film time", () => {
  const { sound, beats } = track();
  const plan = landOn(beats, { bar: 6, at: 5 });
  assert.equal(plan.length, 1);
  near(plan[0]!.from, 3.5, 1e-9, "two and a half bars before");
  const e = cutToBars(sound, beats, [...plan, { from: 6, to: 8 }]);
  assert.deepEqual(e.joins, [], "bar 6 follows on from what lands on it: no join");
  near(pitchAt(e.sound, 5), 200 + 50 * 6, 30, "bar 6's click at 5 s");
  // started later in the film, fewer bars lead in
  near(landOn(beats, { bar: 6, at: 5, start: 3 })[0]!.from, 5, 1e-9, "one bar before");
  assert.throws(() => landOn(beats, { bar: 1, at: 10 }), /cannot sound/);
});

test("bar lines off the millisecond: every sample where it belongs, every downbeat kept on its join", () => {
  // each sample holds its own index in the source, so the edit says where it came from
  const sr = 48_000;
  const src = new Float32Array(sr * 30).map((_, i) => i);
  const sound = Object.assign([src], { sampleRate: sr });
  // bars that fall between milliseconds, and are not all one length
  const downbeats = [0.0123];
  for (let i = 1; i < 14; i++) downbeats.push(downbeats[i - 1]! + 1.9672 + 0.02 * Math.sin(i));
  const beats = {
    version: 1 as const,
    duration: 30,
    tempo: { bpm: 122 },
    beats: downbeats,
    downbeats,
  };
  const at = (bar: number) => Math.round(downbeats[bar]! * sr);
  const e = cutToBars(
    sound,
    beats,
    [
      { from: 2, to: 4 },
      { from: 8, to: 9, times: 2 },
    ],
    {
      fadeIn: 0,
      fadeOut: 0,
    },
  );
  const out = e.sound[0]!;
  assert.equal(out.length, at(4) - at(2) + 2 * (at(9) - at(8)));
  for (const [pos, bar] of [
    [0, 2],
    [at(4) - at(2), 8],
    [at(4) - at(2) + at(9) - at(8), 8],
  ] as const)
    assert.equal(out[pos], at(bar), `bar ${bar}'s downbeat sample on its join`);
  assert.equal(e.beats.downbeats.length, 4, `${e.beats.downbeats}`);
  near(e.beats.downbeats[2]!, (at(4) - at(2)) / sr, 0.001, "the downbeat on the first join");
  // landOn walks the bars as they fall
  const l = cutToBars(sound, beats, [
    ...landOn(beats, { bar: 10, at: 13.3 }),
    { from: 10, to: 11 },
  ]);
  assert.equal(l.sound[0]![Math.round(13.3 * sr)], at(10));
});
