import assert from "node:assert/strict";
import { test } from "node:test";
import {
  type ConflictNotice,
  type OperationResult,
  resolveConflictAction,
  shouldKeepConflict,
} from "../src/lib/conflict.js";

const conflict = (operation: ConflictNotice["operation"]): ConflictNotice => ({
  mtime: 42,
  operation,
});

test("adopting theirs reports a reload failure and does not discard conflict state", async () => {
  let rebased = false;
  let retried = false;
  const result = await resolveConflictAction("theirs", conflict("save"), {
    reload: async () => false,
    rebase: () => {
      rebased = true;
    },
    retrySave: async () => {
      retried = true;
      return "done";
    },
    retryExport: async () => {
      retried = true;
      return "done";
    },
  });

  assert.equal(result, "error");
  assert.equal(rebased, false);
  assert.equal(retried, false);
});

test("keeping mine after an export conflict re-bases and retries export directly", async () => {
  const calls: string[] = [];
  const result = await resolveConflictAction("mine", conflict("export"), {
    reload: async () => true,
    rebase: (mtime) => calls.push(`rebase:${mtime}`),
    retrySave: async () => {
      calls.push("save");
      return "done";
    },
    retryExport: async (): Promise<OperationResult> => {
      calls.push("export");
      return "done";
    },
  });

  assert.equal(result, "done");
  assert.deepEqual(calls, ["rebase:42", "export"]);
});

test("keeping mine after an autosave conflict retries save, not export", async () => {
  const calls: string[] = [];
  await resolveConflictAction("mine", conflict("save"), {
    reload: async () => true,
    rebase: () => calls.push("rebase"),
    retrySave: async () => {
      calls.push("save");
      return "done";
    },
    retryExport: async () => {
      calls.push("export");
      return "done";
    },
  });
  assert.deepEqual(calls, ["rebase", "save"]);
});

test("a keep-mine operation error does not resurrect the old write conflict", () => {
  assert.equal(shouldKeepConflict("mine", "error"), false);
  assert.equal(shouldKeepConflict("mine", "conflict"), true);
  assert.equal(shouldKeepConflict("theirs", "error"), true, "failed reload keeps the choice open");
});
