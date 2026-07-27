import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, relative, resolve } from "node:path";

export type PackageManager = "npm" | "pnpm" | "yarn" | "bun";

type RunOptions = {
  cwd: string;
  env: NodeJS.ProcessEnv;
};

export type Runner = (command: string, args: string[], options: RunOptions) => Promise<void>;

const FLAGS: Record<string, PackageManager> = {
  "--use-npm": "npm",
  "--use-pnpm": "pnpm",
  "--use-yarn": "yarn",
  "--use-bun": "bun",
};

const OTHER_FLAGS = new Set(["--yes", "-y", "--help", "-h"]);

export const DEFAULT_DIRECTORY = "open-take-demo";

/** Asks for one line of input; the default applies when the answer is empty. */
export type Ask = (question: string, defaultValue: string) => Promise<string>;

export type ParsedArgs = {
  help: boolean;
  yes: boolean;
  directory?: string;
  packageManager?: PackageManager;
};

export function requestedPackageManager(args: string[]): PackageManager | undefined {
  const requested = args.filter((arg) => arg in FLAGS);
  if (requested.length > 1) {
    throw new Error("Choose only one of --use-npm, --use-pnpm, --use-yarn, or --use-bun.");
  }
  return requested[0] ? FLAGS[requested[0]] : undefined;
}

export function parseArgs(args: string[]): ParsedArgs {
  const unknown = args.find(
    (arg) => arg.startsWith("-") && !(arg in FLAGS) && !OTHER_FLAGS.has(arg),
  );
  if (unknown) throw new Error(`Unknown option ${unknown}. Run with --help to see the usage.`);

  const positional = args.filter((arg) => !arg.startsWith("-"));
  if (positional.length > 1) {
    throw new Error(`Pass at most one directory (got ${positional.join(", ")}).`);
  }

  return {
    help: args.includes("--help") || args.includes("-h"),
    yes: args.includes("--yes") || args.includes("-y"),
    directory: positional[0],
    packageManager: requestedPackageManager(args),
  };
}

