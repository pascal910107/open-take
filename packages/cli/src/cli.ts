#!/usr/bin/env node
// open-take — thin CLI over the runtime/compositor.
//
//   open-take inspect <url> [--viewport 1920x1080]
//       -> JSON of interactive elements (accessible name + bbox) for planning
//   open-take make --plan <plan.json> --out <out.mp4>
//       -> plan -> capture -> polished mp4 + editable composition + kept capture
//   open-take render --composition <c.json> --video <capture.mp4> --out <mp4>
//       -> re-render an EDITED composition over a kept capture (no app drive)
import { readFile } from "node:fs/promises";
import {
  type TakePlan,
  inspectPage,
  makeTake,
  renderCompositionFile,
  startEditServer,
} from "@open-take/runtime";

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
  open-take make   --plan <plan.json> --out <out.mp4> [--fps 60]
  open-take render --composition <c.json> --video <capture.mp4> --out <mp4>
  open-take edit   <take.mp4 | take dir> [--port 4178] [--no-open]

  make    drive the app (real-time) → polished mp4 + editable
          <out>.composition.json + KEPT <out>.capture.mp4 + <out>.capture.json
          (the ground-truth log; render auto-loads it for the capture-lock check).
  render  re-render an EDITED composition over a kept capture — NO app drive.
          The refine loop: tweak the composition.json (zoom / pacing / framing),
          re-render deterministically. Only the cinematic layer is editable this
          way; changing what's clicked/typed or the beat order needs a fresh make.
          Auto-loads <video>.json as the capture log (the capture-lock source);
          --capture-log <path> overrides it.
  edit    open the web editor on a take: a live, scrubbable WYSIWYG preview +
          property panel over the cinematic layer (zoom / cursor / framing /
          pacing). Edits validate on save; Export re-renders over the kept
          capture with live progress — all on 127.0.0.1, nothing uploaded.
          Needs the editor build (pnpm --filter @open-take/editor build).

  --fps <n>   (make only) capture AND render fps (default 60 — the premium feel).
              Drop to 30 for fast-draft renders (~½ the time + file size) while
              iterating. Capture is always a pure-CDP screencast; this sets the
              encode + render grid.
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
    const { mp4Path, compositionPath, capturePath, captureLogPath } = await makeTake(plan, {
      outPath: out,
      logProgress: true,
      ...(fps ? { capture: { fps } } : {}),
    });
    process.stdout.write(
      `\nmp4:         ${mp4Path}\ncomposition: ${compositionPath}\n` +
        `capture:     ${capturePath}\ncapture log: ${captureLogPath}\n` +
        `\nrefine: edit the composition.json, then\n` +
        `  open-take render --composition ${compositionPath} --video ${capturePath} --out ${mp4Path}\n`,
    );
    return;
  }
  if (cmd === "render") {
    const compositionPath = flag("--composition");
    const video = flag("--video");
    const out = flag("--out") ?? "take.mp4";
    if (!compositionPath) throw new Error("render: missing --composition <c.json>");
    if (!video) throw new Error("render: missing --video <capture.mp4>");
    const { mp4Path } = await renderCompositionFile({
      compositionPath,
      capturePath: video,
      outPath: out,
      // override the auto-loaded sibling capture log (the capture-lock source)
      ...(flag("--capture-log") ? { captureLogPath: flag("--capture-log") } : {}),
      logProgress: true,
    });
    process.stdout.write(`\nmp4: ${mp4Path}\n`);
    return;
  }
  if (cmd === "edit") {
    const takePath = positional[0];
    if (!takePath) throw new Error("edit: missing <take.mp4 | take dir>");
    const portFlag = flag("--port");
    await startEditServer({
      takePath,
      ...(portFlag ? { port: Number(portFlag) } : {}),
      open: !("--no-open" in flags),
    });
    await new Promise(() => {}); // keep alive until Ctrl-C
    return;
  }
  process.stderr.write(USAGE);
  process.exit(cmd ? 1 : 0);
}

main().catch((e) => {
  process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});
