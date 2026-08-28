// checkTake — the POST-SHOOT deterministic defect report. validateComposition
// (compositor) judges the composition JSON before a render; this judges the
// SHOOT after one: the engine knows its own intent (composition + capture
// log), so it can line intent up against the recorded pixels and name what
// went wrong — zero tokens, no VLM guessing. Fed back to a planning model the
// report repairs most plan defects (measured across 3 open models: zoom
// misuse ~100% repaired, dead openings and stale tails mostly repaired).
//
// Failure-tolerant BY CONTRACT (same as frame-diff.ts): a diagnostics pass
// must never fail a take. Each pixel check silently skips when its video is
// absent or unreadable; the structural checks are pure.

import { spawn } from "node:child_process";
import type { CaptureLog, CompositionIssue, TakeComposition } from "@open-take/compositor";
import { resolveFfmpeg, resolveFfprobe } from "@open-take/compositor";

/** dead-opening: a capture frame whose grayscale std reaches this share of the
 *  take's OWN steady-state baseline counts as painted. Relative, never
 *  absolute — absolute std varies wildly across apps/themes, while the
 *  measured planes separate 17×: blank capture frames sit at std ≈2.6 vs
 *  ≈44–51 once painted. 0.55 sits mid-band of that separation — a threshold
 *  near either edge misreads progressive paint (content up, hero image still
 *  loading measures ≈0.7–0.9× the settled baseline) as still-blank. This is
 *  the calibration that produced the validated defect reports (800ms/300ms
 *  heads found, zero false positives across four real takes). */
const SETTLE_STD_FRAC = 0.55;
/** a blank head under this is a normal first-paint, not a defect */
const DEAD_OPENING_MIN_MS = 100;
/** opening probe: sample the capture's first 2s on a 50ms grid */
const OPENING_PROBE_MS = 2000;
const OPENING_STEP_MS = 50;
/** steady-state baseline = median std of ~6 frames across 30%–90% of the take */
const BASELINE_SAMPLES = 6;
const BASELINE_SPAN: [number, number] = [0.3, 0.9];
/** static-tail: frames at (dur−3.0s) and (dur−0.2s) with a mean absolute
 *  pixel diff under this ⇒ the delivered video ends frozen (a live tail's
 *  encode noise alone measures well above 1). */
const TAIL_SPAN_S = 3.0;
const TAIL_LAST_S = 0.2;
const TAIL_FROZEN_DIFF = 1.0;
/** zoom-on-global-payoff: a zoomed beat whose capture-measured changeCoverage
 *  exceeds this repaints most of the frame — punching in crops the very payoff
 *  the beat exists to show. Calibration: 0.10 gave 0 false positives on the
 *  golden take (its max zoomed coverage was 0.054) and 3 true flags on the
 *  worst take. The engine's own DEFAULT_CAMERA.pullOutCoverage (0.55) is the
 *  "must pull out" red line; this is deliberately tighter because
 *  zoom:"always" overrides the auto-director — nothing else stands between
 *  the plan and the crop. */
const ZOOMED_COVERAGE_MAX = 0.1;
/** canvas/video apps are diff-blind: a paint surface repaints regardless of
 *  the beat, so changeCoverage stops meaning "this beat's payoff" (see
 *  CaptureLog.paintedFrac in @open-take/compositor's types). Past this
 *  painted share, both coverage-based checks stand down entirely. */
const DIFF_BLIND_PAINTED_FRAC = 0.2;
/** analysis raster width — frames are decoded grayscale at this width */
const ANALYSIS_W = 480;

/** An affordance the take is expected to demonstrate (e.g. a changeset's
 *  user-facing features). Caller-supplied — the checker carries no
 *  app-specific knowledge. */
export type InventoryRule = {
  name: string;
  match: {
    /** the covering beat's kind must equal this ("click" / "type" / "press" …) */
    action?: string;
    /** the covering beat's label/keys must contain ANY of these (case-insensitive) */
    targetIncludes?: string[];
  };
};

export type CheckTakeOpts = {
  composition: TakeComposition;
  captureLog: CaptureLog;
  /** the delivered (cinematic) mp4 — static-tail reads it. Absent ⇒ skipped. */
  deliveredMp4?: string;
  /** the raw capture mp4 (viewport pixels) — dead-opening reads it. Absent ⇒ skipped. */
  captureMp4?: string;
  /** advertised affordances the take must cover. Absent ⇒ check skipped. */
  inventory?: InventoryRule[];
};

