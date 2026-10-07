// The film kit's look (kit/look.js): colours and contrast, how big a film
// size reads on a phone, line breaking (CJK by phrase with its line-start and
// line-end rules, Latin at spaces, balanced lines), fitText's size search, and
// a palette from look.json — in Node with a width function, and in Chrome
// with a real font, where the text set at the size fitText gives must fit.

import assert from "node:assert/strict";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import {
  breakLines,
  contrast,
  fitText,
  luminance,
  palette,
  parseColor,
  readable,
} from "../kit/look.js";
import { contrastRatio, parseFont, readableSize } from "../src/film/look";
import { launchHtmlBrowser } from "../src/html/cdp";
import { serveDirectory } from "../src/html/server";
import { findChrome } from "./fixtures/find-chrome";

const chrome = findChrome();
const skip = chrome ? false : "no Chrome for Testing";

/** a width function: CJK and full-width marks 1 em, Latin 0.5 em, spaces 0.25 em */
const em = (s: string, size: number) => {
  let w = 0;
  for (const ch of s) w += /[　-鿿＀-￯]/.test(ch) ? 1 : ch === " " ? 0.25 : 0.5;
  return w * size;
};
const at = (size: number) => (s: string) => em(s, size);

let dir = "";
before(async () => {
  dir = await mkdtemp(join(tmpdir(), "open-take-kit-look-test-"));
});
after(async () => {
  await rm(dir, { recursive: true, force: true });
});

test("parseColor, luminance and contrast agree with the node side", () => {
  assert.deepEqual(parseColor("#e4572e"), { r: 0xe4, g: 0x57, b: 0x2e, a: 1 });
  assert.deepEqual(parseColor("rgb(1 2 3 / 0.5)"), { r: 1, g: 2, b: 3, a: 0.5 });
  assert.deepEqual(parseColor("hsl(0 100% 50%)"), { r: 255, g: 0, b: 0, a: 1 });
  assert.equal(parseColor("not a colour"), null, "no canvas in Node: unknown words are no colour");
  assert.equal(luminance("#ffffff"), 1);
  assert.equal(luminance("#000"), 0);
  assert.equal(contrast("#000", "#fff"), 21);
  for (const [a, b] of [
    ["#20352d", "#ffffff"],
    ["#647169", "#ffffff"],
    ["rgba(255,255,255,0.6)", "#10382e"],
  ])
    assert.ok(Math.abs(contrast(a!, b!) - contrastRatio(a!, b!)) < 0.01, `${a} on ${b}`);
});

test("readable: the kit and the node side say the same", () => {
  assert.deepEqual(readable(72), readableSize(72));
  const r = readable(40);
  assert.equal(r.on[0]!.px, 8.2);
});

test("breakLines: closing marks never start a line, opening ones never end one", () => {
  const w = at(100);
  // 6 em lines: 「找到你的下一間」健身房。
  const lines = breakLines("找到你的下一間健身房，就在這裡。", 600, w, { phrases: false });
  for (const l of lines) {
    assert.ok(!/^[，。」]/.test(l), `"${l}" starts with a closing mark`);
    assert.ok(w(l) <= 600 + 100, `"${l}" is at most one clinging mark over`);
  }
  const quoted = breakLines("一二三四五「六七」", 600, w, { phrases: false });
  for (const l of quoted) assert.ok(!l.endsWith("「"), `"${l}" ends with an opening mark`);
  assert.equal(quoted.join(""), "一二三四五「六七」");
});

test("breakLines: Latin at spaces, a word wider than the line by character, \\n always", () => {
  const w = at(10);
  assert.deepEqual(breakLines("one two three four", 45, w), ["one two", "three", "four"]);
  assert.deepEqual(breakLines("one two three four", 50, w), ["one two", "three four"]);
  const long = breakLines("supercalifragilistic", 50, w);
  assert.ok(long.length >= 2 && long.every((l) => w(l) <= 50));
  assert.equal(long.join(""), "supercalifragilistic");
  assert.deepEqual(breakLines("a\nb", 500, w), ["a", "b"]);
});

test("breakLines keeps a CJK word whole when phrases are on", () => {
  const w = at(100);
  // 健身房 is one word; at 5 em the greedy break would split it after 健身
  const on = breakLines("找到你的健身房", 500, w);
  assert.ok(
    on.some((l) => l.includes("健身房")),
    on.join(" | "),
  );
  const off = breakLines("找到你的健身房", 500, w, { phrases: false });
  assert.deepEqual(off, ["找到你的健", "身房"]);
});

