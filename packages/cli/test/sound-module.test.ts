// `open-take sound render score.mjs`: a score written as code — its default
// export, the score or a function that returns it — renders like score.json.
// Hermetic: no Chrome.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const CLI = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
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

test("a score written as code renders: loops on a beat, the module's default export", async () => {
  const dir = await mkdtemp(join(tmpdir(), "open-take-score-mjs-"));
  await writeFile(
    join(dir, "score.mjs"),
    `const beat = 60 / 120;
export default async function () {
  const kicks = [];
  for (let i = 0; i < 8; i++) kicks.push({ at: i * beat, drum: "kick-long", gainDb: -8 });
  return { version: 1, durationS: 4, tracks: [{ name: "drums", events: kicks }] };
}
`,
  );
  const r = await run(["sound", "render", "score.mjs", "--json"], dir);
  assert.equal(r.code, 0, r.err);
  const res = JSON.parse(r.out) as { out: string; tracks: { name: string }[] };
  assert.equal(res.out, "score.wav");
  assert.deepEqual(
    res.tracks.map((t) => t.name),
    ["drums"],
  );
  const wav = await readFile(join(dir, "score.wav"));
  assert.equal(wav.subarray(0, 4).toString(), "RIFF");
  assert.ok(wav.length > 48000 * 2 * 3, "about four seconds of sound");
});

test("a score module without a default export says what it needs", async () => {
  const dir = await mkdtemp(join(tmpdir(), "open-take-score-mjs-"));
  await writeFile(join(dir, "score.mjs"), "export const score = {};\n");
  const r = await run(["sound", "render", "score.mjs"], dir);
  assert.notEqual(r.code, 0);
  assert.match(r.err, /no default export/);
});
