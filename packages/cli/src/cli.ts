#!/usr/bin/env node
// open-take — thin CLI over the runtime/compositor.
//
//   open-take inspect <url>          -> elements JSON for planning
//   open-take make --plan p --out o  -> capture + polished mp4 + artifacts
//   open-take render <take>          -> re-render the edited composition
//   open-take beats <take>           -> the numbered beat sheet (stdout)
//   open-take ab <take> --set …      -> A/B variant reel for a taste question
//
// The refine loop is conversational: the user talks, the agent edits
// composition.json and drives these verbs. See skills/open-take/SKILL.md.
import { stat as fsStat, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  SAY_IT_CARD,
  type TakePlan,
  buildBeatSheet,
  inspectPage,
  makeTake,
  openPath,
  renderAbReel,
  renderBeforeAfter,
  renderCompositionFile,
  renderReview,
  requireTakeFiles,
  resolveTakePaths,
  revealPath,
  stagePrev,
} from "@open-take/runtime";
import { installAgentSkill } from "./init";

// how to invoke this CLI, for printed follow-up commands: the bin name when
// installed, else the literal node path the user just ran (copy-pasteable).
const INVOKE = process.argv[1]?.endsWith("cli.js")
  ? `node ${process.argv[1]!.replace(`${process.cwd()}/`, "")}`
  : "open-take";

const BOOL_FLAGS = new Set([
  "--review",
  "--open",
  "--reveal",
  "--card",
  "--full",
  "--draft",
  "--no-open",
  "--before-after",
]);

const argv = process.argv.slice(2);
const cmd = argv[0];
const positional: string[] = [];
const flags: Record<string, string> = {};
for (let i = 1; i < argv.length; i++) {
  const a = argv[i]!;
  if (a.startsWith("--")) {
    if (BOOL_FLAGS.has(a)) {
      flags[a] = "true";
    } else {
      flags[a] = argv[i + 1] ?? "";
      i++;
    }
  } else {
    positional.push(a);
  }
}
const flag = (name: string): string | undefined => flags[name];
const has = (name: string): boolean => name in flags;

function parseViewport(s?: string): { width: number; height: number } | undefined {
  if (!s) return undefined;
  const [w, h] = s.toLowerCase().split("x").map(Number);
  return w && h ? { width: w, height: h } : undefined;
}

const USAGE = `open-take — agent-native demo recorder

Usage:
  open-take inspect <url> [--viewport 1920x1080]
  open-take make   --plan <plan.json> --out <out.mp4> [--fps 60]
  open-take render <take> [--review] [--open] [--reveal] [--no-open]
  open-take beats  <take> [--card]
  open-take ab     <take> --set <knob>=<v1>,<v2>[,<v3>] [--beat N] [--full] [--draft] [--no-open]
  open-take ab     <take> --before-after [--beat N] [--full] [--no-open]
  open-take edit   <take> [--port 4178] [--no-open]
  open-take init
  open-take skill  [install]

  <take> is any member of a take's artifact family (its .mp4, .composition.json,
  .capture.mp4, or the directory holding them) — siblings resolve by convention.

  make    drive the app (real-time) → polished <out>.mp4 + editable
          <out>.composition.json + KEPT <out>.capture.mp4 + <out>.capture.json.
  render  re-render the (edited) composition over the kept capture — NO app
          drive, deterministic. The previous master is kept as <base>.prev.mp4
          so "keep the old one" is a mechanical revert.
          --review renders a fast DRAFT copy to <base>.review.mp4 instead, with
          beat badges burned in (the video teaches "beat 3" refers) + a REVIEW
          watermark — never overwrites the postable master. Review copies
          auto-open in the player (--no-open to skip; --reveal to reveal
          instead).
          (legacy flags --composition/--video/--out/--capture-log still work)
  beats   print the numbered beat sheet — the shared map for notes like
          "beat 3: no zoom". --card appends the say-it cheat card.
  ab      answer a taste question by eye: ONE knob, up to 3 candidate values
          (the current state is always variant A), rendered as a labeled reel —
          each variant plays twice. Auto-opens (--no-open to skip).
          knobs: zoom (with --beat N; values off/light/medium/tight/close or a
          number) · look (midnight/ink/slate/ocean/plum/ember/paper/plain) ·
          pace (calm/natural/brisk) · finish (smooth/crisp/heavy) · or a raw
          dot-path like cursor.holdMs=900,1300.
          Windowed to the beat's zoom arc by default (--full for the whole
          take); FEEL knobs render at full quality — judge motion by eye.
          --before-after replays <base>.prev.mp4 vs the current master instead
          (no render; BEFORE then AFTER, twice).

  edit    open the visual editor on a take: preview + icon-rail settings +
          timeline with zoom blocks; every change previews live, Export renders
          the real mp4 — all on 127.0.0.1, nothing uploaded. Hands off anything
          it can't do (reorder, re-record) to your agent via the Agent panel
          (notes land in <base>.notes.md + this terminal).

  init    install the Open Take skill into this project for coding agents.

  skill   print the full agent guide (SKILL.md). \`skill install\` remains as a
          backwards-compatible alias for \`init\`.

  --fps <n>   (make only) capture AND render fps (default 60). Drop to 30 for
              fast drafts while iterating.
`;