test("fitText: the biggest size within the box and the line limit, lines balanced", () => {
  const box = { width: 1000, height: 400 };
  const one = fitText(box, "找到你的下一間健身房", { measure: em, lines: 1 });
  assert.equal(one.lines.length, 1);
  assert.equal(one.size, 100, "10 em across 1000 px");
  assert.ok(one.fits);
  const two = fitText(box, "找到你的下一間健身房", { measure: em, lines: 2, lineHeight: 1.2 });
  assert.equal(two.lines.length, 2);
  assert.ok(two.size > one.size, `${two.size} > ${one.size}`);
  assert.ok(two.height <= 400 + 0.01);
  // balanced: the two lines are as even as the words allow
  assert.ok(Math.abs(em(two.lines[0]!, two.size) - em(two.lines[1]!, two.size)) <= two.size * 1.01);
  // unbalanced: the first line filled first
  const greedy = fitText({ width: 1000, height: 1000 }, "aa bb cc dd ee ff gg hh ii", {
    measure: em,
    max: 120,
    balance: false,
  });
  const even = fitText({ width: 1000, height: 1000 }, "aa bb cc dd ee ff gg hh ii", {
    measure: em,
    max: 120,
  });
  assert.equal(greedy.size, even.size);
  assert.ok(even.width <= greedy.width);
  assert.match(one.font, /^normal 400 100px\/1.15 /);
  assert.equal(one.readable.filmPx, 100);
});

test("breakLines never breaks inside a Latin run: prices, domains, numbers", () => {
  const w = at(10);
  // "NT$3,176" and "findgym.tw" are segmented into several words, but are one unit to break at
  assert.deepEqual(breakLines("費用 NT$3,176 起", 50, w), ["費用", "NT$3,176", "起"]);
  assert.deepEqual(breakLines("visit findgym.tw now", 60, w), ["visit", "findgym.tw", "now"]);
  // a CJK neighbour or a dash still offers a break
  assert.deepEqual(breakLines("解約要NT$300", 40, w), ["解約要", "NT$300"]);
  assert.deepEqual(breakLines("e-mail", 25, w), ["e-", "mail"]);
});

test("fitText cuts a Latin word by character only when no size fits it whole", () => {
  const box = { width: 1000, height: 400 };
  const r = fitText(box, "Hi supercalifragilisticexpialidocious", { measure: em });
  assert.ok(r.lines.includes("supercalifragilisticexpialidocious"), r.lines.join(" | "));
  assert.ok(r.fits && r.width <= 1000 + 0.01);
  // below `min` it has to cut — and says it fits, at a size that does
  const tight = fitText({ width: 100, height: 400 }, "supercalifragilistic", {
    measure: em,
    min: 12,
  });
  assert.ok(tight.lines.length > 1 && tight.fits && tight.size >= 12);
});

test("fitText says when even the smallest size does not fit", () => {
  const r = fitText({ width: 100, height: 20 }, "a long line of words that cannot fit", {
    measure: em,
    min: 18,
  });
  assert.equal(r.fits, false);
  assert.equal(r.size, 18);
  assert.throws(
    () => fitText({ width: 0, height: 10 }, "x", { measure: em }),
    /width and a height/,
  );
});

test("palette reads look.json roles, fonts and colours", () => {
  const p = palette({
    roles: {
      bg: { hex: "#ffffff" },
      text: { hex: "#20352d" },
      accent: { hex: "#00805f" },
      onAccent: { hex: "#ffffff" },
      muted: { hex: null },
    },
    colours: [{ hex: "#ffffff" }, { hex: "#20352d" }, { hex: "#00805f" }],
    fonts: [
      { family: "Noto Sans TC", webfont: true },
      { family: "Helvetica", webfont: false },
      { family: "Barlow", webfont: true },
    ],
  });
  assert.equal(p.bg, "#ffffff");
  assert.equal(p.get("muted", "#777"), "#777");
  assert.equal(p.get("accent"), "#00805f");
  assert.deepEqual(p.fonts, ["Noto Sans TC", "Barlow"]);
  assert.equal(p.font(), '"Noto Sans TC", sans-serif');
  assert.equal(p.font(5), "sans-serif");
  assert.equal(p.byContrast("#ffffff")[0]!.hex, "#20352d");
  assert.equal(
    p.css(),
    "--look-bg: #ffffff; --look-text: #20352d; --look-accent: #00805f; --look-on-accent: #ffffff;",
  );
});

