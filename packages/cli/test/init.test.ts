import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  autoSyncAgentSkill,
  autoSyncBundledAgentSkill,
  detectSkillDrift,
  installAgentSkill,
  loadSkillBundle,
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
    resources?: Record<string, string>;
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

const REF = "references/motion-composition.md";
const R1 = "# Motion\nCompose real product assets.\n";
const R2 = "# Motion\nCompose and animate real product assets.\n";
const referenceAt = (root: string, provider = ".agents") =>
  join(root, provider, "skills/open-take", REF);

test("old locks safely acquire new references even when SKILL.md is unchanged", async () => {
  const root = await tmpRoot();
  await installAgentSkill({ root, skillText: V1 });
  assert.equal((await lockAt(root)).resources, undefined);
  const options = { root, skillText: V1, resources: { [REF]: R1 } };
  assert.equal((await detectSkillDrift(options)).state, "stale");
  assert.equal((await autoSyncAgentSkill(options)).action, "refreshed");
  assert.equal(await readFile(referenceAt(root), "utf8"), R1);
  assert.equal(await readFile(referenceAt(root, ".claude"), "utf8"), R1);
  assert.equal((await lockAt(root)).resources?.[REF], skillHash(R1));
  assert.equal((await detectSkillDrift(options)).state, "current");
});

test("reference edits protect the whole bundle, including when only the guide changes", async () => {
  const root = await tmpRoot();
  const options = { root, skillText: V1, resources: { [REF]: R1 } };
  await installAgentSkill(options);
  await writeFile(referenceAt(root), `${R1}My custom rule.\n`);
  assert.equal((await detectSkillDrift(options)).state, "modified");
  assert.equal((await syncAgentSkill({ ...options, skillText: V2 })).action, "kept");
  assert.equal((await autoSyncAgentSkill({ ...options, skillText: V2 })).action, "none");
  assert.equal(await skillAt(root), V1);
  assert.equal(await readFile(referenceAt(root), "utf8"), `${R1}My custom rule.\n`);
  assert.equal((await syncAgentSkill({ ...options, overwriteModified: true })).action, "installed");
  assert.equal(await readFile(referenceAt(root), "utf8"), R1);
});

test("untracked reference collisions require force, even without an installed guide", async () => {
  for (const withGuide of [false, true]) {
    const root = await tmpRoot();
    if (withGuide) await installAgentSkill({ root, skillText: V1 });
    await mkdir(join(root, ".agents/skills/open-take/references"), { recursive: true });
    await writeFile(referenceAt(root), "My existing reference");
    const options = { root, skillText: V1, resources: { [REF]: R1 } };
    assert.equal((await syncAgentSkill(options)).action, "kept");
    assert.equal((await autoSyncAgentSkill(options)).action, "none");
    assert.equal(await readFile(referenceAt(root), "utf8"), "My existing reference");
    assert.equal(
      (await syncAgentSkill({ ...options, overwriteModified: true })).action,
      "installed",
    );
    assert.equal(await readFile(referenceAt(root), "utf8"), R1);
  }
});

test("reference hashes normalize CRLF and trailing whitespace like the guide", async () => {
  const root = await tmpRoot();
  await installAgentSkill({ root, skillText: V1, resources: { [REF]: R1 } });
  await writeFile(referenceAt(root), `${R1.replace(/\n/g, "\r\n")}\r\n`);
  assert.equal(
    (await detectSkillDrift({ root, skillText: V1, resources: { [REF]: R1 } })).state,
    "current",
  );
  assert.equal(
    (await autoSyncAgentSkill({ root, skillText: V1, resources: { [REF]: R2 } })).action,
    "refreshed",
  );
  assert.equal(await readFile(referenceAt(root), "utf8"), R2);
});

test("copy fallback synchronizes references and preserves edits in either provider", async () => {
  const root = await tmpRoot();
  const options = { root, skillText: V1, resources: { [REF]: R1 }, platform: "win32" as const };
  assert.equal((await installAgentSkill(options)).claudeMode, "copied");
  assert.equal(await readFile(referenceAt(root, ".claude"), "utf8"), R1);
  assert.equal(
    (await autoSyncAgentSkill({ ...options, resources: { [REF]: R2 } })).action,
    "refreshed",
  );
  assert.equal(await readFile(referenceAt(root, ".claude"), "utf8"), R2);
  await writeFile(referenceAt(root, ".claude"), "Claude-specific edit");
  assert.equal((await syncAgentSkill(options)).action, "kept");
  assert.equal((await autoSyncAgentSkill(options)).action, "none");
  assert.equal(await readFile(referenceAt(root), "utf8"), R2);
  assert.equal(await readFile(referenceAt(root, ".claude"), "utf8"), "Claude-specific edit");
  await syncAgentSkill({ ...options, overwriteModified: true });
  assert.equal(await readFile(referenceAt(root, ".claude"), "utf8"), R1);
});

