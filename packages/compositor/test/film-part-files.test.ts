// The part files' Node half (src/film/part-files.ts) on the small synthetic
// shoot: what a screen's page gave (states/<id>/parts-dom.json, written here
// as the runtime writes it) becomes one standalone HTML file per part, with
// the page's @font-face rules for the families it uses (from its own
// <style>, its linked stylesheets and what they @import) relative to the
// parts folder, a header saying where it came from, and parts/index.json;
// every part that is not a file is in `skipped` with its reason. No browser
// (the page half runs against Chrome in runtime/test/shoot-browser.test.ts).

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { gatherComponents, readComponentSource } from "../src/film/components";
import {
  type PartFilesIndex,
  partFileName,
  partFilesLine,
  stateFontFaces,
  writePartFiles,
} from "../src/film/part-files";
import { writePartDom, writePartsShoot } from "./fixtures/parts-shoot";

function shoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "open-take-part-files-"));
  writePartsShoot(dir);
  writePartDom(dir);
  return dir;
}

test("stateFontFaces: a saved screen's @font-face rules from its <style>, its links and their @imports, relative to where they go", () => {
  const dir = shoot();
  try {
    const faces = stateFontFaces(join(dir, "states", "home"), join(dir, "parts"));
    const by = Object.fromEntries(faces.map((f) => [f.key, f]));
    assert.deepEqual(Object.keys(by).sort(), ["brand sans", "mono", "unused"]);
    assert.equal(by["brand sans"]!.family, "Brand Sans");
    assert.match(
      by["brand sans"]!.css,
      /src:url\("\.\.\/states\/assets\/font\.woff2"\) format\("woff2"\)/,
    );
    assert.match(
      by.mono!.css,
      /url\("\.\.\/states\/assets\/mono\.woff2"\)/,
      "from the @imported sheet",
    );
    assert.match(
      by.unused!.css,
      /url\("\.\.\/states\/assets\/none\.woff2"\)/,
      "from the page's own <style>",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("writePartFiles: a file per part the page gave, the rest skipped with their reasons, and index.json", () => {
  const dir = shoot();
  try {
    const source = readComponentSource(dir);
    const file = gatherComponents(source);
    const r = writePartFiles(file, source, join(dir, "parts"));
    assert.equal(r.written, 2);
    assert.equal(r.dir, join(dir, "parts"));
    const index = JSON.parse(readFileSync(r.index, "utf8")) as PartFilesIndex;
    assert.equal(index.version, 1);
    assert.equal(index.components, "../components.json");
    assert.deepEqual(
      index.parts.map((p) => [p.file, p.ref, p.kind, p.w, p.h, p.fonts]),
      [
        ["home-e2-heading.html", "home:e2", "heading", 200, 30, ["Brand Sans"]],
        ["home-e4-number.html", "home:e4", "number", 80, 40, ["Mono"]],
      ],
    );
    assert.deepEqual(index.parts[1]!.values, { text: "3", number: "3" });
    // every other part of components.json, each with why
    assert.equal(index.parts.length + index.skipped.length, file.components.length);
    assert.match(index.skipped.find((s) => s.ref === "home:e3")!.why, /it holds an <iframe>/);
    assert.match(
      index.skipped.find((s) => s.ref === "add-1:e2")!.why,
      /saved before parts were kept as files \(no parts-dom\.json\)/,
    );
    assert.equal(
      partFilesLine(r, "shots/parts"),
      `parts: 2 parts as files in shots/parts/ (index.json) — each opens alone at any size, in the product's styles; ${index.skipped.length} skipped, each with its reason in index.json`,
    );

    const h1 = readFileSync(join(dir, "parts", "home-e2-heading.html"), "utf8");
    assert.match(
      h1,
      /^<!doctype html>\n<!--\n {2}Counter — a heading of http:\/\/127\.0\.0\.1:9\/counter\.html/,
    );
    assert.match(h1, /\n {2}source: {3}http:\/\/127\.0\.0\.1:9\/counter\.html\n/);
    assert.match(h1, /\n {2}state: {4}home \(\.\.\/states\/home\/state\.html\)\n/);
    assert.match(h1, /\n {2}selector: h1\n/);
    assert.match(h1, /\n {2}values: {3}\{"text":"Counter"\}\n/);
    assert.match(h1, /\n {2}captured: \d{4}-/);
    assert.match(h1, /<iframe src="parts\/home-e2-heading\.html" width="200" height="30"/);
    assert.match(h1, /:root\{--part-w:200px;--part-h:30px;--part-backdrop:#ffffff\}/);
    assert.match(h1, /<body data-w="200" data-h="30" data-ref="home:e2" data-kind="heading">/);
    assert.match(
      h1,
      /<style data-part-fonts>\n@font-face\{font-family:"Brand Sans";src:url\("\.\.\/states\/assets\/font\.woff2"\)/,
    );
    assert.ok(!h1.includes("Mono") && !h1.includes("Unused"), "only the fonts it uses");

    const n = readFileSync(join(dir, "parts", "home-e4-number.html"), "utf8");
    assert.match(
      n,
      /background-image:url\(&quot;\.\.\/states\/assets\/pic\.svg&quot;\)/,
      "saved files, from the parts folder",
    );
    assert.match(n, /<img src="\.\.\/states\/assets\/pic\.svg"/);
    assert.match(n, /<body data-w="80" data-h="40"/, "a fractional size rounds up");
    assert.match(n, /\[data-ot-p="1"\]::before\{content:"--> \$"\}/);
    // the header's comment ends only where it should
    assert.equal(n.indexOf("-->"), n.indexOf("\n-->\n") + 1);

    // written again: the folder is replaced, not added to
    writeFileSync(join(dir, "parts", "home-old-text.html"), "old");
    writePartFiles(file, source, join(dir, "parts"));
    assert.ok(!existsSync(join(dir, "parts", "home-old-text.html")));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("writePartFiles: a parts folder that is someone else's is refused, not replaced", () => {
  const dir = shoot();
  try {
    mkdirSync(join(dir, "parts"));
    writeFileSync(join(dir, "parts", "mine.txt"), "mine");
    const source = readComponentSource(dir);
    assert.throws(
      () => writePartFiles(gatherComponents(source), source, join(dir, "parts")),
      /holds something else than part files/,
    );
    assert.ok(existsSync(join(dir, "parts", "mine.txt")));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("partFileName: <state>-<el>-<kind>.html, safe as a file name", () => {
  assert.equal(partFileName({ state: "home", el: "e12", kind: "card" }), "home-e12-card.html");
  assert.equal(partFileName({ state: "a b/c", el: "e1", kind: "text" }), "a_b_c-e1-text.html");
});