export function findPnpmWorkspaceRoot(cwd: string): string | undefined {
  let current = resolve(cwd);
  for (;;) {
    if (
      existsSync(resolve(current, "pnpm-workspace.yaml")) ||
      existsSync(resolve(current, "pnpm-workspace.yml"))
    ) {
      return current;
    }
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

export function detectPackageManager(
  cwd: string,
  userAgent = process.env.npm_config_user_agent,
): PackageManager {
  const packageJsonPath = resolve(cwd, "package.json");
  if (existsSync(packageJsonPath)) {
    try {
      const pkg = JSON.parse(readFileSync(packageJsonPath, "utf8")) as {
        packageManager?: unknown;
      };
      if (typeof pkg.packageManager === "string") {
        const fromPackageJson = pkg.packageManager.split("@", 1)[0];
        if (
          fromPackageJson === "pnpm" ||
          fromPackageJson === "yarn" ||
          fromPackageJson === "bun" ||
          fromPackageJson === "npm"
        ) {
          return fromPackageJson;
        }
      }
    } catch {
      // A malformed package.json is reported by the selected package manager.
    }
  }

  if (findPnpmWorkspaceRoot(cwd)) return "pnpm";

  const locks: Array<[string, PackageManager]> = [
    ["pnpm-lock.yaml", "pnpm"],
    ["yarn.lock", "yarn"],
    ["bun.lock", "bun"],
    ["bun.lockb", "bun"],
    ["package-lock.json", "npm"],
  ];
  const fromLockfile = locks.find(([file]) => existsSync(resolve(cwd, file)))?.[1];
  if (fromLockfile) return fromLockfile;

  const fromAgent = userAgent?.split("/", 1)[0];
  if (fromAgent === "pnpm" || fromAgent === "yarn" || fromAgent === "bun" || fromAgent === "npm") {
    return fromAgent;
  }
  return "npm";
}

export function installCommand(
  packageManager: PackageManager,
  packageSpec = "open-take@latest",
  options: { workspaceRoot?: boolean } = {},
): { command: string; args: string[] } {
  switch (packageManager) {
    case "pnpm":
      return {
        command: "pnpm",
        args: [
          "add",
          ...(options.workspaceRoot ? ["--workspace-root"] : []),
          "--save-dev",
          packageSpec,
        ],
      };
    case "yarn":
      return { command: "yarn", args: ["add", "--dev", packageSpec] };
    case "bun":
      return { command: "bun", args: ["add", "--dev", packageSpec] };
    default:
      return { command: "npm", args: ["install", "--save-dev", packageSpec] };
  }
}

export function isPnpmWorkspaceRoot(cwd: string): boolean {
  return findPnpmWorkspaceRoot(cwd) === resolve(cwd);
}

export function initCommand(packageManager: PackageManager): {
  command: string;
  args: string[];
} {
  switch (packageManager) {
    case "pnpm":
      return { command: "pnpm", args: ["exec", "open-take", "init"] };
    case "yarn":
      return { command: "yarn", args: ["exec", "open-take", "init"] };
    case "bun":
      return { command: "bun", args: ["x", "open-take", "init"] };
    default:
      return { command: "npm", args: ["exec", "--", "open-take", "init"] };
  }
}

export const spawnRunner: Runner = (command, args, options) =>
  new Promise<void>((resolvePromise, reject) => {
    const child = spawn(command, args, {
      ...options,
      stdio: "inherit",
      shell: process.platform === "win32",
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolvePromise();
      else reject(new Error(`${command} exited with code ${code}`));
    });
  });

export function packageNameFromDirectory(dir: string): string {
  const name = basename(resolve(dir))
    .toLowerCase()
    .replace(/[^a-z0-9\-._~]+/g, "-")
    .replace(/^[-._]+/, "")
    .replace(/[-._]+$/, "")
    .slice(0, 214);
  return name || "open-take-app";
}

export const NO_DIRECTORY_MESSAGE =
  "There is no package.json here, so there is no app to add Open Take to.\n" +
  `Name a directory to create instead:  npm create open-take@latest <directory>\n` +
  `(or --yes to accept the default "${DEFAULT_DIRECTORY}", or run it from your app's root)`;

/**
 * Where the install goes. Writing into whatever directory the user happens to
 * be standing in is not an option — an initializer that scatters package.json,
 * node_modules and skill folders across someone's home directory is a mess they
 * have to clean up. So: an explicit directory wins, an existing package.json
 * means "add to this app", and otherwise we ask before creating anything.
 */
export async function resolveTargetDirectory(options: {
  cwd: string;
  directory?: string;
  yes?: boolean;
  ask?: Ask;
}): Promise<{ target: string; chosenByUser: boolean }> {
  if (options.directory) {
    return { target: resolve(options.cwd, options.directory), chosenByUser: true };
  }
  if (existsSync(resolve(options.cwd, "package.json"))) {
    return { target: options.cwd, chosenByUser: true };
  }
  if (options.yes || !options.ask) {
    if (!options.yes) throw new Error(NO_DIRECTORY_MESSAGE);
    return { target: resolve(options.cwd, DEFAULT_DIRECTORY), chosenByUser: false };
  }
  const answer = (await options.ask("Project directory", DEFAULT_DIRECTORY)).trim();
  return { target: resolve(options.cwd, answer || DEFAULT_DIRECTORY), chosenByUser: false };
}

/** `.git` and `.DS_Store` do not make a directory "occupied". */
function isEmptyDirectory(dir: string): boolean {
  return readdirSync(dir).every((entry) => entry === ".git" || entry === ".DS_Store");
}

export function prepareDirectory(
  target: string,
  options: { chosenByUser?: boolean } = {},
): { createdDirectory: boolean; createdPackageJson: boolean } {
  let createdDirectory = false;
  if (!existsSync(target)) {
    mkdirSync(target, { recursive: true });
    createdDirectory = true;
  } else if (!statSync(target).isDirectory()) {
    throw new Error(`${target} is not a directory.`);
  }

  const packageJsonPath = resolve(target, "package.json");
  const hasPackageJson = existsSync(packageJsonPath);
  if (!hasPackageJson && !createdDirectory && !options.chosenByUser && !isEmptyDirectory(target)) {
    throw new Error(`${basename(target)} already exists and is not empty — pick another name.`);
  }
  if (hasPackageJson) return { createdDirectory, createdPackageJson: false };

  writeFileSync(
    packageJsonPath,
    `${JSON.stringify({ name: packageNameFromDirectory(target), version: "0.0.0", private: true }, null, 2)}\n`,
  );
  return { createdDirectory, createdPackageJson: true };
}

const displayPath = (from: string, to: string) => (from === to ? to : `${relative(from, to)}/`);

/** Entry names as a reader would delete them: directories keep their slash. */
function describeEntries(dir: string, entries: string[]): string {
  return entries
    .map((entry) => {
      const isDir = statSync(resolve(dir, entry), { throwIfNoEntry: false })?.isDirectory();
      return isDir ? `${entry}/` : entry;
    })
    .join(", ");
}

export async function initializeOpenTake(
  options: {
    cwd?: string;
    directory?: string;
    yes?: boolean;
    ask?: Ask;
    packageManager?: PackageManager;
    packageSpec?: string;
    runner?: Runner;
    write?: (message: string) => void;
  } = {},
): Promise<void> {
  const cwd = resolve(options.cwd ?? process.cwd());
  const runner = options.runner ?? spawnRunner;
  const write = options.write ?? ((message) => process.stdout.write(message));

  const { target, chosenByUser } = await resolveTargetDirectory({
    cwd,
    directory: options.directory,
    yes: options.yes,
    ask: options.ask,
  });
  const where = displayPath(cwd, target);
  // Snapshot first: everything that appears after this line was put there by
  // this command, and the closing summary names it — nobody should have to
  // guess what to delete.
  const before = new Set(existsSync(target) ? readdirSync(target) : []);
  const { createdDirectory } = prepareDirectory(target, { chosenByUser });
  write(
    createdDirectory ? `\nCreating a project in ${where}\n` : `\nAdding Open Take to ${where}\n`,
  );

  const packageManager = options.packageManager ?? detectPackageManager(target);
  write(`Installing open-take with ${packageManager}…\n`);
  const install = installCommand(
    packageManager,
    options.packageSpec ?? process.env.OPEN_TAKE_PACKAGE ?? "open-take@latest",
    {
      workspaceRoot: packageManager === "pnpm" && isPnpmWorkspaceRoot(target),
    },
  );
  await runner(install.command, install.args, { cwd: target, env: process.env });

  const init = initCommand(packageManager);
  await runner(init.command, init.args, { cwd: target, env: process.env });

  const added = readdirSync(target)
    .filter((entry) => !before.has(entry))
    .sort();
  if (added.length) {
    write(`\nWrote into ${where}: ${describeEntries(target, added)}\n`);
    write(
      createdDirectory
        ? `Delete ${where} to undo this.\n`
        : `Nothing outside those paths was touched.\n`,
    );
  }
  if (target !== cwd) write(`\n  cd ${relative(cwd, target)}\n`);
  write('\nReady. Ask your agent: "Make a demo of localhost:3000 for Twitter."\n');
}

export const HELP = `create-open-take — start an Open Take project, or add it to your app

Run from an app root (a directory with package.json) and it installs there.
Anywhere else it asks for a directory to create, and never writes into the
directory you are standing in without being told to.

Usage:
  npm create open-take@latest              asks which directory to create
  npm create open-take@latest my-demo      creates ./my-demo, no questions
  npm create open-take@latest .            uses the current directory
  npm create open-take@latest my-demo -- --use-pnpm

It writes: package.json (only if the directory has none), node_modules/ and a
lockfile, plus .agents/skills/open-take/ and .claude/skills/open-take/ from
"open-take init". The closing summary lists exactly what landed.

Options:
  -y, --yes   skip the question and use ./${DEFAULT_DIRECTORY}
  --use-npm | --use-pnpm | --use-yarn | --use-bun
  -h, --help
`;
