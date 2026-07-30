// Argument parsing, driven through the real binary.
//
// The failure this locks down is silent and expensive: a value flag whose value
// is missing used to swallow whatever came next. `make --profile --draft` would
// then run an UNAUTHENTICATED capture with "--draft" as the profile name and
// drop the --draft too — a full-quality shoot of a logged-out app, minutes
// long, with nothing in the output saying why. The parser now refuses instead.
//
// Spawned rather than imported on purpose: cli.ts parses process.argv at module
// scope, so the parse IS the module's load-time behaviour and only a real
// invocation exercises it. Every case below is rejected before any browser or
// filesystem work starts, so the suite stays fast and hermetic.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const CLI = fileURLToPath(new URL("../src/cli.ts", import.meta.url));

function run(args: string[]): Promise<{ code: number; out: string; err: string }> {
  return new Promise((res, rej) => {
    const p = spawn(process.execPath, ["--import", "tsx/esm", CLI, ...args], {
      cwd: fileURLToPath(new URL("..", import.meta.url)),
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

test("a value flag with its value missing errors instead of eating the next flag", async () => {
  const r = await run(["make", "--plan", "--draft"]);
  assert.equal(r.code, 1, "must not proceed");
  assert.match(r.err, /--plan requires a value/);
  // the specific disaster: --draft must never be read AS the plan path
  assert.doesNotMatch(r.err, /no such file|ENOENT/i, "never got as far as opening a plan");
});

test("a value flag at the end of the line errors too", async () => {
  const r = await run(["notes", "--timeout"]);
  assert.equal(r.code, 1);
  assert.match(r.err, /--timeout requires a value/);
});

test("the error names the command as well as the flag", async () => {
  // a bare "--url requires a value" is ambiguous in a transcript full of them
  const r = await run(["auth", "myprofile", "--url"]);
  assert.equal(r.code, 1);
  assert.match(r.err, /^auth: --url requires a value/m);
});

test("a boolean flag is not treated as needing a value", async () => {
  // --headed takes nothing; the guard above must not fire on it, and parsing
  // must get far enough to reach the command's own missing-argument check
  const r = await run(["inspect", "--headed"]);
  assert.equal(r.code, 1);
  assert.match(r.err, /inspect: missing <url>/);
  assert.doesNotMatch(r.err, /requires a value/);
});

test("a value flag with a real value is consumed, and only it", async () => {
  const r = await run(["inspect", "--viewport", "1280x720"]);
  assert.equal(r.code, 1);
  // got past the parser: the only complaint left is the absent positional
  assert.match(r.err, /inspect: missing <url>/);
});

test("an unknown flag still reports the command's allowed list", async () => {
  // the parse guard runs first now — it must not mask the version-skew hint,
  // which is the message that tells a user their installed CLI predates a doc
  const r = await run(["render", "x.mp4", "--bogus", "v"]);
  assert.equal(r.code, 1);
  assert.match(r.err, /unknown flag --bogus/);
  assert.match(r.err, /--review/, "lists what render does accept");
});

// --out names the postable master, and the check runs BEFORE the plan is read
// (and long before a browser starts) so a mistyped extension costs nothing.
test("--out must name an mp4 — a bare name is completed, another extension is refused", async () => {
  const r = await run(["make", "--out", "demo.mov"]);
  assert.equal(r.code, 1);
  assert.match(r.err, /--out must be an \.mp4 path/);

  // a bare name is the natural thing to type: it gets the extension, so the
  // run proceeds to the next missing thing rather than writing a file called
  // "demo" that no player opens
  const bare = await run(["make", "--out", "demo"]);
  assert.equal(bare.code, 1);
  assert.match(bare.err, /make: missing --plan/);
});

// The CLI's users are agents reading --help. Where takes go, and which file is
// the postable one, are the two things a wrong answer to is expensive.
test("--help states the take layout and where takes go by default", async () => {
  const r = await run(["--help"]);
  assert.equal(r.code, 0);
  assert.match(r.out, /<out>\.take\//, "the working dir is named");
  assert.match(r.out, /demos\/take\.mp4/, "the default --out is documented");
  assert.match(r.out, /\.gitignore \(\*\.take\/\)/, "how to keep it out of git");
});

test("a flag that belongs to another command is refused, not ignored", async () => {
  // --profile is a make/inspect flag; accepting it silently on `render` is how
  // an older CLI pretends to honour a newer doc
  const r = await run(["render", "x.mp4", "--profile", "vercel"]);
  assert.equal(r.code, 1);
  assert.match(r.err, /unknown flag --profile/);
});
