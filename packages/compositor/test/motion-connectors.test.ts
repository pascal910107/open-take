import assert from "node:assert/strict";
import test from "node:test";
import { launchTemplate } from "../src/launch-template";
import type { LaunchComposition } from "../src/launch-types";
import { validateLaunchComposition } from "../src/launch-validate";
import { analyzeMotionQuality } from "../src/motion-quality";
import type { MotionImageLayer, MotionLayer, MotionLineLayer } from "../src/motion-types";

const image = (extra: Partial<MotionImageLayer> = {}): MotionImageLayer => ({
  id: "media",
  type: "image",
  asset: "screen.png",
  width: 100,
  height: 80,
  ...extra,
});
const line = (extra: Partial<MotionLineLayer> = {}): MotionLineLayer => ({
  id: "connector",
  type: "line",
  points: [
    [-90, 0],
    [90, 0],
  ],
  stroke: "#de3b3d",
  ...extra,
});
function composition(layers: MotionLayer[], durationS = 4): LaunchComposition {
  return { ...launchTemplate(), scenes: [{ id: "scene", type: "motion", durationS, layers }] };
}
const warnings = (value: LaunchComposition) =>
  analyzeMotionQuality(value).filter((issue) =>
    issue.message.startsWith("Possible obscuring or ambiguous connector"),
  );

test("foreground crossing is advisory, identifies the media and gives a local timestamp", () => {
  const value = composition([image(), line()]);
  assert.deepEqual(validateLaunchComposition(value), []);
  const issues = warnings(value);
  assert.equal(issues.length, 1);
  assert.equal(issues[0]!.severity, "warn");
  assert.equal(issues[0]!.path, "scenes[0].layers[1]");
  assert.match(issues[0]!.message, /media "media".*scene-local \d+\.\d+s/);
  assert.match(issues[0]!.message, /Inspect the actual media and omit or reposition/);
  assert.match(issues[0]!.message, /does not establish text or semantic overlap/);
});

test("video bounds and nested rotated/scaled groups use composed transforms", () => {
  const value = composition([
    {
      id: "outer",
      type: "group",
      x: 80,
      y: 40,
      rotation: 35,
      scaleX: 1.5,
      scaleY: 0.8,
      children: [
        {
          id: "inner",
          type: "group",
          x: 30,
          rotation: -12,
          children: [
            { id: "video", type: "video", asset: "clip.mp4", width: 100, height: 80, durationS: 4 },
            line(),
          ],
        },
      ],
    },
  ]);
  assert.deepEqual(validateLaunchComposition(value), []);
  assert.equal(warnings(value).length, 1);
});

test("paint order, invisible paint and inherited visibility suppress warnings", () => {
  assert.deepEqual(warnings(composition([line(), image()])), []);
  for (const connector of [
    line({ opacity: 0 }),
    line({ stroke: "#de3b3d00" }),
    line({ strokeWidth: 0 }),
    line({ scaleX: 0, scaleY: 0 }),
  ]) {
    assert.deepEqual(warnings(composition([image(), connector])), []);
  }
  assert.deepEqual(warnings(composition([image({ opacity: 0 }), line()])), []);
  assert.deepEqual(
    warnings(
      composition([image(), { id: "hidden", type: "group", opacity: 0, children: [line()] }]),
    ),
    [],
  );
  assert.deepEqual(
    warnings(
      composition([{ id: "hidden", type: "group", opacity: 0, children: [image()] }, line()]),
    ),
    [],
  );
});

test("polyline bounding-box overlap alone and media edge touches do not warn", () => {
  assert.deepEqual(
    warnings(
      composition([
        image(),
        line({
          points: [
            [-90, -60],
            [90, -60],
            [90, 60],
          ],
        }),
      ]),
    ),
    [],
  );
  assert.deepEqual(
    warnings(
      composition([
        image(),
        line({
          points: [
            [-90, -40],
            [90, -40],
          ],
        }),
      ]),
    ),
    [],
  );
  assert.deepEqual(
    warnings(
      composition([
        image(),
        line({
          points: [
            [-90, 0],
            [-50, 0],
          ],
        }),
      ]),
    ),
    [],
  );
  assert.deepEqual(
    warnings(
      composition([
        image({ width: 100, height: 20, rotation: 45 }),
        line({
          points: [
            [35, -35],
            [45, -35],
          ],
        }),
      ]),
    ),
    [],
  );
});

test("only the revealed arc length of a polyline is considered", () => {
  const connector = line({
    points: [
      [-100, -80],
      [100, -80],
      [0, 0],
    ],
    end: 0.5,
  });
  assert.deepEqual(warnings(composition([image(), connector])), []);
  connector.end = 1;
  assert.equal(warnings(composition([image(), connector])).length, 1);
  connector.end = 0;
  assert.deepEqual(warnings(composition([image(), connector])), []);
});

