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
import { stat as fsStat, readFile, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  asDefects,
  auditCursor,
  authProfile,
  buildBeatSheet,
  buildDefectReport,
  type CaptureLog,
  type CompositionIssue,
  checkTake,
  type Defect,
  type DefectReport,
  ciAllowedOrigins,
  ciTake,
  emitGithubOutputs,
  emitStepSummary,
  ensureChrome,
  formatIssues,
  formatNotes,
  healingWithheld,
  inspectPage,
  lintPlan,
  loadCaptureLogSibling,
  makeTake,
  openPath,
  type PostShootPass,
  PrecheckRefusal,
  profileDir,
  readNotes,
  renderAbReel,
  renderBeforeAfter,
  renderCompositionFile,
  renderDefectBlock,
  renderDraft,
  renderFrames,
  renderReview,
  renderTeaserGif,
  reRenderInPlace,
  requireTakeFiles,
  resolveTakePaths,
  revealPath,
  runPostShootGates,
  SAY_IT_CARD,
  settleDefects,
  skippedDefects,
  stagePrev,
  type TakeComposition,
  type TakePaths,
  type TakePlan,
  toDraft,
  waitForNotes,
} from "@open-take/runtime";
import { autoSyncAgentSkill, syncAgentSkill } from "./init";

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
  "--strict",
  "--no-strict",
  "--force",
  "--headed",
  "--verbose",
  "--wait",
  "--all",
  "--quiet",
  "--dry-run",
  "--skip-permissions",
  "--no-teaser",
]);

const argv = process.argv.slice(2);
const cmd = argv[0];
const positional: string[] = [];
const flags: Record<string, string> = {};
let parseError: string | undefined;
for (let i = 1; i < argv.length; i++) {
  const a = argv[i]!;
  if (a.startsWith("--")) {
    if (BOOL_FLAGS.has(a)) {
      flags[a] = "true";
    } else {
      // a value flag with its value missing must ERROR, not swallow the next
      // flag (a bare `--profile --draft` would otherwise run UNauthenticated
      // with "--draft" as the profile name — or worse, silently drop both).
      const v = argv[i + 1];
      if (v == null || v.startsWith("--")) {
        parseError = `${a} requires a value`;
        break;
      }
      flags[a] = v;
      i++;
    }
  } else {
    positional.push(a);
  }
}
const flag = (name: string): string | undefined => flags[name];
const has = (name: string): boolean => name in flags;

// Per-command flag allowlists. A flag this binary doesn't know (or that
// belongs to another verb) ERRORS instead of being silently ignored — the
// field failure this prevents: an older installed CLI accepting `render
// --draft` (a valid flag elsewhere) and silently rendering a full master.
const FLAGS_BY_CMD: Record<string, string[]> = {
  inspect: ["--viewport", "--profile", "--headed", "--verbose"],
  make: [
    "--plan",
    "--out",
    "--fps",
    "--capture-scale",
    "--strict",
    "--no-strict",
    "--force",
    "--draft",
    "--no-open",
    "--profile",
    "--headed",
    "--verbose",
  ],
  render: [
    "--review",
    "--draft",
    "--open",
    "--reveal",
    "--no-open",
    "--no-strict",
    "--composition",
    "--video",
    "--out",
    "--capture-log",
    "--verbose",
  ],
  check: ["--no-strict", "--verbose"],
  beats: ["--card"],
  frames: ["--beat", "--tile", "--open", "--verbose"],
  ab: ["--set", "--beat", "--full", "--draft", "--before-after", "--no-open", "--verbose"],
  edit: ["--port", "--no-open"],
  notes: ["--wait", "--timeout", "--all", "--quiet"],
  auth: ["--url"],
  ci: [
    "--start",
    "--brief",
    "--captions",
    "--title-card",
    "--change-title",
    "--changed-paths",
    "--out",
    "--fps",
    "--capture-scale",
    "--budget-usd",
    "--agent",
    "--model",
    "--allowed-tools",
    "--allowed-origins",
    "--skip-permissions",
    "--wait-timeout",
    "--timeout",
    "--dry-run",
    "--no-teaser",
    "--verbose",
  ],
  init: ["--force"],
  skill: ["--force"],
};

function rejectUnknownFlags(cmd: string): void {
  const allowed = FLAGS_BY_CMD[cmd];
  if (!allowed) return;
  for (const f of Object.keys(flags)) {
    if (!allowed.includes(f))
      throw new Error(
        `${cmd}: unknown flag ${f}${allowed.length ? ` — allowed: ${allowed.join(" ")}` : " — this command takes no flags"}\n` +
          `(if a newer doc mentions ${f}, this installed open-take predates it: run npx from the project ` +
          `that has open-take installed, or upgrade — a bare npx elsewhere resolves the registry copy)`,
      );
  }
}

function parseViewport(s?: string): { width: number; height: number } | undefined {
  if (!s) return undefined;
  const [w, h] = s.toLowerCase().split("x").map(Number);
  return w && h ? { width: w, height: h } : undefined;
}

