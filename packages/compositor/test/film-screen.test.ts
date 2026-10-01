// Saved screens on a film's stage (film-kit's openScreen): a part lifted off
// the page lands where it was put and paints alone; the actions on the
// interface are a function of film time, the same in any order; review reads
// the text a lifted part shows; a part that flies gets motion blur. Browser
// tests skip without Chrome for Testing.

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { promisify } from "node:util";
import { resolveFfmpeg } from "../src/ffmpeg";
import { filmClockSource } from "../src/film/clock";
import { clampView, count, frame, travel, typing } from "../src/film/kit";
import { filmKitPath } from "../src/film/kit-file";
import { filmStills, renderFilm } from "../src/film/render";
import { filmReview } from "../src/film/review";
import { launchHtmlBrowser } from "../src/html/cdp";
import { serveDirectory } from "../src/html/server";
import { findChrome } from "./fixtures/find-chrome";

const exec = promisify(execFile);
const chrome = findChrome();
const skip = chrome ? false : "no Chrome for Testing";
let dir = "";
before(async () => {
  dir = await mkdtemp(join(tmpdir(), "open-take-screen-test-"));
});
after(async () => {
  await rm(dir, { recursive: true, force: true });
});

// --- pure ------------------------------------------------------------------------------

test("frame: a part with room around it, at the window's shape", () => {
  const v = frame({ x: 100, y: 50, width: 200, height: 100 }, 16 / 9, { pad: 0.1 });
  assert.deepEqual([v.cx, v.cy], [200, 100]);
  // 240 × 120 with its padding: wider than 16:9, so its width sets the view's
  assert.ok(Math.abs(v.w - 240) < 1e-9);
  // a square part: its height sets it, 120 × 16/9
  const sq = frame({ x: 0, y: 0, width: 100, height: 100 }, 16 / 9, { pad: 0.1 });
  assert.ok(Math.abs(sq.w - (120 * 16) / 9) < 1e-9);
  // a long list framed by its width: the window filled with it, its top at the top
  const list = frame({ x: 100, y: 200, width: 400, height: 1500 }, 16 / 9, {
    pad: 0,
    fit: "width",
  });
  assert.equal(list.w, 400);
  assert.equal(list.cx, 300);
  assert.ok(Math.abs(list.cy - (200 + 400 / (16 / 9) / 2)) < 1e-9, "read from its top");
});

test("travel: what is framed heads for its place without swinging back", () => {
  // from the whole page to a small part near its corner: the part's centre on
  // screen moves one way only, whatever the zoom
  const page = { cx: 960, cy: 540, w: 1920 };
  const part = { cx: 1700, cy: 120, w: 300 };
  const onScreen = (v: { cx: number; cy: number; w: number }) => ({
    x: (part.cx - v.cx) * (1920 / v.w),
    y: (part.cy - v.cy) * (1920 / v.w),
  });
  let last = onScreen(page);
  for (let i = 1; i <= 100; i++) {
    const now = onScreen(travel(i / 100, page, part));
    assert.ok(Math.abs(now.x) <= Math.abs(last.x) + 1e-9, `x heads home at ${i}`);
    assert.ok(Math.abs(now.y) <= Math.abs(last.y) + 1e-9, `y heads home at ${i}`);
    last = now;
  }
  assert.deepEqual(travel(1, page, part), part);
  // a spring past the end never collapses the view
  assert.ok(travel(3, page, part).w >= 150);
});

test("clampView: no blank past the page's edges; centred where the view is larger", () => {
  const page = { width: 1000, height: 600 };
  assert.deepEqual(clampView({ cx: 0, cy: 0, w: 400 }, page, 2), { cx: 200, cy: 100, w: 400 });
  assert.deepEqual(clampView({ cx: 990, cy: 590, w: 400 }, page, 2), { cx: 800, cy: 500, w: 400 });
  assert.deepEqual(clampView({ cx: 10, cy: 10, w: 1600 }, page, 2), { cx: 500, cy: 300, w: 1600 });
});

