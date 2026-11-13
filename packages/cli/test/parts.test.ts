// The lines that point a film at the product's parts, driven through the real
// binary on the compositor's small synthetic shoot: `film init --from` names
// product() at the URL film render serves the shoot from when run in the
// same folder, and `open-take components` lists the tracks followed with the
// cursor kept at each step, the same line, and the parts written as files.
// Hermetic: the shoot's parts are measured already, so no Chrome — except
// `film init --url` on a served page, which skips without one.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { writePartDom, writePartsShoot } from "../../compositor/test/fixtures/parts-shoot";
import { resolveChrome } from "../../runtime/src/cdp";

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
  writePartDom(join(dir, "shots"));
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
  // what init wrote: the kit a line a file, the samples as one line, START.md last
  assert.match(r.out, /^wrote film\/kit\/time\.js$/m);
  assert.match(
    r.out,
    /^wrote film\/samples\/ \(\d+ files — recorded instruments; NOTICE\.txt has their licences\)$/m,
  );
  assert.match(r.out, /\nRead film\/START\.md first\.\n$/);
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
  assert.match(
    r.out,
    /^parts: 2 parts as files in shots\/parts\/ \(index\.json\) — each opens alone at any size, in the product's styles; 19 skipped, each with its reason in index\.json$/m,
  );
  assert.ok(existsSync(join(dir, "shots", "parts", "home-e2-heading.html")));
});

const chrome = process.env.OPEN_TAKE_E2E_CHROME ?? resolveChrome();

test("film init --url: the summary says the parts are files in film/parts/", {
  skip: chrome ? false : "no Chrome for Testing",
  timeout: 120000,
}, async () => {
  const server = createServer((_req, res) =>
    res
      .writeHead(200, { "content-type": "text/html; charset=utf-8" })
      .end(
        `<!doctype html><html><head><title>Plans</title><style>body{margin:0;font:16px sans-serif}.card{margin:40px;width:300px;padding:20px;background:#eef;border-radius:12px;box-shadow:0 2px 8px #0003}.v{font-size:40px;font-weight:700}</style></head><body><h1>Plans</h1><div class="card"><p>You save</p><span class="v">NT$4,466</span></div><button>Start now</button></body></html>`,
      ),
  );
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  try {
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/`;
    const r = await run(["film", "init", "film-url", "--url", url, "--size", "800x600"], dir);
    assert.equal(r.code, 0, r.err);
    assert.match(
      r.out,
      /^parts: \d+ parts? as files in film-url\/parts\/ \(index\.json\) — each opens alone at any size, in the product's styles/m,
    );
    assert.ok(existsSync(join(dir, "film-url", "parts", "index.json")));
    // the page to start from names them, beside the other routes
    assert.match(
      readFileSync(join(dir, "film-url", "index.html"), "utf8"),
      /its parts as files: parts\/index\.json/,
    );
  } finally {
    server.close();
  }
});