const USAGE = `open-take — agent-native demo recorder

Usage:
  open-take inspect <url> [--viewport 1920x1080]
  open-take make   --plan <plan.json> --out <out.mp4> [--fps 60] [--draft] [--no-open]
  open-take render <take> [--review] [--draft] [--open] [--reveal] [--no-open] [--no-strict]
  open-take check  <take> [--no-strict]
  open-take beats  <take> [--card]
  open-take frames <take> [--beat N] [--tile 720]
  open-take ab     <take> --set <knob>=<v1>,<v2>[,<v3>] [--beat N] [--full] [--draft] [--no-open]
  open-take ab     <take> --before-after [--beat N] [--full] [--no-open]
  open-take edit   <take> [--port 4178] [--no-open]
  open-take notes  [<take>] [--wait [--timeout 1800]] [--all] [--quiet]
  open-take auth   <name> [--url <login-url>]
  open-take ci     <url> [--start "<command>"] [--brief "<what to demo>"]
                   [--out demos/take.mp4] [--budget-usd 8] [--dry-run]
  open-take init   [--force]
  open-take skill  [install [--force]]

  A take is TWO things on disk: the postable master at exactly your --out path
  (<out>.mp4), and a working directory beside it (<out>.take/) holding
  everything else — composition.json, the kept capture, the disposable
  review/draft/ab copies, prev.mp4, dossier.md, notes.md. Post the mp4; ignore,
  .gitignore (*.take/) or delete the folder.

  Keep takes together in ONE folder (the default --out is demos/take.mp4) and
  name each after the app or the cut — demos/myapp.mp4, demos/myapp-pricing.mp4.
  Their masters then sit side by side, which is how you compare and pick one.

  <take> is the master mp4, the <name>.take/ dir, any file inside it, or a
  directory holding exactly one take — the rest resolves by convention.

  make    drive the app (real-time) → polished <out>.mp4 + <out>.take/ with the
          editable composition.json + the KEPT capture.mp4 + capture.json.
          The raw capture auto-opens the moment it lands (minutes before the
          polished render finishes) so the wait is spent watching raw footage —
          --no-open to skip. Refuses to overwrite a take of a DIFFERENT app
          (name the second demo after its app instead); --force overrides.
  render  re-render the (edited) composition over the kept capture — NO app
          drive, deterministic. The previous master is kept as prev.mp4
          so "keep the old one" is a mechanical revert. The new master then
          goes through the same post-shoot gates as make (cursor audit, dead
          opening, static tail, zoom vs payoff) and re-prints the capture's
          skipped steps; a cursor-audit error gets ONE bounded re-render +
          re-audit (the defect class is transient) before any error finding
          or skipped step exits 2 (--no-strict downgrades to a warning).
          --review renders a fast DRAFT copy to review.mp4 instead, with
          beat badges burned in (the video teaches "beat 3" refers) + a REVIEW
          watermark — never overwrites the postable master. Review copies
          auto-open in the player (--no-open to skip; --reveal to reveal
          instead).
          --draft renders a clean draft copy to draft.mp4 (30fps cap +
          motion blur off, no badges) — the cheap re-render for frame checks
          mid-refine; never overwrites the master. Does not auto-open.
          (legacy flags --composition/--video/--out/--capture-log still work)
  check   judge an existing take without rendering anything: re-run the
          post-shoot gates against the delivered master (cursor audit · dead
          opening · static tail · zoom vs payoff) and re-print the capture's
          skipped steps. Exit 2 on any error finding or skipped step
          (--no-strict downgrades); exit 1 when a gate could not run at all —
          "no error found" by a gate that never ran is not a clean bill.
          Any judged finding (warns included) also emits the machine-readable
          defects block and refreshes <name>.take/defects.json. Otherwise
          READ-ONLY — it never rewrites the take itself; when the cursor
          audit fails, \`render\` is the healing move (it re-renders from the
          frozen capture and re-audits).

  beats   print the numbered beat sheet — the shared map for notes like
          "beat 3: no zoom". --card appends the say-it cheat card.
  frames  extract a beat-aware contact sheet (<take>/frames.png) from the
          delivered mp4: an intro row, one row per beat (a mid-travel cell +
          4 samples across the beat's camera HOLD, timed off the real camera
          schedule), a tail row. --beat N densifies one beat into a 10-cell
          strip with per-cell phase labels. Pass <base>.take/draft.mp4 or
          <base>.take/review.mp4 as <take> to sample that copy instead of the
          master. --tile <px> sets tile width (default 480; a --beat strip
          defaults 720 — thumbnails suspect a framing bug, bigger tiles
          confirm it). Seconds (pure ffmpeg, no render) — this is the
          verification step: judge framing on HOLD cells, never mid-ramp.
  ab      answer a taste question by eye: ONE knob, up to 3 candidate values
          (the current state is always variant A), rendered as a labeled reel —
          each variant plays twice. Auto-opens (--no-open to skip).
          knobs: zoom (with --beat N; values off/light/medium/tight/close or a
          number) · look (midnight/ink/slate/ocean/plum/ember/paper/plain) ·
          pace (calm/natural/brisk) · finish (smooth/crisp/heavy) · or a raw
          dot-path like cursor.holdMs=900,1300.
          Windowed to the beat's zoom arc by default (--full for the whole
          take); FEEL knobs render at full quality — judge motion by eye.
          --before-after replays prev.mp4 vs the current master instead
          (no render; BEFORE then AFTER, twice).

  edit    open the visual editor on a take: preview + icon-rail settings +
          timeline with zoom blocks; every change previews live, Export renders
          the real mp4 — all on 127.0.0.1, nothing uploaded. Hands off anything
          it can't do (reorder, re-record) to your agent via the Agent panel
          (notes land in <base>.take/notes.md + this terminal). Export
          overwrites the master and keeps the replaced one as prev.mp4.

  notes   read the director's notes the editor's Agent panel left for you —
          the notes you have NOT already read, then remembered as read (the
          position lives in notes.cursor; --all re-reads everything).
          <take> defaults to the current directory. --quiet prints nothing
          when there is nothing new (for hooks).
          --wait BLOCKS until a note lands and then exits — start it in the
          background when you open the editor and its exit IS your wake-up.
          --timeout <seconds> caps the wait (default 1800 = 30min); a burst of
          notes typed together arrives as one batch.

  auth    one-time interactive login on a persistent profile: opens a normal
          (headed) Chrome on ~/.open-take/profiles/<name> at --url, you log in
          by hand, then press Enter here (or quit Chrome). Later captures reuse
          the session via \`make --profile <name>\` — still headless, no
          credentials ever touch a plan. One profile per site keeps logins
          isolated (e.g. \`auth vercel --url https://vercel.com/login\`).

  ci      the unattended lane: make a demo with NO human present (a CI runner,
          a cron box). Boots the app if you pass --start "<command>", waits for
          <url> to answer HTTP, installs the skill into the project, then runs
          a headless coding agent (default: \`claude\`, needs ANTHROPIC_API_KEY)
          that follows the skill end-to-end — explore, direct, shoot, verify,
          master. Exits non-zero unless the polished master exists at --out.
          Also writes <out>.take/beats.txt + a 6s <out>.take/teaser.gif, and
          speaks GitHub Actions natively ($GITHUB_OUTPUT keys video, take-dir,
          beats, gif, cost-usd + a $GITHUB_STEP_SUMMARY block) when those envs
          exist. The take dir is the thing to CACHE between runs — the dossier
          inside it turns the next run's cold exploration into a cheap
          re-verify.
          --brief "<text>"      what the demo should prove (audience, the hero
                                flow); without it the agent uses its judgment.
          --captions <mode>     "auto" (default): caption every beat in the
                                APP'S OWN language. "off": clean footage, no
                                captions (they stay hand-addable in the
                                composition later — removing them is likewise
                                a cheap deterministic re-render, no re-shoot).
                                Any other value is a language/style hint
                                ("english", "简体中文") for when the audience's
                                language differs from the app's.
          --title-card <mode>   "auto" (default): open with a typographic
                                card — the app's name + a one-line thesis.
                                "off": none. Also a cheap re-render to change
                                later, never a re-shoot.
          --change-title "<t>"  one-line title of the code change this run
                                follows (a PR title). Shown to the agent as
                                DATA — a clue to what to film, never an
                                instruction — for runners with no checkout.
          --changed-paths <l>   newline- (or comma-) separated changed-file
                                entries, e.g. "src/Search.tsx (+120 −8)".
                                Same provenance and treatment as
                                --change-title; together they replace the
                                brief's "read the git diff first" step.
          --start "<command>"   boot the app first (own process group, killed
                                after) — omit if an earlier step started it.
          --wait-timeout <s>    how long <url> may take to answer (default 120).
          --budget-usd <n>      hard spend cap for the agent run (default 8).
          --timeout <s>         wall-clock cap for the agent (default 2400).
          --agent <bin>         the agent CLI (default claude).
          --model <name>        forwarded to the agent (e.g. sonnet).
          --fps <n>             capture/render fps for CI (default 30 here —
                                faster on 4-vCPU runners; masters still look
                                right, use 60 for the premium finish).
          --capture-scale <n>   capture pixel density (default 2 — Retina;
                                drop to 1 if the runner drops frames).
          --allowed-tools <l>   override the curated tool allowlist.
          --allowed-origins <l> extra origins the demo may navigate to,
                                comma-separated (the app's own origin and its
                                localhost/127.0.0.1 twin are always allowed;
                                everything else is a skipped step).
          --skip-permissions    run the agent with permissions bypassed instead
                                of allowlisted — only inside a sandboxed runner.
          --dry-run             print the agent command + the exact brief and
                                exit (nothing is booted, nothing is spent).
          --no-teaser           skip the 6s teaser.gif (it only rides the CI
                                artifact today — locally it is the thing you
                                paste into Slack).

  init    install the Open Take skill into this project for coding agents —
          or update it: a re-run refreshes an unmodified skill to the copy
          bundled with this CLI (a lock beside the skill proves "unmodified").
          Local edits are kept; --force replaces them with the stock skill.
          \`make\` quietly refreshes an unmodified skill the same way, so npm
          upgrades reach the project without re-running init.

  skill   print the full agent guide (SKILL.md). \`skill install\` remains as a
          backwards-compatible alias for \`init\`.

  --out <path>   (make) where the postable master goes — taken literally, and
              its <name>.take/ working dir is created beside it. Default
              demos/take.mp4.
  --fps <n>   (make only) capture AND render fps (default 60). Drop to 30 for
              fast drafts while iterating.
  --capture-scale <n>   (make/ci) capture pixel density (default 2 — Retina;
              keeps zooms sharp). Drop to 1 if a heavy page can't hold fps.
  --no-strict (make/render/check) exit 0 even when plan steps were skipped
              (target not found, or a navigate destination that didn't
              resolve) or a post-shoot check found an error (mis-drawn cursor,
              dead opening). By DEFAULT those exit 2 — the mp4 is still
              written and the summary lists every finding, but the exit code
              refuses to call a defective take a success. A cursor-audit
              error first gets ONE bounded re-render + re-audit (measured:
              that defect class is transient and a re-render heals it) before
              the exit code fires. (--strict is the default and remains
              accepted on make.)
              Every defective verdict also prints a machine-readable report —
              one JSON object between \`--- open-take defects v1 ---\` and
              \`--- end open-take defects ---\` carrying EVERY finding (warns
              included) with its measured values and computed fix — and writes
              it to <name>.take/defects.json when the take dir exists (\`check\`
              writes it for warn-only findings too). Relay the block VERBATIM
              to whoever authored the plan and re-run; at most two repair
              rounds (see the skill's repair loop).
  --force     (make only) overwrite the take at --out even when it was shot from
              a different app. Without it that is refused: two demos in one
              folder each get their own name (\`--out myapp.mp4\`). Under
              OPEN_TAKE_CI the refusal softens to a warning — preview deploys
              give the same app a fresh origin every PR.
  --profile <name>   (make/inspect) drive an authenticated session: reuse the
              persistent profile created by \`open-take auth <name>\`.
  --headed    (make/inspect) drive a visible Chrome window instead of headless —
              the escape hatch for sites that gate on a real window. The
              screencast records the page either way.
  --verbose   show per-event diagnostics (frame-diff lines, renderer console
              passthrough). Hidden by default so real warnings stay visible.
`;

