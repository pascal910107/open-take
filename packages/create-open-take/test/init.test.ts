import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  detectPackageManager,
  findPnpmWorkspaceRoot,
  initCommand,
  initializeOpenTake,
  installCommand,
  isPnpmWorkspaceRoot,
  requestedPackageManager,
  type Runner,
} from "../src/index";

test("package-manager selection accepts an explicit flag and launcher fallback", () => {
  assert.equal(requestedPackageManager(["--use-pnpm"]), "pnpm");
  assert.equal(detectPackageManager("/does/not/matter", "yarn/4.9.1 npm/? node/v22"), "yarn");
  assert.throws(() => requestedPackageManager(["--use-npm", "--use-bun"]), /Choose only one/);
});

test("project package-manager metadata wins over the npm create launcher", async () => {
  const packageManagerDir = await mkdtemp(join(tmpdir(), "create-open-take-package-manager-"));
  await writeFile(
    join(packageManagerDir, "package.json"),
    JSON.stringify({ packageManager: "pnpm@10.28.2" }),
  );
  assert.equal(detectPackageManager(packageManagerDir, "npm/11.4.2 node/v22"), "pnpm");

  const lockfileDir = await mkdtemp(join(tmpdir(), "create-open-take-lockfile-"));
  await writeFile(join(lockfileDir, "package.json"), "{}");
  await writeFile(join(lockfileDir, "yarn.lock"), "");
  assert.equal(detectPackageManager(lockfileDir, "npm/11.4.2 node/v22"), "yarn");

  const workspaceRoot = await mkdtemp(join(tmpdir(), "create-open-take-workspace-"));
  const workspaceChild = join(workspaceRoot, "packages", "app");
  await mkdir(workspaceChild, { recursive: true });
  await writeFile(join(workspaceRoot, "pnpm-workspace.yaml"), "packages:\n  - packages/*\n");
  await writeFile(join(workspaceChild, "package.json"), "{}");
  assert.equal(findPnpmWorkspaceRoot(workspaceChild), workspaceRoot);
  assert.equal(detectPackageManager(workspaceChild, "npm/11.4.2 node/v22"), "pnpm");
  assert.equal(isPnpmWorkspaceRoot(workspaceChild), false);
});

test("commands install the dev dependency and run the local init", () => {
  assert.deepEqual(installCommand("npm"), {
    command: "npm",
    args: ["install", "--save-dev", "open-take@latest"],
  });
  assert.deepEqual(initCommand("pnpm"), {
    command: "pnpm",
    args: ["exec", "open-take", "init"],
  });
  assert.deepEqual(installCommand("pnpm"), {
    command: "pnpm",
    args: ["add", "--save-dev", "open-take@latest"],
  });
  assert.deepEqual(installCommand("pnpm", "open-take@latest", { workspaceRoot: true }), {
    command: "pnpm",
    args: ["add", "--workspace-root", "--save-dev", "open-take@latest"],
  });
});

test("initializer explicitly installs into a pnpm workspace root", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "create-open-take-pnpm-root-"));
  await writeFile(join(cwd, "package.json"), "{}");
  await writeFile(join(cwd, "pnpm-workspace.yaml"), "packages: []\n");
  const calls: Array<{ command: string; args: string[] }> = [];
  const runner: Runner = async (command, args) => {
    calls.push({ command, args });
  };

  assert.equal(isPnpmWorkspaceRoot(cwd), true);
  await initializeOpenTake({
    cwd,
    packageManager: "pnpm",
    packageSpec: "open-take@0.1.3",
    runner,
    write: () => {},
  });

  assert.deepEqual(calls[0], {
    command: "pnpm",
    args: ["add", "--workspace-root", "--save-dev", "open-take@0.1.3"],
  });
  assert.deepEqual(calls[1], {
    command: "pnpm",
    args: ["exec", "open-take", "init"],
  });
});

test("initializer installs the package and runs its local init", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "create-open-take-"));
  await writeFile(join(cwd, "package.json"), "{}");
  const calls: Array<{ command: string; args: string[]; env: NodeJS.ProcessEnv }> = [];
  const runner: Runner = async (command, args, options) => {
    calls.push({
      command,
      args,
      env: options.env,
    });
  };

  await initializeOpenTake({
    cwd,
    packageManager: "npm",
    packageSpec: "open-take@0.1.3",
    runner,
    write: () => {},
  });

  assert.deepEqual(
    calls.map(({ command, args }) => ({ command, args })),
    [
      {
        command: "npm",
        args: ["install", "--save-dev", "open-take@0.1.3"],
      },
      {
        command: "npm",
        args: ["exec", "--", "open-take", "init"],
      },
    ],
  );
  assert.equal(
    calls.every(({ env }) => env === process.env),
    true,
  );
});
