// ffmpeg/ffprobe resolution — zero-config for npm consumers. Prefer the
// system binaries on PATH (often newer/faster, and what the repo has always
// used); fall back to the platform binaries from @ffmpeg-installer/ffmpeg and
// @ffprobe-installer/ffprobe (direct deps here, and already in the tree via
// @revideo/ffmpeg — so the fallback costs consumers no extra download). Throw
// with an install hint only when neither exists.

import { spawnSync } from "node:child_process";

let cachedFfmpeg: string | undefined;
let cachedFfprobe: string | undefined;

function runsOk(bin: string): boolean {
  try {
    return spawnSync(bin, ["-version"], { stdio: "ignore" }).status === 0;
  } catch {
    return false;
  }
}

async function installerPath(pkg: string): Promise<string | null> {
  try {
    const m = (await import(pkg)) as { default?: { path?: string }; path?: string };
    return m.default?.path ?? m.path ?? null;
  } catch {
    return null;
  }
}

export async function resolveFfmpeg(): Promise<string> {
  if (cachedFfmpeg) return cachedFfmpeg;
  if (runsOk("ffmpeg")) {
    cachedFfmpeg = "ffmpeg";
    return cachedFfmpeg;
  }
  const p = await installerPath("@ffmpeg-installer/ffmpeg");
  if (p && runsOk(p)) {
    cachedFfmpeg = p;
    return p;
  }
  throw new Error(
    "ffmpeg not found — install it (e.g. `brew install ffmpeg`) or `npm install` so the bundled @ffmpeg-installer binary resolves for this platform",
  );
}

export async function resolveFfprobe(): Promise<string> {
  if (cachedFfprobe) return cachedFfprobe;
  if (runsOk("ffprobe")) {
    cachedFfprobe = "ffprobe";
    return cachedFfprobe;
  }
  const p = await installerPath("@ffprobe-installer/ffprobe");
  if (p && runsOk(p)) {
    cachedFfprobe = p;
    return p;
  }
  throw new Error(
    "ffprobe not found — install ffmpeg (e.g. `brew install ffmpeg`) or `npm install` so the bundled @ffprobe-installer binary resolves for this platform",
  );
}