const fmtDuration = (s: number): string => (s >= 120 ? `${Math.round(s / 60)}m` : `${s}s`);

const fmtBytes = (n: number): string =>
  n > 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.round(n / 1024)} KB`;

/** Where a take goes when nobody says. Takes belong TOGETHER in one folder —
 *  their masters then sit side by side, which is how you compare, pick and drag
 *  them — and that folder should not be the user's project root, which is
 *  someone else's. This is only the default: `--out` is always taken literally,
 *  because a tool that writes your video somewhere other than where you pointed
 *  is worse than any tidiness it buys. */
const DEFAULT_OUT = "demos/take.mp4";

/** `--out` names the postable master, so it is an mp4 path. A bare name is the
 *  natural thing to type (`--out demo`) and used to produce a file literally
 *  called "demo" that no player would open by double-click. */
function normalizeOut(out: string): string {
  if (/\.mp4$/i.test(out)) return out;
  if (extname(out) === "") return `${out}.mp4`;
  throw new Error(`make: --out must be an .mp4 path (got "${out}")`);
}

/** Two demos, one folder: the failure this prevents is a second `make` at the
 *  default `--out` silently destroying the first demo — a capture that cost
 *  minutes of real app drive, plus its hand-edited composition. A re-make of
 *  the SAME app is the legitimate case and stays silent; a take shot from a
 *  different origin is almost certainly a name collision, so it stops and says
 *  what to type instead. Takes made before the URL was recorded have nothing to
 *  compare and are not blocked. */
async function refuseCrossAppOverwrite(take: TakePaths, planUrl: string): Promise<void> {
  const previous = await readFile(take.captureLogPath, "utf8")
    .then((t) => (JSON.parse(t) as { url?: string }).url)
    .catch(() => undefined);
  const origin = (u: string | undefined): string | undefined => {
    try {
      return u ? new URL(u).origin : undefined;
    } catch {
      return undefined;
    }
  };
  const was = origin(previous);
  const now = origin(planUrl);
  if (!was || !now || was === now) return;
  // Unattended runs: per-PR preview deploys hand the SAME app a fresh hostname
  // every PR (myapp-git-pr7-team.vercel.app), so a differing origin is the
  // EXPECTED shape, not a second app — and in CI the take's identity is the
  // pipeline's cache key (--out), declared by the operator. Warn (the log
  // keeps the trail) instead of stranding regenerate mode.
  if (process.env.OPEN_TAKE_CI) {
    process.stderr.write(
      `⚠ make: overwriting a take of ${was} with one of ${now} — allowed under OPEN_TAKE_CI ` +
        `(per-PR preview origins differ by design; the --out path names the app)\n`,
    );
    return;
  }
  // A local app's hostname is "localhost" or an IP — no name to suggest there,
  // and suggesting "--out 127.mp4" reads like a bug.
  const host = new URL(planUrl).hostname.replace(/^www\./, "");
  const named = /^[a-z]/i.test(host) && host !== "localhost" ? host.split(".")[0] : null;
  throw new Error(
    `make: ${take.mp4Path} is already a take of ${was} — this plan drives ${now}.\n` +
      `Overwriting it would destroy that demo's capture and composition. Two demos in one folder\n` +
      `each want their own name: --out ${named ?? "<the-app>"}.mp4\n` +
      `If this IS the same app at a new address (a dev server that moved port), pass --force.`,
  );
}

async function readyLine(mp4Path: string): Promise<string> {
  const take = await resolveTakePaths(mp4Path);
  const comp = JSON.parse(await readFile(take.compositionPath, "utf8")) as {
    durationMs: number;
    startMs?: number;
    output: { width: number; height: number; fps: number };
  };
  const size = (await fsStat(mp4Path)).size;
  const seconds = (comp.durationMs - (comp.startMs ?? 0)) / 1000;
  return `${mp4Path} · ${seconds.toFixed(1)}s · ${comp.output.width}×${comp.output.height}@${comp.output.fps} · ${fmtBytes(size)}`;
}

/** Re-print the validator's non-fatal findings in the SUMMARY. renderTake
 *  already writes them to stderr, but that happens BEFORE the render — by the
 *  time the run ends they are minutes deep under progress output and get
 *  scrolled past, which is how a "punches into empty space" warning once
 *  shipped a finale that cropped the app. Same treatment as skipped steps. */
function printWarnings(warnings: CompositionIssue[] | undefined): void {
  if (!warnings?.length) return;
  process.stdout.write(
    `\n⚠ ${warnings.length} composition warning${warnings.length === 1 ? "" : "s"}:\n` +
      `${formatIssues(warnings)}\n` +
      `the render went ahead — but look at each one before you post this\n`,
  );
}

/** The capture log's skipped[] re-printed as part of a verdict (render/check;
 *  `make` prints its own copy with re-make guidance and exits on it first). */
function printSkippedSummary(skipped: NonNullable<CaptureLog["skipped"]>): void {
  process.stdout.write(
    `\n⚠ ${skipped.length} step${skipped.length === 1 ? "" : "s"} skipped at capture time:\n` +
      skipped
        .map(
          (s) =>
            `  step ${s.step + 1}: ${s.action} ${JSON.stringify(s.target ?? "")} (${s.reason})\n`,
        )
        .join("") +
      `the video is missing ${skipped.length === 1 ? "this beat" : "these beats"} — only a re-make (fresh capture) can restore them\n`,
  );
}

const verdictLine = (errors: number, skipped: number): string =>
  `${errors} post-shoot check error${errors === 1 ? "" : "s"}` +
  (skipped ? ` + ${skipped} skipped step${skipped === 1 ? "" : "s"}` : "");

/** Print one post-shoot gate pass's findings (make/render/check share the
 *  format). The "re-audit" header marks the second pass after the bounded
 *  re-render, so a reader can tell which findings survived the heal. */
function printPostShoot(issues: CompositionIssue[], pass: PostShootPass): void {
  if (!issues.length) return;
  process.stdout.write(
    `\n⚠ ${issues.length} ${pass === "re-audit" ? "re-audit" : "post-shoot check"} finding${issues.length === 1 ? "" : "s"}:\n` +
      issues
        .map(
          (p) =>
            `  [${p.severity}] ${p.path}: ${p.message}\n${p.fix ? `          fix: ${p.fix}\n` : ""}`,
        )
        .join(""),
  );
}

/** The pre-capture plan-target warnings re-printed as part of a verdict.
 *  `make` prints the live ones; render/check read them back from capture.json
 *  so a later verdict still names the late-bound suspects (the one defect
 *  class the gate cannot refuse — the repair loop closes it from here). */
function printPrecheckWarns(precheck: readonly CompositionIssue[]): void {
  if (!precheck.length) return;
  process.stdout.write(
    `\n⚠ ${precheck.length} plan-target warning${precheck.length === 1 ? "" : "s"} (pre-capture check):\n` +
      precheck
        .map(
          (p) =>
            `  [${p.severity}] ${p.path}: ${p.message}\n${p.fix ? `          fix: ${p.fix}\n` : ""}`,
        )
        .join(""),
  );
}

