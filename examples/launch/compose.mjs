// Assemble the owned sample from reusable scene templates. Its duration is
// the sum of its authored scene/state timings, never a global constant.
import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  launchDurationS,
  launchSceneWindows,
  launchTemplate,
  resolveFfprobe,
  uiStateDurationS,
  validateLaunchAssets,
} from "../../packages/compositor/dist/index.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const out = join(root, "out", "launch-demo");
const compositionPath = join(out, "launch.json");
const probe = JSON.parse(
  execFileSync(
    await resolveFfprobe(),
    [
      "-v",
      "error",
      "-show_entries",
      "format=duration",
      "-of",
      "json",
      join(out, "assets", "recording.mp4"),
    ],
    { encoding: "utf8" },
  ),
);
const comp = launchTemplate("assets/recording.mp4", Number(probe.format.duration));
const first = comp.scenes.find((s) => s.id === "capture");
first.trimStartS = 0.7;
first.durationS = 4.7;
const second = comp.scenes.find((s) => s.id === "editable");
second.trimStartS = first.trimStartS + first.durationS;
second.durationS = Math.min(5.4, Number(probe.format.duration) - second.trimStartS - 0.1);
// This source shows an actual demo fixture. Describe the visible result honestly.
second.caption = "Real actions. Real results.";
const end = comp.scenes.find((s) => s.type === "end-card");
end.durationS = 3.7; // Enough time to read the command; not a film-length constraint.
end.transition = { type: "cut" };

const ui = comp.scenes.find((s) => s.type === "ui-morph");
comp.audio = [
  {
    id: "score",
    kind: "music",
    asset: "assets/music.wav",
    atS: 0,
    loop: true,
    gain: 1.5,
    fadeInS: 0.8,
    fadeOutS: 1.8,
  },
];
let stateStartS = 0;
for (const [index, state] of ui.states.entries()) {
  if (index > 0)
    comp.audio.push({
      id: `ui-${index}`,
      kind: "sfx",
      asset: "assets/ui.wav",
      afterSceneId: "capture",
      offsetS: stateStartS,
      durationS: 0.55,
      gain: 0.45,
    });
  stateStartS += uiStateDurationS(state);
}
// The cue follows the title scene if the opening is later shortened/lengthened.
comp.audio.push({
  id: "capture-in",
  kind: "sfx",
  asset: "assets/tap.wav",
  afterSceneId: "opening",
  offsetS: 0.1,
  durationS: 0.22,
  gain: 0.5,
});
await mkdir(out, { recursive: true });
const issues = await validateLaunchAssets(comp, compositionPath);
if (issues.some((issue) => issue.severity === "error"))
  throw new Error(JSON.stringify(issues, null, 2));
await writeFile(compositionPath, `${JSON.stringify(comp, null, 2)}\n`);
await writeFile(
  join(out, "ui-morph.json"),
  `${JSON.stringify({ ...comp, scenes: [{ ...ui, transition: { type: "cut" } }], audio: [] }, null, 2)}\n`,
);
console.log(`Authored ${launchDurationS(comp).toFixed(3)} seconds → ${compositionPath}`);
for (const win of launchSceneWindows(comp))
  console.log(`${win.startS.toFixed(3)}–${win.endS.toFixed(3)}  ${win.scene.id}`);
