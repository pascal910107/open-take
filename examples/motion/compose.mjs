// Different compositions from one public JSON vocabulary, with no custom scenes.
// Run after prepare-assets.mjs: node examples/motion/compose.mjs
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { launchDurationS, validateLaunchAssets } from "../../packages/compositor/dist/index.js";

const out = resolve(dirname(fileURLToPath(import.meta.url)), "../../out/motion-demo");
const manifest = JSON.parse(await readFile(join(out, "assets.json"), "utf8"));
const font = "Avenir Next, Avenir, Helvetica Neue, sans-serif";
const serif = "Georgia, Times New Roman, serif";
const theme = (canvas, ink, surface, accent, dark = ink) => ({
  canvas,
  ink,
  surface,
  accent,
  dark,
  fontFamily: font,
});
const track = (property, points) => ({
  property,
  keyframes: points.map(([atS, value, easing]) => ({ atS, value, ...(easing ? { easing } : {}) })),
});
const arrive = (at = 0) => [
  track("opacity", [[0, 0], ...(at ? [[at, 0]] : []), [at + 0.6, 1, "ease-out"]]),
];
const text = (id, copy, x, y, width, height, fontSize, props = {}) => ({
  id,
  type: "text",
  text: copy,
  x,
  y,
  width,
  height,
  fontSize,
  align: "left",
  ...props,
});
const rect = (id, x, y, width, height, props = {}) => ({
  id,
  type: "rect",
  x,
  y,
  width,
  height,
  strokeWidth: 0,
  ...props,
});
const line = (id, points, props = {}) => ({ id, type: "line", points, strokeWidth: 2, ...props });
const crop = (id, view, region, x, y, width, height, props = {}) => ({
  id,
  type: "image",
  asset: manifest.views[view].before,
  crop: manifest.views[view].crops[region],
  x,
  y,
  width,
  height,
  ...props,
});
const scene = (id, durationS, layers, props = {}) => ({
  id,
  type: "motion",
  durationS,
  transition: { type: "cut" },
  layers,
  ...props,
});
const composition = (colors, scenes, output = { width: 1920, height: 1080, fps: 30 }) => ({
  version: 1,
  output,
  theme: colors,
  scenes,
});

const commerce = composition(theme("#F5F0E7", "#292920", "#E8DFCF", "#986745"), [
  scene("compare-light", 6, [
    text("brand", "morrow.", -690, -425, 340, 75, 45, { fontWeight: 600 }),
    text("edition", "COLLECTION 04 / FIND YOUR LIGHT", 440, -425, 710, 55, 22, { align: "right" }),
    line(
      "rule",
      [
        [-855, -357],
        [855, -357],
      ],
      { stroke: "#B6AD9E", strokeWidth: 1 },
    ),
    text("headline", "Same warmth.\nDifferent character.", -370, -205, 970, 200, 76, {
      fontFamily: serif,
      animations: arrive(),
    }),
    text("description", "Two silhouettes,\none considered collection.", 610, -210, 470, 110, 30, {
      fill: "#706F64",
      animations: arrive(0.3),
    }),
    {
      id: "products",
      type: "group",
      y: 153,
      width: 1700,
      height: 540,
      clip: true,
      children: [
        crop("terra", "commerce", "terra", -422, 0, 790, 510, {
          animations: [
            track("x", [
              [0, -980],
              [1.15, -422, "ease-out"],
            ]),
            ...arrive(0.2),
          ],
        }),
        crop("orb", "commerce", "orb", 422, 0, 790, 510, {
          animations: [
            track("x", [
              [0, 980],
              [1.4, 422, "ease-out"],
            ]),
            ...arrive(0.45),
          ],
        }),
      ],
    },
    line(
      "divider",
      [
        [0, -55],
        [0, 402],
      ],
      { stroke: "#B6AD9E", strokeWidth: 1, animations: arrive(1) },
    ),
    text("caption-left", "FOCUSED / THE READING LIGHT", -425, 452, 810, 52, 21, {
      align: "center",
      animations: arrive(1.2),
    }),
    text("caption-right", "AMBIENT / THE EVENING LIGHT", 425, 452, 810, 52, 21, {
      align: "center",
      animations: arrive(1.45),
    }),
    text("source", "Original fixture · Illustrative products", 0, 512, 1500, 28, 14, {
      align: "center",
      fill: "#847B6E",
    }),
  ]),
]);

