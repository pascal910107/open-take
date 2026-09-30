import assert from "node:assert/strict";
import { test } from "node:test";
import {
  decodeWav,
  type EventSheet,
  encodeWav,
  FOLEY_ROLES,
  mixCues,
  peakDb,
  spot,
  synthesize,
  validateCueSheet,
  validateEventSheet,
} from "../src/index";

const sheet: EventSheet = {
  version: 1,
  durationS: 8,
  events: [
    { kind: "notify", atS: 0.1 },
    { kind: "tap", atS: 0.5, pan: -0.5 },
    { kind: "tap", atS: 0.6 },
    { kind: "tap", atS: 0.7 },
    { kind: "build", atS: 1, durationS: 2 },
    { kind: "move", atS: 1.2, durationS: 0.5, extent: 0.4 },
    { kind: "move", atS: 2, durationS: 0.3, extent: 0.02 },
    { kind: "key", atS: 2.1 },
    { kind: "key", atS: 2.2 },
    { kind: "click", atS: 2.5 },
    { kind: "transition", atS: 3 },
    { kind: "reveal", atS: 3.1, intensity: 0.9 },
    { kind: "zoom-in", atS: 5, durationS: 0.7 },
    { kind: "zoom-out", atS: 6.5, durationS: 0.9 },
  ],
};

test("every voice renders finite, peak-normalised samples at any seed", () => {
  for (const role of FOLEY_ROLES)
    for (const seed of [1, 2, 99]) {
      const y = synthesize(role, { sampleRate: 48000, durationS: 0.5, pitch: 0, seed });
      assert.ok(y.length > 0, role);
      let peak = 0;
      for (const v of y) {
        assert.ok(Number.isFinite(v), `${role} produced a non-finite sample`);
        peak = Math.max(peak, Math.abs(v));
      }
      assert.ok(Math.abs(peak - 1) < 1e-3, `${role} peak ${peak}`);
    }
});

test("a voice is deterministic in its seed and differs across seeds", () => {
  const a = synthesize("tap", { sampleRate: 48000, durationS: 0.2, pitch: 0, seed: 7 });
  const b = synthesize("tap", { sampleRate: 48000, durationS: 0.2, pitch: 0, seed: 7 });
  const c = synthesize("tap", { sampleRate: 48000, durationS: 0.2, pitch: 0, seed: 8 });
  assert.deepEqual(Array.from(a), Array.from(b));
  assert.notDeepEqual(Array.from(a), Array.from(c));
});

test("spotting maps kinds to roles by the style table", () => {
  const cues = spot(sheet, { style: "cinematic", seed: 3 });
  const roles = (r: string) => cues.cues.filter((c) => c.role === r);
  assert.equal(roles("notify").length, 1);
  assert.equal(roles("tap").length, 3);
  assert.equal(roles("key").length, 2);
  assert.equal(roles("click").length, 1);
  assert.equal(roles("riser").length, 1);
  assert.equal(roles("riser")[0]!.durationS, 2);
  // one move crosses 40% of the frame (whoosh), one crosses 2% (silent);
  // the zoom-in adds a second whoosh
  assert.equal(roles("whoosh").length, 2);
  // the transition breathes (air + ui), the zoom-out breathes (air)
  assert.equal(roles("air").length, 2);
  assert.equal(roles("ui").length, 1);
  // the payoff stack lands together
  const payoff = ["pop", "impact", "boom", "chime"].map((r) => roles(r)[0]!);
  for (const c of payoff) assert.ok(c && Math.abs(c.atS - 3.1) < 0.06, `${c?.role} at ${c?.atS}`);
  // a whoosh departs a little BEFORE its move so the swell rides the motion
  const w = roles("whoosh").find((c) => c.from === undefined && c.atS < 1.2)!;
  assert.ok(w.atS < 1.2 && w.atS > 1.0);
  assert.equal(validateCueSheet(cues).length, 0);
});

