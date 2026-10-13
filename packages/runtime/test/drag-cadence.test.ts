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

test("a gap is a lost picture only while the pointer moved through it", () => {
  // a linear 600 px drag over 1 s: 0.6 px a ms
  const drag = {
    kind: "drag",
    tMs: 0,
    durationMs: 1000,
    path: [
      { x: 0, y: 0 },
      { x: 600, y: 0 },
    ],
    ease: "linear",
  };
  // a picture every 16 ms except one 100 ms hole at 400–500 ms (60 px moved)
  const frames = Array.from({ length: 63 }, (_, i) => i * 16).filter((t) => t < 400 || t >= 500);
  frames.push(400);
  frames.sort((a, b) => a - b);
  const [d] = dragCadence([drag], frames);
  assert.equal(d!.holes, 1);
  assert.equal(d!.worstHole!.atMs, 400);
  assert.equal(d!.worstHole!.movedPx, Math.round(0.6 * (frames.find((t) => t > 400)! - 400)));
});

test("the eased slow start and the wait for the first picture are not losses", () => {
  // smooth ease: the pointer covers ~1.6% of 320 px (~5 px) in the first
  // 130 ms — a canvas app waiting out its drag threshold draws nothing then
  const drag = {
    kind: "drag",
    tMs: 1000,
    durationMs: 700,
    path: [
      { x: 0, y: 0 },
      { x: 320, y: 0 },
    ],
    ease: "smooth",
  };
  // one picture at the press, the next at +110 ms (pointer moved ~5 px),
  // then every 16 ms to the release, nothing in the eased-out last 50 ms
  const frames = [1012, ...Array.from({ length: 34 }, (_, i) => 1122 + i * 16)];
  const [d] = dragCadence([drag], frames);
  assert.equal(d!.holes, 0);
  assert.ok(d!.maxGapMs >= 110, "the gap itself is still reported");
});

test("delivery: the median time from drawn to received over the drag's pictures", () => {
  const drag = { kind: "drag", tMs: 0, durationMs: 300 };
  const frames = [10, 50, 90, 400];
  const arrivals = [40, 180, 120, 405];
  const [d] = dragCadence([drag], frames, arrivals);
  assert.equal(d!.deliveryMs, 30); // delays 30, 130, 30 inside the drag
});

test("a drag with no pictures at all reports its whole length as the gap", () => {
  const [d] = dragCadence([{ kind: "drag", tMs: 0, durationMs: 800 }], []);
  assert.equal(d!.frames, 0);
  assert.equal(d!.maxGapMs, 800);
});
