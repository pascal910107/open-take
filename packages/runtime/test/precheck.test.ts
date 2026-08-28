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
