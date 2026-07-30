// The take layout: ONE postable mp4 at the path its author asked for, and a
// `<name>.take/` working dir beside it holding everything else. These tests pin
// the four ways a caller can name a take (the master, the working dir, a file
// inside it, a directory holding one) — every verb accepts all four — and the
// two ambiguities that must speak up instead of guessing: a folder with two
// takes, and a take still in the old flat layout.

import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { test } from "node:test";
import { resolveTakePaths } from "../src/take.js";

test("the master names the take; everything else lives in its working dir", async () => {
  const take = await resolveTakePaths("out/demo.mp4");
  assert.equal(take.name, "demo");
  assert.equal(take.base, resolve("out/demo"));
  assert.equal(take.mp4Path, resolve("out/demo.mp4"));
  assert.equal(take.dir, resolve("out/demo.take"));
  // the postable master is the ONLY member outside the working dir
  for (const p of [
    take.compositionPath,
    take.capturePath,
    take.captureLogPath,
    take.reviewPath,
    take.draftPath,
    take.abPath,
    take.prevPath,
    take.prevCompositionPath,
    take.framesPath,
    take.dossierPath,
    take.notesPath,
    take.notesCursorPath,
  ])
    assert.equal(p.startsWith(take.dir + sep), true, `${p} belongs in the working dir`);
  assert.equal(take.compositionPath, join(take.dir, "composition.json"));
  assert.equal(take.capturePath, join(take.dir, "capture.mp4"));
  assert.equal(take.captureLogPath, join(take.dir, "capture.json"));
  assert.equal(take.dossierPath, join(take.dir, "dossier.md"));
});

test("a bare --out name gets the mp4 extension it meant", async () => {
  const take = await resolveTakePaths("out/demo");
  assert.equal(take.mp4Path, resolve("out/demo.mp4"));
  assert.equal(take.dir, resolve("out/demo.take"));
});

test("the working dir, and any file in it, resolve the whole take", async () => {
  // built with the platform's own separators so this holds on Windows too
  const dir = resolve("nowhere");
  for (const input of [
    join(dir, "demo.take"),
    join(dir, "demo.take", "composition.json"),
    join(dir, "demo.take", "draft.mp4"),
    join(dir, "demo.take", "dossier.md"),
  ]) {
    const take = await resolveTakePaths(input);
    assert.equal(take.name, "demo", input);
    assert.equal(take.base, join(dir, "demo"), input);
    assert.equal(take.mp4Path, join(dir, "demo.mp4"), input);
  }
});

test("a directory holding exactly one take resolves it; two speak up", async () => {
  const dir = await mkdtemp(join(tmpdir(), "open-take-family-"));
  try {
    await mkdir(join(dir, "myapp.take"), { recursive: true });
    const one = await resolveTakePaths(dir);
    assert.equal(one.base, join(dir, "myapp"));

    // two demos in one folder: `notes .` must not silently pick one
    await mkdir(join(dir, "other.take"), { recursive: true });
    await assert.rejects(() => resolveTakePaths(dir), /holds 2 takes[\s\S]*myapp[\s\S]*other/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("an empty directory says what a take looks like", async () => {
  const dir = await mkdtemp(join(tmpdir(), "open-take-family-"));
  try {
    await assert.rejects(() => resolveTakePaths(dir), /no take in/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// The pre-`.take/` layout put the whole family beside the master as
// `demo.composition.json`, `demo.capture.mp4`, … Pointing at one of those (a
// path from an old doc, or an old take on disk) would otherwise strip the
// suffix and resolve to a take called "demo.capture". Say what happened.
test("an old flat take is explained, not silently mis-resolved", async () => {
  const dir = await mkdtemp(join(tmpdir(), "open-take-family-"));
  try {
    for (const member of [
      "demo.composition.json",
      "demo.capture.mp4",
      "demo.review.mp4",
      "demo.notes.md",
    ]) {
      await writeFile(join(dir, member), "{}");
      await assert.rejects(
        () => resolveTakePaths(join(dir, member)),
        /old flat take layout[\s\S]*demo\.take/,
        member,
      );
    }
    // and the directory form finds the flat take instead of claiming there is none
    await assert.rejects(() => resolveTakePaths(dir), /old flat take layout/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// The flat-layout names are only a diagnosis for files that EXIST. Nothing
// reserves them any more: the suffixes that used to be forbidden as `--out`
// names now live inside the working dir, where they cannot collide.
test("a take may be NAMED like an old member, as long as it is a new take", async () => {
  const take = await resolveTakePaths("out/foo.draft.mp4");
  assert.equal(take.mp4Path, resolve("out/foo.draft.mp4"));
  assert.equal(take.dir, resolve("out/foo.draft.take"));
  assert.equal(take.draftPath, resolve("out/foo.draft.take/draft.mp4"));
});
