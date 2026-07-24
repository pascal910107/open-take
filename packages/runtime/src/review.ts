// The conversational refine surface: beat sheets, badged review copies, and
// A/B variant reels. No GUI — the system video player shows purpose-built
// artifacts and the terminal (agent) is the only input channel.
//
//   beats   — a numbered stdout table: the shared map for "beat 3: no zoom"
//   review  — `<base>.review.mp4`: fast draft with beat badges burned in
//             (the video itself teaches the referring vocabulary) + watermark
//   ab      — `<base>.ab.mp4`: ONE knob, 2-4 labeled variants, each played
//             twice — a taste question answered with one letter
//
// Badges/labels are drawn by the revideo scene in Chrome (composition.review),
// NOT by ffmpeg drawtext — slim ffmpeg builds ship without font filters.

import { spawn } from "node:child_process";
import { readFile, rm, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
  type CaptureLog,
  type CompEvent,
  FINISH,
  type FinishName,
  LOOKS,
  type LookName,
  MOTION,
  type MotionName,
  type ReviewBadge,
  type TakeComposition,
  ZOOM_LEVELS,
  type ZoomLevelName,
  finishName,
  formatIssues,
  lookName,
  motionName,
  renderTake,
  resolveFfmpeg,
  validateComposition,
  zoomLevelName,
} from "@open-take/compositor";
import { ensureChrome } from "./cdp";
import { type TakePaths, requireTakeFiles } from "./take";

/** Sibling capture log (`<capture>.json`), if present — enables the
 *  capture-lock check; silently absent otherwise (matches index.ts). */
async function loadLogSibling(capturePath: string): Promise<CaptureLog | undefined> {
  try {
    return JSON.parse(
      await readFile(resolve(capturePath).replace(/\.mp4$/i, ".json"), "utf8"),
    ) as CaptureLog;
  } catch {
    return undefined;
  }
}

// --- shared formatting -------------------------------------------------------

const KIND_LABEL: Record<CompEvent["kind"], string> = {
  click: "click",
  type: "type",
  drag: "drag",
  scroll: "scroll",
  hover: "hover",
  press: "key",
};

function beatTitle(e: CompEvent): string {
  if (e.label) return e.label;
  if (e.kind === "type" && e.text) return `"${e.text}"`;
  if (e.kind === "press" && e.keys) return e.keys;
  return e.kind;
}

const trunc = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