test("in Chrome: text set at fitText's size with its lines fits the box", { skip }, async () => {
  await mkdir(join(dir, "kit"), { recursive: true });
  await copyFile(join(import.meta.dirname, "..", "kit", "look.js"), join(dir, "kit", "look.js"));
  await writeFile(
    join(dir, "mono.woff2"),
    await readFile(
      join(import.meta.dirname, "fixtures", "fonts", "instrument-sans-latin-wght.woff2"),
    ),
  );
  const cjk = join(import.meta.dirname, "fixtures", "fonts", "noto-sans-tc-slice.woff2");
  await writeFile(join(dir, "han.woff2"), await readFile(cjk));
  // Han characters the slice has, as a title with a closing mark
  const han = `${[...parseFont(await readFile(cjk)).cmap.keys()]
    .filter((cp) => cp >= 0x4e00 && cp <= 0x9fff)
    .slice(0, 13)
    .map((cp) => String.fromCodePoint(cp))
    .join("")}。`;
  await writeFile(
    join(dir, "index.html"),
    `<!doctype html><meta charset="utf-8"><style>@font-face{font-family:Brand;font-weight:100 900;src:url(mono.woff2)}
@font-face{font-family:Han;font-weight:100 900;src:url(han.woff2)}
body{margin:0} #t{position:absolute;left:0;top:0;width:900px;white-space:nowrap}</style><div id="t"></div>
<script type="module">
import { fitText, fontsReady, parseColor } from "./kit/look.js";
window.run = async () => {
  await fontsReady("Brand", [800], "Launch a film without editing it");
  await fontsReady("Han", [700], ${JSON.stringify(han)});
  const box = { width: 900, height: 300 };
  const out = [];
  for (const [text, font, weight, lines] of [
    ["Launch a film without editing it", "Brand", 800, 1],
    ["Launch a film without editing it", "Brand", 800, 2],
    ["Launch a film without editing it", "Brand", 800, 3],
    [${JSON.stringify(han)}, "Han", 700, 1],
    [${JSON.stringify(han)}, "Han", 700, 2],
  ]) {
    const f = fitText(box, text, { font, weight, lines });
    const el = document.getElementById("t");
    el.style.font = f.font;
    el.innerHTML = f.lines.map((l) => "<span>" + l + "</span>").join("<br>");
    const spans = [...el.querySelectorAll("span")].map((s) => s.getBoundingClientRect().width);
    out.push({ font, lines: f.lines.length, size: f.size, widest: Math.max(...spans), height: el.getBoundingClientRect().height, fits: f.fits, text: f.lines.join("|") });
  }
  return { out, named: parseColor("rebeccapurple"), mix: parseColor("color-mix(in srgb, #000 50%, #fff)") };
};
</script>`,
  );
  const server = await serveDirectory(dir);
  const b = await launchHtmlBrowser({
    chromePath: chrome!,
    url: `${server.url}/index.html`,
    width: 1000,
    height: 400,
  });
  try {
    const r = await b.evaluate<{
      out: {
        font: string;
        lines: number;
        size: number;
        widest: number;
        height: number;
        fits: boolean;
        text: string;
      }[];
      named: unknown;
      mix: { r: number } | null;
    }>("window.run()");
    const last = new Map<string, number>();
    for (const x of r.out) {
      assert.ok(x.fits, JSON.stringify(x));
      assert.ok(x.widest <= 900 + 0.5, `${x.font} ${x.lines} line(s): ${x.widest} px wide`);
      assert.ok(x.height <= 300 + 1, `${x.font} ${x.lines} line(s): ${x.height} px tall`);
      assert.ok(x.size >= (last.get(x.font) ?? 0), "more lines allowed never shrinks the size");
      last.set(x.font, x.size);
    }
    // the CJK title: two lines, the closing mark never starting one
    const two = r.out.find((x) => x.font === "Han" && x.lines === 2)!;
    assert.ok(!two.text.split("|")[1]!.startsWith("。"), two.text);
    assert.ok(two.size > r.out.find((x) => x.font === "Han" && x.lines === 1)!.size);
    assert.ok(r.out[0]!.size > 40 && r.out[0]!.size < 120, `one line at ${r.out[0]!.size} px`);
    assert.deepEqual(r.named, { r: 102, g: 51, b: 153, a: 1 });
    assert.ok(r.mix && Math.abs(r.mix.r - 128) <= 1);
  } finally {
    await b.close();
    await server.close();
  }
});
