// The whole page's material against real Chrome: a served product page with
// an srcset image in the first screen, an illustration (inline svg) and a
// tagline two screens down, a tracking pixel, a marquee's aria-hidden
// repeat. A shoot that keeps a saved screen of it must list all of them in
// page order — the illustration and the tagline below the first screen
// too — save the largest source and the svg, draw the page as a sheet, and
// print a few lines naming them; a screen saved without the list is read
// from its state.html. Skips without Chrome for Testing.

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { crc32, deflateSync } from "node:zlib";
import { imageFileSize, type MaterialsFile, materialsSummary } from "@open-take/compositor";
import { resolveChrome } from "../src/cdp";
import { inventoryMaterials } from "../src/materials";
import { runShoot, shootHome } from "../src/shoot";

const chrome = process.env.OPEN_TAKE_E2E_CHROME ?? resolveChrome();
const skip = chrome ? false : "no Chrome for Testing";

/** a solid-colour PNG of w×h */
function png(w: number, h: number, rgb: [number, number, number]): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, "latin1"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(td) >>> 0);
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const row = Buffer.alloc(1 + w * 3);
  for (let x = 0; x < w; x++) row.set(rgb, 1 + x * 3);
  const raw = Buffer.concat(Array.from({ length: h }, () => row));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>Plantly — water on time</title>
<meta name="description" content="Reminders for every plant on your sill.">
<meta property="og:image" content="/img/share.png">
<style>
*{box-sizing:border-box} body{margin:0;font:16px Arial,sans-serif;color:#222}
nav{height:60px;display:flex;gap:20px;align-items:center;padding:0 40px}
.hero{height:100vh;padding:40px}
.hero h1{font-size:56px;margin:0 0 20px}
.hero img{width:400px;height:250px;display:block}
.spacer{height:900px}
.art{width:400px;height:300px;display:block;margin:0 40px}
.tagline{font-size:40px;margin:40px}
.reveal{opacity:0}
.marquee{font-size:28px} .marquee span{display:inline-block;padding:0 20px}
</style></head><body>
<nav><a href="/">Plantly</a><a href="/pricing">Pricing</a><a href="/login">Log in</a></nav>
<section class="hero">
  <h1>Water every plant on time</h1>
  <p>Plantly reminds you when each plant on your sill is thirsty, and how much to give it.</p>
  <img alt="The reminder list" src="/img/list-400.png" srcset="/img/list-400.png 400w, /img/list-1600.png 1600w" sizes="400px">
  <img alt="" src="/img/pixel.png" style="width:1px;height:1px">
</section>
<div class="spacer"></div>
<svg class="art" viewBox="0 0 400 300"><title>A watering can over three pots</title>
  <rect x="40" y="200" width="80" height="80" fill="#c86"/><rect x="160" y="200" width="80" height="80" fill="#c86"/>
  <rect x="280" y="200" width="80" height="80" fill="#c86"/><circle cx="200" cy="90" r="60" fill="#6a8"/></svg>
<p class="tagline reveal">Your sill, never thirsty again</p>
<div class="marquee"><span>Ferns</span><span>Cacti</span><span aria-hidden="true">Ferns</span></div>
<div style="height:400px"></div>
</body></html>`;

async function serve(): Promise<{ server: Server; url: string }> {
  const files: Record<string, [string, Buffer]> = {
    "/": ["text/html", Buffer.from(PAGE)],
    "/img/list-400.png": ["image/png", png(400, 250, [40, 120, 200])],
    "/img/list-1600.png": ["image/png", png(1600, 1000, [40, 120, 200])],
    "/img/pixel.png": ["image/png", png(1, 1, [0, 0, 0])],
    "/img/share.png": ["image/png", png(1200, 630, [200, 80, 40])],
  };
  const server = createServer((req, res) => {
    const f = files[req.url ?? "/"];
    if (!f) return res.writeHead(404).end();
    res.writeHead(200, { "content-type": f[0] }).end(f[1]);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  return { server, url: `http://127.0.0.1:${port}` };
}

const VW = 1280;
const VH = 720;

function checkList(f: MaterialsFile, stateDir: string, read: "live" | "saved screen") {
  assert.equal(f.read, read);
  assert.equal(f.viewport.h, VH);
  assert.ok(f.page.h > VH * 2.5, `the whole page (${f.page.h} px), not one screen`);
  // page order
  for (let i = 1; i < f.images.length; i++)
    assert.ok(f.images[i]!.box[1] >= f.images[i - 1]!.box[1]);
  for (let i = 1; i < f.copy.length; i++) assert.ok(f.copy[i]!.box[1] >= f.copy[i - 1]!.box[1]);

  const list = f.images.find((i) => i.alt === "The reminder list");
  assert.ok(list, "the srcset image");
  assert.equal(list.kind, "img");
  assert.equal(list.firstScreen, true);
  const art = f.images.find((i) => i.kind === "svg");
  assert.ok(art, "the illustration below the first screen");
  assert.equal(art.name, "A watering can over three pots");
  assert.equal(art.firstScreen, false);
  assert.ok(art.box[1] > VH * 1.5, `page y ${art.box[1]}`);
  assert.ok(art.file && /\.svg$/.test(art.file), "its markup saved");
  const svg = readFileSync(join(stateDir, art.file), "utf8");
  assert.ok(/^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/.test(svg) && /<circle/.test(svg));
  assert.ok(!f.images.some((i) => i.alt === "" && i.box[2] <= 1), "the 1×1 pixel is not listed");
  assert.ok(f.skipped.small >= 1, "…it is counted");

  const tag = f.copy.find((t) => t.text === "Your sill, never thirsty again");
  assert.ok(tag, "the tagline below the first screen");
  assert.equal(tag.firstScreen, false);
  assert.equal(tag.hidden, "opacity 0", "a reveal not yet run is listed, and says so");
  assert.ok(tag.fontPx === 40);
  const h1 = f.copy.find((t) => t.tag === "h1");
  assert.ok(h1 && h1.level === 1 && h1.firstScreen && h1.text === "Water every plant on time");
  assert.ok(f.copy.some((t) => t.tag === "p" && /thirsty, and how much/.test(t.text)));
  assert.ok(!f.copy.some((t) => /^(Pricing|Log in)$/.test(t.text)), "nav links are not copy");
  assert.ok(f.skipped.ariaHidden >= 1, "the marquee's repeat is counted, not listed");
  assert.equal(f.meta.description, "Reminders for every plant on your sill.");
  return { list, art, tag };
}

