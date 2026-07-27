import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  DEFAULT_DIRECTORY,
  type Runner,
  detectPackageManager,
  findPnpmWorkspaceRoot,
  initCommand,
  initializeOpenTake,
  installCommand,
  isPnpmWorkspaceRoot,
  packageNameFromDirectory,
  parseArgs,
  requestedPackageManager,
} from "../src/index";

// Records what the initializer would have shelled out to, and where.
function recorder() {
  const calls: Array<{ command: string; args: string[]; cwd: string }> = [];
  const runner: Runner = async (command, args, options) => {
    calls.push({ command, args, cwd: options.cwd });
  };
  return { calls, runner };
}

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

test("argument parsing takes one directory and rejects the rest", () => {
  assert.deepEqual(parseArgs(["my-demo", "--use-pnpm"]), {
    help: false,
    yes: false,
    directory: "my-demo",
    packageManager: "pnpm",
  });
  assert.deepEqual(parseArgs(["-y"]).yes, true);
  assert.throws(() => parseArgs(["--force"]), /Unknown option --force/);
  assert.throws(() => parseArgs(["a", "b"]), /at most one directory/);
});

test("a directory argument creates that subdirectory, never the cwd", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "create-open-take-arg-"));
  const { calls, runner } = recorder();
  const messages: string[] = [];

  await initializeOpenTake({
    cwd,
    directory: "My Demo!",
    packageManager: "npm",
    packageSpec: "open-take@0.1.3",
    runner,
    write: (message) => messages.push(message),
  });

  const target = join(cwd, "My Demo!");
  assert.deepEqual(await readdir(cwd), ["My Demo!"]); // the cwd itself stays clean
  assert.deepEqual(JSON.parse(await readFile(join(target, "package.json"), "utf8")), {
    name: "my-demo",
    version: "0.0.0",
    private: true,
  });
  assert.deepEqual(
    calls.map(({ cwd: at }) => at),
    [target, target],
  );
  assert.match(messages.join(""), /Creating a project in My Demo!\//);
  assert.match(messages.join(""), /cd My Demo!/);
  assert.equal(packageNameFromDirectory("/tmp/_Weird.Name_"), "weird.name");
});

test("with no directory and no package.json the initializer asks first", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "create-open-take-ask-"));
  const { calls, runner } = recorder();
  const asked: string[] = [];

  await initializeOpenTake({
    cwd,
    packageManager: "npm",
    runner,
    write: () => {},
    ask: async (question, defaultValue) => {
      asked.push(`${question} (${defaultValue})`);
      return "  chosen-name  ";
    },
  });

  assert.deepEqual(asked, [`Project directory (${DEFAULT_DIRECTORY})`]);
  assert.deepEqual(await readdir(cwd), ["chosen-name"]);
  assert.equal(calls[0].cwd, join(cwd, "chosen-name"));
});

test("an empty answer takes the default, and --yes skips the question", async () => {
  const emptyAnswer = await mkdtemp(join(tmpdir(), "create-open-take-default-"));
  await initializeOpenTake({
    cwd: emptyAnswer,
    packageManager: "npm",
    runner: recorder().runner,
    write: () => {},
    ask: async () => "",
  });
  assert.deepEqual(await readdir(emptyAnswer), [DEFAULT_DIRECTORY]);

  const yesFlag = await mkdtemp(join(tmpdir(), "create-open-take-yes-"));
  let askedAnyway = false;
  await initializeOpenTake({
    cwd: yesFlag,
    yes: true,
    packageManager: "npm",
    runner: recorder().runner,
    write: () => {},
    ask: async () => {
      askedAnyway = true;
      return "";
    },
  });
  assert.equal(askedAnyway, false);
  assert.deepEqual(await readdir(yesFlag), [DEFAULT_DIRECTORY]);
});

test("without a way to ask, it names the argument instead of writing anything", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "create-open-take-noninteractive-"));
  await assert.rejects(
    initializeOpenTake({ cwd, packageManager: "npm", runner: recorder().runner, write: () => {} }),
    /npm create open-take@latest <directory>/,
  );
  assert.deepEqual(await readdir(cwd), []);
});

test("a chosen name that is already taken is refused, not merged into", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "create-open-take-occupied-"));
  await mkdir(join(cwd, "taken"));
  await writeFile(join(cwd, "taken", "notes.txt"), "mine");

  await assert.rejects(
    initializeOpenTake({
      cwd,
      packageManager: "npm",
      runner: recorder().runner,
      write: () => {},
      ask: async () => "taken",
    }),
    /already exists and is not empty/,
  );
  assert.deepEqual(await readdir(join(cwd, "taken")), ["notes.txt"]);
});

test("an app root is used as-is: no question, no new package.json", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "create-open-take-existing-"));
  await writeFile(join(cwd, "package.json"), '{ "name": "my-app" }');
  const { calls, runner } = recorder();
  const messages: string[] = [];

  await initializeOpenTake({
    cwd,
    packageManager: "npm",
    packageSpec: "open-take@0.1.3",
    runner,
    write: (message) => messages.push(message),
    ask: async () => assert.fail("must not ask inside an app root"),
  });

  assert.equal(await readFile(join(cwd, "package.json"), "utf8"), '{ "name": "my-app" }');
  assert.equal(calls[0].cwd, cwd);
  assert.match(messages.join(""), /Adding Open Take to/);
  assert.doesNotMatch(messages.join(""), /cd /);
});

test("the summary names what landed, so it can be deleted", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "create-open-take-summary-"));
  await writeFile(join(cwd, "package.json"), "{}");
  const messages: string[] = [];

  // Stand in for what npm and `open-take init` leave behind.
  const runner: Runner = async (_command, args, options) => {
    if (args.includes("install")) {
      await mkdir(join(options.cwd, "node_modules"));
      await writeFile(join(options.cwd, "package-lock.json"), "{}");
    } else {
      await mkdir(join(options.cwd, ".agents", "skills", "open-take"), { recursive: true });
      await mkdir(join(options.cwd, ".claude", "skills", "open-take"), { recursive: true });
    }
  };

  await initializeOpenTake({
    cwd,
    packageManager: "npm",
    runner,
    write: (message) => messages.push(message),
  });

  assert.match(
    messages.join(""),
    /Wrote into .*: \.agents\/, \.claude\/, node_modules\/, package-lock\.json/,
  );
  assert.match(messages.join(""), /Nothing outside those paths was touched/);
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
