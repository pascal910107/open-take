import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  detectPackageManager,
  initCommand,
  initializeOpenTake,
  installCommand,
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