function fmtTime(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** "zoom medium (×1.5)" | "zoom ×1.85 (custom)" | "wide" */
function zoomText(e: CompEvent): string {
  if (!e.zoom.enabled) return "wide";
  const name = zoomLevelName(e.zoom.scale);
  const x = `×${Number(e.zoom.scale.toFixed(2))}`;
  return name ? `zoom ${name} (${x})` : `zoom ${x} (custom)`;
}

// --- the beat sheet ----------------------------------------------------------

export function buildBeatSheet(comp: TakeComposition, name: string): string {
  const n = comp.events.length;
  const look = lookName(comp.framing) ?? "custom";
  const pace = motionName(comp.cursor) ?? "custom";
  const finish = finishName(comp.motionBlur) ?? "custom";
  const lines: string[] = [
    `${name} · ${(comp.durationMs / 1000).toFixed(1)}s · ${n} beat${n === 1 ? "" : "s"} · look ${look} · pace ${pace} · finish ${finish}`,
  ];
  const first = comp.events[0];
  if (!first || first.zoom.inAtMs > 400) lines.push(`  in   0:00  full view, cursor glides in`);
  comp.events.forEach((e, i) => {
    const num = String(i + 1).padStart(2, " ");
    const kind = KIND_LABEL[e.kind].padEnd(6, " ");
    const title = trunc(beatTitle(e), 24).padEnd(25, " ");
    lines.push(`  ${num}   ${fmtTime(e.tMs)}  ${kind} ${title} ${zoomText(e)}`);
  });
  const last = comp.events[n - 1];
  if (last) {
    const endMs = last.tMs + (last.durationMs ?? 0) + comp.cursor.holdMs;
    lines.push(`  out  ${fmtTime(endMs)}  zoom releases, holds to ${fmtTime(comp.durationMs)}`);
  }
  lines.push(
    `say it like: "beat 2: no zoom" · "tighter on beat 3" · "look: slate" · "pace: brisk"`,
  );
  return lines.join("\n");
}

export const SAY_IT_CARD = `SAY IT, I'LL CUT IT
 instant (~10s)  zoom off / tighter / looser on a beat · re-center a beat (name the
                 element) · hold longer · pace: calm / natural / brisk · look:
                 midnight / ink / slate / ocean / plum / ember / paper / plain ·
                 finish: smooth / crisp / heavy · quicker intro · shorter tail
 re-shoot (~1m)  change what's clicked or typed · add / cut / reorder beats ·
                 retime an action
 compare         taste questions come back as an A/B reel — answer with a letter
                 ("B"), or "between A and B", or "none, go darker"`;

// --- review copy -------------------------------------------------------------

/** Badge windows: each beat owns [its zoom.inAtMs, the next beat's) — the pill
 *  swaps as the camera starts moving toward the beat. INTRO/TAIL bracket them. */
export function buildBadges(comp: TakeComposition): ReviewBadge[] {
  const n = comp.events.length;
  const badges: ReviewBadge[] = [];
  let prevStart = 0;
  const starts = comp.events.map((e) => {
    const s = Math.max(e.zoom.inAtMs, prevStart + 1);
    prevStart = s;
    return s;
  });
  if (n === 0 || starts[0]! > 400)
    badges.push({ fromMs: 0, toMs: starts[0] ?? comp.durationMs, text: "INTRO" });
  comp.events.forEach((e, i) => {
    const last = i === n - 1;
    const endOwn = e.tMs + (e.durationMs ?? 0) + comp.cursor.holdMs;
    const to = last ? Math.min(endOwn, comp.durationMs) : starts[i + 1]!;
    badges.push({
      fromMs: starts[i]!,
      toMs: to,
      text: `BEAT ${i + 1}/${n} · ${KIND_LABEL[e.kind]} ${trunc(beatTitle(e), 24)} · ${zoomText(e)}`,
    });
    if (last && to < comp.durationMs + 1000)
      badges.push({ fromMs: to, toMs: comp.durationMs + 1500, text: "TAIL" });
  });
  return badges;
}

/** Draft-quality transform: 30fps cap + motion blur OFF — up to ~12× faster
 *  than a blurred 60fps master, close enough for composition-level notes.
 *  (2 blur samples would render 2× the frames for a tmix window that rounds to
 *  1 — all cost, zero blur.) FEEL questions (blur, pace, zoom silkiness) must
 *  be judged on full quality — use `ab`. */
function toDraft(comp: TakeComposition): TakeComposition {
  const { motionBlur: _mb, ...rest } = comp;
  return { ...rest, output: { ...comp.output, fps: Math.min(30, comp.output.fps) } };
}

export type ReviewOpts = {
  chromePath?: string;
  logProgress?: boolean;
};

export async function renderReview(
  take: TakePaths,
  opts: ReviewOpts = {},
): Promise<{ reviewPath: string; sheet: string }> {
  await requireTakeFiles(take, { capture: true });
  const comp = JSON.parse(await readFile(take.compositionPath, "utf8")) as TakeComposition;
  const captureLog = await loadLogSibling(take.capturePath);
  const chromePath = await ensureChrome(opts.chromePath);
  const decorated: TakeComposition = {
    ...toDraft(comp),
    review: { watermark: "REVIEW", badges: buildBadges(comp) },
  };
  await renderTake({
    composition: decorated,
    videoPath: take.capturePath,
    outPath: take.reviewPath,
    captureLog,
    logProgress: opts.logProgress ?? true,
    chromePath,
    writeCompositionSibling: false,
  });
  return { reviewPath: take.reviewPath, sheet: buildBeatSheet(comp, take.name) };
}

// --- A/B variant reels -------------------------------------------------------

export type AbKnob =
  | { kind: "zoom"; beat: number } // 1-based beat number
  | { kind: "look" }
  | { kind: "pace" }
  | { kind: "finish" }
  | { kind: "path"; path: string }; // raw dot-path escape hatch (agent use)

export type AbVariant = { letter: string; desc: string; comp: TakeComposition };

export function parseSetFlag(set: string, beat?: number): { knob: AbKnob; values: string[] } {
  const eq = set.indexOf("=");
  if (eq < 1) throw new Error(`ab: --set expects <knob>=<v1>,<v2>[,<v3>] (got "${set}")`);
  const key = set.slice(0, eq).trim();
  const values = set
    .slice(eq + 1)
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);
  if (values.length < 1) throw new Error(`ab: --set ${key}= needs at least one value`);
  if (values.length > 3) throw new Error(`ab: at most 3 requested values (plus current) per reel`);
  if (key === "zoom") {
    if (!beat) throw new Error(`ab: --set zoom=… needs --beat <n> (which beat to reframe)`);
    return { knob: { kind: "zoom", beat }, values };
  }
  if (key === "look" || key === "pace" || key === "finish") return { knob: { kind: key }, values };
  if (key.includes(".")) return { knob: { kind: "path", path: key }, values };
  throw new Error(
    `ab: unknown knob "${key}" — use zoom (with --beat), look, pace, finish, or a raw dot-path like cursor.holdMs`,
  );
}

