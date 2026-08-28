import assert from "node:assert/strict";
import { test } from "node:test";
import { planTargets, precheckPlan, probeJs } from "../src/precheck";
import type { TakePlan } from "../src/types";

const steps = (s: unknown[]) => s as TakePlan["steps"];

// A fake page: maps probe JS back to canned outcomes by the target value
// embedded in it. precheckPlan only sees the eval boundary, so this exercises
// the full grading logic without a browser.
const page =
  (outcomes: Record<string, unknown>) =>
  async (js: string): Promise<unknown> => {
    for (const [needle, out] of Object.entries(outcomes))
      if (js.includes(JSON.stringify(needle))) return out;
    return { count: 0 };
  };

const noSleep = { retryMs: 0, sleep: async () => {} };

test("cold prefix ends at the first state-changing action", () => {
  const t = planTargets(
    steps([
      { action: "wait", ms: 500 },
      { action: "look", text: "Hero" },
      { action: "click", text: "Edit" },
      { action: "click", text: "Bold" },
    ]),
  );
  assert.deepEqual(
    t.map((x) => [x.value, x.cold]),
    [
      ["Hero", true],
      ["Edit", true], // the mutating step itself still resolves cold
      ["Bold", false],
    ],
  );
});

test("press reveal targets are never required to pre-exist", async () => {
  const issues = await precheckPlan(
    steps([{ action: "press", keys: "Meta+k", text: "Command palette" }]),
    page({}),
    noSleep,
  );
  assert.equal(issues.length, 0);
});

test("a cold miss is an error; a late miss aggregates into one warning", async () => {
  const issues = await precheckPlan(
    steps([
      { action: "click", text: "Nope" },
      { action: "click", text: "Bold" },
      { action: "click", text: "Italic" },
    ]),
    page({ Nope: { count: 0 }, Bold: { count: 0 }, Italic: { count: 0 } }),
    noSleep,
  );
  const errors = issues.filter((i) => i.severity === "error");
  assert.equal(errors.length, 1);
  assert.match(errors[0]!.message, /CERTAIN to be skipped/);
  const warns = issues.filter((i) => i.severity === "warn");
  assert.equal(warns.length, 1); // ONE aggregate line, not one per step
  assert.match(warns[0]!.message, /2 targets are not in the initial DOM/);
});

test("an ambiguous selector warns and names the qualify fix", async () => {
  const issues = await precheckPlan(
    steps([{ action: "click", selector: "h1[data-slide-loc]" }]),
    page({ "h1[data-slide-loc]": { count: 3, first: { tag: "H1", w: 240, h: 40, inMain: true } } }),
    noSleep,
  );
  assert.equal(issues.length, 1);
  assert.equal(issues[0]!.severity, "warn");
  assert.match(issues[0]!.message, /matches 3 nodes/);
  assert.match(issues[0]!.fix ?? "", /main/);
});

test("invalid selector syntax is an error even late in the plan", async () => {
  const issues = await precheckPlan(
    steps([
      { action: "click", text: "Edit" },
      { action: "click", selector: ":::garbage" },
    ]),
    page({
      Edit: { count: 1, first: { tag: "BUTTON", w: 40, h: 20, inMain: true } },
      ":::garbage": { err: "SyntaxError" },
    }),
    noSleep,
  );
  assert.equal(issues.filter((i) => i.severity === "error").length, 1);
});

test("a clean plan produces zero issues", async () => {
  const ok = { count: 1, first: { tag: "BUTTON", w: 40, h: 20, inMain: true } };
  const issues = await precheckPlan(
    steps([
      { action: "click", text: "Edit" },
      { action: "type", text: "Title", value: "Hello" },
    ]),
    page({ Edit: ok, Title: ok }),
    noSleep,
  );
  assert.deepEqual(issues, []);
});

