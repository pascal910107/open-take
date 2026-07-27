// The CI half of a release: upload the already-tagged, already-gated packages
// to npm using Trusted Publishing (OIDC). No token, no 2FA code, nothing to
// rotate — GitHub mints a short-lived identity token and npm checks it against
// the trusted publisher configured for each package.
//
// Why it packs with pnpm and uploads with npm, rather than just `pnpm publish`:
//
//   - Only pnpm resolves `workspace:*` into the real version at pack time. npm
//     would upload that specifier verbatim and every install would break.
//   - Only npm speaks OIDC. pnpm has no trusted-publishing support (pnpm#9812),
//     and `pnpm publish` under OIDC fails outright.
//
// So each package is packed by pnpm — which is exactly what
// test/package-artifacts.test.mjs already asserts produces a resolved,
// `workspace:*`-free manifest — and the resulting tarball is handed to
// `npm publish <tarball>`, which authenticates over OIDC and attaches provenance.
//
// Idempotent: a version already on the registry is skipped, so re-running a
// half-finished workflow finishes it instead of failing on E409.

import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  INDEPENDENT,
  REPO_ROOT,
  publishOrder,
  publishedVersions,
  readPackages,
  waitForVersion,
} from "./lib/workspace.mjs";

const argv = process.argv.slice(2);
const DRY = argv.includes("--dry-run");
const WITH_CREATE = argv.includes("--with-create");
const expected = argv.find((a) => /^\d+\.\d+\.\d+/.test(a));

const log = (m) => process.stdout.write(`${m}\n`);
const die = (m) => {
  process.stderr.write(`\npublish: ${m}\n`);
  process.exit(1);
};

// The workflow has no flag to forward, so whether an independently-versioned
// package ships is decided by the tree: `pnpm release --with-create` bumps
// create-open-take onto the release version, and "its version equals the tag"
// IS that signal. Without this, `--with-create` bumped and tagged a package CI
// then filtered out, and the local wait loop hung forever on a version nobody
// was uploading. A release that leaves it behind keeps its old version, which
// never matches the tag, so it stays out.
const shipsIndependent = (p) =>
  WITH_CREATE || DRY || (expected !== undefined && p.version === expected);
const chain = publishOrder(readPackages()).filter(
  (p) => !INDEPENDENT.has(p.name) || shipsIndependent(p),
);

log("publishing over OIDC (trusted publishing)\n");
log("order (from the workspace dependency graph):");
for (const [i, p] of chain.entries()) log(`  ${i + 1}. ${p.name}@${p.version}`);

// The tag says what is being released; the manifests say what would actually be
// uploaded. If they disagree, the tag was pushed against the wrong tree and the
// upload would silently ship a different version than the one being announced.
if (expected) {
  const off = chain.filter((p) => p.version !== expected);
  if (off.length)
    die(
      `tag says ${expected} but ${off.map((p) => `${p.name}@${p.version}`).join(", ")} disagree — ` +
        `the tag is on the wrong commit`,
    );
  log(`\nall ${chain.length} packages agree with the tag (${expected})`);
}

// npm's OIDC support landed in 11.5.1; an older CLI silently falls back to
// looking for a token and fails with a confusing 404/401 instead.
const npmVersion = execFileSync("npm", ["--version"], { encoding: "utf8" }).trim();
const [maj, min, pat] = npmVersion.split(".").map(Number);
const oidcCapable = maj > 11 || (maj === 11 && (min > 5 || (min === 5 && pat >= 1)));
log(`npm ${npmVersion}${oidcCapable ? "" : "  ← TOO OLD for OIDC (needs >= 11.5.1)"}`);
if (!oidcCapable && !DRY) die(`npm ${npmVersion} cannot do trusted publishing; needs >= 11.5.1`);

const live = new Map();
for (const p of chain) live.set(p.name, await publishedVersions(p.name));

const outDir = mkdtempSync(join(tmpdir(), "open-take-tarballs-"));
const published = [];

for (const pkg of chain) {
  if (live.get(pkg.name).has(pkg.version)) {
    log(`\n· ${pkg.name}@${pkg.version} already on the registry — skipped`);
    continue;
  }

  // pnpm pack: runs prepack (runtime bundles the editor here) and rewrites
  // workspace:* to the exact versions of the packages published just above.
  log(`\n▸ packing ${pkg.name}@${pkg.version}`);
  const packed = spawnSync("pnpm", ["pack", "--pack-destination", outDir, "--json"], {
    cwd: pkg.dir,
    encoding: "utf8",
  });
  if (packed.status !== 0) die(`pnpm pack failed for ${pkg.name}:\n${packed.stderr ?? ""}`);
  const jsonStart = Math.max(0, packed.stdout.lastIndexOf("\n{") + 1);
  let tarball;
  try {
    tarball = JSON.parse(packed.stdout.slice(jsonStart)).filename;
  } catch {
    die(`could not read the tarball name out of pnpm pack's output:\n${packed.stdout}`);
  }

  if (DRY) {
    log(`  would publish ${tarball}`);
    continue;
  }

  // npm publish <tarball>: OIDC auth, provenance attached automatically.
  log(`▸ publishing ${pkg.name}@${pkg.version}`);
  const res = spawnSync("npm", ["publish", tarball, "--access", "public"], {
    cwd: outDir,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  const out = `${res.stdout ?? ""}${res.stderr ?? ""}`;
  if (res.status !== 0) {
    // Everything published so far stays published; re-running resumes.
    die(
      `npm publish failed for ${pkg.name}@${pkg.version}:\n${out.trim().split("\n").slice(-20).join("\n")}\n\n` +
        `published so far: ${published.join(", ") || "(none)"}\n` +
        `re-run this workflow to resume — published versions are skipped.`,
    );
  }
  log(`  ✓ ${pkg.name}@${pkg.version}`);
  published.push(`${pkg.name}@${pkg.version}`);
}

if (DRY) {
  log(`\ndry run complete — ${chain.length} package(s) packed, nothing uploaded`);
  process.exit(0);
}

// Verify against the registry rather than trusting exit codes: a scoped package
// can 404 on a missing org while an unscoped one publishes fine.
log(`\n▸ verifying the registry serves every package`);
const missing = [];
for (const pkg of chain) {
  const ok = await waitForVersion(pkg.name, pkg.version);
  log(`  ${ok ? "✓" : "✗"} ${pkg.name}@${pkg.version}`);
  if (!ok) missing.push(pkg.name);
}
if (missing.length) die(`not on the registry: ${missing.join(", ")} — re-run to resume`);

log(`\nreleased ${chain.length} package(s)`);
log(`smoke-test:  npm i -D open-take && npx open-take --version`);
void REPO_ROOT;
