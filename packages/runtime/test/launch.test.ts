import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { type LaunchComposition, launchDurationS, resolveFfmpeg } from "@open-take/compositor";
import { checkLaunchFile, composeLaunchFile, initLaunchProject } from "../src/launch";

const command = (bin: string, args: string[]) =>
  new Promise<void>((ok, fail) => {
    const child = spawn(bin, args, { stdio: "ignore" });
    child.on("error", fail);
    child.on("close", (code) => (code === 0 ? ok() : fail(new Error(`command exited ${code}`))));
  });

test("launch init is portable, handles spaces, and fits a short source", async (t) => {
  const work = await mkdtemp(join(tmpdir(), "open take launch "));
  t.after(() => rm(work, { recursive: true, force: true }));
  const source = join(work, "source clip.mp4"),
    project = join(work, "film project");
  await command(await resolveFfmpeg(), [
    "-y",
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "testsrc2=size=320x180:rate=30:duration=1.2",
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    source,
  ]);
  const result = await initLaunchProject(project, source);
  const authored = await readFile(result.compositionPath, "utf8");
  const composition = JSON.parse(authored) as LaunchComposition;
  assert.match(composition.scenes.find((x) => x.type === "footage")?.asset ?? "", /^assets\//);
  assert.deepEqual(
    composition.scenes.map((x) => x.type),
    ["title", "footage", "end-card"],
  );
  const footage = composition.scenes.find((x) => x.type === "footage");
  assert(footage && footage.type === "footage");
  assert.equal(footage.durationS, 1.2, "starter retains the full real clip");
  assert.equal(composition.output.fps, 30, "output fps follows the recording's own rate");
  assert.equal(launchDurationS(composition), 5.2, "total derives from the clip and editable cards");
  assert.equal(composition.audio, undefined, "audio stays opt-in");
  const checked = await checkLaunchFile(result.compositionPath);
  assert.equal(checked.issues.filter((x) => x.severity === "error").length, 0);
  await assert.rejects(() => initLaunchProject(project, source), /refusing to overwrite/);
});

const storyTheme = {
  canvas: "#f4efe5",
  ink: "#19251f",
  surface: "#dfe6d8",
  accent: "#a04b35",
  dark: "#101a16",
  fontFamily: "Avenir Next, sans-serif",
};

function focusBrief(asset: string) {
  return {
    version: 1,
    output: { width: 960, height: 540, fps: 30 },
    theme: storyTheme,
    scenes: [
      {
        id: "focus",
        recipe: "focus",
        title: "One clear result",
        body: "Real source material stays central.",
        image: { asset },
      },
    ],
  };
}

function motionImageAssets(composition: LaunchComposition): string[] {
  const assets: string[] = [];
  for (const scene of composition.scenes) {
    if (scene.type !== "motion") continue;
    const visit = (layers: typeof scene.layers) => {
      for (const layer of layers) {
        if (layer.type === "image") assets.push(layer.asset);
        if (layer.type === "group") visit(layer.children);
      }
    };
    visit(scene.layers);
  }
  return assets;
}

function motionVideoAssets(composition: LaunchComposition): string[] {
  const assets: string[] = [];
  for (const scene of composition.scenes) {
    if (scene.type !== "motion") continue;
    const visit = (layers: typeof scene.layers) => {
      for (const layer of layers) {
        if (layer.type === "video") assets.push(layer.asset);
        if (layer.type === "group") visit(layer.children);
      }
    };
    visit(scene.layers);
  }
  return assets;
}

test("launch compose validates, rebases spaced media paths, and derives recipe duration", async (t) => {
  const work = await mkdtemp(join(tmpdir(), "open take compose "));
  t.after(() => rm(work, { recursive: true, force: true }));
  const briefDir = join(work, "brief source"),
    assetDir = join(briefDir, "product assets"),
    deliveryDir = join(work, "nested delivery", "film"),
    asset = join(assetDir, "hero image.png"),
    media = join(assetDir, "source clip.mp4"),
    briefPath = join(briefDir, "story brief.json"),
    outputPath = join(deliveryDir, "launch story.json");
  await mkdir(assetDir, { recursive: true });
  await command(await resolveFfmpeg(), [
    "-y",
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "color=c=0x4f725f:size=64x48:duration=0.04",
    "-frames:v",
    "1",
    asset,
  ]);
  await command(await resolveFfmpeg(), [
    "-y",
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "testsrc2=size=160x90:rate=30:duration=1",
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=440:sample_rate=48000:duration=1",
    "-shortest",
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "aac",
    media,
  ]);

  const briefValue = focusBrief("product assets/hero image.png") as ReturnType<
    typeof focusBrief
  > & {
    audio?: { id: string; kind: "sfx"; asset: string; atS: number; durationS: number }[];
    story?: LaunchComposition["story"];
  };
  briefValue.scenes.push({
    id: "nested-proof",
    type: "motion",
    durationS: 1,
    transition: { type: "cut" },
    layers: [
      {
        id: "clip",
        type: "group",
        width: 320,
        height: 240,
        clip: true,
        children: [
          {
            id: "nested-image",
            type: "image",
            asset: "product assets/hero image.png",
            width: 320,
            height: 240,
          },
          {
            id: "nested-video",
            type: "video",
            asset: "product assets/source clip.mp4",
            width: 320,
            height: 180,
            startS: 0.2,
            durationS: 0.5,
          },
        ],
      },
    ],
  } as never);
  briefValue.scenes.push({
    id: "real-footage",
    type: "footage",
    durationS: 0.5,
    asset: "product assets/source clip.mp4",
    transition: { type: "cut" },
  } as never);
  briefValue.audio = [
    {
      id: "tone",
      kind: "sfx",
      asset: "product assets/source clip.mp4",
      atS: 0,
      durationS: 0.5,
    },
  ];
  briefValue.story = {
    intent: "launch",
    audience: "Teams reviewing a handoff",
    takeaway: "See the next owner before handing work over.",
    beats: [
      { id: "context", sceneId: "focus", role: "context", message: "Every handoff matters." },
      { id: "promise", sceneId: "focus", role: "promise", message: "Find the next owner." },
      {
        id: "proof",
        sceneId: "nested-proof",
        startS: 0.2,
        endS: 0.7,
        role: "proof",
        message: "Owner",
        evidence: [{ kind: "recording", layerId: "nested-video" }],
      },
    ],
  };
  await writeFile(briefPath, `${JSON.stringify(briefValue)}\n`);

  const result = await composeLaunchFile(briefPath, outputPath);
  assert.equal(result.compositionPath, outputPath);
  assert.equal(result.composition.scenes[0]?.type, "motion");
  const authored = JSON.parse(await readFile(outputPath, "utf8")) as LaunchComposition;
  assert.deepEqual(authored.story, briefValue.story, "story references survive asset rebasing");
  assert.deepEqual(
    JSON.parse(await readFile(briefPath, "utf8")).story,
    briefValue.story,
    "the source brief remains unchanged",
  );
  assert(
    result.issues.some(
      (issue) => issue.path === "story.beats" && /No action beat/.test(issue.message),
    ),
    "compose reports an unfinished launch story without blocking an editable draft",
  );
  assert.deepEqual(
    [...new Set(motionImageAssets(authored))],
    ["../../brief source/product assets/hero image.png"],
  );
  assert.deepEqual(
    [...new Set(motionVideoAssets(authored))],
    ["../../brief source/product assets/source clip.mp4"],
  );
  assert.equal(
    authored.scenes.find((scene) => scene.type === "footage")?.asset,
    "../../brief source/product assets/source clip.mp4",
  );
  assert.equal(authored.audio?.[0]?.asset, "../../brief source/product assets/source clip.mp4");
  assert.equal(
    (await checkLaunchFile(outputPath)).issues.some((x) => x.severity === "error"),
    false,
  );
  const qualityPath = join(deliveryDir, "quality warning.json");
  authored.scenes.push({
    id: "small-copy",
    type: "motion",
    durationS: 2,
    motion: "off",
    transition: { type: "cut" },
    designSize: { width: 960, height: 540 },
    layers: [
      {
        id: "small-text",
        type: "text",
        text: "Readable structure, intentionally weak scale",
        width: 500,
        height: 80,
        fontSize: 10,
      },
    ],
  });
  await writeFile(qualityPath, `${JSON.stringify(authored)}\n`);
  const quality = await checkLaunchFile(qualityPath);
  assert(
    quality.issues.some(
      (issue) => issue.path === "story.beats" && /No action beat/.test(issue.message),
    ),
    "launch check reports the same story gap after writing and reopening the composition",
  );
  assert.equal(
    quality.issues.some((issue) => issue.severity === "error"),
    false,
  );
  assert(
    quality.issues.some(
      (issue) => issue.severity === "warn" && /small relative to the design/i.test(issue.message),
    ),
    "launch check includes non-blocking semantic quality warnings",
  );
  const brokenEvidencePath = join(deliveryDir, "broken evidence.json");
  const brokenEvidence = structuredClone(authored);
  brokenEvidence.story!.beats[2]!.evidence![0]!.layerId = "missing-video";
  await writeFile(brokenEvidencePath, `${JSON.stringify(brokenEvidence)}\n`);
  assert(
    (await checkLaunchFile(brokenEvidencePath)).issues.some(
      (issue) => issue.severity === "error" && issue.path === "story.beats[2].evidence[0].layerId",
    ),
    "broken story-to-source references fail before rendering",
  );

  const stepsBrief = join(briefDir, "steps.json"),
    stepsOutput = join(deliveryDir, "steps.json"),
    stepsValue = {
      version: 1,
      output: { width: 960, height: 540, fps: 30 },
      theme: storyTheme,
      scenes: [
        {
          id: "steps",
          recipe: "steps",
          title: "A variable sequence",
          steps: [
            { label: "Frame the problem" },
            { label: "Compare the evidence" },
            { label: "Choose the result" },
            { label: "Share the outcome" },
          ],
        },
      ],
    };
  await writeFile(stepsBrief, `${JSON.stringify(stepsValue)}\n`);
  const steps = await composeLaunchFile(stepsBrief, stepsOutput);
  const shortStepsBrief = join(briefDir, "short steps.json"),
    shortStepsOutput = join(deliveryDir, "short steps.json");
  stepsValue.scenes[0]!.steps = stepsValue.scenes[0]!.steps.slice(0, 2);
  await writeFile(shortStepsBrief, `${JSON.stringify(stepsValue)}\n`);
  const shortSteps = await composeLaunchFile(shortStepsBrief, shortStepsOutput);
  assert.ok(
    launchDurationS(steps.composition) > launchDurationS(shortSteps.composition),
    "duration follows recipe content instead of a fixed film length",
  );
});

test("launch compose rejects invalid inputs and preserves every existing artifact", async (t) => {
  const work = await mkdtemp(join(tmpdir(), "open take compose refusal "));
  t.after(() => rm(work, { recursive: true, force: true }));
  const asset = join(work, "source.png"),
    media = join(work, "source clip.mp4"),
    brief = join(work, "brief.json");
  await command(await resolveFfmpeg(), [
    "-y",
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "color=c=0xc66b48:size=32x32:duration=0.04",
    "-frames:v",
    "1",
    asset,
  ]);
  await command(await resolveFfmpeg(), [
    "-y",
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "testsrc2=size=64x36:rate=30:duration=1",
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    media,
  ]);
  const protectedBrief = focusBrief("source.png");
  protectedBrief.scenes.push({
    id: "protected-video",
    type: "motion",
    durationS: 1,
    layers: [
      {
        id: "clip",
        type: "video",
        asset: "source clip.mp4",
        width: 320,
        height: 180,
        durationS: 1,
      },
    ],
  } as never);
  await writeFile(brief, `${JSON.stringify(protectedBrief)}\n`);

  const existing = join(work, "existing.json"),
    sentinel = "keep this exact output\n";
  await writeFile(existing, sentinel);
  await assert.rejects(() => composeLaunchFile(brief, existing), /refusing to overwrite/);
  assert.equal(await readFile(existing, "utf8"), sentinel);

  const sourceBefore = await readFile(asset);
  await assert.rejects(() => composeLaunchFile(brief, asset), /must not overwrite.*required asset/);
  assert.deepEqual(await readFile(asset), sourceBefore);
  const mediaBefore = await readFile(media);
  await assert.rejects(() => composeLaunchFile(brief, media), /must not overwrite.*required asset/);
  assert.deepEqual(await readFile(media), mediaBefore);

  const missingBrief = join(work, "missing.json"),
    missingOutput = join(work, "missing-output.json");
  await writeFile(missingBrief, `${JSON.stringify(focusBrief("does not exist.png"))}\n`);
  await assert.rejects(
    () => composeLaunchFile(missingBrief, missingOutput),
    /missing asset: does not exist\.png/i,
  );
  await assert.rejects(() => access(missingOutput));

  const invalidBrief = join(work, "invalid.json"),
    invalidOutput = join(work, "invalid-output.json");
  await writeFile(invalidBrief, '{"version":1,"scenes":[{"recipe":"unknown"}]}\n');
  await assert.rejects(
    () => composeLaunchFile(invalidBrief, invalidOutput),
    /launch compose failed/,
  );
  await assert.rejects(() => access(invalidOutput));
});