test("shoot: the whole page's material — images with their largest source, the copy below the first screen, a sheet — and a few lines naming them", {
  skip,
  timeout: 180_000,
}, async () => {
  const { server, url } = await serve();
  const out = await mkdtemp(join(tmpdir(), "ot-materials-"));
  try {
    const r = await runShoot({
      script: async (s) => {
        await s.open(`${url}/`);
        await s.still("home");
        await s.still("again"); // the same page: read once
      },
      outDir: out,
      width: VW,
      height: VH,
      scale: 1,
      chromePath: chrome!,
      components: false,
      onNote: () => {},
    });
    assert.equal(r.materials?.length, 1, "one list per page");
    const page = r.materials![0]!;
    assert.equal(page.id, "home");
    assert.equal(page.path, join(out, "states", "home", "materials.json"));
    assert.ok(!existsSync(join(out, "states", "again", "materials.json")));
    const f = JSON.parse(readFileSync(page.path, "utf8")) as MaterialsFile;
    const { list } = checkList(f, page.dir, "live");
    // the largest source, fetched and saved
    assert.equal(list.src, `${url}/img/list-1600.png`);
    assert.equal(list.srcW, 1600);
    assert.equal(list.sources, 3);
    assert.equal(list.shown, `${url}/img/list-400.png`);
    assert.deepEqual(list.fileSize, [1600, 1000]);
    assert.ok(list.file && existsSync(join(page.dir, list.file)));
    assert.ok(f.meta.ogImageFile && existsSync(join(page.dir, f.meta.ogImageFile)));
    // the sheet: the page top to bottom
    assert.ok(f.sheet, "a sheet");
    const sheet = readFileSync(join(page.dir, f.sheet.file));
    assert.equal(f.sheet.coveredPx, f.page.h);
    assert.equal(f.sheet.columns * f.sheet.columnPx >= f.page.h, true);
    if (/\.png$/.test(f.sheet.file)) assert.ok(imageFileSize(sheet));
    else assert.ok(sheet[0] === 0xff && sheet[1] === 0xd8, "a JPEG");

    const lines = materialsSummary(r.materials!, { show: (p) => p, cmd: "open-take materials x" });
    assert.ok(lines.length <= 12, lines.join("\n"));
    const text = lines.join("\n");
    assert.match(text, /"The reminder list"/);
    assert.match(text, /svg .*"A watering can over three pots"/);
    assert.match(text, /"Your sill, never thirsty again"/);
    assert.match(text, /open-take materials x/);
    assert.match(text, /sheet\.(jpg|png)/);
    assert.doesNotMatch(text, /\b(best|recommend|should|score)\b/i);

    // a screen saved without the list is read from its state.html
    await rm(page.path);
    const inv = await inventoryMaterials({ path: out, chromePath: chrome! });
    assert.deepEqual(inv.read, ["home"]);
    assert.deepEqual(inv.failed, []);
    const again = inv.pages[0]!;
    const g = checkList(again.file, again.dir, "saved screen");
    assert.equal(again.file.url, `${url}/`, "the page's address, not the saved file's");
    assert.ok(g.list.file && existsSync(join(again.dir, g.list.file)), "the saved file it drew");
    assert.ok(again.file.sheet);
  } finally {
    server.close();
    await rm(out, { recursive: true, force: true });
  }
});

test("shoot: film init's landing screen carries its material; --no-materials reads none", {
  skip,
  timeout: 120_000,
}, async () => {
  const { server, url } = await serve();
  const dir = await mkdtemp(join(tmpdir(), "ot-materials-home-"));
  try {
    const home = await shootHome({
      url: `${url}/`,
      dir,
      width: VW,
      height: VH,
      chromePath: chrome!,
      components: false,
    });
    assert.ok(home.materials, "the landing page's list");
    assert.equal(home.materials.path, join(dir, "states", "home", "materials.json"));
    assert.ok(existsSync(home.materials.path));
    const art = home.materials.file.images.find((i) => i.kind === "svg");
    assert.ok(
      art?.file && existsSync(join(home.materials.dir, art.file)),
      "its files moved with it",
    );
    const off = await shootHome({
      url: `${url}/`,
      dir,
      name: "bare",
      width: VW,
      height: VH,
      chromePath: chrome!,
      components: false,
      materials: false,
    });
    assert.equal(off.materials, undefined);
    assert.ok(!existsSync(join(dir, "states", "bare", "materials.json")));
  } finally {
    server.close();
    await rm(dir, { recursive: true, force: true });
  }
});
