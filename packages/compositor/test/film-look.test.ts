// `open-take film look` (src/film/look.ts): fonts read from TrueType, WOFF
// and WOFF2 (the transformed glyf rebuilt), cut down and still drawn the same,
// the film's words checked against them; colours and roles; CSS read for
// faces and motion; the film page's words read statically; and the whole read
// of a saved screen and of a live URL in Chrome (skipped without one).

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import {
  contrastRatio,
  cssDeclarations,
  cssMotion,
  estimateRoles,
  filmLook,
  filmText,
  formatFilmLook,
  glyphChars,
  glyphCoverage,
  type LookColour,
  needsGlyph,
  oklch,
  packageFonts,
  parseCssColor,
  parseFont,
  parseFontFaces,
  parseUnicodeRange,
  readableSize,
  readSfnt,
  scriptStrings,
  sizeForCapHeight,
  subsetFont,
  textWidth,
  toHex,
  unicodeRangeOf,
} from "../src/film/look";
import { launchHtmlBrowser } from "../src/html/cdp";
import { serveDirectory } from "../src/html/server";
import { findChrome } from "./fixtures/find-chrome";

const FONTS = join(import.meta.dirname, "fixtures", "fonts");
const MONO = join(FONTS, "geist-mono-latin-400.woff2");
const VAR = join(FONTS, "instrument-sans-latin-wght.woff2");
const CJK = join(FONTS, "noto-sans-tc-slice.woff2");
const chrome = findChrome();
const skip = chrome ? false : "no Chrome for Testing";

let dir = "";
before(async () => {
  dir = await mkdtemp(join(tmpdir(), "open-take-film-look-test-"));
});
after(async () => {
  await rm(dir, { recursive: true, force: true });
});

// --- fonts ------------------------------------------------------------------

test("parseFont reads WOFF2 names, weight, axes, metrics and the cmap", async () => {
  const mono = parseFont(await readFile(MONO));
  assert.equal(mono.format, "woff2");
  assert.equal(mono.outlines, "truetype");
  assert.match(mono.family, /Geist Mono/);
  assert.equal(mono.weight, 400);
  assert.deepEqual(mono.axes, []);
  assert.ok(mono.cmap.has("A".codePointAt(0)!) && mono.cmap.has("0".codePointAt(0)!));
  assert.ok(!mono.cmap.has("的".codePointAt(0)!));
  assert.ok(mono.unitsPerEm > 0 && mono.capHeight > 0 && mono.glyphs > 50);

  const v = parseFont(await readFile(VAR));
  assert.match(v.family, /Instrument Sans/);
  const wght = v.axes.find((a) => a.tag === "wght");
  assert.ok(wght && wght.min <= 400 && wght.max >= 700, JSON.stringify(v.axes));

  const cjk = parseFont(await readFile(CJK));
  assert.match(cjk.family, /^Noto Sans TC/);
  assert.ok(cjk.cmap.size > 100);
  assert.equal(cjk.capHeight > 0, true);
});

test("the WOFF2 glyf transform is undone into glyphs a TrueType reader walks", async () => {
  const sfnt = readSfnt(await readFile(VAR));
  const head = sfnt.tables.get("head")!;
  assert.equal(head.readInt16BE(50), 1, "loca is long after the rebuild");
  const n = sfnt.tables.get("maxp")!.readUInt16BE(4);
  const loca = sfnt.tables.get("loca")!;
  assert.equal(loca.length, 4 * (n + 1));
  const glyf = sfnt.tables.get("glyf")!;
  assert.equal(loca.readUInt32BE(4 * n), glyf.length);
  // every glyph parses: contours, its end points rising, inside the table
  const info = parseFont(await readFile(VAR));
  const gA = info.cmap.get("A".codePointAt(0)!)!;
  const at = loca.readUInt32BE(4 * gA);
  const contours = glyf.readInt16BE(at);
  assert.ok(contours >= 1, "A has outlines");
  const xMin = glyf.readInt16BE(at + 2);
  const xMax = glyf.readInt16BE(at + 6);
  assert.ok(xMax > xMin && xMax <= info.unitsPerEm * 1.2);
  // hmtx is the rebuilt one: an advance for the glyph, about its box
  assert.ok(info.advances[gA]! >= xMax - xMin);
});

