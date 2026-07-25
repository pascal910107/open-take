// The local half of a release: `pnpm release [patch|minor|major|<x.y.z>]`.
//
// It bumps the ship chain, runs the gates, commits, tags and pushes — and then
// stops. The actual upload happens in .github/workflows/release.yml, which the
// tag triggers, authenticating to npm over OIDC (trusted publishing). Nothing
// here touches the registry, so there is no token on this machine, no 2FA code
// to type, and no way for a laptop to publish something CI never saw.
//
// By default it then waits for the registry to actually serve the new version,
// because "the workflow went green" and "the packages are installable" are not
// the same claim — a scoped package can 404 on a missing org while the unscoped
// CLI publishes fine, which is how you get a live CLI whose dependency does not
// exist. --no-wait skips it.
//
// Flags: --dry-run (gates + plan, no commit/tag/push), --yes, --no-wait,
// --force-gates, --with-create (also bump create-open-take, which is otherwise
// versioned independently — it installs open-take@latest).

import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import {
  INDEPENDENT,
  REPO_ROOT,
  publishOrder,
  publishedVersions,
  readPackages,
} from "./lib/workspace.mjs";

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const DRY = has("--dry-run");
const YES = has("--yes") || has("-y");
const WITH_CREATE = has("--with-create");
const WAIT = !has("--no-wait");
const positional = argv.filter((a) => !a.startsWith("-"));

const log = (msg) => process.stdout.write(`${msg}\n`);

// Version bumps are written to disk before the gates run (the gates must test
// what would ship). Anything that aborts before the release commit has to put
// the manifests back, or a failed run leaves a dirty tree that the next run's
// preflight refuses to start from.
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

// --- git ----------------------------------------------------------------
const git = (...args) => execFileSync("git", args, { cwd: REPO_ROOT, encoding: "utf8" }).trim();

function preflightGit() {
  const branch = git("rev-parse", "--abbrev-ref", "HEAD");
  if (branch !== "main") die(`releases go out from main, not ${branch}`);
  const dirty = git("status", "--porcelain");
  if (dirty) die(`working tree is dirty — commit or stash first:\n${dirty}`);
  git("fetch", "origin", "main", "--tags");
  const behind = git("rev-list", "--count", "HEAD..origin/main");
  if (behind !== "0") die(`main is ${behind} commit(s) behind origin — pull first`);
  const ahead = git("rev-list", "--count", "origin/main..HEAD");
  if (ahead !== "0") log(`  note: ${ahead} unpushed commit(s); they go out with the release push`);
}

const remoteUrl = () => git("config", "--get", "remote.origin.url");
const actionsUrl = () => {
  const m = /github\.com[:/](.+?)(?:\.git)?$/.exec(remoteUrl());
  return m ? `https://github.com/${m[1]}/actions/workflows/release.yml` : "(the Actions tab)";
};

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
function run(cmd, args) {
  const res = spawnSync(cmd, args, { cwd: REPO_ROOT, encoding: "utf8", stdio: "inherit" });
  if (res.error) die(`${cmd} could not be started: ${res.error.message}`);
  return res;
}

function gate(label, cmd, args) {
  log(`\n▸ ${label}`);
  if (run(cmd, args).status !== 0) die(`${label} failed — nothing was tagged or pushed`);
}

async function ask(question) {
  if (!process.stdin.isTTY) die(`need input (${question}) but stdin is not a terminal`);
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question(question);
  rl.close();
  return answer.trim();
}

// --- main ---------------------------------------------------------------
const chain = publishOrder(readPackages()).filter((p) => WITH_CREATE || !INDEPENDENT.has(p.name));

log("open-take release\n");
log("ship chain (from the workspace dependency graph):");
for (const [i, p] of chain.entries()) log(`  ${i + 1}. ${p.name}  ${p.version}`);
log("");

preflightGit();

// An unfinished release — committed and maybe tagged, but the workflow never got
// everything onto the registry. The signal is the release commit itself: this
// script only writes one AFTER the gates pass. Resume at that version rather
// than bumping past a half-published release.
const liveVersions = new Map();
for (const p of chain) liveVersions.set(p.name, await publishedVersions(p.name));
const unpublished = chain.filter((p) => !liveVersions.get(p.name).has(p.version));
const explicitStep = positional[0];

