// The whole page's material, Node side (no Chrome): the largest source of an
// image among what the page offers, the size an image file states, the
// hosts that are never saved, what the probe's answer becomes in
// materials.json, and the lines a shoot prints — in page order, a few of
// them, naming what is below the first screen too, never ranking.

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  adHost,
  formatMaterials,
  imageFileSize,
  largestSource,
  MATERIALS_PROBE_JS,
  type MaterialsFile,
  type MaterialsPage,
  type MaterialsProbeResult,
  materialsFromProbe,
  materialsSummary,
  readMaterials,
} from "../src/index";

test("largestSource: the widest w descriptor, else the highest density; a data: placeholder only when alone", () => {
  assert.deepEqual(
    largestSource([
      { url: "https://x/a-400.jpg", w: 400 },
      { url: "https://x/a-1600.jpg", w: 1600 },
      { url: "https://x/a.jpg", x: 1 },
    ]),
    { url: "https://x/a-1600.jpg", w: 1600 },
  );
  assert.deepEqual(
    largestSource([
      { url: "https://x/a.png", x: 1 },
      { url: "https://x/a@2x.png", x: 2 },
    ]),
    { url: "https://x/a@2x.png" },
  );
  // a blurred placeholder in src, the picture in srcset
  assert.deepEqual(
    largestSource([
      { url: "data:image/png;base64,AAAA", x: 1 },
      { url: "https://x/real.webp", w: 800 },
    ]),
    { url: "https://x/real.webp", w: 800 },
  );
  assert.deepEqual(largestSource([{ url: "data:image/gif;base64,R0lG", x: 1 }]), {
    url: "data:image/gif;base64,R0lG",
  });
  // the same width as avif and as jpeg: the plain format
  assert.equal(
    largestSource([
      { url: "https://x/a.avif", w: 1200, type: "image/avif" },
      { url: "https://x/a.jpg", w: 1200, type: "image/jpeg" },
    ])?.url,
    "https://x/a.jpg",
  );
  assert.equal(largestSource([{ url: "blob:https://x/1", x: 1 }]), null);
  assert.equal(largestSource([]), null);
});

test("imageFileSize reads PNG, GIF, JPEG, WebP and SVG headers", () => {
  const png = Buffer.alloc(24);
  png.writeUInt32BE(0x89504e47, 0);
  png.writeUInt32BE(1600, 16);
  png.writeUInt32BE(1000, 20);
  assert.deepEqual(imageFileSize(png), [1600, 1000]);
  const gif = Buffer.from("GIF89a\x40\x01\xf0\x00", "latin1");
  assert.deepEqual(imageFileSize(gif), [320, 240]);
  // SOI, an APP0 of 16 bytes, SOF0 with 480×640 (height first)
  const jpeg = Buffer.from([
    0xff,
    0xd8,
    0xff,
    0xe0,
    0x00,
    0x10,
    ...Buffer.alloc(14),
    0xff,
    0xc0,
    0x00,
    0x11,
    0x08,
    0x01,
    0xe0,
    0x02,
    0x80,
    0x03,
    0,
    0,
    0,
    0,
    0,
  ]);
  assert.deepEqual(imageFileSize(jpeg), [640, 480]);
  const webp = Buffer.alloc(30);
  webp.write("RIFF", 0, "latin1");
  webp.write("WEBP", 8, "latin1");
  webp.write("VP8X", 12, "latin1");
  webp.writeUIntLE(799, 24, 3);
  webp.writeUIntLE(599, 27, 3);
  assert.deepEqual(imageFileSize(webp), [800, 600]);
  assert.deepEqual(imageFileSize(Buffer.from('<svg width="400" height="300"></svg>')), [400, 300]);
  assert.deepEqual(imageFileSize(Buffer.from('<svg viewBox="0 0 120 80"></svg>')), [120, 80]);
  assert.equal(imageFileSize(Buffer.from("not an image")), null);
});

test("adHost: ad and tracking hosts, never the product's own", () => {
  assert.ok(adHost("https://securepubads.g.doubleclick.net/x.gif"));
  assert.ok(adHost("https://www.facebook.com/tr?id=1"));
  assert.ok(!adHost("https://www.facebook.com/brand/logo.png"));
  assert.ok(!adHost("https://cdn.example.com/hero.png"));
  assert.ok(!adHost("not a url"));
});

