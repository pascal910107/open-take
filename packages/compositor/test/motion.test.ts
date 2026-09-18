import assert from "node:assert/strict";
import test from "node:test";
import { launchTemplate } from "../src/launch-template";
import { validateLaunchComposition } from "../src/launch-validate";
import { evaluateMotionScene, evaluateMotionTrack, motionGraphemes } from "../src/motion-evaluate";
import type { MotionLayer, MotionScene, MotionTrack } from "../src/motion-types";
import { validateMotionScene } from "../src/motion-validate";

const scene = (layers: MotionLayer[]): MotionScene => ({
  id: "motion",
  type: "motion",
  durationS: 2,
  layers,
});
const rect = (): MotionLayer => ({ id: "box", type: "rect", width: 120, height: 80 });
function freeze(value: unknown): void {
  if (value && typeof value === "object") {
    Object.freeze(value);
    for (const child of Object.values(value)) freeze(child);
  }
}

test("motion evaluation defaults, paint order and nested transforms preserve immutable input", () => {
  const s = scene([
    {
      id: "group",
      type: "group",
      x: 40,
      rotation: 15,
      clip: true,
      width: 400,
      height: 300,
      children: [
        rect(),
        { id: "label", type: "text", text: "Hello", width: 200, height: 60, fontSize: 32 },
      ],
    },
    {
      id: "path",
      type: "line",
      points: [
        [0, 0],
        [20, 20],
      ],
    },
  ]);
  freeze(s);
  const result = evaluateMotionScene(s, 0.5),
    group = result.layers[0]!;
  assert.deepEqual(result.designSize, { width: 1920, height: 1080 });
  assert.equal(group.type, "group");
  if (group.type !== "group") return;
  assert.equal(group.x, 40);
  assert.equal(group.rotation, 15);
  assert.equal(group.opacity, 1);
  assert.equal(group.scaleX, 1);
  assert(group.clip);
  assert.deepEqual(
    group.children.map((x) => x.id),
    ["box", "label"],
  );
  assert.equal(group.children[0]!.x, 0, "child coordinates remain local to parent");
  const label = group.children[1]!;
  assert.equal(label.type, "text");
  if (label.type === "text") {
    assert.equal(label.align, "center");
    assert.equal(label.lineHeight, 38.4);
    assert.equal(label.fullText, "Hello");
  }
  assert(!("animations" in group));
  assert.notEqual(
    group.children,
    s.layers[0]!.type === "group" ? s.layers[0]!.children : undefined,
  );
});

test("destination easing, boundaries, step and endpoint holds are deterministic", () => {
  const track: MotionTrack = {
    property: "x",
    keyframes: [
      { atS: 0, value: 0, easing: "ease-out" },
      { atS: 1, value: 100, easing: "ease-in" },
      { atS: 2, value: 200, easing: "step" },
    ],
  };
  assert.equal(evaluateMotionTrack(track, -1), 0);
  assert.equal(evaluateMotionTrack(track, 0.5), 12.5);
  assert.equal(evaluateMotionTrack(track, 1), 100);
  assert.equal(evaluateMotionTrack(track, 1.999), 100);
  assert.equal(evaluateMotionTrack(track, 2), 200);
  assert.equal(evaluateMotionTrack(track, 30), 200);
  track.keyframes[1]!.easing = "ease-out";
  assert.equal(evaluateMotionTrack(track, 0.5), 87.5);
  track.keyframes[1]!.easing = "ease-in-out";
  assert.equal(evaluateMotionTrack(track, 0.5), 50);
});

test("RGBA channels interpolate and motion off uses useful base values", () => {
  const s = scene([
    {
      id: "box",
      type: "rect",
      width: 200,
      height: 100,
      x: 80,
      fill: "#123456",
      animations: [
        {
          property: "x",
          keyframes: [
            { atS: 0, value: -1000 },
            { atS: 2, value: 80 },
          ],
        },
        {
          property: "fill",
          keyframes: [
            { atS: 0, value: "#ff000000" },
            { atS: 2, value: "rgba(0,0,255,1)" },
          ],
        },
      ],
    },
  ]);
  const moving = evaluateMotionScene(s, 1).layers[0]!;
  assert.equal(moving.x, -460);
  assert.equal(moving.type === "rect" && moving.fill, "rgba(127.5,0,127.5,0.5)");
  s.motion = "off";
  const still = evaluateMotionScene(s, 0).layers[0]!;
  assert.equal(still.x, 80);
  assert.equal(still.type === "rect" && still.fill, "#123456");
});