test("a deleted tracked reference is a local edit, not a missing new reference", async () => {
  const root = await tmpRoot();
  const options = { root, skillText: V1, resources: { [REF]: R1 } };
  await installAgentSkill(options);
  await unlink(referenceAt(root));
  assert.equal((await syncAgentSkill(options)).action, "kept");
  await assert.rejects(readFile(referenceAt(root)), { code: "ENOENT" });
});

test("resource paths reject escapes, absolute paths, reserved files and case aliases before writes", async () => {
  const root = await tmpRoot();
  for (const path of [
    "../outside.md",
    "/tmp/outside.md",
    "references/../outside.md",
    "references//file.md",
    "references/./file.md",
    "references\\outside.md",
    "C:/outside.md",
    "SKILL.md",
    "skill-lock.json",
    "references/SKILL.md",
    "references/skill-lock.json",
    "references/script.js",
    "references/CON.md",
    "references/nul/file.md",
    "references/folder./file.md",
  ]) {
    await assert.rejects(
      installAgentSkill({ root, skillText: V1, resources: { [path]: R1 } }),
      /Unsafe skill resource path/,
    );
    await assert.rejects(
      detectSkillDrift({ root, skillText: V1, resources: { [path]: R1 } }),
      /Unsafe skill resource path/,
    );
  }
  await assert.rejects(
    installAgentSkill({
      root,
      skillText: V1,
      resources: {
        "references/motion.md": R1,
        "references/Motion.md": R2,
      },
    }),
    /Unsafe skill resource path/,
  );
  await assert.rejects(skillAt(root), { code: "ENOENT" });
});

test("symlinked resource destinations cannot write outside the skill directory, even with force", async () => {
  const root = await tmpRoot();
  const external = await tmpRoot();
  await installAgentSkill({ root, skillText: V1 });
  await writeFile(join(external, "motion-composition.md"), "Protected external file");
  await symlink(external, join(root, ".agents/skills/open-take/references"), "dir");
  await assert.rejects(
    syncAgentSkill({ root, skillText: V2, resources: { [REF]: R1 }, overwriteModified: true }),
    /Unsafe skill destination/,
  );
  assert.equal(await skillAt(root), V1);
  assert.equal(
    await readFile(join(external, "motion-composition.md"), "utf8"),
    "Protected external file",
  );
});

test("bundle loading keeps guide and references together and bounds content", async () => {
  const directory = await tmpRoot();
  await mkdir(join(directory, "references"));
  await writeFile(join(directory, "SKILL.md"), V1);
  await writeFile(join(directory, REF), R1);
  assert.deepEqual(await loadSkillBundle(directory), { skillText: V1, resources: { [REF]: R1 } });
  await writeFile(join(directory, "references/script.js"), "untrusted");
  await assert.rejects(loadSkillBundle(directory), /Unsafe skill resource path/);
  await unlink(join(directory, "references/script.js"));
  await writeFile(join(directory, REF), "x".repeat(2 * 1024 * 1024 + 1));
  await assert.rejects(loadSkillBundle(directory), /Invalid skill resource/);
});

test("copy fallback also protects untracked conflicting reference files", async () => {
  const root = await tmpRoot();
  await installAgentSkill({ root, skillText: V1, platform: "win32" });
  await mkdir(join(root, ".claude/skills/open-take/references"));
  await writeFile(referenceAt(root, ".claude"), "Existing Claude reference");
  const options = { root, skillText: V1, resources: { [REF]: R1 } };
  assert.equal((await syncAgentSkill(options)).action, "kept");
  await assert.rejects(readFile(referenceAt(root)), { code: "ENOENT" });
  assert.equal(await readFile(referenceAt(root, ".claude"), "utf8"), "Existing Claude reference");
});