// C3.5 — a resolving target that lands on the wrong node. The canned probe
// mirrors the measured trap: "Build slides" is a <main> headline, but the
// click candidate set only contains a sidebar thumbnail whose textContent
// includes those words.
const poisoned = {
  count: 1,
  exact: 0,
  how: "substring",
  pickNameShare: 0.17, // "Build slides" inside the thumbnail's whole-slide text
  pickName: "Build slides inside Replit. A hands-on guide to running open-…",
  pickIsNamed: false,
  first: { tag: "BUTTON", w: 240, h: 116, x: 12, y: 92, inMain: false },
  mainMatches: [{ tag: "H1", w: 1333, h: 128, x: 426, y: 319, inMain: true, match: "exact" }],
};

test("a cold parse-intent mismatch is an error naming both elements", async () => {
  const issues = await precheckPlan(
    steps([{ action: "click", text: "Build slides" }]),
    page({ "Build slides": poisoned }),
    noSleep,
  );
  assert.equal(issues.length, 1);
  assert.equal(issues[0]!.severity, "error");
  assert.match(issues[0]!.message, /WRONG element/);
  assert.match(issues[0]!.message, /OUTSIDE <main>/);
  assert.match(issues[0]!.message, /h1 at \(426,319\)/);
  assert.match(issues[0]!.fix ?? "", /scoped to/);
});

test("a late parse-intent mismatch stays a warning (graded on the initial DOM)", async () => {
  const issues = await precheckPlan(
    steps([
      { action: "click", selector: "main h1" },
      { action: "look", text: "Build slides" },
    ]),
    page({
      "main h1": { count: 1, first: { tag: "H1", w: 1333, h: 128, x: 426, y: 319, inMain: true } },
      "Build slides": poisoned,
    }),
    noSleep,
  );
  assert.equal(issues.length, 1);
  assert.equal(issues[0]!.severity, "warn");
  assert.match(issues[0]!.message, /WRONG element/);
});

test("a mismatch INSIDE main stays a warning — only an outside-main impostor is certain", async () => {
  const issues = await precheckPlan(
    steps([{ action: "click", text: "Pricing plan" }]),
    page({
      "Pricing plan": {
        ...poisoned,
        first: { tag: "BUTTON", w: 200, h: 40, x: 400, y: 900, inMain: true },
      },
    }),
    noSleep,
  );
  assert.equal(issues.length, 1);
  assert.equal(issues[0]!.severity, "warn");
});

test("an ABBREVIATED label is not an impostor — high share keeps a header control clickable", async () => {
  // "Comments" naming the header's badge button "Comments3", while main body
  // copy merely mentions comments: the author abbreviated the control's own
  // label. Only an EXACT in-main duplicate would make that ambiguous.
  const issues = await precheckPlan(
    steps([{ action: "click", text: "Comments" }]),
    page({
      Comments: {
        count: 1,
        exact: 0,
        how: "substring",
        pickNameShare: 0.89,
        pickName: "Comments3",
        pickIsNamed: false,
        first: { tag: "BUTTON", w: 128, h: 30, x: 16, y: 9, inMain: false },
        mainMatches: [{ tag: "P", w: 1376, h: 18, x: 32, y: 173, inMain: true, match: "contains" }],
      },
    }),
    noSleep,
  );
  assert.deepEqual(issues, []);
});

test("a high-share pick with an EXACT in-main duplicate warns instead of refusing", async () => {
  const issues = await precheckPlan(
    steps([{ action: "click", text: "Pricing" }]),
    page({
      Pricing: {
        count: 1,
        exact: 0,
        how: "substring",
        pickNameShare: 0.54, // "Pricing" naming the nav's "Pricing plans"
        pickName: "Pricing plans",
        pickIsNamed: false,
        first: { tag: "A", w: 110, h: 30, x: 900, y: 12, inMain: false },
        mainMatches: [{ tag: "H2", w: 200, h: 40, x: 40, y: 164, inMain: true, match: "exact" }],
      },
    }),
    noSleep,
  );
  assert.equal(issues.length, 1);
  assert.equal(issues[0]!.severity, "warn");
});

test("a pick that WRAPS the named element is clean (a clickable card around its own title)", async () => {
  const issues = await precheckPlan(
    steps([{ action: "click", text: "Revenue" }]),
    page({
      Revenue: {
        count: 1,
        exact: 0,
        how: "substring",
        pickIsNamed: true, // the in-page scan saw m.contains(the <h3>)
        first: { tag: "BUTTON", w: 400, h: 300, x: 100, y: 100, inMain: true },
        mainMatches: [],
      },
    }),
    noSleep,
  );
  assert.deepEqual(issues, []);
});

