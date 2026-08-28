// runPostShootGates — the bounded-re-render orchestrator. Pure sequencing
// tests with injected gates: what triggers the ONE re-render (a cursor-audit
// ERROR and nothing else), that every gate re-runs after it (repairs re-roll
// defects), and that no failure inside a gate or the re-render can escalate
// past a warn line.

import assert from "node:assert/strict";
import { test } from "node:test";
import type { CompositionIssue } from "@open-take/compositor";
import {
  healingWithheld,
  type PostShootIO,
  type PostShootPass,
  runPostShootGates,
} from "../src/post-shoot";

const err = (message: string): CompositionIssue => ({ severity: "error", path: "events", message });
const warn = (message: string): CompositionIssue => ({ severity: "warn", path: "events", message });

type Trace = {
  calls: string[];
  findings: Array<{ pass: PostShootPass; issues: CompositionIssue[] }>;
  logs: string[];
  warns: string[];
};

/** Build an IO whose gates replay per-pass scripts and record every call. */
function io(opts: {
  check?: Array<CompositionIssue[] | Error>;
  cursor?: Array<CompositionIssue[] | Error>;
  reRender?: (() => Promise<void>) | "ok" | "boom";
}): { io: PostShootIO; trace: Trace } {
  const trace: Trace = { calls: [], findings: [], logs: [], warns: [] };
  const scripted =
    (name: string, script: Array<CompositionIssue[] | Error>) =>
    async (): Promise<CompositionIssue[]> => {
      const n = trace.calls.filter((c) => c === name).length;
      trace.calls.push(name);
      const step = script[Math.min(n, script.length - 1)] ?? [];
      if (step instanceof Error) throw step;
      return step;
    };
  const base: PostShootIO = {
    checkTake: scripted("check", opts.check ?? [[]]),
    auditCursor: scripted("cursor", opts.cursor ?? [[]]),
    onFindings: (issues, pass) => trace.findings.push({ pass, issues }),
    log: (line) => trace.logs.push(line),
    warn: (line) => trace.warns.push(line),
  };
  if (opts.reRender === "ok")
    base.reRender = async () => {
      trace.calls.push("reRender");
    };
  else if (opts.reRender === "boom")
    base.reRender = async () => {
      trace.calls.push("reRender");
      throw new Error("render exploded");
    };
  else if (opts.reRender) base.reRender = opts.reRender;
  return { io: base, trace };
}

test("clean take: one pass, no re-render, zero errors", async () => {
  const { io: t, trace } = io({ reRender: "ok" });
  const res = await runPostShootGates(t);
  assert.deepEqual(trace.calls, ["check", "cursor"]);
  assert.equal(res.errors, 0);
  assert.equal(res.reRendered, false);
  assert.equal(trace.findings.length, 1);
  assert.equal(trace.findings[0]!.pass, "post-shoot");
});

test("cursor error + transient: re-render runs ONCE, verdict comes from the second pass", async () => {
  const { io: t, trace } = io({
    cursor: [[err("drawn 11.9px off")], []],
    reRender: "ok",
  });
  const res = await runPostShootGates(t);
  assert.deepEqual(trace.calls, ["check", "cursor", "reRender", "check", "cursor"]);
  assert.equal(res.reRendered, true);
  assert.equal(res.errors, 0);
  assert.deepEqual(res.issues, []);
  assert.equal(trace.findings[1]!.pass, "re-audit");
  assert.match(trace.logs.at(-1)!, /transient/);
});

test("cursor error persists: exactly one re-render ever (bounded), errors survive", async () => {
  const { io: t, trace } = io({
    cursor: [[err("drawn 11.9px off")], [err("still 11.9px off")]],
    reRender: "ok",
  });
  const res = await runPostShootGates(t);
  assert.equal(trace.calls.filter((c) => c === "reRender").length, 1);
  assert.equal(res.reRendered, true);
  assert.equal(res.errors, 1);
  assert.match(trace.logs.at(-1)!, /STILL off/);
});

test("checkTake error alone does NOT trigger the re-render (it cannot heal those)", async () => {
  const { io: t, trace } = io({
    check: [[err("0.8s dead opening")]],
    reRender: "ok",
  });
  const res = await runPostShootGates(t);
  assert.ok(!trace.calls.includes("reRender"));
  assert.equal(res.errors, 1);
  assert.equal(res.reRendered, false);
});

