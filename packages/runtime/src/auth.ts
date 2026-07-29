// open-take auth — one-time interactive login on a PERSISTENT profile.
//
// Launches a HEADED Chrome on ~/.open-take/profiles/<name> (or an explicit
// dir), navigates to the login URL, and waits for the human to finish (press
// Enter in the terminal, or quit Chrome). Later captures reuse the same
// profile via `make --profile <name>` — still headless — so the recording is
// authenticated without ever typing credentials into a TakePlan.
//
// Deliberately NOT launchBrowser: no CDP, no debug port, no automation flags
// beyond the keychain ones — as close to a normal browsing session as an
// isolated profile gets. The keychain flags (--password-store=basic /
// --use-mock-keychain) MUST match the capture launch exactly: Chrome encrypts
// cookies with the active keychain, so a mismatch would write cookies the
// headless capture can't decrypt.

import { type ChildProcess, spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { ensureChrome } from "./cdp";

/** The canonical profile dir for a named auth profile. Names are a single
 *  path segment — anything else ("../", "/", spaces-only) would escape or
 *  collide with other open-take state under ~/.open-take. */
export function profileDir(name: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name) || name.includes(".."))
    throw new Error(
      `invalid profile name ${JSON.stringify(name)} — use letters/digits/dots/dashes/underscores`,
    );
  return join(homedir(), ".open-take", "profiles", name);
}

export type AuthOpts = {
  /** profile name (dir under ~/.open-take/profiles/) — or pass `dir` */
  name: string;
  /** explicit profile dir (overrides `name`) */
  dir?: string;
  /** where to send the user to log in (default about:blank) */
  url?: string;
  /** explicit Chrome binary (else auto-resolved / auto-downloaded) */
  chromePath?: string;
};

export type AuthResult = { dir: string };

/**
 * Open a headed Chrome on the persistent profile and resolve when the user is
 * done (Enter on stdin, or the browser quits). The profile dir is returned so
 * callers can print how to use it.
 */
export async function authProfile(opts: AuthOpts): Promise<AuthResult> {
  const dir = opts.dir ?? profileDir(opts.name);
  mkdirSync(dir, { recursive: true });
  const chrome = await ensureChrome(opts.chromePath);
  const proc: ChildProcess = spawn(
    chrome,
    [
      `--user-data-dir=${dir}`,
      "--no-first-run",
      "--no-default-browser-check",
      // keychain parity with launchBrowser (see header)
      "--password-store=basic",
      "--use-mock-keychain",
      "--window-size=1280,900",
      opts.url ?? "about:blank",
    ],
    { stdio: ["ignore", "ignore", "ignore"], detached: false },
  );

  let spawnErr: Error | undefined;
  await new Promise<void>((resolveWait) => {
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      process.stdin.off("data", onEnter);
      if (process.stdin.isTTY) process.stdin.pause();
      resolveWait();
    };
    const onEnter = () => done();
    proc.once("exit", done);
    proc.once("error", (e) => {
      // spawn failure (bad chromePath, EACCES): 'exit' never fires — surface
      // the real error instead of crashing on an unhandled 'error' event.
      spawnErr = e;
      done();
    });
    if (process.stdin.isTTY) {
      process.stdin.resume();
      process.stdin.on("data", onEnter);
    }
  });
  if (spawnErr) throw new Error(`auth: failed to launch Chrome: ${spawnErr.message}`);

  // If the user pressed Enter with Chrome still open, close it gracefully so
  // the profile (cookies, local storage) flushes to disk — and WAIT for the
  // exit (cleared timer, SIGKILL fallback) so we never print "profile saved"
  // while Chrome still holds the SingletonLock mid-flush.
  if (proc.exitCode == null) {
    proc.kill("SIGTERM");
    await new Promise<void>((r) => {
      const tm = setTimeout(() => {
        try {
          proc.kill("SIGKILL");
        } catch {
          /* already gone */
        }
        r();
      }, 4000);
      proc.once("exit", () => {
        clearTimeout(tm);
        r();
      });
    });
  }
  // give Chrome a beat to finish flushing profile files
  await new Promise((r) => setTimeout(r, 500));
  return { dir };
}