test("an exact-name pick that mismatches stays a warning — the author named a real control", async () => {
  const issues = await precheckPlan(
    steps([{ action: "click", text: "Docs" }]),
    page({
      Docs: {
        ...poisoned,
        exact: 1,
        how: "exact",
        first: { tag: "BUTTON", w: 64, h: 28, x: 900, y: 12, inMain: false },
      },
    }),
    noSleep,
  );
  assert.equal(issues.length, 1);
  assert.equal(issues[0]!.severity, "warn");
});

test("a pick that IS the same-named in-main element is clean", async () => {
  const issues = await precheckPlan(
    steps([{ action: "click", text: "Save" }]),
    page({
      Save: {
        count: 1,
        exact: 1,
        how: "exact",
        first: { tag: "BUTTON", w: 64, h: 28, x: 1192, y: 980, inMain: true },
        mainMatches: [
          { tag: "BUTTON", w: 64, h: 28, x: 1192, y: 980, inMain: true, match: "exact" },
        ],
      },
    }),
    noSleep,
  );
  assert.deepEqual(issues, []);
});

test("probeJs gathers the C3.5 evidence for text targets", () => {
  const js = probeJs("text", "Build slides", "click");
  assert.match(js, /mainMatches/);
  assert.match(js, /main \*/);
});

// The C3.5 verdict is decided by the JS that runs IN THE PAGE, and the fake
// page above never executes it — so the sort, the container exclusion and the
// containment escape would all be free to regress with the suite green. This
// runs the emitted source against a hand-built DOM: enough of the four methods
// it touches (getAttribute / textContent / getBoundingClientRect / closest /
// contains) to pin the rule without a browser.
type FakeEl = {
  tagName: string;
  textContent: string;
  getAttribute: (a: string) => string | null;
  getBoundingClientRect: () => { x: number; y: number; width: number; height: number };
  closest: (sel: string) => unknown;
  contains: (o: unknown) => boolean;
  kids: FakeEl[];
};
const mkEl = (
  tag: string,
  text: string,
  [x, y, w, h]: number[],
  opts?: { inMain?: boolean; kids?: FakeEl[] },
): FakeEl => {
  const self: FakeEl = {
    tagName: tag.toUpperCase(),
    textContent: text,
    getAttribute: () => null,
    getBoundingClientRect: () => ({ x: x!, y: y!, width: w!, height: h! }),
    closest: (sel: string) => (sel === "main" && opts?.inMain ? {} : null),
    contains: (o: unknown) => o === self || (opts?.kids ?? []).some((k) => k.contains(o)),
    kids: opts?.kids ?? [],
  };
  return self;
};
const runProbe = (js: string, candidates: FakeEl[], inMain: FakeEl[]) => {
  const doc = {
    querySelectorAll: (sel: string) => (sel === "main *" ? inMain : candidates),
  };
  const win = { innerWidth: 1920, innerHeight: 1080 };
  return JSON.parse(
    new Function("document", "window", `return ${js}`)(doc, win) as string,
  ) as Record<string, never>;
};

test("in-page: the thumbnail trap — substring pick, exact in-main intent, wrapper and hidden twin dropped", () => {
  const h1 = mkEl("h1", "Build slides", [426, 319, 1333, 128], { inMain: true });
  const hiddenTwin = mkEl("h1", "Build slides", [0, 0, 0, 0], { inMain: true });
  const stage = mkEl("div", "Build slides inside Replit. A hands-on guide", [312, 88, 1560, 908], {
    inMain: true,
    kids: [h1, hiddenTwin],
  });
  const thumb = mkEl("button", "Build slides inside Replit.", [12, 92, 240, 116]);
  const out = runProbe(probeJs("text", "Build slides", "click"), [thumb], [stage, h1, hiddenTwin]);

  assert.equal(out.count as unknown as number, 1);
  assert.equal(out.how as unknown as string, "substring");
  assert.equal(out.pickIsNamed as unknown as boolean, false);
  const mm = out.mainMatches as unknown as { tag: string; match: string }[];
  assert.equal(mm.length, 1, "the stage wrapper (>25% of the viewport) and the 0x0 twin are noise");
  assert.equal(mm[0]!.tag, "H1"); // desc() reports tagName as the DOM spells it
  assert.equal(mm[0]!.match, "exact");
});