function setPath(comp: TakeComposition, path: string, raw: string): TakeComposition {
  // coerce booleans/null BEFORE the number check — a string "false" is truthy,
  // which would silently leave e.g. zoom.enabled ON while the variant label
  // claims otherwise (a reel comparing two identical clips).
  const t = raw.trim();
  const value: unknown =
    t === "true"
      ? true
      : t === "false"
        ? false
        : t === "null"
          ? null
          : Number.isFinite(Number(raw)) && t !== ""
            ? Number(raw)
            : raw;
  const parts = path.split(".");
  const next = structuredClone(comp) as unknown as Record<string, unknown>;
  let node: Record<string, unknown> = next;
  for (const p of parts.slice(0, -1)) {
    const child = node[p];
    if (typeof child !== "object" || child == null)
      throw new Error(`ab: path "${path}" — "${p}" is not an object`);
    node = child as Record<string, unknown>;
  }
  node[parts[parts.length - 1]!] = value;
  return next as unknown as TakeComposition;
}

/** Current-state description for a knob (the implicit "keep it" variant). */
function currentDesc(comp: TakeComposition, knob: AbKnob): string {
  if (knob.kind === "zoom") {
    const e = comp.events[knob.beat - 1];
    return e ? zoomText(e) : "?";
  }
  if (knob.kind === "look") return lookName(comp.framing) ?? "custom look";
  if (knob.kind === "pace") return motionName(comp.cursor) ?? "custom pace";
  if (knob.kind === "finish") return finishName(comp.motionBlur) ?? "custom finish";
  const parts = knob.path.split(".");
  let node: unknown = comp;
  for (const p of parts) node = (node as Record<string, unknown> | undefined)?.[p];
  return `${knob.path}=${JSON.stringify(node)}`;
}