test("Unicode reveal preserves combining marks, emoji families and flags", () => {
  const text = "A👨‍👩‍👧‍👦e\u0301🇹🇼漢";
  assert.equal(motionGraphemes(text).length, 5);
  const s = scene([
    {
      id: "copy",
      type: "text",
      text,
      width: 600,
      height: 80,
      fontSize: 40,
      animations: [
        {
          property: "reveal",
          keyframes: [
            { atS: 0, value: 0 },
            { atS: 2, value: 1 },
          ],
        },
      ],
    },
  ]);
  const middle = evaluateMotionScene(s, 1.2).layers[0]!;
  assert.equal(middle.type === "text" && middle.text, "A👨‍👩‍👧‍👦e\u0301");
  assert.equal(middle.type === "text" && middle.fullText, text);
  s.motion = "off";
  assert.equal((evaluateMotionScene(s, 0).layers[0] as { text: string }).text, text);
});

test("motion video derives bounded media time while motion off freezes only geometry", () => {
  const s = scene([
    {
      id: "operation",
      type: "video",
      asset: "operation.mp4",
      width: 960,
      height: 540,
      trimStartS: 3,
      startS: 0.5,
      durationS: 1,
      x: 40,
      shadow: { color: "#00000033", blur: 24, offsetY: 12 },
      animations: [
        {
          property: "x",
          keyframes: [
            { atS: 0, value: -200 },
            { atS: 2, value: 40 },
          ],
        },
      ],
    },
  ]);
  const videoAt = (time: number) => {
    const layer = evaluateMotionScene(s, time).layers[0]!;
    assert.equal(layer.type, "video");
    if (layer.type !== "video") throw new Error("expected video");
    return layer;
  };
  assert.equal(videoAt(-1).mediaTimeS, 3, "pre-roll holds the first trimmed frame");
  assert.equal(videoAt(0.5).mediaTimeS, 3);
  assert.equal(videoAt(0.75).mediaTimeS, 3.25);
  assert.equal(videoAt(1.5).mediaTimeS, 4);
  assert.equal(videoAt(30).mediaTimeS, 4, "post-roll holds the clip endpoint");
  assert.equal(videoAt(1).fit, "contain");
  assert.equal(videoAt(1).radius, 0);
  assert.deepEqual(videoAt(1).shadow, { color: "#00000033", blur: 24, offsetY: 12 });
  assert.notEqual(
    videoAt(1).shadow,
    s.layers[0]!.type === "video" ? s.layers[0]!.shadow : undefined,
    "evaluated shadow does not alias authored JSON",
  );
  s.motion = "off";
  assert.equal(videoAt(1).x, 40, "motion off keeps authored geometry");
  assert.equal(videoAt(1).mediaTimeS, 3.5, "motion off does not pause real media");
});

test("clipped groups evaluate rounded masks and unclipped groups reject no-op radii", () => {
  const rounded = scene([
    {
      id: "window",
      type: "group",
      clip: true,
      width: 900,
      height: 560,
      radius: 24,
      animations: [
        {
          property: "radius",
          keyframes: [
            { atS: 0, value: 24 },
            { atS: 2, value: 48 },
          ],
        },
      ],
      children: [rect()],
    },
  ]);
  assert.deepEqual(validateMotionScene(rounded), []);
  const group = evaluateMotionScene(rounded, 1).layers[0]!;
  assert.equal(group.type, "group");
  assert.equal(group.type === "group" && group.radius, 36);

  const staticRadius = validateMotionScene(
    scene([{ id: "plain", type: "group", radius: 20, children: [rect()] }]),
  );
  assert(staticRadius.some((issue) => issue.path === "$.layers[0].radius"));
  const animatedRadius = validateMotionScene(
    scene([
      {
        id: "plain",
        type: "group",
        children: [rect()],
        animations: [{ property: "radius", keyframes: [{ atS: 0, value: 20 }] }],
      },
    ]),
  );
  assert(animatedRadius.some((issue) => issue.path === "$.layers[0].animations[0].property"));
});

test("motion scenes join existing launch validation without mandatory scene vocabulary", () => {
  const c = launchTemplate();
  c.scenes = [scene([rect()])];
  c.audio = [];
  assert.deepEqual(validateLaunchComposition(c), []);
  c.scenes[0]!.designSize = { width: 1080, height: 1920 };
  assert.deepEqual(evaluateMotionScene(c.scenes[0]!, 0).designSize, { width: 1080, height: 1920 });
});

