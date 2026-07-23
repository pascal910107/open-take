// pnpm 10's tarball extraction does not always preserve the executable
// bit on `node-pty`'s prebuilt `spawn-helper` binary. Without +x,
// `posix_spawnp` fails as soon as NodePtyDriver.open() is called. This
// script walks every install location of node-pty under node_modules
// and chmods the helper. Idempotent + safe to run on every install.
//
// Triggered via the root postinstall (see package.json). Each repair is a no-op
// when that platform/layout does not contain the relevant binaries.

import { chmodSync, existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// fileURLToPath, not .pathname: on Windows the latter yields "/C:/Users/…",
// which every fs call then misses (silently — the walk just finds nothing).
const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const PNPM_STORE = join(REPO_ROOT, "node_modules", ".pnpm");

function walkNodePtyDirs(root) {
  const out = [];
  if (!existsSync(root)) return out;
  for (const entry of readdirSync(root)) {
    if (!entry.startsWith("node-pty@")) continue;
    const inner = join(root, entry, "node_modules", "node-pty");
    if (existsSync(inner)) out.push(inner);
  }
  return out;
}

function fixHelperUnder(ptyRoot) {
  const prebuilds = join(ptyRoot, "prebuilds");
  if (!existsSync(prebuilds)) return 0;
  let count = 0;
  for (const platform of readdirSync(prebuilds)) {
    const helper = join(prebuilds, platform, "spawn-helper");
    if (!existsSync(helper)) continue;
    const mode = statSync(helper).mode;
    // 0o111 == +x for owner/group/other. Preserve existing bits.
    chmodSync(helper, mode | 0o111);
    count++;
  }
  return count;
}

let totalFixed = 0;
for (const ptyDir of walkNodePtyDirs(PNPM_STORE)) {
  totalFixed += fixHelperUnder(ptyDir);
}
// Direct install path (non-pnpm-store layout — rare in this repo but
// safe to cover).
const directPty = join(REPO_ROOT, "node_modules", "node-pty");
if (existsSync(directPty)) totalFixed += fixHelperUnder(directPty);

if (totalFixed > 0) {
  process.stdout.write(
    `fix-node-pty-perms: chmod +x on ${totalFixed} spawn-helper binar${totalFixed === 1 ? "y" : "ies"}\n`,
  );
}

// @open-take/compositor renders via revideo, which spawns the prebuilt
// `@ffmpeg-installer` / `@ffprobe-installer` binaries. pnpm 10 skips their
// chmod postinstall (they're not in onlyBuiltDependencies), leaving them
// non-executable → EACCES at render time. Traverse only installer packages,
// rather than the whole dependency tree, and +x every ffmpeg/ffprobe binary.
// Idempotent.
function fixMediaBinsUnder(root) {
  let count = 0;
  if (!existsSync(root)) return count;
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isDirectory()) {
        stack.push(p);
      } else if (
        (e.isFile() || e.isSymbolicLink()) &&
        ["ffmpeg", "ffprobe", "ffmpeg.exe", "ffprobe.exe"].includes(e.name)
      ) {
        try {
          const mode = statSync(p).mode;
          chmodSync(p, mode | 0o111);
          count++;
        } catch {
          // symlink target missing etc — skip
        }
      }
    }
  }
  return count;
}

let mediaFixed = 0;
if (existsSync(PNPM_STORE)) {
  for (const entry of readdirSync(PNPM_STORE)) {
    if (!entry.startsWith("@ffmpeg-installer+") && !entry.startsWith("@ffprobe-installer+")) {
      continue;
    }
    mediaFixed += fixMediaBinsUnder(join(PNPM_STORE, entry));
  }
}
// npm/yarn's hoisted layout does not have pnpm's encoded package directories.
mediaFixed += fixMediaBinsUnder(join(REPO_ROOT, "node_modules", "@ffmpeg-installer"));
mediaFixed += fixMediaBinsUnder(join(REPO_ROOT, "node_modules", "@ffprobe-installer"));
if (mediaFixed > 0) {
  process.stdout.write(
    `fix-node-pty-perms: chmod +x on ${mediaFixed} ffmpeg/ffprobe binar${mediaFixed === 1 ? "y" : "ies"}\n`,
  );
}
