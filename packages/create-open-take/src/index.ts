import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

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

export function requestedPackageManager(args: string[]): PackageManager | undefined {
  const requested = args.filter((arg) => arg in FLAGS);
  if (requested.length > 1) {
    throw new Error("Choose only one of --use-npm, --use-pnpm, --use-yarn, or --use-bun.");
  }
  return requested[0] ? FLAGS[requested[0]] : undefined;
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
): { command: string; args: string[] } {
  switch (packageManager) {
    case "pnpm":
      return { command: "pnpm", args: ["add", "--save-dev", packageSpec] };
    case "yarn":
      return { command: "yarn", args: ["add", "--dev", packageSpec] };
    case "bun":
      return { command: "bun", args: ["add", "--dev", packageSpec] };
    default:
      return { command: "npm", args: ["install", "--save-dev", packageSpec] };
  }
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

export async function initializeOpenTake(
  options: {
    cwd?: string;
    packageManager?: PackageManager;
    packageSpec?: string;
    runner?: Runner;
    write?: (message: string) => void;
  } = {},
): Promise<void> {
  const cwd = resolve(options.cwd ?? process.cwd());
  if (!existsSync(resolve(cwd, "package.json"))) {
    throw new Error("Run this command from your app's root (package.json was not found).");
  }

  const packageManager = options.packageManager ?? detectPackageManager(cwd);
  const runner = options.runner ?? spawnRunner;
  const write = options.write ?? ((message) => process.stdout.write(message));

  write(`Installing open-take with ${packageManager}…\n`);
  const install = installCommand(
    packageManager,
    options.packageSpec ?? process.env.OPEN_TAKE_PACKAGE ?? "open-take@latest",
  );
  await runner(install.command, install.args, { cwd, env: process.env });

  const init = initCommand(packageManager);
  await runner(init.command, init.args, { cwd, env: process.env });
  write('\nReady. Ask your agent: "Make a demo of localhost:3000 for Twitter."\n');
}

export const HELP = `create-open-take — add Open Take to an existing app

Usage:
  npm create open-take@latest
  npm create open-take@latest -- --use-pnpm

Options:
  --use-npm | --use-pnpm | --use-yarn | --use-bun
  -h, --help
`;