/** Print the machine-readable defects block, and persist it as
 *  `<take>.take/defects.json` when the verdict belongs to a take on disk —
 *  the stdout block is the authority, the file is the convenience copy.
 *
 *  The stdout writes are AWAITED: off Linux, stdio pipes are asynchronous,
 *  and a process.exit right after a fire-and-forget write measurably
 *  truncates the largest write in the queue once a slow reader has the ~64KB
 *  pipe buffer full — which would cut the one payload a machine parses
 *  mid-JSON. Awaiting the callback drains everything queued before it too;
 *  the short verdict lines printed after this remain best-effort prose. */
async function emitDefects(report: DefectReport, takeDir?: string): Promise<void> {
  const flush = (s: string): Promise<void> =>
    new Promise((done) => process.stdout.write(s, () => done()));
  await flush(renderDefectBlock(report));
  if (!takeDir) return;
  const p = join(takeDir, "defects.json");
  try {
    await writeFile(p, `${JSON.stringify(report, null, 1)}\n`);
    await flush(`defects also written to: ${p}\n`);
  } catch (e) {
    process.stderr.write(
      `could not write ${p} (${e instanceof Error ? e.message : e}) — the block above is the report\n`,
    );
  }
}

/** The take dir that may carry a REFUSAL's defects.json. A refusal records
 *  nothing, so it never creates the dir (a spurious ENOENT on every
 *  first-make refusal taught that) — and a dir that already exists must
 *  belong to THIS plan's app: a lint-refused plan for app B must not plant
 *  its report in app A's take dir (same origin rule as the overwrite guard;
 *  --force claims the dir like it claims the overwrite; an unparseable plan
 *  url claims nothing). */
async function defectsDirFor(
  take: TakePaths | null,
  planUrl: unknown,
  force: boolean,
): Promise<string | undefined> {
  if (!take) return undefined;
  if (!(await fsStat(take.dir).catch(() => null))?.isDirectory()) return undefined;
  if (force) return take.dir;
  if (typeof planUrl !== "string") return undefined;
  const previous = await readFile(take.captureLogPath, "utf8")
    .then((t) => (JSON.parse(t) as { url?: string }).url)
    .catch(() => undefined);
  const origin = (u: string | undefined): string | undefined => {
    try {
      return u ? new URL(u).origin : undefined;
    } catch {
      return undefined;
    }
  };
  const was = origin(previous);
  return !was || was === origin(planUrl) ? take.dir : undefined;
}

/** A verdict with nothing to report must not leave last round's defects.json
 *  lying around — a stale report re-fed to the plan author would "repair"
 *  defects that are already gone. */
const clearDefects = async (takeDir: string): Promise<void> =>
  unlink(join(takeDir, "defects.json")).catch(() => {});

