// The music layer's contracts: the tempo map puts every anchor on a downbeat
// within the allowed tempo range; loudness reads the calibration signal the
// standard defines; the master lands on target under its ceiling; the same
// sheet always performs to the same samples.

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  arrange,
  limit,
  master,
  measureLoudness,
  type Pcm,
  renderMusic,
  solveTempo,
  truePeakDb,
} from "../src/index";

const SR = 48000;

function sine(freq: number, peakDb: number, seconds: number, channels = 2): Pcm {
  const n = Math.round(seconds * SR);
  const a = 10 ** (peakDb / 20);
  const ch = new Float32Array(n);
  for (let i = 0; i < n; i++) ch[i] = a * Math.sin((2 * Math.PI * freq * i) / SR);
  return { sampleRate: SR, channels: Array.from({ length: channels }, () => ch.slice()) };
}

test("tempo: every anchor lands on a downbeat, inside the tempo range", () => {
  const anchors = [0, 6.5, 19.05, 30.15, 33.35, 47.65, 61.05];
  const map = solveTempo(anchors, { bpm: 120 });
  assert.equal(map.spans.length, anchors.length - 1);
  map.spans.forEach((s, i) => {
    const end = s.atS + (s.eighths * 30) / s.bpm;
    assert.ok(Math.abs(end - anchors[i + 1]!) < 0.002, `span ${i} ends on the next anchor`);
    assert.ok(s.bpm > 120 * 0.85 && s.bpm < 120 * 1.15, `span ${i} tempo ${s.bpm}`);
    assert.ok(Number.isInteger(s.eighths) && s.eighths >= 4);
  });
});

test("tempo: a span too short to hold a bar is merged, never a protected hit", () => {
  const map = solveTempo([0, 4, 4.4, 8], { bpm: 120 }, [4.4]);
  assert.deepEqual(map.dropped, [4]);
  assert.deepEqual(
    map.spans.map((s) => s.atS),
    [0, 4.4],
  );
});

test("tempo: an evenly spaced cut is played at its natural tempo", () => {
  const map = solveTempo([0, 8, 16, 24], { bpm: 120 });
  for (const s of map.spans) {
    assert.equal(s.bpm, 120);
    assert.equal(s.eighths, 32);
  }
});

test("loudness: a stereo 1 kHz sine at −23 dBFS reads −23 LUFS (EBU Tech 3341)", () => {
  const l = measureLoudness(sine(1000, -23, 20));
  assert.ok(Math.abs(l.integrated - -23) < 0.1, `integrated ${l.integrated}`);
  assert.ok(l.range < 0.1, `range ${l.range}`);
});

test("loudness: silence is gated out, not averaged in", () => {
  const tone = sine(1000, -23, 10);
  const n = tone.channels[0]!.length;
  const padded: Pcm = {
    sampleRate: SR,
    channels: tone.channels.map((c) => {
      const y = new Float32Array(n * 2);
      y.set(c, 0);
      return y;
    }),
  };
  assert.ok(Math.abs(measureLoudness(padded).integrated - -23) < 0.1);
});

test("true peak sees the over a sample peak misses", () => {
  // fs/4 sine sampled at ±45°: every sample is 0.707 of the real peak
  const n = SR;
  const ch = new Float32Array(n);
  for (let i = 0; i < n; i++) ch[i] = Math.sin((Math.PI / 2) * i + Math.PI / 4);
  const tp = truePeakDb({ sampleRate: SR, channels: [ch] });
  assert.ok(tp > -0.5, `true peak ${tp.toFixed(2)} dBTP should approach 0`);
});

test("limit never lets a sample past the ceiling", () => {
  const hot = sine(220, 6, 1);
  const out = limit(hot, -1);
  for (const ch of out.channels)
    for (const v of ch) assert.ok(Math.abs(v) <= 10 ** (-1 / 20) + 1e-6);
});

test("master lands on the loudness target under the true-peak ceiling", () => {
  const m = master(sine(440, -30, 12), { lufs: -15, truePeak: -1 });
  assert.ok(Math.abs(m.after.integrated - -15) < 0.2, `lufs ${m.after.integrated}`);
  assert.ok(m.after.truePeak <= -0.95, `tp ${m.after.truePeak}`);
});

