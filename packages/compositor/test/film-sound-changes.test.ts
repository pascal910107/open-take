// What `film listen` and the render's report say of the sound on its own,
// checked on sound with known answers: a groove that switches at 10 s to
// half-time, other chords and no hats with nothing leading in — and the same
// switch after a rise; notes played in tune, and the same notes bent down
// through each one.

import assert from "node:assert/strict";
import { test } from "node:test";
import { LISTEN_RATE } from "../src/film/beats";
import { formatSoundChanges, soundChanges } from "../src/film/changes";
import { formatTuning, tuning } from "../src/film/tuning";

const R = LISTEN_RATE;

/** a seeded noise source, so every run is the same sound */
function noise(seed: number) {
  let a = seed | 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), a | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return (((t ^ (t >>> 14)) >>> 0) / 4294967296) * 2 - 1;
  };
}

const hz = (m: number) => 440 * 2 ** ((m - 69) / 12);

/** 20 s: 0–10 a kick every 0.5 s, hats every 0.25 s, a C major chord; then a
 *  kick every 1 s, no hats, an F♯ major chord — optionally a noise rising
 *  over the 1.5 s before the switch */
function groove({ riser = false } = {}) {
  const n = 20 * R;
  const x = new Float32Array(n);
  const rnd = noise(7);
  const add = (at: number, len: number, f: (t: number) => number) => {
    const a = Math.round(at * R);
    for (let i = 0; i < len * R && a + i < n; i++) x[a + i]! += f(i / R);
  };
  for (let t = 0; t < 20; t += t < 10 ? 0.5 : 1)
    add(
      t,
      0.3,
      (u) => 0.6 * Math.sin(2 * Math.PI * (55 + 60 * Math.exp(-u * 30)) * u) * Math.exp(-u * 12),
    );
  for (let t = 0; t < 10; t += 0.25) add(t, 0.03, (u) => 0.15 * rnd() * Math.exp(-u * 150));
  const chord = (ms: number[], from: number, to: number) =>
    add(from, to - from, (u) =>
      ms.reduce((a, m) => a + 0.05 * Math.sin(2 * Math.PI * hz(m) * u), 0),
    );
  chord([60, 64, 67], 0, 10);
  chord([66, 70, 73], 10, 20);
  if (riser) add(8.5, 1.5, (u) => 0.3 * (u / 1.5) ** 2 * rnd());
  return x;
}

test("a switch with nothing leading in: found where it is, what changed named, nothing leads into it", () => {
  const cs = soundChanges(groove());
  const c = cs.find((x) => Math.abs(x.t - 10) <= 0.4);
  assert.ok(c, `a change near 10 s: ${JSON.stringify(cs.map((x) => x.t))}`);
  assert.equal(cs[0], c, "the sharpest in the sound");
  const said = c!.parts.join("; ");
  assert.match(said, /high hits 4\.0 → 0\.0 a second/);
  assert.match(said, /harmony changes/);
  assert.match(said, /low (hits 2\.0 → 1\.0|pulse goes half-time)/);
  assert.equal(c!.leadIn, null);
  assert.match(
    formatSoundChanges(cs)[0]!,
    /nothing leads into it — the sharpest in this film \(estimated\)/,
  );
  // too short to set 3 s either side: not measured, not calm
  assert.equal(soundChanges(new Float32Array(5 * R)), null);
  assert.match(formatSoundChanges(null)[0]!, /\(not measured\)$/);
  assert.deepEqual(formatSoundChanges([]), [
    "- no change in the sound stood out from how it usually moves (not detected)",
  ]);
});

test("the same switch after a rise: the rise is said", () => {
  const c = soundChanges(groove({ riser: true })).find((x) => Math.abs(x.t - 10) <= 0.4);
  assert.ok(c);
  assert.match(c!.leadIn ?? "", /rises \d+ dB over the 1\.5 s before/);
});

/** a bass line of 0.4 s notes and a melody above it; `bend` cents down through each note */
function line(bend: number) {
  const n = 16 * R;
  const x = new Float32Array(n);
  const bass = [45, 45, 52, 48, 41, 41, 43, 43];
  const top = [69, 72, 76, 74, 72, 71, 69, 67];
  for (let k = 0; k < 40; k++) {
    for (const [ms, amp, len] of [
      [bass, 0.4, 0.4],
      [top, 0.15, 0.4],
    ] as const) {
      const f0 = hz(ms[k % ms.length]!);
      let ph = 0;
      const a = Math.round(k * 0.4 * R);
      for (let i = 0; i < len * R && a + i < n; i++) {
        const u = i / R;
        const f = f0 * 2 ** (-(bend / 1200) * (u / len));
        ph += (2 * Math.PI * f) / R;
        x[a + i]! +=
          amp * (Math.sin(ph) + 0.5 * Math.sin(2 * ph)) * Math.min(1, u * 200, (len - u) * 200);
      }
    }
  }
  return x;
}

test("notes in tune read in tune; the same notes bent down through each read off", () => {
  const good = tuning(line(0));
  assert.ok(good.reference != null && Math.abs(good.reference) <= 5, `reference ${good.reference}`);
  for (const r of good.registers) assert.ok(r.inTune >= 0.85, `${r.name}: ${r.inTune}`);
  const bent = tuning(line(150));
  const low = bent.registers.find((r) => r.name === "low")!;
  assert.ok(low.inTune <= 0.6, `bent low register still ${low.inTune} in tune`);
  assert.match(
    formatTuning(good)[1]!,
    /low register \(80–400 Hz\): \d+% of its pitched frames within 15 cents/,
  );
  assert.deepEqual(formatTuning(tuning(new Float32Array(R * 2))), [
    "- tuning: nothing pitched stood out (not detected)",
  ]);
});

test("a bright saw bass in tune reads in tune: its harmonics above it are not taken for notes", async () => {
  const { osc } = await import("../kit/audio.mjs");
  const n = 12 * R;
  const x = new Float32Array(n);
  const bass = [36, 36, 43, 41];
  for (let k = 0; k < 24; k++) {
    const note = osc("saw", hz(bass[k % 4]!), 0.5, { sampleRate: R });
    for (let i = 0; i < note.length; i++) x[Math.round(k * 0.5 * R) + i]! += 0.4 * note[i]!;
  }
  for (const r of tuning(x).registers.filter((r) => r.frames >= 20))
    assert.ok(r.inTune >= 0.85, `${r.name}: ${r.inTune} in tune`);
});
