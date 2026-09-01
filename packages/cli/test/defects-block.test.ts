// The machine-readable defects block, driven through the real binary on the
// one gate that needs no Chrome: the structural plan lint. The contract under
// test is the repair loop's wire format — exit 2 AND a stdout section between
// the two sentinels holding one JSON object whose entries keep the lint's
// teaching copy and computed fixes verbatim. Hermetic: the lint refusal fires
// before any Chrome work.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

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

const OPEN = "--- open-take defects v1 ---";
const CLOSE = "--- end open-take defects ---";

test("a structurally broken plan exits 2 with a parseable defects block", async () => {
  const dir = await mkdtemp(join(tmpdir(), "open-take-defects-test-"));
  const planPath = join(dir, "plan.json");
  // two benchmark-dominant defects: a wait paced by `duration` (error, with a
  // computed verbatim rewrite) and a type with content in `text` (error)
  await writeFile(
    planPath,
    JSON.stringify({
      url: "http://127.0.0.1:9",
      steps: [
        { action: "wait", duration: 800 },
        { action: "type", text: "Q3 launch" },
      ],
    }),
  );
  const r = await run(["make", "--plan", planPath, "--out", join(dir, "demos", "t.mp4")], dir);
  assert.equal(r.code, 2);
  const open = r.out.indexOf(OPEN);
  const close = r.out.indexOf(CLOSE);
  assert.ok(open >= 0, `stdout is missing the opening sentinel:\n${r.out}\n${r.err}`);
  assert.ok(close > open, "stdout is missing the closing sentinel");
  const report = JSON.parse(r.out.slice(open + OPEN.length, close)) as {
    format: string;
    verb: string;
    exitCode: number;
    plan?: string;
    errors: number;
    defects: { gate: string; severity: string; path: string; message: string; fix?: string }[];
    repair: string;
  };
  assert.equal(report.format, "open-take-defects/1");
  assert.equal(report.verb, "make");
  assert.equal(report.exitCode, 2);
  assert.equal(report.plan, planPath);
  assert.equal(report.errors, 2);
  for (const d of report.defects) assert.equal(d.gate, "plan-lint");
  // the computed wait rewrite must arrive VERBATIM — that copy is the fix the
  // author applies without thinking
  const wait = report.defects.find((d) => d.path === "steps[0].duration");
  assert.ok(wait?.fix?.includes('{"action":"wait","ms":800}'), JSON.stringify(wait));
  const type = report.defects.find((d) => d.path.startsWith("steps[1]"));
  assert.equal(type?.severity, "error");
  assert.match(report.repair, /two repair\s+rounds/);
});

test("a lint refusal refreshes a same-app take dir's stale defects.json", async () => {
  // round 1 left a report in the take dir; round 2's "corrected" plan has a
  // structural error. The refusal must overwrite the stale report — feeding
  // round 1's already-fixed defects back to the plan author is the exact
  // hazard the file exists to prevent.
  const dir = await mkdtemp(join(tmpdir(), "open-take-defects-test-"));
  const take = join(dir, "demos", "t.take");
  await mkdir(take, { recursive: true });
  await writeFile(
    join(take, "capture.json"),
    JSON.stringify({ url: "http://127.0.0.1:9/s/deck", events: [] }),
  );
  await writeFile(join(take, "defects.json"), JSON.stringify({ verb: "make", stale: true }));
  const planPath = join(dir, "plan.json");
  await writeFile(
    planPath,
    JSON.stringify({ url: "http://127.0.0.1:9", steps: [{ action: "wait", duration: 5 }] }),
  );
  const r = await run(["make", "--plan", planPath, "--out", join(dir, "demos", "t.mp4")], dir);
  assert.equal(r.code, 2);
  const onDisk = JSON.parse(await readFile(join(take, "defects.json"), "utf8")) as {
    stale?: boolean;
    defects?: { gate: string }[];
  };
  assert.ok(!onDisk.stale, "stale report must be replaced");
  assert.equal(onDisk.defects?.[0]?.gate, "plan-lint");
});