function applyKnob(comp: TakeComposition, knob: AbKnob, value: string): TakeComposition {
  if (knob.kind === "zoom") {
    const i = knob.beat - 1;
    const e = comp.events[i];
    if (!e) throw new Error(`ab: --beat ${knob.beat} out of range (1-${comp.events.length})`);
    const events = comp.events.slice();
    if (value === "off" || value === "wide") {
      events[i] = { ...e, zoom: { ...e.zoom, enabled: false } };
    } else {
      const scale = value in ZOOM_LEVELS ? ZOOM_LEVELS[value as ZoomLevelName] : Number(value);
      if (!Number.isFinite(scale))
        throw new Error(`ab: zoom value "${value}" — use off/light/medium/tight/close or a number`);
      events[i] = { ...e, zoom: { ...e.zoom, enabled: true, scale } };
    }
    return { ...comp, events };
  }
  if (knob.kind === "look") {
    const look = LOOKS[value as LookName];
    if (!look)
      throw new Error(`ab: unknown look "${value}" — one of ${Object.keys(LOOKS).join("/")}`);
    return { ...comp, framing: { ...comp.framing, ...structuredClone(look) } };
  }
  if (knob.kind === "pace") {
    const pace = MOTION[value as MotionName];
    if (!pace)
      throw new Error(`ab: unknown pace "${value}" — one of ${Object.keys(MOTION).join("/")}`);
    // zoomInMs only affects rendering through each beat's zoom.inAtMs (derived
    // at plan time as tMs − zoomInMs). Rebase events still sitting on the OLD
    // derivation so the new pace actually changes the zoom ramps; hand-tuned
    // inAtMs values are left alone.
    const oldZoomInMs = comp.cursor.zoomInMs;
    const events = comp.events.map((e) =>
      e.zoom.inAtMs === Math.max(0, e.tMs - oldZoomInMs)
        ? { ...e, zoom: { ...e.zoom, inAtMs: Math.max(0, e.tMs - pace.zoomInMs) } }
        : e,
    );
    return { ...comp, events, cursor: { ...comp.cursor, ...pace } };
  }
  if (knob.kind === "finish") {
    if (!(value in FINISH))
      throw new Error(`ab: unknown finish "${value}" — one of ${Object.keys(FINISH).join("/")}`);
    const mb = FINISH[value as FinishName];
    const { motionBlur: _mb, ...rest } = comp;
    return mb ? { ...rest, motionBlur: { ...mb } } : rest;
  }
  return setPath(comp, knob.path, value);
}

function variantDesc(knob: AbKnob, value: string, comp: TakeComposition): string {
  if (knob.kind === "zoom") {
    const e = comp.events[knob.beat - 1];
    return e ? zoomText(e) : value;
  }
  if (knob.kind === "path") return `${knob.path}=${value}`;
  return value;
}

/** The reel's time window (ms): a beat's zoom arc with lead-in/out padding, so
 *  a taste question costs a ~4s render per variant, not the whole take. The
 *  window is the UNION across all variant compositions — a variant with a
 *  longer hold/zoom-out (or a rebased inAtMs) must not be cut mid-settle, since
 *  the settle is exactly what the reel exists to judge. */
export function abWindow(
  comps: TakeComposition[],
  beat: number | undefined,
  full: boolean,
): [number, number] | undefined {
  if (full) return undefined;
  const base = comps[0];
  if (!base || base.events.length === 0) return undefined;
  if (beat != null && (beat < 1 || beat > base.events.length))
    throw new Error(`ab: --beat ${beat} out of range (1-${base.events.length})`);
  let i = beat != null ? beat - 1 : base.events.findIndex((e) => e.zoom.enabled);
  if (i < 0) i = 0;
  let from = Number.POSITIVE_INFINITY;
  let to = 0;
  for (const c of comps) {
    const e = c.events[i];
    if (!e) continue;
    // A PULL-OUT beat's camera ramp can start up to zoomOutMs before its tMs
    // (math.ts pull-out pacing — earlier than the stored inAtMs); open the
    // window on whichever is earlier so the clip keeps a static lead-in.
    const rampFrom = Math.min(e.zoom.inAtMs, e.tMs - c.cursor.zoomOutMs);
    from = Math.min(from, Math.max(0, rampFrom - 1200));
    const next = c.events[i + 1];
    const ownEnd = e.tMs + (e.durationMs ?? 0) + c.cursor.holdMs + c.cursor.zoomOutMs;
    // no durationMs clamp: the scene runs to its last keyframe + tail, and a
    // range end past the scene's end just stops at the end.
    to = Math.max(to, (next ? next.zoom.inAtMs : ownEnd) + 400);
  }
  if (!Number.isFinite(from)) return undefined;
  return [from, Math.max(to, from + 1500)];
}

