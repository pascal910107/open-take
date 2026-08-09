import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  autoSyncAgentSkill,
  detectSkillDrift,
  installAgentSkill,
  skillHash,
  syncAgentSkill,
} from "../src/init";

const V1 = "# skill v1\ndo the old thing\n";
const V2 = "# skill v2\ndo the new thing\n";
const EDITED = "# skill v1\ndo the old thing\nplus my house rule\n";

const tmpRoot = () => mkdtemp(join(tmpdir(), "open-take-init-"));
const lockAt = async (root: string) =>
  JSON.parse(await readFile(join(root, ".agents/skills/open-take/skill-lock.json"), "utf8")) as {
    sha256: string;
    cliVersion?: string;
  };
const skillAt = (root: string) => readFile(join(root, ".agents/skills/open-take/SKILL.md"), "utf8");

test("init installs one canonical skill, its lock, and links Claude Code to it", async () => {
  const root = await tmpRoot();
  const result = await installAgentSkill({ root, skillText: V1, cliVersion: "9.9.9" });

  assert.equal(await readFile(result.canonicalPath, "utf8"), V1);
  assert.equal(await readFile(result.claudePath, "utf8"), V1);
  const lock = await lockAt(root);
  assert.equal(lock.sha256, skillHash(V1));
  assert.equal(lock.cliVersion, "9.9.9");
  if (process.platform !== "win32") {
    assert.equal((await lstat(join(root, ".claude/skills/open-take"))).isSymbolicLink(), true);
    assert.equal(result.claudeMode, "linked");
  }
});

test("Windows mode falls back to a copy", async () => {
  const root = await tmpRoot();
  const result = await installAgentSkill({ root, skillText: V1, platform: "win32" });

  assert.equal(result.claudeMode, "copied");
  assert.equal(await readFile(result.claudePath, "utf8"), V1);
});

test("drift detection tells missing/current/stale/modified/unknown apart", async () => {
  const root = await tmpRoot();
  assert.equal((await detectSkillDrift({ root, skillText: V1 })).state, "missing");

  await installAgentSkill({ root, skillText: V1 });
  assert.equal((await detectSkillDrift({ root, skillText: V1 })).state, "current");
  // a newer CLI ships V2: the untouched install is provably stale stock
  assert.equal((await detectSkillDrift({ root, skillText: V2 })).state, "stale");

  // the user edits the installed skill: hash no longer matches the lock
  await writeFile(join(root, ".agents/skills/open-take/SKILL.md"), EDITED);
  assert.equal((await detectSkillDrift({ root, skillText: V2 })).state, "modified");
});

test("a pre-lock install that differs is unknown, not stale", async () => {
  const root = await tmpRoot();
  await mkdir(join(root, ".agents/skills/open-take"), { recursive: true });
  await writeFile(join(root, ".agents/skills/open-take/SKILL.md"), V1);
  assert.equal((await detectSkillDrift({ root, skillText: V2 })).state, "unknown");
});

test("editor-shaped edits (CRLF, trailing newline) do not count as modified", async () => {
  const root = await tmpRoot();
  await installAgentSkill({ root, skillText: V1 });
  await writeFile(
    join(root, ".agents/skills/open-take/SKILL.md"),
    `${V1.replace(/\n/g, "\r\n")}\r\n`,
  );
  assert.equal((await detectSkillDrift({ root, skillText: V1 })).state, "current");
  assert.equal((await detectSkillDrift({ root, skillText: V2 })).state, "stale");
});

test("sync refreshes stale stock but refuses hash-verified local edits", async () => {
  const root = await tmpRoot();
  await installAgentSkill({ root, skillText: V1 });

  const refreshed = await syncAgentSkill({ root, skillText: V2 });
  assert.equal(refreshed.action, "installed");
  assert.equal(await skillAt(root), V2);
  assert.equal((await lockAt(root)).sha256, skillHash(V2));

  await writeFile(join(root, ".agents/skills/open-take/SKILL.md"), EDITED);
  const kept = await syncAgentSkill({ root, skillText: V2 });
  assert.equal(kept.action, "kept");
  assert.equal(await skillAt(root), EDITED);

  const forced = await syncAgentSkill({ root, skillText: V2, overwriteModified: true });
  assert.equal(forced.action, "installed");
  assert.equal(await skillAt(root), V2);
});

test("sync overwrites a pre-lock unknown install (what init always did) and locks it", async () => {
  const root = await tmpRoot();
  await mkdir(join(root, ".agents/skills/open-take"), { recursive: true });
  await writeFile(join(root, ".agents/skills/open-take/SKILL.md"), V1);

  const res = await syncAgentSkill({ root, skillText: V2 });
  assert.equal(res.action, "installed");
  assert.equal(res.drift, "unknown");
  assert.equal(await skillAt(root), V2);
  assert.equal((await lockAt(root)).sha256, skillHash(V2));
});

test("auto-sync refreshes only what it can prove", async () => {
  // stale stock → refreshed in place
  const stale = await tmpRoot();
  await installAgentSkill({ root: stale, skillText: V1 });
  assert.equal((await autoSyncAgentSkill({ root: stale, skillText: V2 })).action, "refreshed");
  assert.equal(await skillAt(stale), V2);

  // modified → untouched, silently
  const modified = await tmpRoot();
  await installAgentSkill({ root: modified, skillText: V1 });
  await writeFile(join(modified, ".agents/skills/open-take/SKILL.md"), EDITED);
  assert.equal((await autoSyncAgentSkill({ root: modified, skillText: V2 })).action, "none");
  assert.equal(await skillAt(modified), EDITED);

  // unknown → a hint, no write
  const unknown = await tmpRoot();
  await mkdir(join(unknown, ".agents/skills/open-take"), { recursive: true });
  await writeFile(join(unknown, ".agents/skills/open-take/SKILL.md"), V1);
  assert.equal((await autoSyncAgentSkill({ root: unknown, skillText: V2 })).action, "hint");
  assert.equal(await skillAt(unknown), V1);

  // missing → nothing to do
  const missing = await tmpRoot();
  assert.equal((await autoSyncAgentSkill({ root: missing, skillText: V2 })).action, "none");
});

test("auto-sync backfills the lock on a current pre-lock install", async () => {
  const root = await tmpRoot();
  await mkdir(join(root, ".agents/skills/open-take"), { recursive: true });
  await writeFile(join(root, ".agents/skills/open-take/SKILL.md"), V2);

  assert.equal((await autoSyncAgentSkill({ root, skillText: V2 })).action, "none");
  assert.equal((await lockAt(root)).sha256, skillHash(V2));
  // now that it is locked, the NEXT version can prove staleness
  assert.equal((await detectSkillDrift({ root, skillText: `${V2}more\n` })).state, "stale");
});
