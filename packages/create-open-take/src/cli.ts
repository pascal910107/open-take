#!/usr/bin/env node

import { createInterface } from "node:readline/promises";
import { type Ask, HELP, initializeOpenTake, parseArgs } from "./index";

// Only ask when there is a human to answer. Piped stdin (CI, `| cat`) gets the
// error that names the directory argument instead of hanging on a prompt.
const ask: Ask | undefined = process.stdin.isTTY
  ? async (question, defaultValue) => {
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      try {
        return await rl.question(`${question} (${defaultValue}): `);
      } finally {
        rl.close();
      }
    }
  : undefined;

function fail(error: unknown): never {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}

try {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(HELP);
  } else {
    // Package-manager detection happens inside, against the resolved directory.
    initializeOpenTake({
      directory: args.directory,
      yes: args.yes,
      packageManager: args.packageManager,
      ask,
    }).catch(fail);
  }
} catch (error) {
  fail(error);
}
