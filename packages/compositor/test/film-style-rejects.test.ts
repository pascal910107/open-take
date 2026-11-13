// An inline style the page sets that the browser ignores (`scale(NaN)`,
// `scale([object Object])`) is named by render and still — the element, the
// property, the value and the film time — once per element and property, and
// what the page draws does not change. Chrome for Testing; skips without it.

import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { filmStills, renderFilm, styleWarnings } from "../src/film/render";
import { findChrome } from "./fixtures/find-chrome";

const chrome = findChrome();
const skip = chrome ? false : "no Chrome for Testing";

let dir = "";
before(async () => {
  dir = await mkdtemp(join(tmpdir(), "open-take-style-rejects-"));
});
after(async () => {
  await rm(dir, { recursive: true, force: true });
});

// a card scaled from a lerp that lost an argument after 0.5 s, a pin given
// an object for its scale, a custom property given NaN, and the same valid
// values set again every frame (which must not be named)
const PAGE = `<!doctype html><html><head><meta charset="utf-8"><style>
body{margin:0;background:#fff;width:640px;height:360px;overflow:hidden}
#card{position:absolute;left:40px;top:40px;width:80px;height:80px;background:#d22}
.pin{position:absolute;left:200px;top:60px;width:40px;height:40px;background:#22d}
</style></head><body><div id="card"></div><div class="scene"><div class="pin"></div></div>
<script>
const lerp = (a, b, p) => a + (b - a) * p;
const stamp = (t) => ({ scale: 1 + t, opacity: 1 });
const card = document.getElementById("card");
const pin = document.querySelector(".pin");
window.__film = { duration: 1, width: 640, height: 360 };
window.__render = (t) => {
  const x = t < 0.5 ? lerp(1, 2, t) : lerp(1, 2);
  card.style.transform = \`scale(\${x})\`;
  card.style.opacity = 1;
  pin.style.transform = \`scale(\${stamp(t)})\`;
  pin.style.setProperty("--k", String(t < 0.5 ? 1 : NaN));
  pin.style.setProperty("left", "200px");
};
</script></body></html>`;

test("an inline style the browser ignores is named once, with its element, value and time", {
  skip,
}, async () => {
  const page = join(dir, "page");
  await mkdir(page, { recursive: true });
  await writeFile(join(page, "index.html"), PAGE);
  const r = await renderFilm({
    page,
    out: join(dir, "film.mp4"),
    chromePath: chrome!,
    audio: null,
    workers: 2,
    draft: true,
  });
  const style = r.warnings.filter((w) => w.startsWith("the page set "));
  const card = style.filter((w) => w.includes("#card"));
  assert.equal(card.length, 1, `one warning for the card's transform: ${style.join("\n")}`);
  assert.match(
    card[0]!,
    /transform on div#card to "scale\(NaN\)" at 0\.5\d*s and the browser ignored it/,
  );
  // what the card kept: its last good scale, or — where a worker's page met
  // the bad value first, before it set any — none
  assert.match(card[0]!, /kept ("scale\(1\.4\d*\)"|no transform of its own)/);
  const pin = style.filter((w) => w.includes("div.pin"));
  assert.ok(
    pin.some((w) =>
      /transform on div\.scene:nth-of-type\(2\) > div\.pin to "scale\(\[object Object\]\)" at 0\.000s/.test(
        w,
      ),
    ),
    pin.join("\n"),
  );
  assert.ok(
    pin.some((w) =>
      /--k on div\.scene:nth-of-type\(2\) > div\.pin to "NaN" at 0\.5\d*s: a custom property/.test(
        w,
      ),
    ),
    pin.join("\n"),
  );
  assert.ok(!style.some((w) => /opacity|left/.test(w)), "valid values set again are not named");
  assert.equal(style.length, 3, style.join("\n"));
  // the events file and the film are written as ever
  assert.ok((await readFile(r.events, "utf8")).length > 0);
});

test("a still names an ignored inline style through onWarning", { skip }, async () => {
  const page = join(dir, "page-still");
  await mkdir(page, { recursive: true });
  await writeFile(join(page, "index.html"), PAGE);
  const warned: string[] = [];
  await filmStills({
    page,
    chromePath: chrome!,
    at: [0.75],
    outDir: join(dir, "stills"),
    blur: false,
    onWarning: (w) => warned.push(w),
  });
  assert.ok(
    warned.some((w) => /transform on div#card to "scale\(NaN\)" at 0\.750s/.test(w)),
    warned.join("\n"),
  );
});

test("a page whose styles all take is not named, and its own calls on style work as before", {
  skip,
}, async () => {
  const page = join(dir, "page-ok");
  await mkdir(page, { recursive: true });
  await writeFile(
    join(page, "index.html"),
    `<!doctype html><html><head><style>body{margin:0;background:#000;width:200px;height:100px}
#b{position:absolute;left:0;top:0;width:20px;height:100px;background:#fff}</style></head>
<body><div id="b"></div><script>
window.__film = { duration: 1, width: 200, height: 100 };
const b = document.getElementById("b");
window.__render = (t) => {
  b.style.transform = "translateX(" + t * 100 + "px)";
  b.style.webkitTransform = "translateX(" + t * 100 + "px)";
  b.style.cssFloat = "left";
  b.style.setProperty("background-color", "#fff", "important");
  b.style.opacity = "";
  b.style.width = null;
  // the prototype's methods called on an element's style, as some libraries do
  CSSStyleDeclaration.prototype.setProperty.call(b.style, "height", "100px");
  if (CSSStyleDeclaration.prototype.getPropertyValue.call(b.style, "height") !== "100px")
    throw new Error("height not read back");
  if (!(b.style instanceof CSSStyleDeclaration) || b.style !== b.style)
    throw new Error("style is not itself");
  Object.assign(b.style, { borderTopWidth: "0px" });
};
</script></body></html>`,
  );
  const warned: string[] = [];
  const files = await filmStills({
    page,
    chromePath: chrome!,
    at: [0.5],
    outDir: join(dir, "stills-ok"),
    blur: false,
    onWarning: (w) => warned.push(w),
  });
  assert.deepEqual(warned, []);
  assert.equal(files.length, 1);
});

test("style warnings: in time order, a value cut short, the rest counted", () => {
  const many = Array.from({ length: 14 }, (_, i) => ({
    el: `div#e${i}`,
    prop: "transform",
    value: i === 0 ? `scale(${"9".repeat(200)})` : "scale(NaN)",
    kept: "",
    how: "ignored" as const,
    t: 14 - i,
  }));
  const w = styleWarnings(many);
  assert.equal(w.length, 13);
  assert.match(w[0]!, /div#e13 .* at 1\.000s .* kept no transform of its own/);
  assert.match(w.at(-1)!, /^2 more inline style/);
  const long = styleWarnings([{ ...many[0]!, t: null }])[0]!;
  assert.match(long, /…" before the film starts/);
});