test("legacy bundles may omit references and oversized resource maps fail before writing", async () => {
  const root = await tmpRoot();
  await writeFile(join(root, "SKILL.md"), V1);
  assert.deepEqual(await loadSkillBundle(root), { skillText: V1, resources: {} });
  const resources = Object.fromEntries(
    Array.from({ length: 65 }, (_, i) => [`references/ref-${i}.md`, R1]),
  );
  await assert.rejects(
    installAgentSkill({ root, skillText: V1, resources }),
    /exceeds 64 references/,
  );
  await assert.rejects(
    installAgentSkill({
      root,
      skillText: V1,
      resources: { [REF]: "x".repeat(2 * 1024 * 1024 + 1) },
    }),
    /exceed 2 MiB/,
  );
  await assert.rejects(skillAt(root), { code: "ENOENT" });
});

test("a guide linking a missing reference is rejected before installation", async () => {
  const bundle = await tmpRoot(),
    project = await tmpRoot();
  await installAgentSkill({ root: project, skillText: V1 });
  const guide = "# guide\nRead [motion](references/motion-composition.md#layers).\n";
  await writeFile(join(bundle, "SKILL.md"), guide);
  await assert.rejects(
    loadSkillBundle(bundle),
    /Missing skill reference: references\/motion-composition\.md/,
  );
  await assert.rejects(
    syncAgentSkill({ root: project, skillText: guide, resources: {} }),
    /Missing skill reference/,
  );
  assert.equal(await skillAt(project), V1);
  await mkdir(join(bundle, "references"));
  await writeFile(join(bundle, REF), R1);
  assert.equal((await loadSkillBundle(bundle)).resources?.[REF], R1);
});

test("reference-style and angle-bracket local links also require bundled references", async () => {
  const root = await tmpRoot();
  for (const guide of [
    "[motion]: references/motion-composition.md",
    "[motion](<./references/motion-composition.md>)",
  ]) {
    await assert.rejects(installAgentSkill({ root, skillText: guide }), /Missing skill reference/);
  }
  await assert.rejects(skillAt(root), { code: "ENOENT" });
});

test("quiet auto-sync catches actual malformed-bundle loading and preserves installed files", async () => {
  const root = await tmpRoot(),
    directory = await tmpRoot();
  await installAgentSkill({ root, skillText: V1 });
  await writeFile(join(directory, "SKILL.md"), V2);
  await mkdir(join(directory, "references"));
  await writeFile(join(directory, "references/script.js"), "invalid resource");
  assert.deepEqual(
    await autoSyncBundledAgentSkill({ root, loadBundle: () => loadSkillBundle(directory) }),
    { action: "none" },
  );
  assert.equal(await skillAt(root), V1);
  await unlink(join(directory, "references/script.js"));
  assert.equal(
    (await autoSyncBundledAgentSkill({ root, loadBundle: () => loadSkillBundle(directory) }))
      .action,
    "refreshed",
  );
  assert.equal(await skillAt(root), V2);
});

test("file/directory resource collisions fail before modifying the installed guide", async () => {
  const root = await tmpRoot();
  await installAgentSkill({ root, skillText: V1 });
  for (const resources of [
    { "references/a.md": R1, "references/a.md/b.md": R2 },
    { "references/A.md": R1, "references/a.md/b.md": R2 },
  ]) {
    await assert.rejects(
      syncAgentSkill({ root, skillText: V2, resources }),
      /file\/directory collision/,
    );
    assert.equal(await skillAt(root), V1);
  }
});

test("packaging refuses dangling references before clearing the previous bundle", async () => {
  const root = await tmpRoot(),
    scripts = join(root, "packages/cli/scripts"),
    source = join(root, "skills/open-take"),
    destination = join(root, "packages/cli/skill");
  await mkdir(scripts, { recursive: true });
  await mkdir(join(source, "references"), { recursive: true });
  await mkdir(destination, { recursive: true });
  await copyFile(
    new URL("../scripts/copy-skill.mjs", import.meta.url),
    join(scripts, "copy-skill.mjs"),
  );
  await writeFile(join(destination, "SKILL.md"), V1);
  const guide = "# guide\nRead [motion](references/motion-composition.md).\n";
  await writeFile(join(source, "SKILL.md"), guide);
  const run = promisify(execFile);
  await assert.rejects(
    run(process.execPath, [join(scripts, "copy-skill.mjs")]),
    /Missing skill reference/,
  );
  assert.equal(await readFile(join(destination, "SKILL.md"), "utf8"), V1);
  await writeFile(join(source, REF), R1);
  await run(process.execPath, [join(scripts, "copy-skill.mjs")]);
  assert.equal(await readFile(join(destination, "SKILL.md"), "utf8"), guide);
  assert.equal(await readFile(join(destination, REF), "utf8"), R1);
});
