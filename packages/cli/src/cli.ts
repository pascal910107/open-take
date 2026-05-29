#!/usr/bin/env node
// open-take — thin CLI over the runtime/compositor.
//
//   open-take inspect <url> [--viewport 1920x1080]
//       -> JSON of interactive elements (accessible name + bbox) for planning
//   open-take make --plan <plan.json> --out <out.mp4>
//       -> plan -> capture -> polished mp4 + editable composition
import { readFile } from "node:fs/promises";
import { inspectPage, makeTake, type TakePlan } from "@open-take/runtime";

const argv = process.argv.slice(2);
const cmd = argv[0];
const positional: string[] = [];
const flags: Record<string, string> = {};
for (let i = 1; i < argv.length; i++) {
  const a = argv[i]!;
  if (a.startsWith("--")) {
    flags[a] = argv[i + 1] ?? "";
    i++;
  } else {
    positional.push(a);
  }
}
const flag = (name: string): string | undefined => flags[name];

function parseViewport(s?: string): { width: number; height: number } | undefined {
  if (!s) return undefined;
  const [w, h] = s.toLowerCase().split("x").map(Number);
  return w && h ? { width: w, height: h } : undefined;
}

const USAGE = `open-take — agent-native demo recorder

Usage:
  open-take inspect <url> [--viewport 1920x1080]
  open-take make --plan <plan.json> --out <out.mp4> [--fps 60]

  --fps <n>   capture AND render fps (default 30). 60 = smooth continuous
              motion (drags/scroll/cursor), ~2× render cost. Capture is always
              a pure-CDP screencast; this sets the encode + render grid.
`;

async function main() {
  if (cmd === "inspect") {
    const url = positional[0];
    if (!url) throw new Error("inspect: missing <url>");
    const res = await inspectPage(url, { viewport: parseViewport(flag("--viewport")) });
    process.stdout.write(`${JSON.stringify(res, null, 2)}\n`);
    return;
  }
  if (cmd === "make") {
    const planPath = flag("--plan");
    const out = flag("--out") ?? "take.mp4";
    if (!planPath) throw new Error("make: missing --plan <plan.json>");
    const plan = JSON.parse(await readFile(planPath, "utf8")) as TakePlan;
    const fpsFlag = flag("--fps");
    const fps = fpsFlag ? Number(fpsFlag) : undefined;
    const { mp4Path, compositionPath } = await makeTake(plan, {
      outPath: out,
      logProgress: true,
      ...(fps ? { capture: { fps } } : {}),
    });
    process.stdout.write(`\nmp4: ${mp4Path}\ncomposition: ${compositionPath}\n`);
    return;
  }
  process.stderr.write(USAGE);
  process.exit(cmd ? 1 : 0);
}

main().catch((e) => {
  process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});
