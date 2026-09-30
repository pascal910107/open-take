// A launch film's music anchors come from the film itself: story roles decide
// energy and hits, scene changes land even without a story, near-coincident
// moments collapse into one downbeat, and busy foley is handed to the arranger.

import assert from "node:assert/strict";
import { test } from "node:test";
import { arrange } from "open-foley";
import { launchEventSheet } from "../src/foley-events.js";
import { launchMusicAnchors } from "../src/launch-music.js";
import type { LaunchComposition } from "../src/launch-types.js";

const theme = {
  canvas: "#fff",
  ink: "#111",
  surface: "#eee",
  accent: "#06f",
  dark: "#000",
  fontFamily: "Inter",
};

const FILM: LaunchComposition = {
  version: 1,
  output: { width: 1920, height: 1080, fps: 30 },
  theme,
  scenes: [
    { id: "open", type: "title", durationS: 5, lines: ["One", "Two"] },
    { id: "work", type: "footage", durationS: 16, asset: "demo.mp4" },
    { id: "end", type: "end-card", durationS: 6, headline: "Try it", brand: "x", cta: "npx x" },
  ],
  story: {
    intent: "launch",
    audience: "devs",
    takeaway: "it works",
    beats: [
      { id: "ctx", sceneId: "open", role: "context", message: "why" },
      { id: "prom", sceneId: "open", role: "promise", message: "what" },
      { id: "proof", sceneId: "work", role: "proof", message: "see", startS: 0 },
      { id: "win", sceneId: "work", role: "payoff", message: "done", startS: 9.3 },
      { id: "go", sceneId: "end", role: "action", message: "try" },
    ],
  },
};

test("story roles become anchors: ambient intro, big first landing, big payoff, big final", () => {
  const { anchors } = launchMusicAnchors(FILM, launchEventSheet(FILM));
  assert.deepEqual(
    anchors.map((a) => [a.atS, a.energy, a.hit ?? null]),
    [
      [0, 0, null],
      [5, 2, "big"],
      [14.3, 3, "big"],
      [21, 2, "big"],
    ],
  );
});

test("without a story, scene changes still land (small), the film's end card is final", () => {
  const { story: _s, ...bare } = FILM;
  const { anchors } = launchMusicAnchors(bare, launchEventSheet(bare));
  assert.deepEqual(
    anchors.map((a) => a.atS),
    [0, 5, 21],
  );
  assert.equal(anchors.at(-1)!.hit, "big");
});

test("the anchors arrange into downbeats exactly on the film's moments", () => {
  const input = launchMusicAnchors(FILM, launchEventSheet(FILM));
  const sheet = arrange(input);
  const downbeats = sheet.sections.map((s) => s.atS);
  assert.deepEqual(downbeats, [0, 5, 14.3]);
  assert.equal(sheet.outro?.atS, 21);
  sheet.sections.forEach((s, i) => {
    const end = s.atS + (s.eighths * 30) / s.bpm;
    const next = sheet.sections[i + 1]?.atS ?? sheet.outro!.atS;
    assert.ok(Math.abs(end - next) < 0.002);
  });
});

test("merge windows are anchored, and a scene cut keeps its downbeat", () => {
  const film: LaunchComposition = {
    ...FILM,
    scenes: [
      { id: "open", type: "title", durationS: 5, lines: ["One"] },
      { id: "work", type: "footage", durationS: 16, asset: "demo.mp4" },
      { id: "end", type: "end-card", durationS: 6, headline: "Try it", brand: "x", cta: "npx x" },
    ],
    story: {
      intent: "launch",
      audience: "devs",
      takeaway: "it works",
      beats: [
        { id: "ctx", sceneId: "open", role: "context", message: "why" },
        // a context beat half a second after the cut: the cut keeps the downbeat
        { id: "late", sceneId: "work", role: "context", message: "later", startS: 0.5 },
        // a run of beats 0.5 s apart must not slide one anchor across 2 s
        { id: "p1", sceneId: "work", role: "proof", message: "a", startS: 6 },
        { id: "p2", sceneId: "work", role: "proof", message: "b", startS: 6.5 },
        { id: "p3", sceneId: "work", role: "proof", message: "c", startS: 7 },
        { id: "p4", sceneId: "work", role: "proof", message: "d", startS: 7.5 },
        { id: "p5", sceneId: "work", role: "proof", message: "e", startS: 8 },
      ],
    },
  };
  const { anchors } = launchMusicAnchors(film, launchEventSheet(film));
  const times = anchors.map((a) => a.atS);
  assert.ok(times.includes(5), `the cut at 5 s keeps its downbeat (${times})`);
  // clusters anchored at their first moment: [11, 11.5, 12] and [12.5, 13]
  assert.ok(times.includes(11) && times.includes(12.5), `anchored clusters (${times})`);
  // a landing never lands into an ambient span
  for (const a of anchors) if (a.hit) assert.ok(a.energy >= 1);
});

