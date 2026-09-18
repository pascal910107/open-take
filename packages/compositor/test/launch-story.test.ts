import assert from "node:assert/strict";
import test from "node:test";
import { analyzeLaunchStory, validateLaunchStory } from "../src/launch-story";
import { launchTemplate } from "../src/launch-template";
import type { LaunchComposition, LaunchStory, LaunchStoryBeat } from "../src/launch-types";
import { validateLaunchComposition } from "../src/launch-validate";

function composition(): LaunchComposition {
  return {
    ...launchTemplate(),
    scenes: [
      { id: "opening", type: "title", durationS: 3, lines: ["A useful result"], motion: "off" },
      {
        id: "demo",
        type: "motion",
        durationS: 6,
        motion: "on",
        layers: [
          {
            id: "group",
            type: "group",
            children: [
              {
                id: "capture",
                type: "video",
                asset: "capture.webm",
                width: 640,
                height: 360,
                startS: 2,
                durationS: 2,
              },
              { id: "still", type: "image", asset: "still.png", width: 640, height: 360 },
              { id: "decoration", type: "rect", width: 100, height: 100 },
            ],
          },
        ],
      },
      { id: "source", type: "footage", durationS: 4, asset: "source.mp4" },
    ],
  };
}
const beat = (overrides: Partial<LaunchStoryBeat> = {}): LaunchStoryBeat => ({
  id: "main",
  sceneId: "demo",
  role: "promise",
  message: "A useful result",
  ...overrides,
});
const story = (overrides: Partial<LaunchStory> = {}): LaunchStory => ({
  intent: "launch",
  audience: "People reviewing their work",
  takeaway: "See the important result clearly",
  beats: [beat()],
  ...overrides,
});
const withStory = (value: LaunchStory): LaunchComposition => ({ ...composition(), story: value });
const validStory = (): LaunchStory =>
  story({
    beats: [
      beat({ id: "context", sceneId: "opening", role: "context", message: "Know the task" }),
      beat({ evidence: [{ kind: "recording", layerId: "capture" }] }),
      beat({
        id: "next",
        sceneId: "source",
        role: "action",
        message: "Review the result",
        evidence: [{ kind: "recording" }],
      }),
    ],
  });

test("legacy compositions have no new validation findings or story warnings", () => {
  assert.deepEqual(validateLaunchComposition(launchTemplate()), []);
  assert.deepEqual(analyzeLaunchStory(launchTemplate()), []);
  assert.deepEqual(validateLaunchStory(undefined), []);
});

test("valid nested references and default scene-local windows preserve authored metadata", () => {
  const c = withStory(validStory()),
    before = structuredClone(c);
  assert.deepEqual(validateLaunchComposition(c), []);
  assert.deepEqual(validateLaunchStory(c.story, c.scenes), []);
  assert.deepEqual(analyzeLaunchStory(c), []);
  assert.deepEqual(c, before);
  c.story!.beats[1]!.startS = 0;
  c.story!.beats[1]!.endS = 2;
  assert.deepEqual(
    validateLaunchComposition(c),
    [],
    "second scene beat times start at zero, not film time three",
  );
});

test("unknown JSON containers, missing fields and unsupported fields receive exact paths", () => {
  for (const value of [
    null,
    3,
    true,
    "x",
    [],
    { beats: [null] },
    { beats: {} },
    { beats: [{ evidence: [null] }] },
  ])
    assert.doesNotThrow(() => validateLaunchStory(value));
  const bad = {
    ...story(),
    extra: true,
    beats: [
      {
        ...beat(),
        mystery: true,
        evidence: [{ kind: "screenshot", layerId: "still", url: "remote" }],
      },
    ],
  };
  const issues = validateLaunchStory(bad, composition().scenes);
  for (const path of ["story.extra", "story.beats[0].mystery", "story.beats[0].evidence[0].url"])
    assert(
      issues.some((issue) => issue.path === path),
      path,
    );
  assert(
    validateLaunchStory({ ...story(), intent: "ad" }).some(
      (issue) => issue.path === "story.intent",
    ),
  );
  assert(
    validateLaunchStory({ ...story(), audience: " " }).some(
      (issue) => issue.path === "story.audience",
    ),
  );
  assert(
    validateLaunchStory({ ...story(), takeaway: null }).some(
      (issue) => issue.path === "story.takeaway",
    ),
  );
  assert(
    validateLaunchStory(story({ beats: [beat({ role: "wrong" as never })] })).some(
      (issue) => issue.path === "story.beats[0].role",
    ),
  );
});

