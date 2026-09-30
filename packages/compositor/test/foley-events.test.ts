// The compositor's timelines as open-foley event sheets. Pure translation —
// these pin that every kind of moment a take or a film knows about reaches
// the sound design at the right time, in the right vocabulary, and that
// nothing is invented (no camera move ⇒ no zoom event; footage without a
// recording beside it ⇒ only its entrance).

import assert from "node:assert/strict";
import { test } from "node:test";
import { captureEventSheet, launchEventSheet, takeEventSheet } from "../src/foley-events.js";
import type { LaunchComposition } from "../src/launch-types.js";
import { planComposition } from "../src/plan.js";
import type { CaptureLog } from "../src/types.js";

const VW = 1920,
  VH = 1080;

function log(events: CaptureLog["events"], tEndMs = 9000): CaptureLog {
  return {
    video: { width: VW, height: VH, fps: 60, durationS: tEndMs / 1000 },
    viewport: { w: VW, h: VH },
    start: { x: 200, y: 900 },
    events,
    tEndMs,
  };
}

const CAPTURE = log([
  { kind: "click", x: 300, y: 300, box: { x: 280, y: 280, w: 40, h: 40 }, tMs: 1000 },
  {
    kind: "type",
    x: 600,
    y: 400,
    box: { x: 500, y: 380, w: 400, h: 40 },
    tMs: 2000,
    durationMs: 1500,
    text: "hello world",
  },
  {
    kind: "press",
    x: 600,
    y: 400,
    box: { x: 500, y: 380, w: 400, h: 200 },
    tMs: 4000,
    durationMs: 400,
    keys: "Enter",
  },
  {
    kind: "click",
    x: 1700,
    y: 200,
    box: { x: 1680, y: 180, w: 40, h: 40 },
    tMs: 5500,
    changeCoverage: 0.9,
  },
  { kind: "drag", x: 400, y: 600, to: { x: 1400, y: 600 }, tMs: 6500, durationMs: 600 },
]);

test("a take's actions, camera and captions become events on the composition timeline", () => {
  const comp = planComposition(CAPTURE, { sound: { style: "cinematic" } });
  assert.deepEqual(comp.sound, { style: "cinematic" });
  const sheet = takeEventSheet(comp);
  const of = (kind: string) => sheet.events.filter((e) => e.kind === kind);

  assert.equal(of("click").length, 2);
  assert.equal(of("click")[0]!.atS, 1);
  // one keystroke per typed character, spread over the typing window
  const keys = of("key");
  assert.equal(keys.filter((k) => k.label === "type").length, "hello world".length);
  assert.ok(keys[0]!.atS > 2 && keys[keys.length - 2]!.atS < 3.5);
  // typing long enough to build tension gets a build window
  assert.equal(of("build").length, 1);
  assert.equal(of("build")[0]!.durationS, 1.5);
  // Enter with a located reveal: a keystroke and the result entering
  assert.ok(keys.some((k) => k.label === "Enter" && k.atS === 4));
  assert.ok(of("enter").some((e) => e.label?.startsWith("Enter")));
  // a click that repainted 90% of the frame is a transition
  assert.equal(of("transition").length, 1);
  assert.ok(Math.abs(of("transition")[0]!.atS - 5.6) < 0.01);
  // a drag across half the frame is a move with that extent
  const move = of("move")[0]!;
  assert.equal(move.atS, 6.5);
  assert.equal(move.durationS, 0.6);
  assert.ok(move.extent! > 0.5 && move.extent! < 0.55);
  // the camera zoomed on the click: at least one zoom-in and a final zoom-out
  assert.ok(of("zoom-in").length >= 1, "the director framed something");
  assert.ok(of("zoom-out").length >= 1, "the camera pulls out at the end");
  // pan is where it happened: the right-edge click leans right
  assert.ok(of("click")[1]!.pan! > 0.7);
  // sorted, on the untrimmed timeline, with the stage's own length
  for (let i = 1; i < sheet.events.length; i++)
    assert.ok(sheet.events[i]!.atS >= sheet.events[i - 1]!.atS);
  assert.ok(sheet.durationS >= comp.durationMs / 1000);
});

