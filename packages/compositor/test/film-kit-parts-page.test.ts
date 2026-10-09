// A part of product() (kit/media.js) in a page: lift, isolate, hold and
// screen().box take it as they take a ref — its element on the screen they
// are given, whichever screen it was named on — and coveredBy(t) says what
// the page draws over it. On the synthetic shoot of the parts tests. Chrome
// for Testing; skips without it.

import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { gatherComponents, readComponentSource, writeComponents } from "../src/film/components";
import { initFilm } from "../src/film/kit";
import { launchHtmlBrowser } from "../src/html/cdp";
import { serveDirectory } from "../src/html/server";
import { findChrome } from "./fixtures/find-chrome";
import { writePartsShoot } from "./fixtures/parts-shoot";

const chrome = findChrome();
const skip = chrome ? false : "no Chrome for Testing";

let dir = "";
before(async () => {
  dir = await mkdtemp(join(tmpdir(), "open-take-parts-page-test-"));
  writePartsShoot(dir);
  writeComponents(gatherComponents(readComponentSource(dir)), dir);
  await initFilm({ dir: join(dir, "film") });
});
after(async () => {
  await rm(dir, { recursive: true, force: true });
});

test("lift, isolate, hold and box take a part; coveredBy says what is drawn over it", {
  skip,
}, async () => {
  await writeFile(
    join(dir, "film", "parts.html"),
    `<!doctype html><html><head><meta charset="utf-8"><style>
html,body{margin:0;width:640px;height:360px;background:#fff}
.stage{position:absolute;left:0;top:0;width:640px;height:360px}
iframe{position:absolute;left:0;top:0;width:640px;height:360px;border:0}
#over{position:absolute;left:300px;top:200px;width:80px;height:20px;pointer-events:none}
</style></head><body>
<div class="stage" id="back"><iframe id="home" src="../states/home/state.html"></iframe></div>
<div class="stage" id="front"><iframe id="now" src="../states/add-2/state.html"></iframe></div>
<svg id="over" viewBox="0 0 80 20"><rect width="80" height="20" fill="#e33"/></svg>
<script type="module">
import { product, screen, lift, isolate, hold } from "./kit/media.js";
window.result = (async () => {
  const P = await product("../");
  P.play([[0, "add-2"]]);
  const heading = P.part("home:e2", { name: "title" });   // named on home
  const back = screen(document.getElementById("home"));
  const now = screen(document.getElementById("now"));
  await Promise.all([back.ready, now.ready]);
  const box = now.box(heading);                           // on add-2: moved down
  const homeBox = back.box(heading);
  const l = lift(now, heading, { around: "clear" });
  const fade = isolate(now, [heading]);
  await Promise.all([l.ready, fade.ready]);
  const h = hold([back, now], heading);
  const offsets = h.offsets;
  h.release();
  const count = P.part("t1");
  const covered = count.coveredBy(0);
  // the part's own lifted layer and the screen showing it are not "over" it
  const own = heading.coveredBy(0);
  document.getElementById("over").remove();
  const clear = count.coveredBy(0);
  // view() naming a wrapper around the screen: what is inside it shows it
  P.view({ el: [document.getElementById("front")] });
  const wrapped = count.coveredBy(0);
  let missing = "";
  try { await lift(now, P.part("home:e1")).ready; } catch (e) { missing = e.message; }
  return { box, homeBox, source: l.source, label: l.el.dataset.otLift, holes: fade.holes, offsets,
    covered, own, clear, wrapped, missing };
})();
</script></body></html>`,
  );
  const server = await serveDirectory(dir);
  const b = await launchHtmlBrowser({
    chromePath: chrome!,
    url: `${server.url}/film/parts.html`,
    width: 640,
    height: 360,
  });
  try {
    // biome-ignore lint/suspicious/noExplicitAny: the page's own report
    const r = await b.evaluate<any>("window.result");
    const at = { x: 40, y: 60, width: 200, height: 30 };
    assert.deepEqual(r.box, at, "add-2's own element, from its index");
    assert.deepEqual(r.homeBox, { ...at, y: 20 });
    assert.deepEqual(r.source, at, "lifted from the screen it was given");
    assert.equal(r.label, "add-2:e2");
    assert.deepEqual(r.holes, [at]);
    assert.deepEqual(
      r.offsets.map((o: { dy: number }) => Math.round(o.dy)),
      [0, -40],
    );
    // the svg over the number's top half, pointer-events none and all
    assert.deepEqual(r.covered, [{ what: "rect in #over", share: 0.5 }]);
    assert.deepEqual(r.own, []);
    assert.deepEqual(r.clear, []);
    assert.deepEqual(r.wrapped, []);
    assert.match(r.missing, /home:e1 is not on the saved screen "add-2" — it is on home/);
  } finally {
    await b.close();
    await server.close();
  }
});