test("subsetFont keeps the asked characters and every glyph id, empties the rest", async () => {
  const buf = await readFile(VAR);
  const full = parseFont(buf);
  const sub = subsetFont(buf, "Office", { format: "ttf" });
  assert.equal(sub.how, "subset");
  assert.equal(sub.kept, 5); // O f i c e
  const s = parseFont(sub.data);
  assert.equal(s.glyphs, full.glyphs, "glyph ids keep their numbers");
  assert.deepEqual(
    [...s.cmap.keys()].sort((a, b) => a - b),
    glyphChars("Office"),
  );
  for (const ch of "Ofice")
    assert.equal(s.cmap.get(ch.codePointAt(0)!), full.cmap.get(ch.codePointAt(0)!));
  assert.ok(sub.glyphs.kept < full.glyphs / 2, `${sub.glyphs.kept} of ${full.glyphs}`);
  assert.ok(sub.data.length < buf.length * 3, "a TTF of a handful of glyphs");
  // the "ffi" ligature GSUB reaches is kept with the letters
  assert.ok(sub.glyphs.kept > 6, "GSUB closure keeps more than the 5 mapped glyphs + .notdef");
  // WOFF is the default output and reads back the same
  const woff = subsetFont(buf, "Office");
  assert.equal(woff.data.toString("latin1", 0, 4), "wOFF");
  assert.deepEqual([...parseFont(woff.data).cmap.keys()].sort(), [...s.cmap.keys()].sort());
});

test("subsetFont cuts a CJK slice down and copies what it cannot cut", async () => {
  const buf = await readFile(CJK);
  const info = parseFont(buf);
  const some = [...info.cmap.keys()].filter((cp) => cp > 0x3000).slice(0, 5);
  const sub = subsetFont(buf, some);
  assert.equal(sub.how, "subset");
  assert.equal(sub.kept, 5);
  assert.ok(sub.data.length < buf.length);
  const back = parseFont(sub.data);
  assert.deepEqual(
    [...back.cmap.keys()].sort((a, b) => a - b),
    some.sort((a, b) => a - b),
  );
  // a CFF-flavoured file: flagged as copied, the bytes untouched
  const ttf = subsetFont(buf, some, { format: "ttf" }).data;
  const otto = Buffer.from(ttf);
  otto.write("OTTO", 0, "latin1");
  // rename glyf→CFF in the directory so it reads as a CFF font
  const n = otto.readUInt16BE(4);
  for (let i = 0; i < n; i++)
    if (otto.toString("latin1", 12 + 16 * i, 16 + 16 * i) === "glyf")
      otto.write("CFF ", 12 + 16 * i, "latin1");
  const copied = subsetFont(otto, some);
  assert.equal(copied.how, "copied");
  assert.match(copied.why!, /cff outlines/);
  assert.equal(copied.data, otto);
});

test("glyphCoverage and glyphChars: what each font has of a text, spaces and selectors needing none", async () => {
  const mono = parseFont(await readFile(MONO));
  const cjk = parseFont(await readFile(CJK));
  const cjkChar = String.fromCodePoint([...cjk.cmap.keys()].find((cp) => cp > 0x4e00)!);
  const text = `Go ${cjkChar}　鑫️\n`;
  assert.deepEqual(
    glyphChars(text)
      .map((c) => String.fromCodePoint(c))
      .sort(),
    ["G", "o", cjkChar, "鑫"].sort(),
  );
  assert.equal(needsGlyph(0x20), false);
  assert.equal(needsGlyph(0xfe0f), false);
  const c = glyphCoverage(
    [
      { name: "mono", font: mono },
      { name: "cjk", font: cjk },
    ],
    text,
  );
  assert.equal(c.chars, 4);
  assert.deepEqual(c.missing, [{ char: "鑫", code: "U+946B" }]);
  assert.equal(c.byFont.find((f) => f.name === "mono")!.lacks.includes(cjkChar), true);
});

test("textWidth adds advances; sizeForCapHeight inverts the cap height", async () => {
  const mono = parseFont(await readFile(MONO));
  const w = textWidth(mono, "abc", 100);
  assert.ok(Math.abs(w - textWidth(mono, "xyz", 100)) < 1e-9, "monospace");
  assert.ok(Math.abs(textWidth(mono, "abc", 50) - w / 2) < 1e-9);
  const g = mono.cmap.get("a".codePointAt(0)!)!;
  assert.ok(
    Math.abs(
      w - (3 * mono.advances[Math.min(g, mono.advances.length - 1)]! * 100) / mono.unitsPerEm,
    ) < 1e-6,
  );
  const size = sizeForCapHeight(mono, 70);
  assert.ok(Math.abs((size * mono.capHeight) / mono.unitsPerEm - 70) < 1e-9);
});