test("a raw capture speaks the same vocabulary on its own timeline", () => {
  const sheet = captureEventSheet(CAPTURE);
  const of = (kind: string) => sheet.events.filter((e) => e.kind === kind);
  assert.equal(of("click").length, 2);
  assert.equal(of("key").length, "hello world".length + 1);
  assert.equal(of("transition").length, 1);
  assert.equal(of("zoom-in").length, 0, "a capture has no camera");
  assert.equal(sheet.durationS, 9);
});

const FILM: LaunchComposition = {
  version: 1,
  output: { width: 1920, height: 1080, fps: 30 },
  theme: {
    canvas: "#fff",
    ink: "#111",
    surface: "#eee",
    accent: "#06f",
    dark: "#000",
    fontFamily: "Inter",
  },
  scenes: [
    { id: "open", type: "title", durationS: 3, lines: ["One", "Two"], staggerS: 0.3 },
    {
      id: "shot",
      type: "footage",
      durationS: 4,
      asset: "demo.mp4",
      trimStartS: 1,
      transition: { type: "fade", durationS: 0.4 },
    },
    {
      id: "graph",
      type: "motion",
      durationS: 4,
      transition: { type: "cut" },
      layers: [
        {
          id: "card",
          type: "rect",
          width: 800,
          height: 400,
          x: 200,
          y: 300,
          animations: [
            {
              property: "opacity",
              keyframes: [
                { atS: 0, value: 0 },
                { atS: 0.4, value: 1 },
              ],
            },
            {
              property: "x",
              keyframes: [
                { atS: 1, value: 200 },
                { atS: 1.6, value: 1000 },
              ],
            },
          ],
        },
        {
          id: "cursor",
          type: "image",
          asset: "cursor.png",
          width: 32,
          height: 42,
          animations: [
            {
              property: "x",
              keyframes: [
                { atS: 2, value: 100 },
                { atS: 2.5, value: 1800 },
              ],
            },
          ],
        },
        {
          id: "line",
          type: "text",
          text: "typed",
          width: 600,
          height: 60,
          fontSize: 40,
          animations: [
            {
              property: "reveal",
              keyframes: [
                { atS: 2, value: 0 },
                { atS: 3, value: 1 },
              ],
            },
            {
              property: "y",
              keyframes: [
                { atS: 2, value: 300 },
                { atS: 2.4, value: 0 },
              ],
            },
          ],
        },
      ],
    },
    { id: "close", type: "end-card", durationS: 3, headline: "Try it", brand: "x", cta: "go" },
  ],
  story: {
    intent: "launch",
    audience: "devs",
    takeaway: "it works",
    beats: [{ id: "b", sceneId: "graph", startS: 1.6, role: "payoff", message: "the card lands" }],
  },
};

test("a launch film's scenes, layers, footage and story become events on the film timeline", () => {
  const sheet = launchEventSheet(FILM, {
    takeFor: (asset) => (asset === "demo.mp4" ? { kind: "capture", log: CAPTURE } : undefined),
  });
  const of = (kind: string) => sheet.events.filter((e) => e.kind === kind);
  const at = (kind: string, t: number) => of(kind).find((e) => Math.abs(e.atS - t) < 0.011);

  assert.equal(sheet.durationS, 14);
  // the title notifies and enters its lines with the stagger
  assert.ok(at("notify", 0.05));
  assert.ok(at("enter", 0.3) && at("enter", 0.6));
  // every scene after the first is a transition, weighted by its type
  assert.equal(of("transition").filter((e) => e.label?.includes("(")).length, 3);
  assert.equal(at("transition", 3)!.intensity, 0.4);
  assert.equal(at("transition", 7)!.intensity, 0.6);
  // footage: the capture's first click was at 1.0 s of the recording; the
  // scene starts at 3 s and is trimmed by 1 s ⇒ film time 3.0
  assert.ok(at("click", 3), "the click inside the recording is scored");
  // ...and the click at 5.5 s falls inside the 4 s window (film 7.5)? No —
  // the scene ends at 7 s, so it is dropped
  assert.equal(of("click").filter((e) => e.label?.startsWith("shot")).length, 1);
  // motion: the card fades in (enter at the END of its fade) and slides
  assert.ok(at("enter", 7.4));
  const slide = of("move").find((e) => e.label === "card (slide)")!;
  assert.equal(slide.atS, 8);
  assert.equal(slide.durationS, 0.6);
  assert.ok(slide.extent! > 0.4);
  // a cursor-sized sprite crossing the frame and a line of text rising in
  // are not moves: the clicks and the entrance carry them, not a whoosh
  assert.equal(of("move").filter((e) => e.label === "cursor (slide)").length, 0);
  assert.equal(of("move").filter((e) => e.label === "line (slide)").length, 0);
  // a text reveal types its characters
  assert.equal(of("key").filter((e) => e.label === "line (reveal)").length, 5);
  // the story's payoff beat is the film's reveal; so is the end card
  assert.equal(of("reveal").length, 2);
  assert.ok(at("reveal", 8.6));
  assert.ok(at("reveal", 11.3));
  for (let i = 1; i < sheet.events.length; i++)
    assert.ok(sheet.events[i]!.atS >= sheet.events[i - 1]!.atS);
});

