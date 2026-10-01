// DOM states, the pure half: the MHTML → state.html converter on a synthetic
// archive shaped like Chrome's (quoted-printable document, base64 resources,
// cid: parts, an adopted-stylesheet link after </body>), plus the fidelity
// arithmetic and the event→element matcher. No browser here — the capture
// and restore paths run against real Chrome in dom-state-browser.test.ts.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  comparePixels,
  convertMhtml,
  type DomStateProbe,
  decodeQuotedPrintable,
  INERT_SCRIPT,
  matchTarget,
  parseMhtml,
  parseSrcset,
  stillOutside,
} from "../src/dom-state";

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==",
  "base64",
);
const FONT = Buffer.from("wOF2-not-really-a-font");
const sha1 = (b: Buffer) => createHash("sha1").update(b).digest("hex");
const B = "----MultipartBoundary--test----";
const CRLF = "\r\n";

/** quoted-printable the way Chrome writes it: `=` escaped, lines soft-broken
 *  short (never inside an escape) */
const qp = (s: string) =>
  s
    .split("\n")
    .map((line) => {
      const tokens = line.replace(/=/g, "=3D").match(/=3D|[^=]/g) ?? [];
      const out: string[] = [];
      let cur = "";
      for (const t of tokens) {
        if (cur.length + t.length > 70) {
          out.push(cur);
          cur = "";
        }
        cur += t;
      }
      out.push(cur);
      return out.join(`=${CRLF}`);
    })
    .join(CRLF);

const part = (headers: string[], body: string) =>
  `--${B}${CRLF}${headers.join(CRLF)}${CRLF}${CRLF}${body}${CRLF}`;

const DOC = `<!DOCTYPE html><html><head><meta http-equiv="Content-Type" content="text/html; charset=UTF-8"><script src="cid:js-shim@mhtml.blink"></script><title>t</title>
<link rel="stylesheet" crossorigin href="http://app.test/style.css" integrity="sha384-x"><meta http-equiv="refresh" content="5"><base href="http://app.test/sub/"></head>
<body>
<div id="root" style="background:url(/img.png)"><button onclick="go()" onmouseover="hi()">Go</button><img src="http://app.test/img.png" srcset="http://app.test/img.png 1x, http://app.test/missing.png 2x"><picture><source srcset="/nope.png 2x"><img src="http://app.test/img.png"></picture><script>alert(1)</script><span>after</span><iframe src="cid:frame-child@mhtml.blink"></iframe><div id="host"><template shadowmode="open"><b>s</b></template><i>light</i></div><img src="http://app.test/dup.png" crossorigin="anonymous"><a href="http://app.test/x">x</a></div>
<svg><defs><clipPath id="clip"><rect width="9" height="9"/></clipPath><symbol id="icon"><circle r="4"/></symbol></defs><use href="#icon"></use><use href="http://app.test/icons.svg#check"></use></svg>
<style>.hero{background:url("/img.png")}.gone{background:url("http://app.test/gone.png")}.clipped{clip-path:url(#clip)}.masked{mask:url(/icons.svg#check)}</style>
<script type="application/json">{"a":1}</script>
</body><link rel="stylesheet" type="text/css" href="cid:css-adopted@mhtml.blink" /></html>`;

const SVG = `<svg xmlns="http://www.w3.org/2000/svg"><symbol id="check"><path d="M0 0h4v4z"/></symbol></svg>`;

