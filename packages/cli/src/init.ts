// The skill agents read lives IN the project (committed, visible without any
// npm install) — which means an npm upgrade ships a new SKILL.md inside the
// package but the copy agents actually follow stays frozen. The lock written
// beside the skill records the hash of the text AS INSTALLED, which is what
// lets an updater tell "older stock version" (safe to refresh) from "the user
// edited this" (never overwrite silently). See syncAgentSkill /
// autoSyncAgentSkill for the two update policies built on it.
import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, readdir, symlink, unlink, writeFile } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";

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

export type SkillBundle = { skillText: string; resources?: Record<string, string> };
type SkillLock = {
  version: 1;
  sha256: string;
  resources?: Record<string, string>;
  cliVersion?: string;
  note?: string;
};

/** Resources are bounded Markdown references, never executable files or locks. */
function resourceEntries(resources: Record<string, string> = {}): [string, string][] {
  const entries = Object.entries(resources);
  if (entries.length > 64) throw new Error("Skill bundle exceeds 64 references");
  let bytes = 0;
  const names = new Set<string>();
  for (const [path, text] of entries) {
    const parts = path.split("/");
    if (
      parts.length < 2 ||
      parts.length > 9 ||
      parts[0] !== "references" ||
      !path.endsWith(".md") ||
      parts.some(
        (part) =>
          !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(part) ||
          /^(skill\.md|skill-lock\.json)$/i.test(part) ||
          part.endsWith(".") ||
          /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part),
      ) ||
      names.has(path.toLowerCase()) ||
      typeof text !== "string"
    )
      throw new Error(`Unsafe skill resource path: ${path}`);
    names.add(path.toLowerCase());
    bytes += Buffer.byteLength(text);
  }
  if (bytes > 2 * 1024 * 1024) throw new Error("Skill references exceed 2 MiB");
  for (const path of names) {
    const parts = path.split("/");
    for (let i = 1; i < parts.length; i++) {
      if (names.has(parts.slice(0, i).join("/")))
        throw new Error(`Unsafe skill resource path: file/directory collision at ${path}`);
    }
  }
  return entries;
}

/** Legacy guides may have no references; an explicit local Markdown link must resolve. */
function checkBundleReferences(bundle: SkillBundle): void {
  const links = bundle.skillText.matchAll(
    /(?:\]\(\s*<?|\]:\s*<?)(?:\.\/)?(references\/[a-zA-Z0-9._/-]+\.md)(?:[?#][^\s)>]*)?(?=[>\s)]|$)/g,
  );
  for (const match of links) {
    const path = match[1]!;
    if (!Object.hasOwn(bundle.resources ?? {}, path))
      throw new Error(`Missing skill reference: ${path} (re-run the package build)`);
  }
}

/** Read all texts from one selected bundle; never mix package and source files. */
export async function loadSkillBundle(directory: string): Promise<SkillBundle> {
  const resources: Record<string, string> = {};
  const walk = async (relativePath: string, depth: number): Promise<void> => {
    if (depth > 8) throw new Error("Skill reference directory is too deep");
    const path = resolve(directory, relativePath);
    const info = await lstat(path).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT" && relativePath === "references") return null;
      throw error;
    });
    if (!info) return;
    if (info.isSymbolicLink()) throw new Error(`Unsafe skill resource path: ${relativePath}`);
    if (info.isDirectory()) {
      for (const name of await readdir(path)) await walk(`${relativePath}/${name}`, depth + 1);
    } else {
      if (!info.isFile() || info.size > 2 * 1024 * 1024)
        throw new Error(`Invalid skill resource: ${relativePath}`);
      resources[relativePath] = await readFile(path, "utf8");
      resourceEntries(resources);
    }
  };
  const skillText = await readFile(resolve(directory, "SKILL.md"), "utf8");
  await walk("references", 0);
  const bundle = { skillText, resources };
  checkBundleReferences(bundle);
  return bundle;
}

