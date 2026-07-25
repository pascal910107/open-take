// One-command release: `pnpm release [patch|minor|major|<x.y.z>]`
//
// Replaces the hand-typed sequence (bump 4 package.jsons, build, typecheck,
// test, `pnpm --filter … publish` four times in the right order, then curl the
// registry to check they all actually landed). Everything here was already
// written down in .notes/NPM-PUBLISH.md as steps a human had to not get wrong.
//
// The three things that make this more than a shell alias:
//
//  1. PUBLISH ORDER IS DERIVED, NOT HARDCODED. The ship chain is
//     revideo-renderer → compositor → runtime → cli, and it is easy to forget
//     that compositor depends on revideo-renderer at all. pnpm rewrites
//     `workspace:*` to an exact version in the tarball, so publishing a package
//     before its workspace dependency uploads a manifest pointing at a version
//     that does not exist yet. We topologically sort the real graph instead.
//
//  2. IT RESUMES. The npm account has 2FA and an OTP expires in ~30s, so a
//     four-package run can (and did) die halfway, leaving a live package whose
//     dependency was never published — the exact failure the ledger warns
//     about. Every publish is preceded by a registry probe, so re-running skips
//     what already landed. A run interrupted at package 3 is finished by
//     running the same command again.
//
//  3. IT VERIFIES WHAT IT SHIPPED, not what it meant to ship. `npm view`
//     caches; a direct registry fetch does not. Scoped packages 404 on publish
//     when the npm org is missing while the unscoped CLI succeeds, which is how
//     you end up with a half-published release that looks fine.
//
// Flags: --dry-run (do everything except publish/commit/tag/push), --yes (skip
// the confirmation), --otp <code>, --with-create (also bump create-open-take,
// which is otherwise versioned independently — it installs open-take@latest,
// so it does not need a coordinated bump).

import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const PKG_DIR = join(REPO_ROOT, "packages");

// create-open-take is a standalone project initializer: it installs
// open-take@latest rather than depending on the workspace, so it is not part of
// the version-locked ship chain (see --with-create).
const INDEPENDENT = new Set(["create-open-take"]);

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const flagValue = (f) => {
  const i = argv.indexOf(f);
  return i === -1 ? undefined : argv[i + 1];
};
const DRY = has("--dry-run");
const YES = has("--yes") || has("-y");
const WITH_CREATE = has("--with-create");
// scan rather than filter: `--otp 123456` must not leave 123456 looking like a
// requested version
const positional = [];
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === "--otp") i++; // skip its value
  else if (!argv[i].startsWith("-")) positional.push(argv[i]);
}

const log = (msg) => process.stdout.write(`${msg}\n`);

// Version bumps are written to disk before the gates run (the gates must test
// what would ship). Anything that aborts before the release commit therefore
// has to put the manifests back, or a failed run leaves a dirty tree that the
// next run's preflight refuses to start from.
const snapshots = new Map();
function restoreManifests() {
  for (const [path, contents] of snapshots) {
    try {
      writeFileSync(path, contents);
    } catch {
      /* best effort — never mask the original failure */
    }
  }
  const n = snapshots.size;
  snapshots.clear();
  return n;
}

const die = (msg) => {
  const restored = restoreManifests();
  process.stderr.write(`\nrelease: ${msg}\n`);
  if (restored) process.stderr.write(`release: reverted ${restored} version bump(s)\n`);
  process.exit(1);
};

// --- workspace graph ----------------------------------------------------
function readPackages() {
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
    pkgs.push({ name: manifest.name, version: manifest.version, dir: entry, manifestPath });
  }
  return pkgs;
}

// Topological order over workspace-internal deps: a package is published only
// after everything it depends on, so no tarball ever references a version that
// is not on the registry yet.
function publishOrder(pkgs) {
  const byName = new Map(pkgs.map((p) => [p.name, p]));
  const depsOf = (p) => {
    const m = JSON.parse(readFileSync(p.manifestPath, "utf8"));
    return Object.keys({ ...m.dependencies, ...m.peerDependencies }).filter((d) => byName.has(d));
  };
  const ordered = [];
  const state = new Map(); // name -> "visiting" | "done"
  const visit = (p) => {
    const seen = state.get(p.name);
    if (seen === "done") return;
    if (seen === "visiting") die(`dependency cycle in the workspace graph at ${p.name}`);
    state.set(p.name, "visiting");
    for (const d of depsOf(p)) visit(byName.get(d));
    state.set(p.name, "done");
    ordered.push(p);
  };
  for (const p of pkgs) visit(p);
  return ordered;
}

