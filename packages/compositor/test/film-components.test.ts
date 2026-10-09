// The component inventory's gather (src/film/components.ts) on real saved
// screens: j01's findgym shoots (calc: a slider drag that changes the
// numbers; home: the membership wizard, clicked) and a small take
// (make --states on a bill splitter). Fixtures hold each state's index.json
// and the parts.json the component probe measured in Chrome — this test
// needs no browser.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  COMPONENT_ORDER,
  type ComponentsFile,
  componentCounts,
  componentsLine,
  exampleSource,
  FOLLOWED_SHOWN,
  fitOf,
  followedLine,
  formatComponents,
  gatherComponents,
  partsLine,
  phoneOf,
  readComponentSource,
  readNumber,
  writeComponents,
} from "../src/film/components";
import { writePartsShoot } from "./fixtures/parts-shoot";

const FIX = join(import.meta.dirname, "fixtures", "components");
const calc = () => gatherComponents(readComponentSource(join(FIX, "j01-calc")));
const entry = (f: ComponentsFile, ref: string) => {
  const e = f.components.find((x) => x.ref === ref);
  assert.ok(e, `${ref} is in the inventory`);
  return e!;
};

test("a shoot: screens in log order, with the action that led to each", () => {
  const src = readComponentSource(join(FIX, "j01-calc"));
  assert.equal(src.kind, "shoot");
  assert.deepEqual(
    src.states.map((s) => s.id),
    ["calc", "slide", "calc-end"],
  );
  assert.equal(src.states[0]!.action, undefined);
  // the drag's still: its point is read in the screen before it
  assert.deepEqual(src.states[1]!.action, {
    kind: "drag",
    label: "slide",
    point: { x: 743.13, y: 1164.8, in: "before" },
  });
  // a plain still after the drag: no action since the screen before
  assert.equal(src.states[2]!.action, undefined);
  // the shots.json file itself and the folder read the same
  assert.equal(readComponentSource(join(FIX, "j01-calc", "shots.json")).root, src.root);
});

test("recall on calc-end: the parts j01 lifted by hand are listed (e149, e155, e156, e170)", () => {
  const f = calc();
  assert.equal(entry(f, "calc-end:e149").kind, "stat");
  assert.equal(entry(f, "calc-end:e155").kind, "badge");
  assert.equal(entry(f, "calc-end:e155").label, "VS");
  assert.equal(entry(f, "calc-end:e156").kind, "stat");
  const e170 = entry(f, "calc-end:e170");
  assert.equal(e170.label, "轉讓省 NT$4,466");
  // refs everywhere, pictures relative to components.json
  assert.match(e170.picture ?? "", /^states\/assets\/[0-9a-f]{40}\.png$/);
  assert.ok(existsSync(join(FIX, "j01-calc", "states", "calc", "state.html")));
  for (const e of f.components) {
    if (e.inside) assert.match(e.inside, /^[\w-]+:e\d+$/);
    for (const r of [...(e.parts ?? []), ...(e.members ?? [])])
      assert.ok(r.startsWith(`${e.state}:`));
  }
  assert.deepEqual(f.source, {
    kind: "shoot",
    log: "shots.json",
    viewport: { w: 1920, h: 1300, dpr: 2 },
    srcRatio: 2,
  });
  assert.equal(f.states[1]!.url, "states/slide/state.html");
});

