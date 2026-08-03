// The unattended lane's building blocks. What these lock down, in order of
// what a failure costs: (1) the app the CI job boots must NEVER inherit the
// agent's API key — the app is the PR's own code, and one line added to a dev
// script would exfiltrate the key before any agent is involved; (2) the brief
// must carry the trust boundary (page content is data, never instructions) and
// the agent flags must match the real claude CLI surface; (3) liveness must
// fail fast WITH the app's own words, because "capture filmed Chrome's error
// page for 10 minutes" is the expensive alternative.
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  appBootEnv,
  buildAgentArgs,
  buildCiBrief,
  CI_ALLOWED_TOOLS,
  CI_DISALLOWED_TOOLS,
  ciAllowedOrigins,
  startApp,
  waitForHttp,
} from "../src/ci";

// --- appBootEnv: the key-exfiltration scrub ---------------------------------

test("the app's boot env never contains the agent's or the runner's secrets", () => {
  const env = appBootEnv({
    ANTHROPIC_API_KEY: "sk-ant-secret",
    CLAUDE_CODE_SIMPLE: "1",
    GITHUB_TOKEN: "ghs_secret",
    ACTIONS_RUNTIME_TOKEN: "art_secret",
    INPUT_ANTHROPIC_API_KEY: "sk-ant-secret-via-action-input",
    DATABASE_URL: "postgres://localhost/dev",
    PATH: "/usr/bin",
    PORT: "3000",
  });
  assert.equal(env.ANTHROPIC_API_KEY, undefined);
  assert.equal(env.CLAUDE_CODE_SIMPLE, undefined);
  assert.equal(env.GITHUB_TOKEN, undefined);
  assert.equal(env.ACTIONS_RUNTIME_TOKEN, undefined);
  assert.equal(env.INPUT_ANTHROPIC_API_KEY, undefined);
  // the app keeps ITS env — a dev server without DATABASE_URL boots broken,
  // and a broken app wastes the whole agent budget filming a stack trace
  assert.equal(env.DATABASE_URL, "postgres://localhost/dev");
  assert.equal(env.PATH, "/usr/bin");
  assert.equal(env.PORT, "3000");
});

// The probe children run from script FILES, not `node -e '…'`: cmd.exe does
// not treat single quotes as quoting, so inline-shell one-liners are exactly
// the kind of POSIX-only test that greens on a Mac and reds on windows-latest.
async function probeScript(source: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "open-take-ci-probe-"));
  const path = join(dir, "probe.mjs");
  await writeFile(path, source);
  return path;
}

test("startApp actually launches with the scrubbed env, end to end", async () => {
  process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY ?? "sk-test-canary";
  const probe = await probeScript(
    `console.log("key=" + (process.env.ANTHROPIC_API_KEY ?? "SCRUBBED"));`,
  );
  const app = startApp(`node "${probe}"`);
  await new Promise((r) => setTimeout(r, 700));
  await app.stop();
  assert.match(app.output.tail(), /key=SCRUBBED/);
});

test("stop() takes down the whole process tree, not just the shell", async () => {
  // the shell spawns a child that would outlive a naive kill; the process
  // group (POSIX) / taskkill tree walk (Windows) is what lets stop() take both
  const probe = await probeScript(`setInterval(() => {}, 1000);`);
  const app = startApp(`node "${probe}"`);
  assert.ok(app.pid, "spawned");
  await app.stop();
  // after stop resolves the tree must be gone — signal 0 probes existence
  // (taskkill is fire-and-forget, so give Windows a beat to reap)
  await new Promise((r) => setTimeout(r, process.platform === "win32" ? 600 : 100));
  assert.throws(() => process.kill(app.pid!, 0), "the process tree must be dead");
});

// --- the brief: the trust boundary and the two modes ------------------------