/**
 * Post-shoot deterministic take check: line the composition's intent up
 * against what the shoot actually produced and report defects in the same
 * shape as validateComposition. The two pixel checks each need a video and
 * SILENTLY SKIP when their path is absent or unreadable — dead-opening reads
 * `captureMp4` (raw viewport pixels; the delivered frame's cinematic backdrop
 * would drown the signal), static-tail reads `deliveredMp4` (the shipped
 * file). Everything else is pure over composition + capture log. Never throws.
 */
export async function checkTake(opts: CheckTakeOpts): Promise<CompositionIssue[]> {
  const issues: CompositionIssue[] = [];
  const comp = opts.composition;
  const log = opts.captureLog;
  const warn = (path: string, message: string, fix?: string) =>
    issues.push({ severity: "warn", path, message, fix });

  // --- 1. dead-opening (error) — CAPTURE pixels --------------------------
  if (opts.captureMp4) {
    try {
      const issue = await deadOpeningIssue(opts.captureMp4, comp.startMs ?? 0);
      if (issue) issues.push(issue);
    } catch {
      /* a diagnostics pass must never throw */
    }
  }

  // --- 2. static-tail (warn) — DELIVERED pixels --------------------------
  if (opts.deliveredMp4) {
    try {
      const issue = await staticTailIssue(opts.deliveredMp4, comp.framing?.insetFrac ?? 0.92);
      if (issue) issues.push(issue);
    } catch {
      /* a diagnostics pass must never throw */
    }
  }

  // --- 3+4. coverage checks: zoom-on-global-payoff / dead-beat -----------
  // Both read the frame-diff annotation, so both stand down on a diff-blind
  // (canvas/video) capture. Events zip by index — a count mismatch is
  // validateComposition's finding, not repeated here.
  // Both structures arrive via JSON.parse casts at every real call site, and
  // the very plans this tool critiques are model-edited — read defensively so
  // a dropped field degrades to "nothing to say", never a TypeError.
  const events = comp.events ?? [];
  const logEvents = log.events ?? [];
  const diffBlind = (log.paintedFrac ?? 0) > DIFF_BLIND_PAINTED_FRAC;
  if (!diffBlind) {
    const n = Math.min(events.length, logEvents.length);
    for (let i = 0; i < n; i++) {
      const e = events[i]!;
      const cap = logEvents[i]!;
      const cov = cap.changeCoverage;
      if (cov == null) continue; // unannotated — nothing measured, nothing to say
      if (e.zoom?.enabled && cov > ZOOMED_COVERAGE_MAX)
        warn(
          `events[${i}].zoom.enabled`,
          `this beat's payoff repaints ${Math.round(cov * 100)}% of the frame${e.label ? ` (${e.label})` : ""} — zooming in crops the very change the beat is there to show`,
          `set events[${i}].zoom.enabled=false — zoom is for payoffs that land near the pointer`,
        );
      if (cov === 0 || cap.effectBox == null)
        warn(
          `events[${i}]`,
          `the frame diff attributes no visible payoff to this beat (${cov === 0 ? "changeCoverage 0" : `changeCoverage ${cov} but no effectBox — scattered specks, no coherent region`}) — it may have changed nothing on screen`,
          `check this beat's frames — a 1px outline or low-alpha highlight can legitimately measure 0; if nothing really happens, drop the step and re-capture`,
        );
    }
  }

  // --- 5. inventory coverage (error) --------------------------------------
  const rules = opts.inventory ?? [];
  if (rules.length) {
    const text = (e: (typeof events)[number]) => `${e.label ?? ""} ${e.keys ?? ""}`.toLowerCase();
    const covered = (r: InventoryRule) =>
      events.some((e) => {
        if (r.match.action && e.kind !== r.match.action) return false;
        const t = r.match.targetIncludes;
        if (t?.length && !t.some((s) => text(e).includes(s.toLowerCase()))) return false;
        return true;
      });
    const missing = rules.filter((r) => !covered(r));
    if (missing.length)
      issues.push({
        severity: "error",
        path: "events",
        message: `${missing.length} of ${rules.length} advertised affordance${missing.length === 1 ? " is" : "s are"} never shown: ${missing.map((r) => r.name).join(", ")} — every advertised affordance must be shown or explicitly waived`,
        fix: "add a beat demonstrating each (re-capture with the extra steps), or waive it explicitly in the delivery note",
      });
  }

  return issues;
}

// --- pixel checks -----------------------------------------------------------

/** Dead-opening runs on the CAPTURE video, never the delivered mp4: on the
 *  capture, blank-vs-painted separates 17× in grayscale std (≈2.6 vs ≈44–51),
 *  while on the delivered frame the dark cinematic background dominates and
 *  the same two states measured 84.2 vs 88.9 — no signal. Do not "fix" a miss
 *  by measuring the delivered frame. */