const analytics = composition(theme("#101925", "#ECF0F4", "#182433", "#DFFF82"), [
  scene("revenue-trend", 6.4, [
    text("brand", "northline /", -650, -421, 410, 80, 42, { fontWeight: 600 }),
    text("section", "A CLEARER VIEW OF YOUR STUDIO", 435, -421, 790, 60, 20, {
      align: "right",
      fill: "#9FACBA",
    }),
    text("headline", "Know what\nis working.", -560, -190, 610, 230, 78, {
      fontWeight: 500,
      animations: arrive(),
    }),
    text("metric", "$28,400", -568, 15, 610, 150, 112, {
      fontWeight: 500,
      animations: [
        track("y", [
          [0, 65],
          [1, 15, "ease-out"],
        ]),
        ...arrive(0.35),
      ],
    }),
    text("growth", "+24% this month", -560, 127, 610, 68, 30, {
      fill: "#DFFF82",
      animations: arrive(0.8),
    }),
    {
      id: "trend",
      type: "group",
      x: 350,
      y: -47,
      width: 970,
      height: 516,
      clip: true,
      children: [
        ...[-190, -65, 60, 185].map((y, i) =>
          line(
            `grid-${i}`,
            [
              [-480, y],
              [480, y],
            ],
            { stroke: "#344152", strokeWidth: 1 },
          ),
        ),
        line(
          "trend-path",
          [
            [-470, 175],
            [-385, 140],
            [-300, 152],
            [-215, 75],
            [-130, 101],
            [-45, 40],
            [40, 29],
            [125, -30],
            [210, -13],
            [295, -94],
            [380, -136],
            [465, -200],
          ],
          {
            strokeWidth: 7,
            animations: [
              track("end", [
                [0, 0],
                [0.6, 0],
                [3.4, 1, "ease-in-out"],
              ]),
            ],
          },
        ),
        {
          id: "last-point",
          type: "ellipse",
          x: 465,
          y: -200,
          width: 20,
          height: 20,
          fill: "#DFFF82",
          animations: arrive(3),
        },
      ],
    },
    text("chart-note", "REVENUE TREND / ILLUSTRATIVE DATA", 350, 241, 970, 55, 20, {
      fill: "#9FACBA",
      align: "center",
    }),
    {
      id: "source-strip",
      type: "group",
      x: 0,
      y: 389,
      width: 1710,
      height: 160,
      clip: true,
      children: [
        rect("strip-bg", 0, 0, 1710, 160, { fill: "#182433", radius: 10 }),
        crop("source-metric", "analytics", "revenue", -610, 0, 380, 140),
        text("source-label", "From the real dashboard fixture.", 180, -24, 1120, 65, 32),
        text(
          "source-description",
          "A screenshot anchors the explanation; the line is an editorial view of sample data.",
          180,
          37,
          1120,
          55,
          20,
          { fill: "#9FACBA" },
        ),
      ],
      animations: arrive(1.3),
    },
  ]),
]);

const board = composition(theme("#F3F1EB", "#292C30", "#E5E4DE", "#C34632"), [
  scene("workflow-map", 6.8, [
    text("brand", "Outline", -665, -420, 380, 90, 52, { fontFamily: serif }),
    text("section", "A SHARED NEXT STEP", 550, -420, 620, 60, 23, { align: "right" }),
    text("headline", "Good work keeps moving.", 0, -283, 1710, 155, 78, {
      fontWeight: 500,
      animations: arrive(),
    }),
    ...[-560, 0, 560].map((x, i) => ({
      id: `column-${i}`,
      type: "group",
      x,
      y: 102,
      children: [
        rect(`column-surface-${i}`, 0, 0, 510, 510, { fill: i === 2 ? "#E1E7DC" : "#E5E4DE" }),
        text(
          `column-title-${i}`,
          ["01 / IN PROGRESS", "02 / REVIEW", "03 / SHIPPED"][i],
          0,
          -199,
          444,
          66,
          21,
          { fontWeight: 600 },
        ),
      ],
    })),
    {
      id: "fixed-cards",
      type: "group",
      width: 1650,
      height: 620,
      clip: true,
      children: [
        crop("notes", "board", "notes", -560, 224, 446, 180, { opacity: 0.6 }),
        crop("design", "board", "design", 0, 224, 446, 180, { opacity: 0.6 }),
      ],
    },
    line(
      "route",
      [
        [-560, -180],
        [560, -180],
      ],
      {
        stroke: "#C34632",
        strokeWidth: 3,
        animations: [
          track("end", [
            [0, 0],
            [1.4, 0],
            [4.1, 1, "ease-in-out"],
          ]),
        ],
      },
    ),
    {
      id: "moving-task",
      type: "group",
      x: 560,
      y: 56,
      rotation: 0,
      animations: [
        track("x", [
          [0, -560],
          [1.25, -560],
          [2.45, 0, "ease-in-out"],
          [3.25, 0],
          [4.45, 560, "ease-in-out"],
        ]),
        track("y", [
          [0, 56],
          [1.25, 56],
          [1.8, 20, "ease-out"],
          [2.45, 56, "ease-in"],
          [3.25, 56],
          [3.8, 20, "ease-out"],
          [4.45, 56, "ease-in"],
        ]),
        track("rotation", [
          [0, 0],
          [1.25, 0],
          [1.85, -3, "ease-out"],
          [2.45, 0],
          [3.25, 0],
          [3.85, 3, "ease-out"],
          [4.45, 0],
        ]),
      ],
      children: [
        rect("task-shadow", 8, 10, 457, 239, { fill: "#292C3019" }),
        crop("task", "board", "release", 0, 0, 458, 240),
      ],
    },
    text("payoff", "A clear owner. A visible handoff.", 0, 428, 1650, 74, 35, {
      align: "center",
      animations: arrive(4.3),
    }),
    text(
      "source",
      "Workflow illustration using real cards from the original demo workspace",
      0,
      495,
      1680,
      45,
      18,
      { fill: "#7B7E76", align: "center" },
    ),
  ]),
]);

