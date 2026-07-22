// validateComposition: a NON-MUTATING structural check on an edited
// composition. The refine loop is "edit the JSON, re-render" — so the agent
// (or a human) hand-edits `*.composition.json`, and this gives a
// millisecond, field-specific verdict BEFORE paying for a render. It never
// changes the composition; it only reports.
//
// Severity:
//   "error" — the render would be wrong/broken (or silently mis-framed).
//             renderTake refuses to render until these are fixed.
//   "warn"  — suspect, but may be intentional. Rendered as-is.
//
// The single most important check is the capture-lock (see CAPTURE-LOCKED
// below): an action beat's `tMs` is bound to the recording — the video frame
// at time t shows the page AS IT WAS at capture-time t — so re-rendering with
// a moved `tMs` desyncs the overlay from the on-screen action. Retiming an
// action needs a re-capture, not a JSON edit. Pass the capture log to enforce
// this; without it the check is skipped (we can't know the ground truth).

import { restStageScale } from "./math";
import type { CaptureLog, TakeComposition } from "./types";

export type CompositionIssue = {
  severity: "error" | "warn";
  /** dotted/indexed field path, e.g. "events[3].zoom.scale" */
  path: string;
  message: string;
  /** a concrete suggested correction the agent can apply */
  fix?: string;
};

export type ValidateOpts = {
  /** soft ceiling on zoom scale — above it the pixels visibly soften (warn).
   *  Default 2.5 (the planner caps auto-zoom at 1.5; manual edits get headroom). */
  maxScale?: number;
  /** the ground-truth capture log. When given, action `tMs` is checked against
   *  it (capture-lock). Omit to skip that check. */
  captureLog?: CaptureLog;
};

const reqField: Record<string, string> = {
  type: "text",
  press: "keys",
  drag: "to",
};

