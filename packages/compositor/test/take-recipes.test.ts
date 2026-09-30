// Recipes whose material is a recording with saved screens: the brief names
// actions and an element; the program places, times and joins everything.
// The take here is synthetic (a capture log and three saved screens in
// memory), shaped like `make --states` writes them.

import assert from "node:assert/strict";
import { test } from "node:test";
import { evaluateMotionTrack } from "../src/motion-evaluate";
import { composeMotionStory } from "../src/motion-recipes";
import type { MotionLayer, MotionScene } from "../src/motion-types";
import type { StateElement, StateIndex } from "../src/state-index";
import type { TakeMaterial } from "../src/take-recipes";
import type { CaptureLog } from "../src/types";

const el = (
  id: string,
  path: number[],
  tag: string,
  box: [number, number, number, number],
  extra: Partial<StateElement> = {},
): StateElement => ({ id, path, tag, box, ...extra });
const state = (id: string, tMs: number, elements: StateElement[], ok = true): StateIndex => ({
  version: 1,
  id,
  url: "http://127.0.0.1:5173/",
  title: "App",
  tMs,
  viewport: { w: 1920, h: 1080, dpr: 2 },
  scroll: { x: 0, y: 0 },
  elements,
  layers: [],
  fidelity: { psnr: ok ? 40 : 20, diffFrac: ok ? 0 : 0.4, ok },
});
// a page: a stage on the left (its preview box changes), a settings card on
// the right (its value changes)
const page = (value: string, previewW: number) => [
  el("e0", [1], "body", [0, 0, 1920, 1080]),
  el("e1", [1, 0], "div", [200, 200, 800, 600]),
  el("e2", [1, 0, 0], "div", [300, 300, previewW, 300]),
  el("e3", [1, 1], "div", [1500, 150, 300, 200]),
  el("e4", [1, 1, 0], "b", [1520, 170, 200, 20], { text: "Settings" }),
  el("e5", [1, 1, 1], "span", [1520, 220, 100, 20], { text: "Depth" }),
  el("e6", [1, 1, 2], "span", [1700, 220, 60, 20], { text: value }),
  el("e7", [1, 1, 3], "button", [1520, 280, 120, 40], {
    role: "button",
    name: "Save",
    text: "Save",
    interactive: true,
  }),
];
const capture: CaptureLog = {
  video: { width: 3840, height: 2160, fps: 60 },
  viewport: { w: 1920, h: 1080 },
  start: { x: 960, y: 900 },
  events: [
    { kind: "click", x: 400, y: 900, tMs: 2000, sel: "Open", state: "s1" },
    {
      kind: "drag",
      x: 1600,
      y: 230,
      to: { x: 1560, y: 230 },
      tMs: 5000,
      durationMs: 800,
      sel: "input[type=range]",
      state: "s2",
      effectBox: { x: 300, y: 300, w: 400, h: 300 },
    },
    { kind: "click", x: 1580, y: 300, tMs: 12000, sel: "Save", state: "s3" },
  ],
  states: {
    dir: "states",
    items: [
      { id: "s1", tMs: 3500 },
      { id: "s2", tMs: 7000 },
      { id: "s3", tMs: 13500 },
    ],
  },
} as CaptureLog;
const states = new Map([
  ["s1", state("s1", 3500, page("2.2×", 300))],
  ["s2", state("s2", 7000, page("1.6×", 400))],
  ["s3", state("s3", 13500, page("1.6×", 400))],
]);
const take = (over: Partial<TakeMaterial> = {}): TakeMaterial => ({
  path: "demo.take",
  capture,
  states,
  ...over,
});

const brief = (scenes: unknown[], loader: (path: string) => TakeMaterial | string = () => take()) =>
  composeMotionStory(
    {
      version: 1,
      output: { width: 1920, height: 1080, fps: 30 },
      theme: {
        canvas: "#0e0e12",
        ink: "#f2f2f5",
        surface: "#16161c",
        accent: "#7c5cff",
        dark: "#0e0e12",
        fontFamily: "Helvetica",
      },
      scenes,
    },
    { take: loader },
  );
const errors = (r: ReturnType<typeof brief>) =>
  r.issues.filter((i) => i.severity === "error").map((i) => `${i.path}: ${i.message}`);
const walk = (layers: MotionLayer[]): MotionLayer[] =>
  layers.flatMap((l) => (l.type === "group" ? [l, ...walk(l.children)] : [l]));
const find = (scene: MotionScene, id: string) => walk(scene.layers).find((l) => l.id === id)!;
const keys = (l: MotionLayer, p: string) =>
  l.animations?.find((t) => t.property === p)?.keyframes ?? [];