export type AbOpts = {
  set: string;
  beat?: number;
  full?: boolean;
  draft?: boolean;
  chromePath?: string;
  logProgress?: boolean;
};

const LETTERS = ["A", "B", "C", "D"];

export async function renderAbReel(
  take: TakePaths,
  opts: AbOpts,
): Promise<{ abPath: string; legend: string }> {
  await requireTakeFiles(take, { capture: true });
  const comp = JSON.parse(await readFile(take.compositionPath, "utf8")) as TakeComposition;
  const captureLog = await loadLogSibling(take.capturePath);
  const chromePath = await ensureChrome(opts.chromePath);
  const { knob, values } = parseSetFlag(opts.set, opts.beat);

  // variants: the CURRENT state first (so "A" always means "keep it"), then the
  // requested values — skipping a request that just re-states the current state.
  const cur = currentDesc(comp, knob);
  const variants: AbVariant[] = [{ letter: "A", desc: `current (${cur})`, comp }];
  for (const v of values) {
    const applied = applyKnob(comp, knob, v);
    const desc = variantDesc(knob, v, applied);
    if (desc === cur || variants.some((x) => x.desc === desc)) continue;
    variants.push({ letter: LETTERS[variants.length]!, desc, comp: applied });
  }
  if (variants.length < 2)
    throw new Error(`ab: every requested value matches the current state — nothing to compare`);

  // validate EVERY variant up front (milliseconds) — one bad value must not
  // waste the minutes already spent rendering the variants before it.
  for (const v of variants) {
    const issues = validateComposition(v.comp, captureLog ? { captureLog } : {});
    const errors = issues.filter((i) => i.severity === "error");
    if (errors.length)
      throw new Error(`ab: variant ${v.letter} (${v.desc}) is invalid:\n${formatIssues(errors)}`);
  }

  const windowMs = abWindow(
    variants.map((v) => v.comp),
    opts.beat,
    opts.full ?? false,
  );
  const rangeSec = windowMs
    ? ([windowMs[0] / 1000, windowMs[1] / 1000] as [number, number])
    : undefined;

  // FEEL knobs are judged at FULL quality (blur by eye); --draft opts down.
  const clips: string[] = [];
  try {
    for (const v of variants) {
      const base = opts.draft ? toDraft(v.comp) : v.comp;
      const decorated: TakeComposition = {
        ...base,
        review: { label: `${v.letter} · ${v.desc}` },
      };
      const clip = `${take.base}.ab.${v.letter}.mp4`;
      if (opts.logProgress !== false)
        process.stderr.write(
          `variant ${v.letter} · ${v.desc}${rangeSec ? ` · window ${rangeSec[0].toFixed(1)}–${rangeSec[1].toFixed(1)}s` : ""}\n`,
        );
      await renderTake({
        composition: decorated,
        videoPath: take.capturePath,
        outPath: clip,
        captureLog,
        logProgress: opts.logProgress ?? true,
        chromePath,
        rangeSec,
        writeCompositionSibling: false,
      });
      clips.push(clip);
    }

    // reel = A B C A B C with short black gaps; each variant seen twice so the
    // eye can confirm on the second pass.
    await concatWithGaps([...clips, ...clips], take.abPath, {
      width: comp.output.width,
      height: comp.output.height,
      fps: opts.draft ? Math.min(30, comp.output.fps) : comp.output.fps,
    });
  } finally {
    await Promise.all(clips.map((c) => rm(c, { force: true })));
  }

  const legend = [
    `A/B reel: ${take.abPath}  (${knobLabel(knob)})`,
    ...variants.map((v) => `  ${v.letter}  ${v.desc}`),
    `answer with a letter — or "between A and B" / "none, try …"`,
  ].join("\n");
  return { abPath: take.abPath, legend };
}

