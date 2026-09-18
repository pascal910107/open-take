// Capture original local fixtures, including real before/after interaction states.
// Run after pnpm build: node examples/motion/prepare-assets.mjs
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ensureChrome } from "../../packages/runtime/dist/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const out = process.argv[2] ? resolve(process.argv[2]) : resolve(here, "../../out/motion-demo");
const captureScale = 2;
const assets = join(out, "assets");
await mkdir(assets, { recursive: true });
const requireRenderer = createRequire(
  new URL("../../packages/revideo-renderer/package.json", import.meta.url),
);
const puppeteer = requireRenderer("puppeteer-core");
const html = await readFile(join(here, "fixture.html"));
const server = createServer((_req, res) => {
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(html);
});
await new Promise((ok, fail) => {
  server.once("error", fail);
  server.listen(0, "127.0.0.1", ok);
});
let browser;
const manifest = {
  viewport: { width: 1440, height: 900, deviceScaleFactor: captureScale },
  sourcePixels: { width: 1440 * captureScale, height: 900 * captureScale },
  source: "examples/motion/fixture.html",
  views: {},
};
try {
  browser = await puppeteer.launch({ executablePath: await ensureChrome(), headless: true });
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: captureScale });
  for (const view of ["commerce", "analytics", "board"]) {
    await page.goto(`http://127.0.0.1:${server.address().port}/?view=${view}`, {
      waitUntil: "networkidle0",
    });
    await page.evaluate(() => document.fonts.ready);
    const crops = await page.evaluate(
      (scale) =>
        Object.fromEntries(
          [...document.querySelectorAll("[data-crop]")].map((node) => {
            const r = node.getBoundingClientRect();
            return [
              node.dataset.crop,
              {
                x: Math.floor(r.x * scale),
                y: Math.floor(r.y * scale),
                width: Math.ceil(r.right * scale) - Math.floor(r.x * scale),
                height: Math.ceil(r.bottom * scale) - Math.floor(r.y * scale),
              },
            ];
          }),
        ),
      captureScale,
    );
    const before = `assets/${view}.png`;
    await page.screenshot({ path: join(out, before) });
    if (view === "commerce") await page.click("#compare");
    if (view === "analytics") await page.click("#week");
    if (view === "board") {
      await page.click("#advance");
      await page.click("#advance");
    }
    const after = `assets/${view}-after.png`;
    await page.screenshot({ path: join(out, after) });
    manifest.views[view] = { before, after, crops };
  }
  const hashes = {};
  for (const entry of Object.values(manifest.views))
    for (const file of [entry.before, entry.after])
      hashes[file] = createHash("sha256")
        .update(await readFile(join(out, file)))
        .digest("hex");
  await writeFile(join(out, "assets.json"), JSON.stringify(manifest, null, 2) + "\n");
  await writeFile(join(out, "source-hashes.json"), JSON.stringify(hashes, null, 2) + "\n");
  console.log(`Original screenshots and measured crops ready: ${out}`);
} finally {
  if (browser) await browser.close();
  await new Promise((ok) => server.close(ok));
}
