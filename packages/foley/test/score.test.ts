// A score the author writes: validated, played deterministically, mastered.

import assert from "node:assert/strict";
import { test } from "node:test";
import { measureLoudness } from "../src/master";
import { midiOf, renderScore, type ScoreSheet, validateScore } from "../src/score";

const noFiles = () => {
  throw new Error("no files in this test");
};

const sheet: ScoreSheet = {
  version: 1,
  durationS: 3,
  tracks: [
    {
      name: "band",
      events: [
        { at: 0, drum: "kick" },
        { at: 0.5, drum: "hat", gainDb: -20 },
        { at: 0, note: "warm-pad", pitch: ["D3", "F#3", "A3"], dur: 2, gainDb: -18 },
        { at: 0, note: "bass", pitch: "D2", dur: 1 },
        { at: 1.5, note: "bell", pitch: 81, dur: 1 },
      ],
    },
    {
      name: "ui",
      events: [
        { at: 1, sound: "key.brown", gainDb: -14 },
        { at: 2, sound: "whoosh" },
      ],
    },
  ],
};

test("note names are MIDI numbers", () => {
  assert.equal(midiOf("C4"), 60);
  assert.equal(midiOf("F#3"), 54);
  assert.equal(midiOf("Bb2"), 46);
  assert.equal(midiOf(69), 69);
  assert.throws(() => midiOf("H2"), /note name/);
});

test("a score says what is wrong with it, by path", () => {
  assert.deepEqual(validateScore(sheet), []);
  const bad = validateScore({
    version: 1,
    durationS: 2,
    tracks: [
      {
        name: "a",
        duck: { under: "nobody" },
        events: [{ at: -1, drum: "gong" }, { at: 0, note: "pad" }, { at: 0 }],
      },
      { name: "a", events: [{ at: 0, sound: "key.nothing" }] },
    ],
  });
  const text = bad.join("\n");
  assert.match(text, /tracks\[0\]\.events\[0\]\.at/);
  assert.match(text, /tracks\[0\]\.events\[0\]\.drum/);
  assert.match(text, /tracks\[0\]\.events\[1\]\.pitch: required/);
  assert.match(text, /tracks\[0\]\.events\[2\]: exactly one of/);
  assert.match(text, /tracks\[1\]\.name: "a" is used twice/);
  assert.match(text, /key\.nothing/);
  assert.match(text, /duck\.under: no track named "nobody"/);
});

test("the same score renders to the same samples, mastered to its loudness", () => {
  const a = renderScore(sheet, noFiles);
  const b = renderScore(sheet, noFiles);
  assert.equal(a.pcm.channels[0]!.length, 3 * 48000);
  assert.deepEqual(a.pcm.channels[0], b.pcm.channels[0]);
  const l = measureLoudness(a.pcm);
  assert.ok(Math.abs(l.integrated - -16) < 0.5, `mastered to -16 LUFS (got ${l.integrated})`);
  assert.ok(l.truePeak <= -1.5 + 0.05, `true peak under the ceiling (got ${l.truePeak})`);
  assert.deepEqual(
    a.tracks.map((t) => t.name),
    ["band", "ui"],
  );
});

test("master: false leaves every level as written", () => {
  const raw = renderScore({ ...sheet, master: false }, noFiles);
  assert.equal(raw.masterGainDb, 0);
  assert.equal(raw.after.integrated, raw.before.integrated);
});