function knobLabel(knob: AbKnob): string {
  if (knob.kind === "zoom") return `beat ${knob.beat} · zoom`;
  if (knob.kind === "path") return knob.path;
  return knob.kind;
}

/** before/after reel from the existing prev + current masters — no render at
 *  all, pure ffmpeg trims. Order convention: BEFORE then AFTER, twice. */
export async function renderBeforeAfter(
  take: TakePaths,
  opts: { beat?: number; full?: boolean } = {},
): Promise<{ abPath: string; legend: string }> {
  await requireTakeFiles(take);
  if (!(await stat(take.prevPath).catch(() => null)))
    throw new Error(`ab --before-after: no ${take.prevPath} yet (it appears after a re-render)`);
  const comp = JSON.parse(await readFile(take.compositionPath, "utf8")) as TakeComposition;
  const win = abWindow([comp], opts.beat, opts.full ?? false);
  const cut = async (src: string, out: string) => {
    const args = ["-y", "-loglevel", "error", "-i", src];
    if (win) args.push("-ss", String(win[0] / 1000), "-t", String((win[1] - win[0]) / 1000));
    args.push("-c:v", "libx264", "-crf", "18", "-pix_fmt", "yuv420p", "-an", out);
    await ffmpeg(args);
  };
  const before = `${take.base}.ab.before.mp4`;
  const after = `${take.base}.ab.after.mp4`;
  await cut(take.prevPath, before);
  await cut(take.mp4Path, after);
  await concatWithGaps([before, after, before, after], take.abPath, {
    width: comp.output.width,
    height: comp.output.height,
    fps: comp.output.fps,
  });
  await Promise.all([rm(before, { force: true }), rm(after, { force: true })]);
  const legend = [
    `before/after reel: ${take.abPath}`,
    `  plays BEFORE then AFTER, twice — say "keep the old one" to revert`,
  ].join("\n");
  return { abPath: take.abPath, legend };
}

// --- ffmpeg helpers ----------------------------------------------------------

async function ffmpeg(args: string[]): Promise<void> {
  const bin = await resolveFfmpeg();
  return new Promise((res, rej) => {
    const c = spawn(bin, args, { stdio: ["ignore", "ignore", "pipe"] });
    let err = "";
    c.stderr.on("data", (d) => {
      err += d;
    });
    c.on("error", rej);
    c.on("close", (code) => (code === 0 ? res() : rej(new Error(`ffmpeg exited ${code}: ${err}`))));
  });
}

/** Concat clips with a 0.35s black gap between each, re-encoding via the concat
 *  FILTER (robust to per-clip encoder variance; everything shares WxH/fps). The
 *  gap comes from a lavfi color source — no font/text filters needed. */
async function concatWithGaps(
  clips: string[],
  outPath: string,
  v: { width: number; height: number; fps: number },
): Promise<void> {
  const args = ["-y", "-loglevel", "error"];
  for (const c of clips) args.push("-i", resolve(c));
  args.push("-f", "lavfi", "-t", "0.35", "-i", `color=c=black:s=${v.width}x${v.height}:r=${v.fps}`);
  const gapIdx = clips.length;
  // A gap after every clip except the last: [0][gap][1][gap]…[n-1]
  const seq: string[] = [];
  const gapUses = clips.length - 1;
  const split =
    gapUses > 1
      ? `[${gapIdx}:v]split=${gapUses}${Array.from({ length: gapUses }, (_, i) => `[g${i}]`).join("")};`
      : "";
  clips.forEach((_, i) => {
    seq.push(`[${i}:v]`);
    if (i < clips.length - 1) seq.push(gapUses > 1 ? `[g${i}]` : `[${gapIdx}:v]`);
  });
  const filter = `${split}${seq.join("")}concat=n=${seq.length}:v=1:a=0[v]`;
  args.push(
    "-filter_complex",
    filter,
    "-map",
    "[v]",
    "-c:v",
    "libx264",
    "-crf",
    "18",
    "-pix_fmt",
    "yuv420p",
    "-r",
    String(v.fps),
    "-an",
    resolve(outPath),
  );
  await ffmpeg(args);
}

