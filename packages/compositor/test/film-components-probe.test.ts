// The component probe's Node side (no Chrome): the card test it is handed
// (cardsOf, shared with `open-take states`), the expression it evaluates,
// and the window a part's picture shows.

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  COMPONENT_PROBE_JS,
  cardsOf,
  componentProbeExpression,
  pictureClip,
  type StateIndex,
} from "../src/index";

const el = (
  id: string,
  path: number[],
  box: [number, number, number, number],
  extra: Partial<StateIndex["elements"][number]> = {},
) => ({ id, path, tag: "div", box, ...extra });

const index: StateIndex = {
  version: 1,
  id: "s1",
  url: "http://x/",
  title: "x",
  tMs: 0,
  viewport: { w: 1000, h: 1000, dpr: 1 },
  scroll: { x: 0, y: 0 },
  layers: [],
  elements: [
    el("e0", [], [0, 0, 1000, 1000], { tag: "html" }),
    // a wrapper with the card's box, and the card: the outermost is the card
    el("e1", [0], [100, 100, 300, 200]),
    el("e2", [0, 0], [100, 100, 300, 200]),
    el("e3", [0, 0, 0], [110, 110, 100, 20], { tag: "p", text: "You save" }),
    el("e4", [0, 0, 1], [110, 140, 100, 40], { tag: "span", text: "NT$4,466" }),
    // too small to be a card (< 0.3 % of the page)
    el("e5", [1], [0, 0, 40, 40]),
    el("e6", [1, 0], [0, 0, 10, 10], { tag: "span", text: "a" }),
    el("e7", [1, 1], [0, 0, 10, 10], { tag: "span", text: "b" }),
  ],
};

test("cardsOf: two labelled things inside, 0.3–20 % of the page, the outermost of one box", () => {
  assert.deepEqual([...cardsOf(index)], ["e1"]);
  const byPath = new Map(index.elements.map((e) => [e.path.join("."), e]));
  assert.deepEqual([...cardsOf(index, byPath)], ["e1"], "the lookup can be passed in");
  // 30 % of the page: over the 20 % cardsOf keeps by default, inside a raised ceiling
  const big: StateIndex = {
    ...index,
    elements: index.elements.map((e) =>
      e.id === "e1" || e.id === "e2" ? { ...e, box: [0, 0, 600, 500] as typeof e.box } : e,
    ),
  };
  assert.deepEqual([...cardsOf(big)], []);
  assert.deepEqual([...cardsOf(big, undefined, { maxFrac: 0.4 })], ["e1"]);
});

test("componentProbeExpression hands the page script this state's cards", () => {
  const x = componentProbeExpression(index, { minArea: 0.001 });
  assert.ok(x.startsWith(`(${COMPONENT_PROBE_JS})(`));
  assert.ok(x.endsWith(`(${JSON.stringify({ cards: ["e1"], minArea: 0.001 })})`));
  // the page script is a function expression that parses
  assert.equal(typeof new Function(`return (${COMPONENT_PROBE_JS})`)(), "function");
});

test("pictureClip: ink or box ± pad, inside the viewport, 3× unless that passes the side cap", () => {
  const vp = { w: 1000, h: 800 };
  const lift = { around: "clear" as const, box: "ink" as const, pad: 8 };
  assert.deepEqual(pictureClip({ box: [100, 100, 300, 40], ink: [120, 104, 80, 30], lift }, vp), {
    clip: [112, 96, 96, 46],
    scale: 3,
  });
  assert.deepEqual(
    pictureClip({ box: [100, 100, 300, 40], lift: { ...lift, box: "box" } }, vp)?.clip,
    [92, 92, 316, 56],
    "box when asked (or when there is no ink)",
  );
  assert.deepEqual(
    pictureClip({ box: [-50, 780, 200, 100], lift }, vp)?.clip,
    [0, 772, 158, 28],
    "clamped to the viewport",
  );
  assert.equal(pictureClip({ box: [0, 0, 1000, 800], lift }, vp)?.scale, 3);
  assert.equal(pictureClip({ box: [0, 0, 1000, 800], lift }, vp, { maxSide: 2000 })?.scale, 2);
  assert.equal(pictureClip({ box: [1200, 900, 10, 10], lift }, vp), null, "off screen");
});