test("in-page: a clickable card that WRAPS its own title reports pickIsNamed, not a mismatch", () => {
  const title = mkEl("h3", "Revenue", [110, 110, 120, 30], { inMain: true });
  const card = mkEl("button", "Revenue 42%", [100, 100, 400, 300], { inMain: true, kids: [title] });
  const out = runProbe(probeJs("text", "Revenue", "click"), [card], [card, title]);

  assert.equal(out.pickIsNamed as unknown as boolean, true);
  assert.deepEqual(out.mainMatches as unknown as unknown[], []);
});

test("in-page: an abbreviated label reports its share and full name; the badge button is spared", () => {
  const badge = mkEl("button", "Comments3", [16, 9, 128, 30]);
  const copy = mkEl(
    "p",
    "Comments from your team appear in the activity feed.",
    [32, 173, 1376, 18],
    {
      inMain: true,
    },
  );
  const out = runProbe(probeJs("text", "Comments", "click"), [badge], [copy]);
  assert.equal(out.how as unknown as string, "substring");
  assert.equal(out.pickName as unknown as string, "Comments3");
  assert.ok((out.pickNameShare as unknown as number) > 0.8);
});

test("in-page: a substring SELF-match no longer exonerates — the in-main warn tier is reachable", () => {
  // The reviewed blind spot: for any value >6 chars, the pick's own name
  // contains the value by definition, so a self-hit must not count as "the
  // pick is the named element" unless the name is EXACT.
  const h2 = mkEl("h2", "Pricing plan", [40, 40, 200, 40], { inMain: true });
  const calc = mkEl("button", "Pricing plan calculator", [400, 900, 220, 40], { inMain: true });
  const out = runProbe(probeJs("text", "Pricing plan", "click"), [calc], [h2, calc]);
  assert.equal(out.pickIsNamed as unknown as boolean, false);
  const mm = out.mainMatches as unknown as { tag: string; match: string }[];
  assert.equal(mm[0]!.tag, "H2");
  assert.equal(mm[0]!.match, "exact");
});

test("in-page: a value with quotes and backslashes resolves instead of throwing", () => {
  const nasty = 'He said "hi" \\ bye';
  const btn = mkEl("button", nasty, [10, 10, 80, 20]);
  const out = runProbe(probeJs("text", nasty, "click"), [btn], []);
  assert.equal(out.how as unknown as string, "exact");
});

test("only the field the capture actually resolves is checked", async () => {
  // click reads `text` and never falls back — a stale extra selector alongside
  // it must not refuse a plan the capture would shoot fine
  const okText = { count: 1, exact: 1, how: "exact", first: { tag: "BUTTON", w: 40, h: 20 } };
  const clickIssues = await precheckPlan(
    steps([{ action: "click", text: "Save", selector: "#stale" }]),
    page({ Save: okText, "#stale": { count: 0 } }),
    noSleep,
  );
  assert.deepEqual(clickIssues, []);
  // scroll is the other way round: `toSelector` wins over `toText`
  const scrollIssues = await precheckPlan(
    steps([{ action: "scroll", toSelector: "#gone", toText: "Pricing" }]),
    page({ "#gone": { count: 0 }, Pricing: okText }),
    noSleep,
  );
  assert.equal(scrollIssues.filter((i) => i.severity === "error").length, 1);
  assert.match(scrollIssues[0]!.path, /toSelector/);
});

