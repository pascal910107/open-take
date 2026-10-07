// Product audio, the runtime half: blocks the page forwarded are mixed onto
// the capture timeline (sample 0 = the take's t0), resampled when a source
// runs at another rate, written as an unclipped float WAV; fetched sound files
// get stable, distinct names. The in-page half against real Chrome is
// product-audio-browser.test.ts.

import assert from "node:assert/strict";
import { test } from "node:test";
import { floatWav, mixBlocks, uniqueName } from "../src/product-audio.js";

const tone = (frames: number, v: number): Float32Array => new Float32Array(frames * 2).fill(v);

test("a block lands at its produced time relative to t0, and overlapping blocks sum", () => {
  const t0 = 1_000_000;
  const sources = new Map([[1, { sampleRate: 1000 }]]);
  const mix = mixBlocks(
    [
      { src: 1, producedMs: t0 + 100, samples: tone(50, 0.25) },
      { src: 1, producedMs: t0 + 120, samples: tone(10, 0.5) },
    ],
    sources,
    t0,
    1000,
  );
  assert.equal(mix.sampleRate, 1000);
  assert.equal(mix.pcm.length, 2000, "the WAV spans the whole take");
  assert.equal(mix.pcm[2 * 99], 0);
  assert.equal(mix.pcm[2 * 100], 0.25);
  assert.equal(mix.pcm[2 * 125 + 1], 0.75, "overlap sums (no clipping, no ducking)");
  assert.deepEqual(mix.soundAt, [[100, 150]]);
  assert.equal(mix.peak, 0.75);
});

test("sound before t0 or after the end is cut, never shifted", () => {
  const t0 = 5000;
  const sources = new Map([[1, { sampleRate: 1000 }]]);
  const mix = mixBlocks(
    [
      { src: 1, producedMs: t0 - 20, samples: tone(40, 0.1) },
      { src: 1, producedMs: t0 + 2000, samples: tone(40, 0.1) },
    ],
    sources,
    t0,
    500,
  );
  assert.equal(mix.pcm[0], Math.fround(0.1), "the tail that falls after t0 stays at its time");
  assert.equal(mix.pcm[2 * 20], 0);
  assert.deepEqual(mix.soundAt, [[0, 20]]);
});

test("the rate most sound arrived at wins; another source is resampled to it", () => {
  const sources = new Map([
    [1, { sampleRate: 48000 }],
    [2, { sampleRate: 24000 }],
  ]);
  const mix = mixBlocks(
    [
      { src: 1, producedMs: 0, samples: tone(4800, 0.1) },
      { src: 2, producedMs: 200, samples: tone(1200, 0.2) },
    ],
    sources,
    0,
    400,
  );
  assert.equal(mix.sampleRate, 48000);
  // 1200 frames at 24 kHz = 50 ms = 2400 frames at 48 kHz, starting at 200 ms
  const first = 0.2 * 48000;
  assert.ok(Math.abs(mix.pcm[2 * first]! - 0.2) < 1e-6);
  assert.ok(Math.abs(mix.pcm[2 * (first + 2390)]! - 0.2) < 1e-6);
  assert.equal(mix.pcm[2 * (first + 2410)], 0);
});

test("blocks of one source sit end to end on its own clock, whatever their wall stamps jitter", () => {
  const sources = new Map([[1, { sampleRate: 1000 }]]);
  // 10-frame blocks at 1 kHz whose wall stamps wobble ±0.4 ms around an
  // offset of 100 ms: laid by stamp they would overlap or leave holes
  const blocks = [0, 10, 20, 30].map((f, i) => ({
    src: 1,
    producedMs: 100 + f + [0, 0.4, -0.4, 0.3][i]!,
    ctxFrame: f,
    samples: tone(10, 0.5),
  }));
  const mix = mixBlocks(blocks, sources, 0, 200);
  for (let k = 100; k < 140; k++) assert.equal(mix.pcm[2 * k], 0.5, `frame ${k} covered once`);
  assert.equal(mix.pcm[2 * 99], 0);
  assert.equal(mix.pcm[2 * 140], 0);
  assert.equal(mix.peak, 0.5, "no spike where blocks meet");
});

test("a jump in a source's clock offset starts a new run; stale duplicate stamps are dropped", () => {
  const sources = new Map([[1, { sampleRate: 1000 }]]);
  const b = (producedMs: number, ctxFrame: number) => ({
    src: 1,
    producedMs,
    ctxFrame,
    samples: tone(10, 0.5),
  });
  const mix = mixBlocks(
    [
      b(100, 0),
      b(110, 10),
      // resumed after a suspend: the context clock stood still for 200 ms
      b(320, 20),
      // a stall: two buffers stamped with one stale time, overlapping the
      // steady chain that follows from frame 35
      b(330, 30),
      b(330, 30),
      b(335, 35),
      b(345, 45),
    ],
    sources,
    0,
    500,
  );
  assert.equal(mix.pcm[2 * 100], 0.5);
  assert.equal(mix.pcm[2 * 125], 0, "the suspended stretch stays silent");
  assert.equal(mix.pcm[2 * 320], 0.5, "the resumed run sits at its own offset");
  assert.equal(mix.pcm[2 * 332], 0, "the stale duplicates are left out");
  assert.equal(mix.pcm[2 * 336], 0.5);
  assert.equal(mix.peak, 0.5);
});

test("floatWav writes an IEEE-float RIFF header ffmpeg and audio.mjs read", () => {
  const wav = floatWav(new Float32Array([0.5, -0.5, 1.5, -1.5]), 48000, 2);
  assert.equal(wav.toString("ascii", 0, 4), "RIFF");
  assert.equal(wav.readUInt16LE(20), 3, "format 3 = float");
  assert.equal(wav.readUInt16LE(22), 2);
  assert.equal(wav.readUInt32LE(24), 48000);
  assert.equal(wav.readUInt16LE(34), 32);
  assert.equal(wav.readUInt32LE(40), 16);
  assert.equal(wav.readFloatLE(44 + 8), 1.5, "kept unclipped");
});

test("fetched sound files get readable, distinct names", () => {
  const used = new Set<string>();
  assert.equal(
    uniqueName("https://x.dev/sound/click4/click4_1.wav?v=2", used),
    "sound-click4-click4_1.wav",
  );
  assert.equal(
    uniqueName("https://y.dev/sound/click4/click4_1.wav", used),
    "sound-click4-click4_1-2.wav",
  );
  assert.equal(uniqueName("https://x.dev/a%20b/stream", used), "a_b-stream.audio");
  assert.equal(uniqueName("https://x.dev/", used), "sound.audio");
});