// --- registry -----------------------------------------------------------
// Direct registry read: `npm view` serves a cache, which is exactly how a
// missing publish gets mistaken for a successful one.
async function publishedVersions(name) {
  const res = await fetch(`https://registry.npmjs.org/${encodeURIComponent(name)}`, {
    headers: { accept: "application/json" },
  });
  if (res.status === 404) return new Set();
  if (!res.ok) die(`registry probe for ${name} failed with HTTP ${res.status}`);
  const body = await res.json();
  return new Set(Object.keys(body.versions ?? {}));
}

// --- git ----------------------------------------------------------------
const git = (...args) => execFileSync("git", args, { cwd: REPO_ROOT, encoding: "utf8" }).trim();

function preflightGit() {
  const branch = git("rev-parse", "--abbrev-ref", "HEAD");
  if (branch !== "main") die(`releases go out from main, not ${branch}`);
  const dirty = git("status", "--porcelain");
  if (dirty) die(`working tree is dirty — commit or stash first:\n${dirty}`);
  git("fetch", "origin", "main");
  const [local, remote] = [git("rev-parse", "HEAD"), git("rev-parse", "origin/main")];
  if (local !== remote) {
    const ahead = git("rev-list", "--count", "origin/main..HEAD");
    const behind = git("rev-list", "--count", "HEAD..origin/main");
    if (behind !== "0") die(`main is ${behind} commit(s) behind origin — pull first`);
    log(`  note: ${ahead} unpushed commit(s); they go out with the release push`);
  }
}

// Fail on a stale npm token here rather than after a two-minute build. A
// granular automation token in ~/.npmrc also removes the OTP prompt entirely,
// which is what makes `pnpm release --yes` runnable unattended (or by an agent,
// which has no terminal to type a code into).
function preflightNpm() {
  const res = run("npm", ["whoami"], { capture: true });
  if (res.status === 0) {
    log(`  npm: authenticated as ${res.stdout.trim()}`);
    return;
  }
  die(
    "npm is not authenticated (`npm whoami` failed).\n" +
      "  Fix with `npm login`, or — better for repeat releases — create a granular\n" +
      "  access token at npmjs.com/settings/~/tokens with publish rights and put it in\n" +
      "  ~/.npmrc as //registry.npmjs.org/:_authToken=<token>. An automation token\n" +
      "  skips the 2FA one-time password, so the whole release runs unattended.",
  );
}

// --- version ------------------------------------------------------------
function bumpVersion(current, how) {
  if (/^\d+\.\d+\.\d+/.test(how)) return how; // explicit version
  const [major, minor, patch] = current.split(".").map(Number);
  if (how === "major") return `${major + 1}.0.0`;
  if (how === "minor") return `${major}.${minor + 1}.0`;
  if (how === "patch") return `${major}.${minor}.${patch + 1}`;
  return die(`unknown version step ${JSON.stringify(how)} — use patch, minor, major or x.y.z`);
}

