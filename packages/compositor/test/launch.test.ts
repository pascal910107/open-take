import assert from "node:assert/strict";
import test from "node:test";
import { join } from "node:path";
import {
  evaluateUiMorph,
  launchAudioAtS,
  launchDurationS,
  launchSceneWindows,
  launchTemplate,
  uiStateDurationS,
  uiMorphDurationS,
  validateLaunchComposition,
} from "../src/index";

test("ui morph duration and film total derive from editable state timings", () => {
  const comp = launchTemplate("clip.mp4", 11);
  const ui = comp.scenes.find((x) => x.type === "ui-morph");
  assert(ui && ui.type === "ui-morph");
  assert.equal(ui.durationS, undefined);
  assert.equal(uiMorphDurationS(ui), 6);
  const before = launchDurationS(comp);
  ui.states[2]!.holdS += 0.75;
  assert.equal(launchDurationS(comp), before + 0.75);
});

test("mid-transition exposes intermediate geometry and independent old/new layers", () => {
  const comp = launchTemplate();
  const ui = comp.scenes.find((x) => x.type === "ui-morph");
  assert(ui && ui.type === "ui-morph");
  const boundary = uiStateDurationS(ui.states[0]!) + uiStateDurationS(ui.states[1]!);
  const state = evaluateUiMorph(ui, boundary + 0.2);
  assert.equal(state.from.label, "Record");
  assert.equal(state.to.label, "Style");
  assert(state.progress > 0 && state.progress < 1);
  assert(state.panelWidth > 1040 && state.panelWidth < 1100);
  assert(state.oldOpacity > 0);
  assert.equal(state.newOpacity, 0);
});

test("scene order, add/remove, and relative audio anchors use current JSON", () => {
  const comp = launchTemplate();
  const first = launchSceneWindows(comp)[0]!;
  comp.audio = [
    {
      id: "cue",
      kind: "sfx",
      asset: "cue.wav",
      afterSceneId: first.scene.id,
      offsetS: 0.2,
      durationS: 0.1,
    },
  ];
  assert.equal(launchAudioAtS(comp, comp.audio[0]!), first.endS + 0.2);
  comp.scenes.splice(0, 1);
  const issues = validateLaunchComposition(comp);
  assert(issues.some((x) => x.path === "audio[0].afterSceneId"));
});

test("invalid and primitive JSON reports field errors without throwing", () => {
  assert.doesNotThrow(() => validateLaunchComposition(null as never));
  const comp = launchTemplate();
  (comp as unknown as { scenes: unknown }).scenes = [null, 7];
  (comp as unknown as { audio: unknown }).audio = {};
  const issues = validateLaunchComposition(comp);
  assert(issues.some((x) => x.path === "scenes[0]"));
  assert(issues.some((x) => x.path === "audio"));
});

test("asset checks resolve relative to composition directory", () => {
  const comp = launchTemplate("media/clip with spaces.mp4", 12);
  const issues = validateLaunchComposition(comp, join("/tmp", "project with spaces"));
  assert(
    issues.some(
      (x) => x.path === "scenes[1].asset" && x.message.includes("media/clip with spaces.mp4"),
    ),
  );
});

test("explicit ui duration mismatch is actionable", () => {
  const comp = launchTemplate();
  const ui = comp.scenes.find((x) => x.type === "ui-morph");
  assert(ui && ui.type === "ui-morph");
  ui.durationS = 4;
  const issue = validateLaunchComposition(comp).find((x) => x.path.endsWith(".durationS"));
  assert(issue?.message.includes("derived from state timings"));
});
