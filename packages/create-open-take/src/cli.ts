#!/usr/bin/env node

import { HELP, initializeOpenTake, requestedPackageManager } from "./index";

const args = process.argv.slice(2);

function fail(error: unknown): never {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}

if (args.includes("--help") || args.includes("-h")) {
  process.stdout.write(HELP);
} else {
  try {
    // Detection happens inside, after any missing package.json is scaffolded.
    initializeOpenTake({ packageManager: requestedPackageManager(args) }).catch(fail);
  } catch (error) {
    fail(error);
  }
}