const at = (l: MotionLayer, p: string, t: number) =>
  evaluateMotionTrack(l.animations!.find((k) => k.property === p)!, t) as number;
/** where the camera group looks (page CSS px) and how close, at scene second t */
const lookAt = (scene: MotionScene, t: number) => {
  const cam = scene.layers[0]!;
  const s = at(cam, "scaleX", t);
  return { x: 960 - at(cam, "x", t) / s, y: 540 - at(cam, "y", t) / s, scale: s };
};

test("a proof plays the recording through the take's own camera and cursor, from a beat before the hand moves", () => {
  const r = brief([{ recipe: "proof", id: "open", take: "demo.take", from: "a1" }]);
  assert.deepEqual(errors(r), []);
  const scene = r.composition!.scenes[0] as MotionScene;
  const camera = scene.layers[0] as Extract<MotionLayer, { type: "group" }>;
  assert.equal(camera.camera, true, "the scene is framed by a camera group");
  const rec = find(scene, "open-rec") as Extract<MotionLayer, { type: "video" }>;
  // a beat before the cursor leaves for the click at 2 s, until its result settled (s1, 3.5 s)
  assert.ok(rec.trimStartS! > 0.3 && rec.trimStartS! < 1.2, `starts ${rec.trimStartS}`);
  assert.equal(Math.round((rec.trimStartS! + rec.durationS) * 1000), 3500);
  // the cursor is on the click as it happens, a ripple spreading from it
  const click = 2 - rec.trimStartS!;
  const cursor = find(scene, "open-cursor");
  assert.ok(Math.abs(at(cursor, "x", click) - (400 - 960)) < 2, "cursor x on the click");
  assert.ok(Math.abs(at(cursor, "y", click) - (900 - 540)) < 2, "cursor y on the click");
  assert.ok(Math.abs(keys(find(scene, "open-ripple-1"), "opacity")[1]!.atS - click) < 1e-3);
});

test("cause, then effect: the camera frames the hand through the action, then looks at the result it changed", () => {
  const r = brief([{ recipe: "proof", id: "all", take: "demo.take", from: "a2", to: "a3" }]);
  assert.deepEqual(errors(r), []);
  const [one, two] = r.composition!.scenes as MotionScene[];
  const rec = find(one!, "all-1-rec") as Extract<MotionLayer, { type: "video" }>;
  const t = (capture: number) => capture - rec.trimStartS!;
  // the drag at 5.0–5.8 s happens at the right edge; what it changed is on the left
  const hand = lookAt(one!, t(5.4));
  assert.ok(
    hand.scale > 1.5 && hand.x > 1300,
    `on the hand during the drag: ${JSON.stringify(hand)}`,
  );
  const result = lookAt(one!, t(7.6));
  assert.ok(result.x < 800, `then on the result: ${JSON.stringify(result)}`);
  // the idle stretch before the next action is cut — onto a new framing
  assert.ok(two, "a second shot");
  const next = find(two!, "all-2-rec") as Extract<MotionLayer, { type: "video" }>;
  assert.ok(next.trimStartS! > rec.trimStartS! + rec.durationS + 1.5, "the wait is gone");
  const before = lookAt(one!, one!.durationS),
    after = lookAt(two!, 0);
  assert.ok(
    Math.abs(Math.log(before.scale / after.scale)) > Math.log(1.25) ||
      Math.hypot(before.x - after.x, before.y - after.y) * Math.min(before.scale, after.scale) >
        480,
    `the cut lands on a new framing: ${JSON.stringify({ before, after })}`,
  );
});

test("a lift raises the element clear of what the action changes, shows the change in place, and hands back", () => {
  const r = brief([
    { recipe: "lift", id: "card", take: "demo.take", after: "a1", element: "e3", change: "a2" },
  ]);
  assert.deepEqual(errors(r), []);
  const scene = r.composition!.scenes[0] as MotionScene;
  const lift = find(scene, "card-lift");
  const x = keys(lift, "x"),
    scale = keys(lift, "scaleX");
  // it rests where the card is on the page (centred page px): x 1500−8 … 1800+8
  assert.equal(x[0]!.value, (1492 + 1808) / 2 - 960);
  // the change happens on the left (the preview box, and the drag's pixels):
  // the card lands on the right half, big
  const landed = x[2]!.value as number;
  assert.ok(landed > 0, `lands right of centre (${landed})`);
  assert.ok((scale[2]!.value as number) > 1.5, `grows (${scale[2]!.value})`);
  // the element as it was, then as the change left it (s2) — same place
  const before = find(scene, "card-lifted") as Extract<MotionLayer, { type: "state" }>;
  const after = find(scene, "card-lifted-after") as Extract<MotionLayer, { type: "state" }>;
  assert.equal(before.state, "demo.take/states/s1");
  assert.equal(after.state, "demo.take/states/s2");
  assert.deepEqual(before.only, ["e3"]);
  assert.deepEqual(before.crop, after.crop);
  // the page behind has an empty slot while it is out
  const slot = find(scene, "card-page-slot") as Extract<MotionLayer, { type: "state" }>;
  assert.deepEqual(slot.hide, ["e3"]);
  // in and out on the recording, at its settled frames
  const recIn = find(scene, "card-rec-in") as Extract<MotionLayer, { type: "video" }>;
  const recOut = find(scene, "card-rec-out") as Extract<MotionLayer, { type: "video" }>;
  assert.equal(recIn.trimStartS! + recIn.durationS, 3.5);
  assert.equal(recOut.trimStartS, 7);
});

