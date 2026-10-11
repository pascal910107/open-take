import assert from "node:assert/strict";
import test from "node:test";
import { dragCadence } from "../src/cdp";

test("a drag's pictures: count, rate and the longest gap, press and release included", () => {
  const events = [
    { kind: "click", tMs: 100 },
    { kind: "drag", tMs: 1000, durationMs: 2000 },
    { kind: "drag", tMs: 4000, durationMs: 100 },
  ];
  // 14 pictures over the 2 s drag, nothing in its first 600 ms
  const frames = [500, ...Array.from({ length: 14 }, (_, i) => 1600 + i * 100), 3500];
  const [d, ...rest] = dragCadence(events, frames);
  assert.equal(rest.length, 0, "a drag shorter than 200 ms is not reported");
  assert.equal(d!.event, 1);
  assert.equal(d!.frames, 14);
  assert.equal(d!.perSecond, 7);
  assert.equal(d!.maxGapMs, 600);
});

test("a drag with no pictures at all reports its whole length as the gap", () => {
  const [d] = dragCadence([{ kind: "drag", tMs: 0, durationMs: 800 }], []);
  assert.equal(d!.frames, 0);
  assert.equal(d!.maxGapMs, 800);
});
