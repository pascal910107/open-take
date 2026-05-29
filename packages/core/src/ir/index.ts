// Demo IR. The exported Demo object IS the IR — no lowering.
// See docs/architecture.md §1.2.

export type DemoId = string;
export type StepId = string;
export type StateClaim = string;
export type ElementRef = string;

export type SrcLoc = { file: string; line: number; col: number };

export type BrowserAction =
  | { kind: "browser.goto"; url: string; __loc?: SrcLoc }
  | { kind: "browser.eval"; expr: string; __loc?: SrcLoc }
  | { kind: "browser.click"; ref: ElementRef; modifiers?: string[]; __loc?: SrcLoc }
  | {
      kind: "browser.type";
      ref: ElementRef;
      text: string;
      delayPerChar?: number;
      __loc?: SrcLoc;
    }
  | { kind: "browser.dropFile"; ref: ElementRef; path: string; __loc?: SrcLoc }
  | { kind: "browser.waitFor"; ref: ElementRef; timeoutMs?: number; __loc?: SrcLoc }
  | { kind: "browser.screenshot"; ref?: ElementRef; __loc?: SrcLoc }
  | { kind: "browser.assertVisible"; ref: ElementRef; __loc?: SrcLoc }
  | { kind: "browser.assertText"; ref: ElementRef; text: string; __loc?: SrcLoc }
  | { kind: "browser.assertUrl"; pattern: string; __loc?: SrcLoc }
  | { kind: "browser.assertA11yTreeMatches"; snapshotPath: string; __loc?: SrcLoc };

export type TerminalAction =
  | {
      kind: "terminal.run";
      cmd: string;
      waitFor?: string;
      waitForExit?: boolean;
      __loc?: SrcLoc;
    }
  | { kind: "terminal.sendKeys"; keys: string; __loc?: SrcLoc }
  | { kind: "terminal.assertContains"; text: string; __loc?: SrcLoc }
  | { kind: "terminal.assertExit"; code: number; __loc?: SrcLoc };

export type NarrateAction = { kind: "narrate.say"; text: string; voice?: string; __loc?: SrcLoc };

export type ComposeAction =
  | { kind: "compose.focus"; pane: "browser" | "terminal" | "split"; __loc?: SrcLoc }
  | {
      kind: "compose.zoom";
      ref: ElementRef;
      scale: number;
      durationMs: number;
      __loc?: SrcLoc;
    }
  | { kind: "compose.highlight"; ref: ElementRef; durationMs: number; __loc?: SrcLoc };

export type PauseAction =
  | { kind: "pause.for"; ms: number; __loc?: SrcLoc }
  | { kind: "pause.until"; predicate: string; __loc?: SrcLoc };

export type Action = BrowserAction | TerminalAction | NarrateAction | ComposeAction | PauseAction;

export type Step = {
  id: StepId;
  requires?: StateClaim[];
  produces?: StateClaim[];
  seed?: number;
  network?: "live" | "mocked";
  deterministic?: boolean;
  actions: Action[];
};

export type StructuralFp = {
  agentBrowser: string;
  chrome: string;
  ffmpeg: string;
  ttsModel: string;
  node: string;
  renderProfile: string;
};

export type EnvironmentFp = {
  arch: string;
  os: string;
  fontsPresent: string[];
  devicePixelRatio: number;
};

export type ToolFingerprint = {
  structural: StructuralFp;
  environment: EnvironmentFp;
};

export type DemoMeta = {
  id: DemoId;
  sourcePath: string;
  authoredAt: string;
  runtimeVersion: string;
  toolFingerprint: ToolFingerprint;
};

export type Demo = {
  name: string;
  canvas?: { width: number; height: number };
  voice?: string;
  driver?: "cdp" | "agent-browser" | "playwright" | "computer-use";
  mode?: "strict";
  steps: Step[];
  meta?: DemoMeta;
};

export type Comment = {
  id: string;
  ts: string;
  note: string;
  hint?: string;
};

// Canonical-JSON serialization. Sorts object keys recursively so the
// hash is stable across V8 / engine iteration-order differences.
export function canonical(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return "[" + v.map(canonical).join(",") + "]";
  const keys = Object.keys(v as object).sort();
  return (
    "{" +
    keys
      .map(
        (k) =>
          JSON.stringify(k) + ":" + canonical((v as Record<string, unknown>)[k]),
      )
      .join(",") +
    "}"
  );
}

// Drop ts-morph __loc tags so source-position moves don't bust caches.
export function stripLoc<T>(node: T): T {
  if (node === null || typeof node !== "object") return node;
  if (Array.isArray(node)) return node.map(stripLoc) as unknown as T;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(node as object)) {
    if (k === "__loc") continue;
    out[k] = stripLoc(v);
  }
  return out as T;
}

// Drop Narrate.say.text so re-narration doesn't bust the video cache.
// The narration text is captured in narrationHash separately. Voice
// stays — voice id contributes to TTS output and is part of state.
export function stripNarrationText<T>(node: T): T {
  if (node === null || typeof node !== "object") return node;
  if (Array.isArray(node)) return node.map(stripNarrationText) as unknown as T;
  const isNarrateSay = (node as { kind?: string }).kind === "narrate.say";
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(node as object)) {
    if (isNarrateSay && k === "text") continue;
    out[k] = stripNarrationText(v);
  }
  return out as T;
}
