// hold() (kit/media.js): one part of the product kept in place while its
// saved screens are swapped in turn — the part moved in each screen to where
// it sits in the one kept, the rest of each screen as the product laid it
// out, a click's point moved with it. Chrome for Testing; skips without it.

import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { initFilm } from "../src/film/kit";
import { launchHtmlBrowser } from "../src/html/cdp";
import { serveDirectory } from "../src/html/server";
import { findChrome } from "./fixtures/find-chrome";

const chrome = findChrome();
const skip = chrome ? false : "no Chrome for Testing";

let dir = "";
before(async () => {
  dir = await mkdtemp(join(tmpdir(), "open-take-hold-test-"));
});
after(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** a wizard step: `rows` chosen rows above the card push it down */
const step = (rows: number) => `<!doctype html><html><head><meta charset="utf-8"><style>
html,body{margin:0;width:640px;height:360px;background:#fff;font:14px sans-serif}
.row{height:32px;margin:0 40px}#title{margin:20px 40px;height:30px}
.card{margin:10px 40px;width:300px;height:120px;background:#eee}
</style></head><body><h1 id="title">Pick a city</h1>${"<div class=row>a city</div>".repeat(rows)}
<div class="card"><p>從你的生活圈開始</p><p>不用登入</p></div></body></html>`;

test("hold keeps a part in place across screens, and moves points with it", { skip }, async () => {
  for (let i = 0; i < 3; i++) {
    await mkdir(join(dir, "states", `s${i}`), { recursive: true });
    await writeFile(join(dir, "states", `s${i}`, "state.html"), step([0, 1, 3][i]!));
  }
  const film = join(dir, "film");
  await initFilm({ dir: film, starter: false });
  await writeFile(
    join(film, "hold.html"),
    `<!doctype html><html><head><meta charset="utf-8"><style>
iframe{position:absolute;left:0;top:0;width:640px;height:360px;border:0}
</style></head><body>
${[0, 1, 2].map((i) => `<iframe id="f${i}" src="../states/s${i}/state.html"></iframe>`).join("")}
<script type="module">
import { screen, hold } from "./kit/media.js";
const screens = [0, 1, 2].map((i) => screen(document.getElementById("f" + i)));
window.result = (async () => {
  await Promise.all(screens.map((s) => s.ready));
  const cardTop = (i) => screens[i].frame.contentDocument.querySelector(".card").getBoundingClientRect().top;
  const titleTop = (i) => screens[i].frame.contentDocument.querySelector("#title").getBoundingClientRect().top;
  const before = [0, 1, 2].map(cardTop);
  const h = hold(screens, { text: "從你的生活圈開始", up: 1 });
  const held = [0, 1, 2].map(cardTop);
  const titles = [0, 1, 2].map(titleTop);
  const point = h.point(2, { x: 50, y: 300, extra: 1 });
  const onlyX = hold(screens, ".card", { axis: "x", to: 1 });
  const xOffsets = onlyX.offsets;
  h.release();
  const released = [0, 1, 2].map(cardTop);
  let missing = "";
  try { hold(screens, "#nope"); } catch (e) { missing = e.message; }
  return { before, held, titles, offsets: h.offsets, point, xOffsets, released, missing };
})();
</script></body></html>`,
  );
  const server = await serveDirectory(dir);
  const b = await launchHtmlBrowser({
    chromePath: chrome!,
    url: `${server.url}/film/hold.html`,
    width: 640,
    height: 360,
  });
  try {
    // biome-ignore lint/suspicious/noExplicitAny: the page's own report
    const r = await b.evaluate<any>("window.result");
    assert.ok(
      r.before[1] > r.before[0] && r.before[2] > r.before[1],
      "the product moves the card down",
    );
    for (const t of r.held) assert.ok(Math.abs(t - r.held[0]) < 0.01, `held: ${r.held}`);
    assert.ok(
      r.titles.every((t: number) => t === r.titles[0]),
      "the rest of each screen stays",
    );
    assert.deepEqual(
      r.offsets.map((o: { dy: number }) => Math.round(o.dy)),
      [0, Math.round(r.before[0] - r.before[1]), Math.round(r.before[0] - r.before[2])],
    );
    assert.equal(Math.round(r.point.y), Math.round(300 + r.before[0] - r.before[2]));
    assert.equal(r.point.extra, 1, "the point's other fields kept");
    assert.ok(
      r.xOffsets.every((o: { dy: number }) => o.dy === 0),
      "axis x moves no part up or down",
    );
    assert.deepEqual(r.released, r.before, "release puts every screen back");
    assert.match(r.missing, /^hold: nothing matches #nope/);
  } finally {
    await b.close();
    await server.close();
  }
});
