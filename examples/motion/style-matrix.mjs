// Reproducible visual-review matrix for protected recipe treatments.
// Run after `pnpm build` and `node examples/motion/prepare-assets.mjs`.
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { composeMotionStory } from "../../packages/compositor/dist/index.js";

const out = process.argv[2]
  ? resolve(process.argv[2])
  : resolve(dirname(fileURLToPath(import.meta.url)), "../../out/motion-demo");
const assets = JSON.parse(await readFile(join(out, "assets.json"), "utf8"));
const image = (view, region) => ({
  asset: assets.views[view].before,
  crop: assets.views[view].crops[region],
});
const theme = {
  canvas: "#F3F1EB",
  ink: "#292C30",
  surface: "#E5E4DE",
  accent: "#AA3928",
  dark: "#222825",
  fontFamily: "Avenir Next, Avenir, Helvetica Neue, sans-serif",
};
const styles = ["editorial", "product", "technical"];
const outputs = {
  landscape: { width: 1920, height: 1080, fps: 30 },
  portrait: { width: 1080, height: 1920, fps: 30 },
  square: { width: 1080, height: 1080, fps: 30 },
};
const scenes = (style, motion = "on") => [
  {
    id: `${style}-focus`,
    recipe: "focus",
    style,
    motion,
    title: "One signal, clearly framed.",
    body: "保留真實畫面，讓成果一眼可讀。",
    image: image("analytics", "chart"),
  },
  {
    id: `${style}-compare`,
    recipe: "compare",
    style,
    motion,
    title: "Two designs. One decision.",
    body: "並列兩款設計，清楚比較差異。",
    before: { label: "Terra", image: image("commerce", "terra") },
    after: { label: "Orb", image: image("commerce", "orb") },
  },
  {
    id: `${style}-steps`,
    recipe: "steps",
    style,
    motion,
    title: "From capture to release.",
    steps: [
      { label: "Capture", body: "保存真實操作。" },
      { label: "Compose", body: "整理清楚重點。" },
      { label: "Deliver", body: "輸出可讀成果。" },
    ],
  },
];

async function writeComposition(name, brief) {
  const result = composeMotionStory(brief);
  const errors = result.issues.filter((issue) => issue.severity === "error");
  if (!result.composition || errors.length)
    throw new Error(`${name}: ${JSON.stringify(result.issues, null, 2)}`);
  await writeFile(join(out, `${name}.brief.json`), `${JSON.stringify(brief, null, 2)}\n`);
  await writeFile(join(out, `${name}.json`), `${JSON.stringify(result.composition, null, 2)}\n`);
  console.log(
    `${name}.brief.json -> ${name}.json${result.issues.length ? ` (${result.issues.length} advisory warnings)` : ""}`,
  );
}

for (const style of styles)
  for (const [aspect, output] of Object.entries(outputs))
    await writeComposition(`style-${style}-${aspect}`, {
      version: 1,
      output,
      theme,
      scenes: scenes(style),
    });

for (const [index, style] of styles.entries()) {
  const selected = scenes(style, "off")[index];
  await writeComposition(`style-${style}-square-off`, {
    version: 1,
    output: outputs.square,
    theme,
    scenes: [selected],
  });
}
