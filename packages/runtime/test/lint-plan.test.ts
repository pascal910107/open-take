// lintPlan — the structural check a plan gets before it drives a capture.
// The cases here are the defects a 48-run repair benchmark actually produced:
// the engine no-ops or skips them silently, so the lint is the only place
// they become words. The two teaching messages (wait paced by `duration`,
// type content written into `text`) are asserted on substance, not phrasing —
// that copy is what doubles retry convergence, and a rewrite that drops it
// should fail here.
import assert from "node:assert/strict";
import { test } from "node:test";
import { lintPlan, type PlanIssue } from "../src/lint-plan";

const errors = (issues: PlanIssue[]) => issues.filter((i) => i.severity === "error");
const plan = (steps: unknown[]) => ({ url: "http://localhost:3000", steps });

test("a valid plan with one of each action lints clean", () => {
  const valid = {
    url: "http://localhost:5173",
    viewport: { width: 1280, height: 800 },
    startCursor: { x: 640, y: 400 },
    steps: [
      { action: "wait", ms: 800 },
      { action: "click", text: "New project", zoom: "auto", settleMs: 900, caption: "Start here" },
      { action: "type", selector: "#name", value: "Q3 launch", clear: true, perCharMs: 40 },
      { action: "press", keys: "Enter", note: "submit the form" },
      { action: "hover", text: "Help", durationMs: 1200 },
      { action: "look", selector: ".chart", durationMs: 1800, zoom: "always" },
      { action: "scroll", dy: 600 },
      { action: "select", text: "Team size", value: "Large" },
      { action: "drag", from: { x: 200, y: 300 }, to: { x: 500, y: 420 } },
      { action: "dropFiles", paths: ["./assets/logo.png"], toText: "Drop files here" },
      { action: "navigate", hrefFrom: { text: "Open dashboard" }, query: { speed: "3" } },
    ],
  };
  assert.deepEqual(lintPlan(valid), []);
});

test("a wait paced by `duration` is an error with the rewrite computed", () => {
  // the benchmark's #1 defect: the engine reads only `ms`, so this wait
  // silently never happens
  const issues = lintPlan(plan([{ action: "wait", duration: 800 }]));
  assert.equal(issues.length, 1);
  const i = issues[0]!;
  assert.equal(i.severity, "error");
  assert.equal(i.path, "steps[0].duration");
  // the teaching substance: the exact shape, ms-only, and the silent no-op
  assert.match(i.message, /\{"action":"wait","ms":<integer milliseconds>\}/);
  assert.match(i.message, /ONLY `ms`/);
  assert.match(i.message, /silently does not happen/);
  // the fix carries the value over — apply it verbatim and the plan is fixed
  assert.equal(i.fix, 'rewrite as {"action":"wait","ms":800}');
});

test("durationMs and settleMs on a wait get the same computed rewrite", () => {
  const [a] = errors(lintPlan(plan([{ action: "wait", durationMs: 1200 }])));
  assert.equal(a!.fix, 'rewrite as {"action":"wait","ms":1200}');
  const [b] = errors(lintPlan(plan([{ action: "wait", settleMs: 900 }])));
  assert.equal(b!.fix, 'rewrite as {"action":"wait","ms":900}');
});

test("a wait with a valid ms plus a dead extra field only warns", () => {
  // ms is read, so the wait happens — the extra is suspect, not broken
  const issues = lintPlan(plan([{ action: "wait", ms: 800, duration: 800 }]));
  assert.equal(errors(issues).length, 0);
  assert.equal(issues.length, 1);
  assert.equal(issues[0]!.severity, "warn");
  assert.equal(issues[0]!.path, "steps[0].duration");
});

test("a wait with no ms at all still teaches the shape", () => {
  const issues = lintPlan(plan([{ action: "wait" }]));
  assert.equal(issues.length, 1);
  assert.equal(issues[0]!.path, "steps[0].ms");
  assert.match(issues[0]!.message, /ONLY `ms`/);
  assert.match(issues[0]!.message, /silently does not happen/);
});

test("type with the content written into `text` and no `value` teaches the field split", () => {
  // the benchmark's #2 defect: `text` is the TARGET (accessible name); the
  // engine searches for an element NAMED the content, finds none, skips
  const issues = lintPlan(plan([{ action: "type", text: "hello@example.com" }]));
  assert.equal(issues.length, 1);
  const i = issues[0]!;
  assert.equal(i.severity, "error");
  assert.equal(i.path, "steps[0].value");
  assert.match(i.message, /`value` is the string to type/);
  assert.match(i.message, /`text`/);
  assert.match(i.message, /NAMED that content/);
  assert.match(i.message, /skipped/);
  // the fix carries the stranded content into `value`
  assert.match(i.fix!, /"value":"hello@example\.com"/);
});

test("select with the option label in `text` and no `value` gets the same treatment", () => {
  const issues = lintPlan(plan([{ action: "select", text: "Large" }]));
  assert.equal(issues.length, 1);
  assert.equal(issues[0]!.path, "steps[0].value");
  assert.match(issues[0]!.fix!, /"value":"Large"/);
});

test("an action outside the vocabulary is an error, with a near-miss suggested", () => {
  const issues = lintPlan(plan([{ action: "clik", text: "Go" }]));
  assert.equal(issues.length, 1);
  assert.equal(issues[0]!.severity, "error");
  assert.equal(issues[0]!.path, "steps[0].action");
  assert.match(issues[0]!.message, /vocabulary/);
  assert.equal(issues[0]!.fix, 'did you mean "click"?');
});