test("line and media clipping, rotated clip geometry and offscreen content are honored", () => {
  const mediaClip: MotionLayer = {
    id: "crop",
    type: "group",
    clip: true,
    width: 20,
    height: 20,
    children: [image()],
  };
  assert.deepEqual(warnings(composition([mediaClip, line({ y: 30 })])), []);
  assert.equal(warnings(composition([mediaClip, line()])).length, 1);
  assert.deepEqual(
    warnings(
      composition([
        image(),
        {
          id: "line-crop",
          type: "group",
          x: -90,
          clip: true,
          width: 20,
          height: 30,
          children: [
            line({
              points: [
                [0, 0],
                [200, 0],
              ],
            }),
          ],
        },
      ]),
    ),
    [],
  );
  assert.deepEqual(
    warnings(
      composition([
        {
          id: "rotated-crop",
          type: "group",
          rotation: 45,
          clip: true,
          width: 120,
          height: 20,
          children: [image({ width: 200, height: 200 })],
        },
        line({
          points: [
            [35, -40],
            [45, -40],
          ],
        }),
      ]),
    ),
    [],
  );
  assert.deepEqual(
    warnings(
      composition([{ id: "offscreen", type: "group", x: 2000, children: [image(), line()] }]),
    ),
    [],
  );
  assert.deepEqual(
    warnings(
      composition([
        {
          id: "empty-crop",
          type: "group",
          clip: true,
          width: 20,
          height: 20,
          children: [image({ x: 150 })],
        },
        line({ x: 150 }),
      ]),
    ),
    [],
  );
});

test("known opaque shapes hiding either the media or foreground line suppress the crossing", () => {
  const cover: MotionLayer = {
    id: "cover",
    type: "rect",
    width: 120,
    height: 100,
    fill: "#ffffff",
  };
  assert.deepEqual(warnings(composition([image(), cover, line()])), []);
  assert.deepEqual(warnings(composition([image(), line(), cover])), []);
  assert.equal(warnings(composition([image(), line(), { ...cover, opacity: 0.5 }])).length, 1);
});

test("crossings confined to entrances and brief visible flashes do not warn", () => {
  assert.deepEqual(
    warnings(
      composition(
        [
          image(),
          line({
            animations: [
              {
                property: "x",
                keyframes: [
                  { atS: 0, value: -200 },
                  { atS: 1, value: 200 },
                ],
              },
            ],
          }),
        ],
        1,
      ),
    ),
    [],
  );
  assert.deepEqual(
    warnings(
      composition([
        image(),
        line({
          opacity: 0,
          animations: [
            {
              property: "opacity",
              keyframes: [
                { atS: 0, value: 0 },
                { atS: 1, value: 1, easing: "step" },
                { atS: 1.1, value: 0, easing: "step" },
              ],
            },
          ],
        }),
      ]),
    ),
    [],
  );
});

test("keyed sampling finds a short useful hold in a very long scene; motion off uses base values", () => {
  const value = composition(
    [
      image(),
      line({
        opacity: 0,
        animations: [
          {
            property: "opacity",
            keyframes: [
              { atS: 0, value: 0 },
              { atS: 100.2, value: 1, easing: "step" },
              { atS: 101, value: 0, easing: "step" },
            ],
          },
        ],
      }),
    ],
    86400,
  );
  assert.equal(warnings(value).length, 1);
  if (value.scenes[0]?.type === "motion") value.scenes[0].motion = "off";
  assert.deepEqual(warnings(value), []);
});

test("moving media followed by a revealed connector hold is sampled after both settle", () => {
  const value = composition(
    [
      {
        id: "workspace",
        type: "group",
        x: 500,
        scaleX: 0.33,
        scaleY: 0.33,
        animations: [
          {
            property: "x",
            keyframes: [
              { atS: 0, value: 460 },
              { atS: 4.6, value: 460 },
              { atS: 5.45, value: 565, easing: "ease-in-out" },
            ],
          },
        ],
        children: [image({ width: 1920, height: 1080 })],
      },
      line({
        points: [
          [240, 245],
          [300, 245],
          [300, 160],
          [336, 160],
        ],
        opacity: 0,
        animations: [
          {
            property: "opacity",
            keyframes: [
              { atS: 0, value: 0 },
              { atS: 5.1, value: 1, easing: "step" },
              { atS: 10.86, value: 0, easing: "step" },
            ],
          },
          {
            property: "end",
            keyframes: [
              { atS: 0, value: 0 },
              { atS: 5.1, value: 0 },
              { atS: 5.8, value: 1 },
            ],
          },
        ],
      }),
    ],
    12,
  );
  const issues = warnings(value);
  assert.equal(issues.length, 1);
  const time = Number(issues[0]!.message.match(/scene-local (\d+\.\d+)s/)![1]);
  assert.ok(time >= 5.8 && time <= 10.86);
  assert.deepEqual(
    warnings(
      composition([value.scenes[0]!.type === "motion" ? value.scenes[0]!.layers[0]! : image()], 12),
    ),
    [],
  );
});

test("dense candidate graphs and long polylines have bounded geometric work", {
  timeout: 5000,
}, () => {
  const layers: MotionLayer[] = Array.from({ length: 100 }, (_, i) => image({ id: `media-${i}` }));
  for (let i = 0; i < 100; i++)
    layers.push(
      line({
        id: `line-${i}`,
        points: Array.from({ length: 1024 }, (_, j) =>
          j % 4 === 0 ? [-100, -100] : j % 4 === 2 ? [100, 100] : [100, -100],
        ),
      }),
    );
  // Bounding boxes overlap, but every actual segment stays outside the media.
  assert.deepEqual(warnings(composition(layers)), []);
});
