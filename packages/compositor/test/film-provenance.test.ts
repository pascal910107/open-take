// Where the values on screen come from: the page declares it (kit/time.js
// `tl.source`), the kit reads the product's real values by field
// (kit/media.js `readValues`), `film render` writes the sources into the
// events file, and `film probe` sets the numbers in the film's own text
// beside them and beside components.json — information, never a block or a
// grade; a count's in-between numbers are not listed.

import assert from "node:assert/strict";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
// @ts-expect-error — the kit is plain JS, checked by its own tsconfig
import { partValues } from "../kit/media.js";
import { timeline } from "../kit/time.js";
import { filmProbe } from "../src/film/probe";
import {
  componentValueIndex,
  findComponentFiles,
  formatProvenance,
  numberTokens,
  type ProvenanceSample,
  pageSourcesOf,
  readProvenance,
} from "../src/film/provenance";
import { checkSources, filmEvents, patchEvents, renderFilm } from "../src/film/render";
import { findChrome } from "./fixtures/find-chrome";

/** a components.json of version 2, shaped as the contract has it */
const V2 = {
  version: 2,
  components: [
    {
      ref: "calc-end:e149",
      state: "calc-end",
      el: "e149",
      kind: "stat",
      label: "轉讓 NT$3,376",
      values: {
        price: {
          text: "NT$3,376",
          value: 3376,
          unit: "NT$",
          source: { state: "calc-end", eid: "e150", selector: "#transfer .num" },
        },
        title: { text: "轉讓", source: { state: "calc-end", eid: "e151" } },
      },
      relations: [],
      provenance: { state: "calc-end", url: "https://findgym.example/calc" },
    },
    {
      ref: "calc-end:e155",
      state: "calc-end",
      el: "e155",
      kind: "stat",
      label: "解約 NT$300",
      values: {
        price: { text: "NT$300", value: 300, source: { state: "calc-end", eid: "e156" } },
      },
      relations: [],
      provenance: { state: "calc-end" },
    },
    {
      ref: "calc:e12",
      state: "calc",
      el: "e12",
      kind: "control",
      label: "months",
      values: { months: { text: "14 months", value: 14, source: { state: "calc", eid: "e12" } } },
      relations: [{ kind: "changes", to: "calc-end:e149" }],
      provenance: { state: "calc", capturedAt: "2026-10-08T10:00:00Z" },
    },
    {
      ref: "brands:e7",
      state: "brands",
      el: "e7",
      kind: "heading",
      label: "World Gym",
      values: { name: { text: "World Gym", source: { state: "brands", eid: "e7" } } },
      relations: [],
      provenance: { state: "brands" },
    },
  ],
};

// --- the timeline ---------------------------------------------------------------------

test("tl.source: where a value comes from, as given, into the hooks", () => {
  const tl = timeline({ at: { end: 2 } });
  assert.deepEqual(tl.sources(), []);
  assert.deepEqual(tl.source("NT$3,376", { ref: "calc-end:e149", field: "price" }), {
    label: "NT$3,376",
    ref: "calc-end:e149",
    field: "price",
  });
  tl.source("six listings", { note: "demo", selector: "#market", text: ["6"] });
  tl.source("the monthly fee", { url: "https://x", text: "NT$1,688" });
  assert.throws(() => tl.source("", { note: "demo" }), /needs a label/);
  assert.throws(() => tl.source("x", { field: "price" }), /says nothing of where/);
  assert.throws(() => tl.source("x", undefined as never), /needs \{ ref \}/);
  const list = tl.hooks().sources();
  assert.equal(list.length, 3);
  assert.deepEqual(list[1], {
    label: "six listings",
    note: "demo",
    selector: "#market",
    text: ["6"],
  });
  assert.deepEqual(list[2]!.text, ["NT$1,688"]);
  // a copy: changing it changes nothing kept
  list[2]!.text!.push("y");
  assert.deepEqual(tl.sources()[2]!.text, ["NT$1,688"]);
});

// --- the kit's values ---------------------------------------------------------------------