test("arrange + render: deterministic, on the anchors, silent-free", () => {
  const input = {
    durationS: 20,
    anchors: [
      { atS: 0, energy: 0 as const },
      { atS: 4.1, energy: 2 as const, hit: "small" as const },
      { atS: 12.2, energy: 3 as const, hit: "big" as const },
      { atS: 16.3, energy: 2 as const, hit: "small" as const },
    ],
  };
  const sheet = arrange(input, { seed: 3 });
  assert.deepEqual(
    sheet.sections.map((s) => s.atS),
    [0, 4.1, 12.2],
  );
  assert.equal(sheet.outro?.atS, 16.3);
  // the span before the big hit carries its build and its breath
  const pre = sheet.sections[1]!;
  assert.ok(pre.build > 0 && pre.breath > 0);
  const a = renderMusic(sheet);
  const b = renderMusic(sheet);
  assert.deepEqual(a.pcm.channels[0], b.pcm.channels[0]);
  // the big hit is where the anchor said
  assert.ok(a.hitsS.some((h) => h.hit === "big" && Math.abs(h.atS - 12.2) < 1e-9));
  const l = measureLoudness(a.pcm);
  assert.ok(
    Number.isFinite(l.integrated) && l.integrated > -40,
    `music is audible (${l.integrated})`,
  );
});

// --- regressions from the adversarial review (each input failed before) ----

function clicks(seconds: number, everyS: number, burstS: number): Pcm {
  const n = Math.round(seconds * SR);
  const ch = new Float32Array(n);
  let s = 12345;
  for (let t = 0.1; t < seconds; t += everyS) {
    const a = Math.round(t * SR);
    for (let i = 0; i < burstS * SR && a + i < n; i++) {
      s = (s * 1103515245 + 12345) >>> 0;
      ch[a + i] = (s / 2 ** 32) * 2 - 1;
    }
  }
  return { sampleRate: SR, channels: [ch, ch.slice()] };
}

test("master: a click-only stem stays under the true-peak ceiling", () => {
  for (const burst of [0.003, 0.01]) {
    const m = master(clicks(8, 0.25, burst), { lufs: -15, truePeak: -1 });
    assert.ok(m.after.truePeak <= -1 + 1e-9, `burst ${burst}: tp ${m.after.truePeak}`);
  }
});

test("master: driven hard, music still honours the ceiling (and says if it missed)", () => {
  const sheet = arrange(
    {
      durationS: 16,
      anchors: [
        { atS: 0, energy: 2 },
        { atS: 8, energy: 3, hit: "big" },
        { atS: 12, energy: 2 },
      ],
    },
    { seed: 3 },
  );
  const m = master(renderMusic(sheet).pcm, { lufs: -9, truePeak: -1 });
  assert.ok(m.after.truePeak <= -1 + 1e-9, `tp ${m.after.truePeak}`);
  if (m.converged) assert.ok(Math.abs(m.after.integrated - -9) < 0.3);
});

test("master: an unreachable target is reported, not pumped", () => {
  const m = master(sine(1000, -20, 6), { lufs: 0, truePeak: -1 });
  assert.equal(m.converged, false);
  assert.ok(m.after.truePeak <= -1 + 1e-9);
  assert.ok(m.gainDb <= 36);
});

test("tempo: a caller-protected hit outranks the implicit first boundary", () => {
  const map = solveTempo([0, 0.5, 20], { bpm: 120 }, [0.5, 20]);
  assert.deepEqual(map.dropped, [0]);
  assert.equal(map.spans[0]!.atS, 0.5);
});

test("tempo: the last boundary is kept when nothing is protected", () => {
  const map = solveTempo([0, 10, 10.3], { bpm: 120 });
  assert.deepEqual(map.dropped, [10]);
  const last = map.spans.at(-1)!;
  assert.ok(Math.abs(last.atS + (last.eighths * 30) / last.bpm - 10.3) < 0.002);
});

test("tempo: a zero range is refused, not silently empty", () => {
  assert.throws(() => solveTempo([0, 8], { range: 0 }));
});

