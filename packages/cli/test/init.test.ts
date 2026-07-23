import assert from "node:assert/strict";
import { lstat, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { installAgentSkill } from "../src/init";

test("init installs one canonical skill and links Claude Code to it", async () => {
  const root = await mkdtemp(join(tmpdir(), "open-take-init-"));
  const result = await installAgentSkill({ root, skillText: "# test\n" });

  assert.equal(await readFile(result.canonicalPath, "utf8"), "# test\n");
  assert.equal(await readFile(result.claudePath, "utf8"), "# test\n");
  if (process.platform !== "win32") {
    assert.equal((await lstat(join(root, ".claude/skills/open-take"))).isSymbolicLink(), true);
    assert.equal(result.claudeMode, "linked");
  }
});

test("Windows mode falls back to a copy", async () => {
  const root = await mkdtemp(join(tmpdir(), "open-take-init-win-"));
  const result = await installAgentSkill({
    root,
    skillText: "# windows\n",
    platform: "win32",
  });

  assert.equal(result.claudeMode, "copied");
  assert.equal(await readFile(result.claudePath, "utf8"), "# windows\n");
});
