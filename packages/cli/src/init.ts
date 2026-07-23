import { lstat, mkdir, symlink, unlink, writeFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";

export type SkillInstallResult = {
  canonicalPath: string;
  claudePath: string;
  claudeMode: "linked" | "copied";
};

async function copyClaudeSkill(path: string, skillText: string): Promise<void> {
  await mkdir(path, { recursive: true });
  await writeFile(resolve(path, "SKILL.md"), skillText);
}

export async function installAgentSkill(options: {
  root: string;
  skillText: string;
  platform?: NodeJS.Platform;
}): Promise<SkillInstallResult> {
  const root = resolve(options.root);
  const canonicalDir = resolve(root, ".agents", "skills", "open-take");
  const canonicalPath = resolve(canonicalDir, "SKILL.md");
  const claudeDir = resolve(root, ".claude", "skills", "open-take");
  const claudePath = resolve(claudeDir, "SKILL.md");
  const platform = options.platform ?? process.platform;

  await mkdir(canonicalDir, { recursive: true });
  await writeFile(canonicalPath, options.skillText);
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