test("a payoff that opens the film keeps its hit", () => {
  const film: LaunchComposition = {
    ...FILM,
    story: {
      ...FILM.story!,
      beats: [{ id: "win", sceneId: "open", role: "payoff", message: "done" }],
    },
  };
  const { anchors } = launchMusicAnchors(film, launchEventSheet(film));
  assert.equal(anchors[0]!.atS, 0);
  assert.equal(anchors[0]!.hit, "big");
  assert.equal(anchors[0]!.energy, 3);
});

test("a payoff a breath before the end card keeps its own moment", () => {
  const film: LaunchComposition = {
    ...FILM,
    story: {
      ...FILM.story!,
      beats: [
        { id: "ctx", sceneId: "open", role: "context", message: "why" },
        { id: "proof", sceneId: "work", role: "proof", message: "see", startS: 0 },
        // the reveal lands 0.85 s before the end card cuts in (work ends at 21)
        { id: "win", sceneId: "work", role: "payoff", message: "done", startS: 15.15 },
      ],
    },
  };
  const { anchors } = launchMusicAnchors(film, launchEventSheet(film));
  const late = anchors.filter((a) => a.atS > 19);
  assert.equal(late.length, 1);
  assert.equal(late[0]!.atS, 20.15);
  assert.equal(late[0]!.hit, "big");
});

test("the soundtrack: palette voices + score, mastered; the film's own music wins", async () => {
  const { launchSoundtrack } = await import("../src/launch-render.js");
  const film: LaunchComposition = {
    ...FILM,
    sound: { style: "cinematic", palette: { key: "key.crisp" } },
  };
  const out = launchSoundtrack(film, "/tmp/film.json");
  assert.ok(out.music, "a score is generated by default");
  assert.equal(out.pcm.channels[0]!.length, Math.ceil(27 * 48000));
  assert.ok(out.loudness.truePeak <= -1.5 + 1e-9);
  assert.ok(Math.abs(out.loudness.lufs - -15) < 0.5, `lufs ${out.loudness.lufs}`);
  const own: LaunchComposition = {
    ...film,
    audio: [{ id: "bed", kind: "music", asset: "bed.wav" }],
  };
  assert.equal(launchSoundtrack(own, "/tmp/film.json").music, undefined, "own music: no score");
  const quiet: LaunchComposition = {
    ...film,
    sound: { style: "cinematic", palette: { music: false } },
  };
  assert.equal(launchSoundtrack(quiet, "/tmp/film.json").music, undefined);
});

test("an unapproved or unknown palette pick is a validation error", async () => {
  const { validateLaunchComposition } = await import("../src/launch-validate.js");
  const bad = {
    ...FILM,
    sound: { style: "cinematic", palette: { whoosh: "whoosh.deep", key: "nope" } },
  };
  const issues = validateLaunchComposition(bad).filter((i) => i.severity === "error");
  assert.ok(
    issues.some((i) => i.path === "sound.palette.whoosh" && /approved/.test(i.message)),
    JSON.stringify(issues),
  );
  assert.ok(issues.some((i) => i.path === "sound.palette.key" && /unknown entry/.test(i.message)));
});
