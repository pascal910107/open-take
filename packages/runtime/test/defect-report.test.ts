// The defects block — the repair loop's wire format. What matters here is
// stability of the contract, not phrasing: the block must round-trip through
// the two sentinel lines as ONE parseable JSON object, every finding must
// survive with its gate/severity/fix intact (warns included — late-bound
// poison only ever warns, and dropping it would blind the repair round to the
// one defect class the gate cannot refuse), and the measured settle numbers
// must arrive as copyable values, never as ratchets ("budget" beats excluded).
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  asDefects,
  buildDefectReport,
  DEFECTS_CLOSE,
  DEFECTS_OPEN,
  type DefectReport,
  renderDefectBlock,
  settleDefects,
  skippedDefects,
} from "../src/defect-report";

const sampleDefects = () => [
  ...asDefects("precheck", [
    {
      severity: "error" as const,
      path: "steps[0].text",
      message: 'click "Build slides": resolves to the WRONG element…',
      fix: "target the in-main h1 with a CSS selector scoped to `main`",
    },
    {
      severity: "warn" as const,
      path: "steps[4].text",
      message: "3 targets are not in the initial DOM",
    },
  ]),
  ...skippedDefects([{ step: 3, action: "click", target: 'text:"Save"', reason: "no match" }]),
];

test("the block round-trips: sentinels wrap exactly one parseable JSON object", () => {
  const report = buildDefectReport({
    verb: "make",
    verdict: "1 post-shoot check error + 1 skipped step",
    exitCode: 2,
    plan: "plan.json",
    master: "demos/take.mp4",
    defects: sampleDefects(),
  });
  const block = renderDefectBlock(report);
  const lines = block.split("\n");
  assert.ok(lines.includes(DEFECTS_OPEN));
  assert.ok(lines.includes(DEFECTS_CLOSE));
  const inner = block.slice(
    block.indexOf(DEFECTS_OPEN) + DEFECTS_OPEN.length,
    block.indexOf(DEFECTS_CLOSE),
  );
  const parsed = JSON.parse(inner) as DefectReport;
  assert.equal(parsed.format, "open-take-defects/1");
  assert.equal(parsed.verb, "make");
  assert.equal(parsed.exitCode, 2);
  assert.equal(parsed.plan, "plan.json");
  assert.equal(parsed.master, "demos/take.mp4");
  assert.deepEqual(parsed.defects, report.defects);
});

test("warns ride along and are counted apart from errors", () => {
  const report = buildDefectReport({
    verb: "make",
    verdict: "v",
    exitCode: 2,
    defects: sampleDefects(),
  });
  assert.equal(report.errors, 2); // precheck error + skipped step
  assert.equal(report.warns, 1); // the late-bound aggregate stays visible
  const warn = report.defects.find((d) => d.severity === "warn");
  assert.equal(warn?.gate, "precheck");
  // a finding with no fix must not grow a fix key (fix is the gate's own copy
  // or nothing — the report never invents one)
  assert.ok(warn && !("fix" in warn));
});

test("skipped steps become error defects at the step's path", () => {
  const [d] = skippedDefects([
    { step: 5, action: "click", target: 'text:"Export"', reason: "no match after retry" },
  ]);
  assert.equal(d?.severity, "error");
  assert.equal(d?.gate, "capture");
  assert.equal(d?.path, "steps[5]");
  assert.match(d?.message ?? "", /SKIPPED at capture/);
  assert.match(d?.message ?? "", /no match after retry/);
  assert.ok(d?.fix);
});

test("a focus skip gets fix copy about arming the field, not about a missing element", () => {
  const [d] = skippedDefects([
    {
      step: 10,
      action: "type",
      target: "main h1",
      reason: "focus never reached the target — typing would go nowhere",
    },
  ]);
  // the target RESOLVED — "point the target at an element that exists" would
  // send the repair round at the wrong dimension
  assert.match(d?.fix ?? "", /never took focus/);
  assert.doesNotMatch(d?.fix ?? "", /element that exists/);
});

test("settle defects carry the measured number for beats that DID go quiet — and only those", () => {
  const ds = settleDefects([
    { step: 1, action: "click", heldMs: 900, waitedMs: 400, reason: "idle" },
    { step: 2, action: "look", heldMs: 1200, waitedMs: 3000, reason: "budget" },
    { step: 3, action: "type", heldMs: 500, waitedMs: 100, reason: "unavailable" },
  ]);
  assert.equal(ds.length, 1);
  assert.equal(ds[0]?.path, "steps[1].settleMs");
  assert.equal(ds[0]?.severity, "warn");
  assert.match(ds[0]?.fix ?? "", /1300/); // heldMs + waitedMs, copyable verbatim
});

test("the repair contract names the bound: two rounds, then a human", () => {
  const report = buildDefectReport({ verb: "check", verdict: "v", exitCode: 0, defects: [] });
  assert.match(report.repair, /VERBATIM/);
  assert.match(report.repair, /ENTIRE corrected\s+plan/);
  assert.match(report.repair, /two repair\s+rounds/);
});