// --- open / reveal -----------------------------------------------------------

/** Spawn a fire-and-forget opener. spawn ENOENT arrives ASYNCHRONOUSLY on the
 *  child's "error" event (a try/catch around spawn never sees it and the
 *  process would die with an unhandled error) — so degrade via the listener.
 *
 *  `windowsVerbatimArguments` hands argv to Windows unmodified: cmd.exe and explorer.exe
 *  re-parse the raw command line by rules node's own quoting doesn't match, so
 *  the command builders below quote for them (see winQuote). */
export type OpenerCommand = {
  command: string;
  args: string[];
  windowsVerbatimArguments: boolean;
};

function spawnOpener(spec: OpenerCommand, fallbackLine: string): void {
  try {
    const c = spawn(spec.command, spec.args, {
      stdio: "ignore",
      detached: true,
      windowsVerbatimArguments: spec.windowsVerbatimArguments,
    });
    c.on("error", () => process.stdout.write(fallbackLine));
    c.unref();
  } catch {
    process.stdout.write(fallbackLine);
  }
}

/** Wrap a path/URL for a verbatim Windows command line. Safe unquoted-inside:
 *  `"` is illegal in Windows filenames, and cmd stops treating `&` `^` `|` as
 *  metacharacters once quoted. */
const winQuote = (s: string) => `"${s}"`;

/** Pure command specs keep platform quoting independently testable on every
 *  CI runner, including the Windows-only `start` title argument rule. */
export function getOpenCommand(
  target: string,
  platform: NodeJS.Platform = process.platform,
): OpenerCommand {
  if (platform === "darwin") {
    return { command: "open", args: [target], windowsVerbatimArguments: false };
  }
  if (platform === "win32") {
    return {
      command: "cmd",
      args: ["/c", "start", '""', winQuote(target)],
      windowsVerbatimArguments: true,
    };
  }
  return { command: "xdg-open", args: [target], windowsVerbatimArguments: false };
}

export function getRevealCommand(
  absolutePath: string,
  platform: NodeJS.Platform = process.platform,
): OpenerCommand {
  if (platform === "darwin") {
    return { command: "open", args: ["-R", absolutePath], windowsVerbatimArguments: false };
  }
  if (platform === "win32") {
    return {
      command: "explorer",
      // explorer takes ONE argument: `/select,` glued to a quoted path.
      args: [`/select,${winQuote(absolutePath)}`],
      windowsVerbatimArguments: true,
    };
  }
  return {
    command: "xdg-open",
    args: [dirname(absolutePath)],
    windowsVerbatimArguments: false,
  };
}

/** Open a file with the OS default player; degrade to printing the path. */
export function openPath(p: string): void {
  const abs = resolve(p);
  openWithOs(abs, `open: ${abs}\n`);
}

/** Hand a path or URL to the OS default handler. Windows needs `cmd /c start`
 *  with an EMPTY first argument: `start` reads a lone quoted argument as the
 *  window TITLE, so `start "<file>"` opens a blank console instead of the file. */
export function openWithOs(target: string, fallbackLine: string): void {
  spawnOpener(getOpenCommand(target), fallbackLine);
}

/** Reveal a file in Finder/Explorer; degrade to printing the path. */
export function revealPath(p: string): void {
  const abs = resolve(p);
  spawnOpener(getRevealCommand(abs), `at: ${abs}\n`);
}