test("unknown JSON and nested invalid properties report exact paths without evaluator crashes", () => {
  const s = {
    id: "bad",
    type: "motion",
    durationS: 2,
    layers: [
      null,
      { id: "g", type: "group", children: [false, { id: 3, type: "unknown" }] },
      {
        id: "box",
        type: "rect",
        width: 20,
        height: 20,
        onclick: "code",
        animations: [
          { property: "reveal", keyframes: [] },
          { property: "x", keyframes: [null] },
        ],
      },
    ],
  };
  const paths = validateMotionScene(s, "scenes[1]").map((x) => x.path);
  for (const p of [
    "scenes[1].layers[0]",
    "scenes[1].layers[1].children[0]",
    "scenes[1].layers[1].children[1].id",
    "scenes[1].layers[2].onclick",
    "scenes[1].layers[2].animations[0].property",
    "scenes[1].layers[2].animations[1].keyframes[0]",
  ])
    assert(paths.includes(p), p);
  for (const value of [null, 1, [], { layers: null }, { layers: [3] }])
    assert.doesNotThrow(() => validateMotionScene(value));
});

test("animated dimensions, colors, text fit and keyframe ordering are validated", () => {
  const s = scene([
    {
      id: "copy",
      type: "text",
      text: "Readable copy",
      width: 300,
      height: 70,
      fontSize: 24,
      animations: [
        {
          property: "fontSize",
          keyframes: [
            { atS: 0.1, value: 240 },
            { atS: 0.1, value: -20 },
          ],
        },
        { property: "fill", keyframes: [{ atS: 0, value: "rgb(999,0,0)" }] },
        {
          property: "fontSize",
          keyframes: [
            { atS: 0, value: 20 },
            { atS: 3, value: 30 },
          ],
        },
      ],
    },
  ]);
  const issues = validateMotionScene(s);
  for (const suffix of [
    "keyframes[0].atS",
    "keyframes[1].atS",
    "keyframes[1].value",
    "keyframes[0].value",
    "animations[2].property",
    ".text",
  ])
    assert(
      issues.some((x) => x.path.endsWith(suffix)),
      suffix,
    );
});

test("recursive limits, duplicate IDs and excessive keyframes are rejected", () => {
  const duplicates = scene([{ id: "g", type: "group", children: [rect()] }, rect()]);
  assert(validateMotionScene(duplicates).some((x) => x.path === "$.layers[1].id"));
  assert(
    validateMotionScene(
      scene(Array.from({ length: 257 }, (_, i) => ({ ...rect(), id: `r${i}` }))),
    ).some((x) => x.message.includes("256-layer")),
  );
  let child: MotionLayer = rect();
  for (let i = 0; i < 9; i++) child = { id: `g${i}`, type: "group", children: [child] };
  assert(validateMotionScene(scene([child])).some((x) => x.message.includes("depth of 8")));
  const many = {
    ...rect(),
    animations: [
      {
        property: "x",
        keyframes: Array.from({ length: 129 }, (_, i) => ({ atS: i / 100, value: i })),
      },
    ],
  };
  assert(
    validateMotionScene(scene([many as MotionLayer])).some((x) => x.path.endsWith("keyframes")),
  );
});

test("motion video validates local formats, bounded spans and recursive count", () => {
  const valid = scene([
    {
      id: "clip",
      type: "video",
      asset: "real operation.webm",
      width: 640,
      height: 360,
      trimStartS: 2,
      startS: 0.25,
      durationS: 1.5,
      fit: "cover",
      shadow: { color: "rgba(0,0,0,0.2)", blur: 32, offsetX: 4, offsetY: 16 },
    },
  ]);
  assert.deepEqual(validateMotionScene(valid), []);

  const invalid = scene([
    {
      id: "bad-clip",
      type: "video",
      asset: "https://example.com/operation.mp4",
      width: 640,
      height: 360,
      trimStartS: -1,
      startS: 2.1,
      durationS: 0.2,
      shadow: { color: "named-color", blur: 300, offsetX: 600 },
    },
  ]);
  const issues = validateMotionScene(invalid);
  for (const suffix of [
    ".asset",
    ".trimStartS",
    ".startS",
    ".durationS",
    ".shadow.color",
    ".shadow.blur",
    ".shadow.offsetX",
  ])
    assert(
      issues.some((issue) => issue.path.endsWith(suffix)),
      suffix,
    );

  const tooMany = scene([
    {
      id: "video-group",
      type: "group",
      children: Array.from({ length: 9 }, (_, i) => ({
        id: `video-${i}`,
        type: "video" as const,
        asset: `clip-${i}.mov`,
        width: 320,
        height: 180,
        durationS: 1,
      })),
    },
  ]);
  assert(
    validateMotionScene(tooMany).some((issue) => issue.message.includes("8-video layer limit")),
  );
  assert(
    validateMotionScene({
      ...valid,
      layers: [{ id: "missing-duration", type: "video", asset: "clip.mp4", width: 2, height: 2 }],
    }).some((issue) => issue.path === "$.layers[0].durationS"),
  );
});