async function main() {
  if (parseError) throw new Error(`${cmd ?? ""}: ${parseError}`.trim());
  if (cmd) rejectUnknownFlags(cmd);
  // The vendored renderer forwards page-console noise ("Worker 0: JSHandle:…")
  // only when this is set (see revideo-renderer/scripts/build.mjs).
  if (has("--verbose")) process.env.OPEN_TAKE_VERBOSE = "1";

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

  // package.json sits beside dist/ (or beside src/ in the monorepo) — the
  // version stamps the skill lock so a lock file names the CLI that wrote it.
  const cliVersion = async (): Promise<string | undefined> => {
    const here = dirname(fileURLToPath(import.meta.url));
    return readFile(resolve(here, "..", "package.json"), "utf8")
      .then((t) => (JSON.parse(t) as { version?: string }).version)
      .catch(() => undefined);
  };

  // `init` and its alias `skill install`: install the skill, or refresh an
  // installed one to this CLI's copy. Hash-verified local edits are the
  // user's — refused without --force, so a routine re-init can never eat a
  // deliberately customized playbook.
  const runInit = async (): Promise<void> => {
    const res = await syncAgentSkill({
      root: process.cwd(),
      skillText: await bundledSkill(),
      cliVersion: await cliVersion(),
      overwriteModified: has("--force"),
    });
    if (res.action === "kept")
      throw new Error(
        `init: ${res.canonicalPath} has local edits — keeping them.\n` +
          `To replace them with this CLI's stock skill: ${INVOKE} init --force`,
      );
    process.stdout.write(
      res.drift === "missing"
        ? `initialized: ${res.canonicalPath}\nAsk your agent to "make a demo of <your app>".\n`
        : res.drift === "current"
          ? `up to date: ${res.canonicalPath}\n`
          : `updated: ${res.canonicalPath} (now matches this CLI)\n`,
    );
  };

  if (cmd === "init") {
    await runInit();
    return;
  }

  if (cmd === "auth") {
    const name = positional[0];
    if (!name)
      throw new Error(`auth: missing <name> — e.g. ${INVOKE} auth vercel --url <login-url>`);
    process.stdout.write(
      `opening Chrome on the "${name}" profile — log in there, then press Enter here (or quit Chrome)…\n`,
    );
    const { dir } = await authProfile({ name, url: flag("--url") });
    process.stdout.write(
      `profile saved: ${dir}\nauthenticated captures: ${INVOKE} make --plan <plan.json> --out <out.mp4> --profile ${name}\n`,
    );
    return;
  }

  if (cmd === "ci") {
    const url = positional[0];
    if (!url)
      throw new Error(
        `ci: missing <url> — the address the app answers on (add --start "<command>" if this run should boot it)`,
      );
    const out = normalizeOut(flag("--out") ?? DEFAULT_OUT);
    const num = (name: string): number | undefined => {
      const raw = flag(name);
      if (raw == null) return undefined;
      const n = Number(raw);
      if (!Number.isFinite(n) || n <= 0)
        throw new Error(`ci: ${name} expects a positive number (got "${raw}")`);
      return n;
    };
    // Every flag validates BEFORE any side effect (skill install, Chrome
    // download) — a typo'd flag should cost nothing.
    const waitTimeoutS = num("--wait-timeout");
    const agentTimeoutS = num("--timeout");
    const budgetUsd = num("--budget-usd");
    const fps = num("--fps");
    const captureScale = num("--capture-scale");
    if (flag("--allowed-origins")) ciAllowedOrigins(url, flag("--allowed-origins"));

    // --dry-run is PURE: print the command + brief and touch nothing — no
    // skill install (installers never write into a tree that only asked to
    // look), no Chrome download. The printed skillPath is where a real run
    // WOULD install it.
    const dryRun = has("--dry-run");
    // The agent discovers the playbook the same way an interactive one does:
    // installed in the project. An unmodified skill is refreshed to the copy
    // bundled with this CLI (skill and binary must agree on the verbs); a
    // hash-verified locally-edited skill is the operator's deliberate playbook
    // and is kept — with a warning, since the skew is now theirs to own.
    const skillPath = dryRun
      ? resolve(process.cwd(), ".claude", "skills", "open-take", "SKILL.md")
      : await (async () => {
          const res = await syncAgentSkill({
            root: process.cwd(),
            skillText: await bundledSkill(),
            cliVersion: await cliVersion(),
          });
          if (res.action === "kept")
            process.stderr.write(
              `⚠ ci: ${res.canonicalPath} has local edits — the agent follows YOUR version, ` +
                `not this CLI's (\`${INVOKE} init --force\` restores stock)\n`,
            );
          return res.claudePath;
        })();

    // Chrome resolves BEFORE the agent starts burning budget: the first run on
    // a cold runner downloads ~150MB, and that wait should not sit inside an
    // agent turn (or worse, time one out).
    if (!dryRun) await ensureChrome();

    const res = await ciTake({
      url,
      outPath: out,
      brief: flag("--brief"),
      captions: flag("--captions"),
      titleCard: flag("--title-card"),
      changeTitle: flag("--change-title"),
      changedPaths: flag("--changed-paths"),
      startCmd: flag("--start"),
      ...(waitTimeoutS != null ? { waitTimeoutMs: waitTimeoutS * 1000 } : {}),
      agentBin: flag("--agent"),
      model: flag("--model"),
      budgetUsd,
      ...(agentTimeoutS != null ? { agentTimeoutMs: agentTimeoutS * 1000 } : {}),
      fps,
      captureScale,
      allowedTools: flag("--allowed-tools"),
      allowedOrigins: flag("--allowed-origins"),
      skipPermissions: has("--skip-permissions"),
      skillPath,
      dryRun,
      logProgress: true,
    });
    if (res.dryRun) return;

    const take = await resolveTakePaths(res.mp4Path);
    const comp = JSON.parse(await readFile(take.compositionPath, "utf8"));
    const sheet = buildBeatSheet(comp, take.name);
    const beatsPath = join(take.dir, "beats.txt");
    await writeFile(beatsPath, `${sheet}\n`);
    // The teaser's only CI consumer today is the artifact zip (GitHub's API
    // can't post playable media until the hosted relay exists) — so it stays
    // default-on for the humans who grab it, with --no-teaser for leaner runs.
    const gifPath = join(take.dir, "teaser.gif");
    const gif = has("--no-teaser")
      ? undefined
      : await renderTeaserGif(res.mp4Path, gifPath).catch((e) => {
          process.stderr.write(`⚠ teaser gif failed (the take itself is fine): ${e.message}\n`);
          return undefined;
        });

    if (res.agentWarning)
      process.stderr.write(
        `⚠ the agent died after delivering — the master passed every gate and ships anyway: ${res.agentWarning.split("\n")[0]}\n`,
      );
    const ready = await readyLine(res.mp4Path);
    const agentLine =
      res.costUsd != null || res.turns != null
        ? `agent:  ${res.costUsd != null ? `$${res.costUsd.toFixed(2)}` : "?"}${res.turns != null ? ` · ${res.turns} turns` : ""}\n`
        : "";
    process.stdout.write(
      `\nready:  ${ready}\nbeats:  ${beatsPath}\n${gif ? `teaser: ${gif}\n` : ""}${agentLine}`,
    );

    await emitGithubOutputs({
      video: res.mp4Path,
      "take-dir": take.dir,
      beats: beatsPath,
      ...(gif ? { gif } : {}),
      ...(res.costUsd != null ? { "cost-usd": res.costUsd.toFixed(4) } : {}),
    });
    await emitStepSummary(
      [
        `## open-take demo — ${take.name}`,
        "",
        `**${ready}**`,
        "",
        // fenced + backtick-stripped, same rule as the PR comment: agent
        // prose is content, never markup
        ...(res.finalText ? ["```", res.finalText.replace(/`/g, "'"), "```", ""] : []),
        "```",
        sheet,
        "```",
        "",
        `_${agentLine.trim() || "agent run"} · download the video from this run's artifacts_`,
      ].join("\n"),
    );
    return;
  }

  if (cmd === "inspect") {
    const url = positional[0];
    if (!url) throw new Error("inspect: missing <url>");
    const profile = flag("--profile");
    const res = await inspectPage(url, {
      viewport: parseViewport(flag("--viewport")),
      ...(profile ? { userDataDir: profileDir(profile) } : {}),
      ...(has("--headed") ? { headless: false } : {}),
    });
    process.stdout.write(`${JSON.stringify(res, null, 2)}\n`);
    return;
  }

  if (cmd === "make") {
    const planPath = flag("--plan");
    const out = normalizeOut(flag("--out") ?? DEFAULT_OUT);
    if (!planPath) throw new Error("make: missing --plan <plan.json>");
    const parsedPlan: unknown = JSON.parse(await readFile(planPath, "utf8"));
    // The structural gate in front of everything: a plan whose steps the
    // engine would silently no-op (a wait without `ms`) or certainly skip (a
    // type without `value`) must fail HERE, in milliseconds, with messages
    // that teach the field semantics — measured on a 44-plan repair benchmark,
    // teaching messages doubled one-retry convergence over terse ones.
    // resolved before the lint so a refusal can refresh <out>.take/defects.json
    // — a stale round-1 report outliving a round-2 lint refusal would feed the
    // repair loop defects that are already fixed (resolveTakePaths is a pure
    // string transform; the master need not exist)
    const takePre = await resolveTakePaths(out).catch(() => null);
    const planIssues = lintPlan(parsedPlan);
    {
      const planErrors = planIssues.filter((i) => i.severity === "error");
      for (const i of planIssues)
        process.stderr.write(
          `plan ${i.severity}: ${i.path}: ${i.message}\n${i.fix ? `  fix: ${i.fix}\n` : ""}`,
        );
      if (planErrors.length) {
        process.stderr.write(
          `make: ${planPath} has ${planErrors.length} structural error${planErrors.length === 1 ? "" : "s"} — nothing was recorded. Fix the plan and re-make.\n`,
        );
        await emitDefects(
          buildDefectReport({
            verb: "make",
            verdict: `refused before capture: ${planErrors.length} plan structural error${planErrors.length === 1 ? "" : "s"} — nothing was recorded`,
            exitCode: 2,
            plan: planPath,
            defects: asDefects("plan-lint", planIssues),
          }),
          await defectsDirFor(
            takePre,
            (parsedPlan as { url?: unknown } | null)?.url,
            has("--force"),
          ),
        );
        process.exit(2);
      }
    }
    // warn-tier lint findings survive to the verdict report below — a defect
    // block that dropped them would hide half the repair surface
    const planWarns = planIssues.filter((i) => i.severity === "warn");
    const plan = parsedPlan as TakePlan;
    // npm upgrades ship a new SKILL.md inside the package, but the copy agents
    // read lives in the project — refresh it here, after validation (make is
    // the verb every session runs, and it already writes into this tree).
    // Only a PROVABLY unmodified skill is touched — see autoSyncAgentSkill —
    // and never fatally: a demo must not fail over its own documentation.
    const skillSync = await autoSyncAgentSkill({
      root: process.cwd(),
      skillText: await bundledSkill(),
      cliVersion: await cliVersion(),
    }).catch(() => ({ action: "none" }) as const);
    if (skillSync.action === "refreshed")
      process.stderr.write(
        `⟳ agent skill refreshed to match this CLI: ${skillSync.canonicalPath}\n`,
      );
    else if (skillSync.action === "hint")
      process.stderr.write(
        `note: ${skillSync.canonicalPath} predates skill version tracking — \`${INVOKE} init\` updates it\n`,
      );
    const fpsFlag = flag("--fps");
    const fps = fpsFlag ? Number(fpsFlag) : undefined;
    const scaleFlag = flag("--capture-scale");
    const captureScale = scaleFlag ? Number(scaleFlag) : undefined;
    const profile = flag("--profile");
    const headed = has("--headed");
    // a re-make (re-shoot) is a new generation: keep the old master as prev so
    // --before-after compares against the take the user just reacted to — and
    // keep the old COMPOSITION too: a re-make re-plans from the new capture, so
    // any hand-edited zoom overrides in the old one would silently vanish
    // (issue #10). `<base>.prev.composition.json` preserves them for re-apply.
    if (takePre && !has("--force")) await refuseCrossAppOverwrite(takePre, plan.url);
    const noStage = { commit: async () => {}, abort: async () => {} };
    const staged = takePre ? await stagePrev(takePre.mp4Path, takePre.prevPath) : noStage;
    const stagedComp = takePre
      ? await stagePrev(takePre.compositionPath, takePre.prevCompositionPath)
      : noStage;
    let made: Awaited<ReturnType<typeof makeTake>>;
    try {
      made = await makeTake(plan, {
        outPath: out,
        logProgress: true,
        verbose: has("--verbose"),
        draft: has("--draft"),
        // progressive reveal: the capture exists minutes before the polished
        // mp4 — show the raw footage the moment it lands so the wait is spent
        // watching, not staring at a spinner.
        onCaptureReady: (p) => {
          process.stdout.write(
            `\ncapture landed: ${p}\n  raw footage (unpolished) — the polished render is still cooking\n`,
          );
          if (!has("--no-open")) openPath(p);
        },
        ...(fps || captureScale || profile || headed
          ? {
              capture: {
                ...(fps ? { fps } : {}),
                ...(captureScale ? { captureScale } : {}),
                ...(profile ? { userDataDir: profileDir(profile) } : {}),
                ...(headed ? { headless: false } : {}),
              },
            }
          : {}),
      });
      await staged.commit();
      await stagedComp.commit();
    } catch (e) {
      await staged.abort();
      await stagedComp.abort();
      // The pre-capture gate's refusal is a VERDICT, not a crash: exit 2 like
      // every other deterministic gate, with the machine-readable block the
      // repair loop feeds back — riding the generic error path used to flatten
      // the structured findings into prose and exit 1.
      if (e instanceof PrecheckRefusal) {
        process.stderr.write(`${e.message}\n`);
        const n = e.issues.filter((i) => i.severity === "error").length;
        await emitDefects(
          buildDefectReport({
            verb: "make",
            verdict: `refused before capture: ${n} plan target${n === 1 ? "" : "s"} failed the pre-capture check — nothing was recorded`,
            exitCode: 2,
            plan: planPath,
            defects: [...asDefects("plan-lint", planWarns), ...asDefects("precheck", e.issues)],
          }),
          // dir-existence checked: a refusal on a FIRST make has no take dir
          // (nothing was recorded, so none was created)
          await defectsDirFor(takePre, plan.url, has("--force")),
        );
        process.exit(2);
      }
      throw e;
    }
    const {
      mp4Path,
      compositionPath,
      takeDir,
      capturePath,
      captureLogPath,
      skipped,
      precheck,
      settleWaits,
      paintedFrac,
      warnings,
    } = made;
    const draftNote = has("--draft")
      ? ` (DRAFT quality — \`${INVOKE} render ${mp4Path}\` masters it)`
      : "      ← the one to post";
    // the dossier is the agent's exploration harvest — nudge for it here so
    // the NEXT demo of this app skips cold exploration even when the agent
    // isn't following the skill to the letter.
    const takePost = await resolveTakePaths(mp4Path);
    const { dossierPath } = takePost;
    const dossierLine = (await fsStat(dossierPath).catch(() => null))?.isFile()
      ? `dossier:     ${dossierPath}      ← read this before re-exploring the app\n`
      : `dossier:     ${dossierPath}      ← missing — write the exploration harvest\n` +
        `             (app thesis · hero candidates tried/rejected · selector map ·\n` +
        `             content answers · hazards) so the next demo skips cold exploration\n`;
    process.stdout.write(
      `\nmp4:         ${mp4Path}${draftNote}\n` +
        `working dir: ${takeDir}/      (everything below lives here)\n` +
        `composition: ${compositionPath}\n` +
        `capture:     ${capturePath}\ncapture log: ${captureLogPath}\n` +
        dossierLine +
        `\nrefine by asking your agent for changes — or directly:\n` +
        `  ${INVOKE} frames ${mp4Path}            (beat-aware contact sheet — verify first)\n` +
        `  ${INVOKE} render ${mp4Path} --review   (draft copy with beat badges, auto-opens)\n` +
        `  ${INVOKE} beats  ${mp4Path}            (the numbered beat sheet)\n` +
        `  ${INVOKE} ab     ${mp4Path} --set zoom=light,tight --beat 2   (taste A/B)\n`,
    );
    printWarnings(warnings);
    // Post-shoot gates: line the delivered video up against the engine's own
    // intent. checkTake reads pixels (dead opening / static tail) and the
    // capture log (zoom vs payoff locality); auditCursor re-derives every
    // pointer landing from the compositor's math and template-matches the
    // DRAWN cursor — the check that keeps a mis-drawn cursor from shipping
    // again (a real take once went out 13% off; the audit flags 1%). A
    // cursor-audit error gets ONE bounded re-render + full re-audit before
    // the exit code fires — that defect class is measured transient (see
    // runPostShootGates).
    let postShootErrors = 0;
    let postShootIssues: CompositionIssue[] = [];
    try {
      const captureLogJson = JSON.parse(await readFile(captureLogPath, "utf8")) as CaptureLog;
      // A take already doomed by skipped steps earns no healing minutes: the
      // skipped-steps exit 2 below fires regardless of what a re-render fixes.
      const doomed = healingWithheld(skipped.length, !has("--no-strict"));
      const result = await runPostShootGates({
        checkTake: () =>
          checkTake({
            composition: made.composition,
            captureLog: captureLogJson,
            deliveredMp4: mp4Path,
            captureMp4: capturePath,
          }),
        auditCursor: async () => (await auditCursor(made.composition, mp4Path)).issues,
        ...(doomed
          ? {}
          : {
              reRender: () =>
                reRenderInPlace(
                  takePost,
                  // draft parity: the master on disk was rendered from the
                  // draft transform, so the heal must render the same one
                  has("--draft") ? toDraft(made.composition) : made.composition,
                  captureLogJson,
                ),
            }),
        onFindings: printPostShoot,
        log: (line) => process.stdout.write(`\n${line}\n`),
        warn: (line) => process.stderr.write(`${line}\n`),
      });
      postShootErrors = result.errors;
      postShootIssues = result.issues;
    } catch (e) {
      // the gate must never turn a delivered take into a crash — report and move on
      process.stderr.write(
        `post-shoot checks did not run: ${e instanceof Error ? e.message : e}\n`,
      );
    }
    // Pre-capture target findings (ambiguous selectors, late-bound targets).
    // Errors already refused the capture inside the engine; what prints here
    // is the suspect tier — same summary treatment as composition warnings.
    printPrecheckWarns(precheck);
    // dropped steps reach the SUMMARY (not just an early stderr line buried
    // under render progress) — and, by default, the exit code (below, after
    // the settle measurements have printed and the defects block is out). The
    // engine's own diagnosis outranks any downstream reader: a take with
    // missing beats must not exit 0 just because an mp4 exists.
    if (skipped.length) {
      process.stdout.write(
        `\n⚠ ${skipped.length} step${skipped.length === 1 ? "" : "s"} skipped:\n` +
          skipped
            .map(
              (s) =>
                `  step ${s.step + 1}: ${s.action} ${JSON.stringify(s.target ?? "")} (${s.reason})\n`,
            )
            .join("") +
          `the video is missing ${skipped.length === 1 ? "this beat" : "these beats"} — fix the plan targets and re-make\n`,
      );
    }
    // Beats the PAGE outlasted. The capture already waited, so nothing is
    // broken — but the plan under-budgeted them, and now there is a measured
    // number to write down instead of another guess.
    if (settleWaits.length) {
      // Split by REASON: a beat that settled has a number worth copying, but a
      // beat that spent the whole budget never settled at all — telling its
      // author to raise settleMs to held+waited is a ratchet that can never be
      // satisfied, because the page is not going to go quiet at any number.
      const measured = settleWaits.filter((w) => w.reason === "idle");
      const restless = settleWaits.filter((w) => w.reason !== "idle");
      process.stdout.write(
        `\n⏱ ${settleWaits.length} beat${settleWaits.length === 1 ? "" : "s"} needed longer than planned:\n` +
          settleWaits
            .map(
              (w) =>
                `  step ${w.step + 1}: ${w.action} held ${w.heldMs}ms, page needed ${w.reason === "idle" ? `~${w.heldMs + w.waitedMs}ms` : "longer than the budget"}\n`,
            )
            .join("") +
          (measured.length
            ? `set those steps' settleMs to the measured number and re-make for a tighter, surer take\n`
            : "") +
          (restless.length
            ? `${restless.length === settleWaits.length ? "None" : "Some"} of those ever went quiet — this page is always doing something (a clock, a poll, a looping animation), so no settleMs will satisfy it. Set each beat's settleMs by eye, or pass a capture with settleBudgetMs: 0 to switch the waiting off.\n`
            : ""),
      );
    }
    // A canvas app looks PERFECTLY still to the settle probe no matter what it
    // is drawing, so the absence of ⏱ lines above says nothing there. Say so,
    // or the quiet run reads as proof the timings were right.
    if (paintedFrac != null) {
      process.stdout.write(
        `\n🎨 a <canvas>/<video> covers ~${Math.round(paintedFrac * 100)}% of the frame.\n` +
          `  Whatever is drawn inside one is invisible to the settle check — for beats whose payoff\n` +
          `  is painted there, settleMs is doing the whole job on its own. Budget those by eye and\n` +
          `  confirm with \`${INVOKE} frames ${mp4Path}\` rather than a quiet run.\n`,
      );
    }
    // The verdict. A defective take gets the machine-readable defects block —
    // EVERY finding, warns included, so the repair round sees the late-bound
    // suspects too — and then the strict exits fire in their long-standing
    // order (missing beats outrank pixel findings).
    if (skipped.length || postShootErrors) {
      await emitDefects(
        buildDefectReport({
          verb: "make",
          verdict: verdictLine(postShootErrors, skipped.length),
          exitCode: has("--no-strict") ? 0 : 2,
          plan: planPath,
          master: mp4Path,
          defects: [
            ...asDefects("plan-lint", planWarns),
            ...asDefects("precheck", precheck),
            ...skippedDefects(skipped),
            ...asDefects("post-shoot", postShootIssues),
            ...asDefects("composition", warnings ?? []),
            ...settleDefects(settleWaits),
          ],
        }),
        takeDir,
      );
      if (!has("--no-strict")) {
        if (skipped.length) {
          process.stdout.write(
            `exiting 2: a take with missing beats is not a success (pass --no-strict to downgrade this to a warning)\n`,
          );
          process.exit(2);
        }
        process.stdout.write(
          `exiting 2: ${postShootErrors} post-shoot check error${postShootErrors === 1 ? "" : "s"} — the take is on disk; read the findings above before posting it (pass --no-strict to downgrade to a warning)\n`,
        );
        process.exit(2);
      }
      process.stdout.write(
        `--no-strict: ${verdictLine(postShootErrors, skipped.length)} downgraded to warnings\n`,
      );
    } else {
      await clearDefects(takeDir);
    }
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
        const { mp4Path, warnings } = await renderCompositionFile({
          compositionPath,
          capturePath: video,
          outPath: out,
          ...(flag("--capture-log") ? { captureLogPath: flag("--capture-log") } : {}),
          logProgress: true,
        });
        await staged.commit();
        process.stdout.write(`\nmp4: ${mp4Path}\n`);
        printWarnings(warnings);
        if (has("--open")) openPath(mp4Path);
        if (has("--reveal")) revealPath(mp4Path);
      } catch (e) {
        await staged.abort();
        throw e;
      }
      return;
    }

    const takeArg = positional[0];
    if (!takeArg) throw new Error("render: missing <take> (its .mp4, its .take/ dir, or a dir)");
    const take = await resolveTakePaths(takeArg);

    if (has("--review")) {
      const { reviewPath, sheet, warnings } = await renderReview(take, { logProgress: true });
      process.stdout.write(`\n${sheet}\n\nreview copy: ${reviewPath}\n`);
      printWarnings(warnings);
      if (has("--reveal")) revealPath(reviewPath);
      else if (!has("--no-open")) openPath(reviewPath);
      return;
    }

    if (has("--draft")) {
      const { draftPath, warnings } = await renderDraft(take, { logProgress: true });
      process.stdout.write(`\ndraft: ${draftPath}\n  check it: ${INVOKE} frames ${draftPath}\n`);
      printWarnings(warnings);
      if (has("--reveal")) revealPath(draftPath);
      else if (has("--open")) openPath(draftPath);
      return;
    }

    await requireTakeFiles(take, { capture: true });
    const staged = await stagePrev(take.mp4Path, take.prevPath);
    let warnings: CompositionIssue[];
    let composition: TakeComposition;
    try {
      // keep the composition the render ACTUALLY used — judging a re-read of
      // composition.json would race a concurrent editor save (TOCTOU)
      ({ warnings, composition } = await renderCompositionFile({
        compositionPath: take.compositionPath,
        capturePath: take.capturePath,
        outPath: take.mp4Path,
        logProgress: true,
      }));
      await staged.commit();
    } catch (e) {
      await staged.abort();
      throw e;
    }
    printWarnings(warnings);
    // The render-only path judges its own product with the same post-shoot
    // gates `make` runs, bounded re-render included — this is the very path
    // the transient-misdraw class lives on. A master that skipped the gates
    // just because it came from `render` was the hole a defective take could
    // still ship through. (--review/--draft copies are disposable: ungated.)
    let postShootErrors = 0;
    let postShootIssues: CompositionIssue[] = [];
    const captureLog = await loadCaptureLogSibling(take.capturePath);
    try {
      const result = await runPostShootGates({
        checkTake: () =>
          checkTake({
            composition,
            ...(captureLog ? { captureLog } : {}),
            deliveredMp4: take.mp4Path,
            captureMp4: take.capturePath,
          }),
        auditCursor: async () => (await auditCursor(composition, take.mp4Path)).issues,
        reRender: () => reRenderInPlace(take, composition, captureLog),
        onFindings: printPostShoot,
        log: (line) => process.stdout.write(`\n${line}\n`),
        warn: (line) => process.stderr.write(`${line}\n`),
      });
      postShootErrors = result.errors;
      postShootIssues = result.issues;
    } catch (e) {
      process.stderr.write(
        `post-shoot checks did not run: ${e instanceof Error ? e.message : e}\n`,
      );
    }
    // The capture log's skipped[] stays part of the verdict on every path: a
    // re-render cannot restore beats the shoot never recorded, and `render`
    // exiting 0 on a take `check` refuses would make the two verbs argue.
    const skipped = captureLog?.skipped ?? [];
    if (skipped.length) printSkippedSummary(skipped);
    printPrecheckWarns(captureLog?.precheck ?? []);
    if (postShootErrors || skipped.length) {
      await emitDefects(
        buildDefectReport({
          verb: "render",
          verdict: verdictLine(postShootErrors, skipped.length),
          exitCode: has("--no-strict") ? 0 : 2,
          master: take.mp4Path,
          defects: [
            ...asDefects("precheck", captureLog?.precheck ?? []),
            ...skippedDefects(skipped),
            ...asDefects("post-shoot", postShootIssues),
            ...asDefects("composition", warnings ?? []),
            ...settleDefects(captureLog?.settleWaits ?? []),
          ],
        }),
        take.dir,
      );
      if (!has("--no-strict")) {
        process.stdout.write(
          `exiting 2: ${verdictLine(postShootErrors, skipped.length)} — the master is on disk; read the findings above before posting it (pass --no-strict to downgrade to a warning)\n`,
        );
        process.exit(2);
      }
      process.stdout.write(
        `--no-strict: ${verdictLine(postShootErrors, skipped.length)} downgraded to warnings\n`,
      );
    } else {
      await clearDefects(take.dir);
    }
    process.stdout.write(`\nready: ${await readyLine(take.mp4Path)}\n`);
    if (has("--open")) openPath(take.mp4Path);
    if (has("--reveal")) revealPath(take.mp4Path);
    return;
  }

  if (cmd === "check") {
    // Judge an existing take WITHOUT rendering anything — the standalone gate
    // verb. `make` and `render` already gate their own product; this is for
    // the take that got here some other way (an older CLI, a copied working
    // dir, "is this still postable?"). READ-ONLY by contract: a verb named
    // check must never rewrite the master, so there is no bounded re-render
    // here — when the cursor audit fails, `render` is the healing move.
    const takeArg = positional[0];
    if (!takeArg) throw new Error("check: missing <take> (its .mp4, its .take/ dir, or a dir)");
    const take = await resolveTakePaths(takeArg);
    await requireTakeFiles(take);
    if (!(await fsStat(take.mp4Path).catch(() => null))?.isFile())
      throw new Error(
        `check: no delivered master at ${take.mp4Path} — nothing to judge; \`${INVOKE} render ${takeArg}\` produces one from the composition + kept capture`,
      );
    let composition: TakeComposition;
    try {
      composition = JSON.parse(await readFile(take.compositionPath, "utf8")) as TakeComposition;
    } catch (e) {
      throw new Error(
        `check: ${take.compositionPath} is not readable JSON (${e instanceof Error ? e.message : e})`,
      );
    }
    const captureLog = await loadCaptureLogSibling(take.capturePath);
    const captureOnDisk = (await fsStat(take.capturePath).catch(() => null))?.isFile() ?? false;
    // A corrupt capture.json must not read as "nothing to enforce" — a log
    // that EXISTS but won't parse silently drops the skipped-step verdict, so
    // it refuses the ✓ below instead.
    const logOnDisk = (await fsStat(take.captureLogPath).catch(() => null))?.isFile() ?? false;
    const logCorrupt = !captureLog && logOnDisk;
    if (logCorrupt)
      process.stderr.write(
        `capture log ${take.captureLogPath} exists but did not parse — its skipped-step and coverage verdicts cannot run\n`,
      );
    else if (!captureLog)
      process.stdout.write(
        `note: no capture log at ${take.captureLogPath} — the coverage checks and the skipped-step re-print have nothing to read; the pixel gates still run\n`,
      );
    let cursorErrors = 0;
    const result = await runPostShootGates({
      checkTake: () =>
        checkTake({
          composition,
          ...(captureLog ? { captureLog } : {}),
          deliveredMp4: take.mp4Path,
          ...(captureOnDisk ? { captureMp4: take.capturePath } : {}),
        }),
      auditCursor: async () => {
        const { issues } = await auditCursor(composition, take.mp4Path);
        cursorErrors = issues.filter((i) => i.severity === "error").length;
        return issues;
      },
      onFindings: printPostShoot,
      log: (line) => process.stdout.write(`\n${line}\n`),
      warn: (line) => process.stderr.write(`${line}\n`),
    });
    // The capture log's skipped[] is part of the postability verdict: a take
    // with missing beats stays defective no matter how clean its pixels are.
    const skipped = captureLog?.skipped ?? [];
    if (skipped.length) printSkippedSummary(skipped);
    printPrecheckWarns(captureLog?.precheck ?? []);
    if (cursorErrors > 0 && captureOnDisk)
      process.stdout.write(
        `\na failed cursor audit can be a transient renderer misdraw — \`${INVOKE} render ${take.mp4Path}\` re-renders from the frozen capture and re-audits; a repeat failure means the renderer disagrees with its own math\n`,
      );
    // check is the interrogation verb, so its report is not gated on exit 2:
    // ANY finding — the warn-only tier included — emits the machine-readable
    // block. That is what lets a repair round close the warns (late-bound
    // poison never refuses; this report is the only stable place it surfaces
    // after the shoot).
    const checkDefects: Defect[] = [
      ...asDefects("precheck", captureLog?.precheck ?? []),
      ...skippedDefects(skipped),
      ...asDefects("post-shoot", result.issues),
      ...settleDefects(captureLog?.settleWaits ?? []),
    ];
    if (result.errors || skipped.length) {
      const verdict = verdictLine(result.errors, skipped.length);
      await emitDefects(
        buildDefectReport({
          verb: "check",
          verdict,
          exitCode: has("--no-strict") ? 0 : 2,
          master: take.mp4Path,
          defects: checkDefects,
        }),
        take.dir,
      );
      if (!has("--no-strict")) {
        process.stdout.write(
          `exiting 2: ${verdict} — this take is not postable as-is (pass --no-strict to downgrade to a warning)\n`,
        );
        process.exit(2);
      }
      process.stdout.write(`--no-strict: ${verdict} downgraded to warnings\n`);
      return;
    }
    // check's whole product is the verdict — "no errors found" from a run
    // where a gate never measured anything is not a clean bill.
    const unjudged = [
      ...result.crashed,
      ...(logCorrupt ? ["the capture-log verdicts (file exists but did not parse)"] : []),
    ];
    if (unjudged.length) {
      process.stdout.write(
        `exiting 1: could not judge this take — ${unjudged.join(" + ")} did not run; no error was FOUND, but nothing here says the take is clean\n`,
      );
      process.exit(1);
    }
    if (checkDefects.length) {
      await emitDefects(
        buildDefectReport({
          verb: "check",
          verdict: `0 post-shoot check errors, ${checkDefects.length} warning${checkDefects.length === 1 ? "" : "s"} — postable; address each warn or say why it stays`,
          exitCode: 0,
          master: take.mp4Path,
          defects: checkDefects,
        }),
        take.dir,
      );
    } else {
      await clearDefects(take.dir);
    }
    process.stdout.write(`\n✓ no post-shoot errors: ${await readyLine(take.mp4Path)}\n`);
    return;
  }

  if (cmd === "frames") {
    const takeArg = positional[0];
    if (!takeArg) throw new Error("frames: missing <take>");
    const take = await resolveTakePaths(takeArg);
    const beatFlag = flag("--beat");
    const beat = beatFlag ? Number(beatFlag) : undefined;
    if (beatFlag && (!Number.isInteger(beat) || beat! < 1))
      throw new Error(`frames: --beat expects a 1-based beat number (got "${beatFlag}")`);
    // naming a disposable copy samples that copy; anything else = the master.
    const named = basename(takeArg).toLowerCase();
    const sourcePath =
      named === "draft.mp4" ? take.draftPath : named === "review.mp4" ? take.reviewPath : undefined;
    const tileFlag = flag("--tile");
    const { framesPath, sheet } = await renderFrames(take, {
      ...(beat != null ? { beat } : {}),
      ...(sourcePath ? { sourcePath } : {}),
      ...(tileFlag ? { tileWidth: Number(tileFlag) } : {}),
    });
    process.stdout.write(`${sheet}\n`);
    if (has("--open")) openPath(framesPath);
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
    if (positional[0] === "install") await runInit();
    else process.stdout.write(await bundledSkill());
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
    // Tell whoever started this how the notes come back out: the editor is a
    // one-way door otherwise (the user types a note and nothing reads it).
    process.stdout.write(
      `\nAgent-panel notes append to ${take.notesPath}\n` +
        `  ${INVOKE} notes ${takePath} --wait   # blocks in another shell, exits on the next note\n`,
    );
    await new Promise(() => {}); // keep alive until Ctrl-C
    return;
  }

  if (cmd === "notes") {
    const quiet = has("--quiet");
    // No <take> = "the take in this directory", so a hook can run this from a
    // project root without knowing the name. A directory with no take is not
    // an error in --quiet mode: hooks fire everywhere, notes exist in one place.
    let take: Awaited<ReturnType<typeof resolveTakePaths>>;
    try {
      take = await resolveTakePaths(positional[0] ?? process.cwd());
    } catch (e) {
      if (quiet) return;
      throw e;
    }
    const wait = has("--wait");
    const timeoutFlag = flag("--timeout");
    const timeoutS = timeoutFlag ? Number(timeoutFlag) : undefined;
    if (timeoutFlag != null && (!Number.isFinite(timeoutS) || timeoutS! <= 0))
      throw new Error(`notes: --timeout expects seconds (got "${timeoutFlag}")`);
    const opts = { all: has("--all") };

    if (!wait) {
      const res = await readNotes(take, opts);
      if (res.notes.length || !quiet) process.stdout.write(formatNotes(take, res));
      return;
    }
    // The wake-up: this process EXITS when a note lands, which is the signal
    // every agent harness already understands. Announce first so a user (or an
    // agent tailing the background job) can see it is armed.
    process.stderr.write(
      `watching ${take.notesPath} for editor notes — exits on the first one ` +
        `(timeout ${fmtDuration(timeoutS ?? 1800)})\n`,
    );
    const res = await waitForNotes(take, {
      ...opts,
      ...(timeoutS != null ? { timeoutMs: timeoutS * 1000 } : {}),
    });
    if (res.notes.length || !quiet) process.stdout.write(formatNotes(take, res, { waited: true }));
    return;
  }

  process.stderr.write(USAGE);
  process.exit(cmd ? 1 : 0);
}

main().catch((e) => {
  process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});