async function deadOpeningIssue(
  captureMp4: string,
  currentStartMs: number,
): Promise<CompositionIssue | undefined> {
  const meta = await probeVideo(captureMp4);
  if (!meta) return undefined;
  const bin = await resolveFfmpeg();
  const { aw, ah } = raster(meta);

  // steady-state baseline: the take's own "has content" plane
  const [b0, b1] = BASELINE_SPAN;
  const ts: number[] = [];
  for (let i = 0; i < BASELINE_SAMPLES; i++)
    ts.push(meta.durationS * (b0 + ((b1 - b0) * i) / (BASELINE_SAMPLES - 1)));
  const frames = await Promise.all(ts.map((t) => grayFrame(bin, captureMp4, t, aw, ah)));
  const stds = frames.filter((f): f is Uint8Array => !!f).map(grayStd);
  if (stds.length < 3) return undefined;
  const steady = median(stds);
  if (!(steady > 0)) return undefined; // a flat take has no settled look to reach

  const strip = await grayStrip(
    bin,
    captureMp4,
    Math.min(OPENING_PROBE_MS / 1000, meta.durationS),
    OPENING_STEP_MS,
    aw,
    ah,
  );
  if (!strip.length) return undefined;
  let settleIdx = -1;
  for (let i = 0; i < strip.length; i++) {
    if (grayStd(strip[i]!) >= steady * SETTLE_STD_FRAC) {
      settleIdx = i;
      break;
    }
  }
  const probeEndMs = Math.round(Math.min(OPENING_PROBE_MS, meta.durationS * 1000));
  // a startMs that already trims past the whole probe window has nothing left
  // to flag (re-rendered/hand-edited comps; a fresh make has no startMs)
  if (currentStartMs >= probeEndMs) return undefined;
  if (settleIdx < 0)
    return {
      severity: "error",
      path: "startMs",
      message: `the capture has not reached its settled look by ${probeEndMs}ms (frame std stays under ${Math.round(SETTLE_STD_FRAC * 100)}% of the steady baseline ${steady.toFixed(1)}) — the delivered video opens on unpainted frames`,
      fix: `set startMs ≈ ${probeEndMs} and re-check; if the app paints even later, re-capture with a longer load wait before the first beat`,
    };
  const settleMs = settleIdx * OPENING_STEP_MS;
  if (settleMs < DEAD_OPENING_MIN_MS) return undefined;
  if (currentStartMs >= settleMs) return undefined; // the head trim already cuts the blank
  return {
    severity: "error",
    path: "startMs",
    message: `the capture's first ~${settleMs}ms are unpainted (frame std reaches the settled baseline ${steady.toFixed(1)} only at ${settleMs}ms)${currentStartMs ? `, and startMs ${currentStartMs} trims less than that` : ""} — the delivered video opens on a blank screen`,
    fix: `set startMs ≈ ${settleMs}`,
  };
}

/** Static-tail runs on the DELIVERED mp4 — the frozen ending is a property of
 *  the shipped file (durationMs / the last beat's settle), not the capture.
 *  The diff is taken over the STAGE interior only: the cinematic backdrop
 *  (~1−insetFrac·0.9 of the frame) never changes, and diffing the full frame
 *  would dilute mean|Δ| by that share — the 1.0 threshold is calibrated on
 *  screen pixels. */
async function staticTailIssue(
  deliveredMp4: string,
  insetFrac: number,
): Promise<CompositionIssue | undefined> {
  const meta = await probeVideo(deliveredMp4);
  if (!meta || meta.durationS < TAIL_SPAN_S + 0.5) return undefined; // too short to have a tail
  const bin = await resolveFfmpeg();
  const { aw, ah } = raster(meta);
  // centered crop just inside the stage: the app occupies insetFrac of the
  // frame; ·0.9 keeps the rounded corners and drop shadow out of the diff
  const cropFrac = Math.min(1, Math.max(0.2, insetFrac * 0.9));
  const [a, b] = await Promise.all([
    grayFrame(bin, deliveredMp4, meta.durationS - TAIL_SPAN_S, aw, ah, cropFrac),
    grayFrame(bin, deliveredMp4, meta.durationS - TAIL_LAST_S, aw, ah, cropFrac),
  ]);
  if (!a || !b) return undefined;
  const diff = meanAbsDiff(a, b);
  if (diff >= TAIL_FROZEN_DIFF) return undefined;
  return {
    severity: "warn",
    path: "durationMs",
    message: `nothing changes across the delivered video's last ${TAIL_SPAN_S}s (mean pixel diff ${diff.toFixed(2)}) — it ends on a frozen screen`,
    fix: "shorten the last beat's settleMs, or add a closing beat that earns the tail",
  };
}