test("duplicate beat ids and missing scene or nested layer references fail structurally", () => {
  const c = composition();
  for (const [value, path] of [
    [story({ beats: [beat(), beat()] }), "story.beats[1].id"],
    [story({ beats: [beat({ sceneId: "missing" })] }), "story.beats[0].sceneId"],
    [
      story({ beats: [beat({ evidence: [{ kind: "recording", layerId: "missing" }] })] }),
      "story.beats[0].evidence[0].layerId",
    ],
    [
      story({
        beats: [beat({ sceneId: "opening", evidence: [{ kind: "screenshot", layerId: "still" }] })],
      }),
      "story.beats[0].evidence[0].layerId",
    ],
    [
      story({ beats: [beat({ evidence: [{ kind: "illustration", layerId: "decoration" }] })] }),
      "story.beats[0].evidence[0].layerId",
    ],
  ] as const)
    assert(
      validateLaunchStory(value, c.scenes).some((issue) => issue.path === path),
      path,
    );
});

test("recording and screenshot evidence cannot mislabel the target media kind", () => {
  for (const evidence of [
    { kind: "recording" as const, layerId: "still" },
    { kind: "screenshot" as const, layerId: "capture" },
  ]) {
    const issues = validateLaunchStory(
      story({ beats: [beat({ evidence: [evidence] })] }),
      composition().scenes,
    );
    assert(issues.some((issue) => issue.path === "story.beats[0].evidence[0].kind"));
  }
  for (const kind of ["recording", "screenshot"] as const)
    assert(
      validateLaunchStory(
        story({ beats: [beat({ evidence: [{ kind }] })] }),
        composition().scenes,
      ).some((issue) => issue.path.endsWith(".layerId")),
    );
  assert.deepEqual(
    validateLaunchStory(
      story({ beats: [beat({ sceneId: "source", evidence: [{ kind: "recording" }] })] }),
      composition().scenes,
    ),
    [],
  );
  assert.deepEqual(
    validateLaunchStory(
      story({ beats: [beat({ sceneId: "opening", evidence: [{ kind: "illustration" }] })] }),
      composition().scenes,
    ),
    [],
  );
});

test("beat windows reject nonfinite, negative, inverted and out-of-scene intervals", () => {
  for (const [overrides, key] of [
    [{ startS: -1 }, "startS"],
    [{ endS: Infinity }, "endS"],
    [{ startS: 2, endS: 1 }, "endS"],
    [{ startS: 6 }, "startS"],
    [{ endS: 6.1 }, "endS"],
    [{ startS: 0, endS: 0 }, "endS"],
  ] as const)
    assert(
      validateLaunchStory(story({ beats: [beat(overrides)] }), composition().scenes).some(
        (issue) => issue.path === `story.beats[0].${key}`,
      ),
    );
  const c = launchTemplate(),
    ui = c.scenes.find((scene) => scene.type === "ui-morph")!;
  delete ui.durationS;
  c.story = story({ beats: [beat({ sceneId: ui.id })] });
  assert.deepEqual(
    validateLaunchComposition(c),
    [],
    "state-derived scene duration supports omitted beat endpoints",
  );
});

test("abstract teaser is allowed while launch and walkthrough suggest their missing roles and evidence", () => {
  const teaser = withStory(story({ intent: "teaser" }));
  assert.deepEqual(analyzeLaunchStory(teaser), []);
  const launch = analyzeLaunchStory(withStory(story()));
  assert(launch.some((issue) => issue.message.includes("No context beat")));
  assert(launch.some((issue) => issue.message.includes("No action beat")));
  assert(
    launch.some((issue) => issue.message.includes("No potentially visible recording/screenshot")),
  );
  const walkthrough = analyzeLaunchStory(withStory(story({ intent: "walkthrough", beats: [] })));
  assert(walkthrough.some((issue) => issue.message.includes("No context beat")));
  assert(!walkthrough.some((issue) => issue.message.includes("No promise beat")));
  assert(launch.every((issue) => issue.severity === "warn"));
});

