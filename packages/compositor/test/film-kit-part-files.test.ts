// partFiles() (kit/media.js) in a page: parts/index.json read with each
// part's URL and size, a part file shown in an iframe, and node() putting a
// part into the page itself — in a shadow root of its own, its font declared
// on the document and loaded, its picture from the saved files, the film's
// own CSS kept out. On the synthetic shoot of the parts tests. Chrome for
// Testing; skips without it.

import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { gatherComponents, readComponentSource, writeComponents } from "../src/film/components";
import { initFilm } from "../src/film/kit";
import { writePartFiles } from "../src/film/part-files";
import { launchHtmlBrowser } from "../src/html/cdp";
import { serveDirectory } from "../src/html/server";
import { findChrome } from "./fixtures/find-chrome";
import { writePartDom, writePartsShoot } from "./fixtures/parts-shoot";

const chrome = findChrome();
const skip = chrome ? false : "no Chrome for Testing";

let dir = "";
before(async () => {
  dir = await mkdtemp(join(tmpdir(), "open-take-kit-part-files-"));
  writePartsShoot(dir);
  writePartDom(dir);
  const source = readComponentSource(dir);
  const file = gatherComponents(source);
  writeComponents(file, dir);
  writePartFiles(file, source, join(dir, "parts"));
  await initFilm({ dir: join(dir, "film") });
});
after(async () => {
  await rm(dir, { recursive: true, force: true });
});

test("partFiles: the list, a file in an iframe, and node() into the page in the product's font", {
  skip,
}, async () => {
  await writeFile(
    join(dir, "film", "part-files.html"),
    `<!doctype html><html><head><meta charset="utf-8"><style>
html,body{margin:0;width:640px;height:360px;background:#fff}
h1{color:rgb(255, 0, 0)!important;font-size:99px!important}
iframe{border:0}
</style></head><body><iframe id="f"></iframe><div id="stage"></div>
<script type="module">
import { partFiles } from "./kit/media.js";
window.result = (async () => {
  const F = await partFiles("../parts/");
  const h = F.get("home:e2");
  const frame = document.getElementById("f");
  frame.width = h.w; frame.height = h.h;
  await new Promise((r) => { frame.onload = r; frame.src = h.url; });
  await frame.contentDocument.fonts.ready;
  const inFrame = frame.contentDocument.body.firstElementChild;
  const el = await F.node("home:e2");
  const n = await F.node("home-e4-number.html");
  await F.node("home:e2"); // again: its font is declared once
  document.getElementById("stage").append(el, n);
  await document.fonts.ready;
  const h1 = el.shadowRoot.querySelector("h1");
  const img = n.shadowRoot.querySelector("img");
  await new Promise((r) => (img.complete ? r() : (img.onload = img.onerror = r)));
  let missing = "", skipped = "";
  try { F.get("home:e9"); } catch (e) { missing = e.message; }
  try { F.get("home:e3"); } catch (e) { skipped = e.message; }
  return {
    refs: F.list.map((p) => p.ref), url: h.url, w: h.w, h: h.h,
    frameFamily: getComputedStyle(inFrame).fontFamily, frameSize: getComputedStyle(inFrame).fontSize,
    host: [el.offsetWidth, el.offsetHeight], size: getComputedStyle(h1).fontSize, color: getComputedStyle(h1).color,
    font: [...document.fonts].some((f) => f.family.replace(/"/g, "") === "Brand Sans" && f.status === "loaded"),
    fontStyles: document.querySelectorAll("style[data-part-fonts]").length,
    img: img.naturalWidth, imgSrc: img.getAttribute("src"),
    before: getComputedStyle(n.shadowRoot.querySelector("#n"), "::before").content,
    missing, skipped,
  };
})();
</script></body></html>`,
  );
  const server = await serveDirectory(dir);
  const b = await launchHtmlBrowser({
    chromePath: chrome!,
    url: `${server.url}/film/part-files.html`,
    width: 640,
    height: 360,
  });
  try {
    // biome-ignore lint/suspicious/noExplicitAny: the page's own report
    const r = await b.evaluate<any>("window.result");
    assert.deepEqual(r.refs, ["home:e2", "home:e4"]);
    assert.equal(r.url, `${server.url}/parts/home-e2-heading.html`);
    assert.deepEqual([r.w, r.h], [200, 30]);
    assert.match(r.frameFamily, /Brand Sans/);
    assert.equal(r.frameSize, "20px", "the file alone, in an iframe");
    assert.deepEqual(r.host, [200, 30], "the host is the part's natural size");
    assert.equal(r.size, "20px", "the film's own CSS does not reach into it");
    assert.notEqual(r.color, "rgb(255, 0, 0)");
    assert.equal(r.font, true, "its font, declared on the page and loaded from the saved file");
    assert.equal(r.fontStyles, 2, "each part's fonts once (the heading's, the number's)");
    assert.equal(r.img, 20, "its picture, from the saved files");
    assert.equal(r.imgSrc, `${server.url}/states/assets/pic.svg`);
    assert.equal(r.before, '"--> $"', "its ::before stays with it");
    assert.match(r.missing, /no part home:e9 — there are home:e2, home:e4/);
    assert.match(r.skipped, /home:e3 is not a file — it holds an <iframe>/);
  } finally {
    await b.close();
    await server.close();
  }
});