test("planTargets marks which field the engine will consult, per verb", () => {
  const t = planTargets(
    steps([
      { action: "click", text: "Save", selector: "#stale" },
      { action: "drag", selector: "main canvas", text: "Canvas", toText: "Trash" },
      // selectOptionJs and scrollDeltaSelectorJs invert the click precedence
      { action: "select", text: "Team size", selector: "#size", value: "Large" },
    ]),
  );
  assert.deepEqual(
    t.map((x) => [x.action, x.field, x.used]),
    [
      ["click", "selector", false],
      ["click", "text", true],
      ["drag", "selector", true],
      ["drag", "text", false],
      ["drag", "toText", true],
      ["select", "selector", true],
      ["select", "text", false],
    ],
  );
});

test("a drag with a path never grades its element endpoints — the path is their fallback", async () => {
  // cdp-capture: resolvePoint(...) ?? pathPts[0] — a stale selector costs
  // nothing when waypoints exist, and the capture shoots the stroke.
  const t = planTargets(
    steps([
      {
        action: "drag",
        selector: "#canvas-gone",
        path: [
          { x: 10, y: 10 },
          { x: 200, y: 200 },
        ],
        durationMs: 400,
      },
    ]),
  );
  assert.deepEqual(t, []);
  const issues = await precheckPlan(
    steps([{ action: "drag", selector: "#canvas-gone", path: [{ x: 10, y: 10 }] }]),
    page({ "#canvas-gone": { count: 0 } }),
    noSleep,
  );
  assert.deepEqual(issues, []);
});

test("a cold navigate whose hrefFrom names a missing link is an error, not a silent zero-beat take", async () => {
  const t = planTargets(
    steps([
      { action: "navigate", hrefFrom: { text: "Open report" } },
      { action: "click", text: "Export CSV" },
    ]),
  );
  assert.deepEqual(
    t.map((x) => [x.field, x.cold, x.used]),
    [
      ["hrefFrom.text", true, true],
      ["text", false, true], // navigate is MUTATING: later steps grade late
    ],
  );
  const issues = await precheckPlan(
    steps([{ action: "navigate", hrefFrom: { text: "Open report" } }]),
    page({ "Open report": { count: 0 } }),
    noSleep,
  );
  assert.equal(issues.filter((i) => i.severity === "error").length, 1);
  assert.match(issues[0]!.path, /hrefFrom/);
});

test("navigate's hrefFrom is selector-first, mirroring hrefSelectorJs", () => {
  const t = planTargets(
    steps([{ action: "navigate", hrefFrom: { selector: "a.report", text: "Open report" } }]),
  );
  assert.deepEqual(
    t.map((x) => [x.field, x.used]),
    [
      ["hrefFrom.selector", true],
      ["hrefFrom.text", false],
    ],
  );
});

test("probeJs resolves a navigate text target over the link candidate set", () => {
  assert.match(probeJs("text", "Open report", "navigate"), /a,button,\[role=link\]/);
});

test("probeJs uses the engine's per-action candidate set, not one set for all", () => {
  // scroll resolves headings/sections; hover/look/drag resolve titled boxes;
  // click resolves clickables; a <select> is found by its label semantics
  assert.match(probeJs("text", "Pricing", "scroll"), /h1,h2,h3/);
  assert.match(probeJs("text", "Revenue panel", "look"), /img\[alt\]/);
  assert.match(probeJs("text", "Save", "click"), /input\[type=submit\]/);
  const sel = probeJs("text", "Team size", "select");
  assert.match(sel, /querySelectorAll\('select'\)/);
  assert.match(sel, /label\[for/);
});

test("a select located by its label is cold-resolvable, not a false certain-miss", async () => {
  const issues = await precheckPlan(
    steps([{ action: "select", text: "Team size", value: "Large" }]),
    page({ "Team size": { count: 1, exact: 1, first: { tag: "SELECT", w: 120, h: 28 } } }),
    noSleep,
  );
  assert.deepEqual(issues, []);
});

test("dropFiles ends the cold prefix like every other state-changing action", () => {
  const t = planTargets(
    steps([
      { action: "dropFiles", paths: ["./a.png"], toText: "Drop files here" },
      { action: "click", text: "Remove" },
    ]),
  );
  assert.deepEqual(
    t.map((x) => [x.value, x.cold]),
    [["Remove", false]],
  );
});