test("illustrations never count as actual UI proof, even if they reference a video", () => {
  const illustrated = story({
    beats: [beat({ role: "proof", evidence: [{ kind: "illustration", layerId: "capture" }] })],
  });
  const c = withStory(illustrated);
  assert.deepEqual(validateLaunchComposition(c), []);
  assert(
    analyzeLaunchStory(c).some((issue) => issue.message.includes("illustrations do not count")),
  );
  c.story!.intent = "teaser";
  assert(
    analyzeLaunchStory(c).some(
      (issue) =>
        issue.path === "story.beats[0].evidence" && issue.message.includes("not actual UI proof"),
    ),
  );
});

test("a source-backed beat does not excuse a separate unsupported launch proof beat", () => {
  const value = validStory();
  value.beats.push(
    beat({
      id: "unsupported-proof",
      role: "proof",
      evidence: [{ kind: "illustration", layerId: "still" }],
    }),
  );
  const c = withStory(value);
  assert.deepEqual(validateLaunchComposition(c), []);
  const issues = analyzeLaunchStory(c);
  assert(
    issues.some(
      (issue) =>
        issue.path === "story.beats[3].evidence" &&
        issue.message.includes("This launch declares a proof beat"),
    ),
  );
  assert(
    !issues.some((issue) =>
      issue.message.includes("No potentially visible recording/screenshot evidence is declared"),
    ),
    "the other beat still supplies the composition's declared actual source",
  );
});

test("competing promise and rushed editorial-window warnings remain heuristic", () => {
  const c = withStory(
    story({
      intent: "teaser",
      beats: [
        beat({ message: "Finish sooner", startS: 0, endS: 0.1 }),
        beat({ id: "second", message: "Keep every detail" }),
      ],
    }),
  );
  const issues = analyzeLaunchStory(c);
  assert(issues.some((issue) => issue.message.includes("different messages")));
  assert(
    issues.some(
      (issue) => issue.path === "story.beats[0].endS" && issue.message.includes("does not assert"),
    ),
  );
  c.story!.beats[1]!.message = " Finish  sooner ";
  assert(!analyzeLaunchStory(c).some((issue) => issue.message.includes("different messages")));
});

test("known invisible ancestor evidence warns and does not supply the declared proof", () => {
  const c = withStory(validStory());
  c.story!.beats = c.story!.beats.slice(0, 2);
  const scene = c.scenes[1]!;
  assert(scene.type === "motion");
  scene.layers[0]!.opacity = 0;
  assert(analyzeLaunchStory(c).some((issue) => issue.message.includes("opacity/scale throughout")));
  assert(
    analyzeLaunchStory(c).some((issue) =>
      issue.message.includes("No potentially visible recording/screenshot"),
    ),
  );
  scene.layers[0]!.animations = [
    {
      property: "opacity",
      keyframes: [
        { atS: 0, value: 0 },
        { atS: 1, value: 1 },
      ],
    },
  ];
  assert(
    !analyzeLaunchStory(c).some((issue) => issue.message.includes("opacity/scale throughout")),
    "an entrance is not proven invisible",
  );
  scene.motion = "off";
  assert(
    analyzeLaunchStory(c).some((issue) => issue.message.includes("opacity/scale throughout")),
    "motion off uses authored opacity",
  );
});

test("recording active overlap is scene-local and endpoint holds are not described as playback", () => {
  const c = withStory(validStory());
  const b = c.story!.beats[1]!;
  b.startS = 0;
  b.endS = 2;
  assert(analyzeLaunchStory(c).some((issue) => issue.message.includes("holds an endpoint frame")));
  b.startS = 2;
  b.endS = 4;
  assert(!analyzeLaunchStory(c).some((issue) => issue.message.includes("holds an endpoint frame")));
  const scene = c.scenes[1]!;
  assert(scene.type === "motion");
  scene.motion = "off";
  assert(
    !analyzeLaunchStory(c).some((issue) => issue.message.includes("holds an endpoint frame")),
    "motion off disables transforms, not video playback",
  );
});

test("story shape validation still runs when malformed scene JSON prevents reference checking", () => {
  const issues = validateLaunchComposition({
    ...composition(),
    scenes: [null],
    story: { intent: "launch", audience: 3, takeaway: "x", beats: [null] },
  });
  assert(issues.some((issue) => issue.path === "scenes[0]"));
  assert(issues.some((issue) => issue.path === "story.audience"));
  assert(issues.some((issue) => issue.path === "story.beats[0]"));
});
