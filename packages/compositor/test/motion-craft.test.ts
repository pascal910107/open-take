// Craft advisories from the frame-by-frame study of a reference launch film:
// a designed film never rests, varies its camera, and lets copy leave by
// moving — each is a warning (advice), never an error.

import assert from "node:assert/strict";
import test from "node:test";
import { launchTemplate } from "../src/launch-template";
import type { LaunchComposition } from "../src/launch-types";
import { analyzeMotionQuality } from "../src/motion-quality";

const film = (durationS: number, layers: unknown[]): LaunchComposition =>
  ({
    ...launchTemplate(),
    output: { width: 1920, height: 1080, fps: 60 },
    scenes: [{ id: "m", type: "motion", durationS, layers }],
  }) as LaunchComposition;
const said = (c: LaunchComposition, marker: string) =>
  analyzeMotionQuality(c).filter((x) => x.message.includes(marker));

const card = (animations: unknown[]) => ({
  id: "card",
  type: "rect",
  width: 400,
  height: 300,
  animations,
});

test("a hold of more than 3 s with nothing moving is called out; a creep answers it", () => {
  const still = film(6, [
    card([
      {
        property: "y",
        keyframes: [
          { atS: 0, value: 80 },
          { atS: 0.6, value: 0, easing: "snap" },
        ],
      },
    ]),
  ]);
  const found = said(still, "Nothing authored moves");
  assert.equal(found.length, 1);
  assert.match(found[0]!.message, /0\.60s to 6\.00s/);
  assert.equal(found[0]!.severity, "warn");
  const creeping = film(6, [
    card([
      {
        property: "y",
        keyframes: [
          { atS: 0, value: 80 },
          { atS: 0.6, value: 0, easing: "snap" },
        ],
      },
      {
        property: "scaleX",
        keyframes: [
          { atS: 0, value: 1 },
          { atS: 6, value: 1.03 },
        ],
      },
    ]),
  ]);
  assert.deepEqual(said(creeping, "Nothing authored moves"), []);
});

test("the same camera move three times is called out; varied moves are not", () => {
  const move = (from: number, to: number, x0: number, x1: number) => [
    { atS: from, value: x0 },
    { atS: to, value: x1, easing: "glide" },
  ];
  const same = film(10, [
    {
      id: "camera",
      type: "group",
      children: [card([])],
      animations: [
        {
          property: "x",
          keyframes: [
            { atS: 0, value: 0 },
            ...move(1, 1.7, 0, -340).slice(1),
            ...move(3, 3.7, -340, 0),
            ...move(5, 5.7, 0, -340),
            ...move(7, 7.7, -340, 0),
          ],
        },
      ],
    },
  ]);
  assert.equal(said(same, "The same move happens").length, 1);
  const varied = film(10, [
    {
      id: "camera",
      type: "group",
      children: [card([])],
      animations: [
        {
          property: "x",
          keyframes: [
            { atS: 0, value: 0 },
            { atS: 1.7, value: -340, easing: "glide" },
            { atS: 3, value: -340 },
            { atS: 4.2, value: 120, easing: "glide" },
            { atS: 5, value: 120 },
            { atS: 5.4, value: 0, easing: "swift" },
          ],
        },
      ],
    },
  ]);
  assert.deepEqual(said(varied, "The same move happens"), []);
});

test("copy that leaves by fading alone is called out; a fall or a move off is not", () => {
  const line = (extra: Record<string, unknown>) => ({
    id: "line",
    type: "text",
    text: "Your agent writes the slides.",
    width: 1400,
    height: 160,
    fontSize: 96,
    ...extra,
  });
  const fading = film(4, [
    line({
      animations: [
        {
          property: "opacity",
          keyframes: [
            { atS: 0, value: 1 },
            { atS: 3, value: 1 },
            { atS: 3.3, value: 0, easing: "ease-in" },
          ],
        },
      ],
    }),
  ]);
  assert.equal(said(fading, "leaves by fading only").length, 1);
  const falling = film(4, [
    line({
      units: {
        by: "word",
        moves: [
          { move: "rise", atS: 0 },
          { move: "fall", atS: 3 },
        ],
      },
    }),
  ]);
  assert.deepEqual(said(falling, "leaves by fading only"), []);
  const movingOff = film(4, [
    line({
      animations: [
        {
          property: "opacity",
          keyframes: [
            { atS: 0, value: 1 },
            { atS: 3, value: 1 },
            { atS: 3.3, value: 0, easing: "ease-in" },
          ],
        },
        {
          property: "y",
          keyframes: [
            { atS: 0, value: 0 },
            { atS: 3, value: 0 },
            { atS: 3.3, value: -120, easing: "ease-in" },
          ],
        },
      ],
    }),
  ]);
  assert.deepEqual(said(movingOff, "leaves by fading only"), []);
  // an entrance move long before the fade does not make the fade a move
  const enteredThenFaded = film(4, [
    line({
      animations: [
        {
          property: "y",
          keyframes: [
            { atS: 0, value: 40 },
            { atS: 0.5, value: 0, easing: "snap" },
          ],
        },
        {
          property: "opacity",
          keyframes: [
            { atS: 0, value: 1 },
            { atS: 3, value: 1 },
            { atS: 3.3, value: 0, easing: "ease-in" },
          ],
        },
      ],
    }),
  ]);
  assert.equal(said(enteredThenFaded, "leaves by fading only").length, 1);
});

test("set pieces used everywhere are called out as decoration", () => {
  const wipe = (i: number) => ({ id: `w${i}`, type: "wipe", atS: 1 + i * 2 });
  const three = film(10, [card([]), wipe(0), wipe(1), wipe(2)]);
  assert.equal(said(three, "wipes in one scene").length, 1);
  const two = film(10, [card([]), wipe(0), wipe(1)]);
  assert.deepEqual(said(two, "wipes in one scene"), []);
  const hits = film(10, [card([])]);
  (hits.scenes[0] as { hits?: unknown[] }).hits = [1, 3, 5].map((atS) => ({ atS }));
  assert.equal(said(hits, "hits in one scene").length, 1);
});
