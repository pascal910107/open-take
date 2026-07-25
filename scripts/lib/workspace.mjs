// Shared workspace facts for the two halves of a release: `release.mjs` runs on
// a laptop and prepares/tags, `publish-oidc.mjs` runs in CI and uploads. Both
// need the same answer to "which packages ship, and in what order", so that
// answer lives here rather than being written twice and drifting.

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const PKG_DIR = join(REPO_ROOT, "packages");

// create-open-take is a standalone project initializer: it installs
// open-take@latest rather than depending on the workspace, so it is not part of
// the version-locked ship chain.
export const INDEPENDENT = new Set(["create-open-take"]);

export function readPackages() {
  const pkgs = [];
  for (const entry of readdirSync(PKG_DIR)) {
    const manifestPath = join(PKG_DIR, entry, "package.json");
    let manifest;
    try {
      manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    } catch {
      continue; // not a package dir
    }
    if (manifest.private) continue; // adapters etc — never published
    pkgs.push({
      name: manifest.name,
      version: manifest.version,
      dir: join(PKG_DIR, entry),
      manifestPath,
    });
  }
  return pkgs;
}

/**
 * Topological order over workspace-internal deps, so a package is only ever
 * published after everything it depends on.
 *
 * This exists because the order is NOT obvious by eye: @open-take/compositor
 * depends on @open-take/revideo-renderer, and the hand-written procedure this
 * replaced listed three packages when the chain is four. Both pnpm pack and
 * pnpm publish rewrite `workspace:*` to an exact version, so publishing out of
 * order uploads a manifest pointing at a version that does not exist yet.
 */
export function publishOrder(pkgs) {
  const byName = new Map(pkgs.map((p) => [p.name, p]));
  const depsOf = (p) => {
    const m = JSON.parse(readFileSync(p.manifestPath, "utf8"));
    return Object.keys({ ...m.dependencies, ...m.peerDependencies }).filter((d) => byName.has(d));
  };
  const ordered = [];
  const state = new Map();
  const visit = (p) => {
    const seen = state.get(p.name);
    if (seen === "done") return;
    if (seen === "visiting") throw new Error(`dependency cycle in the workspace at ${p.name}`);
    state.set(p.name, "visiting");
    for (const d of depsOf(p)) visit(byName.get(d));
    state.set(p.name, "done");
    ordered.push(p);
  };
  for (const p of pkgs) visit(p);
  return ordered;
}

/**
 * Versions the registry actually serves. A direct read, not `npm view` — npm
 * caches, which is exactly how a missing publish gets mistaken for a successful
 * one. Returns an empty set for a package that does not exist yet.
 */
export async function publishedVersions(name) {
  const res = await fetch(`https://registry.npmjs.org/${encodeURIComponent(name)}`, {
    headers: { accept: "application/json" },
  });
  if (res.status === 404) return new Set();
  if (!res.ok) throw new Error(`registry probe for ${name} failed with HTTP ${res.status}`);
  const body = await res.json();
  return new Set(Object.keys(body.versions ?? {}));
}

/** Wait for the registry to serve a just-published version (it lags a little). */
export async function waitForVersion(name, version, tries = 5, delayMs = 2000) {
  for (let i = 0; i < tries; i++) {
    if (i) await new Promise((r) => setTimeout(r, delayMs));
    if ((await publishedVersions(name)).has(version)) return true;
  }
  return false;
}
