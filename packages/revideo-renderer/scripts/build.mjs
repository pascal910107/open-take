import { cp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const upstream = dirname(require.resolve("@revideo/renderer/package.json"));
const out = join(root, "dist");

await rm(out, { recursive: true, force: true });
await cp(join(upstream, "lib"), out, { recursive: true });

async function replaceOnce(path, from, to) {
  const source = await readFile(path, "utf8");
  const first = source.indexOf(from);
  if (first === -1 || source.indexOf(from, first + from.length) !== -1) {
    throw new Error(`Expected exactly one ${JSON.stringify(from)} in ${path}`);
  }
  await writeFile(path, source.replace(from, to));
}

await replaceOnce(
  join(out, "server", "render-video.js"),
  'require("puppeteer")',
  'require("puppeteer-core")',
);
await replaceOnce(
  join(out, "server", "render-video.d.ts"),
  "from 'puppeteer';",
  "from 'puppeteer-core';",
);
await replaceOnce(
  join(out, "server", "renderer-plugin.js"),
  "@revideo/renderer/lib/client/render",
  "@open-take/revideo-renderer/dist/client/render",
);
await rm(join(out, "server", "tsconfig.tsbuildinfo"), { force: true });