test("a scroll with none of toSelector/toText/dy is an error", () => {
  const issues = lintPlan(plan([{ action: "scroll" }]));
  assert.equal(issues.length, 1);
  assert.equal(issues[0]!.severity, "error");
  assert.equal(issues[0]!.path, "steps[0]");
  assert.match(issues[0]!.message, /`toSelector`\/`toText`\/`dy`/);
});

test("an unknown field on a click is a warn that lists the step's real fields", () => {
  const issues = lintPlan(plan([{ action: "click", text: "Save", timeout: 500 }]));
  assert.equal(issues.length, 1);
  const i = issues[0]!;
  assert.equal(i.severity, "warn");
  assert.equal(i.path, "steps[0].timeout");
  assert.match(i.message, /never reads it/);
  assert.match(i.fix!, /selector, text, note, caption, settleMs, zoom/);
});

test("an unknown field that misspells a required one is an error with a rename fix", () => {
  // `key` on a press: without the rename, `keys` is missing and nothing fires
  const issues = lintPlan(plan([{ action: "press", key: "Enter" }]));
  assert.equal(issues.length, 1);
  assert.equal(issues[0]!.severity, "error");
  assert.equal(issues[0]!.path, "steps[0].key");
  assert.match(issues[0]!.fix!, /rename `key` to `keys`/);
});

test("click with neither selector nor text is an error (the step would be skipped)", () => {
  const issues = lintPlan(plan([{ action: "click" }]));
  assert.equal(issues.length, 1);
  assert.match(issues[0]!.message, /neither `selector` nor `text`/);
  assert.match(issues[0]!.message, /skipped/);
});

test("an invalid zoom value is an error naming the three intents", () => {
  const issues = lintPlan(plan([{ action: "click", text: "Go", zoom: "sometimes" }]));
  assert.equal(issues.length, 1);
  assert.equal(issues[0]!.path, "steps[0].zoom");
  assert.match(issues[0]!.message, /"never" \| "auto" \| "always"/);
});

test("a path-only drag is complete — the path carries its own endpoints", () => {
  const issues = lintPlan(
    plan([
      {
        action: "drag",
        path: [
          { x: 200, y: 300 },
          { x: 420, y: 180 },
        ],
      },
    ]),
  );
  assert.deepEqual(issues, []);
});

test("a drag with no endpoints at all reports both missing ends", () => {
  const issues = lintPlan(plan([{ action: "drag" }]));
  assert.equal(errors(issues).length, 2);
  assert.match(issues[0]!.message, /no start/);
  assert.match(issues[1]!.message, /no end/);
});

test("plan-level shape: not an object, missing url, empty steps", () => {
  assert.equal(lintPlan("nope")[0]!.severity, "error");
  assert.equal(lintPlan([])[0]!.path, "plan");

  const noUrl = lintPlan({ steps: [{ action: "wait", ms: 500 }] });
  assert.equal(noUrl.length, 1);
  assert.equal(noUrl[0]!.path, "url");

  const empty = lintPlan({ url: "http://localhost:3000", steps: [] });
  assert.equal(empty.length, 1);
  assert.equal(empty[0]!.path, "steps");
});

test("a malformed viewport is an error with the rewrite computed from its numbers", () => {
  const issues = lintPlan({
    url: "http://localhost:3000",
    viewport: { width: 1280.4, height: 800 },
    steps: [{ action: "wait", ms: 500 }],
  });
  assert.equal(issues.length, 1);
  assert.equal(issues[0]!.path, "viewport");
  assert.equal(issues[0]!.fix, 'rewrite as {"width":1280,"height":800}');
});

test("steps under a misspelled top-level key is diagnosed as the misspelling", () => {
  const issues = lintPlan({ url: "http://localhost:3000", step: [{ action: "wait", ms: 500 }] });
  assert.equal(issues.length, 1);
  assert.equal(issues[0]!.severity, "error");
  assert.equal(issues[0]!.path, "step");
  assert.match(issues[0]!.fix!, /rename `step` to `steps`/);
});

test("a present-but-mistyped target names the type problem, not a missing field", () => {
  const issues = lintPlan(plan([{ action: "click", text: 123 }]));
  const e = errors(issues);
  assert.equal(e.length, 1);
  assert.equal(e[0]!.path, "steps[0].text");
  assert.match(e[0]!.message, /must be a string/);
  // the wrong copy would send a retry in a circle: it HAS text
  assert.doesNotMatch(e[0]!.message, /neither/);
});

test("a drag with a malformed path gets the path error alone, not phantom endpoint errors", () => {
  const issues = lintPlan(
    plan([
      {
        action: "drag",
        path: [
          { x: 3, y: 4 },
          { x: "5", y: 6 },
        ],
      },
    ]),
  );
  const e = errors(issues);
  assert.equal(e.length, 1);
  assert.match(e[0]!.path, /path/);
});

test("a navigate query that is not an object of strings is an error", () => {
  const issues = lintPlan(plan([{ action: "navigate", query: "speed=3" }]));
  const e = errors(issues);
  assert.equal(e.length, 1);
  assert.equal(e[0]!.path, "steps[0].query");
});

test("dropFiles without paths is an error", () => {
  const e = errors(lintPlan(plan([{ action: "dropFiles", toText: "Drop files here" }])));
  assert.equal(e.length, 1);
  assert.match(e[0]!.path, /paths/);
});

test("a navigate hrefFrom without selector/text is an error", () => {
  const e = errors(lintPlan(plan([{ action: "navigate", hrefFrom: {} }])));
  assert.equal(e.length, 1);
  assert.match(e[0]!.path, /hrefFrom/);
});
