// A saved state keeps the page's web fonts, against real Chrome: the MHTML
// snapshot carries no font file at all, so `finalizeDomStates` fetches each
// @font-face file through the recorded page and saves it with the other
// parts. A served page with an inline face, a linked sheet's relative faces
// (unicode-range subsets, one the page never uses) and two faces whose path
// the app answers with its HTML shell (one used, one not) → capture → finalize → the state opened
// from disk with the server gone draws its text in the saved fonts. Skips
// without a Chrome for Testing or the workspace's @fontsource files.

import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { type Browser, fitViewport, launchBrowser, resolveChrome } from "../src/cdp";
import { captureDomState, finalizeDomStates } from "../src/dom-state";

const chrome = process.env.OPEN_TAKE_E2E_CHROME ?? resolveChrome();
const FILES = join(
  import.meta.dirname,
  "..",
  "..",
  "..",
  "node_modules",
  ".pnpm",
  "@fontsource+geist-mono@5.3.0",
  "node_modules",
  "@fontsource",
  "geist-mono",
  "files",
);
const font = (subset: string) => join(FILES, `geist-mono-${subset}-400-normal.woff2`);
const SUBSETS = ["latin", "latin-ext", "cyrillic", "vietnamese"];
const skip = !chrome
  ? "no Chrome for Testing"
  : !SUBSETS.every((s) => existsSync(font(s)))
    ? "no @fontsource/geist-mono files"
    : false;

const HTML = `<!DOCTYPE html><html><head><meta charset="utf-8">
<style>@font-face{font-family:Inline;src:url(/fonts/inline.woff2) format("woff2")}</style>
<link rel="stylesheet" href="/static/css/app.css"></head>
<body style="margin:0;font-size:28px">
<p style="font-family:Inline">inline face</p>
<p style="font-family:Sub">latin and Ā ext</p>
<p style="font-family:Shell,monospace">shell face</p>
</body></html>`;
const CSS = `@font-face{font-family:Sub;src:url("../media/latin.woff2") format("woff2");unicode-range:U+0000-00FF}
@font-face{font-family:Sub;src:url("../media/latin-ext.woff2") format("woff2");unicode-range:U+0100-024F}
@font-face{font-family:Sub;src:url("../media/cyrillic.woff2") format("woff2");unicode-range:U+0400-045F}
@font-face{font-family:Shell;src:url("../media/shell.woff2") format("woff2")}
@font-face{font-family:Ghost;src:url("../media/ghost.woff2") format("woff2")}`;