test("typing: a person's pace, the same every time, shared by picture and sound", () => {
  const k = typing("World Gym", { at: 2 });
  assert.equal(k.times[0], 2, "the first key lands at `at`");
  assert.deepEqual(typing("World Gym", { at: 2 }).times, k.times, "the same every time");
  for (let i = 1; i < k.times.length; i++) assert.ok(k.times[i]! > k.times[i - 1]!);
  assert.equal(k.count(1.9), 0);
  assert.equal(k.text(k.end), "World Gym");
  assert.equal(k.text(k.times[3]!), "Worl");
  // intervals are uneven (a person), around the recorder's pace for 9 characters
  const gaps = k.times.slice(1).map((t, i) => t - k.times[i]!);
  assert.ok(new Set(gaps.map((g) => g.toFixed(4))).size > 3);
  const mean = gaps.reduce((a, b) => a + b, 0) / gaps.length;
  assert.ok(mean > 0.07 && mean < 0.16, `mean gap ${mean}`);
  // CJK reads slower; an emoji with a skin tone is one character
  const cjk = typing("找健身房", { at: 0, jitter: 0 });
  assert.ok(cjk.times[1]! - cjk.times[0]! > 0.09);
  assert.equal(typing("ok 👍🏽", { at: 0 }).chars.length, 4);
  assert.ok(Math.abs(typing("abcd", { at: 0, cps: 10, jitter: 0 }).times[1]! - 0.1) < 1e-9);
});

// --- in the browser -----------------------------------------------------------------------

/** a saved screen as `open-take make --states` writes it, reduced to what the
 *  film side relies on: ids on the parts, the restore script marking it ready,
 *  and index.json beside it with the captured viewport */
async function savedScreen(root: string): Promise<void> {
  const at = join(root, "state");
  await mkdir(at, { recursive: true });
  await writeFile(
    join(at, "state.html"),
    `<!doctype html><html><head><style>
body{margin:0;background:#e8e2d0;font:16px sans-serif}
header{height:40px;background:#123e35;color:#fff}
#q{position:absolute;left:40px;top:60px;width:300px;height:32px;font:16px sans-serif;padding:0 8px;border:1px solid #888}
#go{position:absolute;left:360px;top:60px;width:80px;height:34px;transform:translateX(10px)}
#card{position:absolute;left:200px;top:120px;width:240px;height:140px;background:#d8edad;border-radius:12px}
#card .price{position:absolute;left:16px;top:16px;font-size:28px;color:#123e35}
.secret{visibility:hidden}
#menu{position:absolute;left:40px;top:300px;width:100px;height:30px}
#menu[aria-expanded="true"]{background:#ff0000}
</style></head><body>
<header data-ot-id="e1">Header text</header>
<input id="q" data-ot-id="e3" value="">
<button id="go" data-ot-id="e4">Go</button>
<div id="card" data-ot-id="e2"><span class="price">NT$1,188</span><span class="secret">hidden words</span></div>
<div id="menu" data-ot-id="e5" aria-expanded="false">Menu</div>
<script type="application/x-open-take-inert"></script>
<script data-ot-restore>document.fonts.ready.then(function(){document.documentElement.setAttribute("data-ot-ready","1")})</script>
</body></html>`,
  );
  await writeFile(
    join(at, "index.json"),
    JSON.stringify({
      version: 1,
      id: "s1",
      viewport: { w: 640, h: 360, dpr: 1 },
      // where each part was when it was captured: the card where the saved
      // page has it, the menu somewhere else (a saved page that does not
      // reproduce it)
      elements: [
        { id: "e2", box: [200, 120, 240, 140] },
        { id: "e5", box: [400, 20, 100, 30] },
      ],
    }),
  );
}

async function filmPage(name: string, body: string): Promise<string> {
  const page = join(dir, name);
  await savedScreen(page);
  await copyFile(filmKitPath(), join(page, "film-kit.js"));
  await writeFile(
    join(page, "index.html"),
    `<!doctype html><html><head><style>body{margin:0;width:640px;height:360px;background:#000;position:relative;overflow:hidden}</style></head><body>
<script type="module">
${body}
</script></body></html>`,
  );
  return page;
}

const ACTS = `import { openScreen, count } from "./film-kit.js";
let page, card;
window.__film = { duration: 4, width: 640, height: 360, ready: (async () => {
  page = await openScreen("state/state.html");
  card = await openScreen("state/state.html", { show: ["e2"] });
  window.S = { page, card };
})() };
window.__render = (t) => {
  page.window({ x: 0, y: 0, width: 320, height: 180 }).view({ cx: 320, cy: 180, w: 640 });
  card.place({ box: { x: 400, y: 200, width: 120, height: 70 } });
  page.type(t, "e3", "World Gym", { at: 1 });
  page.press(t, "e4", { at: 2, dur: 0.4 });
  page.set(t, "e5", { at: 2.5, attr: { "aria-expanded": "true" } });
  page.set(t, ".price", { at: 3, text: count(t, { at: 3, dur: 0.5, from: 1188, to: 300 }) });
};`;

