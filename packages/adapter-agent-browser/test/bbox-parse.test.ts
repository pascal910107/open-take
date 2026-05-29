// Smoke tests for the bbox parse path. Session 5 HANDOFF gotcha #1:
// the prior eval-based path returned null for every selector-bearing
// action in the dryrun. The Session 6 fix routes through
// `agent-browser get box <sel>` (purpose-built command, deterministic
// output). These tests pin the parser against every realistic shape
// the agent-browser CLI may emit so a future format change can't
// silently regress the inspector loop again.

import { test } from "node:test";
import assert from "node:assert/strict";
import { parseBboxFromBatchOutput } from "../src/index.ts";

test("parseBboxFromBatchOutput: object shape {x, y, width, height}", () => {
  // What `agent-browser get box <sel>` emits for a successful query.
  const stdout = JSON.stringify([
    { command: ["get", "box", "#input"], ok: true, output: JSON.stringify({ x: 10, y: 20, width: 100, height: 50 }) },
  ]);
  const bbox = parseBboxFromBatchOutput(stdout);
  assert.deepEqual(bbox, [10, 20, 100, 50]);
});

test("parseBboxFromBatchOutput: object shape with x/y/w/h short keys", () => {
  const stdout = JSON.stringify([
    { command: ["get", "box", "#input"], ok: true, output: JSON.stringify({ x: 12.7, y: 22.3, w: 100.6, h: 50.4 }) },
  ]);
  const bbox = parseBboxFromBatchOutput(stdout);
  assert.deepEqual(bbox, [13, 22, 101, 50]);
});

test("parseBboxFromBatchOutput: array shape [x, y, w, h]", () => {
  // What the prior eval-based path emitted: JSON.stringify of an array
  // inside the `output` field. Kept as a parser branch so we can mix
  // adapters or upgrade across CLI versions without breaking the loop.
  const stdout = JSON.stringify([
    { command: ["eval", "..."], ok: true, output: "[10, 20, 100, 50]" },
  ]);
  const bbox = parseBboxFromBatchOutput(stdout);
  assert.deepEqual(bbox, [10, 20, 100, 50]);
});

test("parseBboxFromBatchOutput: double-stringified output (the Session 5 bug)", () => {
  // The bug from gotcha #1: agent-browser's eval result serialization
  // wraps the JSON string in another JSON layer. The parser must
  // unwrap multiple layers and still find the array.
  const inner = JSON.stringify([10, 20, 100, 50]);
  const middle = JSON.stringify(inner);
  const stdout = JSON.stringify([
    { command: ["eval", "..."], ok: true, output: middle },
  ]);
  const bbox = parseBboxFromBatchOutput(stdout);
  assert.deepEqual(bbox, [10, 20, 100, 50]);
});

test("parseBboxFromBatchOutput: `result` field (alternate output key)", () => {
  // Some agent-browser versions write the result to `result` rather
  // than `output`. Parser checks all three (result / output / stdout).
  const stdout = JSON.stringify([
    { command: ["get", "box", "#input"], ok: true, result: { x: 1, y: 2, width: 3, height: 4 } },
  ]);
  const bbox = parseBboxFromBatchOutput(stdout);
  assert.deepEqual(bbox, [1, 2, 3, 4]);
});

test("parseBboxFromBatchOutput: null element returns null", () => {
  const stdout = JSON.stringify([
    { command: ["get", "box", "#missing"], ok: true, output: "null" },
  ]);
  assert.equal(parseBboxFromBatchOutput(stdout), null);
});

test("parseBboxFromBatchOutput: empty output returns null", () => {
  const stdout = JSON.stringify([{ command: ["get", "box", "#x"], ok: true, output: "" }]);
  assert.equal(parseBboxFromBatchOutput(stdout), null);
});

test("parseBboxFromBatchOutput: garbage stdout returns null without throwing", () => {
  assert.equal(parseBboxFromBatchOutput("not json at all"), null);
  assert.equal(parseBboxFromBatchOutput(""), null);
  assert.equal(parseBboxFromBatchOutput("[]"), null);
});

test("parseBboxFromBatchOutput: stdout with status lines around the JSON", () => {
  // agent-browser sometimes prints a startup line before the JSON
  // array on stdout. The parser scans for the outermost [...] window.
  const stdout =
    "[info] using existing session\n" +
    JSON.stringify([{ output: JSON.stringify({ x: 5, y: 6, width: 7, height: 8 }) }]) +
    "\n[info] done";
  const bbox = parseBboxFromBatchOutput(stdout);
  assert.deepEqual(bbox, [5, 6, 7, 8]);
});

test("parseBboxFromBatchOutput: malformed array (wrong length) returns null", () => {
  const stdout = JSON.stringify([{ output: "[1, 2, 3]" }]);
  assert.equal(parseBboxFromBatchOutput(stdout), null);
});