// --- colour, CSS, words ---------------------------------------------------------

test("parseCssColor, toHex, contrastRatio, oklch", () => {
  assert.deepEqual(parseCssColor("#abc"), { r: 0xaa, g: 0xbb, b: 0xcc, a: 1 });
  assert.deepEqual(parseCssColor("#11223380"), { r: 0x11, g: 0x22, b: 0x33, a: 0x80 / 255 });
  assert.deepEqual(parseCssColor("rgb(10 20 30 / 50%)"), { r: 10, g: 20, b: 30, a: 0.5 });
  assert.deepEqual(parseCssColor("rgba(255, 0, 0, 0.25)"), { r: 255, g: 0, b: 0, a: 0.25 });
  assert.deepEqual(parseCssColor("hsl(120, 100%, 25%)"), { r: 0, g: 128, b: 0, a: 1 });
  assert.equal(parseCssColor("oklch(0.5 0.1 120)"), null);
  assert.equal(toHex({ r: 0, g: 128, b: 255, a: 1 }), "#0080ff");
  assert.equal(toHex({ r: 0, g: 0, b: 0, a: 0.5 }), "#00000080");
  assert.equal(Math.round(contrastRatio("#000", "#fff")), 21);
  assert.equal(contrastRatio("#777", "#777"), 1);
  // a translucent colour is laid over its ground first
  assert.ok(
    Math.abs(contrastRatio("rgba(0,0,0,0.5)", "#fff") - contrastRatio("#808080", "#fff")) < 0.05,
  );
  const [L, C] = oklch(parseCssColor("#ffffff")!);
  assert.ok(Math.abs(L - 1) < 1e-3 && C < 1e-3);
  assert.ok(oklch(parseCssColor("#e4572e")!)[1] > 0.1);
});

test("readableSize: a film size on the screens it is watched on", () => {
  const r = readableSize(96);
  assert.equal(r.filmWidth, 1920);
  const phone = r.on[0]!;
  assert.equal(phone.px, Math.round(((96 * 393) / 1920) * 10) / 10);
  assert.ok(phone.mm! > 3 && phone.mm! < 4);
  assert.match(r.reference, /17 px/);
  assert.equal(
    readableSize(100, { filmWidth: 1000, screens: [{ name: "x", widthPx: 500 }] }).on[0]!.px,
    50,
  );
});

test("cssDeclarations and parseFontFaces read rules, blocks and urls", () => {
  const css = `/* c */ @font-face{font-family:"Brand Sans";font-weight:100 900;src:url(../assets/a.woff2)format("woff2");unicode-range:U+0-FF,U+4??}
@font-face{font-family:Brand Sans;font-style:italic;src:url(about:blank)format("woff2")}
@font-face{font-family:'X Fallback';src:local("Arial");size-adjust:104%}
@media (min-width:1px){.a{color:red;background:url("data:image/svg+xml;a{b}")}}
:root{--brand:#e4572e}`;
  const d = cssDeclarations(css);
  assert.ok(d.some((x) => x.selector === ".a" && x.property === "color" && x.value === "red"));
  assert.ok(
    d.some((x) => x.property === "background" && x.value.includes("a{b}")),
    "braces inside url() are not blocks",
  );
  assert.ok(d.some((x) => x.selector === ":root" && x.property === "--brand"));
  const faces = parseFontFaces(css, "http://h/states/assets/s.css");
  assert.equal(faces.length, 3);
  assert.deepEqual(faces[0], {
    family: "Brand Sans",
    weight: "100 900",
    style: "normal",
    unicodeRange: "U+0-FF,U+4??",
    src: "http://h/states/assets/a.woff2",
    format: "woff2",
  });
  assert.equal(faces[1]!.style, "italic");
  assert.equal(faces[1]!.src, "about:blank");
  assert.equal(faces[2]!.src, null);
});