test("a lifted part paints alone, where it was put; the page shows through its window", {
  skip,
}, async () => {
  const page = await filmPage("lift", ACTS);
  const [still] = await filmStills({
    page,
    chromePath: chrome!,
    at: [0],
    outDir: join(dir, "lift-stills"),
    blur: false,
  });
  const rgb = (
    await exec(
      await resolveFfmpeg(),
      ["-v", "error", "-i", still!, "-f", "rawvideo", "-pix_fmt", "rgb24", "-"],
      { encoding: "buffer", maxBuffer: 1 << 24 },
    )
  ).stdout as Buffer;
  const at = (x: number, y: number) =>
    Array.from(rgb.subarray((y * 640 + x) * 3, (y * 640 + x) * 3 + 3));
  const near = (a: number[], b: number[]) => a.every((v, i) => Math.abs(v - b[i]!) <= 6);
  // the card (240 × 140 on the saved page) fits 120 × 70 at (400, 200)
  assert.ok(near(at(470, 255), [216, 237, 173]), `the card inside its box: ${at(470, 255)}`);
  // around it, inside the lifted screen's frame, the film's own black: the
  // saved page's background does not paint
  assert.ok(near(at(320, 150), [0, 0, 0]), `around the part, the film: ${at(320, 150)}`);
  assert.ok(near(at(560, 300), [0, 0, 0]), `below it too: ${at(560, 300)}`);
  // the whole page, half size, in the 320 × 180 window: its header at the top
  assert.ok(near(at(200, 5), [18, 62, 53]), `the page's header in the window: ${at(200, 5)}`);
  assert.ok(near(at(300, 150), [232, 226, 208]), `the page's background: ${at(300, 150)}`);
});

test("acting on a saved screen: typed, pressed, switched — the same frame in any order", {
  skip,
}, async () => {
  const page = await filmPage("acts", ACTS);
  const server = await serveDirectory(page);
  const open = () =>
    launchHtmlBrowser({
      chromePath: chrome!,
      url: `${server.url}/index.html`,
      width: 640,
      height: 360,
      initScript: filmClockSource({ seed: 7, epochMs: 0 }),
    });
  const a = await open();
  const b = await open();
  const state = async (x: Awaited<ReturnType<typeof open>>, t: number) => {
    await x.evaluate(`window.__ot.seek(${t})`);
    return x.evaluate<{
      value: string;
      caret: string;
      scale: string;
      transform: string;
      menu: string | null;
      price: string;
    }>(`(() => {
      const d = S.page.doc;
      const caret = d.querySelector("[data-ot-caret]");
      return {
        value: d.getElementById("q").value,
        caret: caret ? getComputedStyle(caret).display : "none",
        scale: d.getElementById("go").style.scale,
        transform: getComputedStyle(d.getElementById("go")).transform,
        menu: d.getElementById("menu").getAttribute("aria-expanded"),
        price: d.querySelector("#card .price").textContent,
      };
    })()`);
  };
  try {
    await a.evaluate("window.__ot.prepare()");
    await b.evaluate("window.__ot.prepare()");
    const k = typing("World Gym", { at: 1 });
    const s05 = await state(a, 0.5);
    assert.equal(s05.value, "");
    assert.equal(s05.caret, "none", "no caret before typing");
    const s15 = await state(a, 1.5);
    assert.equal(s15.value, k.text(1.5), "typed so far, at the shared pace");
    assert.ok(s15.value.length > 0 && s15.value.length < 9);
    assert.equal(s15.caret, "block", "a caret while typing");
    const s22 = await state(a, 2.2);
    assert.equal(s22.value, "World Gym");
    const f = Number(s22.scale.split(" ")[0]);
    assert.ok(f < 1 && f > 0.9, `pressed: ${s22.scale}`);
    assert.equal(s22.transform, "matrix(1, 0, 0, 1, 10, 0)", "its own transform stays");
    assert.equal(s22.menu, "false");
    const s325 = await state(a, 3.25);
    assert.equal(s325.menu, "true", "the product's own state, switched");
    assert.equal(s325.price, count(3.25, { at: 3, dur: 0.5, from: 1188, to: 300 }));
    assert.equal(s325.scale, "", "the press is over");
    // back and forth, and in a browser that only ever drew this instant
    assert.deepEqual(await state(a, 0.5), s05, "going back puts the saved page back");
    assert.deepEqual(await state(a, 3.25), s325);
    assert.deepEqual(await state(b, 3.25), s325);
    assert.deepEqual(await state(b, 1.5), s15);
    // the lifted part's own text stays as the product hid it
    const vis = await a.evaluate<string[]>(
      `[S.card.$("e1"), S.card.$(".price"), S.card.$(".secret")].map((e) => getComputedStyle(e).visibility)`,
    );
    assert.deepEqual(vis, ["hidden", "visible", "hidden"]);
    // a framing is never wider than the page: a part too tall for the window
    // at the page's width is framed at that width
    const tall = await a.evaluate<number>(
      "S.page.frameOf({ getBoundingClientRect: () => ({ left: 0, top: 0, right: 100, bottom: 2000, width: 100, height: 2000 }) }).w",
    );
    assert.equal(tall, 640);
    // where the part is on the stage, as place() put it
    const box = await a.evaluate<number[]>(
      "(() => { const b = S.card.stageBox(); return [b.x, b.y, b.width, b.height]; })()",
    );
    assert.deepEqual(
      box.map((v) => Math.round(v)),
      [400, 200, 120, 70],
    );
  } finally {
    await Promise.all([a.close(), b.close()]);
    await server.close();
  }
});

