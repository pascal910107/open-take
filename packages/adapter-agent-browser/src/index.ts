// AgentBrowserDriver — D8 primary. Subprocess against `agent-browser`
// CLI. Each step's actions are coalesced into one `agent-browser batch`
// invocation, with `record start` / `record stop` wrapping the batch
// to capture the segment video.
//
// State save/restore via session-file copy at ~/.agent-browser/sessions/.
// See spike-1b/runtime.ts for the validated shape.

import { spawn, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import type {
  ActionBatchResult,
  ActionResult,
  AssertionResult,
  BBox,
  BrowserAction,
  BrowserDriver,
  BrowserOpts,
  BrowserSession,
  DeterminismOpts,
} from "@open-take/core";
import { actionToArgv } from "./action-argv.js";
import { type BatchEntry, evaluateAssertion } from "./assert-bridge.js";

const AB_SESSIONS_DIR = resolve(homedir(), ".agent-browser/sessions");

function abSessionFile(name: string): string {
  return resolve(AB_SESSIONS_DIR, `${name}-default.json`);
}

function ensureDir(p: string) {
  mkdirSync(p, { recursive: true });
}

function resolveBin(): string {
  // Prefer the locally-installed binary; fall back to PATH.
  const local = resolve(process.cwd(), "node_modules/.bin/agent-browser");
  if (existsSync(local)) return local;
  return "agent-browser";
}

export type AgentBrowserDriverOpts = {
  binPath?: string;
};

export class AgentBrowserDriver implements BrowserDriver {
  private binPath: string;
  constructor(opts: AgentBrowserDriverOpts = {}) {
    this.binPath = opts.binPath ?? resolveBin();
  }

  async open(opts: BrowserOpts): Promise<BrowserSession> {
    const sessionName = opts.sessionName ?? `open-take-${Math.random().toString(36).slice(2, 10)}`;
    return new AgentBrowserSession(
      this.binPath,
      sessionName,
      opts.workspaceRoot,
      opts.updateSnapshots ?? false,
    );
  }
}

export class AgentBrowserSession implements BrowserSession {
  private videoPath: string | null = null;
  private closed = false;

  constructor(
    private binPath: string,
    public sessionName: string,
    private workspaceRoot?: string,
    private updateSnapshots: boolean = false,
  ) {}

  async dispose(): Promise<void> {
    if (this.closed) return;
    // Best-effort close so the session file is flushed.
    spawnSync(this.binPath, ["--session-name", this.sessionName, "close"], {
      encoding: "utf8",
    });
    this.closed = true;
  }

  async restoreStateFile(path: string): Promise<void> {
    if (!existsSync(path)) return;
    ensureDir(AB_SESSIONS_DIR);
    const live = abSessionFile(this.sessionName);
    if (existsSync(live)) rmSync(live, { force: true });
    copyFileSync(path, live);
  }

  async saveStateFile(path: string): Promise<void> {
    // Flush whatever's running; the close command persists the session
    // file to disk.
    spawnSync(this.binPath, ["--session-name", this.sessionName, "close"], {
      encoding: "utf8",
    });
    this.closed = true;
    const live = abSessionFile(this.sessionName);
    if (!existsSync(live)) return;
    ensureDir(dirname(path));
    copyFileSync(live, path);
  }

  async startVideo(path: string): Promise<void> {
    this.videoPath = path;
    ensureDir(dirname(path));
    if (existsSync(path)) rmSync(path, { force: true });
  }

  async stopVideo(): Promise<void> {
    // No-op. record start/stop are emitted as part of the batch in
    // runActionBatch — D8 mandatory single-batch-per-step.
  }

  async runActionBatch(actions: BrowserAction[]): Promise<ActionBatchResult> {
    if (this.closed) {
      throw new Error("AgentBrowserSession.runActionBatch called on a closed session");
    }
    // Spike 1c finding: a step that doesn't start with an `open` action
    // ends up recording about:blank because session-restore doesn't
    // carry the URL. If no goto is present in this batch, fail loud
    // rather than silently capture a blank frame.
    const firstNonGotoIdx = actions.findIndex((a) => a.kind === "browser.goto");
    if (this.videoPath !== null && actions.length > 0 && firstNonGotoIdx !== 0) {
      // Allow no-actions batches and goto-first batches. Anything else
      // with a video target violates the recorded-window-must-have-URL
      // contract.
      throw new Error(
        `AgentBrowserDriver: when recording, the first action of each step must be ` +
          `Browser.goto(url) (Spike 1c: session-restore does not carry URL). ` +
          `Got first action of kind "${actions[0]?.kind}".`,
      );
    }

    // Build the JSON batch payload.
    const cmds: string[][] = [];

    // Open first (so record start has an active page), then begin
    // recording, then the rest.
    let recordingStarted = false;
    for (let i = 0; i < actions.length; i++) {
      const a = actions[i]!;
      for (const argv of actionToArgv(a)) cmds.push(argv);
      if (i === 0 && this.videoPath !== null) {
        cmds.push(["record", "start", this.videoPath]);
        recordingStarted = true;
      }
    }
    if (recordingStarted) {
      cmds.push(["record", "stop"]);
    }

    const stdoutText = await this.runBatch(cmds);
    return parseBatchResult(stdoutText, actions, {
      workspaceRoot: this.workspaceRoot,
      updateSnapshots: this.updateSnapshots,
    });
  }

  async collectBboxes(actions: BrowserAction[]): Promise<Record<string, BBox>> {
    // Q-E inspector support. For every action that targets a selector
    // (click / type / dropFile / waitFor / assertVisible / assertText
    // / screenshot-with-ref), query the live agent-browser session
    // for that element's bounding rect. Non-spatial actions (goto,
    // eval, narrate, assertUrl, ...) get no entry — the caller treats
    // missing keys as null (page-level).
    //
    // Geometry is captured post-batch against the resting DOM. For the
    // dryrun (static fixture) this is exactly the bbox the viewer
    // needs. For animated content the bbox may drift mid-action; v1
    // accepts this — the resolver still routes the click to the right
    // action because the surrounding bbox is roughly right and the
    // resolver's tie-breakers handle overlaps.
    if (this.closed) return {};
    const out: Record<string, BBox> = {};
    const targets = actions
      .map((a, idx) => ({ idx, action: a, ref: refOf(a) }))
      .filter((t): t is { idx: number; action: BrowserAction; ref: string } => t.ref !== null);
    for (const t of targets) {
      const bbox = await this.queryBbox(t.ref);
      if (bbox) {
        out[String(t.idx)] = bbox;
      }
    }
    return out;
  }

  private async queryBbox(ref: string): Promise<BBox | null> {
    // agent-browser has a purpose-built `get box <sel>` command (Rust
    // CLI 0.27+) that emits a JSON bounding box. Use it directly
    // instead of the eval + JSON.stringify dance — the previous path
    // hit a double-stringification corner that returned null on every
    // selector-bearing action (see Session 5 HANDOFF gotcha #1).
    //
    // Refs that start with "@" are agent-browser a11y refs from a
    // prior `snapshot`. v1 doesn't snapshot during bbox collection, so
    // those skip cleanly (returning null routes the click through the
    // step-level fallback in the resolver).
    if (ref.startsWith("@")) return null;
    try {
      const stdoutText = await this.runBatch([["get", "box", ref]]);
      return parseBboxFromBatchOutput(stdoutText);
    } catch {
      return null;
    }
  }

  async recordHar(_path: string): Promise<void> {
    // D19 mocked-network — Session 7 wires HAR replay end-to-end.
  }

  async replayHar(_path: string): Promise<void> {
    // D19 mocked-network — Session 7.
  }

  async installDeterminismScaffold(_opts: DeterminismOpts): Promise<void> {
    // D19 / Spike 1c: agent-browser 0.27 drops AGENT_BROWSER_INIT_SCRIPTS
    // on record start. v0 ships without the scaffold; the dryrun smoke
    // exercises static-render segments where this isn't load-bearing
    // (architecture §9 invariant #2 softened). The honest v1 mitigation
    // (inline payload into served HTML) lands when we wire HAR in
    // Session 7.
  }

  private runBatch(cmds: string[][]): Promise<string> {
    return new Promise<string>((resolveP, rejectP) => {
      const child = spawn(
        this.binPath,
        ["--session-name", this.sessionName, "batch", "--json"],
        { stdio: ["pipe", "pipe", "pipe"] },
      );
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (d) => {
        stdout += d.toString();
      });
      child.stderr.on("data", (d) => {
        stderr += d.toString();
      });
      child.on("error", rejectP);
      child.on("close", (code) => {
        // `batch` returns non-zero only when --bail is set and a command
        // fails. We don't pass --bail (we want all results), so non-zero
        // here means the subprocess itself crashed.
        if (code !== 0 && stdout.length === 0) {
          rejectP(
            new Error(
              `agent-browser batch exited ${code}\nstderr:\n${stderr}\nstdout:\n${stdout}`,
            ),
          );
          return;
        }
        resolveP(stdout);
      });
      child.stdin.write(JSON.stringify(cmds));
      child.stdin.end();
    });
  }
}