test("parseUnicodeRange and unicodeRangeOf", () => {
  assert.deepEqual(parseUnicodeRange("U+0-7F, u+4??, U+20AC"), [
    [0, 0x7f],
    [0x400, 0x4ff],
    [0x20ac, 0x20ac],
  ]);
  assert.equal(unicodeRangeOf([0x41, 0x42, 0x43, 0x4e00, 0x20ac]), "U+41-43, U+20AC, U+4E00");
});

test("cssMotion lists declared durations and easings, delays included, with where", () => {
  const m = cssMotion([
    `.btn{transition:color .2s ease-out,transform 300ms cubic-bezier(.2, .8, .2, 1) 50ms}
     .x{animation:spin 1s linear infinite}.y{transition-duration:200ms;transition-timing-function:ease}
     @keyframes spin{to{transform:rotate(1turn)}} .z{transition:none}`,
  ]);
  const ms = Object.fromEntries(m.durations.map((d) => [d.ms, d.count]));
  assert.deepEqual(ms, { 200: 2, 300: 1, 50: 1, 1000: 1 });
  const e = Object.fromEntries(m.easings.map((x) => [x.value, x.count]));
  assert.equal(e["cubic-bezier(.2,.8,.2,1)"], 1);
  assert.equal(e["ease-out"], 1);
  assert.equal(e.linear, 1);
  assert.equal(e.ease, 1);
  assert.deepEqual(m.keyframes, ["spin"]);
  assert.match(m.durations.find((d) => d.ms === 300)!.where[0]!, /\.btn/);
});