test("spotting is deterministic and styles differ", () => {
  const a = spot(sheet, { seed: 5 });
  const b = spot(sheet, { seed: 5 });
  assert.deepEqual(a, b);
  const minimal = spot(sheet, { style: "minimal", seed: 5 });
  assert.equal(minimal.cues.filter((c) => c.role === "riser").length, 0);
  assert.equal(minimal.cues.filter((c) => c.role === "boom").length, 0);
  assert.ok(minimal.cues.length < a.cues.length);
});

test("same-role collisions collapse and micro density is capped", () => {
  const dense: EventSheet = {
    version: 1,
    durationS: 3,
    events: [
      ...Array.from({ length: 40 }, (_, i) => ({ kind: "tap" as const, atS: 0.5 + i * 0.02 })),
      { kind: "click", atS: 1.0 },
      { kind: "click", atS: 1.01, intensity: 1 },
    ],
  };
  const cues = spot(dense, { seed: 1 });
  const taps = cues.cues.filter((c) => c.role === "tap");
  assert.ok(taps.length <= 14, `${taps.length} taps survived`);
  for (let i = 1; i < taps.length; i++) assert.ok(taps[i]!.atS - taps[i - 1]!.atS >= 0.04 - 1e-9);
  const clicks = cues.cues.filter((c) => c.role === "click");
  assert.equal(clicks.length, 1);
  assert.ok(clicks[0]!.gainDb > -24, "the louder colliding click is the one kept");
});

test("the mix places cues at their sample offsets, pans, and stays inside full scale", () => {
  const cues = spot(sheet, { seed: 2 });
  const pcm = mixCues(cues, { sampleRate: 48000 });
  assert.equal(pcm.channels.length, 2);
  assert.equal(pcm.channels[0]!.length, 8 * 48000);
  assert.ok(peakDb(pcm) <= 0);
  // the first tap was panned left: more energy on L than R around 0.5 s
  const [L, R] = pcm.channels as [Float32Array, Float32Array];
  const e = (ch: Float32Array) => {
    let s = 0;
    for (let i = 0.5 * 48000; i < 0.58 * 48000; i++) s += ch[i]! ** 2;
    return s;
  };
  assert.ok(e(L) > e(R) * 1.5);
  // nothing before the first cue
  for (let i = 0; i < 0.05 * 48000; i++) assert.equal(L[i], 0);
});

test("a head-trim offset shifts and drops cues", () => {
  const cues = spot(sheet, { seed: 2 });
  const pcm = mixCues(cues, { sampleRate: 48000, offsetS: 3.1 });
  assert.equal(pcm.channels[0]!.length, Math.ceil((8 - 3.1) * 48000));
  // the payoff (at 3.1) now sits at 0
  let early = 0;
  for (let i = 0; i < 0.01 * 48000; i++) early = Math.max(early, Math.abs(pcm.channels[0]![i]!));
  assert.ok(early > 0.01);
});

test("wav round-trips", () => {
  const cues = spot(sheet, { seed: 4 });
  const pcm = mixCues(cues, { sampleRate: 48000, durationS: 1 });
  const back = decodeWav(encodeWav(pcm));
  assert.equal(back.sampleRate, 48000);
  assert.equal(back.channels.length, 2);
  assert.equal(back.channels[0]!.length, 48000);
  let err = 0;
  for (let i = 0; i < 48000; i++)
    err = Math.max(err, Math.abs(back.channels[0]![i]! - pcm.channels[0]![i]!));
  assert.ok(err < 1 / 32000);
});

test("sheet validation names the bad field", () => {
  assert.deepEqual(validateEventSheet(sheet), []);
  const issues = validateEventSheet({
    version: 1,
    durationS: 1,
    events: [{ kind: "boing", atS: -1 }],
  });
  assert.ok(issues.some((x) => x.path === "events[0].kind"));
  assert.ok(issues.some((x) => x.path === "events[0].atS"));
  const bad = validateCueSheet({
    version: 1,
    durationS: 1,
    cues: [{ id: "a", role: "tap", atS: 0, durationS: 0.1, gainDb: 3, pan: 0, pitch: 0, seed: 1 }],
  });
  assert.ok(bad.some((x) => x.path === "cues[0].gainDb"));
});