test("the probe is one function expression that reads the page only", () => {
  assert.doesNotThrow(() => new Function(`return (${MATERIALS_PROBE_JS})`));
  // nothing that writes to the page or scrolls it
  assert.doesNotMatch(
    MATERIALS_PROBE_JS,
    /setAttribute|appendChild|removeChild|\.remove\(|scrollTo|scrollBy|scrollIntoView|\.style\.|innerHTML\s*=/,
  );
});

type Probe = Exclude<MaterialsProbeResult, { error: string }>;
const box = (y: number, h = 100): [number, number, number, number] => [40, y, 400, h];
const probe: Probe = {
  url: "https://app.example/",
  title: "Example",
  viewport: { w: 1280, h: 720 },
  page: { w: 1280, h: 3600 },
  medianTextPx: 16,
  meta: { description: "A made-up product." },
  images: [
    {
      kind: "img",
      box: box(200, 250),
      firstScreen: true,
      alt: "The list",
      selector: "img",
      candidates: [
        { url: "https://app.example/l-400.png", w: 400 },
        { url: "https://app.example/l-1600.png", w: 1600 },
      ],
      current: "https://app.example/l-400.png",
      natural: [400, 250],
    },
    {
      kind: "svg",
      box: box(1700, 300),
      firstScreen: false,
      name: "A drawing",
      selector: "svg",
      candidates: [],
      markup: "<svg/>",
    },
    {
      kind: "img",
      box: box(2400),
      firstScreen: false,
      alt: "",
      selector: "img:nth-of-type(2)",
      candidates: [{ url: "data:image/png;base64,iVBORw0KGgo=", x: 1 }],
    },
    {
      kind: "video",
      box: box(2800, 400),
      firstScreen: false,
      selector: "video",
      candidates: [{ url: "https://app.example/demo.mp4", x: 1 }],
      poster: "https://app.example/poster.jpg",
    },
    { kind: "canvas", box: box(3200), firstScreen: false, selector: "canvas", candidates: [] },
  ],
  copy: [
    {
      tag: "h1",
      level: 1,
      text: "Make a thing",
      box: box(100, 60),
      fontPx: 56,
      weight: 700,
      firstScreen: true,
      selector: "h1",
    },
    {
      tag: "p",
      text: "Body copy that runs along.",
      box: box(170, 20),
      fontPx: 16,
      weight: 400,
      firstScreen: true,
      selector: "p",
    },
    {
      tag: "p",
      text: "A small paragraph below.",
      box: box(1500, 20),
      fontPx: 16,
      weight: 400,
      firstScreen: false,
      selector: "p:nth-of-type(2)",
    },
    {
      tag: "p",
      text: "Your next step, ready",
      box: box(2100, 48),
      fontPx: 40,
      weight: 400,
      firstScreen: false,
      hidden: "opacity 0",
      selector: "p.tagline",
    },
    {
      tag: "h2",
      level: 2,
      text: "Pricing",
      box: box(2600, 40),
      fontPx: 32,
      weight: 700,
      firstScreen: false,
      in: "footer",
      selector: "h2",
    },
  ],
  skipped: { hidden: 2, small: 1, icons: 7, ariaHidden: 1, frames: 1, more: 0 },
  ms: 12,
};

test("materialsFromProbe: each image's largest source, what to save beside it, the sources dropped", () => {
  const { file, save } = materialsFromProbe(probe, { state: "home", read: "live" });
  assert.equal(file.version, 1);
  assert.equal(file.state, "home");
  const [list, art, inline, video, canvas] = file.images;
  assert.equal(list!.src, "https://app.example/l-1600.png");
  assert.equal(list!.srcW, 1600);
  assert.equal(list!.sources, 2);
  assert.equal(list!.shown, "https://app.example/l-400.png");
  assert.ok(!("candidates" in list!));
  assert.deepEqual(save[0], { url: "https://app.example/l-1600.png" });
  assert.deepEqual(save[1], { markup: "<svg/>" });
  assert.ok(!("markup" in art!));
  assert.equal(inline!.src, "data:image/png", "the list names a data: URL by its type only");
  assert.deepEqual(save[2], { data: "data:image/png;base64,iVBORw0KGgo=" });
  assert.equal(video!.src, "https://app.example/demo.mp4");
  assert.deepEqual(
    save[3],
    { url: "https://app.example/poster.jpg" },
    "a video's poster, not the video",
  );
  assert.equal(canvas!.src, undefined);
  assert.equal(save[4], null);
  assert.match(file.scope, /page order/);
});

const pageOf = (f: MaterialsFile, dir = "/s/states/home"): MaterialsPage => ({
  id: f.state,
  dir,
  file: f,
  path: join(dir, "materials.json"),
});

test("materialsSummary: a few lines — counts, first images in and below the first screen, headings and large type below it, where the rest is", () => {
  const { file } = materialsFromProbe(probe, { state: "home", read: "live" });
  file.images[0]!.file = "../assets/abc.png";
  file.images[0]!.fileSize = [1600, 1000];
  file.sheet = {
    file: "sheet.jpg",
    columns: 2,
    columnPx: 1800,
    scale: 0.28,
    coveredPx: 3600,
    from: "saved screen",
  };
  const lines = materialsSummary([pageOf(file)], {
    show: (p) => p,
    cmd: "open-take materials shots",
  });
  assert.ok(lines.length <= 12, lines.join("\n"));
  const text = lines.join("\n");
  assert.match(
    lines[0]!,
    /home .* 3600 px tall, 5 screens: 5 images \(4 below the first screen, 1 saved\), 5 texts \(3 below\)/,
  );
  assert.match(
    text,
    /y +200 +img +1600×1000 \(drawn 400×250\) +"The list" +\/s\/states\/assets\/abc\.png/,
  );
  assert.match(text, /y +1700 +svg .*"A drawing"/);
  // below the first screen: the large tagline and the heading, not the small paragraph
  assert.match(text, /"Your next step, ready" +\(opacity 0\)/);
  assert.match(text, /"Pricing" +\(in footer\)/);
  assert.doesNotMatch(text, /A small paragraph below/);
  assert.doesNotMatch(text, /Make a thing/, "the first screen's copy is the screen itself");
  assert.match(
    text,
    /open-take materials shots \(\/s\/states\/home\/materials\.json\); the page as one picture: \/s\/states\/home\/sheet\.jpg/,
  );
  // page order within each kind
  const ys = lines.slice(1, 6).map((l) => Number(/y +(\d+)/.exec(l)?.[1]));
  assert.deepEqual(
    [...ys].sort((a, b) => a - b),
    ys,
  );
  assert.doesNotMatch(text, /\b(best|recommend|should|score|pick)\b/i);
  assert.deepEqual(materialsSummary([], { show: (p) => p, cmd: "x" }), []);
});

test("materialsSummary: more pages, a line each; it stays a few lines", () => {
  const pages = ["home", "pricing", "docs", "blog", "about"].map((id) =>
    pageOf(
      materialsFromProbe(
        { ...probe, url: `https://app.example/${id}` },
        { state: id, read: "live" },
      ).file,
      `/s/states/${id}`,
    ),
  );
  const lines = materialsSummary(pages, { show: (p) => p, cmd: "open-take materials shots" });
  assert.ok(lines.length <= 12, `${lines.length} lines`);
  assert.match(lines.join("\n"), /\+ pricing \(https:\/\/app\.example\/pricing\)/);
  assert.match(lines.join("\n"), /\+ 2 more pages/);
  assert.match(lines.at(-1)!, /one per page/);
});

test("formatMaterials: images and copy in one page order, where the first screen ends, what was not listed", () => {
  const { file } = materialsFromProbe(probe, { state: "home", read: "live" });
  file.images[3]!.notSaved = "HTTP 404";
  const out = formatMaterials([pageOf(file)], { show: (p) => p });
  const ys = [...out.matchAll(/^ {2}y +(\d+)/gm)].map((m) => Number(m[1]));
  assert.equal(ys.length, 10);
  assert.deepEqual(
    [...ys].sort((a, b) => a - b),
    ys,
  );
  const fold = out.indexOf("the first screen ends (y 720)");
  assert.ok(fold > out.indexOf("Make a thing") && fold < out.indexOf("A small paragraph below"));
  assert.match(out, /canvas .*drawn 400×100/);
  assert.match(
    out,
    /not listed: 2 drawn at no size, 1 smaller than 24 px, 7 svg icons, 1 aria-hidden copies, 1 iframes \(not read\)/,
  );
  assert.match(out, /description: "A made-up product\."/);
});

test("readMaterials: one list per page from the screens that hold one; a page without names its first screen", () => {
  const root = mkdtempSync(join(tmpdir(), "ot-mat-"));
  const st = (id: string, url: string, materials?: MaterialsFile) => {
    const dir = join(root, id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "index.json"), JSON.stringify({ version: 1, id, url }));
    if (materials) writeFileSync(join(dir, "materials.json"), JSON.stringify(materials));
    return { id, dir };
  };
  const home = materialsFromProbe(probe, { state: "a", read: "live" }).file;
  const states = [
    st("a", "https://app.example/", home),
    st("b", "https://app.example/#pricing"),
    st("c", "https://app.example/docs"),
    st("d", "https://app.example/docs"),
  ];
  const r = readMaterials({ kind: "states", root, states });
  assert.deepEqual(
    r.pages.map((p) => p.id),
    ["a"],
  );
  assert.deepEqual(
    r.missing.map((m) => m.id),
    ["c"],
    "the same page by its fragment is covered; another page once, by its first screen",
  );
});
