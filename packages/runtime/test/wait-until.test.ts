import assert from "node:assert/strict";
import { test } from "node:test";
import { waitUntil } from "../src/cdp.js";

test("waitUntil resolves as soon as the page has done the thing", async () => {
  let painted = 0;
  setTimeout(() => {
    painted = 1;
  }, 20);
  const started = Date.now();
  assert.equal(await waitUntil(() => painted > 0, 3000), true);
  // Loose bound: the release gates run every package's tests in parallel on a
  // busy machine, so only "long before the 3 s deadline" is asserted.
  assert.ok(Date.now() - started < 1500, "returned when the condition flipped, not at the deadline");
});

test("waitUntil gives up at the deadline instead of hanging a take", async () => {
  const started = Date.now();
  assert.equal(await waitUntil(() => false, 60), false);
  const elapsed = Date.now() - started;
  assert.ok(elapsed >= 55 && elapsed < 1500, `bounded wait, got ${elapsed}ms`);
});

test("waitUntil returns immediately when the condition already holds", async () => {
  const started = Date.now();
  assert.equal(await waitUntil(() => true, 3000), true);
  assert.ok(Date.now() - started < 1500);
});