test("arrange: same-time anchors keep the bigger hit", () => {
  const sheet = arrange({
    durationS: 20,
    anchors: [
      { atS: 0, energy: 0 },
      { atS: 5, energy: 2, hit: "small" },
      { atS: 5, energy: 3, hit: "big" },
      { atS: 15, energy: 2, hit: "small" },
    ],
  });
  const at5 = sheet.sections.find((s) => s.atS === 5)!;
  assert.equal(at5.hit, "big");
  assert.equal(at5.energy, 3);
});

test("arrange: a payoff a breath before the end card becomes one big hit", () => {
  const sheet = arrange({
    durationS: 26,
    anchors: [
      { atS: 0, energy: 0 },
      { atS: 5, energy: 2, hit: "big" },
      { atS: 20.15, energy: 3, hit: "big" },
      { atS: 21, energy: 2, hit: "big" },
    ],
  });
  // one downbeat survives near 20–21 and it carries the big hit
  const near = [
    ...sheet.sections.map((s) => [s.atS, s.hit] as const),
    [sheet.outro!.atS, sheet.outro!.hit] as const,
  ].filter(([t]) => t > 19 && t < 22);
  assert.equal(near.length, 1);
  assert.equal(near[0]![1], "big");
  const r = renderMusic(sheet);
  assert.ok(r.hitsS.some((h) => Math.abs(h.atS - 20.15) < 1e-9 && h.hit === "big"));
});

test("arrange: anchors outside the film are ignored", () => {
  const sheet = arrange({
    durationS: 10,
    anchors: [
      { atS: -1, energy: 2, hit: "big" },
      { atS: 0, energy: 1 },
      { atS: 4, energy: 2, hit: "small" },
      { atS: 12, energy: 3, hit: "big" },
    ],
  });
  const r = renderMusic(sheet);
  for (const t of [...r.kicksS, ...r.hitsS.map((h) => h.atS)])
    assert.ok(t >= 0 && t < 10, `event at ${t}`);
});

test("render: the resolve rings out and ends, however long the film holds", () => {
  const sheet = arrange({
    durationS: 40,
    anchors: [
      { atS: 0, energy: 1 },
      { atS: 8, energy: 2, hit: "big" },
    ],
  });
  const { pcm } = renderMusic(sheet);
  // outro at 8 s, two groove bars, a ring of at most 8 s → silent by 24 s
  const tail = pcm.channels[0]!.subarray(Math.round(24 * SR));
  assert.ok(
    tail.every((v) => v === 0),
    "silent well after the resolve",
  );
});

// --- second review round ------------------------------------------------------

test("arrange: collapsed anchors are reported, clusters do not slide", () => {
  const sheet = arrange({
    durationS: 20,
    anchors: [
      { atS: 0, energy: 1 },
      { atS: 0.5, energy: 2, hit: "small" },
      { atS: 1.0, energy: 3, hit: "big" },
      { atS: 1.5, energy: 2 },
      { atS: 10, energy: 2, hit: "small" },
    ],
  });
  // every anchor is either a downbeat or reported
  const owned = new Set([...sheet.sections.map((s) => s.atS), sheet.outro?.atS]);
  for (const t of [0, 0.5, 1.0, 1.5, 10])
    assert.ok(owned.has(t) || sheet.dropped.includes(t), `${t}`);
  // the big hit survives
  assert.ok(renderMusic(sheet).hitsS.some((h) => h.atS === 1 && h.hit === "big"));
});

test("arrange: a final anchor close to the end still starts the outro", () => {
  const sheet = arrange({
    durationS: 30,
    anchors: [
      { atS: 0, energy: 1 },
      { atS: 15, energy: 2, hit: "small" },
      { atS: 29.8, energy: 2, hit: "big" },
    ],
  });
  assert.equal(sheet.outro?.atS, 29.8);
});

test("arrange: nothing inside the film is an empty sheet, not a throw", () => {
  const sheet = arrange({ durationS: 0, anchors: [{ atS: 0, energy: 1 }] });
  assert.equal(sheet.sections.length, 0);
  assert.equal(sheet.outro, undefined);
  assert.deepEqual(sheet.dropped, [0]);
});