test("what the drag changed: was → now, the slider marked as acted on, tracks through the screens", () => {
  const f = calc();
  const slide = f.states.find((s) => s.id === "slide")!;
  assert.equal(slide.since, "calc");
  assert.deepEqual(slide.action, {
    kind: "drag",
    label: "slide",
    acted: "slide:e127",
    by: "point",
    // the totals that moved — not the slider's own readout inside its field
    changes: ["slide:e145", "slide:e149", "slide:e152", "slide:e167", "slide:e170", "slide:e171"],
  });
  assert.equal(entry(f, "slide:e127").kind, "input");
  assert.equal(entry(f, "slide:e127").facts.acted, true);
  assert.equal(entry(f, "slide:e171").facts.changed, "NT$2,276 → NT$4,466");
  assert.equal(entry(f, "slide:e125").facts.changed, "10 個月 → 18.5 個月");
  // nothing changed between slide and calc-end
  assert.equal(entry(f, "calc-end:e171").facts.changed, undefined);
  // the total, followed through all three screens
  const t = f.tracks.find((x) => x.id === entry(f, "calc-end:e170").track)!;
  assert.equal(t.kind, "stat");
  assert.deepEqual(
    t.steps.map((s) => [s.ref, s.text]),
    [
      ["calc:e170", "轉讓省 NT$2,276"],
      ["slide:e170", "轉讓省 NT$4,466"],
      ["calc-end:e170", "轉讓省 NT$4,466"],
    ],
  );
  assert.equal(t.changes, 1);
  assert.equal(entry(f, "calc:e170").track, t.id);
  // a part that never changed is a repeat, not a track
  const heading = entry(f, "calc-end:e28");
  assert.equal(heading.track, undefined);
  assert.equal(heading.repeats, "calc:e28");
});

test("order: the page's own order — nothing moved up for what the action touched", () => {
  const f = calc();
  const slide = f.states.find((s) => s.id === "slide")!;
  const parts = (
    JSON.parse(readFileSync(join(FIX, "j01-calc", "states", "slide", "parts.json"), "utf8")) as {
      parts: { el: string }[];
    }
  ).parts.map((p) => `slide:${p.el}`);
  assert.deepEqual(slide.components, parts);
  assert.equal(f.order, COMPONENT_ORDER);
  assert.doesNotMatch(COMPONENT_ORDER, /first|score|contrast/);
  // the same order in `components`
  assert.deepEqual(
    f.components.filter((e) => e.state === "slide").map((e) => e.ref),
    slide.components,
  );
});