async function readLock(lockPath: string): Promise<SkillLock | null> {
  try {
    const lock = JSON.parse(await readFile(lockPath, "utf8")) as SkillLock;
    if (typeof lock?.sha256 !== "string") return null;
    if (lock.resources) resourceEntries(lock.resources);
    return lock;
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

/** Reject symlinks in destinations before writing any member of the bundle. */
async function checkDestination(root: string, path: string): Promise<void> {
  const parts = relative(root, path).split(sep);
  let current = root;
  for (const part of parts) {
    current = resolve(current, part);
    const info = await lstat(current).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (info?.isSymbolicLink()) throw new Error(`Unsafe skill destination: ${current}`);
  }
}

export async function detectSkillDrift(
  options: SkillBundle & {
    root: string;
  },
): Promise<SkillDrift> {
  checkBundleReferences(options);
  const root = resolve(options.root);
  const paths = skillPaths(root);
  const entries: [string, string][] = [
    ["SKILL.md", options.skillText],
    ...resourceEntries(options.resources),
  ];
  const lock = await readLock(paths.lockPath);
  const states: SkillDriftState[] = [];
  let needsLockRepair = false;
  const inspect = async (directory: string, copied: boolean): Promise<void> => {
    for (const [name, text] of entries) {
      const path = resolve(directory, name);
      await checkDestination(root, path);
      const installed = await readFile(path, "utf8").catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return null;
        throw error;
      });
      const recorded = name === "SKILL.md" ? lock?.sha256 : lock?.resources?.[name];
      if (installed === null) {
        states.push(
          name === "SKILL.md" ? (copied ? "stale" : "missing") : recorded ? "modified" : "stale",
        );
      } else if (skillHash(installed) === skillHash(text)) {
        if (!copied && recorded !== skillHash(installed)) needsLockRepair = true;
        states.push("current");
      } else if (recorded) {
        states.push(recorded === skillHash(installed) ? "stale" : "modified");
      } else {
        // Legacy guide behavior is preserved; untracked reference collisions
        // are local files, never silently adopted or overwritten.
        states.push(name === "SKILL.md" ? "unknown" : "modified");
      }
    }
  };
  await inspect(paths.canonicalDir, false);
  const claude = await lstat(paths.claudeDir).catch(() => null);
  if (claude && !claude.isSymbolicLink()) await inspect(paths.claudeDir, true);
  const state = states.includes("modified")
    ? "modified"
    : states.includes("unknown")
      ? "unknown"
      : states.includes("missing")
        ? "missing"
        : states.includes("stale")
          ? "stale"
          : "current";
  return { state, needsLockRepair: state === "current" && needsLockRepair };
}

async function writeBundle(directory: string, options: SkillBundle): Promise<void> {
  const entries: [string, string][] = [
    ["SKILL.md", options.skillText],
    ...resourceEntries(options.resources),
  ];
  for (const [name, text] of entries) {
    const path = resolve(directory, name);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, text);
  }
}

/** Unconditional write: skill + lock + the Claude Code link. Policy (what may
 *  be overwritten when) lives in syncAgentSkill / autoSyncAgentSkill. */
export async function installAgentSkill(
  options: SkillBundle & {
    root: string;
    cliVersion?: string;
    platform?: NodeJS.Platform;
  },
): Promise<SkillInstallResult> {
  const root = resolve(options.root);
  const { canonicalDir, canonicalPath, lockPath, claudeDir, claudePath } = skillPaths(root);
  const platform = options.platform ?? process.platform;

  const entries = resourceEntries(options.resources);
  checkBundleReferences(options);
  const existing = await lstat(claudeDir).catch(() => null);
  await checkDestination(root, dirname(claudeDir));
  for (const name of ["SKILL.md", "skill-lock.json", ...entries.map(([name]) => name)]) {
    await checkDestination(root, resolve(canonicalDir, name));
    if (!existing?.isSymbolicLink()) await checkDestination(root, resolve(claudeDir, name));
  }
  await writeBundle(canonicalDir, options);
  const lock: SkillLock = {
    version: 1,
    sha256: skillHash(options.skillText),
    ...(entries.length
      ? { resources: Object.fromEntries(entries.map(([name, text]) => [name, skillHash(text)])) }
      : {}),
    ...(options.cliVersion ? { cliVersion: options.cliVersion } : {}),
    note: "hashes of the guide and references as installed — detects local edits; do not edit",
  };
  await writeFile(lockPath, `${JSON.stringify(lock, null, 2)}\n`);
  await mkdir(dirname(claudeDir), { recursive: true });

  if (existing?.isSymbolicLink()) {
    await unlink(claudeDir);
  } else if (existing) {
    await writeBundle(claudeDir, options);
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

  await writeBundle(claudeDir, options);
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
export async function syncAgentSkill(
  options: SkillBundle & {
    root: string;
    cliVersion?: string;
    overwriteModified?: boolean;
    platform?: NodeJS.Platform;
  },
): Promise<SkillSyncResult> {
  const root = resolve(options.root);
  const { state } = await detectSkillDrift({ ...options, root });
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
export async function autoSyncAgentSkill(
  options: SkillBundle & {
    root: string;
    cliVersion?: string;
  },
): Promise<SkillAutoSyncResult> {
  const root = resolve(options.root);
  const drift = await detectSkillDrift({ ...options, root });
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

/** Documentation refresh must never prevent recording, including bundle-loading failures. */
export async function autoSyncBundledAgentSkill(options: {
  root: string;
  loadBundle: () => Promise<SkillBundle>;
  cliVersion?: string;
}): Promise<SkillAutoSyncResult> {
  try {
    return await autoSyncAgentSkill({
      root: options.root,
      ...(await options.loadBundle()),
      cliVersion: options.cliVersion,
    });
  } catch {
    return { action: "none" };
  }
}
