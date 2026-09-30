// Copy that moves word by word: how it splits (CJK too), where each unit sits,
// and what each named move does to a unit over time — the numbers measured
// off a reference launch film (rise 1.1 font sizes on snap, 70 ms apart; fall
// 0.9 font sizes, tipping and blurring, 35 ms apart).

import assert from "node:assert/strict";
import test from "node:test";
import { evaluateTextUnit, layoutTextUnits, motionTextUnits } from "../src/motion-evaluate";
import type { MotionScene, MotionTextUnits } from "../src/motion-types";
import { validateMotionScene } from "../src/motion-validate";

const font = { fontSize: 100, lineHeight: 120 };

test("copy splits into words — spaces and punctuation ride with the word before them", () => {
  assert.deepEqual(motionTextUnits("Your agent writes the slides.", "word"), [
    ["Your ", "agent ", "writes ", "the ", "slides."],
  ]);
  assert.deepEqual(motionTextUnits("把想法\n做成簡報。", "word"), [
    ["把", "想法"],
    ["做成", "簡報。"],
  ]);
  assert.deepEqual(motionTextUnits("用 Agent 建立。", "word"), [["用 ", "Agent ", "建立。"]]);
  assert.deepEqual(motionTextUnits("ab c", "grapheme"), [["a", "b ", "c"]]);
});

test("units sit where the whole-box text would: aligned, wrapped at word boundaries", () => {
  const measure = (s: string) => s.length * 10;
  const box = { width: 100, height: 240, align: "center" as const, lineHeight: 120 };
  // "aaa " (40) + "bbb" (30): 70 wide, centred in 100 → starts at 15; each unit
  // is centred on its ink ("aaa", 30), its trailing space only a gap
  const [a, b] = layoutTextUnits([["aaa ", "bbb"]], box, measure);
  assert.equal(a!.cx, -50 + 15 + 15);
  assert.equal(a!.width, 30);
  assert.equal(b!.cx, -50 + 55 + 15);
  assert.equal(a!.cy, -120 + 60);
  // "aaaaa " + "bbbbb" is 110 wide: the second word wraps, the third joins it
  const wrapped = layoutTextUnits([["aaaaa ", "bbbbb ", "ccc"]], box, measure);
  assert.equal(wrapped[1]!.cy, wrapped[0]!.cy + 120);
  assert.equal(wrapped[2]!.cy, wrapped[1]!.cy);
  const left = layoutTextUnits([["aa"]], { ...box, align: "left" }, measure);
  assert.equal(left[0]!.cx, -50 + 10);
  const right = layoutTextUnits([["aa"]], { ...box, align: "right" }, measure);
  assert.equal(right[0]!.cx, 50 - 10);
});

test("rise: hidden below its mask, then up on snap, 70 ms apart, resting after", () => {
  const units: MotionTextUnits = { by: "word", moves: [{ move: "rise", atS: 1 }] };
  const before = evaluateTextUnit(units, 0, 0.5, font);
  assert.equal(before.opacity, 0);
  assert.ok(before.masked && before.dy >= 120);
  // 0.3 s into a 0.9 s snap the word is ~90 % home
  const early = evaluateTextUnit(units, 0, 1.3, font);
  assert.ok(early.dy < 0.14 * 120 && early.masked, String(early.dy));
  // the next word is 70 ms behind
  const second = evaluateTextUnit(units, 1, 1.3, font);
  assert.ok(second.dy > early.dy);
  assert.equal(evaluateTextUnit(units, 1, 1.07, font).opacity, 1);
  assert.equal(evaluateTextUnit(units, 1, 1.069, font).opacity, 0);
  const rest = evaluateTextUnit(units, 3, 3, font);
  assert.deepEqual(rest, {
    dx: 0,
    dy: 0,
    scale: 1,
    rotation: 0,
    opacity: 1,
    blur: 0,
    masked: false,
  });
});