async function serve(): Promise<{ server: Server; url: string }> {
  const server = createServer((req, res) => {
    const u = req.url ?? "/";
    if (u === "/static/css/app.css")
      return res.writeHead(200, { "content-type": "text/css" }).end(CSS);
    if (u === "/fonts/inline.woff2")
      return res
        .writeHead(200, { "content-type": "font/woff2" })
        .end(readFileSync(font("vietnamese")));
    const m = /^\/static\/media\/(latin|latin-ext|cyrillic)\.woff2$/.exec(u);
    if (m)
      return res.writeHead(200, { "content-type": "font/woff2" }).end(readFileSync(font(m[1]!)));
    // an app that answers every other path with its page
    res.writeHead(200, { "content-type": "text/html" }).end(HTML);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  return { server, url: `http://127.0.0.1:${(server.address() as { port: number }).port}/` };
}

test("a saved state keeps the page's web fonts the snapshot leaves out, and draws with them offline", {
  skip,
  timeout: 120000,
}, async () => {
  const dir = await mkdtemp(join(tmpdir(), "open-take-dom-state-fonts-"));
  let browser: Browser | null = null;
  let server: Server | null = null;
  try {
    const served = await serve();
    server = served.server;
    browser = await launchBrowser({ width: 640, height: 360, chromePath: chrome! });
    const { cdp } = browser;
    await cdp.send("Page.enable");
    await cdp.send("Runtime.enable");
    const inner = await fitViewport(cdp, browser.targetId, 640, 360);
    const evaluate = async <T>(expression: string): Promise<T> =>
      (
        await cdp.send<{ result?: { value?: T } }>("Runtime.evaluate", {
          expression,
          returnByValue: true,
          awaitPromise: true,
        })
      ).result!.value as T;
    const loaded = new Promise<void>((r) => cdp.on("Page.loadEventFired", () => r()));
    await cdp.send("Page.navigate", { url: served.url });
    await loaded;
    await evaluate("document.fonts.ready.then(() => true)");

    const statesDir = join(dir, "states");
    const raw = await captureDomState(cdp, {
      statesDir,
      id: "s0",
      tMs: 0,
      vw: inner[0],
      vh: inner[1],
      dpr: 1,
    });
    const used = (raw.loadedFonts ?? []).map((u) => new URL(u).pathname).sort();
    assert.deepEqual(
      used,
      [
        "/fonts/inline.woff2",
        "/static/media/latin-ext.woff2",
        "/static/media/latin.woff2",
        "/static/media/shell.woff2",
      ],
      "the files the page fetched for its fonts are noted",
    );
    await finalizeDomStates({
      browser,
      statesDir,
      states: [raw],
      vw: inner[0],
      vh: inner[1],
      parts: false,
    });

    const assetsDir = join(statesDir, "assets");
    const saved = readdirSync(assetsDir).filter((f) => f.endsWith(".woff2"));
    // inline, latin, latin-ext and the cyrillic subset nothing used (a film's
    // words may need it); the HTML shell an unused face gets is not a font
    // and is not saved
    assert.equal(saved.length, 4, `font files saved: ${saved.join(", ")}`);
    for (const s of SUBSETS) {
      const bytes = readFileSync(font(s));
      assert.ok(
        saved.some((f) => readFileSync(join(assetsDir, f)).equals(bytes)),
        `${s} saved byte for byte`,
      );
    }
    const sheet = readdirSync(assetsDir)
      .filter((f) => f.endsWith(".css"))
      .map((f) => readFileSync(join(assetsDir, f), "utf8"))
      .find((c) => c.includes("Sub"))!;
    assert.equal((sheet.match(/url\("\.\.\/assets\/[0-9a-f]{40}\.woff2"\)/g) ?? []).length, 3);
    // the used shell face's answer came in the snapshot itself (as HTML, the
    // one font request Chrome's snapshot keeps); the unused one is cut off
    assert.match(sheet, /font-family: Shell; src: url\("\.\.\/assets\/[0-9a-f]{40}\.html"\)/);
    assert.match(sheet, /font-family: Ghost; src: url\("about:blank"\)/);
    assert.ok(!sheet.includes("127.0.0.1"), "nothing in the saved sheet reaches the network");
    // (Chrome writes the inline <style> out as a sheet of its own)
    const inline = readdirSync(assetsDir)
      .filter((f) => f.endsWith(".css"))
      .map((f) => readFileSync(join(assetsDir, f), "utf8"))
      .find((c) => c.includes("Inline"));
    assert.match(
      inline ?? "",
      /font-family: Inline; src: url\("?\.\.\/assets\/[0-9a-f]{40}\.woff2"?\)/,
    );

    // the app's server is gone; the saved state still draws in its fonts
    await new Promise<void>((r) => server!.close(() => r()));
    server = null;
    const reopened = new Promise<void>((r) => cdp.on("Page.loadEventFired", () => r()));
    await cdp.send("Page.navigate", {
      url: pathToFileURL(join(statesDir, "s0", "state.html")).href,
    });
    await reopened;
    const status = await evaluate<Record<string, boolean>>(
      `document.fonts.ready.then(() => ({ inline: document.fonts.check("28px Inline", "inline"), latin: document.fonts.check("28px Sub", "latin"), ext: document.fonts.check("28px Sub", "Ā") }))`,
    );
    const faces = await evaluate<string[]>(
      `Array.from(document.fonts).map(f => f.family + " " + f.status)`,
    );
    assert.ok(faces.includes("Inline loaded"), `inline face loaded offline: ${faces.join(", ")}`);
    assert.ok(
      faces.filter((f) => f === "Sub loaded").length >= 2,
      `the used subsets loaded offline: ${faces.join(", ")}`,
    );
    assert.ok(status.inline && status.latin && status.ext, JSON.stringify(status));
  } finally {
    await browser?.close();
    if (server) await new Promise<void>((r) => server!.close(() => r()));
    await rm(dir, { recursive: true, force: true });
  }
});