function archive(): string {
  return (
    [
      "From: <Saved by Blink>",
      "Snapshot-Content-Location: http://app.test/",
      "Subject: t",
      "MIME-Version: 1.0",
      "Content-Type: multipart/related;",
      '\ttype="text/html";',
      `\tboundary="${B}"`,
      "",
      "",
    ].join(CRLF) +
    part(
      [
        "Content-Type: text/html",
        "Content-ID: <frame-main@mhtml.blink>",
        "Content-Transfer-Encoding: quoted-printable",
        "Content-Location: http://app.test/",
      ],
      qp(DOC),
    ) +
    part(
      [
        "Content-Type: text/css",
        "Content-Transfer-Encoding: quoted-printable",
        "Content-Location: http://app.test/style.css",
      ],
      qp(
        `@import url('/more.css');\n@font-face{font-family:F;src:url("fonts/f.woff2") format("woff2")}\nbody{background:url(/img.png)}`,
      ),
    ) +
    part(
      [
        "Content-Type: text/css",
        "Content-Transfer-Encoding: quoted-printable",
        "Content-Location: http://app.test/more.css",
      ],
      qp("p{color:red}"),
    ) +
    part(
      [
        "Content-Type: font/woff2",
        "Content-Transfer-Encoding: base64",
        "Content-Location: http://app.test/fonts/f.woff2",
      ],
      FONT.toString("base64"),
    ) +
    part(
      [
        "Content-Type: image/png",
        "Content-Transfer-Encoding: base64",
        "Content-Location: http://app.test/img.png",
      ],
      PNG.toString("base64"),
    ) +
    part(
      [
        "Content-Type: image/png",
        "Content-Transfer-Encoding: base64",
        "Content-Location: http://app.test/dup.png",
      ],
      PNG.toString("base64"),
    ) +
    part(
      [
        "Content-Type: image/svg+xml",
        "Content-Transfer-Encoding: quoted-printable",
        "Content-Location: http://app.test/icons.svg",
      ],
      qp(SVG),
    ) +
    part(
      [
        "Content-Type: text/css",
        "Content-Transfer-Encoding: quoted-printable",
        "Content-Location: cid:css-adopted@mhtml.blink",
      ],
      qp(".adopted{color:blue}"),
    ) +
    part(
      [
        "Content-Type: text/html",
        "Content-ID: <frame-child@mhtml.blink>",
        "Content-Transfer-Encoding: quoted-printable",
        "Content-Location: http://app.test/frame.html",
      ],
      qp(
        `<html><head><script src="cid:js-shim@mhtml.blink"></script></head><body><p onload="x()">frame</p><img src="http://app.test/img.png"></body></html>`,
      ),
    ) +
    part(
      [
        "Content-Type: text/javascript",
        "Content-Transfer-Encoding: quoted-printable",
        "Content-Location: cid:js-shim@mhtml.blink",
      ],
      qp("(()=>{})();"),
    ) +
    `--${B}--${CRLF}`
  );
}

const probe: DomStateProbe = {
  url: "http://app.test/",
  title: "t",
  viewport: { w: 800, h: 600, dpr: 2 },
  scroll: { x: 0, y: 40 },
  elements: [
    { id: "e0", path: [], tag: "html", box: [0, 0, 800, 600] },
    {
      id: "e1",
      path: [1, 0, 0],
      tag: "button",
      role: "button",
      name: "Go",
      text: "Go",
      box: [8, 8, 40, 20],
      interactive: true,
    },
  ],
  layers: ["e1"],
  scrolled: [{ path: [1, 0], top: 12, left: 0 }],
  inputs: [{ path: [1, 0, 1], value: 'typed </script> "x"' }],
  canvases: [],
  videos: [],
  animated: [{ path: [1, 0], styles: { opacity: "1" } }],
  custom: [{ name: "my-el" }],
};

test("parseMhtml: boundary, part headers, quoted-printable + base64 bodies", () => {
  const parts = parseMhtml(archive());
  assert.equal(parts.length, 10);
  assert.equal(parts[0]!.contentType, "text/html");
  assert.equal(parts[0]!.id, "frame-main@mhtml.blink");
  assert.equal(parts[0]!.location, "http://app.test/");
  assert.ok(
    parts[0]!.body.toString("utf8").includes('<base href="http://app.test/sub/">'),
    "QP soft breaks + =3D decoded",
  );
  const png = parts.find((p) => p.location === "http://app.test/img.png")!;
  assert.ok(png.body.equals(PNG), "base64 body decoded to the original bytes");
  assert.equal(decodeQuotedPrintable("a=3Db=\r\nc=\nd=20").toString("latin1"), "a=bcd ");
});