test("fall: accelerates away, tipping alternately and blurring, gone at the end", () => {
  const units: MotionTextUnits = {
    by: "word",
    moves: [
      { move: "rise", atS: 0 },
      { move: "fall", atS: 2 },
    ],
  };
  const start = evaluateTextUnit(units, 0, 2.1, font);
  assert.ok(start.dy < 5 && start.opacity > 0.99, "an exit starts slowly");
  const end0 = evaluateTextUnit(units, 0, 2.6, font);
  assert.equal(end0.opacity, 0);
  assert.equal(end0.blur, 8);
  assert.equal(end0.dy, 90);
  assert.equal(end0.masked, false);
  const end1 = evaluateTextUnit(units, 1, 3, font);
  assert.ok(Math.sign(end0.rotation) !== Math.sign(end1.rotation), "neighbours tip opposite ways");
});

test("pop settles from 1.18× with a blurred start", () => {
  const units: MotionTextUnits = { by: "word", moves: [{ move: "pop", atS: 0 }] };
  const first = evaluateTextUnit(units, 0, 1 / 60, font);
  assert.ok(first.scale > 1.1 && first.blur > 6, JSON.stringify(first));
  const late = evaluateTextUnit(units, 0, 0.34, font);
  assert.ok(late.scale < 1.01 && late.blur < 0.5);
  assert.equal(evaluateTextUnit(units, 0, 0.5, font).scale, 1);
});

test("an exit-only unit rests until it leaves", () => {
  const units: MotionTextUnits = { by: "word", moves: [{ move: "fade-out", atS: 1 }] };
  assert.equal(evaluateTextUnit(units, 0, 0.5, font).opacity, 1);
  assert.equal(evaluateTextUnit(units, 0, 1.5, font).opacity, 0);
});

test("units validate: known moves, arrival before exit, time order, no reveal track", () => {
  const scene = (units: unknown, reveal = false): MotionScene =>
    ({
      id: "s",
      type: "motion",
      durationS: 4,
      layers: [
        {
          id: "t",
          type: "text",
          text: "Hello there",
          width: 800,
          height: 200,
          fontSize: 80,
          units,
          ...(reveal
            ? {
                animations: [
                  {
                    property: "reveal",
                    keyframes: [
                      { atS: 0, value: 0 },
                      { atS: 1, value: 1 },
                    ],
                  },
                ],
              }
            : {}),
        },
      ],
    }) as unknown as MotionScene;
  const issues = (u: unknown, reveal = false) => validateMotionScene(scene(u, reveal), "s");
  assert.deepEqual(issues({ by: "word", moves: [{ move: "rise", atS: 0.2 }] }), []);
  assert.deepEqual(
    issues({
      by: "grapheme",
      moves: [
        { move: "pop", atS: 0.2, staggerS: 0.03 },
        { move: "fall", atS: 3, durationS: 0.6 },
      ],
    }),
    [],
  );
  assert.ok(issues({ by: "letter", moves: [{ move: "rise", atS: 0 }] }).length);
  assert.ok(issues({ by: "word", moves: [{ move: "zoom", atS: 0 }] }).length);
  assert.ok(issues({ by: "word", moves: [] }).length);
  assert.ok(
    issues({
      by: "word",
      moves: [
        { move: "fall", atS: 0 },
        { move: "rise", atS: 1 },
      ],
    }).length,
    "an exit cannot come before the arrival",
  );
  assert.ok(
    issues({
      by: "word",
      moves: [
        { move: "rise", atS: 2 },
        { move: "fall", atS: 1 },
      ],
    }).length,
    "moves in time order",
  );
  assert.ok(issues({ by: "word", moves: [{ move: "rise", atS: 9 }] }).length, "inside the scene");
  // "Hello there" is two words: the second lands at 0.2 + 0.07 + 0.9 = 1.17 s
  assert.ok(
    issues({
      by: "word",
      moves: [
        { move: "rise", atS: 0.2 },
        { move: "fall", atS: 0.8 },
      ],
    }).some((x) => x.message.includes("before the last unit has arrived")),
    "an exit cannot cut an arrival short",
  );
  assert.deepEqual(
    issues({
      by: "word",
      moves: [
        { move: "rise", atS: 0.2 },
        { move: "fall", atS: 1.2 },
      ],
    }),
    [],
  );
  assert.ok(issues({ by: "word", moves: [{ move: "rise", atS: 0 }] }, true).length, "no reveal");
});
