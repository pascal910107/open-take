// The skill agents read lives IN the project (committed, visible without any
// npm install) — which means an npm upgrade ships a new SKILL.md inside the
// package but the copy agents actually follow stays frozen. The lock written
// beside the skill records the hash of the text AS INSTALLED, which is what
// lets an updater tell "older stock version" (safe to refresh) from "the user
// edited this" (never overwrite silently). See syncAgentSkill /
// autoSyncAgentSkill for the two update policies built on it.
import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, symlink, unlink, writeFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";

export type SkillInstallResult = {
  canonicalPath: string;
  claudePath: string;
  claudeMode: "linked" | "copied";
};

/** Where the skill lives in a project: `.agents/skills/` is canonical,
 *  `.claude/skills/` is a symlink into it (or a synchronized copy where
 *  symlinks don't work). */
function skillPaths(root: string) {
  const canonicalDir = resolve(root, ".agents", "skills", "open-take");
  const claudeDir = resolve(root, ".claude", "skills", "open-take");
  return {
    canonicalDir,
    canonicalPath: resolve(canonicalDir, "SKILL.md"),
    lockPath: resolve(canonicalDir, "skill-lock.json"),
    claudeDir,
    claudePath: resolve(claudeDir, "SKILL.md"),
  };
}

/** Hash of the skill TEXT, tolerant of the edits editors make on their own
 *  (CRLF, a trailing newline) — those must never read as "the user customized
 *  the skill". */
export function skillHash(text: string): string {
  return createHash("sha256").update(text.replace(/\r\n/g, "\n").trimEnd()).digest("hex");
}

type SkillLock = { version: 1; sha256: string; cliVersion?: string; note?: string };

async function readLock(lockPath: string): Promise<SkillLock | null> {
  try {
    const lock = JSON.parse(await readFile(lockPath, "utf8")) as SkillLock;
    return typeof lock?.sha256 === "string" ? lock : null;
  } catch {
    return null;
  }
}

export type SkillDriftState =
  | "missing" // no skill installed here
  | "current" // exactly the text bundled with this CLI
  | "stale" // provably unmodified stock, older than this CLI's copy
  | "modified" // hash-verified local edits
  | "unknown"; // differs, but predates the lock — stale or modified, can't tell

export type SkillDrift = {
  state: SkillDriftState;
  /** true when the text is current but the lock is absent or records a
   *  different hash — a quiet rewrite converges it so FUTURE drift is provable. */
  needsLockRepair: boolean;
};

export async function detectSkillDrift(options: {
  root: string;
  skillText: string;
}): Promise<SkillDrift> {
  const { canonicalPath, lockPath } = skillPaths(resolve(options.root));
  const installed = await readFile(canonicalPath, "utf8").catch(() => null);
  if (installed == null) return { state: "missing", needsLockRepair: false };
  const installedHash = skillHash(installed);
  const lock = await readLock(lockPath);
  if (installedHash === skillHash(options.skillText))
    return { state: "current", needsLockRepair: lock?.sha256 !== installedHash };
  if (lock == null) return { state: "unknown", needsLockRepair: false };
  return {
    state: lock.sha256 === installedHash ? "stale" : "modified",
    needsLockRepair: false,
  };
}

async function copyClaudeSkill(path: string, skillText: string): Promise<void> {
  await mkdir(path, { recursive: true });
  await writeFile(resolve(path, "SKILL.md"), skillText);
}

/** Unconditional write: skill + lock + the Claude Code link. Policy (what may
 *  be overwritten when) lives in syncAgentSkill / autoSyncAgentSkill. */
export async function installAgentSkill(options: {
  root: string;
  skillText: string;
  cliVersion?: string;
  platform?: NodeJS.Platform;
}): Promise<SkillInstallResult> {
  const root = resolve(options.root);
  const { canonicalDir, canonicalPath, lockPath, claudeDir, claudePath } = skillPaths(root);
  const platform = options.platform ?? process.platform;

  await mkdir(canonicalDir, { recursive: true });
  await writeFile(canonicalPath, options.skillText);
  const lock: SkillLock = {
    version: 1,
    sha256: skillHash(options.skillText),
    ...(options.cliVersion ? { cliVersion: options.cliVersion } : {}),
    note: "hash of SKILL.md as installed — lets open-take tell local edits from stale versions; do not edit",
  };
  await writeFile(lockPath, `${JSON.stringify(lock, null, 2)}\n`);
  await mkdir(dirname(claudeDir), { recursive: true });

  const existing = await lstat(claudeDir).catch(() => null);
  if (existing?.isSymbolicLink()) {
    await unlink(claudeDir);
  } else if (existing) {
    await copyClaudeSkill(claudeDir, options.skillText);
    return { canonicalPath, claudePath, claudeMode: "copied" };
  }

  if (platform !== "win32") {
    try {
      await symlink(relative(dirname(claudeDir), canonicalDir), claudeDir, "dir");
      return { canonicalPath, claudePath, claudeMode: "linked" };
    } catch {
      // Some filesystems disallow symlinks. Keep Claude Code support by
      // falling back to a synchronized copy.
    }
  }

  await copyClaudeSkill(claudeDir, options.skillText);
  return { canonicalPath, claudePath, claudeMode: "copied" };
}

export type SkillSyncResult =
  | ({ action: "installed"; drift: SkillDriftState } & SkillInstallResult)
  | { action: "kept"; drift: "modified"; canonicalPath: string; claudePath: string };

/** The explicit path (`init`, `skill install`, `ci`): install or refresh the
 *  skill, EXCEPT over hash-verified local edits — those are the user's and
 *  survive unless overwriteModified says otherwise. An "unknown" install
 *  (pre-lock era) is overwritten, which is exactly what init always did before
 *  the lock existed; protection starts with the first locked install. */
export async function syncAgentSkill(options: {
  root: string;
  skillText: string;
  cliVersion?: string;
  overwriteModified?: boolean;
  platform?: NodeJS.Platform;
}): Promise<SkillSyncResult> {
  const root = resolve(options.root);
  const { state } = await detectSkillDrift({ root, skillText: options.skillText });
  if (state === "modified" && !options.overwriteModified) {
    const { canonicalPath, claudePath } = skillPaths(root);
    return { action: "kept", drift: "modified", canonicalPath, claudePath };
  }
  const installed = await installAgentSkill(options);
  return { action: "installed", drift: state, ...installed };
}

export type SkillAutoSyncResult =
  | { action: "none" }
  | { action: "refreshed"; canonicalPath: string }
  | { action: "hint"; canonicalPath: string };

/** The quiet path `make` runs: refresh a PROVABLY stock skill so npm upgrades
 *  reach the project without anyone re-running init, repair a missing lock
 *  when the text already matches, and touch nothing it can't prove — a
 *  modified skill is the user's, an unknown one gets a hint instead of a
 *  write, a missing one stays missing (a human driving make directly never
 *  asked for skill files). */
export async function autoSyncAgentSkill(options: {
  root: string;
  skillText: string;
  cliVersion?: string;
}): Promise<SkillAutoSyncResult> {
  const root = resolve(options.root);
  const drift = await detectSkillDrift({ root, skillText: options.skillText });
  const { canonicalPath } = skillPaths(root);
  if (drift.state === "stale") {
    await installAgentSkill(options);
    return { action: "refreshed", canonicalPath };
  }
  if (drift.state === "current" && drift.needsLockRepair) {
    await installAgentSkill(options); // same text — this just writes the lock
    return { action: "none" };
  }
  if (drift.state === "unknown") return { action: "hint", canonicalPath };
  return { action: "none" };
}
