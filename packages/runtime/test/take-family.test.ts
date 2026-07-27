// take family — the dossier joins the sibling convention: any member of the
// family (including the dossier itself) resolves the rest, and the dossier
// path is derived so `make` can nudge for it and the skill can find it.

import assert from "node:assert/strict";
import { resolve } from "node:path";
import { test } from "node:test";
import { resolveTakePaths } from "../src/take.js";

test("take family includes the dossier sibling", async () => {
  const take = await resolveTakePaths("out/demo.mp4");
  assert.equal(take.dossierPath, resolve("out/demo.dossier.md"));
});

test("a dossier path resolves its take family", async () => {
  const take = await resolveTakePaths("out/demo.dossier.md");
  assert.equal(take.base, resolve("out/demo"));
  assert.equal(take.mp4Path, resolve("out/demo.mp4"));
  assert.equal(take.capturePath, resolve("out/demo.capture.mp4"));
});
