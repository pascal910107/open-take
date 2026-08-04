// The cross-app overwrite guard, driven through the real binary. Two demos in
// one folder must not silently eat each other — but a per-PR preview deploy
// gives the SAME app a fresh hostname every PR, so under OPEN_TAKE_CI the
// refusal softens to a warning (the take's identity there is the pipeline's
// cache key, not the origin). Hermetic: the refusal fires before any Chrome
// work, and the relaxed path is cut short by pointing OPEN_TAKE_CHROME at the
// node binary — which exits on Chrome's flags instantly, no download, no net.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const CLI = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const TSX = import.meta.resolve("tsx/esm");

function run(
  args: string[],
  cwd: string,
  env: Record<string, string> = {},
): Promise<{ code: number; out: string; err: string }> {
  return new Promise((res, rej) => {
    const p = spawn(process.execPath, ["--import", TSX, CLI, ...args], {
      cwd,
      env: { ...process.env, ...env },
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

// A take of app A on disk, and a plan that drives app B at the same --out.
async function crossAppScene(): Promise<{ dir: string; planPath: string }> {
  const dir = await mkdtemp(join(tmpdir(), "open-take-guard-test-"));
  const take = join(dir, "demos", "x.take");
  await mkdir(take, { recursive: true });
  await writeFile(join(dir, "demos", "x.mp4"), "not really an mp4");
  await writeFile(
    join(take, "capture.json"),
    JSON.stringify({ url: "https://myapp-git-pr1-team.vercel.app/dash", events: [] }),
  );
  const planPath = join(dir, "plan.json");
  // never navigated to in these tests: the run either refuses before Chrome or
  // dies launching the fake Chrome below
  await writeFile(planPath, JSON.stringify({ url: "http://127.0.0.1:9", steps: [] }));
  return { dir, planPath };
}

test("make refuses to overwrite a take shot from a different app, and names the fix", async () => {
  const { dir, planPath } = await crossAppScene();
  const r = await run(["make", "--plan", planPath, "--out", "demos/x.mp4", "--no-open"], dir);
  assert.equal(r.code, 1);
  assert.match(r.err, /already a take of https:\/\/myapp-git-pr1-team\.vercel\.app/);
  assert.match(r.err, /--force/, "the same-app-new-address escape hatch is named");
});

test("under OPEN_TAKE_CI the cross-app refusal softens to a warning — preview origins differ by design", async () => {
  const { dir, planPath } = await crossAppScene();
  const r = await run(["make", "--plan", planPath, "--out", "demos/x.mp4", "--no-open"], dir, {
    OPEN_TAKE_CI: "1",
    // an existing, runnable, definitely-not-Chrome binary: the capture dies in
    // milliseconds ("chrome exited early"), keeping the test hermetic — what
    // matters is that the run got PAST the guard
    OPEN_TAKE_CHROME: process.execPath,
  });
  assert.notEqual(r.code, 0, "the run still fails later (fake Chrome) — just not at the guard");
  assert.match(r.err, /⚠ make: overwriting a take of https:\/\/myapp-git-pr1-team\.vercel\.app/);
  assert.doesNotMatch(r.err, /already a take of/, "no refusal under OPEN_TAKE_CI");
});
