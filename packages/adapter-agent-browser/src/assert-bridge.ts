// Per-assert evaluation. The agent-browser CLI surfaces "is visible
// <sel>", "get text <sel>", "get url", and "snapshot" — none of which
// know the demo author's intent. This module compares those raw
// outputs against the BrowserAction's expected value and produces a
// structured AssertionResult.
//
// Before Session 7 the runtime treated every assert-action as PASS so
// long as the subprocess exited 0 (which is true for any "get" the
// element is reachable for, regardless of value). That heuristic
// happily green-lit a demo whose `Browser.assertText("#log", "won")`
// observed "lost" — exactly the demo-as-test regression D12 warns
// about. The fix lives here so it's covered by smoke tests.
//
// `assertA11yTreeMatches` resolves its golden file relative to a
// workspaceRoot when one is plumbed through (BrowserOpts.workspaceRoot
// → AgentBrowserSession → here). Absolute paths bypass resolution.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import type { AssertionResult, BrowserAction } from "@open-take/core";

export type BatchEntry = {
  command?: string[];
  ok?: boolean;
  exitCode?: number;
  stdout?: string;
  stderr?: string;
  output?: string;
  error?: string;
};

export type EvaluateContext = {
  workspaceRoot?: string;
  // When true, assertA11yTreeMatches writes the observed tree to
  // snapshotPath (creating the file + parent dirs if missing,
  // overwriting on divergence) and returns PASS. Jest's
  // --update-snapshot semantics applied to a11y goldens.
  updateSnapshots?: boolean;
};

// AssertionResult extended with the observed value, so the runtime can
// stash it for diff reporting. Stays AssertionResult-shaped at the
// type level (the runtime treats `actual` as optional metadata).
export type RichAssertionResult = AssertionResult & { actual?: string };

export function evaluateAssertion(
  action: BrowserAction,
  slice: BatchEntry[],
  ctx: EvaluateContext = {},
): RichAssertionResult {
  // Any subprocess crash means the assertion can't be evaluated; fail
  // loud with the stderr/error text so the CI report points at the
  // right cause.
  for (const r of slice) {
    if (r.ok === false || (typeof r.exitCode === "number" && r.exitCode !== 0)) {
      const msg = r.error || r.stderr || `agent-browser exited ${r.exitCode ?? "?"}`;
      return { ok: false, kind: action.kind, message: msg };
    }
  }

  const lastOutput = (slice[slice.length - 1]?.output ?? slice[slice.length - 1]?.stdout ?? "").trim();

  switch (action.kind) {
    case "browser.assertVisible": {
      const truthy = parseBoolish(lastOutput);
      if (truthy === true) return { ok: true, kind: action.kind, actual: "true" };
      return {
        ok: false,
        kind: action.kind,
        message: `expected ${action.ref} to be visible; got ${JSON.stringify(lastOutput)}`,
        actual: lastOutput,
      };
    }
    case "browser.assertText": {
      const text = unquote(lastOutput);
      if (text.includes(action.text)) {
        return { ok: true, kind: action.kind, actual: text };
      }
      return {
        ok: false,
        kind: action.kind,
        message: `expected text containing ${JSON.stringify(action.text)} in ${action.ref}; got ${JSON.stringify(text)}`,
        actual: text,
      };
    }
    case "browser.assertUrl": {
      const url = unquote(lastOutput);
      let matched = false;
      try {
        matched = new RegExp(action.pattern).test(url);
      } catch {
        // not a valid regex — fall through to literal contains/equals
        // (lets authors write Browser.assertUrl("foo.com/bar") without
        // escaping dots).
        matched = url === action.pattern || url.includes(action.pattern);
      }
      if (matched) return { ok: true, kind: action.kind, actual: url };
      return {
        ok: false,
        kind: action.kind,
        message: `expected url matching ${JSON.stringify(action.pattern)}; got ${JSON.stringify(url)}`,
        actual: url,
      };
    }
    case "browser.assertA11yTreeMatches": {
      const goldenPath = isAbsolute(action.snapshotPath)
        ? action.snapshotPath
        : resolve(ctx.workspaceRoot ?? process.cwd(), action.snapshotPath);
      const goldenExists = existsSync(goldenPath);
      if (!goldenExists) {
        if (ctx.updateSnapshots) {
          writeSnapshotAtomic(goldenPath, lastOutput);
          return {
            ok: true,
            kind: action.kind,
            message: `snapshot written: ${goldenPath} (--update-snapshots)`,
            actual: lastOutput.slice(0, 4000),
          };
        }
        return {
          ok: false,
          kind: action.kind,
          message:
            `snapshot file not found: ${goldenPath} ` +
            "(seed it by writing the current a11y tree to that path on first run, " +
            "or re-run with --update-snapshots)",
          actual: lastOutput.slice(0, 4000),
        };
      }
      const golden = readFileSync(goldenPath, "utf8");
      if (a11yMatches(golden, lastOutput)) {
        return { ok: true, kind: action.kind };
      }
      if (ctx.updateSnapshots) {
        writeSnapshotAtomic(goldenPath, lastOutput);
        return {
          ok: true,
          kind: action.kind,
          message: `snapshot updated: ${goldenPath} (--update-snapshots; was divergent)`,
          actual: lastOutput.slice(0, 4000),
        };
      }
      return {
        ok: false,
        kind: action.kind,
        message: `a11y tree diverges from snapshot at ${goldenPath}; ${firstDiffSummary(golden, lastOutput)}`,
        actual: lastOutput.slice(0, 4000),
      };
    }
    default:
      return { ok: true, kind: (action as BrowserAction).kind };
  }
}

