// settle() — the hold that stops betting on settleMs.
//
// The contract in one line: the editorial hold ALWAYS runs in full, and only
// then does the page get extra time, bounded by a budget. Driven here against
// a scripted CDP so the timing is deterministic — no browser, no flake. (The
// end-to-end behaviour against real Chrome is exercised by the capture path.)

import assert from "node:assert/strict";
import { test } from "node:test";
import type { CDP } from "../src/cdp.js";
import { PAINT_BLIND_FRAC, makeBudgetGovernor, settle } from "../src/settle.js";

/** A CDP stand-in whose probe answers come from a scripted queue. `null` in
 *  the queue means "no probe installed". The last entry repeats forever. */
function fakeCdp(script: (number | null)[]): { cdp: CDP; reads: number } {
  const state = { reads: 0 };
  const cdp = {
    send: async (method: string) => {
      if (method !== "Runtime.evaluate") return {};
      const q = script[Math.min(state.reads, script.length - 1)];
      state.reads++;
      if (q === null) return { result: { value: JSON.stringify({ ok: false }) } };
      return {
        result: { value: JSON.stringify({ ok: true, quietMs: q, net: 0, anims: 0, paint: 0 }) },
      };
    },
  } as unknown as CDP;
  return {
    cdp,
    get reads() {
      return state.reads;
    },
  } as { cdp: CDP; reads: number };
}

test("a settled page costs one probe and no extra time", async () => {
  const f = fakeCdp([5000]); // quiet for ages
  const t0 = Date.now();
  const r = await settle(f.cdp, 120);
  const elapsed = Date.now() - t0;
  assert.equal(r.reason, "idle");
  assert.ok(r.waitedMs < 60, `no meaningful wait added (got ${r.waitedMs}ms)`);
  assert.ok(elapsed >= 115, `the editorial hold still ran in full (${elapsed}ms)`);
  assert.equal(f.reads, 1, "one round-trip, not a poll loop");
});

test("a busy page gets extra time, and the hold is never cut short", async () => {
  // busy, busy, then quiet — the page needed ~2 polls more than the hold
  const f = fakeCdp([0, 0, 5000]);
  const t0 = Date.now();
  const r = await settle(f.cdp, 100);
  const elapsed = Date.now() - t0;
  assert.equal(r.reason, "idle");
  assert.equal(r.heldMs, 100, "the editorial hold is reported unchanged");
  assert.ok(r.waitedMs >= 100, `waited for the page (got ${r.waitedMs}ms)`);
  assert.ok(elapsed >= 100 + r.waitedMs - 20, "the total is hold + wait, not one or the other");
});

test("a page that never goes quiet costs the budget and says so", async () => {
  const f = fakeCdp([0]); // busy forever
  const r = await settle(f.cdp, 50, { budgetMs: 300 });
  assert.equal(r.reason, "budget", "the wait is bounded, not open-ended");
  assert.ok(r.waitedMs >= 300 && r.waitedMs < 900, `stopped near the budget (got ${r.waitedMs}ms)`);
});

test("budgetMs 0 is exactly the old fixed sleep", async () => {
  const f = fakeCdp([0]);
  const t0 = Date.now();
  const r = await settle(f.cdp, 120, { budgetMs: 0 });
  const elapsed = Date.now() - t0;
  assert.equal(r.waitedMs, 0, "no wait");
  assert.equal(f.reads, 0, "the page is not even asked");
  assert.ok(elapsed >= 115 && elapsed < 300, `just the hold (${elapsed}ms)`);
});

test("no probe installed degrades to the old behaviour, not to a stall", async () => {
  const f = fakeCdp([null]);
  const r = await settle(f.cdp, 40, { budgetMs: 500 });
  assert.equal(r.reason, "unavailable");
  assert.ok(r.waitedMs < 100, "gives up immediately rather than polling a page that cannot answer");
});

// --- the damage bound ------------------------------------------------------
// A page that never goes quiet (a one-second clock, a poll loop) cannot be told
// apart from real work by any DOM signal. Measured before this guard existed: a
// clock page turned a 4-beat capture from ~5.2s into ~10.3s and reported every
// single beat as needing more time. The governor is what makes that bounded.

test("the budget survives an isolated slow beat", () => {
  const g = makeBudgetGovernor(1200);
  assert.equal(g.record("budget"), false, "one slow beat is just a slow beat");
  assert.equal(g.record("idle"), false, "…and settling resets the run");
  assert.equal(g.record("budget"), false);
  assert.equal(g.budgetMs, 1200, "still waiting for pages that might settle");
  assert.equal(g.gaveUp, false);
});

test("a page that never settles is written off after a short run", () => {
  const g = makeBudgetGovernor(1200);
  assert.equal(g.record("budget"), false, "first strike");
  assert.equal(g.record("budget"), true, "second strike gives up — and says so exactly once");
  assert.equal(g.budgetMs, 0, "every later beat costs nothing");
  assert.equal(g.gaveUp, true);
  assert.equal(g.record("budget"), false, "and it never announces itself twice");
});

test("giving up is permanent — a lucky later beat cannot switch it back on", () => {
  const g = makeBudgetGovernor(1200);
  g.record("budget");
  g.record("budget");
  g.record("idle"); // with the budget at 0 every beat trivially "settles"
  assert.equal(g.budgetMs, 0, "a beat that settles because we stopped waiting proves nothing");
});

test("an explicitly disabled budget never reports giving up", () => {
  const g = makeBudgetGovernor(0);
  assert.equal(g.record("budget"), false);
  assert.equal(g.record("budget"), false);
  assert.equal(g.gaveUp, false, "the author turned it off; that is not a finding");
});

// --- the canvas blind spot -------------------------------------------------
// Verified against real Chrome: a <canvas> painting for 1.5s via rAF reports
// ZERO beats needing more time — the probe reads structure, and a paint surface
// has none to change. So the size of that surface is the only warning available,
// and settle() must carry it out even on the runs that look perfectly clean.

test("a settled beat still reports how much of the frame is a paint surface", async () => {
  const cdp = {
    send: async (method: string) => {
      if (method !== "Runtime.evaluate") return {};
      return {
        result: {
          value: JSON.stringify({ ok: true, quietMs: 5000, net: 0, anims: 0, paint: 0.91 }),
        },
      };
    },
  } as unknown as CDP;
  const r = await settle(cdp, 20);
  assert.equal(r.reason, "idle", "the page really did look still — that is the whole problem");
  assert.equal(r.waitedMs < 60, true, "and it cost nothing, so nothing else would flag it");
  assert.equal(r.paintFrac, 0.91, "the surface share still reaches the caller");
  assert.ok(r.paintFrac >= PAINT_BLIND_FRAC, "…and clears the reporting bar");
});

test("an ordinary DOM page reports no paint surface at all", async () => {
  const f = fakeCdp([5000]); // the shared stub answers paint-free
  const r = await settle(f.cdp, 20);
  assert.equal(r.paintFrac, 0, "nothing to warn about");
  assert.ok(r.paintFrac < PAINT_BLIND_FRAC);
});
