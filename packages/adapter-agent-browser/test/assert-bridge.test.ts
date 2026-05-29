// Smoke tests for assert-bridge.ts. Before Session 7 the runtime ran
// every browser.assert* through a "subprocess exited 0 → PASS"
// heuristic. That happily green-lit a demo whose Browser.assertText
// expected one value and observed another — exactly the D12 demo-as-
// test regression we ship to catch.
//
// Each test feeds a fake agent-browser stdout JSON array to
// parseBatchResult and asserts the resulting AssertionResult shape.

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BrowserAction } from "@open-take/core";
import { parseBatchResult } from "../src/index.ts";

function stdout(entries: object[]): string {
  return JSON.stringify(entries);
}

test("assertVisible: 'true' output passes", () => {
  const actions: BrowserAction[] = [{ kind: "browser.assertVisible", ref: "#btn" }];
  const out = parseBatchResult(
    stdout([{ command: ["is", "visible", "#btn"], ok: true, output: "true" }]),
    actions,
  );
  assert.equal(out.assertions.length, 1);
  assert.equal(out.assertions[0]!.ok, true);
  assert.equal(out.assertions[0]!.kind, "browser.assertVisible");
});

test("assertVisible: 'false' output fails with diagnostic message", () => {
  const actions: BrowserAction[] = [{ kind: "browser.assertVisible", ref: "#missing" }];
  const out = parseBatchResult(
    stdout([{ command: ["is", "visible", "#missing"], ok: true, output: "false" }]),
    actions,
  );
  assert.equal(out.assertions[0]!.ok, false);
  assert.match(out.assertions[0]!.message ?? "", /#missing/);
  assert.match(out.assertions[0]!.message ?? "", /visible/);
});

test("assertVisible: subprocess error fails with stderr message", () => {
  const actions: BrowserAction[] = [{ kind: "browser.assertVisible", ref: "#btn" }];
  const out = parseBatchResult(
    stdout([
      { command: ["is", "visible", "#btn"], ok: false, exitCode: 1, stderr: "element not found" },
    ]),
    actions,
  );
  assert.equal(out.assertions[0]!.ok, false);
  assert.match(out.assertions[0]!.message ?? "", /element not found/);
});

test("assertText: substring match passes", () => {
  const actions: BrowserAction[] = [
    { kind: "browser.assertText", ref: "#log", text: "clicked" },
  ];
  const out = parseBatchResult(
    stdout([
      { command: ["get", "text", "#log"], ok: true, output: '"clicked just now"' },
    ]),
    actions,
  );
  assert.equal(out.assertions[0]!.ok, true);
});

test("assertText: mismatch fails and reports observed vs expected", () => {
  const actions: BrowserAction[] = [
    { kind: "browser.assertText", ref: "#log", text: "won" },
  ];
  const out = parseBatchResult(
    stdout([{ command: ["get", "text", "#log"], ok: true, output: "lost" }]),
    actions,
  );
  assert.equal(out.assertions[0]!.ok, false);
  assert.match(out.assertions[0]!.message ?? "", /"won"/);
  assert.match(out.assertions[0]!.message ?? "", /lost/);
});

test("assertUrl: regex pattern passes when url matches", () => {
  const actions: BrowserAction[] = [
    { kind: "browser.assertUrl", pattern: "^https?://.*/index\\.html" },
  ];
  const out = parseBatchResult(
    stdout([{ command: ["get", "url"], ok: true, output: "https://localhost/index.html" }]),
    actions,
  );
  assert.equal(out.assertions[0]!.ok, true);
});

test("assertUrl: literal substring fallback when pattern isn't a valid regex", () => {
  const actions: BrowserAction[] = [
    { kind: "browser.assertUrl", pattern: "[invalid(regex" },
  ];
  const out = parseBatchResult(
    stdout([{ command: ["get", "url"], ok: true, output: "https://example.com/?q=[invalid(regex" }]),
    actions,
  );
  // The bad regex falls back to literal contains; output contains the
  // pattern verbatim, so this passes.
  assert.equal(out.assertions[0]!.ok, true);
});

test("assertUrl: mismatch fails", () => {
  const actions: BrowserAction[] = [
    { kind: "browser.assertUrl", pattern: "/dashboard$" },
  ];
  const out = parseBatchResult(
    stdout([{ command: ["get", "url"], ok: true, output: "https://localhost/login" }]),
    actions,
  );
  assert.equal(out.assertions[0]!.ok, false);
});

test("assertA11yTreeMatches: golden file equality passes (JSON canonical compare)", () => {
  const work = mkdtempSync(join(tmpdir(), "assert-a11y-"));
  try {
    const goldenPath = join(work, "golden.json");
    // Same content but different key order — canonical compare normalizes.
    writeFileSync(goldenPath, JSON.stringify({ role: "button", name: "Click me" }));
    const actions: BrowserAction[] = [
      { kind: "browser.assertA11yTreeMatches", snapshotPath: goldenPath },
    ];
    const out = parseBatchResult(
      stdout([
        { command: ["snapshot"], ok: true, output: JSON.stringify({ name: "Click me", role: "button" }) },
      ]),
      actions,
    );
    assert.equal(out.assertions[0]!.ok, true);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test("assertA11yTreeMatches: divergence fails with first-diff context", () => {
  const work = mkdtempSync(join(tmpdir(), "assert-a11y-"));
  try {
    const goldenPath = join(work, "golden.json");
    writeFileSync(goldenPath, JSON.stringify({ role: "button", name: "Submit" }));
    const actions: BrowserAction[] = [
      { kind: "browser.assertA11yTreeMatches", snapshotPath: goldenPath },
    ];
    const out = parseBatchResult(
      stdout([
        { command: ["snapshot"], ok: true, output: JSON.stringify({ role: "button", name: "Cancel" }) },
      ]),
      actions,
    );
    assert.equal(out.assertions[0]!.ok, false);
    assert.match(out.assertions[0]!.message ?? "", /diverges|first diff/);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test("assertA11yTreeMatches: missing golden file fails with helpful message", () => {
  const actions: BrowserAction[] = [
    { kind: "browser.assertA11yTreeMatches", snapshotPath: "/nonexistent/snap.json" },
  ];
  const out = parseBatchResult(
    stdout([{ command: ["snapshot"], ok: true, output: "{}" }]),
    actions,
  );
  assert.equal(out.assertions[0]!.ok, false);
  assert.match(out.assertions[0]!.message ?? "", /not found/);
});

test("assertA11yTreeMatches + updateSnapshots: missing golden is created from observed tree and passes", () => {
  const work = mkdtempSync(join(tmpdir(), "assert-a11y-"));
  try {
    // Path includes a nested dir that doesn't exist yet — the writer
    // must mkdir -p before writing (real-world demos park snapshots
    // under a per-step subdir).
    const goldenPath = join(work, "nested", "step-001", "golden.json");
    const observed = JSON.stringify({ role: "button", name: "Submit" });
    const actions: BrowserAction[] = [
      { kind: "browser.assertA11yTreeMatches", snapshotPath: goldenPath },
    ];
    const out = parseBatchResult(
      stdout([{ command: ["snapshot"], ok: true, output: observed }]),
      actions,
      { updateSnapshots: true },
    );
    assert.equal(out.assertions[0]!.ok, true);
    assert.match(out.assertions[0]!.message ?? "", /snapshot written/);
    assert.equal(existsSync(goldenPath), true);
    // Stored pretty-printed; canonical-JSON match against observed.
    const onDisk = JSON.parse(readFileSync(goldenPath, "utf8"));
    assert.deepEqual(onDisk, { role: "button", name: "Submit" });
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test("assertA11yTreeMatches + updateSnapshots: divergent golden is overwritten and passes", () => {
  const work = mkdtempSync(join(tmpdir(), "assert-a11y-"));
  try {
    const goldenPath = join(work, "golden.json");
    writeFileSync(goldenPath, JSON.stringify({ role: "button", name: "Submit" }));
    const observed = JSON.stringify({ role: "button", name: "Cancel" });
    const actions: BrowserAction[] = [
      { kind: "browser.assertA11yTreeMatches", snapshotPath: goldenPath },
    ];
    const out = parseBatchResult(
      stdout([{ command: ["snapshot"], ok: true, output: observed }]),
      actions,
      { updateSnapshots: true },
    );
    assert.equal(out.assertions[0]!.ok, true);
    assert.match(out.assertions[0]!.message ?? "", /snapshot updated/);
    const onDisk = JSON.parse(readFileSync(goldenPath, "utf8"));
    assert.deepEqual(onDisk, { role: "button", name: "Cancel" });
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test("assertA11yTreeMatches + updateSnapshots: matching golden passes without rewriting", () => {
  const work = mkdtempSync(join(tmpdir(), "assert-a11y-"));
  try {
    const goldenPath = join(work, "golden.json");
    const goldenContent = JSON.stringify({ role: "button", name: "Submit" });
    writeFileSync(goldenPath, goldenContent);
    const actions: BrowserAction[] = [
      { kind: "browser.assertA11yTreeMatches", snapshotPath: goldenPath },
    ];
    const out = parseBatchResult(
      stdout([{ command: ["snapshot"], ok: true, output: goldenContent }]),
      actions,
      { updateSnapshots: true },
    );
    assert.equal(out.assertions[0]!.ok, true);
    // Match path returns no message (control: writer was not invoked).
    assert.equal(out.assertions[0]!.message, undefined);
    // Content on disk unchanged (the writer would have pretty-printed
    // and added a trailing newline).
    assert.equal(readFileSync(goldenPath, "utf8"), goldenContent);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test("mixed step: passing assertVisible + failing assertText surface separately", () => {
  const actions: BrowserAction[] = [
    { kind: "browser.goto", url: "file:///x" },
    { kind: "browser.click", ref: "#btn" },
    { kind: "browser.assertVisible", ref: "#log" },
    { kind: "browser.assertText", ref: "#log", text: "won" },
  ];
  // open + click each emit one entry; assertVisible emits one; assertText
  // emits one (get text). Total 4 entries.
  const out = parseBatchResult(
    stdout([
      { command: ["open", "file:///x"], ok: true, output: "" },
      { command: ["click", "#btn"], ok: true, output: "" },
      { command: ["is", "visible", "#log"], ok: true, output: "true" },
      { command: ["get", "text", "#log"], ok: true, output: "lost" },
    ]),
    actions,
  );
  assert.equal(out.assertions.length, 2);
  assert.equal(out.assertions[0]!.ok, true);
  assert.equal(out.assertions[0]!.kind, "browser.assertVisible");
  assert.equal(out.assertions[1]!.ok, false);
  assert.equal(out.assertions[1]!.kind, "browser.assertText");
});