test("review reads the text a lifted part shows, not the text it hides", { skip }, async () => {
  const page = await filmPage(
    "lift-review",
    `import { openScreen } from "./film-kit.js";
let card;
window.__film = { duration: 1, width: 640, height: 360, ready: (async () => {
  card = await openScreen("state/state.html", { show: ["e2"] });
  const cap = document.createElement("div");
  cap.id = "cap";
  cap.textContent = "Every gym, one place";
  Object.assign(cap.style, { position: "absolute", left: "40px", top: "60px", font: "40px sans-serif", color: "#fff" });
  document.body.append(cap);
})() };
window.__render = () => {
  // the card at (40, 40), full size: its price runs under the caption
  card.place({ x: 40, y: 40, anchor: [0, 0] });
};`,
  );
  const film = join(dir, "lift-review.mp4");
  await renderFilm({ page, out: film, chromePath: chrome!, workers: 1, draft: true });
  const r = await filmReview({ film, page, chromePath: chrome!, out: join(dir, "lift-review") });
  const found = (r.layout ?? []).map((l) => `${l.kind} ${l.a} × ${l.b ?? ""}`);
  assert.ok(
    found.some((f) => /text-over-text/.test(f) && /#cap/.test(f) && /NT\$1,188/.test(f)),
    `the caption over the lifted price: ${found.join(" | ")}`,
  );
  assert.ok(
    !found.some((f) => /Header text|hidden words/.test(f)),
    `nothing about text the screen hides: ${found.join(" | ")}`,
  );
});

test("a lifted part that flies is blurred like anything else that moves", { skip }, async () => {
  const page = await filmPage(
    "lift-blur",
    `import { openScreen } from "./film-kit.js";
let card;
window.__film = { duration: 0.5, width: 640, height: 360, ready: (async () => {
  card = await openScreen("state/state.html", { show: ["e2"] });
})() };
window.__render = (t) => {
  // 480 px in half a second
  card.place({ x: 60 + 960 * t, y: 180, scale: 0.5 });
};`,
  );
  const r = await renderFilm({
    page,
    out: join(dir, "lift-blur.mp4"),
    chromePath: chrome!,
    workers: 1,
  });
  assert.equal(r.mode, "render");
  assert.ok(
    r.samples >= r.frames * 2,
    `the flying part got blur samples (${r.samples} for ${r.frames})`,
  );
});

test("lifting a part the saved page does not show as captured says so", { skip }, async () => {
  const page = await filmPage(
    "lift-warn",
    `import { openScreen } from "./film-kit.js";
window.__film = { duration: 1, width: 640, height: 360, ready: (async () => {
  await openScreen("state/state.html", { show: ["e2"] });
  await openScreen("state/state.html", { show: ["e5"] });
})() };
window.__render = () => {};`,
  );
  const said: string[] = [];
  await filmStills({
    page,
    chromePath: chrome!,
    at: [0],
    outDir: join(dir, "lift-warn-stills"),
    onConsole: (level, text) => {
      if (level === "warning") said.push(text);
    },
  });
  // (stills may open the page more than once: the same words each time)
  const distinct = [...new Set(said)];
  assert.equal(distinct.length, 1, distinct.join(" | "));
  assert.match(distinct[0]!, /e5 is not where it was captured/);
  assert.match(distinct[0]!, /\[400, 20, 100, 30\] then, \[40, 300, 100, 30\]/);
});
