#!/usr/bin/env node

import { HELP, detectPackageManager, initializeOpenTake, requestedPackageManager } from "./index";

const args = process.argv.slice(2);

if (args.includes("--help") || args.includes("-h")) {
  process.stdout.write(HELP);
} else {
  initializeOpenTake({
    packageManager: requestedPackageManager(args) ?? detectPackageManager(process.cwd()),
  }).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}
