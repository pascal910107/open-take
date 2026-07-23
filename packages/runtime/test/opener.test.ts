import assert from "node:assert/strict";
import { test } from "node:test";
import { getOpenCommand, getRevealCommand } from "../src/review.js";

test("Windows open reserves start's empty title and quotes the target verbatim", () => {
  const target = String.raw`C:\Demo & Clips\take.mp4`;
  assert.deepEqual(getOpenCommand(target, "win32"), {
    command: "cmd",
    args: ["/c", "start", '""', `"${target}"`],
    windowsVerbatimArguments: true,
  });
});

test("Windows reveal keeps /select and the quoted path in one Explorer argument", () => {
  const target = String.raw`C:\Demo & Clips\take.mp4`;
  assert.deepEqual(getRevealCommand(target, "win32"), {
    command: "explorer",
    args: [`/select,"${target}"`],
    windowsVerbatimArguments: true,
  });
});

test("macOS and Linux use native openers without Windows verbatim quoting", () => {
  assert.deepEqual(getOpenCommand("https://127.0.0.1:4178/", "darwin"), {
    command: "open",
    args: ["https://127.0.0.1:4178/"],
    windowsVerbatimArguments: false,
  });
  assert.deepEqual(getRevealCommand("/tmp/takes/demo.mp4", "linux"), {
    command: "xdg-open",
    args: ["/tmp/takes"],
    windowsVerbatimArguments: false,
  });
});