export function validateComposition(
  comp: TakeComposition,
  opts: ValidateOpts = {},
): CompositionIssue[] {
  const issues: CompositionIssue[] = [];
  const err = (path: string, message: string, fix?: string) =>
    issues.push({ severity: "error", path, message, fix });
  const warn = (path: string, message: string, fix?: string) =>
    issues.push({ severity: "warn", path, message, fix });

  const maxScale = opts.maxScale ?? 2.5;

  // --- output / source sanity ---
  const { width: oW, height: oH, fps } = comp.output;
  if (!(oW > 0 && oH > 0))
    err("output", `non-positive output size ${oW}x${oH}`, "set positive width/height");
  if (!(fps > 0)) err("output.fps", `fps must be > 0 (got ${fps})`, "set output.fps to 30 or 60");
  const { videoWidth: vW, videoHeight: vH } = comp.source;
  if (!(vW > 0 && vH > 0)) err("source", `non-positive source video size ${vW}x${vH}`);

  const rest = restStageScale(vW, vH, oW, oH, comp.framing.insetFrac);

  // --- motion blur (render cost scales with samples: frames = fps × samples) ---
  const mb = comp.motionBlur;
  if (mb) {
    if (!Number.isInteger(mb.samples) || mb.samples < 1 || mb.samples > 16)
      err(
        "motionBlur.samples",
        `samples must be an integer 1-16 (got ${mb.samples})`,
        "6 is the balanced default; 1 turns blur off",
      );
    else if (mb.samples > 9)
      warn(
        "motionBlur.samples",
        `samples ${mb.samples} renders ${mb.samples}× the frames for little extra smoothness`,
        "9 is the practical ceiling",
      );
    if (!(mb.shutter >= 0 && mb.shutter <= 1))
      err(
        "motionBlur.shutter",
        `shutter must be 0..1 (got ${mb.shutter})`,
        "0.7 is the default; 0 turns blur off",
      );
  }

  // --- duration / ordering ---
  const events = comp.events ?? [];
  let lastEnd = 0;
  let prevT = -1;
  for (let i = 0; i < events.length; i++) {
    const e = events[i]!;
    const p = `events[${i}]`;
    const dur = e.durationMs ?? 0;
    const endMs = e.tMs + dur;
    lastEnd = Math.max(lastEnd, endMs);

    // ordering: events must stay in temporal order (the video is temporal)
    if (e.tMs < prevT) {
      err(
        `${p}.tMs`,
        `tMs ${e.tMs} is before the previous beat (${prevT}) — events out of order`,
        "events follow the recording; reordering needs a re-capture, not a swap here",
      );
    }
    prevT = e.tMs;

    if (e.tMs < 0) err(`${p}.tMs`, `negative tMs ${e.tMs}`);
    if (e.tMs > comp.durationMs)
      err(
        `${p}.tMs`,
        `tMs ${e.tMs} exceeds composition durationMs ${comp.durationMs}`,
        "raise durationMs or remove the beat",
      );

    // kind-specific required fields (editability invariants)
    const need = reqField[e.kind];
    if (need && (e as Record<string, unknown>)[need] == null)
      err(
        `${p}.${need}`,
        `${e.kind} beat is missing "${need}"`,
        `restore ${need} from the capture`,
      );

    // --- zoom decision ---
    const z = e.zoom;
    if (!z) {
      err(
        `${p}.zoom`,
        "missing zoom decision",
        "every beat needs a zoom { enabled, scale, center, inAtMs }",
      );
      continue;
    }
    // inAtMs must precede the action (the zoom-in ramps in before the beat lands)
    if (z.inAtMs < 0) err(`${p}.zoom.inAtMs`, `negative inAtMs ${z.inAtMs}`, "clamp to 0");
    if (z.inAtMs > e.tMs)
      err(
        `${p}.zoom.inAtMs`,
        `inAtMs ${z.inAtMs} is AFTER the action at tMs ${e.tMs} — the zoom would arrive late`,
        `set inAtMs = tMs − cursor.zoomInMs (= ${Math.max(0, e.tMs - comp.cursor.zoomInMs)})`,
      );

    if (z.enabled) {
      // scale must zoom IN (≥ rest). Below rest shows MORE than the framed
      // video → backdrop dead-space; that's never what an enabled zoom wants.
      if (z.scale < rest - 1e-6)
        err(
          `${p}.zoom.scale`,
          `scale ${z.scale.toFixed(3)} is below rest ${rest.toFixed(3)} — that zooms OUT past the frame (dead space)`,
          `raise to ≥ ${rest.toFixed(2)}, or set zoom.enabled=false for a full-view beat`,
        );
      else if (z.scale <= rest + 1e-6)
        warn(
          `${p}.zoom.scale`,
          `scale ${z.scale.toFixed(3)} ≈ rest — zoom is enabled but does nothing visible`,
          "raise scale to actually zoom, or set enabled=false",
        );
      if (z.scale > maxScale)
        warn(
          `${p}.zoom.scale`,
          `scale ${z.scale.toFixed(2)} exceeds the soft cap ${maxScale} — pixels will soften`,
          `clamp toward ${maxScale.toFixed(1)} unless the detail truly needs it`,
        );
      // center inside the video (clampCenter will pull it in, but an off-video
      // center usually means a stale/hand-miscomputed value)
      if (z.center.x < 0 || z.center.x > vW || z.center.y < 0 || z.center.y > vH)
        warn(
          `${p}.zoom.center`,
          `center (${z.center.x.toFixed(0)},${z.center.y.toFixed(0)}) is outside the video ${vW}x${vH}`,
          e.bbox
            ? "use the bbox center: { x: bbox.x+bbox.w/2, y: bbox.y+bbox.h/2 }"
            : "point at the on-screen target (video-px)",
        );
      // enabling zoom on a no-bbox beat means an invented center/scale — fine,
      // but flag it so the refine loop knows it's not bbox-derived.
      if (!e.bbox)
        warn(
          `${p}.zoom`,
          "zoom enabled on a beat with no bbox — center/scale are hand-set, not bbox-fit",
          "double-check the center frames the intended region",
        );
    }
  }

  // tail: the composition must outlast the last action (+ a little settle)
  if (comp.durationMs < lastEnd)
    err(
      "durationMs",
      `durationMs ${comp.durationMs} ends before the last action (${lastEnd})`,
      `raise to ≥ ${Math.round(lastEnd + comp.cursor.holdMs + comp.cursor.zoomOutMs)}`,
    );
  else if (comp.durationMs < lastEnd + comp.cursor.zoomOutMs)
    warn(
      "durationMs",
      `only ${comp.durationMs - lastEnd}ms after the last action — the final zoom-out may be cut`,
      `allow ≥ ${comp.cursor.zoomOutMs}ms (cursor.zoomOutMs) of tail`,
    );

  // --- CAPTURE-LOCKED: action tMs must match the recording ---
  // The video is temporal: a beat's tMs is WHEN it is visible in the capture.
  // A render-only edit cannot move that, so a drifted tMs would fire the
  // overlay off the on-screen action. (Cinematic timing — inAtMs, holdMs,
  // zoom ramps, the intro travel and the tail — IS freely editable; only the
  // action anchor tMs is locked.)
  if (opts.captureLog) {
    const log = opts.captureLog;
    if (log.events.length !== events.length)
      warn(
        "events",
        `composition has ${events.length} beats but the capture log has ${log.events.length} — added/removed actions need a re-capture`,
        "re-capture to change the choreography; edit only renders the existing recording",
      );
    const n = Math.min(log.events.length, events.length);
    for (let i = 0; i < n; i++) {
      const lt = log.events[i]!.tMs;
      const ct = events[i]!.tMs;
      if (Math.abs(lt - ct) > 1)
        err(
          `events[${i}].tMs`,
          `tMs ${ct} drifted from the captured ${lt} — an action's tMs is capture-locked (the video shows it at ${lt}ms)`,
          `restore tMs to ${lt}; to retime the action itself, re-capture`,
        );
    }
  }

  return issues;
}

/** Format issues for a human/agent log. Errors first. */
export function formatIssues(issues: CompositionIssue[]): string {
  if (!issues.length) return "composition OK (0 issues)";
  const order = (s: string) => (s === "error" ? 0 : 1);
  return issues
    .slice()
    .sort((a, b) => order(a.severity) - order(b.severity))
    .map(
      (i) => `  [${i.severity}] ${i.path}: ${i.message}${i.fix ? `\n          fix: ${i.fix}` : ""}`,
    )
    .join("\n");
}
