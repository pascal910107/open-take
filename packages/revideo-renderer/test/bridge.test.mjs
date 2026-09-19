import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

test("the packaged renderer uses puppeteer-core and its own client", async () => {
  const server = await readFile(resolve(root, "dist/server/render-video.js"), "utf8");
  const declarations = await readFile(resolve(root, "dist/server/render-video.d.ts"), "utf8");
  const plugin = await readFile(resolve(root, "dist/server/renderer-plugin.js"), "utf8");
  const pkg = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));

  assert.match(server, /require\("puppeteer-core"\)/);
  assert.doesNotMatch(server, /require\("puppeteer"\)/);
  assert.match(declarations, /from 'puppeteer-core'/);
  assert.doesNotMatch(declarations, /from 'puppeteer'/);
  assert.match(plugin, /@open-take\/revideo-renderer\/dist\/client\/render/);
  assert.equal(pkg.dependencies.puppeteer, undefined);
  assert.equal(pkg.dependencies["puppeteer-core"], "25.4.0");
});

test("the silent audio track bypasses fluent-ffmpeg's -formats check (FFmpeg ≥ 7 lists lavfi as a device)", async () => {
  const server = await readFile(resolve(root, "dist/server/render-video.js"), "utf8");
  assert.match(
    server,
    /Object\.assign\(\{\}, require\("@revideo\/ffmpeg"\), require\("\.\/silent-audio"\)\)/,
  );
  const { createSilentAudioFile } = await import(
    pathToFileURL(resolve(root, "dist/server/silent-audio.js")).href // a file URL: Windows needs it
  );
  assert.equal(typeof createSilentAudioFile, "function");
});