const fmtBytes = (n: number): string =>
  n > 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.round(n / 1024)} KB`;

async function readyLine(mp4Path: string): Promise<string> {
  const take = await resolveTakePaths(mp4Path);
  const comp = JSON.parse(await readFile(take.compositionPath, "utf8")) as {
    durationMs: number;
    output: { width: number; height: number; fps: number };
  };
  const size = (await fsStat(mp4Path)).size;
  return `${mp4Path} · ${(comp.durationMs / 1000).toFixed(1)}s · ${comp.output.width}×${comp.output.height}@${comp.output.fps} · ${fmtBytes(size)}`;
}

async function main() {
  const bundledSkill = async (): Promise<string> => {
    // packaged copy (skill/SKILL.md beside dist/) first, monorepo source second
    const here = dirname(fileURLToPath(import.meta.url)); // dist/ or src/
    const candidates = [
      resolve(here, "..", "skill", "SKILL.md"),
      resolve(here, "..", "..", "..", "skills", "open-take", "SKILL.md"),
    ];
    for (const candidate of candidates) {
      const text = await readFile(candidate, "utf8").catch(() => null);
      if (text) return text;
    }
    throw new Error("SKILL.md not found (re-run the package build)");
  };

  if (cmd === "init") {
    const installed = await installAgentSkill({
      root: process.cwd(),
      skillText: await bundledSkill(),
    });
    process.stdout.write(
      `initialized: ${installed.canonicalPath}\n` +
        `Ask your agent to "make a demo of <your app>".\n`,
    );
    return;
  }

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
    if (/\.(review|ab|prev|capture)\.mp4$/i.test(out))
      throw new Error(
        `make: ".review/.ab/.prev/.capture" are reserved take suffixes — pick another --out name`,
      );
    const plan = JSON.parse(await readFile(planPath, "utf8")) as TakePlan;
    const fpsFlag = flag("--fps");
    const fps = fpsFlag ? Number(fpsFlag) : undefined;
    // a re-make (re-shoot) is a new generation: keep the old master as prev so
    // --before-after compares against the take the user just reacted to.
    const takePre = await resolveTakePaths(out).catch(() => null);
    const staged = takePre
      ? await stagePrev(takePre.mp4Path, takePre.prevPath)
      : { commit: async () => {}, abort: async () => {} };
    let made: Awaited<ReturnType<typeof makeTake>>;
    try {
      made = await makeTake(plan, {
        outPath: out,
        logProgress: true,
        ...(fps ? { capture: { fps } } : {}),
      });
      await staged.commit();
    } catch (e) {
      await staged.abort();
      throw e;
    }
    const { mp4Path, compositionPath, capturePath, captureLogPath } = made;
    process.stdout.write(
      `\nmp4:         ${mp4Path}\ncomposition: ${compositionPath}\n` +
        `capture:     ${capturePath}\ncapture log: ${captureLogPath}\n` +
        `\nrefine by asking your agent for changes — or directly:\n` +
        `  ${INVOKE} render ${mp4Path} --review   (draft copy with beat badges, auto-opens)\n` +
        `  ${INVOKE} beats  ${mp4Path}            (the numbered beat sheet)\n` +
        `  ${INVOKE} ab     ${mp4Path} --set zoom=light,tight --beat 2   (taste A/B)\n`,
    );
    return;
  }

  if (cmd === "render") {
    // legacy explicit-flags form (kept for compatibility with existing agents)
    if (flag("--composition") || flag("--video")) {
      const compositionPath = flag("--composition");
      const video = flag("--video");
      const out = flag("--out") ?? "take.mp4";
      if (!compositionPath) throw new Error("render: missing --composition <c.json>");
      if (!video) throw new Error("render: missing --video <capture.mp4>");
      const take = await resolveTakePaths(out).catch(() => null);
      const staged = take
        ? await stagePrev(take.mp4Path, take.prevPath)
        : { commit: async () => {}, abort: async () => {} };
      try {
        const { mp4Path } = await renderCompositionFile({
          compositionPath,
          capturePath: video,
          outPath: out,
          ...(flag("--capture-log") ? { captureLogPath: flag("--capture-log") } : {}),
          logProgress: true,
        });
        await staged.commit();
        process.stdout.write(`\nmp4: ${mp4Path}\n`);
        if (has("--open")) openPath(mp4Path);
        if (has("--reveal")) revealPath(mp4Path);
      } catch (e) {
        await staged.abort();
        throw e;
      }
      return;
    }

    const takeArg = positional[0];
    if (!takeArg) throw new Error("render: missing <take> (its .mp4 / .composition.json / dir)");
    const take = await resolveTakePaths(takeArg);

    if (has("--review")) {
      const { reviewPath, sheet } = await renderReview(take, { logProgress: true });
      process.stdout.write(`\n${sheet}\n\nreview copy: ${reviewPath}\n`);
      if (has("--reveal")) revealPath(reviewPath);
      else if (!has("--no-open")) openPath(reviewPath);
      return;
    }

    await requireTakeFiles(take, { capture: true });
    const staged = await stagePrev(take.mp4Path, take.prevPath);
    try {
      const { mp4Path } = await renderCompositionFile({
        compositionPath: take.compositionPath,
        capturePath: take.capturePath,
        outPath: take.mp4Path,
        logProgress: true,
      });
      await staged.commit();
      process.stdout.write(`\nready: ${await readyLine(mp4Path)}\n`);
      if (has("--open")) openPath(mp4Path);
      if (has("--reveal")) revealPath(mp4Path);
    } catch (e) {
      await staged.abort();
      throw e;
    }
    return;
  }

  if (cmd === "beats") {
    const takeArg = positional[0];
    if (!takeArg) throw new Error("beats: missing <take>");
    const take = await resolveTakePaths(takeArg);
    await requireTakeFiles(take);
    const comp = JSON.parse(await readFile(take.compositionPath, "utf8"));
    process.stdout.write(`${buildBeatSheet(comp, take.name)}\n`);
    if (has("--card")) process.stdout.write(`\n${SAY_IT_CARD}\n`);
    return;
  }

  if (cmd === "ab") {
    const takeArg = positional[0];
    if (!takeArg) throw new Error("ab: missing <take>");
    const take = await resolveTakePaths(takeArg);
    const beatFlag = flag("--beat");
    const beat = beatFlag ? Number(beatFlag) : undefined;
    if (beatFlag && (!Number.isInteger(beat) || beat! < 1))
      throw new Error(`ab: --beat expects a 1-based beat number (got "${beatFlag}")`);

    if (has("--before-after")) {
      const { abPath, legend } = await renderBeforeAfter(take, {
        beat,
        full: has("--full"),
      });
      process.stdout.write(`\n${legend}\n`);
      if (!has("--no-open")) openPath(abPath);
      return;
    }

    const setFlags = argv.filter((a) => a === "--set").length;
    if (setFlags > 1)
      throw new Error("ab: ONE knob at a time — a reel answers one taste question by eye");
    const set = flag("--set");
    if (!set) throw new Error("ab: missing --set <knob>=<v1>,<v2>[,<v3>] (or --before-after)");
    const { abPath, legend } = await renderAbReel(take, {
      set,
      beat,
      full: has("--full"),
      draft: has("--draft"),
      logProgress: true,
    });
    process.stdout.write(`\n${legend}\n`);
    if (!has("--no-open")) openPath(abPath);
    return;
  }

  if (cmd === "skill") {
    const text = await bundledSkill();
    if (positional[0] === "install") {
      const installed = await installAgentSkill({ root: process.cwd(), skillText: text });
      process.stdout.write(
        `installed: ${installed.canonicalPath}\n` +
          `Ask your agent to "make a demo of <your app>".\n`,
      );
    } else {
      process.stdout.write(text);
    }
    return;
  }

  if (cmd === "--version" || cmd === "-v") {
    const pkg = JSON.parse(
      await readFile(
        resolve(dirname(fileURLToPath(import.meta.url)), "..", "package.json"),
        "utf8",
      ),
    ) as { version: string };
    process.stdout.write(`${pkg.version}\n`);
    return;
  }

  if (cmd === "--help" || cmd === "-h" || cmd === "help") {
    process.stdout.write(USAGE);
    return;
  }

  if (cmd === "edit") {
    const takePath = positional[0];
    if (!takePath) throw new Error("edit: missing <take.mp4 | take dir>");
    const take = await resolveTakePaths(takePath);
    await requireTakeFiles(take, { capture: true });
    const { startEditServer } = await import("@open-take/runtime");
    const portFlag = flag("--port");
    await startEditServer({
      takePath: take.compositionPath,
      ...(portFlag ? { port: Number(portFlag) } : {}),
      open: !has("--no-open"),
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