// Rewrite only the top-level "version" line. A JSON round-trip would reformat
// the whole manifest and bury the one-line diff a release commit should be.
function writeVersion(pkg, version) {
  const src = readFileSync(pkg.manifestPath, "utf8");
  if (!snapshots.has(pkg.manifestPath)) snapshots.set(pkg.manifestPath, src);
  const next = src.replace(/("version"\s*:\s*")[^"]+(")/, `$1${version}$2`);
  if (next === src && !src.includes(`"version": "${version}"`))
    die(`could not rewrite the version field in ${pkg.manifestPath}`);
  writeFileSync(pkg.manifestPath, next);
}

// --- shell --------------------------------------------------------------
function run(cmd, args, { capture = false } = {}) {
  const res = spawnSync(cmd, args, {
    cwd: REPO_ROOT,
    encoding: "utf8",
    stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
  });
  if (res.error) die(`${cmd} could not be started: ${res.error.message}`);
  return res;
}

function gate(label, cmd, args) {
  log(`\n▸ ${label}`);
  const res = run(cmd, args);
  if (res.status !== 0) die(`${label} failed — nothing was published`);
}

async function ask(question) {
  if (!process.stdin.isTTY) die(`need input (${question}) but stdin is not a terminal`);
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question(question);
  rl.close();
  return answer.trim();
}

// --- publish ------------------------------------------------------------
// Returns the OTP actually used, so one code covers the whole chain (npm
// accepts a code for its full ~30s window; re-prompting per package is what
// makes a four-package release race the clock).
async function publishOne(pkg, version, initialOtp) {
  const args = ["--filter", pkg.name, "publish", "--no-git-checks", "--access", "public"];
  let otp = initialOtp;
  for (let attempt = 0; ; attempt++) {
    const res = run("pnpm", [...args, ...(otp ? ["--otp", otp] : [])], { capture: true });
    if (res.status === 0) {
      log(`  ✓ ${pkg.name}@${version}`);
      return otp;
    }
    const output = `${res.stdout ?? ""}${res.stderr ?? ""}`;
    // Match npm's actual error, not any mention of "otp" — npm prints a 2FA
    // deprecation notice on every command, which a loose pattern reads as a
    // password prompt.
    const needsOtp = /\bEOTP\b|one-time password/i.test(output);
    if (needsOtp && attempt < 3) {
      otp = await ask(`  ${pkg.name}: npm one-time password: `);
      continue;
    }
    die(`publishing ${pkg.name} failed:\n${output.trim().split("\n").slice(-15).join("\n")}`);
  }
}

// --- main ---------------------------------------------------------------
const all = readPackages();
const chain = publishOrder(all).filter((p) => WITH_CREATE || !INDEPENDENT.has(p.name));

log("open-take release\n");
log(`publish order (from the workspace dependency graph):`);
for (const [i, p] of chain.entries()) log(`  ${i + 1}. ${p.name}  ${p.version}`);

log("");
preflightGit();
if (!DRY) preflightNpm();

// An unfinished release — versions bumped and committed, but the publish never
// finished (an OTP expiring is the usual cause). The signal is HEAD itself: this
// script only writes a `release: X` commit AFTER the gates pass, so a clean tree
// sitting on one, at a version that is not fully on the registry, is a run that
// died between commit and publish. Resume it rather than bump past it.
const liveVersions = new Map();
for (const p of chain) liveVersions.set(p.name, await publishedVersions(p.name));
const unpublished = chain.filter((p) => !liveVersions.get(p.name).has(p.version));
const explicitStep = positional[0];
// Find the release commit this tree is sitting on. Not necessarily HEAD —
// fixing whatever broke the publish (or writing a note) legitimately lands
// commits on top of it.
function findReleaseCommit() {
  const lines = git("log", "-30", "--pretty=%H %s").split("\n");
  for (const line of lines) {
    const m = /^(\S+) release: (\d+\.\d+\.\d+\S*)$/.exec(line);
    if (m) return { sha: m[1], version: m[2] };
  }
  return null;
}
const priorRelease = findReleaseCommit();
const resuming =
  !explicitStep &&
  unpublished.length > 0 &&
  priorRelease !== null &&
  chain.every((p) => p.version === priorRelease.version);

// The gates can only be skipped if nothing that ends up IN a tarball has
// changed since they ran. Commits that touch tooling or notes leave the
// published artifacts identical; a change under packages/ or test/ does not.
function shippedFilesChangedSince(sha) {
  const changed = git("diff", "--name-only", `${sha}..HEAD`).split("\n").filter(Boolean);
  return changed.filter((f) => f.startsWith("packages/") || f.startsWith("test/"));
}

let version;
if (resuming) {
  version = priorRelease.version;
  log(`\nresuming the unfinished release ${version} (committed ${priorRelease.sha.slice(0, 8)})`);
  for (const p of chain)
    log(`  ${unpublished.includes(p) ? "·" : "✓"} ${p.name}@${p.version}`);
} else {
  // The CLI's version is the release number; the rest of the chain moves with
  // it. Lockstep is deliberate — one number to reason about, and a dependency
  // can never lag behind the package that ships it.
  const current = chain.find((p) => p.name === "open-take")?.version ?? chain[0].version;
  version = bumpVersion(current, explicitStep ?? "patch");
  log(`\nversion ${version} (lockstep):`);
  for (const p of chain)
    log(`  ${p.name}  ${p.version} → ${version}${p.version === version ? "  (unchanged)" : ""}`);
}

if (DRY) log("\n-- dry run: no publish, no commit, no push --");

if (!YES && !DRY) {
  const answer = await ask(`\nrelease ${version}? [y/N] `);
  if (!/^y(es)?$/i.test(answer)) die("aborted");
}

// Bump + commit BEFORE publishing: a publish that dies mid-chain then leaves a
// clean tree at the released version, which is what lets a re-run resume rather
// than bump on top of a half-published release.
if (!resuming) {
  for (const p of chain) writeVersion(p, version);
  log(`\n▸ bumped ${chain.length} package.json files to ${version}`);
}

// Skipping the gates on a resume is load-bearing rather than a shortcut: they
// already passed on the release commit, and re-running them burns two minutes —
// longer than the ~30s life of the one-time password the resume exists to spend.
// Only safe while the packaged files are byte-identical to what they gated.
const dirtySinceRelease = resuming ? shippedFilesChangedSince(priorRelease.sha) : [];
if (resuming && !has("--force-gates") && dirtySinceRelease.length === 0) {
  log(`\n▸ gates skipped — they passed on ${priorRelease.sha.slice(0, 8)}, and nothing`);
  log(`  that ships has changed since (--force-gates to run them anyway)`);
} else {
  if (dirtySinceRelease.length)
    log(`\n▸ running the gates: ${dirtySinceRelease.length} packaged file(s) changed since the`);
  if (dirtySinceRelease.length) log(`  release commit — ${dirtySinceRelease.slice(0, 3).join(", ")}`);
  // Same set CI runs, in the same order — a release must not be able to ship
  // something the pipeline would reject.
  gate("build", "pnpm", ["build"]);
  gate("typecheck", "pnpm", ["typecheck"]);
  gate("lint", "pnpm", ["lint"]);
  gate("test", "pnpm", ["-r", "--if-present", "test"]);
  gate("package artifacts", "pnpm", ["test:package"]);
}

if (DRY) {
  const reverted = restoreManifests();
  log(`\ndry run complete — would publish ${chain.length} package(s) at ${version}`);
  if (reverted) log(`(reverted ${reverted} version bump(s); the tree is untouched)`);
  process.exit(0);
}

if (!resuming) {
  const dirty = git("status", "--porcelain");
  if (dirty) {
    run("git", ["add", "-A"]);
    run("git", ["commit", "-q", "-m", `release: ${version}`]);
    snapshots.clear(); // committed — a later failure must not revert it
    log(`\n▸ committed release: ${version}`);
  }
}

log(`\n▸ publishing ${chain.length} package(s) in dependency order`);
let otp = flagValue("--otp");
for (const pkg of chain) {
  if (liveVersions.get(pkg.name).has(version)) {
    log(`  · ${pkg.name}@${version} already on the registry — skipped`);
    continue;
  }
  otp = await publishOne(pkg, version, otp);
}

// Verify against the registry itself. The failure this catches is a scoped
// package 404ing (missing npm org) while the unscoped CLI publishes fine.
log(`\n▸ verifying every package is really on the registry`);
const missing = [];
for (const pkg of chain) {
  let found = false;
  // the registry needs a moment to serve a just-published version
  for (let i = 0; i < 5 && !found; i++) {
    if (i) await new Promise((r) => setTimeout(r, 2000));
    found = (await publishedVersions(pkg.name)).has(version);
  }
  log(`  ${found ? "✓" : "✗"} ${pkg.name}@${version}`);
  if (!found) missing.push(pkg.name);
}
if (missing.length) die(`not on the registry: ${missing.join(", ")} — re-run to resume`);

const tag = `v${version}`;
if (!git("tag", "-l", tag)) run("git", ["tag", "-a", tag, "-m", `open-take ${version}`]);
run("git", ["push", "origin", "main"]);
run("git", ["push", "origin", tag]);

log(`\nreleased ${version} · ${chain.length} packages · tagged ${tag} · pushed`);
log(`smoke-test it:  cd $(mktemp -d) && npm i -D open-take && npx open-take --version`);