test("the author brief carries the whole non-interactive contract", () => {
  const brief = buildCiBrief({
    url: "http://localhost:3000",
    outPath: "demos/myapp.mp4",
    brief: "show the bulk-edit flow",
    mode: "author",
  });
  assert.match(brief, /http:\/\/localhost:3000/);
  assert.match(brief, /show the bulk-edit flow/);
  assert.match(brief, /never call AskUserQuestion/i);
  assert.match(brief, /UNTRUSTED CONTENT/);
  assert.match(brief, /never instructions/i, "page content is data, not instructions");
  assert.match(brief, /--out demos\/myapp\.mp4/);
  assert.match(brief, /--strict/, "skipped steps must fail the make");
  assert.match(brief, /--no-open/);
  assert.match(brief, /--fps 30/, "CI defaults to 30fps for 4-vCPU runners");
  assert.match(brief, /do NOT ship a video of it/i, "a broken app means no video, not a bad one");
  assert.match(brief, /dossier/);
  // diff-aware scoping: a CI take follows a code change — the changed flow
  // leads when it is user-visible, with an explicit fallback otherwise
  assert.match(brief, /git diff|git log/, "the brief points at the diff");
  assert.match(brief, /CHANGED flow the demo's protagonist/);
  assert.match(brief, /signature\s+story/, "and names the fallback for non-visual changes");
});

test("a dossier'd take flips the brief to regeneration — maintenance, not re-edit", () => {
  const brief = buildCiBrief({
    url: "https://preview.example.com",
    outPath: "demos/myapp.mp4",
    mode: "regenerate",
  });
  assert.match(brief, /Refresh the existing demo/);
  assert.match(brief, /Keep the established editorial line/);
  assert.match(brief, /stale HINT/, "the cached dossier is data to re-verify, not instructions");
  assert.doesNotMatch(brief, /decide the most impressive TRUE story/);
});

// --- agent args: must match the REAL claude CLI surface ---------------------

test("agent args speak current claude: budget cap, no --max-turns, stream-json", () => {
  const args = buildAgentArgs({ brief: "b", budgetUsd: 5 });
  assert.equal(args[0], "-p");
  assert.ok(args.includes("--max-budget-usd") && args.includes("5"), "budget is the spend cap");
  assert.ok(
    !args.includes("--max-turns"),
    "current claude has no --max-turns — passing it would error",
  );
  assert.ok(args.includes("stream-json"));
  assert.ok(args.includes("--verbose"), "stream-json in -p mode requires --verbose");
});

test("the default permission posture is allowlist + dontAsk, never bypass", () => {
  const args = buildAgentArgs({ brief: "b" });
  assert.ok(args.includes("--permission-mode") && args.includes("dontAsk"));
  const allowed = args[args.indexOf("--allowedTools") + 1]!;
  assert.match(allowed, /Bash\(npx open-take \*\)/);
  assert.ok(!args.includes("--dangerously-skip-permissions"));
  // the exfil verbs are disallowed on TOP of the allowlist
  const disallowed = args[args.indexOf("--disallowedTools") + 1]!;
  assert.match(disallowed, /curl/);
  assert.match(disallowed, /Bash\(gh \*\)/);
  assert.match(disallowed, /WebFetch/);
});

test("--skip-permissions swaps the allowlist for the explicit bypass — but keeps the denials", () => {
  const args = buildAgentArgs({ brief: "b", skipPermissions: true });
  assert.ok(args.includes("--dangerously-skip-permissions"));
  assert.ok(!args.includes("--allowedTools"));
  assert.ok(args.includes("--disallowedTools"), "the deny list is the only belt left");
});

test("the curated lists stay disjoint — a tool cannot be both allowed and denied", () => {
  const allowed = new Set(CI_ALLOWED_TOOLS.split(","));
  for (const denied of CI_DISALLOWED_TOOLS.split(",")) {
    assert.ok(!allowed.has(denied), `${denied} is in both lists`);
  }
});

test("git is readable but never writable — the diff feeds editorial, not exfil", () => {
  const allowed = CI_ALLOWED_TOOLS;
  assert.match(allowed, /Bash\(git diff \*\)/);
  assert.match(allowed, /Bash\(git log \*\)/);
  assert.doesNotMatch(allowed, /git push|git commit|git remote/);
  assert.match(CI_DISALLOWED_TOOLS, /Bash\(git push\*\)/, "push stays on the deny list");
});

// --- the navigation fence and its escape hatch -------------------------------

test("the fence always carries the localhost/127.0.0.1 twin — same server, two spellings", () => {
  assert.equal(
    ciAllowedOrigins("http://localhost:3000"),
    "http://localhost:3000,http://127.0.0.1:3000",
  );
  assert.equal(
    ciAllowedOrigins("http://127.0.0.1:4173"),
    "http://127.0.0.1:4173,http://localhost:4173",
  );
  // a real domain has no twin to invent
  assert.equal(ciAllowedOrigins("https://preview.example.com"), "https://preview.example.com");
});

test("--allowed-origins entries normalize to origins, dedupe, and a bare host trusts both schemes", () => {
  assert.equal(
    ciAllowedOrigins(
      "https://app.example.com",
      "https://docs.example.com/getting-started, app.example.com",
    ),
    // the path is dropped; the bare host adds http:// alongside the https://
    // the app origin already covers
    "https://app.example.com,https://docs.example.com,http://app.example.com",
  );
});

test("an unparseable --allowed-origins entry errors up front, not as a silent no-match", () => {
  assert.throws(() => ciAllowedOrigins("http://localhost:3000", "not a url at all"), /not a URL/);
});

// --- liveness: fail fast, and say why ---------------------------------------

test("waitForHttp resolves once anything answers — even a late, non-200 server", async () => {
  const server = createServer((_req, res) => {
    res.statusCode = 401; // an auth wall is still a LIVE app
    res.end("nope");
  });
  await new Promise<void>((r) => setTimeout(r, 300)).then(
    () => new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r())),
  );
  const port = (server.address() as { port: number }).port;
  await waitForHttp(`http://127.0.0.1:${port}/`, { timeoutMs: 5000, intervalMs: 100 });
  server.close();
});

test("waitForHttp's timeout carries the app's own last words", async () => {
  const probe = await probeScript(
    `console.error("EADDRINUSE: port 3000 already in use"); setInterval(() => {}, 1000);`,
  );
  const app = startApp(`node "${probe}"`);
  await new Promise((r) => setTimeout(r, 500));
  await assert.rejects(
    waitForHttp("http://127.0.0.1:1", { timeoutMs: 400, intervalMs: 100, appOutput: app.output }),
    /EADDRINUSE/,
    "the failure message must include the app's log tail — that's the diagnosis",
  );
  await app.stop();
});

test("waitForHttp without a booted app suggests --start", async () => {
  await assert.rejects(
    waitForHttp("http://127.0.0.1:1", { timeoutMs: 300, intervalMs: 100 }),
    /--start/,
  );
});