// Independent proof: change design aspect, hierarchy, paint order, language and timing.
const portrait = composition(
  theme("#EFE9DB", "#244534", "#E2DECF", "#BB563B"),
  [
    scene(
      "portrait-proof",
      4.8,
      [
        {
          id: "circle",
          type: "ellipse",
          x: 300,
          y: -680,
          width: 720,
          height: 720,
          fill: "#D9E0CA",
          animations: [
            track("scaleX", [
              [0, 0.7],
              [1.7, 1, "ease-out"],
            ]),
            track("scaleY", [
              [0, 0.7],
              [1.7, 1, "ease-out"],
            ]),
          ],
        },
        text("brand", "MORROW / 日常之光", 0, -807, 920, 100, 38),
        text("headline", "找到屬於\n你的光。", 0, -590, 920, 300, 108, {
          fontFamily: "PingFang TC, Noto Sans CJK TC, sans-serif",
          animations: [
            track("reveal", [
              [0, 0],
              [0.3, 0],
              [1.6, 1],
            ]),
          ],
        }),
        {
          id: "product-window",
          type: "group",
          y: 4,
          width: 930,
          height: 635,
          clip: true,
          children: [
            crop("product", "commerce", "orb", 0, 0, 930, 635, {
              animations: [
                track("y", [
                  [0, 720],
                  [1.5, 0, "ease-out"],
                ]),
              ],
            }),
          ],
        },
        text("detail", "Orb · 柔和的夜晚", 0, 467, 920, 130, 60, {
          fontFamily: "PingFang TC, Noto Sans CJK TC, sans-serif",
        }),
        line(
          "rule",
          [
            [-460, 604],
            [460, 604],
          ],
          { strokeWidth: 3 },
        ),
        text("unicode", "為日常留一盞燈 ✨", 0, 713, 920, 130, 49, {
          fontFamily: "PingFang TC, Noto Sans CJK TC, sans-serif",
          animations: [
            track("reveal", [
              [0, 0],
              [2, 0],
              [3.4, 1],
            ]),
          ],
        }),
        text("source", "原創示範素材 / 靜態介面的動畫編排", 0, 864, 920, 70, 24, {
          fontFamily: "PingFang TC, Noto Sans CJK TC, sans-serif",
          fill: "#6E7565",
        }),
      ],
      { designSize: { width: 1080, height: 1920 } },
    ),
  ],
  { width: 1080, height: 1920, fps: 30 },
);
const still = structuredClone(board);
still.scenes[0].id = "static-workflow";
still.scenes[0].durationS = 6.8;
still.scenes[0].motion = "off";

for (const [name, value] of Object.entries({
  commerce,
  analytics,
  board,
  portrait,
  "motion-off": still,
})) {
  const file = join(out, `${name}.json`);
  const issues = await validateLaunchAssets(value, file);
  if (issues.some((x) => x.severity === "error"))
    throw new Error(`${name}: ${JSON.stringify(issues, null, 2)}`);
  await writeFile(file, JSON.stringify(value, null, 2) + "\n");
  console.log(`${name}: ${value.scenes.length} scene, ${launchDurationS(value)} seconds`);
}
