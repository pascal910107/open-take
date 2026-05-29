// Each BrowserAction → one or more agent-browser argv arrays. Used by
// AgentBrowserDriver.runActionBatch to build the JSON stdin payload
// for `agent-browser batch`.

import type { BrowserAction } from "@open-take/core";

export function actionToArgv(a: BrowserAction): string[][] {
  switch (a.kind) {
    case "browser.goto":
      return [["open", a.url]];
    case "browser.eval":
      return [["eval", a.expr]];
    case "browser.click":
      // CSS-selector resolution; modifiers v0 ignored (Session 9 will
      // route through `find` for richer locators).
      return [["click", a.ref]];
    case "browser.type": {
      // Focus the selector, then dispatch real keystrokes. delayPerChar
      // is a Playwright-flavored knob; agent-browser doesn't expose it
      // at the CLI today, so v0 ignores it (Q-C tracks).
      return [
        ["focus", a.ref],
        ["keyboard", "type", a.text],
      ];
    }
    case "browser.dropFile":
      return [["upload", a.ref, a.path]];
    case "browser.waitFor":
      return [["wait", a.ref]];
    case "browser.screenshot":
      return [a.ref ? ["screenshot", "--selector", a.ref] : ["screenshot"]];
    case "browser.assertVisible":
      return [["is", "visible", a.ref]];
    case "browser.assertText":
      return [["get", "text", a.ref]];
    case "browser.assertUrl":
      return [["get", "url"]];
    case "browser.assertA11yTreeMatches":
      return [["snapshot"]];
  }
}
