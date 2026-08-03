// The `ci` verb, driven through the real binary — hermetic: --dry-run spends
// nothing, boots nothing, downloads nothing, yet exercises the whole
// preflight (flag validation → skill install → mode detection → the exact
// agent command). What this locks down: a CI job's misconfiguration must die
// at minute zero with a named fix, never at minute 22 of a paid run.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const CLI = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
// resolved to an absolute URL here, because the suite runs the CLI from
// scratch temp dirs where a bare "tsx/esm" specifier has nothing to resolve to
const TSX = import.meta.resolve("tsx/esm");

function run(args: string[], cwd: string): Promise<{ code: number; out: string; err: string }> {
  return new Promise((res, rej) => {
    const p = spawn(process.execPath, ["--import", TSX, CLI, ...args], {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    p.stdout.on("data", (d) => {
      out += d;
    });
    p.stderr.on("data", (d) => {
      err += d;
    });
    p.once("error", rej);
    p.once("close", (code) => res({ code: code ?? -1, out, err }));
  });
}

const scratch = () => mkdtemp(join(tmpdir(), "open-take-ci-test-"));

test("ci without a url names the fix", async () => {
  const r = await run(["ci"], await scratch());
  assert.equal(r.code, 1);
  assert.match(r.err, /ci: missing <url>/);
  assert.match(r.err, /--start/, "points at how to boot the app too");
});

test("a bad numeric flag dies before any side effect", async () => {
  const dir = await scratch();
  const r = await run(["ci", "http://localhost:3000", "--budget-usd", "lots", "--dry-run"], dir);
  assert.equal(r.code, 1);
  assert.match(r.err, /--budget-usd expects a positive number/);
  // no skill install happened — the typo cost nothing
  await assert.rejects(stat(join(dir, ".agents")), "no side effects before validation");
});

test("a flag from another verb is refused on ci too", async () => {
  const r = await run(["ci", "http://localhost:3000", "--profile", "me"], await scratch());
  assert.equal(r.code, 1);
  assert.match(r.err, /unknown flag --profile/);
});

test("--dry-run prints the exact agent command and the brief, and installs the skill", async () => {
  const dir = await scratch();
  const r = await run(
    ["ci", "http://localhost:3000", "--brief", "demo the search flow", "--dry-run"],
    dir,
  );
  assert.equal(r.code, 0, r.err);
  // the command: real current-claude flags, nothing invented
  assert.match(r.out, /claude -p/);
  assert.match(r.out, /--max-budget-usd 8/, "the default budget is visible");
  assert.match(r.out, /--permission-mode dontAsk/);
  assert.match(r.out, /--disallowedTools/);
  assert.doesNotMatch(r.out, /--max-turns/, "current claude has no such flag");
  // the brief: the whole unattended contract, readable before spending
  assert.match(r.out, /--- brief ---/);
  assert.match(r.out, /demo the search flow/);
  assert.match(r.out, /author mode/, "no dossier here — cold authorship");
  // the skill landed where a headless agent will look for it
  const skill = await stat(join(dir, ".claude", "skills", "open-take", "SKILL.md"));
  assert.ok(skill.isFile());
});

test("--skip-permissions swaps to the explicit bypass in the printed command", async () => {
  const dir = await scratch();
  const r = await run(["ci", "http://localhost:3000", "--dry-run", "--skip-permissions"], dir);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /--dangerously-skip-permissions/);
  assert.doesNotMatch(r.out, /--allowedTools/);
});

test("an existing dossier flips the run to regenerate mode", async () => {
  const dir = await scratch();
  // the take dir with a dossier is the marker a previous (human-checked) demo
  // left behind — CI's job becomes keeping THAT demo fresh, not re-directing
  await mkdir(join(dir, "demos", "take.take"), { recursive: true });
  await writeFile(
    join(dir, "demos", "take.take", "dossier.md"),
    "# myapp\nhero: the bulk-edit flow\n",
  );
  const r = await run(["ci", "http://localhost:3000", "--dry-run"], dir);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /regenerate mode/);
  assert.match(r.out, /Refresh the existing demo/);
  assert.match(r.out, /Keep the established editorial line/);
});

test("--help documents the ci verb's contract", async () => {
  const r = await run(["--help"], await scratch());
  assert.equal(r.code, 0);
  assert.match(r.out, /open-take ci/);
  assert.match(r.out, /ANTHROPIC_API_KEY/, "the one secret it needs is named");
  assert.match(r.out, /GITHUB_OUTPUT/, "the Actions contract is named");
  assert.match(r.out, /--dry-run/);
});