test("cursor WARN alone (offscreen tips / nothing to audit) does not trigger the re-render", async () => {
  const { io: t, trace } = io({
    cursor: [[warn("no pointer-landing beats to audit")]],
    reRender: "ok",
  });
  const res = await runPostShootGates(t);
  assert.ok(!trace.calls.includes("reRender"));
  assert.equal(res.errors, 0);
});

test("no reRender wired (check verb / doomed take): report-only single pass", async () => {
  const { io: t, trace } = io({ cursor: [[err("drawn 11.9px off")]] });
  const res = await runPostShootGates(t);
  assert.deepEqual(trace.calls, ["check", "cursor"]);
  assert.equal(res.errors, 1);
  assert.equal(res.reRendered, false);
});

test("re-render crash: first pass's findings kept, reported as a warn, never thrown", async () => {
  const first = [err("drawn 11.9px off")];
  const { io: t, trace } = io({ cursor: [first], reRender: "boom" });
  const res = await runPostShootGates(t);
  assert.equal(res.reRendered, false);
  assert.deepEqual(res.issues, first);
  assert.equal(res.errors, 1);
  assert.ok(trace.warns.some((w) => /re-render failed/.test(w) && /render exploded/.test(w)));
  // the crash must not produce a second findings block — nothing new was measured
  assert.equal(trace.findings.length, 1);
});

test("a crashing gate is isolated: the other gate's findings survive, a warn line lands, and the crash is NAMED in the result", async () => {
  const { io: t, trace } = io({
    check: [new Error("no ffmpeg")],
    cursor: [[warn("one offscreen beat")]],
  });
  const res = await runPostShootGates(t);
  assert.equal(res.issues.length, 1);
  assert.ok(trace.warns.some((w) => /take checks did not run: no ffmpeg/.test(w)));
  assert.deepEqual(res.crashed, ["take checks"]);
});

test("a crashing cursor audit cannot trigger the re-render, and is named in crashed", async () => {
  const { io: t, trace } = io({ cursor: [new Error("bad mp4")], reRender: "ok" });
  const res = await runPostShootGates(t);
  assert.ok(!trace.calls.includes("reRender"));
  assert.equal(res.errors, 0);
  assert.ok(trace.warns.some((w) => /cursor audit did not run: bad mp4/.test(w)));
  assert.deepEqual(res.crashed, ["cursor audit"]);
});

test("a clean run reports no crashed gates", async () => {
  const { io: t } = io({});
  const res = await runPostShootGates(t);
  assert.deepEqual(res.crashed, []);
});

test("re-audit cursor crash: the FIRST audit's measured error survives — an unverifiable re-render is not a heal", async () => {
  const first = err("drawn 11.9px off");
  const { io: t, trace } = io({
    cursor: [[first], new Error("bad mp4 after re-render")],
    reRender: "ok",
  });
  const res = await runPostShootGates(t);
  assert.equal(trace.calls.filter((c) => c === "reRender").length, 1);
  assert.equal(res.reRendered, true);
  assert.equal(res.errors, 1);
  assert.deepEqual(res.issues, [first]);
  // the first pass DID measure — the verdict has data, so nothing is "crashed"
  assert.deepEqual(res.crashed, []);
  assert.match(trace.logs.at(-1)!, /could not re-measure/);
  assert.ok(!trace.logs.some((l) => /cursor clean/.test(l)));
});

test("re-audit checkTake crash: its first-pass findings carry into the verdict", async () => {
  const dead = err("0.8s dead opening");
  const { io: t } = io({
    check: [[dead], new Error("ffmpeg died on pass 2")],
    cursor: [[err("drawn 11.9px off")], []],
    reRender: "ok",
  });
  const res = await runPostShootGates(t);
  assert.equal(res.reRendered, true);
  assert.deepEqual(res.issues, [dead]);
  assert.equal(res.errors, 1);
  assert.deepEqual(res.crashed, []);
});

test("healingWithheld: only a skipped take under strict loses its heal", () => {
  assert.equal(healingWithheld(0, true), false);
  assert.equal(healingWithheld(0, false), false);
  assert.equal(healingWithheld(3, true), true);
  assert.equal(healingWithheld(3, false), false);
});

test("re-rolled defect: a NEW checkTake error after the heal reaches the verdict", async () => {
  const { io: t } = io({
    check: [[], [err("static tail appeared after the re-render")]],
    cursor: [[err("drawn 11.9px off")], []],
    reRender: "ok",
  });
  const res = await runPostShootGates(t);
  assert.equal(res.reRendered, true);
  assert.equal(res.errors, 1);
  assert.match(res.issues[0]!.message, /static tail/);
});
