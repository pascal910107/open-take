// TS DSL — constructors that return typed Action / Step / Demo objects.
// The returned object IS the IR; no walker, no JSX.
//
// See spike-1b/dsl.ts for the validated shape and docs/architecture.md
// §1.1 / §1.2 for the typed surface.

import type {
  Action,
  BrowserAction,
  ComposeAction,
  Demo,
  ElementRef,
  NarrateAction,
  PauseAction,
  Step,
  TerminalAction,
} from "../ir/index.js";

export function defineDemo(d: Demo): Demo {
  return d;
}

export function step(s: Step): Step {
  return s;
}

export const Browser = {
  goto: (url: string): BrowserAction => ({ kind: "browser.goto", url }),
  eval: (expr: string): BrowserAction => ({ kind: "browser.eval", expr }),
  click: (ref: ElementRef, modifiers?: string[]): BrowserAction => ({
    kind: "browser.click",
    ref,
    ...(modifiers ? { modifiers } : {}),
  }),
  type: (ref: ElementRef, text: string, delayPerChar?: number): BrowserAction => ({
    kind: "browser.type",
    ref,
    text,
    ...(delayPerChar !== undefined ? { delayPerChar } : {}),
  }),
  dropFile: (ref: ElementRef, path: string): BrowserAction => ({
    kind: "browser.dropFile",
    ref,
    path,
  }),
  waitFor: (ref: ElementRef, timeoutMs?: number): BrowserAction => ({
    kind: "browser.waitFor",
    ref,
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
  }),
  screenshot: (ref?: ElementRef): BrowserAction => ({
    kind: "browser.screenshot",
    ...(ref !== undefined ? { ref } : {}),
  }),
  assertVisible: (ref: ElementRef): BrowserAction => ({
    kind: "browser.assertVisible",
    ref,
  }),
  assertText: (ref: ElementRef, text: string): BrowserAction => ({
    kind: "browser.assertText",
    ref,
    text,
  }),
  assertUrl: (pattern: string): BrowserAction => ({
    kind: "browser.assertUrl",
    pattern,
  }),
  assertA11yTreeMatches: (snapshotPath: string): BrowserAction => ({
    kind: "browser.assertA11yTreeMatches",
    snapshotPath,
  }),
};

export const Terminal = {
  run: (
    cmd: string,
    opts?: { waitFor?: string; waitForExit?: boolean },
  ): TerminalAction => ({
    kind: "terminal.run",
    cmd,
    ...(opts?.waitFor !== undefined ? { waitFor: opts.waitFor } : {}),
    ...(opts?.waitForExit !== undefined ? { waitForExit: opts.waitForExit } : {}),
  }),
  sendKeys: (keys: string): TerminalAction => ({ kind: "terminal.sendKeys", keys }),
  assertContains: (text: string): TerminalAction => ({
    kind: "terminal.assertContains",
    text,
  }),
  assertExit: (code: number): TerminalAction => ({ kind: "terminal.assertExit", code }),
};

export const Narrate = {
  say: (text: string, voice?: string): NarrateAction => ({
    kind: "narrate.say",
    text,
    ...(voice !== undefined ? { voice } : {}),
  }),
};

export const Compose = {
  focus: (pane: "browser" | "terminal" | "split"): ComposeAction => ({
    kind: "compose.focus",
    pane,
  }),
  zoom: (ref: ElementRef, scale: number, durationMs: number): ComposeAction => ({
    kind: "compose.zoom",
    ref,
    scale,
    durationMs,
  }),
  highlight: (ref: ElementRef, durationMs: number): ComposeAction => ({
    kind: "compose.highlight",
    ref,
    durationMs,
  }),
};

export const Assert = {
  // Mirrors Browser.assert* / Terminal.assert* so author code reads
  // ergonomically: Assert.visible(...) instead of Browser.assertVisible(...).
  visible: (ref: ElementRef): BrowserAction => Browser.assertVisible(ref),
  text: (ref: ElementRef, text: string): BrowserAction => Browser.assertText(ref, text),
  url: (pattern: string): BrowserAction => Browser.assertUrl(pattern),
  terminalContains: (text: string): TerminalAction => Terminal.assertContains(text),
  terminalExit: (code: number): TerminalAction => Terminal.assertExit(code),
};

export const Pause = {
  for: (ms: number): PauseAction => ({ kind: "pause.for", ms }),
  until: (predicate: string): PauseAction => ({ kind: "pause.until", predicate }),
};

// Helper for downstream code that needs to discriminate actions by
// surface (browser vs terminal vs ...). Faster than a switch over
// every kind tag.
export function actionSurface(
  a: Action,
): "browser" | "terminal" | "narrate" | "compose" | "pause" {
  const k = a.kind;
  if (k.startsWith("browser.")) return "browser";
  if (k.startsWith("terminal.")) return "terminal";
  if (k.startsWith("narrate.")) return "narrate";
  if (k.startsWith("compose.")) return "compose";
  return "pause";
}