test("after a lift, a proof of a later action cuts onto its lead-in, the cursor where the drag left it", () => {
  const r = brief([
    { recipe: "lift", id: "card", take: "demo.take", after: "a1", element: "e3", change: "a2" },
    { recipe: "proof", id: "save", take: "demo.take", from: "a3" },
  ]);
  assert.deepEqual(errors(r), []);
  const [lift, proof] = r.composition!.scenes as MotionScene[];
  const out = find(lift!, "card-rec-out") as Extract<MotionLayer, { type: "video" }>;
  const rec = find(proof!, "save-rec") as Extract<MotionLayer, { type: "video" }>;
  // the click comes 5 s after the handback: too long to wait — a cut onto its lead-in
  assert.ok(rec.trimStartS! > out.trimStartS! + out.durationS, "the idle wait is cut");
  const cursor = find(proof!, "save-cursor");
  assert.ok(
    Math.abs(at(cursor, "x", 0) - (1560 - 960)) < 2,
    "the cursor starts where the drag left it",
  );
});

test("take recipes say what is wrong in the take's own terms", () => {
  const e = (scenes: unknown[], loader?: (p: string) => TakeMaterial | string) =>
    errors(brief(scenes, loader)).join("\n");
  assert.match(
    e([{ recipe: "proof", id: "p", take: "demo.take", from: "a9" }]),
    /a9: the take has 3 actions \(a1–a3\)/,
  );
  assert.match(
    e([{ recipe: "proof", id: "p", take: "demo.take", from: "Missing" }]),
    /no action "Missing" in the take/,
  );
  assert.match(
    e([{ recipe: "lift", id: "l", take: "demo.take", after: "a1", element: "e99" }]),
    /s1 \(after a1\) has no element "e99"/,
  );
  assert.match(
    e([{ recipe: "lift", id: "l", take: "demo.take", after: "a2", element: "e3", change: "a1" }]),
    /a1 must come after a2/,
  );
  const failed = new Map(states);
  failed.set("s1", state("s1", 3500, page("2.2×", 300), false));
  assert.match(
    e([{ recipe: "lift", id: "l", take: "demo.take", after: "a1", element: "e3" }], () =>
      take({ states: failed }),
    ),
    /s1 \(after a1\) does not re-render like the recording \(20\.0 dB\) — show this moment with a proof/,
  );
  // a moment the page was still moving at has no saved screen, by design
  const unsaved = new Map(states);
  unsaved.delete("s1");
  const movingLog = {
    ...capture,
    states: {
      dir: "states",
      items: capture.states!.items.map((i) =>
        i.id === "s1" ? { ...i, moving: true as const } : i,
      ),
    },
  } as CaptureLog;
  assert.match(
    e([{ recipe: "lift", id: "l", take: "demo.take", after: "a1", element: "e3" }], () =>
      take({ capture: movingLog, states: unsaved }),
    ),
    /the page was still moving after a1 \(s1 not saved\) — show that moment with a proof/,
  );
  const bare = { ...capture, states: undefined } as CaptureLog;
  assert.match(
    e([{ recipe: "lift", id: "l", take: "demo.take", after: "a1", element: "e3" }], () =>
      take({ capture: bare }),
    ),
    /demo\.take has no saved screens — record it with `make --states`/,
  );
  assert.match(
    e(
      [{ recipe: "proof", id: "p", take: "demo.take", from: "a1" }],
      () => "no recording at demo.take",
    ),
    /no recording at demo\.take/,
  );
  assert.match(
    e([{ recipe: "proof", id: "p", take: "demo.take", from: "a1", zoom: 2 }]),
    /zoom: unsupported recipe field/,
  );
});
