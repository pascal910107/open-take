import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile, mkdtemp } from "node:fs/promises";
import { gunzipSync } from "node:zlib";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packages = {
  bridge: "packages/revideo-renderer",
  compositor: "packages/compositor",
  runtime: "packages/runtime",
  cli: "packages/cli",
  initializer: "packages/create-open-take",
};

function textField(buffer) {
  const zero = buffer.indexOf(0);
  return buffer.subarray(0, zero === -1 ? buffer.length : zero).toString("utf8");
}

async function tarEntries(archivePath) {
  const tar = gunzipSync(await readFile(archivePath));
  const entries = new Map();

  for (let offset = 0; offset + 512 <= tar.length; ) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;

    const name = textField(header.subarray(0, 100));
    const prefix = textField(header.subarray(345, 500));
    const path = prefix ? `${prefix}/${name}` : name;
    const size = Number.parseInt(textField(header.subarray(124, 136)).trim() || "0", 8);
    const dataStart = offset + 512;
    entries.set(path, tar.subarray(dataStart, dataStart + size));
    offset = dataStart + Math.ceil(size / 512) * 512;
  }

  return entries;
}

function pack(packageDir, destination) {
  const pnpmEntry = process.env.npm_execpath;
  assert.ok(pnpmEntry, "npm_execpath must point to pnpm");
  const output = execFileSync(
    process.execPath,
    [pnpmEntry, "pack", "--pack-destination", destination, "--json"],
    {
      cwd: resolve(workspaceRoot, packageDir),
      encoding: "utf8",
    },
  );
  const jsonStart = Math.max(0, output.lastIndexOf("\n{") + 1);
  return JSON.parse(output.slice(jsonStart)).filename;
}

function entryText(entries, path) {
  const entry = entries.get(path);
  assert.ok(entry, `${path} must be present in the packed artifact`);
  return entry.toString("utf8");
}

test("packed release artifacts form a browser-download-free dependency chain", async () => {
  const destination = await mkdtemp(join(tmpdir(), "open-take-packages-"));
  const artifacts = Object.fromEntries(
    Object.entries(packages).map(([name, path]) => [name, pack(path, destination)]),
  );
  const entries = Object.fromEntries(
    await Promise.all(
      Object.entries(artifacts).map(async ([name, path]) => [name, await tarEntries(path)]),
    ),
  );
  const manifests = Object.fromEntries(
    Object.entries(entries).map(([name, files]) => [
      name,
      JSON.parse(entryText(files, "package/package.json")),
    ]),
  );

  assert.equal(manifests.bridge.version, "0.1.0");
  assert.equal(manifests.bridge.dependencies.puppeteer, undefined);
  assert.equal(manifests.bridge.dependencies["puppeteer-core"], "25.3.0");
  assert.equal(manifests.compositor.version, "0.1.2");
  assert.equal(
    manifests.compositor.dependencies["@open-take/revideo-renderer"],
    manifests.bridge.version,
  );
  assert.equal(manifests.runtime.version, "0.1.2");
  assert.equal(
    manifests.runtime.dependencies["@open-take/compositor"],
    manifests.compositor.version,
  );
  assert.equal(manifests.cli.version, "0.1.3");
  assert.equal(manifests.cli.dependencies["@open-take/runtime"], manifests.runtime.version);
  assert.equal(manifests.initializer.version, "0.1.0");
  assert.equal(manifests.initializer.dependencies, undefined);
  entryText(entries.initializer, "package/LICENSE");

  const declarations = entryText(entries.bridge, "package/dist/server/render-video.d.ts");
  assert.match(declarations, /from 'puppeteer-core'/);
  assert.doesNotMatch(declarations, /from 'puppeteer'/);

  const readme = entryText(entries.cli, "package/README.md");
  entryText(entries.cli, "package/skill/SKILL.md");
  assert.doesNotMatch(readme, /PUPPETEER_SKIP_DOWNLOAD/);
  assert.doesNotMatch(readme, /open-take make/);
});