test("scriptStrings: quotes, templates, escapes; comments and regexes skipped", () => {
  const js = String.raw`// "not this"
  const a = "找到你的", b = 'it\'s', c = /["']+/g; /* "nor this" */
  const t = ${"`"}<b>${"${"}n > 1 ? "多" : "一"}</b> 間${"`"};
  const u = "中\x41";
  return /x"y/.test(s) ? "yes" : "no";`;
  const s = scriptStrings(js);
  assert.deepEqual(s, ["找到你的", "it's", "<b>", "多", "一", "</b> 間", "中A", "yes", "no"]);
});

test("filmText reads the page, its own modules and data, not kit/", async () => {
  const film = join(dir, "film-words");
  await mkdir(join(film, "kit"), { recursive: true });
  await writeFile(
    join(film, "index.html"),
    `<!doctype html><title>t</title><style>.a{content:"樣式"}</style><h1 aria-label="標籤">你好 &amp; 再見</h1>
<script type="module">import { tl } from "./timeline.js"; import * as m from "./kit/motion.js"; const cap = "字幕一"; fetch("./words.json");</script>
<script src="./extra.js"></script>`,
  );
  await writeFile(
    join(film, "timeline.js"),
    `export const tl = { lines: ["第二句", \`第\${3}句\`] };`,
  );
  await writeFile(join(film, "extra.js"), `const x = "外部";`);
  await writeFile(join(film, "words.json"), JSON.stringify({ a: ["資料"] }));
  await writeFile(join(film, "kit", "motion.js"), `throw new Error("工具");`);
  const { text, files } = await filmText(film);
  for (const w of ["你好 & 再見", "標籤", "字幕一", "第二句", "第", "句", "外部", "資料"])
    assert.ok(text.includes(w), w);
  assert.ok(!text.includes("工具"), "kit/ left out");
  assert.ok(!text.includes("樣式"), "CSS left out");
  assert.equal(files.length, 4);
});

test("estimateRoles: background, surface, text, muted, accent, on-accent, border from use", () => {
  const c = (hex: string, o: Partial<LookColour>): LookColour => ({
    hex,
    background: 0,
    text: 0,
    border: 0,
    fill: 0,
    interactive: 0,
    on: [],
    where: [],
    vars: [],
    oklch: oklch(parseCssColor(hex)!),
    ...o,
  });
  const roles = estimateRoles(
    [
      c("#fafafa", { background: 0.6 }),
      c("#123456", { background: 0.3 }),
      c("#222222", { text: 500, on: [{ ground: "#fafafa", chars: 500, contrast: 15 }] }),
      c("#777777", { text: 700, on: [{ ground: "#fafafa", chars: 700, contrast: 4.3 }] }),
      c("#e4572e", { background: 0.01, interactive: 1 }),
      c("#ffffff", { text: 40, on: [{ ground: "#e4572e", chars: 40, contrast: 3.4 }] }),
      c("#dddddd", { border: 9000 }),
    ],
    1240,
  );
  assert.equal(roles.bg.hex, "#fafafa");
  assert.equal(roles.surface.hex, "#123456");
  assert.equal(
    roles.text.hex,
    "#222222",
    "the most contrast among the colours most text is set in",
  );
  assert.equal(roles.muted.hex, "#777777");
  assert.equal(roles.accent.hex, "#e4572e");
  assert.equal(roles.onAccent.hex, "#ffffff");
  assert.equal(roles.border.hex, "#dddddd");
  for (const r of Object.values(roles)) assert.equal(r.how, "estimated");
  const empty = estimateRoles([], 0);
  for (const r of Object.values(empty)) assert.equal(r.how, "not detected");
});

test("packageFonts writes cut-down files and a fonts.css for the characters each serves", async () => {
  const out = join(dir, "pack");
  const pack = await packageFonts({
    dir: out,
    chars: glyphChars("Hello 你好"),
    files: [
      { family: "Mono", weight: "400", style: "normal", path: MONO },
      { family: "Mono", weight: "700", style: "normal", path: MONO }, // one file, two faces
      { family: "Brand", weight: "100 900", style: "normal", unicodeRange: "U+0-FF", path: VAR },
      { family: "Han", weight: "400", style: "normal", path: CJK },
    ],
  });
  const css = await readFile(pack.css, "utf8");
  assert.equal(pack.files.filter((f) => f.family === "Mono").length, 2);
  assert.equal(
    new Set(pack.files.filter((f) => f.family === "Mono").map((f) => f.file)).size,
    1,
    "cut once",
  );
  assert.match(css, /font-family: "Brand";\n {2}font-weight: 100 900;/);
  // the words, and the space the font has to set them with
  assert.match(css, /unicode-range: U\+20, U\+48, U\+65, U\+6C, U\+6F, U\+A0;/);
  for (const f of pack.files) assert.ok(existsSync(join(out, f.file)));
  // the CJK slice only serves the Han characters it has
  const han = pack.files.find((f) => f.family === "Han");
  const cjk = parseFont(await readFile(CJK));
  assert.equal(han?.chars, glyphChars("Hello 你好").filter((cp) => cjk.cmap.has(cp)).length);
});

test("the film's words are checked per weight: one weight's files do not cover another's", async () => {
  // family B: 400 is the CJK slice, 700 a Latin-only file — a browser setting
  // a Han character at 700 falls back to the next family, whatever 400 has
  const root = join(dir, "weights");
  await mkdir(join(root, "fonts"), { recursive: true });
  await writeFile(join(root, "fonts", "h.woff2"), await readFile(CJK));
  await writeFile(join(root, "fonts", "m.woff2"), await readFile(MONO));
  const cjk = parseFont(await readFile(CJK));
  const han = String.fromCodePoint([...cjk.cmap.keys()].find((cp) => cp >= 0x4e00)!);
  const mono = parseFont(await readFile(MONO));
  const latin = String.fromCodePoint(
    [...mono.cmap.keys()].find((cp) => cp > 0x20 && !cjk.cmap.has(cp))!,
  );
  const face = (file: string, weight: string) => ({
    file,
    source: null,
    weight,
    style: "normal",
    unicodeRange: "",
    status: "saved",
  });
  const look = {
    version: 1,
    source: {
      kind: "take",
      input: "x",
      url: null,
      title: null,
      screens: [],
      skipped: [],
      viewport: null,
    },
    roles: {},
    colours: [],
    gradients: [],
    imageShare: 0,
    vars: [],
    fonts: [
      {
        family: "B",
        webfont: true,
        chars: 1,
        share: 1,
        weights: [],
        sizes: [],
        stacks: [],
        samples: [],
        files: [face("fonts/h.woff2", "400"), face("fonts/m.woff2", "bold")],
        declared: 2,
        missingFiles: 0,
      },
    ],
    declaredFamilies: [],
    type: [],
    radii: [],
    shadows: [],
    motion: {
      declared: { durations: [], easings: [], keyframes: [] },
      used: [],
      usedHow: "not detected",
    },
    labels: {},
    notes: [],
  };
  await writeFile(join(root, "look.json"), JSON.stringify(look));
  const r = await filmLook({ source: join(root, "look.json"), text: `${latin}${han}` });
  const g = r.look.glyphs!;
  assert.deepEqual(g.missing, [], "each character is in some file");
  const at = (w: string) => g.byFamily.find((f) => f.weight === w)!;
  assert.equal(at("400").lacks, latin);
  assert.equal(at("700").lacks, han, "700 is checked on its own (bold read as 700)");
  assert.match(formatFilmLook(r.look), /B 700: 1\/2 — lacks .*\n.*falls back to the next family/);

  // a variable font given with --font-files serves its whole weight axis,
  // under its family without the default instance's weight
  const given = await filmLook({
    source: join(root, "look.json"),
    text: han,
    fontFiles: [CJK],
    fonts: join(root, "packed"),
  });
  const noto = given.look.glyphs!.byFamily.find((f) => f.family === "Noto Sans TC");
  assert.ok(noto, JSON.stringify(given.look.glyphs!.byFamily));
  assert.equal(noto.weight, "100 900");
  assert.match(
    await readFile(given.css!, "utf8"),
    /font-family: "Noto Sans TC";\n {2}font-weight: 100 900;/,
  );
});

// --- the whole read, in Chrome --------------------------------------------------------

/** a take with one saved screen: known colours, a web font, one face never loaded */
async function fixtureTake(root: string): Promise<string> {
  const take = join(root, "demo.take");
  const s0 = join(take, "states", "s0");
  const assets = join(take, "states", "assets");
  await mkdir(s0, { recursive: true });
  await mkdir(assets, { recursive: true });
  await writeFile(join(assets, "mono.woff2"), await readFile(MONO));
  await writeFile(
    join(assets, "site.css"),
    `@font-face{font-family:"Site Mono";font-weight:400;src:url(../assets/mono.woff2)format("woff2");unicode-range:U+0-FF}
@font-face{font-family:"Site Mono";font-weight:400;src:url(about:blank)format("woff2");unicode-range:U+100-24F}
:root{--brand:#e4572e;--ink:#222222}
html,body{margin:0;width:640px;height:360px;background:#fafafa;font-family:"Site Mono",monospace;color:#222}
.card{position:absolute;left:0;top:0;width:640px;height:120px;background:#123456;border-radius:16px;box-shadow:0 10px 30px rgba(0,0,0,.2)}
.card p{color:#ffffff;margin:20px;font-size:20px}
p.body{position:absolute;top:150px;left:20px;margin:0;font-size:24px;font-weight:400}
p.note{position:absolute;top:200px;left:20px;margin:0;color:#777;font-size:16px}
button{position:absolute;top:260px;left:20px;background:var(--brand);color:#fff;border:0;border-radius:999px;padding:12px 28px;font:600 18px "Site Mono";transition:transform .2s cubic-bezier(.2,.8,.2,1)}
.line{position:absolute;top:330px;left:0;width:640px;border-top:2px solid #dddddd}`,
  );
  await writeFile(
    join(s0, "state.html"),
    `<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="../assets/site.css">
<style data-ot-freeze>*{transition:none!important}</style></head>
<body><div class="card"><p>Header on the card</p></div><p class="body">Body text set in the site font, long enough</p>
<p class="note">a quieter note line under it</p><button>Start now</button><div class="line"></div>
<script>document.documentElement.dataset.otReady = "1"</script></body></html>`,
  );
  await writeFile(
    join(s0, "index.json"),
    JSON.stringify({
      version: 1,
      id: "s0",
      url: "https://example.test/",
      title: "Fixture",
      tMs: 0,
      viewport: { w: 640, h: 360, dpr: 1 },
      scroll: { x: 0, y: 0 },
      elements: [],
      layers: [],
      fidelity: { psnr: 40, diffFrac: 0, ok: true },
    }),
  );
  return take;
}

test("filmLook reads a take's saved screen: roles, fonts and files, glyphs, packed fonts, picture", {
  skip,
}, async () => {
  const take = await fixtureTake(join(dir, "take"));
  const out = join(dir, "look");
  const film = join(dir, "film-page");
  await mkdir(film, { recursive: true });
  await writeFile(
    join(film, "index.html"),
    `<h1>Start now</h1><script type="module">const c = "Ł 字";</script>`,
  );
  const r = await filmLook({
    source: take,
    out,
    chromePath: chrome!,
    page: film,
    fonts: join(dir, "film-fonts"),
  });
  const L = r.look;
  assert.equal(L.source.kind, "take");
  assert.deepEqual(L.source.screens, ["s0"]);
  assert.equal(L.source.url, "https://example.test/");
  assert.equal(L.roles.bg.hex, "#fafafa");
  assert.equal(L.roles.surface.hex, "#123456");
  assert.equal(L.roles.text.hex, "#222222");
  assert.deepEqual(L.roles.text.vars, ["--ink"]);
  assert.equal(L.roles.muted.hex, "#777777");
  assert.equal(L.roles.accent.hex, "#e4572e");
  assert.deepEqual(L.roles.accent.vars, ["--brand"]);
  assert.equal(L.roles.onAccent.hex, "#ffffff");
  assert.equal(L.roles.border.hex, "#dddddd");
  const bg = L.colours.find((c) => c.hex === "#fafafa")!;
  const card = L.colours.find((c) => c.hex === "#123456")!;
  assert.ok(Math.abs(card.background - 120 / 360) < 0.04, `card share ${card.background}`);
  assert.ok(bg.background > 0.5);
  // fonts: the family, the saved file, the face never loaded
  const mono = L.fonts.find((f) => f.family === "Site Mono")!;
  assert.ok(mono.webfont && mono.chars > 40);
  assert.equal(mono.files.length, 1);
  assert.equal(mono.files[0]!.status, "saved");
  assert.ok(existsSync(join(out, mono.files[0]!.file!)));
  assert.equal(mono.missingFiles, 1);
  assert.ok(L.type.some((t) => t.sizePx === 24 && t.family === "Site Mono"));
  assert.ok(L.radii.some((x) => x.value === "16px") && L.radii.some((x) => x.value === "pill"));
  assert.equal(L.shadows.length, 1);
  assert.ok(L.motion.declared.durations.some((d) => d.ms === 200));
  assert.equal(L.motion.usedHow, "not detected", "a saved screen holds motion still");
  // the film's words: "Ł" (Latin Extended, the face never saved) and 字 are in no file
  assert.deepEqual(L.glyphs!.missing.map((m) => m.char).sort(), ["Ł", "字"].sort());
  assert.deepEqual(
    L.glyphs!.declaredElsewhere.map((e) => e.chars),
    ["Ł"],
  );
  assert.ok(L.packaged && L.packaged.files.length === 1);
  assert.match(await readFile(L.packaged.css, "utf8"), /font-family: "Site Mono"/);
  assert.ok(r.png && existsSync(r.png));
  assert.match(await readFile(join(out, "look.css"), "utf8"), /--look-accent: #e4572e;/);
  const report = formatFilmLook(L);
  assert.match(report, /\[estimated\]/);
  assert.match(report, /in no font file here \(2\)/);
  const saved = JSON.parse(await readFile(r.json, "utf8"));
  assert.equal(saved.version, 1);
  // a look.json source: the font work again, nothing re-read
  const again = await filmLook({ source: r.json, text: "Start" });
  assert.equal(again.look.glyphs!.missing.length, 0);
  assert.equal(again.png, null, "no Chrome given, no picture");
});

test("the packed fonts draw exactly what the originals draw", { skip }, async () => {
  const root = join(dir, "draw");
  await mkdir(root, { recursive: true });
  const words = "Office affinity 2026 Hello";
  const cjk = parseFont(await readFile(CJK));
  const han = [...cjk.cmap.keys()]
    .filter((cp) => cp >= 0x4e00)
    .slice(0, 8)
    .map((cp) => String.fromCodePoint(cp))
    .join("");
  const pack = await packageFonts({
    dir: join(root, "pack"),
    chars: glyphChars(words + han),
    files: [
      { family: "V", weight: "100 900", style: "normal", path: VAR },
      { family: "M", weight: "400", style: "normal", path: MONO },
      { family: "H", weight: "100 900", style: "normal", path: CJK },
    ],
  });
  for (const [f, name] of [
    [VAR, "v.woff2"],
    [MONO, "m.woff2"],
    [CJK, "h.woff2"],
  ] as const)
    await writeFile(join(root, name), await readFile(f));
  const rows = [
    ["V", "v.woff2", words, 700],
    ["V", "v.woff2", words, 300],
    ["M", "m.woff2", words, 400],
    ["H", "h.woff2", han, 800],
  ] as const;
  const css = (await readFile(pack.css, "utf8")).replace(/url\("/g, 'url("pack/');
  const html = `<!doctype html><meta charset="utf-8"><style>${css}
${rows.map(([, file], i) => `@font-face{font-family:O${i};font-weight:100 900;src:url(${file})}`).join("\n")}
body{margin:0;background:#fff} div{height:80px;font-size:56px;white-space:nowrap;line-height:80px}</style>
${rows.map(([fam, , text, w], i) => `<div style="font-family:O${i};font-weight:${w}">${text}</div><div style="font-family:${fam};font-weight:${w}">${text}</div>`).join("")}`;
  await writeFile(join(root, "page.html"), html);
  const server = await serveDirectory(root);
  const b = await launchHtmlBrowser({
    chromePath: chrome!,
    url: `${server.url}/page.html`,
    width: 1200,
    height: 640,
  });
  try {
    const status = await b.evaluate<string[]>(
      "document.fonts.ready.then(() => [...document.fonts].map((f) => f.family + ':' + f.status))",
    );
    assert.ok(
      status.every((s) => s.endsWith(":loaded")),
      status.join(" "),
    );
    // each original row and its packed twin, compared as drawn pixels
    const diff = await b.evaluate<number[]>(`(async () => {
      const out = [];
      const divs = [...document.querySelectorAll("div")];
      const draw = (el) => {
        const c = document.createElement("canvas"); c.width = 1200; c.height = 80; const x = c.getContext("2d");
        x.fillStyle = "#fff"; x.fillRect(0, 0, 1200, 80); x.fillStyle = "#000";
        const s = getComputedStyle(el); x.font = s.fontWeight + " 56px " + s.fontFamily; x.textBaseline = "middle";
        x.fillText(el.textContent, 0, 40); return x.getImageData(0, 0, 1200, 80).data;
      };
      for (let i = 0; i < divs.length; i += 2) {
        await document.fonts.load(getComputedStyle(divs[i]).fontWeight + " 56px " + getComputedStyle(divs[i]).fontFamily, divs[i].textContent);
        await document.fonts.load(getComputedStyle(divs[i + 1]).fontWeight + " 56px " + getComputedStyle(divs[i + 1]).fontFamily, divs[i + 1].textContent);
        const a = draw(divs[i]), b = draw(divs[i + 1]);
        let n = 0, ink = 0; for (let k = 0; k < a.length; k += 4) { if (a[k] !== b[k]) n++; if (a[k] < 128) ink++; }
        out.push(ink ? n / ink : -1);
      }
      return out;
    })()`);
    for (const [i, d] of diff.entries()) {
      assert.ok(d >= 0, `row ${i} drew nothing`);
      assert.equal(d, 0, `row ${i}: ${d} of its ink differs`);
    }
  } finally {
    await b.close();
    await server.close();
  }
});

test("filmLook reads a live URL whose page throws, downloads the faces it loaded", {
  skip,
}, async () => {
  const site = join(dir, "site");
  await mkdir(site, { recursive: true });
  await writeFile(join(site, "mono.woff2"), await readFile(MONO));
  await writeFile(join(site, "var.woff2"), await readFile(VAR));
  await writeFile(
    join(site, "index.html"),
    `<!doctype html><meta charset="utf-8"><title>Live</title><style>
@font-face{font-family:Live;src:url(mono.woff2)}
@font-face{font-family:Unused;src:url(var.woff2)}
body{margin:0;background:#101820;color:#f2aa4c;font:32px Live}
a{transition:color 150ms ease-in}</style><p>Live words <a href="#">here</a></p>
<script>throw new Error("analytics failed"); </script><script>Promise.reject(new Error("no"));</script>`,
  );
  const server = await serveDirectory(site);
  try {
    const r = await filmLook({
      source: `${server.url}/index.html`,
      out: join(dir, "look-url"),
      chromePath: chrome!,
      noPicture: true,
    });
    assert.equal(r.look.source.kind, "url");
    assert.equal(r.look.roles.bg.hex, "#101820");
    assert.equal(r.look.roles.text.hex, "#f2aa4c");
    const live = r.look.fonts.find((f) => f.family === "Live")!;
    assert.equal(live.files[0]?.status, "downloaded");
    assert.ok(r.look.declaredFamilies.includes("Unused"));
    assert.equal(r.look.motion.usedHow, "measured");
    assert.ok(r.look.motion.used.some((u) => /150ms|0\.15s/.test(u.value)));
    assert.equal(r.png, null);
  } finally {
    await server.close();
  }
});