// Not necessarily HEAD — fixing whatever broke the release legitimately lands
// commits on top of it.
function findReleaseCommit() {
  for (const line of git("log", "-30", "--pretty=%H %s").split("\n")) {
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

// The gates can only be skipped if nothing that ends up IN a tarball changed
// since they ran. Tooling and notes leave the artifacts identical; anything
// under packages/ or test/ does not.
function shippedFilesChangedSince(sha) {
  return git("diff", "--name-only", `${sha}..HEAD`)
    .split("\n")
    .filter((f) => f.startsWith("packages/") || f.startsWith("test/"));
}

let version;
if (resuming) {
  version = priorRelease.version;
  log(`\nresuming the unfinished release ${version} (committed ${priorRelease.sha.slice(0, 8)})`);
  for (const p of chain) log(`  ${unpublished.includes(p) ? "·" : "✓"} ${p.name}@${p.version}`);
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

const tag = `v${version}`;
const tagExists = git("tag", "-l", tag) === tag;
const tagOnRemote = git("ls-remote", "--tags", "origin", tag) !== "";

if (DRY) log("\n-- dry run: no commit, tag or push --");

if (!YES && !DRY) {
  const answer = await ask(`\nrelease ${version}? [y/N] `);
  if (!/^y(es)?$/i.test(answer)) die("aborted");
}

if (!resuming) for (const p of chain) writeVersion(p, version);

const dirtySinceRelease = resuming ? shippedFilesChangedSince(priorRelease.sha) : [];
if (resuming && !has("--force-gates") && dirtySinceRelease.length === 0) {
  log(`\n▸ gates skipped — they passed on ${priorRelease.sha.slice(0, 8)}, and nothing`);
  log(`  that ships has changed since (--force-gates to run them anyway)`);
} else {
  if (dirtySinceRelease.length)
    log(
      `\n▸ running the gates: ${dirtySinceRelease.length} packaged file(s) changed since ` +
        `the release commit — ${dirtySinceRelease.slice(0, 3).join(", ")}`,
    );
  // The same set CI runs, in the same order — a release must not be able to ship
  // something the pipeline would reject.
  gate("build", "pnpm", ["build"]);
  gate("typecheck", "pnpm", ["typecheck"]);
  gate("lint", "pnpm", ["lint"]);
  gate("test", "pnpm", ["-r", "--if-present", "test"]);
  gate("package artifacts", "pnpm", ["test:package"]);
}

if (DRY) {
  const reverted = restoreManifests();
  log(`\ndry run complete — would tag ${tag} and let CI publish ${chain.length} package(s)`);
  if (reverted) log(`(reverted ${reverted} version bump(s); the tree is untouched)`);
  process.exit(0);
}

if (!resuming && git("status", "--porcelain")) {
  run("git", ["add", "-A"]);
  run("git", ["commit", "-q", "-m", `release: ${version}`]);
  snapshots.clear(); // committed — a later failure must not revert it
  log(`\n▸ committed release: ${version}`);
}

// Push the commit first: the tag triggers the publish, and a workflow that
// checks out a commit main does not have yet is a confusing way to fail.
run("git", ["push", "origin", "main"]);
if (!tagExists) run("git", ["tag", "-a", tag, "-m", `open-take ${version}`]);

if (tagOnRemote) {
  // Re-pushing an existing tag is a no-op, so it cannot re-trigger the workflow.
  log(`\n▸ ${tag} is already on origin — pushing it again would NOT re-trigger anything.`);
  log(`  Re-run the Release workflow instead: ${actionsUrl()}`);
} else {
  run("git", ["push", "origin", tag]);
  log(`\n▸ pushed ${tag} — the Release workflow publishes over OIDC`);
  log(`  ${actionsUrl()}`);
}

if (!WAIT) {
  log(`\nnot waiting (--no-wait). Verify with:  npm view open-take@${version} version`);
  process.exit(0);
}

// Poll the registry, not the workflow: green CI and installable packages are
// different claims.
log(`\n▸ waiting for the registry to serve ${version} (Ctrl-C is safe — CI keeps going)`);
const deadline = Date.now() + 15 * 60_000;
const pending = new Set(chain.map((p) => p.name));
while (pending.size && Date.now() < deadline) {
  for (const name of [...pending]) {
    if ((await publishedVersions(name)).has(version)) {
      pending.delete(name);
      log(`  ✓ ${name}@${version}`);
    }
  }
  if (pending.size) await new Promise((r) => setTimeout(r, 10_000));
}

if (pending.size)
  die(
    `still missing after 15min: ${[...pending].join(", ")}\n` +
      `  check ${actionsUrl()} — re-running the workflow resumes (published versions are skipped)`,
  );

log(`\nreleased ${version} · ${chain.length} packages · tagged ${tag}`);
log(`smoke-test it:  cd $(mktemp -d) && npm i -D open-take && npx open-take --version`);