// --- Bounding-box parse (extracted so it's covered by smoke tests) ----

// agent-browser batch returns a JSON array of entries; each entry has
// `output` (or `stdout`) carrying the per-command result string. For
// `get box <sel>` the result is either an object `{x, y, width, height}`
// or `null` (when the element isn't there). We've also seen it come
// back JSON-encoded inside the string field (quoted twice); the loop
// below unwraps up to 4 layers, which matches every shape encountered
// in the wild. Returns null on any failure path — the resolver's
// step-level fallback covers null geometry without breaking the loop.
export function parseBboxFromBatchOutput(stdoutText: string): BBox | null {
  let parsed: { output?: string; stdout?: string; result?: unknown }[] = [];
  try {
    parsed = JSON.parse(stdoutText);
  } catch {
    parsed = [];
    for (const window of iterBalancedArrays(stdoutText)) {
      try {
        const candidate = JSON.parse(window);
        if (Array.isArray(candidate) && candidate.length > 0 && typeof candidate[0] === "object") {
          parsed = candidate;
          break;
        }
      } catch {
        // try next candidate
      }
    }
  }
  if (!Array.isArray(parsed) || parsed.length === 0) return null;
  const entry = parsed[0] ?? {};
  let candidate: unknown = entry.result ?? entry.output ?? entry.stdout ?? "";
  if (typeof candidate === "string") {
    const trimmed = candidate.trim();
    if (!trimmed || trimmed === "null") return null;
    candidate = trimmed;
    for (let i = 0; i < 4; i++) {
      if (typeof candidate !== "string") break;
      try {
        candidate = JSON.parse(candidate);
      } catch {
        break;
      }
    }
  }
  if (
    Array.isArray(candidate) &&
    candidate.length === 4 &&
    candidate.every((n) => typeof n === "number")
  ) {
    return [
      Math.round(candidate[0] as number),
      Math.round(candidate[1] as number),
      Math.round(candidate[2] as number),
      Math.round(candidate[3] as number),
    ];
  }
  if (candidate && typeof candidate === "object") {
    const o = candidate as Record<string, unknown>;
    const x = num(o.x);
    const y = num(o.y);
    const w = num(o.width) ?? num(o.w);
    const h = num(o.height) ?? num(o.h);
    if (x !== null && y !== null && w !== null && h !== null) {
      return [Math.round(x), Math.round(y), Math.round(w), Math.round(h)];
    }
  }
  return null;
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

// Yield each balanced `[...]` window in `s`. Honors strings (so [ or ]
// inside a quoted string don't perturb depth). Callers try each window
// in turn — agent-browser may print stray log lines around the JSON
// batch result that happen to contain bracket characters.
function* iterBalancedArrays(s: string): Generator<string> {
  for (let i = 0; i < s.length; i++) {
    if (s[i] !== "[") continue;
    let depth = 0;
    let inString = false;
    let closed = false;
    for (let j = i; j < s.length; j++) {
      const c = s[j];
      if (inString) {
        if (c === "\\") {
          j++;
          continue;
        }
        if (c === '"') inString = false;
        continue;
      }
      if (c === '"') {
        inString = true;
        continue;
      }
      if (c === "[") depth++;
      else if (c === "]") {
        depth--;
        if (depth === 0) {
          yield s.slice(i, j + 1);
          closed = true;
          break;
        }
      }
    }
    void closed;
  }
}

// --- ref extraction (for inspector bbox query) ------------------------

function refOf(a: BrowserAction): string | null {
  switch (a.kind) {
    case "browser.click":
    case "browser.type":
    case "browser.dropFile":
    case "browser.waitFor":
    case "browser.assertVisible":
    case "browser.assertText":
      return a.ref;
    case "browser.screenshot":
      return a.ref ?? null;
    case "browser.goto":
    case "browser.eval":
    case "browser.assertUrl":
    case "browser.assertA11yTreeMatches":
      return null;
  }
}

// --- Batch result parsing ---------------------------------------------

export function parseBatchResult(
  stdout: string,
  actions: BrowserAction[],
  ctx: { workspaceRoot?: string; updateSnapshots?: boolean } = {},
): ActionBatchResult {
  let parsed: BatchEntry[] = [];
  if (stdout.trim().length > 0) {
    try {
      parsed = JSON.parse(stdout) as BatchEntry[];
    } catch {
      // agent-browser sometimes prints status lines around the JSON
      // array; try to recover the first '[' to last ']' window.
      const start = stdout.indexOf("[");
      const end = stdout.lastIndexOf("]");
      if (start >= 0 && end > start) {
        try {
          parsed = JSON.parse(stdout.slice(start, end + 1)) as BatchEntry[];
        } catch {
          parsed = [];
        }
      }
    }
  }

  // Map each ORIGINAL action to one or more raw entries. We rely on
  // ordering — actionToArgv emits 1+ argv per action; results come back
  // in the same order. Aggregate them.
  let cursor = 0;
  const results: ActionResult[] = [];
  const assertions: AssertionResult[] = [];

  for (const a of actions) {
    const argvCount = actionToArgv(a).length;
    const slice = parsed.slice(cursor, cursor + argvCount);
    cursor += argvCount;
    const allOk = slice.every((r) => r.ok !== false && (r.exitCode === undefined || r.exitCode === 0));
    const errMsg = slice
      .map((r) => r.error || r.stderr || "")
      .filter((s) => s.length > 0)
      .join("; ");
    const outputs = slice
      .map((r) => r.output || r.stdout || "")
      .filter((s) => s.length > 0)
      .join("\n");
    results.push({
      ok: allOk,
      ...(outputs ? { output: outputs } : {}),
      ...(errMsg ? { error: errMsg } : {}),
    });

    if (a.kind.startsWith("browser.assert")) {
      // D12: real comparison against the action's expected value.
      // evaluateAssertion handles the four assert kinds + a11y golden
      // file resolution.
      const evaluated = evaluateAssertion(a, slice, {
        workspaceRoot: ctx.workspaceRoot,
        ...(ctx.updateSnapshots ? { updateSnapshots: true } : {}),
      });
      assertions.push(evaluated);
    }
  }

  return { results, assertions };
}

// --- Smoke helper: probe whether agent-browser is installed -----------

export function probeAgentBrowser(binPath = resolveBin()): { installed: boolean; version?: string; error?: string } {
  try {
    if (binPath.startsWith("/") && !existsSync(binPath)) {
      return { installed: false, error: `binary not found at ${binPath}` };
    }
    const r = spawnSync(binPath, ["--version"], { encoding: "utf8" });
    if (r.status !== 0) {
      return { installed: false, error: r.stderr || `exit ${r.status}` };
    }
    return { installed: true, version: r.stdout.trim() };
  } catch (e) {
    return { installed: false, error: String(e) };
  }
}

// Touch unused-import for type-only safety: ensures the statSync import
// isn't tree-shaken when bundler heuristics drift.
void statSync;