test("partValues: a part's real values by field, declared once on the timeline", () => {
  const tl = timeline({ at: { end: 2 } });
  const v = partValues(V2, { tl, file: "../shots/components.json" });
  assert.equal(v.version, 2);
  assert.deepEqual(v.refs(), ["calc-end:e149", "calc-end:e155", "calc:e12", "brands:e7"]);
  assert.deepEqual(v.fields("calc-end:e149"), ["price", "title"]);
  assert.equal(v.text("calc-end:e149", "price"), "NT$3,376");
  assert.equal(v.valueOf({ ref: "calc-end:e149" }, "price").value, 3376);
  assert.equal(v.valueOf("calc-end:e149", "price").source.selector, "#transfer .num");
  // read twice, declared once
  v.text("calc-end:e149", "price");
  assert.deepEqual(tl.sources(), [
    { label: "NT$3,376", ref: "calc-end:e149", field: "price", file: "../shots/components.json" },
  ]);
  // a field the part did not show is an error naming what it did show
  assert.throws(
    () => v.valueOf("calc-end:e149", "total"),
    /showed no "total" — it showed: price, title/,
  );
  assert.throws(() => v.values("nope:e1"), /no part nope:e1/);
  assert.deepEqual(v.withField("price"), ["calc-end:e149", "calc-end:e155"]);
  assert.deepEqual(v.relations("calc:e12"), [{ kind: "changes", to: "calc-end:e149" }]);
  assert.deepEqual(v.provenance("calc:e12"), { state: "calc", capturedAt: "2026-10-08T10:00:00Z" });
  // the values handed out are copies
  v.values("calc-end:e149").price.text = "NT$1";
  assert.equal(v.text("calc-end:e149", "price"), "NT$3,376");
  // a version 1 file keeps labels only: no value is made from them
  const v1 = partValues({ version: 1, components: [{ ref: "a:e1", label: "NT$9" }] });
  assert.deepEqual(v1.values("a:e1"), {});
  assert.throws(() => v1.valueOf("a:e1", "price"), /version 1 and keeps no values/);
  assert.throws(() => partValues({ version: 2 }), /not a components.json/);
});

// --- the events file ----------------------------------------------------------------------

test("sources: checked, into the events file, the page's own as it is now on a patch", () => {
  const warnings: string[] = [];
  const s = checkSources(
    [
      { label: "NT$3,376", ref: "calc-end:e149", field: "price", extra: 1 },
      { label: "six", note: "demo", text: "6" },
      { label: "nothing" },
      { ref: "a:e1" },
      null,
    ],
    warnings,
  );
  assert.deepEqual(s, [
    { label: "NT$3,376", ref: "calc-end:e149", field: "price" },
    { label: "six", note: "demo", text: ["6"] },
  ]);
  assert.match(warnings[0]!, /3 source\(s\) without a label/);
  assert.deepEqual(checkSources(null), []);
  const w2: string[] = [];
  assert.deepEqual(checkSources({}, w2), []);
  assert.match(w2[0]!, /not a list/);
  const film = { fps: 30, f0: 0, f1: 60, total: 60 };
  assert.deepEqual(filmEvents(film, [], [], [], false).sources, [], "none: an empty list");
  const master = filmEvents(film, [], [], [], false, [], [], s);
  assert.deepEqual(master.sources, s);
  const range = filmEvents({ ...film, f0: 30 }, [], [], [], false, [], [], [s[1]!]);
  assert.deepEqual(patchEvents(master, range)!.sources, [s[1]]);
});

// --- the probe's reading --------------------------------------------------------------------

test("numbers as written, compared as plain numbers", () => {
  assert.deepEqual(numberTokens("轉讓省 NT$3,076，剩 10 個月 · 4.50% · €12,5"), [
    { raw: "NT$3,076", norm: "3076" },
    { raw: "10", norm: "10" },
    { raw: "4.50%", norm: "4.5" },
    { raw: "€12,5", norm: "12.5" },
  ]);
  assert.deepEqual(numberTokens("no digits"), []);
});

