// `film viewer`: the round names the ffmpeg it can run, says what the viewer
// must be allowed, and a round with notes and no frame is a viewer that saw
// nothing.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { test } from "node:test";
import {
  checkViewer, prepareViewer, VIEWER_TOOLS, viewerBrief, viewerCommand, viewerRounds,
} from "../src/film/viewer";

test("the brief names ffmpeg and ffprobe by full path and where the frames go", () => {
  const brief = viewerBrief("/films/a.viewer/1/film.mp4", "/films/a.viewer/1/VIEWER.md", "npx open-take", {
    ffmpeg: "/home/u/.open-take/ffmpeg/b/ffmpeg", ffprobe: "/home/u/.open-take/ffmpeg/b/ffprobe",
  });
  assert.match(brief, /ffmpeg is at `\/home\/u\/\.open-take\/ffmpeg\/b\/ffmpeg` and ffprobe at `\/home\/u\/\.open-take\/ffmpeg\/b\/ffprobe`/);
  assert.match(brief, /may not be on your PATH/);
  assert.match(brief, /Keep every frame and sheet you look at in \/films\/a\.viewer\/1\/frames/);
  assert.match(brief, /If you cannot take a single frame/);
  // nothing about what to look for
  assert.doesNotMatch(brief, /hard cut|caption|logo/i);
});

test("the session command puts the tools on PATH and allows what a viewer needs", () => {
  const cmd = viewerCommand({ dir: "/films/it's.viewer/2", ffmpeg: "/opt/ot/ffmpeg", ffprobe: "/opt/ot/ffprobe" });
  assert.equal(cmd,
    `cd '/films/it'\\''s.viewer/2' && PATH='/opt/ot':"$PATH" claude -p --allowedTools "Bash Read Write Edit Glob Grep" < BRIEF.md`);
  assert.ok(VIEWER_TOOLS.includes("Bash") && VIEWER_TOOLS.includes("Read") && VIEWER_TOOLS.includes("Write"));
  // tools found on PATH have no folder to add: the current folder is never put on PATH
  const onPath = viewerCommand({ dir: "/films/a.viewer/1", ffmpeg: "ffmpeg", ffprobe: "ffprobe" });
  assert.equal(onPath, `cd '/films/a.viewer/1' && claude -p --allowedTools "Bash Read Write Edit Glob Grep" < BRIEF.md`);
  assert.doesNotMatch(viewerBrief("/f/film.mp4", "/f/VIEWER.md", "npx open-take", { ffmpeg: "ffmpeg", ffprobe: "ffprobe" }), /is at/);
});

test("a round with notes and no frame is a viewer that saw nothing; with a frame it passes", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "ot-viewer-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const film = join(dir, "film.mp4");
  await writeFile(film, "not a film: the round only copies it");
  assert.equal((await checkViewer(film)).ok, false);
  assert.match((await checkViewer(film)).message, /no viewer round/);

  const v = await prepareViewer(film, "npx open-take");
  assert.equal(v.round, 1);
  // open-take's own by full path, or the bare name of one already on PATH
  assert.ok(isAbsolute(v.ffmpeg) || v.ffmpeg === "ffmpeg");
  assert.ok(isAbsolute(v.ffprobe) || v.ffprobe === "ffprobe");
  assert.equal(dirname(v.brief), v.dir);
  let c = await checkViewer(film);
  assert.equal(c.ok, false);
  assert.match(c.message, /no VIEWER\.md yet/);

  await writeFile(v.notes, "It was fine.\n");
  c = await checkViewer(film);
  assert.equal(c.ok, false);
  assert.match(c.message, /SAW NOTHING/);
  assert.deepEqual((await viewerRounds(film)).done.map((d) => [d.round, d.frames]), [[1, 0]]);

  await mkdir(join(v.dir, "frames"));
  await writeFile(join(v.dir, "frames", "0001.jpg"), "");
  c = await checkViewer(film);
  assert.equal(c.ok, true);
  assert.match(c.message, /1 frame/);

  // the check reads the latest round
  const second = await prepareViewer(film);
  assert.equal(second.round, 2);
  assert.equal((await checkViewer(film)).ok, false);
});