test("check on a take with skipped steps exits 2, emits the block, and writes defects.json", async () => {
  // a fake take: unreadable mp4s make the pixel gates stand down silently and
  // the cursor audit crash (caught, reported as unjudged-able) — but the
  // capture log's skipped[] and precheck[] alone must carry the verdict, the
  // sentinel block, and the file. Hermetic: no Chrome, no ffmpeg success path.
  const dir = await mkdtemp(join(tmpdir(), "open-take-defects-test-"));
  const take = join(dir, "demos", "x.take");
  await mkdir(take, { recursive: true });
  await writeFile(join(dir, "demos", "x.mp4"), "not really an mp4");
  await writeFile(join(take, "capture.mp4"), "not really an mp4");
  await writeFile(
    join(take, "composition.json"),
    JSON.stringify({
      durationMs: 1000,
      events: [],
      output: { width: 1920, height: 1080, fps: 60 },
    }),
  );
  await writeFile(
    join(take, "capture.json"),
    JSON.stringify({
      video: { width: 1920, height: 1080 },
      viewport: { w: 1280, h: 800 },
      url: "http://127.0.0.1:9",
      events: [],
      skipped: [{ step: 2, action: "click", target: 'text:"Save"', reason: "no match" }],
      precheck: [
        {
          severity: "warn",
          path: "steps[4].text",
          message: "1 target is not in the initial DOM",
        },
      ],
      settleWaits: [
        { step: 1, action: "click", heldMs: 900, waitedMs: 400, reason: "idle" },
        { step: 3, action: "look", heldMs: 1200, waitedMs: 3000, reason: "budget" },
      ],
    }),
  );
  const r = await run(["check", join(dir, "demos", "x.mp4")], dir);
  assert.equal(r.code, 2, `expected exit 2:\n${r.out}\n${r.err}`);
  const open = r.out.indexOf(OPEN);
  const close = r.out.indexOf(CLOSE);
  assert.ok(open >= 0 && close > open, `missing sentinels:\n${r.out}`);
  const report = JSON.parse(r.out.slice(open + OPEN.length, close)) as {
    verb: string;
    exitCode: number;
    defects: { gate: string; severity: string; path: string; fix?: string }[];
  };
  assert.equal(report.verb, "check");
  assert.equal(report.exitCode, 2);
  // the missing beat is an error defect at the step's path…
  const skippedDefect = report.defects.find((d) => d.gate === "capture");
  assert.equal(skippedDefect?.severity, "error");
  assert.equal(skippedDefect?.path, "steps[2]");
  // …and the late-bound warn rides along from capture.json (warn 收口 depends on it)
  const warn = report.defects.find((d) => d.gate === "precheck");
  assert.equal(warn?.severity, "warn");
  // …and the settle underrun arrives with its measured, copyable number —
  // idle beats only (the "budget" beat has no number that would ever satisfy)
  const settles = report.defects.filter((d) => d.path.endsWith(".settleMs"));
  assert.equal(settles.length, 1);
  assert.equal(settles[0]?.path, "steps[1].settleMs");
  assert.match(settles[0]?.fix ?? "", /1300/);
  // the convenience copy exists and parses to the same report
  const onDisk = JSON.parse(await readFile(join(take, "defects.json"), "utf8")) as {
    verb: string;
    defects: unknown[];
  };
  assert.equal(onDisk.verb, "check");
  assert.equal(onDisk.defects.length, report.defects.length);
});

test("a clean lint keeps stdout free of the defects sentinels", async () => {
  // fails later (unreachable app) but the lint gate itself passes — by then
  // no defects block may have printed. OPEN_TAKE_CHROME shortcut keeps the
  // run cheap and offline: the fake "Chrome" (node) exits instantly.
  const dir = await mkdtemp(join(tmpdir(), "open-take-defects-test-"));
  const planPath = join(dir, "plan.json");
  await writeFile(
    planPath,
    JSON.stringify({ url: "http://127.0.0.1:9", steps: [{ action: "wait", ms: 1 }] }),
  );
  const r = await run(["make", "--plan", planPath, "--out", join(dir, "demos", "t.mp4")], dir, {
    OPEN_TAKE_CHROME: process.execPath,
  });
  assert.notEqual(r.code, 2, `expected a non-verdict failure, got:\n${r.out}\n${r.err}`);
  assert.ok(!r.out.includes(OPEN), "no defects block on a lint-clean plan");
});