test("the film's numbers beside its sources and the parts: declared, matched, none; a count's in-between left out", async () => {
  const dir = await mkdtemp(join(tmpdir(), "open-take-prov-"));
  try {
    await mkdir(join(dir, "shots"), { recursive: true });
    await writeFile(join(dir, "shots", "components.json"), JSON.stringify(V2));
    await mkdir(join(dir, "node_modules", "x"), { recursive: true });
    await writeFile(join(dir, "node_modules", "x", "components.json"), "{}");
    const files = findComponentFiles({ pageDir: dir, base: dir, sources: [] });
    assert.deepEqual(files, [join(dir, "shots", "components.json")]);
    const index = componentValueIndex(files);
    assert.deepEqual(
      index.files.map((f) => [f.version, f.parts, f.values]),
      [[2, 4, 5]],
    );
    const it = (k: number, text: string, cov: number[] = []) => ({ k, text, cov });
    // 1: a count from 0 to the real total, then held; 2: a number no part
    // showed; 3: a real number nobody declared; 4: a demo block, by selector;
    // 5: a caption without digits that reads as a part's value; 6: a number
    // shown once as its element leaves
    const samples: ProvenanceSample[] = [
      { t: 0, items: [it(1, "NT$0"), it(5, "World Gym")] },
      { t: 0.5, items: [it(1, "NT$1,200"), it(5, "World Gym"), it(4, "6 listings", [1])] },
      { t: 1, items: [it(1, "NT$2,400"), it(4, "6 listings", [1])] },
      { t: 1.5, items: [it(1, "NT$3,376"), it(2, "轉讓省 NT$3,076"), it(6, "剩 10 個月")] },
      { t: 2, items: [it(1, "NT$3,376"), it(2, "轉讓省 NT$3,076"), it(3, "NT$300")] },
      { t: 2.5, items: [it(1, "NT$3,376"), it(3, "NT$300")] },
    ];
    const sources = [
      { label: "the transfer total", ref: "calc-end:e149", field: "price" },
      { label: "six listings", note: "demo", selector: "#market" },
      { label: "a page nobody shows", url: "https://x" },
      { label: "x", ref: "gone:e1" },
    ];
    const p = readProvenance(samples, { sources, sourcesFrom: "page", index, every: 0.5 });
    assert.equal(p.how, "measured");
    const row = (text: string) => p.values.filter((v) => v.text === text);
    assert.deepEqual(
      row("NT$3,376").map((v) => [v.how, v.spans, v.sources]),
      [["declared", [[1.5, 3]], ["the transfer total"]]],
    );
    assert.equal(row("NT$0").length, 0, "the count's start is the film's, not the product's");
    assert.equal(row("NT$1,200").length + row("NT$2,400").length, 0);
    assert.deepEqual(p.between, { values: 3, elements: 1 });
    assert.deepEqual(
      row("NT$3,076").map((v) => [v.how, v.in]),
      [["no source declared", "轉讓省 NT$3,076"]],
    );
    assert.deepEqual(
      row("NT$300").map((v) => [v.how, v.parts]),
      [["matches a part", ["calc-end:e155 price"]]],
    );
    assert.deepEqual(
      row("6").map((v) => [v.how, v.sources, v.spans]),
      [["declared", ["six listings"], [[0.5, 1.5]]]],
    );
    assert.deepEqual(
      row("10").map((v) => v.how),
      ["no source declared"],
      "shown as it left",
    );
    assert.deepEqual(p.strings, [
      { text: "World Gym", spans: [[0, 1]], parts: ["brands:e7 name"] },
    ]);
    assert.deepEqual(
      p.sources.list.map((s) => [s.label, s.seen, s.part]),
      [
        ["the transfer total", [], "in components.json"],
        ["six listings", [[0.5, 1.5]], undefined],
        ["a page nobody shows", [], undefined],
        ["x", [], "not in the components.json read"],
      ],
    );
    const md = formatProvenance(p, dir).join("\n");
    assert.match(
      md,
      /components.json read: shots\/components.json \(version 2, 4 parts, 5 values\)/,
    );
    assert.match(md, /- declared: NT\$3,376 1\.50s–3\.00s \("the transfer total"\)/);
    assert.match(md, /- no source declared: NT\$3,076 1\.50s–2\.50s in "轉讓省 NT\$3,076"/);
    assert.match(md, /- matches a part: NT\$300 2\.00s–3\.00s \(calc-end:e155 price\)/);
    assert.match(md, /"a page nobody shows" — url https:\/\/x — not seen/);
    assert.match(md, /In-between numbers .*: 3 in 1 element/);
    assert.doesNotMatch(md, /\bscore\b|\bpass\b|\bgrade|\bfail|must|should/i);
    // no page: the sources only, said so
    const none = readProvenance(null, {
      sources,
      sourcesFrom: "events file",
      index: componentValueIndex([]),
      every: 0.5,
      note: "no page given (--page)",
    });
    assert.equal(none.how, "not measured");
    assert.equal(none.sources.list[0]!.part, "no components.json read");
    assert.match(formatProvenance(none).join("\n"), /\[not measured\] .*no page given/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("the page's sources over the film: one declared late is kept, and an element's cover follows its source", async () => {
  const late = { label: "NT$3,376", ref: "calc-end:e149", field: "price" };
  const bad = { label: "", note: "demo", selector: "#x" };
  const demo = { label: "six", note: "demo", selector: "#market" };
  const r = pageSourcesOf([
    { t: 0, items: [{ k: 1, text: "6 listings", cov: [1] }], sources: [bad, demo] },
    { t: 0.5, items: [{ k: 1, text: "6 listings", cov: [1] }], sources: [bad, demo, late] },
    { t: 1, items: [{ k: 2, text: "NT$3,376", cov: [0] }], sources: [bad, demo, late] },
  ]);
  assert.ok(r);
  assert.deepEqual(r.sources, [demo, late]);
  assert.deepEqual(
    r.samples.map((s) => s.items[0]!.cov),
    [[0], [0], []],
    "renumbered to the checked list; the left-out entry covers nothing",
  );
  assert.equal(pageSourcesOf([{ t: 0, items: [] }]), null);
  const d = await mkdtemp(join(tmpdir(), "open-take-prov-root-"));
  try {
    await mkdir(join(d, "shots"), { recursive: true });
    await mkdir(join(d, "film"), { recursive: true });
    await writeFile(join(d, "shots", "components.json"), "{}");
    assert.deepEqual(
      findComponentFiles({
        pageDir: join(d, "film"),
        root: d,
        base: d,
        sources: [{ label: "x", ref: "a:e1", file: "/shots/components.json?v=2" }],
      }),
      [join(d, "shots", "components.json")],
      "a path from the served root",
    );
  } finally {
    await rm(d, { recursive: true, force: true });
  }
});

// --- the whole way, in Chrome -------------------------------------------------------------

const chrome = findChrome();
let dir = "";
before(async () => {
  dir = await mkdtemp(join(tmpdir(), "open-take-prov-film-"));
});
after(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});

test("a film fills a part it draws with real values: render writes the sources, probe sets the numbers beside them", {
  skip: chrome ? false : "no Chrome for Testing",
}, async () => {
  const page = join(dir, "page");
  await mkdir(join(page, "kit"), { recursive: true });
  await mkdir(join(dir, "shots"), { recursive: true });
  await writeFile(join(dir, "shots", "components.json"), JSON.stringify(V2));
  for (const f of ["time.js", "media.js"])
    await copyFile(join(import.meta.dirname, "..", "kit", f), join(page, "kit", f));
  await writeFile(
    join(page, "index.html"),
    `<!doctype html><html><head><style>body{margin:0;width:320px;height:180px;overflow:hidden;background:#fff;font:20px sans-serif}
div{position:absolute;left:10px}</style></head><body>
<div id="total" style="top:10px"></div><div id="made" style="top:50px">省 NT$3,076</div>
<div id="real" style="top:90px"></div><div id="demo" style="top:130px">6 listings</div>
<script type="module">
import { timeline } from "./kit/time.js";
import { readValues } from "./kit/media.js";
const tl = timeline({ at: { end: 2 } });
tl.source("six listings", { note: "demo", selector: "#demo" });
const v = await readValues("../shots/components.json", { tl });
const to = v.valueOf("calc-end:e149", "price").value;
const plain = await readValues("../shots/components.json");
document.getElementById("real").textContent = plain.text("calc-end:e155", "price");
window.__film = { duration: 2, width: 320, height: 180, fps: 10, ...tl.hooks() };
window.__render = (t) => {
  const p = Math.min(1, t / 0.6);
  document.getElementById("total").textContent = "NT$" + Math.round(to * p).toLocaleString("en-US");
};
</script></body></html>`,
  );
  const out = join(dir, "film.mp4");
  const r = await renderFilm({
    page,
    root: dir,
    out,
    chromePath: chrome!,
    blur: false,
    audio: null,
    workers: 1,
  });
  const ev = JSON.parse(await readFile(r.events!, "utf8"));
  assert.deepEqual(ev.sources, [
    { label: "six listings", note: "demo", selector: "#demo" },
    { label: "NT$3,376", ref: "calc-end:e149", field: "price", file: "../shots/components.json" },
  ]);
  const pr = await filmProbe({
    input: out,
    page,
    root: dir,
    chromePath: chrome!,
    text: false,
    textEvery: 0.2,
    out: join(dir, "film.probe"),
  });
  const p = pr.probe.provenance;
  assert.equal(p.sources.from, "page");
  assert.deepEqual(
    p.components.map((c) => c.file),
    [join(dir, "shots", "components.json")],
  );
  const how = (text: string) => p.values.filter((x) => x.text === text).map((x) => x.how);
  assert.deepEqual(how("NT$3,376"), ["declared"]);
  assert.deepEqual(how("NT$3,076"), ["no source declared"]);
  assert.deepEqual(how("NT$300"), ["matches a part"], "read from the file without a timeline");
  assert.deepEqual(how("6"), ["declared"]);
  assert.ok(p.between.values >= 2, `the count's in-between numbers: ${JSON.stringify(p.between)}`);
  assert.ok(!p.values.some((x) => x.text === "NT$0"), JSON.stringify(p.values));
  const md = await readFile(pr.md, "utf8");
  assert.match(md, /## Where the values on screen come from\n\[measured\]/);
});
