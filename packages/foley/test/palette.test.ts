// The palette's promises: only approved entries can be picked, recordings
// load from the package, designed voices stand in for a role, the default is
// the audition's choices, and a film's soundtrack lands on its delivery target.

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  arrange,
  DEFAULT_PALETTE,
  describePalette,
  mixCues,
  mixFilm,
  PALETTE,
  paletteLibrary,
  renderMusic,
  resolvePalette,
  validatePalette,
} from "../src/index";
import { voiceFor } from "../src/library";

test("validation: unknown, mismatched and unapproved picks are refused", () => {
  assert.deepEqual(validatePalette(undefined), []);
  assert.deepEqual(validatePalette({ key: "key.crisp", music: { style: "chill" } }), []);
  assert.deepEqual(validatePalette({ key: "key.blue" }), []);
  assert.match(validatePalette({ key: "nope" })[0]!, /unknown entry/);
  assert.match(validatePalette({ tap: "key.office" })[0]!, /is a key sound/);
  assert.match(validatePalette({ whoosh: "whoosh.deep" })[0]!, /not been approved/);
  assert.match(validatePalette({ music: { style: "jazz" } })[0]!, /one of pulse/);
  assert.match(validatePalette({ music: { pad: "airy" } })[0]!, /one of/);
  assert.deepEqual(validatePalette({ music: false }), []);
});

test("every approved entry is playable", () => {
  for (const e of PALETTE.filter((x) => x.approved)) {
    const lib = paletteLibrary({ [e.role]: e.id });
    const v = voiceFor(e.role, { sampleRate: 48000, durationS: 0.5, pitch: 0, seed: 3 }, lib);
    assert.ok(v.length > 100, `${e.id} renders`);
    assert.ok(
      v.some((x) => Math.abs(x) > 0.1),
      `${e.id} is not silent`,
    );
  }
});

test("recordings come from the package; typing rotates through many keystrokes", () => {
  const lib = paletteLibrary();
  assert.ok((lib.roles.key?.length ?? 0) >= 16, "brown switches: a keystroke per seed");
  assert.ok((lib.roles.tap?.length ?? 0) >= 2);
  assert.equal(lib.voices?.whoosh, "whoosh.medium");
  // recordings stay near their own pitch
  assert.ok(lib.roles.key!.every((v) => (v.pitchScale ?? 1) < 0.5));
});

test("the default is the audition's choices; a film overrides one role at a time", () => {
  assert.equal(resolvePalette().key, DEFAULT_PALETTE.key);
  const p = resolvePalette({ key: "key.crisp", music: { style: "cinematic" } });
  assert.equal(p.key, "key.crisp");
  assert.equal(p.tap, DEFAULT_PALETTE.tap);
  assert.deepEqual(p.music, { style: "cinematic", build: "cinematic" });
  assert.equal(resolvePalette({ music: false }).music, false);
});

test("the listing names every approved entry and marks the defaults", () => {
  const text = describePalette();
  for (const e of PALETTE.filter((x) => x.approved)) assert.ok(text.includes(e.id), e.id);
  assert.ok(!text.includes("whoosh.deep"), "unapproved entries are not offered");
  assert.match(text, /key\.brown \[default\]/);
  assert.match(text, /key\.office \(provisional\)/);
});

test("a film soundtrack (music + foley) lands on −15 LUFS under −1.5 dBTP", () => {
  const cues = {
    version: 1 as const,
    durationS: 12,
    style: "cinematic",
    seed: 1,
    cues: Array.from({ length: 20 }, (_, i) => ({
      id: `key-${i}`,
      role: "key" as const,
      atS: 3 + i * 0.13,
      durationS: 0.11,
      gainDb: -27,
      pan: 0,
      pitch: 0,
      seed: i,
    })),
  };
  const foley = mixCues(cues, { library: paletteLibrary() });
  const sheet = arrange({
    durationS: 12,
    anchors: [
      { atS: 0, energy: 1 },
      { atS: 4, energy: 2, hit: "small" },
      { atS: 8, energy: 2, hit: "big" },
    ],
  });
  const music = renderMusic(sheet, undefined, resolvePalette().music || {}).pcm;
  const m = mixFilm(
    music,
    foley,
    cues.cues.map((c) => c.atS),
    12,
  );
  assert.ok(m.converged, "a film with music reaches its target");
  assert.ok(Math.abs(m.after.integrated - -15) < 0.3, `lufs ${m.after.integrated}`);
  assert.ok(m.after.truePeak <= -1.5 + 1e-9, `tp ${m.after.truePeak}`);
  // sparse foley alone is never pumped past its ceiling to chase loudness
  const alone = mixFilm(undefined, foley, [], 12);
  assert.ok(alone.after.truePeak <= -1.5 + 1e-9, `tp ${alone.after.truePeak}`);
});