test("convertMhtml: scripts inert in place, on* gone, refs → ../assets/<sha1>.<ext>, dedupe, freeze + restore appended", async () => {
  const dir = await mkdtemp(join(tmpdir(), "open-take-dom-state-"));
  try {
    const assetsDir = join(dir, "assets");
    const { html, assets, unresolved } = convertMhtml(archive(), probe, { assetsDir });

    // every script became the inert twin, at its place: the inline one still sits between the picture and the span
    const scripts = html.match(/<script[^>]*>/g) ?? [];
    assert.equal(scripts.length, 4, "3 original scripts + our restore script");
    assert.equal(
      scripts.filter((s) => s === '<script type="application/x-open-take-inert">').length,
      3,
    );
    assert.ok(
      !html.includes("alert(1)") && !html.includes('{"a":1}') && !html.includes("cid:js-shim"),
      "script bodies and srcs are gone",
    );
    assert.match(
      html,
      new RegExp(
        `</picture>${INERT_SCRIPT.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\\\$&")}<span>after</span>`,
      ),
    );
    assert.ok(!/\son[a-z]+=/i.test(html), "no on* attributes survive");

    // resources: the stylesheet (rewritten, then hashed), its import, the font, the image
    const cssName = readdirSync(assetsDir).find(
      (f) => f.endsWith(".css") && readFileSync(join(assetsDir, f), "utf8").includes("@font-face"),
    )!;
    assert.ok(cssName, "style.css written as an asset");
    assert.match(
      html,
      new RegExp(`<link rel="stylesheet" href="\\.\\./assets/${cssName}">`),
      "link rewritten; crossorigin (a file:// CORS request is refused) and integrity dropped",
    );
    const css = readFileSync(join(assetsDir, cssName), "utf8");
    assert.ok(
      css.includes(`url("../assets/${sha1(FONT)}.woff2")`),
      `font url rewritten relative to the sheet: ${css}`,
    );
    assert.ok(css.includes(`url(../assets/${sha1(PNG)}.png)`), "image url in CSS rewritten");
    assert.match(css, /@import url\('\.\.\/assets\/[0-9a-f]{40}\.css'\)/, "@import rewritten");
    assert.ok(
      existsSync(join(assetsDir, `${sha1(FONT)}.woff2`)) &&
        existsSync(join(assetsDir, `${sha1(PNG)}.png`)),
    );

    // dedupe: img.png and dup.png are the same bytes → one file, both references point at it
    assert.equal(assets.filter((a) => a.endsWith(".png")).length, 1);
    assert.equal(
      (html.match(new RegExp(`src="\\.\\./assets/${sha1(PNG)}\\.png"`, "g")) ?? []).length,
      3,
      "img, picture img, dup img",
    );
    assert.ok(!/crossorigin|integrity/i.test(html), "no CORS/SRI attribute survives");
    // a network reference the snapshot did not carry loads nothing, ever
    assert.ok(html.includes('.gone{background:url("about:blank")}'), "missing resource cut off");
    assert.ok(!html.includes("gone.png"));

    // a place in the document stays as it is; a place in another file stays on its copy
    const icons = `../assets/${sha1(Buffer.from(SVG))}.svg`;
    assert.ok(html.includes('<use href="#icon">'), "a symbol in the document");
    assert.ok(html.includes(`<use href="${icons}#check">`), `a symbol in a sprite file`);
    assert.ok(html.includes(".clipped{clip-path:url(#clip)}"), "a clip path in the document");
    assert.ok(html.includes(`.masked{mask:url(${icons}#check)}`), "a mask in a sprite file");

    // srcset keeps only candidates that travelled; a source with none loses the attribute
    assert.ok(
      html.includes(`srcset="../assets/${sha1(PNG)}.png 1x"`),
      "unresolved 2x candidate pruned",
    );
    assert.ok(html.includes("<source>"), "source srcset with no local candidate dropped");
    assert.equal(unresolved, 3, "missing.png + nope.png + gone.png counted as cut off");

    // inline style + <style> content resolved against the <base>; base href dropped
    assert.ok(html.includes(`style="background:url(../assets/${sha1(PNG)}.png)"`));
    assert.ok(html.includes(`.hero{background:url("../assets/${sha1(PNG)}.png")}`));
    assert.ok(html.includes("<base>") && !html.includes("app.test/sub"), "base href removed");

    // metas neutralised, shadow template made declarative, cid iframe → html asset, adopted sheet link rewritten
    assert.ok(html.includes('<meta data-ot-stripped-http-equiv="refresh" content="5">'));
    assert.ok(html.includes('<template shadowrootmode="open"><b>s</b></template><i>light</i>'));
    const frame = /<iframe src="\.\.\/assets\/([0-9a-f]{40}\.html)"/.exec(html);
    assert.ok(frame, "iframe cid rewritten to an html asset");
    const frameHtml = readFileSync(join(assetsDir, frame![1]!), "utf8");
    assert.ok(
      frameHtml.includes(INERT_SCRIPT) &&
        !frameHtml.includes("onload") &&
        frameHtml.includes("data-ot-freeze"),
    );
    assert.ok(frameHtml.includes(`src="../assets/${sha1(PNG)}.png"`), "frame refs resolved too");
    assert.match(
      html,
      /<link rel="stylesheet" type="text\/css" href="\.\.\/assets\/[0-9a-f]{40}\.css" \/>/,
    );

    // our additions sit at the END of head and after everything in body
    assert.match(html, /<style data-ot-freeze>[^<]*animation:none!important[^<]*<\/style><\/head>/);
    assert.match(html, /<script data-ot-restore>[\s\S]*<\/script>\n<\/html>$/);
    assert.ok(
      html.includes('"value":"typed \\u003c/script> \\"x\\""'),
      "probe JSON embedded with < escaped",
    );
    assert.ok(html.includes('"custom":[{"name":"my-el"}]'));
    // the original document's head/body markup is otherwise untouched (no element added before an existing one)
    assert.ok(
      html.startsWith(
        '<!DOCTYPE html><html><head><meta http-equiv="Content-Type" content="text/html; charset=UTF-8">',
      ),
      `head prefix: ${html.slice(0, 160)}`,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("parseSrcset: url + descriptor pairs, trailing commas, data URLs", () => {
  assert.deepEqual(parseSrcset("/a.png 1x, /b.png 2x"), [
    { url: "/a.png", descriptor: "1x" },
    { url: "/b.png", descriptor: "2x" },
  ]);
  assert.deepEqual(parseSrcset("/a.png"), [{ url: "/a.png", descriptor: "" }]);
  assert.deepEqual(parseSrcset("/a.png 100w,/b.png 200w"), [
    { url: "/a.png", descriptor: "100w" },
    { url: "/b.png", descriptor: "200w" },
  ]);
  assert.deepEqual(parseSrcset("data:image/png;base64,AAAA 1x"), [
    { url: "data:image/png;base64,AAAA", descriptor: "1x" },
  ]);
});

test("comparePixels: identical → 99 dB / 0 diff; a changed pixel counts once it exceeds 8 on a channel", () => {
  const a = new Uint8Array(3 * 100).fill(120);
  assert.deepEqual(comparePixels(a, a), { psnr: 99, diffFrac: 0 });
  const b = new Uint8Array(a);
  b[0] = 128; // +8: not a differing pixel, but it costs PSNR
  const r1 = comparePixels(a, b);
  assert.equal(r1.diffFrac, 0);
  assert.ok(r1.psnr < 99 && r1.psnr > 50);
  b[1] = 140; // +20 on a second channel of the same pixel
  const r2 = comparePixels(a, b);
  assert.equal(r2.diffFrac, 0.01);
  // PSNR by hand: mse = (64 + 400) / 300 ≈ 1.5467 → 10·log10(65025 / 1.5467)
  assert.ok(Math.abs(r2.psnr - 10 * Math.log10(65025 / (464 / 300))) < 0.01, `psnr ${r2.psnr}`);
});

test("matchTarget: the best IoU ≥ 0.5 wins, below it nothing matches", () => {
  const elements = [
    { id: "e0", path: [], tag: "html", box: [0, 0, 800, 600] as [number, number, number, number] },
    {
      id: "e1",
      path: [1, 0],
      tag: "button",
      box: [100, 100, 120, 40] as [number, number, number, number],
    },
    {
      id: "e2",
      path: [1, 1],
      tag: "span",
      box: [100, 100, 60, 40] as [number, number, number, number],
    },
  ];
  assert.equal(matchTarget({ x: 100, y: 100, w: 120, h: 40 }, elements), "e1");
  assert.equal(
    matchTarget({ x: 102, y: 101, w: 116, h: 38 }, elements),
    "e1",
    "a near-identical box still matches",
  );
  assert.equal(
    matchTarget({ x: 100, y: 100, w: 60, h: 40 }, elements),
    "e2",
    "the tighter element outranks the container",
  );
  assert.equal(
    matchTarget({ x: 400, y: 400, w: 20, h: 20 }, elements),
    undefined,
    "nothing overlaps enough",
  );
});

test("comparePixels leaves out masked boxes; stillOutside ignores what moves on its own", async () => {
  // 4×2 RGB, one pixel (x=3, y=1) differs
  const a = new Uint8Array(4 * 2 * 3).fill(100);
  const b = new Uint8Array(a);
  b[(1 * 4 + 3) * 3] = 250;
  assert.ok(comparePixels(a, b).psnr < 30);
  assert.equal(comparePixels(a, b, { width: 4, boxes: [[3, 1, 1, 1]] }).psnr, 99);
  // 3×2 RGBA images; the viewport is 3 CSS px wide, so 1 image px = 1 CSS px
  const img = (px: number[]) => ({ w: 3, h: 2, ch: 4, data: new Uint8Array(px) });
  const base = Array.from({ length: 24 }, (_, i) => (i % 4 === 3 ? 255 : 40));
  // one pixel changing is below what counts as motion
  const blink = [...base];
  blink[8] = 200;
  assert.equal(stillOutside(img(base), img(blink), [], 3, 0), true);
  // three pixels in the right column (x=2) and the bottom row change: moving —
  // unless they are all inside a box that moves on its own
  const moved = [...base];
  for (const i of [8, 20, 16]) moved[i] = 200;
  assert.equal(stillOutside(img(base), img(moved), [], 3, 0), false);
  assert.equal(stillOutside(img(base), img(moved), [[1, 0, 2, 2]], 3, 0), true);
});