// --- ffmpeg plumbing --------------------------------------------------------

type VideoMeta = { durationS: number; width: number; height: number };

function runBuf(bin: string, args: string[]): Promise<Buffer> {
  return new Promise((res, rej) => {
    const c = spawn(bin, args, { stdio: ["ignore", "pipe", "ignore"] });
    const chunks: Buffer[] = [];
    c.stdout.on("data", (b: Buffer) => chunks.push(b));
    c.on("error", rej);
    c.on("close", (code) =>
      code === 0 ? res(Buffer.concat(chunks)) : rej(new Error(`${bin} exited ${code}`)),
    );
  });
}

async function probeVideo(path: string): Promise<VideoMeta | undefined> {
  try {
    const bin = await resolveFfprobe();
    const out = (
      await runBuf(bin, [
        "-v",
        "error",
        "-select_streams",
        "v:0",
        "-show_entries",
        "stream=width,height",
        "-show_entries",
        "format=duration",
        "-of",
        "json",
        path,
      ])
    ).toString("utf8");
    const j = JSON.parse(out) as {
      streams?: { width?: number; height?: number }[];
      format?: { duration?: string };
    };
    const s = j.streams?.[0];
    const d = Number.parseFloat(j.format?.duration ?? "");
    if (!s?.width || !s.height || !Number.isFinite(d) || d <= 0) return undefined;
    return { durationS: d, width: s.width, height: s.height };
  } catch {
    return undefined;
  }
}

/** analysis raster for a video: ANALYSIS_W wide, aspect kept */
function raster(meta: VideoMeta): { aw: number; ah: number } {
  const aw = Math.min(ANALYSIS_W, meta.width);
  return { aw, ah: Math.max(2, Math.round((meta.height * aw) / meta.width)) };
}

/** decode ONE grayscale frame at `tS`, scaled to aw×ah; undefined on failure.
 *  `cropFrac` first takes the centered `cropFrac`×`cropFrac` share of the
 *  source frame (stage-interior reads on a delivered mp4). */
async function grayFrame(
  bin: string,
  path: string,
  tS: number,
  aw: number,
  ah: number,
  cropFrac?: number,
): Promise<Uint8Array | undefined> {
  try {
    const crop =
      cropFrac != null && cropFrac < 1
        ? `crop=floor(iw*${cropFrac.toFixed(3)}/2)*2:floor(ih*${cropFrac.toFixed(3)}/2)*2,`
        : "";
    const buf = await runBuf(bin, [
      "-v",
      "error",
      "-ss",
      Math.max(0, tS).toFixed(3),
      "-i",
      path,
      "-frames:v",
      "1",
      "-vf",
      `${crop}scale=${aw}:${ah}`,
      "-f",
      "rawvideo",
      "-pix_fmt",
      "gray",
      "-",
    ]);
    return buf.length === aw * ah ? new Uint8Array(buf) : undefined;
  } catch {
    return undefined;
  }
}

/** decode grayscale frames from t=0 on a `stepMs` grid over the first `spanS`
 *  seconds, in ONE ffmpeg pass (frame k sits at k·stepMs) */
async function grayStrip(
  bin: string,
  path: string,
  spanS: number,
  stepMs: number,
  aw: number,
  ah: number,
): Promise<Uint8Array[]> {
  const buf = await runBuf(bin, [
    "-v",
    "error",
    "-i",
    path,
    "-t",
    spanS.toFixed(3),
    "-vf",
    `fps=${1000 / stepMs},scale=${aw}:${ah}`,
    "-f",
    "rawvideo",
    "-pix_fmt",
    "gray",
    "-",
  ]);
  const n = aw * ah;
  const frames: Uint8Array[] = [];
  for (let off = 0; off + n <= buf.length; off += n)
    frames.push(new Uint8Array(buf.subarray(off, off + n)));
  return frames;
}

// --- pixel stats ------------------------------------------------------------

function grayStd(f: Uint8Array): number {
  let sum = 0;
  for (let i = 0; i < f.length; i++) sum += f[i]!;
  const mean = sum / f.length;
  let acc = 0;
  for (let i = 0; i < f.length; i++) {
    const d = f[i]! - mean;
    acc += d * d;
  }
  return Math.sqrt(acc / f.length);
}

function meanAbsDiff(a: Uint8Array, b: Uint8Array): number {
  const n = Math.min(a.length, b.length);
  if (!n) return 0;
  let acc = 0;
  for (let i = 0; i < n; i++) acc += Math.abs(a[i]! - b[i]!);
  return acc / n;
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}
