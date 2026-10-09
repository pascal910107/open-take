// The lines that point a film at the product's parts, driven through the real
// binary on the compositor's small synthetic shoot: `film init --from` names
// product() at the URL film render serves the shoot from when run in the
// same folder, and `open-take components` lists the tracks followed with the
// cursor kept at each step and the same line. Hermetic: the shoot's parts are
// measured already, so no Chrome.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { writePartsShoot } from "../../compositor/test/fixtures/parts-shoot";

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

let dir = "";
before(async () => {
  dir = await mkdtemp(join(tmpdir(), "open-take-cli-parts-"));
  await mkdir(join(dir, "shots"));
  writePartsShoot(join(dir, "shots"));
});
after(async () => {
  await rm(dir, { recursive: true, force: true });
});

test("film init --from: the shoot's parts by product() at the URL film render serves", async () => {
  const r = await run(["film", "init", "film", "--from", "shots"], dir);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /^components: 21 parts in 7 saved screens/m);
  assert.match(
    r.out,
    /^parts: product\("\/shots\/"\) in kit\/media\.js — each part by ref or track as one reference/m,
  );
  // run from inside the shoot, the shoot is the served folder itself
  const inside = await run(["film", "init", "film", "--from", "."], join(dir, "shots"));
  assert.equal(inside.code, 0, inside.err);
  assert.match(inside.out, /^parts: product\("\/"\)/m);
});

test("open-take components: the tracks followed with the cursor, and the product() line", async () => {
  const r = await run(["components", "shots"], dir);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /^followed: t1 number "9" 3 → 9 over home…n-4, cursor kept at each step$/m);
  assert.match(r.out, /^parts: product\("\/shots\/"\) in kit\/media\.js/m);
});
