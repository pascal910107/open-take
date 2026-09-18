// Minimal authoring inputs. Layout is owned by launch compose, not this script.
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const out = resolve(dirname(fileURLToPath(import.meta.url)), "../../out/motion-demo");
const assets = JSON.parse(await readFile(join(out, "assets.json"), "utf8"));
const image = (view, region) => ({
  asset: assets.views[view].before,
  crop: assets.views[view].crops[region],
});
const scenes = [
  {
    id: "one-result",
    recipe: "focus",
    title: "One clear result.",
    body: "Give the viewer a real detail to understand.",
    image: image("analytics", "revenue"),
  },
  {
    id: "two-characters",
    recipe: "compare",
    title: "A light for every evening.",
    body: "Compare two original illustrative products.",
    before: { label: "Terra / Focused", image: image("commerce", "terra") },
    after: { label: "Orb / Ambient", image: image("commerce", "orb") },
  },
  {
    id: "shared-process",
    recipe: "steps",
    title: "Make the handoff visible.",
    steps: [
      { label: "Prepare", body: "Gather the work." },
      { label: "Review", body: "Share the context." },
      { label: "Release", body: "Show the result." },
    ],
  },
];
const squareScenes = [
  scenes[0],
  {
    id: "dense-process",
    recipe: "steps",
    title: "From a real interaction to a clear story.",
    steps: ["Capture", "Compose", "Refine", "Review", "Deliver"].map((label) => ({
      label,
      body: "Keep the result editable.",
    })),
  },
];
for (const [name, width, height, fps, content] of [
  ["landscape", 1920, 1080, 30, scenes],
  ["portrait", 1080, 1920, 30, scenes],
  ["square", 1080, 1080, 12, squareScenes],
]) {
  const brief = {
    version: 1,
    output: { width, height, fps },
    theme: {
      canvas: "#F3F1EB",
      ink: "#292C30",
      surface: "#E5E4DE",
      accent: "#AA3928",
      dark: "#222825",
      fontFamily: "Avenir Next, Avenir, Helvetica Neue, sans-serif",
    },
    scenes: content,
  };
  await writeFile(join(out, `recipe-${name}.brief.json`), JSON.stringify(brief, null, 2) + "\n");
  console.log(`recipe-${name}.brief.json`);
}