test("home: the wizard card is one track, and the click is found under the mouse in the screen before", () => {
  const f = gatherComponents(readComponentSource(join(FIX, "j01-home")));
  const card = entry(f, "home:e47");
  assert.equal(card.kind, "card");
  assert.equal(card.sub, "result");
  assert.match(card.selector, /^#find-membership/);
  const t = f.tracks.find((x) => x.id === card.track)!;
  assert.deepEqual(
    t.steps.map((s) => s.ref),
    ["home:e47", "taipei:e47", "newtaipei:e47"],
  );
  const taipei = f.states.find((s) => s.id === "taipei")!;
  assert.equal(taipei.action?.acted, "taipei:e77");
  assert.equal(entry(f, "taipei:e77").label, "台北市");
  assert.equal(entry(f, "taipei:e77").facts.acted, true);
});

test("a take: the capture's own target is what was acted on, and what it changed is a seen relation", () => {
  const src = readComponentSource(join(FIX, "bill.take"));
  assert.equal(src.kind, "take");
  const f = gatherComponents(src);
  const s2 = f.states.find((s) => s.id === "s2")!;
  assert.deepEqual(s2.action, {
    kind: "click",
    label: "#go",
    acted: "s2:e8",
    by: "capture",
    changes: ["s2:e3", "s2:e5"],
  });
  assert.equal(entry(f, "s2:e5").facts.changed, "$0.00 → $42.50");
  assert.equal(entry(f, "s2:e8").facts.acted, true);
  assert.deepEqual(
    entry(f, "s2:e8").relations.filter((r) => r.kind === "changes"),
    [
      { kind: "changes", to: "s2:e3", by: "seen" },
      { kind: "changes", to: "s2:e5", by: "seen" },
    ],
  );
  assert.equal(f.source.log, "capture.json");
  // measured before the probe kept full values: what parts.json had, short
  // enough here not to be capped
  assert.deepEqual(entry(f, "s2:e5").values.number, {
    text: "$42.50",
    value: 42.5,
    unit: "$",
    source: { state: "s2", eid: "e5", selector: "#total" },
  });
  // a page served from this machine says so
  assert.deepEqual(entry(f, "s2:e5").provenance.local, true);
  assert.equal(entry(f, "s2:e5").provenance.url, "http://127.0.0.1:38713/page.html");
});

test("before: the same element on the screen before — a part that stayed but moved is linked too", () => {
  const dir = mkdtempSync(join(tmpdir(), "ot-components-"));
  try {
    writePartsShoot(dir);
    const f = gatherComponents(readComponentSource(dir));
    // the heading moved down on add-1, its text the same: no track, no
    // repeat (another place) — only the link to itself before
    const moved = entry(f, "add-1:e2");
    assert.equal(moved.facts.moved, true);
    assert.equal(moved.track, undefined);
    assert.equal(moved.repeats, undefined);
    assert.equal(moved.before, "home:e2");
    // unchanged and in place: a repeat, and linked as well
    assert.equal(entry(f, "add-2:e2").repeats, "add-1:e2");
    assert.equal(entry(f, "add-2:e2").before, "add-1:e2");
    // the first screen has no screen before
    assert.equal(entry(f, "home:e2").before, undefined);
    // tracks are as they were: the number, through every screen
    assert.deepEqual(
      f.tracks.map((t) => [t.id, t.steps.map((s) => s.ref)]),
      [["t1", f.states.map((s) => `${s.id}:e4`)]],
    );
    assert.equal(entry(f, "n-4:e4").before, "n-3:e4");
    // the stills' px per screen px
    assert.equal(f.source.srcRatio, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a take's srcRatio is its recording's width over the viewport's", () => {
  const f = gatherComponents(readComponentSource(join(FIX, "bill.take")));
  assert.equal(f.source.srcRatio, 2556 / 1280);
});

test("followed: the tracks with the cursor kept at each step, and the product() line — an index, nothing picked", () => {
  const dir = mkdtempSync(join(tmpdir(), "ot-components-"));
  try {
    writePartsShoot(dir);
    const f = gatherComponents(readComponentSource(dir));
    assert.equal(
      followedLine(f, dir),
      'followed: t1 number "9" 3 → 9 over home…n-4, cursor kept at each step',
    );
    // more than the summary names: the rest are in the file
    const many: ComponentsFile = {
      ...f,
      tracks: Array.from({ length: FOLLOWED_SHOWN + 2 }, (_, i) => ({
        ...f.tracks[0]!,
        id: `t${i + 1}`,
      })),
    };
    const line = followedLine(many, dir)!;
    assert.equal(line.match(/cursor kept at each step/g)?.length, FOLLOWED_SHOWN);
    assert.match(line, / · … 2 more in components\.json$/);
    // a still without a cursor: that track is not followed
    const log = JSON.parse(readFileSync(join(dir, "shots.json"), "utf8"));
    delete log.stills[2].cursor;
    writeFileSync(join(dir, "shots.json"), JSON.stringify(log));
    assert.equal(followedLine(f, dir), null);
    // the URL as film render serves it from the folder it runs in
    assert.match(
      partsLine(dir, join(dir, "..")),
      new RegExp(`^parts: product\\("/${dir.split("/").pop()}/"\\) in kit/media\\.js — `),
    );
    assert.match(partsLine(dir, join(dir, "states")), /--root/);
    const out = formatComponents(f, { path: "components.json", at: dir, servedFrom: dir });
    assert.match(out, /\nparts: product\("\/"\)/);
    assert.doesNotMatch(out, /\nfollowed:/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  // a take has no stills: nothing followed
  const take = gatherComponents(readComponentSource(join(FIX, "bill.take")));
  assert.equal(followedLine(take, join(FIX, "bill.take")), null);
});

test("a screen with no parts.json is listed as unmeasured, not dropped", () => {
  const dir = mkdtempSync(join(tmpdir(), "ot-components-"));
  try {
    cpSync(join(FIX, "j01-calc"), dir, { recursive: true });
    rmSync(join(dir, "states", "slide", "parts.json"));
    const f = gatherComponents(readComponentSource(dir));
    const slide = f.states.find((s) => s.id === "slide")!;
    assert.match(slide.unmeasured ?? "", /no parts\.json/);
    assert.deepEqual(slide.components, []);
    // calc-end still compares with the screen before it (its index is there)
    assert.equal(f.states.find((s) => s.id === "calc-end")!.since, "slide");
    assert.equal(componentCounts(f).measured, 2);
    // written beside the log
    const path = writeComponents(f, dir);
    assert.equal(path, join(dir, "components.json"));
    assert.equal((JSON.parse(readFileSync(path, "utf8")) as ComponentsFile).version, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("one saved screen: its folder is the root, pictures relative to it", () => {
  const f = gatherComponents(readComponentSource(join(FIX, "j01-calc", "states", "calc-end")));
  assert.equal(f.source.kind, "state");
  assert.deepEqual(
    f.states.map((s) => [s.id, s.url]),
    [["calc-end", "state.html"]],
  );
  assert.match(entry(f, "calc-end:e170").picture ?? "", /^\.\.\/assets\//);
});

test("a folder that holds no saved screens says what it takes", () => {
  const dir = mkdtempSync(join(tmpdir(), "ot-components-"));
  try {
    assert.throws(() => readComponentSource(dir), /holds no saved screens/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("fit and phone: arithmetic, stated", () => {
  // 183 × 30 of ink + 8 px each side → the width binds: 0.7 × 1920 / 199
  const fit = fitOf({
    box: [999, 599, 544, 30],
    ink: [999, 599, 183, 30],
    lift: { around: "clear", box: "ink", pad: 8 },
  });
  assert.equal(fit.by, "ink");
  assert.equal(fit.k, Math.round(((0.7 * 1920) / 199) * 100) / 100);
  assert.equal(fit.box[2], Math.round(199 * ((0.7 * 1920) / 199)));
  assert.equal(fit.box[0], Math.round((1920 - fit.box[2]) / 2));
  // a box when the lift keeps the box
  assert.equal(
    fitOf({ box: [0, 0, 100, 400], lift: { around: "clear", box: "box", pad: 0 } }).box[3],
    648,
  );
  // 20 px text, a 1920 × 1300 screen contained in 1920 × 1080, a 390 px phone
  const p = phoneOf(20, 6, { w: 1920, h: 1300 });
  assert.equal(p.asScreen, Math.round(20 * (1080 / 1300) * (390 / 1920) * 10) / 10);
  assert.equal(p.atFit, Math.round(20 * 6 * (390 / 1920) * 10) / 10);
});

test("exampleSource: lifts the part with its own options and moves it to its fit — valid JS", () => {
  const f = calc();
  const src = exampleSource(f, "calc-end:e170", { screens: "../shots" });
  assert.match(
    src,
    /screen\(frame, "\.\.\/shots\/states\/calc-end\/state\.html", \{ hidden: true \}\)/,
  );
  assert.match(src, /lift\(src, "e170", \{ around: "clear", box: "ink", pad: 8 \}\)/);
  // a number counts along its track, from the value it held first, in the product's format
  assert.match(src, /count\(t, at \+ 0\.2, "NT\$2,276", "NT\$4,466"\)/);
  // a stat's number is the element inside it: that one's text is set
  assert.match(src, /"NT\$4,466"\)\.text, "e171"\)/);
  assert.match(src, /export async function liftPart\(stage, tl\)/);
  const e = entry(f, "calc-end:e170");
  assert.ok(
    src.includes(
      `{ x: ${e.fit.box[0]}, y: ${e.fit.box[1]}, w: ${e.fit.box[2]}, h: ${e.fit.box[3]} }`,
    ),
  );
  assert.match(src, /width: "1920px", height: "1300px"/);
  // a card assembles its own parts; a button is pressed
  const card = f.components.find((x) => x.kind === "card" && x.parts?.length)!;
  const cardSrc = exampleSource(f, card.ref);
  assert.match(cardSrc, /assemble\(t, at \+ 0\.5, part\.parts\(\)\)/);
  assert.match(cardSrc, /parts: \["e\d+"/);
  const button = f.components.find((x) => x.kind === "button")!;
  assert.match(exampleSource(f, button.ref), /press\(t, pressAt\)/);
  assert.throws(() => exampleSource(f, "calc-end:e9999"), /no part calc-end:e9999/);
  // each one parses as a module
  const dir = mkdtempSync(join(tmpdir(), "ot-example-"));
  try {
    for (const [i, s] of [src, cardSrc, exampleSource(f, button.ref)].entries()) {
      const file = join(dir, `example${i}.mjs`);
      writeFileSync(file, s);
      const r = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
      assert.equal(r.status, 0, r.stderr);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the summary is information only: kinds, what changed, no part put forward", () => {
  const f = calc();
  const out = formatComponents(f, { path: "shots/components.json", dir: "shots" });
  const slideBlock = out.split("\n\n").find((b) => b.startsWith("slide"))!;
  const lines = slideBlock.split("\n").slice(1);
  assert.match(lines[0]!, /^ {2}\d+ badge · \d+ button · /);
  // only what the drag acted on or changed is named, in the page's order
  for (const l of lines.slice(1).filter((x) => /^ {2}slide:e\d+/.test(x)))
    assert.match(l, /acted on|changed|restyled|appeared/);
  assert.ok(lines.some((l) => l.startsWith("  slide:e171 ")));
  // no part's ref is printed as a next step
  assert.match(out, /snippet: open-take components shots --snippet <ref>/);
  assert.doesNotMatch(out, /--snippet [\w-]+:e\d+/);
  assert.doesNotMatch(out, /example/);
  // --state: one screen
  const one = formatComponents(f, { path: "c.json", state: "calc" });
  assert.ok(!one.includes("\nslide"));
  const line = componentsLine(f, "shots/components.json", "shots");
  assert.match(
    line,
    /^components: \d+ parts in 3 saved screens \(\d+ distinct\) → shots\/components\.json, measured in \d+\.\d s/,
  );
  assert.match(line, /--no-components skips it$/);
  assert.doesNotMatch(line, /:e\d+/, "the line names no part");
});

test("a field's snippet runs its input's own value from the value it held first", () => {
  const f = calc();
  // slide:e125 ("18.5 個月") changed too, but it sits in the field the drag acted on
  assert.equal(entry(f, "slide:e121").facts.acted, true);
  assert.equal(entry(f, "slide:e125").facts.changed, "10 個月 → 18.5 個月");
  const field = exampleSource(f, "slide:e121");
  assert.match(field, /part\.find\("e127"\)/);
  assert.match(field, /count\(t, at \+ 0\.9, "10", "18\.5"\)\.value/);
  assert.ok(!field.includes("type("), "a number is not typed");
  const dir = mkdtempSync(join(tmpdir(), "ot-example-"));
  try {
    writeFileSync(join(dir, "f.mjs"), field);
    const r = spawnSync(process.execPath, ["--check", join(dir, "f.mjs")], { encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a number no screen before held another value of does not count — never from a made-up 0", () => {
  const f = calc();
  // NT$300 reads the same on every screen: no track
  const e = entry(f, "calc-end:e159");
  assert.equal(e.track, undefined);
  assert.equal(e.values.number?.text, "NT$300");
  const src = exampleSource(f, e.ref);
  assert.ok(!src.includes("count("), src);
  assert.match(src, /"NT\$300" as the product showed it/);
  // the first screen's own total has a track, but nothing before it: no count either
  assert.ok(!exampleSource(f, "calc:e171").includes("count("));
});

test("values: in full, field by field, each with where it was read", () => {
  const f = calc();
  // a card's text is kept whole (the label is cut at 80)
  const card = entry(f, "calc-end:e33");
  assert.ok(card.label.length <= 80);
  assert.ok(card.values.text!.text.length > 1000);
  assert.ok(card.values.text!.text.startsWith(card.label.slice(0, -1)));
  assert.equal(card.values.text!.capped, undefined);
  assert.deepEqual(card.values.text!.source, {
    state: "calc-end",
    eid: "e33",
    selector: card.selector,
  });
  // its accessible name (aria-labelledby → the heading) is a value, and a relation
  assert.equal(card.values.name?.text, "您的合約");
  assert.ok(
    entry(f, "calc-end:e34").relations.some(
      (r) => r.kind === "labels" && r.to === "calc-end:e33" && r.by === "markup",
    ),
  );
  // a stat: its number from the number part inside it, and the words beside it
  const stat = entry(f, "calc-end:e170");
  assert.deepEqual(stat.values.number, {
    text: "NT$4,466",
    value: 4466,
    unit: "NT$",
    source: { state: "calc-end", eid: "e171", selector: entry(f, "calc-end:e171").selector },
  });
  assert.equal(stat.values.label?.text, "轉讓省");
  // an input: its value apart from what it shows; a range's bounds
  const slider = entry(f, "slide:e127");
  assert.equal(slider.values.text, undefined);
  assert.deepEqual(
    [
      slider.values.value?.text,
      slider.values.value?.value,
      slider.values.min?.value,
      slider.values.max?.value,
    ],
    ["18.5", 18.5, 0, 24],
  );
  // a select: the option shown and every option, as the page has them
  const brand = entry(f, "calc:e47");
  assert.equal(brand.values.value?.text, "不確定／未列出");
  assert.ok(brand.values.options?.text.split("\n").includes("Anytime Fitness"));
  // a field: its label, and its input's value read from the input
  assert.equal(entry(f, "slide:e121").values.value?.source.eid, "e127");
  // the state a toggle shows
  assert.deepEqual(entry(f, "calc:e68").shows, { pressed: "true" });
  // where: the live site, when the screen was saved
  const prov = entry(f, "calc:e68").provenance;
  assert.equal(prov.url, "https://findgym.tw/calc");
  assert.equal(prov.local, undefined);
  assert.match(prov.capturedAt ?? "", /^\d{4}-\d\d-\d\dT/);
  // nothing in the file singles a part out
  const text = JSON.stringify(f);
  assert.doesNotMatch(text, /"(example|pick|hero)"/);
});

test("relations: the drag changed the totals, not the slider's own readout", () => {
  const f = calc();
  const changes = entry(f, "slide:e127")
    .relations.filter((r) => r.kind === "changes")
    .map((r) => r.to);
  assert.ok(changes.includes("slide:e171"), changes.join(" "));
  assert.ok(changes.includes("slide:e152"));
  assert.ok(!changes.includes("slide:e125"), "the slider's readout sits in the field acted on");
  assert.ok(!changes.includes("slide:e127"));
  // what holds what
  assert.ok(
    entry(f, "slide:e170").relations.some((r) => r.kind === "contains" && r.to === "slide:e171"),
  );
  // a field labels its input
  assert.ok(
    entry(f, "slide:e121").relations.some(
      (r) => r.kind === "labels" && r.to === "slide:e127" && r.by === "layout",
    ),
  );
  // tracks keep each step's text in full and its number
  const t = f.tracks.find((x) => x.id === entry(f, "slide:e127").track)!;
  assert.deepEqual(
    t.steps.map((s) => [s.text, s.value]),
    [
      ["10", 10],
      ["18.5", 18.5],
      ["18.5", 18.5],
    ],
  );
});

test("readNumber: the number as written, its value and what stands with it", () => {
  assert.deepEqual(readNumber("轉讓省 NT$4,466"), { text: "NT$4,466", value: 4466, unit: "NT$" });
  assert.deepEqual(readNumber("18.5個月"), { text: "18.5個月", value: 18.5, unit: "個月" });
  assert.deepEqual(readNumber("最高 20%"), { text: "20%", value: 20, unit: "%" });
  assert.deepEqual(readNumber("−3"), { text: "−3", value: -3 });
  assert.equal(readNumber("no digits"), null);
});

test("a control matched to one whose text and size both differ is another control, not the one acted on", () => {
  const dir = mkdtempSync(join(tmpdir(), "ot-components-"));
  try {
    cpSync(join(FIX, "j01-home"), dir, { recursive: true });
    const p = join(dir, "states", "taipei", "index.json");
    const index = JSON.parse(readFileSync(p, "utf8")) as {
      elements: { id: string; text?: string; name?: string; box: number[] }[];
    };
    const b = index.elements.find((e) => e.id === "e77")!;
    Object.assign(b, { text: "上一步", name: "上一步", box: [b.box[0], b.box[1], 48, 48] });
    writeFileSync(p, JSON.stringify(index));
    const f = gatherComponents(readComponentSource(dir));
    const taipei = f.states.find((s) => s.id === "taipei")!;
    assert.equal(taipei.action?.acted, undefined);
    assert.match(taipei.action?.actedBefore ?? "", /^home:e\d+$/);
    assert.equal(entry(f, "taipei:e77").facts.acted, undefined);
    assert.equal(entry(f, "taipei:e77").facts.changed, undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("--snippet's URL: from the folder film render serves, the same from any page under it", () => {
  const f = calc();
  const root = join(FIX, "j01-calc");
  const src = exampleSource(f, "calc-end:e170", { root, servedFrom: FIX });
  assert.match(
    src,
    /screen\(frame, "\/j01-calc\/states\/calc-end\/state\.html", \{ hidden: true \}\)/,
  );
  // outside it: the screen's own path, and what render needs to reach it
  const out = exampleSource(f, "calc-end:e170", { root, servedFrom: join(FIX, "bill.take") });
  assert.ok(
    out.includes(`screen(frame, ${JSON.stringify(join(root, "states/calc-end/state.html"))}`),
  );
  assert.match(out, /--root/);
});

test("a tab-like toggle: its state is a change of its own, and what the click changed is a relation", () => {
  const f = gatherComponents(readComponentSource(join(FIX, "j01-home")));
  const b = entry(f, "taipei:e77");
  assert.match(b.facts.restyled ?? "", /pressed: – → true/);
  const t = f.tracks.find((x) => x.id === b.track)!;
  assert.equal(t.changes, 1);
  assert.deepEqual(
    t.steps.map((s) => [s.text, /pressed=true/.test(s.shows ?? "")]),
    [
      ["台北市", false],
      ["台北市", true],
      ["台北市", true],
    ],
  );
  assert.deepEqual(
    b.relations.filter((r) => r.kind === "changes").map((r) => r.to),
    // the wizard card around the button changed beyond it (the district
    // input appeared in it): it is counted, as is the input
    ["taipei:e47", "taipei:e88"],
  );
});

test("an action on an element that is not a part (a tab drawn as a bare link): what it changed is on the action", () => {
  const dir = mkdtempSync(join(tmpdir(), "ot-components-"));
  try {
    cpSync(join(FIX, "j01-home"), dir, { recursive: true });
    const p = join(dir, "states", "taipei", "parts.json");
    const parts = JSON.parse(readFileSync(p, "utf8"));
    parts.parts = parts.parts.filter((x: { el: string }) => x.el !== "e77");
    writeFileSync(p, JSON.stringify(parts));
    const f = gatherComponents(readComponentSource(dir));
    const s = f.states.find((x) => x.id === "taipei")!;
    assert.equal(s.action?.acted, "taipei:e77");
    assert.deepEqual(s.action?.changes, ["taipei:e47", "taipei:e88"]);
    assert.ok(
      f.components.every(
        (e) => !e.relations.some((r) => r.kind === "changes" && r.to.startsWith("taipei:")),
      ),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a shoot's still is where each value was seen", () => {
  const dir = mkdtempSync(join(tmpdir(), "ot-components-"));
  try {
    cpSync(join(FIX, "j01-calc"), dir, { recursive: true });
    writeFileSync(join(dir, "056-slide.png"), "");
    const f = gatherComponents(readComponentSource(dir));
    assert.equal(f.states.find((s) => s.id === "slide")!.shot, "056-slide.png");
    assert.equal(entry(f, "slide:e171").values.number?.source.shot, "056-slide.png");
    // a still that is not there is not named
    assert.equal(f.states.find((s) => s.id === "calc")!.shot, undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