function parseBoolish(s: string): boolean | null {
  const t = s.trim().toLowerCase();
  if (t === "true") return true;
  if (t === "false") return false;
  try {
    const parsed = JSON.parse(s);
    if (typeof parsed === "boolean") return parsed;
  } catch {
    // not JSON
  }
  return null;
}

function unquote(s: string): string {
  const t = s.trim();
  if (t.length >= 2) {
    const first = t[0];
    const last = t[t.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      try {
        const parsed = JSON.parse(t);
        if (typeof parsed === "string") return parsed;
      } catch {
        return t.slice(1, -1);
      }
    }
  }
  return t;
}

// Snapshot equality. Tries JSON canonical compare first (most common
// shape for a11y trees); falls back to whitespace-normalized text
// compare so authors can keep snapshots as pretty-printed JSON or as
// a serialized tree dump.
export function a11yMatches(golden: string, actual: string): boolean {
  try {
    const a = JSON.parse(golden);
    const b = JSON.parse(actual);
    return canonicalize(a) === canonicalize(b);
  } catch {
    return normalizeWs(golden) === normalizeWs(actual);
  }
}

function canonicalize(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonicalize).join(",")}]`;
  const o = v as Record<string, unknown>;
  const keys = Object.keys(o).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalize(o[k])}`).join(",")}}`;
}

function normalizeWs(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

// Pretty-print JSON when the observed tree parses cleanly so the
// golden diffs readably in git; otherwise write the raw text. Atomic
// tmp+rename so concurrent reads never see a half-written snapshot
// (D22 disciplines the cache; the same hygiene applies here).
function writeSnapshotAtomic(path: string, observed: string): void {
  mkdirSync(dirname(path), { recursive: true });
  let body = observed;
  try {
    body = JSON.stringify(JSON.parse(observed), null, 2) + "\n";
  } catch {
    // not JSON — write raw, trim trailing whitespace, ensure newline.
    body = observed.replace(/\s+$/, "") + "\n";
  }
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, body);
  renameSync(tmp, path);
}

function firstDiffSummary(a: string, b: string): string {
  const an = normalizeWs(a);
  const bn = normalizeWs(b);
  for (let i = 0; i < Math.min(an.length, bn.length); i++) {
    if (an[i] !== bn[i]) {
      const lo = Math.max(0, i - 16);
      return `first diff @ ${i}: …${an.slice(lo, i + 16)}… vs …${bn.slice(lo, i + 16)}…`;
    }
  }
  return `lengths ${an.length} vs ${bn.length}`;
}