test("footage with no recording beside it only enters", () => {
  const sheet = launchEventSheet(FILM);
  const shot = sheet.events.filter((e) => e.label?.startsWith("shot"));
  assert.deepEqual(
    shot.map((e) => e.kind),
    ["transition", "enter"],
  );
});

test("a click's own indicator appearing is part of the click, not a second sound", () => {
  const film: LaunchComposition = {
    version: 1,
    output: { width: 1920, height: 1080, fps: 30 },
    theme: {
      canvas: "#fff",
      ink: "#111",
      surface: "#eee",
      accent: "#06f",
      dark: "#000",
      fontFamily: "Inter",
    },
    scenes: [
      {
        id: "m",
        type: "motion",
        durationS: 4,
        layers: [
          { id: "rec", type: "video", asset: "demo.mp4", width: 1600, height: 900, durationS: 4 },
          {
            id: "ripple",
            type: "ellipse",
            width: 40,
            height: 40,
            opacity: 0,
            animations: [
              {
                property: "opacity",
                keyframes: [
                  { atS: 1.95, value: 0 },
                  { atS: 2, value: 1 },
                ],
              },
            ],
          },
          {
            id: "card",
            type: "rect",
            width: 400,
            height: 300,
            opacity: 0,
            animations: [
              {
                property: "opacity",
                keyframes: [
                  { atS: 3, value: 0 },
                  { atS: 3.3, value: 1 },
                ],
              },
            ],
          },
        ],
      },
    ],
  };
  // the recording inside the film clicks at 2.0 s, exactly when the ripple appears
  const recording = log(
    [{ kind: "click", x: 300, y: 300, box: { x: 280, y: 280, w: 40, h: 40 }, tMs: 2000 }],
    4000,
  );
  const sheet = launchEventSheet(film, { takeFor: () => ({ kind: "capture", log: recording }) });
  assert.ok(sheet.events.some((e) => e.kind === "click" && Math.abs(e.atS - 2) < 0.01));
  assert.ok(
    !sheet.events.some((e) => e.kind === "enter" && e.label === "ripple"),
    "the ripple is the click",
  );
  assert.ok(
    sheet.events.some((e) => e.kind === "enter" && e.label === "card"),
    "a real arrival still sounds",
  );
  // without the click, the same ripple is an arrival
  const silentTake = launchEventSheet(film);
  assert.ok(silentTake.events.some((e) => e.kind === "enter" && e.label === "ripple"));
});

test("a slow linear push through a hold is not an entrance; a pop-in is", () => {
  const withGroup = (scale: { v0: number; v1: number; easing: string }) =>
    ({
      ...FILM,
      scenes: [
        {
          id: "m",
          type: "motion",
          durationS: 4,
          layers: [
            {
              id: "stage",
              type: "group",
              children: [],
              animations: [
                {
                  property: "scaleX",
                  keyframes: [
                    { atS: 0, value: scale.v0 },
                    { atS: 3, value: scale.v1, easing: scale.easing },
                  ],
                },
              ],
            },
          ],
        },
      ],
      story: undefined,
    }) as unknown as LaunchComposition;
  const enters = (c: LaunchComposition) =>
    launchEventSheet(c).events.filter((e) => e.kind === "enter" && e.label === "stage (scale)");
  assert.equal(enters(withGroup({ v0: 1, v1: 1.025, easing: "linear" })).length, 0);
  assert.equal(enters(withGroup({ v0: 0.6, v1: 1, easing: "spring" })).length, 1);
});
